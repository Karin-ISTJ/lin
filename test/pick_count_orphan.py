#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「选择追踪角色」计数多 1 · 孤儿 id 回归测试

缺陷现象（用户两张截图）
------------------------
【图一】选择追踪角色右上角显示「1 已选」，但 6 个勾选框**全是空的**，
        下方「已选行程」显示「00 TRACKING」（0 个）。
【图二】勾选「阐述」后显示「2 已选」，「01 TRACKING」（1 个）。

真实数量是 0 → 1，标题却报 1 → 2，**恒定多 1**。
「NN TRACKING」和勾选框都是对的，只有「N 已选」错。

根因
----
两个计数走了**不同数据源**：

  「N 已选」（app.js:313）
      = getEnabledContactIds().length
      = Object.keys(enabled).filter(v => enabled[v])      ← 只按 key 数，不校验联系人

  「NN TRACKING」（app.js:349）
      = getAllContactRows().filter(isEnabled).length       ← 遍历真实联系人

enabled 是 { "<contactId>": true } 的 map。联系人被删后这条 key 永远留着
（setEnabled 只在显式取消勾选时 delete），于是前者把孤儿一起数进去。

连带 bug（更隐蔽）
------------------
「先勾选角色才能开自动生成」的守卫（app.js:517）也靠同一个 length 判空。
孤儿让它误以为「已经选过角色」→ 守卫放行 → 用户一个角色都没选却能开启
「自动生成行程」，而 getExpiredEnabledContacts 会把孤儿正确排除，
于是这个开关开着但什么也不做。

修复
----
1. `pruneOrphanEnabled()`：读取时懒清理（loadRaw 三条分支 + 异步水合）
2. `getEnabledContactIds()`：只返回**真实存在**的联系人 id（计数口径统一）
3. `purgeContactScopedData` 新增 `safe('itinerary', …)`：删联系人时联动清理

关键约束
--------
`aliveContactIds()` 在联系人列表**为空**时返回 null，表示「拿不到」而非
「一个都没有」。否则 store 未就绪时会把 enabled 里的正常条目全删光。
F8 就是锁这一条的。

跑法：python3 test/pick_count_orphan.py
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


