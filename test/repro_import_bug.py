#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
复现「导入 ST 分支聊天 → 提示格式不正确 → 却留下一个点不进去的记录」。

跑法：
    python3 -m http.server 8099     # 项目根目录
    python3 test/repro_import_bug.py

核心观察点：
  1. importSession 只校验 messages 是不是数组，空数组照样建会话（空壳）。
  2. 空壳会话 getSessions() 过滤掉 → 列表里本该看不见，
     但 importSession 里 activeSessionId 已被指向它 → 点进去命中
     storyHasContent()=false → 落到「选择开场白」页 → 用户体感「点不进去」。
  3. 报错信息一律是「文件格式不正确」，无差化，用户无法自救。
"""
import asyncio, json, sys, time
from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"
UA = ("Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
VIEWPORT = {"width": 412, "height": 915}

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def goto(pg, wait=3400):
    await pg.goto(BASE, wait_until="load")
    await pg.wait_for_timeout(wait)


async def goto_fresh(pg, ctx, wait=4200):
    """
    导航到页面，保证加载的是磁盘上的当前代码。

    两个陷阱，都要绕：
      ① sw.js 把 js1/miya-appointment-app.js 收进 precache ——
         「改完代码直接 reload」会静默地跑旧版；
      ② index.html 里 script 的 ?v=148 是固定版本号，
         浏览器据此走 HTTP 磁盘缓存，即使没有 SW 也拿旧文件。

    处理方式：
      · context 层面 service_workers='block' 解决 ①；
      · 用 query 参数把 URL 变掉（唯一化）解决 ② ——
        这比加 no-cache 头可靠，因为它直接让缓存 key 不命中。
    调用前必须已把 ctx 建好，pg 用 ctx.new_page() 现开。
    """
    pg = await ctx.new_page()
    await pg.goto(f"{BASE}?t={int(time.time() * 1000)}", wait_until="load")
    await pg.wait_for_timeout(wait)
    return pg


# 在页面里注入一个可直接调用的 import 探针。
# 之所以不真跑 <input type=file>：filechooser 只能给真实文件，
# 我们需要的是一串可控文本 → 走与 UI 完全相同的解析 + store 路径。
PROBE = r"""
/*
 * 探针里的 api / store 一律「用的时候现取」，不在 __mkProbe() 里闭包捕获。
 *
 * 原因：页面是懒启动的，脚本虽已解析完，但 miyaOfflineApp 里的东西
 * （以及 store 的 hydrate）是随后才就位的。早先把它们捕获进闭包，
 * 拿到的就是 undefined / 半成品，测试会报「__testRunImport is not a function」
 * 这种看起来像产品 bug、实际是测试自身时序问题的假失败。
 */
