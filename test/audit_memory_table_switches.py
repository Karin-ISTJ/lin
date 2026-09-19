# -*- coding: utf-8 -*-
"""
记忆表格四个开关的精确语义验证
-------------------------------
开关定义（js2/miya-memory-table-store.js defaultSettings）：
    enabled           总开关
    isAiRead          AI 读取
    isAiWrite         AI 写入
    detailedWriteRules 详细写入规则

代码里四处判定：
    js2/miya-memory-table-engine.js:93   buildTablesPrompt      enabled===false || isAiRead===false  → 返回 ''
    js2/miya-memory-table-engine.js:111  buildTablesPrompt      isAiWrite!==false            → 追加写入规则
    js2/miya-memory-table-engine.js:739  processAssistantReply  enabled===false || isAiWrite===false → 剥标签不落库
    js2/miya-memory-table-engine.js:765  injectIntoMessages     enabled===false || isAiRead===false  → 不注入

本测试要确认的关键点：
  ① isAiRead=false  → 表格内容完全不进 API 上下文
  ② isAiRead=true   → 表格内容进上下文
  ③ isAiWrite=false → 仍然**读取**（只去掉写入规则），这是独立开关
  ④ isAiWrite=false → 模型写的 <tableEdit> 被剥离且不落库
  ⑤ enabled=false   → 读写全停

跑法：python3 test/audit_memory_table_switches.py
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

    if (!cs || !st || !ts || !te) return { fatal: 'modules_missing' };

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

    /* 写入一行显眼内容 */
    const tables = ts.getChatTables(cid);
    const ev = tables.filter(function (t) { return t.id === 't_event'; })[0];
    ev.rows.push(['小满', '【标记】海边约定', '去年夏', '海边', '温柔']);
    await ts.setChatTables(cid, tables);
    await sleep(400);

    function injectText() {
        const msgs = [{ role: 'system', content: 'sys' }];
        te.injectIntoMessages(msgs, cid);
        return msgs.map(function (m) { return String(m.content || ''); }).join('\n');
    }

    /* 基线：全开 */
    ts.saveSettings(Object.assign({}, ts.defaultSettings()));
    await sleep(150);
    const base = injectText();
    log('全开 注入含表格标记', base.indexOf('标记') >= 0);
    log('全开 注入含「重要事件」', base.indexOf('重要事件') >= 0);
    log('全开 注入含写入规则(tableEdit)', base.indexOf('tableEdit') >= 0);

    /* ① isAiRead = false */
    const s1 = ts.defaultSettings(); s1.isAiRead = false;
    ts.saveSettings(s1); await sleep(150);
    const t1 = injectText();
    log('关读取 注入含表格标记', t1.indexOf('标记') >= 0);
    log('关读取 注入含「重要事件」', t1.indexOf('重要事件') >= 0);
    log('关读取 注入块是否为空', t1 === 'sys');

    /* ③ isAiWrite = false（读取仍开） */
    const s2 = ts.defaultSettings(); s2.isAiWrite = false;
    ts.saveSettings(s2); await sleep(150);
    const t2 = injectText();
    log('关写入 注入含表格标记', t2.indexOf('标记') >= 0);
    log('关写入 注入含写入规则(tableEdit)', t2.indexOf('tableEdit') >= 0);

    /* ④ 关写入时，模型回复里的 tableEdit 应被剥离且不落库 */
    ts.saveSettings(s2); await sleep(120);
    const before = (function () {
        const t = ts.getChatTables(cid).filter(function (x) { return x.id === 't_char'; })[0];
        return t ? t.rows.length : -1;
    })();
    /*
     * 注意格式：写入规则规定的是**函数调用式**，不是 JSON 数组。
     *   insertRow(tableIndex, {0:"值",1:"值"})
     * 且必须包在 <!-- --> 里。tableIndex 从 0 开始，
     * 故 1 = t_char（0 是 t_time）。
     * 最初这里误用了 [{"op":...}] 的 JSON 写法，解析器不认，
     * 造成「关写入时标签被剥离」通过、而「开写入时落库」失败的假象。
     */
    const reply = '好的。\n<tableEdit><!-- insertRow(1, {0:"测试",1:"高",2:"开朗",3:"学生",4:"跑步",5:"城东",6:"无"}) --></tableEdit>';
    const r1 = te.processAssistantReply(cid, reply);
    await sleep(300);
    const after = (function () {
        const t = ts.getChatTables(cid).filter(function (x) { return x.id === 't_char'; })[0];
        return t ? t.rows.length : -1;
    })();
    log('关写入 回复里的标签被剥离', String(r1.text || '').indexOf('tableEdit') < 0);
    log('关写入 未落库（行数不变）', before === after);
    log('关写入 applied 标记', String(r1.applied));

    /* 反向对照：开写入时应落库 */
    const s3 = ts.defaultSettings(); s3.isAiWrite = true;
    ts.saveSettings(s3); await sleep(120);
    const before2 = (function () {
        const t = ts.getChatTables(cid).filter(function (x) { return x.id === 't_char'; })[0];
        return t ? t.rows.length : -1;
    })();
    const r2 = te.processAssistantReply(cid, reply);
    await sleep(300);
    const after2 = (function () {
        const t = ts.getChatTables(cid).filter(function (x) { return x.id === 't_char'; })[0];
        return t ? t.rows.length : -1;
    })();
    log('开写入 已落库（行数 +1）', after2 === before2 + 1);

    /* ⑤ enabled = false */
    const s4 = ts.defaultSettings(); s4.enabled = false;
    ts.saveSettings(s4); await sleep(150);
    const t4 = injectText();
    log('总开关关 注入块是否为空', t4 === 'sys');
    const r3 = te.processAssistantReply(cid, 'x\n<tableEdit><!-- insertRow(1, {0:"a",1:"b",2:"c"}) --></tableEdit>');
    await sleep(200);
    const after3 = (function () {
        const t = ts.getChatTables(cid).filter(function (x) { return x.id === 't_char'; })[0];
        return t ? t.rows.length : -1;
    })();
    log('总开关关 未落库', after3 === after2);
    log('总开关关 applied 标记', String(r3.applied));

    /* 复原设置，避免影响后续 */
    ts.saveSettings(ts.defaultSettings());

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
        print('探测失败：', res)
        return 1

    print('\n' + '=' * 64)
    print('记忆表格开关语义实测')
    print('=' * 64)
    for k, v in res['steps']:
        print('  %-40s %s' % (k, v))

    d = {k: v for k, v in res['steps']}
    print('\n' + '-' * 64)
    ok = 0
    total = 0

    def chk(tag, cond, extra=''):
        nonlocal ok, total
        total += 1
        print('  %s %s%s' % ('✓' if cond else '✗', tag, ('  —— ' + extra) if extra else ''))
        if cond:
            ok += 1

    # 基线
    chk('全开：表格内容进上下文', d.get('全开 注入含表格标记') is True)
    chk('全开：含写入规则', d.get('全开 注入含写入规则(tableEdit)') is True)

    # isAiRead
    chk('关「AI 读取」→ 表格内容**完全不进**上下文',
        d.get('关读取 注入含表格标记') is False
        and d.get('关读取 注入块是否为空') is True)

    # isAiWrite 与读取独立
    chk('关「AI 写入」→ 表格内容**仍然进**上下文（两者独立）',
        d.get('关写入 注入含表格标记') is True,
        '这是最容易被误解的一点')
    chk('关「AI 写入」→ 注入里不再教写入规则',
        d.get('关写入 注入含写入规则(tableEdit)') is False)
    chk('关「AI 写入」→ 回复里的 <tableEdit> 被剥离',
        d.get('关写入 回复里的标签被剥离') is True)
    chk('关「AI 写入」→ 不落库',
        d.get('关写入 未落库（行数不变）') is True)
    chk('开「AI 写入」→ 正常落库（反向对照）',
        d.get('开写入 已落库（行数 +1）') is True)

    # enabled
    chk('关总开关 → 不注入', d.get('总开关关 注入块是否为空') is True)
    chk('关总开关 → 不落库', d.get('总开关关 未落库') is True)

    print('\n%d/%d 通过' % (ok, total))
    if errors:
        print('\n页面错误：')
        for e in errors[:6]:
            print('  -', e)
    return 0 if ok == total else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
