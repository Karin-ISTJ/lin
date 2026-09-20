#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
气泡调试器 · 编译与反解纯函数测试

覆盖 js1/miya-chat-bubble-tuner.js 的 compileCss / parseCss / normalizeParams：
  【1】编译产物的三条硬约束（作用域 #qq-room、无 !important、注释不含 mq-wechat-skin）
  【2】往返一致：parseCss(compileCss(p)) 应与 p 等价
  【3】边界：radius=0 四角齐平、borderW=0 输出 none、无角标不输出 ::after
  【4】降级：手写 CSS 返回 matched=0、非法颜色退回默认、超范围夹取

不需要起浏览器 —— 直接在页面上下文里调纯函数。
"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        pg = await browser.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(BASE, wait_until="domcontentloaded")
        await pg.wait_for_timeout(1500)

        # 模块是否加载
        loaded = await pg.evaluate("() => !!(window.MiyaBubbleTuner)")
        check("MiyaBubbleTuner 模块已加载", loaded)
        if not loaded:
            print("\n模块未加载，后续测试跳过")
            await browser.close()
            return 1

        print("\n【1】编译产物的硬约束")
        r = await pg.evaluate("""() => {
          const T = window.MiyaBubbleTuner;
          const css = T.compileCss(T.DEFAULTS);
          return {
            hasRoom: css.includes('#qq-room '),
            noPreview: !css.includes('#mq-bf-preview'),
            noImportant: !css.includes('!important'),
            noWechat: !css.includes('mq-wechat-skin'),
            themRadius: /border-radius: 14px 14px 14px 4px/.test(css),
            meRadius: /border-radius: 14px 14px 4px 14px/.test(css),
            hasMark: css.startsWith(T.GEN_MARK)
          };
        }""")
        check("作用域为 #qq-room", r["hasRoom"])
        check("不含 #mq-bf-preview（作用域互转交给 beautify）", r["noPreview"])
        check("不含 !important（不霸占用户手写 CSS）", r["noImportant"])
        check("注释不含 mq-wechat-skin（避免误触底栏皮肤）", r["noWechat"])
        check("对方气泡呼吸角在左下", r["themRadius"])
        check("我方气泡呼吸角在右下", r["meRadius"])
        check("首行为固定标记", r["hasMark"])

        print("\n【2】往返一致")
        r = await pg.evaluate("""() => {
          const T = window.MiyaBubbleTuner;
          const p = T.normalizeParams({
            meBg:'#ffd6e8', meFg:'#3a2b33', themBg:'#ffffff', themFg:'#222222',
            borderColor:'#c89ab0', chatBg:'#fff5f9',
            radius:18, borderW:2, padX:16, padY:10, maxW:60, lineH:1.7,
            badgeUrl:'https://x.com/a.png', badgeSize:26, badgeTop:-8,
            badgeLeft:-6, badgeMirror:true
          });
          const back = T.parseCss(T.compileCss(p));
          const diffs = [];
          Object.keys(p).forEach(k => {
            if (k === 'badgeMirror') {
              if (!!back.params[k] !== !!p[k]) diffs.push(k);
              return;
            }
            if (String(back.params[k]) !== String(p[k])) diffs.push(k + ':' + p[k] + '->' + back.params[k]);
          });
          return { diffs, matched: back.matched, total: back.total };
        }""")
        check("往返参数完全一致", len(r["diffs"]) == 0, str(r["diffs"]))
        check("识别项数覆盖全部字段", r["matched"] == r["total"],
              f'{r["matched"]}/{r["total"]}')

        print("\n【3】边界")
        r = await pg.evaluate("""() => {
          const T = window.MiyaBubbleTuner;
          const c0 = T.compileCss(Object.assign({}, T.DEFAULTS, {radius:0}));
          const c1 = T.compileCss(Object.assign({}, T.DEFAULTS, {borderW:0}));
          const c2 = T.compileCss(T.DEFAULTS);
          const c3 = T.compileCss(Object.assign({}, T.DEFAULTS, {badgeUrl:'x"y\\\\z.png'}));
          const urlLine = c3.split('\\n').find(l => l.includes('url(')) || '';
          return {
            radius0: /border-radius: 0px 0px 0px 0px/.test(c0),
            borderNone: /border: none;/.test(c1),
            borderBack: T.parseCss(c1).params.borderW === 0,
            noBadge: !c2.includes('::after'),
            badgeHost: c2.includes('position: relative;') === false,
            urlClean: urlLine.includes('url("xyz.png")'),
            hasOverflow: T.compileCss(Object.assign({}, T.DEFAULTS,
              {badgeUrl:'https://a/b.png'})).includes('overflow: visible;')
          };
        }""")
        check("radius=0 时四角齐平（不残留 4px 小角）", r["radius0"])
        check("borderW=0 输出 border:none 而非 width:0", r["borderNone"])
        check("borderW=0 可正确回解", r["borderBack"])
        check("无角标时不输出 ::after 段", r["noBadge"])
        check("无角标时不输出宿主定位（不污染基础样式）", r["badgeHost"])
        check("角标 URL 清洗掉引号与反斜杠", r["urlClean"])
        check("角标段带 overflow:visible（防负偏移被裁）", r["hasOverflow"])

        print("\n【4】降级")
        r = await pg.evaluate("""() => {
          const T = window.MiyaBubbleTuner;
          const hand = '#qq-room{background:red} .foo .bar{baz:1}';
          const bad = T.normalizeParams({meBg:'rgb(1,2,3)', meFg:'not-a-color'});
          const cl = T.normalizeParams({radius:999, padX:-50, maxW:1000});
          const empty = T.parseCss('');
          return {
            handMatched: T.parseCss(hand).matched,
            handParams: Object.keys(T.parseCss(hand).params).length,
            badBg: bad.meBg === T.DEFAULTS.meBg,
            badFg: bad.meFg === T.DEFAULTS.meFg,
            clampR: cl.radius, clampPx: cl.padX, clampW: cl.maxW,
            emptyMatched: empty.matched,
            genTrue: T.isGenerated(T.compileCss(T.DEFAULTS)),
            genFalse: T.isGenerated(hand)
          };
        }""")
        check("手写 CSS 返回 matched=0", r["handMatched"] == 0)
        check("手写 CSS 不产生任何参数（调用方保留原值）", r["handParams"] == 0)
        check("空 CSS 返回 matched=0", r["emptyMatched"] == 0)
        check("非法颜色退回默认", r["badBg"] and r["badFg"])
        check("超范围夹取", r["clampR"] == 28 and r["clampPx"] == 2 and r["clampW"] == 100,
              f'radius={r["clampR"]} padX={r["clampPx"]} maxW={r["clampW"]}')
        check("isGenerated 认得出自己生成的 CSS", r["genTrue"])
        check("isGenerated 对非生成物返回 false", not r["genFalse"])

        check("全程无 pageerror", len(errors) == 0, "; ".join(errors[:3]))

        await browser.close()

    print(f"\n{'='*52}")
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        for f in failed:
            print(f"  ✗ {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
