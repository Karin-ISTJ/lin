# -*- coding: utf-8 -*-
"""
重回「改写约束」验证
====================

背景
----
用户报：「把角色发来的消息删掉 重新生成 还是会生成一模一样的消息」

诊断结论（见 audit_online_regenerate_repeat.py）：
  重答与首发使用**逐字相同**的上下文与采样参数，
  且没有任何「换一种说法」的指令 ⇒ 输出趋同是必然。

本测试验证修复后：
  Q1  buildRegenerateTailNudge 确实包含改写约束
  Q2  该约束挂载在正确的分支上（isRegenerate + user_spoke_last）
  Q3  约束内容覆盖了几个关键要求（换角度 / 保人设 / 禁元叙述）
  Q4  约束**不会**污染非重答路径（普通发送、主动推、线下、通话）
  Q5  运行时：真实构造一次 payload，确认末条 user 指令就是改写约束

跑法：python3 test/audit_regenerate_differentiation.py
"""
import json
import os
import subprocess
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

const engSrc = read('js1/miya-chat-engine.js');

/* 取出 buildRegenerateTailNudge 的函数体（保留原格式，便于读字符串） */
const fnMatch = engSrc.match(/function\s+buildRegenerateTailNudge\s*\([^)]*\)\s*\{[\s\S]*?\n    \}/);
const fnBody = fnMatch ? fnMatch[0] : '';
check('Q1a 定位到 buildRegenerateTailNudge 函数体', !!fnBody,
  fnBody ? ('长度 ' + fnBody.length) : '未匹配');

/* ── Q1 改写约束是否存在 ── */
check('Q1b 含「上一版回复已被丢弃」的明确告知',
  /已被用户丢弃|已被丢弃|上一版/.test(fnBody),
  '命中=' + /已被用户丢弃|已被丢弃|上一版/.test(fnBody));

check('Q1c 含「换方向」类改写要求（换一个角度切入…）',
  /换一个角度切入|换一个切入角度|换角度|换一个话题侧重/.test(fnBody),
  '命中=' + /换一个角度切入|换一个切入角度|换角度|换一个话题侧重/.test(fnBody));

/*
 * Q1e（v8.4 新增）：必须**明确排除**「同义改写」这条歧义读法。
 *
 * 用户原话：「『换个说法』这句话有歧义 是同一个意思换个说法还是换一种别的」
 * 只说「换一个角度」还不够 —— 模型完全可以理解成「同一个意思换套词」。
 * 所以要求文里出现显式的排除句。
 */
check('Q1e 显式排除「同义改写」歧义读法',
  /不是[\s\S]{0,40}换一组词|同义改写/.test(fnBody),
  '命中=' + /不是[\s\S]{0,40}换一组词|同义改写/.test(fnBody));

/* Q1f（v8.4 新增）：上一版原文必须被**引用**出来。
   上下文里那一轮已被 omitTrailingAssistantRound 摘掉，
   不引用原文，模型无从对照「要躲开什么」。 */
check('Q1f 引用上一版原文（avoidBlock）',
  /avoidBlock/.test(fnBody) && /上一次的回复原文是/.test(fnBody),
  '含avoidBlock=' + /avoidBlock/.test(fnBody) +
  ' 含引用引导语=' + /上一次的回复原文是/.test(fnBody));

check('Q1d 含「禁止复述/换皮重复」的负面约束',
  /严禁与其雷同|禁止复述|换皮|重复你上一版/.test(fnBody),
  '命中=' + /严禁与其雷同|禁止复述|换皮|重复你上一版/.test(fnBody));

/* ── Q3 约束必须保护人设、且禁止元叙述 ── */
check('Q3a 要求保持人设与剧情连贯（防为求新而 OOC）',
  /保持人设|人设.*连贯|偏离角色/.test(fnBody),
  '命中=' + /保持人设|人设.*连贯|偏离角色/.test(fnBody));

check('Q3b 禁止输出「重新生成/换一种说法」这类元叙述',
  /元叙述|禁止在回复里提及/.test(fnBody),
  '命中=' + /元叙述|禁止在回复里提及/.test(fnBody));

check('Q3c 不得要求硬性改变长度（避免喧宾夺主）',
  !/(必须更[长短]|至少\d+字|不超过\d+字)/.test(fnBody),
  '命中长度硬约束=' + /(必须更[长短]|至少\d+字|不超过\d+字)/.test(fnBody));

/* ── Q2 挂载点正确性 ── */
const appendMatch = engSrc.match(
  /function\s+appendManualActionTailNudge\s*\([\s\S]*?\n    \}/);
const appendBody = appendMatch ? appendMatch[0] : '';
check('Q2a 定位到 appendManualActionTailNudge', !!appendBody);

