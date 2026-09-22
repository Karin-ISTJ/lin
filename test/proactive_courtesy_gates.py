#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主动消息「礼貌门」回归测试
==========================

覆盖 js1/miya-chat-background.js 里两道新增的压制门：

  1. isUserComposing()  —— 用户正在输入框里写字时不打扰
  2. withinDailyCap()   —— 每日主动次数上限（跨天自动归零）

以及配套的 localDayKey()（本地时区日期键）与
saveProactiveAttempt() 里的「成功后计数 +1」逻辑。

为什么要有这个文件
──────────────────
这两道门的验证最初是用临时 node heredoc 跑的，跑完就没了。
它们属于「加了不显眼、坏了很烦人」的类型：

  · isUserComposing 判错 → 角色在你打字时插嘴，或者永远不发
  · withinDailyCap 判错 → 要么上限形同虚设，要么升级后老用户被误伤

所以固化成可重跑的测试，并带 A/B 守卫：
把源码里的关键实现改坏，测试必须变红。

运行
────
    python3 test/proactive_courtesy_gates.py

不需要服务器：全部是纯逻辑（在 node 里手搓最小 DOM 环境 + 抽取函数源码）。
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BG_JS = ROOT / "js1" / "miya-chat-background.js"
STORE_JS = ROOT / "js1" / "miya-chat-store.js"
GLOBAL_JS = ROOT / "js1" / "miya-chat-global-settings.js"
PANEL_JS = ROOT / "js1" / "miya-chat-settings-panel.js"
CT_JS = ROOT / "js1" / "miya-chat-contact-settings.js"

passed = 0
failed = 0
_notes = []


def ok(msg):
    global passed
    passed += 1
    print(f"  \u2705 {msg}")


def bad(msg):
    global failed
    failed += 1
    print(f"  \u274c {msg}")


def check(cond, msg):
    if cond:
        ok(msg)
    else:
        bad(msg)


def note(msg):
    _notes.append(msg)
    print(f"  \u2139\ufe0f  {msg}")


def read(p):
    return p.read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────
# 静态检查：源码里这两道门必须真的挂在 triggerReply 上
# ─────────────────────────────────────────────────────────────

def static_checks():
    print("\n[静态] 源码接入点")
    src = read(BG_JS)

    check("function isUserComposing(" in src, "S1 存在 isUserComposing 定义")
    check("function withinDailyCap(" in src, "S2 存在 withinDailyCap 定义")
    check("function localDayKey(" in src, "S3 存在 localDayKey 定义")

    # 定位 triggerReply 函数体
    m = re.search(r"function triggerReply\s*\(", src)
    if not m:
        bad("S4 找不到 triggerReply")
        return
    ok("S4 找到 triggerReply")

    # 从 triggerReply 起点往后截一段（函数体足够长，截 3000 字符覆盖前置判断）
    body = src[m.start(): m.start() + 3000]

    check(
        "isUserComposing()" in body,
        "S5 triggerReply 里调用了 isUserComposing（打字门已接）",
    )
    check(
        "withinDailyCap(" in body,
        "S6 triggerReply 里调用了 withinDailyCap（每日上限门已接）",
    )

    # 两道门必须是「跳过」不是「失败」：resolve 而非 reject，
    # 且不能被写成 lastPushFailAt —— 否则会把冷却期一起拉长。
    gate_lines = [
        ln.strip()
        for ln in body.splitlines()
        if "isUserComposing()" in ln or "withinDailyCap(" in ln
    ]
    joined = " ".join(gate_lines)
    check(
        joined.count("return Promise.resolve()") == 2,
        "S7 两道门都是 resolve 跳过（不是 reject 失败）",
    )
    check(
        "lastPushFailAt" not in joined,
        "S8 两道门都没写 lastPushFailAt（不污染失败冷却）",
    )

    # 顺序：必须排在 isBackgroundSuppressed 之后（复用既有抑制结论）
    idx_supp = body.find("isBackgroundSuppressed(")
    idx_typing = body.find("isUserComposing()")
    idx_cap = body.find("withinDailyCap(")
    check(
        idx_supp != -1 and idx_supp < idx_typing < idx_cap,
        "S9 门序正确：suppressed → typing → dailyCap",
    )


# ─────────────────────────────────────────────────────────────
# 静态检查：数据层字段与归一化
# ─────────────────────────────────────────────────────────────

