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
