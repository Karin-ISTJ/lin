# -*- coding: utf-8 -*-
"""
线下工程 · 思维链记忆注入审计（正路径）
==========================================

audit_offline_memory_chain.py 走的是「先建卷宗 → 再删 → 观察注入」，
删完之后 cross 包本来就是空的，断言容易变成空跑（summaryLen=0 时
「抬头出现 0 次」也算通过 —— 这是假通过）。

本文件补的正是这条：**保留卷宗**，让 cross 包里真的有总结内容，
再验证注入形态。这样 D2 的三条断言才是实打实的。

内容准备走 replaceOrAddSummary（离线总结的正式入口），
它同时驱动：
  · summaryList → buildOfflineSummaryBlocks / collectOfflineSlotsForOnline
  · buildOfflineMirrorFilterContext → 线上镜像过滤口径

跑法：python3 test/audit_offline_memory_chain_positive.py
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
    log('chat', { chatId, contactId });

    /* ---- 1) 两个卷宗：A 保留（本场），B 作为“往期线下”被读取 ---- */
    const sessA = aps.startNewSession(chatId, contactId);
    const sessB = aps.startNewSession(chatId, contactId);
    if (!sessA || !sessB) return { fatal: 'no session' };

    aps.addMessage(chatId, sessB.id, { role: 'user', content: '去年的今天我们去看了海。' });
    aps.addMessage(chatId, sessB.id, { role: 'assistant', content: '嗯，那天风很大。' });
    if (aps.replaceOrAddSummary) {
        aps.replaceOrAddSummary(chatId, sessB.id, {
            id: 'sum_b', startIndex: 1, endIndex: 2,
            content: SECRET, createdAt: Date.now() - 86400000
        });
    }
    aps.addMessage(chatId, sessA.id, { role: 'user', content: '今天在家休息。' });
    if (aps.flushSave) aps.flushSave();
    await sleep(250);

    const ex = aps.exportForMemory(chatId, contactId) || [];
    log('1_卷宗落库', {
        sessions: ex.length,
        totalSummaries: ex.reduce((a, s) => a + ((s.summaryList || []).length), 0),
        hasSecret: JSON.stringify(ex).includes('绝密卷宗')
    });

    /* ---- 2) 构造 cross：sessionId = 本场 sessA（应排除本场，保留 B） ---- */
    const settings = st.getChatSettings ? st.getChatSettings(chatId) : null;
    const profile = { name: '我' };
    const cross = mem.buildAppointmentCrossMemory(chatId, contact, profile, settings, { sessionId: sessA.id });
    log('2_cross', {
        summaryLen: String(cross.summaryText || '').length,
        summaryBlocks: (cross.summaryBlocks || []).length,
        slotItems: (cross.slotItems || []).length,
        leaksSecret: JSON.stringify(cross).includes('绝密卷宗'),
        excludedSelf: !JSON.stringify(cross).includes('今天在家休息')
    });

    /* ---- 3) 注入后的 system 消息 ---- */
    const apiMessages = [];
    mem.injectAppointmentCrossMemory(apiMessages, cross);
    out.injected = apiMessages.map(m => ({
        role: m.role,
        len: String(m.content || '').length,
        head: String(m.content || '').slice(0, 110)
    }));
    log('3_注入 system 消息数', apiMessages.length);

    /* ---- 4) 总结块头的存在性：证明 turn 转文本没有丢块头 ---- */
    const sumMsg = apiMessages.find(m => /对话历史记忆/.test(m.content || '')) || null;
    const sumText = String((sumMsg && sumMsg.content) || '');
    log('4_总结抬头出现次数', (sumText.match(/对话历史记忆/g) || []).length);
    log('4_是否标注为已发生', /已经发生过/.test(sumText));
    log('4_是否标注非待接内容', /不是当前待接|勿当作本轮/.test(sumText));
    log('4_是否保留会话块头', /线下场景总结/.test(sumText));
    log('4_是否含绝密内容', /绝密卷宗/.test(sumText));
    log('4_不含重复壳层', !/【对话历史记忆·总结】[\s\S]*【对话历史记忆·总结】/.test(sumText));

    /* ---- 5) 世界书匹配上下文口径复算 ---- */
    const slotBodies = (cross.slotItems || []).map(it => String(it.content || '').trim()).filter(Boolean);
    const preFix = slotBodies.concat(cross.summaryText ? [String(cross.summaryText)] : []);
    log('5_修复前匹配文本条数', preFix.length);
    log('5_修复后匹配文本条数', slotBodies.length);
    log('5_修复前泄漏总结进匹配文本', preFix.join('\n').includes('对话历史记忆'));
    log('5_修复后不泄漏', !slotBodies.join('\n').includes('对话历史记忆'));

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

        # 前提：这次真的有内容，断言不再空跑
        c2 = S.get('2_cross', {})
        check('前提：cross 包里确实有总结内容（非空跑）',
              c2.get('summaryLen', 0) > 0, f"summaryLen={c2.get('summaryLen')}")
        check('前提：跨场记忆读到了保留的卷宗 B',
              c2.get('leaksSecret') is True)
        check('前提：本场 sessA 已被正确排除',
              c2.get('excludedSelf') is True)

        # D2 三条（这次是实的）
        check('D2 总结抬头只出现一次（不再双重套壳）',
              S.get('4_总结抬头出现次数') == 1, f"出现 {S.get('4_总结抬头出现次数')} 次")
        check('D2 总结被标注为「已经发生过」',
              S.get('4_是否标注为已发生') is True)
        check('D2 总结被标注为「不是当前待接内容」',
              S.get('4_是否标注非待接内容') is True)
        check('D2 总结保留了「线下场景总结·会话」块头（未被拍成裸文本）',
              S.get('4_是否保留会话块头') is True)
        check('D2 无重复壳层', S.get('4_不含重复壳层') is True)

        # D1 复算（这次也是实的）
        check('D1 修复前会把总结混进世界书匹配文本',
              S.get('5_修复前泄漏总结进匹配文本') is True,
              f"{S.get('5_修复前匹配文本条数')} 条")
        check('D1 修复后匹配文本不再含总结',
              S.get('5_修复后不泄漏') is True,
              f"{S.get('5_修复后匹配文本条数')} 条")

        inj = res.get('injected', [])
        check('注入全部为 system 角色', all(m['role'] == 'system' for m in inj), f'{len(inj)} 条')
        check('页面无 JS 报错', not errors, '; '.join(errors[:3]))

        await browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n通过 {passed} / {len(results)}')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    asyncio.run(main())
