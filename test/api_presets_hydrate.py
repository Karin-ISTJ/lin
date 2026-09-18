#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 「对话 API 保存预设，返回再进来就没了」回归测试

缺陷现象
--------
在「对话 API → 接口预设」里点 ✓ 保存预设：

  1. toast 提示「预设已保存」
  2. 当前面板的下拉里确实出现了新预设
  3. 但**返回上一级、或切走再回到这个子视图，下拉又变空了**
  4. 整页刷新后同样是空的

用户感知就是「保存预设后发现没保存到」。数据其实一直好好躺在
IndexedDB / localStorage 里 —— 丢的是**渲染用的那份列表**。

根因
----
js2/miya-api-config.js 的 ensureApiPresetsReady() 返回的是一个
**只 resolve 一次**的 promise，它闭包里捕获的是「首次加载时的那个数组对象」。

    apiPresetsReady = loadApiPresetsArr().then(function (list) {
      if (!Array.isArray(apiPresetsCache)) apiPresetsCache = list.slice();
      return apiPresetsCache;          // ← 首次加载的对象，之后不再变
    });

而 upsert() 每次都是 `apiPresetsCache = list.slice()` —— **换了新对象**，
老 promise 仍然指向旧的（首次进入时为空的那个）数组。

于是这个顺序必然踩坑：
    先进面板（此时预设为空，promise 固化为 []）
    → 保存一条（apiPresetsCache 换成新的非空数组，promise 不变）
    → 返回再进来 → hydrateApiPresets 拿 ensureReady() 的返回值重绘
    → 拿到首轮的 []，把正确的下拉**覆盖成空**

同一个 bug 在这个模块里已经复发过三次，每次都是「拿 ensureReady()
的返回值当数据用」：
  1. upsert / remove（已修：改走 enqueueApiPresets 队列）
  2. find（已修：ensureReady().then 里重新读 apiPresetsCache）
  3. hydrateApiPresets（本次）

修法
----
数据层：ensureReady() 已就绪时 resolve 当前 apiPresetsCache，不再吐旧快照。
UI 层：hydrateApiPresets 显式再读一次 getCached()，双保险。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/api_presets_hydrate.py
"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


# 造一个真实联系人 + 会话，才能进到设置子视图
SETUP = """async () => {
    const cs = window.miyaContactsStore, st = window.miyaChatStore;
    await st.init(); await cs.whenReady();
    await cs.upsertGroup({id:'ct-default', name:'默认分组', enabled:true}).catch(()=>{});
    await cs.upsertCharacter({id:'c-test-1', name:'测试角色', persona:'t',
                              groupId:'ct-default', enabled:true}).catch(()=>{});
    const row = (cs.listCharacters()||[]).find(c => c.id === 'c-test-1');
    const contact = await st.addContactFromChronicle(row, 'ct-default');
    const chat = await st.createChat({contactId: contact.id});
    return chat.id;
}"""


