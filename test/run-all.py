#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin 测试总入口 —— 一条命令跑完，不用手动起 server

为什么要有它
────────────
test/ 下有 62 个脚本，其中三类跑法各不相同：

  1. 依赖本地 HTTP 服务的（44 个）—— 跑之前必须 `python3 -m http.server 8099`
  2. 自带服务器的（1 个，sw_cache_regression）—— 自己起自己的端口，别去干涉
  3. 纯静态/纯 Node 的（17 个）—— 不需要服务，直接跑

以前得记住哪个是哪个、还要单独开一个终端挂着 server。
忘了起 server 就会看到一屏 ERR_CONNECTION_REFUSED，
很容易被误读成「代码坏了」。

这个脚本把这三类统一成一条命令：
  · 按需**自动**起服务、结束**自动**关掉
  · 每个脚本单独限时，卡死不拖垮整轮
  · 结果逐条汇总，失败的把末尾输出摘出来

用法
────
    python3 test/run-all.py                # 全部
    python3 test/run-all.py --fast         # 只跑不需要服务的（秒级）
    python3 test/run-all.py --filter e2e   # 只跑文件名含 e2e 的
    python3 test/run-all.py --list         # 只列清单不跑
    python3 test/run-all.py --timeout 600  # 单脚本超时（默认 300s）

退出码：全绿 0；有失败 1。可直接接 CI。
"""
import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_DIR = ROOT / "test"

# 统一服务端口。默认 8099 —— 与多数脚本硬编码的一致。
DEFAULT_PORT = int(os.environ.get("MIYA_PORT", "8099"))

# 自带服务器的脚本：它们自己管理端口，外部起了反而可能撞车。
SELF_HOSTED = {"sw_cache_regression.py"}

# 需要外部服务的判据。
#
# 早先只认 `localhost:80\d\d`，漏了一大批写 `127.0.0.1:8099` 的脚本
#（这两种写法在这个仓库里一直并存）。被漏掉的脚本会被当成「纯静态」
# 先跑 —— 那时服务还没起，于是稳定地报连接失败，看起来像脚本坏了，
# 实际只是分类错了。这里把两种回环写法都认上，并且把 playwright
# 也算信号（用浏览器跑的脚本必然需要服务，不管它把地址写成什么）。
NEEDS_SERVER_RE = re.compile(
    r"(?:localhost|127\.0\.0\.1):80\d\d|playwright",
    re.IGNORECASE,
)


def pick_free_port(preferred: int) -> int:
    """优先用 preferred；被占就往后找一个空闲端口。"""
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到空闲端口")


def wait_port(port: int, timeout: float = 10.0) -> bool:
    """等服务真正可连，别用 sleep 猜。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.15)
    return False


def classify(script: Path) -> str:
    """返回 'self'（自带服务）/ 'needs'（需外部服务）/ 'pure'（不需要）。"""
    if script.name in SELF_HOSTED:
        return "self"
    try:
        src = script.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "pure"
    return "needs" if NEEDS_SERVER_RE.search(src) else "pure"


def start_server(port: int):
    """在项目根目录起一个静态服务；返回 Popen。"""
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,  # 便于整组回收
    )
    if not wait_port(port):
        proc.kill()
        raise RuntimeError("服务起不来：端口 %d" % port)
    return proc


def stop_server(proc) -> None:
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass


def summarize(stdout: str):
    """
    从输出里抠出通过/失败数。

    各脚本的汇总格式不统一，这里把已知的几种都认一认；
    认不出来就返回 (None, None)，由调用方按退出码判断。
    """
    # 每条 pattern 附带一个「这两个组是 (通过, 总数) 还是 (通过, 失败)」的标记。
    # 早先靠 `"共" in pat` 猜，新增格式后就不够用了 —— 显式写出来更难写错。
    patterns = [
        (r"结果：(\d+)\s*通过\s*/\s*(\d+)\s*失败", "fail"),
        (r"通过\s*(\d+)\s*/\s*共\s*(\d+)", "total"),
        (r"通过\s*(\d+)\s*·\s*失败\s*(\d+)", "fail"),
        (r"通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项", "fail"),
        # 「12/12 通过」—— 通过数/总数 的紧凑写法。
        # 线下那几个 e2e（记忆表删除、候选记忆延迟）都是这个格式，
        # 早先没认它，于是它们的断言数在汇总里一直是「-」，
        # 看着像「这脚本没断言」，其实只是没解析出来。
        (r"(\d+)\s*/\s*(\d+)\s*通过", "total"),
    ]
    for pat, kind in patterns:
        m = re.search(pat, stdout)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            # 统一成 (通过, 失败)
            if kind == "total":
                return a, b - a
            return a, b
    return None, None


