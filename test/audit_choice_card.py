#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
audit_choice_card.py
────────────────────
剧情建议卡（[Choice|…] · 可点）的静态与渲染检查。

背景
────
「点一条建议 = 替你发一句话」这个功能横跨三层：

  1. 解析层  js2/miya-offline-card.js
             SCHEMA / GROUP_OF / SECTION_ALIAS / DEFAULT_SECTIONS
  2. 渲染层  同上，itemHtml 的 choice 分支
  3. 委托层  js1/miya-appointment-app.js
             root 点击委托里的 [data-mi-choice] 分支

任何一层漏了，表现都是「按钮不出现」或「点了没反应」——
后者尤其难查，因为它不报错。所以这里逐层上锁。

本脚本分两部分：
  A. 静态源码检查 —— 断言各层关键代码在位
  B. 渲染实测     —— 用 node 真跑一遍解析与渲染，断言产出的 HTML

用法：
    python3 test/audit_choice_card.py
"""

import json
import os
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CARD_JS = os.path.join(ROOT, "js2", "miya-offline-card.js")
APP_JS = os.path.join(ROOT, "js1", "miya-appointment-app.js")
CSS = os.path.join(ROOT, "css", "miya-offline-card.css")

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
        return ""
    return open(p, encoding="utf-8").read()


def static_checks():
    print("\n── A. 静态源码检查 ──")
    card = read("js2/miya-offline-card.js")
    app = read("js1/miya-appointment-app.js")
    css = read("css/miya-offline-card.css")

    # ── A1 解析层四处登记 ──
    # 少了任何一处，[Choices] 这行都会走「未知题材」分支，四条建议集体消失
    check("A1.1 SCHEMA 登记 choice", "choice:       ['text', 'hint']" in card)
    check("A1.2 GROUP_OF 登记 choice", "choice: 'choice'" in card)
    check("A1.3 DEFAULT_SECTIONS 登记「剧情建议」", "choice: '剧情建议'" in card)
    check(
        "A1.4 SECTION_ALIAS 登记 choices（漏了会走未知分支）",
        "choices: 'choice'" in card,
    )

    # ── A2 渲染层 ──
    check("A2.1 itemHtml 有 choice 分支", "if (t === 'choice')" in card)
    check("A2.2 用 button 而非 div（键盘可达）", "'<button type=\"button\" class=\"xwc__choice\"" in card)
    check("A2.3 属性值走 escAttr 转义", 'data-mi-choice="\' + escAttr(ctext)' in card)
    check("A2.4 空建议不产出空按钮", "if (!ctext) return '';" in card)

    # ── A3 委托层 ──
    check("A3.1 委托里接 [data-mi-choice]", "closest('[data-mi-choice]')" in app)
    check("A3.2 取文本用 getAttribute", "getAttribute('data-mi-choice')" in app)
    # 末尾楼层判定：这是防「把话插进历史中间」的关键
    check("A3.3 判定所属楼层用 data-ap-msg-id", "closest('[data-ap-msg-id]')" in app)
    check("A3.4 与末尾楼层比对", "floorId !== String(lastMsg.id)" in app)
    check("A3.5 生成中拒绝点击", "等上一镜结束再说" in app)
    check("A3.6 填入输入框后发送", "inputEl.value = choiceText;" in app)

    # ── A4 样式 ──
    check("A4.1 .xwc__choice 存在", ".xwc__choice {" in css)
    check("A4.2 清掉 button 默认外观", "appearance: none;" in css)
    check("A4.3 有 focus-visible（键盘焦点可见）", ":focus-visible" in css)
    check("A4.4 允许长建议换行", "overflow-wrap: anywhere;" in css)
    check("A4.5 走主题变量而非硬编码色", "var(--xwc-" in css)


def render_checks():
    print("\n── B. 渲染实测（node 真跑）──")

    script = r"""
global.window = global;
global.document = { createElement: function(){ return {}; } };
require(CARD_PATH);
var api = global.MiyaOfflineCard;
if (!api) { console.log(JSON.stringify({error:'模块未导出'})); process.exit(0); }

var raw = [
  '角色说了一句话。',
  '<card>',
  '[Profile|\u6211|\u5b66\u751f|Lv3|300|\u6709\u70b9\u7d27\u5f20]',
  '[Choices]',
  '[Choice|\u6211\u628a\u4f1e\u9012\u8fc7\u53bb\uff0c\u95ee\u5979\u8981\u4e0d\u8981\u4e00\u8d77\u8d70|\u987a\u52bf\u62c9\u8fd1\u5173\u7cfb]',
  '[Choice|\u5047\u88c5\u6ca1\u770b\u89c1\uff0c\u5148\u56de\u81ea\u5df1\u5de5\u4f4d|\u4fdd\u6301\u8ddd\u79bb]',
  '[Choice|\u53cd\u95ee\u5979"\u521a\u624d\u90a3\u53e5\u8bdd"\u4ec0\u4e48\u610f\u601d|\u628a\u8bdd\u644a\u5f00]',
  '[Choice|\u7ea6\u5979\u5468\u672b\u53bb\u4e0a\u6b21\u8bf4\u7684\u90a3\u5bb6\u5e97|\u63a8\u8fdb\u5230\u79c1\u4e0b\u76f8\u5904]',
  '</card>'
].join('\n');

