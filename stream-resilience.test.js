/**
 * 流式断线韧性回归测试（修复后版本）
 *
 * 运行：PKG_ROOT=<包目录> node stream-resilience.test.js
 *
 * 直接从源文件抽取实现来跑，而不是复刻——
 * 避免「测试通过但线上代码不一样」的假安全感。
 *
 * 覆盖：
 *   - 正常读完
 *   - 断线后有内容 → 部分收尾 + partial 标记
 *   - 断线后无内容 → 抛错（交给上层整体重试）
 *   - 用户中止 → 原样抛 AbortError
 *   - 空闲超时看门狗存在
 *   - 不再有退避空转（断线应立即返回，而非白等 1.2 秒）
 *   - 两处实现策略一致
 *
 * 注：原第三个被测对象（模拟器引擎 js2/miya-simulator-engine.js）
 * 已随模拟器模式一并移除，本测试同步收窄到剩余两处实现。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = process.env.PKG_ROOT || __dirname;
var BRIDGE = path.join(ROOT, 'js2/miya-api-bridge.js');
var APPT = path.join(ROOT, 'js1/miya-appointment-engine.js');

var pass = 0, fail = 0, failures = [];
function check(name, got, expect) {
  var ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) pass++; else { fail++; failures.push(name + ': got=' + JSON.stringify(got) + ' expect=' + JSON.stringify(expect)); }
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '   got=' + JSON.stringify(got) + ' expect=' + JSON.stringify(expect)));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

var bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
var apptSrc = fs.readFileSync(APPT, 'utf8');

var all = [['api-bridge', bridgeSrc], ['appointment-engine', apptSrc]];

/* ── 静态审计 ── */
section('A. 旧的「退避续读」已移除');
all.forEach(function (p) {
  check(p[0] + '：无 resumeLeft', /resumeLeft/.test(p[1]), false);
  check(p[0] + '：无 STREAM_RESUME 常量', /STREAM_RESUME_(MAX_RETRIES|BASE_DELAY)/.test(p[1]), false);
});

section('B. 空闲超时看门狗已就位');
all.forEach(function (p) {
  check(p[0] + '：定义 STREAM_IDLE_TIMEOUT_MS', /STREAM_IDLE_TIMEOUT_MS *= *\d+/.test(p[1]), true);
  check(p[0] + '：每块数据重置定时器（armIdle）', /armIdle/.test(p[1]), true);
  check(p[0] + '：读到数据后 clearIdle', /clearIdle\(\)/.test(p[1]), true);
  check(p[0] + '：超时时 cancel reader', /reader\.cancel\(\)/.test(p[1]), true);
  check(p[0] + '：有 StreamIdleTimeout 错误名', /StreamIdleTimeout/.test(p[1]), true);
});
check('api-bridge：默认 60s', /STREAM_IDLE_TIMEOUT_MS *= *60000/.test(bridgeSrc), true);