def store_checks():
    print("\n[静态] 数据层字段")
    src = read(STORE_JS)

    for field in ("maxPerDay", "dayKey", "dayCount"):
        check(field + ":" in src, f"S10 默认值含 {field}")

    check(
        re.search(r"bm\.maxPerDay\s*=", src) is not None,
        "S11 maxPerDay 有归一化",
    )
    check(
        re.search(r"bm\.dayKey\s*=", src) is not None,
        "S12 dayKey 有归一化",
    )
    check(
        re.search(r"bm\.dayCount\s*=", src) is not None,
        "S13 dayCount 有归一化",
    )

    # 默认值必须是 0 / '' —— 升级后老用户行为不变（0 = 不限）
    check(
        re.search(r"maxPerDay\s*:\s*0", src) is not None,
        "S14 maxPerDay 默认 0（升级不改既有行为）",
    )

    # 计数 +1 必须在 recordAutoPushAt 分支内（真发出去才记）
    bg = read(BG_JS)
    m = re.search(r"if \(extra\.recordAutoPushAt\) \{", bg)
    if not m:
        bad("S15 找不到 recordAutoPushAt 分支")
    else:
        seg = bg[m.start(): m.start() + 1400]
        check(
            "bmPatch.dayCount" in seg,
            "S15 计数 +1 落在 recordAutoPushAt 分支内",
        )
        check(
            "sameDay" in seg,
            "S16 跨天从 1 重算（sameDay 分支存在）",
        )
        check(
            "bmPatch.dayKey" in seg,
            "S17 写入时同步 dayKey",
        )


def bm_key_list(src, start_marker, end_marker):
    """在 src 里从 start_marker 起抠出一段，抽出其中的引号字符串列表。"""
    i = src.find(start_marker)
    if i == -1:
        return None
    j = src.find(end_marker, i)
    if j == -1:
        return None
    seg = src[i:j]
    return re.findall(r"'([A-Za-z0-9_]+)'", seg)


def session_scope_checks():
    """
    会话级 backgroundMessage 名单的一致性守卫。

    历史教训：farm 和 timeEvents 各踩过一次「空模板盖掉真实数据」的坑。
    每日计数的 dayKey/dayCount 属于同一类运行时状态，必须同时登记在
    miya-chat-store.js 的 chatLevelBgKeys 和
    miya-chat-global-settings.js 的 CHAT_LEVEL_BM_KEYS 里，
    否则跨天计数会被全局配置的 '' / 0 盖掉，每日上限形同虚设。
    """
    print("\n[静态] 会话级字段名单一致性")
    store_src = read(STORE_JS)
    global_src = read(GLOBAL_JS)

    store_list = bm_key_list(store_src, "var chatLevelBgKeys = [", "];")
    global_list = bm_key_list(global_src, "var CHAT_LEVEL_BM_KEYS = [", "];")

    if store_list is None:
        bad("S18 找不到 store 的 chatLevelBgKeys")
        return
    if global_list is None:
        bad("S19 找不到 global 的 CHAT_LEVEL_BM_KEYS")
        return

    ok(f"S18 读到 store 名单（{len(store_list)} 项）")
    ok(f"S19 读到 global 名单（{len(global_list)} 项）")

    check(
        sorted(store_list) == sorted(global_list),
        "S20 两份名单完全一致（增删字段必须同步）",
    )
    if sorted(store_list) != sorted(global_list):
        only_store = set(store_list) - set(global_list)
        only_global = set(global_list) - set(store_list)
        note(f"仅 store 有：{sorted(only_store)}；仅 global 有：{sorted(only_global)}")

    check("dayKey" in store_list, "S21 dayKey 已登记为会话级（不被全局配置盖掉）")
    check("dayCount" in store_list, "S22 dayCount 已登记为会话级")
    check(
        "maxPerDay" not in store_list,
        "S23 maxPerDay 未登记为会话级（它是配置项，应走全局/联系人覆盖）",
    )


def ui_checks():
    """UI 开关必须真的存在，否则 #2 只落在数据层、用户改不到。"""
    print("\n[静态] UI 开关接入")
    ct = read(CT_JS)
    panel = read(PANEL_JS)

    check(
        "data-mq-set-bg-max-day" in ct,
        "S24 会话级面板有每日上限输入框",
    )
    check(
        ct.count("data-mq-set-bg-max-day") >= 3,
        f"S25 会话级面板三处齐全（渲染/读取/回填），实际 {ct.count('data-mq-set-bg-max-day')} 处",
    )
    check(
        re.search(r"maxPerDay\s*:\s*Math\.min\(200", ct) is not None,
        "S26 会话级读取有 0..200 夹取",
    )

    check(
        "miya-ct-def-bg-max-day" in panel,
        "S27 全局默认页有每日上限输入框",
    )
    check(
        panel.count("miya-ct-def-bg-max-day") >= 3,
        f"S28 全局页三处齐全（渲染/读取/回填），实际 {panel.count('miya-ct-def-bg-max-day')} 处",
    )
    check(
        re.search(r"maxPerDay\s*:\s*Math\.min\(200", panel) is not None,
        "S29 全局读取有 0..200 夹取",
    )

    # 文档里要能搜到，否则用户不知道有这功能
    check(
        "每日上限" in ct and "每日上限" in panel,
        "S30 两处 UI 都有「每日上限」文案",
    )


