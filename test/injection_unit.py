#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 深度注入（@深度）单元回归

覆盖三块，全部在 Node 里用 vm 加载浏览器 IIFE 模块，无需起服务：

  A. 插入语义   js1/miya-chat-engine.js        insertWorldbookInChatMessages()
  B. 分桶与透出 js2/miya-worldbook-prompt.js   buildWorldbookPrompt()
  C. 字段归一   js2/miya-worldbook-st.js       normalizeStFields()（经 store 落库）

跑法：
    python3 test/injection_unit.py
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

/* ---------- A. 插入语义 ---------- */
(function () {
  const s = { console, Date, Math, JSON, setTimeout: () => 0, clearTimeout: () => {}, Promise };
  s.window = s; s.globalThis = s; vm.createContext(s);
  vm.runInContext(read('js1/miya-chat-engine.js'), s, { filename: 'engine.js' });
  const E = s.miyaChatEngine;
  if (!E || typeof E.insertWorldbookInChatMessages !== 'function') {
    ck('miyaChatEngine.insertWorldbookInChatMessages 已导出', false, '缺失');
    return;
  }
  ck('miyaChatEngine.insertWorldbookInChatMessages 已导出', true);

  const mk = (n) => { const o = []; for (let i = 0; i < (n == null ? 5 : n); i++) o.push({ role: 'user', content: 'm' + i }); return o; };
  const idx = (a, t) => a.findIndex(x => x.content === t);
  const body = (a) => a.map(x => x.content);

  console.log('\n  【1】单条插入 depth → 下标');
  [[0, 5], [1, 4], [2, 3], [5, 0], [9, 0]].forEach(function (kv) {
    const d = kv[0], want = kv[1];
    const a = mk();
    E.insertWorldbookInChatMessages(a, [{ content: 'X', depth: d, order: 100 }]);
    const got = idx(a, 'X');
    ck('depth=' + d + ' → 下标 ' + got + '（期望 ' + want + '）', got === want);
  });

  console.log('\n  【2】多条不同 depth：抓索引漂移（最关键）');
  const a2 = mk(6);
  E.insertWorldbookInChatMessages(a2, [
    { content: 'D3', depth: 3, order: 100 },
    { content: 'D1', depth: 1, order: 100 },
    { content: 'D0', depth: 0, order: 100 },
  ]);
  console.log('    结果: ' + body(a2).join(' '));
  ck('D0 落在数组最末', a2[a2.length - 1].content === 'D0');
  ck('D3 落在准确下标 3', idx(a2, 'D3') === 3, '实际 ' + idx(a2, 'D3'));
  ck('m0..m5 相对顺序未被破坏',
    a2.filter(x => /^m\d$/.test(x.content)).map(x => x.content).join(',') === 'm0,m1,m2,m3,m4,m5');
  ck('D1 位于 D0 之前（depth=1 语义）', idx(a2, 'D1') < idx(a2, 'D0'));

  console.log('\n  【3】结果与输入次序无关');
  const runOrder = (order) => { const arr = mk(6); E.insertWorldbookInChatMessages(arr, order); return body(arr).join(' '); };
  const o1 = runOrder([{ content: 'D3', depth: 3, order: 100 }, { content: 'D1', depth: 1, order: 100 }, { content: 'D0', depth: 0, order: 100 }]);
  const o2 = runOrder([{ content: 'D0', depth: 0, order: 100 }, { content: 'D3', depth: 3, order: 100 }, { content: 'D1', depth: 1, order: 100 }]);
  const o3 = runOrder([{ content: 'D1', depth: 1, order: 100 }, { content: 'D0', depth: 0, order: 100 }, { content: 'D3', depth: 3, order: 100 }]);
  ck('三种输入次序结果一致', o1 === o2 && o2 === o3);

  console.log('\n  【4】同 depth 按 order 升序');
  const a4 = mk();
  E.insertWorldbookInChatMessages(a4, [
    { content: 'HIGH', depth: 2, order: 900 },
    { content: 'LOW', depth: 2, order: 10 },
  ]);
  ck('order 小的排前面', idx(a4, 'LOW') < idx(a4, 'HIGH'));

  console.log('\n  【5】边界');
  const b1 = [];
  E.insertWorldbookInChatMessages(b1, [{ content: 'X', depth: 3, order: 1 }]);
  ck('空历史：不崩且内容保留', b1.length === 1 && b1[0].content === 'X');
  const b2 = mk();
  E.insertWorldbookInChatMessages(b2, [{ content: '', depth: 1, order: 1 }, { content: null, depth: 1, order: 1 }]);
  ck('空内容被跳过', b2.length === 5);
  const b3 = mk();
  E.insertWorldbookInChatMessages(b3, []);
  ck('空输入：无副作用', b3.length === 5 && b3[0].content === 'm0');
  const b4 = mk();
  E.insertWorldbookInChatMessages(b4, [{ content: 'N', depth: -5, order: 1 }]);
  ck('负 depth 视作 0（追加末尾）', b4[b4.length - 1].content === 'N');
  const b5 = mk();
  E.insertWorldbookInChatMessages(b5, null);
  ck('null 输入不崩', b5.length === 5);
  const b6 = mk();
  E.insertWorldbookInChatMessages(b6, [{ content: 'Q', order: 1 }]);
  ck('缺 depth 字段视作 0', b6[b6.length - 1].content === 'Q');
  ck('非法 apiMessages 不崩', (function () {
    try { E.insertWorldbookInChatMessages(null, [{ content: 'x', depth: 1 }]); return true; } catch (e) { return false; }
  })());

  console.log('\n  【6】插入条目角色为 system');
  const a6 = mk();
  E.insertWorldbookInChatMessages(a6, [{ content: 'S', depth: 1, order: 1 }]);
  ck('role=system', (a6[idx(a6, 'S')] || {}).role === 'system');
})();

