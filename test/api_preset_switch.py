#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「切换对话 API 预设后点保存，却变回切换之前的 URL / key」回归测试

缺陷现象（用户原话）
--------------------
「我切换了对话 API 的预设，结果一点保存，却没切换成功，
  变回来切换之前的 URL 和 key。」

关键点：**保存本身没坏**。坏的是「切换」在保存之前就被抹掉了 ——
用户点保存时，表单里其实已经是切换前的那份，于是保存把旧值又写了一遍。

根因（三个环节缺一不可，所以现象很绕）
--------------------------------------
1. 「载入预设」按设计只改 DOM、**不动正式配置**
   （见 applyApiPresetToForm 的注释：「载入」是一次可反悔的预览，
    用户随后点「保存」才生效）。所以切换后的线路只活在 DOM 里。

2. render() 对子视图是**整块换 innerHTML**。而这些路径都会触发 render：
     · closeSubView()  —— 点返回
     · openSubView()   —— 切到别的子视图 / 再进来
     · open() 链里的异步 scheduleRender() —— **用户不动也会触发**
   任何一条发生，只活在 DOM 里的切换值被当场销毁。

3. renderApiChatSub() 重绘时的初值取自 miyaGetApiConfigCached()
   （**正式配置**，仍是切换前的旧线路）。

   → 载入线路B → 返回（B 被销毁）→ 再进来（表单按正式配置重绘成线路A）
     → 点保存 → 写回 A。用户看到「切了、保存了、又变回去了」，
     而且全程零提示，因为每一步都"成功"了。

修法
----
引入**子视图表单草稿** state.subViewDraft（思路与页面级 formDraft 一致）：
  · 载入预设 / 手改字段 → 写入草稿
  · render 进子视图：换 innerHTML **之前** captureSubViewDraft，
    换完 applySubViewDraft 回填
  · 点「保存」成功 → 清草稿（正式配置已等于表单，草稿使命结束）
  · 关掉整个设置页 / 换 chatId → 清草稿

