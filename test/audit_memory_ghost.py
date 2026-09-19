#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
复现：删掉的线下卷宗内容，仍被线上「记忆档案」注入请求

用户描述：线下功能思维链会读取记忆档案，而记忆档案里是我之前删过的卷宗里的内容。
       记忆功能 / 记忆表格界面里查过是空的，但线下链路仍能读到。

假设：存在两条独立链路
  A. 记忆功能 UI   → chatSettings.summaryList        （删除确实生效，所以界面是空的）
  B. 线下记忆桥    → appointmentStore session.summaryList / messages（删除未同步，内容还在）

本脚本用真实 API 走一遍「建卷宗 → 删除 → 再构造线上请求上下文」，
看 B 链路是否还能拿到已删内容。
"""
import asyncio, json
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

SEED = """
(function(){
  var now = Date.now();
  var meta = {
    version: 2, activeProfileId: 'p1',
    profiles: [{ id:'p1', name:'我', createdAt:now, updatedAt:now }],
    emojiGroups: [], emojiPacks: [], savedMessages: [], contactGroups: [],
    contacts: [{ id:'c_e2e', name:'小满', remarkName:'小满',
                 createdAt:now, updatedAt:now, chatSettings:{} }],
    chats: [{ id:'chat_e2e', type:'single', contactId:'c_e2e', title:'小满',
              profileId:'p1', createdAt:now, updatedAt:now, chatSettings:{} }],
    messagesByChat: { 'chat_e2e': [] },
    shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

SECRET = "【绝密卷宗】我们约定过：小满最怕打雷，雷雨天要抱着她。"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(viewport=VIEWPORT, user_agent=UA)
        await ctx.add_init_script(SEED)
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(BASE, wait_until="domcontentloaded")
        await pg.wait_for_timeout(1600)

        print("=== 0) 准备：确认模块就位 ===")
        mods = await pg.evaluate("""() => ({
            appt: !!window.MiyaAppointmentStore,
            mem: !!window.MiyaAppointmentMemory,
            chat: !!window.miyaChatStore
        })""")
        print(f"    {mods}")
        check("MiyaAppointmentStore 已加载", mods["appt"])
        check("MiyaAppointmentMemory 已加载", mods["mem"])

        print("\n=== 1) 建一个线下卷宗，写入绝密内容 ===")
        built = await pg.evaluate("""(secret) => {
            var aps = window.MiyaAppointmentStore;
            var sess = aps.startNewSession('chat_e2e', 'c_e2e');
            if (!sess) return { err: 'no_session' };
            aps.addMessage('chat_e2e', sess.id, { role:'user', content: secret });
            aps.addMessage('chat_e2e', sess.id, { role:'assistant', content: '好，我记住了。' });
            aps.replaceOrAddSummary('chat_e2e', sess.id, {
              startIndex: 1, endIndex: 2, content: secret + '（总结）'
            });
            var s2 = aps.getSession('chat_e2e', sess.id);
            return {
              sessionId: sess.id,
              msgCount: (s2.messages || []).length,
              sumCount: (s2.summaryList || []).length
            };
        }""", SECRET)
        print(f"    {built}")
        check("卷宗建立成功", built.get("msgCount", 0) >= 2 and not built.get("err"))
        check("session 级总结已写入", built.get("sumCount", 0) >= 1)

        print("\n=== 2) 确认此刻线上记忆档案能读到（作为基线）===")
        before = await pg.evaluate("""(secret) => {
            var aps = window.MiyaAppointmentStore;
            var mem = window.MiyaAppointmentMemory;
            var exported = aps.exportForMemory('chat_e2e', 'c_e2e');
            var blocks = mem.buildOfflineSummaryBlocks(exported);
            var text = mem.buildSummaryBlocksText ? mem.buildSummaryBlocksText(blocks) : JSON.stringify(blocks);
            return { sessionCount: exported.length, hasSecret: String(text).indexOf('绝密卷宗') >= 0, len: String(text).length };
        }""", SECRET)
        print(f"    {before}")
        check("基线：删除前能读到绝密内容", before["hasSecret"])

        print("\n=== 3) 走真实删除流程：deleteSession ===")
        dele = await pg.evaluate("""(sid) => {
            var aps = window.MiyaAppointmentStore;
            aps.deleteSession('chat_e2e', sid);
            return {
              remainingSessions: aps.getSessions('chat_e2e').length,
              exported: aps.exportForMemory('chat_e2e', 'c_e2e').length
            };
        }""", built["sessionId"])
        print(f"    {dele}")
        check("删除后 getSessions 已空", dele["remainingSessions"] == 0)
        check("删除后 exportForMemory 已空", dele["exported"] == 0)

        print("\n=== 4) 【关键】删除后再次构造线上记忆档案 ===")
        after = await pg.evaluate("""() => {
            var aps = window.MiyaAppointmentStore;
            var mem = window.MiyaAppointmentMemory;
            var exported = aps.exportForMemory('chat_e2e', 'c_e2e');
            var blocks = mem.buildOfflineSummaryBlocks(exported);
            var text = mem.buildSummaryBlocksText ? mem.buildSummaryBlocksText(blocks) : JSON.stringify(blocks);
            var out = { sessionCount: exported.length, hasSecret: String(text).indexOf('绝密卷宗') >= 0, len: String(text).length };
            /* 也试跨场景记忆通道 */
            try {
              var cm = mem.buildOnlineCrossMemory('chat_e2e', { id:'c_e2e', name:'小满' }, { id:'p1' }, {});
              var cmText = JSON.stringify((cm && cm.slotItems) || []);
              out.crossHasSecret = cmText.indexOf('绝密卷宗') >= 0;
              out.crossSlotCount = ((cm && cm.slotItems) || []).length;
            } catch (e) { out.crossErr = String(e && e.message); }
            return out;
        }""")
        print(f"    {after}")
        check("删除后 session 级导出已空", after["sessionCount"] == 0)
        check("删除后记忆档案不再含绝密内容", not after["hasSecret"], f"len={after['len']}")
        check("删除后跨场景记忆通道也不含", not after.get("crossHasSecret", False),
              f"slots={after.get('crossSlotCount')}")

        print("\n=== 5) 【复活测试】模拟重启：重新 load 后镜像是否把卷宗带回来 ===")
        revive = await pg.evaluate("""() => {
            var aps = window.MiyaAppointmentStore;
            /* 触发一次镜像恢复（真实代码路径） */
            var rec = null;
            try { rec = aps.recoverFromChatMirrors ? aps.recoverFromChatMirrors() : null; } catch (e) {}
            aps.invalidateCache();
            var after = aps.getSessions('chat_e2e');
            aps.syncAllSessionsToChat('chat_e2e', 'c_e2e');
            var exported = aps.exportForMemory('chat_e2e', 'c_e2e');
            var mem = window.MiyaAppointmentMemory;
            var blocks = mem.buildOfflineSummaryBlocks(exported);
            var text = mem.buildSummaryBlocksText ? mem.buildSummaryBlocksText(blocks) : JSON.stringify(blocks);
            return {
              sessionsAfterInvalidate: after.length,
              exportedAfterSync: exported.length,
              hasSecret: String(text).indexOf('绝密卷宗') >= 0,
              recovered: rec && rec.byChat ? Object.keys(rec.byChat).length : null
            };
        }""")
        print(f"    {revive}")
        if revive["sessionsAfterInvalidate"] > 0 or revive["hasSecret"]:
            print("    ⚠️ 卷宗被复活了")
        check("镜像恢复后卷宗未被复活", revive["sessionsAfterInvalidate"] == 0,
              f"sessions={revive['sessionsAfterInvalidate']}")
        check("复活后记忆档案不含绝密内容", not revive["hasSecret"])

        print(f"\n    页面错误数：{len(errors)}")
        for e in errors[:5]:
            print(f"      · {e}")

        print(f"\n{'='*56}\n通过 {len(passed)} / {len(passed)+len(failed)}")
        if failed:
            print("失败项（= 已复现的问题）：")
            for f in failed:
                print("  ✗", f)
        await browser.close()
        return 1 if failed else 0


rc = asyncio.run(main())
raise SystemExit(rc)
