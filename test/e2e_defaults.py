#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证「聊天默认值」面板（桌面设置 → 聊天 → 聊天默认值）
- 面板能打开、能填值、能保存
- 保存后，未单独设置的联系人读到新默认值
- 「恢复」能让已覆盖的联系人回到全局
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

        print("\n【1】桌面设置主页是否有「聊天」分区入口")
        r1 = await pg.evaluate("""
        (async function(){
          var app = window.miyaSettingsApp;
          if (!app) return {error: 'no settings app'};
          app.open();
          await new Promise(function(r){ setTimeout(r, 600); });
          var main = document.getElementById('miya-st-main');
          var navs = [];
          main.querySelectorAll('[data-st-nav]').forEach(function(el){
            navs.push(el.getAttribute('data-st-nav'));
          });
          var labels = [];
          main.querySelectorAll('.st-card-label').forEach(function(el){ labels.push(el.textContent.trim()); });
          return {
            navs: navs,
            hasDefaultsNav: navs.indexOf('miya-st-panel-chat-defaults') >= 0,
            hasChatEntry: navs.indexOf('miya-st-panel-contact-chat') >= 0,
            labels: labels
          };
        })()
        """)
        print("   navs:", json.dumps(r1.get("navs"), ensure_ascii=False))
        check("主页有「聊天设置」入口", r1.get("hasChatEntry"))
        check("主页有「聊天默认值」入口", r1.get("hasDefaultsNav"))

        print("\n【2】打开「聊天默认值」，检查表单渲染")
        r2 = await pg.evaluate("""
        (async function(){
          window.miyaSettingsApp.open('miya-st-panel-chat-defaults');
          await new Promise(function(r){ setTimeout(r, 800); });
          var p = document.getElementById('miya-st-panel-chat-defaults');
          if (!p) return {error: 'no panel'};
          function val(id){ var el = document.getElementById(id); return el ? el.value : null; }
          function on(id){ var el = document.getElementById(id); return el ? el.classList.contains('is-on') : null; }
          return {
            visible: !p.hidden && p.classList.contains('is-active'),
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

          // 重开面板看覆盖列表
          window.miyaSettingsApp.open('miya-st-panel-chat-defaults');
          await new Promise(function(r){ setTimeout(r, 900); });
          var box = document.getElementById('miya-ct-def-overrides');
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
