/**
 * Miya 聊天美化 · 主题 / 壁纸 / 自定义 CSS / 复制源码
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'mq-beautify-style';
  var GUARD_STYLE_ID = 'mq-beautify-guard';
  var PREVIEW_STYLE_ID = 'mq-beautify-preview-style';
  var PRESETS_LS = 'miya-chat-beautify-presets-v1';
  var PREVIEW_AVA_THEM = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect fill="#ebe8e3" width="40" height="40"/><text x="20" y="25" text-anchor="middle" fill="#999" font-size="13" font-family="sans-serif">Ta</text></svg>'
  );
  var PREVIEW_AVA_ME = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect fill="#d8d8d8" width="40" height="40"/><text x="20" y="25" text-anchor="middle" fill="#555" font-size="13" font-family="sans-serif">我</text></svg>'
  );
  var THEME_MAP = {
    gallery: 'mq-theme-porcelain',
    ins: 'mq-theme-porcelain',
    blossom: 'mq-theme-sakura',
    noir: 'mq-theme-noir',
    /* custom 不再映射到 mq-theme-atelier —— 该 class 全仓无任何 CSS 规则，
       挂上去等于「以为在自定义、实为默认外观」。语义上 custom 就该「不套任何
       内置皮肤」，外观完全由用户写入的 CSS 决定（injectCustomCss 接管）。 */
    custom: ''
  };

  var BUILTIN_THEMES = [
    { id: 'gallery', label: '素纸', sub: '暖灰底 · 细线框' },
    { id: 'blossom', label: '樱雾', sub: '浅粉渐变 · 大圆角' },
    { id: 'noir', label: '夜刊', sub: '深底 · 金线描边' },
    { id: 'custom', label: '自定义', sub: '写入 CSS 完全自控' }
  ];

  function getBuiltinSourceRef() {
    if (global.MIYA_BEAUTIFY_SOURCE_REF) return String(global.MIYA_BEAUTIFY_SOURCE_REF);
    return [
      'Miya 美化源码与选择器参考（内置模块未加载）',
      '作用域 #qq-room · 底栏 #qq-room-toolbar[hidden] 须解开裁切',
      '四键：#qq-room-ai · #qq-room-input · #qq-room-send · #qq-room-tools-toggle'
    ].join('\n');
  }
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
    el.className = 'mq-toast';
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

  /** 主题 id 白名单取自 store 的唯一权威定义；store 未就绪时退回本地兜底（与 store 保持一致） */
  var THEME_FALLBACK_IDS = ['gallery', 'ins', 'blossom', 'noir', 'custom'];
  function chatThemeIds() {
    var st = global.miyaChatStore;
    var ids = st && st.CHAT_THEME_IDS;
    return Array.isArray(ids) && ids.length ? ids : THEME_FALLBACK_IDS;
  }

  function normalizeBeautify(raw) {
    var st = global.miyaChatStore;
    var d = st && st.defaultChatSettings ? st.defaultChatSettings().chatBeautify : {};
    if (!raw || typeof raw !== 'object') return Object.assign({}, d);
    var themeId = raw.themeId || d.themeId || 'gallery';
    if (chatThemeIds().indexOf(themeId) < 0) themeId = 'gallery';
    return {
      wallpaperMode: ['none', 'idb', 'url'].indexOf(raw.wallpaperMode) >= 0 ? raw.wallpaperMode : d.wallpaperMode,
      wallpaperId: raw.wallpaperId ? String(raw.wallpaperId) : null,
      wallpaperUrl: String(raw.wallpaperUrl || '').trim(),
      /* themeId 只由 themeId 决定（与离线侧同一语义）。
         此处原为 `raw.customCss ? 'custom' : (themeId === 'custom' ? 'custom' : themeId)`：
         前半段让残留 customCss 劫持用户所选主题，后半段两个分支恒等属半成品写法。
         与 B1 是同一个 bug，此处为聊天侧残留。 */
      themeId: themeId,
      customCss: String(raw.customCss || ''),
      bubbleMeCss: '',
      bubbleThemCss: '',
      hvCustomCss: String(raw.hvCustomCss || ''),
      presetName: String(raw.presetName || '').trim()
    };
  }

  function themeClassFor(id) {
    /* custom 映射为空串：不套任何内置皮肤。
       注意不能写成 `|| THEME_MAP.gallery`，否则正好把 custom 兜成 gallery。 */
    if (Object.prototype.hasOwnProperty.call(THEME_MAP, id)) return THEME_MAP[id] || '';
    return THEME_MAP.gallery;
  }

  function applyThemeClass(el, cls) {
    if (!el) return;
    if (cls) el.classList.add(cls);
  }

  function allThemeClasses() {
    var seen = {};
    Object.keys(THEME_MAP).forEach(function (k) {
      if (THEME_MAP[k]) seen[THEME_MAP[k]] = true;
    });
    return Object.keys(seen);
  }

  function ensureWallLayer(room) {
    if (!room) return null;
    var wall = room.querySelector('.mq-room-wall');
    if (!wall) {
      wall = document.createElement('div');
      wall.className = 'mq-room-wall';
      wall.setAttribute('aria-hidden', 'true');
      room.insertBefore(wall, room.firstChild);
    }
    return wall;
  }

  function injectBeautifyGuardCss() {
    var css = [
      '/* miya beautify interaction guard — keeps long-press / copy working under custom CSS */',
      '#qq-room > .mq-room-wall,',
      '#qq-room > .mc-room-deco,',
      '#qq-room > .mc-room-deco * { pointer-events: none !important; }',
      '#qq-room::before,',
      '#qq-room::after,',
      '#qq-room .qq-room__main::before,',
      '#qq-room .qq-room__main::after,',
      '#qq-room .qq-room__scroll::before,',
      '#qq-room .qq-room__scroll::after,',
      '#qq-room [data-msg-id]::before,',
      '#qq-room [data-msg-id]::after,',
      '#qq-room .qq-room__row::before,',
      '#qq-room .qq-room__row::after,',
      '#qq-room .qq-room__bubble::before,',
      '#qq-room .qq-room__bubble::after { pointer-events: none !important; }',
      '#qq-room .qq-room__bubble-ava,',
      '#qq-room .qq-room__bubble-ava[data-hv-ava] { pointer-events: auto !important; cursor: pointer; touch-action: manipulation; }',
      '#qq-room .qq-room__scroll,',
      '#qq-room [data-msg-id],',
      '#qq-room .qq-room__row[data-msg-id],',
      '#qq-room .qq-room__sys[data-msg-id] { pointer-events: auto !important; touch-action: pan-y; }',
      '.qq-msg-menu,',
      '.qq-msg-menu--portal { pointer-events: auto !important; touch-action: manipulation; }'
    ].join('\n');
    var el = document.getElementById(GUARD_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = GUARD_STYLE_ID;
      document.body.appendChild(el);
    }
    el.textContent = css;
    return el;
  }

  function scopeCssForRoom(css) {
    var s = String(css || '');
    s = s.replace(/#mq-bf-preview-([\w-]+)/g, '#qq-room-$1');
    s = s.replace(/#mq-bf-preview-room\b/g, '#qq-room');
    return s;
  }

  function scopeCssForPreview(css) {
    var s = scopeCssForRoom(css);
    s = s.replace(/#qq-room-([\w-]+)/g, '#mq-bf-preview-$1');
    s = s.replace(/#qq-room\b/g, '#mq-bf-preview-room');
    return s;
  }

  function injectCustomCss(css) {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.body.appendChild(el);
    }
    el.textContent = scopeCssForRoom(css);
    injectBeautifyGuardCss();
    return el;
  }

  function injectPreviewCss(css) {
    var el = document.getElementById(PREVIEW_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = PREVIEW_STYLE_ID;
      document.body.appendChild(el);
    }
    el.textContent = scopeCssForPreview(css);
    return el;
  }

  function clearPreviewCss() {
    var el = document.getElementById(PREVIEW_STYLE_ID);
    if (el) el.textContent = '';
  }

  function buildCssPreviewRoomHtml() {
    return '<div id="mq-bf-preview-room" class="qq-room mi-bf-preview-room" data-mq-bf-css-preview aria-label="美化预览">' +
      '<div class="mc-room-deco" aria-hidden="true">' +
        '<div class="mc-room-deco__grain"></div>' +
        '<div class="mc-room-deco__watermark">MIYA</div>' +
      '</div>' +
      '<header class="qq-room__head mi-bf-preview-head">' +
        '<div class="qq-room__head-profile">' +
          '<span class="qq-room__back" id="mq-bf-preview-back" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 18l-6-6 6-6" stroke-linecap="round"/></svg>' +
          '</span>' +
          '<div class="qq-room__head-info">' +
            '<div class="qq-room__head-name" id="mq-bf-preview-title">预览</div>' +
          '</div>' +
          '<span class="qq-room__menu" id="mq-bf-preview-more" aria-hidden="true"><span></span><span></span><span></span></span>' +
        '</div>' +
      '</header>' +
      '<div class="qq-room__main">' +
      '<div class="qq-room__scroll" id="mq-bf-preview-scroll">' +
        '<div class="qq-room__row qq-room__row--them qq-room__row--first">' +
          '<img class="qq-room__bubble-ava" src="' + PREVIEW_AVA_THEM + '" alt="">' +
          '<div class="qq-room__bubble-wrap"><div class="qq-room__bubble">在吗？今晚有空吗</div></div>' +
        '</div>' +
        '<div class="qq-room__row qq-room__row--them qq-room__row--last">' +
          '<img class="qq-room__bubble-ava" src="' + PREVIEW_AVA_THEM + '" alt="">' +
          '<div class="qq-room__bubble-wrap"><div class="qq-room__bubble">想请你帮个小忙</div></div>' +
        '</div>' +
        '<div class="qq-room__row qq-room__row--me qq-room__row--solo">' +
          '<div class="qq-room__bubble-wrap"><div class="qq-room__bubble">可以的，你说</div></div>' +
          '<img class="qq-room__bubble-ava" src="' + PREVIEW_AVA_ME + '" alt="">' +
        '</div>' +
        '<div class="qq-room__row qq-room__row--them qq-room__row--solo">' +
          '<img class="qq-room__bubble-ava" src="' + PREVIEW_AVA_THEM + '" alt="">' +
          '<div class="qq-room__bubble-wrap qq-room__bubble-wrap--card">' +
            '<div class="qq-card qq-card-voice">' +
              '<div class="qq-card-voice__row">' +
                '<span class="qq-card-voice__wave" aria-hidden="true">' +
                  '<span class="qq-card-voice__bar"></span><span class="qq-card-voice__bar"></span>' +
                  '<span class="qq-card-voice__bar"></span><span class="qq-card-voice__bar"></span>' +
                  '<span class="qq-card-voice__bar"></span>' +
                '</span>' +
                '<span class="qq-card-voice__dur">3″</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>' +
      '<footer class="qq-room__foot mi-bf-preview-foot">' +
        '<div class="qq-room__input-row">' +
          '<div class="qq-room__input" id="mq-bf-preview-input" aria-hidden="true">写点什么…</div>' +
        '</div>' +
        '<div class="qq-room__toolbar mi-bf-preview-toolbar">' +
          '<span class="qq-room__tool-icon qq-room__tool-icon--reply" id="mq-bf-preview-ai" aria-hidden="true"></span>' +
          '<span class="qq-room__tool-icon" data-qq-tool="image" aria-hidden="true"></span>' +
          '<span class="qq-room__tool-icon" data-qq-tool="redo" aria-hidden="true"></span>' +
          '<span class="qq-room__tool-icon" data-qq-tool="mic" aria-hidden="true"></span>' +
          '<span class="qq-room__tool-icon" data-qq-tool="emoji" aria-hidden="true"></span>' +
          '<span class="qq-room__tool-icon" data-qq-tool="plus" aria-hidden="true"></span>' +
        '</div>' +
      '</footer>' +
    '</div>';
  }

  function resolveBeautifyRoot(root) {
    if (!root) return null;
    return root.matches && root.matches('[data-mq-bf-css-preview], .mi-bf-wrap, [data-mq-bf-custom-css]')
      ? root
      : (root.querySelector('.mi-bf-wrap') || root);
  }

  function hydrateCssPreview(root) {
    root = resolveBeautifyRoot(root);
    if (!root) return;
    var room = root.querySelector('[data-mq-bf-css-preview]');
    var ta = root.querySelector('[data-mq-bf-custom-css]');
    if (!room) return;
    var css = ta ? String(ta.value || '') : '';
    var hasCss = !!css.trim();
    allThemeClasses().forEach(function (cls) { room.classList.remove(cls); });
    applyThemeClass(room, themeClassFor(hasCss ? 'custom' : 'gallery'));
    room.classList.toggle('mq-has-custom-css', hasCss);
    room.classList.toggle('mq-foot-wechat', hasCss && String(css).indexOf('mq-wechat-skin') >= 0);
    injectPreviewCss(css);
    if (global.miyaSyncChatBeautifyFontScale) global.miyaSyncChatBeautifyFontScale();
    if (global.miyaSyncChatTimestampFontScale) global.miyaSyncChatTimestampFontScale();
  }

  function resolveWallpaperUrl(bf) {
    bf = normalizeBeautify(bf);
    if (bf.wallpaperMode === 'url' && bf.wallpaperUrl) {
      return Promise.resolve(bf.wallpaperUrl);
    }
    if (bf.wallpaperMode === 'idb' && bf.wallpaperId && global.miyaChatStore) {
      return global.miyaChatStore.getAvatarUrl(bf.wallpaperId);
    }
    return Promise.resolve('');
  }

  function applyToRoomEl(room, bf) {
    if (!room) return Promise.resolve();
    bf = normalizeBeautify(bf);
    allThemeClasses().forEach(function (cls) { room.classList.remove(cls); });
    /* 主题类只认 themeId，不再让 customCss 决定主题（同 B1） */
    applyThemeClass(room, themeClassFor(bf.themeId));
    room.classList.toggle('mq-has-custom-css', !!bf.customCss);
    room.classList.toggle(
      'mq-foot-wechat',
      !!(bf.customCss && String(bf.customCss).indexOf('mq-wechat-skin') >= 0)
    );
    injectCustomCss(bf.customCss);
    if (global.miyaSyncChatBeautifyFontScale) global.miyaSyncChatBeautifyFontScale();
    if (global.miyaSyncChatTimestampFontScale) global.miyaSyncChatTimestampFontScale();
    return resolveWallpaperUrl(bf).then(function (url) {
      var wall = ensureWallLayer(room);
      if (!wall) return;
      if (url) {
        room.classList.add('mq-has-wall');
        wall.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
        wall.hidden = false;
      } else {
        room.classList.remove('mq-has-wall');
        wall.style.backgroundImage = '';
        wall.hidden = true;
      }
    });
  }

  function applyForChat(chatId) {
    var st = global.miyaChatStore;
    if (!st || !chatId) return Promise.resolve();
    var settings = st.getChatSettings(chatId);
    var bf = settings && settings.chatBeautify ? settings.chatBeautify : {};
    var room = document.getElementById('qq-room');
    return applyToRoomEl(room, bf);
  }

  function getFullSourcePack() {
    return getBuiltinSourceRef();
  }

  function buildSourceReferenceHtml() {
    var src = getFullSourcePack();
    return '<div class="mi-bf-block mi-bf-block--copy">' +
      '<span class="mi-bf-block__label">美化源码 · 选择器参考</span>' +
      '<p class="mi-bf-preview-hint">单聊页 DOM 树、选择器与布局要点；建议以 <strong>#qq-room</strong> 为作用域写 CSS</p>' +
      '<textarea class="mi-input mi-input--code mi-input--readonly" data-mq-bf-src-readonly rows="16" readonly tabindex="-1">' + esc(src) + '</textarea>' +
      '<div class="mi-btn-row" style="margin-top:10px">' +
        '<button type="button" class="mi-pill mi-pill--dark" data-mq-bf-copy-src>复制源码</button>' +
        '<button type="button" class="mi-pill" data-mq-bf-download-src>下载 txt</button>' +
      '</div>' +
    '</div>';
  }

  function copySource(kind) {
    var text = getFullSourcePack();
    return copyText(text).then(function () {
      toast('界面源码已复制');
    }).catch(function () {
      toast('复制失败，请手动选取');
    });
  }

  function downloadSource() {
    var text = getFullSourcePack();
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'miya美化源码-选择器参考.txt';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('已下载 txt 文件');
    } catch (e) {
      toast('下载失败');
    }
  }

  function normalizePresetRow(raw) {
    if (!raw || !raw.name) return null;
    var at = Number(raw.savedAt);
    /* savedAt 只用于排序；补有限性校验（Infinity 是真值，`|| Date.now()` 兜不住） */
    return Object.assign(
      { name: String(raw.name).trim(), savedAt: isFinite(at) ? at : Date.now() },
      normalizeBeautify(raw)
    );
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

  function deletePreset(name) {
    var label = String(name || '').trim();
    if (!label) return Promise.reject(new Error('empty_name'));
    return whenPresetsReady().then(function (list) {
      var next = list.filter(function (p) { return p.name !== label; });
      if (next.length === list.length) return Promise.reject(new Error('not_found'));
      return persistPresets(next);
    });
  }

  function findPreset(name) {
    var label = String(name || '').trim();
    if (!label) return null;
    return loadPresets().find(function (p) { return p.name === label; }) || null;
  }

  function buildPresetSelectOptions(selectedName, includeNone) {
    var html = includeNone !== false ? '<option value="">不使用预设</option>' : '';
    loadPresets().forEach(function (p) {
      html += '<option value="' + esc(p.name) + '"' + (p.name === selectedName ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    });
    return html;
  }

  function refreshPresetSelect(root, selectedName, selector) {
    var sel = root && root.querySelector(selector || '[data-mq-bf-preset-pick]');
    if (!sel) return;
    sel.innerHTML = buildPresetSelectOptions(selectedName, true);
  }

  function hasAppliedBeautifyCss(bf) {
    bf = normalizeBeautify(bf);
    return !!(bf.presetName && bf.presetName.trim()) || !!(bf.customCss && bf.customCss.trim());
  }

  function chatDisplayName(st, chat) {
    var contact = st.findContact(chat.contactId);
    var name = contact ? String(contact.remarkName || contact.name || '').trim() : '';
    if (!name) name = String(chat.title || '').trim() || '未命名';
    var profile = null;
    if (chat.profileId && st.getProfiles) {
      profile = st.getProfiles().find(function (p) { return p.id === chat.profileId; }) || null;
    }
    return { name: name, profileName: profile ? String(profile.name || '').trim() : '' };
  }

  function appliedBeautifyLabel(bf) {
    bf = normalizeBeautify(bf);
    if (bf.presetName) return '预设「' + bf.presetName + '」';
    if (bf.customCss && bf.customCss.trim()) return '自定义 CSS';
    return '';
  }

  function getChatsWithAppliedBeautify() {
    var st = global.miyaChatStore;
    if (!st || !st.getChats) return [];
    return st.getChats().filter(function (ch) {
      if (ch.type === 'group') return false;
      return hasAppliedBeautifyCss(st.getChatSettings(ch.id).chatBeautify);
    }).map(function (ch) {
      var bf = normalizeBeautify(st.getChatSettings(ch.id).chatBeautify);
      var dn = chatDisplayName(st, ch);
      return {
        chatId: ch.id,
        name: dn.name,
        profileName: dn.profileName,
        label: appliedBeautifyLabel(bf)
      };
    });
  }

  function buildAppliedListHtml() {
    var rows = getChatsWithAppliedBeautify();
    if (!rows.length) {
      return '<p class="mi-empty-hint mi-bf-applied-empty">暂无联系人套用自定义样式</p>';
    }
    return rows.map(function (row) {
      var sub = row.profileName
        ? '<span class="mi-bf-applied-row__profile">' + esc(row.profileName) + '</span>'
        : '';
      return '<div class="mi-bf-applied-row">' +
        '<div class="mi-bf-applied-row__info">' +
          '<strong>' + esc(row.name) + '</strong>' +
          sub +
          '<span class="mi-bf-applied-row__tag">' + esc(row.label) + '</span>' +
        '</div>' +
        '<button type="button" class="mi-pill mi-pill--ghost" data-mq-bf-clear-applied="' + esc(row.chatId) + '">清除</button>' +
      '</div>';
    }).join('');
  }

  function buildAppliedBlockHtml(opts) {
    opts = opts || {};
    var hint = opts.hint || '清除后该联系人恢复默认聊天样式，预设库不受影响';
    return '<div class="mi-bf-block mi-bf-block--applied">' +
      '<span class="mi-bf-block__label">联系人样式</span>' +
      '<p class="mi-bf-preview-hint">' + esc(hint) + '</p>' +
      '<div class="mi-bf-applied-list" data-mq-bf-applied-list>' + buildAppliedListHtml() + '</div>' +
    '</div>';
  }

  function refreshAppliedList(root) {
    var list = root && root.querySelector('[data-mq-bf-applied-list]');
    if (list) list.innerHTML = buildAppliedListHtml();
  }

  function clearAppliedBeautifyForChat(chatId) {
    var st = global.miyaChatStore;
    if (!st || !chatId) return Promise.reject(new Error('no_chat'));
    var cur = st.getChatSettings(chatId);
    var patch = normalizeBeautify(Object.assign({}, cur.chatBeautify, {
      presetName: '',
      customCss: '',
      themeId: 'gallery',
      bubbleMeCss: '',
      bubbleThemCss: '',
      hvCustomCss: ''
    }));
    return saveChatBeautify(chatId, patch);
  }

  function buildPresetEditorHtml(bf) {
    bf = normalizeBeautify(bf);
    return '<div class="mi-bf-wrap">' +
      '<p class="mi-bf-lead">编写 CSS 后保存为预设，可在各聊天设置里选用</p>' +
      '<div class="mi-bf-block mi-bf-block--preview">' +
        '<span class="mi-bf-block__label">实时预览</span>' +
        '<p class="mi-bf-preview-hint">下方编辑 CSS 时即时更新，结构与真实聊天室一致</p>' +
        '<div class="mi-bf-preview-stage">' + buildCssPreviewRoomHtml() + '</div>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<div class="mi-bf-block__head">' +
          '<span class="mi-bf-block__label">自定义 CSS</span>' +
          '<button type="button" class="mi-pill mi-pill--ghost" data-mq-bf-doc-import>快捷导入</button>' +
        '</div>' +
        '<textarea class="mi-input mi-input--code" data-mq-bf-custom-css rows="10" placeholder="/* 建议以 #qq-room 为作用域 */">' + esc(bf.customCss) + '</textarea>' +
      '</div>' +
      buildSourceReferenceHtml() +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">预设</span>' +
        '<select class="mi-input" data-mq-bf-preset-pick>' + buildPresetSelectOptions('', true) + '</select>' +
        '<div class="mi-btn-row" style="margin-top:10px">' +
          '<button type="button" class="mi-pill mi-pill--dark" data-mq-bf-preset-save>保存预设</button>' +
          '<button type="button" class="mi-pill" data-mq-bf-preset-load>读取预设</button>' +
          '<button type="button" class="mi-pill mi-pill--ghost" data-mq-bf-preset-delete>删除预设</button>' +
        '</div>' +
      '</div>' +
      buildAppliedBlockHtml() +
    '</div>';
  }

  function buildContactPresetFieldHtml(bf) {
    return buildChatSettingsBeautifyHtml(bf);
  }

  function buildChatSettingsBeautifyHtml(bf) {
    bf = normalizeBeautify(bf || {});
    var presetNote = bf.presetName && bf.customCss
      ? '当前预设「' + esc(bf.presetName) + '」已套用'
      : (bf.customCss ? '已写入自定义 CSS' : '未选用预设时保持默认聊天样式');
    return '<div class="mi-bf-wrap mi-bf-wrap--settings">' +
      '<p class="mi-bf-lead">编写 CSS 并保存为预设，各聊天均可选用；仅对本聊天生效</p>' +
      '<div class="mi-bf-block mi-bf-block--preview">' +
        '<span class="mi-bf-block__label">实时预览</span>' +
        '<p class="mi-bf-preview-hint">下方编辑 CSS 时即时更新，结构与真实聊天室一致</p>' +
        '<div class="mi-bf-preview-stage">' + buildCssPreviewRoomHtml() + '</div>' +
      '</div>' +
      '<div class="mi-bf-block">' +
        '<div class="mi-bf-block__head">' +
          '<span class="mi-bf-block__label">自定义 CSS</span>' +
          '<button type="button" class="mi-pill mi-pill--ghost" data-mq-bf-doc-import>快捷导入</button>' +
        '</div>' +
        '<textarea class="mi-input mi-input--code" data-mq-bf-custom-css rows="10" placeholder="/* 建议以 #qq-room 为作用域 */">' + esc(bf.customCss) + '</textarea>' +
      '</div>' +
      buildSourceReferenceHtml() +
      '<div class="mi-bf-block">' +
        '<span class="mi-bf-block__label">预设库</span>' +
        '<p class="mi-bf-preview-hint">保存的预设全局可用，可在任意聊天设置里读取并套用</p>' +
        '<select class="mi-input" data-mq-bf-preset-pick>' + buildPresetSelectOptions(bf.presetName, true) + '</select>' +
        '<div class="mi-btn-row" style="margin-top:10px">' +
          '<button type="button" class="mi-pill mi-pill--dark" data-mq-bf-preset-save>保存预设</button>' +
          '<button type="button" class="mi-pill" data-mq-bf-preset-load>读取预设</button>' +
          '<button type="button" class="mi-pill mi-pill--ghost" data-mq-bf-preset-delete>删除预设</button>' +
        '</div>' +
      '</div>' +
      '<p class="mi-pill-note">' + presetNote + '</p>' +
      '<div class="mi-btn-row">' +
        '<button type="button" class="mi-pill mi-pill--ghost" data-mq-bf-clear-current>清除本聊天样式</button>' +
      '</div>' +
    '</div>';
  }

  function readChatBeautifyFromRoot(root, base) {
    var atelier = readAtelierFromRoot(root);
    var presetPick = root && root.querySelector('[data-mq-bf-preset-pick]');
    var presetName = presetPick ? String(presetPick.value || '').trim() : '';
    return normalizeBeautify(Object.assign({}, base || {}, atelier, { presetName: presetName }));
  }

  function beautifyFromPresetName(presetName, base) {
    var next = normalizeBeautify(Object.assign({}, base || {}));
    var label = String(presetName || '').trim();
    next.presetName = label;
    next.bubbleMeCss = '';
    next.bubbleThemCss = '';
    if (!label) {
      next.presetName = '';
      next.customCss = '';
      next.themeId = 'gallery';
      return next;
    }
    var preset = findPreset(label);
    if (!preset) return next;
    next.themeId = 'custom';
    next.customCss = preset.customCss || '';
    return next;
  }

  function savePreset(name, beautify) {
    var label = String(name || '').trim();
    if (!label) return Promise.reject(new Error('empty_name'));
    return whenPresetsReady().then(function (list) {
      var row = normalizePresetRow(Object.assign({ name: label, savedAt: Date.now() }, normalizeBeautify(beautify)));
      var idx = list.findIndex(function (p) { return p.name === label; });
      if (idx >= 0) list[idx] = row;
      else list.unshift(row);
      return persistPresets(list).then(function () { return row; });
    });
  }

  function saveChatBeautify(chatId, patch) {
    var st = global.miyaChatStore;
    if (!st || !chatId) return Promise.reject(new Error('no_chat'));
    var cur = st.getChatSettings(chatId);
    var next = normalizeBeautify(Object.assign({}, cur.chatBeautify, patch || {}));
    return st.saveChatSettings(chatId, { chatBeautify: next }).then(function () {
      return applyForChat(chatId).then(function () { return next; });
    });
  }

  function buildThemePickerHtml(activeId, white) {
    var cardCls = white ? 'mi-bf-tile' : 'mq-bf-theme-card';
    var haloCls = white ? 'mi-bf-tile__dot' : 'mq-bf-theme-card__halo';
    return BUILTIN_THEMES.map(function (t) {
      var on = t.id === activeId;
      return '<button type="button" class="' + cardCls + (on ? ' is-active' : '') + '" data-mq-bf-theme="' + esc(t.id) + '">' +
        '<span class="' + haloCls + '" aria-hidden="true"></span>' +
        '<strong>' + esc(t.label) + '</strong>' +
        '<small>' + esc(t.sub) + '</small>' +
      '</button>';
    }).join('');
  }

  function buildAtelierPanelHtml(bf, opts) {
    opts = opts || {};
    return buildPresetEditorHtml(bf);
  }

  function readAtelierFromRoot(root) {
    if (!root) return {};
    function val(sel) {
      var el = root.querySelector(sel);
      return el ? String(el.value || '') : '';
    }
    return {
      themeId: 'custom',
      customCss: val('[data-mq-bf-custom-css]'),
      bubbleMeCss: '',
      bubbleThemCss: ''
    };
  }

  function bindAtelierRoot(root, chatId, onSaved) {
    root = resolveBeautifyRoot(root);
    if (!root) return;
    if (root.dataset.mqBfBound) {
      hydrateCssPreview(root);
      refreshAppliedList(root);
      return;
    }
    root.dataset.mqBfBound = '1';

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-mq-bf-preset-save]')) {
        var pick = root.querySelector('[data-mq-bf-preset-pick]');
        var defaultName = pick && pick.value ? pick.value : '';
        var promptFn = global.miyaDialog && global.miyaDialog.prompt
          ? global.miyaDialog.prompt.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(prompt(o.message || '名称', o.defaultValue || '')); };
        promptFn({ title: '保存预设', message: '为这个预设取个名字', placeholder: '例如：灰白', defaultValue: defaultName }).then(function (name) {
          if (!name || !String(name).trim()) return;
          var patch = readAtelierFromRoot(root);
          return savePreset(String(name).trim(), patch);
        }).then(function (row) {
          if (!row) return;
          refreshPresetSelect(root, row.name);
          toast('预设已保存');
        }).catch(function (err) {
          if (!err || err.message === 'empty_name') return;
          toast(err.message === 'preset_persist_failed' ? '存储空间不足，预设未能保存' : '保存失败');
        });
        return;
      }
      if (e.target.closest('[data-mq-bf-preset-load]')) {
        var sel = root.querySelector('[data-mq-bf-preset-pick]');
        var name = sel ? sel.value : '';
        if (!name) return toast('请先选择预设');
        var preset = findPreset(name);
        if (!preset) return toast('预设不存在');
        var ta = root.querySelector('[data-mq-bf-custom-css]');
        if (ta) ta.value = preset.customCss || '';
        hydrateCssPreview(root);
        toast('已读取「' + name + '」');
        return;
      }
      if (e.target.closest('[data-mq-bf-preset-delete]')) {
        var selDel = root.querySelector('[data-mq-bf-preset-pick]');
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
      if (e.target.closest('[data-mq-bf-copy-src]')) {
        copySource();
        return;
      }
      if (e.target.closest('[data-mq-bf-download-src]')) {
        downloadSource();
        return;
      }
      if (e.target.closest('[data-mq-bf-doc-import]')) {
        var cssTa = root.querySelector('[data-mq-bf-custom-css]');
        var docImp = global.miyaBeautifyDocImport;
        if (!docImp || !cssTa) {
          toast('导入模块未加载');
          return;
        }
        docImp.pickAndImport(cssTa).then(function () {
          hydrateCssPreview(root);
          toast('CSS 已导入');
        }).catch(function (err) {
          docImp.toastError(err, toast);
        });
        return;
      }
      if (e.target.closest('[data-mq-bf-clear-current]')) {
        if (!chatId) return toast('请先打开聊天设置');
        var stCur = global.miyaChatStore;
        var chatCur = stCur && stCur.findChat(chatId);
        var dnCur = chatCur ? chatDisplayName(stCur, chatCur) : { name: '本聊天' };
        var confirmCurFn = global.miyaDialog && global.miyaDialog.confirm
          ? global.miyaDialog.confirm.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(confirm(o.message || '确定？')); };
        confirmCurFn({
          title: '清除样式',
          message: '确定清除「' + dnCur.name + '」的自定义美化 CSS？',
          confirmText: '清除',
          cancelText: '取消'
        }).then(function (ok) {
          if (!ok) return;
          return clearAppliedBeautifyForChat(chatId);
        }).then(function () {
          var ta = root.querySelector('[data-mq-bf-custom-css]');
          if (ta) ta.value = '';
          refreshPresetSelect(root, '');
          hydrateCssPreview(root);
          if (typeof onSaved === 'function') onSaved();
          toast('已清除本聊天样式');
        }).catch(function (err) {
          if (err && err.message !== 'no_chat') toast('清除失败');
        });
        return;
      }
      var clearAppliedBtn = e.target.closest('[data-mq-bf-clear-applied]');
      if (clearAppliedBtn) {
        var clearChatId = clearAppliedBtn.getAttribute('data-mq-bf-clear-applied');
        var stClear = global.miyaChatStore;
        var chatRow = stClear && stClear.findChat(clearChatId);
        var dnClear = chatRow ? chatDisplayName(stClear, chatRow) : { name: '该联系人' };
        var confirmClearFn = global.miyaDialog && global.miyaDialog.confirm
          ? global.miyaDialog.confirm.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(confirm(o.message || '确定？')); };
        confirmClearFn({
          title: '清除样式',
          message: '确定清除「' + dnClear.name + '」的自定义美化 CSS？',
          confirmText: '清除',
          cancelText: '取消'
        }).then(function (ok) {
          if (!ok) return;
          return clearAppliedBeautifyForChat(clearChatId);
        }).then(function () {
          refreshAppliedList(root);
          toast('已清除「' + dnClear.name + '」的样式');
        }).catch(function (err) {
          if (err && err.message !== 'no_chat') toast('清除失败');
        });
        return;
      }
      /* 此面板现已只保留 CSS 编辑与预设库。
         原先的壁纸工具（本地上传 / 链接 / 清除）在这个版本已无对应 UI，
         壁纸统一走「我的 → 壁纸管理」本地上传，再在「聊天背景」里选用。 */
    });

    var previewTimer = null;
    root.addEventListener('input', function (e) {
      if (!e.target.matches('[data-mq-bf-custom-css]')) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(function () { hydrateCssPreview(root); }, 100);
    });

    hydrateCssPreview(root);
    refreshAppliedList(root);
  }

  function saveAtelierFromRoot(root, chatId) {
    var patch = readAtelierFromRoot(root);
    if (chatId) return saveChatBeautify(chatId, patch);
    return Promise.resolve(normalizeBeautify(patch));
  }

  global.MiyaChatBeautify = {
    BUILTIN_THEMES: BUILTIN_THEMES,
    normalizeBeautify: normalizeBeautify,
    applyForChat: applyForChat,
    applyToRoomEl: applyToRoomEl,
    resolveWallpaperUrl: resolveWallpaperUrl,
    saveChatBeautify: saveChatBeautify,
    saveAtelierFromRoot: saveAtelierFromRoot,
    readAtelierFromRoot: readAtelierFromRoot,
    buildAtelierPanelHtml: buildAtelierPanelHtml,
    bindAtelierRoot: bindAtelierRoot,
    copySource: copySource,
    downloadSource: downloadSource,
    buildSourceReferenceHtml: buildSourceReferenceHtml,
    getFullSourcePack: getFullSourcePack,
    getCssReference: getFullSourcePack,
    getBubbleCssReference: getFullSourcePack,
    whenPresetsReady: whenPresetsReady,
    loadPresets: loadPresets,
    savePreset: savePreset,
    deletePreset: deletePreset,
    findPreset: findPreset,
    buildPresetEditorHtml: buildPresetEditorHtml,
    buildChatSettingsBeautifyHtml: buildChatSettingsBeautifyHtml,
    buildContactPresetFieldHtml: buildContactPresetFieldHtml,
    readChatBeautifyFromRoot: readChatBeautifyFromRoot,
    beautifyFromPresetName: beautifyFromPresetName,
    refreshPresetSelect: refreshPresetSelect,
    refreshAppliedList: refreshAppliedList,
    buildAppliedBlockHtml: buildAppliedBlockHtml,
    getChatsWithAppliedBeautify: getChatsWithAppliedBeautify,
    clearAppliedBeautifyForChat: clearAppliedBeautifyForChat,
    hydrateCssPreview: hydrateCssPreview,
    clearPreviewCss: clearPreviewCss,
    toast: toast
  };

  if (global.miyaRegisterKvStore) {
    global.miyaRegisterKvStore({ whenReady: whenPresetsReady });
  }
  whenPresetsReady();
})(window);