section('C. partial 标记已接线');
check('api-bridge：定义 markPartial', /function markPartial/.test(bridgeSrc), true);
check('api-bridge：支持 onPartial 回调', /reqOpts\.onPartial/.test(bridgeSrc), true);
check('api-bridge：finishPartial 调用 markPartial', /function finishPartial\(err\) \{[\s\S]{0,300}?markPartial\(err\)/.test(bridgeSrc), true);
check('appointment-engine：支持 handlers.onPartial', /handlers\.onPartial/.test(apptSrc), true);
check('appointment-engine：返回体带 partial:true', /partial: *true/.test(apptSrc), true);

section('D. 两处实现策略一致');
all.forEach(function (p) {
  check(p[0] + '：有 err 回调', /reader\.read\(\)\.then\(function[\s\S]{0,3000}?\}, function \(err\)/.test(p[1]), true);
  check(p[0] + '：有 abort 守卫', /AbortError/.test(p[1]), true);
});

/* ── 行为测试：抽取 api-bridge 的流式逻辑实跑 ── */
section('E. 行为测试（真实执行 api-bridge 的流式分支）');

var sandboxStub = [
  'function delayMs(ms){ return new Promise(function(r){ setTimeout(r, Math.max(0, ms||0)); }); }',
  'function normalizeApiTextContent(c){',
  '  if (c == null) return "";',
  '  if (typeof c === "string") return c;',
  '  if (Array.isArray(c)) return c.map(function(p){ return p && p.type === "text" ? String(p.text||"") : ""; }).join("");',
  '  return String(c);',
  '}',
  'function extractStreamDelta(obj){',
  '  if (!obj || typeof obj !== "object") return { content: "", reasoning: "" };',
  '  var ch = obj.choices && obj.choices[0];',
  '  if (!ch) return { content: "", reasoning: "" };',
  '  var d = ch.delta || ch.message || {};',
  '  var content = normalizeApiTextContent(d.content != null ? d.content : d.text);',
  '  var reasoning = "";',
  '  if (d.reasoning_content != null) reasoning = normalizeApiTextContent(d.reasoning_content);',
  '  else if (d.reasoning != null) reasoning = normalizeApiTextContent(d.reasoning);',
  '  if (!content && ch.text != null) content = normalizeApiTextContent(ch.text);',
  '  return { content: content, reasoning: reasoning };',
  '}',
  'var global = { miyaChatEngine: null };',
  'var STREAM_IDLE_TIMEOUT_MS = 60000;'
].join('\n');

function extractFn(src, name, nextName) {
  var start = src.indexOf('function ' + name);
  if (start < 0) return null;
  var end = nextName ? src.indexOf('function ' + nextName, start) : -1;
  var body = end > start ? src.slice(start, end) : src.slice(start);
  /* 回退到最后一个顶层闭括号 */
  var last = body.lastIndexOf('\n  }');
  return last > 0 ? body.slice(0, last + 4) : body;
}

var parse = null;
try {
  var fnSrc = extractFn(bridgeSrc, 'parseCompletionResponse', 'callCompletionsWithConfig');
  parse = new Function(sandboxStub + '\n' + fnSrc + '\nreturn parseCompletionResponse;')();
} catch (e) {
  console.log('  FAIL  抽取 parseCompletionResponse 失败: ' + e.message);
  fail++;
}

var enc = new TextEncoder();
function sseFrame(content, finish) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: content }, finish_reason: finish || null }] }) + '\n\n';
}
function fakeRes(script, contentType) {
  var i = 0;
  return {
    ok: true,
    headers: { get: function () { return contentType || 'text/event-stream'; } },
    body: {
      getReader: function () {
        return {
          read: function () {
            if (i >= script.length) return Promise.resolve({ done: true, value: undefined });
            var st = script[i++];
            if (st.error) return Promise.reject(st.error);
            return Promise.resolve({ done: false, value: enc.encode(st.chunk) });
          },
          cancel: function () { return Promise.resolve(); }
        };
      }
    }
  };
}
function netErr(name) {
  var e = new Error(name === 'AbortError' ? 'aborted' : 'network dropped');
  e.name = name;
  return e;
}

if (parse) {
  (async function () {
    var r1 = await parse(fakeRes([{ chunk: sseFrame('你好') }, { chunk: sseFrame('，世界') }]), {});
    check('E1 正常读完拼接正确', r1, '你好，世界');

    var partialCalls = [];
    var r2 = await parse(fakeRes([{ chunk: sseFrame('收到一半') }, { error: netErr('TypeError') }]),
      { onPartial: function (i) { partialCalls.push(i); } });
    check('E2 部分内容被保住', r2, '收到一半');
    check('E2 onPartial 被调用一次', partialCalls.length, 1);
    check('E2 标记为 disconnected', partialCalls[0] && partialCalls[0].reason, 'disconnected');

    var threw3 = null;
    try { await parse(fakeRes([{ error: netErr('TypeError') }]), {}); } catch (e) { threw3 = e.message; }
    check('E3 无内容时抛错（交给上层重试）', threw3 !== null, true);

    var partialCalls4 = [];
    var threw4 = null;
    try {
      await parse(fakeRes([{ chunk: sseFrame('正在输出') }, { error: netErr('AbortError') }]),
        { onPartial: function (i) { partialCalls4.push(i); } });
    } catch (e) { threw4 = e.name; }
    check('E4 用户中止 → 抛 AbortError', threw4, 'AbortError');
    check('E4 不触发 onPartial', partialCalls4.length, 0);

    var t0 = Date.now();
    await parse(fakeRes([{ chunk: sseFrame('内容') }, { error: netErr('TypeError') }]), { onPartial: function () {} });
    var elapsed = Date.now() - t0;
    check('E5 断线立即返回（修复前约 1200ms 空转）', elapsed < 300, true);
    console.log('       实测耗时: ' + elapsed + 'ms');

    var r6 = await parse(fakeRes([{ chunk: sseFrame('中') }, { chunk: sseFrame('文') }]), {});
    check('E6 中文跨 chunk 拼接正确', r6, '中文');

    var r7 = await parse(fakeRes([
      { chunk: 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '思考' } }] }) + '\n\n' },
      { chunk: sseFrame('正文') }
    ]), {});
    check('E7 reasoning 不污染正文', r7, '正文');

    var truncCalls = 0;
    await parse(fakeRes([{ chunk: sseFrame('说一半', 'length') }]), { onTruncated: function () { truncCalls++; } });
    check('E8 finish_reason=length 仍通知截断', truncCalls, 1);

    var threw9 = null;
    try { await parse(fakeRes([]), {}); } catch (e) { threw9 = e.message; }
    check('E9 空流抛错', threw9 !== null, true);

    finish();
  })();
} else {
  finish();
}

function finish() {
  console.log('\n' + new Array(61).join('='));
  console.log('结果：PASS=' + pass + '  FAIL=' + fail);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  · ' + f); });
  }
  process.exit(fail ? 1 : 0);
}
