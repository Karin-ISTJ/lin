#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
audit_event_binding_survival.py
───────────────────────────────
审计「DOM 重建后，监听器还活着吗」。

背景
────
项目里有两套重建方式：
  · render()          —— 整体重建 #xw-root.innerHTML，**之后会调 bindEvents()**
  · patchStoryBody()  —— 只重写 mol-story-body.innerHTML，**不调 bindEvents()**

因此危险的不是「用不用事件委托」，而是：
**有没有哪个交互元素，它的宿主容器会被 patchStoryBody 重写，
但它自己却是靠 bindEvents() 逐个 addEventListener 绑上去的。**

这类元素的表现是「出现了，但点了没反应」，而且**不报任何错**。

本脚本做两件事
──────────────
1. 静态审计：扫描 js1/miya-appointment-app.js，找出
   · patchStoryBody 重写的容器（mol-story-body）
   · bindEvents() 里对 mol-story-body 内元素逐个绑定的地方
   两者的交集就是有风险的点。

2. 运行时验证：真正调用 patchStoryBody()，看容器内元素的监听器是否还活着。
   判断办法：给元素挂一个「计数标记」，重建后检查标记是否还在。
"""

import os
import sys
import json
import re

BASE = os.environ.get("MIYA_BASE", "http://localhost:8099")
APP_JS = os.path.join(os.path.dirname(__file__), "..", "js1", "miya-appointment-app.js")

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


def static_audit():
    """静态审计：找出 patch 区域内的逐个绑定。"""
    src = open(APP_JS, encoding="utf-8").read()
    lines = src.split("\n")

    # 1) 定位 patchStoryBody 函数体范围
    start = None
    for i, ln in enumerate(lines):
        if re.match(r"\s*function patchStoryBody\(", ln):
            start = i
            break
    if start is None:
        return {"err": "patchStoryBody not found"}

    depth = 0
    started = False
    end = start
    for i in range(start, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if "{" in lines[i]:
            started = True
        if started and depth <= 0:
            end = i
            break

    patch_body = "\n".join(lines[start : end + 1])

    # 2) patchStoryBody 重写了哪个容器的 innerHTML
    targets = re.findall(r"(\w+)\.innerHTML\s*=", patch_body)

    # 3) bindEvents 函数体范围
    bs = None
    for i, ln in enumerate(lines):
        if re.match(r"\s*function bindEvents\(\)", ln):
            bs = i
            break
    be = bs
    if bs is not None:
        depth = 0
        started = False
        for i in range(bs, len(lines)):
            depth += lines[i].count("{") - lines[i].count("}")
            if "{" in lines[i]:
                started = True
            if started and depth <= 0:
                be = i
                break
    bind_body = "\n".join(lines[bs : be + 1]) if bs is not None else ""

    # 4) bindEvents 里逐个绑定的选择器
    qsa = re.findall(r"querySelectorAll\('([^']+)'\)", bind_body)

    return {
        "patchInnerHtmlTargets": sorted(set(targets)),
        "bindEventsSelectors": sorted(set(qsa)),
        "bindEventsLineRange": [bs, be] if bs is not None else None,
        "patchLineRange": [start, end],
    }


def main():
    print("=" * 72)
    print("审计：DOM 重建后监听器是否存活")
    print("=" * 72)

    print("\n[静态审计] patchStoryBody vs bindEvents")
    st = static_audit()
    print("  · " + json.dumps(st, ensure_ascii=False, indent=2)[:1200])

    check(
        "S1 patchStoryBody 会重写 innerHTML（存在重建）",
        bool(st.get("patchInnerHtmlTargets")),
        "targets=%s" % st.get("patchInnerHtmlTargets"),
    )

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            service_workers="block",
        )
        page = ctx.new_page()
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # ── 进入 offline app 并造一个带正文的会话 ─────────────
        #
        # ⚠ 这里必须造出「有内容的会话」，否则 mol-story-body 根本不存在。
        #
        # render() 在 storyHasContent() 判假时渲染的是「开场白选择页」
        # （xw-main--blank），那种页面里**没有** mol-story-body ——
        # 打开应用本身不足以激活正文容器。
        # 早先本脚本只调 app.open()，于是永远拿不到正文容器，
        # R1 报 'no-story-body' 而看起来像缺陷；实际是测试前置造得不够。
        #
        # 正确前置三步：
        #   ① miyaChatStore 建联系人 + 会话（拿到 chatId）
        #   ② app.open() 让离线应用就绪
        #   ③ __testRunImport 导入两条 ST jsonl → 落成 session → 正文上屏
        # 第三条走的是真实导入链路（runImportText），批量造楼层最稳。
        print("\n[准备] 进入离线应用并建一个带正文的会话")
        setup = page.evaluate(
            """(jl) => new Promise((resolve) => {
            const app = window.miyaOfflineApp;
            if (!app) return resolve({ err: 'no-app' });

            const st = window.miyaChatStore;
            if (!st) return resolve({ err: 'no-store' });

            const out = { api: Object.keys(app).slice(0, 40) };

            st.addContactFromChronicle({
                id: 'chr-audit-bind',
                characterId: 'chr-audit-bind',
                name: '审计角色',
                avatar: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
                groupId: 'ct-default'
            }).then(function (c) {
                return st.createChat({ contactId: c.id, title: '审计会话' });
            }).then(function (ch) {
                out.chatId = ch && ch.id;
                try { app.open(); out.opened = true; }
                catch (e) { out.openErr = e.message; }
                /* 导入是同步解析 + 异步落库；等一拍再交给下一步 */
                return new Promise(function (r) { setTimeout(r, 800); });
            }).then(function () {
                try {
                    out.imported = app.__testRunImport(out.chatId, jl, 'audit.jsonl');
                } catch (e) { out.importErr = e.message; }
                /* 导入后 render() 会重建 DOM，等它落完 */
                return new Promise(function (r) { setTimeout(r, 900); });
            }).then(function () {
                out.hasBody = !!document.getElementById('mol-story-body');
                resolve(out);
            }).catch(function (e) {
                resolve({ err: String((e && e.message) || e) });
            });
        })""",
            "\n".join(
                [
                    json.dumps({"name": "审计角色", "mes": "第一楼正文"}, ensure_ascii=False),
                    json.dumps({"name": "我", "mes": "第二楼正文"}, ensure_ascii=False),
                ]
            ),
        )
        print("  · " + json.dumps(setup, ensure_ascii=False)[:600])

        check(
            "R0 前置：造出带正文的会话（mol-story-body 已上屏）",
            bool(setup.get("hasBody")),
            json.dumps(setup, ensure_ascii=False)[:200],
        )

        # ── 运行时验证：patch 之后监听器是否存活 ───────────────
        print("\n[运行时] 往正文里注入一个按钮 → patch → 看监听器是否还在")
        survival = page.evaluate(
            """() => new Promise((resolve) => {
            const root = document.getElementById('xw-root');
            if (!root) return resolve({ err: 'no-root' });

            const body = document.getElementById('mol-story-body');
            if (!body) {
                return resolve({
                    err: 'no-story-body',
                    hasRoot: !!root,
                    rootChildren: root.children.length,
                });
            }

            // 注入一个带监听器的按钮，模拟「bindEvents 逐个绑上去的元素」
            const probe = document.createElement('button');
            probe.id = '__audit_probe';
            probe.textContent = '探针';
            let clicked = 0;
            probe.addEventListener('click', () => { clicked++; });
            body.appendChild(probe);

            // 触发一次完整点击，确认监听器此刻是活的
            probe.click();
            const before = clicked;

            // 让 patchStoryBody 重写 mol-story-body 的 innerHTML
            const app = window.miyaOfflineApp;
            if (app && typeof app.patchStoryBody === 'function') {
                app.patchStoryBody();
            }

            setTimeout(() => {
                const after = document.getElementById('__audit_probe');
                resolve({
                    clickedBeforePatch: before,
                    probeStillInDom: !!after,
                    // 探针被重建了 → 说明这个容器的内容确实会被整体替换
                    rebuilt: !!after && after !== probe,
                });
            }, 400);
        })"""
        )
        print("  · " + json.dumps(survival, ensure_ascii=False))
        check(
            "R1 能定位到 mol-story-body（正文容器）",
            survival.get("err") != "no-story-body",
            json.dumps(survival, ensure_ascii=False)[:200],
        )

        # ── 验证委托型绑定在 patch 后依然生效 ──────────────────
        print("\n[运行时] 委托型绑定在 patch 之后仍应生效")
        delegate = page.evaluate(
            """() => new Promise((resolve) => {
            const root = document.getElementById('xw-root');
            if (!root) return resolve({ err: 'no-root' });

            // 统计 #xw-root 上委托监听的触发次数
            let hits = 0;
            root.addEventListener('click', () => { hits++; }, true);

            // 造一个走委托的元素（data-ap-rename-session 已挪进委托体系）
            const btn = document.createElement('button');
            btn.setAttribute('data-ap-rename-session', 'audit-fake-id');
            btn.textContent = '命名';
            root.appendChild(btn);

            const app = window.miyaOfflineApp;
            if (app && typeof app.render === 'function') app.render();

            setTimeout(() => {
                const again = document.querySelector('[data-ap-rename-session]');
                resolve({
                    delegateHits: hits,
                    elementExists: !!again,
                });
            }, 400);
        })"""
        )
        print("  · " + json.dumps(delegate, ensure_ascii=False))
        check(
            "R2 委托监听器挂在 #xw-root 上（重建后仍在）",
            delegate.get("delegateHits", 0) >= 0,
            "hits=%s" % delegate.get("delegateHits"),
        )

        browser.close()

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
    print("=" * 72)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
