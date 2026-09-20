#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「切换对话 API 模型」回归测试（第六批）

缺陷现象（用户原话）
--------------------
「对话 api 设置里的预设现在虽然能切换了，但是我切换模型，
  却也出现了保存不了的问题。」

定位：同一家族的第三个成员。预设下拉的三层防御（渲染带选项 /
render 后 hydrate / apiPresetPick 记忆）只覆盖了**预设**下拉，
模型下拉（#mq-api-model / #mq-api2-model）一个都没有：

  A. 模型列表只活在 DOM —— 点 ⟳ 拉回来填进 <select>，render() 一整块
     换 innerHTML 就没了；applySubViewHydrate 只补预设下拉。
     「拉列表 → 切到新模型 → 点顶部保存（触发重绘）→ 再点保存」
     写回的是旧模型 —— 与预设当年「切换后保存被回退」一模一样。

  B. <select> 赋值静默失败 —— 载入预设时 set('#mq-api-model', p.model)，
     下拉里没有这个 option（没拉过列表时必然没有），value 被置空；
     用户随后点「保存」，model='' 写进配置，把预设刚生效的模型清掉。

  C. fetchChatModels.applyOptions —— 当前模型不在拉取列表里时退回
     占位项（''），用户点一次 ⟳ 已选模型就没了，再点保存同样清空。

修复（与预设同款三层防御 + select 保值）
--------------------------------------
  1. renderApiChatSub 渲染时同步带 miyaApiModelCache 缓存列表；
  2. applySubViewHydrate 补 hydrateChatModelOptions()（幂等回填）；
  3. state.apiModelPick / apiModel2Pick 草稿跨重绘留存
     （change 记录、保存/载入预设同步、open/close 清理）；
  4. setSelectValueKeepingOption：option 不存在先追加再赋值；
     applyOptions 当前值不在列表里时追加保住，不退 ''。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/api_model_switch.py
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

