#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证：备份导入 localStorage 写入失败时的快照回滚
1. 预置旧数据 old-1..old-5
2. 导入含 11MB 巨型 value 的备份 JSON（超过 localStorage 10MB 配额 → 写入失败）
3. 断言：failed 路径触发后旧 key 被回填；写入成功的 key 保留
"""
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
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(3500)

        # 1. 预置旧数据
        await pg.evaluate("""
        () => {
          localStorage.setItem('old-1', '旧数据一');
          localStorage.setItem('old-2', '旧数据二');
          localStorage.setItem('old-3', '旧数据三');
          localStorage.setItem('old-4', '旧数据四');
          localStorage.setItem('old-5', '旧数据五');
        }
        """)

        # 2. 构造超大备份并走真导入链路
        #    页面用的是自定义 DOM 对话框（miyaDialog），原生 confirm 事件收不到，
        #    这里直接 stub 掉确认框让它放行，其余链路保持真实。
        r = await pg.evaluate("""
        (async function(){
          window.miyaDialog.confirm = (function(){
            var n = 0;
            return function(){ n++; return Promise.resolve(n === 1); };
          })(); /* 只放行「导入确认」，拦下「建议刷新」避免页面重载 */
          var big = new Array(11 * 1024 * 1024 + 1).join('x');
          var payload = JSON.stringify({
            localStorage: { 'app-key': 'ok-value', 'huge-key': big },
            indexedDB_kv: {}
          });
          var file = new File([payload], 'backup.json', { type: 'application/json' });
          window.__importResult = null;
          window.miyaBackup.importFiles([file]);
          /* 轮询等待导入完成（toast 出现 / localStorage 稳定） */
          for (var i = 0; i < 40; i++) {
            await new Promise(function(r){ setTimeout(r, 250); });
            if (localStorage.getItem('app-key') === 'ok-value') {
              /* 再等一拍让失败处理走完 */
              await new Promise(function(r){ setTimeout(r, 600); });
              break;
            }
          }
          return {
            appKey: localStorage.getItem('app-key'),
            hugeKeyLen: (localStorage.getItem('huge-key') || '').length,
            oldKeys: ['old-1','old-2','old-3','old-4','old-5'].map(function(k){
              return localStorage.getItem(k);
            })
          };
        })()
        """)
        print("导入后状态:", {k: (v if k != 'hugeKeyLen' else f"len={v}")
                              for k, v in r.items()})

        oldBack = all(v is not None for v in r["oldKeys"])
        ok = (r["appKey"] == "ok-value" and oldBack and not errors)
        print("\n判定:")
        print("  写成功的 key 保留 (app-key):", "✓" if r["appKey"] == "ok-value" else "✗")
        print("  失败的巨型 key 未落库:", "✓" if r["hugeKeyLen"] == 0 else f"✗ len={r['hugeKeyLen']}")
        print("  旧数据 5/5 被回填:", "✓" if oldBack else f"✗ {r['oldKeys']}")
        print("  无页面错误:", "✓" if not errors else f"✗ {errors[:2]}")
        print("\n总结:", "✓ 回滚验证通过" if ok else "✗ 回滚验证失败")
        await browser.close()

asyncio.run(main())
