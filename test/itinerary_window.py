#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「行程轨迹窗口方向」回归测试

缺陷现象（用户原话）
--------------------
「我发现行程轨迹设计有问题 生成出来的行程是未来七天的，应该要过去七天的。」

根因
----
行程窗口的**起点**被算成了「今天」，再往后铺 7 天：

    weekStart = isoDate(new Date())          // = 今天
    days[i].dateLabel = weekStart + i 天     // 第 1 天=今天 … 第 7 天=今天+6

于是整个窗口 100% 落在未来。而这个功能的语义是「角色**已经经历**的行程」：
对话注入的 `buildChatItineraryBlock` 读的是「此刻这一格」，
日历渲染展示的是「过去这些天做了什么」—— 两者都要求窗口覆盖过去。

三处各自独立地取「今天」，必须一起改，否则会出现
「生成用未来、渲染按过去」的错位：

  1. `buildUserPrompt`      —— 喂给 AI 的日期清单
  2. `generateWeekSchedule` —— 落库时的 weekStart
  3. `normalizeSchedule`    —— 缺省补全时的 weekStart

修复
----
新增 `store.pastWindowStartIso()`：今天往前推 (WEEK_DAYS - 1) = 6 天。
窗口 = [今天-6, 今天]，今天落在最后一天，**当天对话一定能查到当前时段**。
过期判定沿用 `weekEndDate = weekStart+6 天 23:59:59.999`，即今天过完才过期。

跑法（纯 Node，不需要浏览器）：
    node test/itinerary_window.py    # 见文件末尾说明
或直接：
    python3 test/itinerary_window.py
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
const fs = require('fs'), vm = require('vm');
const ROOT = process.argv[2];

const sandbox = {
  console, Date, Intl, JSON, Math, Number, String, Array, Object,
  parseInt, isNaN, setTimeout, clearTimeout, Promise, RegExp, Error, Boolean,
  localStorage: (function () {
    const m = {};
    return { getItem: k => (k in m ? m[k] : null),
             setItem: (k, v) => { m[k] = String(v); },
             removeItem: k => { delete m[k]; } };
  })()
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(ROOT + '/js2/miya-itinerary-store.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(ROOT + '/js2/miya-itinerary-bridge.js', 'utf8'), sandbox);

const st = sandbox.miyaItineraryStore;
const bridgeSrc = fs.readFileSync(ROOT + '/js2/miya-itinerary-bridge.js', 'utf8');
const storeSrc = fs.readFileSync(ROOT + '/js2/miya-itinerary-store.js', 'utf8');

const out = [];
const t = new Date(); t.setHours(0, 0, 0, 0);
const todayIso = st.isoDate(t);

/* ── A. 窗口本身 ─────────────────────────────────────────── */
const startIso = st.pastWindowStartIso();
const start = (function (iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
})(startIso);
const backDays = Math.round((t - start) / 86400000);
out.push(['A1 窗口起点 = 今天往前 6 天', backDays === 6, `起点=${startIso} 往前=${backDays}天`]);

const end = st.weekEndDate(startIso);
out.push(['A2 窗口终点 = 今天', st.isoDate(end) === todayIso, `终点=${st.isoDate(end)}`]);

const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
const span = Math.round((endDay - start) / 86400000) + 1;
out.push(['A3 窗口恰为 7 天', span === 7, `含首尾=${span}`]);

out.push(['A4 今天落在窗口内（不判过期）',
          st.isScheduleExpired({ weekStart: startIso }) === false, '']);

const seen = [];
for (let i = 0; i < 7; i++) { const x = new Date(start); x.setDate(x.getDate() + i); seen.push(st.isoDate(x)); }
out.push(['A5 第 7 天就是今天（当天可查时段）', seen[6] === todayIso, `第7天=${seen[6]}`]);
out.push(['A6 7 天连续无重复', new Set(seen).size === 7, seen.join(',')]);

/* ── B. 三处 weekStart 口径必须一致 ───────────────────────── */
const sch = st.normalizeSchedule({ days: [] }, 'c1');
out.push(['B1 normalizeSchedule 缺省 = 过去窗口',
          !!sch && sch.weekStart === startIso, sch ? sch.weekStart : 'null']);

out.push(['B2 生成侧缺省走 pastWindowStartIso',
          bridgeSrc.indexOf('pastWindowStartIso') >= 0, '']);

const todayBased = bridgeSrc.match(/weekStart = opts\.weekStart \|\| \(store && store\.isoDate\s*\?\s*store\.isoDate\(new Date\(\)\)/g);
out.push(['B3 生成侧不再以「今天」为起点', !todayBased, todayBased ? String(todayBased.length) + ' 处残留' : '']);

/* ── C. 提示词措辞（过去时） ──────────────────────────────── */
out.push(['C1 日期清单标题为「过去七天时间」', bridgeSrc.indexOf('【过去七天时间】') >= 0, '']);
out.push(['C2 不再出现「【本周时间】」', bridgeSrc.indexOf('【本周时间】') < 0, '']);
out.push(['C3 生成任务写明「回溯」', bridgeSrc.indexOf('回溯并整理从') >= 0, '']);
out.push(['C4 生成任务写明「已经发生过」', bridgeSrc.indexOf('已经发生过') >= 0, '']);
out.push(['C5 提示词禁止写计划', bridgeSrc.indexOf('不要写计划') >= 0, '']);

/* ── D. 导出面 ───────────────────────────────────────────── */
out.push(['D1 store 导出 pastWindowStartIso',
          typeof st.pastWindowStartIso === 'function', '']);

console.log(JSON.stringify(out));
"""


def main():
    print("\n【行程轨迹窗口方向】\n")

    js_path = os.path.join("/tmp", "_itinerary_window_check.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(JS)

    proc = subprocess.run(
        ["node", js_path, ROOT],
        capture_output=True, text=True
    )
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

    rows = json.loads(line[-1])
    for name, ok, detail in rows:
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
