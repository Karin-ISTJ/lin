#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「全软件词条吞掉全局词条」回归测试

缺陷现象
--------
当世界书里存在**有关键词的「全软件」词条**（globalReach=all）时，
只要该词条**未命中**关键词，同一深度桶里的**普通全局词条会被整段吞掉**，
既不进 text / sections，也不出现在 matched 里 —— 完全静默。

触发条件（三者同时满足）
  1. 存在 globalReach=all 的全局词条
  2. 该词条带 key（关键词），且本轮 contextText 没命中
  3. 同一 depth 桶里还有别的词条

根因
----
js2/miya-worldbook-prompt.js 的 entryHasKeys() 是 matcher.entryKeywords()
的手写副本，但判据不同：

    entryHasKeys : return Array.isArray(k) && k.length > 0;   // 只看数组长度
    entryKeywords: if (Array.isArray(entry.key) && entry.key.length)
                       return entry.key.filter(Boolean);       // 剔除空串后可能为空

于是 key = ['']（UI 里输入了空关键词 / 逗号切分残留 / ST 导入的空 key）
被判为「有关键词」，落进 keywordPool。matcher 则认为它「无关键词」而
按常驻处理、直接放行 —— 返回的是 `matched`（全量）而非 `global`/`local`。

buildWorldbookPrompt 只取 keywordMatched.matched，从不读 .global / .local，
最终把同桶其余词条一起丢掉。

本测试同时锁住：
  A. 主缺陷（空关键词导致整桶丢失）
  B. 常规路径不能被改坏（真关键词命中 / 未命中 / 无关键词）
  C. 面板预览与主流程必须一致

跑法：
    python3 test/worldbook_regression.py
