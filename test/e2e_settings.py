#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
端到端验证：新的「记忆与后台」与「模型高级」分区
1. 打开角色聊天设置的对应入口
2. 检查两个新分区是否渲染
3. 改值 → 保存 → 重开 → 值是否留住
4. lifeLike 与定时主动消息的互斥反馈
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
    profiles: [{ id: 'p1', name: '我', createdAt: now, updatedAt: now }],
    emojiGroups: [{ id: 'default', name: '默认', sort: 0, scope: 'global', contactIds: [] }],
    emojiPacks: [], savedMessages: [],
    contactGroups: [{ id: 'ct-default', name: '默认', sort: 0, createdAt: now }],
    contacts: [{ id: 'c_e2e', name: '小满', remarkName: '小满', groupId: 'ct-default',
      createdAt: now, updatedAt: now, chatSettings: {} }],
    chats: [{ id: 'chat_e2e', type: 'single', contactId: 'c_e2e', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now, chatSettings: {} }],
    messagesByChat: { 'chat_e2e': [] }, shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True
        )
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)

        print("\n【1】直接以模块 API 打开聊天设置，检查新分区渲染")
        r = await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore;
          await st.init();
          var mod = window.miyaChatContactSettings;
          if (!mod) return {error: 'no miyaChatContactSettings'};
          mod.open('chat_e2e');
          await new Promise(function(r){ setTimeout(r, 700); });
          var page = document.getElementById('mq-set-page');
          if (!page) return {error: 'no page'};
          var zones = [];
          page.querySelectorAll('[data-mq-set-zone]').forEach(function(z){
            zones.push({ id: z.getAttribute('data-mq-set-zone'),
                         title: (z.querySelector('.mi-set-zone__title')||{}).textContent || '' });
          });
          return {
            zones: zones,
            hasMemoryZone: !!page.querySelector('[data-mq-set-zone="memory"]'),
            hasModelZone: !!page.querySelector('[data-mq-set-zone="model"]'),
            hasMemoryCountInput: !!page.querySelector('[data-mq-set-memory-count]'),
            hasSummaryTrigger: !!page.querySelector('[data-mq-set-summary-trigger]'),
            hasSummaryLength: !!page.querySelector('[data-mq-set-summary-length]'),
            hasBgActive: !!page.querySelector('#mq-set-bg-active'),
            hasBgInterval: !!page.querySelector('[data-mq-set-bg-active-min]'),
            hasQuietStart: !!page.querySelector('[data-mq-set-bg-quiet-start]'),
            hasQuietEnd: !!page.querySelector('[data-mq-set-bg-quiet-end]'),
            hasQuietEn: !!page.querySelector('#mq-set-bg-quiet-en'),
            hasTimeEn: !!page.querySelector('#mq-set-time-en'),
            hasCtxUsage: !!page.querySelector('[data-mq-set-ctx-usage]'),
            visible: !page.hidden
          };
        })()
        """)
        print("   zones:", json.dumps(r.get("zones"), ensure_ascii=False))
        check("聊天设置页已打开", r.get("visible"))
        check("存在「记忆与后台」分区", r.get("hasMemoryZone"))
        check("存在「模型高级」分区", r.get("hasModelZone"))
        check("上下文条数输入框存在", r.get("hasMemoryCountInput"))
        check("自动总结触发输入框存在", r.get("hasSummaryTrigger"))
        check("总结长度输入框存在（幽灵字段已补 UI）", r.get("hasSummaryLength"))
        check("主动发消息开关存在", r.get("hasBgActive"))
        check("主动间隔输入框存在", r.get("hasBgInterval"))
        check("静默时段起止存在", r.get("hasQuietStart") and r.get("hasQuietEnd"))
        check("启用静默开关存在", r.get("hasQuietEn"))
        check("时间感知开关存在（单聊补齐）", r.get("hasTimeEn"))
        check("Token 用量容器存在", r.get("hasCtxUsage"))

        print("\n【2】改值并保存，检查是否真正生效")
        r2 = await pg.evaluate("""
        (async function(){
          var page = document.getElementById('mq-set-page');
          var body = page.querySelector('[data-mq-set-body]');
          function setVal(sel, v){ var el = body.querySelector(sel); if (el) el.value = v; }
          function setToggle(sel, on){
            var el = body.querySelector(sel);
            if (!el) return false;
            el.classList.toggle('is-on', !!on);
            el.setAttribute('aria-checked', on ? 'true':'false');
            return true;
          }
          setVal('[data-mq-set-memory-count]', 150);
          setVal('[data-mq-set-summary-trigger]', 25);
          setVal('[data-mq-set-summary-length]', '八十到一百五十字');
          setToggle('#mq-set-bg-active', true);
          setVal('[data-mq-set-bg-active-min]', 45);
          setToggle('#mq-set-bg-quiet-en', true);
          setVal('[data-mq-set-bg-quiet-start]', '23:30');
          setVal('[data-mq-set-bg-quiet-end]', '07:15');
          setToggle('#mq-set-time-en', true);

          page.querySelector('[data-mq-set-save]').click();
          await new Promise(function(r){ setTimeout(r, 1200); });

          var st = window.miyaChatStore;
          var s = st.getChatSettings('chat_e2e');
          var bg = s.backgroundMessage || {};
          return {
            memoryCount: s.memoryCount,
            summaryTrigger: s.summaryTrigger,
            summaryLength: s.summaryLength,
            activeEnabled: !!bg.activeEnabled,
            activeIntervalMin: bg.activeIntervalMin,
            quietEnabled: !!bg.quietEnabled,
            quietStartMin: bg.quietStartMin,
            quietEndMin: bg.quietEndMin,
            timeEnabled: !!(s.timeAwareness && s.timeAwareness.enabled)
          };
        })()
        """)
        print("   saved:", json.dumps(r2, ensure_ascii=False))
        check("上下文条数 = 150", r2.get("memoryCount") == 150, str(r2.get("memoryCount")))
        check("自动总结触发 = 25", r2.get("summaryTrigger") == 25, str(r2.get("summaryTrigger")))
        check("总结长度 = 八十到一百五十字", r2.get("summaryLength") == "八十到一百五十字", str(r2.get("summaryLength")))
        check("主动发消息已开启（跨层生效）", r2.get("activeEnabled") is True, str(r2.get("activeEnabled")))
        check("主动间隔 = 45（跨层生效）", r2.get("activeIntervalMin") == 45, str(r2.get("activeIntervalMin")))
        check("静默已开启", r2.get("quietEnabled") is True)
        check("静默起 = 23:30 (1410)", r2.get("quietStartMin") == 1410, str(r2.get("quietStartMin")))
        check("静默止 = 07:15 (435)", r2.get("quietEndMin") == 435, str(r2.get("quietEndMin")))
        check("时间感知已开启", r2.get("timeEnabled") is True)

        print("\n【3】关闭再重开，检查值是否持久（不被全局覆盖）")
        r3 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaChatContactSettings;
          mod.close();
          await new Promise(function(r){ setTimeout(r, 400); });
          mod.open('chat_e2e');
          await new Promise(function(r){ setTimeout(r, 900); });
          var page = document.getElementById('mq-set-page');
          var body = page.querySelector('[data-mq-set-body]');
          function val(sel){ var el = body.querySelector(sel); return el ? el.value : null; }
          function on(sel){ var el = body.querySelector(sel); return el ? el.classList.contains('is-on') : null; }
          var st = window.miyaChatStore;
          var s = st.getChatSettings('chat_e2e');
          var gs = window.miyaChatGlobalSettings;
          await gs.whenReady();
          return {
            uiMemoryCount: val('[data-mq-set-memory-count]'),
            uiSummaryTrigger: val('[data-mq-set-summary-trigger]'),
            uiSummaryLength: val('[data-mq-set-summary-length]'),
            uiBgActive: on('#mq-set-bg-active'),
            uiBgInterval: val('[data-mq-set-bg-active-min]'),
            uiQuietEn: on('#mq-set-bg-quiet-en'),
            uiQuietStart: val('[data-mq-set-bg-quiet-start]'),
            uiTimeEn: on('#mq-set-time-en'),
            liveMemoryCount: s.memoryCount,
            perContact: gs.getState().perContact['c_e2e'] || null,
            usesGlobal: gs.contactUsesGlobal('c_e2e')
          };
        })()
        """)
        print("   reopened:", json.dumps(r3, ensure_ascii=False, indent=2))
        check("重开后 UI 上下文条数 = 150", r3.get("uiMemoryCount") == "150", str(r3.get("uiMemoryCount")))
        check("重开后 UI 总结长度保持", r3.get("uiSummaryLength") == "八十到一百五十字", str(r3.get("uiSummaryLength")))
        check("重开后 UI 主动发消息为开", r3.get("uiBgActive") is True)
        check("重开后 UI 静默时段起 = 23:30", r3.get("uiQuietStart") == "23:30", str(r3.get("uiQuietStart")))
        check("重开后 UI 时间感知为开", r3.get("uiTimeEn") is True)
        check("已登记为该联系人的独立配置", r3.get("usesGlobal") is False)
        pc = r3.get("perContact") or {}
        check("perContact 无会话级运行时脏字段",
              "lifeLikeNextPushAt" not in ((pc.get("settings") or {}).get("backgroundMessage") or {}))

        print("\n【4】lifeLike 与定时主动消息的互斥反馈")
        r4 = await pg.evaluate("""
        (async function(){
          var page = document.getElementById('mq-set-page');
          var body = page.querySelector('[data-mq-set-body]');
          var life = body.querySelector('#mq-set-lifelike');
          var warn = body.querySelector('[data-mq-set-bg-lifelike-warn]');
          if (!life) return {error: 'no lifelike'};
          life.click();
          await new Promise(function(r){ setTimeout(r, 250); });
          var activeSw = body.querySelector('#mq-set-bg-active');
          var warnAfter = body.querySelector('[data-mq-set-bg-lifelike-warn]');
          return {
            lifeOn: life.classList.contains('is-on'),
            warnVisible: warnAfter ? !warnAfter.hidden : null,
            activeDisabled: activeSw ? activeSw.classList.contains('is-disabled') : null,
            activeOn: activeSw ? activeSw.classList.contains('is-on') : null
          };
        })()
        """)
        print("   lifelike:", json.dumps(r4, ensure_ascii=False))
        if r4.get("error"):
            check("lifeLike 联动测试可执行", False, r4["error"])
        else:
            check("开启 lifeLike 后出现互斥提示", r4.get("warnVisible") is True)
            check("开启 lifeLike 后定时开关被禁用", r4.get("activeDisabled") is True)
            check("开启 lifeLike 后定时开关被置灰", r4.get("activeOn") is False)

        print("\n【5】回归边界：桌面设置 App 与「我的」齿轮 已彻底删除，功能已并入聊天设置")
        r5 = await pg.evaluate("""
        (async function(){
          /* 「我的」菜单是点开才渲染的，先直接生成 HTML 再查，
             否则查到的 0 只是「菜单还没画」，证明不了入口被删。 */
          var chatApp = window.miyaChatApp;
          var menuHtml = '';
          if (chatApp && typeof chatApp.__buildMineMenuForTest === 'function') {
            menuHtml = chatApp.__buildMineMenuForTest();
          }
          /* 桌面图标：miya-desk-custom 的布局里不该再有 'set' */
          var deskIcons = Array.prototype.map.call(
            document.querySelectorAll('.miya-desk-icon[data-app], [data-desk-app]'),
            function(el){ return el.getAttribute('data-app') || el.getAttribute('data-desk-app'); });
          return {
            appDom: !!document.getElementById('miya-settings-app'),
            panels: document.querySelectorAll('[id^="miya-st-panel-"]').length,
            menuLen: menuHtml.length,
            menuHasSettings: menuHtml.indexOf('data-mine-action=\\"settings\\"') >= 0,
            menuHasFavorites: menuHtml.indexOf('我的收藏') >= 0,
            deskSetIcons: deskIcons.filter(function(k){ return k === 'set'; }).length,
            /* 老 API 兼容层仍在，且能落到正确子视图 */
            legacyOpenType: typeof (window.miyaSettingsApp || {}).open,
            /* 数据层引擎必须全部存活（拆文件时最容易误删的就是它们） */
            apiCfg: typeof window.miyaGetApiConfigCached,
            setCfg: typeof window.miyaSetApiConfig,
            sysPrefs: typeof window.miyaGetSystemPrefs,
            backup: typeof (window.miyaBackup || {}).exportFull,
            toast: typeof window.miyaToast
          };
        })()
        """)
        print("   boundary:", json.dumps(r5, ensure_ascii=False))
        check("桌面设置 App DOM 已删除", r5.get("appDom") is False)
        check("设置 App 的面板 DOM 已清空", r5.get("panels") == 0, str(r5.get("panels")))
        check("「我的」菜单已生成（断言前提成立）", r5.get("menuLen", 0) > 0, f"len={r5.get('menuLen')}")
        check("「我的」菜单仍有其它项（未误删）", r5.get("menuHasFavorites") is True)
        check("「我的」页齿轮入口已删除", r5.get("menuHasSettings") is False)
        check("桌面无 set 图标", r5.get("deskSetIcons") == 0, str(r5.get("deskSetIcons")))
        check("老 API 兼容层仍在", r5.get("legacyOpenType") == "function")
        check("数据层引擎存活（API 配置）",
              r5.get("apiCfg") == "function" and r5.get("setCfg") == "function")
        check("数据层引擎存活（系统偏好）", r5.get("sysPrefs") == "function")
        check("数据层引擎存活（备份）", r5.get("backup") == "function")
        check("miyaToast 已定义（原先全项目缺失）", r5.get("toast") == "function")

        print("\n【6】老 API 转发：miyaSettingsApp.open(panelId) 应落到对应子视图")
        r6 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaChatContactSettings;
          mod.close();
          await new Promise(function(r){ setTimeout(r, 400); });
          var out = {};
          var cases = [
            ['miya-st-panel-chat', '对话 API'],
            ['miya-st-panel-voice', '语音合成'],
            ['miya-st-panel-imagegen', '生图 API'],
            ['miya-st-panel-msg-sound', '通知与提示音'],
            ['miya-st-panel-storage', '存储用量']
          ];
          for (var i = 0; i < cases.length; i++) {
            window.miyaSettingsApp.open(cases[i][0]);
            await new Promise(function(r){ setTimeout(r, 700); });
            var page = document.getElementById('mq-set-page');
            out[cases[i][0]] = page ? ((page.querySelector('.st-navtitle')||{}).textContent || '(none)') : '(no page)';
            var back = page && page.querySelector('[data-mq-set-sub-back]');
            if (back) { back.click(); await new Promise(function(r){ setTimeout(r, 350); }); }
            mod.close();
            await new Promise(function(r){ setTimeout(r, 300); });
          }
          return out;
        })()
        """)
        print("   legacy routing:", json.dumps(r6, ensure_ascii=False))
        check("老面板名 'miya-st-panel-chat' → 对话 API",
              r6.get("miya-st-panel-chat") == "对话 API", str(r6.get("miya-st-panel-chat")))
        check("老面板名 'miya-st-panel-voice' → 语音合成",
              r6.get("miya-st-panel-voice") == "语音合成", str(r6.get("miya-st-panel-voice")))
        check("老面板名 'miya-st-panel-imagegen' → 生图 API",
              r6.get("miya-st-panel-imagegen") == "生图 API", str(r6.get("miya-st-panel-imagegen")))
        check("老面板名 'miya-st-panel-msg-sound' → 通知与提示音",
              r6.get("miya-st-panel-msg-sound") == "通知与提示音", str(r6.get("miya-st-panel-msg-sound")))
        check("老面板名 'miya-st-panel-storage' → 存储用量",
              r6.get("miya-st-panel-storage") == "存储用量", str(r6.get("miya-st-panel-storage")))

        print("\n【7】桌面「生图」图标保留，且能独立打开生图 App")
        r7 = await pg.evaluate("""
        (async function(){
          var handler = window.__miyaDeskAppHandlers && window.__miyaDeskAppHandlers.imagegen;
          var opened = false;
          if (window.MiyaImageGenApp && typeof window.MiyaImageGenApp.open === 'function') {
            try { window.MiyaImageGenApp.open(); opened = true; } catch(e) { opened = 'throw:' + e; }
          }
          await new Promise(function(r){ setTimeout(r, 600); });
          var root = document.getElementById('miya-igapp');
          return {
            hasApi: !!(window.MiyaImageGenApp && window.MiyaImageGenApp.open),
            opened: opened,
            rootVisible: root ? !root.hidden : false,
            /* 生图 API 设置面板必须挂在这个 App 内部，
               否则 miya-image-gen.js 里的 getElementById 会找不到 */
            panelInApp: root ? !!root.querySelector('#miya-st-panel-imagegen') : false
          };
        })()
        """)
        print("   imagegen:", json.dumps(r7, ensure_ascii=False))
        check("生图 App 可独立打开", r7.get("hasApi") is True and r7.get("rootVisible") is True)
        check("生图 API 设置面板挂在生图 App 内部（id 未变）", r7.get("panelInApp") is True)

        await browser.close()

    print(f"\n{'='*60}")
    print(f"通过 {len(passed)} / 共 {len(passed)+len(failed)}")
    if failed:
        print("失败项：")
        for f in failed:
            print("  -", f)
        return 1
    print("全部通过 ✅")
    return 0


raise SystemExit(asyncio.run(main()))
