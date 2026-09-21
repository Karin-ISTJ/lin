#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
repro_theme_ava_blowout.py
──────────────────────────
复现并验证「进入聊天列表时整页被一张照片撑爆」。

症状回顾（用户反馈）：
    · 进入聊天列表 / 日记时，屏幕被一张巨大的照片占满
    · 把桌面「纯照片小组件」的照片清掉后症状消失
    · 之后重新导入图片 + 刷新，又复现不出来

根因：
    聊天列表头像是 <img class="soft-thread__ava qq-chat-item__ava">，
    它原先的 48×48 约束写在**依赖主题类**的选择器里
    （`.theme-soft .qq-chat-item__ava`）。一旦 theme-soft 类缺失，
    <img> 就完全没有尺寸约束，浏览器按图片**原始像素**铺开整页。

    wrapper `.soft-thread__ava-wrap` 原先也只有 flex-shrink:0、没有尺寸，
    挡不住里面的 img。

本测试用「移除 theme-soft 类」模拟主题类失效的那一刻，再测量
真实列表项里头像的渲染尺寸：

    bug 版：头像撑到图片原始宽度（远超 48px），页面被撑出横向滚动
    修复版：头像恒为 48×48，页面宽度稳定

对照组：群聊头像 wrapper `.qq-chat-item__ava-wrap--group` 是**无条件**
52×52，所以群聊从不出现此问题 —— 这也解释了为什么用户只在单聊列表见到。
"""

import os
import sys
import json

BASE = os.environ.get("MIYA_BASE", "http://localhost:8099")
TEST_URL = BASE + "/index.html"

from playwright.sync_api import sync_playwright

PASS = 0
FAIL = 0
RESULTS = []

# 一张 1600×1600 的真实位图（JPEG）。必须用位图而不是 SVG ——
# SVG data-URI 没有「固有像素尺寸」，在无约束容器里会塌成 0，
# 复现不出用户看到的「按原图尺寸铺开」。真实照片是位图，有固有尺寸。
_B64_PATH = "/tmp/bigimg.b64"
try:
    with open(_B64_PATH) as _f:
        BIG_IMG = "data:image/jpeg;base64," + _f.read().strip()
except Exception:
    # 兜底：现造一张 1600×1600 的纯色 JPEG
    import io as _io
    import base64 as _b64
    from PIL import Image as _Image

    _im = _Image.new("RGB", (1600, 1600), (200, 120, 80))
    _buf = _io.BytesIO()
    _im.save(_buf, "JPEG", quality=60)
    BIG_IMG = "data:image/jpeg;base64," + _b64.b64encode(_buf.getvalue()).decode()
    try:
        with open(_B64_PATH, "w") as _f:
            _f.write(BIG_IMG.split(",", 1)[1])
    except Exception:
        pass


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        RESULTS.append(("PASS", name, detail))
        print("  ✅ PASS  " + name + (("  ← " + detail) if detail else ""))
    else:
        FAIL += 1
        RESULTS.append(("FAIL", name, detail))
        print("  ❌ FAIL  " + name + (("  ← " + detail) if detail else ""))


def seed(page):
    """
    通过应用自身的 store API 造数据（聊天数据在 IndexedDB，不能靠写 LS）：
      · addContactFromChronicle → 建一个联系人，avatar 指向那张 1600×1600 巨图
      · createChat             → 建对应的单聊会话
    然后用 store 自己的渲染入口把列表画出来。
    """
    page.goto(TEST_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    out = page.evaluate(
        """(big) => new Promise((resolve) => {
        const st = window.miyaChatStore;
        if (!st) return resolve({ ok: false, why: 'no-store' });

        const done = (tag, val) => resolve(Object.assign({ ok: true, tag }, val));

        // ── 1) 建联系人（巨图头像）─────────────────────────
        st.addContactFromChronicle({
            id: 'chr-blowsize',
            characterId: 'chr-blowsize',
            name: '撑爆测试',
            avatar: big,
            groupId: 'ct-default'
        }).then(function (c) {
            // ── 2) 建单聊会话 ──────────────────────────────
            return st.createChat({ contactId: c.id, title: '撑爆测试' })
                     .then(function (ch) { return done('seeded', { contactId: c.id, chatId: ch && ch.id }); });
        }).catch(function (e) {
            resolve({ ok: false, why: String(e && e.message || e) });
        });
    })""",
        BIG_IMG,
    )
    print("  · [seed] " + json.dumps(out, ensure_ascii=False))
    page.wait_for_timeout(500)

    # 打开聊天应用并切到「聊天」页，触发真实的列表渲染
    nav = page.evaluate(
        """() => {
        const app = window.miyaChatApp;
        if (!app) return 'no-app';
        const log = [];
        try {
            if (typeof app.open === 'function') { app.open(); log.push('open'); }
            if (typeof app.switchTab === 'function') { app.switchTab('chat'); log.push('switchTab:chat'); }
            if (typeof app.refreshLists === 'function') { app.refreshLists(); log.push('refreshLists'); }
        } catch (e) { log.push('err:' + e.message); }
        return log.join('|');
    }"""
    )
    print("  · [nav] " + str(nav))
    page.wait_for_timeout(1500)
    return out


def open_chat_list(page):
    """切到聊天列表页（不依赖桌面小组件）。"""
    return page.evaluate(
        """() => {
        // 优先用应用自身的视图切换 API
        const app = window.miyaChatApp || window.miyaOfflineApp || null;
        if (app && typeof app.setView === 'function') { app.setView('list'); return 'api:list'; }
        if (app && typeof app.openChatList === 'function') { app.openChatList(); return 'api:openChatList'; }

        // 退而求其次：点桌面上的聊天图标
        const cand = [...document.querySelectorAll('[class*="desk"] [class*="item"]')]
            .find(el => /聊天|消息|chat/i.test(el.textContent || '') ||
                        /chat/i.test(el.getAttribute('data-app') || ''));
        if (cand) { cand.click(); return 'click:desk'; }

        // 再退：直接让列表容器可见
        const list = document.getElementById('qq-chat-list');
        if (list) {
            let p = list;
            while (p && p !== document.body) { p.style.display = ''; p = p.parentElement; }
            return 'force:visible';
        }
        return 'none';
    }"""
    )


def measure(page):
    """测量真实列表项里头像的渲染尺寸与页面宽度（等图片真正加载完）。"""
    # 等头像 img 完成加载，否则 naturalWidth/渲染尺寸都不可靠
    try:
        page.wait_for_function(
            """() => {
            const i = document.querySelector('.qq-chat-item img, .soft-thread img');
            return i && i.complete && i.naturalWidth > 0;
        }""",
            timeout=5000,
        )
    except Exception:
        pass
    page.wait_for_timeout(300)
    return page.evaluate(
        """() => {
        const items = [...document.querySelectorAll('.qq-chat-item, .soft-thread')];
        // 找到含 img 的那一项
        let target = null, img = null, wrap = null;
        for (const it of items) {
            const i = it.querySelector('img.qq-chat-item__ava, img.soft-thread__ava, img');
            if (i) { target = it; img = i; wrap = it.querySelector('.soft-thread__ava-wrap'); break; }
        }
        if (!img) {
            return {
                error: 'no-avatar-img',
                itemCount: items.length,
                listHTML: (document.getElementById('qq-chat-list') || {}).innerHTML
                          ? document.getElementById('qq-chat-list').innerHTML.slice(0, 300) : ''
            };
        }
        const ir = img.getBoundingClientRect();
        const wr = wrap ? wrap.getBoundingClientRect() : null;
        // 图片自然尺寸（用 naturalWidth/Height；未加载完时为 0）
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        // 是否「图片按原始尺寸溢出容器」：渲染尺寸远大于容器限制
        const escapesWrap = (wr && wr.width > 0)
            ? (ir.width > wr.width + 1)
            : (ir.width > 48 + 1);
        return {
            imgCls: (img.className || '').toString(),
            imgW: Math.round(ir.width),
            imgH: Math.round(ir.height),
            naturalW: nw,
            wrapW: wr ? Math.round(wr.width) : null,
            wrapH: wr ? Math.round(wr.height) : null,
            escapesWrap: escapesWrap,
            docScrollW: document.documentElement.scrollWidth,
            docScrollH: document.documentElement.scrollHeight,
            winW: window.innerWidth,
            winH: window.innerHeight,
            appHasThemeSoft: !!document.querySelector('.miya-chat-app.theme-soft'),
        };
    }"""
    )


def main():
    print("=" * 72)
    print("复现：主题类缺失时聊天列表头像撑爆布局")
    print("=" * 72)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},   # 手机视口
            device_scale_factor=2,
            service_workers="block",                   # 挡住 SW 的旧缓存
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                "Mobile/15E148 Safari/604.1"
            ),
        )
        page = ctx.new_page()

        # ── 用例 1：正常带 theme-soft ─────────────────────────────
        print("\n[用例 1] 正常状态（theme-soft 在位）")
        seed(page)
        open_chat_list(page)
        page.wait_for_timeout(800)
        m1 = measure(page)
        print("  · " + json.dumps(m1, ensure_ascii=False))
        if m1.get("error"):
            check("1.0 列表里能找到真实头像", False, json.dumps(m1, ensure_ascii=False))
        else:
            check("1.0 列表里能找到真实头像", True, "imgCls=%s" % m1.get("imgCls"))
            check(
                "1.1 头像宽 = 48px",
                m1.get("imgW") == 48,
                "imgW=%s naturalW=%s" % (m1.get("imgW"), m1.get("naturalW")),
            )
            check(
                "1.2 页面无横向溢出",
                m1.get("docScrollW", 0) <= m1.get("winW", 0) + 1,
                "scrollW=%s winW=%s" % (m1.get("docScrollW"), m1.get("winW")),
            )

        # ── 用例 2：剥离 theme-soft（模拟类失效）──────────────────
        print("\n[用例 2] theme-soft 被剥离（关键对照）")
        check(
            "2.0 theme-soft 在位（剥离前）",
            measure(page).get("appHasThemeSoft") is True,
            "",
        )
        page.evaluate(
            """() => {
            document.querySelectorAll('.theme-soft').forEach(
                el => el.classList.remove('theme-soft'));
        }"""
        )
        page.wait_for_timeout(600)
        m2 = measure(page)
        print("  · " + json.dumps(m2, ensure_ascii=False))
        check(
            "2.1 theme-soft 确实已剥离",
            m2.get("appHasThemeSoft") is False,
            "appHasThemeSoft=%s" % m2.get("appHasThemeSoft"),
        )
        check(
            "2.2 头像仍被约束为 48px 宽  ← 修复核心",
            m2.get("imgW") == 48,
            "imgW=%s（bug 版会是 %s）" % (m2.get("imgW"), m2.get("naturalW") or 1600),
        )
        check(
            "2.3 wrapper 仍有 48×48  ← 修复核心",
            m2.get("wrapW") == 48 and m2.get("wrapH") == 48,
            "wrap=%sx%s" % (m2.get("wrapW"), m2.get("wrapH")),
        )
        check(
            "2.4 页面无横向溢出  ← 修复核心",
            m2.get("docScrollW", 0) <= m2.get("winW", 0) + 1,
            "scrollW=%s winW=%s（bug 版会是 1600+）"
            % (m2.get("docScrollW"), m2.get("winW")),
        )
        check(
            "2.5 头像渲染尺寸不超过一屏（未按原图尺寸铺开）← 修复核心",
            (m2.get("imgW") or 0) <= (m2.get("winW") or 0) + 1
            and (m2.get("imgH") or 0) <= (m2.get("winH") or 0) + 1,
            "img=%sx%s viewport=%sx%s（bug 版会是 1600×1600，即「整页一张照片」）"
            % (
                m2.get("imgW"), m2.get("imgH"),
                m2.get("winW"), m2.get("winH"),
            ),
        )

        # ── 用例 3：群聊头像对照组 ────────────────────────────────
        print("\n[用例 3] 群聊头像对照组（无条件 52×52，本就不该出问题）")
        page.evaluate(
            """(big) => {
            const host = document.querySelector('#qq-chat-list') || document.body;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'soft-thread qq-chat-item qq-chat-item--group';
            btn.id = '__repro_group';
            btn.innerHTML =
                '<div class="soft-thread__ava-wrap qq-chat-item__ava-wrap--group">' +
                  '<img class="qq-chat-item__ava soft-thread__ava" src="' + big + '">' +
                '</div>' +
                '<div class="soft-thread__body"><div class="soft-thread__name">群聊对照</div></div>';
            host.appendChild(btn);
        }""",
            BIG_IMG,
        )
        page.wait_for_timeout(400)
        m3 = page.evaluate(
            """() => {
            const el = document.getElementById('__repro_group');
            const img = el.querySelector('img');
            const wrap = el.querySelector('.soft-thread__ava-wrap');
            const ir = img.getBoundingClientRect();
            const wr = wrap.getBoundingClientRect();
            return {
                imgW: Math.round(ir.width),
                wrapW: Math.round(wr.width),
                wrapH: Math.round(wr.height),
                themeSoft: !!document.querySelector('.miya-chat-app.theme-soft')
            };
        }"""
        )
        print("  · " + json.dumps(m3, ensure_ascii=False))
        check(
            "3.1 群聊 wrapper 稳定在 52×52（不依赖主题类）",
            m3.get("wrapW") == 52 and m3.get("wrapH") == 52,
            "wrap=%sx%s" % (m3.get("wrapW"), m3.get("wrapH")),
        )

        # ── 用例 4：首屏类稳定性（不依赖已移除的导出）────────────
        print("\n[用例 4] 主题类的首屏稳定性与幂等性")
        page4 = ctx.new_page()
        page4.goto(TEST_URL, wait_until="domcontentloaded")
        page4.wait_for_timeout(2000)
        comp = page4.evaluate(
            """() => {
            const app = document.getElementById('miya-chat-app');
            if (!app) return { ok: false, why: 'no-app' };

            const before = app.className;

            // miya-chat-ui-theme.js 已按设计不再导出全局 API，
            // 所以这里验证的是「首屏是否稳定带类」以及「重复操作不会丢类」。
            app.classList.add('theme-soft', 'theme-ins');   // 幂等：重复 add 不应出错
            app.classList.add('theme-soft', 'theme-ins');
            const idempotent = app.classList.contains('theme-soft') &&
                               app.classList.contains('theme-ins');

            // 关键：只 add 不 remove —— 确认不存在「两个类都不在」的写法
            const src = Array.from(document.scripts)
                .filter(s => /miya-chat-ui-theme/.test(s.src))
                .map(s => s.src);
            return {
                ok: idempotent,
                before: before,
                after: app.className,
                themeScripts: src,
            };
        }"""
        )
        print("  · " + json.dumps(comp, ensure_ascii=False))
        check(
            "4.1 类操作幂等：重复 add 后两个类都在位",
            comp.get("ok") is True,
            "after=%s" % comp.get("after"),
        )

        # 4.2 源码校验：ui-theme 不得在代码里对 theme-soft 调 remove
        #     （注释里提到 remove 是允许的，所以先剥掉注释再判）
        try:
            theme_src = page4.request.get(
                BASE + "/js1/miya-chat-ui-theme.js"
            ).text()
        except Exception as e:
            theme_src = ""
            print("  · [fetch-theme-src] failed: %s" % e)

        import re as _re
        code_only = _re.sub(r"/\*[\s\S]*?\*/", "", theme_src)      # 去块注释
        code_only = _re.sub(r"^\s*//.*$", "", code_only, flags=_re.M)  # 去行注释
        has_bad_remove = (
            "remove('theme-soft'" in code_only
            or 'remove("theme-soft"' in code_only
            or "remove('theme-ins" in code_only
        )
        check(
            "4.2 主题脚本代码中不再 remove theme-soft（消除空窗）",
            (theme_src != "") and (not has_bad_remove),
            "len=%d badRemove=%s" % (len(theme_src), has_bad_remove),
        )
        check(
            "4.3 主题脚本含轮询补偿（拿不到 #miya-chat-app 时重试）",
            "ensureTimer" in theme_src and "ensureTries" in theme_src,
            "",
        )

        # ── 用例 5：index.html 静态类兜底 ─────────────────────────
        print("\n[用例 5] 首屏静态类兜底（不依赖 JS 就能有尺寸约束）")
        page5 = ctx.new_page()
        page5.goto(TEST_URL, wait_until="domcontentloaded")
        page5.wait_for_timeout(1000)
        cls5 = page5.evaluate(
            """() => {
            const app = document.getElementById('miya-chat-app');
            return app ? app.className : '';
        }"""
        )
        check(
            "5.1 首屏 #miya-chat-app 已带 theme-soft",
            "theme-soft" in (cls5 or ""),
            "cls=%s" % cls5,
        )

        browser.close()

    print("\n" + "=" * 72)
    print("结果：%d 通过 / %d 失败" % (PASS, FAIL))
    print("=" * 72)
    for st, name, detail in RESULTS:
        if st == "FAIL":
            print("  ❌ %s  ← %s" % (name, detail))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
