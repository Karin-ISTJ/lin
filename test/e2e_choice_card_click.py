#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
e2e_choice_card_click.py
────────────────────────
浏览器端到端：点剧情建议卡里的一条 → 真的发出去一条消息。

验的是这条链路能不能通：
    卡片渲染出 [data-mi-choice]
      → 点它
      → 委托取到文本、判定是末尾楼层
      → 填进输入框、调 sendMessage()
      → 会话里多出一条 **内容等于该建议** 的 user 楼层

为什么必须放浏览器里测
──────────────────────
这条链路的每一环都依赖真实 DOM 与真实事件：
  · 委托是绑在 root 上的，靠事件冒泡命中 —— 静态读代码看不出有没有接上
  · 末尾楼层判定要 closest('[data-ap-msg-id]') 逐层往上找容器
  · 按钮是 patchStoryBody() 重建出来的，「重建后监听器是否还在」
    只有真点一下才知道

后者尤其关键：同一批楼层工具（‹ ›、现实时钟卡）都踩过
「按钮在、点了没反应」的坑，根因就是监听器跟着 DOM 一起没了。

用法（需先起服务）：
    python3 -m http.server 8099 --bind 127.0.0.1
    python3 test/e2e_choice_card_click.py
"""

import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://127.0.0.1:8099/index.html'

PROBE = r"""
async () => {
    const out = { steps: [] };
    const log = (k, v) => out.steps.push([k, v]);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const cs = window.miyaContactsStore;
    const st = window.miyaChatStore;
    const aps = window.MiyaAppointmentStore;

    if (!cs || !st || !aps) {
        return { fatal: 'modules_missing', have: { cs: !!cs, st: !!st, aps: !!aps } };
    }

    if (typeof window.miyaSetApiConfig === 'function') {
        window.miyaSetApiConfig({
            baseUrl: 'https://probe.invalid/v1',
            apiKey: 'probe-key',
            model: 'probe-model'
        });
    }

    /*
     * 假 fetch：吐一条**带 <card> 和四条建议**的回复。
     *
     * 建议文本特意选得好认，便于最后断言「发出去的正是那一条」。
     */
    const REPLY = [
        '她抬头看了我一眼，把伞往这边挪了挪。',
        '<card>',
        '[Profile|我|学生|Lv3|300|心跳有点快]',
        '[Choices]',
        '[Choice|我把伞接过来，说那我来撑|顺势拉近关系]',
        '[Choice|说声谢谢，然后快步走开|保持距离]',
        '[Choice|问她周末去不去那家店|推进私下相处]',
        '[Choice|什么都不说，就跟着她走|先不说话]',
        '</card>'
    ].join('\n');

    /*
     * ⚠️ 假 fetch 只装这一次，全程不卸。
     *
     * 早先的写法分了三段：先装假 fetch、建会话时卸回真的、生成时再
     * 靠 `window.__probeFetch || realFetch` 切回假的 —— 那个变量从未
     * 定义过，于是「切回假 fetch」实际装的是真 fetch。生成请求打到
     * probe.invalid 静默失败，楼层数停在 1，卡片自然渲染不出来。
     *
     * 对照 e2e_swipe_memory_deferred（那边是通的）就能看出：它从头到尾
     * 就一个假 fetch，建角色、建会话、生成全走它。这里的建会话阶段
     * 本来也不需要真网络，一起来用假 fetch 兜底更稳。
     */
    const realFetch = window.fetch;
    window.fetch = function () {
        const chunk =
            'data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] }) + '\n\n' +
            'data: [DONE]\n\n';
        const enc = new TextEncoder();
        let done = false;
        return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: function () { return 'text/event-stream'; } },
            body: {
                getReader() {
                    return {
                        read() {
                            if (done) return Promise.resolve({ done: true, value: undefined });
                            done = true;
                            return Promise.resolve({ done: false, value: enc.encode(chunk) });
                        },
                        cancel() { return Promise.resolve(); }
                    };
                }
            },
            text: function () { return Promise.resolve(chunk); },
            json: function () { return Promise.resolve({ choices: [{ message: { content: REPLY } }] }); }
        });
    };

    if (cs.whenReady) await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
    await sleep(300);

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

    /*
     * ⚠️ 这里**不要**把 fetch 还原成真的。
     *
     * 早先这里有一行 `window.fetch = realFetch;`，注释写的是「建会话阶段
     * 用真实（无所谓），下面生成时再装回来」—— 但下面那行「装回来」写的是
     * `window.fetch = window.__probeFetch || realFetch`，而 __probeFetch
     * 从未定义过，于是实际装回去的还是真 fetch。生成请求打到 probe.invalid，
     * 静默失败，楼层数停在 1，卡片渲染不出来。
     *
     * 对照 e2e_swipe_memory_deferred（通的）就能看出：它从头到尾只装一个
     * 假 fetch。这里的建会话阶段本来也不需要真网络。
     */

    if (window.miyaOfflineApp && window.miyaOfflineApp.open) {
        window.miyaOfflineApp.open({
            chatId: chatId,
            contactId: String(contact.id),
            cast: [{ contactId: String(contact.id), chatId: chatId }]
        });
        await sleep(600);
    }

    const ui = window.miyaOfflineApp.__testUi ? window.miyaOfflineApp.__testUi() : null;
    log('UI 就绪', !!(ui && String(ui.chatId) === chatId));
    if (!ui || String(ui.chatId) !== chatId) return { fatal: 'ui_not_open', out };

    // ── 造一层角色回复（含建议卡）──
    /*
     * ⚠️ 这里**不重装 fetch**：上面那个假 fetch 全程有效。
     *
     * 装回来的坑见上面那段说明 —— 早先就是在这里把真 fetch 装了回来。
     */
    aps.addMessage(chatId, sessionId, { role: 'user', content: '要不要一起走？' });
    await sleep(120);

    /*
     * 走 __testRegenFloor(userMsg, false) 生成。
     *
     * 为什么走它而不是直连引擎：引擎的 replaceLastAssistant 语义是
     * 「找最后一条 assistant 重写」，它不看你中间插没插 user 楼层。
     * 而 app 层的 regenerateAfterUserFloor 才会「在 user 后面新写一层」，
     * 这正是界面「我发一句 → 角色接一句」的真实路径，也正是本用例
     * 要验的那条 —— 新写出来的角色楼层里才带着建议卡。
     */
    const lastUser = (aps.getSessionMessages(chatId, sessionId) || []).filter(m => m && m.role === 'user').pop();
    if (!lastUser) return { fatal: 'no_user_floor', out };
    /*
     * ⚠️ 传**消息对象**，不是 id 字符串。
     *
     * regenerateFloor(m, keep) 里读的是 m.id / m.role —— 传字符串
     * 会得到 m.id === undefined，函数第一行 `if (!m || !m.id) return;`
     * 直接静默返回，表现就是「什么都没发生」（这正是早先那次楼层数
     * 停在 1 的第二个原因）。e2e_swipe_memory_deferred 的 T6 传的
     * 也是对象，保持一致。
     */
    try { window.miyaOfflineApp.__testRegenFloor(lastUser, false); } catch (e) { log('生成异常', String((e && e.message) || e)); }
    /* 给足流式解析 + patchStoryBody + 卡片渲染的时间（诊断实测 2.5s 稳过） */
    await sleep(2500);

    // ── 检查卡片与按钮 ──
    const btns = document.querySelectorAll('[data-mi-choice]');
    log('建议按钮数', btns.length);

    const before = (aps.getSessionMessages(chatId, sessionId) || []).filter(m => m && !m.deleted);
    log('点击前楼层数', before.length);
    const beforeIds = new Set(before.map(m => String(m.id)));
    const beforeLastId = before.length ? String(before[before.length - 1].id) : '';

    if (!btns.length) return { fatal: 'no_choice_button', out };

    // 挑第 3 条（「问她周末去不去那家店」），确保不是第一条，避免「总是取第1条」的假通过
    const target = btns[2];
    const wantText = String(target.getAttribute('data-mi-choice') || '').trim();
    log('准备点击的建议', wantText);

    target.click();
    await sleep(1200);

    const after = (aps.getSessionMessages(chatId, sessionId) || []).filter(m => m && !m.deleted);
    const newOnes = after.filter(m => !beforeIds.has(String(m.id)));
    const userNew = newOnes.filter(m => m && m.role === 'user');
    log('点击后新增楼层数', newOnes.length);
    log('其中 user 楼层', userNew.length);
    log('新 user 内容', userNew.length ? String(userNew[0].content || '') : '');
    log('期望内容', wantText);

    out.result = {
        btnCount: btns.length,
        wantText: wantText,
        newUserContent: userNew.length ? String(userNew[0].content || '') : '',
        newCount: newOnes.length,
        beforeLastId: beforeLastId,
        matched: userNew.some(m => String(m.content || '').trim() === wantText)
    };

    /* ══════════════════════════════════════════════════════════════════
     * B 段：历史楼层上的建议**点不动**
     * ══════════════════════════════════════════════════════════════════
     *
     * 这是用户明确要的语义：建议代表「接下来可以怎么做」，只在剧情
     * 推进到那儿时才成立。历史楼层上点它 = 把一句话插到旧剧情中间，
     * 会把时间线截断。
     *
     * ⚠️ 必须真点一次验，不能只读代码：
     *   · 判定靠 closest('[data-ap-msg-id]') 逐层往上找容器再比对末尾 id，
     *     这种 DOM 关系静态读不出来对不对；
     *   · 委托是绑在 root 上的，命中与否只有真冒泡才知道。
     *
     * ⚠️ 刚点完第 3 条，末尾楼层已经是**新的 user 楼层**了 ——
     * 而那条 user 楼层里没有建议按钮，所以此刻页面上的 4 个按钮
     * 全部属于「历史楼层」。正好拿来验。
     */
    const btns2 = document.querySelectorAll('[data-mi-choice]');
    log('B段 当前建议按钮数', btns2.length);
    if (btns2.length) {
        const beforeB = (aps.getSessionMessages(chatId, sessionId) || []).filter(m => m && !m.deleted);
        const beforeIdsB = new Set(beforeB.map(m => String(m.id)));
        const targetB = btns2[0];
        log('B段 点击历史楼层的建议', String(targetB.getAttribute('data-mi-choice') || '').trim());
        targetB.click();
        await sleep(900);
        const afterB = (aps.getSessionMessages(chatId, sessionId) || []).filter(m => m && !m.deleted);
        const newB = afterB.filter(m => !beforeIdsB.has(String(m.id)));
        log('B段 点击后新增楼层数', newB.length);
        out.result.historicalNewCount = newB.length;
        /* 顺带把 toast 文案捞出来，确认给的是「已经过去了」而不是静默 */
        out.result.historicalBlocked = newB.length === 0;
    }
    return out;
}
"""


async def run():
    passed = 0
    failed = 0

    def ck(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print("  ✅ PASS  " + name + (("  ← " + detail) if detail else ""))
        else:
            failed += 1
            print("  ❌ FAIL  " + name + (("  ← " + detail) if detail else ""))

    print("=" * 72)
    print("E2E：点剧情建议卡 → 发出消息")
    print("=" * 72)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        page.on("console", lambda m: None)

        await page.goto(BASE, wait_until='domcontentloaded')
        await page.evaluate("try{localStorage.clear();}catch(e){}")
        await page.reload(wait_until='domcontentloaded')
        await page.wait_for_timeout(1500)

        res = await page.evaluate(PROBE)
        await browser.close()

    steps = res.get("steps") or []
    for k, v in steps:
        print("   · %s: %s" % (k, v))

    if res.get("fatal"):
        ck("探针顺利完成", False, str(res["fatal"]))
    else:
        r = res.get("result") or {}
        ck("卡片渲染出 4 个建议按钮", r.get("btnCount") == 4, "%s 个" % r.get("btnCount"))
        ck("点击后确实多出一层", r.get("newCount", 0) >= 1, "%s 层" % r.get("newCount"))
        ck("新楼层是 user 发言", bool(r.get("newUserContent")), r.get("newUserContent"))
        ck("发出去的内容 = 被点的那条建议", r.get("matched"),
           "点的是「%s」" % r.get("wantText"))
        ck("历史楼层上的建议点不动", r.get("historicalBlocked") is True,
           "新增 %s 层" % r.get("historicalNewCount"))

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (passed, failed))
    print("=" * 72)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
