#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「切换对话 API 预设」语义回归测试

⚠️ 本文件在第二轮修复后**已改写为「选中即生效」语义**。

历史
----
第一轮：把症状当成「载入=预览，点保存才生效」下的中间态丢失，加了子视图草稿。
        能修好症状，但那是给一个多余设计打补丁。

第二轮：拿到旧包（karinn-imagegen-v5）做基线对比，发现**旧实现压根没有中间态**：
            // js2/miya-settings-app.js  miya-st-preset-pick change
            setApiConfig(pr.config);   // ← 选中即刻写正式配置
            syncFormsFromConfig();
        旧版「好用」的根本原因是设计上就没有可丢的中间态。
        于是对齐旧包：载入 = 写配置 + 落盘 + 同步表单，撤掉整套草稿机制。

另外修掉草稿机制引入的副作用（用户反馈）：
    「一点保存，保存的预设都没了，但重进又会显示出来」
    —— applySubViewDraft 会拿草稿回填下拉框，与重绘后重建 option 时序错位，
       把列表刷成空。数据在盘里没问题，所以重进又正常。撤掉草稿即消失。

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
    await wait_ready(pg)
    await pg.evaluate(
        "(c) => window.miyaSetApiConfig({ baseUrl: c.b, apiKey: c.k })",
        {"b": A_BASE, "k": A_KEY})
    await pg.wait_for_timeout(500)


async def wait_ready(pg, sel='[data-mq-set-sub="api-chat"]', tmo=15000):
    """等设置页的**异步首屏渲染**落定。

    render(opts) 是异步的（scheduleRender + 可能 await 配置水合），
    打开设置页的一瞬间 body 里只有「加载中…」。直接对尚未挂载的
    导航项点击会命中 30s 超时 —— 这是测试自身的等待缺口，不是产品缺陷。
    """
    await pg.wait_for_selector(sel, state="attached", timeout=tmo)


async def enter(pg):
    """进入对话 API 子视图。"""
    # 若还停在别的子视图，先退回根层级（点返回键而不是猜 DOM）
    await pg.evaluate("""
    () => {
      var page = document.getElementById('mq-set-page');
      if (!page) return;
      if (page.querySelector('[data-mq-set-sub]')) return;   // 已根层级
      var bk = page.querySelector('[data-mq-set-back]');
      if (bk) bk.click();
    }""")
    await pg.wait_for_timeout(600)
    await wait_ready(pg)
    await pg.click('[data-mq-set-sub="api-chat"]')
    # 子视图底部保存键已移除，改等表单主体出现（接口预设下拉是稳定的锚点）
    await pg.wait_for_selector('#mq-api-preset-pick', state="attached", timeout=15000)
    await pg.wait_for_timeout(1200)


async def back(pg):
    await pg.evaluate(
        "() => { var b = document.querySelector('#mq-set-page [data-mq-set-back]'); if (b) b.click(); }")
    await pg.wait_for_timeout(900)


