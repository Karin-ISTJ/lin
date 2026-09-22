# -*- coding: utf-8 -*-
"""
线下候选 · 记忆延迟写入 真实浏览器端到端验证
================================================

对应需求（用户原话）：
  「在当前多个候选楼层不记忆 等到用户在其中一个候选发消息 才记忆那个候选的记忆
    其他候选不用记忆」
  「发消息就确认」

背景（为什么线下候选会串味）：
  线下一条角色楼层可以有多个候选（右下角 ‹ › 翻看），它们**共用同一个消息 id**
  —— 引擎用 replaceTargetId: m.id 把新一版写回**同一层**，id 不变。
  记忆表的行溯源 rowSource 值就是 messageId，无法区分候选，于是：
    · 生成候选 B 时会把 A 的记忆一并回收（A 凭空消失）
    · 翻回 A 再发消息，界面是 A，记忆表却停在 B（串味）

修复后的行为（本测试逐条验证）：
  T1  首版生成（末尾、无候选）           → 记忆写入
  T2  › 生成候选 B（末尾、已有候选）      → **不写**（延迟生效）
  T3  在候选 B 下发消息（确认 B）         → B 的记忆补写
  T4  只是翻看候选 A，不做确认            → **不写** A
  T5  在候选 A 下发消息（确认 A）         → A 的记忆补写
  T6  反向对照：不翻候选、正常往下推进    → 记忆照常写入（防「一律不写」假修复）
  T7  历史楼层（非末尾）重生成            → 记忆照常写入

跑法：
  先起服务： python3 -m http.server 8099 --bind 127.0.0.1
  再执行：   python3 test/e2e_swipe_memory_deferred.py
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
    const aps = window.MiyaAppointmentStore;
    const eng = window.MiyaAppointmentEngine;
    const mt = window.MiyaMemoryTableApp;

    if (!cs || !st || !ts || !aps || !eng || !mt) {
        return { fatal: 'modules_missing', have: {
            cs: !!cs, st: !!st, ts: !!ts, aps: !!aps, eng: !!eng, mt: !!mt } };
    }

    // ── 配好假 API（过 api_not_configured 闸门）──
    if (typeof window.miyaSetApiConfig === 'function') {
        window.miyaSetApiConfig({
            baseUrl: 'https://probe.invalid/v1',
            apiKey: 'probe-key',
            model: 'probe-model'
        });
    }
    const cfgNow = (window.miyaGetApiConfigCached && window.miyaGetApiConfigCached()) || {};
    log('G0 配置就绪', !!cfgNow.baseUrl && !!cfgNow.apiKey && !!cfgNow.model);

    /*
     * ── 网络层假 fetch ──
     *
     * 不打桩引擎内部，只在 fetch 这一层给回内容。
     * 这样引擎的流式解析、落库、候选归档、afterGenerate 延迟门、
     * processAssistantReply 全都跑**真实代码**，只有「模型说什么」是假的。
     *
     * 每次调用依次吐一条回复，正文里埋 A版/B版/V6/V7 标记，
     * 供断言语义溯源 —— 能验证「写进记忆表的到底是哪一版」。
     */
    /*
     * t_event 的序号**在假 fetch 里现场取**，不预先固化成常量。
     *
     * 早先是先算好 EIDX 再拼 REPLIES，结果页面里真实序号是 4、
     * 拼进去的却是缺省的 3 —— 记忆全落到了别的表，断言读 t_event 读空，
     * 报出来的是「记忆没写入」，掩盖了真正的错因（表序号错）。
     * 现场取就不会有这种偏差。
     */
    const eidxNow = () => {
        let idx = 3;
        (ts.getChatTables(chatId) || []).forEach(function (t, i) {
            if (t && t.id === 't_event') idx = i;
        });
        return idx;
    };
    const mkEdit = (mark) =>
        '\n<tableEdit><!-- insertRow(' + eidxNow() + ', {0:"小满",1:"' + mark +
        '",2:"-",3:"-",4:"补充"}) --></tableEdit>';

    const MARKS = [
        'A版·首版提到海边',
        'B版·候选提到看海',
        'V6·明天出发',
        'V7·历史层重生成'
    ];
    let fetchSeq = 0;
    const realFetch = window.fetch;
    window.fetch = function (url, opts) {
        const i = Math.min(fetchSeq, MARKS.length - 1);
        fetchSeq += 1;
        const body = '（第' + (i + 1) + '次生成）' + mkEdit(MARKS[i]);
        const chunk =
            'data: ' + JSON.stringify({ choices: [{ delta: { content: body } }] }) + '\n\n' +
            'data: [DONE]\n\n';
        const stream = {
            getReader() {
                let done = false;
                const enc = new TextEncoder();
                return {
                    read() {
                        if (done) return Promise.resolve({ done: true, value: undefined });
                        done = true;
                        return Promise.resolve({ done: false, value: enc.encode(chunk) });
                    },
                    cancel() { return Promise.resolve(); }
                };
            }
        };
        return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: function () { return 'text/event-stream'; } },
            body: stream,
            text: function () { return Promise.resolve(chunk); },
            json: function () {
                return Promise.resolve({ choices: [{ message: { content: body } }] });
            }
        });
    };

    if (cs.whenReady) await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
    await sleep(300);

    // ── 建角色 + 会话 + 线下卷宗 ──
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔' });
    const chr = (cs.listCharacters() || [])[0];
    if (!chr) return { fatal: 'no_character' };
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    if (!contact) return { fatal: 'no_contact' };
    const chat = await st.createChat({ contactId: contact.id });
    if (!chat) return { fatal: 'no_chat' };
    const chatId = String(chat.id);
    const sess = aps.startNewSession(chatId, String(contact.id));
    if (!sess) return { fatal: 'no_session' };
    const sessionId = String(sess.id);
    log('chatId', chatId);
    log('sessionId', sessionId);

    /*
     * 把线下界面**真的打开**并停在这个会话上。
     *
     * 为什么要这一步：候选翻看（‹ ›）走的是 applyOfflineSwipe，
     * 而它开头就依赖 ui.chatId / ui.sessionId —— 不开界面时这两个是空串，
     * 函数直接 return，翻看静默不生效。早先 T4 里点了 ‹ 却纹丝不动
     * （swipeId 从 1 翻完还是 1），根因就在这里，而不是翻看逻辑有问题。
     *
     * 带上 cast 是为了让 openWithChat 直接用我们指定的 chatId，
     * 不去走「最后一个进入过的聊天」那条恢复路径。
     */
    if (window.miyaOfflineApp && window.miyaOfflineApp.open) {
        window.miyaOfflineApp.open({
            chatId: chatId,
            contactId: String(contact.id),
            cast: [{ contactId: String(contact.id), chatId: chatId }]
        });
        await sleep(600);
        const u = window.miyaOfflineApp.__testUi ? window.miyaOfflineApp.__testUi() : null;
        log('UI 已进入会话', !!(u && String(u.chatId) === chatId && String(u.sessionId) === sessionId));
        log('UI chatId', u && u.chatId);
        log('UI sessionId', u && u.sessionId);
    }

    // t_event 序号按 id 查，不靠默认顺序
    let eventIdx = 3;
    (ts.getChatTables(chatId) || []).forEach(function (t, i) {
        if (t && t.id === 't_event') eventIdx = i;
    });
    log('eventIdx', eventIdx);

    const rowsOf = () => {
        const tb = ts.getChatTables(chatId) || [];
        const t = tb[eventIdx];
        return (t && t.rows) ? t.rows.map(r => String(r[1] || '')) : [];
    };
    const liveMsgs = () => {
        try {
            const s = aps.getSession(chatId, sessionId);
            return (s && Array.isArray(s.messages)) ? s.messages.filter(m => m && !m.deleted) : [];
        } catch (e) { return []; }
    };
    const lastAsst = () => {
        const ms = liveMsgs();
        for (let i = ms.length - 1; i >= 0; i--) {
            if (ms[i].role === 'assistant' && String(ms[i].content || '').trim()) return ms[i];
        }
        return null;
    };
    const gen = (opts) => eng.regenerateAppointment(
        chatId, sessionId, { onStatus: function () {}, onDelta: function () {} }, opts);

    /* ══ T1 首版：末尾、无候选 → 记忆写入 ══
     *
     * ⚠️ **不手动建空占位楼层**。
     * aps.addMessage 有条铁律：内容为空直接返回 null（空楼层不许落库）。
     * 早先的写法先 addMessage({role:'assistant', content:''}) 建占位，
     * 拿到的是 null，后面 String(m0.id) 就炸在「读 null 的 id」上。
     * 正确做法是**只加 user 楼层**，让引擎自己找末尾并落库 ——
     * 这正是 regenerateAppointment 里 `if (!msg) msg = aps.addMessage(...)`
     * 那条分支在做的事，也是界面的真实路径。 */
    aps.addMessage(chatId, sessionId, { role: 'user', content: '我们周末去海边吧' });
    try {
        await gen({ keepRegenCandidate: false, attempt: 1 });
    } catch (e) { log('T1 生成异常', String((e && e.message) || e)); }
    await sleep(500);
    const t1a = lastAsst();
    log('T1 末层内容', String((t1a && t1a.content) || '').slice(0, 30));
    log('T1 候选数', ((t1a && t1a.swipes) || []).length);
    log('T1 记忆行', rowsOf());

    /* ══ T2 点 › 生成候选（末尾、已有候选）→ 不写 ══
     *
     * ⚠️ 这里必须走 **__testRegenFloor(m, true)** 这条界面路径，
     * 不能直接调 eng.regenerateAppointment：
     * › 键的语义是「先软删原版（顺带回收它写过的记忆）、再让引擎重答」，
     * 而 app 层的 regenerateAssistantFloor 才会做那一步软删。
     * 直接调引擎会绕过软删 —— 于是「原版变成候选后，它先前写的记忆
     * 应该被回收」这条就永远测不到，看着像「回收坏了」，
     * 其实是测试根本没触发那条链路。 */
    const before2 = rowsOf();
    const cur = lastAsst();
    log('T2 生成前候选数', ((cur && cur.swipes) || []).length);
    try {
        window.miyaOfflineApp.__testRegenFloor(cur, true);
    } catch (e) { log('T2 生成异常', String((e && e.message) || e)); }
    await sleep(900);
    const t2a = lastAsst();
    log('T2 候选数', ((t2a && t2a.swipes) || []).length);
    log('T2 末层内容', String((t2a && t2a.content) || '').slice(0, 30));
    log('T2 记忆行', rowsOf());
    log('T2 与生成前一致', JSON.stringify(rowsOf()) === JSON.stringify(before2));

    /* ══ T3 在候选 B 下发消息（确认 B）→ 补写 B ══ */
    const bF = lastAsst();
    log('T3 确认前内容', String((bF && bF.content) || '').slice(0, 30));
    log('T3 确认前 mtRaw', String((bF && bF.mtRaw) || '').slice(0, 40));
    let ok3 = null;
    try {
        ok3 = await mt.commitConfirmedFloor(chatId, String(bF.id), String(bF.content));
    } catch (e) { log('T3 补写异常', String((e && e.message) || e)); }
    await sleep(400);
    log('T3 补写返回', ok3);
    log('T3 记忆行', rowsOf());
    log('T3 记忆含 B', rowsOf().some(r => r.indexOf('B版') >= 0));

    /* ══ T4 翻回候选 A（走真实 ‹ 键路径）→ 不新增行，且标记切到 A 那一版 ══
     *
     * ⚠️ 这条断言的正确形态是「翻看不新增」，而不是「记忆里没有 A」。
     * A 版在第一轮（T1）作为唯一一版**已经正常写入过**了 —— 那时它还不是
     * 候选，没有理由延迟。所以「记忆里没有 A」是个前提就错的断言。
     *
     * 真正要验证的是两件事：
     *   · 翻看不碰记忆表（不新增行）；
     *   · 翻看会把「这一版待落库的标记」切过去 —— 否则翻回 A 再发消息，
     *     补写的会是 B 的记忆（串味换了个地方复现）。
     *
     * 走 __testApplySwipe 后门 = 用户点 ‹ 的那条真实代码路径
     * （applyOfflineSwipe），不是测试自己另写一份 updateMessage。 */
    const rowsBeforeT4 = rowsOf();
    const t4m = lastAsst();
    const sw4 = (t4m && t4m.swipes) || [];
    log('T4 翻看前 swipeId', t4m && t4m.swipeId);
    if (sw4.length >= 2) {
        window.miyaOfflineApp.__testApplySwipe(String(t4m.id), -1);
    }
    await sleep(300);
    const t4after = lastAsst();
    log('T4 翻看后 swipeId', t4after && t4after.swipeId);
    log('T4 当前显示内容', String((t4after && t4after.content) || '').slice(0, 30));
    log('T4 记忆行', rowsOf());
    log('T4 行数不变', JSON.stringify(rowsOf()) === JSON.stringify(rowsBeforeT4));
    log('T4 翻看后 mtRaw', String((t4after && t4after.mtRaw) || '').slice(0, 40));
    /* 翻到的是 A 那一版：正文是「第 1 次生成」，标记里写着 A 版 */
    log('T4 翻到的是 A 版', String((t4after && t4after.content) || '').indexOf('第1次生成') >= 0);
    log('T4 mtRaw 指向 A', String((t4after && t4after.mtRaw) || '').indexOf('A版') >= 0);

    /* ══ T5 在候选 A 下发消息（确认 A）→ 补写 A ══ */
    const aF = lastAsst();
    let ok5 = null;
    try {
        ok5 = await mt.commitConfirmedFloor(chatId, String(aF.id), String(aF.content));
    } catch (e) { log('T5 补写异常', String((e && e.message) || e)); }
    await sleep(400);
    log('T5 补写返回', ok5);
    log('T5 记忆行', rowsOf());
    log('T5 记忆含 A', rowsOf().some(r => r.indexOf('A版') >= 0));

    /* ══ T6 反向对照：不翻候选、正常往下推进 → 照常写 ══
     *
     * 关键：上一层的候选已被「钉住」（下面有 user 楼层），
     * 所以这一层生成时应**正常写记忆**，延迟门不该生效。
     *
     * ⚠️ 走 __testRegenFloor(userMsg, false) 而不是直连引擎：
     * 引擎的 replaceLastAssistant 语义是「找最后一条 assistant 重写」，
     * 它不看你中间插没插 user 楼层 —— 直接调引擎的结果是**把上一轮
     * 角色楼层覆盖掉**，而不是「接着往下新写一层」。
     * 界面上「我发一句 → 角色接一句」走的是 user 楼层那条分支
     * （regenerateAfterUserFloor），必须从这里进才是真实路径。 */
    const u6 = aps.addMessage(chatId, sessionId, { role: 'user', content: '那我们明天出发' });
    const before6 = rowsOf();
    const floorsBefore6 = liveMsgs().length;
    try {
        window.miyaOfflineApp.__testRegenFloor(u6, false);
    } catch (e) { log('T6 生成异常', String((e && e.message) || e)); }
    await sleep(900);
    log('T6 记忆行', rowsOf());
    log('T6 记忆有新增', rowsOf().length > before6.length);
    log('T6 楼层有新增', liveMsgs().length > floorsBefore6);

    /* ══ T7 历史楼层（非末尾）重生成 → 照常写 ══
     *
     * 先再推一轮，攒够「后面还有楼层」的历史层。
     *
     * ⚠️ 取「倒数第二个角色楼层」当历史层，而不是早先的 `i < length - 2`：
     * 后者在只有 2 个 assistant 楼层时一个都取不到（循环空转），
     * 表现是 T7 整段被跳过、看着像「通过」其实什么都没测。 */
    const u7 = aps.addMessage(chatId, sessionId, { role: 'user', content: '路上要不要带点什么' });
    try {
        window.miyaOfflineApp.__testRegenFloor(u7, false);
    } catch (e) { log('T7 铺垫生成异常', String((e && e.message) || e)); }
    await sleep(900);

    const ms7 = liveMsgs();
    const asstIdx7 = [];
    for (let i = 0; i < ms7.length; i++) {
        if (ms7[i].role === 'assistant' && String(ms7[i].content || '').trim()) asstIdx7.push(i);
    }
    let hist = null;
    if (asstIdx7.length >= 2) hist = ms7[asstIdx7[asstIdx7.length - 2]];
    log('T7 角色楼层数', asstIdx7.length);
    log('T7 找到历史楼层', !!hist);
    if (hist) {
        const before7 = rowsOf();
        try {
            await gen({ replaceTargetId: String(hist.id), keepRegenCandidate: false, attempt: 1 });
        } catch (e) { log('T7 生成异常', String((e && e.message) || e)); }
        await sleep(500);
        log('T7 记忆行', rowsOf());
        log('T7 记忆有新增', rowsOf().length > before7.length);
    }

    window.fetch = realFetch;
    log('表结构仍在', Array.isArray(ts.getChatTables(chatId)) && ts.getChatTables(chatId).length > 0);
    log('表数量', (ts.getChatTables(chatId) || []).length);
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

    if not res:
        print('❌ 页面无返回')
        return 1
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

    if not d.get('G0 配置就绪'):
        print('❌ 假 API 配置未生效，后续断言无意义')
        return 1

    check('T1 首版生成 → 写入记忆（末尾无候选，不该延迟）',
          any('A版' in r for r in d.get('T1 记忆行', [])),
          json.dumps(d.get('T1 记忆行'), ensure_ascii=False))

    check('T2 前置：候选确实产生了（› 归档旧版）',
          (d.get('T2 候选数') or 0) >= 2,
          'swipes=%s' % d.get('T2 候选数'))
    check('T2 ★候选悬着时不写记忆（延迟生效，B 没被写入）',
          not any('B版' in r for r in d.get('T2 记忆行', [])),
          json.dumps(d.get('T2 记忆行'), ensure_ascii=False))
    check('T2 ★原版变候选后，它先前写的记忆被回收（A 不再留在表里）',
          not any('A版' in r for r in d.get('T2 记忆行', [])),
          json.dumps(d.get('T2 记忆行'), ensure_ascii=False))

    check('T3 在候选 B 下发消息 → B 的记忆被补写',
          d.get('T3 记忆含 B') is True,
          json.dumps(d.get('T3 记忆行'), ensure_ascii=False))

    check('T4 翻看候选 A → 不产生新行（翻看不碰记忆表）',
          d.get('T4 行数不变') is True,
          json.dumps(d.get('T4 记忆行'), ensure_ascii=False))
    check('T4 翻看后确实停在 A 版（前置成立）',
          d.get('T4 翻到的是 A 版') is True,
          'content=%s' % d.get('T4 当前显示内容'))
    check('T4 ★翻看把待落库标记切到了 A 那一版（否则补写会串味）',
          d.get('T4 mtRaw 指向 A') is True,
          'mtRaw=%s' % d.get('T4 翻看后 mtRaw'))

    check('T5 在候选 A 下发消息 → A 的记忆被补写',
          d.get('T5 记忆含 A') is True,
          json.dumps(d.get('T5 记忆行'), ensure_ascii=False))

    check('T6 反向对照：正常推进的楼层记忆照常写入（防「一律不写」）',
          d.get('T6 记忆有新增') is True,
          json.dumps(d.get('T6 记忆行'), ensure_ascii=False))

    if d.get('T7 找到历史楼层'):
        check('T7 历史楼层（非末尾）重生成 → 记忆照常写入',
              d.get('T7 记忆有新增') is True,
              json.dumps(d.get('T7 记忆行'), ensure_ascii=False))

    store_src = (ROOT / 'js2' / 'miya-memory-table-store.js').read_text(encoding='utf-8')
    m = re.search(r'function defaultTables\(\)\s*\{(.*?)\n  \}', store_src, re.S)
    expected_tables = len(re.findall(r"id:\s*'t_", m.group(1))) if m else None
    check('表结构未被破坏',
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

    if errors:
        return 1
    return 0 if passed == len(checks) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
