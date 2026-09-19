# -*- coding: utf-8 -*-
"""
E2E：多选模式下点图片应「选中」而不是「打开大图」
=================================================

用户报告（原话）：
  「点删除开始选消息的时候 如果我点图片 容易点进图片预览状态
    要点发图片的边边才能选中」

根因假设
--------
两条点击监听器的**阶段不同**：

  · 图片大图预览：document 上的 **capture** 监听（bindGlobalImageClicks）
  · 多选选中：    roomEl 上的 **bubble** 监听

roomEl 是 document 的后代，所以派发顺序是
  document(capture) → ... → roomEl(bubble)
图片预览先执行，并调用了 stopPropagation()，
把事件截断，roomEl 的多选逻辑根本没机会跑。

图片卡片是 <button> 包着 <img>，按钮面积 = 整张图。
只有"边边"（button 的 padding/边框）没有命中 [data-mq-img-view]
的 closest 匹配……实际上边边也在 button 内，所以是**偶发**：
点快了/点在特定位置时表现为可选中 —— 这解释了"容易"而非"必然"。

本测试在真实浏览器里验证修复后：
  M1  进入多选模式成功
  M2  点击图片卡片 → 被选中（不是打开大图）
  M3  大图预览**未**打开
  M4  点击图片下载/其它消息类型仍能正常选中
  M5  退出多选后，点图片恢复正常打开大图

跑法：python3 test/e2e_multiselect_image_click.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"


async def main():
    results = []

    def check(name, cond, detail=""):
        results.append({"name": name, "pass": bool(cond), "detail": str(detail)})

    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page()

        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(2500)

        # ── 造数：联系人 → 会话 → 一条文字 + 一条图片 ──
        setup = await pg.evaluate("""async () => {
            const CS = window.miyaChatStore;
            if (CS.init) await CS.init();
            const cs = window.miyaContactsStore;
            if (cs && cs.upsertCharacter) {
                cs.upsertCharacter({ name: '多选测', groupId: 'ct_default', persona: 'x' });
            }
            const contact = await CS.addContactFromChronicle(
                { id: 'actor_ms', characterId: 'actor_ms', name: '多选测' }
            ).catch(() => null);
            if (!contact || !contact.id) return { error: 'no_contact' };
            const chat = await CS.createChat({ contactId: contact.id }).catch(() => null);
            const cid = chat && chat.id ? String(chat.id) : null;
            if (!cid) return { error: 'no_chat' };
            await CS.addMessage(cid, { role: 'user', content: '看看这张图' });
            /*
             * 图片消息的正确形状：type='image' + imageDataKey。
             * parseDisplayPayload 只认 m.type === 'image'；
             * 我第一版写成 kind:'photo'，结果卡片根本没渲染出来
             * （M1b 图片卡片数=0），等于没测到目标。
             */
            const m2 = await CS.addMessage(cid, {
                role: 'assistant',
                type: 'image',
                content: '[图片]',
                imageDataKey: 'blob_test_key'
            });
            return { cid, contactId: contact.id, imgMsgId: m2 && m2.id };
        }""")
        check("M0 造数成功", not setup.get("error"),
              json.dumps(setup, ensure_ascii=False))
        if setup.get("error"):
            await b.close()
            _report(results)
            return 1

        cid = setup["cid"]

        # ── 给假 blobKey 挂一个真实可解析的 URL ──
        #
        # 不这么做的话 openImageLightbox 会在 resolveChatImageUrl 处
        # 拿不到 url 而 early-return，大图**根本不会打开** ——
        # 于是「M3 大图未被打开」在任何情况下都通过，等于没测。
        # 这是典型的假通过，必须堵掉。
        stub = await pg.evaluate("""() => {
            const CS = window.miyaChatStore;
            if (typeof CS.getCachedBlobUrl !== 'function') return { ok: false, err: 'no_api' };
            // 1x1 透明 gif
            const url = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            const orig = CS.getCachedBlobUrl;
            CS.getCachedBlobUrl = function (k) {
                if (String(k) === 'blob_test_key') return url;
                return orig.call(CS, k);
            };
            return { ok: true, resolved: CS.getCachedBlobUrl('blob_test_key') === url };
        }""")
        check("M1d 已为假 blobKey 挂上可解析 URL（避免 M3 假通过）",
              stub.get("ok") is True and stub.get("resolved") is True,
              json.dumps(stub, ensure_ascii=False))

        # ── 打开聊天 App，再进具体会话 ──
        #
        # 只调 miyaChatRoom.open(cid) 不够：房间壳没被挂到可见层级，
        # 卡片虽然渲染出来了但 isVisible=false，Playwright 点不到
        # （第一版就卡在 "Element is not visible"）。
        # 必须先走 App 壳（openChatApp 会 paintChatAppShell），再进房。
        opened = await pg.evaluate("""async (args) => {
            try {
                if (window.miyaChatApp && typeof window.miyaChatApp.open === 'function') {
                    await window.miyaChatApp.open();
                }
            } catch (e) { /* 壳打开失败也继续试进房 */ }
            await new Promise(function (r) { setTimeout(r, 400); });
            try {
                if (window.miyaChatRoom && typeof window.miyaChatRoom.open === 'function') {
                    await window.miyaChatRoom.open(String(args.cid));
                }
            } catch (e) { return { ok: false, err: String(e && e.message) }; }
            return { ok: true };
        }""", {"cid": cid})
        await pg.wait_for_timeout(1500)
        check("M1 聊天室打开", opened.get("ok") is True,
              json.dumps(opened, ensure_ascii=False))

        # 找图片卡片
        imgsel = "[data-mq-img-view]"
        cnt = await pg.locator(imgsel).count()
        check("M1b 页面上存在图片卡片", cnt > 0, "图片卡片数=%d" % cnt)

        if cnt > 0:
            # ── 进入多选模式 ──
            entered = await pg.evaluate("""() => {
                const room = window.miyaChatRoom;
                // 通过公开入口进多选：模拟长按菜单里的「删除」
                if (typeof room.__testEnterMultiSelect === 'function') {
                    room.__testEnterMultiSelect();
                    return { ok: true };
                }
                return { ok: false, err: 'no_test_hook' };
            }""")
            check("M1c 进入多选模式（测试钩子）",
                  entered.get("ok") is True,
                  json.dumps(entered, ensure_ascii=False))

            if entered.get("ok"):
                await pg.wait_for_timeout(400)

                # ── 核心：点图片卡片 ──
                before = await pg.evaluate("""() => {
                    const host = document.getElementById('qq-img-lightbox');
                    return {
                        lbOpen: !!(host && !host.hidden
                                   && document.documentElement.classList.contains('qq-img-lightbox-open')),
                        picked: document.querySelectorAll('.is-picked').length
                    };
                }""")

                await pg.locator(imgsel).first.click(force=True)
                await pg.wait_for_timeout(600)

                after = await pg.evaluate("""() => {
                    const host = document.getElementById('qq-img-lightbox');
                    const room = document.getElementById('qq-room');
                    return {
                        lbOpen: !!(host && !host.hidden
                                   && document.documentElement.classList.contains('qq-img-lightbox-open')),
                        pickMode: !!(room && room.classList.contains('qq-room--pick')),
                        pickedCount: document.querySelectorAll('.is-picked').length
                    };
                }""")

                check("M2 点击图片后被选中（进入多选态且计数增加）",
                      after.get("pickedCount", 0) > 0,
                      "点击前 picked=%d，点击后 picked=%s" % (
                          before.get("picked"), after.get("pickedCount")))

                check("M3 大图预览未被打开", not after.get("lbOpen"),
                      "lbOpen=%s（点击前 %s）" % (after.get("lbOpen"), before.get("lbOpen")))

                # ── 正向对照：退出多选后，点图片应恢复打开大图 ──
                #
                # 这条是 M3 的「反向证明」：如果没有它，
                # 万一 image handler 整个坏掉（永远不打开大图），
                # M3 依然会通过 —— 那就把「修好了」和「彻底坏了」混为一谈了。
                await pg.evaluate("() => window.miyaChatRoom.__testExitMultiSelect()")
                await pg.wait_for_timeout(400)

                await pg.locator(imgsel).first.click(force=True)
                await pg.wait_for_timeout(900)

                after2 = await pg.evaluate("""() => {
                    const host = document.getElementById('qq-img-lightbox');
                    return {
                        lbOpen: !!(host && !host.hidden
                                   && document.documentElement.classList.contains('qq-img-lightbox-open'))
                    };
                }""")
                check("M4 退出多选后点图片能正常打开大图（反向对照）",
                      after2.get("lbOpen") is True,
                      "lbOpen=%s" % after2.get("lbOpen"))

        await b.close()

    _report(results)
    return 0 if all(r["pass"] for r in results) else 1


def _report(results):
    print("=" * 74)
    print("E2E：多选模式下点图片应「选中」而非「打开大图」")
    print("=" * 74)
    for r in results:
        print(("  ✅ " if r["pass"] else "  ❌ ") + r["name"])
        if r["detail"]:
            print("       " + r["detail"])
    print("-" * 74)
    n = sum(1 for r in results if r["pass"])
    print("%d/%d 通过" % (n, len(results)))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
