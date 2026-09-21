/**
 * miya-chat-ui-theme.js — 聊天 UI 主题（INS 高级软刊风）
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-chat-ui-theme';
  var THEMES = ['soft'];
  var current = 'soft';

  function getApp() {
    return document.getElementById('miya-chat-app');
  }

  function getStored() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'magazine' || v === 'cinema' || v === 'ins' || v === 'noir') return 'soft';
      return THEMES.indexOf(v) >= 0 ? v : 'soft';
    } catch (e) {
      return 'soft';
    }
  }

  function persist(theme) {
    /* 主题是纯字符串，不需要 JSON.stringify；失败时同样要上报，
       否则用户换了主题、下次打开又变回去，只会以为是「主题有 bug」。 */
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(STORAGE_KEY, String(theme));
    } else {
      try { localStorage.setItem(STORAGE_KEY, String(theme)); } catch (e) {}
    }
  }

  /*
   * 确保主题类落在 #miya-chat-app 上。
   *
   * 早先这里是「拿不到元素就 return」—— 但 init() 只在 DOMContentLoaded
   * 跑一次，那一刻 #miya-chat-app 若尚未就位（脚本拆分、延迟挂载、
   * 缓存导致执行顺序变化都会造成），类就【永久】加不上。
   * 后果不只是"主题没生效"：列表头像的 48×48 尺寸约束原先挂在
   * `.theme-soft` 下，类一缺，<img> 就没有尺寸，整页会被一张照片撑爆。
   *
   * 所以拿不到元素时要重试，而不是静默放弃。
   */
  var ensureTimer = 0;
  var ensureTries = 0;

  function applyClasses(theme) {
    var app = getApp();
    if (!app) {
      /* 元素未就位：轮询几次直到它出现（挂载完成即停） */
      if (ensureTimer || ensureTries > 40) return;
      ensureTimer = global.setTimeout(function () {
        ensureTimer = 0;
        ensureTries += 1;
        applyClasses(theme);
      }, 50);
      return;
    }
    ensureTries = 0;
    /*
     * 直接 add，不要在 add 之前 remove 同一个类。
     *
     * 原来写成「先 remove('theme-soft','theme-ins') 再 add(...)」，
     * 于是中途存在一个「两个类都不在」的瞬间。如果浏览器恰好在这一帧
     * 重算样式（重排 / 触发动画 / 别处的 rAF），列表头像会短暂失去
     * 48×48 约束 —— 大图会瞬间把布局撑开，且不保证能恢复。
     * 本文件是唯一会写这两个类的地方，没有需要"先摘掉再戴"的场景。
     */
    app.classList.add('theme-soft', 'theme-ins');
    app.setAttribute('data-chat-ui', theme);
  }

  function apply(theme, opts) {
    opts = opts || {};
    if (THEMES.indexOf(theme) < 0) theme = 'soft';
    var prev = current;
    current = theme;
    persist(theme);
    applyClasses(theme);
    if (global.miyaChatApp && typeof global.miyaChatApp.onUiThemeChange === 'function') {
      global.miyaChatApp.onUiThemeChange(theme, prev);
    }
  }

  function init() {
    apply(getStored(), { animate: false });
  }

  /* 注：原 global.miyaChatUiTheme 导出（init/get/apply/toggle/THEMES）无任何外部引用，
     v36 批次 4 移除。内部 init/apply/THEMES 仍被本文件与 DOMContentLoaded 引导使用，
     故保留；本模块通过 applyClasses 直接作用于 #miya-chat-app 达成效果。 */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
