# -*- coding: utf-8 -*-
"""
记忆表 · 「删楼层回收记忆」真实浏览器端到端验证
================================================

对应缺陷（用户原话）：
  「线下ai生成新的楼层 更新了记忆表，如果我把这一层删了，
    记忆表对应的内容不会跟着一起被删」

本测试在真实浏览器里跑**用户实际路径**（不调内部函数）：

  E1  AI 生成一层（写回复 + 落库记忆表行 + 建立溯源）
  E2  store.deleteMessages 删除这一层（= 用户多选删除）
  E3  该层写入的记忆表行被回收，**其他层的行完好**

并用**反向对照**确认：不删楼层时，行必须还在（防止「一律清空」的假修复）。

跑法：python3 test/e2e_memory_table_floor_delete.py
"""
import asyncio
import json
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent

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

    // 建角色 + 会话（沿用既有测试的 API 组合）
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    if (!contact) return { fatal: 'no_contact' };
    const chat = await st.createChat({ contactId: contact.id });
    if (!chat) return { fatal: 'no_chat' };
    const chatId = String(chat.id);
    log('chatId', chatId);

    /* 表序号按 id 查，避免依赖默认顺序（第 4 张 = t_event 重要事件） */
    let eventIdx = 3;
    (ts.getChatTables(chatId) || []).forEach(function (t, i) {
        if (t && t.id === 't_event') eventIdx = i;
    });
    log('eventIdx', eventIdx);

    // ── 第一轮：模拟 AI 生成，并落库两条消息（user + assistant）──
    const u1 = await st.addMessage(chatId, { role: 'user', content: '我们约好周末去看海' });
    const a1 = await st.addMessage(chatId, { role: 'assistant', content: '好呀，我记住了。' });
    log('a1.id', a1 && a1.id);

    // 引擎处理 AI 回复：真实路径（afterGenerate 就是这么调的）
    te.processAssistantReply(
        chatId,
        `好呀，我记住了。\n<tableEdit><!-- insertRow(${eventIdx}, {0:"小满",1:"约定周末看海",2:"周末",3:"海边",4:"期待"}) --></tableEdit>`,
        { sourceMsgIds: [String(a1.id)] }
    );

    let tables = ts.getChatTables(chatId);
    log('第一轮后事件行数', tables[eventIdx].rows.length);
    log('第一轮后事件内容', tables[eventIdx].rows.map(r => r[1]));

    // ── 第二轮：再来一层，写第二条记忆 ──
    const u2 = await st.addMessage(chatId, { role: 'user', content: '对了，生日是 3 月 12 日' });
    const a2 = await st.addMessage(chatId, { role: 'assistant', content: '我记下了。' });
    te.processAssistantReply(
        chatId,
        `我记下了。\n<tableEdit><!-- insertRow(${eventIdx}, {0:"小满",1:"生日3月12日",2:"-",3:"-",4:"重要"}) --></tableEdit>`,
        { sourceMsgIds: [String(a2.id)] }
    );

    tables = ts.getChatTables(chatId);
    log('第二轮后事件行数', tables[eventIdx].rows.length);
    // V0 对照：不删任何东西时，两条都在
    const beforeDelete = tables[eventIdx].rows.map(r => r[1]);
    log('V0 不删时的内容', beforeDelete);

    // ── 删除第一轮那一层（用户多选删除）──
    await st.deleteMessages(chatId, [String(a1.id)]);
    await sleep(400);

    tables = ts.getChatTables(chatId);
    const afterDelete = tables[eventIdx].rows.map(r => r[1]);
    log('删除第一轮后内容', afterDelete);

    // ── 再删第二轮那一层 ──
    await st.deleteMessages(chatId, [String(a2.id)]);
    await sleep(400);
    tables = ts.getChatTables(chatId);
    log('删除两轮后内容', tables[eventIdx].rows.map(r => r[1]));

    // ── 附加：确认表结构还在（没被 dropChat 掉）──
    log('表结构仍在', Array.isArray(tables) && tables.length > 0);
    log('表数量', tables.length);

    return out;
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
        print(json.dumps(res.get('have', {}), ensure_ascii=False))
        return 1

    steps = res['steps']
    print('── 执行轨迹 ──')
    for k, v in steps:
        print('  %-22s %s' % (k, json.dumps(v, ensure_ascii=False)))

    d = {k: v for k, v in steps}
    checks = []

    def check(name, cond, detail=''):
        checks.append((name, bool(cond), detail))

    before = d.get('V0 不删时的内容', [])
    after1 = d.get('删除第一轮后内容', [])
    after2 = d.get('删除两轮后内容', [])

    check('V0 反向对照：不删时两行都在（防「一律清空」假修复）',
          len(before) == 2 and '约定周末看海' in before and '生日3月12日' in before,
          json.dumps(before, ensure_ascii=False))
    check('E3 删第一层 → 该层记忆被回收',
          '约定周末看海' not in after1,
          json.dumps(after1, ensure_ascii=False))
    check('E3 删第一层 → **另一层记忆完好保留**（不误伤）',
          '生日3月12日' in after1,
          json.dumps(after1, ensure_ascii=False))
    check('E3 删第一层后行数 = 1', len(after1) == 1, str(len(after1)))
    check('E3 删第二层后行数 = 0', len(after2) == 0,
          json.dumps(after2, ensure_ascii=False))
    # ── 表结构仍在 ────────────────────────────────────────────
    #
    # 这里**不能**写死一个数字。早先写的是 `== 5`，而 defaultTables()
    # 早已是**六张**表（时空/角色特征/社交关系/任务/事件/物品），
    # 于是这条断言长期处于假失败状态 —— 它测的不是「结构有没有被删掉」，
    # 而是「表的数量还是不是当年那个数」，后者一改表就要重新对数字，
    # 既误报又遮蔽真问题。
    #
    # 改成：期望数量从源码里的 defaultTables() 现场数出来，
    # 这样加表/删表都不会误报，而「被 dropChat 清空」仍然抓得住。
    store_src = (ROOT / 'js2' / 'miya-memory-table-store.js').read_text(encoding='utf-8')
    m = re.search(r'function defaultTables\(\)\s*\{(.*?)\n  \}', store_src, re.S)
    expected_tables = len(re.findall(r"id:\s*'t_", m.group(1))) if m else None

    check('默认表数量可从源码推出（守卫有效性）',
          expected_tables is not None and expected_tables > 0,
          'expected=%s' % expected_tables)
    check('表结构未被破坏（resetChat/dropChat 语义区分）',
          d.get('表结构仍在') is True and d.get('表数量') == expected_tables,
          'tables=%s expected=%s' % (d.get('表数量'), expected_tables))

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

    # 页面报错不算通过
    if errors:
        return 1
    return 0 if passed == len(checks) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
