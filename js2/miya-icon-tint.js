/**
 * Miya 桌面图标着色 · 主屏/程序坞图标底板换色（HSL 长条滑条），透明度不变
 *
 * 实现原理：桌面图标底板颜色在 8 处 CSS 中统一为
 *   rgba(var(--miya-icon-plate-c, 255, 255, 255), var(--miya-icon-plate-a, 0.30))
 * 默认 --miya-icon-plate-c 未定义 = 纯白（原生外观）。本模块只在开启后把
 * HSL 滑条换算出的 RGB 三元组写到 documentElement 的 --miya-icon-plate-c，
 * 透明度变量 --miya-icon-plate-a 全程不动。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-icon-tint-v1';
  var STYLE_ID = 'miya-icon-tint-style';

  var DEFAULTS = {
    enabled: false,
    h: 0, s: 0, l: 100   /* 默认 = 纯白（rgb 255,255,255），等同原生 */
  };

  var LIMITS = { h: [0, 360], s: [0, 100], l: [0, 100] };
  var UNITS = { h: '', s: '%', l: '%' };

  var stateCache = null;

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    if (global.miyaToast && typeof global.miyaToast.show === 'function') {
      global.miyaToast.show(msg);
      return;
    }
    if (global.miyaChatApp && global.miyaChatApp.toast) {
      global.miyaChatApp.toast(msg);
      return;
    }
    var el = document.createElement('div');
    el.className = 'qq-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2400);
  }

  function clampNum(v, lo, hi, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return Math.round(n);
  }

  function normalizeState(raw) {
    var d = DEFAULTS;
    if (!raw || typeof raw !== 'object') return Object.assign({}, d);
    return {
      enabled: !!raw.enabled,
      h: clampNum(raw.h, LIMITS.h[0], LIMITS.h[1], d.h),
      s: clampNum(raw.s, LIMITS.s[0], LIMITS.s[1], d.s),
      l: clampNum(raw.l, LIMITS.l[0], LIMITS.l[1], d.l)
    };
  }

  function readStorage() {
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var synced = global.miyaSyncReadJsonKey(STORAGE_KEY);
      if (synced && typeof synced === 'object') return synced;
    }
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      if (global.miyaLsIsIdbPlaceholder && global.miyaLsIsIdbPlaceholder(raw)) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(state) {
    if (!state) return;
    if (typeof global.miyaSyncFlushJsonKey === 'function') {
      global.miyaSyncFlushJsonKey(STORAGE_KEY, state);
      return;
    }
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      global.miyaWriteLsJsonKey(STORAGE_KEY, state).catch(function () {});
      return;
    }
    var str = '';
    try { str = JSON.stringify(state); } catch (eStr) { return; }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(STORAGE_KEY, str);
    } else {
      try { global.localStorage.setItem(STORAGE_KEY, str); } catch (e) {}
    }
  }

  function getState() {
    if (!stateCache) stateCache = normalizeState(readStorage());
    return Object.assign({}, stateCache);
  }

  function saveState(patch) {
    var next = normalizeState(Object.assign({}, getState(), patch || {}));
    stateCache = next;
    writeStorage(next);
    return next;
  }

  /** HSL → {r,g,b}（0-255 整数） */
  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    function k(n) { return (n + h / 30) % 12; }
    var a = s * Math.min(l, 1 - l);
    function f(n) {
      return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    }
    return {
      r: Math.round(f(0) * 255),
      g: Math.round(f(8) * 255),
      b: Math.round(f(4) * 255)
    };
  }

  function rgbTriple(st) {
    var c = hslToRgb(st.h, st.s, st.l);
    return c.r + ', ' + c.g + ', ' + c.b;
  }

  function hslCss(st) {
    return 'hsl(' + st.h + ', ' + st.s + '%, ' + st.l + '%)';
  }

  function apply(st) {
    st = normalizeState(st || getState());
    stateCache = st;
    var root = document.documentElement;
    if (st.enabled) {
      root.style.setProperty('--miya-icon-plate-c', rgbTriple(st));
    } else {
      root.style.removeProperty('--miya-icon-plate-c');
    }
    return st;
  }

  /* ── 面板 ── */

  /* 预览用通用线性图标（与桌面真实图标同构：52px 圆角底板 + 18px 线性 svg） */
  var PREVIEW_ICONS = [
    /* 消息 */ '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    /* 相册 */ '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    /* 设置 */ '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    /* 钱包 */ '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="16" cy="14" r="1" fill="currentColor"/></svg>'
  ];

  function buildPreviewHtml() {
    return '<div class="mit-preview-stage">' +
      '<div class="mit-preview-desk">' +
        PREVIEW_ICONS.map(function (svg, i) {
          return '<div class="mit-preview-cell">' +
            '<span class="mit-preview-ic"><span class="mit-preview-plate">' + svg + '</span></span>' +
            '<span class="mit-preview-lbl">' + ['消息', '相册', '设置', '钱包'][i] + '</span>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<p class="mit-preview-note">底板颜色实时预览 · 图标与底板透明度保持不变</p>' +
    '</div>';
  }

  function unitFor(key) { return UNITS[key] || ''; }

  function rangeRow(label, key, val) {
    var lim = LIMITS[key];
    return '<label class="mib-range">' +
      '<span class="mib-range__name">' + esc(label) + '</span>' +
      '<input type="range" class="mit-range__input" data-mit-key="' + key + '"' +
        ' min="' + lim[0] + '" max="' + lim[1] + '" step="1" value="' + val + '">' +
      '<span class="mib-range__val" data-mit-val="' + key + '">' + val + unitFor(key) + '</span>' +
    '</label>';
  }

  function buildPanelHtml(st) {
    st = normalizeState(st || getState());
    var css = ':root { --miya-icon-plate-c: ' + rgbTriple(st) + '; }';
    return '<div class="mi-bf-wrap mi-bf-wrap--mit" data-mit-root>' +
      '<p class="mi-me-lead">更换主屏与程序坞图标底板的颜色，图标透明度保持不变</p>' +
      '<div class="mib-switch-row">' +
        '<span class="mib-switch-row__label">启用图标着色</span>' +
        '<button type="button" class="mib-switch' + (st.enabled ? ' is-on' : '') + '" data-mit-toggle role="switch" aria-checked="' + (st.enabled ? 'true' : 'false') + '" aria-label="启用图标着色"><span class="mib-switch__knob"></span></button>' +
      '</div>' +
      '<div class="mi-bf-block mi-bf-block--preview">' +
        '<span class="mi-bf-block__label">实时预览</span>' +
        buildPreviewHtml() +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<div class="mi-bf-block__head">' +
          '<span class="mi-bf-block__label">底板颜色</span>' +
          '<span class="mit-chip" data-mit-chip style="background:' + hslCss(st) + '"></span>' +
        '</div>' +
        rangeRow('色相', 'h', st.h) +
        rangeRow('饱和度', 's', st.s) +
        rangeRow('亮度', 'l', st.l) +
      '</div>' +
      '<div class="mi-btn-row">' +
        '<button type="button" class="mi-pill mi-pill--dark" data-mit-apply>应用图标颜色</button>' +
        '<button type="button" class="mi-pill mi-pill--ghost" data-mit-reset>重置默认</button>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">生成的 CSS</span>' +
        '<textarea class="mi-input mi-input--code mi-input--readonly" data-mit-css rows="3" readonly tabindex="-1">' + esc(css) + '</textarea>' +
      '</div>' +
    '</div>';
  }

  function hydratePreview(root, st) {
    if (!root) return;
    var stage = root.querySelector('.mit-preview-stage');
    if (!stage) return;
    var el = document.getElementById('mit-preview-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'mit-preview-style';
      document.head.appendChild(el);
    }
    /* 变量定义在预览容器上：预览始终跟随滑条（与开关无关），
       且不会触碰 html 根上的同名变量 —— 真实桌面只受 apply() 控制 */
    el.textContent = '.mit-preview-desk { --miya-icon-plate-c: ' + rgbTriple(st) + '; }';
  }

  function copyText(text) {
    var t = String(text || '');
    if (!t) return Promise.reject(new Error('empty'));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  var persistTimer = null;

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      writeStorage(getState());
    }, 250);
  }

  function handleControl(root, key, raw) {
    if (!key) return;
    var patch = {};
    patch[key] = Number(raw);
    var st = saveState(patch);

    var valEl = root.querySelector('[data-mit-val="' + key + '"]');
    if (valEl) valEl.textContent = st[key] + unitFor(key);

    var chip = root.querySelector('[data-mit-chip]');
    if (chip) chip.style.background = hslCss(st);

    var cssBox = root.querySelector('[data-mit-css]');
    if (cssBox) cssBox.value = ':root { --miya-icon-plate-c: ' + rgbTriple(st) + '; }';

    hydratePreview(root, st);
    schedulePersist();
    if (getState().enabled) apply(getState());
  }

  function bindPanelRoot(root, onReset) {
    if (!root || root.dataset.mitBound) {
      if (root) hydratePreview(root, getState());
      return;
    }
    root.dataset.mitBound = '1';

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-mit-toggle]')) {
        var next = saveState({ enabled: !getState().enabled });
        apply(next);
        var btn = root.querySelector('[data-mit-toggle]');
        if (btn) {
          btn.classList.toggle('is-on', next.enabled);
          btn.setAttribute('aria-checked', next.enabled ? 'true' : 'false');
        }
        toast(next.enabled ? '图标着色已开启' : '图标着色已关闭，已恢复默认');
        return;
      }

      /* 应用按钮：一键「开启 + 保存 + 上屏 + 刷新预览」 */
      if (e.target.closest('[data-mit-apply]')) {
        var applied = saveState({ enabled: true });
        apply(applied);
        hydratePreview(root, applied);
        var toggleBtn = root.querySelector('[data-mit-toggle]');
        if (toggleBtn) {
          toggleBtn.classList.add('is-on');
          toggleBtn.setAttribute('aria-checked', 'true');
        }
        toast('图标颜色已应用');
        return;
      }

      if (e.target.closest('[data-mit-reset]')) {
        stateCache = normalizeState(null);
        writeStorage(stateCache);
        apply(getState());
        if (typeof onReset === 'function') onReset();
        toast('已恢复默认图标底板');
        return;
      }
    });

    /* input + change 双监听：部分移动端 WebView 拖动 range 只派发 change */
    root.addEventListener('input', function (e) {
      var inp = e.target.closest('[data-mit-key]');
      if (!inp) return;
      handleControl(root, inp.getAttribute('data-mit-key'), inp.value);
    });
    root.addEventListener('change', function (e) {
      var inp = e.target.closest('[data-mit-key]');
      if (!inp) return;
      handleControl(root, inp.getAttribute('data-mit-key'), inp.value);
    });

    hydratePreview(root, getState());
  }

  function init() {
    apply(getState());
  }

  global.MiyaIconTint = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    getState: getState,
    saveState: saveState,
    apply: apply,
    buildPanelHtml: buildPanelHtml,
    bindPanelRoot: bindPanelRoot,
    hslToRgb: hslToRgb,
    toast: toast
  };

  if (global.miyaRegisterKvStore) {
    global.miyaRegisterKvStore({
      whenReady: function () { getState(); return Promise.resolve(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
