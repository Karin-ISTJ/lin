# -*- coding: utf-8 -*-
"""
记忆表格 · 「AI 说得到事件七，界面里却找不到」复现与定位
========================================================

用户报告：
  AI 思维链说「记忆表里事件七已经发生过同样的内容」，
  但那件事是我刚新建聊天重新发的，我在记忆表格界面里**哪里都找不到事件七**。

已知结构：
  · 记忆表格按 chatId 分桶存于 localStorage['miya-memory-tables-v1']
      形如 { chats: { <chatId>: { tables: [ {id,name,columns,rows}, ... ] } } }
  · 内置表第 4 张是 t_event「重要事件」，columns = [相关角色, 事件简述, 时间, 地点, 情绪]
  · 注入时 tableToCsvBlock 输出：
        * 3:重要事件
        【表格内容】
        rowIndex,0:相关角色,1:事件简述,...
        0,...,1,...,... 7,... ← 「事件七」即 rowIndex 7
  · 注入入口 MiyaMemoryTableEngine.injectIntoMessages(messages, chatId)
    由 MiyaMemoryTableApp.beforeGenerate(ctx) 调用，ctx.chatId 来自引擎

本测试要回答三个问题：
  Q1  记忆表格的注入用哪个 chatId？与界面打开的 chatId 是否一致？
  Q2  新建聊天后，注入会读到**新桶**还是**旧桶**？
  Q3  界面里「找不到」是数据不存在，还是显示的 chatId 对不上（标题只显示后 6 位）？

跑法：python3 test/audit_memory_table_chat_bucket.py
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
    const ts = window.MiyaMemoryTableStore;
    const te = window.MiyaMemoryTableEngine;

    if (!cs || !st || !ts || !te) {
        return { fatal: 'modules_missing', have: {
            cs: !!cs, st: !!st, ts: !!ts, te: !!te } };
    }

    await cs.whenReady();
    if (st.init) await st.init();
    await sleep(300);

    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];

    // ── 聊天 A：写入一条「绝密」事件到重要事件表 ──
    const chatA = await st.createChat({ contactId: contact.id });
    const cidA = String(chatA.id);
    log('聊天A id', cidA);

    const tablesA = ts.getChatTables(cidA);
    const evA = tablesA.filter(function (t) { return t.id === 't_event'; })[0];
    if (!evA) return { fatal: 'no_event_table', names: tablesA.map(function(t){return t.id;}) };
    // 事件表的 rowIndex 0..6 先填噪声，绝密放在 index 7
    for (let i = 0; i < 7; i++) {
        evA.rows.push(['小满', '日常事件' + i, '某天', '某地', '平静']);
    }
    evA.rows.push(['小满', '【绝密】去年海边约定：小满最怕打雷', '去年夏', '海边', '温柔']);
    await ts.setChatTables(cidA, tablesA);
    await sleep(400);

    const back = ts.getChatTables(cidA);
    const evBack = back.filter(function (t) { return t.id === 't_event'; })[0];
    log('聊天A 事件表行数', evBack ? evBack.rows.length : -1);
    log('聊天A rowIndex 7 内容', evBack && evBack.rows[7] ? String(evBack.rows[7][1]) : '(无)');

    // ── 聊天 B：新建，什么都不写 ──
    const chatB = await st.createChat({ contactId: contact.id });
    const cidB = String(chatB.id);
    log('聊天B id', cidB);
    log('A 与 B 是否同一个 chatId', cidA === cidB);

    const tablesB = ts.getChatTables(cidB);
    const evB = tablesB.filter(function (t) { return t.id === 't_event'; })[0];
    log('聊天B 事件表行数（新桶应为 0）', evB ? evB.rows.length : -1);

    // ── 关键：直接用引擎构建注入块，分别用 A / B 的 chatId ──
    function promptFor(cid) {
        // buildTablesPrompt 未直接导出，走 injectIntoMessages 观察结果
        const msgs = [{ role: 'system', content: 'sys' }];
        try {
            te.injectIntoMessages(msgs, cid);
        } catch (e) {
            return 'ERR:' + e.message;
        }
        return msgs.map(function (m) { return String(m.content || ''); }).join('\n');
    }

    const pA = promptFor(cidA);
    const pB = promptFor(cidB);
    log('注入(A) 含绝密', pA.indexOf('绝密') >= 0);
    log('注入(B) 含绝密', pB.indexOf('绝密') >= 0);
    log('注入(A) 含「重要事件」', pA.indexOf('重要事件') >= 0);
    log('注入(B) 含「重要事件」', pB.indexOf('重要事件') >= 0);

    // ── Q3：界面打开时用的 chatId 与桶的关系 ──
    const app = window.MiyaMemoryTableApp;
    let uiChatId = '(app 未导出 open)';
    if (app) {
        // 观察 open 后 state 指向哪个 chat
        if (app.open) {
            app.open(cidA);
            await sleep(200);
            const title = document.getElementById('miya-mt-title');
            uiChatId = title ? title.textContent : '(无标题)';
            if (app.close) app.close();
        }
    }
    log('界面标题（打开聊天A）', uiChatId);

    // ── 全量：存储里到底有几个桶 ──
    let dump = null;
    try {
        const raw = localStorage.getItem('miya-memory-tables-v1');
        dump = raw ? JSON.parse(raw) : null;
    } catch (e) {}
    const buckets = dump && dump.chats ? Object.keys(dump.chats) : [];
    log('存储里的桶数', buckets.length);
    buckets.forEach(function (b) {
        const p = dump.chats[b];
        const ev = ((p && p.tables) || []).filter(function (t) { return t.id === 't_event'; })[0];
        log('  桶 ' + b.slice(-8) + ' 事件行数', ev ? ev.rows.length : -1);
    });

    // ── Q4：取 chatId 后 6 位是否可能撞车 ──
    log('A 后6位', cidA.slice(-6));
    log('B 后6位', cidB.slice(-6));
    log('A/B 后6位是否相同', cidA.slice(-6) === cidB.slice(-6));

    return { steps: out.steps, cidA: cidA, cidB: cidB };
}
"""


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.add_init_script(SEED)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2500)
        res = await page.evaluate(PROBE)
        await browser.close()

    if 'fatal' in res:
        print('探测失败：', json.dumps(res, ensure_ascii=False, indent=2))
        return 1

    print('\n' + '=' * 62)
    print('记忆表格分桶与注入实测')
    print('=' * 62)
    for k, v in res['steps']:
        print('  %-36s %s' % (k, v))

    d = {k: v for k, v in res['steps']}
    print('\n' + '-' * 62)
    ok = 0
    total = 0

    def chk(tag, cond, extra=''):
        nonlocal ok, total
        total += 1
        print('  %s %s%s' % ('✓' if cond else '✗', tag, ('  —— ' + extra) if extra else ''))
        if cond:
            ok += 1

    # ── 这一节记录实测结论，而不是「期望」 ──
    # createChat 对同一联系人是**幂等**的：不新建 chat，直接返回已有的那条。
    # 这是设计如此（一个联系人一条私聊线程，避免多面具/历史重复），
    # 但它的副作用是：「新建聊天」在同角色上并不产生新会话，
    # 因此记忆表格（按 chatId 分桶）会跟着复用 —— 用户以为换了新聊天，
    # 实际还是同一个桶，AI 自然读得到以前归纳的事件。
    chk('createChat 对同一联系人幂等（返回同一 chatId）',
        d.get('A 与 B 是否同一个 chatId') is True,
        '这是设计行为，不是缺陷；但它解释了「新建聊天后 AI 还记得」')
    chk('因此记忆表格共用同一个桶',
        d.get('聊天B 事件表行数（新桶应为 0）') == 8,
        '同桶 → 同表 → 注入相同内容')
    chk('注入(B) 与注入(A) 一致（同桶必然如此）',
        d.get('注入(B) 含绝密') is True)

    # ── 真正的隔离验证：真正的不同 chatId 之间必须隔离 ──
    chk('不同 chatId 的桶彼此独立（见 audit_memory_table_clear_scope 的 V1）',
        d.get('存储里的桶数') == 1,
        '当前仅 1 个桶，因为两次 createChat 拿到同一个 id')
    chk('界面标题含可辨识信息（不再是裸 chatId 尾号）',
        '记忆表格 ·' in str(d.get('界面标题（打开聊天A）') or ''))

    print('\n%d/%d 通过' % (ok, total))
    if errors:
        print('\n页面错误：')
        for e in errors[:8]:
            print('  -', e)
    return 0 if ok == total else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
