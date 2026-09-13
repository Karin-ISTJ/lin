/**
 * Miya 聊天 App · 四屏美化（主题 / 装饰 / 自定义 CSS / 预设）
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-chat-app-beautify-v1';
  var PRESETS_LS = 'miya-chat-app-beautify-presets-v1';
  var STYLE_ID = 'miya-chat-app-bf-style';
  var PREVIEW_STYLE_ID = 'miya-chat-app-bf-preview-style';
  var GUARD_STYLE_ID = 'miya-chat-app-bf-guard';

  var BUILTIN_THEMES = [
    { id: 'default-orange', label: '默认橙', sub: '暖灰底 · 珊瑚点缀 · 当前默认' }
  ];

  var THEME_CLASS_PREFIX = 'chat-bf-theme-';
  var stateCache = null;
  var presetsCache = null;
  var presetsReady = null;

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
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

  function getApp() {
    return document.getElementById('miya-chat-app');
  }

  function defaultState() {
    return {
      themeId: 'default-orange',
      customCss: '',
      presetName: '',
      decoItems: []
    };
  }

  /**
   * 装饰项的数值字段此前只有 opacity 做了钳制，x/y/w/h/z 一律裸奔进 style 属性。
   * 实测（Node 沙箱驱动真实 normalizeDecoItem）确认四类缺陷：
   *   x: Infinity  → 生成 left:Infinitypx（Number(Infinity) 为真，`|| 0` 兜不住）
   *   x: 1e30      → 生成 left:1e+30px（非法 CSS 值）
   *   h: -50       → 负尺寸
   *   opacity: NaN → Math.min(1, Math.max(0, NaN)) 结果仍是 NaN
   * 另：w=0 会被 `|| 80` 悄悄改成 80（用户想隐藏却变成 80 宽）。
   * 这里统一补上「有限数 + 值域」双重校验。
   *
   * 注：XSS 走不通 —— 字符串会被 Number() 转成 NaN 并回落默认值，属性无法突破；
   *     所以这是健壮性/数据合法性修复，不是安全漏洞修复。
   */
  var DECO_LIMITS = {
    pos: 4000,   /* 坐标绝对值上限：远超任何现实屏幕尺寸，纯防溢出 */
    size: 4000,  /* 尺寸上限 */
    minSize: 0,  /* 允许 0（0 表示该方向不渲染），但不许负数 */
    maxZ: 999
  };

  /** 取有限数值；非法（NaN/Infinity/非数字）时返回 fallback */
  function finiteNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /** 有限数值 + 钳制到 [lo, hi] */
  function clampNum(v, lo, hi, fallback) {
    var n = finiteNum(v, fallback);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /** 装饰图 URL 走 store 的图片白名单（store 先于本模块加载）；store 未就绪则退回本地兜底 */
  function safeDecoUrl(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var st = global.miyaChatStore;
    if (st && typeof st.sanitizeImageUrl === 'function') return st.sanitizeImageUrl(s);
    if (!s) return '';
    if (/[\u0000-\u001f\u007f]/.test(s)) return '';
    if (/^(?:https?:\/\/|blob:)/i.test(s)) return s.length <= 2048 ? s : '';
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
    return s.length <= 2048 ? s : '';
  }

  function normalizeDecoItem(raw, idx) {
    if (!raw || typeof raw !== 'object') return null;
    var page = String(raw.page || 'all').trim();
    if (['all', 'msg', 'feed', 'contacts', 'mine'].indexOf(page) < 0) page = 'all';
    var L = DECO_LIMITS;
    return {
      id: String(raw.id || 'deco-' + (idx != null ? idx : Date.now())),
      page: page,
      url: safeDecoUrl(raw.url),
      x: clampNum(raw.x, -L.pos, L.pos, 0),
      y: clampNum(raw.y, -L.pos, L.pos, 0),
      /* 尺寸用「缺省才回退」，不再用 `|| 80` —— 0 是用户的有效意图，不该被改写 */
      w: clampNum(raw.w, L.minSize, L.size, 80),
      h: clampNum(raw.h, L.minSize, L.size, 80),
      z: clampNum(raw.z, 0, L.maxZ, 1),
      opacity: clampNum(raw.opacity, 0, 1, 1)
    };
  }

  function normalizeState(raw) {
    var d = defaultState();
    if (!raw || typeof raw !== 'object') return Object.assign({}, d, { decoItems: [] });
    var themeId = String(raw.themeId || d.themeId);
    if (BUILTIN_THEMES.every(function (t) { return t.id !== themeId; })) themeId = d.themeId;
    var items = Array.isArray(raw.decoItems)
      ? raw.decoItems.map(normalizeDecoItem).filter(Boolean)
      : [];
    return {
      themeId: raw.customCss && String(raw.customCss).trim() ? themeId : themeId,
      customCss: String(raw.customCss || ''),
      presetName: String(raw.presetName || '').trim(),
      decoItems: items
    };
  }

  function readStorage() {
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var synced = global.miyaSyncReadJsonKey(STORAGE_KEY);
      if (synced && typeof synced === 'object') return synced;
    }
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
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
      try { localStorage.setItem(STORAGE_KEY, str); } catch (e) {}
    }
  }

  function appBeautifyScore(raw) {
    if (!raw || typeof raw !== 'object') return 0;
    var score = 0;
    var css = String(raw.customCss || '');
    if (css.trim()) score += Math.min(500, css.length);
    if (raw.themeId && raw.themeId !== 'default-orange') score += 20;
    if (Array.isArray(raw.decoItems)) score += raw.decoItems.length * 15;
    if (raw.presetName) score += 10;
    return score;
  }

  function hydrateAppBeautifyFromIdb() {
    if (typeof global.miyaReadLsJsonKey !== 'function') return Promise.resolve(getState());
    return global.miyaReadLsJsonKey(STORAGE_KEY, null).then(function (v) {
      if (!v || typeof v !== 'object') return getState();
      var next = normalizeState(v);
      var cur = stateCache ? normalizeState(stateCache) : defaultState();
      if (appBeautifyScore(next) >= appBeautifyScore(cur)) {
        stateCache = next;
        apply(next);
      }
      return getState();
    }).catch(function () {
      return getState();
    });
  }

  function getState() {
    if (!stateCache) stateCache = normalizeState(readStorage());
    return Object.assign({}, stateCache, { decoItems: (stateCache.decoItems || []).slice() });
  }

  function saveState(patch) {
    var next = normalizeState(Object.assign({}, getState(), patch || {}));
    if (patch && patch.decoItems) {
      next.decoItems = patch.decoItems.map(normalizeDecoItem).filter(Boolean);
    }
    stateCache = next;
    writeStorage(next);
    return next;
  }

  function allThemeClasses() {
    return BUILTIN_THEMES.map(function (t) { return THEME_CLASS_PREFIX + t.id; });
  }

  function injectGuardCss() {
    var css = [
      '/* miya chat-app beautify guard */',
      '#miya-chat-app > .soft-deco,',
      '#miya-chat-app > .soft-deco *,',
      '#miya-chat-app > .chat-app-deco,',
      '#miya-chat-app > .chat-app-deco * { pointer-events: none !important; }',
      '#miya-chat-app .chat-app-deco__item[data-deco-editing] { pointer-events: auto !important; }'
    ].join('\n');
    var el = document.getElementById(GUARD_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = GUARD_STYLE_ID;
      document.body.appendChild(el);
    }
    el.textContent = css;
  }

  function scopeCss(css, rootId) {
    var s = String(css || '');
    rootId = rootId || '#miya-chat-app';
    if (rootId === '#mq-cab-preview') {
      s = s.replace(/#miya-chat-app\b/g, '#mq-cab-preview');
    }
    s = s.replace(/#mq-cab-preview\b/g, rootId);
    return s;
  }

  function injectCustomCss(css) {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.body.appendChild(el);
    }
    el.textContent = scopeCss(css, '#miya-chat-app');
    injectGuardCss();
    return el;
  }

  function injectPreviewCss(css) {
    var el = document.getElementById(PREVIEW_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = PREVIEW_STYLE_ID;
      document.body.appendChild(el);
    }
    el.textContent = scopeCss(css, '#mq-cab-preview');
    return el;
  }

  function clearPreviewCss() {
    var el = document.getElementById(PREVIEW_STYLE_ID);
    if (el) el.textContent = '';
  }

  function pageClassFor(page) {
    if (page === 'msg') return 'qq-page--msg';
    if (page === 'feed') return 'qq-page--feed';
    if (page === 'contacts') return 'qq-page--contacts';
    if (page === 'mine') return 'qq-page--mine';
    return '';
  }

  function renderDecoLayer(app, state, previewRoot) {
    var host = previewRoot
      ? previewRoot.querySelector('[data-chat-app-deco]')
      : (app && app.querySelector('[data-chat-app-deco]'));
    if (!host) return;
    var builtin = host.querySelectorAll('.chat-app-deco--builtin-doodle-msg, .chat-app-deco--builtin-doodle-mine');
    var builtinHtml = '';
    builtin.forEach(function (el) { builtinHtml += el.outerHTML; });
    var activePage = previewRoot
      ? (previewRoot.getAttribute('data-cab-preview-tab') || 'msg')
      : (app && app.querySelector('.qq-page.is-active'))
        ? (app.querySelector('.qq-page.is-active').getAttribute('data-qq-tab') || 'msg')
        : 'msg';
    var items = (state && state.decoItems) || [];
    host.innerHTML = builtinHtml + items.map(function (item) {
      if (!item.url) return '';
      if (item.page !== 'all' && item.page !== activePage) return '';
      return '<div class="chat-app-deco__item" data-deco-id="' + esc(item.id) + '" style="' +
        'left:' + item.x + 'px;top:' + item.y + 'px;width:' + item.w + 'px;height:' + item.h + 'px;' +
        'z-index:' + item.z + ';opacity:' + item.opacity + '">' +
        '<img src="' + esc(item.url) + '" alt="" draggable="false">' +
      '</div>';
    }).join('');
  }

  function applyThemeClasses(app, state) {
    if (!app) return;
    allThemeClasses().forEach(function (cls) { app.classList.remove(cls); });
    var tid = state.themeId || 'default-orange';
    app.classList.add(THEME_CLASS_PREFIX + tid);
    app.classList.toggle('chat-bf-has-custom-css', !!(state.customCss && state.customCss.trim()));
  }

  function apply(state) {
    state = normalizeState(state || getState());
    stateCache = state;
    var app = getApp();
    if (!app) return state;
    applyThemeClasses(app, state);
    injectCustomCss(state.customCss);
    renderDecoLayer(app, state);
    if (global.miyaChatApp && typeof global.miyaChatApp.refreshMineMenu === 'function') {
      global.miyaChatApp.refreshMineMenu();
    }
    return state;
  }

  function applyTheme(themeId) {
    saveState({ themeId: themeId, presetName: '' });
    apply(getState());
    return getState();
  }

  /** 清除当前生效的聊天 App 美化（主题 / CSS / 装饰），预设库保留 */
  function clearCustomBeautify() {
    clearPreviewCss();
    var next = saveState({
      themeId: 'default-orange',
      customCss: '',
      presetName: '',
      decoItems: []
    });
    apply(next);
    return next;
  }

  function getFullSourcePack() {
    if (global.MIYA_CHAT_APP_BEAUTIFY_SOURCE_REF) return String(global.MIYA_CHAT_APP_BEAUTIFY_SOURCE_REF);
    return '# Miya 聊天 App 美化参考（模块未加载）\n#miya-chat-app';
  }

  function buildSourceReferenceHtml() {
    var src = getFullSourcePack();
    return '<div class="mi-bf-block mi-bf-block--copy">' +
      '<span class="mi-bf-block__label">选择器参考</span>' +
      '<textarea class="mi-input mi-input--code mi-input--readonly" data-cab-src-readonly rows="14" readonly tabindex="-1">' + esc(src) + '</textarea>' +
      '<div class="mi-btn-row" style="margin-top:10px">' +
        '<button type="button" class="mi-pill mi-pill--dark" data-cab-copy-src>复制源码</button>' +
        '<button type="button" class="mi-pill" data-cab-download-src>下载 txt</button>' +
      '</div>' +
    '</div>';
  }

  function buildPreviewHtml(activeTab) {
    activeTab = activeTab || 'msg';
    return '<div class="cab-preview" id="mq-cab-preview" data-cab-preview-tab="' + esc(activeTab) + '">' +
      '<div class="chat-app-deco" data-chat-app-deco aria-hidden="true"></div>' +
      '<div class="cab-preview__tabs" role="tablist">' +
        ['msg', 'feed', 'contacts', 'mine'].map(function (tab) {
          var labels = { msg: '消息', feed: '动态', contacts: '联系人', mine: '我的' };
          return '<button type="button" class="cab-preview__tab' + (tab === activeTab ? ' is-active' : '') + '" data-cab-preview-tab="' + tab + '">' + labels[tab] + '</button>';
        }).join('') +
      '</div>' +
      '<div class="cab-preview__screen cab-preview__screen--' + esc(activeTab) + '">' +
        buildPreviewScreenHtml(activeTab) +
      '</div>' +
    '</div>';
  }

  function buildPreviewScreenHtml(tab) {
    if (tab === 'msg') {
      return '<div class="cab-mock cab-mock--msg">' +
        '<div class="cab-mock__head"><span class="cab-mock__title">消息</span><span class="cab-mock__btn">+</span></div>' +
        '<div class="cab-mock__search">搜索</div>' +
        '<div class="cab-mock__thread cab-mock__thread--pin"><span class="cab-mock__ava"></span><span class="cab-mock__body"><b>Vivian</b><small>今晚一起去看展吗？</small></span><span class="cab-mock__badge">2</span></div>' +
        '<div class="cab-mock__thread"><span class="cab-mock__ava"></span><span class="cab-mock__body"><b>阿宁</b><small>好的，明天见</small></span></div>' +
      '</div>';
    }
    if (tab === 'feed') {
      return '<div class="cab-mock cab-mock--feed">' +
        '<div class="cab-mock__head"><span class="cab-mock__title">动态</span></div>' +
        '<div class="cab-mock__feed-tabs"><span class="is-on">关注</span><span>推荐</span></div>' +
        '<div class="cab-mock__card"><div class="cab-mock__card-head"><span class="cab-mock__ava"></span><b>森林里的小鹿</b></div><p>生活的细碎美好都值得被记录</p><div class="cab-mock__img"></div></div>' +
      '</div>';
    }
    if (tab === 'contacts') {
      return '<div class="cab-mock cab-mock--contacts">' +
        '<div class="cab-mock__head"><span class="cab-mock__title">联系人</span></div>' +
        '<div class="cab-mock__quick"><span>新朋友</span><span>群聊</span></div>' +
        '<div class="cab-mock__letter">A</div>' +
        '<div class="cab-mock__thread"><span class="cab-mock__ava"></span><span class="cab-mock__body"><b>阿宁</b><small>ID · anning</small></span></div>' +
      '</div>';
    }
    return '<div class="cab-mock cab-mock--mine">' +
      '<div class="cab-mock__head"><span class="cab-mock__title">我的</span></div>' +
      '<div class="cab-mock__profile"><span class="cab-mock__ava cab-mock__ava--lg"></span><div><b>Echo</b><small>保持热爱，奔赴山海。</small></div></div>' +
      '<div class="cab-mock__stats"><span>268 动态</span><span>56 关注</span><span>342 粉丝</span></div>' +
    '</div>';
  }

  function buildThemePickerHtml(activeId) {
    return BUILTIN_THEMES.map(function (t) {
      var on = t.id === activeId;
      return '<button type="button" class="cab-theme-card' + (on ? ' is-active' : '') + '" data-cab-theme="' + esc(t.id) + '">' +
        '<span class="cab-theme-card__swatch cab-theme-card__swatch--' + esc(t.id) + '" aria-hidden="true"></span>' +
        '<strong>' + esc(t.label) + '</strong>' +
        '<small>' + esc(t.sub) + '</small>' +
      '</button>';
    }).join('');
  }

  function buildDecoListHtml(items) {
    items = items || [];
    if (!items.length) {
      return '<p class="mi-empty-hint cab-deco-empty">暂无装饰 · 可上传 PNG/SVG/JPG，自由定位</p>';
    }
    return '<div class="cab-deco-list">' + items.map(function (item, i) {
      return '<div class="cab-deco-row" data-cab-deco-row="' + esc(item.id) + '">' +
        '<div class="cab-deco-row__thumb" style="background-image:url(\'' + esc(item.url).replace(/['\\()\s]/g, '') + '\')"></div>' +
        '<div class="cab-deco-row__meta">' +
          '<span>页面：' + esc(item.page === 'all' ? '全部' : item.page) + '</span>' +
          '<span>位置 ' + item.x + ',' + item.y + ' · ' + item.w + '×' + item.h + '</span>' +
        '</div>' +
        '<button type="button" class="mi-pill mi-pill--ghost" data-cab-deco-del="' + esc(item.id) + '">删除</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  function buildPanelHtml(state) {
    state = normalizeState(state || getState());
    var activeTheme = state.themeId || 'default-orange';
    return '<div class="mi-bf-wrap mi-bf-wrap--cab" data-cab-root>' +
      '<p class="mi-me-lead">聊天 App 四屏美化 · 内置预设可随时切换，不影响下方自定义 CSS 与装饰</p>' +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">内置预设</span>' +
        '<p class="mi-bf-preview-hint">切换预设只改外观主题，自定义 CSS / 装饰 / 已存预设均保留</p>' +
        '<div class="cab-theme-grid" data-cab-themes>' + buildThemePickerHtml(activeTheme) + '</div>' +
      '</div>' +
      '<div class="mi-bf-block mi-bf-block--preview">' +
        '<span class="mi-bf-block__label">实时预览</span>' +
        '<p class="mi-bf-preview-hint">切换 Tab 预览四屏；编辑 CSS 时即时更新</p>' +
        '<div class="cab-preview-stage">' + buildPreviewHtml('msg') + '</div>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<div class="mi-bf-block__head">' +
          '<span class="mi-bf-block__label">自定义 CSS</span>' +
          '<button type="button" class="mi-pill mi-pill--ghost" data-cab-doc-import>快捷导入</button>' +
        '</div>' +
        '<textarea class="mi-input mi-input--code" data-cab-custom-css rows="10" placeholder="/* 建议以 #miya-chat-app 为作用域 */">' + esc(state.customCss) + '</textarea>' +
        '<div class="mi-btn-row" style="margin-top:10px">' +
          '<button type="button" class="mi-pill mi-pill--dark" data-cab-apply-css>应用 CSS</button>' +
          '<button type="button" class="mi-pill" data-cab-clear-css>清除 CSS</button>' +
        '</div>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">自定义装饰</span>' +
        '<p class="mi-bf-preview-hint">上传图片后可设页面、位置与尺寸（单位 px）</p>' +
        '<div class="cab-deco-form">' +
          '<select class="mi-input" data-cab-deco-page>' +
            '<option value="all">全部页面</option>' +
            '<option value="msg">消息</option>' +
            '<option value="feed">动态</option>' +
            '<option value="contacts">联系人</option>' +
            '<option value="mine">我的</option>' +
          '</select>' +
          '<div class="cab-deco-form__nums">' +
            '<label>x<input type="number" class="mi-input" data-cab-deco-x value="0" min="-4000" max="4000" step="1"></label>' +
            '<label>y<input type="number" class="mi-input" data-cab-deco-y value="0" min="-4000" max="4000" step="1"></label>' +
            '<label>宽<input type="number" class="mi-input" data-cab-deco-w value="72" min="0" max="4000" step="1"></label>' +
            '<label>高<input type="number" class="mi-input" data-cab-deco-h value="72" min="0" max="4000" step="1"></label>' +
            '<label>层级<input type="number" class="mi-input" data-cab-deco-z value="1" min="0" max="999" step="1"></label>' +
          '</div>' +
          '<button type="button" class="mi-pill mi-pill--dark" data-cab-deco-upload>上传装饰图</button>' +
          '<input type="file" accept="image/*" hidden data-cab-deco-file>' +
        '</div>' +
        '<div data-cab-deco-list>' + buildDecoListHtml(state.decoItems) + '</div>' +
      '</div>' +
      buildSourceReferenceHtml() +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">我的预设</span>' +
        '<p class="mi-bf-preview-hint">保存主题 + CSS + 装饰组合；读取后需点「应用 CSS」生效</p>' +
        '<select class="mi-input" data-cab-preset-pick>' + buildPresetSelectOptions(state.presetName) + '</select>' +
        '<div class="mi-btn-row" style="margin-top:10px">' +
          '<button type="button" class="mi-pill mi-pill--dark" data-cab-preset-save>保存预设</button>' +
          '<button type="button" class="mi-pill" data-cab-preset-load>读取预设</button>' +
          '<button type="button" class="mi-pill mi-pill--ghost" data-cab-preset-delete>删除预设</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function hydratePreview(root, state) {
    root = root && root.querySelector ? root.querySelector('[data-cab-root]') || root : null;
    if (!root) return;
    state = normalizeState(state || readPanelState(root));
    var preview = root.querySelector('#mq-cab-preview');
    if (!preview) return;
    allThemeClasses().forEach(function (cls) {
      preview.classList.remove(cls);
    });
    preview.classList.add(THEME_CLASS_PREFIX + (state.themeId || 'default-orange'));
    preview.classList.toggle('chat-bf-has-custom-css', !!(state.customCss && state.customCss.trim()));
    injectPreviewCss(state.customCss);
    renderDecoLayer(null, state, preview);
  }

  function readPanelState(root) {
    var css = root.querySelector('[data-cab-custom-css]');
    var pick = root.querySelector('[data-cab-preset-pick]');
    var cur = getState();
    return normalizeState({
      themeId: cur.themeId,
      customCss: css ? String(css.value || '') : cur.customCss,
      presetName: pick ? String(pick.value || '').trim() : cur.presetName,
      decoItems: cur.decoItems
    });
  }

  function normalizePresetRow(raw) {
    if (!raw || !raw.name) return null;
    var st = normalizeState(raw);
    return {
      name: String(raw.name).trim(),
      /* savedAt 只用于排序；`Number(x) || Date.now()` 兜得住 NaN 却兜不住 Infinity
         （Infinity 为真值），故补一次有限性校验。 */
      savedAt: finiteNum(raw.savedAt, Date.now()),
      themeId: st.themeId,
      customCss: st.customCss,
      decoItems: st.decoItems
    };
  }

  function hydratePresetsSync() {
    if (presetsCache) return presetsCache;
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var raw = global.miyaSyncReadJsonKey(PRESETS_LS);
      if (Array.isArray(raw)) {
        presetsCache = raw.map(normalizePresetRow).filter(Boolean);
        return presetsCache;
      }
    }
    return null;
  }

  function whenPresetsReady() {
    if (presetsReady) return presetsReady;
    var chain = typeof global.miyaReadLsJsonKey === 'function'
      ? global.miyaReadLsJsonKey(PRESETS_LS, [])
      : Promise.resolve([]);
    presetsReady = chain.then(function (parsed) {
      if (!Array.isArray(parsed)) parsed = [];
      presetsCache = parsed.map(normalizePresetRow).filter(Boolean);
      return presetsCache.slice();
    }).catch(function () {
      presetsCache = [];
      return [];
    });
    return presetsReady;
  }

  function loadPresets() {
    var hydrated = hydratePresetsSync();
    if (hydrated) return hydrated.slice();
    return [];
  }

  function persistPresets(list) {
    var prev = presetsCache;
    var prevReady = presetsReady;
    presetsCache = Array.isArray(list) ? list.slice() : [];
    presetsReady = null;

    if (typeof global.miyaWriteLsJsonKey !== 'function') {
      try {
        localStorage.setItem(PRESETS_LS, JSON.stringify(presetsCache));
      } catch (e) {
        /* 连 localStorage 都写不进：回滚缓存并显式失败，不再静默吞掉 */
        presetsCache = prev;
        presetsReady = prevReady;
        return Promise.reject(new Error('preset_persist_failed'));
      }
      return Promise.resolve(presetsCache.slice());
    }

    /* miyaWriteLsJsonKey 的契约是「失败 resolve(false)」而非 reject，
       早期这里只挂 .then() 无视入参，于是存储全挂时依然提示「预设已保存」，
       刷新后预设消失。现在显式检查返回值，失败即回滚缓存 + reject。 */
    return Promise.resolve(global.miyaWriteLsJsonKey(PRESETS_LS, presetsCache)).then(function (ok) {
      if (ok === false) {
        presetsCache = prev;
        presetsReady = prevReady;
        throw new Error('preset_persist_failed');
      }
      return presetsCache.slice();
    }, function () {
      presetsCache = prev;
      presetsReady = prevReady;
      throw new Error('preset_persist_failed');
    });
  }

  function buildPresetSelectOptions(selectedName) {
    var html = '<option value="">不使用预设</option>';
    loadPresets().forEach(function (p) {
      html += '<option value="' + esc(p.name) + '"' + (p.name === selectedName ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    });
    return html;
  }

  function refreshPresetSelect(root, selectedName) {
    var sel = root && root.querySelector('[data-cab-preset-pick]');
    if (!sel) return;
    sel.innerHTML = buildPresetSelectOptions(selectedName);
  }

  function findPreset(name) {
    var label = String(name || '').trim();
    if (!label) return null;
    return loadPresets().find(function (p) { return p.name === label; }) || null;
  }

  function savePreset(name, state) {
    var label = String(name || '').trim();
    if (!label) return Promise.reject(new Error('empty_name'));
    return whenPresetsReady().then(function (list) {
      var row = normalizePresetRow(Object.assign({ name: label, savedAt: Date.now() }, normalizeState(state)));
      var idx = list.findIndex(function (p) { return p.name === label; });
      if (idx >= 0) list[idx] = row;
      else list.unshift(row);
      return persistPresets(list).then(function () { return row; });
    });
  }

  function deletePreset(name) {
    var label = String(name || '').trim();
    if (!label) return Promise.reject(new Error('empty_name'));
    return whenPresetsReady().then(function (list) {
      var next = list.filter(function (p) { return p.name !== label; });
      if (next.length === list.length) return Promise.reject(new Error('not_found'));
      return persistPresets(next);
    });
  }

  function refreshDecoList(root, items) {
    var list = root && root.querySelector('[data-cab-deco-list]');
    if (list) list.innerHTML = buildDecoListHtml(items);
  }

  function bindPanelRoot(root, onChange) {
    root = root && root.querySelector ? root.querySelector('[data-cab-root]') || root : null;
    if (!root || root.dataset.cabBound) {
      if (root) hydratePreview(root);
      return;
    }
    root.dataset.cabBound = '1';

    var previewTimer = null;

    function notify() {
      hydratePreview(root);
      if (typeof onChange === 'function') onChange(readPanelState(root));
    }

    root.addEventListener('click', function (e) {
      var themeBtn = e.target.closest('[data-cab-theme]');
      if (themeBtn) {
        var tid = themeBtn.getAttribute('data-cab-theme');
        root.querySelectorAll('[data-cab-theme]').forEach(function (b) {
          b.classList.toggle('is-active', b === themeBtn);
        });
        saveState({ themeId: tid });
        apply(getState());
        notify();
        toast('已切换「' + (BUILTIN_THEMES.find(function (t) { return t.id === tid; }) || {}).label + '」');
        return;
      }

      var tabBtn = e.target.closest('[data-cab-preview-tab]');
      if (tabBtn && tabBtn.classList.contains('cab-preview__tab')) {
        var tab = tabBtn.getAttribute('data-cab-preview-tab');
        root.querySelectorAll('.cab-preview__tab').forEach(function (b) {
          b.classList.toggle('is-active', b === tabBtn);
        });
        var preview = root.querySelector('#mq-cab-preview');
        var screen = root.querySelector('.cab-preview__screen');
        if (preview) preview.setAttribute('data-cab-preview-tab', tab);
        if (screen) {
          screen.className = 'cab-preview__screen cab-preview__screen--' + tab;
          screen.innerHTML = buildPreviewScreenHtml(tab);
        }
        notify();
        return;
      }

      if (e.target.closest('[data-cab-apply-css]')) {
        var patch = readPanelState(root);
        saveState(patch);
        apply(getState());
        notify();
        toast('CSS 已应用');
        return;
      }

      if (e.target.closest('[data-cab-clear-css]')) {
        var ta = root.querySelector('[data-cab-custom-css]');
        if (ta) ta.value = '';
        saveState({ customCss: '', presetName: '' });
        apply(getState());
        notify();
        toast('已清除自定义 CSS');
        return;
      }

      if (e.target.closest('[data-cab-copy-src]')) {
        copyText(getFullSourcePack()).then(function () { toast('源码已复制'); }).catch(function () { toast('复制失败'); });
        return;
      }

      if (e.target.closest('[data-cab-download-src]')) {
        try {
          var blob = new Blob([getFullSourcePack()], { type: 'text/plain;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'miya聊天App美化-选择器参考.txt';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          toast('已下载 txt');
        } catch (err) {
          toast('下载失败');
        }
        return;
      }

      if (e.target.closest('[data-cab-doc-import]')) {
        var cssTa = root.querySelector('[data-cab-custom-css]');
        var docImp = global.miyaBeautifyDocImport;
        if (!docImp || !cssTa) return toast('导入模块未加载');
        docImp.pickAndImport(cssTa).then(function () {
          notify();
          toast('CSS 已导入');
        }).catch(function (err) {
          docImp.toastError(err, toast);
        });
        return;
      }

      if (e.target.closest('[data-cab-deco-upload]')) {
        var fileInp = root.querySelector('[data-cab-deco-file]');
        if (fileInp) fileInp.click();
        return;
      }

      var delDeco = e.target.closest('[data-cab-deco-del]');
      if (delDeco) {
        var did = delDeco.getAttribute('data-cab-deco-del');
        var cur = getState();
        var nextItems = (cur.decoItems || []).filter(function (x) { return x.id !== did; });
        saveState({ decoItems: nextItems });
        apply(getState());
        refreshDecoList(root, nextItems);
        notify();
        toast('装饰已删除');
        return;
      }

      if (e.target.closest('[data-cab-preset-save]')) {
        var pickSave = root.querySelector('[data-cab-preset-pick]');
        var defaultName = pickSave && pickSave.value ? pickSave.value : '';
        var promptFn = global.miyaDialog && global.miyaDialog.prompt
          ? global.miyaDialog.prompt.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(prompt(o.message || '名称', o.defaultValue || '')); };
        promptFn({ title: '保存预设', message: '为这套外观取个名字', defaultValue: defaultName }).then(function (name) {
          if (!name || !String(name).trim()) return;
          var st = readPanelState(root);
          return savePreset(String(name).trim(), st);
        }).then(function (row) {
          if (!row) return;
          saveState({ presetName: row.name });
          refreshPresetSelect(root, row.name);
          toast('预设已保存');
        }).catch(function (err) {
          if (!err || err.message === 'empty_name') return;
          toast(err.message === 'preset_persist_failed' ? '存储空间不足，预设未能保存' : '保存失败');
        });
        return;
      }

      if (e.target.closest('[data-cab-preset-load]')) {
        var sel = root.querySelector('[data-cab-preset-pick]');
        var pname = sel ? sel.value : '';
        if (!pname) return toast('请先选择预设');
        var preset = findPreset(pname);
        if (!preset) return toast('预设不存在');
        saveState({
          themeId: preset.themeId,
          customCss: preset.customCss,
          decoItems: preset.decoItems || [],
          presetName: pname
        });
        apply(getState());
        var cssTaLoad = root.querySelector('[data-cab-custom-css]');
        if (cssTaLoad) cssTaLoad.value = preset.customCss || '';
        refreshDecoList(root, preset.decoItems || []);
        root.querySelectorAll('[data-cab-theme]').forEach(function (b) {
          b.classList.toggle('is-active', b.getAttribute('data-cab-theme') === preset.themeId);
        });
        notify();
        toast('已读取「' + pname + '」');
        return;
      }

      if (e.target.closest('[data-cab-preset-delete]')) {
        var selDel = root.querySelector('[data-cab-preset-pick]');
        var delName = selDel ? selDel.value : '';
        if (!delName) return toast('请先选择要删除的预设');
        var confirmFn = global.miyaDialog && global.miyaDialog.confirm
          ? global.miyaDialog.confirm.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(confirm(o.message || '确定？')); };
        confirmFn({ title: '删除预设', message: '确定删除「' + delName + '」？', confirmText: '删除', cancelText: '取消' }).then(function (ok) {
          if (!ok) return;
          return deletePreset(delName);
        }).then(function () {
          refreshPresetSelect(root, '');
          toast('预设已删除');
        }).catch(function () { toast('删除失败'); });
        return;
      }
    });

    root.addEventListener('input', function (e) {
      if (!e.target.matches('[data-cab-custom-css]')) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(notify, 120);
    });

    var decoFile = root.querySelector('[data-cab-deco-file]');
    if (decoFile) {
      decoFile.addEventListener('change', function (ev) {
        var file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file || !/^image\//i.test(file.type)) return;
        var reader = new FileReader();
        reader.onload = function () {
          var url = String(reader.result || '');
          if (!url) return;
          var pageSel = root.querySelector('[data-cab-deco-page]');
          var xInp = root.querySelector('[data-cab-deco-x]');
          var yInp = root.querySelector('[data-cab-deco-y]');
          var wInp = root.querySelector('[data-cab-deco-w]');
          var hInp = root.querySelector('[data-cab-deco-h]');
          var zInp = root.querySelector('[data-cab-deco-z]');
          var item = normalizeDecoItem({
            id: 'deco-' + Date.now(),
            page: pageSel ? pageSel.value : 'all',
            url: url,
            x: xInp ? xInp.value : 0,
            y: yInp ? yInp.value : 0,
            w: wInp ? wInp.value : 72,
            h: hInp ? hInp.value : 72,
            z: zInp ? zInp.value : 2,
            opacity: 1
          });
          var cur = getState();
          var nextItems = (cur.decoItems || []).concat([item]);
          saveState({ decoItems: nextItems });
          apply(getState());
          refreshDecoList(root, nextItems);
          notify();
          toast('装饰已添加');
        };
        reader.readAsDataURL(file);
      });
    }

    hydratePreview(root);
    whenPresetsReady().then(function () {
      refreshPresetSelect(root, getState().presetName);
    });
  }

  function init() {
    apply(getState());
    hydrateAppBeautifyFromIdb().catch(function () {});
  }

  /* B13 跨标签页同步：另一标签页改了聊天 App 美化（主题 / 自定义 CSS / 装饰）后，
     本标签页此前不会感知，若随后发生一次保存就会用旧 stateCache 整包覆盖。
     这里补 storage 监听：仅认本模块 STORAGE_KEY。
     storage 事件只派发给其它标签页，写入方自身收不到，故无自回环；
     hydrateAppBeautifyFromIdb 内部带 appBeautifyScore 比较，不会用低分旧状态覆盖高分新状态。 */
  window.addEventListener('storage', function (ev) {
    if (!ev || ev.key !== STORAGE_KEY || ev.newValue == null) return;
    hydrateAppBeautifyFromIdb().catch(function () {});
  });

  global.MiyaChatAppBeautify = {
    BUILTIN_THEMES: BUILTIN_THEMES,
    STORAGE_KEY: STORAGE_KEY,
    getState: getState,
    saveState: saveState,
    apply: apply,
    applyTheme: applyTheme,
    clearCustomBeautify: clearCustomBeautify,
    init: init,
    buildPanelHtml: buildPanelHtml,
    bindPanelRoot: bindPanelRoot,
    getFullSourcePack: getFullSourcePack,
    whenPresetsReady: whenPresetsReady,
    loadPresets: loadPresets,
    savePreset: savePreset,
    deletePreset: deletePreset,
    renderDecoLayer: function () { renderDecoLayer(getApp(), getState()); },
    toast: toast
  };

  if (global.miyaRegisterKvStore) {
    global.miyaRegisterKvStore({ whenReady: whenPresetsReady });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  whenPresetsReady();
})(window);
