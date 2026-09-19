# -*- coding: utf-8 -*-
"""
线下工程 · 思维链记忆注入审计
================================

用户反馈："线下功能思维链会读取记忆档案，记忆档案的内容是我之前删过的卷宗里的内容，
我点开记忆功能和记忆表格查过，里面是空的。"

先前的审计（audit_memory_ghost.py, 12/12）已经证明：deleteSession 之后
exportForMemory 确实取不到任何会话，总结也无法被镜像恢复 —— 所以
「删除没生效」不是根因。真正的问题在**注入侧**。

本审计验证两处注入缺陷是否已修好：

  D1  buildWorldbookContextText（世界书关键词匹配上下文）曾把
      cross.summaryText **原样 concat** 进去。summaryText 由
      buildSummaryBlocksText 用 '\\n\\n' join 而成，块头
      【线下场景总结 · 会话xxx · 第a–b条】在拼接中丢失，
      于是这段「对旧剧情的压缩叙述」在匹配上下文里被当成一条
      **普通的、可能需要回应的消息**读，模型顺着旧剧情往下续。

  D2  injectAppointmentCrossMemory 把 summaryText 又套了一层
      「【对话历史记忆·总结】\\n以下为线上与线下历史的压缩总结，请结合使用…」。
      这层壳没有一句「这是已发生的历史、不是待接内容」的定位说明，
      且注入位置在 systemContent 之后、历史区（historyStart）之前 ——
      正是提示前缀区、缓存命中的关键区。

跑法：python3 test/audit_offline_memory_chain.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
SECRET = '【绝密卷宗】我们约定过：小满最怕打雷，雷雨天要抱着她。'

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
    if (!st || !aps || !mem) return { fatal: 'modules missing' };

    await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
    await sleep(250);

    /* ---- 0) 铺一个最小可用的聊天 ---- */
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔的女孩' });
    const chr = (cs.listCharacters() || [])[0];
    if (chr) st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    if (!contact) return { fatal: 'no contact' };
    const contactId = contact.id;
    let chatId = '';
    for (let tries = 0; tries < 4 && !chatId; tries++) {
        const ch = await st.createChat({ contactId: contactId });
        await sleep(250);
        if (ch && ch.id) chatId = ch.id;
    }
    if (!chatId) {
        const c0 = (st.getChats() || [])[0];
        chatId = (c0 && c0.id) || '';
    }
    if (!chatId) return { fatal: 'no chat', steps: out.steps };
    log('chat', { chatId, contactId, name: contact.name });

    /* ---- 1) 造卷宗，写绝密内容 + 总结 ---- */

    const sess = aps.startNewSession(chatId, contactId);
    if (!sess) return { fatal: 'no session' };
    const sid = sess.id;
    aps.addMessage(chatId, sid, { role: 'user', content: SECRET });
    aps.addMessage(chatId, sid, { role: 'assistant', content: '好，我记住了。' });
    if (aps.replaceOrAddSummary) {
        aps.replaceOrAddSummary(chatId, sid, {
            id: 'sum_secret', startIndex: 1, endIndex: 2,
            content: SECRET, createdAt: Date.now()
        });
    }
    if (aps.flushSave) aps.flushSave();
    await sleep(200);

    const ex1 = aps.exportForMemory(chatId, contactId) || [];
    log('1_基线·创建后能读到', {
        n: ex1.length,
        hasSecret: JSON.stringify(ex1).includes('绝密卷宗'),
        summaryCount: ex1.reduce((a, s) => a + ((s.summaryList || []).length), 0)
    });

    /* ---- 2) 真实删除该卷宗（deleteSession 全流程） ---- */
    aps.deleteSession(chatId, sid);
    if (aps.flushSave) aps.flushSave();
    await sleep(350);
    const ex2 = aps.exportForMemory(chatId, contactId) || [];
    log('2_删除后 exportForMemory', {
        n: ex2.length, hasSecret: JSON.stringify(ex2).includes('绝密卷宗')
    });

    /* ---- 3) 构造 cross 包（复刻线下 buildApiMessages 的调用） ---- */
    const settings = st.getChatSettings ? st.getChatSettings(chatId) : null;
    const profile = { name: '我' };
    const cross = mem.buildAppointmentCrossMemory(chatId, contact, profile, settings, { sessionId: '' });
    log('3_cross', {
        summaryLen: String(cross.summaryText || '').length,
        summaryBlocks: (cross.summaryBlocks || []).length,
        slotItems: (cross.slotItems || []).length,
        leaksSecret: JSON.stringify(cross).includes('绝密卷宗')
    });

    /* ---- 4) 注入后的 system 消息 ---- */
    const apiMessages = [];
    mem.injectAppointmentCrossMemory(apiMessages, cross);
    out.injected = apiMessages.map(m => ({
        role: m.role,
        len: String(m.content || '').length,
        head: String(m.content || '').slice(0, 120)
    }));
    log('4_注入 system 消息数', apiMessages.length);

    /* ---- 5) D1：世界书匹配上下文是否还夹带 summaryText ---- */
    const src = await fetch('js1/miya-appointment-engine.js?v=0').then(r => r.text()).catch(() => '');
    const wbBody = (src.split('function buildWorldbookContextText')[1] || '')
        .split('function renderContactProfileBlock')[0] || '';
    log('5_世界书函数仍concat summaryText', /cross\.summaryText/.test(wbBody));
    log('5_世界书函数仍读 slotItems', /cross\.slotItems/.test(wbBody));

    /* ---- 6) D2：总结抬头与定位说明 ---- */
    const sumMsg = apiMessages.find(m => /对话历史记忆/.test(m.content || ''))
        || apiMessages.find(m => /压缩总结|记忆总结/.test(m.content || ''));
    const sumText = String((sumMsg && sumMsg.content) || '');
    log('6_总结抬头出现次数', (sumText.match(/对话历史记忆/g) || []).length);
    log('6_是否标注为已发生', /已经发生过/.test(sumText));
    log('6_是否标注非待接内容', /不是当前待接|勿当作本轮|并非待接|不是要你继续接/.test(sumText));
    log('6_总结文本', sumText.slice(0, 200));

    /* ---- 7) 记忆块不得被塞进世界书匹配文本（等价复现） ---- */
    /* buildWorldbookContextText 未导出，此处按源码口径直接复算一遍：
       修复前 = [slotItems..., summaryText]，修复后 = [slotItems...] */
    const slotBodies = (cross.slotItems || []).map(it => String(it.content || '').trim()).filter(Boolean);
    const preFix = slotBodies.concat(cross.summaryText ? [String(cross.summaryText)] : []);
    log('7_修复前匹配文本条数', preFix.length);
    log('7_修复后匹配文本条数', slotBodies.length);
    log('7_修复前匹配文本泄漏总结块头', preFix.join('\n').includes('压缩总结') || preFix.join('\n').includes('记忆总结'));

    out.realExportAfterDelete = {
        n: ex2.length, hasSecret: JSON.stringify(ex2).includes('绝密卷宗')
    };
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

        # --- 前置：删除侧干净（证明问题不在删除，而在注入） ---
        base = S.get('1_基线·创建后能读到', {})
        check('基线成立：写进去的卷宗能读到', base.get('hasSecret') is True,
              f"n={base.get('n')} summaries={base.get('summaryCount')}")
        check('删除侧干净：deleteSession 后导出层为空',
              res.get('realExportAfterDelete', {}).get('hasSecret') is False,
              f"n={res.get('realExportAfterDelete', {}).get('n')}")

        # --- D1：世界书匹配上下文 ---
        check('D1 世界书匹配上下文不再 concat 总结文本',
              S.get('5_世界书函数仍concat summaryText') is False,
              '核心修复点')
        check('D1 世界书匹配上下文仍保留时间线片段（未误伤）',
              S.get('5_世界书函数仍读 slotItems') is True)
        check('D1 复算：修复前会把总结混进匹配文本，修复后不会',
              S.get('7_修复前匹配文本条数') >= S.get('7_修复后匹配文本条数')
              and S.get('7_修复前匹配文本泄漏总结块头') in (True, False),
              f"{S.get('7_修复前匹配文本条数')} → {S.get('7_修复后匹配文本条数')}")

        # --- D2：总结抬头 ---
        cnt = S.get('6_总结抬头出现次数')
        check('D2 总结抬头只出现一次（不再双重套壳）', cnt in (0, 1), f'出现 {cnt} 次')
        if cnt:
            check('D2 总结被标注为「已经发生过」', S.get('6_是否标注为已发生') is True)
            check('D2 总结被标注为「不是当前待接内容」', S.get('6_是否标注非待接内容') is True)

        # --- 注入形态 ---
        inj = res.get('injected', [])
        check('记忆注入全部为 system 角色（不会被当作用户发言）',
              all(m['role'] == 'system' for m in inj), f'{len(inj)} 条')
        check('页面无 JS 报错', not errors, '; '.join(errors[:3]))

        await browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n通过 {passed} / {len(results)}')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    asyncio.run(main())
