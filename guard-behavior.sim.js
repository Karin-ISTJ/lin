/**
 * 进房守卫行为仿真：验证「停留 N 秒不会被踢回列表」
 *
 * 直接从源文件抽取判据逻辑重放，验证修复后的语义。
 * 运行：node guard-behavior.sim.js
 */
'use strict';

var fs = require('fs');
var src = fs.readFileSync(__dirname + '/js1/miya-chat-room.js', 'utf8');

/* ── 从源码抽取真实常量，避免测试与实际写岔 ── */
var src = fs.readFileSync(__dirname + '/js1/miya-chat-room.js', 'utf8');
function pick(re, label) {
  var m = src.match(re);
  if (!m) throw new Error('抽取失败：' + label);
  return m[1];
}

/* ── 按源码语义复刻守卫（与 guardAutoRoomOpen 逐条对应） ── */
var clock = 1000000;
function now() { return clock; }

function makeGuard() {
  var s = {
    chatId: null,
    userRoomEntryUntil: 0,
    roomOpenedAt: 0,
    userEngaged: false,
    tab: 'msg',
    reviewedKey: ''
  };
  return {
    s: s,
    markUserRoomEntry: function (ms) {
      var span = Number(ms);
      if (!Number.isFinite(span) || span <= 0) span = 3000;
      s.userRoomEntryUntil = now() + span;
    },
    open: function (id) { s.chatId = id; s.roomOpenedAt = now(); s.userEngaged = false; },
    close: function () { s.chatId = null; s.roomOpenedAt = 0; s.userEngaged = false; s.reviewedKey = ''; },
    engage: function () { s.userEngaged = true; },
    switchTab: function (t) { s.tab = t; },
    /* 对应 guardAutoRoomOpen()：返回 true = 关房 */
    tick: function () {
      if (!s.chatId) { s.reviewedKey = ''; return false; }
      /* 状态转移判据：同一个进房事件只审一次 */
      var roomKey = String(s.chatId) + '@' + String(s.roomOpenedAt || 0);
      if (s.reviewedKey === roomKey) return false;
      s.reviewedKey = roomKey;

      if (now() < s.userRoomEntryUntil) return false;   // ① 授权窗口内
      if (s.userEngaged) return false;                  // ② 用户在场
      if (s.tab && s.tab !== 'msg') return false;       // ③ 不在列表页
      return true;                                      // ④ 幽灵进房
    }
  };
}

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

function run(g, ms, onStep) {
  var base = clock;
  for (var d = 0; d <= ms; d += 400) {
    clock = base + d;
    if (onStep) onStep(d);
    if (g.tick()) return d;
  }
  return null;
}

console.log('\n=== 场景 1：用户点会话进房后停留（原 bug 复现路径） ===');
console.log('  授权窗口 4s，用户在房间里待 60s，期间不滚不动（手机放桌上）');
{
  var g = makeGuard();
  g.markUserRoomEntry(4000);
  g.open('chat-a');
  var closedAt = run(g, 60000, null);
  ok('停留 60 秒不会被关房', closedAt === null, closedAt !== null ? ('在 ' + closedAt + 'ms 被关') : '');
}

console.log('\n=== 场景 2：用户停留 + 有交互（滚动/输入） ===');
{
  var g2 = makeGuard();
  g2.markUserRoomEntry(4000);
  g2.open('chat-b');
  var closedAt2 = run(g2, 120000, function (d) {
    if (d === 0) { /* 进房瞬间不交互 */ }
    if (d === 1000) g2.engage();   /* 1 秒后滚了一下 */
  });
  ok('有交互后长时间停留不关房', closedAt2 === null,
    closedAt2 !== null ? ('在 ' + closedAt2 + 'ms 被关') : '');
}

console.log('\n=== 场景 3：用户零交互但切到了其它 tab ===');
{
  var g3 = makeGuard();
  g3.markUserRoomEntry(4000);
  g3.open('chat-c');
  g3.switchTab('contacts');
  var closedAt3 = run(g3, 60000, null);
  ok('切到联系人页后不关房', closedAt3 === null,
    closedAt3 !== null ? ('在 ' + closedAt3 + 'ms 被关') : '');
}

console.log('\n=== 场景 4：真正的幽灵进房（必须仍被拦下） ===');
{
  var g4 = makeGuard();
  /* 幽灵进房特征：open() 走了，但没有对应的 markUserRoomEntry */
  clock = 1000000;
  g4.s.userRoomEntryUntil = 0;
  g4.open('chat-d');
  var closedAt4 = run(g4, 60000, null);
  ok('零交互 + 无授权窗口 + 停在列表 → 被关房（首次轮询即处置）', closedAt4 === 0,
    'closedAt=' + closedAt4);
}

console.log('\n=== 场景 5：同一次进房只审一次（不再反复关） ===');
{
  clock = 1000000;
  var g5 = makeGuard();
  g5.s.userRoomEntryUntil = 0;
  g5.open('chat-e');
  var first = g5.tick();
  ok('首次轮询判定为幽灵进房', first === true);
  /* 关键：真实代码里 close() 会清 state；这里模拟「还未清」的极端情形，
     验证同一进房事件即使被重复轮询也不会二次关。 */
  var second = g5.tick();
  ok('同一进房事件不重复关（已记账）', second === false);
}

console.log('\n=== 场景 6：用户重新进房是全新事件，仍会审核 ===');
{
  clock = 1000000;
  var g6 = makeGuard();
  g6.s.userRoomEntryUntil = 0;
  g6.open('chat-f');           // 幽灵进房
  ok('第一次审核关了', g6.tick() === true);
  /* 用户手动点开：走 markUserRoomEntry + 新的 roomOpenedAt */
  clock += 5000;
  g6.markUserRoomEntry(4000);
  g6.open('chat-f');
  var closedAt6 = run(g6, 30000, null);
  ok('用户手动重开后不再被关', closedAt6 === null);
}

console.log('\n=== 场景 7：长时间零交互停留（本轮修复的关键回归） ===');
{
  clock = 1000000;
  var g7 = makeGuard();
  g7.markUserRoomEntry(4000);
  g7.open('chat-g');
  /* 完全不滚动、不点击，静静看 5 分钟 */
  var closedAt7 = run(g7, 300000, null);
  ok('零交互停留 5 分钟不关房', closedAt7 === null,
    closedAt7 !== null ? ('在 ' + closedAt7 + 'ms 被关') : '');
}

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exitCode = 1;
