/**
 * miya-cache-probe.test.js — 缓存探针回归测试
 *
 * 运行：node miya-cache-probe.test.js
 * 需要探针文件在同目录，或改 PROBE_PATH。
 *
 * 覆盖：命中/未命中各类判定、多模态、超长会话、各家 usage 字段、
 *       异常与畸形输入、探针自身崩溃可观测性。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var PROBE_PATH =
  process.env.PROBE_PATH || path.join(__dirname, 'miya-cache-probe.js');

var SRC = fs.readFileSync(PROBE_PATH, 'utf8');

/* 每个用例用全新的环境，避免 localStorage 与 lastByKey 互相污染 */
function newProbe() {
  var store = {};
  var ls = {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  var win = {};
  /* eslint-disable no-new-func */
  new Function('window', 'self', 'localStorage', 'console', SRC)(win, win, ls, console);
  return { probe: win.miyaCacheProbe, ls: ls, store: store };
}

function m(role, content) { return { role: role, content: content }; }

var pass = 0, fail = 0; var failures = [];
function check(name, got, expect) {
  var ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; } else { fail++; failures.push(name + ': got=' + JSON.stringify(got) + ' expect=' + JSON.stringify(expect)); }
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (ok ? '' : '   got=' + JSON.stringify(got) + ' expect=' + JSON.stringify(expect)));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ── 正常演进 ── */
section('尾部追加（正常演进，应命中）');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')]);
  check('reason', r.reason, 'append');
  check('ok', r.ok, true);
}

section('原样重发（应命中）');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1')]);
  check('reason', r.reason, 'identical');
  check('ok', r.ok, true);
}

section('历史收缩到上一轮的真前缀（尾部裁剪，前缀仍有效）');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1')]);
  check('不崩溃（回归：原先返回 null）', r !== null, true);
  check('reason', r && r.reason, 'truncate_tail');
  check('ok', r && r.ok, true);
  check('本轮已留档', p.loadRounds().length, 2);
}

/* ── 污染检测 ── */
section('system 里混入每轮变化的时间戳（历史被改写）');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S [time=10:01]'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')]);
  check('reason', r.reason, 'modified');
  check('ok', r.ok, false);
}

section('世界书插到历史中间');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('system', 'WB'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')]);
  check('reason', r.reason, 'inserted');
  check('ok', r.ok, false);
  check('sameCount', r.sameCount, 1);
}

section('两条 assistant 之间插入 assistant（角色相同，不能误判为改写）');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1'), m('assistant', 'a1x'), m('user', 'u2'), m('user', 'u3')]);
  check('reason', r.reason, 'inserted');
  check('ok', r.ok, false);
}

section('历史中间被删除');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'A'), m('assistant', 'B'), m('user', 'u1')]);
  var r = p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('assistant', 'B'), m('user', 'u1'), m('user', 'u2')]);
  check('reason', r.reason, 'removed');
  check('ok', r.ok, false);
}

section('前缀污染一轮后能恢复命中');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1')]);
  var r1 = p.trackRequest({ id: 'c1' }, [m('system', 'S [t=1]'), m('user', 'u1'), m('user', 'u2')]);
  var r2 = p.trackRequest({ id: 'c1' }, [m('system', 'S [t=1]'), m('user', 'u1'), m('user', 'u2'), m('user', 'u3')]);
  check('污染轮', r1.reason, 'modified');
  check('恢复轮', r2.reason, 'append');
}

/* ── 多模态 ── */
section('多模态：图片内容变化必须被察觉（回归：原先漏报 identical）');
{
  var p = newProbe().probe;
  var img = function (b) {
    return [{ type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b } }];
  };
  p.trackRequest({ id: 'i' }, [m('system', 'S'), { role: 'user', content: img('AAAA') }]);
  var r = p.trackRequest({ id: 'i' }, [m('system', 'S'), { role: 'user', content: img('BBBB') }]);
  check('reason', r.reason, 'modified');
  check('ok', r.ok, false);
}

