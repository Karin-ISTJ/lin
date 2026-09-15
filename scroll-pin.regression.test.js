/**
 * 线下「生成结束自动滚底」+ 聊天室「停留自动退出」回归测试
 *
 * 运行：PKG_ROOT=<包目录> node scroll-pin.regression.test.js
 *
 * 与 stream-resilience.test.js 同一套路：直接读源文件做静态断言，
 * 避免「测试通过但线上代码不一样」的假安全感。
 *
 * 两个 bug 的根因回顾：
 *
 * 1) 聊天室停留几秒被踢回列表
 *    miya-chat-room.js 的 guardAutoRoomOpen 早期只看一个固定授权窗口
 *    （4 秒）。窗口一过就认为「这次进房不是用户点的」，于是把正正常常
 *    在看聊天的人踢回列表 —— 停留越久越必然触发。
 *    修法：改成按「进房事件」审核一次（状态转移），并用用户是否在场
 *    （滚动/输入/点击）作为放行依据，不再拿时长否定用户。
 *
 * 2) 线下生成结束自动滚到底
 *    scrollStoryToEnd 依赖 userPinnedBottom，而该值只在真实滚动事件里更新；
 *    用户在生成中滑了一下之后内容继续增长，pinned 会停在一个过期的 true，
 *    生成结束就把人拽到新底部。
 *    修法：引入「跟随意图」userIntendsFollowBottom，并把手势停稳后
 *    按最终位置结算，避免下滑途中的中间帧把意图误判成 true。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = process.env.PKG_ROOT || __dirname;
var APPT_APP = path.join(ROOT, 'js1/miya-appointment-app.js');
var CHAT_ROOM = path.join(ROOT, 'js1/miya-chat-room.js');
var CHAT_APP = path.join(ROOT, 'js1/miya-chat-app.js');

var pass = 0, fail = 0, failures = [];
function check(name, got, expect) {
  var ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) pass++;
  else { fail++; failures.push(name + ': got=' + JSON.stringify(got) + ' expect=' + JSON.stringify(expect)); }
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '   got=' + JSON.stringify(got)));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

var apptSrc = fs.readFileSync(APPT_APP, 'utf8');
var roomSrc = fs.readFileSync(CHAT_ROOM, 'utf8');
var chatAppSrc = fs.readFileSync(CHAT_APP, 'utf8');

/* ═════════════════════════════════════════════════════════
 * A. 线下滚动：区分「用户意图」与「此刻位置」
 * ═════════════════════════════════════════════════════════ */
section('A. 线下：跟随意图必须独立于此刻位置记账');

check('定义 userTouchedScroll（用户是否碰过滚动条）', /userTouchedScroll/.test(apptSrc), true);
check('定义 userPinnedBottom（此刻是否贴底）', /userPinnedBottom/.test(apptSrc), true);
check('定义 userIntendsFollowBottom（是否想跟最新）', /userIntendsFollowBottom/.test(apptSrc), true);

/* 关键：拿此刻位置去判断「要不要跟」，会被内容增长污染 —— 必须用意图 */
check(
  'scrollStoryToEnd 用意图而非此刻位置做闸',
  /function scrollStoryToEnd[\s\S]{0,1400}?if \(!streamUi\.userIntendsFollowBottom\) return;/.test(apptSrc),
  true
);
check(
  'patchStoryBody 尾部用意图做闸',
  /opts\.streamOnly && streamUi\.userTouchedScroll && streamUi\.userIntendsFollowBottom/.test(apptSrc),
  true
);

/* 意图要在手势停稳后结算，否则下滑途中的中间帧会把意图误判成 true */
check('有手势停稳后的意图结算函数', /function scheduleFollowIntentSettle/.test(apptSrc), true);
check(
  '滚动过程中先吊销意图（离开底部立即停止跟随）',
  /streamUi\.userIntendsFollowBottom = false;[\s\S]{0,120}?scheduleFollowIntentSettle/.test(apptSrc),
  true
);
check('意图结算带延时（等手势停下）', /setTimeout\(function \(\) \{[\s\S]{0,600}?\}, 160\)/.test(apptSrc), true);

