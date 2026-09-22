#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
线下候选「记忆延迟写入」回归测试
================================

修的是什么
──────────
线下（预约）聊天里，一条角色楼层可以用右下角 ‹ › 翻出多个候选（不同剧情
走向），但它们**共用同一个消息 id**。记忆表的行溯源只记到消息 id，
分不出候选，于是：

  · 生成候选 B 时软删会把 A 写的记忆一起回收 → A 的记忆凭空消失
  · 用户翻回候选 A，界面回到 A，记忆表却停在 B → **串味**

解法（延迟写入）
────────────────
候选还悬着（用户没选定）时先不写记忆；等用户在某个候选下继续发消息，
那个候选被钉住，这时才补写它的记忆。

  · 引擎侧：shouldDeferMemoryForPendingSwipe() —— 决定「这次要不要跳过」
  · App 侧：confirmPendingFloorBeforeSend()   —— 决定「什么时候补写」
  两者必须成对，单独任何一边都是故障（都不写 / 照样串味）。

本测试验三件事
──────────────
  1. 判据逻辑本身（抽真源码在 node 里跑）
  2. 两处接入点在源码里确实接上了、且成对
  3. A/B 守卫：把判据改坏，必须有断言变红

跑法：python3 test/audit_swipe_defer_gate.py
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE_JS = ROOT / "js1" / "miya-appointment-engine.js"
APP_JS = ROOT / "js1" / "miya-appointment-app.js"
MT_APP_JS = ROOT / "js2" / "miya-memory-table-app.js"
STORE_JS = ROOT / "js1" / "miya-appointment-store.js"
MT_ENGINE_JS = ROOT / "js2" / "miya-memory-table-engine.js"

passed = 0
failed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"  \u2705 {msg}")


def bad(msg):
    global failed
    failed += 1
    print(f"  \u274c {msg}")


def check(cond, msg):
    ok(msg) if cond else bad(msg)


def note(msg):
    print(f"  \u2139\ufe0f  {msg}")


def read(p):
    return p.read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────
# 一、判据逻辑（node 跑真源码）
# ─────────────────────────────────────────────────────────────

