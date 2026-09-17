#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 两个历史问题的回归测试

问题一：进美化功能就弹出本地相册
问题二：锁屏第一下没反应 / 时好时坏

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/regression.py
"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

# 记录所有隐藏 file input 的被点击情况，用于判定「弹相册」
FILE_TRACE = """
window.__fileOpened = [];
(function(){
  var ids = ['miya-bf-file-lock-wall','miya-bf-file-wall','miya-bf-file-icon',
             'miya-bf-file-font','miya-bf-file-import','miya-bf-file-custom-wg-import',
             'desk-custom-wg-editor-file'];
  function bind(){
    ids.forEach(function(id){
      var el = document.getElementById(id);
      if (!el || el.__traced) return;
      el.__traced = true;
      el.addEventListener('click', function(e){
        window.__fileOpened.push({id:id, trusted:e.isTrusted});
      }, true);
    });
  }
  bind();
  document.addEventListener('DOMContentLoaded', bind);
})();
"""

passed, failed = [], []

def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))

async def new_page(ctx):
    pg = await ctx.new_page()
    await pg.add_init_script(FILE_TRACE)
    pg.on("filechooser", lambda fc: asyncio.ensure_future(fc.set_files([])))
    return pg

async def goto(pg, wait=3200):
    await pg.goto(BASE, wait_until="load")
    await pg.wait_for_timeout(wait)