特别记一笔（踩过的坑）：**不能**在 closeSubView() 里清草稿。
一开始按「返回 = 放弃编辑」的直觉清了，核心路径依然坏 ——
用户返回再进来看到被弹回的 A，自然会再点一次保存，照样把 A 写死。
正确语义是：未保存的表单内容应跨重绘存活。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/api_preset_switch.py
"""
import asyncio, json, sys
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
    profiles: [{ id: 'p1', name: '我', createdAt: now, updatedAt: now }],
    emojiGroups: [], emojiPacks: [], savedMessages: [],
    contactGroups: [{ id: 'ct-default', name: '默认', sort: 0, createdAt: now }],
    contacts: [{ id: 'c1', name: '小满', remarkName: '小满', groupId: 'ct-default',
      createdAt: now, updatedAt: now, chatSettings: {} }],
    chats: [{ id: 'chat1', type: 'single', contactId: 'c1', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now, chatSettings: {} }],
    messagesByChat: { 'chat1': [] }, shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

A_BASE, A_KEY = "https://api.A.example", "sk-AAAA"
B_BASE, B_KEY = "https://api.B.example", "sk-BBBB"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def boot(pg):
    """打开聊天设置 → 进对话 API 子视图，并把正式配置置成线路A。"""
    await pg.evaluate("""
    (async function(){
      var st = window.miyaChatStore; await st.init();
      window.miyaChatApp.open();
      await new Promise(function(r){ setTimeout(r, 800); });
      window.miyaChatContactSettings.open('chat1');
    })()""")
    await pg.wait_for_timeout(900)
    await pg.evaluate(
        "(c) => window.miyaSetApiConfig({ baseUrl: c.b, apiKey: c.k })",
        {"b": A_BASE, "k": A_KEY})
    await pg.wait_for_timeout(500)


async def enter(pg):
    await pg.click('[data-mq-set-sub="api-chat"]')
    await pg.wait_for_timeout(1500)


async def back(pg):
    await pg.evaluate(
        "() => { var b = document.querySelector('#mq-set-page [data-mq-set-back]'); if (b) b.click(); }")
    await pg.wait_for_timeout(900)


async def save(pg):
    await pg.click('[data-mq-set-sub-save="api-chat"]')
    await pg.wait_for_timeout(1200)


async def form(pg):
    return await pg.evaluate("""
    (function(){
      var p = document.getElementById('mq-set-page');
      function v(id){ var e = p.querySelector('#'+id); return e ? e.value : null; }
      return { base: v('mq-api-base'), key: v('mq-api-key'), name: v('mq-api-preset-name') };
    })()""")


async def cfg(pg):
    return await pg.evaluate("() => window.miyaGetApiConfigCached()")


async def make_presets(pg):
    """用界面真实操作存两条预设：线路A（当前生效）、线路B（要切过去的）。"""
    cfg_js = json.dumps({"ab": A_BASE, "ak": A_KEY, "bb": B_BASE, "bk": B_KEY})
    await pg.evaluate("""
    (async function(c){
      var p = document.getElementById('mq-set-page');
      function set(id, v){ var e = p.querySelector('#'+id); if (e) e.value = v; }
      set('mq-api-base', c.ab); set('mq-api-key', c.ak);
      p.querySelector('[data-mq-set-sub-save="api-chat"]').click();
      await new Promise(function(r){ setTimeout(r, 600); });
      set('mq-api-preset-name', '线路A');
      p.querySelector('#mq-api-preset-save').click();
      await new Promise(function(r){ setTimeout(r, 600); });
      set('mq-api-base', c.bb); set('mq-api-key', c.bk);
      set('mq-api-preset-name', '线路B');
      p.querySelector('#mq-api-preset-save').click();
      await new Promise(function(r){ setTimeout(r, 600); });
    })(""" + cfg_js + ")")
    await pg.wait_for_timeout(600)
    # 存预设的过程改动了表单与正式配置，把正式配置归位到 A，
    # 再返回重进 —— 让草稿清空、表单回到由正式配置渲染的状态
    await pg.evaluate(
        "(c) => window.miyaSetApiConfig({ baseUrl: c.b, apiKey: c.k })",
        {"b": A_BASE, "k": A_KEY})
    await pg.wait_for_timeout(500)
    await back(pg)
    await enter(pg)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(user_agent=UA, viewport=VIEWPORT,
                                  has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4500)

        await boot(pg)
        await enter(pg)
        await make_presets(pg)

        # ══════════════════════════════════════════════════════════
        print("\n【1】核心路径：切换预设 → 返回 → 再进来 → 点保存")
        c0 = await cfg(pg)
        check("起始正式配置为线路A", c0.get("baseUrl") == A_BASE, str(c0.get("baseUrl")))

        await pg.select_option("#mq-api-preset-pick", "线路B")
        await pg.wait_for_timeout(1000)
        f1 = await form(pg)
        check("载入后表单显示线路B", f1["base"] == B_BASE, str(f1["base"]))

        await back(pg)
        await enter(pg)
        f2 = await form(pg)
        check("★ 返回后重进，表单仍是线路B（曾经的失败点）",
              f2["base"] == B_BASE, str(f2["base"]))
        check("★ 密钥也一并保持", f2["key"] == B_KEY, str(f2["key"]))

        await save(pg)
        c1 = await cfg(pg)
        check("★ 点保存后生效的是线路B（URL）",
              c1.get("baseUrl") == B_BASE, f"实际 {c1.get('baseUrl')}")
        check("★ 点保存后生效的是线路B（key）",
              c1.get("apiKey") == B_KEY, f"实际 {c1.get('apiKey')}")

        disk1 = await pg.evaluate(
            "async () => await window.miyaReadLsJsonKey('miya-api-config', null)")
        check("落盘也是线路B（确认真的切成功了）",
              disk1.get("baseUrl") == B_BASE, str(disk1.get("baseUrl")))

        # ══════════════════════════════════════════════════════════
        print("\n【2】跨子视图：切到语音合成再回来，切换不丢")
        await pg.select_option("#mq-api-preset-pick", "线路A")
        await pg.wait_for_timeout(1000)
        await back(pg)
        await pg.click('[data-mq-set-sub="api-voice"]')
        await pg.wait_for_timeout(1200)
        await back(pg)
        await enter(pg)
        f3 = await form(pg)
        check("★ 绕道别的子视图回来，表单仍是线路A",
              f3["base"] == A_BASE, str(f3["base"]))
        await save(pg)
        c2 = await cfg(pg)
        check("★ 点保存后生效的是线路A",
              c2.get("baseUrl") == A_BASE, f"实际 {c2.get('baseUrl')}")

        # ══════════════════════════════════════════════════════════
        print("\n【3】手改字段：不经预设直接改，也不该被重绘抹掉")
        await pg.fill("#mq-api-base", B_BASE)
        await pg.fill("#mq-api-key", B_KEY)
        await pg.wait_for_timeout(400)
        # 模拟「后台某个流程调了一次 open() 重新进来」——用户没动界面也会发生
        await pg.evaluate(
            "() => window.miyaChatContactSettings.openSubViewForChat('chat1', 'api-chat')")
        await pg.wait_for_timeout(2500)
        f4 = await form(pg)
        check("★ 后台重进后，手改的值还在",
              f4["base"] == B_BASE, str(f4["base"]))
        await save(pg)
        c3 = await cfg(pg)
        check("★ 点保存后生效的是手改的线路B",
              c3.get("baseUrl") == B_BASE, f"实际 {c3.get('baseUrl')}")

        # ══════════════════════════════════════════════════════════
        print("\n【4】反向护栏：保存后草稿必须清干净，不能把表单锁死")
        await pg.evaluate(
            "(c) => window.miyaSetApiConfig({ baseUrl: c.b, apiKey: c.k })",
            {"b": A_BASE, "k": A_KEY})
        await pg.wait_for_timeout(500)
        await back(pg)
        await enter(pg)
        f5 = await form(pg)
        check("★ 外部改了正式配置后重进，表单跟随新值（没有被草稿锁住）",
              f5["base"] == A_BASE, str(f5["base"]))
        await save(pg)
        c4 = await cfg(pg)
        check("★ 未编辑直接保存，写回的仍是线路A（没被旧草稿污染）",
              c4.get("baseUrl") == A_BASE, f"实际 {c4.get('baseUrl')}")

        # ══════════════════════════════════════════════════════════
        print("\n【5】关掉设置页再进来，未保存的改动应被放弃")
        await pg.fill("#mq-api-base", B_BASE)
        await pg.wait_for_timeout(400)
        await pg.evaluate("() => window.miyaChatContactSettings.close()")
        await pg.wait_for_timeout(900)
        await pg.evaluate("""
        (async function(){
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 800); });
          window.miyaChatContactSettings.open('chat1');
        })()""")
        await pg.wait_for_timeout(900)
        await enter(pg)
        f6 = await form(pg)
        check("★ 关闭设置页后重进，回到正式配置线路A（未保存的B被放弃）",
              f6["base"] == A_BASE, str(f6["base"]))

        # ══════════════════════════════════════════════════════════
        print("\n【6】预设名与下拉选中值也不该在重绘后丢")
        await pg.select_option("#mq-api-preset-pick", "线路B")
        await pg.wait_for_timeout(1000)
        await back(pg)
        await enter(pg)
        f7 = await form(pg)
        check("重进后名称框仍带「线路B」（可直接覆盖保存）",
              f7["name"] == "线路B", str(f7["name"]))

        print("\n【7】全程无 JS 报错")
        check("无 pageerror", not errs, str(errs[:3]))

        await b.close()

    print(f"\n{'='*62}")
    print(f"通过 {len(passed)} / 共 {len(passed)+len(failed)}")
    if failed:
        print("失败项：")
        for f in failed:
            print("  -", f)
        return 1
    print("全部通过 ✅")
    return 0


sys.exit(asyncio.run(main()))