JS = r"""
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = process.argv[2];

/* 每个场景独立沙箱：需要能重建 store，所以封装成函数 */
function boot(storedEnabled, contacts) {
  const sandbox = {
    console, Date, Intl, JSON, Math, Number, String, Array, Object,
    parseInt, isNaN, setTimeout, clearTimeout, Promise, RegExp, Error, Boolean,
    localStorage: (function () {
      const m = {};
      return { getItem: k => (k in m ? m[k] : null),
               setItem: (k, v) => { m[k] = String(v); },
               removeItem: k => { delete m[k]; },
               __dump: () => m };
    })()
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.miyaLsIsIdbPlaceholder = () => false;
  sandbox.localStorage.setItem('miya-itinerary-v1', JSON.stringify({
    settings: { autoGenerate: false }, enabled: storedEnabled, schedules: {}
  }));
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ROOT + '/js2/miya-itinerary-store.js', 'utf8'), sandbox);

  if (contacts !== null) {
    sandbox.miyaChatStore = { getContacts: () => contacts };
  }
  const st = sandbox.miyaItineraryStore;
  const keys = () => {
    try { return Object.keys(JSON.parse(sandbox.localStorage.__dump()['miya-itinerary-v1']).enabled || {}); }
    catch (e) { return null; }
  };
  return { sandbox, st, keys };
}

const out = [];
const TWO = [{ id: 'c1', name: '谢临川' }, { id: 'c2', name: '顾临渊' }];

/* ── F1/F2：孤儿必须被剔除，且计数与真实联系人一致 ───────────── */
{
  const { st, keys } = boot({ c1: true, c2: true, ghost: true }, TWO);
  const ids = st.getEnabledContactIds();
  out.push(['F1 计数不含孤儿（用户截图「多 1」的直接根因）',
            ids.length === 2, JSON.stringify(ids)]);
  out.push(['F2 getEnabledContactIds 不含 ghost',
            ids.indexOf('ghost') < 0, JSON.stringify(ids)]);
}

/* ── F2b/F2c：★ 把懒清理停掉，单独验证「过滤」这条防线 ─────────
   为什么必须单独测：懒清理（pruneOrphanEnabled）一跑，孤儿就从存储里没了，
   于是过滤逻辑即使被删掉，F1/F2 也会通过 —— 反证时就是这么暴露的。
   这里人为让 pruneOrphanEnabled 返回 false（不删 key），
   强制让孤儿留在 enabled 里，再看计数还准不准。 ─────────────── */
{
  const { st, keys } = boot({ c1: true, ghost: true }, TWO);
  st.setDisableOrphanPrune(true);   // 停掉懒清理
  const ids = st.getEnabledContactIds();
  const k = keys();
  out.push(['F2b★ 懒清理失效时，过滤仍保证计数不含孤儿',
            ids.indexOf('ghost') < 0 && ids.length === 1, JSON.stringify(ids)]);
  out.push(['F2c★ 上一步确实没删 key（证明测的是过滤而非清理）',
            k.indexOf('ghost') >= 0, JSON.stringify(k)]);
}

/* ── F3：勾选一个真实角色 → 1（不是 2） ─────────────────────── */
{
  const { st } = boot({ ghost: true }, TWO);
  st.setDisableOrphanPrune(true);   // 停掉懒清理，逼过滤生效
  st.setEnabled('c1', true);
  const ids = st.getEnabledContactIds();
  out.push(['F3 1 个真实勾选 → 计数为 1（用户图二：不该是 2）',
            ids.length === 1, JSON.stringify(ids)]);
}

/* ── F4：两个计数口径必须恒等（本次 bug 的本质） ────────────── */
{
  const { st } = boot({ c1: true, ghost: true, ghost2: true }, TWO);
  st.setDisableOrphanPrune(true);   // 停掉懒清理，逼过滤生效
  const a = st.getEnabledContactIds().length;
  const b = st.getAllContactRows().filter(c => st.isEnabled(c.id)).length;
  out.push(['F4 「N 已选」与「NN TRACKING」口径恒等',
            a === b && a === 1, `已选=${a} TRACKING=${b}`]);
}

/* ── F5：巡检不得认领孤儿（既有正确行为，防回退） ───────────── */
{
  const { st } = boot({ c1: true, ghost: true }, TWO);
  const rows = st.getExpiredEnabledContacts();
  const ids = rows.map(r => r.id);
  out.push(['F5 getExpiredEnabledContacts 不含孤儿',
            ids.indexOf('ghost') < 0, JSON.stringify(ids)]);
}

/* ── F6：守卫语义 —— 只有孤儿时 length 必须为 0 ────────────── */
{
  const { st } = boot({ ghost: true }, TWO);
  st.setDisableOrphanPrune(true);   // 停掉懒清理，逼过滤生效
  out.push(['F6 只有孤儿时守卫判空为真（否则误放行开自动生成）',
            st.getEnabledContactIds().length === 0,
            'length=' + st.getEnabledContactIds().length]);
}

/* ── F7：懒清理必须落盘，不是只过滤 ───────────────────────── */
{
  const { st, keys } = boot({ c1: true, ghost: true }, TWO);
  st.getEnabledContactIds();     // 触发一次读取
  const k = keys();
  out.push(['F7 孤儿已从存储里删掉（不只是过滤）',
            k.indexOf('ghost') < 0 && k.indexOf('c1') >= 0, JSON.stringify(k)]);
}

/* ── F8：★ 联系人列表为空时绝不误删（防灾难） ──────────────── */
{
  const { st, keys } = boot({ c1: true, c2: true }, []);
  const ids = st.getEnabledContactIds();
  const k = keys();
  const untouched = k.length === 2 && k.indexOf('c1') >= 0 && k.indexOf('c2') >= 0;
  out.push(['F8★ 联系人未就绪时不误删任何 key',
            untouched, 'enabled=' + JSON.stringify(k) + ' ids=' + JSON.stringify(ids)]);
}

/* ── F9：chatStore 缺失时不崩、不删 ───────────────────────── */
{
  const { st, keys } = boot({ c1: true }, null);   // contacts=null → 不挂 chatStore
  const ids = st.getEnabledContactIds();
  out.push(['F9 chatStore 未加载时原样返回且不删',
            ids.length === 1 && keys().length === 1, JSON.stringify(ids)]);
}

/* ── F10：正常路径不回归 —— 取消勾选后计数归零 ────────────── */
{
  const { st, keys } = boot({ c1: true }, TWO);
  st.setEnabled('c1', false);
  out.push(['F10 取消勾选后计数归零且 key 被删',
            st.getEnabledContactIds().length === 0 && keys().indexOf('c1') < 0,
            JSON.stringify(keys())]);
}

/* ── F11：删除联系人联动已接入 purgeContactScopedData ──────── */
{
  const src = fs.readFileSync(ROOT + '/js1/miya-chat-store.js', 'utf8');
  const has = src.indexOf("safe('itinerary'") >= 0
           && src.indexOf('miyaItineraryStore') >= 0
           && /safe\('itinerary'[\s\S]{0,400}?setEnabled\(key,\s*false\)/.test(src);
  out.push(['F11 purgeContactScopedData 已接 itinerary 清理', has, '']);
}

/* ── F12：pruneOrphanEnabled 已导出（供清理/测试调用） ─────── */
{
  const { st } = boot({ c1: true }, TWO);
  out.push(['F12 store 导出 pruneOrphanEnabled',
            typeof st.pruneOrphanEnabled === 'function', '']);
}

console.log(JSON.stringify(out));
"""


def main():
    print("\n【选择追踪角色 · 计数孤儿 id】\n")

    js_path = os.path.join("/tmp", "_pick_count_orphan_check.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(JS)

    proc = subprocess.run(["node", js_path, ROOT], capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr)
        check("Node 校验脚本可执行", False, "见上方报错")
        return finish()

    line = [l for l in proc.stdout.strip().split("\n") if l.startswith("[")]
    if not line:
        print(proc.stdout)
        check("Node 校验脚本有输出", False, "未捕获到结果数组")
        return finish()

    for name, ok, detail in json.loads(line[-1]):
        check(name, bool(ok), detail)

    finish()


def finish():
    print("\n" + "=" * 60)
    print(f"通过 {len(passed)} / 共 {len(passed) + len(failed)}")
    if failed:
        print("失败项：")
        for f in failed:
            print("  ✗", f)
        sys.exit(1)
    print("全部通过 ✅")
    print("=" * 60)


if __name__ == "__main__":
    main()