async def save(pg):
    """保存子视图表单 —— 走顶栏「保存」。

    子视图底部那个「保存」（[data-mq-set-sub-save]）已按需求删除；
    api-chat / api-voice 现在唯一的保存入口是顶栏，
    saveForm() 会自动转走 saveSubViewForm()，落库链路不变。
    """
    await pg.evaluate(
        "() => { var b=document.querySelector('#mq-set-page [data-mq-set-save]'); if (b) b.click(); }")
    await pg.wait_for_timeout(1400)


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
      /* 子视图底部保存键已删除 —— 改点顶栏「保存」，
         saveForm() 在 api-chat 子视图内会转走 saveSubViewForm()。 */
      p.querySelector('[data-mq-set-save]').click();
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
        print("\n【1】核心：选中预设即刻生效（对齐旧包语义，无需再点保存）")
        c0 = await cfg(pg)
        check("起始正式配置为线路A", c0.get("baseUrl") == A_BASE, str(c0.get("baseUrl")))

        await pg.select_option("#mq-api-preset-pick", "线路B")
        await pg.wait_for_timeout(1200)
        f1 = await form(pg)
        check("载入后表单显示线路B", f1["base"] == B_BASE, str(f1["base"]))

        # ★ 关键差异：还没有点任何保存，正式配置就应该已经变了
        c1 = await cfg(pg)
        check("★ 仅选中预设，正式配置立刻变成线路B（URL）",
              c1.get("baseUrl") == B_BASE, f"实际 {c1.get('baseUrl')}")
        check("★ 仅选中预设，正式配置立刻变成线路B（key）",
              c1.get("apiKey") == B_KEY, f"实际 {c1.get('apiKey')}")

        disk1 = await pg.evaluate(
            "async () => await window.miyaReadLsJsonKey('miya-api-config', null)")
        check("★ 已落盘（刷新也不会丢）",
              disk1.get("baseUrl") == B_BASE, str(disk1.get("baseUrl")))

        await back(pg)
        await enter(pg)
        f2 = await form(pg)
        check("★ 返回后重进，表单仍是线路B（重绘不影响已生效的配置）",
              f2["base"] == B_BASE, str(f2["base"]))
        check("★ 密钥也一并保持", f2["key"] == B_KEY, str(f2["key"]))

        # ══════════════════════════════════════════════════════════
        print("\n【2】跨子视图：切到语音合成再回来，配置仍是切换后的")
        await pg.select_option("#mq-api-preset-pick", "线路A")
        await pg.wait_for_timeout(1200)
        await back(pg)
        await pg.click('[data-mq-set-sub="api-voice"]')
        await pg.wait_for_timeout(1200)
        await back(pg)
        await enter(pg)
        f3 = await form(pg)
        check("★ 绕道别的子视图回来，表单仍是线路A",
              f3["base"] == A_BASE, str(f3["base"]))
        c2 = await cfg(pg)
        check("★ 正式配置也是线路A（无需点保存）",
              c2.get("baseUrl") == A_BASE, f"实际 {c2.get('baseUrl')}")

        # ══════════════════════════════════════════════════════════
        print("\n【3】手改字段：点保存后才生效（这条路径保留「保存」语义）")
        await pg.fill("#mq-api-base", B_BASE)
        await pg.fill("#mq-api-key", B_KEY)
        await pg.wait_for_timeout(400)
        c3a = await cfg(pg)
        check("未点保存时正式配置不变（仍是线路A）",
              c3a.get("baseUrl") == A_BASE, f"实际 {c3a.get('baseUrl')}")
        await save(pg)
        c3 = await cfg(pg)
        check("★ 点保存后生效的是手改的线路B",
              c3.get("baseUrl") == B_BASE, f"实际 {c3.get('baseUrl')}")

        # ══════════════════════════════════════════════════════════
        print("\n【4】反向护栏：外部改了正式配置，面板必须跟随（不能锁死）")
        await pg.evaluate(
            "(c) => window.miyaSetApiConfig({ baseUrl: c.b, apiKey: c.k })",
            {"b": A_BASE, "k": A_KEY})
        await pg.wait_for_timeout(500)
        await back(pg)
        await enter(pg)
        f5 = await form(pg)
        check("★ 外部改了正式配置后重进，表单跟随新值（没有被任何缓存锁住）",
              f5["base"] == A_BASE, str(f5["base"]))
        await save(pg)
        c4 = await cfg(pg)
        check("★ 未编辑直接保存，写回的仍是线路A",
              c4.get("baseUrl") == A_BASE, f"实际 {c4.get('baseUrl')}")

        # ══════════════════════════════════════════════════════════
        print("\n【5】整页刷新后仍是切换的线路（真持久化）")
        pg2 = await ctx.new_page()
        await pg2.add_init_script(SEED)
        await pg2.goto(BASE, wait_until="load")
        await pg2.wait_for_timeout(4500)
        await pg2.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 800); });
          window.miyaChatContactSettings.open('chat1');
        })()""")
        await pg2.wait_for_timeout(900)
        await wait_ready(pg2)
        await pg2.click('[data-mq-set-sub="api-chat"]')
        # 子视图底部保存键已移除，改等表单主体出现
        await pg2.wait_for_selector('#mq-api-preset-pick', state="attached", timeout=15000)
        await pg2.wait_for_timeout(1600)
        f6 = await pg2.evaluate("""
        (function(){
          var p = document.getElementById('mq-set-page');
          function v(id){ var e = p.querySelector('#'+id); return e ? e.value : null; }
          return { base: v('mq-api-base'), key: v('mq-api-key'),
                   opts: Array.from(p.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value) };
        })()""")
        check("★ 刷新后仍是线路A（切换已落盘）",
              f6["base"] == A_BASE, str(f6["base"]))
        check("★ 刷新后预设列表完整（两条都在）",
              f6["opts"] == ["", "线路A", "线路B"], str(f6["opts"]))
        await pg2.close()

        # ══════════════════════════════════════════════════════════
        print("\n【6】点顶部导航栏「保存」不得清空预设列表（用户实测症状）")
        await enter(pg)
        # 先把选中项确定成线路B，再观察顶部保存的影响
        await pg.select_option("#mq-api-preset-pick", "线路B")
        await pg.wait_for_timeout(1200)
        opts_before = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("保存前预设列表完整", opts_before == ["", "线路A", "线路B"], str(opts_before))
        pick_before = await pg.evaluate(
            "() => { var e=document.querySelector('#mq-api-preset-pick'); return e?e.value:null; }")
        check("保存前下拉有选中项", pick_before == "线路B", str(pick_before))

        # ★ 关键：点的是**顶部导航栏**那个「保存」（data-mq-set-save）。
        #   子视图表单底部那个（data-mq-set-sub-save）已按需求删除，
        #   顶栏现在是 api-chat / api-voice 的唯一保存入口。
        #   它会走 saveForm() → scheduleRender({fromStore:true}) → render()，
        #   而 render() 的子视图分支只换 innerHTML、不做 hydrate。
        await pg.evaluate(
            "() => { var b=document.querySelector('#mq-set-page [data-mq-set-save]'); if (b) b.click(); }")
        await pg.wait_for_timeout(1600)
        opts_after = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("★ 点顶部「保存」后预设列表仍在（不再被清空）",
              opts_after == ["", "线路A", "线路B"], str(opts_after))
        pick_after = await pg.evaluate(
            "() => { var e=document.querySelector('#mq-api-preset-pick'); return e?e.value:null; }")
        check("★ 选中项不被重置", pick_after == "线路B", str(pick_after))

        cached = await pg.evaluate(
            "() => (window.miyaApiPresets.getCached()||[]).map(x=>x.name)")
        check("★ 内存里的预设也没丢", cached == ["线路A", "线路B"], str(cached))

        # 返回再进来一遍，确认没有累积损坏
        await back(pg)
        await enter(pg)
        opts_re = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("★ 返回重进后列表依然完整", opts_re == ["", "线路A", "线路B"], str(opts_re))

        # ══════════════════════════════════════════════════════════
        print("\n【7】子视图内保存（顶栏）同样不得清空预设列表")
        pick7 = await pg.evaluate(
            "() => { var e=document.querySelector('#mq-api-preset-pick'); return e?e.value:null; }")
        if pick7 != "线路B":
            await pg.select_option("#mq-api-preset-pick", "线路B")
            await pg.wait_for_timeout(1000)
        await save(pg)
        opts7 = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("★ 子视图内点顶栏「保存」后列表仍在", opts7 == ["", "线路A", "线路B"], str(opts7))
        pick7b = await pg.evaluate(
            "() => { var e=document.querySelector('#mq-api-preset-pick'); return e?e.value:null; }")
        check("★ 选中项仍是线路B", pick7b == "线路B", str(pick7b))

        # ══════════════════════════════════════════════════════════
        print("\n【8】冷启动：内存缓存清空后，子视图首帧就应带出选项")
        # 整页重载 → 内存缓存必然清空，预设只能从 IndexedDB 读。
        # 修复后 renderApiChatSub 渲染时同步带上缓存里已有的选项；
        # 即便 hydrate 异步段还没回来，下拉也不该是空的。
        await pg.reload(wait_until="load")
        await pg.wait_for_timeout(4500)
        await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 800); });
          window.miyaChatContactSettings.open('chat1');
        })()""")
        await wait_ready(pg)
        await pg.click('[data-mq-set-sub="api-chat"]')
        # 子视图底部保存键已移除，改等表单主体出现
        await pg.wait_for_selector('#mq-api-preset-pick', state="attached", timeout=15000)
        # ★ 0ms 同步采样：不等任何异步 hydrate。
        # 若渲染时没带上缓存选项，此刻下拉必然只有占位项
        # （ensureReady 走 IndexedDB 是宏任务，不可能已完成）。
        opts_first = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("★ 进入子视图的第一眼就有预设（同步渲染，不闪空）",
              opts_first == ["", "线路A", "线路B"], str(opts_first))
        # 再等异步 hydrate 落定，双重确认
        await pg.wait_for_timeout(900)
        opts_cold = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("★ 冷启动首帧下拉就带出全部预设（不再闪空）",
              opts_cold == ["", "线路A", "线路B"], str(opts_cold))

        # 冷启动下再点右上角保存 —— 双重确认
        await pg.evaluate(
            "() => { var b=document.querySelector('#mq-set-page [data-mq-set-save]'); if (b) b.click(); }")
        await pg.wait_for_timeout(1600)
        opts_cold2 = await pg.evaluate(
            "() => Array.from(document.querySelectorAll('#mq-api-preset-pick option')).map(o=>o.value)")
        check("★ 冷启动后点顶部「保存」列表仍在", opts_cold2 == ["", "线路A", "线路B"], str(opts_cold2))

        print("\n【9】全程无 JS 报错")
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
