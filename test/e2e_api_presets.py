#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 对话 API 接口预设的回归测试

背景（用户报的）：「对话 API 预设没法保存和删除」，并要求「导出全部预设」。

根因：js2/miya-api-config.js 里 upsert / remove 都写
    ensureApiPresetsReady().then(function (list) { ... })
而 ensureApiPresetsReady() 只在第一次真正加载，之后永远返回当初那个
已 resolve 的 promise —— 它闭包里捕获的是**首次加载的列表**。
于是每次保存都变成「首次快照 + 这一条」，上一次保存的必然被冲掉：
用户真实操作中「连存两条只剩一条」，感知就是存不上。

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/e2e_api_presets.py

覆盖点：
  1. 无刷新连续保存多条，全部留住（核心回归）
  2. 背靠背并发保存不互相覆盖
  3. 保存 / 删除混合序列结果正确
  4. 同名覆盖不产生重复条目
  5. 跨页面重载持久化
  6. 导出的文件能被导入回来，逐字段还原（含副线路密钥）
  7. 导入同名预设覆盖而非重复；兼容裸数组格式
  8. 坏文件给出提示且不破坏已有数据
  9. 写盘失败不谎报成功，且后续操作仍可用
 10. 对照护栏：生图面板（已知正确）连续保存仍全部留住
"""
import asyncio, json, os, tempfile
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
    emojiGroups: [{ id: 'default', name: '默认', sort: 0, scope: 'global', contactIds: [] }],
    emojiPacks: [], savedMessages: [],
    contactGroups: [{ id: 'ct-default', name: '默认', sort: 0, createdAt: now }],
    contacts: [{ id: 'c_e2e', name: '小满', remarkName: '小满', groupId: 'ct-default',
      createdAt: now, updatedAt: now, chatSettings: {} }],
    chats: [{ id: 'chat_e2e', type: 'single', contactId: 'c_e2e', title: '小满',
      profileId: 'p1', createdAt: now, updatedAt: now, chatSettings: {} }],
    messagesByChat: { 'chat_e2e': [] }, shopCatalog: null, chatWallpapers: []
  };
  try { localStorage.setItem('miya-chat-meta', JSON.stringify(meta)); } catch(e){}
})();
"""

PRESETS_KEY = "miya-api-presets"
passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


# 走真实路径打开对话 API 子视图。
# 注意必须先 miyaChatApp.open()：否则 #miya-chat-app 还是 hidden，
# 面板里所有控件（包括原来就有的 ✓ 保存键）getComputedStyle 都是 hidden，
# 点不动 —— 这是测试脚手架问题，不是功能问题。
OPEN_PANEL = """
(async function(){
  var st = window.miyaChatStore; await st.init();
  window.miyaChatApp.open();
  await new Promise(function(r){ setTimeout(r, 700); });
  window.miyaChatContactSettings.openSubViewForChat('chat_e2e', 'api-chat');
  return true;
})()
"""


async def open_panel(pg):
    """打开对话 API 子视图，并等到界面真正稳定。

    为什么不能只等「按钮可见」：open() 里 store.init() 落地后还会排一次
    requestAnimationFrame 重绘（render 对子视图是整块换 innerHTML）。
    按钮在第一次渲染时就可见了，但重绘可能还在路上；这时候往面板里
    set_input_files / 点按钮，操作会被随后到达的重绘擦掉，
    表现为「导入没反应」—— 实际是**测试自己的时序问题**，
    手动用是好的（浏览器里用户不会卡在那一帧里操作）。

    所以这里再等两帧 + 一次下拉框稳定检查，确保没有待处理的重绘。
    """
    await pg.evaluate(OPEN_PANEL)
    await pg.wait_for_selector("#mq-api-preset-export", state="visible", timeout=15000)
    await pg.evaluate("""
    new Promise(function(res){
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){ res(true); });
      });
    })
    """)
    await pg.wait_for_timeout(400)


