#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 并发 / 竞态注入（快速连点、中途切走）

思路
====
前两轮测的是「数据本身」的边界（畸形值 / 空间不够）。
这一轮测的是**时序**：用户手速和程序异步流程赛跑时，谁赢。

项目里已经有一批异步流程（store.init 水合、scheduleSubViewHydrate 延后填充、
enqueueApiPresets 串行队列、requestAnimationFrame 重绘），
这些流程单独跑都没问题，**叠上手速就会暴露竞态**。

模拟的三类真实操作：
  A. 快速连点 —— 同一入口/按钮在极短时间内点多次
  B. 中途切走 —— 异步流程没跑完就切到别处 / 关掉
  C. 渲染竞速 —— 在「延后填充」还没落地时抢着操作

这类 bug 的特征是「偶尔复现」，所以每项都跑多轮，
**只要有一轮不一致就判失败**（这正是用户说的「时好时坏」）。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/e2e_race_injection.py
"""
import asyncio
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
    contacts: [{ id: 'c_e2e', name: '小满', remarkName: '小满', groupId: 'ct-default',
      createdAt: now, updatedAt: now, chatSettings: {} }],
    chats: [{ id: 'chat_e2e', type: 'single', contactId: 'c_e2e', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now, chatSettings: {} }],
    messagesByChat: { 'chat_e2e': [] }, shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

ERR_TRAP = """
window.__caught = [];
window.addEventListener('error', function(e){
  window.__caught.push('error: ' + (e.message || String(e.error)));
});
window.addEventListener('unhandledrejection', function(e){
  window.__caught.push('rejection: ' + String((e.reason && e.reason.message) || e.reason));
});
"""

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def fresh(pg):
    await pg.goto(BASE, wait_until="load")
    await pg.wait_for_timeout(4000)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True,
            accept_downloads=True)
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await pg.add_init_script(ERR_TRAP)
        page_errors = []
        pg.on("pageerror", lambda e: page_errors.append(str(e)))
        await fresh(pg)

        # ════════════════════════════════════════════════════════
        print("\n【A】快速连点：同一次「保存」连点 8 次，只应产生 1 条")
        rounds_ok = []
        for rnd in range(1, 4):
            r = await pg.evaluate("""
            (async function(){
              var mod = window.miyaApiPresets, K = 'miya-api-presets';
              await window.miyaWriteLsJsonKey(K, []);
              mod.invalidate(); await mod.ensureReady();
              /* 背靠背连点 8 次同名保存（不 await，模拟狂点） */
              var jobs = [];
              for (var i = 0; i < 8; i++) {
                jobs.push(mod.upsert('连点线', { baseUrl: 'https://r' + i }));
              }
              var results = await Promise.allSettled(jobs);
              var rejected = results.filter(function(x){
                return x.status === 'rejected';
              }).length;
              var names = (mod.getCached() || []).map(function(x){ return x.name; });
              var disk = JSON.parse(localStorage.getItem(K) || 'null') || [];
              return { names: names,
                       disk: disk.map(function(x){ return x.name; }),
                       rejected: rejected,
                       dupCache: names.length !== new Set(names).size,
                       dupDisk: disk.length !== new Set(disk.map(function(x){return x.name;})).size };
            })()
            """)
            ok = (r["names"] == ["连点线"] and r["disk"] == ["连点线"]
                  and not r["dupCache"] and not r["dupDisk"])
            rounds_ok.append(ok)
            print(f"    第 {rnd} 轮：缓存={r['names']} 磁盘={r['disk']} "
                  f"拒绝={r['rejected']} -> {'✓' if ok else '✗'}")
        check("连点 8 次只留 1 条（3 轮一致）", all(rounds_ok),
              f"{sum(rounds_ok)}/{len(rounds_ok)}")

        # ════════════════════════════════════════════════════════
        print("\n【B】并发写不同名：快速交替存 10 条，一条都不能丢")
        rB = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, []);
          mod.invalidate(); await mod.ensureReady();
          var jobs = [];
          for (var i = 0; i < 10; i++) {
            jobs.push(mod.upsert('并发' + i, { baseUrl: 'https://c' + i }));
          }
          await Promise.all(jobs);
          var cached = (mod.getCached() || []).map(function(x){ return x.name; });
          var disk = JSON.parse(localStorage.getItem(K) || 'null') || [];
          return { cached: cached,
                   disk: disk.map(function(x){ return x.name; }),
                   diskFull: disk.length };
        })()
        """)
        expect = ["并发" + str(i) for i in range(10)]
        check("并发 10 条全部留住（缓存）", rB["cached"] == expect, str(rB["cached"]))
        check("并发 10 条全部留住（磁盘）", rB["disk"] == expect, str(rB["disk"]))

        # ════════════════════════════════════════════════════════
        print("\n【C】中途切走：子视图还没填好就返回列表")
        cut_ok = []
        for rnd in range(1, 4):
            await fresh(pg)
            rC = await pg.evaluate("""
            (async function(){
              var st = window.miyaChatStore; await st.init();
              window.miyaChatApp.open();
              await new Promise(function(r){ setTimeout(r, 700); });
              var cs = window.miyaChatContactSettings;
              /* 开子视图后【不等待】，立刻切回列表 */
              cs.openSubViewForChat('chat_e2e', 'api-chat');
              cs.open('chat_e2e');
              await new Promise(function(r){ setTimeout(r, 1500); });
              var page = document.getElementById('mq-set-page');
              if (!page) return { err: 'no page' };
              var body = page.querySelector('[data-mq-set-body]');
              /* 切回来后必须落在列表态，且不能残留半截子视图 */
              return { htmlLen: body ? body.innerHTML.length : 0,
                       hasSubNav: !!(body && body.querySelector('[data-mq-set-sub]')),
                       title: (page.querySelector('.st-navtitle')||{}).textContent };
            })()
            """)
            ok = (not rC.get("err") and rC["htmlLen"] > 500
                  and rC["hasSubNav"] and rC["title"] != "对话 API")
            cut_ok.append(ok)
            print(f"    第 {rnd} 轮：列表态={rC['hasSubNav']} "
                  f"标题={rC['title']!r} 内容={rC['htmlLen']} -> {'✓' if ok else '✗'}")
        check("中途切走能干净回到列表（3 轮一致）", all(cut_ok),
              f"{sum(cut_ok)}/{len(cut_ok)}")

        # ════════════════════════════════════════════════════════
        print("\n【D】快速来回切换子视图 6 次，最终状态必须正确")
        await fresh(pg)
        rD = await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 700); });
          var cs = window.miyaChatContactSettings;
          var subs = ['api-chat', 'api-voice', 'backup', 'storage',
                      'notify', 'chat-defaults'];
          /* 不留间隔地连续切 */
          for (var i = 0; i < subs.length; i++) {
            cs.openSubViewForChat('chat_e2e', subs[i]);
          }
          /* 最后一个 chat-defaults 应当胜出 */
          await new Promise(function(r){ setTimeout(r, 2500); });
          var page = document.getElementById('mq-set-page');
          var body = page.querySelector('[data-mq-set-body]');
          var host = page.querySelector('[data-mq-set-defaults-host]');
          return { title: (page.querySelector('.st-navtitle')||{}).textContent,
                   bodyLen: body ? body.innerHTML.length : 0,
                   hostLen: host ? host.innerHTML.length : -1,
                   notLoaded: body ? body.innerHTML.indexOf('设置模块未加载') >= 0 : null };
        })()
        """)
        check("连切 6 次后停在最后一个子视图",
              rD["title"] == "聊天默认值", repr(rD["title"]))
        check("连续切换后内容仍完整", rD["bodyLen"] > 800,
              f"body {rD['bodyLen']} 字符")
        check("连续切换后默认值面板已挂载",
              rD["hostLen"] > 500, f"host {rD['hostLen']} 字符")
        check("连续切换后没有「模块未加载」",
              rD["notLoaded"] is False, str(rD["notLoaded"]))

        # ════════════════════════════════════════════════════════
        print("\n【E】渲染竞速：在延后填充落地前抢着点导出")
        await fresh(pg)
        rE = await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 700); });
          var cs = window.miyaChatContactSettings;
          await window.miyaWriteLsJsonKey('miya-api-presets',
                [{ name: '竞速线', baseUrl: 'https://race' }]);
          window.miyaApiPresets.invalidate();

          var clicked = 0, err = null;
          cs.openSubViewForChat('chat_e2e', 'api-chat');
          /* 不等水合，立刻尝试点导出（元素可能还在 / 可能已被重绘换掉） */
          for (var i = 0; i < 6; i++) {
            var el = document.getElementById('mq-api-preset-export');
            if (el) { try { el.click(); clicked++; } catch (e) { err = String(e.message||e); } }
            await new Promise(function(r){ setTimeout(r, 120); });
          }
          await new Promise(function(r){ setTimeout(r, 2000); });
          var page = document.getElementById('mq-set-page');
          var pick = page.querySelector('#mq-api-preset-pick');
          var opts = [];
          if (pick) pick.querySelectorAll('option').forEach(function(o){
            if (o.value) opts.push(o.value);
          });
          return { clicked: clicked, err: err, opts: opts,
                   title: (page.querySelector('.st-navtitle')||{}).textContent };
        })()
        """)
        check("抢点期间不抛异常", rE["err"] is None, str(rE["err"]))
        check("抢点后子视图仍停在对话 API",
              rE["title"] == "对话 API", repr(rE["title"]))
        check("抢点后预设下拉已正确水合",
              rE["opts"] == ["竞速线"], str(rE["opts"]))

        # ════════════════════════════════════════════════════════
        print("\n【F】快速连点桌面图标 10 次（打开即崩类问题的连点版）")
        await fresh(pg)
        rF = await pg.evaluate("""
        (async function(){
          var el = document.querySelector('[data-app="beauty"]');
          if (!el) return { err: 'no beauty icon' };
          var err = null;
          for (var i = 0; i < 10; i++) {
            try { el.click(); } catch (e) { err = String(e.message || e); }
            await new Promise(function(r){ setTimeout(r, 40); });
          }
          await new Promise(function(r){ setTimeout(r, 1200); });
          var app = document.getElementById('miya-beautify-app');
          return { err: err, open: app.classList.contains('is-open'),
                   errCount: (window.__caught || []).length };
        })()
        """)
        check("连点桌面图标不抛异常", rF["err"] is None, str(rF["err"]))
        check("连点 10 次美化仍正常打开", rF["open"] is True)
        check("连点未产生未捕获异常", rF["errCount"] == 0, str(rF["errCount"]))

        # ════════════════════════════════════════════════════════
        print("\n【G】竞态下删除：边存边删，最终状态必须自洽")
        rG = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, []);
          mod.invalidate(); await mod.ensureReady();
          /* 交错：存A、删A、存B —— 不 await，让它们竞争 */
          var p1 = mod.upsert('争A', { baseUrl: 'https://a' });
          var p2 = mod.remove('争A');
          var p3 = mod.upsert('争B', { baseUrl: 'https://b' });
          await Promise.allSettled([p1, p2, p3]);
          await new Promise(function(r){ setTimeout(r, 500); });
          var cached = (mod.getCached() || []).map(function(x){ return x.name; });
          var disk = JSON.parse(localStorage.getItem(K) || 'null') || [];
          var diskNames = disk.map(function(x){ return x.name; });
          return { cached: cached, disk: diskNames,
                   same: JSON.stringify(cached) === JSON.stringify(diskNames) };
        })()
        """)
        check("竞态操作后缓存与磁盘一致",
              rG["same"] is True, f"cache={rG['cached']} disk={rG['disk']}")
        check("竞态后不应残留已删除项",
              "争A" not in rG["cached"], str(rG["cached"]))
        check("竞态后新条目已落盘",
              "争B" in rG["disk"], str(rG["disk"]))

        # ════════════════════════════════════════════════════════
        print("\n【H】全程兜底")
        ca = await pg.evaluate("window.__caught || []")
        check("竞态注入期间无未捕获异常", len(ca) == 0, str(ca[:4]))
        check("无 pageerror", len(page_errors) == 0, str(page_errors[:3]))

        # 收尾可用性
        await fresh(pg)
        rH = await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 800); });
          window.miyaChatContactSettings.openSubViewForChat('chat_e2e', 'api-chat');
          await new Promise(function(r){ setTimeout(r, 2000); });
          var page = document.getElementById('mq-set-page');
          return { title: (page.querySelector('.st-navtitle')||{}).textContent,
                   hasExport: !!page.querySelector('#mq-api-preset-export'),
                   opts: (function(){ var o=[];
                     page.querySelectorAll('#mq-api-preset-pick option').forEach(function(x){
                       if (x.value) o.push(x.value); }); return o; })() };
        })()
        """)
        check("竞态后应用仍完全可用",
              rH["title"] == "对话 API" and rH["hasExport"],
              str(rH))

        await browser.close()

    print(f"\n{'='*62}")
    print(f"通过 {len(passed)} / 共 {len(passed)+len(failed)}")
    if failed:
        print("失败项：")
        for f in failed:
            print("  -", f)
        return 1
    print("全部通过 ✅")
    return 0


raise SystemExit(asyncio.run(main()))
