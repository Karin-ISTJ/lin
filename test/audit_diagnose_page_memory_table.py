# -*- coding: utf-8 -*-
"""
诊断页自检（记忆表格章节）
--------------------------
造一份「重要事件表里存在事件七」的数据，打开诊断页，
确认它能把这行连编号一起报出来 —— 用户就是靠这个输出确认残留位置的。

跑法：python3 test/audit_diagnose_page_memory_table.py
"""
import asyncio
import sys

from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
DIAG = 'http://127.0.0.1:8099/diagnose-memory-leak.html'
# 只在首次进入时清库。否则导航到诊断页时 add_init_script 会再次执行，
# 把刚造好的数据清掉，诊断页自然报「桶总数 0」（假阴性）。
SEED = r"""
try {
  if (!sessionStorage.getItem('__diag_seeded')) {
    localStorage.clear();
    sessionStorage.setItem('__diag_seeded', '1');
  }
} catch(e) {}
"""

SETUP = r"""
async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cs = window.miyaContactsStore;
    const st = window.miyaChatStore;
    const ts = window.MiyaMemoryTableStore;
    await cs.whenReady();
    if (st.init) await st.init();
    await sleep(300);
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    const chat = await st.createChat({ contactId: contact.id });
    const cid = String(chat.id);
    const tables = ts.getChatTables(cid);
    const ev = tables.filter(function (t) { return t.id === 't_event'; })[0];
    for (let i = 0; i < 7; i++) {
        ev.rows.push(['小满', '日常事件' + i, '某天', '某地', '平静']);
    }
    ev.rows.push(['小满', '【绝密】去年海边约定：小满最怕打雷', '去年夏', '海边', '温柔']);
    await ts.setChatTables(cid, tables);
    await sleep(400);
    return { cid: cid, rows: ev.rows.length };
}
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.add_init_script(SEED)
        page = await ctx.new_page()
        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2500)
        seeded = await page.evaluate(SETUP)
        print('造数据：', seeded)

        await page.goto(DIAG, wait_until='domcontentloaded')
        await page.wait_for_timeout(2200)
        await page.click('#go')
        await page.wait_for_timeout(3200)
        txt = await page.input_value('#out')
        await browser.close()

    print('\n' + '=' * 62)
    print('诊断页 · 记忆表格章节自检')
    print('=' * 62)

    lines = [l.strip() for l in txt.splitlines() if l.strip()]
    print('【输出摘录】')
    for l in lines:
        if any(k in l for k in ['【6】', '记忆表格', '桶（聊天）总数', '有内容的桶',
                                'rowIndex', '重要事件表', '事件']):
            print('   ', l)

    ok = 0
    total = 0

    def chk(tag, cond, extra=''):
        nonlocal ok, total
        total += 1
        print('  %s %s%s' % ('✓' if cond else '✗', tag, ('  —— ' + extra) if extra else ''))
        if cond:
            ok += 1

    print('\n' + '-' * 62)
    chk('诊断页出现【6】记忆表格章节', '【6】记忆表格' in txt)
    chk('能读到桶总数 ≥ 1', '桶（聊天）总数: 1' in txt)
    chk('报出「有内容的桶」≥ 1', '其中有内容的桶: 1' in txt)
    chk('列出重要的逐行内容（含 rowIndex）', 'rowIndex' in txt)
    chk('明确标注「事件七」这一行的编号', '事件七' in txt)
    chk('能看到那行绝密内容', '绝密' in txt)

    print('\n%d/%d 通过' % (ok, total))
    return 0 if ok == total else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