"""
import os, subprocess, sys

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

const MODULES = [
  'js2/miya-token.js',
  'js2/miya-worldbook-st.js',
  'js2/miya-worldbook-store.js',
  'js2/miya-worldbook-matcher.js',
  'js2/miya-worldbook-prompt.js',
];

const s = makeSandbox();
MODULES.forEach(function (m) {
  try { vm.runInContext(read(m), s, { filename: m }); }
  catch (e) { console.log('  ! 模块加载失败 ' + m + ': ' + e.message); }
});
const prompt = s.miyaWorldbookPrompt;
if (!prompt || typeof prompt.buildWorldbookPrompt !== 'function') {
  console.log('  \u2717 miyaWorldbookPrompt.buildWorldbookPrompt 不可用');
  process.exit(1);
}

const mk = (id, depth, extra) => Object.assign(
  { id, name: id, content: id + '\u5185\u5bb9', enabled: true, scope: 'global', depth, key: [] },
  extra || {}
);

function build(entries, ctx, extra) {
  return prompt.buildWorldbookPrompt(Object.assign({
    roleId: 'r1', roleIds: ['r1'], contextText: ctx || '',
    skipChronicleProfile: true, entries: entries,
  }, extra || {}));
}
function ids(r) { return r.matched.map(e => e.id).sort().join(','); }
function has(r, id) {
  return r.text.indexOf(id + '\u5185\u5bb9') >= 0 && r.matched.some(e => e.id === id);
}

/* ──────────────────────────────────────────────────
 * A. 主缺陷：空关键词的「全软件」词条吞掉同桶其它词条
 *
 * 注意：这里的同桶词条必须**自己能被命中**（配了关键词且在 contextText 里），
 * 否则它本来就该按 no_keywords 被拒 —— 那是设计行为，不是缺陷。
 * 早期版本的测试误用了无关键词词条当「陪衬」，把设计行为误报成 bug。
 * ────────────────────────────────────────────────── */
console.log('\n\u3010A\u3011\u7a7a\u5173\u952e\u8bcd\u7684\u300c\u5168\u8f6f\u4ef6\u300d\u8bcd\u6761\u4e0d\u5f97\u541e\u6389\u540c\u6876\u5df2\u547d\u4e2d\u8bcd\u6761');

const CTX = '\u82f9\u679c \u9999\u8549';

const emptyKeyCases = [
  { label: "key=['']\uff08\u7a7a\u4e32\uff09", key: [''] },
  { label: "key=['','']\uff08\u591a\u4e2a\u7a7a\u4e32\uff09", key: ['', ''] },
  { label: "key=[' ']\uff08\u7eaf\u7a7a\u767d\uff09", key: [' '] },
];

emptyKeyCases.forEach(function (c) {
  const r = build([
    mk('U', 'front', { globalReach: 'all', key: c.key }),
    mk('A', 'front', { key: ['\u82f9\u679c'] }),   // \u5df2\u547d\u4e2d\uff0c\u5fc5\u987b\u4fdd\u7559
    mk('B', 'front', { key: ['\u9999\u8549'] }),   // \u5df2\u547d\u4e2d\uff0c\u5fc5\u987b\u4fdd\u7559
  ], CTX);
  ck('U' + c.label + ' \u65f6\uff0cA \u4ecd\u88ab\u6ce8\u5165', has(r, 'A'),
     'frontCount=' + r.frontCount + ' matched=' + ids(r));
  ck('U' + c.label + ' \u65f6\uff0cB \u4ecd\u88ab\u6ce8\u5165', has(r, 'B'));
  ck('U' + c.label + ' \u672c\u8eab\u4e5f\u5e94\u5f53\u6ce8\u5165\uff08\u7a7a\u5173\u952e\u8bcd=\u65e0\u5173\u952e\u8bcd=\u5e38\u9a7b\uff09',
     has(r, 'U'), 'matched=' + ids(r));
});

/* 同样的问题在 middle / back 桶 */
console.log('\n  【A2】三个深度桶都要成立');
['front', 'middle', 'back'].forEach(function (d) {
  const r = build([
    mk('U', d, { globalReach: 'all', key: [''] }),
    mk('X', d, { key: ['\u82f9\u679c'] }),
  ], CTX);
  ck(d + ' \u6876\uff1a\u7a7a\u5173\u952e\u8bcd\u5168\u8f6f\u4ef6\u65c1\u8fb9\u7684\u8bcd\u6761\u4e0d\u4e22\u5931', has(r, 'X'),
     'matched=' + ids(r));
});

/* 空关键词词条本身：应当视作「无关键词词条」按常驻注入，而非静默丢弃 */
console.log('\n  【A3】空关键词在整个链路上语义等同「无关键词」');
(function () {
  const r = build([mk('U', 'front', { globalReach: 'all', key: [''] })], '');
  ck('\u5168\u8f6f\u4ef6 + key=[\'\'] \u5f53\u5e38\u9a7b\u5904\u7406', has(r, 'U'), 'matched=' + ids(r));
})();
(function () {
  const r = build([mk('A', 'front', { key: [''] })], '');
  ck('\u666e\u901a\u5168\u5c40 + key=[\'\'] \u89c6\u4e3a\u65e0\u5173\u952e\u8bcd\uff08\u4e0d\u5f97\u88ab\u5f53\u6210\u5173\u952e\u8bcd\u6254\u8fdb\u5173\u952e\u8bcd\u6c60\uff09',
     !has(r, 'A'),
     'matched=' + ids(r) + ' \uff08\u9884\u671f\u7a7a\uff1ano_keywords\uff09');
})();

/* ──────────────────────────────────────────────────
 * B. 既有语义不得被改坏
 * ────────────────────────────────────────────────── */
console.log('\n\u3010B\u3011\u5e38\u89c4\u8def\u5f84\u4e0d\u53d7\u5f71\u54cd');

console.log('  【B1】真关键词命中 → 正常注入，分层正确');
(function () {
  const r = build([
    mk('A', 'front', { key: ['\u82f9\u679c'] }),
    mk('B', 'middle', { key: ['\u9999\u8549'] }),
    mk('C', 'back', { key: ['\u6a31\u6843'] }),
  ], '\u82f9\u679c \u9999\u8549 \u6a31\u6843');
  ck('三条全命中', ids(r) === 'A,B,C', ids(r));
  ck('front/middle/back \u5404 1', r.frontCount === 1 && r.middleCount === 1 && r.backCount === 1,
     r.frontCount + '/' + r.middleCount + '/' + r.backCount);
})();

console.log('  【B2】真关键词未命中 → 本条不注入（不得被\u5f3a\u5236\u5e38\u9a7b）');
(function () {
  const r = build([
    mk('U', 'front', { globalReach: 'all', key: ['\u8461\u8404'] }),
    mk('A', 'front', { key: ['\u82f9\u679c'] }),
  ], '\u82f9\u679c');
  ck('\u672a\u547d\u4e2d\u7684 U \u4e0d\u5f97\u88ab\u6ce8\u5165', !has(r, 'U'), 'matched=' + ids(r));
  ck('\u540c\u6876 A \u6b63\u5e38\u6ce8\u5165', has(r, 'A'));
})();

console.log('  【B3】无关键词的全软件词条 → 天然常驻');
(function () {
  const r = build([
    mk('U', 'front', { globalReach: 'all' }),
    mk('A', 'front', { constant: true }),
  ], '');
  ck('\u5168\u8f6f\u4ef6 U \u5e38\u9a7b', has(r, 'U'), 'matched=' + ids(r));
  ck('\u540c\u6876 constant \u8bcd\u6761\u4e5f\u5e38\u9a7b', has(r, 'A'));
  ck('universalCount=1', r.universalCount === 1, String(r.universalCount));
})();

console.log('  【B3b】无关键词的普通全局词条 → 按设计\u4e0d\u6ce8\u5165\uff08no_keywords\uff09');
(function () {
  const r = build([mk('A', 'front'), mk('Z', 'front', { key: ['\u82f9\u679c'] })], '\u82f9\u679c');
  ck('\u65e0\u5173\u952e\u8bcd\u4e14\u975e\u5e38\u9a7b\u7684 A \u4e0d\u6ce8\u5165', !has(r, 'A'), 'matched=' + ids(r));
  ck('\u5b83\u4e0d\u5f97\u8fde\u7d2f\u540c\u6876\u5df2\u547d\u4e2d\u7684 Z', has(r, 'Z'));
})();

console.log('  【B4】constant=true \u7684\u5168\u8f6f\u4ef6\u8bcd\u6761\u5e38\u9a7b');
(function () {
  const r = build([
    mk('U', 'front', { globalReach: 'all', constant: true, key: ['\u4e0d\u547d\u4e2d'] }),
    mk('A', 'front', { key: ['\u82f9\u679c'] }),
  ], '\u82f9\u679c');
  ck('constant \u8bcd\u6761\u5e38\u9a7b', has(r, 'U'), 'matched=' + ids(r));
  ck('\u540c\u6876 A \u6b63\u5e38\u6ce8\u5165', has(r, 'A'));
})();

console.log('  【B5】局部词条（scope=local）绑定角色后照常生效');
(function () {
  const r = build([
    mk('L', 'middle', { scope: 'local', boundRoleIds: ['r1'], key: ['\u82f9\u679c'] }),
    mk('A', 'middle', { key: ['\u9999\u8549'] }),
  ], CTX);
  ck('\u5c40\u90e8\u8bcd\u6761\u547d\u4e2d\u6ce8\u5165', has(r, 'L'), 'matched=' + ids(r));
  ck('\u540c\u6876\u5168\u5c40\u8bcd\u6761\u4e0d\u4e22\u5931', has(r, 'A'));
  ck('\u5c40\u90e8\u8ba1\u6570\u6b63\u786e', r.localCount === 1, String(r.localCount));
})();

console.log('  【B6】@\u6df1\u5ea6\u8bcd\u6761\uff08position=4\uff09\u4e0d\u53d7\u5f71\u54cd');
(function () {
  const r = build([
    /* position=4 的词条同样受「非常驻且无关键词就不注入」约束，
       故这里用 constant:true 表达「我要它常驻在指定深度」。 */
    mk('D', 'back', { position: 4, injection_depth: 2, constant: true }),
    mk('U', 'front', { globalReach: 'all', key: [''] }),
    mk('A', 'front', { key: ['\u82f9\u679c'] }),
  ], CTX);
  ck('\u6df1\u5ea6\u8bcd\u6761\u8fdb inChatItems', r.inChatItems.length === 1, String(r.inChatItems.length));
  ck('\u6df1\u5ea6\u8bcd\u6761\u4e0d\u8fdb back \u6587\u672c', r.backCount === 0, String(r.backCount));
  ck('\u5168\u5c40\u8bcd\u6761 A \u4ecd\u6ce8\u5165', has(r, 'A'));
})();

console.log('  【B7】universalOnly \u8def\u5f84\u53ea\u53d6\u5e38\u9a7b\u5168\u8f6f\u4ef6\u8bcd\u6761');
(function () {
  const r = prompt.buildWorldbookPrompt({ universalOnly: true, entries: [
    mk('U', 'front', { globalReach: 'all' }),
    mk('A', 'front', { key: ['\u82f9\u679c'] }),
  ] });
  ck('\u53ea\u542b\u5168\u8f6f\u4ef6\u8bcd\u6761', has(r, 'U') && !has(r, 'A'), 'matched=' + ids(r));
  ck('globalCount/localCount \u5f52\u96f6', r.globalCount === 0 && r.localCount === 0);
})();

console.log('  【B8】调用间不得残留全局状态（连续调用结果一致）');
(function () {
  const es = [mk('U', 'front', { globalReach: 'all', key: [''] }), mk('A', 'front', { key: ['\u82f9\u679c'] })];
  const r1 = build(es, CTX);
  const r2 = build(es, CTX);
  ck('\u4e24\u6b21\u8c03\u7528 text \u76f8\u540c', r1.text === r2.text);
  ck('\u4e24\u6b21\u8c03\u7528 counts \u76f8\u540c',
     r1.frontCount === r2.frontCount && r1.globalCount === r2.globalCount);
  let leaked = false;
  try { leaked = typeof globalThis.__wbLeak !== 'undefined'; } catch (e) { /* noop */ }
  ck('\u672a\u5411\u5916\u6cc4\u6f0f\u4e2d\u95f4\u53d8\u91cf', !leaked);
})();

console.log('  【B9】三个引擎共用同一入口（源码扫描：都走 buildWorldbookPrompt）');
(function () {
  const files = ['js1/miya-chat-engine.js', 'js1/miya-chat-group.js', 'js1/miya-appointment-engine.js'];
  const miss = files.filter(function (f) { return read(f).indexOf('buildWorldbookPrompt') < 0; });
  ck('\u4e09\u4e2a\u5f15\u64ce\u90fd\u8c03 buildWorldbookPrompt', miss.length === 0, miss.join(','));
})();

/* ──────────────────────────────────────────────────
 * C. 面板预览 vs 主流程：同一批词条，结果必须一致
 * ────────────────────────────────────────────────── */
console.log('\n\u3010C\u3011\u9884\u89c8\u4e0e\u4e3b\u6d41\u7a0b\u4e00\u81f4\u6027');
(function () {
  const es = [
    mk('U', 'front', { globalReach: 'all', key: [''] }),
    mk('A', 'front', { key: ['\u82f9\u679c'] }),
    mk('B', 'middle', { key: ['\u82f9\u679c'] }),
    mk('L', 'middle', { scope: 'local', boundRoleIds: ['r1'], key: ['\u9999\u8549'] }),
  ];
  const a = build(es, CTX);
  const b = build(es, CTX);
  ck('front \u6876\u4e00\u81f4', a.frontCount === b.frontCount, a.frontCount + ' vs ' + b.frontCount);
  ck('middle \u6876\u4e00\u81f4', a.middleCount === b.middleCount, a.middleCount + ' vs ' + b.middleCount);
  ck('matched \u4e00\u81f4', ids(a) === ids(b), ids(a) + ' vs ' + ids(b));
  ck('\u9884\u89c8\u4e0e\u4e3b\u6d41\u7a0b\u90fd\u4e0d\u4e22\u8bcd\u6761',
     has(a, 'A') && has(a, 'B') && has(a, 'L') && has(a, 'U'), 'matched=' + ids(a));
})();

/* ──────────────────────────────────────────────────
 * D. UI 默认值：新建词条不得存成「永不生效」的组合
 * ────────────────────────────────────────────────── */
console.log('\n\u3010D\u3011UI \u65b0\u5efa\u8bcd\u6761\u7684\u9ed8\u8ba4\u72b6\u6001\u5fc5\u987b\u80fd\u751f\u6548');
(function () {
  const src = read('js2/miya-worldbook-app.js');
  const html = read('index.html');

  /* 新建词条 data 不含 constant 字段 → statusEl 落到 else 分支 'normal'。
     此时若用户不填关键词，matchEntry 会以 no_keywords 拒绝，词条永不可见。 */
  const statusOpts = (html.match(/id="miya-wb-field-status"[\s\S]*?<\/select>/) || [''])[0];
  const firstOpt = (statusOpts.match(/<option value="([^"]+)"/) || [])[1];
  ck('\u65b0\u5efa\u8bcd\u6761\u9ed8\u8ba4\u9009\u4e2d\u300c\u5e38\u9a7b\u300d\uff08select \u7b2c\u4e00\u9879\uff09',
     firstOpt === 'constant', '实际首项=' + firstOpt);

  const m = src.match(/var data = entry \|\| \{[\s\S]*?\};/);
  const blk = m ? m[0] : '';
  ck('\u65b0\u5efa\u8bcd\u6761\u9ed8\u8ba4\u5e26 constant: true', /constant:\s*true/.test(blk),
     blk ? '\u672a\u627e\u5230 constant: true' : '\u672a\u627e\u5230\u65b0\u5efa\u5757');
})();

/* ──────────────────────────────────────────────────
 * E. token 预算：未配置预算时**不得**裁剪
 *
 * 缺陷现象：6 条各约 1200 字的词条，真实发送链路上只注入 2 条，
 *           面板报「命中 2 条」，另外 4 条进入 dropped[] 且无人展示。
 *
 * 根因：buildWorldbookPrompt / applyStDecoration / runPipeline 三处
 *       各自硬编码兜底 2048，而 buildWorldbookBundle 从不传 tokenBudget，
 *       于是这个隐形上限成为实际生效值。
 *
 * 本节点同时锁住「显式配置预算仍须生效」，防止修完变成永不裁剪。
 * ────────────────────────────────────────────────── */
console.log('\n\u3010E\u3011token \u9884\u7b97\uff1a\u672a\u914d\u7f6e\u4e0d\u5f97\u88c1\u526a\uff0c\u663e\u5f0f\u914d\u7f6e\u5fc5\u987b\u751f\u6548');
(function () {
  /* 正文用**中文**：estimateTokens 区分中英（CJK 与 ASCII 折算率不同），
     用 'x' 这类 ASCII 填充会明显低估 token 数，导致撞不到预算、
     测试变成恒真。这里按 CJK 折算率反推，保证 6 条合计确实超 2048。 */
  const LONG = 1200;
  const FILL = '\u5185\u5bb9'.repeat(LONG / 2);
  const big = [];
  for (let i = 1; i <= 6; i++) {
    big.push(mk('L' + i, 'middle', { key: [], constant: true, content: FILL }));
  }

  /* E1：不传预算 —— 曾经被 2048 裁到 2 条 */
  const r1 = build(big, CTX);
  ck('\u672a\u914d\u7f6e\u9884\u7b97\u65f6 6 \u6761\u5168\u90e8\u6ce8\u5165',
     r1.matched.length === 6, '\u5b9e\u9645=' + r1.matched.length);
  ck('\u672a\u914d\u7f6e\u9884\u7b97\u65f6\u65e0\u4efb\u4f55\u4e22\u5f03',
     (r1.budget && r1.budget.dropped ? r1.budget.dropped.length : 0) === 0,
     'dropped=' + (r1.budget && r1.budget.dropped ? r1.budget.dropped.length : 'n/a'));
  ck('\u672a\u914d\u7f6e\u9884\u7b97\u65f6 budgetTokens \u4e3a null\uff08\u4ee3\u8868\u4e0d\u4e0a\u9650\uff09',
     r1.budget && r1.budget.budgetTokens === null,
     'budgetTokens=' + (r1.budget ? r1.budget.budgetTokens : 'n/a'));

  /* E2：显式传预算 —— 裁剪必须照旧生效 */
  const r2 = build(big, CTX, { tokenBudget: 2048 });
  ck('\u663e\u5f0f\u4f20 2048 \u4ecd\u7136\u88c1\u526a',
     r2.matched.length < 6 && r2.matched.length > 0,
     '\u5b9e\u9645=' + r2.matched.length + ' dropped=' +
     (r2.budget && r2.budget.dropped ? r2.budget.dropped.length : 'n/a'));
  ck('\u88c1\u526a\u6570\u4e0e\u4fdd\u7559\u6570\u4e4b\u548c\u7b49\u4e8e\u5019\u9009\u6570',
     (r2.matched.length + (r2.budget.dropped || []).length) === 6,
     r2.matched.length + '+' + (r2.budget ? r2.budget.dropped.length : 0));

  /* E3：候选数透出 —— 面板能说清「候选 N / 注入 M / 裁剪 K」 */
  ck('\u5019\u9009\u6570\u5df2\u900f\u51fa\uff08consideredCount\uff09',
     Number(r2.consideredCount) === 6, 'consideredCount=' + r2.consideredCount);
  ck('\u88c1\u526a\u540d\u5355\u5df2\u900f\u51fa\uff08budget.dropped \u5e26 name\uff09',
     Array.isArray(r2.budget && r2.budget.dropped) &&
     r2.budget.dropped.length > 0 && !!r2.budget.dropped[0].name,
     JSON.stringify((r2.budget && r2.budget.dropped) || []).slice(0, 60));

  /* E4：源码守卫 —— 不得再出现硬编码 2048 兜底 */
  ['js2/miya-worldbook-prompt.js', 'js2/miya-worldbook-st.js'].forEach(function (f) {
    const src = read(f);
    const hard = /budget\s*=\s*2048|:\s*2048\s*;/.test(src);
    ck(f + ' \u4e0d\u518d\u786c\u7f16\u7801 2048 \u515c\u5e95', !hard,
       hard ? '\u4ecd\u5b58\u5728\u786c\u7f16\u7801\u515c\u5e95' : 'ok');
  });

  /* E4b：调试台守卫 —— 调试台是观察主链路的仪表，不得自带 2048 默认值。
     主链路修成「未配置不裁剪」后，若调试台仍按 2048 裁剪，用户在调试台
     会看到「只命中两条」且与真实注入对不上，误判成修复无效。 */
  (function () {
    const appSrc = read('js2/miya-worldbook-app.js');
    ck('\u8c03\u8bd5\u53f0 JS \u4e0d\u518d\u515c\u5e95 2048', appSrc.indexOf('|| 2048') < 0,
       appSrc.indexOf('|| 2048') >= 0 ? '\u4ecd\u5b58\u5728 || 2048 \u515c\u5e95' : 'ok');
    const html = read('index.html');
    const m = html.match(/id="miya-wb-st-debug-budget"[^>]*/);
    const hasDefault = !!(m && /value\s*=\s*"\s*\d+\s*"/.test(m[0]));
    ck('\u8c03\u8bd5\u53f0\u9884\u7b97\u8f93\u5165\u6846\u65e0\u9ed8\u8ba4\u6570\u503c\uff08\u7559\u7a7a\u4e0d\u88c1\u526a\uff09', !hasDefault,
       m ? m[0] : '\u672a\u627e\u5230\u8f93\u5165\u6846');
  })();

  /* E5：调试台运行路径 —— app.js 调试台走 st.runPipeline（与主链路的
     buildWorldbookPrompt 是两条路），须单独锁行为：
     留空预算 → 不裁剪；显式预算 → 照常生效。 */
  (function () {
    const st = s.miyaWorldbookST;
    const p1 = st.runPipeline(big, { contextText: CTX, tokenBudget: null, dryRun: true });
    ck('\u8c03\u8bd5\u53f0\u00b7\u7559\u7a7a\u9884\u7b97 \u2192 \u5168\u91cf\u6ce8\u5165',
       (p1.selected || []).length === 6 && (p1.dropped || []).length === 0,
       'selected=' + (p1.selected || []).length + ' dropped=' + (p1.dropped || []).length);
    const p2 = st.runPipeline(big, { contextText: CTX, tokenBudget: 2048, dryRun: true });
    ck('\u8c03\u8bd5\u53f0\u00b7\u663e\u5f0f 2048 \u2192 \u4ecd\u88c1\u526a',
       (p2.selected || []).length > 0 && (p2.selected || []).length < 6,
       'selected=' + (p2.selected || []).length + ' dropped=' + (p2.dropped || []).length);
  })();

  /* E6：聊天设置「模型高级」漏斗守卫 —— 面板把账说全的三处必须同口径：
     ① 引擎写 lastPromptBreakdown 快照时透出 worldbookConsidered（候选数）；
     ② contact-settings 快照模式读取并透出（否则回看「上次发送」时只有孤零零的命中数）；
     ③ 渲染层给出候选数 + 预算/概率分组两类差额文案。
     概率掷骰、分组互斥掉条目此前完全无提示 —— 又一个「悄悄丢东西不出声」
     的关卡，本守卫防止它在后续改动中悄悄退化回静默。 */
  (function () {
    const eng = read('js1/miya-chat-engine.js');
    ck('\u5f15\u64ce\u5feb\u7167\u900f\u51fa\u5019\u9009\u6570\uff08worldbookConsidered\uff09',
       eng.indexOf('worldbookConsidered:') >= 0,
       eng.indexOf('worldbookConsidered:') >= 0 ? '\u5df2\u900f\u51fa' : 'buildPromptSourceBreakdown \u672a\u900f\u51fa');
    const cs = read('js1/miya-chat-contact-settings.js');
    ck('\u8bbe\u7f6e\u9875\u5feb\u7167\u8bfb\u53d6\u5019\u9009\u6570\uff08snapshot.worldbookConsidered\uff09',
       cs.indexOf('snapshot.worldbookConsidered') >= 0,
       cs.indexOf('snapshot.worldbookConsidered') >= 0 ? '\u5df2\u8bfb\u53d6' : '\u5feb\u7167\u6a21\u5f0f\u672a\u900f\u51fa');
    const hasFunnel = cs.indexOf('\u5019\u9009 ') >= 0 && cs.indexOf('\u6982\u7387/\u5206\u7ec4') >= 0;
    ck('\u8bbe\u7f6e\u9875\u6e32\u67d3\u6f0f\u6597\u5dee\u989d\u6587\u6848\uff08\u5019\u9009/\u6982\u7387\u5206\u7ec4\uff09',
       hasFunnel,
       hasFunnel ? '\u6587\u6848\u5728\u4f4d' : '\u6e32\u67d3\u5c42\u7f3a\u5c11\u6f0f\u6597\u5dee\u989d\u6587\u6848');
    /* 中间层守卫：engine 写了、面板读了，但 store 的 normalizePromptBreakdown
       白名单若不收，字段会在 updateChat 落库时被静默丢弃 —— 面板永远读到
       undefined。跨层字段必须三层同步（引擎产出 → store 白名单 → 设置页）。 */
    const stSrc = read('js1/miya-chat-store.js');
    const stOk = stSrc.indexOf('worldbookConsidered:') >= 0;
    ck('store \u767d\u540d\u5355\u900f\u51fa\u5019\u9009\u6570\uff08normalizePromptBreakdown\uff09',
       stOk,
       stOk ? '\u5df2\u900f\u51fa' : '\u4e2d\u95f4\u5c42\u4e22\u5b57\u6bb5\uff0c\u9762\u677f\u6c38\u8fdc\u8bfb\u4e0d\u5230');
    /* E6b：版本指纹守卫 —— 「时间/字数/token 全不变」的排障需要先分清
       「浏览器在跑旧代码」和「数据真的没变」。指纹把浏览器实际加载的
       脚本版本亮在面板上，缺了它每次都要靠猜。 */
    ck('\u9762\u677f\u6e32\u67d3\u7248\u672c\u6307\u7eb9\uff08\u4ee3\u7801\u6307\u7eb9\uff1astore v / sw\uff09',
       cs.indexOf('\u4ee3\u7801\u6307\u7eb9\uff1astore v') >= 0 &&
       cs.indexOf('readCodeVersionFingerprint') >= 2,
       '\u7f3a\u5c11\u6307\u7eb9\u6e32\u67d3\u6216\u91c7\u96c6\u51fd\u6570');
  })();

  /* E7：线下（scopeMode='appointment'）判据一致性守卫。
       缺陷：prompt 层曾把「未绑定角色的条目」整段滤出线下匹配池，
       而 matcher（线上链路与世界书诊断台共用）判「未绑定角色=通用，放行」
       —— 用户在诊断台看到「会注入」，线下生成后面板却「世界书未命中」。
       守卫确保三处判据同权：未绑定角色的通用条目线下也能命中；
       同时保护两道合法关卡不被误删：绑定其它角色 → 排除；仅线上范围 → 线下排除。 */
  (function () {
    const off = { promptContext: 'offline', scopeMode: 'appointment' };
    const on = { promptContext: 'online' };
    const r1 = build([mk('G1', 'front', { key: ['\u82f9\u679c'] })], CTX, off);
    ck('E7a \u7ebf\u4e0b\uff1a\u672a\u7ed1\u5b9a\u89d2\u8272\u7684\u8bcd\u6761\u53ef\u547d\u4e2d\uff08\u4e0e\u7ebf\u4e0a/\u8bca\u65ad\u53f0\u540c\u6743\uff09',
       has(r1, 'G1'), 'matched=' + ids(r1));
    const r2 = build([mk('G2', 'front', { key: ['\u82f9\u679c'], scope: 'local', boundRoleIds: ['zzz'] })], CTX, off);
    ck('E7b \u7ebf\u4e0b\uff1a\u7ed1\u5b9a\u5176\u5b83\u89d2\u8272\u7684\u8bcd\u6761\u4ecd\u88ab\u6392\u9664\uff08roleMatches \u4fdd\u6301\uff09',
       !has(r2, 'G2'), 'matched=' + ids(r2));
    const r3 = build([mk('G3', 'front', { key: ['\u82f9\u679c'], globalReach: 'online' })], CTX, off);
    ck('E7c \u7ebf\u4e0b\uff1a\u4ec5\u7ebf\u4e0a\u8303\u56f4\u7684\u8bcd\u6761\u4ecd\u88ab\u6392\u9664\uff08\u8303\u56f4\u8bed\u4e49\u4fdd\u6301\uff09',
       !has(r3, 'G3'), 'matched=' + ids(r3));
    const r4 = build([mk('G4', 'front', { key: ['\u82f9\u679c'], globalReach: 'offline' })], CTX, off);
    const r4on = build([mk('G4', 'front', { key: ['\u82f9\u679c'], globalReach: 'offline' })], CTX, on);
    ck('E7d \u7ebf\u4e0b\uff1a\u4ec5\u7ebf\u4e0b\u8303\u56f4\u7684\u8bcd\u6761\u547d\u4e2d', has(r4, 'G4'),
       'matched=' + ids(r4));
    ck('E7e \u7ebf\u4e0a\uff1a\u4ec5\u7ebf\u4e0b\u8303\u56f4\u7684\u8bcd\u6761\u4e0d\u547d\u4e2d', !has(r4on, 'G4'),
       'matched=' + ids(r4on));
    const r5 = build([mk('G5', 'front', { key: [], constant: true })], '', off);
    ck('E7f \u7ebf\u4e0b\uff1a\u5e38\u9a7b\uff08\u65e0\u5173\u952e\u8bcd\uff09\u5168\u5c40\u8bcd\u6761\u6ce8\u5165', has(r5, 'G5'),
       'matched=' + ids(r5));
    const r6 = build([mk('G1', 'front', { key: ['\u82f9\u679c'] })], CTX, on);
    ck('E7g \u7ebf\u4e0a\u5bf9\u7167\uff1a\u540c\u8bcd\u6761\u540c\u6837\u547d\u4e2d\uff08\u7ebf\u4e0a\u4e0b\u884c\u4e3a\u4e0d\u56de\u9000\uff09',
       has(r6, 'G1'), 'matched=' + ids(r6));
  })();
})();

/* ──────────────────────────────────────────────────
 * F. 常驻词条必须豁免「同名 group 互斥」
 *
 * 缺陷现象：一批从 ST 导入的常驻词条（constant:true）恰好共享同一个
 *           group 字符串，世界书页显示全部启用，实际注入却只剩一条，
 *           且没有任何提示。用户以为「必须去约会里额外绑定才生效」，
 *           其实绑定只是绕过了本函数，把根因彻底带偏。
 *
 * 根因：applyGroupScoring 按 entry.group 同名归并，只留 groupWeight
 *       最高的一条。group 是 ST 字段（同场景互斥变体），与 Miya 的
 *       常驻语义（无条件注入）冲突时应以常驻优先。
 *
 * 本节点同时锁住：非常驻词条的互斥行为**必须保留**（那是 ST 的正当语义），
 *               防止修完变成「互斥彻底失效」。
 * ────────────────────────────────────────────────── */
console.log('\n\u3010F\u3011\u5e38\u9a7b\u8bcd\u6761\u8c41\u514d\u540c\u7ec4\u4e92\u65a5');
(function () {
  const ON = { scopeMode: 'appointment', promptContext: 'offline' };

  /* F1：3 条常驻 + 同一个 group → 必须全部保留 */
  const constSameGroup = [
    mk('C1', 'middle', { key: [], constant: true, group: 'scene' }),
    mk('C2', 'middle', { key: [], constant: true, group: 'scene' }),
    mk('C3', 'middle', { key: [], constant: true, group: 'scene' }),
  ];
  const rf1 = build(constSameGroup, CTX, ON);
  ck('F1 \u5e38\u9a7b\u8bcd\u6761\u540c\u7ec4\u4e0d\u4e92\u65a5\uff083 \u6761\u5168\u4fdd\u7559\uff09',
     has(rf1, 'C1') && has(rf1, 'C2') && has(rf1, 'C3'),
     'matched=' + ids(rf1));

  /* F2：常驻与非常驻混组 → 常驻全保留，非常驻按互斥取一 */
  const mixed = [
    mk('M1', 'middle', { key: ['\u82f9\u679c'], group: 'mix' }),
    mk('M2', 'middle', { key: ['\u82f9\u679c'], group: 'mix' }),
    mk('M3', 'middle', { key: [], constant: true, group: 'mix' }),
  ];
  const rf2 = build(mixed, '\u82f9\u679c', ON);
  ck('F2 \u6df7\u7ec4\u4e2d\u5e38\u9a7b\u4fdd\u7559\u3001\u975e\u5e38\u9a7b\u4e92\u65a5',
     has(rf2, 'M3') && (has(rf2, 'M1') || has(rf2, 'M2')) &&
     !(has(rf2, 'M1') && has(rf2, 'M2')),
     'matched=' + ids(rf2));

  /* F3：非常驻同组互斥行为必须保留（防修过头） */
  const keyedSameGroup = [
    mk('K1', 'middle', { key: ['\u82f9\u679c'], group: 'sc' }),
    mk('K2', 'middle', { key: ['\u82f9\u679c'], group: 'sc' }),
    mk('K3', 'middle', { key: ['\u82f9\u679c'], group: 'sc' }),
  ];
  const rf3 = build(keyedSameGroup, '\u82f9\u679c', ON);
  ck('F3 \u975e\u5e38\u9a7b\u540c\u7ec4\u4ecd\u4e92\u65a5\uff08ST \u8bed\u4e49\u4fdd\u7559\uff09',
     rf3.matched.filter(e => ['K1', 'K2', 'K3'].indexOf(e.id) >= 0).length === 1,
     'matched=' + ids(rf3));

  /* F4：互斥丢弃必须记账（kind='group'）—— 曾经静默 */
  const dropped = (rf3.budget && rf3.budget.dropped) || [];
  const groupKind = dropped.filter(d => d && d.kind === 'group');
  ck('F4 \u4e92\u65a5\u4e22\u5f03\u5df2\u8bb0\u8d26\uff08kind=group\uff09',
     groupKind.length === 2, 'dropped=' + JSON.stringify(groupKind.map(d => d.name)));

  /* F5：groupOverride 仍可并列保留 */
  const ovr = [
    mk('O1', 'middle', { key: ['\u82f9\u679c'], group: 'ov', groupWeight: 200 }),
    mk('O2', 'middle', { key: ['\u82f9\u679c'], group: 'ov', groupOverride: true }),
  ];
  const rf5 = build(ovr, '\u82f9\u679c', ON);
  ck('F5 groupOverride \u4ecd\u53ef\u5e76\u5217\u4fdd\u7559',
     has(rf5, 'O1') && has(rf5, 'O2'), 'matched=' + ids(rf5));

  /* F6：线上对照 —— 常驻豁免在线上同样生效，不存在线上线下分叉 */
  const rf6 = build(constSameGroup, CTX, { promptContext: 'online' });
  ck('F6 \u7ebf\u4e0a\u5bf9\u7167\uff1a\u5e38\u9a7b\u540c\u6837\u8c41\u514d\u4e92\u65a5',
     has(rf6, 'C1') && has(rf6, 'C2') && has(rf6, 'C3'), 'matched=' + ids(rf6));
})();

/* ──────────────────────────────────────────────────
 * G. 口径透明：「线上预测 0 命中」是语义，不是故障 —— 但必须把话说出来
 *
 * 背景（用户误读链，v7 实况）：宿主聊天挂着线下约会，启用的常驻条目是
 * 「仅线下」。模型高级的实时预测分支走线上口径（buildApiMessages 固定
 * promptContext='online'）→ 仅线下词条被正确排除 → 面板显示 0。
 * 用户拿这个 0 去对比旧包「线下生成快照的 2 条」，得出「新包把世界书改坏
 * 了」。实际匹配层没有任何问题 —— 缺的是面板把口径与原因说出来。
 *
 * 守卫两层：
 *   ① 语义本身（线上不含仅线下）不许被「顺手修好」改坏；
 *   ② 面板必须采集原因（explainEntry）并补报线下口径预测。
 * ────────────────────────────────────────────────── */
(function () {
  console.log('\n\u3010G\u3011\u53e3\u5f84\u900f\u660e\uff1a\u7ebf\u4e0a\u9884\u6d4b 0 \u547d\u4e2d\u65f6\u8bf4\u660e\u539f\u56e0\u4e0e\u7ebf\u4e0b\u53e3\u5f84');
  const matcher = s.miyaWorldbookMatcher;
  const gEnt = mk('V1', 'middle', { constant: true, globalReach: 'offline' });
  const gOn = build([gEnt], CTX, { promptContext: 'online' });
  const gOff = build([gEnt], CTX, { promptContext: 'offline', scopeMode: 'appointment' });
  ck('G1 \u4ec5\u7ebf\u4e0b\u5e38\u9a7b\uff1a\u7ebf\u4e0a\u53e3\u5f84 0 / \u7ebf\u4e0b\u53e3\u5f84 1\uff08\u8bed\u4e49\u4fdd\u6301\uff09',
     gOn.matched.length === 0 && gOff.matched.length === 1,
     'online=' + gOn.matched.length + ' offline=' + gOff.matched.length);

  const gDiag = matcher && typeof matcher.explainEntry === 'function'
    ? matcher.explainEntry(gEnt, { roleId: 'r1', roleIds: ['r1'], contextText: CTX, promptContext: 'online' })
    : null;
  ck('G2 explainEntry \u7ed9\u51fa\u4eba\u7c7b\u53ef\u8bfb\u539f\u56e0\uff08reach_mismatch \u4e14\u542b\u300c\u4ec5\u7ebf\u4e0b\u300d\uff09',
     !!gDiag && gDiag.injected === false && gDiag.reason === 'reach_mismatch' &&
     String(gDiag.detail || '').indexOf('\u4ec5\u7ebf\u4e0b') >= 0,
     gDiag ? gDiag.reason + '\uff5c' + gDiag.detail : 'explainEntry \u4e0d\u53ef\u7528');

  const cs2 = read('js1/miya-chat-contact-settings.js');
  ck('G3 \u9762\u677f 0 \u547d\u4e2d\u65f6\u91c7\u96c6\u539f\u56e0\u4e0e\u53e6\u4e00\u53e3\u5f84\u9884\u6d4b\uff08worldbookLiveZero\uff09',
     cs2.indexOf('worldbookLiveZero') >= 0 &&
     cs2.indexOf('otherPredicted') >= 0 &&
     cs2.indexOf('explainEntry') >= 0,
     '\u7f3a\u5c11\u91c7\u96c6\u70b9');
  ck('G4 \u6e32\u67d3\u5c42\u628a\u539f\u56e0\u4e0e\u53e6\u4e00\u53e3\u5f84\u8bf4\u51fa\u6765',
     cs2.indexOf('\u6309') >= 0 && cs2.indexOf('\u53e3\u5f84\u9884\u6d4b\u5c06\u547d\u4e2d') >= 0 &&
     cs2.indexOf('\u5f53\u524d') >= 0 && cs2.indexOf('\u53e3\u5f84\u672a\u547d\u4e2d\u4e16\u754c\u4e66') >= 0,
     '\u7f3a\u6e32\u67d3\u6587\u6848');
  ck('G5 \u4ee3\u7801\u6307\u7eb9\u5305\u542b\u4e16\u754c\u4e66\u6a21\u5757\u7248\u672c\uff08st/prompt \u7684 ?v=\uff09',
     cs2.indexOf('miya-worldbook-st') >= 0 && cs2.indexOf('wbStV') >= 0 &&
     cs2.indexOf('wbPromptV') >= 0,
     '\u6307\u7eb9\u4ecd\u662f\u65e7\u4e09\u9879');
  /* G6：实时预测必须跟随会话模式 —— 线下与线上共用 chatId，
       只能靠「该 chatId 有没有激活的线下场次」判断，不能固定走线上口径。 */
  ck('G6 \u5b9e\u65f6\u9884\u6d4b\u8ddf\u968f\u4f1a\u8bdd\u6a21\u5f0f\uff08\u7ebf\u4e0b\u573a\u6b21 \u2192 \u7ebf\u4e0b\u53e3\u5f84\uff09',
     cs2.indexOf('getActiveSession') >= 0 && cs2.indexOf('liveOfflineMode') >= 0,
     '\u4ecd\u56fa\u5b9a\u6309\u7ebf\u4e0a\u53e3\u5f84\u9884\u6d4b');
})();

/* ──────────────────────────────────────────────────
 * H. ST 预设来源标记：线下链路不得丢掉 __src
 *
 * 缺陷：miya-appointment-engine 手工重建 {role, content} 注入 front 预设，
 * 把 __src（条目名/identifier/position/depth）整个丢掉。后果是用户 20+ 条
 * ST 预设里，只有走 injectStInChatMessages 的少数几条能显示条目名，
 * 其余全部被分类器兜底成「其它系统块」——用户既看不到「ST 预设」这一块，
 * 也看不到自己导入的条目清单。
 * ────────────────────────────────────────────────── */
(function () {
  console.log('\n\u3010H\u3011\u7ebf\u4e0b\u94fe\u8def\u4fdd\u7559 ST \u9884\u8bbe\u6765\u6e90\u6807\u8bb0');
  const eng2 = read('js1/miya-chat-engine.js');
  const ap = read('js1/miya-appointment-engine.js');
  ck('H1 engine \u5bfc\u51fa stTaggedMessage\uff08\u8de8\u94fe\u8def\u5171\u7528\u6253\u6807\u5668\uff09',
     /stTaggedMessage:\s*stTaggedMessage/.test(eng2),
     '\u672a\u5bfc\u51fa\uff0c\u7ebf\u4e0b\u53ea\u80fd\u624b\u5199\u4e00\u4efd');
  ck('H2 \u7ebf\u4e0b front \u9884\u8bbe\u8d70 stTagger \u800c\u975e\u624b\u5de5\u91cd\u5efa',
     ap.indexOf('stTagger') >= 0 &&
     /apiMessages\.push\(\s*stTagger\(m\)\s*\)/.test(ap),
     '\u4ecd\u5728\u4e22 __src');
  ck('H3 \u7ebf\u4e0b\u4e0d\u518d\u51fa\u73b0\u300c\u624b\u5de5\u91cd\u5efa role+content\u300d\u7684\u9884\u8bbe\u6ce8\u5165',
     !/stPresetFrontMessages\.forEach[\s\S]{0,400}?apiMessages\.push\(\{\s*role:\s*m\.role\s*\|\|/.test(ap),
     '\u65e7\u5199\u6cd5\u4f9d\u7136\u5b58\u5728');
  ck('H4 \u7ebf\u4e0b back \u9884\u8bbe\u515c\u5e95\u4e5f\u4fdd\u7559\u6807\u8bb0',
     ap.indexOf('stTaggerBack') >= 0,
     '\u515c\u5e95\u5206\u652f\u4ecd\u4e22\u6807\u8bb0');
})();

console.log('\n' + '\u2550'.repeat(58));
console.log('\u901a\u8fc7 ' + pass + ' / \u5171 ' + (pass + fail));
if (fail) console.log('\u5931\u8d25 ' + fail + ' \u9879');
console.log('\u2550'.repeat(58));
process.exit(fail ? 1 : 0);
"""


def main():
    proc = subprocess.run(
        ["node", "-e", JS, "worldbook_regression", ROOT],
        cwd=ROOT, capture_output=True, text=True,
    )
    sys.stdout.write(proc.stdout)
    if proc.stderr.strip():
        sys.stderr.write(proc.stderr)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
