#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冒烟：storage-usage 模块三个修复点可调用、不抛错"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(user_agent=UA, viewport={"width": 412, "height": 915})
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(3500)
        r = await pg.evaluate("""
        (async function(){
          var su = window.miyaStorageUsage;
          var out = { hasModule: !!su };
          if (!su) return out;
          try { su.invalidate(); out.invalidateOk = true; }
          catch (e) { out.invalidateOk = false; out.invalidateErr = String(e); }
          try { var c = await su.collect(true); out.collectOk = !!c && !!c.groupLs; }
          catch (e) { out.collectOk = false; out.collectErr = String(e); }
          try { var d = await su.deleteAllChatImages([]); out.deleteOk = d && d.ok === 0; }
          catch (e) { out.deleteOk = false; out.deleteErr = String(e); }
          try { await su.clearCategory('api'); out.clearApiOk = true; }
          catch (e) { out.clearApiOk = false; out.clearApiErr = String(e); }
          return out;
        })()
        """)
        print("冒烟结果:", r)
        print("页面错误数:", len(errors), errors[:3])
        ok = (r.get("hasModule") and r.get("invalidateOk") and r.get("collectOk")
              and r.get("deleteOk") and r.get("clearApiOk") and not errors)
        print("\n判定:", "✓ 全部通过" if ok else "✗ 存在失败项")
        await browser.close()

asyncio.run(main())
