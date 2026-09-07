/*!
 * miya-edge-back-gesture.js
 * 屏幕左边缘右滑 = App 内"返回上一页"，而不是触发浏览器的"退出网页"手势。
 *
 * 原理：
 * 1. 只在触摸起点位于屏幕最左侧一小段区域（EDGE_ZONE）时才介入，
 *    避免影响页面里其他左右滑动的组件（相册、轮播等）。
 * 2. 一旦判定为"从边缘向右滑动"，立即 preventDefault，阻断浏览器/系统
 *    自带的边缘返回手势（那个会直接退出网页的手势）。
 * 3. 手指抬起时，如果滑动距离超过阈值，就在当前可见的界面里找到
 *    "最内层"的返回按钮（页面里所有返回按钮的 aria-label 都含"返回"），
 *    模拟点击它，等效于用户自己点了返回。
 * 4. 如果当前没有任何可见的返回按钮（比如已经在最外层主屏），则什么都不做，
 *    不会导致网页被退出。
 */
(function () {
  'use strict';

  var EDGE_ZONE = 24;           // 触摸起点必须在左边缘多少 px 以内才算"边缘滑动"
  var DECIDE_THRESHOLD = 10;    // 移动超过多少 px 后才判断意图（横滑 or 竖滑）
  var TRIGGER_THRESHOLD = 60;   // 横向滑动超过多少 px 才真正触发"返回"
  var MAX_VERTICAL_RATIO = 0.7; // 竖直位移相对水平位移的容忍比例，超过就当成上下滚动

  var state = null;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var node = el.parentElement;
    while (node) {
      var ns = window.getComputedStyle(node);
      if (ns.display === 'none' || ns.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  }

  function depthOf(el) {
    var d = 0, node = el;
    while (node) { d++; node = node.parentElement; }
    return d;
  }

  // 页面内所有"返回"按钮都用 aria-label="返回xxx" 标注，直接用这个通用选择器，
  // 不用逐一维护每个子应用各自的返回按钮 id/class。
  function pickBackTarget() {
    var candidates = Array.prototype.slice
      .call(document.querySelectorAll('[aria-label*="返回"]'))
      .filter(isVisible);
    if (!candidates.length) return null;
    // 多个返回按钮同时可见时（嵌套页面），优先点"层级最深"的那个，
    // 即当前最上层子页面的返回按钮，而不是外层应用的返回主屏按钮。
    candidates.sort(function (a, b) { return depthOf(b) - depthOf(a); });
    return candidates[0];
  }

  function reset() { state = null; }

  function onTouchStart(e) {
    if (e.touches.length !== 1) { reset(); return; }
    var t = e.touches[0];
    if (t.clientX > EDGE_ZONE) { reset(); return; }
    state = {
      startX: t.clientX,
      startY: t.clientY,
      decided: false,
      active: false,
      cancelled: false
    };
  }

  function onTouchMove(e) {
    if (!state || state.cancelled) return;
    if (e.touches.length !== 1) { state.cancelled = true; return; }
    var t = e.touches[0];
    var dx = t.clientX - state.startX;
    var dy = t.clientY - state.startY;

    if (!state.decided) {
      if (Math.abs(dx) < DECIDE_THRESHOLD && Math.abs(dy) < DECIDE_THRESHOLD) return;
      if (dx > 0 && Math.abs(dy) <= Math.abs(dx) * MAX_VERTICAL_RATIO) {
        state.decided = true;
        state.active = true;
      } else {
        state.cancelled = true;
        return;
      }
    }

    if (state.active && e.cancelable) {
      // 关键一步：阻止浏览器/系统把这个手势当成"返回上一页/退出网页"
      e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (!state || state.cancelled || !state.active) { reset(); return; }
    var touch = e.changedTouches && e.changedTouches[0];
    var dx = touch ? touch.clientX - state.startX : 0;
    reset();
    if (dx >= TRIGGER_THRESHOLD) {
      var target = pickBackTarget();
      if (target) target.click();
    }
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', reset, { passive: true });
})();
