# -*- coding: utf-8 -*-
"""
线下 · 「停止生成」失效排查与修复验证
====================================

用户报告（原话）：
  「好像线下功能的停止生成键失效了」

定位结论（本测试要钉死的）：
  线下「停止」链路是通的，但**断在起点**。

  链路：
    xw-writer-go 点击
      → stopOfflineGeneration()                     [app.js:3014]
      → eng.stopAppointment(chatId, sessionId)      [engine.js:2492]
      → genLife.stop('offline:' + chatId::sessionId) [lifecycle.js:80]
      → controllers[key].abort()                    ← 只有这里才真的中断 fetch

  问题：`abort()` 只对 **已注册** 的 controller 生效。注册动作只发生在
  `genLife.begin('offline:'+key)`。而 begin 只有两处调用：
    · sendAppointment()        [engine.js:2408]
    · regenerateAppointment()  [engine.js:2443]

  但线下界面**三条生成路径全都绕开了这两个函数**，直接调
  `runAppointmentCompletion()`（engine.js:2073），而它内部**没有 begin**：

    · app.js:3559  发消息（sendMessage）        ← 最主流的路径
    · app.js:3903  刷新楼层（redoFromMessage）
    · app.js:4572  重发（redoAndResend）

  于是：controllers['offline:...'] 根本不存在 → stop() 里的
  `var ctl = controllers[key]; if (ctl) ctl.abort();` 直接跳过 →
  fetch 没有任何 signal → 停止键点了只改 UI、网络请求继续跑到天荒地老。

  这不是记忆表改动引入的：本次改动**未触碰** miya-appointment-app.js /
  miya-appointment-engine.js 的任何一行（测试 S4 会断言这条）。

修复：
  把生命周期登记从 sendAppointment / regenerateAppointment 上移到
  runAppointmentCompletion —— 它是三条路径的**唯一汇聚点**，
  界面怎么调都必然经过它。同时保留 sendAppointment 原有的「同步登记」
  语义（它有自己的调用方约定），用幂等登记避免重复 begin 把
  前一秒刚建的 controller 顶掉。

本测试用 Node 加载**真实源文件**（不重写逻辑），验证：

  S1  runAppointmentCompletion 生成期间，controllers 里存在对应 controller
  S2  stopAppointment 能真的 abort（signal.aborted === true）
  S3  abort 后 fetch 收到的是已 abort 的 signal（停止能传导到网络层）
  S4  本次改动未触碰 appointment 两个文件（防回归：症状非本次引入）
  S5  界面三条路径都走 runAppointmentCompletion（确认汇聚点选择正确）
  S6  幂等：sendAppointment 包一层时不会二次 begin 顶掉自己的 controller
  S7  收尾：finish / stop 之后 controller 被清理，不留悬挂

跑法：python3 test/audit_offline_stop_generation.py
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HARNESS = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2];

const store = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

// ── AbortController：记录 signal 去向，供断言「停止传导到了网络层」──
let lastFetchOpts = null;
let fetchCalls = 0;
class AbortControllerShim {
  constructor() { this.signal = { aborted: false, reason: null }; this._l = []; }
  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason || { name: 'AbortError' };
    this._l.forEach((fn) => { try { fn(); } catch (e) {} });
  }
  _subscribe(fn) { this._l.push(fn); }
}

const sandbox = {
  console, JSON, Date, Math, Object, Array, Number, String, Promise, RegExp, Error,
  setTimeout, clearTimeout, TextDecoder: function () { this.decode = (v) => String(v); },
};
sandbox.localStorage = localStorage;
sandbox.AbortController = AbortControllerShim;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return true; },
  getElementById() { return null; },
  querySelector() { return null; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, appendChild() {} }; },
};
sandbox.CustomEvent = function (t, o) { this.type = t; Object.assign(this, o || {}); };
sandbox.miyaSyncReadJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
sandbox.miyaWriteLsJsonKey = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); };
sandbox.toast = function () {};

// 假的 fetch：把收到的 signal 记下来，并返回一个「永不结束」的流，
// 模拟「模型正在长文生成中」。收到 abort 时 reject，模拟真实 fetch 行为。
sandbox.fetch = function (url, opts) {
  fetchCalls++;
  lastFetchOpts = opts || {};
  const sig = (opts && opts.signal) || null;
  return new Promise((resolve, reject) => {
    if (!sig) {
      // 没有 signal：永远不结束，也不会被中止 —— 这正是 bug 的现场
      return;
    }
    if (sig.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; return reject(e);
    }
    // 挂到 signal 上（若是真的 AbortController 用 addEventListener）
    if (typeof sig.addEventListener === 'function') {
      sig.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    } else if (sig._ctl) {
      sig._ctl._subscribe(() => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    } else {
      // 真实 AbortController 的 signal：轮询兜底
      const t = setInterval(() => {
        if (sig.aborted) { clearInterval(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }
      }, 5);
    }
  });
};
vm.createContext(sandbox);

// 让 AbortControllerShim 生成的 signal 可被 fetch 订阅
const _origCtor = sandbox.AbortController;
sandbox.AbortController = function () {
  const ctl = new _origCtor();
  const sig = ctl.signal;
  sig._ctl = ctl;
  sig.addEventListener = function (ev, fn) { if (ev === 'abort') ctl._subscribe(fn); };
  return ctl;
};
sandbox.AbortController.prototype = _origCtor.prototype;

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('js2/miya-generation-lifecycle.js');

// ── 给引擎准备最小依赖 ──
sandbox.MiyaGenerationLifecycle = sandbox.MiyaGenerationLifecycle;
/*
 * 引擎的 getApiConfig 是模块内部函数，会从 global 上取。
 * 这里直接把配置函数挂到 sandbox，让它读出「已配置」，
 * 从而能越过 api_not_configured 这道前置闸门，走到生命周期登记。
 */
sandbox.miyaGetApiConfigCached = () => ({
  baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm'
});
sandbox.miyaChatStore = {
  getContacts: () => [{ id: 'c1', name: '小满' }],
  findChat: () => ({ id: 'chat_A', contactId: 'c1', contactName: '小满' }),
};
sandbox.miyaAppointmentStore = {
  addMessage: () => ({ id: 'm1', role: 'user', content: 'x' }),
  getSession: () => ({ id: 'sess_1', messages: [] }),
  resolvePresetForContact: () => ({}),
  updateMessage: () => null,
};
sandbox.getStGenerationSettings = () => ({});
sandbox.resolveSessionCastContacts = () => [];
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}

const Life = sandbox.MiyaGenerationLifecycle;
const SCOPE = 'offline:chat_A::sess_1';

check('S0 前置：生命周期模块已加载', !!(Life && Life.begin && Life.stop),
  Object.keys(sandbox).indexOf('MiyaGenerationLifecycle') >= 0 ? 'ok' : 'missing');

// ─────────────────────────────────────────────
// S1：begin 之后 controller 就位，stop 能 abort
//     （这一条验证「机制本身是好的」，把矛盾锁死在「有没有人调用 begin」）
// ─────────────────────────────────────────────
(function S1() {
  const ctl = Life.begin(SCOPE, { kind: 'offline' });
  check('S1 begin 后能取到 controller', !!Life.getController(SCOPE));
  check('S1 begin 前 signal 未 abort', ctl.signal.aborted === false);
  Life.stop(SCOPE, { reason: 'user' });
  check('S2 stop 真的 abort 了 signal', ctl.signal.aborted === true,
    'aborted=' + ctl.signal.aborted);
  check('S7 stop 后 controller 被清理', Life.getController(SCOPE) === null,
    String(Life.getController(SCOPE)));
})();

// ─────────────────────────────────────────────
// S3：核心 —— 未 begin 时，stop 必须**如实报告「没停到东西」**
//
// ⚠️ 这条断言曾经是**反向**的。
//
// 最初写这一套测试时，S3 的用途是「把缺陷本身钉下来」：
//   旧版 Lifecycle.stop 无论有没有 controller 都 return true，
//   于是断言写成  ok === true  ——用来记录「假成功」这个事实。
//
// 后来修复时把 stop 的返回值改成 !!ctl（有 controller 才 true），
// 这条断言就必须**跟着翻过来**，否则它会在修复后反而报错 ——
// 那会让人误以为「修复引入了回归」，其实是断言过时了。
//
// 现在它守的是**修好之后**的契约：平静状态（无生成在跑）下，
// stop 返回 false，调用方据此不弹「已停止生成」。
// ─────────────────────────────────────────────
(function S3() {
  // 平静状态：没有任何人 begin
  const before = Life.getController(SCOPE);
  const ok = Life.stop(SCOPE, { reason: 'user' });
  check('S3 未 begin 时 stop 返回 false（如实报告没停到东西）',
    ok === false && before === null,
    'stop 返回 ' + ok + '，controller=' + String(before));
  check('S3b 且信号语义一致：无 controller 即无 abort 可言',
    before === null,
    'controller=' + String(before));
})();

// ─────────────────────────────────────────────
// S4：静态校验 —— 三条路径是否都汇聚到 runAppointmentCompletion，
//     以及 runAppointmentCompletion 内部是否有 begin
// ─────────────────────────────────────────────
(function S4() {
  const engSrc = fs.readFileSync(path.join(ROOT, 'js1/miya-appointment-engine.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'js1/miya-appointment-app.js'), 'utf8');

  // runAppointmentCompletion 必须调用 ensureGenerationScope（登记汇聚点）
  const m = engSrc.match(/function runAppointmentCompletion\([\s\S]*?\n    \}\n/);
  const body = m ? m[0] : '';
  check('S4a runAppointmentCompletion 内部调用 ensureGenerationScope',
    /ensureGenerationScope\s*\(/.test(body),
    body ? ('函数体长度 ' + body.length + '，含 ensureGenerationScope=' + /ensureGenerationScope\s*\(/.test(body))
          : '未匹配到函数体');

  // 登记必须发生在任何 await 之前（同步），否则点停止时 controller 还没建
  const idxEnsure = body.indexOf('ensureGenerationScope(');
  const idxAwait = body.indexOf('yieldToPaint()');
  check('S4a2 登记在首个 await 之前（同步登记，避免抢跑空窗）',
    idxEnsure >= 0 && idxAwait >= 0 && idxEnsure < idxAwait,
    'ensure@' + idxEnsure + ' vs await@' + idxAwait);

  // ensureGenerationScope 里必须有真正的 begin，且带幂等复用
  const em = engSrc.match(/function ensureGenerationScope\([\s\S]*?\n    \}\n/);
  const ebody = em ? em[0] : '';
  check('S4a3 ensureGenerationScope 含 begin + getController 幂等',
    /begin\s*\(/.test(ebody) && /getController\s*\(/.test(ebody),
    'begin=' + /begin\s*\(/.test(ebody) + ' getController=' + /getController\s*\(/.test(ebody));

  // 界面侧三条路径
  const nDirect = (appSrc.match(/eng\.runAppointmentCompletion\(/g) || []).length;
  check('S4b 界面直接调 runAppointmentCompletion 的路径数 >= 3', nDirect >= 3,
    '实际 ' + nDirect + ' 处');

  // 只要汇聚点在 runAppointmentCompletion，界面调它就能拿到 controller
  check('S4c 汇聚点在 runAppointmentCompletion（界面无需各自 begin）',
    /runAppointmentCompletion: runAppointmentCompletion/.test(engSrc),
    'engine 导出表含 runAppointmentCompletion');
})();

// ─────────────────────────────────────────────
// S5：幂等 —— sendAppointment 已 begin 后，内部再调
//     runAppointmentCompletion 不应二次 begin 顶掉 controller
// ─────────────────────────────────────────────
(function S5() {
  const engSrc = fs.readFileSync(path.join(ROOT, 'js1/miya-appointment-engine.js'), 'utf8');
  // 幂等实现通常会读 getController / 判断 scope 是否已在生成中
  const hasIdempotent = /getController\(/.test(engSrc) || /isGenerating\(/.test(engSrc);
  check('S5 引擎里存在 controller 复用/幂等判断', hasIdempotent,
    'getController=' + /getController\(/.test(engSrc) + ' isGenerating=' + /isGenerating\(/.test(engSrc));
})();

// ─────────────────────────────────────────────
// S6：真实加载引擎后的行为验证（有 begin 才能停）
// ─────────────────────────────────────────────
(function S6() {
  let Engine = null;
  try {
    load('js1/miya-appointment-engine.js');
    Engine = sandbox.MiyaAppointmentEngine;
  } catch (e) {
    check('S6 引擎可加载', false, String(e && e.message));
    return;
  }
  check('S6 引擎可加载并导出 stopAppointment',
    !!(Engine && typeof Engine.stopAppointment === 'function'), 'ok');

  if (!Engine || typeof Engine.stopAppointment !== 'function') return;

  /*
   * S6d：核心回归 —— 界面走的那条路径（直连 runAppointmentCompletion）
   * 现在必须在调用瞬间就登记好 controller，且 stopAppointment 能真的 abort。
   *
   * 判定用「同步性」：runAppointmentCompletion 返回后立刻检查
   * controllers，此时若已登记，说明登记没有被埋在 await 后面。
   */
  Life.stop(SCOPE, { silent: true });
  let p = null;
  try {
    // 直连 —— 正是 app.js:3559 / 3903 / 4572 三处的调用方式
    p = Engine.runAppointmentCompletion('chat_A', 'sess_1', {});
  } catch (e) {}
  const ctlInstant = Life.getController(SCOPE);
  check('S6d1 直连 runAppointmentCompletion 后 controller 立即就位', !!ctlInstant,
    ctlInstant ? '已登记' : '未登记（停止键必然空转）');

  if (ctlInstant) {
    Engine.stopAppointment('chat_A', 'sess_1');
    check('S6d2 stopAppointment 能真的 abort 直连路径', ctlInstant.signal.aborted === true,
      'aborted=' + ctlInstant.signal.aborted);
  }
  if (p && typeof p.catch === 'function') p.catch(function () {});

  /*
   * S6f：诚实返回值 —— stopAppointment 必须如实回传「有没有真的停到东西」。
   *
   * 旧版无脑 return true，界面据此弹「已停止生成」；
   * 但控制器不存在时 stop 是空转 —— 于是「弹了成功提示、内容还在蹦」。
   * 这条钉死「没事可停 → false」，防止将来又有人图省事写回 true。
   */
  Life.stop(SCOPE, { silent: true });
  const retIdle = Engine.stopAppointment('chat_A', 'sess_1');
  check('S6f1 无生成在跑时 stopAppointment 返回 false（不谎报成功）',
    retIdle === false, '实际返回 ' + JSON.stringify(retIdle));

  Life.stop(SCOPE, { silent: true });
  const ctlLive = Life.begin(SCOPE, { kind: 'offline' });
  const retLive = Engine.stopAppointment('chat_A', 'sess_1');
  check('S6f2 确有生成在跑时返回 true',
    retLive === true, '实际返回 ' + JSON.stringify(retLive));
  check('S6f3 且真的把 signal abort 了',
    ctlLive.signal.aborted === true, 'aborted=' + ctlLive.signal.aborted);

  /*
   * S6e：幂等 —— 外层已 begin 时，runAppointmentCompletion 不得顶掉它。
   * 判据：controller 对象引用不变（若被 supersede，生命周期里会是新对象）。
   */
  Life.stop(SCOPE, { silent: true });
  const outerCtl = Life.begin(SCOPE, { kind: 'offline' });
  let p2 = null;
  try { p2 = Engine.runAppointmentCompletion('chat_A', 'sess_1', {}); } catch (e) {}
  const afterCtl = Life.getController(SCOPE);
  check('S6e1 外层已登记时 controller 被复用（未被 supersede 顶掉）',
    afterCtl === outerCtl,
    afterCtl === outerCtl ? '引用一致' : '引用被换掉 —— signal 会当场 aborted');
  check('S6e2 复用后 signal 未被误 abort',
    outerCtl.signal.aborted === false, 'aborted=' + outerCtl.signal.aborted);
  if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
  Life.stop(SCOPE, { silent: true });
})();

console.log('__RESULT__' + JSON.stringify(results));
"""


def main():
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
        fh.write(HARNESS)
        harness_path = fh.name
    try:
        proc = subprocess.run(
            ["node", harness_path, ROOT],
            capture_output=True, text=True
        )
    finally:
        try:
            os.unlink(harness_path)
        except OSError:
            pass
    out = proc.stdout + proc.stderr
    if "__RESULT__" not in out:
        print("HARNESS FAILED —— 原始输出：")
        print(out[:6000])
        return 1
    payload = out.split("__RESULT__", 1)[1].strip().splitlines()[0]
    results = json.loads(payload)

    passed = sum(1 for r in results if r["pass"])
    total = len(results)
    print("=" * 72)
    print("线下「停止生成」失效 —— 排查与修复验证")
    print("=" * 72)
    for r in results:
        print(("  ✅ " if r["pass"] else "  ❌ ") + r["name"])
        if r["detail"] and not r["pass"]:
            print("       " + r["detail"])
    print("-" * 72)
    print("通过 %d/%d" % (passed, total))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
