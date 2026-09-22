#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
属性值转义：集合必须覆盖「包裹它的那种引号」

背景
────
renderStory() 把头像 URL 拼进 style 属性的**单引号**里：

    ' style="--xw-stream-face:url(' + ava + ')"'

而它当时用的是 esc() —— 那是个**文本位置**转义函数，按设计只转
`& < > "`，**不转单引号**。于是头像里一个 `'` 就能提前闭合 url('，
把后面的字符顶成独立属性。

实测（修复前）：
    style="--xw-stream-face:url(x') onmouseover="…" x=')"
                          ↑ 属性在这里被拆断
DOM 里 .xw-scene 有 3 个属性（class / style / onmouseover）。

修复：这一处改用 escAttr()，它把 & < > " ' 全转了。

判定标准
────────
**看属性有没有被拆开**，而不是看属性值里有没有 `'`。

这个区分很关键：escAttr 把 `'` 写成 `&#39;`，但经过 HTML 解析后
getAttribute('style') 读回来仍然是 `'` —— 因为 `&#39;` 和 `'` 是
**同一个字符**。所以「值里有 '」是正常现象，不代表没转义。
真正能区分修没修好的，是属性个数：修复后恒为 2（class + style）。

────────────────────────────────────────────────────────────
跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/audit_attr_escape_context.py
"""
import json
import os
import re
import sys

BASE = os.environ.get("MIYA_BASE", "http://localhost:8099")

# 载荷：先闭合 url('，再塞一个事件属性，最后开一个引号收尾让剩下的语法合法
PAYLOAD = "x') onmouseover=\"window.__PWNED=1\" x='"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(("  ✅ PASS  " if ok else "  ❌ FAIL  ") + name + ("  ← " + str(detail) if detail else ""))


def static_audit():
    """静态核对：转义集合与使用上下文。"""
    src = open("js1/miya-appointment-app.js", encoding="utf-8").read()

    out = {}

    m = re.search(r"function escAttr\(s\)\s*\{(.*?)\n    \}", src, re.S)
    out["escAttrChars"] = re.findall(r"replace\(/([^/]+)/", m.group(1)) if m else []

    m2 = re.search(r"function esc\(t\)\s*\{(.*?)\n    \}", src, re.S)
    out["escChars"] = re.findall(r"replace\(/([^/]+)/", m2.group(1)) if m2 else []

    # 这个头像变量必须走 escAttr
    out["avaAssign"] = re.findall(r"var ava = (\w+)\(contactAvatar\(primaryFace\)\)", src)

    # 单引号内插值的点
    out["singleQuotedInterp"] = [
        s[:80] for s in re.findall(r"style=\"--xw-stream-face:url\(' \+ \w+ \+ '", src)
    ]

    return out


def main():
    print("=" * 72)
    print("审计：属性值转义的引号覆盖（style 单引号内插值）")
    print("=" * 72)

    print("\n[静态] 转义集合 vs 使用上下文")
    st = static_audit()
    print("  · " + json.dumps(st, ensure_ascii=False))

    check(
        "S1 escAttr 转义集合含单引号",
        "'" in st["escAttrChars"],
        "集合=%s" % st["escAttrChars"],
    )
    check(
        "S2 escAttr 同时覆盖 & < > \" '",
        set(["&", "<", ">", '"', "'"]).issubset(set(st["escAttrChars"])),
        "集合=%s" % st["escAttrChars"],
    )
    check(
        "S3 renderStory 的头像变量走 escAttr（不是 esc）",
        st["avaAssign"] == ["escAttr"],
        "实际用了=%s" % st["avaAssign"],
    )
    check(
        "S4 确认存在「单引号内插值」这一危险上下文",
        len(st["singleQuotedInterp"]) >= 1,
        "插值点=%s" % st["singleQuotedInterp"],
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

        print("\n[准备] 造一个头像带载荷的联系人 + 一条有正文的会话")
        seed = page.evaluate(
            """(evil) => new Promise((resolve) => {
            const st = window.miyaChatStore;
            if (!st) return resolve({ err: 'no-store' });
            const cid = 'chr-esc_' + Date.now();
            st.addContactFromChronicle({
                id: cid, characterId: cid, name: '转义审计',
                avatar: evil, groupId: 'ct-default'
            }).then(function (c) {
                return st.createChat({ contactId: c.id, title: '转义审计' });
            }).then(function (ch) {
                resolve({ chatId: ch && ch.id });
            }).catch(function (e) {
                resolve({ err: String((e && e.message) || e) });
            });
        })""",
            PAYLOAD,
        )
        print("  · " + json.dumps(seed, ensure_ascii=False))
        check("R0 前置：造出会话", bool(seed.get("chatId")), json.dumps(seed, ensure_ascii=False)[:160])

        page.evaluate("() => { window.miyaOfflineApp.open(); }")
        page.wait_for_timeout(1500)

        jl = (
            json.dumps({"name": "转义审计", "mes": "第一楼"}, ensure_ascii=False)
            + "\n"
            + json.dumps({"name": "我", "mes": "第二楼"}, ensure_ascii=False)
        )
        page.evaluate(
            """(a) => window.miyaOfflineApp.__testRunImport(a.chatId, a.jl, 'esc.jsonl')""",
            {"chatId": seed.get("chatId"), "jl": jl},
        )
        page.wait_for_timeout(1200)

        # 挂上 innerHTML 写钩子，抓真正写进 DOM 的 HTML（转义后的形态）
        page.evaluate(
            """() => {
            window.__attrLog = [];
            const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
            Object.defineProperty(Element.prototype, 'innerHTML', {
                set(v) {
                    if (String(v).includes('stream-face')) {
                        const i = String(v).indexOf('stream-face');
                        window.__attrLog.push(String(v).slice(i - 20, i + 140));
                    }
                    return d.set.call(this, v);
                },
                get() { return d.get.call(this); }
            });
        }"""
        )

        # 切到手帐主题 → 触发 isJournalTheme 分支 → 走到那个 style 拼接
        page.evaluate(
            """() => {
            document.getElementById('miya-offline-app').classList.add('xw-theme-korean');
            try { window.miyaOfflineApp.rerender(); } catch (e) {}
        }"""
        )
        page.wait_for_timeout(1200)

        print("\n[运行时] 载荷是否把属性拆开")
        res = page.evaluate(
            """() => {
            const s = document.querySelector('.xw-scene');
            if (!s) return { err: 'no-scene' };
            return {
                attrCount: s.attributes.length,
                names: Array.from(s.attributes).map((a) => a.name),
                hasOnmouseover: s.hasAttribute('onmouseover'),
                pwned: !!window.__PWNED,
            };
        }"""
        )
        print("  · " + json.dumps(res, ensure_ascii=False))

        check(
            "R1 属性个数恒为 2（class + style），未被载荷拆开",
            res.get("attrCount") == 2,
            "attrCount=%s names=%s" % (res.get("attrCount"), res.get("names")),
        )
        check(
            'R2 没有凭空多出 onmouseover 属性',
            not res.get("hasOnmouseover"),
            "hasOnmouseover=%s" % res.get("hasOnmouseover"),
        )
        check(
            "R3 载荷未执行（window.__PWNED 未被写入）",
            not res.get("pwned"),
            "pwned=%s" % res.get("pwned"),
        )
        check(
            "R4 属性名集合就是 class / style",
            sorted(res.get("names") or []) == ["class", "style"],
            "names=%s" % res.get("names"),
        )

        # 真正写进 DOM 的 HTML 里，单引号必须是实体形态
        log = page.evaluate("() => window.__attrLog")
        joined = " ".join(log)
        print("  · innerHTML 写入片段: " + (joined[:160] if joined else "(未捕获)"))

        check(
            "R5 写进 DOM 的 HTML 中，单引号已被转成 &#39;",
            "&#39;" in joined,
            "片段=%s" % joined[:120],
        )
        check(
            "R6 写进 DOM 的 HTML 中，双引号已被转成 &quot;",
            "&quot;" in joined,
            "片段=%s" % joined[:120],
        )
        check(
            "R7 原始未转义的 payload 没有整段出现在 HTML 源码里",
            PAYLOAD not in joined,
            "整段裸串不应出现",
        )

        browser.close()

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (len(passed), len(failed)))
    if failed:
        print("失败项：")
        for f in failed:
            print("  · " + f)
    print("=" * 72)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
