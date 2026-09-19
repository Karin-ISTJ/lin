#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
审查复现（第二轮）：子视图内顶栏保存的额外破坏面
1. 世界书自定义排序 contact.worldbookEntryOrder 是否被清空
2. 全局记忆配置 perContact 覆盖（主动发消息/静默）是否被改写
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
      createdAt: now, updatedAt: now, chatSettings: {},
      worldbookEntryOrder: ['wb-aaa', 'wb-bbb', 'wb-ccc'],
      emojiGroupIds: ['g1'] }],
    chats: [{ id: 'chat_e2e', type: 'single', contactId: 'c_e2e', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now, chatSettings: {} }],
    messagesByChat: { 'chat_e2e': [] }, shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
  /* 预置：该联系人已脱离全局默认，主动发消息开启 */
  var gs = {
    version: 1, useGlobal: true,
    global: { memoryCount: 80, summaryTrigger: 0, summaryLength: '100-300字',
      backgroundMessage: { activeEnabled: false, activeIntervalMin: 30,
        quietEnabled: false, quietStartMin: 1380, quietEndMin: 420 } },
    perContact: { c_e2e: { useGlobal: false, settings: {
      memoryCount: 120, summaryTrigger: 12, summaryLength: '八十到一百五十字',
      backgroundMessage: { activeEnabled: true, activeIntervalMin: 45,
        quietEnabled: true, quietStartMin: 1300, quietEndMin: 400 } } } }
  };
  try { localStorage.setItem('miya-chat-global-settings-v1', JSON.stringify(gs)); } catch(e){}
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
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)

        print("\n【1】打开聊天设置根页（不改任何值），直接点根页保存固化基准")
        await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatContactSettings.open('chat_e2e');
        })()
        """)
        await pg.wait_for_timeout(900)
        await pg.evaluate("""
        () => new Promise(res => {
          document.querySelector('#mq-set-page header [data-mq-set-save]').click();
          setTimeout(res, 900);
        })
        """)
        base = await pg.evaluate("""
        () => ({
          order: (window.miyaChatStore.findContact('c_e2e')||{}).worldbookEntryOrder,
          gs: JSON.parse(localStorage.getItem('miya-chat-global-settings-v1')||'{}')
        })
        """)
        print("   基准 worldbookEntryOrder:", json.dumps(base["order"], ensure_ascii=False))
        pc = ((base["gs"].get("perContact") or {}).get("c_e2e") or {})
        bg0 = ((pc.get("settings") or {}).get("backgroundMessage") or {})
        print("   基准 perContact.backgroundMessage:", json.dumps(bg0, ensure_ascii=False))

        print("\n【2】进入子视图 api-chat，点顶栏「保存」（真实用户误操作）")
        await pg.evaluate("""
        () => new Promise(res => {
          var page = document.getElementById('mq-set-page');
          var link = page.querySelector('[data-mq-set-sub="api-chat"]');
          if (link) link.click();
          setTimeout(res, 700);
        })
        """)
        await pg.evaluate("""
        () => new Promise(res => {
          document.querySelector('#mq-set-page header [data-mq-set-save]').click();
          setTimeout(res, 900);
        })
        """)
        after = await pg.evaluate("""
        () => ({
          order: (window.miyaChatStore.findContact('c_e2e')||{}).worldbookEntryOrder,
          gs: JSON.parse(localStorage.getItem('miya-chat-global-settings-v1')||'{}')
        })
        """)
        print("   操作后 worldbookEntryOrder:", json.dumps(after["order"], ensure_ascii=False))
        pc2 = ((after["gs"].get("perContact") or {}).get("c_e2e") or {})
        bg1 = ((pc2.get("settings") or {}).get("backgroundMessage") or {})
        print("   操作后 perContact.backgroundMessage:", json.dumps(bg1, ensure_ascii=False))

        print("\n【3】判定")
        orderLost = json.dumps(after["order"]) != json.dumps(base["order"])
        check("!!! 世界书自定义排序被清空", not orderLost,
              f"{json.dumps(base['order'])} → {json.dumps(after['order'])}" if orderLost else "未受影响")
        memChanged = (bg0.get("activeEnabled") != bg1.get("activeEnabled")
                      or bg0.get("quietEnabled") != bg1.get("quietEnabled")
                      or bg0.get("activeIntervalMin") != bg1.get("activeIntervalMin"))
        check("!!! 记忆与后台 perContact 配置被改写", not memChanged,
              f"activeEnabled {bg0.get('activeEnabled')}→{bg1.get('activeEnabled')}, "
              f"quietEnabled {bg0.get('quietEnabled')}→{bg1.get('quietEnabled')}, "
              f"interval {bg0.get('activeIntervalMin')}→{bg1.get('activeIntervalMin')}" if memChanged else "未受影响")
        memCountChanged = (pc.get("settings", {}).get("memoryCount") != pc2.get("settings", {}).get("memoryCount"))
        print(f"   memoryCount: {pc.get('settings',{}).get('memoryCount')} → {pc2.get('settings',{}).get('memoryCount')}"
              f"（readConfigScopedMemory 有 fallback，预期不变）")

        await browser.close()

    print(f"\n=== 结果: {len(passed)} 通过 / {len(failed)} 失败 ===")

asyncio.run(main())
