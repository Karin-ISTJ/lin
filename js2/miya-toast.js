/*
 * 全局轻提示（toast）。
 *
 * ── 为什么要单独抽出来 ──────────────────────────────────────────
 *
 * 原先这个函数是 `miya-settings-app.js` 里的私有函数 `toast()`，
 * 只通过 `global.miyaSettingsApp.toast` 暴露。这带来两个问题：
 *
 *   1. 全项目至少 5 处调用方为了弹一行字，要先判断「设置 App 是否已加载」。
 *      而设置 App 是一个很重的模块，聊天页早期根本不该依赖它。
 *   2. `miya-chat-backups.js:245` 与 `miya-storage.js:50` 早就在调
 *      `global.miyaToast(msg)` —— 但这个全局函数**全项目从未定义过**。
 *      两处 `typeof === 'function'` 守卫让它们静默失效：
 *      备份失败的提示、存储写满的提示，用户从来就看不到。
 *
 * 现在把 toast 提成独立模块，在任何脚本之前加载，
 * 上面两个「哑掉」的提示顺带就修好了。
 *
 * ── 与旧行为保持一致 ────────────────────────────────────────────
 *
 * 仍是 `.ins-toast` 类名 + 2400ms 自动消失（样式在 css/miya-apps.css:2558），
 * 所以视觉上与原设置 App 的 toast 完全相同，不会出现「换个地方弹就不一样」。
 */
(function (global) {
  'use strict';

  var DEFAULT_DURATION = 2400;
  var MAX_VISIBLE = 3;

  /*
   * 同一条消息短时间重复时不再叠一个新的 —— 例如网络抖动时
   * 连续三次请求失败，用户不该看到三个一模一样的浮层摞在一起。
   */
  var lastText = '';
  var lastAt = 0;
  var DEDUP_GAP = 600;

  function miyaToast(msg, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var text = msg == null ? '' : String(msg);
    if (!text) return null;

    var now = Date.now();
    if (text === lastText && now - lastAt < DEDUP_GAP) return null;
    lastText = text;
    lastAt = now;

    var duration = Number(opts.duration);
    if (!Number.isFinite(duration) || duration <= 0) duration = DEFAULT_DURATION;

    var div;
    try {
      div = document.createElement('div');
      div.className = 'ins-toast';
      div.textContent = text;
      /* 兜底提示（存储写满等）走的是同一套样式，
         但要压在普通 toast 之上，免得被别的浮层盖住 —— 那类消息不能丢。 */
      if (opts.priority) div.style.zIndex = '9600';
      document.body.appendChild(div);
    } catch (e) {
      return null;
    }

    /*
     * 同时可见数量上限：极端情况下（例如批量导入时每行都报一次错）
     * 不设限会让屏幕上糊满浮层。超出的直接把最早那个撤掉。
     */
    try {
      var live = document.body.querySelectorAll('.ins-toast');
      if (live.length > MAX_VISIBLE) {
        for (var i = 0; i <= live.length - MAX_VISIBLE - 1; i++) {
          try { live[i].remove(); } catch (e2) {}
        }
      }
    } catch (e3) {}

    setTimeout(function () {
      try { div.remove(); } catch (e4) {}
    }, duration);

    return div;
  }

  global.miyaToast = miyaToast;

  /*
   * 兼容层：旧代码一律写 `global.miyaSettingsApp.toast(...)`。
   * 设置 App 被删除后这些调用点会全部改掉，但万一有遗漏，
   * 这层 shim 保证它们仍然能弹出来，而不是静默失效。
   */
  if (!global.miyaSettingsApp) {
    global.miyaSettingsApp = {
      open: function () { return false; },
      close: function () {},
      toast: miyaToast
    };
  } else if (typeof global.miyaSettingsApp.toast !== 'function') {
    global.miyaSettingsApp.toast = miyaToast;
  }
})(typeof window !== 'undefined' ? window : globalThis);
