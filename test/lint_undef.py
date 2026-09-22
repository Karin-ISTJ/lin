#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lint_undef.py
─────────────
把 ESLint 的 `no-undef` 检查包成标准测试脚本，接进 run-all.py。

为什么需要它
────────────
这个项目出过一批**纯 ReferenceError** 的故障，全都属于
「打开某页 / 点到某按钮才崩」：

  · `trim is not defined`
  · `invalidateApiPresetsCache()` 全文件未定义
  · `state.chatId = chatId`（chatId 根本不存在）
  · `markPartial` 跨函数闭包链调用

这类问题不需要跑浏览器，静态检查一眼就能抓出来。
但 `run-all.py` 只扫 `*.py`，ESLint 不主动跑就永远不会跑 ——
所以这里把它包一层，让它和其余 62 个脚本一样被自动发现。

用法：
    python3 test/lint_undef.py

退出码：无告警 0；有告警 1。
"""

import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")

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


def find_eslint():
    """优先用项目内 node_modules，回退到 npx。找不到返回 None。"""
    local = os.path.join(ROOT, "node_modules", ".bin", "eslint")
    if os.path.exists(local):
        return [local]
    npx = shutil.which("npx")
    if npx:
        return [npx, "eslint"]
    global_eslint = shutil.which("eslint")
    if global_eslint:
        return [global_eslint]
    return None


def main():
    print("=" * 72)
    print("ESLint no-undef —— 未定义引用检查")
    print("=" * 72)

    cfg = os.path.join(ROOT, "eslint.config.mjs")
    check("配置文件存在 eslint.config.mjs", os.path.exists(cfg))

    cmd = find_eslint()
    if not cmd:
        check("找到 ESLint 可执行文件", False, "请先 npm install")
        print("\n" + "=" * 72)
        print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
        print("=" * 72)
        return 1
    check("找到 ESLint 可执行文件", True, " ".join(cmd))

    # 检查范围与 npm run lint 保持一致
    targets = ["js1", "js2", "tools", "sw.js"]
    targets = [t for t in targets if os.path.exists(os.path.join(ROOT, t))]
    check("目标目录存在", len(targets) > 0, " ".join(targets))

    full_cmd = cmd + targets
    try:
        cp = subprocess.run(
            full_cmd,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=300,
        )
        out = (cp.stdout or "") + (cp.stderr or "")
        rc = cp.returncode
    except subprocess.TimeoutExpired:
        check("ESLint 在 300s 内完成", False, "超时")
        print("\n" + "=" * 72)
        print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
        print("=" * 72)
        return 1

    # 解析告警数：ESLint 收尾输出形如
    #   ✖ 12 problems (12 errors, 0 warnings)
    m = re.search(r"(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)", out)
    if m:
        errors, warnings = int(m.group(2)), int(m.group(3))
    elif rc == 0:
        errors, warnings = 0, 0
    else:
        # 解析不出但退出码非 0 —— 可能是配置错误，把输出带出来
        errors, warnings = -1, -1

    check("ESLint 正常执行（配置未报错）", errors >= 0, "退出码 %d" % rc)
    check("未定义引用（no-undef）为 0", errors == 0, "%d 条" % max(errors, 0))

    if errors > 0:
        print()
        print("  ── 未定义引用明细 ──")
        for line in out.splitlines():
            if "no-undef" in line:
                print("  " + line.strip())

    if warnings > 0:
        print()
        print("  （另有 %d 条 warning，不阻断）" % warnings)

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
    print("=" * 72)
    if FAIL:
        print("⚠ 存在未定义引用：严格模式下必抛 ReferenceError，请修复。")
        print("  说明见 docs/ESLint基线与未定义引用清单.md")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
