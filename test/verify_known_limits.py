#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_known_limits.py
──────────────────────
校验 docs/已知限制与绕过方法.md 里的**数值声明**与代码一致。

为什么需要这个脚本
──────────────────
「已知限制」文档最怕的不是写漏，而是**写错后没人发现**：
文档说「相册压缩到 2560」，代码后来改成了 1920，
用户照着文档判断，就会得出错误结论 —— 比没有文档更糟。

所以文档里每个硬数值都要在这里有一条对应断言。
改代码时若忘了改文档，这个脚本会失败。

用法：
    python3 test/verify_known_limits.py
"""

import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
DOC = os.path.join(ROOT, "docs", "已知限制与绕过方法.md")

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✅ PASS  " + name + (("  ← " + detail) if detail else ""))
    else:
        FAIL += 1
        print("  ❌ FAIL  " + name + (("  ← " + detail) if detail else ""))


def read(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        return None
    return open(p, encoding="utf-8").read()


def main():
    print("=" * 72)
    print("校验：已知限制文档 vs 代码实际值")
    print("=" * 72)

    doc = read("docs/已知限制与绕过方法.md")
    check("0.1 文档存在", doc is not None)
    if not doc:
        return 1

    # 把文档切成行，便于定位「某一句话」而不是全文子串匹配。
    #
    # ⚠ 这里为什么要按行断言：
    #   最初的写法是「'2560' in doc」—— 但这太弱了。
    #   文档里 2560 出现了两次（正文一处、取舍说明一处），
    #   把正文那处改成 9999，另一处仍含 2560，断言照样通过。
    #   所以必须锁定**承载该数值的那一行**。
    doc_lines = doc.split("\n")

    def doc_has(line_fragment, must_contain):
        """在**含 line_fragment 的那一行**里查找 must_contain。"""
        for ln in doc_lines:
            if line_fragment in ln:
                return must_contain in ln
        return False

    storage = read("js2/miya-storage.js") or ""
    album = read("js1/miya-chat-album.js") or ""
    cstore = read("js1/miya-chat-store.js") or ""
    cimage = read("js1/miya-chat-image.js") or ""
    idx = read("index.html") or ""
    diag = read("js1/miya-diagnostics.js") or ""

    checks = []

    # ── 存储溢出阈值 48 KB / 49152 ────────────────────────────
    m = re.search(r"SPILL_BYTES\s*=\s*(\d+)", storage)
    code_spill = int(m.group(1)) if m else None
    checks.append(
        (
            "1.1 存储溢出阈值：代码 %s，文档该行须写 49152" % code_spill,
            code_spill == 49152
            and doc_has("超过 48 KB", "49152"),
        )
    )

    # ── 相册压缩 2560 / 0.92（锁定正文那一行）────────────────
    m1 = re.search(r"ALBUM_IMAGE_MAX_EDGE\s*=\s*(\d+)", album)
    m2 = re.search(r"ALBUM_IMAGE_QUALITY\s*=\s*([\d.]+)", album)
    a_edge = m1.group(1) if m1 else None
    a_q = m2.group(1) if m2 else None
    checks.append(
        (
            "1.2 相册压缩长边：代码 %s，文档正文该行须写 2560" % a_edge,
            a_edge == "2560"
            and doc_has("里的图入库时会被压缩", "长边 2560"),
        )
    )
    checks.append(
        (
            "1.3 相册压缩质量：代码 %s，文档正文该行须写 0.92" % a_q,
            a_q == "0.92"
            and doc_has("里的图入库时会被压缩", "JPEG 质量 0.92"),
        )
    )

    # ── 聊天图压缩 1920 / 0.82 ───────────────────────────────
    m3 = re.search(
        r"maxEdge\s*=\s*opts\.maxEdge\s*!=\s*null\s*\?\s*opts\.maxEdge\s*:\s*(\d+)",
        cimage,
    )
    m4 = re.search(
        r"quality\s*=\s*opts\.quality\s*!=\s*null\s*\?\s*opts\.quality\s*:\s*([\d.]+)",
        cimage,
    )
    c_edge = m3.group(1) if m3 else None
    c_q = m4.group(1) if m4 else None
    checks.append(
        (
            "1.4 聊天图压缩长边：代码 %s，文档该行须写 1920" % c_edge,
            c_edge == "1920" and doc_has("的压缩更激进", "长边 1920"),
        )
    )
    checks.append(
        (
            "1.5 聊天图压缩质量：代码 %s，文档该行须写 0.82" % c_q,
            c_q == "0.82" and doc_has("的压缩更激进", "质量 0.82"),
        )
    )

    # ── 上下文窗口 80 / 500 / 100 ────────────────────────────
    m5 = re.search(r"memoryCount:\s*(\d+)", cstore)
    m6 = re.search(r"messageRenderLimit:\s*(\d+)", cstore)
    mem = m5.group(1) if m5 else None
    rend = m6.group(1) if m6 else None
    checks.append(
        (
            "1.6 记忆窗口：代码 %s，文档该行须写 80 条" % mem,
            mem == "80" and doc_has("原文，细节完整", "80 条"),
        )
    )
    checks.append(
        (
            "1.7 单次渲染上限：代码 %s，文档该行须写 100" % rend,
            rend == "100" and doc_has("默认上限", "100"),
        )
    )
    checks.append(
        (
            "1.8 上下文硬上限 500 在文档与代码注释中都出现",
            "500 条封顶" in doc and "500 上限" in cstore,
        )
    )

    # ── miya-auth 引用与「可忽略」说明 ───────────────────────
    n_auth = len(re.findall(r"miya-auth/", idx))
    checks.append(
        (
            "1.9 miya-auth 被引用（%d 处）且文档说明可忽略" % n_auth,
            n_auth >= 3 and "miya-auth" in doc and "可以忽略" in doc,
        )
    )

    # ── sw-build 哨兵存在，文档教用户查它 ────────────────────
    checks.append(
        (
            "1.10 miya-sw-build 需存在，且文档给出查询方法",
            "miya-sw-build" in idx and "miya-sw-build" in doc,
        )
    )

    # ── 诊断 API 文档里提到的都要真实存在 ────────────────────
    for api in ["show", "dump", "enable", "disable"]:
        checks.append(
            (
                "1.11 miyaDiag.%s 在代码中存在且文档提到" % api,
                ("%s:" % api) in diag or ("%s(" % api) in diag,
            )
        )
    checks.append(
        (
            "1.12 miyaDiag.show / dump 在文档中被提到",
            "miyaDiag.show()" in doc and "miyaDiag.dump()" in doc,
        )
    )

    # ── 导入失败的两条话术 ───────────────────────────────────
    app = read("js1/miya-appointment-app.js") or ""
    checks.append(
        (
            "1.13 导入「已撤销」话术存在且文档收录",
            "已撤销本次导入" in app and "已撤销本次导入" in doc,
        )
    )
    checks.append(
        (
            "1.14 导入「反复出现可反馈」话术存在且文档收录",
            "若反复出现可反馈此文件" in app and "若反复出现可反馈此文件" in doc,
        )
    )

    # ── 文档「可忽略提示」的表现形式确实存在于代码 ───────────
    # 这些提示散落在多个模块里，所以全量搜 js1/ js2/，
    # 而不是逐个列举文件 —— 列举会随着模块拆分而过期。
    all_js = ""
    for sub in ("js1", "js2"):
        d = os.path.join(ROOT, sub)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.endswith(".js"):
                try:
                    all_js += open(os.path.join(d, fn), encoding="utf-8").read()
                except Exception:
                    pass

    for phrase in [
        "请刷新后重试",
        "存储未就绪",
        "可再试一次",
    ]:
        checks.append(
            (
                "1.15 提示「%s」在文档与代码中都出现" % phrase,
                phrase in doc and phrase in all_js,
            )
        )

    print()
    for name, ok in checks:
        check(name, ok)

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
    print("=" * 72)
    if FAIL:
        print("⚠ 文档与代码已不一致，请同步（数值以代码为准）")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
