#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
线下生成「模型高级不更新」回归测试

缺陷现象
--------
线下（约会/离线会话）功能里连发数条消息，聊天设置 → 模型高级显示的
「刚生成那次」时间 / 字数 / token / 世界书命中数纹丝不动，
永远停留在上一次走线上引擎的时刻。

根因
----
js1/miya-appointment-engine.js 的 runAppointmentCompletion 走独立 fetch 链路，
消息写进 MiyaAppointmentStore 自己的 session，主 chat store 的
chat.lastPromptBreakdown 从未被触碰 —— 面板读的是旧快照，
与线下生成毫无关系（观测世界书命中数时尤其误导：用户以为修复没生效，
其实面板根本没在看线下数据）。

本测试锁住四层，缺一不可（跨层字段必须全链同步）：
  ① 引擎层：runAppointmentCompletion 收尾调用 writeOfflinePromptSnapshot，
     快照带 source:'offline'，built 透出 worldbookMeta；
  ② 多角色层：mergeWorldbookBundles 合并各 bundle 的 meta（此前整段丢弃）；
  ③ store 层：normalizePromptBreakdown 白名单收 source（漏收=静默丢字段）；
  ④ 面板层：contact-settings 透传 snapshotSource 并渲染「（线下）」标注。

跑法：
    python3 test/audit_offline_prompt_snapshot.py
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HARNESS = r"""
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = process.argv[2];
let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  pass += ok ? 1 : 0; fail += ok ? 0 : 1;
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? '  -- ' + detail : ''));
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const apSrc = read('js1/miya-appointment-engine.js');
const stSrc = read('js1/miya-chat-store.js');
const csSrc = read('js1/miya-chat-contact-settings.js');

// ═══════════════════════════════════════════════════════════
// S1 引擎层：收尾必须写快照
// ═══════════════════════════════════════════════════════════
check('S1a writeOfflinePromptSnapshot 已定义',
  /function\s+writeOfflinePromptSnapshot\s*\(/.test(apSrc),
  '缺失则线下生成永远不更新面板');

const callIdx = apSrc.indexOf('writeOfflinePromptSnapshot(chatId, built, fullRaw, msg);');
const addIdx = apSrc.indexOf('if (!msg) msg = aps.addMessage(chatId, sessionId, msgFields);');
check('S1b 收尾在 aps.addMessage 之后调用快照写入',
  callIdx > addIdx && addIdx >= 0,
  'addIdx=' + addIdx + ' callIdx=' + callIdx);

check('S1c 快照带线下来源标记（source = offline）',
  /bd\.source\s*=\s*'offline'/.test(apSrc),
  '不带标记，面板无法区分线上/线下数据');

check('S1d 快照写入成功后推送设置页刷新',
  /patchTokenUsageInSettings\(chatId\)/.test(apSrc),
  '缺了它：设置页开着时需要手动重开才能看到新数据');

check('S1e built 透出 worldbookMeta（线下世界书统计）',
  /worldbookMeta:\s*\(wbBundle && wbBundle\.meta\)\s*\|\|\s*null/.test(apSrc),
  '缺了它：线下快照的世界书命中/候选数全是 0');

check('S1f updateChat 补丁与线上同名同构（lastPromptBreakdown + lastTokenUsage）',
  /lastPromptBreakdown:\s*bd,/.test(apSrc) && /lastTokenUsage:\s*\{/.test(apSrc),
  '字段名不同构则面板读不到');

// ═══════════════════════════════════════════════════════════
// S2 多角色层：mergeWorldbookBundles 必须合并 meta
// ═══════════════════════════════════════════════════════════
const mergeBody = apSrc.slice(
  apSrc.indexOf('function mergeWorldbookBundles'),
  apSrc.indexOf('function sumLayerCharsLocal'));
check('S2a mergeWorldbookBundles 返回值带 meta',
  /meta:\s*mergedMeta/.test(mergeBody),
  '此前多角色线下 wbBundle.meta 恒 undefined');
check('S2b meta 合并累加候选数（consideredCount）',
  /mergedMeta\.consideredCount\s*\+=/.test(mergeBody),
  '缺了它：多人约会的候选数归零');
check('S2c meta 合并累加预算裁剪数（budgetDroppedCount）',
  /mergedMeta\.budgetDroppedCount\s*\+=/.test(mergeBody),
  '缺了它：多人约会看不出条目被预算裁剪');

// ═══════════════════════════════════════════════════════════
// S3 store 层：白名单必须收 source（跨层同步教训）
// ═══════════════════════════════════════════════════════════
check('S3a normalizePromptBreakdown 白名单透出 source',
  /source:\s*String\(raw\.source \|\| ''\)/.test(stSrc),
  '白名单漏收 = updateChat 落库时静默丢字段');

// ═══════════════════════════════════════════════════════════
// S4 面板层：透传 + 渲染线下标注
// ═══════════════════════════════════════════════════════════
check('S4a 快照读取透传 snapshotSource',
  /snapshotSource:\s*String\(snapshot\.source \|\| ''\)/.test(csSrc),
  '缺了它：渲染层拿不到来源');
check('S4b 主面板标注线下来源（上次发送（线下））',
  /上次发送' \+ \(snapshot\.snapshotSource === 'offline' \? '（线下）' : ''\)/.test(csSrc),
  '缺了它：用户分不清数据来自哪条链路');
check('S4c 明细弹层标注线下来源（Prompt 注入（线下））',
  /snapshot\.snapshotSource === 'offline' \? '（线下）' : ''/.test(csSrc),
  '明细层同样需要标注');

// ═══════════════════════════════════════════════════════════
// R 运行时：真实 store 验证 source 落库/透传
// ═══════════════════════════════════════════════════════════
const lsData = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null),
  setItem: (k, v) => { lsData[k] = String(v); },
  removeItem: (k) => { delete lsData[k]; },
};
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  JSON, Date, Math, Object, Array, Number, String, Promise, RegExp, Error,
  setTimeout, clearTimeout,
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
sandbox.miyaSyncReadJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
sandbox.miyaWriteLsJsonKey = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); };
sandbox.miyaWriteLsJsonKeySync = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); };
sandbox.fetch = function () { return Promise.reject(new Error('no network in test')); };
vm.createContext(sandbox);

(async function runtimePart() {
  try {
    vm.runInContext(stSrc, sandbox, { filename: 'js1/miya-chat-store.js' });
  } catch (e) {
    check('R0 store 加载', false, String(e && e.message));
    console.log('__RESULT__' + JSON.stringify(results));
    return;
  }
  const CS = sandbox.miyaChatStore || sandbox.MiyaChatStore;
  check('R0 chat-store 加载成功', !!CS, CS ? 'ok' : '未导出');

  if (CS) {
    try {
      if (CS.init) await CS.init();
      const cs2 = sandbox.miyaContactsStore;
      if (cs2 && cs2.upsertCharacter) {
        cs2.upsertCharacter({ name: '测试', groupId: 'ct_default', persona: 'x' });
      }
      /* addContactFromChronicle 返回的 contact.id 是 store 内部生成的 uid，
         createChat 必须用这个 id（直接用 chronicle id 会 contact_not_found）。 */
      const contact = await CS.addContactFromChronicle({ id: 'chron_off', characterId: 'chron_off', name: '测试' })
        .catch(function () { return null; });
      check('R0b 造联系人成功', !!contact && !!contact.id,
        'contact=' + JSON.stringify(contact && contact.id));
      const chat = contact
        ? await CS.createChat({ contactId: contact.id }).catch(function () { return null; })
        : null;
      check('R0c 造会话成功', !!chat && !!chat.id,
        'chat=' + JSON.stringify(chat && chat.id));
      const cid = chat && chat.id ? String(chat.id) : '';
      await CS.addMessage(cid, { role: 'user', content: '你好' });

      // 模拟线下引擎收尾写入（与 writeOfflinePromptSnapshot 的 patch 同构）
      const snap = {
        grouped: [{ key: 'system_main', label: '系统主提示', chars: 120, tokens: 75, count: 1, subItems: [] }],
        promptChars: 120,
        promptTokens: 75,
        worldbookMatched: 3,
        worldbookConsidered: 6,
        worldbookDropped: 0,
        worldbookInSystem: true,
        replyMsgId: 'msg_off_1',
        isGroupReply: false,
        source: 'offline',
        updatedAt: 1770000000000
      };
      await CS.updateChat(cid, {
        lastPromptBreakdown: snap,
        lastTokenUsage: {
          prompt_chars: 120, completion_chars: 40, total_chars: 160,
          prompt_tokens: 120, completion_tokens: 40, total_tokens: 160,
          updatedAt: 1770000000000, source: 'local_chars'
        }
      });

      const row = CS.findChat(cid);
      const bd = row && row.lastPromptBreakdown;
      check('R1 线下快照落库（findChat 读回 lastPromptBreakdown）',
        !!bd && Array.isArray(bd.grouped) && bd.grouped.length > 0,
        bd ? 'ok' : '快照为 null —— 白名单层被丢');

      check('R2 source 字段跨层透传（offline）',
        !!bd && bd.source === 'offline',
        '实际 source=' + JSON.stringify(bd && bd.source));

      check('R3 线下快照的世界书统计落库（命中/候选）',
        !!bd && bd.worldbookMatched === 3 && bd.worldbookConsidered === 6,
        'matched=' + (bd && bd.worldbookMatched) + ' considered=' + (bd && bd.worldbookConsidered));

      check('R4 本地用量落库（lastTokenUsage）',
        !!(row && row.lastTokenUsage && row.lastTokenUsage.completion_chars === 40),
        'usage=' + JSON.stringify(row && row.lastTokenUsage && row.lastTokenUsage.completion_chars));

      // 线上语义回归：不带 source 的快照（主引擎写入）→ source 应为空串
      await CS.updateChat(cid, {
        lastPromptBreakdown: {
          grouped: [{ key: 'system_main', label: '系统主提示', chars: 90, tokens: 56, count: 1, subItems: [] }],
          promptChars: 90, promptTokens: 56,
          worldbookMatched: 2, worldbookConsidered: 4, worldbookDropped: 0,
          replyMsgId: 'msg_on_1', updatedAt: 1770000009999
        }
      });
      const row2 = CS.findChat(cid);
      check('R5 线上快照（无 source）落库为空串，不残留 offline',
        row2 && row2.lastPromptBreakdown && row2.lastPromptBreakdown.source === '',
        '实际=' + JSON.stringify(row2 && row2.lastPromptBreakdown && row2.lastPromptBreakdown.source));

      check('R6 快照被新一轮覆盖（时间戳更新语义）',
        row2 && row2.lastPromptBreakdown && row2.lastPromptBreakdown.updatedAt === 1770000009999,
        '实际 updatedAt=' + (row2 && row2.lastPromptBreakdown && row2.lastPromptBreakdown.updatedAt));
    } catch (e) {
      check('R1-R6 运行时验证', false, '异常：' + String(e && e.message));
    }
  }

  console.log('__RESULT__' + JSON.stringify(results));
  console.log('\n' + '='.repeat(58));
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail));
  if (fail) console.log('失败 ' + fail + ' 项');
  console.log('='.repeat(58));
})();
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
    sys.stdout.write(proc.stdout)
    if proc.stderr.strip():
        sys.stderr.write(proc.stderr)
    return proc.returncode if proc.stdout.strip().find('FAIL') < 0 else 1


if __name__ == "__main__":
    sys.exit(main())
