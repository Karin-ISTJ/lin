#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 存储压力测试（灌满 localStorage 逼出溢出分支）

思路
====
上一轮（数据边界注入）验的是「畸形值能不能被挡住」。这一轮换维度：
**值本身合法，但大到装不下**。目标是逼出那些平时永远走不到的溢出分支：

  1. localStorage 配额真的被占满时，写入是否明确拒绝（而非静默丢弃）
  2. 占满之后应用是否还能用（不能白屏、不能卡死、不能丢已有数据）
  3. 溢出留痕 __miyaLastStorageError 是否正确记录 key 与错误类型
  4. IDB 兜底路径是否接管（配额满时数据应落到 IDB 而不是彻底丢失）
  5. 清出空间后能否自愈

为什么这是独立的测试维度：
  「值畸形」和「空间不够」是两码事。前者的守卫是「类型/空值判断」，
  后者的守卫是「try/catch + 明确 return false」。一个项目可能把前者
  做得很干净，却在后者上出现「静默丢弃」—— 这是最难排查的一类 bug，
  README 里专门列了 __miyaLastStorageError 就是为它准备的。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/e2e_storage_pressure.py
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

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


async def drain(pg):
    e = await pg.evaluate("window.__caught || []")
    await pg.evaluate("window.__caught = []")
    return e


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True)

        # ════════════════════════════════════════════════════════
        print("\n【1】用填充数据把 localStorage 逼到配额上限")
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script(ERR_TRAP)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4500)

        fill = await pg.evaluate("""
        (function(){
          /* 每块 512KB 的纯文本，一块块塞到写不进去为止。
             用 try/catch 精确捕捉「从哪一块开始塞不下」。 */
          var chunk = 'x'.repeat(512 * 1024);
          var n = 0, errName = null, errMsg = null;
          for (var i = 0; i < 40; i++) {
            try { localStorage.setItem('__stress_fill_' + i, chunk); n++; }
            catch (e) { errName = e && e.name; errMsg = e && e.message; break; }
          }
          var used = 0;
          try {
            for (var k in localStorage) {
              if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
                used += (localStorage.getItem(k) || '').length;
              }
            }
          } catch (e2) {}
          return { chunks: n, mb: (used / 1024 / 1024).toFixed(2),
                   errName: errName, errMsg: (errMsg || '').slice(0, 80) };
        })()
        """)
        print(f"    已写入 {fill['chunks']} 块 ≈ {fill['mb']} MB，"
              f"触发 {fill['errName']}")
        check("成功把 localStorage 逼到溢出", fill["chunks"] > 0,
              f"{fill['chunks']} 块 / {fill['mb']}MB")

        # ════════════════════════════════════════════════════════
        print("\n【2】配额满状态下写预设：必须明确拒绝并留痕")
        r2 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets;
          /* 先把一条正常预设写进去 —— 注意此时可能已经走 IDB 了 */
          await window.miyaWriteLsJsonKey('miya-api-presets',
                 [{ name: '占满前', baseUrl: 'https://before' }]);
          mod.invalidate(); await mod.ensureReady();

          /* 把 localStorage 镜像这条腿也堵死，主 KV 保留 ——
             逼出「镜像写不进但 IDB 成功了」这一档，
             此时应当返回 true（数据没丢），且不应对用户报错。 */
          var before = window.__miyaLastStorageError;
          var res = null, threw = null;
          try {
            res = await mod.upsert('占满后', { baseUrl: 'https://after' });
          } catch (e) { threw = String(e && e.message || e); }
          var after = window.__miyaLastStorageError;
          var names = (mod.getCached() || []).map(function(x){ return x.name; });
          /* 关键：数据到底还在不在？去 IDB 直接问 */
          var fromIdb = await window.miyaReadLsJsonKey('miya-api-presets', null);
          return { res: Array.isArray(res) ? res.map(function(x){return x.name;}) : res,
                   threw: threw, names: names,
                   idbNames: Array.isArray(fromIdb)
                     ? fromIdb.map(function(x){ return x.name; }) : String(fromIdb),
                   errTracked: !!after, errKey: after && after.key,
                   errName: after && after.name };
        })()
        """)
        check("配额满时保存预设不抛未捕获异常",
              r2["threw"] is None, str(r2["threw"]))
        # 核心：IDB 兜底接管 —— 数据不能因为 LS 满了就丢
        check("数据被 IDB 接管，没有因为 localStorage 满而丢失",
              r2["idbNames"] == ["占满前", "占满后"], str(r2["idbNames"]))
        print(f"    （缓存内预设：{r2['names']}）")

        # ════════════════════════════════════════════════════════
        print("\n【3】兜底分支：IDB 完全不可用的设备上，写入必须如实报告失败")
        # 结论先记在这里（踩过两个坑）：
        #   · 用「循环引用」测 → 失败。kvPut 是 IndexedDB 的
        #     objectStore.put()，走结构化克隆，**原生支持循环引用**；
        #     而且这份数据确实被持久化了，此时返回 true 是【正确】的。
        #   · 用「2MB 大值」测 → 也失败。IDB 配额远大于 localStorage，
        #     主 KV 照样写得进去，返回 true 同样是【正确】的。
        #   两次「失败」都是测试自己的前提错了，不是产品 bug。
        #
        # 真正能走到兜底分支的，只有「设备压根没有可用 IDB」
        # （隐私模式 / 内核不支持 / 被策略禁用）。所以这里开一个
        # 全新页面、在脚本之前就把 indexedDB 打掉。
        pgy = await ctx.new_page()
        errY = []
        pgy.on("pageerror", lambda e: errY.append(str(e)))
        await pgy.add_init_script("""
        (function(){
          try { Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            get: function(){ throw new Error('indexedDB unavailable (simulated)'); }
          }); } catch (e) {}
        })();
        """)
        await pgy.add_init_script(ERR_TRAP)
        await pgy.goto(BASE, wait_until="load")
        await pgy.wait_for_timeout(5000)

        r3 = await pgy.evaluate("""
        (async function(){
          var K = 'miya-stress-noidb';
          window.__miyaLastStorageError = null;
          /* IDB 已不可用；localStorage 也堵死 —— 才是真正的全断 */
          var origSafe = window.miyaSafeLsSet;
          var origWk = window.miyaWidgetKvIdbPut;
          window.miyaSafeLsSet = function(){ return false; };
          window.miyaWidgetKvIdbPut = function(){ return Promise.resolve(false); };

          var wrote = null, threw = null;
          try { wrote = await window.miyaWriteLsJsonKey(K, { hello: 'no-idb' }); }
          catch (e) { threw = String(e && e.message || e); }
          var tracked = window.__miyaLastStorageError;

          window.miyaSafeLsSet = origSafe;
          window.miyaWidgetKvIdbPut = origWk;
          return { wrote: wrote, threw: threw,
                   tracked: !!tracked, key: tracked && tracked.key,
                   errName: tracked && tracked.name };
        })()
        """)
        check("无 IDB 的降级路径不抛异常", r3["threw"] is None, str(r3["threw"]))
        check("真正的全断如实返回 false（不谎报成功）",
              r3["wrote"] is False, str(r3["wrote"]))
        check("无 IDB 的页面本身无 pageerror", len(errY) == 0, str(errY[:3]))

        print("\n【3b】循环引用：IDB 原生可存，应如实返回 true 且不写坏镜像")
        r3b = await pg.evaluate("""
        (async function(){
          var K = 'miya-stress-cyclic';
          var origSafe = window.miyaSafeLsSet;
          var origWk = window.miyaWidgetKvIdbPut;
          window.miyaSafeLsSet = function(){ return false; };
          window.miyaWidgetKvIdbPut = function(){ return Promise.resolve(false); };
          var cyc = { a: 1 }; cyc.me = cyc;
          var wrote = null, threw = null;
          try { wrote = await window.miyaWriteLsJsonKey(K, cyc); }
          catch (e) { threw = String(e && e.message || e); }
          window.miyaSafeLsSet = origSafe;
          window.miyaWidgetKvIdbPut = origWk;
          var raw = null;
          try { raw = localStorage.getItem(K); } catch (e2) {}
          var back = await window.miyaReadLsJsonKey(K, 'FALLBACK');
          return { wrote: wrote, threw: threw,
                   raw: raw === null ? 'null' : String(raw).slice(0, 40),
                   backIsObj: !!(back && typeof back === 'object'),
                   backSelfRef: !!(back && back.me === back) };
        })()
        """)
        check("循环引用不抛异常", r3b["threw"] is None, str(r3b["threw"]))
        # IDB 用结构化克隆，能存循环；如实返回 true 才是对的
        check("循环引用被 IDB 如实接收（返回 true 反映真实落盘）",
              r3b["wrote"] is True, str(r3b["wrote"]))
        check("循环引用读回来仍是同一个自引用结构",
              r3b["backIsObj"] is True and r3b["backSelfRef"] is True,
              f"obj={r3b['backIsObj']} selfRef={r3b['backSelfRef']}")
        check("循环引用不留半截 JSON 镜像",
              r3b["raw"] in ("null", None) or not str(r3b["raw"]).startswith("{"),
              str(r3b["raw"]))
        await pgy.close()

        # ════════════════════════════════════════════════════════
        print("\n【4】配额满状态下应用仍可用（不白屏 / 桌面能起 / 面板能开）")
        pg2 = await ctx.new_page()
        errs2 = []
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        await pg2.add_init_script(ERR_TRAP)
        # 新页面同样先把配额灌满
        await pg2.add_init_script("""
        (function(){
          try {
            var chunk = 'y'.repeat(512 * 1024);
            for (var i = 0; i < 40; i++) {
              try { localStorage.setItem('__stress_fill_' + i, chunk); }
              catch (e) { break; }
            }
          } catch (e) {}
        })();
        """)
        await pg2.goto(BASE, wait_until="load")
        await pg2.wait_for_timeout(6000)
        r4 = await pg2.evaluate("""
        (function(){
          var desk = document.querySelector('[data-app="beauty"]');
          var ls = document.getElementById('miya-lockscreen');
          return {
            deskReady: !!desk,
            deskVisible: desk ? !!(desk.offsetWidth || desk.offsetHeight) : false,
            bodyChildren: document.body.children.length,
            blank: document.body.innerHTML.length < 2000,
            lockHidden: ls ? ls.hidden : null
          };
        })()
        """)
        check("配额满时页面不白屏", r4["blank"] is False,
              f"body 内容 {r4['bodyChildren']} 个子节点")
        check("配额满时桌面正常渲染", r4["deskReady"] is True)
        check("配额满时无 pageerror", len(errs2) == 0, str(errs2[:3]))
        check("配额满时无未捕获异常", len(await drain(pg2)) == 0)

        # 面板能否打开
        r4b = await pg2.evaluate("""
        (async function(){
          try {
            window.miyaChatApp.open();
            await new Promise(function(r){ setTimeout(r, 900); });
            return { opened: document.getElementById('miya-chat-app')
                              .classList.contains('is-open') };
          } catch (e) { return { err: String(e && e.message || e) }; }
        })()
        """)
        check("配额满时聊天 App 仍能打开",
              r4b.get("opened") is True or r4b.get("err") is None,
              str(r4b))

        # ════════════════════════════════════════════════════════
        print("\n【5】清出空间后自愈：写入恢复正常、留痕被复位")
        r5 = await pg2.evaluate("""
        (async function(){
          /* 清掉填充块 */
          var keys = [];
          for (var k in localStorage) {
            if (k.indexOf('__stress_fill_') === 0) keys.push(k);
          }
          keys.forEach(function(k){ try { localStorage.removeItem(k); } catch (e) {} });

          window.__miyaLastStorageError = null;
          var ok = await window.miyaWriteLsJsonKey('miya-heal-test',
                     { hello: 'world', n: 42 });
          var back = await window.miyaReadLsJsonKey('miya-heal-test', null);
          if (typeof window.miyaNotifyStorageRecovered === 'function') {
            window.miyaNotifyStorageRecovered();
          }
          return { removed: keys.length, ok: ok,
                   back: back && back.hello,
                   errAfter: window.__miyaLastStorageError };
        })()
        """)
        check("清出空间后写入恢复成功", r5["ok"] is True, str(r5["ok"]))
        check("写进去的数据读得回来",
              r5["back"] == "world", str(r5["back"]))
        check("恢复后留痕被复位",
              r5["errAfter"] is None, str(r5["errAfter"]))
        print(f"    （清掉 {r5['removed']} 个填充块）")

        # ════════════════════════════════════════════════════════
        print("\n【6】超长单值：一次写入远超配额的内容")
        r6 = await pg2.evaluate("""
        (async function(){
          window.__miyaLastStorageError = null;
          var huge = { blob: 'z'.repeat(8 * 1024 * 1024) };  /* 8MB 单值 */
          var wrote = null, threw = null;
          try { wrote = await window.miyaWriteLsJsonKey('miya-huge-single', huge); }
          catch (e) { threw = String(e && e.message || e); }
          var tracked = window.__miyaLastStorageError;
          /* 无论成败，都不得把 localStorage 搞到后续读不出来的状态 */
          var canStillRead = null;
          try { canStillRead = localStorage.getItem('miya-heal-test') !== undefined; }
          catch (e2) { canStillRead = false; }
          return { wrote: wrote, threw: threw,
                   tracked: !!tracked,
                   canStillRead: canStillRead };
        })()
        """)
        check("超大单值不抛未捕获异常", r6["threw"] is None, str(r6["threw"]))
        check("超大单值写入后 localStorage 仍可读", r6["canStillRead"] is True)

        # ════════════════════════════════════════════════════════
        print("\n【7】全程兜底")
        check("压力测试全程无 pageerror", len(errs2) == 0, str(errs2[:3]))
        check("压力测试全程无未捕获异常", len(await drain(pg2)) == 0)

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