async def install_toast_spy(pg):
    """装上提示偷听器，用来断言「有没有弹提示」。

    为什么不能去 DOM 里找 .mi-toast：设置页自己的 toast() 只是转发到
    miyaChatApp.toast() → global.miyaToast()，根本没往 #mq-set-page 里写节点；
    而 miyaToast 的实现会「用完即删」（setTimeout 后 el.remove()）。
    事后去查 DOM 必然是空 —— 那是断言写错了，不是功能坏了。
    所有提示最终都会过 miyaToast 这一道，在这里记一笔最可靠。
    """
    await pg.evaluate("""
    (function(){
      if (window.__toastSpy) return;
      window.__toasts = [];
      var orig = window.miyaToast;
      window.__toastSpy = true;
      window.miyaToast = function(msg){
        window.__toasts.push(String(msg));
        if (typeof orig === 'function') return orig.apply(this, arguments);
      };
    })()
    """)


async def last_toast(pg):
    return await pg.evaluate("(window.__toasts && window.__toasts.length) ? window.__toasts[window.__toasts.length-1] : ''")


async def seed_presets(pg, rows):
    await pg.evaluate(
        """(async function(rows){
          await window.miyaWriteLsJsonKey('miya-api-presets', rows);
          window.miyaApiPresets.invalidate();
          await window.miyaApiPresets.ensureReady();
        })""",
        rows,
    )