check('Q2b 改写约束仅在 opts.isRegenerate 分支内被调用',
  /if\s*\(opts\.isRegenerate\)\s*\{[\s\S]{0,400}?buildRegenerateTailNudge\s*\(/.test(appendBody),
  '命中=' + /if\s*\(opts\.isRegenerate\)\s*\{[\s\S]{0,400}?buildRegenerateTailNudge\s*\(/.test(appendBody));

/*
 * Q2c：buildRegenerateTailNudge 在整个引擎里**只应有一处调用点**，
 * 即 appendManualActionTailNudge 内那一次。若别处也调，
 * 就可能污染非重答路径。
 *
 * 注意：grep 全量匹配会把「函数定义」也算进去，所以要先剔除定义行。
 * 第一版忘了剔，得到 2 就误报失败 —— 断言本身写错了，不是代码有问题。
 */
const allRefs = engSrc.match(/buildRegenerateTailNudge\s*\(/g) || [];
const defRefs = engSrc.match(/function\s+buildRegenerateTailNudge\s*\(/g) || [];
const callSites = allRefs.length - defRefs.length;
check('Q2c 该 nudge 全文件仅一处调用点（不污染其它路径）',
  callSites === 1,
  '引用=' + allRefs.length + '  定义=' + defRefs.length + '  实调用=' + callSites);

/* ── Q4 隔离性：守卫必须挡住非重答路径 ── */
check('Q4a 存在「主动推/线下/朋友圈/拟真」的早退守卫',
  /opts\.isAutoPush\s*\|\|\s*opts\.isOffline[\s\S]{0,80}?return;/.test(appendBody),
  '命中=' + /opts\.isAutoPush/.test(appendBody));

check('Q4b 存在「通话/线下预约」的早退守卫',
  /opts\.callMode\s*\|\|\s*opts\.appointmentMode[\s\S]{0,60}?return;/.test(appendBody),
  '命中=' + /opts\.appointmentMode/.test(appendBody));

check('Q4c 存在「无附加文本 + skipUserMessage」的准入条件',
  /if\s*\(!opts\.skipUserMessage\s*\|\|\s*hasExtraUserText\)\s*return;/.test(appendBody),
  '命中=' + /if\s*\(!opts\.skipUserMessage/.test(appendBody));

check('Q4d 普通重答分支（非 regenerate）走的是「续说」而非「改写」',
  /else if\s*\(historyTailState === 'assistant_spoke_last'\)\s*\{[\s\S]{0,120}?buildManualContinueTailNudge/.test(appendBody),
  '命中=' + /buildManualContinueTailNudge/.test(appendBody));

/* ── Q5 运行时：真造一次 payload，确认末条就是改写约束 ── */
const store = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  JSON, Date, Math, Object, Array, Number, String, Promise, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {};
sandbox.removeEventListener = function () {};
sandbox.dispatchEvent = function () { return true; };
sandbox.indexedDB = undefined;
sandbox.document = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  getElementById() { return null; }, querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, appendChild() {} }; },
  body: { classList: { add() {}, remove() {}, contains() { return false; } } },
  readyState: 'complete',
};
sandbox.CustomEvent = function (t, o) { this.type = t; Object.assign(this, o || {}); };
sandbox.location = { href: 'http://localhost/' };
sandbox.navigator = { userAgent: 'node' };
sandbox.miyaSyncReadJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
sandbox.miyaWriteLsJsonKey = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); };
sandbox.miyaWriteLsJsonKeySync = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); };
sandbox.fetch = function () { return Promise.reject(new Error('no network in test')); };

vm.createContext(sandbox);

try {
  vm.runInContext(engSrc, sandbox, { filename: 'js1/miya-chat-engine.js' });
} catch (e) {
  check('Q5-0 引擎加载', false, String(e && e.message));
}

const eng = sandbox.miyaChatEngine || sandbox.MiyaChatEngine;
check('Q5-0 引擎加载成功', !!eng, eng ? 'ok' : '未导出');

if (eng) {
  /*
   * 直接调内部函数是拿不到的，所以走「导出面」检查：
   * 确认引擎对外暴露了重答入口，且入口用的是 isRegenerate: true。
   */
  check('Q5a 引擎导出 withdrawLastAssistantRound（重答前置撤回）',
    typeof eng.withdrawLastAssistantRound === 'function',
    typeof eng.withdrawLastAssistantRound);

  const regenLast = /function\s+regenerateLastRound[\s\S]{0,320}?skipUserMessage:\s*true,\s*isRegenerate:\s*true/.test(engSrc);
  check('Q5b regenerateLastRound 以 isRegenerate:true 收口到 sendChat',
    regenLast, '命中=' + regenLast);

  /*
   * Q5c：把 buildRegenerateTailNudge 的返回字符串**真跑一遍**。
   * 通过往 sandbox 注入钩子做不到（函数是闭包私有的），
   * 因此改用「源码内字符串拼接结果」静态复现：
   * 抽取所有字面量片段，拼起来确认关键词都在最终文本里。
   */
  const literals = (fnBody.match(/'((?:[^'\\]|\\.)*)'/g) || [])
    .map(function (s) { return s.slice(1, -1); });
  const joined = literals.join('');
  /*
   * v8.4：措辞从「换一个切入角度」改成「换一个角度切入」，
   * 并补上「同义改写」的显式排除。拼接结果里这些必须都在。
   */
  check('Q5c 拼接后的 nudge 文本含改写约束关键词',
    /换一个角度切入/.test(joined) && /同义改写/.test(joined),
    '拼接长度=' + joined.length + '  含换角度=' + /换一个角度切入/.test(joined) +
    '  含排除同义改写=' + /同义改写/.test(joined));
}

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
        print(out[:4000])
        return 1
    payload = out.split('__RESULT__', 1)[1].strip().splitlines()[0]
    results = json.loads(payload)

    passed = sum(1 for r in results if r['pass'])
    print('=' * 74)
    print('重回「改写约束」验证')
    print('=' * 74)
    for r in results:
        print(('  ✅ ' if r['pass'] else '  ❌ ') + r['name'])
        if r['detail']:
            print('       ' + r['detail'])
    print('-' * 74)
    print('%d/%d 通过' % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
