#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SW 缓存策略回归 —— 「修好的 bug 过几天又复发」的根治验证。

背景：线下功能「重发」生成的旧代码逻辑修复其实是完整的，但用户浏览器
在某些时刻仍在跑旧版脚本（网络抖动时 SW 回退到缓存里任意 ?v= 的旧副本；
或 ?v= 漏 bump 时 SW 的 fetch 命中 HTTP 层旧响应）。本次修复把 SW 的
cache key 归一化（去 ?v=），networkFirst 加 cache:'no-cache'，并加版本哨兵。

四个场景（每个都做了新旧 sw.js 的 A/B 对照设计）：

  A. 漏 bump ?v= + JS 长缓存（模拟 CDN max-age）
     部署 v2 只改 JS 内容不改 ?v= → 在线重开必须拿到 v2（no-cache 协商）。
     旧 sw.js：SW fetch 命中 HTTP 缓存的新鲜副本 → 永远 v1 → 挂。
     离线重开也必须是 v2（归一 key 的副本 = 最后在线版本）。

  B. 浏览器入口与 PWA 入口（/?source=pwa）交替
     v1 从浏览器入口在线打开，v2 从 PWA 入口在线打开，随后离线、
     再从浏览器入口打开 → 必须是 v2。
     旧 sw.js：两个入口的导航 key 不同（'/' 与 '/?source=pwa'），
     浏览器入口回退到 v1 HTML → 引用 ?v=7 → v1 副本 → 挂。

  C. 版本哨兵（app.js + sw.js）
     C2/C3/C4（app.js 监听逻辑）：SW 广播的 build 新于页面 meta → 自动 reload 一次；
     重复广播同 build → 不再 reload（防循环）；广播旧 build → 不 reload（防离线被旧 SW 踢回）。
     C5（sw.js 修复点）：页面主动 postMessage 询问 → SW 回包 build=sw-2。
     基线 sw.js 无 message handler → 不回包（锚定本次修复）。

  D. 缓存副本唯一性
     当前 CACHE 里不存在带查询串的 key；probe 路径只有一份副本。
     旧 sw.js：?v=7 与 ?v=8 两份并存 → 挂。

用法：
    python3 test/sw_cache_regression.py            # 跑新 sw.js（应全过）
    SW_BASELINE=1 python3 test/sw_cache_regression.py   # 跑原包 sw.js（A/B/D 应挂）
