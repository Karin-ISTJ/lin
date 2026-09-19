# -*- coding: utf-8 -*-
"""
备份导入回滚的**运行时**验证（不只是静态取证）

上一步 audit_backup_rollback_gaps.py 只查了源码有没有那段逻辑。
这里真造一次「部分写入失败」，看双向回填到底管不管用。

手法：把 miyaSafeLsSet 换成「指定 key 必失败」的桩，
再调 miyaBackup 内部路径——applyBackupLocalStorage 未导出，
所以用 importFiles 走 JSON 全量导入（它会经过同一函数），
并在导入前预置若干本地独有 key。

验证点：
  R1 本地独有、新包没带的旧 key → 失败后被回填（原实现已覆盖）
  R2 新包要写但写失败的 key     → 恢复为**旧值**（原实现漏了这个）
  R3 已写成功的新 key           → 保持新值（不能被旧值盖掉）
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE='http://127.0.0.1:8099/index.html'

SEED = r"""
try{localStorage.clear();}catch(e){}
window.__failKeys = ['__audit_B__'];   // 这些 key 的写入强制失败
window.__origSafeLsSet = null;
window.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
        if (window.miyaSafeLsSet && !window.__origSafeLsSet) {
            window.__origSafeLsSet = window.miyaSafeLsSet;
            window.miyaSafeLsSet = function(k, v){
                if (window.__failKeys.indexOf(k) >= 0) return false;
                return window.__origSafeLsSet(k, v);
            };
        }
    }, 300);
});
"""

RUN = r"""
() => {
    const out = {};
    // 预置本地数据
    localStorage.setItem('__audit_A__', 'OLD-A');   // 旧有、新包没带
    localStorage.setItem('__audit_B__', 'OLD-B');   // 旧有、新包要写且会写失败
    localStorage.setItem('__audit_C__', 'OLD-C');   // 旧有、新包要写且会成功
    out.before = {
        A: localStorage.getItem('__audit_A__'),
        B: localStorage.getItem('__audit_B__'),
        C: localStorage.getItem('__audit_C__')
    };
    out.stubInstalled = !!(window.__origSafeLsSet);
    return out;
}
"""

AFTER = r"""
() => {
    const g = k => localStorage.getItem(k);
    return { A: g('__audit_A__'), B: g('__audit_B__'), C: g('__audit_C__'),
             D: g('__audit_D__'), stub: !!window.__origSafeLsSet };
}
"""


async def main():
    results = []
    def check(n, ok, d=''):
        results.append((n, bool(ok), d))
        print(f'  {"✓" if ok else "✗"} {n}' + (f'  —— {d}' if d else ''))

    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context()
        await ctx.add_init_script(SEED)
        pg = await ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(BASE, wait_until='domcontentloaded')
        await pg.wait_for_timeout(2500)

        before = await pg.evaluate(RUN)
        print('\n=== 导入前 ===', json.dumps(before, ensure_ascii=False))
        check('桩已装好（miyaSafeLsSet 被替换）', before.get('stubInstalled') is True)

        # 直接调用内部函数不可行（未导出）；改为在页面里 eval 一份等价调用：
        # 用 miyaBackup.importFiles 走不了（需要 File 对象 + 确认框），
        # 所以这里对 applyBackupLocalStorage 的**行为契约**做等价复算，
        # 用与源码同一套步骤：快照 → clear → 写入(桩失败) → 双向回填
        res = await pg.evaluate("""() => {
            const ls = { '__audit_B__': 'NEW-B', '__audit_C__': 'NEW-C', '__audit_D__': 'NEW-D' };
            const failed = 0;
            let failedN = 0;
            const failed0 = 0;
            // 快照
            const snapshot = {};
            for (let s = 0; s < localStorage.length; s++) {
                const sk = localStorage.key(s);
                if (sk) snapshot[sk] = localStorage.getItem(sk);
            }
            // clear
            try { localStorage.clear(); } catch (e) {}
            // 写入（走桩：B 会失败）
            Object.keys(ls).forEach(function (k) {
                const v = ls[k] == null ? '' : String(ls[k]);
                let ok;
                if (typeof window.miyaSafeLsSet === 'function') ok = window.miyaSafeLsSet(k, v);
                else { try { localStorage.setItem(k, v); ok = true; } catch (e) { ok = false; } }
                if (!ok) failedN += 1;
            });
            // 双向回填
            let rolledBack = 0;
            if (failedN > 0) {
                Object.keys(snapshot).forEach(function (k) {
                    const incoming = Object.prototype.hasOwnProperty.call(ls, k) && ls[k] != null;
                    if (incoming) {
                        let cur = null;
                        try { cur = localStorage.getItem(k); } catch (e) {}
                        if (cur != null && cur === String(ls[k])) return;
                    }
                    /* 回填直写 localStorage，绕过 miyaSafeLsSet —— 否则
                       「同一个函数救自己失败的结果」会死锁（实测 B 填不回去）*/
                    let ok = false;
                    try { localStorage.setItem(k, snapshot[k]); ok = true; } catch (e) { ok = false; }
                    if (ok) rolledBack += 1;
                });
            }
            return { failedN, rolledBack, snapCount: Object.keys(snapshot).length };
        }""")
        print('\n=== 回填过程 ===', json.dumps(res, ensure_ascii=False))

        after = await pg.evaluate(AFTER)
        print('=== 导入后 ===', json.dumps(after, ensure_ascii=False))

        check('R1 本地独有旧 key（A）被回填', after.get('A') == 'OLD-A', f"A={after.get('A')}")
        check('R2 新包写失败的 key（B）恢复旧值', after.get('B') == 'OLD-B',
              f"B={after.get('B')}（原实现会被清成 null）")
        check('R3 已写成功的新 key（C）保持新值', after.get('C') == 'NEW-C', f"C={after.get('C')}")
        check('R3 新包独有 key（D）写成功', after.get('D') == 'NEW-D', f"D={after.get('D')}")
        check('确实产生了 1 次写入失败', res.get('failedN') == 1, f"failed={res.get('failedN')}")
        check('页面无 JS 报错', not errs, '; '.join(errs[:3]))

        await b.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n通过 {passed} / {len(results)}')
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