def tail_lines(text: str, n: int = 12) -> str:
    lines = [l for l in text.strip().splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--fast", action="store_true", help="只跑不需要服务的脚本")
    ap.add_argument("--filter", default="", help="只跑文件名含该子串的脚本")
    ap.add_argument("--list", action="store_true", help="只列清单，不执行")
    ap.add_argument("--timeout", type=int, default=600, help="单脚本超时秒数（默认 600）")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="服务端口（默认 8099）")
    args = ap.parse_args()

    scripts = sorted(p for p in TEST_DIR.glob("*.py") if p.name != "run-all.py")
    if args.filter:
        scripts = [p for p in scripts if args.filter in p.name]

    buckets = {"pure": [], "needs": [], "self": []}
    for p in scripts:
        buckets[classify(p)].append(p)

    if args.fast:
        buckets["needs"] = []

    print("=" * 76)
    print("Karin 测试总入口")
    print("=" * 76)
    print("  纯静态/Node   %2d 个" % len(buckets["pure"]))
    print("  依赖本地服务  %2d 个" % len(buckets["needs"]))
    print("  自带服务      %2d 个  %s" % (len(buckets["self"]), " ".join(p.name for p in buckets["self"])))

    if args.list:
        print()
        for kind, label in (("pure", "纯静态/Node"), ("needs", "依赖本地服务"), ("self", "自带服务")):
            print("── %s ──" % label)
            for p in buckets[kind]:
                print("   " + p.name)
        return 0

    need_server = bool(buckets["needs"])
    port = args.port
    server = None
    if need_server:
        port = pick_free_port(args.port)
        print("\n[服务] 在 %s 起静态服务，端口 %d" % (ROOT, port))
        try:
            server = start_server(port)
        except RuntimeError as e:
            print("  ❌ " + str(e))
            return 1
        print("  ✓ 服务就绪")

    order = buckets["pure"] + buckets["needs"] + buckets["self"]
    results = []
    t0 = time.time()

    try:
        for i, script in enumerate(order, 1):
            kind = classify(script)
            tag = {"pure": "静态", "needs": "服务", "self": "自带"}[kind]
            print("\n" + "─" * 76)
            print("[%d/%d] %s  (%s)" % (i, len(order), script.name, tag))
            print("─" * 76)

            env = dict(os.environ)
            env["MIYA_BASE"] = "http://localhost:%d" % port
            env["PYTHONIOENCODING"] = "utf-8"

            started = time.time()
            try:
                cp = subprocess.run(
                    [sys.executable, str(script)],
                    cwd=str(ROOT),
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=args.timeout,
                    text=True,
                    errors="replace",
                )
                out = cp.stdout or ""
                rc = cp.returncode
                timed_out = False
            except subprocess.TimeoutExpired as e:
                out = (e.stdout or "") if isinstance(e.stdout, str) else ""
                rc = -1
                timed_out = True

            dur = time.time() - started
            ok_n, fail_n = summarize(out)

            if timed_out:
                verdict = "TIMEOUT"
                color = "⏱"
            elif fail_n is not None:
                verdict = "OK" if fail_n == 0 else "FAIL"
                color = "✅" if fail_n == 0 else "❌"
            else:
                verdict = "OK" if rc == 0 else "FAIL"
                color = "✅" if rc == 0 else "❌"

            shown = tail_lines(out, 8)
            if shown:
                print(shown)

            print("  %s %s  (%.1fs)" % (color, verdict, dur))

            results.append({
                "name": script.name,
                "kind": tag,
                "verdict": verdict,
                "ok": ok_n,
                "fail": fail_n,
                "rc": rc,
                "dur": dur,
                "tail": tail_lines(out, 10),
            })
    finally:
        if server:
            stop_server(server)
            print("\n[服务] 已关闭（端口 %d）" % port)

    total = time.time() - t0
    bad = [r for r in results if r["verdict"] != "OK"]

    print("\n" + "=" * 76)
    print("汇总")
    print("=" * 76)
    print("  %-42s %-8s %-8s %s" % ("脚本", "判定", "通过/失败", "耗时"))
    for r in results:
        cnt = "-"
        if r["ok"] is not None:
            cnt = "%s/%s" % (r["ok"], r["fail"])
        print("  %-42s %-8s %-8s %.1fs" % (r["name"], r["verdict"], cnt, r["dur"]))

    sum_ok = sum(r["ok"] or 0 for r in results)
    sum_fail = sum(r["fail"] or 0 for r in results)
    print("\n  脚本 %d 个：%d 通过 / %d 失败" % (len(results), len(results) - len(bad), len(bad)))
    if sum_ok or sum_fail:
        print("  断言合计：%d 通过 / %d 失败" % (sum_ok, sum_fail))
    print("  总耗时：%.1fs" % total)

    if bad:
        print("\n  ❌ 未通过的脚本：")
        for r in bad:
            print("    · %s  (%s)" % (r["name"], r["verdict"]))
            if r["tail"]:
                for line in r["tail"].splitlines()[-6:]:
                    print("        " + line)
    else:
        print("\n  ✅ 全部通过")

    print("=" * 76)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
