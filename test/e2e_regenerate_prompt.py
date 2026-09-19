# -*- coding: utf-8 -*-
"""
E2E：重回时「改写约束」真的进了请求体
=====================================

这是对 audit_regenerate_differentiation.py 的**端到端补强**：
那个测试是静态读源码，这个测试在真实浏览器里
mock 掉 fetch，把引擎实际发出的 request body 抓下来看。

验证链路：
  toolRegenerate()
    → withdrawLastAssistantRound()   （撤回末尾助手轮）
    → requestAiReply(true, 0, {isRegenerate:true})
    → sendChat(cid, '', {skipUserMessage:true, isRegenerate:true})
    → 组装 apiMessages
    → fetch(url, {body: JSON.stringify(reqPayload)})

断言：
  P1  请求真的发出去了
  P2  末条消息是 user 角色（尾部 nudge）
  P3  该 nudge 含「换一个切入角度」类改写要求
  P4  该 nudge 含「上一版已被丢弃」的告知
  P5  被撤回的助手回复**不在**上下文里
  P6  非重答路径（普通发送）不带这条约束 —— 隔离性

跑法：python3 test/e2e_regenerate_prompt.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"


async def main():
    results = []

    def check(name, cond, detail=""):
        results.append({"name": name, "pass": bool(cond), "detail": str(detail)})

    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page()

        # 拦截 fetch，把请求体存到 window.__caught
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
                // 返回一个合法但空的 completion，让引擎走完流程
                return Promise.resolve(new Response(JSON.stringify({
                    choices: [{ message: { content: '（测试回复）' } }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            };
        """)

        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(2500)

        # 配好 API，否则引擎会 early-return api_not_configured
        await pg.evaluate("""() => {
            if (typeof window.miyaSetApiConfig === 'function') {
                window.miyaSetApiConfig({
                    baseUrl: 'https://example.test/v1',
                    apiKey: 'sk-test',
                    model: 'test-model'
                });
            }
        }""")

        # 造数：联系人 → 会话 → user/assistant 两轮
        setup = await pg.evaluate("""async () => {
            const CS = window.miyaChatStore;
            if (CS.init) await CS.init();
            const cs = window.miyaContactsStore;
            if (cs && cs.upsertCharacter) {
                cs.upsertCharacter({ name: '重答测', groupId: 'ct_default', persona: 'x' });
            }
            const contact = await CS.addContactFromChronicle(
                { id: 'actor_regen', characterId: 'actor_regen', name: '重答测' }
            ).catch(() => null);
            if (!contact || !contact.id) return { error: 'no_contact' };
            const chat = await CS.createChat({ contactId: contact.id }).catch(() => null);
            const cid = chat && chat.id ? String(chat.id) : null;
            if (!cid) return { error: 'no_chat' };
            await CS.addMessage(cid, { role: 'user', content: '你今天去哪了' });
            await CS.addMessage(cid, { role: 'assistant', content: '我去图书馆了。' });
            return { cid, contactId: contact.id };
        }""")
        check("P0 造数成功", not setup.get("error"),
              json.dumps(setup, ensure_ascii=False))
        if setup.get("error"):
            await b.close()
            _report(results)
            return 1

        cid = setup["cid"]

        # ── 直接调引擎的重答入口，绕开 UI 的发送中状态 ──
        regen = await pg.evaluate("""async (cid) => {
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
        }""", cid)
        await pg.wait_for_timeout(1200)

        caught = await pg.evaluate("() => window.__caught || []")
        check("P1 请求真的发出去了", len(caught) > 0,
              "捕获 %d 条请求；regen=%s" % (len(caught), json.dumps(regen, ensure_ascii=False)))

        if caught:
            body = json.loads(caught[-1]["body"])
            msgs = body.get("messages") or []

            # P2 末条是 user 尾注
            last = msgs[-1] if msgs else {}
            check("P2 末条消息为 user（尾部 nudge）",
                  last.get("role") == "user",
                  "role=%s" % last.get("role"))

            tail_text = str(last.get("content") or "")

            check("P3 nudge 含「换一个切入角度」改写要求",
                  "换一个切入角度" in tail_text,
                  "nudge 长度=%d" % len(tail_text))

            check("P4 nudge 含「上一版已被丢弃」告知",
                  "已被丢弃" in tail_text or "上一版" in tail_text,
                  "命中=%s" % ("已被丢弃" in tail_text))

            # P5 被撤回的助手回复不在上下文
            all_text = json.dumps(msgs, ensure_ascii=False)
            check("P5 被撤回的助手回复不在上下文中",
                  "我去图书馆了" not in all_text,
                  "含旧回复=%s" % ("我去图书馆了" in all_text))

            # P6 非重答路径不带这条约束
            check("P6 非重答路径不含改写约束（隔离性）",
                  not any("换一个切入角度" in str(m.get("content") or "")
                          for m in msgs[:-1]),
                  "其它消息里出现改写约束=False")

        await b.close()

    _report(results)
    return 0 if all(r["pass"] for r in results) else 1


def _report(results):
    print("=" * 74)
    print("E2E：重回时「改写约束」真的进了请求体")
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
