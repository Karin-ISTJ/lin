#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
审查复现（第三轮）：子视图内顶栏保存是否清空世界书自定义排序
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

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)

        print("\n【1】创建两个世界书条目，设置自定义排序")
        r = await pg.evaluate("""
        (async function(){
          var wb = window.miyaWorldbookStore;
          await wb.whenReady();
          var e1 = await wb.upsertEntry({ name: '条目甲', content: '甲内容', scope: 'global', enabled: true });
          var e2 = await wb.upsertEntry({ name: '条目乙', content: '乙内容', scope: 'global', enabled: true });
          var st = window.miyaChatStore;
          await st.init();
          await st.updateContact('c_e2e', { worldbookEntryOrder: [e2.id, e1.id] });
          var eng = window.miyaChatEngine;
          var contact = st.findContact('c_e2e');
          var ids = eng.collectSortableWorldbookEntryIdsForContact(contact);
          return { e1: e1.id, e2: e2.id, allowed: ids,
                   saved: contact.worldbookEntryOrder };
        })()
        """)
        print("   条目:", json.dumps(r, ensure_ascii=False))
        assert r["e2"] in r["allowed"], "条目未进入可排序集合，场景构造失败"

        print("\n【2】打开根页（排序区应显示），根页保存固化基准")
        await pg.evaluate("""
        (async function(){
          window.miyaChatContactSettings.open('chat_e2e');
        })()
        """)
        await pg.wait_for_timeout(900)
        rows = await pg.evaluate("""
        () => document.querySelectorAll('[data-mq-set-wb-sort] [data-mq-set-wb-sort-id]').length
        """)
        print("   根页排序区行数:", rows)
        await pg.evaluate("""
        () => new Promise(res => {
          document.querySelector('#mq-set-page header [data-mq-set-save]').click();
          setTimeout(res, 900);
        })
        """)
        base = await pg.evaluate(
            "() => window.miyaChatStore.findContact('c_e2e').worldbookEntryOrder")
        print("   基准 worldbookEntryOrder:", json.dumps(base, ensure_ascii=False))

        print("\n【3】进 api-chat 子视图 → 点顶栏保存")
        await pg.evaluate("""
        () => new Promise(res => {
          var link = document.querySelector('[data-mq-set-sub="api-chat"]');
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
        after = await pg.evaluate(
            "() => window.miyaChatStore.findContact('c_e2e').worldbookEntryOrder")
        print("   操作后 worldbookEntryOrder:", json.dumps(after, ensure_ascii=False))

        ok = json.dumps(after) == json.dumps(base)
        print("\n【4】判定:", "✓ 排序保留" if ok else
              "✗ !!! 世界书自定义排序被清空/改写 —— " + json.dumps(base) + " → " + json.dumps(after))
        await browser.close()

asyncio.run(main())
