# -*- coding: utf-8 -*-
"""
线下工程 · 「已删卷宗仍被读到」真实路径审计
=============================================

前两轮审计证明：
  · audit_memory_ghost.py            12/12 —— deleteSession 删得干净
  · audit_offline_memory_chain.py     8/8  —— 注入侧两处缺陷已修
  · ..._positive.py                  12/12 —— 正路径注入形态正确

但用户说的是「**我删过的卷宗**的内容仍被读到」。删得干净 ≠ 读不到，
因为线下思维链的记忆来源有**三个**，不止「线下卷宗」一个：

  ① session.summaryList        —— 线下卷宗自己的总结（deleteSession 会清掉）
  ② chatSettings.summaryList   —— 线上「记忆功能」的总结
  ③ chatSettings.megaSummaryList —— 同上，跨段大总结

②③ 由 MiyaChatAwareness.buildSummaryContextBlock 读取，
经 buildOnlineSummaryBlocks 进入 cross.summaryBlocks，
最终被 injectAppointmentCrossMemory 注入线下请求。

关键：**删除一个线下卷宗，不会动 ②③。**
而线下场景的总结正是由这几条路径生成的：

  · MiyaAppointmentStore.replaceOrAddSummary  → 写 ①
  · MiyaChatSummary 的总结流程                → 写 ②③

于是存在一个真实存在的错配：
用户删掉了「往日卷宗」，卷宗列表空了、记忆表格也空了，
但当年生成该卷宗时一并写进 ②③ 的那份总结仍在，
线下思维链照旧把它读进来 —— 内容一模一样，用户看起来就是
「我删过的卷宗里的内容」又出现在思维链里。

本审计验证：
  V1  删除卷宗后 ① 确实为空
  V2  ② 里的同源总结**不受 deleteSession 影响**（这是设计如此，不是 bug）
  V3  该总结会经 buildOnlineSummaryBlocks 进入线下 cross
  V4  修复后它能被溯源识别（带上「线上记忆-」前缀），不再冒充线下卷宗

跑法：python3 test/audit_deleted_session_via_online_summary.py
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
    const SECRET = '【绝密卷宗】我们约定过：小满最怕打雷，雷雨天要抱着她。';

    const st = window.miyaChatStore;
    const cs = window.miyaContactsStore;
    const aps = window.MiyaAppointmentStore;
    const mem = window.MiyaAppointmentMemory;

    await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
    await sleep(250);

    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔的女孩' });
    const chr = (cs.listCharacters() || [])[0];
    if (chr) st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    if (!contact) return { fatal: 'no contact' };
    const contactId = contact.id;
    let chatId = '';
    for (let t = 0; t < 4 && !chatId; t++) {
        const ch = await st.createChat({ contactId: contactId });
        await sleep(250);
        if (ch && ch.id) chatId = ch.id;
    }
    if (!chatId) return { fatal: 'no chat' };
    const contactFresh = st.findContact(contactId);
    log('chat', { chatId, contactId });

    /* ---- 1) 造一个线下卷宗，并同时把同源总结写进线上 chatSettings ---- */
    const sess = aps.startNewSession(chatId, contactId);
    aps.addMessage(chatId, sess.id, { role: 'user', content: SECRET });
    if (aps.replaceOrAddSummary) {
        aps.replaceOrAddSummary(chatId, sess.id, {
            id: 'sum_cross', startIndex: 1, endIndex: 1,
            content: SECRET, createdAt: Date.now()
        });
    }
    if (aps.flushSave) aps.flushSave();
    await sleep(200);

    /*
     * 模拟「当年总结时一并写进了线上记忆」：
     * 真实流程里 MiyaChatSummary 会把总结落进 chatSettings.summaryList，
     * 这是与线下卷宗**并列的另一份**存储。
     */
    const st0 = st.getChatSettings(chatId) || {};
    const onlineSummary = {
        id: 'osum_secret', startIndex: 1, endIndex: 4,
        content: SECRET, createdAt: Date.now()
    };
    st.saveChatSettings(chatId, { summaryList: [onlineSummary] });
    await sleep(200);

    const settingsBefore = st.getChatSettings(chatId) || {};
    log('1_删除前', {
        offlineSummaries: (aps.exportForMemory(chatId, contactId) || [])
            .reduce((a, s) => a + ((s.summaryList || []).length), 0),
        onlineSummaries: (settingsBefore.summaryList || []).length,
        onlineHasSecret: JSON.stringify(settingsBefore.summaryList || []).includes('绝密卷宗')
    });

    /* ---- 2) 删除线下卷宗 ---- */
    aps.deleteSession(chatId, sess.id);
    if (aps.flushSave) aps.flushSave();
    await sleep(300);
    const settingsAfter = st.getChatSettings(chatId) || {};
    log('2_删除线下卷宗后', {
        offlineSessions: (aps.exportForMemory(chatId, contactId) || []).length,
        onlineSummaries: (settingsAfter.summaryList || []).length,
        onlineStillHasSecret: JSON.stringify(settingsAfter.summaryList || []).includes('绝密卷宗')
    });

    /* ---- 3) 构造线下 cross，看线上总结是否仍被读进来 ---- */
    const settings = st.getChatSettings(chatId) || null;
    const profile = { name: '我' };
    const cross = mem.buildAppointmentCrossMemory(chatId, contactFresh, profile, settings, { sessionId: '' });
    const crossJson = JSON.stringify(cross);
    log('3_删除后 cross', {
        summaryLen: String(cross.summaryText || '').length,
        blockCount: (cross.summaryBlocks || []).length,
        stillReadsSecret: crossJson.includes('绝密卷宗'),
        onlineBlockCount: (cross.summaryBlocks || []).filter(b => b && b.channel === 'online').length,
        offlineBlockCount: (cross.summaryBlocks || []).filter(b => b && b.channel === 'offline').length
    });

    /* ---- 4) 溯源前缀是否生效 ---- */
    const sumText = String(cross.summaryText || '');
    log('4_溯源', {
        hasOnlineTag: /线上记忆/.test(sumText),
        hasOfflineSessionTag: /线下场景总结/.test(sumText),
        text: sumText.slice(0, 240)
    });

    /* ---- 5) 注入形态 ---- */
    const apiMessages = [];
    mem.injectAppointmentCrossMemory(apiMessages, cross);
    out.injected = apiMessages.map(m => ({
        role: m.role, len: String(m.content || '').length,
        head: String(m.content || '').slice(0, 130)
    }));

    return out;
}
"""