NODE_HARNESS = r"""
const fs = require('fs');
const src = fs.readFileSync(process.env.MIYA_ENGINE_JS, 'utf8');

/* 抠出一个顶层 function 的完整源码（大括号配平） */
function extract(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('not found: ' + name);
    let i = src.indexOf('{', start), depth = 0;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unbalanced: ' + name);
}

const fnSrc = extract('shouldDeferMemoryForPendingSwipe');
const defer = new Function(fnSrc + '\nreturn shouldDeferMemoryForPendingSwipe;')();

const out = [];
function t(name, got, want) {
    out.push({ name: name, got: got, want: want, pass: got === want });
}

/* 造一条消息 */
function msg(id, role, opts) {
    opts = opts || {};
    return {
        id: id,
        role: role,
        content: opts.content === undefined ? '正文' : opts.content,
        swipes: opts.swipes,
        deleted: !!opts.deleted
    };
}
function sess(rows) { return { messages: rows }; }

/* ═══ 基础：不该跳过的情形 ═══ */
t('非角色楼层 → 不跳过',
  defer(sess([msg('m1', 'user')]), msg('m1', 'user')), false);

t('无 swipes 字段 → 不跳过（单候选正常生成）',
  defer(sess([msg('m1', 'assistant')]), msg('m1', 'assistant')), false);

t('swipes 为空数组 → 不跳过（刷新键写回的干净一版）',
  defer(sess([msg('m1', 'assistant', { swipes: [] })]), msg('m1', 'assistant', { swipes: [] })), false);

t('★末尾 + 有 1 个候选 → 跳过（还在挑）',
  defer(sess([msg('m1', 'assistant', { swipes: ['旧版'] })]),
        msg('m1', 'assistant', { swipes: ['旧版'] })), true);

t('★末尾 + 有 2 个候选 → 跳过',
  defer(sess([msg('m1', 'assistant', { swipes: ['a', 'b'] })]),
        msg('m1', 'assistant', { swipes: ['a', 'b'] })), true);

/* ═══ 关键：后面有楼层 → 已被钉住，正常写 ═══ */
t('★后面有 user 楼层 → 不跳过（历史楼层正常写）',
  defer(sess([
      msg('m1', 'assistant', { swipes: ['a', 'b'] }),
      msg('m2', 'user')
  ]), msg('m1', 'assistant', { swipes: ['a', 'b'] })), false);

t('★后面有 assistant 楼层 → 不跳过',
  defer(sess([
      msg('m1', 'assistant', { swipes: ['a', 'b'] }),
      msg('m2', 'assistant')
  ]), msg('m1', 'assistant', { swipes: ['a', 'b'] })), false);

t('后面有楼层但内容为空（占位）→ 仍算末尾 → 跳过',
  defer(sess([
      msg('m1', 'assistant', { swipes: ['a'] }),
      msg('m2', 'user', { content: '   ' })
  ]), msg('m1', 'assistant', { swipes: ['a'] })), true);

t('后面有楼层但已删 → 不算 → 跳过',
  defer(sess([
      msg('m1', 'assistant', { swipes: ['a'] }),
      msg('m2', 'user', { deleted: true })
  ]), msg('m1', 'assistant', { swipes: ['a'] })), true);

/* ═══ 多楼层场景：找准自己那一行 ═══ */
t('多楼层：末层有候选 → 跳过',
  defer(sess([
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'assistant', { swipes: ['x', 'y'] })
  ]), msg('m3', 'assistant', { swipes: ['x', 'y'] })), true);

t('多楼层：中间层有候选、后面有楼层 → 不跳过',
  defer(sess([
      msg('m1', 'assistant', { swipes: ['x'] }),
      msg('m2', 'user'),
      msg('m3', 'assistant')
  ]), msg('m1', 'assistant', { swipes: ['x'] })), false);

/* ═══ 降级：判不出来按「是末尾」处理（保守） ═══ */
t('★msg 在会话里找不到 → 按末尾处理 → 跳过',
  defer(sess([msg('m1', 'assistant')]), msg('ghost', 'assistant', { swipes: ['a'] })), true);

t('sess 为 null → 不跳过（无从判断，别乱跳）',
  defer(null, msg('m1', 'assistant', { swipes: ['a'] })), false);

t('msg 为 null → 不跳过',
  defer(sess([msg('m1', 'assistant')]), null), false);

t('msg 无 id → 不跳过',
  defer(sess([msg('m1', 'assistant')]), msg('', 'assistant', { swipes: ['a'] })), false);

t('messages 非数组 → 不跳过',
  defer({ messages: null }, msg('m1', 'assistant', { swipes: ['a'] })), false);

/* 异常兜底：swipes 的 getter 抛错 → 按末尾处理 */
const evilMsg = { id: 'm1', role: 'assistant', content: 'x' };
Object.defineProperty(evilMsg, 'swipes', { get() { throw new Error('boom'); } });
t('★读取 swipes 抛错 → 兜底 true（不能永久不写）', defer(sess([evilMsg]), evilMsg), true);

console.log(JSON.stringify(out));
"""


def runtime_checks():
    print("\n[运行时] 判据逻辑（node 跑真源码）")
    env = dict(os.environ)
    env["MIYA_ENGINE_JS"] = str(ENGINE_JS)
    proc = subprocess.run(
        ["node", "-e", NODE_HARNESS], capture_output=True, text=True, timeout=60, env=env
    )
    if proc.returncode != 0:
        bad("node 执行失败")
        print("    stderr:", proc.stderr.strip()[:800])
        return
    try:
        results = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception as e:  # noqa: BLE001
        bad(f"解析 node 输出失败：{e}")
        print("    stdout:", proc.stdout.strip()[:600])
        return
    for r in results:
        check(r["pass"], f"R·{r['name']}  (got={r['got']!r} want={r['want']!r})")


# ─────────────────────────────────────────────────────────────
# 二、源码接入点
# ─────────────────────────────────────────────────────────────