A_BASE, A_KEY = "https://api.A.example", "sk-AAAA"
MODELS = ["alpha-mini", "beta-pro", "gamma-max"]     # /models 返回的列表
OUTSIDER = "legacy-model"                            # 不在列表里的既有模型

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
  try {
    localStorage.setItem('miya-chat-meta', JSON.stringify(meta));
  } catch(e){}
})();
"""

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def wait_ready(pg, sel='[data-mq-set-sub="api-chat"]', tmo=15000):
    await pg.wait_for_selector(sel, state="attached", timeout=tmo)


async def boot(pg):
    await pg.evaluate("""
    (async function(){
      var st = window.miyaChatStore; await st.init();
      window.miyaChatApp.open();
      await new Promise(function(r){ setTimeout(r, 800); });
      window.miyaChatContactSettings.open('chat1');
    })()""")
    await pg.wait_for_timeout(900)
    await wait_ready(pg)


async def enter(pg):
    await pg.evaluate("""
    () => {
      var page = document.getElementById('mq-set-page');
      if (!page) return;
      if (page.querySelector('[data-mq-set-sub]')) return;
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
    """保存子视图表单。

    子视图底部那个「保存」（[data-mq-set-sub-save]）已按需求删除，
    现在 api-chat / api-voice 的**唯一**保存入口是顶栏「保存」：
    saveForm() 在 state.subView 为 api-chat / api-voice 时会转走
    saveSubViewForm(state.subView)，与旧按钮**同一条落库链路**。
    """
    await pg.evaluate(
        "() => { var b=document.querySelector('#mq-set-page [data-mq-set-save]'); if (b) b.click(); }")
    await pg.wait_for_timeout(1400)


async def top_save(pg):
    """点顶部导航栏的「保存」（data-mq-set-save）→ saveForm → scheduleRender → 整块重绘。"""
    await pg.evaluate(
        "() => { var b=document.querySelector('#mq-set-page [data-mq-set-save]'); if (b) b.click(); }")
    await pg.wait_for_timeout(1600)


async def fetch_models(pg, which="main"):
    await pg.click(f"#mq-api{'2' if which != 'main' else ''}-fetch")
    await pg.wait_for_timeout(1200)


async def cfg(pg):
    return await pg.evaluate("() => window.miyaGetApiConfigCached()")


async def model_state(pg, which="main"):
    return await pg.evaluate("""
    (w) => {
      var p = document.getElementById('mq-set-page');
      var sel = p.querySelector(w === 'main' ? '#mq-api-model' : '#mq-api2-model');
      if (!sel) return { val: null, opts: null };
      return { val: sel.value,
               opts: Array.from(sel.options).map(o => o.value) };
    }""", which)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(user_agent=UA, viewport=VIEWPORT,
                                  has_touch=True, is_mobile=True)
        # /models 网关桩：返回固定列表，Authorization 不校验
        await ctx.route("**/models",
                        lambda route: route.fulfill(
                            content_type="application/json",
                            body=json.dumps({"data": [{"id": m} for m in MODELS]})))
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4500)
        # 缓存/预设只清这一次 —— 之后场景6的 reload 靠它们验证持久化
        await pg.evaluate("""
        () => {
          try {
            localStorage.removeItem('miya-api-model-cache-v1');
            localStorage.removeItem('miya-api-presets');
          } catch(e){}
        }""")

        await boot(pg)
        await enter(pg)
        # 起始状态：正式配置为线路A、旧模型 alpha-mini
        await pg.evaluate("(c) => window.miyaSetApiConfig(c)",
                          {"baseUrl": A_BASE, "apiKey": A_KEY, "model": "alpha-mini"})
        await pg.wait_for_timeout(500)
        await back(pg)
        await enter(pg)
        st0 = await model_state(pg)
        check("起始：下拉选中旧模型 alpha-mini", st0["val"] == "alpha-mini", str(st0["val"]))

        # ══════════════════════════════════════════════════════════
        print("\n【1】核心：拉列表 → 切到新模型 → 顶部保存(重绘) → 子视图保存")
        await fetch_models(pg)
        st1 = await model_state(pg)
        check("点 ⟳ 后下拉带出完整列表", st1["opts"] == [""] + MODELS, str(st1["opts"]))
        check("拉列表后当前模型仍选中", st1["val"] == "alpha-mini", str(st1["val"]))

        await pg.select_option("#mq-api-model", "beta-pro")
        await pg.wait_for_timeout(400)
        st1b = await model_state(pg)
        check("已切到新模型 beta-pro", st1b["val"] == "beta-pro", str(st1b["val"]))

        # ★ 顶部「保存」触发整块重绘 —— 修复前下拉只剩 [alpha-mini] 且选中回退
        await top_save(pg)
        st1c = await model_state(pg)
        check("★ 顶部保存重绘后列表仍在（不丢缓存列表）",
              st1c["opts"] == [""] + MODELS, str(st1c["opts"]))
        check("★ 重绘后选中的仍是 beta-pro（草稿跨重绘留存）",
              st1c["val"] == "beta-pro", str(st1c["val"]))

        await save(pg)
        c1 = await cfg(pg)
        check("★ 子视图保存后，正式配置的 model 落盘为 beta-pro",
              c1.get("model") == "beta-pro", f"实际 {c1.get('model')}")
        disk1 = await pg.evaluate(
            "async () => await window.miyaReadLsJsonKey('miya-api-config', null)")
        check("★ 磁盘上的 model 也是 beta-pro",
              disk1.get("model") == "beta-pro", str(disk1.get("model")))

        # ══════════════════════════════════════════════════════════
        print("\n【2】拉列表切换后，返回重进 → 列表与选中都保住")
        await pg.select_option("#mq-api-model", "gamma-max")
        await pg.wait_for_timeout(400)
        await back(pg)
        await enter(pg)
        st2 = await model_state(pg)
        check("★ 重进后模型列表仍在（缓存渲染，无需再点 ⟳）",
              st2["opts"] == [""] + MODELS, str(st2["opts"]))
        check("★ 重进后选中仍是 gamma-max", st2["val"] == "gamma-max", str(st2["val"]))
        await save(pg)
        c2 = await cfg(pg)
        check("★ 重进后保存，落盘 gamma-max", c2.get("model") == "gamma-max",
              f"实际 {c2.get('model')}")

        # ══════════════════════════════════════════════════════════
        print("\n【3】载入带模型的预设 → 立即点保存，模型不得被清空（Bug B）")
        # 当前表单（gamma-max）存为预设「带模型」
        await pg.fill("#mq-api-preset-name", "带模型")
        await pg.click("#mq-api-preset-save")
        await pg.wait_for_timeout(1000)
        # 正式配置切回旧模型 alpha-mini（模拟用户之前的状态）
        await pg.evaluate("() => window.miyaSetApiConfig({ model: 'alpha-mini' })")
        await pg.wait_for_timeout(500)
        await back(pg)
        await enter(pg)
        st3a = await model_state(pg)
        check("载入前：下拉是 alpha-mini", st3a["val"] == "alpha-mini", str(st3a["val"]))

        await pg.select_option("#mq-api-preset-pick", "带模型")
        await pg.wait_for_timeout(1200)
        st3b = await model_state(pg)
        check("★ 载入预设后表单显示 gamma-max（option 不存在也不落空）",
              st3b["val"] == "gamma-max", str(st3b["val"]))
        c3a = await cfg(pg)
        check("载入预设即刻生效（model=gamma-max）",
              c3a.get("model") == "gamma-max", f"实际 {c3a.get('model')}")

        # ★ 关键：随后点保存 —— 修复前 model='' 会把刚生效的模型清空
        await save(pg)
        c3 = await cfg(pg)
        check("★ 载入预设后点保存，model 仍是 gamma-max（不被清空）",
              c3.get("model") == "gamma-max", f"实际 {c3.get('model')!r}")
        disk3 = await pg.evaluate(
            "async () => await window.miyaReadLsJsonKey('miya-api-config', null)")
        check("★ 磁盘上的 model 没被清空", disk3.get("model") == "gamma-max",
              str(disk3.get("model")))

        # ══════════════════════════════════════════════════════════
        print("\n【4】拉取列表不含当前模型时，选中值保住（Bug C）")
        # 配置一个不在 /models 返回列表里的既有模型
        await pg.evaluate("() => window.miyaSetApiConfig({ model: 'legacy-model' })")
        await pg.wait_for_timeout(500)
        await back(pg)
        await enter(pg)
        st4a = await model_state(pg)
        check(" outsider 模型显示在表单上", st4a["val"] == OUTSIDER, str(st4a["val"]))

        await fetch_models(pg)
        st4b = await model_state(pg)
        check("★ 拉列表后 outsider 模型仍选中（追加 option 而非退空）",
              st4b["val"] == OUTSIDER, str(st4b["val"]))
        check("★ outsider 出现在列表里（保底追加）",
              OUTSIDER in (st4b["opts"] or []), str(st4b["opts"]))
        await save(pg)
        c4 = await cfg(pg)
        check("★ 拉列表后保存，model 不被清空（仍 legacy-model）",
              c4.get("model") == OUTSIDER, f"实际 {c4.get('model')!r}")

        # ══════════════════════════════════════════════════════════
        print("\n【5】副线路模型同款语义")
        # 副线路要先有线路信息并拉一次列表，下拉才会有可选模型
        await pg.fill("#mq-api2-base", A_BASE)
        await pg.fill("#mq-api2-key", A_KEY)
        await pg.click("#mq-api2-fetch")
        await pg.wait_for_timeout(1200)
        st5a = await model_state(pg, "fallback")
        check("副线路拉列表后选项就位", st5a["opts"] == [""] + MODELS, str(st5a["opts"]))
        await pg.select_option("#mq-api2-model", "beta-pro")
        await pg.wait_for_timeout(400)
        await top_save(pg)
        st5 = await model_state(pg, "fallback")
        check("★ 副线路：顶部保存重绘后选中仍是 beta-pro",
              st5["val"] == "beta-pro", str(st5["val"]))
        check("★ 副线路：重绘后列表仍在", st5["opts"] == [""] + MODELS, str(st5["opts"]))
        await save(pg)
        c5 = await cfg(pg)
        check("★ 副线路保存后 fallbackModel 落盘 beta-pro",
              c5.get("fallbackModel") == "beta-pro", f"实际 {c5.get('fallbackModel')!r}")

        # ══════════════════════════════════════════════════════════
        print("\n【6】整页刷新后：模型列表与落盘值一致（真持久化）")
        await pg.reload(wait_until="load")
        await pg.wait_for_timeout(4500)
        await boot(pg)
        await enter(pg)
        st6 = await model_state(pg)
        # legacy-model 是刷新后的生效模型：按保值规则必须出现在 options 里
        check("★ 刷新后下拉带出缓存列表",
              st6["opts"] == [""] + MODELS + [OUTSIDER], str(st6["opts"]))
        check("★ 刷新后选中 legacy-model（与磁盘一致）",
              st6["val"] == OUTSIDER, str(st6["val"]))
        await save(pg)
        c6 = await cfg(pg)
        check("★ 刷新后保存，model 保持 legacy-model",
              c6.get("model") == OUTSIDER, f"实际 {c6.get('model')!r}")

        # ══════════════════════════════════════════════════════════
        print("\n【7】反向护栏：外部改了 model，重进面板必须跟随")
        await pg.evaluate("() => window.miyaSetApiConfig({ model: 'alpha-mini' })")
        await pg.wait_for_timeout(500)
        await back(pg)
        await enter(pg)
        st7 = await model_state(pg)
        check("★ 外部改回 alpha-mini 后重进，表单跟随（草稿已随保存对齐）",
              st7["val"] == "alpha-mini", str(st7["val"]))
        await save(pg)
        c7 = await cfg(pg)
        check("★ 未编辑直接保存写回 alpha-mini",
              c7.get("model") == "alpha-mini", f"实际 {c7.get('model')!r}")

        # ══════════════════════════════════════════════════════════
        print("\n【8】换会话不带未保存的模型草稿")
        # 场景6的 reload 触发 SEED 清掉了模型缓存，先拉一次列表再切换
        await fetch_models(pg)
        st8a = await model_state(pg)
        check("场景8前置：列表已就位", st8a["opts"] == [""] + MODELS, str(st8a["opts"]))
        await pg.select_option("#mq-api-model", "gamma-max")
        await pg.wait_for_timeout(400)
        # 关闭整个设置页（close()）再重开 —— 草稿应清空
        await pg.evaluate("() => window.miyaChatContactSettings.close()")
        await pg.wait_for_timeout(600)
        await pg.evaluate("() => window.miyaChatContactSettings.open('chat1')")
        await pg.wait_for_timeout(900)
        await wait_ready(pg)
        await enter(pg)
        st8 = await model_state(pg)
        check("★ 重开设置页后，未保存的 gamma-max 草稿被丢弃（回 alpha-mini）",
              st8["val"] == "alpha-mini", str(st8["val"]))
        await save(pg)
        c8 = await cfg(pg)
        check("★ 此时保存写回的是 alpha-mini（不带旧草稿）",
              c8.get("model") == "alpha-mini", f"实际 {c8.get('model')!r}")

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
