#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
复现并守住「未闭合 thinking + 空行 → ReferenceError: trim is not defined」。

跑法：
    python3 -m http.server 8099     # 项目根目录
    python3 test/repro_unclosed_thinking_trim.py

背景：
  miya-chat-engine.js 的 stripUnclosedThinkingTail() 里，
  剥完未闭合 thinking 段后要拼接「其后正文」，那两行写成了
  trim(x) 而不是 x.trim() —— 而本文件从未定义过名为 trim 的函数，
  于是抛 ReferenceError。

  它只在「某层开了 <thinking> 却没闭合、且标签后有空行」时执行，
  所以常规聊天遇不到；一旦用 ST 导入那种「只有思维段、正文为空」
  的楼层，异常就会在渲染期爆出，表现为「导入失败：写入后界面刷新出错」。
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 412, "height": 915},
            user_agent=("Mozilla/5.0 (Linux; Android 14; MAG-AN00) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/151.0.0.0 Mobile Safari/537.36"),
            service_workers="block",
        )
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{BASE}?t=1", wait_until="load")
        await pg.wait_for_timeout(3000)

        print("\n【用例 1】底层 parseThinking：未闭合 thinking + 空行不得抛错")
        variants = pg.evaluate
        r1 = await pg.evaluate("""() => {
          const eng = window.miyaChatEngine;
          const cases = {
            '半角thinking+空行':  '<thinking>x\\n\\ny',
            '全角thinking+空行':  '＜thinking＞x\\n\\ny',
            'think短标签+空行':   '<think>x\\n\\ny',
            'reasoning+空行':     '<reasoning>x\\n\\ny',
            '多段空行':           '<thinking>x\\n\\n\\ny\\n\\nz',
            '标签后立刻空行':      '<thinking>\\n\\nx',
          };
          const out = {};
          for (const k in cases) {
            try {
              const res = eng.parseThinking(cases[k]);
              out[k] = { ok: true, content: String(res.content || '') };
            } catch (e) {
              out[k] = { ok: false, err: String(e && e.message || e) };
            }
          }
          return out;
        }""")
        for k, v in r1.items():
            print(f"      {k}: {json.dumps(v, ensure_ascii=False)}")
        check("所有未闭合 thinking 变体都不抛错",
              all(v["ok"] for v in r1.values()),
              f"失败 {sum(1 for v in r1.values() if not v['ok'])} 个")
        check("抛错信息不是 trim is not defined",
              not any("trim is not defined" in str(v.get("err", "")) for v in r1.values()))

        print("\n【用例 2】剥掉思维段后，正文必须被保留下来")
        r2 = await pg.evaluate("""() => {
          const eng = window.miyaChatEngine;
          const res = eng.parseThinking('<thinking>想了很多\\n\\n真正要说的话');
          return { content: String(res.content || '') };
        }""")
        print(f"      {json.dumps(r2, ensure_ascii=False)}")
        check("未闭合 thinking 之后的正文被保留为 content",
              "真正要说的话" in r2["content"], f"content={r2['content']!r}")

        print("\n【用例 3】端到端：含未闭合 thinking 的 ST 文件必须能导入")
        unclosed = "<thinking>我在回忆今天发生的事。\n\n这段应属正文但没闭合标签"
        rows = [
            json.dumps({"user_name": "U", "character_name": "克苏洛斯",
                        "chat_metadata": {"integrity": "x"}}, ensure_ascii=False),
            json.dumps({"name": "克苏洛斯", "is_user": False, "mes": unclosed,
                        "swipes": [unclosed, "第二版候选"]}, ensure_ascii=False),
            json.dumps({"name": "U", "is_user": True, "mes": "晚上好。",
                        "swipes": ["晚上好。"]}, ensure_ascii=False),
        ]
        text = "\n".join(rows) + "\n"
        r3 = await pg.evaluate("""async (t) => {
          const api = window.miyaOfflineApp, Store = window.MiyaAppointmentStore;
          const CS = window.miyaChatStore;
          await CS.init();
          let c = (CS.getContacts() || [])[0];
          if (!c) c = await CS.addContactFromChronicle({
            id: 'p1', characterId: 'c1', name: '克苏洛斯', avatar: '' });
          let ch = CS.findChatByContact(c.id, '') ||
                   (CS.getChats() || []).filter(x => x.contactId === c.id)[0];
          if (!ch) ch = await CS.createChat({ contactId: c.id, type: 'private' });
          const cid = String(ch.id);
          const before = (Store.getSessions(cid) || []).length;
          let esc = null;
          try { api.__testRunImport(cid, t, 'unclosed.jsonl'); }
          catch (e) { esc = String(e); }
          await new Promise(r => setTimeout(r, 450));
          const after = (Store.getSessions(cid) || []).length;
          const toastEl = document.getElementById('xw-toast');
          return {
            esc, delta: after - before,
            panelShown: !!document.getElementById('xw-import-diag'),
            toast: toastEl ? String(toastEl.textContent || '').trim() : '',
            ui: api.__testUi(),
          };
        }""", text)
        print(f"      {json.dumps(r3, ensure_ascii=False)}")
        check("导入未抛异常", not r3["esc"], f"esc={r3['esc']!r}")
        check("导入成功、卷宗多了一卷", r3["delta"] == 1, f"delta={r3['delta']}")
        check("没有弹出异常诊断面板（说明渲染没炸）", not r3["panelShown"])
        check("toast 报告导入成功而不是失败",
              "已导入" in (r3["toast"] or ""), f"toast={r3['toast']!r}")

        print("\n" + "=" * 56)
        print(f"通过 {len(passed)} · 失败 {len(failed)}")
        if failed:
            print("失败项：")
            for f in failed:
                print(f"  · {f}")
        if errs:
            print("\n页面运行期报错：")
            for e in errs[:8]:
                print(f"  ! {e}")
        await browser.close()
        sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
