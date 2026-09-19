# -*- coding: utf-8 -*-
"""
记忆表格 · 「事件七找不到」三项修复验证
========================================

用户报告（原话）：
  「ai思维链说的记忆表 说事件七里已经发生过我刚才新建聊天重新发的一模一样
    的内容了 但是我哪里找都找不到它说的事件七」

定位结论（本测试要钉死的）：
  AI 说的「事件七」= 记忆表格「重要事件」表 rowIndex 7 那一行。
  用户找不到，是因为 **记忆表格与聊天记录是两套独立存储**，
  而「清空聊天记录」只清后者，前者原封不动：

    clearChatMessages 清理范围
      ✅ messagesByChat[chatId]        聊天消息
      ✅ summaryList / megaSummaryList / charMemoryList  记忆索引
      ❌ miya-memory-tables-v1         记忆表格  ← 漏的
      ❌ miya-appointment-v1           线下卷宗  ← 漏的

  于是：清空记录 → 重发同样的话 → AI 从记忆表里读到「事件七」
        → 用户去聊天记录里翻，当然找不到。

本测试覆盖三项修复：
  V1  clearChatMessages 现在会清空记忆表格（表还在，行清空）
  V2  deleteChat 会整桶删掉记忆表格（不留孤儿桶，避免 chatId 复用时复活）
  V3  removeContact 会清掉该角色名下所有 chat 的记忆表格桶（含群聊成员身份）
  V4  记忆表界面标题显示联系人名而非 chatId 尾号（可辨识性）

跑法：python3 test/audit_memory_table_clear_scope.py
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
    const app = window.MiyaMemoryTableApp;

    if (!cs || !st || !ts) {
        return { fatal: 'modules_missing', have: {
            cs: !!cs, st: !!st, ts: !!ts, app: !!app } };
    }

    await cs.whenReady();
    if (st.init) await st.init();
    await sleep(300);

    /* 造一个角色 + 聊天 + 一条「事件七」 */
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    const chat = await st.createChat({ contactId: contact.id });
    const cid = String(chat.id);

    async function seedEventRow(chatId, text) {
        const tables = ts.getChatTables(chatId);
        const ev = tables.filter(function (t) { return t.id === 't_event'; })[0];
        if (!ev) return -1;
        ev.rows.push(['小满', text, '去年夏', '海边', '温柔']);
        await ts.setChatTables(chatId, tables);
        return ev.rows.length;
    }
    function eventRowCount(chatId) {
        const tables = ts.getChatTables(chatId);
        const ev = tables.filter(function (t) { return t.id === 't_event'; })[0];
        return ev ? ev.rows.length : -1;
    }
    function bucketExists(chatId) {
        try {
            const raw = localStorage.getItem('miya-memory-tables-v1');
            const d = raw ? JSON.parse(raw) : null;
            return !!(d && d.chats && Object.prototype.hasOwnProperty.call(d.chats, chatId));
        } catch (e) { return null; }
    }

    // ── V1：clearChatMessages 应清空记忆表格 ──
    log('V1 播种后事件行数', await seedEventRow(cid, '【绝密】去年海边约定'));
    log('V1 清空前桶存在', bucketExists(cid));
    await st.clearChatMessages(cid);
    await sleep(500);
    log('V1 清空后事件行数', eventRowCount(cid));
    log('V1 清空后桶仍存在（表结构保留）', bucketExists(cid));

    // ── V2：deleteChat 应整桶删除 ──
    await seedEventRow(cid, '【绝密】测试删除聊天');
    log('V2 播种后事件行数', eventRowCount(cid));
    await st.deleteChat(cid);
    await sleep(500);
    log('V2 删除后桶是否还在', bucketExists(cid));

    // ── V3：removeContact 应清该角色名下所有桶 ──
    const chat2 = await st.createChat({ contactId: contact.id });
    const cid2 = String(chat2.id);
    await seedEventRow(cid2, '【绝密】测试删除联系人');
    log('V3 播种后事件行数', eventRowCount(cid2));
    const before = Object.keys((JSON.parse(localStorage.getItem('miya-memory-tables-v1') || '{}').chats) || {});
    log('V3 删除联系人前的桶数', before.length);
    await st.removeContact(contact.id);
    await sleep(900);
    let after = [];
    try {
        after = Object.keys((JSON.parse(localStorage.getItem('miya-memory-tables-v1') || '{}').chats) || {});
    } catch (e) {}
    log('V3 删除联系人后的桶数', after.length);
    log('V3 该聊天的桶是否已清', bucketExists(cid2) === false);

    // ── V4：标题可辨识性 ──
    // 重建一个角色，看界面标题是否含名字
    cs.upsertCharacter({ name: '阿澈', groupId: 'ct_default', persona: '冷静' });
    const chr2 = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr2.id, characterId: chr2.id, name: '阿澈' });
    await sleep(400);
    const contact2 = (st.getContacts() || [])[0];
    const chat3 = await st.createChat({ contactId: contact2.id });
    const cid3 = String(chat3.id);
    if (app && app.open) {
        app.open(cid3);
        await sleep(400);
        const t = document.getElementById('miya-mt-title');
        const scope = document.getElementById('miya-mt-scope');
        log('V4 界面标题', t ? t.textContent : '(无)');
        log('V4 作用域提示', scope ? String(scope.textContent || '').slice(0, 60) : '(无)');
        if (app.close) app.close();
    } else {
        log('V4 界面标题', '(app 未导出 open)');
        log('V4 作用域提示', '(无)');
    }

    return { steps: out.steps };
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

    print('\n' + '=' * 66)
    print('记忆表格清空范围 · 修复验证')
    print('=' * 66)
    for k, v in res['steps']:
        print('  %-34s %s' % (k, v))

    d = {k: v for k, v in res['steps']}
    print('\n' + '-' * 66)
    ok = 0
    total = 0

    def chk(tag, cond, extra=''):
        nonlocal ok, total
        total += 1
        print('  %s %s%s' % ('✓' if cond else '✗', tag, ('  —— ' + extra) if extra else ''))
        if cond:
            ok += 1

    chk('V1 播种成功（事件表原有 1 行）', d.get('V1 播种后事件行数') == 1)
    chk('V1 清空前桶存在', d.get('V1 清空前桶存在') is True)
    chk('V1 清空聊天记录后，记忆表格行已清空',
        d.get('V1 清空后事件行数') == 0,
        '这是用户找不到事件七的直接原因，修复后应归零')
    chk('V1 表结构仍保留（resetChat 而非 dropChat）',
        d.get('V1 清空后桶仍存在（表结构保留）') is True)

    chk('V2 播种成功', d.get('V2 播种后事件行数') == 1)
    chk('V2 删除聊天后整桶消失（不留孤儿桶）',
        d.get('V2 删除后桶是否还在') is False)

    chk('V3 播种成功', d.get('V3 播种后事件行数') == 1)
    chk('V3 删除联系人前有桶', isinstance(d.get('V3 删除联系人前的桶数'), int)
        and d.get('V3 删除联系人前的桶数') >= 1)
    chk('V3 删除联系人后该聊天的桶已清',
        d.get('V3 该聊天的桶是否已清') is True,
        '桶数 %s → %s' % (d.get('V3 删除联系人前的桶数'), d.get('V3 删除联系人后的桶数')))

    title = str(d.get('V4 界面标题') or '')
    chk('V4 标题含联系人名（不再只有 chatId 尾号）',
        '阿澈' in title,
        title)
    chk('V4 作用域提示已渲染（说明表属于哪个聊天）',
        '只属于' in str(d.get('V4 作用域提示') or ''))

    print('\n%d/%d 通过' % (ok, total))
    if errors:
        print('\n页面错误：')
        for e in errors[:8]:
            print('  -', e)
    return 0 if ok == total else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
