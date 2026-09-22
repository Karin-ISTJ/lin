#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
端到端验证：主动消息的两道「礼貌门」在真实流程里生效
====================================================

test/proactive_courtesy_gates.py 验的是**函数逻辑**。
这个文件验的是另一件事：这两道门**真的挂在 triggerReply 上、真的会在
真实调用路径里拦住发送**。

为什么两件事都要验
──────────────
单测全绿但门上没接，是很常见的事故形态 —— 函数写得对，
`if (...)` 那一行漏了或写反了，功能就是没有。
所以这里从页面里真正调一次主动推送，看**副作用**。

怎么观测
────────
礼貌门是「静默跳过」：直接 resolve，不写 lastPushFailAt、
也不写 lastProactiveAttemptAt。所以判据是：

  · 门拦住   → 调用 resolve，lastProactiveAttemptAt **不变**
  · 门放行   → 调用会继续走下去，lastProactiveAttemptAt **被刷新**

这个「变 / 不变」就是最好的探针：不需要改动生产代码去暴露内部函数。

两个必须踩准的前提
──────────────────
1. **锚点必须在过去。** checkAll 走 active 分支要求
   `now - activeAnchor >= intervalMin*60000`。空会话时
   ensureProactiveBaseline 只会把锚点设成「现在」，永远差 0 毫秒，
   于是永远不触发 —— 那不是门拦的，是压根没走到门口。
   所以种子里塞一条一天前的消息，让 lastChatMessageTs 给出旧锚点。

2. **两类字段走两条不同的写入路径。** 这个项目里配置型与会话运行时字段
   是分开存的，混用会「存得进去、读不出来」：

     · 配置型（maxPerDay / activeEnabled / activeIntervalMin / quiet*）
       → 必须走 miyaChatGlobalSettings.savePerContact，登记为该联系人的覆盖。
         直接用 saveChatSettings 写会被 getChatSettings() 末尾的
         applyToChatSettings 用全局 slice 盖回模板默认值（maxPerDay 变 0）。

     · 会话运行时（dayKey / dayCount / lastProactiveAttemptAt / lastPushFailAt）
       → 必须走 saveChatSettings 写进 chat.chatSettings。
         它们已登记在 chatLevelBgKeys / CHAT_LEVEL_BM_KEYS 里，
         applyContactOverride 会主动剔除，所以走 savePerContact 反而会被丢掉。

另外说明为什么这里不断言「dayCount +1」：
计数只在**真的把消息发出去**（recordAutoPushAt 分支）时才 +1。
测试环境没有配 API，发送必然停在 api_not_configured 的失败路径上，
计数按设计不该动。所以「+1」这条断言放在单测里覆盖
（见 test/proactive_courtesy_gates.py 的 S15/S16），
这里只验两道门的拦/放行为 —— 那才是这个文件存在的意义。

运行
────
    MIYA_BASE=http://127.0.0.1:8077 python3 test/e2e_proactive_courtesy_gates.py
