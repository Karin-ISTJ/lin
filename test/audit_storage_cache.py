# -*- coding: utf-8 -*-
"""
存储用量快照缓存审计（BUG-2 遗留项：collect(force) 参数被忽略）

第七批修掉了 storage-usage 三处未定义引用，但 collect(force) 这个
「接了参数却不用、注释里还承诺绕过缓存」的问题当时只记录了、没修。
本批补齐：真缓存 + force 语义落地 + 三处写操作后失效。

验证：
  C1 collect(true) 连续两次都能拿到数据（不因缓存而返回 null）
  C2 缓存确实生效：两次 collect() 返回同一对象引用
  C3 force=true 绕过缓存：返回新对象
  C4 invalidate() 之后 collect() 重新扫描（新对象）
  C5 清空分类后缓存自动失效（用量数字会变）
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
SEED = "try{localStorage.clear();}catch(e){}"

PROBE = r"""
async () => {
  const out = { steps: [] };
  const log = (k, v) => out.steps.push([k, v]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const su = window.miyaStorageUsage;
  if (!su) return { fatal: 'no miyaStorageUsage' };

  await sleep(300);

  // C1 / C2
  const a = await su.collect(true);
  const b = await su.collect();          // 应命中缓存 → 同一引用
  const c = await su.collect(true);      // 强制重扫 → 新引用
  log('C1_true_twice_ok', !!(a && c && a.groupLs && c.groupLs));
  log('C2_cache_hit_same_ref', b === a);
  log('C3_force_new_ref', c !== a);

  // C4 invalidate
  su.invalidate();
  const d = await su.collect();
  log('C4_after_invalidate_new_ref', d !== b);

  // C5 清空分类后缓存失效 —— 用对象引用作判据（分类数字本身可能是 0，测不出变化）
  await su.clearCategory('notify');
  const beforeClearRef = await su.collect();
  await su.clearCategory('chat');
  const afterClearRef = await su.collect();
  log('C5_clear_invalidates_cache', {
      sameRef: afterClearRef === beforeClearRef,
      invalidated: afterClearRef !== beforeClearRef
  });

  out.keys = Object.keys(su);
  return out;
}
"""

async def main():
    results = []
    def check(n, ok, d=''):
        results.append((n, bool(ok), d)); print(f'  {"✓" if ok else "✗"} {n}' + (f'  —— {d}' if d else ''))

    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context()
        await ctx.add_init_script(SEED)
        pg = await ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(BASE, wait_until='domcontentloaded')
        await pg.wait_for_timeout(2200)
        res = await pg.evaluate(PROBE)
        print('\n=== 观测 ==='); print(json.dumps(res, ensure_ascii=False, indent=2))
        if res.get('fatal'):
            print('致命：', res['fatal']); await b.close(); sys.exit(1)
        S = dict((k, v) for k, v in res.get('steps', []))
        print('\n=== 断言 ===')
        check('C1 collect(true) 可用且结构正确', S.get('C1_true_twice_ok') is True)
        check('C2 缓存生效：连续 collect() 返回同一引用', S.get('C2_cache_hit_same_ref') is True)
        check('C3 force=true 绕过缓存', S.get('C3_force_new_ref') is True)
        check('C4 invalidate() 后重新扫描', S.get('C4_after_invalidate_new_ref') is True)
        c5 = S.get('C5_clear_invalidates_cache', {})
        check('C5 清空分类后缓存自动失效', c5.get('invalidated') is True, json.dumps(c5, ensure_ascii=False))
        check('页面无 JS 报错', not errs, '; '.join(errs[:3]))
        await b.close()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n通过 {passed} / {len(results)}'); sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
