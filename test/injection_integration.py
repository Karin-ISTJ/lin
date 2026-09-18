#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 深度注入集成测试

与 injection_unit.py 的分工：
  unit  —— 直接调 insertWorldbookInChatMessages()，验证**插入算法**本身
  integration —— 走**真实入口** buildWorldbookBundle() → 组装 apiMessages，
                 验证「词条从世界书一路走到 prompt」这条链路没断

为什么必须有它：v7 曾漏掉 buildWorldbookBundle 里挑出 inChatItems 的那一行，
导致 wbBundle.inChatItems 恒为 undefined、插入函数空转。
单元测试直接调插入函数，**测不到这个断裂** —— 它只测了「函数对不对」，
没测「函数有没有被喂到数据」。集成测试专门堵这个。

跑法：
    python3 test/injection_integration.py
"""
import os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

JS = r"""
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = process.argv[2];
let pass = 0, fail = 0;
function ck(name, ok, detail) {
  (ok ? pass++ : fail++);
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? '  \u2014\u2014 ' + detail : ''));
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/* 浏览器 IIFE 模块需要的最小宿主环境 */
function makeSandbox() {
  const s = { console, Date, Math, JSON, setTimeout: () => 0, clearTimeout: () => {}, Promise };
  s.window = s; s.globalThis = s;
  s.localStorage = {
    _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }, key() { return null; },
    get length() { return Object.keys(this._d).length; },
  };
  s.document = {
    getElementById() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, addEventListener() {},
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
    body: { appendChild() {}, addEventListener() {} },
  };
  s.navigator = { userAgent: 'node' };
  s.fetch = () => Promise.reject(new Error('no network'));
  s.URL = { createObjectURL() { return ''; }, revokeObjectURL() {} };
  s.Blob = function () {};
  vm.createContext(s);
  return s;
}

/* 世界书链路所需的模块，按依赖顺序加载 */
const WB_MODULES = [
  'js2/miya-token.js',
  'js2/miya-worldbook-st.js',
  'js2/miya-worldbook-matcher.js',
  'js2/miya-worldbook-store.js',
  'js2/miya-worldbook-prompt.js',
];

function loadEngine() {
  const s = makeSandbox();
  WB_MODULES.forEach(p => vm.runInContext(read(p), s, { filename: p }));
  vm.runInContext(read('js1/miya-chat-engine.js'), s, { filename: 'js1/miya-chat-engine.js' });
  return s;
}

function idx(arr, text) {
  return arr.findIndex(m => m && String(m.content || '').includes(text));
}
function contents(arr) {
  return arr.map(m => String((m && m.content) || ''));
}