/* ---------- B/C. 分桶 + 字段归一（异步） ---------- */
(function () {
  const s = { console, Date, Math, JSON, setTimeout: () => 0, clearTimeout: () => {}, Promise };
  s.window = s; s.globalThis = s;
  s.localStorage = {
    _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }, key() { return null; }, get length() { return Object.keys(this._d).length; },
  };
  vm.createContext(s);
  ['js2/miya-token.js', 'js2/miya-worldbook-st.js', 'js2/miya-worldbook-matcher.js',
   'js2/miya-worldbook-store.js', 'js2/miya-worldbook-prompt.js'].forEach(function (p) {
    vm.runInContext(read(p), s, { filename: p });
  });
  const P = s.miyaWorldbookPrompt, Store = s.miyaWorldbookStore, ST = s.miyaWorldbookST;

  (async function () {
    console.log('\n  【7】injection_depth 优先级（UI 填的深度不得被静默覆盖）');
    const cases = [[4, 1], [4, 3], [4, 5], [4, 8], [4, 12], [4, 0]];
    for (const kv of cases) {
      const pos = kv[0], depth = kv[1];
      await Store.upsertEntry(Object.assign({ id: 'p' + depth, name: 'T', content: 'c', keywords: ['k'], key: ['k'] },
        { position: pos, depth: 'back', injection_depth: depth }));
      const e = Store.getEntry('p' + depth);
      ck('position=4 且 UI 填 ' + depth + ' → 存为 ' + e.injection_depth,
        e.injection_depth === depth, '实际 ' + e.injection_depth);
    }

    console.log('\n  【8】两条录入路线结果一致');
    function uiSubmit(position, userDepth) {
      let depth = position === 0 ? 'front' : 'middle';
      if (ST.positionToDepth && position !== 4) depth = ST.positionToDepth(position);
      return { position: position, depth: depth, injection_depth: userDepth };
    }
    await Store.upsertEntry(Object.assign({ id: 'ui1', name: 'UI', content: '内容U', keywords: ['k'], key: ['k'] }, uiSubmit(4, 7)));
    await Store.upsertEntry({ id: 'im1', name: 'IM', content: '内容I', keywords: ['k'], key: ['k'], position: 4, depth: 7, injection_depth: 7 });
    const A = Store.getEntry('ui1'), B = Store.getEntry('im1');
    ck("UI 路线 depth 不是 'back'", A.depth !== 'back', 'depth=' + JSON.stringify(A.depth));
    ck('两路线 position 相同', A.position === B.position);
    ck('两路线 injection_depth 相同', A.injection_depth === B.injection_depth,
      A.injection_depth + ' vs ' + B.injection_depth);

    console.log('\n  【9】position=4 进 inChat 桶，不进 back 桶');
    const sel = [A, B,
      { id: 'f', position: 0, depth: 'front', content: 'F', keywords: ['k'], key: ['k'] },
      { id: 'm', position: 1, depth: 'middle', content: 'M', keywords: ['k'], key: ['k'] },
    ];
    const p = P.buildWorldbookPrompt({ entries: sel, contextText: 'k', scanDepth: 5 });
    console.log('    分桶: front=' + p.frontCount + ' middle=' + p.middleCount +
                ' back=' + p.backCount + ' inChat=' + p.inChatCount);
    ck('inChat 桶有 2 条', p.inChatCount === 2, '实际 ' + p.inChatCount);
    ck('back 桶为 0（替换而非共存）', p.backCount === 0, '实际 ' + p.backCount);
    ck('inChatItems 结构化透出', Array.isArray(p.inChatItems) && p.inChatItems.length === 2);
    if (p.inChatItems && p.inChatItems.length) {
      const it = p.inChatItems[0];
      ck('item 带 depth 字段', Number.isFinite(it.depth));
      ck('item 带 order 字段', Number.isFinite(it.order));
      ck('item 带 content 内容', !!it.content);
      ck('depth 为用户填的 7（未被覆盖）', it.depth === 7, '实际 ' + it.depth);
    }
    ck('back 文本块不含 @深度 内容', !(p.sections.back || '').includes('内容U'));

    console.log('\n  【10】两路一致性：面板预览 vs 主流程（防再次分叉）');
    /* 同一个 position=4 词条，两条路如果分桶不同，就会出现
       「面板说按后注入、实际按深度插」这类说谎。
       历史上正是这么错的（st.js 曾把它同时推进 back 和 inChat）。 */
    const probe = [
      { id: 'x1', position: 4, depth: 'middle', injection_depth: 3, content: '深度词条', keywords: [], key: [], constant: true },
      { id: 'x2', position: 0, depth: 'front', content: '前置', keywords: [], key: [], constant: true },
      { id: 'x3', position: 1, depth: 'middle', content: '中置', keywords: [], key: [], constant: true },
      { id: 'x4', position: 2, depth: 'back', content: '后置', keywords: [], key: [], constant: true },
    ];
    const prev = ST.runPipeline(probe, { contextText: '', dryRun: true });
    const main = P.buildWorldbookPrompt({ entries: probe, contextText: '' });
    const pb = prev.buckets || {};
    const shape = (f, m, b, i) => 'front=' + f + ' middle=' + m + ' back=' + b + ' inChat=' + i;
    console.log('    预览 runPipeline      : ' + shape((pb.front || []).length, (pb.middle || []).length, (pb.back || []).length, (pb.inChat || []).length));
    console.log('    主流程 buildWorldbook : ' + shape(main.frontCount, main.middleCount, main.backCount, main.inChatCount));
    ck('两路 front 桶一致', (pb.front || []).length === main.frontCount);
    ck('两路 middle 桶一致', (pb.middle || []).length === main.middleCount);
    ck('两路 back 桶一致', (pb.back || []).length === main.backCount);
    ck('两路 inChat 桶一致', (pb.inChat || []).length === main.inChatCount);
    ck('两条路都不把 position=4 放进 back',
      !(pb.back || []).some(e => Number(e.position) === 4) && main.backCount === 1,
      '预览 back=' + (pb.back || []).length + ' 主流程 back=' + main.backCount);

    console.log('\n' + '═'.repeat(56));
    console.log('通过 ' + pass + ' / 共 ' + (pass + fail));
    if (fail) console.log('失败 ' + fail + ' 项');
    console.log('═'.repeat(56));
    process.exit(fail ? 1 : 0);
  })().catch(function (e) {
    console.error('运行异常: ' + (e && e.stack || e));
    process.exit(1);
  });
})();
"""

print("=" * 58)
print("Karin · 深度注入单元回归")
print("=" * 58)

fd, tmp = tempfile.mkstemp(suffix=".js", prefix="karin_injection_")
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
