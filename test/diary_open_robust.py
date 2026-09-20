#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 日记 App 打开健壮性回归测试

背景（用户报的）：
  「日记功能的界面乱了…一点日记功能 进去就是一张很大的照片…铺满整屏、
    不知道点哪里、感觉照片有点糊。把桌面小组件的照片删掉才能恢复。」
  复现一次后就再也复现不出来了 —— 典型的**时序 / 中间态**故障。

查到的真实缺陷（本测试锁定的对象）：

  ★ 缺陷 A —— openDiaryApp 的异步链没有 catch
    js2/miya-diary-app.js 里整段「放行界面」的代码被包在
        chain = Promise.resolve()
          .then(cs.init)
          .then(cts.whenReady)
          .then(放行…)
    的**末尾 then** 里，但**没有 .catch()**。
    只要 chain 上任一环 reject（contacts store 初始化失败、IDB 打不开…），
    末尾 then 整体不执行：
        · el.removeAttribute('hidden') 不执行
        · el.classList.add('is-open')  不执行
        · body.classList.add('miya-app-open') 不执行
    结果是**点了日记什么也不发生**，且异常被 Promise 链吞掉，
    控制台只有一条 unhandled rejection。用户看到的就是「点了没反应」。

  ★ 缺陷 B —— 失败路径下 diary-app 停在「半开」状态
    resetOverlayApps()（js1/app.js 顶部）只在启动时把非 is-open 的 App
    补上 hidden。运行期一旦出现「hidden 被摘掉、is-open 没加上」，
    这个 App 就会永久盖在桌面上且**不可点**（它 z-index 529 > 桌面 5/6，
    而它自己没有 is-open，display 仍是 block）——
    这正是「铺满整屏 + 不知道点哪里」的成因。

  ★ 缺陷 C —— 不变量：hidden 与 is-open 必须同生同死
    这两个属性是同一件事的两个表示。任何一处只改其一，
    就会造出「可见但不可关」或「隐藏但仍在挡」的中间态。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/diary_open_robust.py
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [ok]   {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}   {detail}")


async def new_page(browser):
    ctx = await browser.new_context(viewport=VIEWPORT, user_agent=UA)
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: print(f"    [pageerror] {str(e)[:140]}"))
    return ctx, pg


async def seed(pg):
    await pg.evaluate("""async () => {
      const now = Date.now();
      await window.miyaWriteLsJsonKey('miya-chat-meta', {
        version: 2,
        contacts: [
          {id:'c1', name:'林晚', groupId:'ct-default', avatarText:'晚', avatarColor:'#c9a227'},
          {id:'c2', name:'苏叶', groupId:'ct-default', avatarText:'叶', avatarColor:'#7a9e7e'}
        ],
        chats: [],
        groups: [{id:'ct-default', name:'默认分组'}]
      });
      await window.miyaWriteLsJsonKey('miya-diary-v1', {
        diaries: {'c1':[
          {id:'d1', dateIso:'2026-09-19', title:'雨天', mood:'soft',
           content:'今天下了雨。\\n\\n我在窗边坐了很久。', createdAt:now, wordCount:24}
        ]},
        userDiaries: {}, settings: {}
      });
    }""")