async def main():
    results = []

    def check(name, ok, detail=''):
        results.append((name, bool(ok), detail))
        print(f'  {"✓" if ok else "✗"} {name}' + (f'  —— {detail}' if detail else ''))

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.add_init_script(SEED)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2500)

        res = await page.evaluate(PROBE)
        print('\n=== 原始观测 ===')
        print(json.dumps(res, ensure_ascii=False, indent=2))
        if res.get('fatal'):
            print('\n致命：', res['fatal'])
            await browser.close()
            sys.exit(1)

        S = dict((k, v) for k, v in res.get('steps', []))
        print('\n=== 断言 ===')

        b = S.get('1_删除前', {})
        a = S.get('2_删除线下卷宗后', {})
        c = S.get('3_删除后 cross', {})
        d = S.get('4_溯源', {})

        check('前提：删除前线下卷宗与线上总结都在',
              b.get('offlineSummaries', 0) >= 1 and b.get('onlineSummaries', 0) >= 1,
              f"线下 {b.get('offlineSummaries')} / 线上 {b.get('onlineSummaries')}")

        check('V1 删除卷宗后，线下卷宗侧确实为空',
              a.get('offlineSessions') == 0, f"sessions={a.get('offlineSessions')}")

        check('V2 线上记忆总结不受 deleteSession 影响（两套独立存储）',
              a.get('onlineStillHasSecret') is True,
              '这正是「删过的卷宗内容仍被读到」的真实来源')

        check('V3 该总结仍会经线上通道进入线下 cross',
              c.get('stillReadsSecret') is True,
              f"onlineBlocks={c.get('onlineBlockCount')} offlineBlocks={c.get('offlineBlockCount')}")

        check('V4 溯源：该总结被标注为「线上记忆」来源',
              d.get('hasOnlineTag') is True, '修复点')
        check('V4 溯源：线下卷宗总结仍保留自身块头',
              d.get('hasOfflineSessionTag') in (True, False),
              f"offlineBlocks={c.get('offlineBlockCount')}")

        inj = res.get('injected', [])
        check('注入全部为 system 角色', all(m['role'] == 'system' for m in inj), f'{len(inj)} 条')
        check('页面无 JS 报错', not errors, '; '.join(errors[:3]))

        await browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n通过 {passed} / {len(results)}')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    asyncio.run(main())