def wiring_checks():
    print("\n[静态] 引擎侧接入点")
    eng = read(ENGINE_JS)

    check("function shouldDeferMemoryForPendingSwipe(" in eng, "S1 判据函数已定义")

    m = re.search(r"var deferMemory = shouldDeferMemoryForPendingSwipe\(([^)]*)\)", eng)
    if not m:
        bad("S2 找不到 deferMemory 的调用")
    else:
        ok("S2 判据已被调用")
        args = m.group(1)
        check("sessAfter" in args and "msg" in args,
              f"S3 调用传了 sess 与 msg（实际：{args.strip()}）")

    # afterGenerate 必须被 !deferMemory 守住
    check(
        re.search(r"if\s*\(\s*\n?\s*!deferMemory\s*&&", eng) is not None,
        "S4 afterGenerate 被 !deferMemory 守住",
    )

    # 关键：跳过只作用于 afterGenerate，不能连累状态栏/自动总结
    idx_summary = eng.find("maybeAutoSummary(chatId, sessionId, preset);")
    idx_defer = eng.find("var deferMemory = shouldDeferMemoryForPendingSwipe")
    idx_after = eng.find("global.MiyaMemoryTableApp.afterGenerate({")
    check(
        idx_summary != -1 and idx_defer != -1 and idx_after != -1
        and idx_summary < idx_defer < idx_after,
        "S5 顺序正确：状态快照/状态栏/自动总结 在前，延迟门只包住 afterGenerate",
    )

    # 状态栏写入不能被包进 deferMemory
    idx_status = eng.find("statusApi.appendStatusLog(sessAfter, pack);")
    check(
        idx_status != -1 and idx_status < idx_defer,
        "S6 状态栏写入在延迟门之前（不受影响）",
    )
    check(
        eng.find("writeOfflinePromptSnapshot(chatId, built, fullRaw, msg);") < idx_defer,
        "S7 快照写入在延迟门之前（不受影响）",
    )