window.__mkProbe = function () {
  function api() { return window.miyaOfflineApp; }
  function store() { return window.MiyaAppointmentStore; }
  return {
    /* 直接测 store.importSession 对空 messages 的态度 */
    tryImportEmpty: function (chatId) {
      var st = store();
      var before = st.getSessions(chatId).length;
      var sess = st.importSession(chatId, { session: { title: '空壳探针' }, messages: [] });
      var after = st.getSessions(chatId).length;
      var raw = st.getSession(chatId, sess && sess.id);
      return {
        returned: !!sess,
        sessId: sess && sess.id,
        listBefore: before,
        listAfter: after,
        rawExists: !!raw,
        rawMsgCount: raw ? (raw.messages || []).length : -1,
        activeIdMatches: !!(sess && (function () {
          try { return st.getActiveSessionId(chatId) === sess.id; } catch (e) { return false; }
        })())
      };
    },
    /* 用真实 ST jsonl 文本走解析器（详细版，带失败原因） */
    parseSt: function (text) {
      var out = { ok: false, title: '', n: 0, reason: '' };
      var A = api();
      try {
        var d = A && A.__testParseStJsonlDetailed ? A.__testParseStJsonlDetailed(text) : null;
        if (d) {
          out.ok = !!d.ok;
          out.title = d.title || '';
          out.n = (d.messages || []).length;
          out.reason = d.reason || '';
        } else { out.reason = 'no detailed parse api'; }
      } catch (e) { out.reason = String(e && e.message || e); }
      return out;
    },
    /* 走完整导入路径（含 UI 反馈）：把文本塞进 FileReader 那一段的等价逻辑 */
    importText: async function (chatId, text, fileName) {
      var res = { toast: '', sessId: '', view: '', storyHasContent: null,
                  listCount: 0, fellToOpeningPicker: false, threw: '' };
      try {
        var A = api();
        A.__testRunImport(chatId, text, fileName);
      } catch (e) { res.threw = String(e && e.message || e); }
      /*
       * toast 是异步淡入的（有自己的显示定时器），同步读会读到上一句。
       * 这里等一拍再读，否则会把「成功提示晚一帧出现」误判成「没有提示」。
       */
      await new Promise(function (r) { setTimeout(r, 260); });
      var toastEl = document.getElementById('xw-toast');
      res.toast = toastEl ? String(toastEl.textContent || '').trim() : '';
      var ui = (api() && api().__testUi) ? api().__testUi() : null;
      if (ui) {
        res.sessId = ui.sessionId || '';
        res.view = ui.view || '';
        try { res.storyHasContent = api().__testStoryHasContent(); } catch (e2) {}
      }
      try {
        var st = store();
        res.listCount = st.getSessions(chatId).length;
        var root = document.getElementById('xw-root');
        res.fellToOpeningPicker = !!(root && root.querySelector('.xw-opening-pick'));
      } catch (e3) {}
      return res;
    },
    /*
     * 定向注入：让 render 阶段抛错，验证「写入之后」的异常会被回滚。
     *
     * 为什么要专测这一条：导入的失败提示与「记录是否真的落库」
     * 必须是互斥的 —— 要么成功且留记录，要么失败且不留痕迹。
     * 早先 importSession 写库之后、render 之前没有任何回滚，
     * 渲染一抛错就会出现「告诉用户失败、列表里却多一条」的假失败。
     *
     * 注入手段：临时替换 store.getSessionMessages 让它抛错。
     * 该函数处于 importSession 之后、render 内部，正是要覆盖的窗口。
     */
    injectRenderFailure: async function (chatId, text, fileName) {
      var st = store();
      var res = { leaked: null, escaped: '', toast: '', sessIdAfter: '', listDelta: -1 };
      var before = st.getSessions(chatId).map(function (s) { return s.id; });
      var orig = st.getSessionMessages;
      var bomb = false;
      st.getSessionMessages = function () {
        if (bomb) throw new Error('BOOM-render-failure');
        return orig.apply(st, arguments);
      };
      try {
        bomb = true;
        api().__testRunImport(chatId, text, fileName || 'min.jsonl');
      } catch (e) {
        /*
         * 修复到位的话，异常应当在 runImportText 内部就被消化掉，
         * 不该冒到这里 —— 所以这里捕获到反而是「未修复」的信号。
         */
        res.escaped = String(e && e.message || e);
      } finally {
        bomb = false;
        st.getSessionMessages = orig;
      }
      await new Promise(function (r) { setTimeout(r, 300); });
      var toastEl = document.getElementById('xw-toast');
      res.toast = toastEl ? String(toastEl.textContent || '').trim() : '';
      var after = st.getSessions(chatId).map(function (s) { return s.id; });
      var added = after.filter(function (id) { return before.indexOf(id) < 0; });
      res.leaked = added.length > 0;
      res.listDelta = added.length;
      var ui = api().__testUi ? api().__testUi() : null;
      res.sessIdAfter = ui ? (ui.sessionId || '') : '';
      return res;
    }
  };
};
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport=VIEWPORT,
            user_agent=UA,
            # 关键：停用 SW，保证加载的是磁盘上的当前代码（见 goto_fresh）
            service_workers="block",
        )
        errs = []

        # 先绕 SW 与 HTTP 缓存（见 goto_fresh 说明），再挂错误监听，
        # 免得把加载阶段的无关噪声混进真正的页面异常里。
        pg = await goto_fresh(None, ctx)
        pg.on("pageerror", lambda e: errs.append(str(e)))

        # 断言跑的是当前磁盘上的代码，避免「测了缓存里的旧版」。
        # 注意：页面是懒启动的，hook 可能晚一拍才挂上 —— 这里轮询等它出现，
        # 而不是取一次就断言（取一次会出现「代码没问题却报旧版」的假失败）。
        _stamp = None
        for _ in range(30):
            _stamp = await pg.evaluate(r"""
            () => {
              var a = window.miyaOfflineApp || {};
              return {
                hasDetailed: typeof a.__testParseStJsonlDetailed === 'function',
                hasRunImport: typeof a.__testRunImport === 'function'
              };
            }""")
            if _stamp.get("hasDetailed") and _stamp.get("hasRunImport"):
                break
            await pg.wait_for_timeout(300)
        check("页面加载的是含修复的当前代码（非 SW/HTTP 缓存旧版）",
              _stamp["hasDetailed"] and _stamp["hasRunImport"], str(_stamp))

        await pg.evaluate(PROBE)
        ok_probe = await pg.evaluate("!!window.miyaOfflineApp && !!window.MiyaAppointmentStore")
        check("线下模块与 store 均已加载", ok_probe)
        if not ok_probe:
            print("  模块未加载，后续无法继续"); await browser.close(); return

        # ── 准备一个带内容的聊天，供导入挂靠 ──
        # 走 chatStore 自己的异步 API：先造角色（编年史行），再建私聊。
        setup = await pg.evaluate(r"""
        async () => {
          var st = window.miyaChatStore;
          if (!st) return { ok:false, why:'no chatStore' };
          try {
            var c = await st.addContactFromChronicle(
              { id:'chron-import-test', name:'导入测试', persona:'' }, 'ct-default', '');
            if (!c) return { ok:false, why:'addContactFromChronicle 返回空' };
            var chat = await st.createChat({ contactId: c.id });
            if (!chat) return { ok:false, why:'createChat 返回空' };
            return { ok:true, contactId:c.id, chatId:chat.id };
          } catch (e) { return { ok:false, why:String(e && e.message || e) }; }
        }
        """)
        check("准备好测试聊天", setup.get("ok"), str(setup))
        if not setup.get("ok"):
            await browser.close(); return
        chat_id = setup["chatId"]
        print(f"      chatId = {chat_id}")

        # ══════ 用例 1：空 messages 能否落库 ══════
        print("\n【用例 1】importSession 收到空 messages 时应当拒绝")
        r1 = await pg.evaluate("(cid) => window.__mkProbe().tryImportEmpty(cid)", chat_id)
        print(f"      {json.dumps(r1, ensure_ascii=False)}")
        check("空 messages 不应建出会话", not r1["returned"],
              f"returned={r1['returned']} rawMsgCount={r1['rawMsgCount']}")
        check("空会话不应被设为 active（否则点进去无内容）",
              not r1["activeIdMatches"],
              f"activeSessionId 指向了空壳={r1['activeIdMatches']}")

        # ══════ 用例 2：真实 ST jsonl（正常分支文件）能被解析 ══════
        print("\n【用例 2】标准 ST jsonl（含 chat_metadata + sheets）应解析成功")
        meta = {"chat_metadata": {"integrity": "abc123",
                                  "sheets": [{"name": "记忆表", "rows": []}]},
                "user_name": "我", "character_name": "闻述"}
        rows = [
            meta,
            {"name": "闻述", "is_user": False, "is_system": False, "send_date": "2026-09-01T10:00:00Z",
             "mes": "第一楼正文。", "swipes": ["第一楼正文。", "第一楼正文候选二。"],
             "extra": {"branch": 1}},
            {"name": "我", "is_user": True, "is_system": False, "send_date": "2026-09-01T10:01:00Z",
             "mes": "第二楼我说的话。"},
            {"name": "闻述", "is_user": False, "is_system": False, "send_date": "2026-09-01T10:02:00Z",
             "mes": "<thinking>想了想</thinking>第三楼正文。"},
        ]
        jsonl = "\n".join(json.dumps(x, ensure_ascii=False) for x in rows)
        r2 = await pg.evaluate("(t) => window.__mkProbe().parseSt(t)", jsonl)
        print(f"      {json.dumps(r2, ensure_ascii=False)}")
        check("标准 ST jsonl 解析出消息", r2["ok"] and r2["n"] >= 3,
              f"ok={r2['ok']} n={r2['n']} reason={r2['reason']}")
        check("标题取自 character_name", r2["title"] == "闻述", f"title={r2['title']!r}")

        # ══════ 用例 3：只有 1 条消息的分支文件（容易被裁） ══════
        print("\n【用例 3】只有「元信息 + 1 条消息」的分支文件")
        short = "\n".join([
            json.dumps(meta, ensure_ascii=False),
            json.dumps({"name": "闻述", "is_user": False, "mes": "只剩一楼。",
                        "send_date": "2026-09-01T10:00:00Z"}, ensure_ascii=False),
        ])
        r3 = await pg.evaluate("(t) => window.__mkProbe().parseSt(t)", short)
        print(f"      {json.dumps(r3, ensure_ascii=False)}")
        check("元信息+1条消息也应被认出（不是『格式不正确』）",
              r3["ok"] and r3["n"] >= 1, f"ok={r3['ok']} n={r3['n']}")

        # ══════ 用例 4：元信息行不在第一行 ══════
        print("\n【用例 4】元信息行被挪到后面（非首行）")
        shuffled = "\n".join([
            json.dumps(rows[1], ensure_ascii=False),
            json.dumps(meta, ensure_ascii=False),
            json.dumps(rows[2], ensure_ascii=False),
        ])
        r4 = await pg.evaluate("(t) => window.__mkProbe().parseSt(t)", shuffled)
        print(f"      {json.dumps(r4, ensure_ascii=False)}")
        check("元信息非首行也应解析成功", r4["ok"] and r4["n"] >= 2,
              f"ok={r4['ok']} n={r4['n']}")

        # ══════ 用例 5：真正的非 jsonl 文本，报错是否有信息量 ══════
        print("\n【用例 5】非 jsonl 文本的报错信息应当可区分")
        r5 = await pg.evaluate("(t) => window.__mkProbe().parseSt(t)", "这不是 jsonl，只是一段普通文本。")
        print(f"      {json.dumps(r5, ensure_ascii=False)}")
        check("非 jsonl 文本应被识别为非 ST 格式", r5["ok"] is False)

        # ══════ 用例 6：空文件 ══════
        print("\n【用例 6】空文件")
        r6 = await pg.evaluate("(t) => window.__mkProbe().parseSt(t)", "   \n  \n")
        print(f"      {json.dumps(r6, ensure_ascii=False)}")
        check("空文件应被识别为非 ST 格式", r6["ok"] is False)

        # ══════ 用例 7：完整导入链路（解析 → 入库 → 渲染） ══════
        print("\n【用例 7】完整导入链路：真的把楼层摆上屏")
        before = await pg.evaluate("(c) => window.MiyaAppointmentStore.getSessions(c).length", chat_id)
        r7 = await pg.evaluate(
            "async (a) => await window.__mkProbe().importText(a.cid, a.text, a.name)",
            {"cid": chat_id, "text": jsonl, "name": "闻述 - 2026-09-01@10h00m00s Branch #1.jsonl"})
        print(f"      {json.dumps(r7, ensure_ascii=False)}")
        check("导入后列表里确实多了一卷",
              r7["listCount"] > before, f"before={before} after={r7['listCount']}")
        check("导入后停在正片视图", r7["view"] == "story", f"view={r7['view']!r}")
        check("导入后场景有内容（不会落回选择开场白）",
              r7["storyHasContent"] is True and not r7["fellToOpeningPicker"],
              f"hasContent={r7['storyHasContent']} 落回开场白={r7['fellToOpeningPicker']}")
        check("toast 报告了导入条数", "已导入" in (r7["toast"] or ""), f"toast={r7['toast']!r}")

        # ══════ 用例 8：导入后点进去真的能打开 ══════
        print("\n【用例 8】导入后从列表点开，不该是空白/开场白页")
        open_res = await pg.evaluate(r"""
        async (cid) => {
          var st = window.MiyaAppointmentStore;
          var api = window.miyaOfflineApp;
          var sess = st.getSessions(cid)[0];
          if (!sess) return { ok:false, why:'列表是空的' };
          /* 模拟点卷宗那一行：与 data-ap-view-session 的处理同一函数 */
          window.miyaOfflineApp.rerender();
          await new Promise(function (r) { setTimeout(r, 320); });
          var root = document.getElementById('xw-root');
          return {
            ok: true,
            title: sess.title,
            msgCount: (sess.messages || []).length,
            liveCount: st.countLiveMessages(sess),
            floors: root ? root.querySelectorAll('.xw-floor').length : -1,
            fellToOpeningPicker: !!(root && root.querySelector('.xw-opening-pick')),
            emptyHint: !!(root && root.querySelector('.xw-empty'))
          };
        }
        """, chat_id)
        print(f"      {json.dumps(open_res, ensure_ascii=False)}")
        check("导入的那一卷有活着的楼层", open_res.get("liveCount", 0) > 0, str(open_res))
        check("屏上确实渲染出楼层（不是空白页）",
              open_res.get("floors", 0) > 0, f"floors={open_res.get('floors')}")
        check("没有落回「选择开场白」页",
              not open_res.get("fellToOpeningPicker"), str(open_res))

        # ══════ 用例 9：非 jsonl 不应再留下垃圾会话 ══════
        print("\n【用例 9】导入非 jsonl 文本：报错之外不得留下记录")
        before9 = await pg.evaluate("(c) => window.MiyaAppointmentStore.getSessions(c).length", chat_id)
        r9 = await pg.evaluate(
            "async (a) => await window.__mkProbe().importText(a.cid, a.text, a.name)",
            {"cid": chat_id, "text": "这是一段完全不是聊天的文字。\n第二行也是。",
             "name": "随便一个文件.txt"})
        print(f"      {json.dumps(r9, ensure_ascii=False)}")
        after9 = await pg.evaluate("(c) => window.MiyaAppointmentStore.getSessions(c).length", chat_id)
        check("非 jsonl 导入失败后，列表数量不变（没留垃圾）",
              after9 == before9, f"before={before9} after={after9}")
        check("报错话术说明了「不是 ST 格式」而不是笼统的格式不正确",
              "SillyTavern" in (r9["toast"] or "") or "jsonl" in (r9["toast"] or "").lower(),
              f"toast={r9['toast']!r}")

        # ══════ 用例 10：各失败原因的话术必须互不相同 ══════
        print("\n【用例 10】三种失败的报错话术必须可区分")
        msgs = {}
        for label, txt, nm in [
            ("空文件", "   \n\n  ", "empty.jsonl"),
            ("非格式", "just some prose, not json at all", "prose.txt"),
        ]:
            rr = await pg.evaluate("async (a) => await window.__mkProbe().importText(a.cid, a.text, a.name)",
                                   {"cid": chat_id, "text": txt, "name": nm})
            msgs[label] = rr["toast"]
            print(f"      {label}: {rr['toast']!r}")
        all_distinct = len(set(msgs.values())) == len(msgs) and all(msgs.values())
        check("不同失败原因给出不同话术", all_distinct, json.dumps(msgs, ensure_ascii=False))
        check("空文件话术点明「文件是空的」",
              "空" in (msgs.get("空文件") or ""), f"{msgs.get('空文件')!r}")

        # ══════ 用例 11：写入之后渲染抛错 → 必须整体回滚，不留脏记录 ══════
        print("\n【用例 11】写入之后 render 抛错：不得留下脏记录")
        jsonl11 = "\n".join([
            json.dumps({"user_name": "User", "character_name": "Karin",
                        "chat_metadata": {"integrity": "x"}}, ensure_ascii=False),
            json.dumps({"name": "Karin", "is_user": False, "send_date": "2025-01-01T00:00:01.000Z",
                        "mes": "第一层。", "swipes": ["第一层。"]}, ensure_ascii=False),
            json.dumps({"name": "User", "is_user": True, "send_date": "2025-01-01T00:00:02.000Z",
                        "mes": "第二层。", "swipes": ["第二层。"]}, ensure_ascii=False),
        ]) + "\n"
        # 先记下导入前的 ui 立场与列表，回滚后要与它逐字一致
        ui_before11 = await pg.evaluate("() => window.miyaOfflineApp.__testUi()")
        list_before11 = await pg.evaluate(
            "(c) => window.MiyaAppointmentStore.getSessions(c).map(function (s) { return s.id; })",
            chat_id)
        r11 = await pg.evaluate(
            "async (a) => await window.__mkProbe().injectRenderFailure(a.cid, a.text, a.name)",
            {"cid": chat_id, "text": jsonl11, "name": "min.jsonl"})
        print(f"      {json.dumps(r11, ensure_ascii=False)}")
        check("渲染期异常被 runImportText 内部消化，未逃逸到外层",
              not r11["escaped"], f"escaped={r11['escaped']!r}")
        check("导入失败时列表里没有多出记录（整体回滚）",
              r11["leaked"] is False, f"新增 {r11['listDelta']} 条")
        """
        回滚的正确含义是「回到导入之前」，不是「清空」。
        导入前 ui 可能正指着用户已有的某个场次 —— 那条必须原样还回来，
        而不是被一并抹掉（抹掉就等于顺手把用户的东西搞丢了）。
        """
        check("回滚后 ui.sessionId 回到导入前的场次（而非被清空）",
              r11["sessIdAfter"] == ui_before11["sessionId"],
              f"before={ui_before11['sessionId']!r} after={r11['sessIdAfter']!r}")
        list_after11 = await pg.evaluate(
            "(c) => window.MiyaAppointmentStore.getSessions(c).map(function (s) { return s.id; })",
            chat_id)
        check("回滚后卷宗列表与导入前完全相同（用户原有场次未被误伤）",
              list_after11 == list_before11,
              f"before={len(list_before11)} after={len(list_after11)}")
        check("回滚话术说明了「已撤销」而不是推给文件",
              "撤销" in (r11["toast"] or ""), f"toast={r11['toast']!r}")

        # 回滚之后，正常导入仍应可用（不能把 store 搞成半死状态）
        r11b = await pg.evaluate(
            "async (a) => await window.__mkProbe().importText(a.cid, a.text, a.name)",
            {"cid": chat_id, "text": jsonl11, "name": "min.jsonl"})
        print(f"      回滚后重试: {json.dumps(r11b, ensure_ascii=False)}")
        check("回滚后同一份文件仍能正常导入（store 未被搞坏）",
              bool(r11b["sessId"]) and r11b["storyHasContent"] is True,
              f"sessId={r11b['sessId']!r}")

        # ══════ 汇总 ══════
        print("\n" + "=" * 56)
        print(f"通过 {len(passed)} · 失败 {len(failed)}")
        if failed:
            print("失败项：")
            for f in failed:
                print(f"  · {f}")
        if errs:
            print("\n页面运行期报错：")
            for e in errs[:8]:
                print(f"  ! {e}")
        await browser.close()
        sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
