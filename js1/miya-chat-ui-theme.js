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

  function applyClasses(theme) {
    var app = getApp();
    if (!app) return;
    app.classList.remove('theme-soft', 'theme-ins');
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
