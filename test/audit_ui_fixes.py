#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UI 遗留项修复验证：
【1】语音合成模型下拉：内置清单可选、切换保存落盘、清单外值保值
【2】存储图片区：空态/有图态统计与按钮、一键清空真实生效
【3】多选 JSON 备份：toast 提示只导入第一个
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
    messagesByChat: { 'chat_e2e': [
      { id: 'm_img_1', chatId: 'chat_e2e', type: 'image', imageDataKey: 'img-e2e-1',
        sender: 'me', createdAt: now, updatedAt: now }
    ] },
    shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

passed, failed = [], []

def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def open_sub(pg, key):
    await pg.evaluate(f"""
    () => new Promise(res => {{
      /* 宿主聊天 App 必须先打开，否则设置页挂在 display:none 容器里不可见 */
      if (window.miyaChatApp && typeof window.miyaChatApp.open === 'function') {{
        try {{ window.miyaChatApp.open(); }} catch (e) {{}}
      }}
      var page = document.getElementById('mq-set-page');
      if (!page || !page.querySelector('[data-mq-set-body]')) {{
        window.miyaChatContactSettings.open('chat_e2e');
      }}
      setTimeout(function() {{
        var p = document.getElementById('mq-set-page');
        var link = p.querySelector('[data-mq-set-sub="{key}"]');
        /* 子视图入口只在根页：当前在别的子视图就先点返回再点入口 */
        if (!link && p.querySelector('[data-mq-set-body] .mi-set-subview, [data-mq-set-body] .st-container')) {{
          var back = p.querySelector('[data-mq-set-back]');
          if (back) back.click();
          setTimeout(function() {{
            var p2 = document.getElementById('mq-set-page');
            var link2 = p2.querySelector('[data-mq-set-sub="{key}"]');
            if (link2) link2.click();
            setTimeout(res, 600);
          }}, 500);
          return;
        }}
        if (link) link.click();
        setTimeout(res, 600);
      }}, 400);
    }})
    """)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ========== 场景 1：语音模型下拉 ==========
        print("\n【1】语音合成模型下拉")
        await pg.evaluate("(async()=>{await window.miyaChatStore.init();})()")
        await open_sub(pg, "api-voice")
        r1 = await pg.evaluate("""
        () => {
          var sel = document.getElementById('mq-voice-model');
          if (!sel) return {error: 'no select'};
          return { options: Array.prototype.slice.call(sel.options).map(o => o.value) };
        }
        """)
        print("   当前选项:", r1.get("options"))
        check("内置清单渲染（占位+4 模型）",
              r1.get("options") == ["", "speech-01-hd", "speech-01-turbo", "speech-02-hd", "speech-02-turbo"],
              str(r1.get("options")))

        await pg.select_option("#mq-voice-model", "speech-02-hd")
        await pg.evaluate("""
        () => new Promise(res => {
          document.querySelector('[data-mq-set-sub-save="api-voice"]').click();
          setTimeout(res, 500);
        })
        """)
        saved = await pg.evaluate(
            "() => (window.miyaGetApiConfigCached()||{}).minimaxTts && (window.miyaGetApiConfigCached()||{}).minimaxTts.model")
        check("切换后保存落盘 model=speech-02-hd", saved == "speech-02-hd", str(saved))

        await open_sub(pg, "api-voice")
        sel2 = await pg.evaluate("() => document.getElementById('mq-voice-model').value")
        check("重进子视图选中保持", sel2 == "speech-02-hd", str(sel2))

        await pg.evaluate("() => window.miyaSetApiConfig({ minimaxTts: { model: 'speech-99-custom' } })")
        await open_sub(pg, "api-voice")
        r3 = await pg.evaluate("""
        () => {
          var sel = document.getElementById('mq-voice-model');
          return { values: Array.prototype.slice.call(sel.options).map(o => o.value),
                   value: sel.value };
        }
        """)
        check("清单外当前值保值且选中",
              "speech-99-custom" in r3["values"] and r3["value"] == "speech-99-custom",
              f"selected={r3['value']}")

        # ========== 场景 2：存储图片区 ==========
        print("\n【2】存储图片区统计与清理")
        await open_sub(pg, "storage")
        empty = await pg.evaluate("""
        () => {
          var img = document.querySelector('[data-mq-set-storage-images]');
          var act = document.querySelector('[data-mq-set-storage-img-actions]');
          return { text: img ? img.textContent.trim() : null, actionsHidden: act ? act.hidden : null };
        }
        """)
        check("空态文案 + 按钮区隐藏",
              empty.get("text") == "聊天里还没有本地图片" and empty.get("actionsHidden") is True,
              str(empty))

        # 造一张被消息引用的图片：走 store 的正式路径（blob 落 IDB + 消息入 meta），
        # 不能用 IDB 直写 —— collectMessageImageBlobKeys 读的是 store 的内存 meta 快照。
        await pg.evaluate("""
        async () => {
          await window.miyaChatStore.init();
          var canvas = document.createElement('canvas');
          canvas.width = 64; canvas.height = 64;
          var c = canvas.getContext('2d');
          c.fillStyle = '#88a'; c.fillRect(0, 0, 64, 64);
          var blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          var blobId = await window.miyaChatStore.storeMediaBlob(blob, 'chat');
          await window.miyaChatStore.addMessage('chat_e2e', {
            id: 'm_img_ui2', type: 'image', sender: 'me',
            imageDataKey: blobId, createdAt: Date.now(), updatedAt: Date.now()
          });
          return blobId;
        }
        """)
        await pg.evaluate("() => { document.querySelector('[data-mq-set-storage-refresh]').click(); }")
        await pg.wait_for_timeout(1500)
        withimg = await pg.evaluate("""
        () => {
          var img = document.querySelector('[data-mq-set-storage-images]');
          var act = document.querySelector('[data-mq-set-storage-img-actions]');
          return { text: img ? img.textContent.trim() : null, actionsHidden: act ? act.hidden : null };
        }
        """)
        check("有图态：显示张数/占用 + 按钮区出现",
              "聊天图片（1 张" in (withimg.get("text") or "") and withimg.get("actionsHidden") is False,
              str(withimg))

        # 一键清空（确认框 stub 放行——清空流程只有一次确认）
        await pg.evaluate("""
        () => {
          if (window.miyaDialog) {
            window.miyaDialog.confirm = function(){ return Promise.resolve(true); };
          }
          document.querySelector('[data-mq-set-storage-img-clear]').click();
        }
        """)
        await pg.wait_for_timeout(1500)
        cleared = await pg.evaluate("""
        async () => {
          var keys = await new Promise((resolve) => {
            var req = indexedDB.open('miya-chat-media', 1);
            req.onsuccess = () => {
              var db = req.result;
              if (!db.objectStoreNames.contains('blobs')) { resolve([]); return; }
              var tx = db.transaction('blobs', 'readonly');
              var rq = tx.objectStore('blobs').getAllKeys();
              rq.onsuccess = () => resolve(rq.result || []);
              rq.onerror = () => resolve([]);
            };
          });
          var img = document.querySelector('[data-mq-set-storage-images]');
          var act = document.querySelector('[data-mq-set-storage-img-actions]');
          return { keysLeft: keys, text: img ? img.textContent.trim() : null,
                   actionsHidden: act ? act.hidden : null };
        }
        """)
        check("清空后 IDB 图片记录删除", len(cleared.get("keysLeft") or []) == 0,
              str(cleared.get("keysLeft")))
        check("清空后回到空态 + 按钮区隐藏",
              cleared.get("text") == "聊天里还没有本地图片" and cleared.get("actionsHidden") is True,
              str(cleared.get("text")))

        # ========== 场景 3：多选 JSON 提示 ==========
        print("\n【3】多选 JSON 备份导入提示")
        r3b = await pg.evaluate("""
        async () => {
          window.__toasts = [];
          window.miyaToast = function(m){ window.__toasts.push(String(m)); };
          if (window.miyaDialog) {
            var n = 0;
            window.miyaDialog.confirm = function(){ n++; return Promise.resolve(n === 1); };
            /* 第一次=导入确认放行；第二次=「建议刷新」拦下，避免页面重载 */
          }
          function mkFile(obj){
            return new File([JSON.stringify(obj)], 'b.json', { type: 'application/json' });
          }
          var f1 = mkFile({ localStorage: { 'ui3-key': 'from-first' }, indexedDB_kv: {} });
          var f2 = mkFile({ localStorage: { 'ui3-key': 'from-second' }, indexedDB_kv: {} });
          window.miyaBackup.importFiles([f1, f2]);
          for (var i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 200));
            if (localStorage.getItem('ui3-key')) break;
          }
          await new Promise(r => setTimeout(r, 500));
          return { toasts: window.__toasts, value: localStorage.getItem('ui3-key') };
        }
        """)
        joined = " | ".join(r3b.get("toasts") or [])
        check("出现忽略提示", "其余 1 个被忽略" in joined, joined[:120])
        check("导入的是第一个文件", r3b.get("value") == "from-first", str(r3b.get("value")))

        await browser.close()

    print(f"\n=== 结果: {len(passed)} 通过 / {len(failed)} 失败 ===")
    if failed: print("失败项:", failed)
    if errors: print("页面错误:", errors[:3])

asyncio.run(main())