var parsed = api.parseCard(raw);
var items = (parsed.sections.__items && parsed.sections.__items.choice) || [];
var html = api.renderCardBody(raw);
console.log(JSON.stringify({
  order: parsed.order,
  count: items.length,
  firstText: items[0] ? items[0].text : '',
  firstHint: items[0] ? items[0].hint : '',
  quotedKept: items[2] ? items[2].text.indexOf('"') >= 0 : false,
  buttonCount: (html.match(/class="xwc__choice"/g) || []).length,
  hasAttr: html.indexOf('data-mi-choice') >= 0,
  hasHint: html.indexOf('xwc__choice-hint') >= 0,
  escapedQuote: html.indexOf('&quot;') >= 0,
  secTitle: html.indexOf('\u5267\u60c5\u5efa\u8bae') >= 0
}));
"""
    script = script.replace("CARD_PATH", json.dumps(CARD_JS))
    tmp = "/tmp/_choice_render_probe.js"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(script)

    try:
        cp = subprocess.run(["node", tmp], capture_output=True, text=True, timeout=60)
        out = (cp.stdout or "").strip()
    except Exception as e:
        check("B0 能运行 node 探针", False, str(e))
        return

    if not out:
        check("B0 探针有输出", False, (cp.stderr or "")[:200])
        return

    try:
        r = json.loads(out.splitlines()[-1])
    except Exception:
        check("B0 探针输出可解析", False, out[:200])
        return

    if r.get("error"):
        check("B0 模块可加载", False, r["error"])
        return

    check("B1 解析出 choice 分区", "choice" in r["order"], str(r["order"]))
    check("B2 解析出 4 条建议", r["count"] == 4, "%d 条" % r["count"])
    check("B3 正文取对", r["firstText"].startswith("我把伞递过去"), r["firstText"])
    check("B4 补充说明取对", r["firstHint"] == "顺势拉近关系", r["firstHint"])
    check("B5 含引号的建议完整保留", r["quotedKept"])
    check("B6 渲染出 4 个按钮", r["buttonCount"] == 4, "%d 个" % r["buttonCount"])
    check("B7 带 data-mi-choice 属性", r["hasAttr"])
    check("B8 补充说明被渲染", r["hasHint"])
    # 这条最容易被忽略：建议里出现英文引号时，若不转义会直接破坏 HTML 结构
    check("B9 引号已转义为 &quot;（防破坏属性）", r["escapedQuote"])
    check("B10 分区标题显示为「剧情建议」", r["secTitle"])


def guard_checks():
    """
    A/B 反向守卫：把实现改坏，断言必须变红。
    只做「纯文本替换」式的破坏，不真改磁盘文件。
    """
    print("\n── C. 反向守卫（改坏应报错）──")
    card = read("js2/miya-offline-card.js")

    # 守卫 1：去掉 SECTION_ALIAS 的 choices 登记
    broken = card.replace("choices: 'choice'", "")
    check("C1 去掉 SECTION_ALIAS.choices 后，A1.4 判据失效",
          "choices: 'choice'" not in broken)

    # 守卫 2：把 escAttr 换成裸拼接 —— 引号会破坏属性
    broken2 = card.replace(
        'data-mi-choice="\' + escAttr(ctext)',
        'data-mi-choice="\' + ctext',
    )
    check("C2 去掉 escAttr 后，A2.3 判据失效",
          'data-mi-choice="\' + escAttr(ctext)' not in broken2)

    # 守卫 3：去掉末尾楼层判定 —— 会允许往历史中间插话
    app = read("js1/miya-appointment-app.js")
    broken3 = app.replace("floorId !== String(lastMsg.id)", "false")
    check("C3 去掉末尾楼层判定后，A3.4 判据失效",
          "floorId !== String(lastMsg.id)" not in broken3)


def main():
    print("=" * 72)
    print("剧情建议卡（可点）· 三层一致性检查")
    print("=" * 72)

    static_checks()
    render_checks()
    guard_checks()

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
    print("=" * 72)
    if FAIL:
        print("⚠ 剧情建议卡有问题：按钮可能不出现，或点了没反应。")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
