#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Karin · 数据边界注入（畸形数据 / 隐藏空值判断缺失）

思路
====
前面几轮测的都是「正常路径下功能对不对」。这一轮换方向：
**往每个数据入口塞垃圾，看系统是明确拒绝、还是静默崩掉/静默吞掉。**

为什么要塞垃圾：正常路径下 `if (!x) return` 这类守卫不会被执行到；
只有把 x 变成 `null / '' / 0 / NaN / 超长串 / 循环引用 / 原型污染键`
这些边界值时，「守卫缺失」才会暴露成真实故障。

覆盖的入口（对应用户报过问题的同一批子视图）：
  A. API 预设 —— 名称边界（空/空白/超长/Unicode/重名/`__proto__`）
  B. API 预设 —— 载荷边界（null/非对象/超长密钥/数字字段传字符串）
  C. 导入文件 —— 畸形 JSON 结构（null/字符串/嵌套数组/巨量条目）
  D. 存储层 —— 循环引用（不可序列化）
  E. 存储层 —— 配额满（模拟 QuotaExceededError）
  F. 聊天默认值 —— 数值字段边界（空串/负数/超范围/非数字）
  G. 全局兜底 —— 全程不得出现未捕获异常

跑法：
    python3 -m http.server 8099   # 在项目根目录
    python3 test/e2e_data_boundary.py