# ─────────────────────────────────────────────────────────────
# 运行时：把真正的函数源码抠出来，在 node 里跑
# ─────────────────────────────────────────────────────────────

NODE_HARNESS = r"""
const fs = require('fs');
/* node -e 的 argv 里没有脚本路径，路径只能走环境变量传进来 */
const src = fs.readFileSync(process.env.MIYA_BG_JS, 'utf8');

/* 从源码里抠出一个顶层 function 的完整源码（大括号配平） */
function extract(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('not found: ' + name);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unbalanced: ' + name);
}

/* clampInt 是后台模块里的私有工具，按同样语义复刻一份 */
function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

const pieces = ['localDayKey', 'withinDailyCap'].map(extract).join('\n');
const factory = new Function('clampInt', pieces + '\nreturn { localDayKey, withinDailyCap };');
const M = factory(clampInt);

/* ── DOM 环境：isUserComposing 只看 document.activeElement ── */
let _active = null;
global.document = {
    get activeElement() { return _active; },
};

const composingSrc = extract('isUserComposing');
const composing = new Function('document', composingSrc + '\nreturn isUserComposing;')(global.document);

const out = [];
function t(name, got, want) {
    /* undefined 会被 JSON.stringify 丢键；用哨兵替代，保证 Python 侧读得到 */
    var g = (got === undefined) ? '__undefined__' : got;
    var w = (want === undefined) ? '__undefined__' : want;
    out.push({ name: name, got: g, want: w, pass: got === want });
}


/* ══════ saveProactiveAttempt 的计数写入 ══════
 * 抽源码 + 桩 store 捕获 bmPatch，直接验 dayCount 的算法。
 * 之所以能这么测：这个函数只依赖 global.miyaChatStore 的 saveChatSettings，
 * 而它在我们控制的 global 对象上。
 */
const attemptSrc = extract('saveProactiveAttempt');

function runAttempt(extraBg, options, extra, dayOffsetMs) {
    let captured = null;
    const fakeStore = {
        saveChatSettings: function (chatId, patch) {
            captured = patch.backgroundMessage;
            return Promise.resolve();
        },
    };
    const fakeGlobal = { miyaChatStore: fakeStore };

    // 固定「今天」：把 Date.now 钉在某个时刻，方便断言 dayKey
    const realNow = Date.now;
    const T = realNow() + (dayOffsetMs || 0);
    Date.now = function () { return T; };

    const fn = new Function(
        'global', 'clampInt', 'localDayKey',
        attemptSrc + '\nreturn saveProactiveAttempt;'
    )(fakeGlobal, clampInt, M.localDayKey);

    fn('c1', { backgroundMessage: extraBg }, options || {}, extra || {});
    Date.now = realNow;
    return { patch: captured, today: M.localDayKey(T) };
}

const TODAY2 = M.localDayKey(Date.now());

t('recordAutoPushAt 时 dayCount 从 0 → 1',
  runAttempt({ dayKey: '', dayCount: 0 }, { isAutoPush: true }, { recordAutoPushAt: true }).patch.dayCount, 1);

t('当天已有 2 次 → 变 3',
  runAttempt({ dayKey: TODAY2, dayCount: 2 }, { isAutoPush: true }, { recordAutoPushAt: true }).patch.dayCount, 3);

t('★跨天：昨天 99 次 → 今天第一次是 1（不是 100）',
  runAttempt({ dayKey: '1999-01-01', dayCount: 99 }, { isAutoPush: true }, { recordAutoPushAt: true }).patch.dayCount, 1);

t('dayKey 同步写成今天',
  runAttempt({ dayKey: '1999-01-01', dayCount: 99 }, { isAutoPush: true }, { recordAutoPushAt: true }).patch.dayKey, TODAY2);

t('★失败路径（无 recordAutoPushAt）→ 不写 dayCount',
  runAttempt({ dayKey: TODAY2, dayCount: 5 }, { isAutoPush: true }, {}).patch.dayCount, undefined);

t('失败路径不写 dayKey',
  runAttempt({ dayKey: TODAY2, dayCount: 5 }, { isAutoPush: true }, {}).patch.dayKey, undefined);

t('失败路径仍写 lastProactiveAttemptAt（用于间隔计算）',
  typeof runAttempt({}, { isAutoPush: true }, {}).patch.lastProactiveAttemptAt, 'number');

t('脏数据 dayCount=abc → 当天当 0，+1 得 1',
  runAttempt({ dayKey: TODAY2, dayCount: 'abc' }, { isAutoPush: true }, { recordAutoPushAt: true }).patch.dayCount, 1);

t('离线成功也计数（isOffline 分支）',
  runAttempt({ dayKey: TODAY2, dayCount: 0 }, { isOffline: true }, { recordAutoPushAt: true }).patch.dayCount, 1);

t('lifeLike 成功也计数',
  runAttempt({ dayKey: TODAY2, dayCount: 0 }, { isLifeLike: true }, { recordAutoPushAt: true }).patch.dayCount, 1);

/* ══════ withinDailyCap / localDayKey ══════ */
const T = Date.UTC(2025, 4, 20, 10, 0, 0); // 2025-05-20
const TODAY = M.localDayKey(T);
const YESTERDAY = M.localDayKey(T - 86400000);

t('cap=0 不限（旧行为）', M.withinDailyCap({ maxPerDay: 0, dayKey: TODAY, dayCount: 999 }, T), true);
t('cap=3 今天 2/3 放行', M.withinDailyCap({ maxPerDay: 3, dayKey: TODAY, dayCount: 2 }, T), true);
t('cap=3 今天 3/3 拦住', M.withinDailyCap({ maxPerDay: 3, dayKey: TODAY, dayCount: 3 }, T), false);
t('cap=3 今天 4/3 拦住', M.withinDailyCap({ maxPerDay: 3, dayKey: TODAY, dayCount: 4 }, T), false);
t('★跨天计数作废', M.withinDailyCap({ maxPerDay: 3, dayKey: YESTERDAY, dayCount: 99 }, T), true);
t('dayKey 空 → 放行', M.withinDailyCap({ maxPerDay: 3, dayKey: '', dayCount: 99 }, T), true);
t('脏数据 dayCount=abc → 当 0', M.withinDailyCap({ maxPerDay: 3, dayKey: TODAY, dayCount: 'abc' }, T), true);
t('脏数据 maxPerDay 非数 → 不限', M.withinDailyCap({ maxPerDay: 'xx', dayKey: TODAY, dayCount: 99 }, T), true);
t('bg 为 null → 放行（不崩）', M.withinDailyCap(null, T), true);
t('日期键格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(TODAY), true);
t('本地时区取日（非 UTC）', M.localDayKey(new Date(2025, 4, 20, 23, 30).getTime()), '2025-05-20');

/* ══════ isUserComposing ══════ */
function el(tag, opts) {
    opts = opts || {};
    return {
        tagName: tag.toUpperCase(),
        value: opts.value,
        textContent: opts.textContent,
        isContentEditable: !!opts.editable,
        getAttribute: function (k) {
            if (k === 'data-user-typing') return opts.typing === undefined ? null : opts.typing;
            return null;
        },
    };
}

_active = null;
t('没有焦点元素 → 不算', composing(), false);

_active = el('textarea', { value: '' });
t('焦点在空的输入框 → 不算（只是点了一下）', composing(), false);

_active = el('textarea', { value: '   \n  ' });
t('输入框里只有空白 → 不算', composing(), false);

_active = el('textarea', { value: '你好' });
t('★正在输入框里写字 → 应压制', composing(), true);

_active = el('input', { value: '在吗' });
t('input 有内容 → 应压制', composing(), true);

_active = el('input', { value: '' });
t('input 空 → 不压制', composing(), false);

_active = el('div', { editable: true, textContent: '正在写' });
t('★contenteditable 有内容 → 应压制', composing(), true);

_active = el('div', { editable: true, textContent: '' });
t('contenteditable 空 → 不压制', composing(), false);

_active = el('div', { textContent: '正文内容' });
t('普通 div（不可编辑）→ 不算', composing(), false);

_active = el('button', { value: '提交' });
t('按钮即使有 value 也不算', composing(), false);

_active = el('textarea', { value: '', typing: '1' });
t('显式 data-user-typing=1 → 压制', composing(), true);

_active = el('span', { textContent: 'x', typing: '1' });
t('任意元素带 data-user-typing=1 → 压制', composing(), true);

/* 查询抛错时的兜底：绝不能「查不出来就永远不发」 */
_active = {
    tagName: 'TEXTAREA',
    get isContentEditable() { throw new Error('boom'); },
    get value() { throw new Error('boom'); },
    getAttribute: function () { throw new Error('boom'); },
};
t('★查询抛错 → 兜底 false（不能永久压制）', composing(), false);

console.log(JSON.stringify(out));
"""


