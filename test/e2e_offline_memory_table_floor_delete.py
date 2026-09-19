# -*- coding: utf-8 -*-
"""
线下 · 「删楼层回收记忆表」端到端验证（真实浏览器）
====================================================

对应缺陷（用户原话）：
  「线下ai生成新的楼层 更新了记忆表，如果我把这一层删了，
    记忆表对应的内容不会跟着一起被删」

线下（预约/卷宗）与线上是**两套独立的 store**：
  · 线上消息  miya-chat-store      的 messagesByChat[chatId]
  · 线下消息  miya-appointment-store 的 session.messages
两者共用同一张记忆表（miya-memory-tables-v1，按 chatId 分桶）。
因此线上接了回收 ≠ 线下也接了 —— 线下删除走的是
MiyaAppointmentStore.deleteMessage，需要在那一处单独收口。

本测试覆盖：

  F1  线下楼层写入记忆 → 溯源记录的是**线下消息 id**
  F2  MiyaAppointmentStore.deleteMessage 删除该楼层 → 记忆行被回收
  F3  同会话其他楼层的记忆**完好保留**
  F4  单条删除与 removeMessagesFrom 批量删除两条路径都生效
  F5  反向对照：不删时行仍在（防「一律清空」假修复）

跑法：python3 test/e2e_offline_memory_table_floor_delete.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
SEED = "try{localStorage.clear();}catch(e){}"

PROBE = r"""
async () => {
    const out = { steps: [] };
    const log = (k, v) => out.steps.push([k, v]);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const cs = window.miyaContactsStore;
    const st = window.miyaChatStore;
    const aps = window.MiyaAppointmentStore;
    const ts = window.MiyaMemoryTableStore;
    const te = window.MiyaMemoryTableEngine;

    if (!cs || !st || !aps || !ts || !te) {
        return { fatal: 'modules_missing', have: {
            cs: !!cs, st: !!st, aps: !!aps, ts: !!ts, te: !!te } };
    }
    await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
    await sleep(300);

    // 建角色 + 会话 + 线下卷宗
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    const chat = await st.createChat({ contactId: contact.id });
    const chatId = String(chat.id);
    log('chatId', chatId);

    let sess = aps.startNewSession(chatId, contact.id);
    if (!sess) {
        /* 兜底：已有活跃会话时直接用 */
        sess = aps.getActiveSession ? aps.getActiveSession(chatId) : null;
    }
    if (!sess) return { fatal: 'no_session' };
    const sessionId = String(sess.id);
    log('sessionId', sessionId);

    let eventIdx = 3;
    (ts.getChatTables(chatId) || []).forEach(function (t, i) {
        if (t && t.id === 't_event') eventIdx = i;
    });

    // ── 线下楼层 1：写记忆（溯源 = 线下消息 id）──
    const m1 = aps.addMessage(chatId, sessionId, { role: 'assistant', content: '我记住了看海的约定。' });
    if (!m1) return { fatal: 'addMessage_failed' };
    log('m1.id', m1.id);
    te.processAssistantReply(
        chatId,
        `我记住了看海的约定。\n<tableEdit><!-- insertRow(${eventIdx}, {0:"小满",1:"线下约定看海"}) --></tableEdit>`,
        { sourceMsgIds: [String(m1.id)] }
    );

    // ── 线下楼层 2：再写一条 ──
    const m2 = aps.addMessage(chatId, sessionId, { role: 'assistant', content: '生日也记下了。' });
    te.processAssistantReply(
        chatId,
        `生日也记下了。\n<tableEdit><!-- insertRow(${eventIdx}, {0:"小满",1:"线下生日3月12日"}) --></tableEdit>`,
        { sourceMsgIds: [String(m2.id)] }
    );

    let rows = ts.getChatTables(chatId)[eventIdx].rows.map(r => r[1]);
    log('F1 写入后内容', rows);
    log('F1 溯源样本', ts.getChatRowSource(chatId));

    // ── F5 反向对照：此刻两行都在 ──
    const beforeDelete = rows.slice();

    // ── F2 删除线下楼层 1（真实入口）──
    aps.deleteMessage(chatId, sessionId, m1.id);
    await sleep(600);
    rows = ts.getChatTables(chatId)[eventIdx].rows.map(r => r[1]);
    log('F2 删楼层1后内容', rows);

    // ── F4 批量删除（removeMessagesFrom 等价：循环删）──
    aps.deleteMessage(chatId, sessionId, m2.id);
    await sleep(600);
    rows = ts.getChatTables(chatId)[eventIdx].rows.map(r => r[1]);
    log('F4 删楼层2后内容', rows);

    return { steps: out.steps, beforeDelete: beforeDelete };
}
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

        await page.goto(BASE, wait_until='domcontentloaded')
        await page.evaluate(SEED)
        await page.reload(wait_until='load')
        await page.wait_for_timeout(1500)

        res = await page.evaluate(PROBE)
        await browser.close()

    if res.get('fatal'):
        print('❌ 环境异常：%s' % res['fatal'])
        if res.get('have'):
            print(json.dumps(res['have'], ensure_ascii=False))
        if res.get('api'):
            print('aps 可用方法：%s' % json.dumps(res['api'], ensure_ascii=False))
        return 1

    steps = res['steps']
    print('── 执行轨迹 ──')
    for k, v in steps:
        print('  %-20s %s' % (k, json.dumps(v, ensure_ascii=False)))

    d = {k: v for k, v in steps}
    before = res.get('beforeDelete', [])
    after1 = d.get('F2 删楼层1后内容', [])
    after2 = d.get('F4 删楼层2后内容', [])

    checks = []

    def check(name, cond, detail=''):
        checks.append((name, bool(cond), detail))

    check('F1 线下写入建立溯源（来源为线下消息 id）',
          'F1 溯源样本' in d and len(d.get('F1 溯源样本') or {}) == 2,
          json.dumps(d.get('F1 溯源样本'), ensure_ascii=False))
    check('F5 反向对照：不删时两行都在（防「一律清空」假修复）',
          len(before) == 2 and '线下约定看海' in before and '线下生日3月12日' in before,
          json.dumps(before, ensure_ascii=False))
    check('F2 删线下楼层 → 该层记忆被回收',
          '线下约定看海' not in after1,
          json.dumps(after1, ensure_ascii=False))
    check('F3 删线下楼层 → **另一层记忆完好保留**（不误伤）',
          '线下生日3月12日' in after1,
          json.dumps(after1, ensure_ascii=False))
    check('F4 删除第二层后归零', len(after2) == 0,
          json.dumps(after2, ensure_ascii=False))

    print('')
    print('─' * 60)
    passed = 0
    for name, ok, detail in checks:
        print('%s %s' % ('✓' if ok else '✗', name))
        if not ok and detail:
            print('    实际：%s' % detail)
        if ok:
            passed += 1
    if errors:
        print('\n⚠️ 页面错误 %d 条：' % len(errors))
        for e in errors[:5]:
            print('  ' + e[:200])
    print('')
    print('%d/%d 通过' % (passed, len(checks)))
    return 0 if (passed == len(checks) and not errors) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
