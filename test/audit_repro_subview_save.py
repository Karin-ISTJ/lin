#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
审查复现：在子视图内点击顶栏「保存」按钮的破坏性
1. 打开聊天设置根页 → 改多个根级控件 → saveForm 落盘 → 快照 A
2. 进入子视图（api-chat / notify）→ 点击顶栏保存按钮（真实用户操作）
3. 快照 B 与 A 对比 → 根级字段被改写了多少
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


SNAP = "() => { var s = window.miyaChatStore.getChatSettings('chat_e2e'); return JSON.parse(JSON.stringify(s)); }"

OPEN_SUB = """
(sub) => new Promise(function(res){
  var mod = window.miyaChatContactSettings;
  // 模拟点击子视图入口（若找不到入口则直接调内部路由）
  var page = document.getElementById('mq-set-page');
  var link = page && page.querySelector('[data-mq-set-sub="' + sub + '"]');
  if (link) { link.click(); setTimeout(function(){ res({via:'click', ok:true}); }, 500); return; }
  res({via:'none', ok:false});
})
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

        print("\n【1】打开聊天设置根页，填写多个根级控件并保存")
        r = await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore;
          await st.init();
          var mod = window.miyaChatContactSettings;
          mod.open('chat_e2e');
          await new Promise(function(r){ setTimeout(r, 800); });
          var page = document.getElementById('mq-set-page');
          var body = page.querySelector('[data-mq-set-body]');
          function q(sel){ return body.querySelector(sel); }
          function setVal(sel, v){ var el=q(sel); if(el){ el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); return true;} return false; }
          function setToggle(sel,on){ var el=q(sel); if(!el) return false;
            el.classList.toggle('is-on',!!on); el.setAttribute('aria-checked',on?'true':'false'); return true; }
          var did = {};
          did.remark = setVal('[data-mq-set-remark]', '测试备注-勿动');
          did.weatherEn = setToggle('#mq-set-weather-en', true);
          did.weatherPlace = setVal('[data-mq-set-remark]', '测试备注-勿动');
          did.mute = setToggle('#mq-set-mute-notify', true);
          did.lifeLike = setToggle('#mq-set-lifelike', true);
          did.disguise = setToggle('#mq-set-anonymous', true);
          did.tts = setToggle('#mq-set-tts-en', true);
          did.voiceId = setVal('[data-mq-set-voice-id]', 'voice_demo_001');
          return { did: did, hasBody: !!body };
        })()
        """)
        print("   控件填写结果:", json.dumps(r.get("did"), ensure_ascii=False))
        check("根页控件齐全可填写", all([r["did"].get("remark"), r["did"].get("weatherEn"),
              r["did"].get("weatherPlace"), r["did"].get("mute"), r["did"].get("lifeLike"),
              r["did"].get("disguise"), r["did"].get("tts"), r["did"].get("voiceId")]),
              str(r.get("did")))

        # 保存（走内部 saveForm）
        await pg.evaluate("() => window.miyaChatContactSettings && null")
        await pg.evaluate("""
        () => new Promise(function(res){
          var page = document.getElementById('mq-set-page');
          // 根页状态下顶栏保存等价于 saveForm
          var btn = page.querySelector('[data-mq-set-save]');
          btn.click();
          setTimeout(res, 900);
        })
        """)
        snapA = await pg.evaluate(SNAP)
        print("   快照A(根级保存后) 关键字段:", json.dumps({
            k: snapA.get(k) for k in list(snapA.keys())[:0]} , ensure_ascii=False))

        print("\n【2】进入子视图 api-chat，点击顶栏「保存」")
        r2 = await pg.evaluate(OPEN_SUB.replace("'sub'", "'api-chat'").replace("(sub) new", "(sub) => new"))
        # OPEN_SUB 是字符串模板，直接用另一种方式
        await pg.evaluate("""
        () => new Promise(function(res){
          var page = document.getElementById('mq-set-page');
          var link = page.querySelector('[data-mq-set-sub="api-chat"]');
          if (link) { link.click(); }
          setTimeout(res, 700);
        })
        """)
        inSub = await pg.evaluate("""
        () => {
          var page = document.getElementById('mq-set-page');
          return {
            saveBtnVisible: !!(page.querySelector('header [data-mq-set-save]')),
            hasApiChatDom: !!page.querySelector('[data-mq-set-body] #mq-api-model'),
            hasRootRemark: !!page.querySelector('[data-mq-set-body] [data-mq-set-remark]'),
            hasRootWeather: !!page.querySelector('[data-mq-set-body] #mq-set-weather-en'),
            subViewActive: (page.querySelector('[data-mq-set-body] .mi-set-sub, [data-mq-set-body] .st-sub') != null)
          };
        }
        """)
        print("   子视图内状态:", json.dumps(inSub, ensure_ascii=False))
        check("子视图内顶栏保存按钮仍可见", inSub.get("saveBtnVisible"))
        check("子视图内根级控件确实不在 DOM 中",
              (not inSub.get("hasRootRemark")) and (not inSub.get("hasRootWeather")))

        # 点击顶栏保存（真实用户行为）
        await pg.evaluate("""
        () => new Promise(function(res){
          var page = document.getElementById('mq-set-page');
          page.querySelector('header [data-mq-set-save]').click();
          setTimeout(res, 900);
        })
        """)
        snapB = await pg.evaluate(SNAP)

        print("\n【3】对比快照 A → B（根级字段是否被改写）")
        diff = {}
        for k in set(list(snapA.keys()) + list(snapB.keys())):
            va, vb = snapA.get(k, "<缺失>"), snapB.get(k, "<缺失>")
            if json.dumps(va, sort_keys=True, ensure_ascii=False) != json.dumps(vb, sort_keys=True, ensure_ascii=False):
                diff[k] = {"A": va, "B": vb}
        print("   被改写的顶层字段数:", len(diff))
        for k, v in list(diff.items())[:14]:
            print(f"   • {k}:\n     A = {json.dumps(v['A'], ensure_ascii=False)[:160]}\n     B = {json.dumps(v['B'], ensure_ascii=False)[:160]}")
        check("!!! 高危确认：子视图内点顶栏保存会改写根级设置", len(diff) == 0,
              f"{len(diff)} 个顶层字段被改写" if diff else "无改写")

        # 深挖几个具体字段
        def dig(snap, path):
            cur = snap
            for seg in path.split('.'):
                if isinstance(cur, dict) and seg in cur: cur = cur[seg]
                else: return "<缺失>"
            return cur
        for path in ["weatherAwareness.enabled", "weatherAwareness.placeUser",
                     "muteNotify", "backgroundMessage.lifeLikeEnabled",
                     "backgroundMessage.anonymousDisguiseEnabled", "voiceEnabled", "voiceId"]:
            a, b = dig(snapA, path), dig(snapB, path)
            mark = "≠≠被改" if json.dumps(a, ensure_ascii=False) != json.dumps(b, ensure_ascii=False) else "=="
            print(f"   [{mark}] {path}: A={json.dumps(a, ensure_ascii=False)[:60]} → B={json.dumps(b, ensure_ascii=False)[:60]}")

        await browser.close()

    print(f"\n=== 结果: {len(passed)} 通过 / {len(failed)} 失败 ===")
    if failed: print("失败项:", failed)

asyncio.run(main())