"""

import asyncio
import os
import sys

from playwright.async_api import async_playwright

BASE = os.environ.get("MIYA_BASE", "http://localhost:8098").rstrip("/") + "/index.html"
UA = (
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)
VIEWPORT = {"width": 412, "height": 915}

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


def note(msg):
    """提示信息，不计入通过/失败。"""
    print(f"  ℹ️  {msg}")


# ── 种子 ──
# 关键：会话里有一条**一天前**的消息，保证 active 分支的锚点足够旧。
SEED = """
(function(){
  var now = Date.now();
  var dayAgo = now - 24 * 3600 * 1000;
  var meta = {
    version: 2, activeProfileId: 'p1',
    profiles: [{ id: 'p1', name: '我', createdAt: now, updatedAt: now }],
    emojiGroups: [{ id: 'default', name: '默认', sort: 0, scope: 'global', contactIds: [] }],
    emojiPacks: [], savedMessages: [],
    contactGroups: [{ id: 'ct-default', name: '默认', sort: 0, createdAt: now }],
    contacts: [{
      id: 'c_gate', name: '小满', remarkName: '小满', groupId: 'ct-default',
      createdAt: now, updatedAt: now, chatSettings: {}
    }],
    chats: [{
      id: 'chat_gate', type: 'single', contactId: 'c_gate', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now,
      chatSettings: { backgroundMessage: { proactiveBaselineAt: dayAgo } }
    }],
    messagesByChat: {
      'chat_gate': [{
        id: 'm_seed', role: 'assistant', content: '（一天前的旧消息）',
        createdAt: dayAgo, updatedAt: dayAgo
      }]
    },
    shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""


# ── 写入辅助 ──
#
# 配置型字段：走 perContact 覆盖，否则被全局 slice 盖掉。
# 注意 savePerContact 的 settings.backgroundMessage 是**整体替换**该联系人的
# 配置切片，所以每次都要把想生效的字段一并传齐。
SET_CFG = """
(async function(patch){
    await window.miyaChatGlobalSettings.savePerContact('c_gate', {
        useGlobal: false,
        settings: { backgroundMessage: patch, memoryCount: 80 }
    });
    var s = window.miyaChatStore.getChatSettings('chat_gate') || {};
    var bg = s.backgroundMessage || {};
    return {
        maxPerDay: bg.maxPerDay,
        dayKey: bg.dayKey,
        dayCount: bg.dayCount,
        activeEnabled: bg.activeEnabled,
        activeIntervalMin: bg.activeIntervalMin
    };
})
"""

# 会话运行时字段：走 saveChatSettings 写 chat.chatSettings。
# 这两个走 savePerContact 会被 CHAT_LEVEL_BM_KEYS 主动剔掉。
SET_RUNTIME = """
(async function(patch){
    await window.miyaChatStore.saveChatSettings('chat_gate', {
        backgroundMessage: patch
    });
    var s = window.miyaChatStore.getChatSettings('chat_gate') || {};
    var bg = s.backgroundMessage || {};
    return {
        dayKey: bg.dayKey,
        dayCount: bg.dayCount,
        lastProactiveAttemptAt: Number(bg.lastProactiveAttemptAt || 0),
        maxPerDay: bg.maxPerDay
    };
})
"""

TODAY_KEY = """
(function(){
    var d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth()+1).padStart(2,'0') + '-' +
           String(d.getDate()).padStart(2,'0');
})()
"""


# 探针：踢一次扫描，读 lastProactiveAttemptAt 的变化
PROBE = """
(async function(){
    var store = window.miyaChatStore;
    function snap() {
        var s = store.getChatSettings('chat_gate') || {};
        var bg = s.backgroundMessage || {};
        return {
            attempt: Number(bg.lastProactiveAttemptAt || 0),
            fail: Number(bg.lastPushFailAt || 0),
            count: Number(bg.dayCount || 0),
            key: String(bg.dayKey || ''),
            maxPerDay: Number(bg.maxPerDay || 0)
        };
    }
    var before = snap();
    try { window.MiyaChatBackground.kickScan(); } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 1600); });
    var after = snap();
    return { before: before, after: after };
})()
"""


async def set_cfg(pg, patch):
    return await pg.evaluate(SET_CFG, patch)


async def set_runtime(pg, patch):
    return await pg.evaluate(SET_RUNTIME, patch)


async def probe(pg):
    return await pg.evaluate(PROBE)


def blocked(r):
    """门拦住的判据：attempt 没被刷新。"""
    return r["after"]["attempt"] == r["before"]["attempt"]


def passed_through(r):
    """门放行的判据：attempt 被刷新成新时间。"""
    return r["after"]["attempt"] > r["before"]["attempt"]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True
        )
        pg = await ctx.new_page()

        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4500)

        print("\n【0】前置：模块与种子数据就位")
        ready = await pg.evaluate(
            """(function(){
                return {
                    bg: !!(window.MiyaChatBackground && window.MiyaChatBackground.kickScan),
                    gs: !!(window.miyaChatGlobalSettings
                           && window.miyaChatGlobalSettings.savePerContact),
                    store: !!(window.miyaChatStore && window.miyaChatStore.getChatSettings),
                    chat: !!(window.miyaChatStore && window.miyaChatStore.findChat
                            && window.miyaChatStore.findChat('chat_gate')),
                    msgs: (function(){
                        try { return window.miyaChatStore.getMessages
                                     ? window.miyaChatStore.getMessages('chat_gate').length : -1; }
                        catch(e) { return -2; }
                    })()
                };
            })()"""
        )
        check("MiyaChatBackground 已加载", ready["bg"])
        check("miyaChatGlobalSettings 已加载", ready["gs"])
        check("store 可用", ready["store"])
        check("种子会话 chat_gate 存在", ready["chat"])
        check("种子消息存在", ready["msgs"] == 1, f"count={ready['msgs']}")

        # 基线配置：主动开、间隔 1 分钟、上限不限 —— 这时候应该能发出去
        cfg = await set_cfg(pg, {
            "activeEnabled": True,
            "activeIntervalMin": 1,
            "quietEnabled": False,
            "maxPerDay": 0,
        })
        check(
            "基线配置落库（上限 0 = 不限，主动开、间隔 1 分钟）",
            cfg.get("maxPerDay") == 0
            and cfg.get("activeEnabled") is True
            and cfg.get("activeIntervalMin") == 1,
            str(cfg),
        )

        print("\n【1】基线：无人干扰、不限次数 → 应放行")
        await set_runtime(pg, {"lastProactiveAttemptAt": 0, "lastPushFailAt": 0})
        r0 = await probe(pg)
        check(
            "放行：lastProactiveAttemptAt 被刷新",
            passed_through(r0),
            f"before={r0['before']['attempt']} after={r0['after']['attempt']}",
        )
        note(
            "说明：本文件不验 dayCount +1 —— 无 API 时发送停在失败路径，"
            "计数按设计不动（那条断言在单测 S15/S16）。"
        )

        print("\n【2】门 A：用户正在输入框里写字 → 应拦下")
        focus = await pg.evaluate(
            """(function(){
                var ta = document.createElement('textarea');
                ta.id = 'e2e-gate-probe-input';
                ta.value = '我正在打一段很长的回复，别插嘴';
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.focus();
                return {
                    focused: document.activeElement === ta,
                    tag: (document.activeElement || {}).tagName
                };
            })()"""
        )
        check("探针输入框已获焦点", focus["focused"], str(focus))
        check("activeElement 是 TEXTAREA", focus["tag"] == "TEXTAREA")

        # 关键：把 attempt 归零，否则会被 PROACTIVE_MIN_GAP_MS(60s) 先拦掉，
        # 那就测不到门 A 了。归零后若仍不刷新，只能是门 A 拦的。
        await set_runtime(pg, {"lastProactiveAttemptAt": 0, "lastPushFailAt": 0})
        r1 = await probe(pg)
        check(
            "打字中 → lastProactiveAttemptAt 未被刷新（门 A 拦住了）",
            blocked(r1),
            f"before={r1['before']['attempt']} after={r1['after']['attempt']}",
        )

        print("\n【3】门 A 解除：清空输入框 → 应放行")
        await pg.evaluate(
            """(function(){
                var ta = document.getElementById('e2e-gate-probe-input');
                if (ta) { ta.value = ''; ta.blur(); }
                return {
                    focused: document.activeElement === ta,
                    stillThere: !!document.getElementById('e2e-gate-probe-input')
                };
            })()"""
        )
        await pg.wait_for_timeout(200)
        await set_runtime(pg, {"lastProactiveAttemptAt": 0, "lastPushFailAt": 0})

        r2 = await probe(pg)
        check(
            "不写字了 → lastProactiveAttemptAt 被刷新（门 A 放行）",
            passed_through(r2),
            f"before={r2['before']['attempt']} after={r2['after']['attempt']}",
        )

        print("\n【4】门 B：每日上限 1、今天已用满 → 应拦下")
        today = await pg.evaluate(TODAY_KEY)
        cfg_b = await set_cfg(pg, {
            "activeEnabled": True,
            "activeIntervalMin": 1,
            "quietEnabled": False,
            "maxPerDay": 1,
        })
        # 运行时字段单独写：dayCount 记成今天已发 1 次
        rt_b = await set_runtime(pg, {
            "dayKey": today,
            "dayCount": 1,
            "lastProactiveAttemptAt": 0,
            "lastPushFailAt": 0,
        })
        check("上限配置落库（maxPerDay=1）", cfg_b.get("maxPerDay") == 1, str(cfg_b))
        check(
            "今天的计数落库（dayKey=今天 / dayCount=1）",
            rt_b.get("dayKey") == today and rt_b.get("dayCount") == 1,
            str(rt_b),
        )

        r3 = await probe(pg)
        check(
            "今天已满额 → lastProactiveAttemptAt 未被刷新（门 B 拦住了）",
            blocked(r3),
            f"before={r3['before']['attempt']} after={r3['after']['attempt']}",
        )

        print("\n【5】门 B 解除：上限提高 → 应放行")
        cfg_c = await set_cfg(pg, {
            "activeEnabled": True,
            "activeIntervalMin": 1,
            "quietEnabled": False,
            "maxPerDay": 99,
        })
        await set_runtime(pg, {
            "dayKey": today,
            "dayCount": 1,
            "lastProactiveAttemptAt": 0,
            "lastPushFailAt": 0,
        })
        check("上限提到 99", cfg_c.get("maxPerDay") == 99, str(cfg_c))

        r4 = await probe(pg)
        check(
            "上限提高到 99 → lastProactiveAttemptAt 被刷新（门 B 放行）",
            passed_through(r4),
            f"before={r4['before']['attempt']} after={r4['after']['attempt']}",
        )

        print("\n【6】跨天归零 → 应放行")
        rt_d = await set_runtime(pg, {
            "dayKey": "1999-01-01",   # 昨天的残留
            "dayCount": 999,
            "lastProactiveAttemptAt": 0,
            "lastPushFailAt": 0,
        })
        check(
            "昨日残留计数已写入（但 dayKey 不是今天）",
            rt_d.get("dayKey") == "1999-01-01" and rt_d.get("dayCount") == 999,
            str(rt_d),
        )

        r5 = await probe(pg)
        check(
            "昨日残留计数不拦今天的发送（跨天作废）",
            passed_through(r5),
            f"before={r5['before']['attempt']} after={r5['after']['attempt']}",
        )

        print("\n【7】无页面异常")
        real = [e for e in errors if "favicon" not in e.lower()]
        check("运行期间无未捕获异常", len(real) == 0, "; ".join(real[:3]))

        await browser.close()

    print("\n" + "=" * 62)
    print(f"  结果：{len(passed)} 通过 / {len(failed)} 失败")
    if failed:
        print("  失败项：")
        for f in failed:
            print("    · " + f)
    print("=" * 62)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
