# -*- coding: utf-8 -*-
"""
E2E：删掉末尾角色回复后自己再说一句，改写约束真的进了请求体
============================================================

对应用户的第二次反馈：
    「我发现删除消息后还是会有概率发一模一样的消息」

为什么单独一个测试：
    「重新生成」那条路径在 e2e_regenerate_prompt.py 里已经覆盖了，
    但那要长按**现存**的角色消息才点得到按钮。消息一删，按钮就没了，
    用户只能走普通回复 —— 而普通回复此前**一句改写约束都没有**。
    这个测试专门盯这条缝。

真实流程（必须按这个顺序走，否则会像最初那样一条都命中不了）：
    1. 长按删除末尾那条角色回复
    2. 在输入框打字，点「发送」（这一步只把用户消息写进 store）
    3. 点四角星「触发回复」按钮 → sendChat(cid, '', {skipUserMessage:true})

断言：
    R1   删除成功且消息确实没了
    R1b  删除后挂上了「重说」标记
    R2   请求真的发出去了
    R3   末条是 user 角色的尾部 nudge
    R4   该 nudge 是「重说」版：含改写约束，且**不再**是裸的普通回复 nudge
    R5   nudge 里引用了被删掉的那一版原文
    R6   nudge 明确排除了「同义改写」这条歧义读法
    R7   隔离性：没删过东西的会话正常回复**不带**改写约束
    R8   一次性：删完连点两次回复，第二次不再套改写约束

跑法：python3 test/e2e_delete_then_send_rewrite.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"

# 被删掉的那一版回复。挑一个有辨识度的句子，方便在 nudge 里找它。
DOOMED_REPLY = "（我先去洗个澡，你等我一下下嘛）"
USER_FOLLOWUP = "？刚才说什么"
RR_MARK = "同义改写"


async def _setup_chat(pg, tag, with_doomed=True):
    """造一个会话；with_doomed 时末尾再加一条待删的角色回复。"""
    return await pg.evaluate(
        """async ([tag, doomed, withDoomed]) => {
            const CS = window.miyaChatStore;
            if (CS.init) await CS.init();
            const contact = await CS.addContactFromChronicle(
                { id: 'actor_' + tag, characterId: 'actor_' + tag, name: tag }
            ).catch(() => null);
            if (!contact || !contact.id) return { error: 'no_contact' };
            const chat = await CS.createChat({ contactId: contact.id }).catch(() => null);
            const cid = chat && chat.id ? String(chat.id) : null;
            if (!cid) return { error: 'no_chat' };
            await CS.addMessage(cid, { role: 'user', content: '你在忙吗' });
            await CS.addMessage(cid, { role: 'assistant', content: '在的，怎么了？' });
            await CS.addMessage(cid, { role: 'user', content: '没事，就是想说说话' });
            if (!withDoomed) return { cid };
            const d = await CS.addMessage(cid, { role: 'assistant', content: doomed });
            /* 引擎落盘 lastRawAssistantReply，nudge 靠它引用「上一版原文」 */
            await CS.updateChat(cid, { lastRawAssistantReply: doomed });
            return { cid, dId: d && d.id ? String(d.id) : '' };
        }""",
        [tag, DOOMED_REPLY, with_doomed],
    )


async def _real_user_turn(pg, cid, text):
    """按真实顺序走一遍：打开 → 打字发送 → 点触发回复。"""
    await pg.evaluate(
        """async ([cid]) => {
            if (window.miyaChatApp && window.miyaChatApp.open) await window.miyaChatApp.open();
            if (window.miyaChatRoom && window.miyaChatRoom.open) {
                await window.miyaChatRoom.open(String(cid));
            }
        }""",
        [cid],
    )
    await pg.wait_for_timeout(900)


async def main():
    results = []

    def check(name, cond, detail=""):
        results.append({"name": name, "pass": bool(cond), "detail": str(detail)})

    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page()

        await pg.add_init_script("""
            window.__caught = [];
            const _fetch = window.fetch;
            window.fetch = function (url, opts) {
                try {
                    const u = String(url || '');
                    if (opts && opts.body && /chat\\/completions|v1\\/chat|completions/.test(u)) {
                        window.__caught.push({
                            url: u,
                            body: typeof opts.body === 'string' ? opts.body : String(opts.body)
                        });
                    }
                } catch (e) {}
                return Promise.resolve(new Response(JSON.stringify({
                    choices: [{ message: { content: '（测试回复）' } }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            };
        """)

        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(2500)

        await pg.evaluate("""() => {
            if (typeof window.miyaSetApiConfig === 'function') {
                window.miyaSetApiConfig({
                    baseUrl: 'https://example.test/v1',
                    apiKey: 'sk-test',
                    model: 'test-model'
                });
            }
        }""")

        async def last_tail():
            """取最近一次请求的末条消息文本。"""
            raw = await pg.evaluate(
                "() => { const a = window.__caught || []; "
                "return a.length ? a[a.length - 1].body : ''; }"
            )
            if not raw:
                return ""
            msgs = (json.loads(raw) or {}).get("messages") or [{}]
            return str(msgs[-1].get("content") or "")

        # ══════════ 主场景：删 → 打字 → 触发回复 ══════════
        setup = await _setup_chat(pg, "删后重说", with_doomed=True)
        check("R0 造数成功", not setup.get("error"), json.dumps(setup, ensure_ascii=False))
        if setup.get("error"):
            await b.close()
            _report(results)
            return 1

        cid = setup["cid"]
        await _real_user_turn(pg, cid, USER_FOLLOWUP)

        dele = await pg.evaluate(
            """async ([cid, mid]) => {
                const CS = window.miyaChatStore;
                try {
                    await CS.deleteMessage(String(cid), String(mid));
                } catch (e) {
                    return { ok: false, err: String(e && e.message) };
                }
                const left = CS.getMessages(String(cid)) || [];
                return {
                    ok: true,
                    count: left.length,
                    stillThere: left.some(m => String(m.id) === String(mid)),
                    mark: CS.peekRewriteResume ? CS.peekRewriteResume(String(cid)) : null
                };
            }""",
            [cid, setup["dId"]],
        )
        check("R1 删除成功且消息确实没了",
              dele.get("ok") and not dele.get("stillThere"),
              json.dumps(dele, ensure_ascii=False))
        check("R1b 删除后挂上了「重说」标记",
              bool((dele.get("mark") or {}).get("armed")),
              json.dumps(dele.get("mark"), ensure_ascii=False))

        # 打字 + 发送（真实 UI：这一步只落用户消息）
        typed = await pg.evaluate(
            """([txt]) => {
                const inp = document.getElementById('qq-room-input');
                if (!inp) return { err: 'no_input' };
                inp.value = String(txt);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                const btn = document.getElementById('qq-room-send');
                if (!btn) return { err: 'no_send_btn' };
                btn.click();
                return { ok: true };
            }""",
            [USER_FOLLOWUP],
        )
        await pg.wait_for_timeout(600)
        check("R2a 打字发送成功", not typed.get("err"), json.dumps(typed, ensure_ascii=False))

        # 点四角星触发回复
        await pg.evaluate("""() => {
            const ai = document.getElementById('qq-room-ai');
            if (ai) ai.click();
        }""")
        await pg.wait_for_timeout(2000)

        caught = await pg.evaluate("() => window.__caught || []")
        check("R2 请求真的发出去了", len(caught) > 0, "捕获 %d 条" % len(caught))

        if caught:
            tail = await last_tail()

            check("R3 末条为 user（尾部 nudge）",
                  (json.loads(caught[-1]["body"]).get("messages") or [{}])[-1].get("role") == "user",
                  "len=%d" % len(tail))

            check("R4 nudge 是「重说」版（含改写约束）",
                  RR_MARK in tail and "换一个角度切入" in tail,
                  "len=%d 含『同义改写』=%s 含『换一个角度切入』=%s"
                  % (len(tail), RR_MARK in tail, "换一个角度切入" in tail))

            check("R5 nudge 引用了被删掉的那一版原文",
                  DOOMED_REPLY[:14] in tail,
                  "命中原句=%s" % (DOOMED_REPLY[:14] in tail))

            check("R6 nudge 明确排除「同义改写」歧义读法",
                  "不是" in tail and RR_MARK in tail,
                  "含排除语=%s" % ("不是" in tail))

            check("R6b 不再残留裸的普通回复 nudge",
                  "【你刚删掉了自己上一版的回复】" in tail,
                  "含弃版声明=%s" % ("【你刚删掉了自己上一版的回复】" in tail))

        # ══════════ R7 隔离性：没删过东西的会话 ══════════
        await pg.evaluate("() => { window.__caught.length = 0; }")
        s2 = await _setup_chat(pg, "干净会话", with_doomed=False)
        if not s2.get("error"):
            await _real_user_turn(pg, s2["cid"], "好")
            await pg.evaluate("""() => {
                const inp = document.getElementById('qq-room-input');
                if (inp) { inp.value = '好'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
                const sb = document.getElementById('qq-room-send');
                if (sb) sb.click();
            }""")
            await pg.wait_for_timeout(500)
            await pg.evaluate("""() => {
                const ai = document.getElementById('qq-room-ai');
                if (ai) ai.click();
            }""")
            await pg.wait_for_timeout(1800)
            c2 = await pg.evaluate("() => window.__caught || []")
            t2 = await last_tail()
            check("R7 隔离性：未删除的会话正常回复不带改写约束",
                  len(c2) > 0 and RR_MARK not in t2,
                  "捕获 %d 条；含改写约束=%s" % (len(c2), RR_MARK in t2))

        # ══════════ R8 一次性：连点两次回复 ══════════
        await pg.evaluate("() => { window.__caught.length = 0; }")
        s3 = await _setup_chat(pg, "连发两次", with_doomed=True)
        if not s3.get("error"):
            cid3 = s3["cid"]
            await _real_user_turn(pg, cid3, "第一句")
            await pg.evaluate(
                """async ([cid, mid]) => {
                    try { await window.miyaChatStore.deleteMessage(String(cid), String(mid)); } catch (e) {}
                }""",
                [cid3, s3["dId"]],
            )
            await pg.evaluate("""() => {
                const inp = document.getElementById('qq-room-input');
                if (inp) { inp.value = '第一句'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
                const sb = document.getElementById('qq-room-send');
                if (sb) sb.click();
            }""")
            await pg.wait_for_timeout(500)
            await pg.evaluate("""() => { const ai = document.getElementById('qq-room-ai'); if (ai) ai.click(); }""")
            await pg.wait_for_timeout(1800)
            t1 = await last_tail()
            has1 = RR_MARK in t1

            await pg.evaluate("""() => {
                const inp = document.getElementById('qq-room-input');
                if (inp) { inp.value = '第二句'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
                const sb = document.getElementById('qq-room-send');
                if (sb) sb.click();
            }""")
            await pg.wait_for_timeout(500)
            await pg.evaluate("""() => { const ai = document.getElementById('qq-room-ai'); if (ai) ai.click(); }""")
            await pg.wait_for_timeout(1800)
            t2b = await last_tail()
            has2 = RR_MARK in t2b

            check("R8 一次性：第一句带约束、第二句不带", has1 and not has2,
                  "第一句含约束=%s 第二句含约束=%s" % (has1, has2))

        await b.close()

    _report(results)
    return 0 if all(r["pass"] for r in results) else 1


def _report(results):
    print("=" * 74)
    print("E2E：删掉末尾角色回复后自己再说一句，改写约束真的进了请求体")
    print("=" * 74)
    for r in results:
        print(("  ✅ " if r["pass"] else "  ❌ ") + r["name"])
        if r["detail"]:
            print("       " + r["detail"])
    print("-" * 74)
    n = sum(1 for r in results if r["pass"])
    print("%d/%d 通过" % (n, len(results)))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
