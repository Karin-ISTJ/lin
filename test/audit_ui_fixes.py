#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UI 遗留项修复验证：
【1】语音合成模型下拉：内置清单可选、切换保存落盘、清单外值保值
【2】多选 JSON 备份：toast 提示只导入第一个

注：原「存储图片区」场景已随聊天设置的存储用量功能下线一并移除。
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
        # 子视图底部保存键已删除：api-voice 现在唯一的保存入口是顶栏「保存」，
        # saveForm() 会自动转走 saveSubViewForm('api-voice')。
        await pg.evaluate("""
        () => new Promise(res => {
          document.querySelector('#mq-set-page [data-mq-set-save]').click();
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

        # ========== 场景 2：多选 JSON 提示 ==========
        # （原「存储图片区统计与清理」场景已随存储用量功能下线而移除）
        print("\n【2】多选 JSON 备份导入提示")
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