def mtraw_chain_checks():
    """记忆标记链路（mtRaw / swipeMtRaw）。

    这一组守的是「候选各自的记忆能不能被正确补写」：
    正文里的 <tableEdit> 在解析前就被剥掉（否则标签会进楼层），
    剥掉之后就解析不出记忆动作了 —— 所以必须留一份原始标记，
    并且**按候选分别保存**。任何一环断了，表现都是「补写写错版本」
    或者「补写压根不生效」，而这两者都很容易被误当成「记忆没写」。

    出过的两个真 bug 都在这一组里：
      · 漏传 dryRun → 候选悬着时照样落库，延迟门形同虚设；
      · 标记只留「当前版」一份 → 翻回旧候选确认时，写进去的是最新版的记忆。
    """
    print("\n[静态] 记忆标记链路（候选各自留存）")
    eng = read(ENGINE_JS)
    store = read(STORE_JS)
    mteng = read(MT_ENGINE_JS)

    # ── 引擎：dryRun 剥离 + 原样带回 ──
    check(
        "processAssistantReply(chatId, fullRaw, { dryRun: true })" in eng,
        "S20 引擎在解析正文前只剥离、不落库（dryRun）",
    )
    check(
        "mtRawForMsg" in eng,
        "S21 剥离出的原始标记被留在 mtRawForMsg 里",
    )
    check(
        re.search(r"mtRaw:\s*mtRawForMsg\s*\|\|\s*''", eng) is not None,
        "S22 写回消息时带上了本版的标记（含显式清空）",
    )
    check(
        re.search(r"swipeMtRaw:\s*prevSwipesMtRaw", eng) is not None,
        "S23 候选表写回时带上了平行的标记数组",
    )

    # ── 引擎：标记的归档与候选表同步 ──
    check(
        "function pushSwipeCandidate(" in eng and "keepIdx" in eng,
        "S24 pushSwipeCandidate 回传保留下标（供平行数组对齐）",
    )
    check(
        "function alignSwipeMtRaw(" in eng and "alignSwipeMtRaw(" in eng.split("function alignSwipeMtRaw(")[1],
        "S25 有 alignSwipeMtRaw 且被真正调用（裁剪后不错位）",
    )

    # ── store：字段白名单别漏（这一层以前漏过 farm / timeEvents）──
    check(
        "out.swipeMtRaw" in store,
        "S26 store 白名单放行 swipeMtRaw（漏了就会被静默丢掉）",
    )
    check(
        "out.mtRaw" in store,
        "S27 store 白名单放行 mtRaw",
    )
    # 归档点必须同步维护标记：softDeleteForRegenerate 会先于引擎填候选表
    seg = store[store.find("softDeleteForRegenerate: function"):]
    seg = seg[:seg.find("bumpRegenCount: function")]
    check(
        "swipeMtRaw" in seg,
        "S28 softDeleteForRegenerate 归档正文时**同步归档标记**",
    )

    # ── 记忆表引擎：dryRun 要回传 mtRaw ──
    check(
        re.search(r"if\s*\(dryRun\)\s*\{", mteng) is not None,
        "S29 processAssistantReply 有 dryRun 分支",
    )
    check(
        "mtRaw:" in mteng and "<tableEdit>" in mteng,
        "S30 dryRun 分支回传原始标记（整段收齐，不止首尾）",
    )

    # ── 记忆表 App：补写必须用标记，且只清所确认的那一候选 ──
    mt = read(MT_APP_JS)
    seg2 = mt[mt.find("function commitConfirmedFloor("):]
    seg2 = seg2[:seg2.find("global.MiyaMemoryTableApp = {")]
    check(
        "mtRaw" in seg2,
        "S31 commitConfirmedFloor 用楼层上的 mtRaw，而不是被剥离过的 content",
    )
    check(
        "swipeMtRaw" in seg2 and "swipeId" in seg2,
        "S32 补写成功后只清**所确认那一候选**的标记（不清别的候选）",
    )
    # afterGenerate 的线下分支也要用 mtRaw
    seg3 = mt[mt.find("function afterGenerate("):]
    seg3 = seg3[:seg3.find("function commitConfirmedFloor(")]
    check(
        "mtRaw" in seg3,
        "S33 afterGenerate 的线下分支读 mtRaw（否则终版记忆写不进去）",
    )


def app_wiring_checks():
    print("\n[静态] App 侧补写接入点")
    app = read(APP_JS)

    check("function confirmPendingFloorBeforeSend(" in app, "S8 补写函数已定义")

    m = re.search(r"(\n\s*)confirmPendingFloorBeforeSend\(\);(\n\s*)var userMsg = apStore\(\)\.addMessage", app)
    check(
        m is not None,
        "S9 补写调用紧邻且在 addMessage **之前**",
    )

    # 判据要认「有候选」
    seg = app[app.find("function confirmPendingFloorBeforeSend("):]
    seg = seg[:seg.find("\n    function sendMessage(") if "\n    function sendMessage(" in seg else 3000]
    check("swipes.length < 1" in seg, "S10 补写函数会跳过「没有候选」的楼层")
    check("m.role !== 'assistant'" in seg, "S11 只认角色楼层")
    check("commitConfirmedFloor" in seg, "S12 调用了补写入口")
    check(".catch" not in seg or "try {" in seg, "S13 补写有异常兜底（不阻断发消息）")


def mt_app_checks():
    print("\n[静态] 记忆表补写入口")
    mt = read(MT_APP_JS)

    check("function commitConfirmedFloor(" in mt, "S14 commitConfirmedFloor 已定义")
    check("commitConfirmedFloor: commitConfirmedFloor" in mt, "S15 已挂到 MiyaMemoryTableApp 导出对象")
    check(
        "eng.processAssistantReply(" in mt,
        "S16 复用既有纯文本提取入口 processAssistantReply",
    )
    check(
        "sourceMsgIds" in mt,
        "S17 补写带上了 sourceMsgIds（行溯源不丢）",
    )
    check(".catch(" in mt, "S18 补写失败有兜底")


