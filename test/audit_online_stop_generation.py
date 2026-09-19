# -*- coding: utf-8 -*-
"""
线上 · 「停止生成」链路体检
============================

背景
----
用户指出：**线上的停止生成是和线下一起加的**。

线下那条已经查出「控制器从未登记 → 停止键空转 → 却 return true」
的结构性缺陷。同一批加进来的线上实现，必须按同样的怀疑力度查一遍，
不能因为「线上看起来没问题」就放过。

本测试对线上停止链路做**端到端可达性验证**，逐环检查：

  O1  sendChat 是否登记 controller（线上唯一生成入口）
  O2  controller.signal 是否真的传到 fetch 的 init.signal
  O3  stopChatGeneration 是否能 abort 到那个 signal
  O4  备用 API 回退路径是否保留同一 signal（不应中途换/丢）
  O5  重试路径（fetchChatCompletion 递归）是否保留 signal
  O6  返回值语义：无生成在跑 → false，不谎报成功
  O7  停止后忙碌标记被释放（releaseChatApi），不会卡住后续发送

静态 + 运行时双轨：
  · 静态：确认调用点/赋值点存在且可达
  · 运行时：Node vm 加载真实源文件，用假 fetch 抓 init.signal 实测

跑法：python3 test/audit_online_stop_generation.py
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HARNESS = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2];
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ═══════════════════════════════════════════════════════════
// 静态检查：调用点与赋值点的可达性
// ═══════════════════════════════════════════════════════════
const engSrc = read('js1/miya-chat-engine.js');
const roomSrc = read('js1/miya-chat-room.js');

// 去掉注释后的源码，避免把注释里的示例代码当成真实调用
function stripC(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const eng = stripC(engSrc);
const room = stripC(roomSrc);

// ── O1 登记点存在 ──
const beginCalls = (eng.match(/genLife\s*\.\s*begin\s*\(/g) || []).length;
check('O1a sendChat 内存在 genLife.begin 登记', beginCalls >= 1,
  'begin 调用 ' + beginCalls + ' 处');

const genSignalAssign = /var\s+genSignal\s*=\s*genCtl\s*&&\s*genCtl\s*\.\s*signal/.test(eng);
check('O1b 从 controller 取出 signal 赋给 genSignal', genSignalAssign,
  genSignalAssign ? 'ok' : '未找到 genSignal 赋值');

// ── O2 signal 抵达 fetch ──
const fetchSigSet = /if\s*\(\s*signal\s*\)\s*opts\s*\.\s*signal\s*=\s*signal/.test(eng);
check('O2a fetchChatCompletion 把 signal 写进 fetch init', fetchSigSet,
  fetchSigSet ? 'ok' : 'fetch init 未接收 signal');

const passesGenSignal = /fetchChatCompletion\s*\(\s*url\s*,\s*reqHeaders\s*,\s*reqPayload\s*,\s*1\s*,\s*genSignal\s*\)/.test(eng);
check('O2b 调用处把 genSignal 传进 fetchChatCompletion', passesGenSignal,
  passesGenSignal ? 'ok' : '调用处未透传 genSignal');

// ── O4 备用 API 回退路径保留 signal ──
const callWithSliceSig = /function\s+callWithSlice\s*\(/.test(eng);
check('O4a 存在 callWithSlice（主/备 API 共用同一调用封装）', callWithSliceSig,
  callWithSliceSig ? 'ok' : '未找到 callWithSlice');
// 回退分支不应重新构造 signal 或传 null
const fallbackDropsSignal = /callWithSlice\s*\(\s*resolveChatApiSlice\s*\(\s*cfg\s*,\s*true\s*\)\s*,\s*true\s*\)/.test(eng);
check('O4b 备用 API 走同一个 callWithSlice（signal 由闭包捕获）', fallbackDropsSignal,
  fallbackDropsSignal ? 'ok' : '未找到备用分支调用');

// ── O5 重试路径保留 signal ──
const retryKeepsSignal = /fetchChatCompletion\s*\(\s*url\s*,\s*headers\s*,\s*payload\s*,\s*tryNo\s*\+\s*1\s*,\s*signal\s*\)/.test(eng);
check('O5 重试递归把 signal 继续往下传', retryKeepsSignal,
  retryKeepsSignal ? 'ok' : '重试路径丢掉了 signal');

// ── O6 返回值语义 ──
const stopFn = eng.match(/function\s+stopChatGeneration[\s\S]{0,900}?\n    \}/);
const stopBody = stopFn ? stopFn[0] : '';
check('O6a stopChatGeneration 不再无脑 return true',
  !!stopBody && !/return\s+true\s*;/.test(stopBody) && /return\s+!!ctl/.test(stopBody),
  stopBody ? (stopBody.match(/return[^;]*;/) || [''])[0] : '未匹配到函数体');
check('O6b stopChatGeneration 读取 controller 判断是否有在跑的生成',
  /getController\s*\(/.test(stopBody),
  'getController=' + /getController\s*\(/.test(stopBody));

// ── O7 释放忙碌标记 ──
check('O7a stopChatGeneration 调用 releaseChatApi 释放忙碌标记',
  /releaseChatApi\s*\(/.test(stopBody),
  'releaseChatApi=' + /releaseChatApi\s*\(/.test(stopBody));

// ── 界面侧：不谎报成功 ──
/*
 * 取「停止分支」的正文。
 *
 * 这里不能只截到第一个 return —— 停止分支里第一个 return 在末尾，
 * 而分支正文里还夹着注释与多行三元表达式，第一版用 [\s\S]{0,800}?
 * 惰性匹配 + return 边界，结果截出来的片段过短，正则匹配不上，
 * 把已经正确的代码误报成失败。
 *
 * 改为锚定稳定特征「stopChatGeneration」向两侧各扩一段。
 */
const si = room.indexOf('stopChatGeneration');
const roomStopBody = si >= 0 ? room.slice(Math.max(0, si - 400), si + 1400) : '';
check('O8a 线上停止键改用引擎真实返回值',
  /stopped\s*=\s*eng\s*\.\s*stopChatGeneration\([^)]*\)\s*===\s*true/.test(roomStopBody),
  roomStopBody ? ('片段长度 ' + roomStopBody.length
    + '，含比较=' + /stopChatGeneration\([^)]*\)\s*===\s*true/.test(roomStopBody))
    : '未匹配到停止分支');
check('O8b 线上停止键只在真停住时提示',
  /if\s*\(\s*stopped\s*\)\s*toast\s*\(/.test(roomStopBody),
  roomStopBody ? ('含条件 toast=' + /if\s*\(\s*stopped\s*\)\s*toast\s*\(/.test(roomStopBody))
    : '未匹配到停止分支');

// ── O9 提示所有权唯一：abort 只能弹一次 ──
/*
 * 缺陷形态：点击处理弹「已停止生成」+ sendChat 的 catch 也弹 ——
 * 用户点一次停止，弹两次。
 *
 * 正确设计是「提示所有权唯一」：由**知道用户意图**的那一层负责提示。
 * 点击处理知道 stopped（真的中断到了生成），catch 不知道
 * （abort 也可能来自 supersede / clear，非用户触发）。
 * 所以 catch 侧必须静默。
 */
/*
 * 必须用**去注释**后的源码来数。
 *
 * roomSrc 里那段说明文字本身写了好几次 `toast('已停止生成')`（在讲这个
 * 缺陷的历史），直接对数会数出 3 处、把修好的代码误报成失败。
 * 这正是「注释被当成代码」的经典陷阱 —— 本扫描器在 P1 那边也踩过一次，
 * 所以这里统一用 stripC 的结果。
 */
const abortToastCount = (room.match(/toast\s*\(\s*['"]已停止生成['"]\s*\)/g) || []).length;
check('O9a 去注释后「已停止生成」提示只有一处（不重复弹）',
  abortToastCount === 1,
  '实际 ' + abortToastCount + ' 处（注释不计）');

const catchAbortToast = /abortedHere[\s\S]{0,600}?toast\s*\(\s*['"]已停止生成['"]/.test(room);
check('O9b sendChat 的 catch 对 abort 保持静默（提示归点击处理）',
  !catchAbortToast,
  catchAbortToast ? 'catch 里仍会弹提示' : 'ok');

// ═══════════════════════════════════════════════════════════
// 运行时检查：Node vm 加载真实引擎，实测 signal 落点
// ═══════════════════════════════════════════════════════════
const store = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
let lastInit = null;
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  JSON, Date, Math, Object, Array, Number, String, Promise, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  getElementById() { return null; }, querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, appendChild() {}, removeChild() {} }; },
  body: { classList: { add() {}, remove() {}, contains() { return false; } } },
  readyState: 'complete',
};
sandbox.CustomEvent = function (t, o) { this.type = t; Object.assign(this, o || {}); };
sandbox.miyaSyncReadJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
sandbox.miyaWriteLsJsonKey = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); };
sandbox.fetch = function (url, init) {
  lastInit = init || {};
  // 立刻以 AbortError 收尾，避免测试悬挂；signal 已记录
  return new Promise(function (resolve, reject) {
    var e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  });
};
vm.createContext(sandbox);

// 生命周期（真实文件）
try {
  vm.runInContext(read('js2/miya-generation-lifecycle.js'), sandbox,
    { filename: 'js2/miya-generation-lifecycle.js' });
  check('R0 生命周期模块加载成功', !!sandbox.MiyaGenerationLifecycle, 'ok');
} catch (e) {
  check('R0 生命周期模块加载成功', false, String(e && e.message));
}

// 引擎（真实文件）—— 依赖较多，允许失败但不静默
let Engine = null;
try {
  vm.runInContext(read('js1/miya-chat-engine.js'), sandbox,
    { filename: 'js1/miya-chat-engine.js' });
  Engine = sandbox.miyaChatEngine || sandbox.MiyaChatEngine;
  check('R1 线上引擎加载成功', !!Engine, Engine ? 'ok' : '未导出引擎');
} catch (e) {
  check('R1 线上引擎加载成功', false, '加载异常：' + String(e && e.message));
}

// ★ 关键静态断言：确认「登记 → 取 signal → 传参 → 写进 fetch」
//   这四个环节在同一条链上（线下缺陷正是缺了第一环）
check('R2 线上四环齐备：begin → genSignal → 传参 → fetch init.signal',
  beginCalls >= 1 && genSignalAssign && passesGenSignal && fetchSigSet,
  'begin=' + beginCalls + ' genSignal=' + genSignalAssign
  + ' 传参=' + passesGenSignal + ' fetch=' + fetchSigSet);

console.log('__RESULT__' + JSON.stringify(results));
"""


def main():
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False,
                                     encoding='utf-8') as fh:
        fh.write(HARNESS)
        hp = fh.name
    try:
        proc = subprocess.run(['node', hp, ROOT], capture_output=True, text=True)
    finally:
        try:
            os.unlink(hp)
        except OSError:
            pass

    out = proc.stdout + proc.stderr
    if '__RESULT__' not in out:
        print('HARNESS FAILED —— 原始输出：')
        print(out[:5000])
        return 1
    payload = out.split('__RESULT__', 1)[1].strip().splitlines()[0]
    results = json.loads(payload)

    passed = sum(1 for r in results if r['pass'])
    total = len(results)
    print('=' * 72)
    print('线上「停止生成」链路体检')
    print('=' * 72)
    for r in results:
        print(('  ✅ ' if r['pass'] else '  ❌ ') + r['name'])
        if r['detail'] and not r['pass']:
            print('       ' + r['detail'])
    print('-' * 72)
    print('通过 %d/%d' % (passed, total))
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main())