"""
import asyncio
import functools
import http.server
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import zipfile

from playwright.async_api import async_playwright

SRC_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP_PATH = os.path.abspath(os.path.join(SRC_ROOT, os.pardir, os.pardir))
PORT_A = 8097   # 场景 A / C / D
PORT_B = 8096   # 场景 B（独立 origin，避免与 A 交叉）

UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


class CacheCtlHandler(http.server.SimpleHTTPRequestHandler):
    """模拟真实托管：JS/CSS 长缓存，HTML 协商缓存。"""

    def end_headers(self):
        try:
            p = self.path.split('?')[0]
            if p.endswith('.js') or p.endswith('.css') or p.endswith('.png'):
                self.send_header('Cache-Control', 'public, max-age=86400')
            else:
                self.send_header('Cache-Control', 'no-cache')
        except Exception:
            pass
        super().end_headers()

    def log_message(self, *args):
        pass


def start_server(port, directory):
    handler = functools.partial(CacheCtlHandler, directory=directory)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


def make_site_copy(dst):
    """整站浅拷贝（真实项目文件），供测试改写模拟部署。"""
    shutil.copytree(SRC_ROOT, dst, ignore=shutil.ignore_patterns(
        'test', 'docs', '.git', 'node_modules', '__pycache__'))
    if os.environ.get('SW_BASELINE') == '1':
        # A/B 对照：把原包里的 sw.js 换回来（逻辑修复前的旧缓存机制）
        for cand in glob_zip_paths():
            with zipfile.ZipFile(cand) as z:
                with z.open('sw.js') as f:
                    with open(os.path.join(dst, 'sw.js'), 'wb') as out:
                        out.write(f.read())
            break


def glob_zip_paths():
    # 在 /root/uploads 下找原包 zip（沙箱里上传文件带数字前缀）
    for name in sorted(os.listdir('/root/uploads')):
        if name.endswith('karinn-fixed-v7.2-fixes.zip'):
            yield os.path.join('/root/uploads', name)


PROBE_HTML_SNIPPET = """
<script>
(function () {
  var qs = document.currentScript.getAttribute('data-probe-qs') || '?v=7';
  window.__htmlBuild = parseInt(document.currentScript.getAttribute('data-html-build') || '1', 10);
  window.__probeResult = null;
  window.__probeStatus = null;
  fetch('./probe.js' + qs).then(function (r) {
    window.__probeStatus = r.status;
    return r.text();
  }).then(function (t) {
    window.__probeResult = t;
  }).catch(function (e) {
    window.__probeResult = 'FETCH_ERR:' + (e && e.message);
  });
})();
</script>
"""


def patch_index(path, html_build, probe_qs):
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()
    marker = '</body>'
    snippet = PROBE_HTML_SNIPPET.replace('?v=7', probe_qs).replace("'1'", str(html_build))
    html = html.replace(marker, snippet + marker, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)


def write_probe(path, version):
    with open(path, 'w', encoding='utf-8') as f:
        f.write("// probe v%d\nwindow.PROBE_VERSION = %d;\n" % (version, version))


async def wait_probe(page, timeout=15000):
    await page.wait_for_function("() => window.__probeResult !== null", timeout=timeout)
    return await page.evaluate("() => window.__probeResult")


async def goto_online(page, base):
    await page.goto(base, wait_until="load")
    return await wait_probe(page)


async def main():
    tmp = tempfile.mkdtemp(prefix='karinn_sw_')
    site_a = os.path.join(tmp, 'siteA')
    site_b = os.path.join(tmp, 'siteB')
    make_site_copy(site_a)
    shutil.copytree(site_a, site_b)

    srv_a = start_server(PORT_A, site_a)
    srv_b = start_server(PORT_B, site_b)
    base_a = 'http://localhost:%d/' % PORT_A
    base_b = 'http://localhost:%d/' % PORT_B

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        ctx = await browser.new_context(user_agent=UA, viewport=VIEWPORT)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

        # ── 场景 A：漏 bump ?v= + JS 长缓存 ─────────────────────────
        print('场景 A：漏 bump ?v= + JS 长缓存 → 在线重开/离线都必须拿到新版本')
        patch_index(os.path.join(site_a, 'index.html'), 1, '?v=7')
        write_probe(os.path.join(site_a, 'probe.js'), 1)

        # 首次访问：注册 SW（首次会话页面不受控，probe 走网络）
        await goto_online(page, base_a)
        v = await wait_probe(page)
        check('A1 首次在线访问 probe=v1（基线）', 'v1' in v, repr(v))

        await page.evaluate("() => navigator.serviceWorker.ready.then(r => !!r.active)")
        # 重开一次让 SW 接管导航，同时让副本进缓存
        r = await goto_online(page, base_a)
        ctrl = await page.evaluate("() => !!navigator.serviceWorker.controller")
        check('A2 重开后页面受 SW 控制', ctrl)
        check('A3 受控后在线访问 probe=v1（副本已缓存）', 'v1' in r, repr(r))

        # 「部署 v2」：只改 probe.js 内容，?v= 不动（漏 bump），HTML 不动
        time.sleep(1.3)  # 避开 Last-Modified 秒级粒度，保证协商返回 200
        write_probe(os.path.join(site_a, 'probe.js'), 2)

        r = await goto_online(page, base_a)
        ok_a4 = 'v2' in r
        if os.environ.get('SW_BASELINE') == '1':
            check('A4★[基线预期失败] 在线重开应拿到 v2（no-cache 协商）', not ok_a4, '基线拿到 %r（旧机制吃 HTTP 缓存）' % r)
        else:
            check('A4★ 在线重开拿到 v2（no-cache 协商，绕开 HTTP 缓存旧副本）', ok_a4, repr(r))

        # 离线：回退必须是「最后一次在线版本」= v2
        await ctx.set_offline(True)
        try:
            await page.goto(base_a, wait_until='commit', timeout=20000)
        except Exception:
            pass
        try:
            r = await wait_probe(page)
        except Exception as e:
            r = 'TIMEOUT:%s' % e
        ok_a5 = 'v2' in str(r)
        if os.environ.get('SW_BASELINE') == '1':
            check('A5★[基线预期失败] 离线回退应拿到 v2', not ok_a5, '基线拿到 %r' % r)
        else:
            check('A5★ 离线回退拿到 v2（归一 key 副本=最后在线版本）', ok_a5, repr(r))

        # ── 场景 C：版本哨兵 ────────────────────────────────────────
        print('场景 C：版本哨兵（SW 新于页面 → reload 一次；防循环、防旧 SW 踢回）')
        await ctx.set_offline(False)
        await page.goto(base_a, wait_until='load')
        await page.evaluate("() => sessionStorage.removeItem('miya-sw-build-reloaded')")

        async def dispatch_build(build):
            await page.evaluate("""(b) => {
              navigator.serviceWorker.dispatchEvent(
                new MessageEvent('message', { data: { type: 'miya-sw-build', build: b } }));
            }""", build)

        async def load_seq():
            return await page.evaluate("""() => {
              var n = parseInt(sessionStorage.getItem('__swSeq') || '0', 10) + 1;
              sessionStorage.setItem('__swSeq', String(n));
              return n;
            }""")

        s0 = await load_seq()
        # 与页面 meta 相同 → 不 reload。
        # meta 从部署副本动态读取：BUILD 每次发版递增（sw-3→sw-4→…），
        # 硬编码 dispatch 值会在下一次提版后变成「旧于页面」，语义悄悄漂移。
        html_src = open(os.path.join(site_a, 'index.html'), encoding='utf-8').read()
        m_meta = re.search(r'<meta name="miya-sw-build" content="([^"]+)"', html_src)
        meta_build = m_meta.group(1) if m_meta else 'sw-0'
        await dispatch_build(meta_build)   # 与页面 meta 相同 → 不 reload
        await page.wait_for_timeout(700)
        s1 = await load_seq()
        check('C1 build 相同不刷新', s1 == s0 + 1, '%d → %d（meta=%s）' % (s0, s1, meta_build))

        await dispatch_build('sw-9')          # 新于页面 → reload 一次
        await page.wait_for_timeout(1200)
        s2 = await load_seq()
        # reload 会重建文档并重新执行上面 load_seq 的调用（s2 已含新文档的 +1）
        nav_type = await page.evaluate("() => (performance.getEntriesByType('navigation')[0]||{}).type")
        ok_c2 = nav_type == 'reload'
        if os.environ.get('SW_BASELINE') == '1':
            # 基线只替换 sw.js，app.js 仍是新版 → 手动 dispatch 仍会触发 reload；
            # 此项验证的是 app.js 监听逻辑（非 sw.js 修复点），不作为基线锚定点。
            check('C2 SW 新于页面 → 自动 reload（app.js 监听逻辑）', ok_c2, '基线 nav=%r（app.js 仍是新版）' % nav_type)
        else:
            check('C2★ SW 新于页面 → 自动 reload（app.js 监听到 build>meta）', ok_c2, 'nav=%r' % nav_type)

        await dispatch_build('sw-9')          # 重复广播 → 不再 reload
        await page.wait_for_timeout(900)
        nav_type2 = await page.evaluate("() => (performance.getEntriesByType('navigation')[0]||{}).type")
        await page.wait_for_timeout(200)
        reloaded_flag = await page.evaluate("() => sessionStorage.getItem('miya-sw-build-reloaded')")
        check('C3 重复广播不再刷新（sessionStorage 防环）', reloaded_flag == '1', 'flag=%r nav2=%r' % (reloaded_flag, nav_type2))

        await page.evaluate("() => sessionStorage.removeItem('miya-sw-build-reloaded')")
        await dispatch_build('sw-1')           # 旧于页面 → 不 reload
        await page.wait_for_timeout(900)
        nav_type3 = await page.evaluate("() => (performance.getEntriesByType('navigation')[0]||{}).type")
        check('C4 SW 旧于页面不刷新（防离线被旧 SW 踢回旧缓存页）', nav_type3 in ('reload', 'navigate'), 'nav=%r' % nav_type3)
        # C4 强化：不应发生新的 reload —— 上面 dispatch 后等了 900ms，若发生 reload nav_type 会刷新为新的 reload 条目；
        # 用时间戳判断：dispatch 前后 navigation entry 的 startTime 不变
        ts1 = await page.evaluate("() => performance.getEntriesByType('navigation')[0].startTime")
        await dispatch_build('sw-1')
        await page.wait_for_timeout(700)
        ts2 = await page.evaluate("() => performance.getEntriesByType('navigation')[0].startTime")
        check('C4b 旧 build 广播后页面未导航', abs(ts1 - ts2) < 1e-6, '%s vs %s' % (ts1, ts2))

        # C5：主动询问 SW → 回包 build（锚定 sw.js 的 message handler + BUILD）
        # 页面 postMessage {type:'miya-get-build'}，SW 回 {type:'miya-sw-build', build}。
        # 基线 sw.js 无 message handler、无 BUILD → 不回包（3s 超时 → null）。
        got_build = await page.evaluate("""() => new Promise(resolve => {
          var done = false;
          function finish(v) { if (!done) { done = true; resolve(v); } }
          var t = setTimeout(function () { finish(null); }, 3000);
          navigator.serviceWorker.addEventListener('message', function onMsg(ev) {
            if (ev.data && ev.data.type === 'miya-sw-build') {
              navigator.serviceWorker.removeEventListener('message', onMsg);
              clearTimeout(t);
              finish(ev.data.build);
            }
          });
          try {
            navigator.serviceWorker.controller.postMessage({ type: 'miya-get-build' });
          } catch (e) { finish('NO_CONTROLLER'); }
        })""")
        # 期望值从部署副本的 sw.js 动态读取：硬编码 build 号会在每次提版后失配，
        # 让这条「SW 主动回包」的锚定悄悄失效。
        sw_src = open(os.path.join(site_a, 'sw.js'), encoding='utf-8').read()
        m_build = re.search(r"var BUILD = '([^']+)'", sw_src)
        expect_build = m_build.group(1) if m_build else None
        ok_c5 = expect_build is not None and got_build == expect_build
        if os.environ.get('SW_BASELINE') == '1':
            check('C5★[基线预期失败] SW 主动询问 → 回包 build=%s' % expect_build, not ok_c5, '基线 got=%r（旧 sw.js 无 message handler）' % got_build)
        else:
            check('C5★ SW 主动询问 → 回包 build=%s（message handler + BUILD）' % expect_build, ok_c5,
                  'got=%r expect=%r' % (got_build, expect_build))

        # ── 场景 D：缓存副本唯一性 ──────────────────────────────────
        print('场景 D：缓存 key 归一（同路径唯一副本，无 ?v= 残留）')
        d = await page.evaluate("""() => (async () => {
          var names = await caches.keys();
          var miya = names.filter(n => n.indexOf('miya-v') === 0);
          if (!miya.length) return { err: 'no miya cache' };
          var c = await caches.open(miya[0]);
          var keys = await c.keys();
          return {
            names: miya,
            probeKeys: keys.filter(k => new URL(k.url).pathname.endsWith('/probe.js')).map(k => k.url),
            queryKeys: keys.filter(k => new URL(k.url).search).map(k => k.url)
          };
        })()""")
        ok_d1 = d and not d.get('err') and len(d.get('probeKeys', [])) == 1 and 'probe.js' in d['probeKeys'][0] and '?' not in d['probeKeys'][0]
        if os.environ.get('SW_BASELINE') == '1':
            check('D1★[基线预期失败] probe 副本唯一且无查询串', not ok_d1, '基线 probeKeys=%r' % (d and d.get('probeKeys')))
        else:
            check('D1★ probe 副本唯一且无查询串', ok_d1, repr(d and d.get('probeKeys')))
        ok_d2 = d and len(d.get('queryKeys', [])) == 0
        if os.environ.get('SW_BASELINE') == '1':
            check('D2★[基线预期失败] 当前 CACHE 无 ?v= 残留 key', not ok_d2, '基线 queryKeys=%r' % (d and d.get('queryKeys')))
        else:
            check('D2★ 当前 CACHE 无 ?v= 残留 key', ok_d2, repr(d and d.get('queryKeys')))

        await page.close()
        await ctx.close()
        # ── 场景 B：双入口交替（独立 origin）────────────────────────
        print('场景 B：浏览器入口 / PWA 入口交替 → 离线回退必须是最后在线版本')
        ctx2 = await browser.new_context(user_agent=UA, viewport=VIEWPORT)
        page2 = await ctx2.new_page()
        patch_index(os.path.join(site_b, 'index.html'), 1, '?v=7')
        write_probe(os.path.join(site_b, 'probe.js'), 1)

        await goto_online(page2, base_b)                    # v1 · 浏览器入口
        await page2.evaluate("() => navigator.serviceWorker.ready.then(r => !!r.active)")
        r = await goto_online(page2, base_b)
        check('B1 v1 在线（浏览器入口，SW 受控）', 'v1' in r and await page2.evaluate("() => !!navigator.serviceWorker.controller"), repr(r))

        time.sleep(1.3)
        patch_index(os.path.join(site_b, 'index.html'), 2, '?v=8')
        write_probe(os.path.join(site_b, 'probe.js'), 2)

        r = await goto_online(page2, base_b + '?source=pwa')  # v2 · PWA 入口
        hb = await page2.evaluate("() => window.__htmlBuild")
        ok_b2 = 'v2' in r and hb == 2
        check('B2 v2 在线（PWA 入口）', ok_b2, 'probe=%r htmlBuild=%r' % (r, hb))

        await ctx2.set_offline(True)
        try:
            await page2.goto(base_b, wait_until='commit', timeout=20000)
        except Exception:
            pass
        try:
            r = await wait_probe(page2)
            hb = await page2.evaluate("() => window.__htmlBuild")
        except Exception as e:
            r, hb = 'TIMEOUT:%s' % e, -1
        ok_b3 = 'v2' in str(r) and hb == 2
        if os.environ.get('SW_BASELINE') == '1':
            check('B3★[基线预期失败] 离线从浏览器入口打开 → v2', not ok_b3, '基线 probe=%r htmlBuild=%r' % (r, hb))
        else:
            check('B3★ 离线从浏览器入口打开 → v2（双入口归一同一副本）', ok_b3, 'probe=%r htmlBuild=%r' % (r, hb))

        await page2.close()
        await ctx2.close()
        await browser.close()

    srv_a.shutdown()
    srv_b.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)

    print('════════════════════════════════════════════════════════')
    print(f"通过 {len(passed)} / 共 {len(passed) + len(failed)}")
    if failed:
        print('失败项：')
        for f_ in failed:
            print('  ✗', f_)
        sys.exit(1)
    print('全部通过 ✅')


if __name__ == '__main__':
    asyncio.run(main())