/* 程序滚动不得污染用户意图 */
check('程序滚动用 markSelfScroll 标记', /function markSelfScroll/.test(apptSrc), true);
check(
  'self-scroll 期间跳过意图/位置更新',
  /if \(sc\._xwScrollSelf\) return;/.test(apptSrc),
  true
);
/* 主动贴底（发送/重回）应显式确立意图 */
check(
  'pinScrollToBottom 显式确立跟随意图',
  /function pinScrollToBottom[\s\S]{0,400}?userIntendsFollowBottom = true/.test(apptSrc),
  true
);

/* ═════════════════════════════════════════════════════════
 * B. 聊天室：停留不得被踢回列表
 * ═════════════════════════════════════════════════════════ */
section('B. 聊天室：按「进房事件」审核，不拿时长否定用户');

var guardBody = (roomSrc.match(/function guardAutoRoomOpen\s*\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
check('能定位 guardAutoRoomOpen', guardBody.length > 0, true);

/* 核心：同一个进房事件只审一次，之后用户待多久都不再重审 */
check('守卫使用「已审核进房事件」记账', /guardReviewedRoomKey/.test(roomSrc), true);
check(
  '同一进房事件重复轮询直接放行',
  /if \(guardReviewedRoomKey === roomKey\) return;/.test(roomSrc),
  true
);
/* 用户在场即放行 */
check('守卫依据用户在房间内是否表过态', /if \(userEngagedRoom\) return;/.test(guardBody), true);
check('有 markRoomEngaged 记录用户在场', /function markRoomEngaged/.test(roomSrc), true);
check(
  '滚动事件会记录用户在场',
  /addEventListener\('scroll', function \(\) \{[\s\S]{0,400}?markRoomEngaged\(\)/.test(roomSrc),
  true
);
check('有房间内交互的统一绑定', /function bindRoomEngagement/.test(roomSrc), true);

/* 关房/进房要复位，避免状态串场 */
check(
  'close() 复位已审标识与在场标记',
  /roomPinBottomUntil = 0;[\s\S]{0,300}?guardReviewedRoomKey = ''/.test(roomSrc),
  true
);
check(
  'open() 记录进房时刻',
  /roomOpenedAt = Date\.now\(\);/.test(roomSrc),
  true
);

/* 列表页值守不应长驻（长驻只会在边界上误伤） */
check(
  '列表值守有时长上限且进房后收工',
  /LIST_GUARD_HOLD_MS/.test(chatAppSrc) && /stopListGuard\(\);\s*return;/.test(chatAppSrc),
  true
);

/* ═════════════════════════════════════════════════════════
 * C. 不变量：程序滚动只能发生在「用户明确要跟」时
 * ═════════════════════════════════════════════════════════ */
section('C. 不变量：scrollTop 写入路径的唯一性与前置条件');

/* 线下模块里对 xw-main 的 scrollTop 写入应当只有一处 */
var writes = (apptSrc.match(/sc\.scrollTop\s*=/g) || []).length;
check('xw-main 的 scrollTop 写入只有 1 处', writes, 1);
check(
  '该写入位于 scrollStoryToEnd 内且已有意图闸',
  /function scrollStoryToEnd[\s\S]{0,1500}?sc\.scrollTop = sc\.scrollHeight;/.test(apptSrc),
  true
);
/* 被禁用的旧滚动函数不能复活 */
check(
  'scheduleStreamScroll 仍处于禁用状态',
  /function scheduleStreamScroll\(\) \{\s*\n\s*return;/.test(apptSrc),
  true
);

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (failures.length) {
  console.log('\n失败详情：');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exitCode = 1;
}
