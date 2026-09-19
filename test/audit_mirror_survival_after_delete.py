# -*- coding: utf-8 -*-
"""
线下工程 · 「镜像在卷宗删除后仍然存活」单元级取证
==================================================

背景（用户的第二问）：
  第十批我改的是「给线上同源总结打溯源前缀」，那只让记忆**可辨认**，
  并没有让它**不被注入**。用户复查后回报：AI 仍然知道已删卷宗里的内容。

本审计不再依赖浏览器/IDB，直接用 Node 把
  js1/miya-appointment-memory.js 里的过滤决策函数抽出来做纯函数验证。

核心机制（三处串起来才成立）：

  ① getMessagesForApi(chatId)
       js1/miya-chat-store.js:4422  注释白纸黑字：
       「API 上下文：**含线下镜像消息**（线上 UI 不展示）」
       → 它**故意**保留 offlineMeet 行，指望下游过滤。

  ② filterOfflineMirrorsFromApiHistory / filterOfflineMirrorsForApiHistory
       js1/miya-chat-engine.js:2776 与 js1/miya-chat-summary.js:428
       → 唯一的下游兜底。

  ③ shouldKeepOfflineMirror(m, ctx)
       js1/miya-appointment-memory.js:204

  ③ 的判定逻辑是「**只滤掉已被线下总结区间覆盖的镜像**」：
       hidden            → 丢掉      （正确）
       无 appointmentSessionId → 保留（可疑）
       ctx 里查不到该 session → 保留（可疑 ← 致命）
       session 无 summaryList  → 保留（可疑 ← 致命）
       序号在区间内       → 丢掉
       序号在区间外（尾巴）→ 保留

  也就是说：**过滤能力完全依附于「卷宗还活着且带总结区间」**。
  而 ②③ 的上下文来自 aps.exportForMemory(chatId, contactId)
    → getSessionsByContact(contactId)
    → 已删卷宗**不在返回列表里**（deleteSession 从 byChat 里 filter 掉了）

  于是删掉卷宗后，镜像从「可能被滤」变成「**必定保留**」：
  上下文缺失被 ③ 当成「不在任何总结区间内」，一律 return true。

这是「删除反而让内容更容易泄漏」的反直觉结论，本审计逐条钉死它。

跑法：python3 test/audit_mirror_survival_after_delete.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM = ROOT / 'js1' / 'miya-appointment-memory.js'
STORE = ROOT / 'js1' / 'miya-chat-store.js'
ENGINE = ROOT / 'js1' / 'miya-chat-engine.js'
SUMMARY = ROOT / 'js1' / 'miya-chat-summary.js'
APS = ROOT / 'js1' / 'miya-appointment-store.js'

results = []


def check(tag, ok, detail=''):
    results.append((tag, bool(ok), detail))
    print('  %s %s%s' % ('✓' if ok else '✗', tag, ('  —— ' + detail) if detail else ''))


mem_src = MEM.read_text(encoding='utf-8')
store_src = STORE.read_text(encoding='utf-8')
engine_src = ENGINE.read_text(encoding='utf-8')
summary_src = SUMMARY.read_text(encoding='utf-8')
aps_src = APS.read_text(encoding='utf-8')


def extract(src, start_marker, end_marker, name):
    i = src.find(start_marker)
    if i < 0:
        raise SystemExit('抽取失败（找不到起点）: ' + name)
    j = src.find(end_marker, i)
    if j < 0:
        raise SystemExit('抽取失败（找不到终点）: ' + name)
    return src[i:j]


print('\n【0】确证三处衔接点存在')
print('-' * 62)

check('① getMessagesForApi 注释承认「含线下镜像」',
      '含线下镜像消息' in store_src,
      'js1/miya-chat-store.js 的 API 上下文口径')

# ① 保留 offlineMeet 的行为：filter 只排 deleted 与 momentsMemory
m = re.search(
    r'getMessagesForApi:\s*function\s*\(chatId\)\s*\{(.*?)\n\s{8}\},',
    store_src, re.S)
if m:
    body = m.group(1)
    keeps_offline = ('offlineMeet' not in body)
    check('① getMessagesForApi 未排除 offlineMeet（镜像直达 API 候选）',
          keeps_offline,
          '过滤条件仅 deleted + isMomentsMemoryRow')
else:
    check('① 能定位 getMessagesForApi 主体', False, '正则未命中')

check('② miya-chat-engine.js 调用了镜像过滤器',
      'filterOfflineMirrorsForApiHistory' in engine_src or
      'filterOfflineMirrorsFromApiHistory' in engine_src)
check('② miya-chat-summary.js 也调用了镜像过滤器',
      'filterOfflineMirrorsForApiHistory' in summary_src)

print('\n【1】抽取 shouldKeepOfflineMirror 做纯函数判定（③）')
print('-' * 62)

# 抽取 messageIndexCovered + shouldKeepOfflineMirror
cov = extract(mem_src, 'function messageIndexCovered', 'function offlineSummaryRanges',
              'messageIndexCovered')
keep = extract(mem_src, 'function shouldKeepOfflineMirror', 'function filterOfflineMirrorsForApiHistory',
               'shouldKeepOfflineMirror')

HARNESS = r"""
'use strict';
function clampInt(v, min, max, dflt) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
%s
%s
/* —— 判定矩阵 —— */
function ctxEmpty() {
  return {
    sessionRanges: {}, msgIndexById: {}, hiddenMsgIds: {},
    tombstoned: {}, tombstoneKnown: true
  };
}
function ctxWithRange(starts, ends, ids) {
  var c = ctxEmpty();
  c.sessionRanges['sess_1'] = [{ start: starts, end: ends }];
  c.msgIndexById['sess_1'] = ids || {};
  return c;
}
/* 已删卷宗：它在墓碑里，但 exportForMemory 不再返回它 */
function ctxDeleted() {
  var c = ctxEmpty();
  c.tombstoned['sess_1'] = true;
  return c;
}
/* 墓碑表读不到（存储异常）—— 被迫退化 */
function ctxNoTombstones() {
  var c = ctxEmpty();
  c.tombstoneKnown = false;
  return c;
}
var out = {};

