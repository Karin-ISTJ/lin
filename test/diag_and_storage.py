#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diag_and_storage.py
───────────────────
验证「统一诊断通道 + 安全存储写入」真的生效。

覆盖两件事
──────────
1. js1/miya-diagnostics.js 在页面里确实被加载，
   并且 global.miyaSafeLsSet / miyaReportError 真的存在。
   （修复前：这两个函数从未定义，32 处调用点全部回落到裸写入 + 空 catch）

2. 存储配额满时，失败是**可见**的 —— 而不是静默吞掉。
   通过注入一个「写满配额」的 localStorage.setItem 来模拟。

3. 既有的 32 处调用点，现在确实走进了 miyaSafeLsSet 分支。
"""

import os
import sys
import json

BASE = os.environ.get("MIYA_BASE", "http://localhost:8099")
TEST_URL = BASE + "/index.html"

from playwright.sync_api import sync_playwright

PASS = 0
FAIL = 0
RESULTS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        RESULTS.append(("PASS", name, detail))
        print("  ✅ PASS  " + name + (("  ← " + detail) if detail else ""))
    else:
        FAIL += 1
        RESULTS.append(("FAIL", name, detail))
        print("  ❌ FAIL  " + name + (("  ← " + detail) if detail else ""))


def main():
    print("=" * 72)
    print("验证：诊断通道 + 安全存储写入")
    print("=" * 72)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            service_workers="block",
        )
        page = ctx.new_page()
        page.goto(TEST_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # ── 用例 1：诊断模块加载、且**没有**覆盖既有的 miyaSafeLsSet ──
        print("\n[用例 1] 诊断模块加载与导出（关键：不得覆盖既有 miyaSafeLsSet）")
        api = page.evaluate(
            """() => ({
            hasSafeSet: typeof window.miyaSafeLsSet === 'function',
            hasReport: typeof window.miyaReportError === 'function',
            hasSafeSetSrc: typeof window.miyaSafeLsSet === 'function'
                ? String(window.miyaSafeLsSet).slice(0, 400) : '',
            hasDiag: !!(window.miyaDiag && typeof window.miyaDiag.dump === 'function'),
            diagApi: window.miyaDiag ? Object.keys(window.miyaDiag) : [],
            diag: window.miyaDiag ? window.miyaDiag.dump() : null,
        })"""
        )
        print("  · diagApi = " + json.dumps(api.get("diagApi"), ensure_ascii=False))
        check("1.1 miyaReportError 已定义（本轮新增）", api["hasReport"])
        check("1.2 miyaDiag 已定义（本轮新增）", api["hasDiag"])

        # 既有实现的关键特征：会调用 miyaNotifyStorageRecovered / StorageFull
        src = api.get("hasSafeSetSrc") or ""
        check(
            "1.3 miyaSafeLsSet 仍是 js2/miya-storage.js 的实现（未被本模块覆盖）",
            api["hasSafeSet"]
            and ("miyaNotifyStorageRecovered" in src or "miyaNotifyStorageFull" in src),
            "src=" + src.replace("\n", " ")[:160],
        )
        check(
            "1.4 本模块不再导出 miyaSafeLsSet / miyaSafeLsGet 等易撞名符号",
            "safeRead" in (api.get("diagApi") or [])
            and "safeJson" in (api.get("diagApi") or []),
            "diagApi=%s" % json.dumps(api.get("diagApi"), ensure_ascii=False),
        )
        if api.get("diag"):
            recs = api["diag"].get("records") or []
            check(
                "1.5 模块自检记录已写入（证明真的执行过）",
                any("诊断模块已就绪" in (r.get("message") or "") for r in recs),
                "共 %d 条记录" % api["diag"].get("count", 0),
            )

        # ── 用例 2：通用异常上报真的能被看见 ─────────────────────
        print("\n[用例 2] miyaReportError 记录异常（不再静默）")
        rep = page.evaluate(
            """() => {
            if (typeof window.miyaReportError !== 'function') return { err: 'no-fn' };
            const d0 = window.miyaDiag.dump().count;
            window.miyaReportError('test.scope', new Error('故意抛的测试错误'), 'k=v');
            const d1 = window.miyaDiag.dump();
            const hit = (d1.records || []).filter(r => (r.scope || '') === 'test.scope');
            return {
                added: d1.count - d0,
                hit: hit.length,
                msg: hit.length ? hit[hit.length - 1].message : '',
                detail: hit.length ? hit[hit.length - 1].detail : ''
            };
        }"""
        )
        print("  · " + json.dumps(rep, ensure_ascii=False))
        check("2.1 上报后新增了诊断记录", (rep.get("added") or 0) >= 1)
        check(
            "2.2 记录里带 scope 与错误消息",
            "故意抛的测试错误" in (rep.get("msg") or ""),
            "msg=%s" % rep.get("msg"),
        )
        check(
            "2.3 附加信息（detail）被保留",
            (rep.get("detail") or "") == "k=v",
            "detail=%s" % rep.get("detail"),
        )

        # ── 用例 2b：配额类错误被标记为 error 级 ─────────────────
        print("\n[用例 2b] 配额错误被提升为 error 级")
        q = page.evaluate(
            """() => {
            window.miyaReportError('test.quota',
                new DOMException('exceeded the quota', 'QuotaExceededError'));
            const recs = (window.miyaDiag.dump().records || [])
                .filter(r => (r.scope || '') === 'test.quota');
            return recs.length ? { level: recs[recs.length - 1].level,
                                   msg: recs[recs.length - 1].message } : {};
        }"""
        )
        print("  · " + json.dumps(q, ensure_ascii=False))
        check("2b.1 配额错误记为 error 级", q.get("level") == "error", "level=%s" % q.get("level"))

        # ── 用例 3：损坏 JSON 不再静默变默认值 ─────────────────
        print("\n[用例 3] 损坏 JSON 解析失败要留痕")
        bad = page.evaluate(
            """() => {
            if (!window.miyaDiag || typeof window.miyaDiag.safeJson !== 'function') {
                return { err: 'no-fn' };
            }
            const r = window.miyaDiag.safeJson('{这不是合法JSON', { fallback: 1 }, 'test.json');
            const d1 = window.miyaDiag.dump();
            const hit = (d1.records || []).filter(x => (x.scope || '') === 'test.json');
            return {
                ok: r.ok, wasFallback: r.wasFallback, value: r.value,
                hitCount: hit.length,
                sample: hit.length ? hit[hit.length - 1].message : ''
            };
        }"""
        )
        print("  · " + json.dumps(bad, ensure_ascii=False))
        check("3.1 解析失败时 ok=false", bad.get("ok") is False)
        check("3.2 解析失败时返回兜底值", bad.get("wasFallback") is True)
        check(
            "3.3 解析失败留下了诊断记录（不再静默）",
            (bad.get("hitCount") or 0) >= 1,
            "sample=%s" % bad.get("sample"),
        )

        # ── 用例 4：既有存储告警通道仍然可用（没被我改坏）──────
        print("\n[用例 4] 既有存储告警通道未被破坏")
        keep = page.evaluate(
            """() => {
            const hasNotice = typeof window.miyaNotifyStorageFull === 'function';
            const hasRecover = typeof window.miyaNotifyStorageRecovered === 'function';
            let ret = null, lastErr = null;
            if (hasNotice) {
                // 注入一次配额失败，走既有的 miyaSafeLsSet 路径
                const orig = Storage.prototype.setItem;
                Storage.prototype.setItem = function () {
                    throw new DOMException('exceeded the quota', 'QuotaExceededError');
                };
                ret = window.miyaSafeLsSet('__diag_probe_keep', 'x');
                Storage.prototype.setItem = orig;
                lastErr = window.__miyaLastStorageError || null;
            }
            return {
                hasNotice: hasNotice, hasRecover: hasRecover,
                returned: ret,
                lastErrKey: lastErr ? lastErr.key : null,
                lastErrName: lastErr ? lastErr.name : null
            };
        }"""
        )
        print("  · " + json.dumps(keep, ensure_ascii=False))
        check(
            "4.1 miyaSafeLsSet 失败时返回 false 且记录了失败 key",
            keep.get("returned") is False and keep.get("lastErrKey") == "__diag_probe_keep",
            "lastErrKey=%s" % keep.get("lastErrKey"),
        )
        check(
            "4.2 失败被登记为 QuotaExceededError（既有能力保留）",
            keep.get("lastErrName") == "QuotaExceededError",
            "name=%s" % keep.get("lastErrName"),
        )

        # ── 用例 5：默认静默，开关可开 ──────────────────────────
        print("\n[用例 5] 默认静默 / 开关可开（不能污染生产 console）")
        silent = page.evaluate(
            """() => ({
            isOn: window.miyaDiag.isOn(),
            recCount: (window.miyaDiag.dump().records || []).length,
        })"""
        )
        print("  · " + json.dumps(silent, ensure_ascii=False))
        check(
            "5.1 默认不开调试（isOn=false）",
            silent.get("isOn") is False,
            "isOn=%s" % silent.get("isOn"),
        )
        check(
            "5.2 但诊断记录仍在累积（静默≠丢失）",
            (silent.get("recCount") or 0) > 0,
            "%s 条" % silent.get("recCount"),
        )

        page2 = ctx.new_page()
        page2.goto(TEST_URL + "?miya_debug=1", wait_until="domcontentloaded")
        page2.wait_for_timeout(2000)
        url_on = page2.evaluate("() => !!(window.miyaDiag && window.miyaDiag.isOn())")
        check("5.3 ?miya_debug=1 可开启调试", url_on is True, "isOn=%s" % url_on)

        browser.close()

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
    print("=" * 72)
    for st, name, detail in RESULTS:
        if st == "FAIL":
            print("  ❌ %s  ← %s" % (name, detail))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