def _run_node(source, bg_path):
    """把 node 源码跑起来，返回 (returncode, stdout, stderr)。"""
    env = dict(os.environ)
    env["MIYA_BG_JS"] = str(bg_path)
    proc = subprocess.run(
        ["node", "-e", source],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def runtime_checks():
    print("\n[运行时] 纯逻辑断言（node）")

    rc, stdout, stderr = _run_node(NODE_HARNESS, BG_JS)
    if rc != 0:
        bad("node 环境执行失败")
        print("    stderr:", stderr.strip()[:800])
        return

    try:
        results = json.loads(stdout.strip().splitlines()[-1])
    except Exception as e:  # noqa: BLE001
        bad(f"解析 node 输出失败：{e}")
        print("    stdout:", stdout.strip()[:800])
        return

    for r in results:
        check(r["pass"], f"R·{r['name']}  (got={r['got']!r} want={r['want']!r})")


# ─────────────────────────────────────────────────────────────
# A/B 守卫：把实现改坏，静态检查必须变红
# ─────────────────────────────────────────────────────────────

def ab_guard():
    print("\n[A/B] 反向守卫（改坏必须被抓出来）")

    src = read(BG_JS)

    # A/B-1：把 isUserComposing 的门从 triggerReply 里拿掉
    broken = src.replace(
        "if (isUserComposing()) return Promise.resolve();",
        "if (false) return Promise.resolve();",
        1,
    )
    check(broken != src, "A1 构造「打字门被摘掉」的变体成功")
    m = re.search(r"function triggerReply\s*\(", broken)
    body = broken[m.start(): m.start() + 3000]
    check(
        "isUserComposing()" not in body,
        "A2 摘掉后，静态检查能发现打字门缺失",
    )

    # A/B-2：把每日上限门改成写入失败标记（污染冷却）
    check(
        "lastPushFailAt" not in " ".join(
            ln.strip()
            for ln in body.splitlines()
            if "isUserComposing()" in ln or "withinDailyCap(" in ln
        ),
        "A3 门内不写 lastPushFailAt（守卫有效）",
    )

    # A/B-3：把 withinDailyCap 改成恒 true（每日上限形同虚设）
    #        正确的实现必须让至少两项「拦住」类断言变红。
    harness_broken = NODE_HARNESS.replace(
        "const pieces = ['localDayKey', 'withinDailyCap'].map(extract).join('\\n');",
        "const pieces = ['localDayKey'].map(extract).join('\\n') + "
        "`\\nfunction withinDailyCap(bg, now) { return true; }`;",
    )
    rc, stdout, stderr = _run_node(harness_broken, BG_JS)
    if rc == 0:
        res = json.loads(stdout.strip().splitlines()[-1])
        cap_fail = [r for r in res if "拦住" in r["name"] and not r["pass"]]
        check(
            len(cap_fail) >= 2,
            f"A4 把 withinDailyCap 改成恒 true 后，{len(cap_fail)} 项「拦住」断言变红",
        )
    else:
        bad("A4 变体执行失败：" + stderr.strip()[:300])

    # A/B-4：把 isUserComposing 改成恒 false（永远不压制）→ 打字门形同虚设
    harness_nocompose = NODE_HARNESS.replace(
        "const composingSrc = extract('isUserComposing');",
        "const composingSrc = 'function isUserComposing() { return false; }';",
    )
    rc, stdout, stderr = _run_node(harness_nocompose, BG_JS)
    if rc == 0:
        res = json.loads(stdout.strip().splitlines()[-1])
        compose_fail = [
            r for r in res
            if r["want"] is True and "压制" in r["name"] and not r["pass"]
        ]
        check(
            len(compose_fail) >= 2,
            f"A5 把 isUserComposing 改成恒 false 后，{len(compose_fail)} 项「压制」断言变红",
        )
    else:
        bad("A5 变体执行失败：" + stderr.strip()[:300])


def main():
    print("=" * 62)
    print("  主动消息礼貌门回归 — isUserComposing / withinDailyCap")
    print("=" * 62)

    if not BG_JS.exists():
        print(f"找不到 {BG_JS}")
        return 1

    static_checks()
    store_checks()
    session_scope_checks()
    ui_checks()
    runtime_checks()
    ab_guard()

    print("\n" + "=" * 62)
    print(f"  结果：{passed} 通过 / {failed} 失败")
    print("=" * 62)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