section('多模态：同一张图重发仍算命中（不能全是误报）');
{
  var p = newProbe().probe;
  var img = function () {
    return [{ type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
  };
  p.trackRequest({ id: 'i' }, [m('system', 'S'), { role: 'user', content: img() }]);
  var r = p.trackRequest({ id: 'i' }, [m('system', 'S'), { role: 'user', content: img() }, m('user', 'u2')]);
  check('reason', r.reason, 'append');
}

/* ── 超长会话 ── */
section('超长会话：靠后位置的污染仍被发现（回归：原先在 400KB 处被截断后漏报）');
{
  var p = newProbe().probe;
  var many = [];
  for (var i = 0; i < 300; i++) many.push(m('user', new Array(2001).join('X') + i));
  p.trackRequest({ id: 'big' }, [m('system', 'S')].concat(many));
  var t = [m('system', 'S')].concat(many.slice());
  t[295] = m('user', '!!污染!!');
  var r = p.trackRequest({ id: 'big' }, t);
  check('reason', r.reason, 'modified');
  check('ok', r.ok, false);
  check('sameCount', r.sameCount, 295);
}

section('超长会话：总指纹必须有硬上限，不能无限增长');
{
  var p = newProbe().probe;
  var many = [];
  for (var i = 0; i < 5000; i++) many.push(m('user', new Array(2001).join('Y') + i));
  p.trackRequest({ id: 'huge' }, many);
  var rounds = p.loadRounds();
  check('没有爆栈 / 本轮已留档', rounds.length >= 1, true);
}

/* ── 各家用量字段 ── */
section('服务商缓存用量字段解析');
{
  var p = newProbe().probe;
  var ds = p.parseCacheUsage({ usage: { prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, prompt_tokens: 120, completion_tokens: 5, total_tokens: 125 } });
  check('DeepSeek read', ds.read, 100);
  check('DeepSeek write', ds.write, 20);

  var oa = p.parseCacheUsage({ usage: { prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 180 } } });
  check('OpenAI 嵌套 cached_tokens', oa.read, 180);
  check('OpenAI prompt', oa.prompt, 200);

  var an = p.parseCacheUsage({ usage: { input_tokens: 300, output_tokens: 12, cache_read_input_tokens: 250, cache_creation_input_tokens: 50 } });
  check('Anthropic read', an.read, 250);
  check('Anthropic write', an.write, 50);

  var gm = p.parseCacheUsage({ usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 15, totalTokenCount: 415, cachedContentTokenCount: 380 } });
  check('Gemini cachedContentTokenCount', gm.read, 380);
  check('Gemini prompt', gm.prompt, 400);

  check('无字段时返回 null', p.parseCacheUsage({ usage: {} }), null);
  check('传入字符串不炸', p.parseCacheUsage('不是对象'), null);
}

section('用量补记到对应轮次');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S')]);
  p.attachUsage({ read: 10, write: 0, prompt: 100, completion: 1, total: 101, hasCacheField: true });
  var r = p.loadRounds();
  check('usage 已挂载', r[r.length - 1].usage.read, 10);
}

/* ── 健壮性 ── */
section('健壮性：localStorage 写满时不打断聊天');
{
  var env = newProbe();
  env.ls.setItem = function () { throw new Error('QuotaExceededError'); };
  var win = {};
  new Function('window', 'self', 'localStorage', 'console', SRC)(win, win, env.ls, console);
  var p = win.miyaCacheProbe;
  var threw = false;
  try {
    p.trackRequest({ id: 'x' }, [m('system', 'S')]);
    p.trackRequest({ id: 'x' }, [m('system', 'S'), m('user', 'u')]);
    p.attachUsage({ read: 1 });
    p.summarize(5);
    p.report(5);
    p.clear();
  } catch (e) { threw = true; }
  check('不抛异常', threw, false);
}

section('健壮性：畸形输入');
{
  var p = newProbe().probe;
  var threw = false;
  try {
    p.trackRequest(null, null);
    p.trackRequest({}, []);
    p.trackRequest({}, [null, undefined, 42, { role: 'user' }]);
    p.trackRequest(undefined, [{ role: 'user', content: { deep: { nest: true } } }]);
    p.parseCacheUsage(null);
    p.parseCacheUsage({});
    p.attachUsage(null);
    p.summarize(null);
    p.report();
  } catch (e) { threw = true; console.log('    异常: ' + e.message); }
  check('不抛异常', threw, false);
}

section('探针自身出错必须可观测（不能把「探针坏了」显示成「缓存健康」）');
{
  var p = newProbe().probe;
  var s = p.summarize(10);
  check('probeErrors 字段存在', typeof s.probeErrors, 'number');
  check('正常情况为 0', s.probeErrors, 0);
  check('windowCapped 字段存在', typeof s.windowCapped, 'boolean');
}

section('关闭开关生效');
{
  var env = newProbe();
  env.ls.setItem('miyaCacheProbeOff', '1');
  var r = env.probe.trackRequest({ id: 'c1' }, [m('system', 'S')]);
  check('关闭时返回 null', r, null);
}

section('多配置互不干扰');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S')]);
  var r = p.trackRequest({ id: 'c2' }, [m('system', 'OTHER')]);
  check('另一配置独立计基线', r.reason, 'baseline');
}

section('留档上限与报告窗口');
{
  var p = newProbe().probe;
  for (var i = 0; i < 60; i++) p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u' + i)]);
  check('留档裁剪到上限', p.loadRounds().length, 40);
  var s = p.summarize(10);
  check('窗口上限生效', s.rounds <= 10, true);
  check('windowCapped 已置位', s.windowCapped, true);
  var rep = p.report(10);
  check('报告含裁剪提示', rep.indexOf('留档已达上限') >= 0, true);
}

section('命中率统计');
{
  var p = newProbe().probe;
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1')]);
  p.trackRequest({ id: 'c1' }, [m('system', 'S'), m('user', 'u1'), m('user', 'u2')]);
  p.trackRequest({ id: 'c1' }, [m('system', 'S2'), m('user', 'u1'), m('user', 'u2'), m('user', 'u3')]);
  var s = p.summarize(10);
  check('轮数', s.rounds, 2);
  check('命中', s.hits, 1);
  check('未命中', s.misses, 1);
  check('命中率', s.hitRate, 50);
  check('问题条目带改进建议', s.issues.length > 0 && !!s.issues[0].hint, true);
}

/* ── 汇总 ── */
console.log('\n' + new Array(61).join('='));
console.log('结果：PASS=' + pass + '  FAIL=' + fail);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach(function (f) { console.log('  · ' + f); });
}
console.log('探针文件：' + PROBE_PATH);
process.exit(fail ? 1 : 0);
