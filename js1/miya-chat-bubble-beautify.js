/**
 * Miya 聊天气泡美化 · 我方/对方气泡配色（HSL 滑条）+ 圆角 / 内边距 / 最大宽度
 *
 * 设计要点：
 * - 全局生效：注入独立 <style id="mib-bubble-style">，作用域 #qq-room（单聊与群聊共用气泡类）；
 *   每次 apply 都把 style 元素移到 body 末尾，保证与「个性装扮自定义 CSS」同特异性时后注入者胜。
 * - 不碰聊天背景：背景仍由「壁纸管理 / 聊天背景」体系负责。
 * - 去描边：生成 CSS 对气泡 border:none（默认的细描边观感差，按需求直接去掉）。
 * - 深色自适应：亮度 ≤ 45% 时该侧文字自动改白，避免深底黑字看不清。
 * - 小尾巴保留：圆角滑条只改统一圆角值，气泡尖角固定 3px。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-chat-bubble-beautify-v1';
  var STYLE_ID = 'mib-bubble-style';
  var PREVIEW_SCOPE = '#mib-preview-room';

  var DEFAULTS = {
    enabled: false,
    /* 对方气泡默认 #f4f4f4 → hsl(0,0%,96%)；我方 #efefef → hsl(0,0%,94%) */
    themH: 0, themS: 0, themL: 96,
    meH: 0, meS: 0, meL: 94,
    radius: 14,       /* 统一圆角 px（尖角固定 3px） */
    maxWidth: 72,     /* 消息行最大宽度 % */
    padX: 12,         /* 内边距·横向 px */
    padY: 8           /* 内边距·纵向 px */
  };

  var LIMITS = {
    themH: [0, 360], themS: [0, 100], themL: [10, 100],
    meH: [0, 360], meS: [0, 100], meL: [10, 100],
    radius: [0, 28],
    maxWidth: [40, 100],
    padX: [4, 32],
    padY: [2, 28]
  };

  var UNITS = {
    themS: '%', themL: '%', meS: '%', meL: '%',
    radius: 'px', maxWidth: '%', padX: 'px', padY: 'px'
  };

  var DARK_TEXT_THRESHOLD = 45; /* 亮度低于此值 → 白字 */

  var stateCache = null;

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

  function clampNum(v, lo, hi, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return Math.round(n);
  }

  function clampKey(raw, key, fallback) {
    var lim = LIMITS[key] || [0, 100];
    return clampNum(raw, lim[0], lim[1], fallback);
  }

  function normalizeState(raw) {
    var d = DEFAULTS;
    if (!raw || typeof raw !== 'object') return Object.assign({}, d);
    return {
      enabled: !!raw.enabled,
      themH: clampKey(raw.themH, 'themH', d.themH),
      themS: clampKey(raw.themS, 'themS', d.themS),
      themL: clampKey(raw.themL, 'themL', d.themL),
      meH: clampKey(raw.meH, 'meH', d.meH),
      meS: clampKey(raw.meS, 'meS', d.meS),
      meL: clampKey(raw.meL, 'meL', d.meL),
      radius: clampKey(raw.radius, 'radius', d.radius),
      maxWidth: clampKey(raw.maxWidth, 'maxWidth', d.maxWidth),
      padX: clampKey(raw.padX, 'padX', d.padX),
      padY: clampKey(raw.padY, 'padY', d.padY)
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

  function hslOf(st, side) {
    return 'hsl(' + st[side + 'H'] + ', ' + st[side + 'S'] + '%, ' + st[side + 'L'] + '%)';
  }

  function textColorFor(l) {
    return l <= DARK_TEXT_THRESHOLD ? '#ffffff' : '#262626';
  }

  /**
   * 生成气泡美化 CSS。
   * @param {Object} st  归一化状态
   * @param {string} scope 选择器作用域，真实房间传 '#qq-room'，预览传 '#mib-preview-room'
   */
  function buildCss(st, scope) {
    scope = scope || '#qq-room';
    var B = scope + ' .qq-room__bubble.qq-room__bubble'; /* 重复类名抬特异性，稳定压过默认紧凑样式 */
    return [
      '/* Miya 气泡美化 · 生成于「我的 → 美化管理 → 气泡美化」 */',
      '/* row 重复类名 ×4：稳定压过默认紧凑样式的 :not(.mq-has-custom-css) 高特异性规则 */',
      scope + ' .qq-room__row.qq-room__row.qq-room__row.qq-room__row { max-width: ' + st.maxWidth + '%; }',
      '',
      '/* 对方气泡 */',
      scope + ' .qq-room__row--them .qq-room__bubble.qq-room__bubble {',
      '  background: ' + hslOf(st, 'them') + ';',
      '  border: none;',
      '  border-radius: ' + st.radius + 'px ' + st.radius + 'px ' + st.radius + 'px 3px;',
      '  padding: ' + st.padY + 'px ' + st.padX + 'px;',
      '  color: ' + textColorFor(st.themL) + ';',
      '}',
      '',
      '/* 我方气泡 */',
      scope + ' .qq-room__row--me .qq-room__bubble.qq-room__bubble {',
      '  background: ' + hslOf(st, 'me') + ';',
      '  border: none;',
      '  border-radius: ' + st.radius + 'px ' + st.radius + 'px 3px ' + st.radius + 'px;',
      '  padding: ' + st.padY + 'px ' + st.padX + 'px;',
      '  color: ' + textColorFor(st.meL) + ';',
      '}'
    ].join('\n');
  }

  function apply(st) {
    st = normalizeState(st || getState());
    stateCache = st;
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
    }
    el.textContent = st.enabled ? buildCss(st, '#qq-room') : '';
    document.body.appendChild(el); /* append 对已存在节点是「移动」，保证始终最后注入、级联最优先 */
    return st;
  }

  /* ── 面板 UI ── */

  var PREVIEW_AVA_THEM = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect fill="#ebe8e3" width="40" height="40"/><text x="20" y="25" text-anchor="middle" fill="#999" font-size="13" font-family="sans-serif">Ta</text></svg>'
  );
  var PREVIEW_AVA_ME = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect fill="#d8d8d8" width="40" height="40"/><text x="20" y="25" text-anchor="middle" fill="#555" font-size="13" font-family="sans-serif">我</text></svg>'
  );

  function previewRowHtml(side, text) {
    var rowCls = 'qq-room__row qq-room__row--' + side;
    var bubble = '<div class="qq-room__bubble-wrap"><div class="qq-room__bubble">' + esc(text) + '</div></div>';
    var ava = '<img class="qq-room__bubble-ava" src="' + (side === 'me' ? PREVIEW_AVA_ME : PREVIEW_AVA_THEM) + '" alt="">';
    return '<div class="' + rowCls + '">' +
      (side === 'me' ? bubble + ava : ava + bubble) +
    '</div>';
  }

  function buildPreviewRoomHtml() {
    return '<div class="mib-preview-room" id="mib-preview-room" aria-label="气泡预览">' +
      previewRowHtml('them', '在吗？今晚有空吗') +
      previewRowHtml('them', '想请你帮个小忙') +
      previewRowHtml('me', '可以的，你说') +
      previewRowHtml('me', '那我等你消息') +
    '</div>';
  }

  function unitFor(key) { return UNITS[key] || ''; }

  function rangeRow(label, key, val) {
    var lim = LIMITS[key];
    return '<label class="mib-range">' +
      '<span class="mib-range__name">' + esc(label) + '</span>' +
      '<input type="range" class="mib-range__input" data-mib-key="' + key + '"' +
        ' min="' + lim[0] + '" max="' + lim[1] + '" step="1" value="' + val + '">' +
      '<span class="mib-range__val" data-mib-val="' + key + '">' + val + unitFor(key) + '</span>' +
    '</label>';
  }

  function hslGroup(label, side, st) {
    return '<div class="mib-hsl">' +
      '<div class="mib-hsl__head">' +
        '<span class="mib-hsl__chip" data-mib-chip="' + side + '" style="background:' + hslOf(st, side) + '"></span>' +
        '<strong class="mib-hsl__title">' + esc(label) + '</strong>' +
        '<span class="mib-hsl__hex" data-mib-hex="' + side + '">' + hslText(st, side) + '</span>' +
      '</div>' +
      rangeRow('色相', side + 'H', st[side + 'H']) +
      rangeRow('饱和度', side + 'S', st[side + 'S']) +
      rangeRow('亮度', side + 'L', st[side + 'L']) +
    '</div>';
  }

  function hslText(st, side) {
    return 'H ' + st[side + 'H'] + ' · S ' + st[side + 'S'] + '% · L ' + st[side + 'L'] + '%';
  }

  function buildPanelHtml(st) {
    st = normalizeState(st || getState());
    var css = buildCss(st, '#qq-room');
    return '<div class="mi-bf-wrap mi-bf-wrap--mib" data-mib-root>' +
      '<p class="mi-me-lead">调整聊天气泡的颜色与形状，单聊群聊全局生效；聊天背景请在「壁纸管理 / 聊天背景」中设置</p>' +
      '<div class="mi-bf-block">' +
        '<div class="mi-bf-block__head">' +
          '<span class="mi-bf-block__label">启用气泡美化</span>' +
          '<button type="button" class="mib-switch' + (st.enabled ? ' is-on' : '') + '" data-mib-toggle role="switch" aria-checked="' + (st.enabled ? 'true' : 'false') + '" aria-label="启用气泡美化"><span class="mib-switch__knob"></span></button>' +
        '</div>' +
        '<p class="mi-bf-preview-hint">关闭后恢复默认气泡；预览始终展示当前滑条参数的效果</p>' +
      '</div>' +
      '<div class="mi-bf-block mi-bf-block--preview">' +
        '<span class="mi-bf-block__label">实时预览</span>' +
        '<p class="mi-bf-preview-hint">拖动下方滑条即时更新</p>' +
        '<div class="mib-preview-stage">' + buildPreviewRoomHtml() + '</div>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">气泡颜色</span>' +
        hslGroup('对方气泡', 'them', st) +
        hslGroup('我方气泡', 'me', st) +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">尺寸</span>' +
        rangeRow('圆角', 'radius', st.radius) +
        rangeRow('最大宽度', 'maxWidth', st.maxWidth) +
        rangeRow('内边距·横向', 'padX', st.padX) +
        rangeRow('内边距·纵向', 'padY', st.padY) +
      '</div>' +
      '<div class="mi-btn-row">' +
        '<button type="button" class="mi-pill mi-pill--dark" data-mib-apply>应用气泡</button>' +
        '<button type="button" class="mi-pill" data-mib-copy>复制 CSS</button>' +
        '<button type="button" class="mi-pill mi-pill--ghost" data-mib-reset>重置默认</button>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">生成的 CSS</span>' +
        '<textarea class="mi-input mi-input--code mi-input--readonly" data-mib-css rows="12" readonly tabindex="-1">' + esc(css) + '</textarea>' +
      '</div>' +
    '</div>';
  }

  function hydratePreview(root, st) {
    if (!root) return;
    var room = root.querySelector('#mib-preview-room');
    if (!room) return;
    var el = document.getElementById('mib-preview-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'mib-preview-style';
      document.head.appendChild(el);
    }
    el.textContent = buildCss(st, PREVIEW_SCOPE);
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
  var applyTimer = null;

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      writeStorage(getState());
    }, 250);
    if (getState().enabled) {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(function () { apply(getState()); }, 120);
    }
  }

  function bindPanelRoot(root, onReset) {
    if (!root || root.dataset.mibBound) {
      if (root) hydratePreview(root, getState());
      return;
    }
    root.dataset.mibBound = '1';

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-mib-toggle]')) {
        var next = saveState({ enabled: !getState().enabled });
        apply(next);
        var btn = root.querySelector('[data-mib-toggle]');
        if (btn) {
          btn.classList.toggle('is-on', next.enabled);
          btn.setAttribute('aria-checked', next.enabled ? 'true' : 'false');
        }
        toast(next.enabled ? '气泡美化已开启' : '气泡美化已关闭，已恢复默认气泡');
        return;
      }

      /* 应用气泡：一键「开启 + 保存 + 应用到聊天室 + 刷新预览」。
         部分手机 WebView 拖滑条只派发 change 不派发 input，自动联动可能缺席，
         此按钮是明确的手动兜底入口。 */
      if (e.target.closest('[data-mib-apply]')) {
        var applied = saveState({ enabled: true });
        apply(applied);
        hydratePreview(root, applied);
        var toggleBtn = root.querySelector('[data-mib-toggle]');
        if (toggleBtn) {
          toggleBtn.classList.add('is-on');
          toggleBtn.setAttribute('aria-checked', 'true');
        }
        toast('气泡已应用到聊天');
        return;
      }

      if (e.target.closest('[data-mib-copy]')) {
        copyText(buildCss(getState(), '#qq-room')).then(function () {
          toast('CSS 已复制');
        }).catch(function () {
          toast('复制失败，请手动选取');
        });
        return;
      }

      if (e.target.closest('[data-mib-reset]')) {
        stateCache = normalizeState(null);
        writeStorage(stateCache);
        apply(getState());
        if (typeof onReset === 'function') onReset();
        toast('已恢复默认气泡参数');
        return;
      }
    });

    /* 滑条联动：input + change 双监听。部分移动端 WebView 在拖动 range 时
       只派发 change（或只在松手时派发），只听 input 会导致预览"看起来不动"。 */
    function handleControl(root, key, raw) {
      if (!key) return;
      var patch = {};
      patch[key] = Number(raw);
      var st = saveState(patch);

      var valEl = root.querySelector('[data-mib-val="' + key + '"]');
      if (valEl) valEl.textContent = st[key] + unitFor(key);

      var side = /^(me|them)[HSL]$/.test(key) ? (key.indexOf('me') === 0 ? 'me' : 'them') : null;
      if (side) {
        var chip = root.querySelector('[data-mib-chip="' + side + '"]');
        if (chip) chip.style.background = hslOf(st, side);
        var hex = root.querySelector('[data-mib-hex="' + side + '"]');
        if (hex) hex.textContent = hslText(st, side);
      }

      var cssBox = root.querySelector('[data-mib-css]');
      if (cssBox) cssBox.value = buildCss(st, '#qq-room');

      hydratePreview(root, st);
      schedulePersist();
    }

    root.addEventListener('input', function (e) {
      var inp = e.target.closest('[data-mib-key]');
      if (!inp) return;
      handleControl(root, inp.getAttribute('data-mib-key'), inp.value);
    });

    root.addEventListener('change', function (e) {
      var inp = e.target.closest('[data-mib-key]');
      if (!inp) return;
      handleControl(root, inp.getAttribute('data-mib-key'), inp.value);
    });

    hydratePreview(root, getState());
  }

  function init() {
    apply(getState());
  }

  global.MiyaChatBubbleBeautify = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    getState: getState,
    saveState: saveState,
    apply: apply,
    buildCss: buildCss,
    buildPanelHtml: buildPanelHtml,
    bindPanelRoot: bindPanelRoot,
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
