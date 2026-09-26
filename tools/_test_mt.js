/**
 * 记忆表格引擎回归测试（Node 直跑浏览器代码）
 * 覆盖：多动作切分（本轮根治）、截断块、多段收集、大小写归一、
 *       空表 updateRow 兜底、dryRun mtRaw、全角兼容、参数解析容错。
 * 用法：node tools/_test_mt.js
 */
'use strict';
global.window = global;
global.MiyaToken = { fromText: function (t) { return Math.ceil(String(t || '').length / 4); } };
require('../js2/miya-memory-table-engine.js');
var E = global.MiyaMemoryTableEngine;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('── 一、多动作切分（本轮根治的核心）──');
var ex = '<tableEdit><!-- updateRow(0, 0, {4:"小雨"}) --><!-- insertRow(5, {0:"小雨", 1:"钢笔", 2:"母亲遗物", 3:"纪念"}) --></tableEdit>';
var a1 = E.parseTableEditBlock(ex);
ok('范例原文解析出 2 条动作', a1.length === 2, JSON.stringify(a1));
ok('动作类型顺序 updateRow→insertRow', a1.length === 2 && a1[0].op === 'updateRow' && a1[1].op === 'insertRow');
ok('updateRow 实参可解析', a1.length && E.parseArgs(a1[0].rawArgs) !== null);
ok('insertRow 实参可解析', a1.length > 1 && E.parseArgs(a1[1].rawArgs) !== null);
var p1 = a1.length > 1 ? E.parseArgs(a1[1].rawArgs) : null;
ok('insertRow 实参内容正确', !!p1 && p1[0] === 5 && p1[1][1] === '钢笔', JSON.stringify(p1));

var a2 = E.parseTableEditBlock('<tableEdit><!-- insertRow(0,{0:"a"}); insertRow(1,{0:"b"}) --></tableEdit>');
ok('分号分隔 2 条', a2.length === 2, JSON.stringify(a2));

var a2b = E.parseTableEditBlock('<tableEdit><!-- insertRow(0,{0:"a"})\ninsertRow(1,{0:"b"}) --></tableEdit>');
ok('换行分隔 2 条', a2b.length === 2, JSON.stringify(a2b));

var a2c = E.parseTableEditBlock('<tableEdit><!-- insertRow(0,{0:"a"}) insertRow(1,{0:"b"}) --></tableEdit>');
ok('纯空格分隔 2 条（旧正则的盲区）', a2c.length === 2, JSON.stringify(a2c));

console.log('── 二、边界与容错 ──');
var a3 = E.parseTableEditBlock('<tableEdit><!-- insertRow(0,{0:"他说(好)的",1:"x)y"}) --><!-- updateRow(2,1,{0:"z"}) --></tableEdit>');
ok('字符串内括号不干扰切分', a3.length === 2, JSON.stringify(a3));
var p3 = a3.length ? E.parseArgs(a3[0].rawArgs) : null;
ok('字符串内括号内容保真', !!p3 && p3[1][0] === '他说(好)的' && p3[1][1] === 'x)y', JSON.stringify(p3));

var a4 = E.parseTableEditBlock('正文<tableEdit><!-- insertRow(0,{0:"截断"})');
ok('截断块（缺闭合）仍解析出动作', a4.length === 1, JSON.stringify(a4));

var a5 = E.parseTableEditBlock('<tableEdit><!-- insertRow(0,{0:"a"}) --></tableEdit>中间正文<tableEdit><!-- updateRow(0,0,{0:"b"}) --></tableEdit>');
ok('多段 tableEdit 全收集', a5.length === 2, JSON.stringify(a5));

var a5b = E.parseTableEditBlock('<tableEdit><!-- insertRow(0,{0:"a"}) --></tableEdit><tableEdit><!-- insertRow(1,{0:"b"}) --></tableEdit><tableEdit><!-- insertRow(2,{0:"c"}) --></tableEdit>');
ok('三段连排全收集', a5b.length === 3, JSON.stringify(a5b));

var a6 = E.parseTableEditBlock('<tableEdit><!-- INSERTROW(0,{0:"x"}) --></tableEdit>');
ok('INSERTROW 大小写归一', a6.length === 1 && a6[0].op === 'insertRow', JSON.stringify(a6));
var a6b = E.parseTableEditBlock('<tableEdit><!-- UpdateRow(0,0,{0:"x"}) --></tableEdit>');
ok('UpdateRow 大小写归一', a6b.length === 1 && a6b[0].op === 'updateRow', JSON.stringify(a6b));

var a6c = E.parseTableEditBlock('正文提到 insertRow 但不是调用');
ok('正文裸提及动作名不误判', a6c.length === 0, JSON.stringify(a6c));

console.log('── 三、全角兼容（上轮修复回归）──');
var a9 = E.parseTableEditBlock('<tableEdit><!-- insertRow（0，{0：“全角”}） --></tableEdit>');
ok('全角括号/逗号/引号动作可解析', a9.length === 1, JSON.stringify(a9));
var p9 = a9.length ? E.parseArgs(a9[0].rawArgs) : null;
ok('全角内容保真', !!p9 && p9[1][0] === '全角', JSON.stringify(p9));
var a9b = E.parseTableEditBlock('＜tableEdit＞＜!-- insertRow(0,{0:"全角标签"}) --＞＜/tableEdit＞');
ok('全角尖括号标签可解析', a9b.length === 1, JSON.stringify(a9b));
var stripped = E.stripTableEditFromReply('正文＜tableEdit＞＜!-- insertRow(0,{0:"x"}) --＞＜/tableEdit＞结尾');
ok('全角标签可剥离', stripped.indexOf('tableEdit') < 0 && stripped.indexOf('正文') >= 0, stripped);
var stripped2 = E.stripTableEditFromReply('正文<tableEdit><!-- insertRow(0,{0:"x"})结尾');
ok('截断块剥离不残留', stripped2.indexOf('tableEdit') < 0 && stripped2.indexOf('insertRow') < 0, stripped2);

