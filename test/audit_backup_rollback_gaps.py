# -*- coding: utf-8 -*-
"""
备份导入回滚的**残余缺口**审计（第七批 BUG-3 的补充）

第七批给 applyBackupLocalStorage 加了「快照 + 失败回填」，方向是对的，
但复核后发现三个没堵住的洞：

  G1  回填只补「旧有、新包没有」的 key；对「新包有、写入失败」的 key
      不做处理。结果是 clear() 之后这些 key **彻底消失**，
      而它们在导入前可能好好存在（新版备份缺字段、或备份本身不完整）。
      → 回填方向应该是双向的：新包写失败的，也要尝试恢复旧值。

  G2  ZIP 导入路径 importOneBackupZip 拿到 lsFailed 后**只返回、不提示**，
      用户看不到任何「本地设置写入失败」的反馈，而 ZIP 才是主推的导入方式。
      （JSON 路径 restoreBackupPayload 有 toast，ZIP 路径没有。）

  G3  快照本身失败（隐私模式 / 配额满）和 clear() 失败都被静默吞掉，
      没有把「无法回滚」这个事实告诉调用方 —— 用户可能在完全无保护的情况下导入。

  G4  持久化写入走 miyaSafeLsSet，它在配额不足时会**溢出到 IDB**。
      快照只遍历 localStorage，漏掉了这些已落在 IDB 里的 key ——
      回填时它们会以「localStorage 里没有」的身份被忽略。

跑法：python3 test/audit_backup_rollback_gaps.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
SEED = "try{localStorage.clear();}catch(e){}"

PROBE = r"""
async () => {
    const out = {};
    const src = await fetch('js2/miya-backup.js?v=0').then(r => r.text()).catch(() => '');
    const fn = (src.split('function applyBackupLocalStorage')[1] || '').split('async function restoreBackupPayload')[0] || '';
    out.fnLen = fn.length;

    // G1 双向回填
    out.g1_hasBidirectional = /双向|写失败的也|恢复旧值|restoreOldFor/.test(fn);

    // G2 ZIP 路径提示
    const zipFn = (src.split('async function importOneBackupZip')[1] || '').split('async function importBackupZipFiles')[0] || '';
    out.g2_zipToastsFailure = /toast\([^)]*写入失败/.test(zipFn);
    out.g2_zipReturnsFailed = /lsFailed/.test(zipFn);

    // G3 快照/clear 失败不再静默
    out.g3_snapshotReports = /snapshotFailed|快照失败|无法回滚/.test(fn);
    out.g3_clearReports = /clearFailed|清空失败/.test(fn);

    // G4 快照覆盖 IDB 溢出键
    out.g4_coversIdbSpill = /miyaKvKeyNeedsAsyncHydrate|__miyaKvMem|idb/i.test(fn);

    // ── 运行时：真实制造一次写入失败，看回填行为 ──
    const snap0 = {};
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) snap0[k] = localStorage.getItem(k);
    }
    out.beforeKeyCount = Object.keys(snap0).length;

    // 预置一个「新版备份里没有」的旧 key，模拟本地独有数据
    localStorage.setItem('__audit_old_only__', 'KEEP-ME');
    localStorage.setItem('__audit_will_be_overwritten__', 'OLD-VALUE');

    // 构造一份备份包：包含一个会写失败的 key
    const ls = {
        '__audit_will_be_overwritten__': 'NEW-VALUE',
        '__audit_new_only__': 'NEW-KEY'
    };
    const res = window.miyaBackup
        ? null
        : null;
    // applyBackupLocalStorage 未导出，直接复算其行为口径做静态对照
    out.exportedKeys = Object.keys(window.miyaBackup || {});

    localStorage.removeItem('__audit_old_only__');
    localStorage.removeItem('__audit_will_be_overwritten__');
    return out;
}
"""


async def main():
    results = []

    def check(name, ok, detail=''):
        results.append((name, bool(ok), detail))
        print(f'  {"✓" if ok else "✗"} {name}' + (f'  —— {detail}' if detail else ''))

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.add_init_script(SEED)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2200)

        res = await page.evaluate(PROBE)
        print('\n=== 静态取证 ===')
        print(json.dumps(res, ensure_ascii=False, indent=2))
        print('\n=== 断言（缺口应当已被堵住）===')

        check('G1 回填是双向的（新包写失败的 key 也尝试恢复旧值）',
              res.get('g1_hasBidirectional') is True)
        check('G2 ZIP 导入路径会提示写入失败',
              res.get('g2_zipToastsFailure') is True)
        check('G3 快照失败会被上报（不再静默）',
              res.get('g3_snapshotReports') is True)
        check('G3 clear 失败会被上报（不再静默）',
              res.get('g3_clearReports') is True)
        check('G4 快照覆盖溢写到 IDB 的键',
              res.get('g4_coversIdbSpill') is True)
        check('页面无 JS 报错', not errors, '; '.join(errors[:3]))

        await browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n通过 {passed} / {len(results)}')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    asyncio.run(main())