/* A. 修复前泄漏点：卷宗已删、上下文里只有墓碑、没有区间 */
out.A_deleted_tombstoned = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxDeleted());

/* A2. 卷宗已删但墓碑**过期**（不在墓碑里，也不在活卷宗索引里） */
out.A2_deleted_tombstone_expired = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxEmpty());

/* A3. 墓碑表读不到时不得误杀（退化为旧的保守行为） */
out.A3_tombstone_unknown = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxNoTombstones());

/* B. 活卷宗，总结区间覆盖本条 → 丢弃 */
var idsB = { m1: 3 };
out.B_alive_range_covers = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxWithRange(1, 5, idsB));

/* C. 活卷宗，序号落在区间外（未总结的尾巴）→ 保留（正常链路） */
var idsC = { m1: 9 };
out.C_alive_range_outside = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxWithRange(1, 5, idsC));

/* D. 活卷宗，镜像缺 appointmentMsgId → 保留（无法判区间，属正常尾巴） */
out.D_alive_no_msgid = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', content: 'SECRET' },
  ctxWithRange(1, 5, { m1: 3 }));

/* E. 孤儿镜像：无 appointmentSessionId → 丢弃 */
out.E_orphan_no_sid = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentMsgId: 'm1', content: 'SECRET' },
  ctxWithRange(1, 5, { m1: 3 }));

/* E2. 孤儿镜像（即使墓碑表读不到）→ 仍丢弃 */
out.E2_orphan_no_sid_no_tombs = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentMsgId: 'm1', content: 'SECRET' },
  ctxNoTombstones());

/* F. 活卷宗但从未总结（有消息索引、无区间）→ 保留（正常尾巴） */
var ctxF = ctxEmpty();
ctxF.msgIndexById['sess_1'] = { m1: 3 };
out.F_alive_no_summary = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxF);

/* G. 隐藏楼层 → 丢弃 */
var ctxHidden = ctxEmpty();
ctxHidden.hiddenMsgIds = { m1: true };
out.G_hidden = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxHidden);

/* H. 普通线上消息（非镜像）永远保留 */
out.H_normal = shouldKeepOfflineMirror({ role: 'user', content: 'hi' }, ctxEmpty());

/* I. 已删卷宗的镜像，即使它带着区间信息也必须丢弃（墓碑优先级最高） */
var ctxI = ctxDeleted();
ctxI.sessionRanges['sess_1'] = [{ start: 1, end: 5 }];
ctxI.msgIndexById['sess_1'] = { m1: 9 };
out.I_deleted_beats_range = shouldKeepOfflineMirror(
  { offlineMeet: true, appointmentSessionId: 'sess_1', appointmentMsgId: 'm1', content: 'SECRET' },
  ctxI);

