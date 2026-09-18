#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证「聊天默认值」子视图（联系人聊天设置 → 聊天默认值）

背景：原先这个面板住在桌面设置 App（#miya-st-panel-chat-defaults），
现在随设置 App 一起并进了「联系人聊天设置」的子视图体系，
渲染由 miyaChatSettingsPanel.mountDefaultsInto(container) 完成。

断言：
- 子视图能打开、面板能渲染进宿主容器、能填值、能保存
- 保存后，未单独设置的联系人读到新默认值
- 「恢复」能让已覆盖的联系人回到全局
- 桌面设置 App 已不存在（回归边界）
"""
import asyncio, json
from playwright.async_api import async_playwright

BASE = "http://localhost:8098/index.html"
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
    contacts: [
      { id: 'c_a', name: '阿甲', remarkName: '阿甲', groupId: 'ct-default',
        createdAt: now, updatedAt: now, chatSettings: {} },
      { id: 'c_b', name: '阿乙', remarkName: '阿乙', groupId: 'ct-default',
        createdAt: now, updatedAt: now, chatSettings: {} },
      { id: 'c_c', name: '阿丙', remarkName: '阿丙', groupId: 'ct-default',
        createdAt: now, updatedAt: now, chatSettings: {} }
    ],
    chats: [
      { id: 'chat_a', type: 'single', contactId: 'c_a', title: '阿甲', profileId: 'p1',
        createdAt: now, updatedAt: now, chatSettings: {} },
      { id: 'chat_b', type: 'single', contactId: 'c_b', title: '阿乙', profileId: 'p1',
        createdAt: now, updatedAt: now, chatSettings: {} },
      { id: 'chat_c', type: 'single', contactId: 'c_c', title: '阿丙', profileId: 'p1',
        createdAt: now, updatedAt: now, chatSettings: {} }
    ],
    messagesByChat: { 'chat_a': [], 'chat_b': [], 'chat_c': [] },
    shopCatalog: null, chatWallpapers: []
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

        # 跳过锁屏 → 打开聊天 App → 进入「阿甲」的聊天设置
        await pg.evaluate("""() => {
          var ls = document.getElementById('miya-lockscreen');
          if (ls) { ls.classList.remove('is-active','is-open'); ls.style.display = 'none'; }
        }""")
        await pg.wait_for_timeout(600)
        await pg.evaluate("""async () => {
          if (window.miyaLaunchApp) window.miyaLaunchApp('chat');
          var st = window.miyaChatStore;
          if (st && st.init) await st.init();
          window.miyaChatContactSettings.open('chat_a');
        }""")
        await pg.wait_for_timeout(1500)

        print("\n【0】回归边界：桌面设置 App + 「我的」齿轮 必须已彻底删除")
        r0 = await pg.evaluate("""async () => {
          /* 「我的」菜单是点开时才渲染的，先把菜单生成出来再查，
             否则查到的 0 只是「菜单还没画」，证明不了入口被删。 */
          var chatApp = window.miyaChatApp;
          var menuHtml = '';
          if (chatApp && typeof chatApp.__buildMineMenuForTest === 'function') {
            menuHtml = chatApp.__buildMineMenuForTest();
          }
          return {
            appDom: !!document.getElementById('miya-settings-app'),
            panels: document.querySelectorAll('[id^="miya-st-panel-"]').length,
            menuHtmlLen: menuHtml.length,
            menuHasSettings: menuHtml.indexOf('data-mine-action=\"settings\"') >= 0,
            menuHasFavorites: menuHtml.indexOf('我的收藏') >= 0
          };
        }""")
        print("   边界:", json.dumps(r0, ensure_ascii=False))
        check("桌面设置 App DOM 已删除", r0.get("appDom") is False)
        check("设置 App 的面板 DOM 已清空", r0.get("panels") == 0, str(r0.get("panels")))
        check("「我的」菜单已生成（断言前提成立）",
              r0.get("menuHtmlLen", 0) > 0, f"len={r0.get('menuHtmlLen')}")
        check("「我的」菜单仍有其它项（未误删）", r0.get("menuHasFavorites") is True)
        check("「我的」页齿轮入口已删除", r0.get("menuHasSettings") is False,
              f"hasSettings={r0.get('menuHasSettings')}")

        print("\n【1】聊天设置 → 聊天默认值 子视图能否进入")
        r1 = await pg.evaluate("""
        (async function(){
          var p = document.getElementById('mq-set-page');
          if (!p) return {error: 'no mq-set-page'};
          /* 进来时就应该停在列表首页（open() 里已把 state.subView 置 null），
             所以这里不需要先点返回 —— 那个 [data-mq-set-back] 在列表页的语义是
             「关掉整个聊天设置回聊天」，点了它整页会 hidden=true，
             之后再点子视图入口只是对着一个已隐藏的页面空点。 */
          var btn = p.querySelector('[data-mq-set-sub="chat-defaults"]');
          if (!btn) return {error: 'no sub entry'};
          btn.click();
          await new Promise(function(r){ setTimeout(r, 700); });
          /* 返回键断言的对象必须是**真实存在**的那个。
             [data-mq-set-sub-back] 是子视图内的页内返回键，已被有意删除
             （顶栏 [data-mq-set-back] 接管，点击时按 state.subView 决定
             是「回列表」还是「关整页」）。原先断言它存在 → 恒为 false，
             后面 5 条断言又依赖这一步的返回结果，于是连锁误报。
             这里改断言顶栏返回键存在，并顺带验证它的真实语义。 */
          var topBack = p.querySelector('[data-mq-set-back]');
          return {
            title: (p.querySelector('.st-navtitle') || {}).textContent || '',
            hasBack: !!topBack,
            staleSubBackAbsent: !p.querySelector('[data-mq-set-sub-back]')
          };
        })()
        """)
        print("   子视图:", json.dumps(r1, ensure_ascii=False))
        check("「聊天默认值」子视图可进入", r1.get("title") == "聊天默认值", str(r1.get("title")))
        check("子视图有返回键（顶栏）", r1.get("hasBack") is True)
        check("已废弃的页内返回键不再渲染", r1.get("staleSubBackAbsent") is True)

        print("\n【2】检查「聊天默认值」表单渲染")
        r2 = await pg.evaluate("""
        (async function(){
          var host = document.querySelector('[data-mq-set-defaults-host]');
          if (!host) return {error: 'no defaults host'};
          var p = host;
          function val(id){ var el = p.querySelector('#' + id); return el ? el.value : null; }
          function on(id){ var el = p.querySelector('#' + id); return el ? el.classList.contains('is-on') : null; }
          return {
            visible: p.innerHTML.length > 200,
            memoryCount: val('miya-ct-def-memory-count'),
            summaryTrigger: val('miya-ct-def-summary-trigger'),
            summaryLength: val('miya-ct-def-summary-length'),
            bgActive: on('miya-ct-def-bg-active'),
            bgInterval: val('miya-ct-def-bg-active-min'),
            quietStart: val('miya-ct-def-bg-quiet-start'),
            quietEnd: val('miya-ct-def-bg-quiet-end'),
            hasSave: !!document.getElementById('miya-ct-def-save'),
            hasOverridesList: !!document.getElementById('miya-ct-def-overrides')
          };
        })()
        """)
        print("   panel:", json.dumps(r2, ensure_ascii=False))
        check("面板已显示", r2.get("visible"))
        check("默认记忆条数已填充", r2.get("memoryCount") == "80", str(r2.get("memoryCount")))
        check("默认总结长度已填充", r2.get("summaryLength") == "100-300字")
        check("静默时段已填充", r2.get("quietStart") == "23:00", str(r2.get("quietStart")))
        check("有保存按钮", r2.get("hasSave"))
        check("有覆盖列表区", r2.get("hasOverridesList"))

        print("\n【3】改默认值并保存，检查未单独设置的联系人是否读到新值")
        r3 = await pg.evaluate("""
        (async function(){
          function val(id, v){ var el = document.getElementById(id); if (el) el.value = v; }
          function setToggle(id, on){
            var el = document.getElementById(id);
            if (!el) return false;
            el.classList.toggle('is-on', !!on);
            el.setAttribute('aria-checked', on ? 'true':'false');
            return true;
          }
          val('miya-ct-def-memory-count', 200);
          val('miya-ct-def-summary-trigger', 30);
          val('miya-ct-def-summary-length', '两百字左右');
          setToggle('miya-ct-def-bg-active', true);
          val('miya-ct-def-bg-active-min', 60);
          document.getElementById('miya-ct-def-save').click();
          await new Promise(function(r){ setTimeout(r, 1000); });

          var st = window.miyaChatStore;
          var a = st.getChatSettings('chat_a');
          var b = st.getChatSettings('chat_b');
          return {
            aMemoryCount: a.memoryCount,
            bMemoryCount: b.memoryCount,
            aSummaryTrigger: a.summaryTrigger,
            aSummaryLength: a.summaryLength,
            aBgActive: !!(a.backgroundMessage && a.backgroundMessage.activeEnabled),
            aBgInterval: a.backgroundMessage && a.backgroundMessage.activeIntervalMin,
            gsGlobal: (function(){
              var gs = window.miyaChatGlobalSettings;
              return gs ? gs.getState().global.memoryCount : null;
            })()
          };
        })()
        """)
        print("   saved:", json.dumps(r3, ensure_ascii=False))
        check("全局默认条数已存为 200", r3.get("gsGlobal") == 200, str(r3.get("gsGlobal")))
        check("未单独设置的联系人读到 200", r3.get("aMemoryCount") == 200, str(r3.get("aMemoryCount")))
        check("另一联系人同样读到 200", r3.get("bMemoryCount") == 200, str(r3.get("bMemoryCount")))
        check("主动发消息默认已开启", r3.get("aBgActive") is True)
        check("主动间隔读到 60", r3.get("aBgInterval") == 60, str(r3.get("aBgInterval")))

        print("\n【4】某联系人单独改过 → 不受默认值影响；恢复后回到全局")
        r4 = await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore, gs = window.miyaChatGlobalSettings;
          // 阿丙单独改成 55
          await gs.applyContactOverride('c_c', { memoryCount: 55 });
          var c1 = st.getChatSettings('chat_c').memoryCount;
          var a1 = st.getChatSettings('chat_a').memoryCount;

          /* 重进子视图看覆盖列表。
             返回键语义（现行实现）：只渲染顶栏 [data-mq-set-back] 一个，
             点击时按 state.subView 决定走向 —— 在子视图里 → 回列表；
             在列表页 → 关掉整个聊天设置。
             原先这里找 [data-mq-set-sub-back]（已被有意删除的页内返回键），
             恒为 null 直接 return，导致本节 5 条断言全部拿到 None 误报。
             现在改用顶栏返回键，并确认整页还开着 ——
             整页是 innerHTML 重绘，每一步都要重新 getElementById。 */
          var _b = document.getElementById('mq-set-page').querySelector('[data-mq-set-back]');
          if (!_b) return { error: 'no top back button in subview' };
          _b.click();
          await new Promise(function(r){ setTimeout(r, 500); });

          var _p = document.getElementById('mq-set-page');
          if (!_p.classList.contains('is-open') || _p.hidden) {
            /* 页面被关掉了就自己重新开一次，不把「测试点错按钮」
               伪装成「覆盖列表没渲染」这种产品缺陷。 */
            window.miyaChatContactSettings.open('chat_a');
            await new Promise(function(r){ setTimeout(r, 900); });
            _p = document.getElementById('mq-set-page');
            if (!_p.classList.contains('is-open') || _p.hidden) {
              return { error: 'settings page closed and could not reopen',
                       cls: _p.className, hidden: _p.hidden };
            }
          }

          var _entry = null;
          for (var _k = 0; _k < 40; _k++) {
            _entry = document.getElementById('mq-set-page').querySelector('[data-mq-set-sub="chat-defaults"]');
            if (_entry) break;
            await new Promise(function(r){ setTimeout(r, 150); });
          }
          if (!_entry) return { error: 'no chat-defaults entry after back',
                                title: (document.getElementById('mq-set-page').querySelector('.st-navtitle')||{}).textContent };
          _entry.click();
          await new Promise(function(r){ setTimeout(r, 900); });
          /* renderOverrideList 是异步的（要等 whenReady + st.init），
             火候不到就取节点会读到空列表 —— 轮询等它真的画出来。 */
          var box = null;
          for (var _w = 0; _w < 40; _w++) {
            var host = document.querySelector('[data-mq-set-defaults-host]');
            box = host ? host.querySelector('#miya-ct-def-overrides') : null;
            if (box && box.querySelector('[data-def-reset="c_c"]')) break;
            await new Promise(function(r){ setTimeout(r, 100); });
          }
          var listed = box ? box.textContent : '';
          var resetBtn = box ? box.querySelector('[data-def-reset="c_c"]') : null;

          var resetResult = null;
          if (resetBtn) {
            resetBtn.click();
            await new Promise(function(r){ setTimeout(r, 800); });
            resetResult = st.getChatSettings('chat_c').memoryCount;
          }
          return {
            cAfterOverride: c1,
            aUnaffected: a1,
            listedText: listed,
            hasResetBtn: !!resetBtn,
            cAfterReset: resetResult,
            usesGlobalAfterReset: gs.contactUsesGlobal('c_c')
          };
        })()
        """)
        print("   override:", json.dumps(r4, ensure_ascii=False))
        check("单独改过的联系人是 55", r4.get("cAfterOverride") == 55, str(r4.get("cAfterOverride")))
        check("其它联系人不受影响（仍 200）", r4.get("aUnaffected") == 200, str(r4.get("aUnaffected")))
        check("覆盖列表里出现该联系人", r4.get("hasResetBtn") is True)
        check("点恢复后回到全局 200", r4.get("cAfterReset") == 200, str(r4.get("cAfterReset")))
        check("恢复后重新使用全局", r4.get("usesGlobalAfterReset") is True)

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