STATE_JS = """() => {
  const app = document.getElementById('miya-diary-app');
  if (!app) return {missing: true};
  return {
    hasHidden: app.hasAttribute('hidden'),
    isOpen: app.classList.contains('is-open'),
    bodyAppOpen: document.body.classList.contains('miya-app-open'),
    disp: getComputedStyle(app).display,
    z: getComputedStyle(app).zIndex,
  };
}"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])

        # ══════════ 1. 正常路径：开 → 关，不变量成立 ══════════
        print("\n[1] 正常路径")
        ctx, pg = await new_page(b)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)
        await seed(pg)
        await pg.reload(wait_until="load")
        await pg.wait_for_timeout(5000)

        await pg.evaluate("() => window.miyaDiaryApp && window.miyaDiaryApp.open()")
        await pg.wait_for_timeout(1500)
        s = await pg.evaluate(STATE_JS)
        check("打开后 hidden 已摘", s["hasHidden"] is False, str(s))
        check("打开后 is-open 已加", s["isOpen"] is True, str(s))
        check("打开后 body.miya-app-open 已加", s["bodyAppOpen"] is True, str(s))

        await pg.evaluate("() => window.miyaDiaryApp.close()")
        await pg.wait_for_timeout(700)
        s = await pg.evaluate(STATE_JS)
        check("关闭后 hidden 已加", s["hasHidden"] is True, str(s))
        check("关闭后 is-open 已摘", s["isOpen"] is False, str(s))
        check("关闭后 body.miya-app-open 已摘", s["bodyAppOpen"] is False, str(s))
        await ctx.close()

        # ══════════ 2. 缺陷 A：异步链 reject 时必须降级打开，不能半开 ══════════
        print("\n[2] 异步链 reject（缺陷 A：半开 / 静默失败）")
        for label, patch in [
            ("chatStore.init reject",
             "() => { window.__oi = window.miyaChatStore.init;"
             " window.miyaChatStore.init = () => Promise.reject(new Error('boom-init')); }"),
            ("contactsStore.whenReady reject",
             "() => { window.__ow = window.miyaContactsStore.whenReady;"
             " window.miyaContactsStore.whenReady = () => Promise.reject(new Error('boom-wr')); }"),
        ]:
            ctx, pg = await new_page(b)
            await pg.goto(BASE, wait_until="load")
            await pg.wait_for_timeout(4000)
            await pg.evaluate(patch)
            await pg.evaluate("() => window.miyaDiaryApp && window.miyaDiaryApp.open()")
            await pg.wait_for_timeout(2000)
            s = await pg.evaluate(STATE_JS)

            # ① 绝不能停在「可见但没 is-open」的中间态 —— 那正是
            #    「铺满整屏、点不动」的成因。
            broken_middle = (not s["hasHidden"]) and (not s["isOpen"])
            check(f"{label} · 不停在可见未就绪的中间态",
                  not broken_middle,
                  f"hidden={s['hasHidden']} is-open={s['isOpen']} disp={s['disp']}")

            # ② 必须**降级打开**：日记本体只依赖 diaryStore 缓存，
            #    联系人取不到也应显示空态，而不是「点了没反应」。
            check(f"{label} · 降级模式下仍正常打开",
                  s["hasHidden"] is False and s["isOpen"] is True
                  and s["disp"] == "flex",
                  str(s))

            # ③ 降级打开后，界面里的关键骨架必须还在（不是空壳）
            skel = await pg.evaluate(
                """() => {
                  const app = document.getElementById('miya-diary-app');
                  return {
                    mast: !!app.querySelector('.dy-mast'),
                    dock: !!app.querySelector('.dy-dock'),
                    stage: !!app.querySelector('#dy-stage-char'),
                  };
                }"""
            )
            check(f"{label} · 降级模式骨架完整",
                  all(skel.values()), str(skel))

            # ④ 降级打开后仍可正常关闭（不能卡死）
            await pg.evaluate("() => window.miyaDiaryApp.close()")
            await pg.wait_for_timeout(700)
            s2 = await pg.evaluate(STATE_JS)
            check(f"{label} · 降级模式仍可关闭",
                  s2["hasHidden"] is True and s2["isOpen"] is False,
                  str(s2))
            await ctx.close()

        # ══════════ 3. 缺陷 B：中间态下 diary-app 不得盖住桌面 ══════════
        print("\n[3] 中间态遮罩（缺陷 B）")
        ctx, pg = await new_page(b)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)
        # 人为造出「hidden 摘掉、is-open 没加」的坏状态，看它是否可点
        probe = await pg.evaluate(
            """() => {
              const app = document.getElementById('miya-diary-app');
              app.removeAttribute('hidden');
              app.classList.remove('is-open');
              const cs = getComputedStyle(app);
              // 该状态下，屏幕中心命中的是谁？
              const hit = document.elementFromPoint(206, 457);
              return {
                disp: cs.display, z: cs.zIndex, pe: cs.pointerEvents,
                hitId: hit ? (hit.id || hit.className) : null,
                hitInsideDiary: !!(hit && app.contains(hit)),
              };
            }"""
        )
        # 这块 App 只要 display 不是 none 且 z-index 高，就会挡住桌面
        blocks = (probe["disp"] != "none" and int(probe["z"] or 0) > 100)
        check("半开态不应遮挡桌面（应被 display:none 兜住）",
              not blocks,
              f"disp={probe['disp']} z={probe['z']} hit={probe['hitId']}")
        await ctx.close()

        # ══════════ 4. 缺陷 C：不变量 —— hidden 与 is-open 同生同死 ══════════
        print("\n[4] 不变量：hidden 与 is-open 互斥且完备")
        ctx, pg = await new_page(b)
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4000)
        await seed(pg)
        await pg.reload(wait_until="load")
        await pg.wait_for_timeout(5000)

        seq = []
        for _ in range(3):
            await pg.evaluate("() => window.miyaDiaryApp.open()")
            await pg.wait_for_timeout(900)
            seq.append(await pg.evaluate(STATE_JS))
            await pg.evaluate("() => window.miyaDiaryApp.close()")
            await pg.wait_for_timeout(700)
            seq.append(await pg.evaluate(STATE_JS))

        bad = [s for s in seq
               if (s["hasHidden"] and s["isOpen"]) or ((not s["hasHidden"]) and (not s["isOpen"]))]
        check("反复开关 3 轮 · 每个采样点都满足 hidden XOR is-open",
              len(bad) == 0,
              f"坏样本 {len(bad)}/{len(seq)}: {bad[:2]}")
        await ctx.close()

        # ══════════ 5. 同类缺陷：其它全屏 App 的「异步链无 catch」 ══════════
        print("\n[5] 同类缺陷：其它全屏 App")
        # 三个 App 共用同一个反模式：openXApp() 把「放行界面」写进
        # .then() 尾部却没有 .catch()。上游 reject 时界面永远放不出来。
        APPS = [
            ("miya-itinerary-app", "miyaItineraryApp", "miya-chat-app", "itinerary"),
            ("miya-memory-app", "miyaMemoryApp", "miya-chat-store", "memory"),
        ]
        for css_id, api, _, label in APPS:
            ctx, pg = await new_page(b)
            await pg.goto(BASE, wait_until="load")
            await pg.wait_for_timeout(4500)

            has_api = await pg.evaluate(f"() => !!(window.{api} && window.{api}.open)")
            check(f"{label} · 打开入口存在", has_api, f"window.{api}")

            if has_api:
                # 让异步链 reject，验证不会「点了没反应」
                await pg.evaluate(
                    """() => {
                      if (window.miyaContactsStore) {
                        window.__ow = window.miyaContactsStore.whenReady;
                        window.miyaContactsStore.whenReady =
                          () => Promise.reject(new Error('boom-wr'));
                      }
                      if (window.miyaChatStore && window.miyaChatStore.init) {
                        window.__oi = window.miyaChatStore.init;
                        window.miyaChatStore.init = () => Promise.reject(new Error('boom-init'));
                      }
                    }"""
                )
                await pg.evaluate(f"() => window.{api}.open()")
                await pg.wait_for_timeout(2200)
                st = await pg.evaluate(
                    f"""() => {{
                      const el = document.getElementById('{css_id}');
                      return {{
                        hasHidden: el.hasAttribute('hidden'),
                        isOpen: el.classList.contains('is-open'),
                        disp: getComputedStyle(el).display,
                        z: getComputedStyle(el).zIndex,
                      }};
                    }}"""
                )
                # 核心：不能停在「可见但没 is-open」（盖住整屏、点不动）
                broken = (not st["hasHidden"]) and (not st["isOpen"]) \
                    and st["disp"] != "none"
                check(f"{label} · 不停在可见未就绪的中间态",
                      not broken,
                      f"hidden={st['hasHidden']} is-open={st['isOpen']} disp={st['disp']}")
                check(f"{label} · 降级模式下仍可打开",
                      st["hasHidden"] is False and st["isOpen"] is True,
                      str(st))
            await ctx.close()

        await b.close()

    print(f"\n=== 结果: {PASS} 通过 / {FAIL} 失败 ===")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