class App:
    def __init__(self, pg, cid):
        self.pg, self.cid = pg, cid

    async def open_chat_app(self):
        pos = await self.pg.evaluate(
            """() => { const e = document.querySelector('[data-app="chat"]');
                 const r = e.getBoundingClientRect();
                 return {x: r.x + r.width/2, y: r.y + r.height/2}; }""")
        await self.pg.mouse.click(pos["x"], pos["y"])
        await self.pg.wait_for_timeout(2000)

    async def open_panel(self):
        await self.pg.evaluate(
            f"() => window.miyaChatContactSettings.openSubViewForChat({self.cid!r}, 'api-chat')")
        await self.pg.wait_for_timeout(1600)

    async def go_back(self):
        """按子视图的返回键回到列表页（真实交互，触发整块重绘）"""
        await self.pg.evaluate(
            "() => { const b = document.querySelector('#mq-set-page [data-mq-set-back]');"
            " if (b) b.click(); }")
        await self.pg.wait_for_timeout(800)

    async def options(self):
        return await self.pg.evaluate(
            "() => { const p = document.getElementById('mq-api-preset-pick');"
            " return p ? Array.from(p.options).map(o => o.value) : null; }")

    async def fill(self, base="", key="", model=None, name=""):
        await self.pg.evaluate(
            """(f) => { const s = (i, v) => { const e = document.getElementById(i);
                   if (e) e.value = v; };
                 s('mq-api-base', f.base); s('mq-api-key', f.key);
                 s('mq-api-preset-name', f.name); }""",
            {"base": base, "key": key, "name": name})

    async def save(self):
        await self.pg.click("#mq-api-preset-save")
        await self.pg.wait_for_timeout(900)

    async def stored(self):
        return await self.pg.evaluate(
            "async () => { const m = window.miyaApiPresets;"
            " return (await m.load()).map(x => x.name); }")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport=VIEWPORT, is_mobile=True, has_touch=True, user_agent=UA)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))

        try:
            await pg.goto(BASE, wait_until="load")
            await pg.wait_for_timeout(3500)
            cid = await pg.evaluate(SETUP)
            app = App(pg, cid)
            await app.open_chat_app()

            # ── 1. 核心场景：先开面板（预设为空）→ 保存 → 返回 → 重进 ──
            print("\n【1】空面板保存后，返回再进来不能丢（核心复现路径）")
            await app.open_panel()
            o0 = await app.options()
            check("首次进面板，下拉为空", o0 == [""], str(o0))

            await app.fill(base="https://api.one.example", key="sk-one", name="线路一")
            await app.save()
            o1 = await app.options()
            check("保存后当前面板下拉立即可见", "线路一" in o1, str(o1))

            await app.go_back()
            await app.open_panel()
            o2 = await app.options()
            check("返回后重进，预设仍在（曾经的失败点）", "线路一" in o2, str(o2))

            # ── 2. 连存多条，一条都不能被冲掉 ──
            print("\n【2】连续保存多条互不覆盖")
            for n in ["线路二", "线路三", "线路四"]:
                await app.fill(base=f"https://api.{n}.example", key="sk-" + n, name=n)
                await app.save()
            await app.go_back()
            await app.open_panel()
            o3 = await app.options()
            want = ["线路一", "线路二", "线路三", "线路四"]
            check("四条预设全部保留", all(n in o3 for n in want), str(o3))

            # ── 3. 真正落盘（整页刷新）──
            print("\n【3】整页刷新后仍然在（确认是持久化而非内存）")
            await pg.reload(wait_until="load")
            await pg.wait_for_timeout(3500)
            await app.open_chat_app()
            await app.open_panel()
            o4 = await app.options()
            check("刷新后四条预设俱在", all(n in o4 for n in want), str(o4))

            # ── 4. 选中即载入，表单被正确回填 ──
            print("\n【4】从下拉选中预设，表单回填正确")
            await pg.select_option("#mq-api-preset-pick", "线路三")
            await pg.wait_for_timeout(1100)
            f = await pg.evaluate(
                "() => ({base: document.getElementById('mq-api-base').value,"
                " key: document.getElementById('mq-api-key').value,"
                " name: document.getElementById('mq-api-preset-name').value})")
            check("网关回填正确", f["base"] == "https://api.线路三.example", str(f["base"]))
            check("密钥回填正确", f["key"] == "sk-线路三", str(f["key"]))
            check("名称框同步", f["name"] == "线路三", str(f["name"]))

            # ── 5. 删除后返回重进不得复活 ──
            print("\n【5】删除预设，返回重进后不得复活")
            await pg.select_option("#mq-api-preset-pick", "线路二")
            await pg.wait_for_timeout(600)
            await pg.click("#mq-api-preset-delete")
            await pg.wait_for_timeout(900)
            await app.go_back()
            await app.open_panel()
            o5 = await app.options()
            check("已删除的不再出现", "线路二" not in o5, str(o5))
            check("其余预设不受影响", all(n in o5 for n in ["线路一", "线路三", "线路四"]), str(o5))

            # ── 6. 同名覆盖，不产生重复项 ──
            print("\n【6】同名保存走覆盖，不重复")
            await app.fill(base="https://api.one2.example", key="sk-one2", name="线路一")
            await app.save()
            o6 = await app.options()
            check("同名只有一项", o6.count("线路一") == 1, str(o6))

            await app.go_back()
            await app.open_panel()
            o6b = await app.options()
            check("覆盖后返回重进仍只有一项", o6b.count("线路一") == 1, str(o6b))
            stored = await app.stored()
            check("落盘列表与下拉一致", sorted(stored) == sorted([x for x in o6b if x]),
                  f"stored={stored} pick={o6b}")

            # ── 7. 全程无 JS 报错 ──
            print("\n【7】全程无 JS 报错")
            check("无 pageerror", not errs, str(errs[:3]))

        finally:
            await b.close()

    print("\n" + "═" * 58)
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        print("失败项：")
        for f in failed:
            print("  ·", f)
    print("═" * 58)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
