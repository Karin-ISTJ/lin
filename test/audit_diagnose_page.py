# -*- coding: utf-8 -*-
"""
诊断页自检：造一份「已删卷宗 + 残留镜像」的真实数据，再打开 diagnose-memory-leak.html，
确认它能把这批数据报出来。若这里报 0，说明诊断页本身有 bug，不能拿给用户。

跑法：python3 test/audit_diagnose_page.py
"""
import asyncio
import sys

from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
DIAG = 'http://127.0.0.1:8099/diagnose-memory-leak.html'

SEED = r"""
window.__miyaSeedApplied = false;
try {
  if (!localStorage.getItem('__seeded')) {
    localStorage.clear();
    localStorage.setItem('__seeded', '1');
  }
} catch(e) {}
"""

SETUP = r"""
async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const SECRET = '【绝密】去年海边约定：小满最怕打雷。';
    const cs = window.miyaContactsStore;
    const st = window.miyaChatStore;
    const aps = window.MiyaAppointmentStore;
    await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch(e){} }
    await sleep(300);
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    const chat = await st.createChat({ contactId: contact.id });
    const chatId = String(chat.id);
    const sess = aps.startNewSession(chatId, contact.id);
    aps.addMessage(chatId, sess.id, { role: 'user', content: SECRET });
    await sleep(600);
    if (aps.syncAllSessionsToChat) { try { aps.syncAllSessionsToChat(chatId, contact.id); } catch(e){} }
    await sleep(600);
    /* 不删卷宗：先让诊断页在「未删」状态下跑一次，应当报有存活镜像 */
    return { chatId: chatId, sessId: String(sess.id) };
}
"""


async def run_once(page, url, label):
    await page.goto(url, wait_until='domcontentloaded')
    await page.wait_for_timeout(2200)
    if 'diagnose' in url:
        await page.click('#go')
        await page.wait_for_timeout(3000)
        txt = await page.input_value('#out')
    else:
        txt = ''
    return txt


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        ctx.add_init_script(SEED)  # 仅在首次（无 __seeded 标记）清库
        page = await ctx.new_page()

        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2500)
        ids = await page.evaluate(SETUP)
        print('造数据完成：', ids)

        # 第一次：卷宗还在，诊断页应能读到线程与镜像
        txt1 = await run_once(page, DIAG, '未删')
        n1 = txt1.count('已扫描聊天线程数:')
        threads = None
        for line in txt1.splitlines():
            if '已扫描聊天线程数:' in line:
                threads = line.split(':')[-1].strip()

        # 回 index 删掉卷宗
        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2500)
        await page.evaluate(
            """(ids) => { const a = window.MiyaAppointmentStore; a.deleteSession(ids.chatId, ids.sessId); }""",
            ids)
        await page.wait_for_timeout(1200)

        txt2 = await run_once(page, DIAG, '已删')

        await browser.close()

    print('\n' + '=' * 62)
    print('诊断页自检')
    print('=' * 62)

    ok = 0
    total = 0

    def chk(tag, cond, extra=''):
        nonlocal ok, total
        total += 1
        print('  %s %s%s' % ('✓' if cond else '✗', tag, ('  —— ' + extra) if extra else ''))
        if cond:
            ok += 1

    chk('诊断页能读出聊天线程数（>0，非假阴性）',
        threads is not None and threads.isdigit() and int(threads) > 0,
        'threads=%s' % threads)
    chk('未删状态下诊断页报出「存活镜像」', '找到' in txt1 and '存活的线下镜像' in txt1)
    chk('已删状态下诊断页能看到墓碑',
        '墓碑（已删 id）数: 1' in txt2 or '墓碑总数: 1' in txt2)

    print('\n【未删】输出摘录')
    print('-' * 62)
    for line in txt1.splitlines():
        if any(k in line for k in ['已扫描聊天线程数', 'offlineMeet 镜像', '找到', '没有存活']):
            print('   ', line.strip())

    print('\n【已删】输出摘录')
    print('-' * 62)
    for line in txt2.splitlines():
        if any(k in line for k in ['已扫描聊天线程数', '墓碑', 'offlineMeet 镜像', '找到', '没有存活', '没有「已删']):
            print('   ', line.strip())

    print('\n%d/%d 通过' % (ok, total))
    return 0 if ok == total else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