console.log(JSON.stringify(out));
"""

harness_path = '/tmp/_mirror_harness.js'
Path(harness_path).write_text(HARNESS % (cov, keep), encoding='utf-8')
r = subprocess.run(['node', harness_path], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout, r.stderr)
    raise SystemExit('Node 判定挂载失败')
J = json.loads(r.stdout.strip().splitlines()[-1])

print('\n【2】判定矩阵结果（true = 保留镜像 = 内容进 API）')
print('-' * 62)
for k in sorted(J):
    print('  %-24s → %s' % (k, '保留 ⚠' if J[k] else '丢弃 ✓'))

print('\n【3】逐条断言（修复后语义）')
print('-' * 62)

check('A 卷宗已删（墓碑命中）→ 镜像被丢弃，内容不进 API',
      J['A_deleted_tombstoned'] is False,
      '这是本轮修复的核心：删除动作不再反向关闭过滤')

check('A2 墓碑过期后仍被拦（不在活卷宗索引里即视为已删）',
      J['A2_deleted_tombstone_expired'] is False,
      '不依赖 30 天 TTL 的第二道判据')

check('A3 墓碑表读不到时保守放行（不误杀正常内容）',
      J['A3_tombstone_unknown'] is True,
      '存储异常时退回旧行为，宁可漏拦不可误删')

check('B 活卷宗 + 区间覆盖 → 丢弃',
      J['B_alive_range_covers'] is False)

check('C 活卷宗 + 区间外尾巴 → 保留',
      J['C_alive_range_outside'] is True,
      '正常链路不受影响')

check('D 活卷宗 + 镜像缺 appointmentMsgId → 保留',
      J['D_alive_no_msgid'] is True)

check('E 孤儿镜像（无 appointmentSessionId）→ 丢弃',
      J['E_orphan_no_sid'] is False,
      '无法归属任何卷宗，来源不可验证')

check('E2 孤儿镜像在墓碑不可读时也丢弃',
      J['E2_orphan_no_sid_no_tombs'] is False,
      '孤儿判定不依赖墓碑表')

check('F 活卷宗未总结 → 保留（正常尾巴）',
      J['F_alive_no_summary'] is True)

check('G 隐藏楼层 → 丢弃',
      J['G_hidden'] is False)

check('H 普通线上消息 → 保留（不影响正常链路）',
      J['H_normal'] is True)

check('I 已删卷宗即使带着区间信息也丢弃（墓碑优先级最高）',
      J['I_deleted_beats_range'] is False,
      '墓碑判据排在区间判据之前')

print('\n【4】确证修复点已落在源码里')
print('-' * 62)

check('store 导出了 isSessionTombstoned',
      'isSessionTombstoned: function' in aps_src)
check('store 导出了 getDeletedSessionIds',
      'getDeletedSessionIds: function' in aps_src)
check('过滤上下文装载了 tombstoned 集合',
      'tombstoned' in mem_src and 'getDeletedSessionIds' in mem_src)
check('shouldKeepOfflineMirror 读墓碑判据',
      'filterCtx.tombstoned' in mem_src)
check('deleteSession 会跨桶捞真身（不再直接退化为空壳）',
      '先去别的桶把真身捞出来' in aps_src)
check('purgeSessionOnlineMirrors 支持 appointmentMsgId 兜底匹配',
      'ownMsgIds' in aps_src)

print('\n【5】确认上下文来源会把已删卷宗排除掉（这正是必须读墓碑的原因）')
print('-' * 62)

# exportForMemory 取数路径
emi = aps_src.find('exportForMemory: function')
em_body = aps_src[emi:emi + 900]
check('exportForMemory 走 getSessionsByContact',
      'getSessionsByContact' in em_body or 'getSessions(' in em_body)

# getSessionsByContact 是否会滤掉已删
gs = aps_src.find('getSessionsByContact: function')
gs_body = aps_src[gs:gs + 1600]
check('getSessionsByContact 跳过空消息卷宗（countLiveMessages<=0 不返回）',
      'countLiveMessages' in gs_body,
      '已删卷宗 messages 被清空 → 不进入 exportForMemory')

# deleteSession 确实把 session 从 byChat 摘掉
ds = aps_src.find('deleteSession: function')
ds_body = aps_src[ds:ds + 2200]
check('deleteSession 从 byChat 里 filter 掉该 session',
      'filter(function (s) { return !s || s.id !== sid; })' in ds_body)
check('deleteSession 软删线上镜像（purgeSessionOnlineMirrors）',
      'purgeSessionOnlineMirrors' in ds_body)

print('\n【6】软删语义')
print('-' * 62)

sd = aps_src.find('function softDeleteChatMirror')
sd_body = aps_src[sd:sd + 1200]
check('softDeleteChatMirror 走 updateMessage，同时置 deleted 且清空 content',
      'updateMessage' in sd_body and 'deleted' in sd_body and "content: ''" in sd_body,
      '物理内容被清空，是第三道防线')

print('\n' + '=' * 62)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print('镜像存活审计：%d/%d' % (passed, total))
if passed != total:
    print('未通过项：')
    for tag, ok, d in results:
        if not ok:
            print('  ✗ %s  %s' % (tag, d))
    sys.exit(1)
print('结论成立：删除卷宗 → 过滤上下文失效 → 镜像内容重新可被 API 读到。')