(async function () {
  const s = loadEngine();
  const eng = s.miyaChatEngine;
  const P = s.miyaWorldbookPrompt;

  if (!eng || typeof eng.buildWorldbookBundle !== 'function') {
    console.log('  \u2717 miyaChatEngine.buildWorldbookBundle 不可用');
    console.log('通过 0 / 共 1');
    process.exit(1);
  }

  /* ---------------------------------------------------------------
   * 【1】链路完整性：buildWorldbookBundle 必须把 inChatItems 透出来
   *     这是 v7 断裂的地方 —— 单元测试测不到
   * --------------------------------------------------------------- */
  console.log('\n  【1】链路完整性：bundle 必须透出 inChatItems');

  /* buildWorldbookPrompt 直接产出的形状（对照组） */
  const direct = P.buildWorldbookPrompt({
    entries: [
      { id: 'd1', position: 4, depth: 'middle', injection_depth: 2, content: '深度A', keywords: [], key: [], constant: true },
    ],
    contextText: '',
  });
  ck('buildWorldbookPrompt 产出 inChatItems',
    Array.isArray(direct.inChatItems) && direct.inChatItems.length === 1,
    '实际 ' + (direct.inChatItems || []).length);

  /* 真实入口：buildWorldbookBundle（contact=null 时走 store，这里显式塞 store） */
  const Store = s.miyaWorldbookStore;
  await Store.whenReady();
  await Store.upsertEntry({
    id: 'd1', name: '深度A', content: '深度A', keywords: [], key: [],
    constant: true, position: 4, injection_depth: 2, enabled: true,
  });

  const bundle = eng.buildWorldbookBundle(null, '', null, { promptContext: 'online' });
  console.log('    bundle 的键: ' + Object.keys(bundle).join(', '));
  ck('bundle 含 inChatItems 字段', 'inChatItems' in bundle);
  ck('bundle.inChatItems 是数组', Array.isArray(bundle.inChatItems));
  ck('bundle.inChatItems 非空（链路通了）',
    Array.isArray(bundle.inChatItems) && bundle.inChatItems.length === 1,
    '实际 ' + (bundle.inChatItems || []).length);
  ck('bundle.meta 记录 inChatCount',
    bundle.meta && bundle.meta.inChatCount === 1,
    'meta.inChatCount=' + (bundle.meta && bundle.meta.inChatCount));

  /* ---------------------------------------------------------------
   * 【2】端到端：词条真的插进了 apiMessages 的预期位置
   * --------------------------------------------------------------- */
  console.log('\n  【2】端到端：插入位置符合 injection_depth');

  function assemble(inChatItems, historyLen) {
    const msgs = [];
    for (let i = 0; i < (historyLen == null ? 6 : historyLen); i++) {
      msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'h' + i });
    }
    eng.insertWorldbookInChatMessages(msgs, inChatItems);
    return msgs;
  }

  const items = bundle.inChatItems || [];
  const built = assemble(items, 6);
  console.log('    结果: ' + contents(built).join(' | '));
  /* depth=2 → 从末尾往回数第 2 条之前，即下标 6-2=4 */
  const at = idx(built, '深度A');
  ck('深度词条落在下标 4（depth=2, len=6）', at === 4, '实际 ' + at);
  ck('深度词条角色为 system', (built[at] || {}).role === 'system');
  ck('历史 6 条一条不少', built.filter(m => /^h\d$/.test(m.content)).length === 6);

  /* ---------------------------------------------------------------
   * 【3】三条引擎路径都要接上（单聊 / 约会 / 群聊）
   * --------------------------------------------------------------- */
  console.log('\n  【3】三个引擎的 bundle 构造都必须带 inChatItems');

  /* 单聊：buildWorldbookBundle（已在上文验证） */
  ck('单聊 buildWorldbookBundle 带 inChatItems', Array.isArray(bundle.inChatItems));

  /* 约会：mergeWorldbookBundles 是多角色场景的合并器，必须保留 */
  const ae = s.miyaAppointmentEngine;
  if (ae && typeof ae.mergeWorldbookBundles === 'function') {
    const merged = ae.mergeWorldbookBundles([
      { frontLayers: [], layers: [], backLayers: [], inChatItems: [{ id: 'x', content: '约会词条', depth: 1, order: 100 }], matched: [] },
      { frontLayers: [], layers: [], backLayers: [], inChatItems: [{ id: 'y', content: '约会词条2', depth: 3, order: 100 }], matched: [] },
    ]);
    ck('约会 mergeWorldbookBundles 保留 inChatItems',
      Array.isArray(merged.inChatItems) && merged.inChatItems.length === 2,
      '实际 ' + (merged.inChatItems || []).length);
    ck('合并后 depth 信息未丢',
      (merged.inChatItems || []).every(i => Number.isFinite(Number(i.depth))));
  } else {
    /* 无独立导出时，退化为源码扫描 —— 退化为扫描要说明，别让人以为是真的验证过 */
    const src = read('js1/miya-appointment-engine.js');
    const ok = /\(b\.inChatItems \|\| \[\]\)/.test(src);
    ck('约会 mergeWorldbookBundles 保留 inChatItems', ok,
      ok ? '（源码扫描：函数未导出，退化为静态检查）' : '未在源码中找到合并逻辑');
  }

  /* 群聊：buildGroupWorldbookBundle 是内部函数，扫源码确认返回对象带字段 */
  const gsrc = read('js1/miya-chat-group.js');
  const gok = /inChatItems: Array\.isArray\(result && result\.inChatItems\)/.test(gsrc);
  ck('群聊 bundle 构造返回 inChatItems', gok,
    gok ? '（源码扫描：函数未导出，退化为静态检查）' : '未在源码中找到字段透出');

  /* ---------------------------------------------------------------
   * 【4】断链回归：逆向验证测试本身有效
   *     把 inChatItems 人为抽掉，插入必须"什么都不做" —— 说明
   *     本测试确实能发现断链，而不是恒真
   * --------------------------------------------------------------- */
  console.log('\n  【4】反向验证：喂 undefined 时行为应退化（证明测试非恒真）');
  const noItems = assemble(undefined, 6);
  ck('传 undefined 不插入任何内容', noItems.length === 6 && idx(noItems, '深度A') === -1);
  const emptyItems = assemble([], 6);
  ck('传空数组不插入任何内容', emptyItems.length === 6);

  /* ---------------------------------------------------------------
   * 【5】depth 越大越靠前，且 history 顺序不被破坏（集成视角）
   * --------------------------------------------------------------- */
  console.log('\n  【5】多条深度词条：位置与历史完整性');
  const multi = [
    { id: 'a', content: '浅', depth: 0, order: 100 },
    { id: 'b', content: '中', depth: 3, order: 100 },
    { id: 'c', content: '深', depth: 5, order: 100 },
  ];
  const built2 = assemble(multi, 8);
  console.log('    结果: ' + contents(built2).join(' | '));
  /* depth=0 语义是「最后一条之后」，故应落在数组最末（含另两条深度注入共 11 条） */
  ck('浅(0) 落在数组最末', idx(built2, '浅') === built2.length - 1,
    '实际 ' + idx(built2, '浅') + ' / 末尾 ' + (built2.length - 1));
  ck('深(5) 在中(3) 之前', idx(built2, '深') < idx(built2, '中'));
  ck('历史 8 条相对顺序未变',
    built2.filter(m => /^h\d$/.test(m.content)).map(m => m.content).join(',') === 'h0,h1,h2,h3,h4,h5,h6,h7');

  console.log('\n' + '\u2550'.repeat(56));
  console.log('\u901a\u8fc7 ' + pass + ' / \u5171 ' + (pass + fail));
  if (fail) console.log('\u5931\u8d25 ' + fail + ' \u9879');
  console.log('\u2550'.repeat(56));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('\u8fd0\u884c\u5f02\u5e38: ' + (e && e.stack || e));
  process.exit(1);
});
"""

print("=" * 58)
print("Karin · 深度注入集成测试")
print("=" * 58)

fd, tmp = tempfile.mkstemp(suffix=".js", prefix="karin_injection_it_")
os.close(fd)
try:
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(JS)
    r = subprocess.run(["node", tmp, ROOT], capture_output=True, text=True)
finally:
    os.unlink(tmp)

sys.stdout.write(r.stdout)
if r.stderr:
    sys.stderr.write(r.stderr)
sys.exit(r.returncode if r.returncode is not None else 1)