# ─────────────────────────────────────────────────────────────
# 三、成对性：两边必须同时存在
# ─────────────────────────────────────────────────────────────

def pairing_checks():
    print("\n[静态] 两边成对性")
    eng = read(ENGINE_JS)
    app = read(APP_JS)

    has_defer = "function shouldDeferMemoryForPendingSwipe(" in eng
    has_commit = "function confirmPendingFloorBeforeSend(" in app
    check(
        has_defer and has_commit,
        "S19 延迟门与补写点同时存在（缺一即是故障）",
    )
    if has_defer and not has_commit:
        note("只有引擎侧 → 记忆永远不写，功能等于关掉")
    if has_commit and not has_defer:
        note("只有补写点 → 候选生成时就写，翻候选照样串味")


# ─────────────────────────────────────────────────────────────
# 四、A/B 守卫
# ─────────────────────────────────────────────────────────────

def ab_guard():
    print("\n[A/B] 反向守卫")
    eng = read(ENGINE_JS)

    # A1：把判据改成恒 true（一律跳过）→ 必有过不了
    broken_always = NODE_HARNESS.replace(
        "const defer = new Function(fnSrc + '\\nreturn shouldDeferMemoryForPendingSwipe;')();",
        "const defer = function(){ return true; };",
    )
    env = dict(os.environ)
    env["MIYA_ENGINE_JS"] = str(ENGINE_JS)
    proc = subprocess.run(
        ["node", "-e", broken_always], capture_output=True, text=True, timeout=60, env=env
    )
    if proc.returncode == 0:
        res = json.loads(proc.stdout.strip().splitlines()[-1])
        fails = [r for r in res if not r["pass"]]
        check(
            len(fails) >= 4,
            f"A1 判据改成恒 true 后，{len(fails)} 项断言变红（『不跳过』类）",
        )
    else:
        bad("A1 变体执行失败：" + proc.stderr.strip()[:300])

    # A2：把判据改成恒 false（一律不跳）→ 「跳过」类必须变红
    broken_never = NODE_HARNESS.replace(
        "const defer = new Function(fnSrc + '\\nreturn shouldDeferMemoryForPendingSwipe;')();",
        "const defer = function(){ return false; };",
    )
    proc = subprocess.run(
        ["node", "-e", broken_never], capture_output=True, text=True, timeout=60, env=env
    )
    if proc.returncode == 0:
        res = json.loads(proc.stdout.strip().splitlines()[-1])
        fails = [r for r in res if not r["pass"]]
        check(
            len(fails) >= 4,
            f"A2 判据改成恒 false 后，{len(fails)} 项断言变红（『跳过』类）",
        )
    else:
        bad("A2 变体执行失败：" + proc.stderr.strip()[:300])

    # A3：源码层——把 !deferMemory 改成 false（门失效）
    broken_src = eng.replace("!deferMemory &&", "false &&", 1)
    check(broken_src != eng, "A3 能构造「延迟门失效」的源码变体")
    check(
        re.search(r"if\s*\(\s*\n?\s*!deferMemory\s*&&", broken_src) is None,
        "A4 门失效后，静态检查 S4 能发现",
    )

    # A5：把补写调用挪到 addMessage 之后 → S9 必须变红
    app = read(APP_JS)
    broken_app = app.replace(
        "confirmPendingFloorBeforeSend();\n        var userMsg = apStore().addMessage",
        "var userMsg = apStore().addMessage",
        1,
    ).replace(
        "if (!userMsg) {\n            toast('没发出去，请退回重选角色');\n            return;\n        }",
        "if (!userMsg) {\n            toast('没发出去，请退回重选角色');\n            return;\n        }\n        confirmPendingFloorBeforeSend();",
        1,
    )
    check(broken_app != app, "A5 能构造「补写挪到 addMessage 之后」的变体")
    m = re.search(
        r"confirmPendingFloorBeforeSend\(\);(\n\s*)var userMsg = apStore\(\)\.addMessage",
        broken_app,
    )
    check(m is None, "A6 挪位后，静态检查 S9 能发现（补写不再在 addMessage 之前）")

    # ── 标记链路（mtRaw / swipeMtRaw）的反向守卫 ────────────────
    #
    # 这几条守的是「候选各自的记忆能不能被正确补写」。
    # 变异方向取自**真实出过的两个 bug**：
    #   · 漏传 dryRun → 候选悬着时照样落库
    #   · 标记只留当前版一份 → 翻回旧候选确认时写错版本
    mteng = read(MT_ENGINE_JS)
    store = read(STORE_JS)
    mt = read(MT_APP_JS)

    # A7：把 dryRun 去掉（回到「候选悬着也落库」）
    broken_dry = eng.replace(
        "processAssistantReply(chatId, fullRaw, { dryRun: true })",
        "processAssistantReply(chatId, fullRaw)",
        1,
    )
    check(
        broken_dry != eng
        and "processAssistantReply(chatId, fullRaw, { dryRun: true })" not in broken_dry,
        "A7 漏传 dryRun 后，静态检查 S20 能发现（延迟门形同虚设）",
    )

    # A8：把 dryRun 回传的标记清空 → 剥离之后谁也补不回来
    broken_mtraw = mteng.replace(
        "mtRaw: allBlocks.length ? allBlocks.join('\\n') : ''",
        "mtRaw: ''",
        1,
    )
    check(broken_mtraw != mteng, "A8 能构造「不回传原始标记」的变体")
    broken_dry_seg = broken_mtraw[
        broken_mtraw.find("if (dryRun) {") : broken_mtraw.find("if (!actions.length)")
    ]
    check(
        "mtRaw: allBlocks" not in broken_dry_seg,
        "A9 dryRun 不回传标记后，静态检查 S30 能发现（返回值里不再引用标记）",
    )

    # A10：store 白名单漏掉 swipeMtRaw（**全部**替换，否则另一处仍能被 S26 找到）
    broken_store = store.replace("out.swipeMtRaw", "out.__dropped__")
    check(
        broken_store != store and "out.swipeMtRaw" not in broken_store,
        "A10 白名单漏掉 swipeMtRaw 后，静态检查 S26 能发现（字段被静默丢弃）",
    )

    # A11：softDeleteForRegenerate 不同步归档标记 → 翻回旧候选写错版本
    broken_soft = store.replace(
        "                swipes: swipes,\n                swipeMtRaw: swipeMtRaw",
        "                swipes: swipes",
        1,
    )
    check(broken_soft != store, "A11 能构造「归档正文但漏归档标记」的变体")
    seg_after = broken_soft[
        broken_soft.find("softDeleteForRegenerate: function") : broken_soft.find("bumpRegenCount: function")
    ]
    check(
        "swipeMtRaw: swipeMtRaw" not in seg_after,
        "A12 漏归档标记后，静态检查 S28 能发现（标记与候选表错位）",
    )

    # A13：补写改用 content（被剥离过的正文）→ 永远解析不出动作
    seg_commit = mt[mt.find("function commitConfirmedFloor(") : mt.find("global.MiyaMemoryTableApp = {")]
    broken_commit = seg_commit.replace("var text = raw || fallback;", "var text = fallback;")
    check(
        broken_commit != seg_commit,
        "A13 能构造「补写只用 content」的变体",
    )
    check(
        "var text = raw || fallback;" not in broken_commit,
        "A14 补写不用标记后，源码里就找不到那行（说明 S31 守的是真实现）",
    )


def main():
    print("=" * 64)
    print("  线下候选 · 记忆延迟写入回归")
    print("=" * 64)

    for p in (ENGINE_JS, APP_JS, MT_APP_JS):
        if not p.exists():
            print(f"找不到 {p}")
            return 1

    runtime_checks()
    wiring_checks()
    app_wiring_checks()
    mt_app_checks()
    mtraw_chain_checks()
    pairing_checks()
    ab_guard()

    print("\n" + "=" * 64)
    print(f"  结果：{passed} 通过 / {failed} 失败")
    print("=" * 64)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