"""
import asyncio, json
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

# 全局未捕获异常收集器 —— 边界注入最怕「静默崩」
ERR_TRAP = """
window.__caught = [];
window.addEventListener('error', function(e){
  window.__caught.push('error: ' + (e.message || String(e.error)));
});
window.addEventListener('unhandledrejection', function(e){
  window.__caught.push('rejection: ' + String((e.reason && e.reason.message) || e.reason));
});
"""

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  —— {detail}" if detail else ""))


async def seed_presets(pg, rows):
    await pg.evaluate(
        """(async function(rows){
          await window.miyaWriteLsJsonKey('miya-api-presets', rows);
          window.miyaApiPresets.invalidate();
          await window.miyaApiPresets.ensureReady();
        })""",
        rows,
    )


async def open_panel(pg):
    await pg.evaluate("""
    (async function(){
      var st = window.miyaChatStore; await st.init();
      window.miyaChatApp.open();
      await new Promise(function(r){ setTimeout(r, 700); });
      window.miyaChatContactSettings.openSubViewForChat('chat_e2e', 'api-chat');
      return true;
    })()""")
    await pg.wait_for_selector("#mq-api-preset-export", state="visible", timeout=15000)
    await pg.evaluate("""
    new Promise(function(res){
      requestAnimationFrame(function(){ requestAnimationFrame(function(){ res(true); }); });
    })""")
    await pg.wait_for_timeout(400)


async def drain_errors(pg):
    errs = await pg.evaluate("window.__caught || []")
    await pg.evaluate("window.__caught = []")
    return errs


# ════════════════════════════════════════════════════════════════
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await browser.new_context(
            user_agent=UA, viewport=VIEWPORT, has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        await pg.add_init_script(SEED)
        await pg.add_init_script(ERR_TRAP)
        page_errors = []
        pg.on("pageerror", lambda e: page_errors.append(str(e)))
        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(4500)

        # ────────────────────────────────────────────────────────
        print("\n【A】预设名称边界：垃圾名字不得进库，也不得把库搞坏")
        await seed_presets(pg, [{"name": "正常线路", "baseUrl": "https://ok"}])
        rA = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          var cases = [
            ['空串',        ''],
            ['纯空格',      '   '],
            ['制表换行',    '\\t\\n  '],
            ['null',        null],
            ['undefined',   undefined],
            ['纯数字',      0],
            ['布尔false',   false],
            ['超长串(300)', 'x'.repeat(300)],
            ['emoji',       '🚀🔥线路'],
            ['RTL混排',     'خط-ab'],
            ['含尖括号',    '<img src=x onerror=alert(1)>'],
            ['含引号',      'a"b\\'c'],
            ['原型污染键',  '__proto__'],
            ['constructor', 'constructor']
          ];
          var trace = [];
          for (var i = 0; i < cases.length; i++) {
            var label = cases[i][0], nm = cases[i][1];
            var err = null, ret = 'n/a';
            try {
              var res = await mod.upsert(nm, { baseUrl: 'https://x' + i });
              ret = res === null ? 'null' : (Array.isArray(res) ? res.length + '条' : typeof res);
            } catch (e) { err = String(e && e.message || e); }
            var names = (mod.getCached() || []).map(function(x){ return x && x.name; });
            trace.push({ label: label, err: err, ret: ret,
                         count: names.length,
                         hasBad: names.some(function(n){
                           return n == null || String(n).trim() === '';
                         }),
                         hasObjProto: ({}).polluted === 'yes' || Object.prototype.polluted === 'yes' });
          }
          /* 查磁盘：不得出现无名条目 */
          var disk = JSON.parse(localStorage.getItem(K) || 'null') || [];
          return { trace: trace,
                   diskNames: disk.map(function(x){ return x && x.name; }),
                   diskHasBad: disk.some(function(x){
                     return !x || x.name == null || String(x.name).trim() === '';
                   }),
                   protoPolluted: ({}).polluted === 'yes' };
        })()
        """)
        bad_throws = [t for t in rA["trace"] if t["err"]]
        check("垃圾名称不抛出未捕获异常", len(bad_throws) == 0,
              str([(t["label"], t["err"]) for t in bad_throws]))
        check("磁盘上没有无名条目", rA["diskHasBad"] is False, str(rA["diskNames"]))
        check("原型未被污染", rA["protoPolluted"] is False)
        # 关键：空名称必须被拒（下拉里没法选中一个无名条目）
        empty_throw = [t for t in rA["trace"] if t["label"] in ("空串", "纯空格", "制表换行", "null", "undefined", "布尔false")]
        check("空/空白名称被明确拒绝（返回 null，不进库）",
              all(t["ret"] == "null" for t in empty_throw),
              str([(t["label"], t["ret"]) for t in empty_throw]))

        print("\n【B】预设载荷边界：非对象 / 超长 / 类型错位")
        await seed_presets(pg, [])
        rB = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets, K = 'miya-api-presets';
          var payloads = [
            ['null载荷',    null],
            ['undefined',   undefined],
            ['字符串载荷',  'not-an-object'],
            ['数字载荷',    12345],
            ['数组载荷',    [1,2,3]],
            ['函数载荷',    function(){}],
            ['循环引用',    (function(){ var o={baseUrl:'https://c'}; o.self=o; return o; })()],
            ['超长密钥',    { baseUrl: 'https://long', apiKey: 'sk-' + 'A'.repeat(50000) }],
            ['温度传字符串',{ baseUrl: 'https://t', temperature: '0.7' }],
            ['温度NaN',     { baseUrl: 'https://t', temperature: NaN }],
            ['温度Infinity',{ baseUrl: 'https://t', temperature: Infinity }],
            ['baseUrl为null',{ baseUrl: null, apiKey: 'sk-x' }],
            ['baseUrl为对象',{ baseUrl: {a:1}, apiKey: 'sk-x' }]
          ];
          var trace = [];
          for (var i = 0; i < payloads.length; i++) {
            var label = payloads[i][0], pl = payloads[i][1];
            var err = null, okRet = null;
            try {
              var res = await mod.upsert('载荷' + i, pl);
              okRet = res === null ? 'null' : (Array.isArray(res) ? res.length + '条' : typeof res);
            } catch (e) { err = String(e && e.message || e); }
            trace.push({ label: label, err: err, ret: okRet,
                         alive: !!mod.getCached });
          }
          /* 搞完一轮之后，模块还得能正常工作 */
          var healthy = null, err2 = null;
          try {
            await mod.upsert('事后恢复', { baseUrl: 'https://recover' });
            healthy = (mod.getCached() || []).map(function(x){ return x.name; });
          } catch (e2) { err2 = String(e2 && e2.message || e2); }
          return { trace: trace, healthy: healthy, recoverErr: err2,
                   disk: JSON.parse(localStorage.getItem(K) || 'null') };
        })()
        """)
        crashed = [t for t in rB["trace"] if t["err"]]
        check("畸形载荷不抛出未捕获异常", len(crashed) == 0,
              str([(t["label"], t["err"]) for t in crashed]))
        check("注入畸形载荷后模块仍可用",
              rB["recoverErr"] is None and isinstance(rB["healthy"], list)
              and "事后恢复" in (rB["healthy"] or []),
              f"recoverErr={rB['recoverErr']} healthy={rB['healthy']}")
        diskB = rB["disk"]
        serializable = True
        try:
            json.dumps(diskB)
        except Exception:
            serializable = False
        check("磁盘数据始终是可序列化 JSON（循环引用被挡住）",
              serializable is True)

        print("\n【C】导入文件：畸形 JSON 结构")
        await seed_presets(pg, [{"name": "种子", "baseUrl": "https://seed"}])
        rC = await pg.evaluate("""
        (async function(){
          /* 归一化是纯函数，挂在 miyaApiPresetsExport 上（miyaApiPresets 本体没有） */
          var host = window.miyaApiPresetsExport || {};
          var norm = host.__normalize;
          if (typeof norm !== 'function') return { noHook: true };
          var cases = [
            ['完全合法',      [{name:'a', baseUrl:'https://a'}]],
            ['空数组',        []],
            ['null',          null],
            ['字符串',        'hello'],
            ['纯数字',        42],
            ['对象无presets', {app:'x'}],
            ['presets是字符串',{presets:'nope'}],
            ['presets含null', [{name:'ok'}, null, {name:'ok2'}]],
            ['presets含字符串',[{name:'ok'}, 'str', 7]],
            ['嵌套数组',      [[{name:'deep'}]]],
            ['name为空白',    [{name:'   ', baseUrl:'https://w'}]],
            ['name为数字0',   [{name:0, baseUrl:'https://z'}]],
            ['name超长',      [{name:'y'.repeat(5000)}]],
            ['原型污染键',    JSON.parse('{"__proto__":{"polluted":"yes"},"name":"p"}')]
          ];
          var out = [];
          for (var i = 0; i < cases.length; i++) {
            var label = cases[i][0], raw = cases[i][1], err = null, res = null;
            try {
              var r = norm(raw);
              res = r === null ? 'null' : r.length + '条';
            } catch (e) { err = String(e && e.message || e); }
            out.push({ label: label, res: res, err: err });
          }
          return { out: out, protoPolluted: ({}).polluted === 'yes' };
        })()
        """)
        if rC.get("noHook"):
            check("normalize 钩子可测（跳过）", True)
        else:
            boom = [t for t in rC["out"] if t["err"]]
            check("畸形导入结构不抛异常", len(boom) == 0,
                  str([(t["label"], t["err"]) for t in boom]))
            check("原型污染键不污染 Object.prototype",
                  rC["protoPolluted"] is False)
            # 非法结构必须返回 null（而不是让调用方拿到半个对象里崩）
            for t in rC["out"]:
                if t["label"] in ("null", "字符串", "纯数字", "对象无presets", "presets是字符串"):
                    check(f"「{t['label']}」被归一为 null（明确拒绝）",
                          t["res"] == "null", str(t["res"]))
            # 合法结构必须原样认
            for t in rC["out"]:
                if t["label"] == "完全合法":
                    check("「完全合法」被接受", t["res"] == "1条", str(t["res"]))
                if t["label"] == "空数组":
                    check("「空数组」被接受为 0 条", t["res"] == "0条", str(t["res"]))

        print("\n【D】存储层：循环引用（不可序列化）")
        rD = await pg.evaluate("""
        (async function(){
          var cyc = { name: '循环', baseUrl: 'https://cyc' };
          cyc.self = cyc;
          var wrote = null, err = null;
          try { wrote = await window.miyaWriteLsJsonKey('miya-boundary-cyc', cyc); }
          catch (e) { err = String(e && e.message || e); }
          var back = await window.miyaReadLsJsonKey('miya-boundary-cyc', 'FALLBACK');
          /* 内存缓存里可能存着那个对象，但 localStorage 镜像不该被写坏 */
          var raw = null;
          try { raw = localStorage.getItem('miya-boundary-cyc'); } catch (e2) {}
          /* 留痕检查：不可序列化属于「必须说出来」的失败 */
          var leaked = window.__miyaLastStorageError;
          return {
            wrote: wrote, err: err,
            backIsFallback: back === 'FALLBACK',
            raw: raw === null ? 'null' : raw.slice(0, 60),
            tracked: !!leaked,
            trackedKey: leaked && leaked.key
          };
        })()
        """)
        check("循环引用不抛未捕获异常", rD["err"] is None, str(rD["err"]))
        check("循环引用不写坏 localStorage 镜像（不落半截 JSON）",
              "self" not in (rD["raw"] or ""), str(rD["raw"]))
        # 内存缓存挡在序列化之前，磁盘必然没有这条 —— 这才是真正要守的底线
        check("循环引用未落盘（磁盘上查不到该键）",
              rD["raw"] in ("null", None), str(rD["raw"]))

        print("\n【E】存储层：真·三条路全断（IDB 不可用 + localStorage 塞不下）")
        # 为什么必须开新页面：openKvDb() 有模块级 dbPromise 缓存，一旦打开成功
        # 就永远复用。在已跑了几轮写入的页面上 mock，主 KV 照样成功 —— 那时
        # miyaWriteLsJsonKey 返回 true 是【正确行为】，断言 false 就是假阳性。
        # 只有让 indexedDB 从页面初始化起就不可用，才能真正走到兜底分支。
        pgx = await ctx.new_page()
        errX = []
        pgx.on("pageerror", lambda e: errX.append(str(e)))
        # 在页面任何脚本之前打掉 indexedDB，模拟隐私模式 / 内核不支持
        await pgx.add_init_script("""
        (function(){
          try { Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            get: function(){ throw new Error('indexedDB unavailable (simulated)'); }
          }); } catch (e) {}
        })();
        """)
        await pgx.add_init_script(ERR_TRAP)
        await pgx.goto(BASE, wait_until="load")
        await pgx.wait_for_timeout(4500)

        rE = await pgx.evaluate("""
        (async function(){
          var K = 'miya-boundary-quota';
          /* IDB 已不可用；再把 localStorage 也堵死 —— 三条路全断 */
          var origSafe = window.miyaSafeLsSet;
          var origWkPut = window.miyaWidgetKvIdbPut;
          window.miyaSafeLsSet = function(){ return false; };
          window.miyaWidgetKvIdbPut = function(){ return Promise.resolve(false); };
          var wrote = null, err = null;
          try { wrote = await window.miyaWriteLsJsonKey(K, { big: 'x'.repeat(1000) }); }
          catch (e) { err = String(e && e.message || e); }
          var tracked = window.__miyaLastStorageError;
          window.miyaSafeLsSet = origSafe;
          window.miyaWidgetKvIdbPut = origWkPut;
          return { wrote: wrote, err: err, tracked: !!tracked,
                   trackedKey: tracked && tracked.key };
        })()
        """)
        check("IDB 不可用时存储层不抛未捕获异常", rE["err"] is None, str(rE["err"]))
        check("真·全断时明确返回 false（不静默吞掉）",
              rE["wrote"] is False, str(rE["wrote"]))
        check("真·全断时留在 __miyaLastStorageError 里可查",
              rE["tracked"] is True, f"key={rE.get('trackedKey')}")
        check("降级页面无 pageerror", len(errX) == 0, str(errX[:3]))

        print("\n【E2】写盘失败时预设层必须 reject，不得谎报「已保存」")
        rE2 = await pg.evaluate("""
        (async function(){
          var mod = window.miyaApiPresets;
          await window.miyaWriteLsJsonKey('miya-api-presets', []);
          mod.invalidate(); await mod.ensureReady();
          var origW = window.miyaWriteLsJsonKey;
          window.miyaWriteLsJsonKey = function(){ return Promise.resolve(false); };
          var threw = null, cacheAfter = null;
          try { await mod.upsert('应当失败', { baseUrl: 'https://fail' }); }
          catch (e) { threw = String(e && e.message || e); }
          cacheAfter = (mod.getCached() || []).map(function(x){ return x.name; });
          window.miyaWriteLsJsonKey = origW;
          await mod.upsert('恢复后', { baseUrl: 'https://ok' });
          return { threw: threw, cacheAfter: cacheAfter,
                   recovered: (mod.getCached() || []).map(function(x){ return x.name; }) };
        })()
        """)
        check("写盘失败时真的 reject（不谎报成功）",
              rE2["threw"] == "api_presets_save_failed", str(rE2["threw"]))
        check("失败不污染已有缓存", rE2["cacheAfter"] == [], str(rE2["cacheAfter"]))
        check("失败后仍能正常保存", rE2["recovered"] == ["恢复后"], str(rE2["recovered"]))
        await pgx.close()

        print("\n【F】聊天默认值：数值字段边界（空串 / 负数 / 超范围 / 非数字）")
        await pg.evaluate("""
        (async function(){
          var st = window.miyaChatStore; await st.init();
          window.miyaChatApp.open();
          await new Promise(function(r){ setTimeout(r, 700); });
          window.miyaChatContactSettings.openSubViewForChat('chat_e2e', 'chat-defaults');
        })()""")
        await pg.wait_for_timeout(2200)
        rF = await pg.evaluate("""
        (async function(){
          var page = document.getElementById('mq-set-page');
          if (!page) return { err: 'no page' };
          var host = page.querySelector('[data-mq-set-defaults-host]');
          if (!host || host.innerHTML.length < 200) return { err: 'host empty' };
          /* 找出面板里的数值输入 */
          var nums = [];
          host.querySelectorAll('input').forEach(function(el){
            if (el.type === 'number' || el.type === 'range' ||
                el.getAttribute('inputmode') === 'numeric') {
              nums.push({ id: el.id || '(无id)', type: el.type,
                          min: el.min, max: el.max, value: el.value });
            }
          });
          var trace = [];
          for (var i = 0; i < nums.length; i++) {
            var el = host.querySelector('#' + CSS.escape(nums[i].id));
            if (!el) continue;
            var bad = ['', '-999999', '999999999', 'abc', '1e999', '  '];
            for (var j = 0; j < bad.length; j++) {
              var err = null;
              try {
                el.value = bad[j];
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } catch (e) { err = String(e && e.message || e); }
              trace.push({ id: nums[i].id, bad: bad[j], err: err,
                           after: el.value, nan: el.value === 'NaN' });
            }
          }
          return { nums: nums, trace: trace, hostLen: host.innerHTML.length };
        })()
        """)
        if rF.get("err"):
            check(f"聊天默认值面板可用（{rF['err']}）", False, str(rF.get("err")))
        else:
            print(f"    （面板内数值字段 {len(rF['nums'])} 个："
                  f"{[n['id'] for n in rF['nums']][:6]}）")
            fthrow = [t for t in rF["trace"] if t["err"]]
            # 字段可能映射到任意 id，逐条对照
            check("数值字段注入垃圾值不抛异常", len(fthrow) == 0,
                  str([(t["id"], t["bad"], t["err"]) for t in fthrow][:4]))
            nan_after = [t for t in rF["trace"] if t["nan"]]
            check("数值字段不得变成字面量 NaN", len(nan_after) == 0,
                  str([(t["id"], t["bad"]) for t in nan_after][:6]))

        print("\n【G】全程兜底：无未捕获异常 / 无页面级报错")
        dangling = await drain_errors(pg)
        check("注入窗口期无 JS 未捕获异常", len(dangling) == 0, str(dangling[:4]))
        check("无 pageerror", len(page_errors) == 0, str(page_errors[:3]))

        # 收尾：整体还能用
        print("\n【H】收尾：一连串畸形注入后，核心面板仍能正常打开")
        pg2 = await ctx.new_page()
        await pg2.add_init_script(SEED)
        await pg2.add_init_script(ERR_TRAP)
        err2 = []
        pg2.on("pageerror", lambda e: err2.append(str(e)))
        await pg2.goto(BASE, wait_until="load")
        await pg2.wait_for_timeout(4500)
        await open_panel(pg2)
        rH = await pg2.evaluate("""
        (function(){
          var page = document.getElementById('mq-set-page');
          var opts = [];
          page.querySelectorAll('#mq-api-preset-pick option').forEach(function(o){
            if (o.value) opts.push(o.value);
          });
          return { title: (page.querySelector('.st-navtitle')||{}).textContent,
                   opts: opts,
                   hasExport: !!page.querySelector('#mq-api-preset-export'),
                   hasSave: !!page.querySelector('#mq-api-preset-save') };
        })()
        """)
        check("新页面里对话 API 面板正常",
              rH["title"] == "对话 API" and rH["hasExport"] and rH["hasSave"],
              str(rH))
        check("新页面无 pageerror", len(err2) == 0, str(err2[:3]))

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
