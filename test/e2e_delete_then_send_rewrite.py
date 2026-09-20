# -*- coding: utf-8 -*-
"""
E2E：删掉末尾角色回复后自己再说一句，改写约束真的进了请求体
============================================================

对应用户的第三次反馈：
    「线上功能还是出现同样的问题」—— v8.4 自测全绿，线上照旧复读。

为什么 v8.4 全绿却线上失效（本轮修复的根因）：
    UI 的单条删除**根本不走 store.deleteMessage**：
      长按消息 → 菜单「删除」→ enterMultiSelectMode(种子=这一条)
      → 多选栏「删除」→ deleteSelectedMessages → store.deleteMessages（批量接口）
    而 v8.4 的打标只写在 deleteMessage（单条接口）里 ——
    旧版 e2e 的删除步骤也是直接调 CS.deleteMessage，绕开了 UI，
    所以「测绿、线上废」。这正是「测试覆盖率不等于场景覆盖率」的第三次上演。

真实流程（必须按这个顺序走，否则会像最初那样一条都命中不了）：
    1. 长按删除末尾那条角色回复
       e2e 里用 miyaChatRoom.__testEnterMultiSelect（官方测试钩子，
       即「长按→菜单→删除」的落点）+ 点击**真实**多选栏删除按钮，
       完整经过 deleteSelectedMessages → store.deleteMessages
    2. 在输入框打字，点「发送」（这一步只把用户消息写进 store）
    3. 点四角星「触发回复」按钮 → sendChat(cid, '', {skipUserMessage:true})

断言：
    R0   造数成功
    R1   真实 UI 删除成功且消息确实没了
    R1b  **批量删除路径**挂上了「重说」标记（根因回归点：只认单条接口必红）
    R2   请求真的发出去了
    R3   末条是 user 角色的尾部 nudge
    R4   该 nudge 是「重说」版：含改写约束，且**不再**是裸的普通回复 nudge
    R5   nudge 里引用了被删掉的那一版原文
    R6   nudge 明确排除了「同义改写」这条歧义读法
    R7   隔离性：没删过东西的会话正常回复**不带**改写约束
    R8   一次性：删完连点两次回复，第二次不再套改写约束
    R9   多选删多条**不打标**（批量接口的「恰好一条」护栏）
    R10  【重回】引用被撤回原文：撤回清空 chat 字段后，nudge 仍能引用快照
    R11  【重回】成功后的下一次普通发送**不误伤**（陈旧标记已被清掉）

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
    """按真实顺序走一遍：打开 → （后续步骤各自触发）。"""
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


async def _real_ui_delete(pg, cid, d_id):
    """
    走**真实 UI 删除链路**（不直接调 store 接口）：
      长按 → 菜单「删除」 ≈ __testEnterMultiSelect(种子=这条)（官方测试钩子）
      → 点击多选栏「删除」按钮 → deleteSelectedMessages → store.deleteMessages
    返回删除后的探针结果。
    """
    entered = await pg.evaluate(
        """([mid]) => {
            const room = window.miyaChatRoom;
            if (!room || typeof room.__testEnterMultiSelect !== 'function') {
                return { err: 'no_hook' };
            }
            return { ok: room.__testEnterMultiSelect(String(mid)) };
        }""",
        [d_id],
    )
    if entered.get("err"):
        return entered
    # 点真实的「删除」按钮（走 deleteSelectedMessages → store.deleteMessages）
    clicked = await pg.evaluate(
        "() => { const btn = document.querySelector('[data-qq-multi-del]');"
        " if (!btn) return { err: 'no_btn' }; btn.click(); return { ok: true }; }"
    )
    if clicked.get("err"):
        return clicked
    await pg.wait_for_timeout(600)
    return await pg.evaluate(
        """([cid, mid]) => {
            const CS = window.miyaChatStore;
            const left = CS.getMessages(String(cid)) || [];
            return {
                count: left.length,
                stillThere: left.some(m => String(m.id) === String(mid)),
                mark: CS.peekRewriteResume ? CS.peekRewriteResume(String(cid)) : null
            };
        }""",
        [cid, d_id],
    )


async def _type_and_send(pg, text):
    await pg.evaluate(
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
        [text],
    )
    await pg.wait_for_timeout(600)


async def _click_ai_reply(pg):
    await pg.evaluate("""() => {
        const ai = document.getElementById('qq-room-ai');
        if (ai) ai.click();
    }""")
    await pg.wait_for_timeout(2000)


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

        # ══════════ 主场景：真实 UI 删 → 打字 → 触发回复 ══════════
        setup = await _setup_chat(pg, "删后重说", with_doomed=True)
        check("R0 造数成功", not setup.get("error"), json.dumps(setup, ensure_ascii=False))
        if setup.get("error"):
            await b.close()
            _report(results)
            return 1

        cid = setup["cid"]
        await _real_user_turn(pg, cid, USER_FOLLOWUP)

        dele = await _real_ui_delete(pg, cid, setup["dId"])
        check("R1 真实 UI 删除成功且消息确实没了",
              dele.get("count") is not None and not dele.get("stillThere") and not dele.get("err"),
              json.dumps(dele, ensure_ascii=False))
        # 根因回归点：标记必须由**批量删除路径**（deleteMessages）挂上。
        # 修复前这里必红 —— 打标只存在于 deleteMessage，而 UI 从不调它。
        check("R1b 批量删除路径挂上了「重说」标记",
              bool((dele.get("mark") or {}).get("armed")),
              json.dumps(dele.get("mark"), ensure_ascii=False))

        # 打字 + 发送（真实 UI：这一步只落用户消息）
        await _type_and_send(pg, USER_FOLLOWUP)

        # 点四角星触发回复
        await _click_ai_reply(pg)

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
            await _type_and_send(pg, "好")
            await _click_ai_reply(pg)
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
            d3 = await _real_ui_delete(pg, cid3, s3["dId"])
            check("R8 前置：真实 UI 删除后标记在",
                  bool((d3.get("mark") or {}).get("armed")),
                  json.dumps(d3.get("mark"), ensure_ascii=False))
            await _type_and_send(pg, "第一句")
            await _click_ai_reply(pg)
            t1 = await last_tail()
            has1 = RR_MARK in t1

            await _type_and_send(pg, "第二句")
            await _click_ai_reply(pg)
            t2b = await last_tail()
            has2 = RR_MARK in t2b

            check("R8 一次性：第一句带约束、第二句不带", has1 and not has2,
                  "第一句含约束=%s 第二句含约束=%s" % (has1, has2))

        # ══════════ R9 多选删多条不打标（批量接口护栏） ══════════
        await pg.evaluate("() => { window.__caught.length = 0; }")
        s4 = await _setup_chat(pg, "多选删多条", with_doomed=True)
        if not s4.get("error"):
            cid4 = s4["cid"]
            await _real_user_turn(pg, cid4, "清理")
            # 末尾角色回复 + 前面那条用户消息，一次批量删两条
            batch = await pg.evaluate(
                """async ([cid, dId]) => {
                    const CS = window.miyaChatStore;
                    const left = CS.getMessages(String(cid)) || [];
                    const userId = (left.find(m => m.role === 'user') || {}).id;
                    await CS.deleteMessages(String(cid), [String(dId), String(userId)]);
                    return {
                        count: (CS.getMessages(String(cid)) || []).length,
                        mark: CS.peekRewriteResume ? CS.peekRewriteResume(String(cid)) : null
                    };
                }""",
                [cid4, s4["dId"]],
            )
            no_mark = not bool((batch.get("mark") or {}).get("armed"))
            await _type_and_send(pg, "还在吗")
            await _click_ai_reply(pg)
            t4 = await last_tail()
            check("R9 多选删两条不打标、后续回复不带改写约束",
                  no_mark and RR_MARK not in t4,
                  "未打标=%s 尾nudge含约束=%s" % (no_mark, RR_MARK in t4))

        # ══════════ R10/R11 【重回】：撤回快照引用 + 成功后不误伤 ══════════
        await pg.evaluate("() => { window.__caught.length = 0; }")
        s5 = await _setup_chat(pg, "重回快照", with_doomed=True)
        if not s5.get("error"):
            cid5 = s5["cid"]
            await _real_user_turn(pg, cid5, "重回")
            regen = await pg.evaluate(
                """async (cid) => {
                    const eng = window.miyaChatEngine;
                    if (!eng || typeof eng.regenerateLastRound !== 'function') {
                        return { error: 'no_regen_api' };
                    }
                    try {
                        await eng.regenerateLastRound(String(cid));
                        return { ok: true };
                    } catch (e) {
                        return { ok: false, err: String(e && e.message) };
                    }
                }""",
                cid5,
            )
            await pg.wait_for_timeout(2000)
            t5 = await last_tail()
            check("R10 重回 nudge 引用被撤回的原文（快照回退）",
                  DOOMED_REPLY[:14] in t5,
                  "命中原句=%s regen=%s" % (DOOMED_REPLY[:14] in t5,
                                            json.dumps(regen, ensure_ascii=False)))

            # 重回已成功（一版新回复落库）→ 陈旧标记应被清掉：
            # 此后普通发送**不得**再被误判成「删了重说」
            await _type_and_send(pg, "聊点别的")
            await _click_ai_reply(pg)
            t6 = await last_tail()
            check("R11 重回成功后的普通发送不误伤（无改写约束）",
                  RR_MARK not in t6,
                  "含改写约束=%s" % (RR_MARK in t6))

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