console.log('── 四、空表 updateRow 首行兜底 ──');
function mkTables() {
  return [
    { id: 't0', name: '时空', note: '', enabled: true, columns: ['时间', '地点'], rows: [] },
    { id: 't1', name: '角色', note: '', enabled: true, columns: ['名字', '状态'], rows: [['小雨', '健康']] }
  ];
}
var r7 = E.applyActions(mkTables(), [{ op: 'updateRow', rawArgs: '0,0,{0:"夜晚",1:"钢笔的家"}' }], { maxRowsPerTable: 40 });
ok('空表 updateRow(0) 落为首行', r7.tables[0].rows.length === 1 && r7.tables[0].rows[0][0] === '夜晚', JSON.stringify(r7.tables[0].rows));
ok('空表兜底计入 log', r7.log.length === 1, JSON.stringify(r7.log));
ok('空表兜底无失败', r7.failures.length === 0, JSON.stringify(r7.failures));

var r7b = E.applyActions(mkTables(), [{ op: 'updateRow', rawArgs: '0,3,{0:"越界"}' }], { maxRowsPerTable: 40 });
ok('空表 updateRow(非0) 仍判越界', r7b.failures.length === 1 && r7b.failures[0].reason === 'rowIndex', JSON.stringify(r7b.failures));

var r7c = E.applyActions(mkTables(), [{ op: 'updateRow', rawArgs: '1,0,{1:"受伤"}' }], { maxRowsPerTable: 40 });
ok('非空表 updateRow 正常更新', r7c.tables[1].rows[0][1] === '受伤', JSON.stringify(r7c.tables[1].rows));

console.log('── 五、dryRun 与行溯源 ──');
var mockStore = { loadSettings: function () { return { enabled: true, isAiWrite: true }; } };
global.MiyaMemoryTableStore = mockStore;
var d1 = E.processAssistantReply('c1', '正文<tableEdit><!-- insertRow(0,{0:"截断"})', { dryRun: true });
ok('dryRun 收集截断块 mtRaw', !!d1.mtRaw && d1.mtRaw.indexOf('insertRow') >= 0, d1.mtRaw);
ok('dryRun 剥离正文干净', d1.text.indexOf('tableEdit') < 0, d1.text);
var d2 = E.processAssistantReply('c1', '正文<tableEdit><!-- insertRow(0,{0:"a"}) --></tableEdit>尾<tableEdit><!-- updateRow(0,0,{0:"b"}) --></tableEdit>', { dryRun: true });
ok('dryRun 收集多段 mtRaw', (d2.mtRaw.match(/tableEdit/gi) || []).length >= 4, d2.mtRaw);

mockStore.getChatTables = function () { return mkTables(); };
mockStore.getChatRowSource = function () { return {}; };
mockStore.setChatTables = function () { mockStore._saved = true; };
mockStore.rowKey = function (ti, ri) { return ti + ':' + ri; };
var r8 = E.processAssistantReply('c1', '<tableEdit><!-- updateRow(0,0,{0:"夜晚"}) --><!-- insertRow(1,{0:"新角色"}) --></tableEdit>', { sourceMsgIds: ['m1'] });
ok('多动作整轮落地 log=2', r8.applied && r8.log.length === 2, JSON.stringify(r8.log));
ok('空表兜底路径整轮可写库', mockStore._saved === true);
var r8b = E.applyActions(mkTables(), [
  { op: 'updateRow', rawArgs: '0,0,{0:"夜晚"}' },
  { op: 'insertRow', rawArgs: '1,{0:"新角色"}' }
], { maxRowsPerTable: 40 }, {});
ok('placements 含 2 条溯源（空表兜底+新增行）',
  r8b.placements.length === 2 &&
  r8b.placements[0].tableIndex === 0 && r8b.placements[0].rowIndex === 0 &&
  r8b.placements[1].tableIndex === 1 && r8b.placements[1].rowIndex === 1,
  JSON.stringify(r8b.placements));

console.log('── 六、参数解析器回归（历史用例）──');
ok('数字+对象', E.parseArgs('0, {0:"a",1:"b"}') !== null);
ok('三参数', E.parseArgs('0,1,{2:"x"}') !== null);
ok('纯数字', E.parseArgs('0,1') !== null);
ok('中文分号键值', E.parseArgs('0,{0:"a"；1:"b"}') !== null);
ok('全角引号值', E.parseArgs('0,{0:"“引用”"}') !== null);
ok('尾逗号容错', E.parseArgs('0,{0:"a"},') !== null);
ok('转义引号', E.parseArgs('0,{0:"她说\\"好\\""}') !== null);
ok('非法标识符拒绝', E.parseArgs('0,{0:evil()}') === null);
ok('空串拒绝', E.parseArgs('') === null);
ok('负数行号', (function () { var v = E.parseArgs('0,-1'); return v && v[1] === -1; })());

console.log('── 七、注入位置稳定性（缓存友好回归）──');
var msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
mockStore.loadSettings = function () { return { enabled: true, isAiRead: true }; };
mockStore.getChatTables = function () { return mkTables(); };
var inj = E.injectIntoMessages(msgs.map(function (m) { return Object.assign({}, m); }), 'c1');
ok('注入位置 = system 区末尾', inj.length === 4 && inj[1].role === 'system' && inj[2].role === 'user', inj.map(function (m) { return m.role; }).join(','));

console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