async def main():
    tmpdir = tempfile.mkdtemp(prefix="miya-presets-")
    export_path = os.path.join(tmpdir, "exported.json")
    bare_path = os.path.join(tmpdir, "bare.json")
    bad_path = os.path.join(tmpdir, "bad.json")

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True,
            is_mobile=True, accept_downloads=True
        )
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        page_errors = []
        pg.on("pageerror", lambda e: page_errors.append(str(e)))
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4500)

        # ─────────────────────────────────────────────────────────
        print("\n【1】数据层：无刷新连续保存，全部留住（核心回归）")
        r1 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, []);
          mod.invalidate(); await mod.ensureReady();
          var seq = ['线路一','线路二','线路三','线路四'], snap = [];
          for (var i = 0; i < seq.length; i++) {
            await mod.upsert(seq[i], { baseUrl: 'https://h'+i, apiKey: 'sk-'+i, model: 'm'+i });
            snap.push((mod.getCached()||[]).map(function(x){return x.name;}));
          }
          return { perStep: snap,
                   disk: JSON.parse(localStorage.getItem(K)||'null').map(function(x){return x.name;}) };
        })()
        """)
        expect = [["线路一"], ["线路一", "线路二"], ["线路一", "线路二", "线路三"],
                  ["线路一", "线路二", "线路三", "线路四"]]
        check("逐步累加（不再只剩最后一条）", r1["perStep"] == expect, str(r1["perStep"]))
        check("磁盘上 4 条全部留住", r1["disk"] == expect[-1], str(r1["disk"]))

        print("\n【2】数据层：背靠背并发保存不互相覆盖")
        r2 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, []);
          mod.invalidate(); await mod.ensureReady();
          await Promise.all([
            mod.upsert('快A', { baseUrl: 'https://a' }),
            mod.upsert('快B', { baseUrl: 'https://b' })
          ]);
          return { cached: (mod.getCached()||[]).map(function(x){return x.name;}),
                   disk: JSON.parse(localStorage.getItem(K)||'null').map(function(x){return x.name;}) };
        })()
        """)
        check("并发两条都在（缓存）", r2["cached"] == ["快A", "快B"], str(r2["cached"]))
        check("并发两条都在（磁盘）", r2["disk"] == ["快A", "快B"], str(r2["disk"]))

        print("\n【3】数据层：保存/删除混合序列")
        r3 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, []);
          mod.invalidate(); await mod.ensureReady();
          await mod.upsert('甲', { baseUrl: 'https://1' });
          await mod.upsert('乙', { baseUrl: 'https://2' });
          await mod.remove('甲');
          await mod.upsert('丙', { baseUrl: 'https://3' });
          return { cached: (mod.getCached()||[]).map(function(x){return x.name;}),
                   disk: JSON.parse(localStorage.getItem(K)||'null').map(function(x){return x.name;}) };
        })()
        """)
        check("存/存/删/存 结果正确（缓存）", r3["cached"] == ["乙", "丙"], str(r3["cached"]))
        check("存/存/删/存 结果正确（磁盘）", r3["disk"] == ["乙", "丙"], str(r3["disk"]))

        print("\n【4】数据层：同名覆盖不产生重复")
        r4 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, []);
          mod.invalidate(); await mod.ensureReady();
          await mod.upsert('同', { baseUrl: 'https://old' });
          await mod.upsert('同', { baseUrl: 'https://new' });
          var after = (mod.getCached()||[]).map(function(x){ return x.name + '|' + x.baseUrl; });
          await mod.remove('同');
          return { after: after, findAfterRemove: await mod.find('同'),
                   listAfterRemove: (mod.getCached()||[]).map(function(x){return x.name;}) };
        })()
        """)
        check("同名覆盖后只有一条且用新值", r4["after"] == ["同|https://new"], str(r4["after"]))
        check("删除后 find 返回 null", r4["findAfterRemove"] is None, str(r4["findAfterRemove"]))
        check("删除后列表为空", r4["listAfterRemove"] == [], str(r4["listAfterRemove"]))

        print("\n【5】数据层：删干净后磁盘与 IDB 都为空")
        r5 = await pg.evaluate("""
        (async function(){
          var K = 'miya-api-presets';
          return { disk: JSON.parse(localStorage.getItem(K)||'null'),
                   idb: await window.miyaReadLsJsonKey(K, null) };
        })()
        """)
        check("磁盘为空数组", r5["disk"] == [], str(r5["disk"]))
        check("IDB 为空数组", r5["idb"] == [], str(r5["idb"]))

        print("\n【6】数据层：写盘失败不谎报成功，且不毒化后续操作")
        r6 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          await window.miyaWriteLsJsonKey(K, [{ name: '旧有', baseUrl: 'https://keep' }]);
          mod.invalidate(); await mod.ensureReady();
          var orig = window.miyaWriteLsJsonKey;
          window.miyaWriteLsJsonKey = function(){ return Promise.resolve(false); };
          var threw = null;
          try { await mod.upsert('会失败', { baseUrl: 'https://x' }); }
          catch(e) { threw = e && e.message; }
          window.miyaWriteLsJsonKey = orig;
          var afterFail = (mod.getCached()||[]).map(function(x){return x.name;});
          await mod.upsert('恢复后', { baseUrl: 'https://ok' });
          return { threw: threw, afterFail: afterFail,
                   afterRecover: (mod.getCached()||[]).map(function(x){return x.name;}) };
        })()
        """)
        check("写盘失败时真的 reject", r6["threw"] == "api_presets_save_failed", str(r6["threw"]))
        check("失败不污染已有数据", r6["afterFail"] == ["旧有"], str(r6["afterFail"]))
        check("失败后队列未毒化，仍能继续保存",
              r6["afterRecover"] == ["旧有", "恢复后"], str(r6["afterRecover"]))

        # ─────────────────────────────────────────────────────────
        print("\n【7】UI：对话 API 面板应有导出/导入按钮")
        await open_panel(pg)
        r7 = await pg.evaluate("""
        (function(){
          var page = document.getElementById('mq-set-page');
          var e = page.querySelector('#mq-api-preset-export');
          var i = page.querySelector('#mq-api-preset-import');
          return {
            title: (page.querySelector('.st-navtitle')||{}).textContent,
            exportText: e && e.textContent,
            importText: i && i.textContent,
            visible: e ? getComputedStyle(e).visibility === 'visible' : false,
            fileInput: !!page.querySelector('#mq-api-preset-file'),
            saveBtn: !!page.querySelector('#mq-api-preset-save'),
            deleteBtn: !!page.querySelector('#mq-api-preset-delete')
          };
        })()
        """)
        check("子视图标题为「对话 API」", r7["title"] == "对话 API", str(r7["title"]))
        check("导出按钮可见", r7["visible"] is True)
        check("按钮文案正确",
              r7["exportText"] == "导出全部预设" and r7["importText"] == "导入预设",
              f"{r7['exportText']} / {r7['importText']}")
        check("隐藏 file input 已挂上", r7["fileInput"] is True)
        check("原有 ✓ 保存 / × 删除 未被破坏",
              r7["saveBtn"] is True and r7["deleteBtn"] is True)

        print("\n【8】UI：通过真实点击连续保存 3 条预设")
        await seed_presets(pg, [])
        await open_panel(pg)
        r8 = await pg.evaluate("""
        (async function(){
          var page = document.getElementById('mq-set-page');
          function set(id, v){ var e = page.querySelector('#'+id); if (e) e.value = v; }
          var data = [
            ['主力线路', 'https://main.example/v1', 'sk-main-1111', 'gpt-4o'],
            ['备用线路', 'https://backup.example/v1', 'sk-back-2222', 'claude-sonnet-4'],
            ['便宜线路', 'https://cheap.example/v1', 'sk-cheap-3333', 'gpt-4o-mini']
          ];
          var snap = [];
          for (var i = 0; i < data.length; i++) {
            var d = data[i];
            set('mq-api-preset-name', d[0]);
            set('mq-api-base', d[1]);
            set('mq-api-key', d[2]);
            var sel = page.querySelector('#mq-api-model');
            sel.innerHTML = '<option value="' + d[3] + '"></option>';
            sel.value = d[3];
            set('mq-api2-base', 'https://fb.example/v1');
            set('mq-api2-key', 'sk-fb-9999');
            page.querySelector('#mq-api-preset-save').click();
            await new Promise(function(r){ setTimeout(r, 500); });
            var opts = [];
            page.querySelectorAll('#mq-api-preset-pick option').forEach(function(o){ if (o.value) opts.push(o.value); });
            snap.push(opts);
          }
          return { perStep: snap,
                   disk: JSON.parse(localStorage.getItem('miya-api-presets')||'null') };
        })()
        """)
        check("第 1 次保存后下拉 1 条", r8["perStep"][0] == ["主力线路"], str(r8["perStep"][0]))
        check("第 2 次保存后下拉 2 条",
              r8["perStep"][1] == ["主力线路", "备用线路"], str(r8["perStep"][1]))
        check("第 3 次保存后下拉 3 条",
              r8["perStep"][2] == ["主力线路", "备用线路", "便宜线路"], str(r8["perStep"][2]))
        disk = r8["disk"] or []
        check("磁盘上 3 条全部留住", len(disk) == 3, f"实际 {len(disk)} 条")
        check("主线路密钥写入", all(x.get("apiKey") for x in disk))
        check("副线路网关与密钥一并写入",
              all(x.get("fallbackBaseUrl") == "https://fb.example/v1" and
                  x.get("fallbackApiKey") == "sk-fb-9999" for x in disk))

        print("\n【9】UI：跨页面重载后 3 条仍在")
        pg2 = await ctx.new_page()
        await pg2.add_init_script(SEED)
        await pg2.goto(BASE, wait_until="load")
        await pg2.wait_for_timeout(5000)
        await open_panel(pg2)
        r9 = await pg2.evaluate("""
        (function(){
          var page = document.getElementById('mq-set-page');
          var opts = [];
          page.querySelectorAll('#mq-api-preset-pick option').forEach(function(o){ if (o.value) opts.push(o.value); });
          return opts;
        })()
        """)
        check("重载后下拉仍是 3 条",
              r9 == ["主力线路", "备用线路", "便宜线路"], str(r9))

        print("\n【10】UI：通过真实点击删除中间那条，重载后剩 2 条")
        r10 = await pg2.evaluate("""
        (async function(){
          var page = document.getElementById('mq-set-page');
          page.querySelector('#mq-api-preset-pick').value = '备用线路';
          page.querySelector('#mq-api-preset-delete').click();
          await new Promise(function(r){ setTimeout(r, 700); });
          var opts = [];
          page.querySelectorAll('#mq-api-preset-pick option').forEach(function(o){ if (o.value) opts.push(o.value); });
          return { opts: opts,
                   disk: JSON.parse(localStorage.getItem('miya-api-presets')||'null')
                           .map(function(x){ return x.name; }) };
        })()
        """)
        check("删除后下拉剩 2 条", r10["opts"] == ["主力线路", "便宜线路"], str(r10["opts"]))
        check("删除后磁盘剩 2 条", r10["disk"] == ["主力线路", "便宜线路"], str(r10["disk"]))

        pg3 = await ctx.new_page()
        await pg3.add_init_script(SEED)
        await pg3.goto(BASE, wait_until="load")
        await pg3.wait_for_timeout(5000)
        await open_panel(pg3)
        r10b = await pg3.evaluate("""
        (function(){
          var page = document.getElementById('mq-set-page');
          var opts = [];
          page.querySelectorAll('#mq-api-preset-pick option').forEach(function(o){ if (o.value) opts.push(o.value); });
          return opts;
        })()
        """)
        check("重载后删除已生效（剩 2 条）",
              r10b == ["主力线路", "便宜线路"], str(r10b))

        print("\n【11】UI：点「导出全部预设」真的下载一个可用 JSON")
        try:
            async with pg3.expect_download(timeout=10000) as dl_info:
                await pg3.click("#mq-api-preset-export")
            dl = await dl_info.value
            content = open(await dl.path(), encoding="utf-8").read()
            payload = json.loads(content)
            open(export_path, "w", encoding="utf-8").write(content)
            json.dump(payload.get("presets", []),
                      open(bare_path, "w", encoding="utf-8"), ensure_ascii=False)
            check("确实触发下载", True)
            check("文件名含「接口预设」且为 .json",
                  "接口预设" in dl.suggested_filename and dl.suggested_filename.endswith(".json"),
                  dl.suggested_filename)
            check("落款 kind=api-presets", payload.get("kind") == "api-presets", str(payload.get("kind")))
            check("导出条数为 2", payload.get("count") == 2, str(payload.get("count")))
            check("导出条目正确",
                  [x["name"] for x in payload["presets"]] == ["主力线路", "便宜线路"],
                  str([x["name"] for x in payload["presets"]]))
            check("含密钥明文，可 1:1 还原",
                  all(x.get("apiKey") for x in payload["presets"]))
        except Exception as e:
            check("确实触发下载", False, str(e)[:200])

        print("\n【12】UI：清空后导入，逐字段还原")
        await seed_presets(pg3, [])
        await open_panel(pg3)
        await install_toast_spy(pg3)
        await pg3.set_input_files("#mq-api-preset-file", export_path)
        await pg3.wait_for_timeout(1800)
        r12 = await pg3.evaluate("""
        (async function(){
          var page = document.getElementById('mq-set-page');
          var opts = [];
          page.querySelectorAll('#mq-api-preset-pick option').forEach(function(o){ if (o.value) opts.push(o.value); });
          return { opts: opts, full: window.miyaApiPresets.getCached() || [] };
        })()
        """)
        r12["toast"] = await last_toast(pg3)
        by_name = {x["name"]: x for x in (r12["full"] or [])}
        check("导入后下拉恢复 2 条", r12["opts"] == ["主力线路", "便宜线路"], str(r12["opts"]))
        check("导入后有成功提示",
              ("导入" in (r12.get("toast") or "")), str(r12.get("toast")))
        m = by_name.get("主力线路", {})
        check("主线路网关还原", m.get("baseUrl") == "https://main.example/v1", str(m.get("baseUrl")))
        check("主线路密钥还原", m.get("apiKey") == "sk-main-1111", str(m.get("apiKey")))
        check("副线路密钥还原（不被丢掉）", m.get("fallbackApiKey") == "sk-fb-9999", str(m.get("fallbackApiKey")))
        check("副线路网关还原", m.get("fallbackBaseUrl") == "https://fb.example/v1", str(m.get("fallbackBaseUrl")))

        print("\n【13】UI：重复导入同名预设应覆盖而非重复")
        await pg3.set_input_files("#mq-api-preset-file", export_path)
        await pg3.wait_for_timeout(1800)
        r13 = await pg3.evaluate("""
        (function(){ return (window.miyaApiPresets.getCached()||[]).map(function(x){ return x.name; }); })()
        """)
        check("重复导入不产生重复条目", r13 == ["主力线路", "便宜线路"], str(r13))

        print("\n【14】UI：兼容裸数组格式的导入文件")
        await seed_presets(pg3, [])
        await open_panel(pg3)
        await pg3.set_input_files("#mq-api-preset-file", bare_path)
        await pg3.wait_for_timeout(1800)
        r14 = await pg3.evaluate("""
        (function(){ return (window.miyaApiPresets.getCached()||[]).map(function(x){ return x.name; }); })()
        """)
        check("裸数组文件也能导入", r14 == ["主力线路", "便宜线路"], str(r14))

        print("\n【15】UI：坏文件给出提示且不破坏已有数据")
        open(bad_path, "w", encoding="utf-8").write("{ this is not json ")
        await pg3.set_input_files("#mq-api-preset-file", bad_path)
        await pg3.wait_for_timeout(1500)
        r15 = await pg3.evaluate("""
        (function(){
          return { list: (window.miyaApiPresets.getCached()||[]).map(function(x){ return x.name; }) };
        })()
        """)
        r15["toast"] = await last_toast(pg3)
        check("坏 JSON 有明确提示",
              ("JSON" in (r15.get("toast") or "")) or ("格式" in (r15.get("toast") or "")),
              str(r15.get("toast")))
        check("坏 JSON 不影响已有数据",
              r15["list"] == ["主力线路", "便宜线路"], str(r15["list"]))

        print("\n【16】对照护栏：生图面板（已知正确）连续保存仍全部留住")
        r16 = await pg3.evaluate("""
        (async function(){
          if (!window.MiyaImageGenApp) return { noApp: true };
          window.MiyaImageGenApp.open();
          await new Promise(function(r){ setTimeout(r, 900); });
          function set(id, v){ var e = document.getElementById(id); if (e) e.value = v; }
          var snap = [];
          for (var i = 1; i <= 3; i++) {
            set('miya-st-ig-oa-base', 'https://g'+i+'.example');
            set('miya-st-ig-oa-key', 'sk-g'+i);
            set('miya-st-ig-oa-preset-name', 'G'+i);
            document.getElementById('miya-st-ig-oa-preset-save').click();
            await new Promise(function(r){ setTimeout(r, 600); });
            var o = [];
            document.querySelectorAll('#miya-st-ig-oa-preset-pick option')
              .forEach(function(x){ if (x.value) o.push(x.value); });
            snap.push(o);
          }
          return { perStep: snap,
                   disk: JSON.parse(localStorage.getItem('miya-image-gen-oa-presets-v1')||'null')
                           .map(function(x){ return x.name; }) };
        })()
        """)
        if r16.get("noApp"):
            check("生图面板可用（跳过）", True)
        else:
            check("生图面板连续存 3 条全部留住",
                  r16["disk"] == ["G1", "G2", "G3"], str(r16["disk"]))

        print("\n【17】全程无 JS 报错")
        check("无 pageerror", len(page_errors) == 0, str(page_errors[:3]))

        await browser.close()

    print(f"\n{'='*62}")
    print(f"通过 {len(passed)} / 共 {len(passed)+len(failed)}")
    if failed:
        print("失败项：")
        for f in failed:
            print("  -", f)
        return 1
    print("全部通过 ✅")
    return 0


raise SystemExit(asyncio.run(main()))
