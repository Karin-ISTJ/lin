#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 聊天设置「子视图完整性」回归测试

背景（用户报的）：「之前我把一些功能移过来了但是有些功能不完整」。
桌面设置 App 删除后，它承载的功能被搬进页内「聊天设置」的若干子视图。
搬迁过程里最容易出的病是：**渲染出来了，但随后被一次重绘擦掉**。

具体机制（同一个病，三种表现）：
  render() 对子视图是「整块换 innerHTML」。而 open() 在 store.init() 落地后
  会再排一次 requestAnimationFrame 重绘。于是——
    · 同步填充的内容（下拉选项 / 宿主面板）写在第 N 帧，
      第 N+1 帧整块换掉，节点还在但内部是空的，且**不会自己长回来**。

受影响的两条真实路径：
  1. 常规：进聊天设置 → 点子视图入口
  2. 冷启动直跳：openSubViewForChat()（老 API 兼容层 / 外部跳转走这条）

第 2 条是重灾区：open() 的异步重绘恰好在 openSubView() 的同步填充之后。
修法见 js1/miya-chat-contact-settings.js 的
scheduleSubViewHydrate / applySubViewHydrate。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/e2e_subviews.py
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

SEED = """
(function(){
  var now = Date.now();
  var meta = {
    version: 2, activeProfileId: 'p1',
    profiles: [{ id: 'p1', name: '我', createdAt: now, updatedAt: now }],
    emojiGroups: [], emojiPacks: [], savedMessages: [],
    contactGroups: [{ id: 'ct-default', name: '默认', sort: 0, createdAt: now }],
    contacts: [{ id: 'c1', name: '小满', remarkName: '小满', groupId: 'ct-default',
      createdAt: now, updatedAt: now, chatSettings: {} }],
    chats: [{ id: 'chat1', type: 'single', contactId: 'c1', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now, chatSettings: {} }],
    messagesByChat: { 'chat1': [] }, shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

# 每个子视图：期望标题 + 至少要有的控件数下限
# 下限只用来验「真的渲染出来了」，不锁死具体数量，避免以后加控件就红
SUBS = [
    ("api-chat",      "对话 API",     10),
    ("api-voice",     "语音合成",      6),
    ("backup",        "备份与恢复",    3),
    ("notify",        "通知与提示音",  8),
    ("chat-defaults", "聊天默认值",    5),
]

PROBE = """
(function(){
  var page = document.getElementById('mq-set-page');
  if (!page) return { err: 'no page' };
  var body = page.querySelector('[data-mq-set-body]');
  if (!body) return { err: 'no body' };
  var html = body.innerHTML || '';
  var n = 0;
  body.querySelectorAll('input,select,textarea,button').forEach(function(x){
    if (x.offsetParent !== null && x.type !== 'hidden') n++;
  });
  var host = page.querySelector('[data-mq-set-defaults-host]');
  return {
    title: (page.querySelector('.st-navtitle') || {}).textContent || '',
    len: html.length,
    controls: n,
    empty: html.indexOf('该设置页不存在') >= 0,
    notLoaded: html.indexOf('设置模块未加载') >= 0,
    hostLen: host ? host.innerHTML.length : -1
  };
})()
"""

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def open_via_click(pg, sub):
    """路径 1：进聊天设置页，然后真实点击子视图入口。"""
    await pg.evaluate("""
    (async function(){
      var st = window.miyaChatStore; await st.init();
      window.miyaChatApp.open();
      await new Promise(function(r){ setTimeout(r, 800); });
      window.miyaChatContactSettings.open('chat1');
      return true;
    })()""")
    await pg.wait_for_timeout(900)
    await pg.click(f'[data-mq-set-sub="{sub}"]')


async def open_via_direct(pg, sub):
    """路径 2：冷启动直跳（老兼容层与外部跳转走这条）。"""
    await pg.evaluate("""
    (async function(sub){
      var st = window.miyaChatStore; await st.init();
      window.miyaChatApp.open();
      await new Promise(function(r){ setTimeout(r, 700); });
      window.miyaChatContactSettings.openSubViewForChat('chat1', sub);
    })""", sub)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        page_errors = []

        for label, opener in [("常规点击", open_via_click), ("冷启动直跳", open_via_direct)]:
            print(f"\n{'='*60}\n路径：{label}\n{'='*60}")
            for sub, want_title, min_controls in SUBS:
                ctx = await browser.new_context(
                    user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True)
                pg = await ctx.new_page()
                pg.on("pageerror", lambda e: page_errors.append(str(e)))
                await pg.add_init_script(SEED)
                await pg.goto(BASE, wait_until="load")
                await pg.wait_for_timeout(4500)

                await opener(pg, sub)
                # 给足时间，确保 open() 那次延后重绘已经落地
                await pg.wait_for_timeout(2500)
                r = await pg.evaluate(PROBE)

                tag = f"[{label}] {sub}"
                if r.get("err"):
                    check(f"{tag} 正常渲染", False, r["err"])
                    await ctx.close()
                    continue

                check(f"{tag} 标题为「{want_title}」", r["title"] == want_title, repr(r["title"]))
                check(f"{tag} 不是「该设置页不存在」", r["empty"] is False)
                check(f"{tag} 模块已加载", r["notLoaded"] is False)
                check(f"{tag} 有可见控件（≥{min_controls}）",
                      r["controls"] >= min_controls, f"实际 {r['controls']} 个")
                # 宿主型子视图：容器里必须真的有内容，不能是空壳
                if sub == "chat-defaults":
                    check(f"{tag} 默认值面板已挂载", r["hostLen"] > 500,
                          f"host 内容 {r['hostLen']} 字符")
                # 对话 API 的下拉必须有选项来源（预设可能为空，但节点要在）
                if sub == "api-chat":
                    has_pick = await pg.evaluate(
                        "!!document.querySelector('#mq-api-preset-pick')")
                    check(f"{tag} 预设下拉已就位", has_pick is True)
                await ctx.close()

        print("\n【全程无 JS 报错】")
        check("无 pageerror", len(page_errors) == 0, str(page_errors[:3]))

        await browser.close()

    print(f"\n{'='*62}")
    print(f"通过 {len(passed)} / 共 {len(passed) + len(failed)}")
    if failed:
        print("失败项：")
        for f in failed:
            print("  -", f)
        return 1
    print("全部通过 ✅")
    return 0


raise SystemExit(asyncio.run(main()))