async def tap(cdp, x, y, wait=650):
    await cdp.send("Input.dispatchTouchEvent",
                   {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    await asyncio.sleep(0.05)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await asyncio.sleep(wait / 1000)

async def swipe(cdp, x, y0, dist=120, step=20):
    await cdp.send("Input.dispatchTouchEvent",
                   {"type": "touchStart", "touchPoints": [{"x": x, "y": y0}]})
    for yy in range(y0 - 10, y0 - dist - 10, -step):
        await cdp.send("Input.dispatchTouchEvent",
                       {"type": "touchMove", "touchPoints": [{"x": x, "y": yy}]})
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await asyncio.sleep(0.65)

async def el_center(pg, sel):
    return await pg.evaluate(
        """(sel) => { const el = document.querySelector(sel);
             if (!el) return null; const r = el.getBoundingClientRect();
             return {x: r.x + r.width/2, y: r.y + r.height/2}; }""", sel)

# ══════════════ 问题一：进美化弹相册 ══════════════
async def test_beautify(ctx, pg, cdp):
    print("\n【问题一】真实触摸桌面「美化」图标，不得弹出相册")
    await goto(pg)
    pos = await el_center(pg, '[data-app="beauty"]')
    if not pos:
        check("桌面上存在美化图标", False); return

    await pg.evaluate("window.__fileOpened = []")
    await tap(cdp, pos["x"], pos["y"], wait=1000)

    opened = await pg.evaluate("window.__fileOpened")
    is_open = await pg.evaluate(
        "document.getElementById('miya-beautify-app').classList.contains('is-open')")
    check("点一下即打开美化", is_open)
    check("没有任何 file input 被点开（相册没弹）", len(opened) == 0, str(opened))

    # 那条遗留的合成 click 必须被屏蔽层吃掉
    shield_hit = await pg.evaluate(
        "(() => { var e = document.querySelector('.miya-open-click-shield');"
        " return !!e && !e.hidden; })()")
    await pg.wait_for_timeout(600)
    shield_gone = await pg.evaluate(
        "(() => { var e = document.querySelector('.miya-open-click-shield');"
        " return !e || e.hidden; })()")
    check("屏蔽层在打开瞬间生效、并自动撤除", shield_gone, f"即时命中={shield_hit}")

    # 屏蔽层撤掉后，功能照常可用
    btn = await el_center(pg, '[data-bf-wall-pick]')
    await pg.evaluate("window.__fileOpened = []")
    await tap(cdp, btn["x"], btn["y"], wait=900)
    hit = await pg.evaluate("window.__fileOpened")
    check("屏蔽层撤除后「上传壁纸」仍能唤起选择器", len(hit) == 1, str(hit))

    # 可重复：退出再进
    await pg.evaluate("window.__miyaBeautifyExit = 1; window.miyaBeautifyApp.close()")
    await pg.wait_for_timeout(500)
    await pg.evaluate("window.__fileOpened = []")
    await tap(cdp, pos["x"], pos["y"], wait=1000)
    opened2 = await pg.evaluate("window.__fileOpened")
    is_open2 = await pg.evaluate(
        "document.getElementById('miya-beautify-app').classList.contains('is-open')")
    check("退出后再次进入，仍然不弹相册", is_open2 and len(opened2) == 0, str(opened2))

# ══════════════ 问题二：锁屏上滑 ══════════════
LOCK_META = ('{"wallpaperEnabled":true,"wallpaper":null,'
             '"passcodeEnabled":true,"passcode":"1234"}')

async def test_lockscreen(ctx, pg, cdp):
    print("\n【问题二】锁屏：任意位置起手上滑都能进密码页")
    await goto(pg, wait=2500)
    await pg.evaluate(f"localStorage.setItem('miya-lock-meta', {LOCK_META!r})")
    await pg.wait_for_timeout(200)

    # 逐点扫描起手位置（每次刷新，模拟真机每次都是干净手势）
    starts = [900, 850, 800, 700, 600, 500, 400, 300, 200]
    ok_all, detail = True, []
    for y0 in starts:
        await pg.reload(wait_until="load")
        await pg.wait_for_timeout(2700)
        cls0 = await pg.evaluate("document.getElementById('miya-lockscreen').className")
        if "is-clock" not in cls0:
            ok_all = False; detail.append(f"y={y0} 前置异常"); continue
        await swipe(cdp, 206, y0)
        cls = await pg.evaluate("document.getElementById('miya-lockscreen').className")
        got = "is-passcode" in cls
        detail.append(f"{y0}:{'✓' if got else '✗'}")
        ok_all = ok_all and got
    check(f"上滑起点全通过（{len(starts)} 个）", ok_all, " ".join(detail))

    # 顶部安全区不接管
    await pg.reload(wait_until="load"); await pg.wait_for_timeout(2700)
    await swipe(cdp, 206, 100)
    cls = await pg.evaluate("document.getElementById('miya-lockscreen').className")
    check("顶部安全区(y=100)不触发解锁，留给系统手势", "is-passcode" not in cls)

    # 密码键盘不受影响
    await pg.reload(wait_until="load"); await pg.wait_for_timeout(2700)
    await swipe(cdp, 206, 700)
    digits = await pg.evaluate("""(() => {
        window.__digits = [];
        if (!window.__digitBound) {
          window.__digitBound = true;
          document.addEventListener('click', function(e){
            var k = e.target.closest && e.target.closest('[data-lock-key]');
            if (k) window.__digits.push(k.getAttribute('data-lock-key'));
          }, true);
        }
        return true; })()""")
    for d in ["1", "2", "3", "4"]:
        p = await el_center(pg, f'[data-lock-key="{d}"]')
        await tap(cdp, p["x"], p["y"], wait=280)
    await pg.wait_for_timeout(800)
    got = await pg.evaluate("window.__digits")
    unlocked = await pg.evaluate("document.getElementById('miya-lockscreen').hidden")
    check("密码键盘四位输入全部生效", got == ["1", "2", "3", "4"], str(got))
    check("输入正确密码后成功解锁", unlocked)

    # 错误密码：不卡死，能重输
    await pg.reload(wait_until="load"); await pg.wait_for_timeout(2700)
    await swipe(cdp, 206, 700)
    await pg.evaluate("window.__digits = []")
    for d in ["9", "9", "9", "9"]:
        p = await el_center(pg, f'[data-lock-key="{d}"]')
        await tap(cdp, p["x"], p["y"], wait=280)
    await pg.wait_for_timeout(900)
    still_locked = not await pg.evaluate("document.getElementById('miya-lockscreen').hidden")
    msg = await pg.evaluate("(document.getElementById('miya-lock-pass-msg')||{}).textContent")
    check("错误密码不解锁且给出提示", still_locked and "不正确" in (msg or ""), f"msg={msg!r}")

    # 提示必须留得住（历史问题：只亮 0.5s，用户看不清）
    await pg.wait_for_timeout(1800)
    msg_late = await pg.evaluate("(document.getElementById('miya-lock-pass-msg')||{}).textContent")
    check("错误提示至少停留 2s 以上", "不正确" in (msg_late or ""), f"2.7s后 msg={msg_late!r}")

    # 错完可以直接重输，不必先按删除
    for d in ["1", "2", "3", "4"]:
        p2 = await el_center(pg, f'[data-lock-key="{d}"]')
        await tap(cdp, p2["x"], p2["y"], wait=260)
    await pg.wait_for_timeout(900)
    ok2 = await pg.evaluate("document.getElementById('miya-lockscreen').hidden")
    check("输错后可直接重输正确密码解锁", ok2)

# ══════════════ 交替失效：多次刷新一致性 ══════════════
async def test_refresh_consistency(ctx, pg, cdp):
    print("\n【关键线索】连续刷新，行为必须逐次一致（不能时好时坏）")
    await goto(pg, wait=2500)
    await pg.evaluate(f"localStorage.setItem('miya-lock-meta', {LOCK_META!r})")
    await pg.wait_for_timeout(200)

    results = []
    for i in range(1, 7):
        await pg.reload(wait_until="load")
        await pg.wait_for_timeout(2800)
        # 锁屏一致性
        lock_ok = await pg.evaluate(
            "(() => { var e=document.getElementById('miya-lockscreen');"
            " return !e.hidden && e.classList.contains('is-clock')"
            " && e.classList.contains('is-show'); })()")
        # 上滑一致性
        await swipe(cdp, 206, 700)
        ph = await pg.evaluate("document.getElementById('miya-lockscreen').className")
        swipe_ok = "is-passcode" in ph
        # 桌面可用一致性（回到无锁状态）
        await pg.evaluate("""(() => { var e=document.getElementById('miya-lockscreen');
            e.hidden = true; e.setAttribute('aria-hidden','true');
            e.classList.remove('is-show'); document.body.classList.remove('miya-lock-active'); })()""")
        await pg.wait_for_timeout(200)
        desk_ok = await pg.evaluate(
            "!!document.querySelector('[data-app=\"beauty\"]')")
        # 美化点击一致性
        await pg.evaluate("window.__fileOpened=[]")
        pos = await el_center(pg, '[data-app="beauty"]')
        await tap(cdp, pos["x"], pos["y"], wait=950)
        bf_ok = await pg.evaluate(
            "document.getElementById('miya-beautify-app').classList.contains('is-open')")
        fc = await pg.evaluate("window.__fileOpened")
        ok = lock_ok and swipe_ok and desk_ok and bf_ok and len(fc) == 0
        results.append(ok)
        print(f"    #{i}: 锁屏={lock_ok} 上滑={swipe_ok} 桌面={desk_ok} "
              f"美化={bf_ok} 相册={len(fc)}只 -> {'一致 ✓' if ok else '不一致 ✗'}")
    check("6 次刷新行为完全一致", all(results), f"{sum(results)}/{len(results)}")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport=VIEWPORT, device_scale_factor=2,
                                 is_mobile=True, has_touch=True, user_agent=UA)
        pg = await new_page(ctx)
        cdp = await ctx.new_cdp_session(pg)
        try:
            await test_beautify(ctx, pg, cdp)
            await test_lockscreen(ctx, pg, cdp)
            await test_refresh_consistency(ctx, pg, cdp)
        finally:
            await b.close()

    print("\n" + "═" * 58)
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        print("失败项：")
        for f in failed:
            print("  ·", f)
    print("═" * 58)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
