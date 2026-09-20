/**
 * 色盘与内嵌取色器的单元测试（Node，无需浏览器）
 *
 * 覆盖四组：
 *   【1】颜色算法本身的正确性（亮度 / 对比度 / 选色）
 *   【2】色盘数据的完整性（色值合法、排序、无重复）
 *   【3】paletteToParams 的分配约束（背景最亮、我方最艳、文字可读）
 *   【4】面板读写的边界（可选色空串语义、touched 标记）
 */
'use strict';

var path = '/tmp/karinn/karinn-fixed-v8.5-v13/js1/miya-chat-bubble-tuner.js';

/* jsdom 造 DOM 跑面板读写 */
var JSDOM = require('/tmp/node_modules/jsdom').JSDOM;
var dom = new JSDOM('<body><div id="wrap"></div></body>');
global.document = dom.window.document;

global.window = global;
require(path);
var T = window.MiyaBubbleTuner;

var OK = 0, NO = [];
function check(name, ok, detail) {
  if (ok) { OK++; console.log('  ✓ ' + name + (detail ? '  —— ' + detail : '')); }
  else { NO.push(name); console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
}

function lum(h) {
  var c = T.hexToRgb(h);
  function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function ratio(a, b) {
  var la = lum(a), lb = lum(b);
  var hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

console.log('【1】颜色算法');
check('hexToRgb 解析六位', JSON.stringify(T.hexToRgb('#ff8800')) === '{"r":255,"g":136,"b":0}');
check('hexToRgb 解析三位', JSON.stringify(T.hexToRgb('#f80')) === '{"r":255,"g":136,"b":0}');
check('hexToRgb 拒绝非法值', T.hexToRgb('rgb(1,2,3)') === null && T.hexToRgb('') === null);
check('rgbToHex 往返一致', T.rgbToHex(255, 136, 0) === '#ff8800');
check('lum(白) = 1', Math.abs(lum('#ffffff') - 1) < 0.001);
check('lum(黑) = 0', Math.abs(lum('#000000')) < 0.001);
check('黑白对比度 = 21', Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01);
check('同色对比度 = 1', Math.abs(ratio('#888888', '#888888') - 1) < 0.001);
check('pickFg 深底给白字', T.pickFg('#1a1a2e') === '#ffffff');
check('pickFg 浅底给深字', T.contrast('#fdf6d9', T.pickFg('#fdf6d9')) >= 4.5,
      T.pickFg('#fdf6d9'));
check('mostVivid 挑出饱和色', T.mostVivid(['#efefef', '#e0e0e0', '#e74c3c']) === '#e74c3c',
      T.mostVivid(['#efefef', '#e0e0e0', '#e74c3c']));

console.log('\n【2】色盘数据完整性');
check('共 6 套色盘', T.PALETTES.length === 6, String(T.PALETTES.length));
check('每套都有 id/name/shades', T.PALETTES.every(function (p) {
  return p.id && p.name && Array.isArray(p.shades) && p.shades.length >= 4;
}));
check('所有色值都是合法 hex', T.PALETTES.every(function (p) {
  return p.shades.every(function (s) { return T.isHex(s); });
}));
check('色盘 id 不重复', (function () {
  var seen = {}, dup = false;
  T.PALETTES.forEach(function (p) { if (seen[p.id]) dup = true; seen[p.id] = 1; });
  return !dup;
})());
check('hslToHex 红', T.hslToHex(0, 100, 50) === '#ff0000', T.hslToHex(0, 100, 50));
check('hslToHex 白', T.hslToHex(123, 0, 100) === '#ffffff');
check('hslToHex 黑', T.hslToHex(123, 100, 0) === '#000000');
check('hexToHsl 白', (function () { var q = T.hexToHsl('#ffffff'); return q.h === 0 && q.s === 0 && q.l === 100; })());
/* 整数滑块有固有 ±1 量化：#efefef → (0,0,94) → #f0f0f0，肉眼不可辨。
   用户真正在意的性质：在任意滑块位上来回（hex→HSL→hex→HSL→hex），
   颜色每通道漂移 ≤ 2 —— 拖一下再拖回来不会跳色。
   跳过奇异点：l=0/l=100 时饱和度无定义，s=0 时色相无定义。 */
check('HSL 往返不跳色（滑块网格采样）', (function () {
  for (var h = 0; h < 360; h += 30) {
    for (var s = 20; s <= 100; s += 20) {
      for (var l = 10; l <= 90; l += 10) {
        var c1 = T.hexToRgb(T.hslToHex(h, s, l));
        var q = T.hexToHsl(T.rgbToHex(c1.r, c1.g, c1.b));
        var c2 = T.hexToRgb(T.hslToHex(q.h, q.s, q.l));
        if (Math.abs(c1.r - c2.r) > 2 || Math.abs(c1.g - c2.g) > 2 || Math.abs(c1.b - c2.b) > 2) return false;
      }
    }
  }
  return true;
})());
check('灰区色相无定义是正常行为', (function () {
  var q = T.hexToHsl(T.hslToHex(210, 0, 50));
  return q.s === 0 && q.l === 50; /* 色相丢失，但明度饱和度不丢 */
})());

console.log('\n【3】paletteToParams 分配约束');
T.PALETTES.forEach(function (p) {
  var q = T.paletteToParams(p);
  var meL = lum(q.meBg), themL = lum(q.themBg), bgL = lum(q.chatBg);
  var rMe = ratio(q.meBg, q.meFg);
  var rThem = ratio(q.themBg, q.themFg);

  check('[' + p.name + '] 六个颜色字段都产出', !!(q.meBg && q.meFg && q.themBg && q.themFg && q.borderColor && q.chatBg));
  check('[' + p.name + '] 我方文字对比度 ≥ 4.5', rMe >= 4.5, rMe.toFixed(2));
  check('[' + p.name + '] 对方文字对比度 ≥ 4.5', rThem >= 4.5, rThem.toFixed(2));
  check('[' + p.name + '] 背景比两个气泡都亮', bgL > meL && bgL > themL,
        'bg ' + bgL.toFixed(3) + ' / me ' + meL.toFixed(3) + ' / them ' + themL.toFixed(3));
  check('[' + p.name + '] 对方气泡比我方气泡亮（拉开层次）', themL > meL,
        themL.toFixed(3) + ' > ' + meL.toFixed(3));
});
check('paletteToParams(null) 返回 null', T.paletteToParams(null) === null);
check('paletteToParams({}) 返回 null', T.paletteToParams({}) === null);

console.log('\n【4】面板读写边界');
var root = dom.window.document.getElementById('wrap');
root.innerHTML = T.buildPanelHtml('');
var panel = root.querySelector('[data-mq-bt-panel]');

check('面板顶部胶囊行已删', panel.querySelectorAll('[data-mq-bt-preset]').length === 0);
check('每个颜色项都有取色器（共 6 项）', panel.querySelectorAll('[data-mq-bt-picker]').length === 6);
check('取色面板内色盘行保留', (function () {
  var pickers = panel.querySelectorAll('[data-mq-bt-picker]');
  return Array.prototype.every.call(pickers, function (pk) {
    return pk.querySelectorAll('[data-mq-bt-pal]').length === 6;
  });
})());

var p0 = T.readParams(panel);
check('未动过的描边色读回空串', p0.borderColor === '', JSON.stringify(p0.borderColor));
check('未动过的聊天背景读回空串', p0.chatBg === '', JSON.stringify(p0.chatBg));
check('必填色（我方背景）有默认值', T.isHex(p0.meBg), p0.meBg);

/* 显式选白色：应该被认下来，而不是被当成「没动过」 */
T.setColorValue(panel, 'borderColor', '#ffffff');
var p1 = T.readParams(panel);
check('显式选白色会被记住', p1.borderColor === '#ffffff', JSON.stringify(p1.borderColor));

/* 恢复默认：应清掉标记，回到空串语义 */
T.setColorValue(panel, 'borderColor', '');
var p2 = T.readParams(panel);
check('恢复默认后回到空串', p2.borderColor === '', JSON.stringify(p2.borderColor));

/* 非法 hex 应被拒绝 */
check('setColorValue 拒绝非法值', T.setColorValue(panel, 'meBg', 'not-a-color') === false);

/* HSL 滑块联动 */
(function () {
  var box = panel.querySelector('[data-mq-bt-picker="meBg"]');
  check('取色面板带 HSL 滑块组', !!box && !!box.querySelector('[data-mq-bt-hsl-ch="h"]') &&
        !!box.querySelector('[data-mq-bt-hsl-ch="s"]') && !!box.querySelector('[data-mq-bt-hsl-ch="l"]'));
  check('不再渲染系统取色器入口', !box.querySelector('[data-mq-bt-custom-color]') &&
        !box.querySelector('[data-mq-bt-custom-hex]'));
  T.syncHslSliders(panel, 'meBg');
  var hh = Number(box.querySelector('[data-mq-bt-hsl-ch="h"]').value);
  var ss = Number(box.querySelector('[data-mq-bt-hsl-ch="s"]').value);
  var ll = Number(box.querySelector('[data-mq-bt-hsl-ch="l"]').value);
  var back = T.hslToHex(hh, ss, ll);
  var cur = T.readParams(panel).meBg;
  var a = T.hexToRgb(back), b = T.hexToRgb(cur);
  check('滑块反解回原色（±2 通道容差）',
        !!a && !!b && Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2,
        back + ' vs ' + cur);
})();

/* 套色盘不应动形状 */
var before = T.readParams(panel);
var col = T.paletteToParams(T.PALETTES[0]);
T.applyParamsToPanel(panel, Object.assign({}, before, col));
var after = T.readParams(panel);
check('套色盘后形状参数不变',
      after.radius === before.radius && after.padX === before.padX && after.borderW === before.borderW,
      'radius ' + after.radius + ' padX ' + after.padX);
check('套色盘后颜色确实变了', after.meBg === col.meBg, after.meBg);

console.log('\n' + '='.repeat(52));
console.log('通过 ' + OK + '，失败 ' + NO.length);
if (NO.length) { NO.forEach(function (n) { console.log('  ✗ ' + n); }); process.exit(1); }
console.log('全部通过 ✅');
