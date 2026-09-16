(function (global) {
  'use strict';

  var SETTINGS_KEY = 'miya-msg-sound-v1';
  var AUDIO_DB = 'miya-msg-sound-v1';
  var AUDIO_STORE = 'blobs';
  var MAX_CUSTOM_BYTES = 1024 * 1024;
  var MAX_CUSTOM_PRESETS = 10;

  /*
   * ── 内置提示音 ────────────────────────────────────────────────
   *
   * 两种来源，靠有没有 url 区分：
   *
   *   合成型（没有 url）
   *     用 Web Audio 现场生成，零文件体积。
   *     id 是 'preset-N'，播放走 playBuiltin()。
   *
   *   文件型（有 url）
   *     指向 audio/ 下的 mp3，播放走 playUrl()。
   *     采样率统一 44.1kHz、响度对齐到 -22dB RMS，
   *     这样切来切去不会忽大忽小。
   *
   * 排序：清脆 → 星落 → 和音 → 风铃。
   * 前面几个都是短促单音，和音最长（1 秒），放最后不打断前两个的节奏。
   */
  var BUILTIN = [
    { id: 'preset-1', name: '清脆叮', builtin: true },
    { id: 'preset-6', name: '星落', builtin: true, url: 'audio/msg-xingluo.mp3' },
    { id: 'preset-7', name: '和音', builtin: true, url: 'audio/msg-heyin.mp3' },
    { id: 'preset-5', name: '风铃声', builtin: true }
  ];

  var settings = {
    enabled: true,
    selectedId: 'preset-1',
    customPresets: []
  };

  var audioCtx = null;
  var playingAudio = null;
  var blobUrlCache = Object.create(null);
  var uiBound = false;
  /* 最近一次「UI 反馈音」的播放记录，供排查与测试断言（headless 下听不到声） */
  var lastPlay = null;

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    if (global.miyaSettingsApp && typeof global.miyaSettingsApp.toast === 'function') {
      global.miyaSettingsApp.toast(msg);
      return;
    }
    var div = document.createElement('div');
    div.className = 'ins-toast';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 2400);
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function saveSettings() {
    var str = '';
    try { str = JSON.stringify(settings); } catch (eStr) { return; }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(SETTINGS_KEY, str);
    } else {
      try { localStorage.setItem(SETTINGS_KEY, str); } catch (e) {}
    }
  }

  function loadSettings() {
    var p = loadJson(SETTINGS_KEY, {});
    if (typeof p.enabled === 'boolean') settings.enabled = p.enabled;
    if (typeof p.selectedId === 'string' && p.selectedId) settings.selectedId = p.selectedId;
    if (Array.isArray(p.customPresets)) {
      settings.customPresets = p.customPresets.filter(function (c) {
        return c && c.id && c.name;
      }).map(function (c) {
        return {
          id: String(c.id),
          name: String(c.name).slice(0, 32),
          mime: String(c.mime || 'audio/mpeg'),
          builtin: false
        };
      });
    }
    ensureValidSelection();
  }

  function ensureValidSelection() {
    if (getPresetById(settings.selectedId)) return;
    settings.selectedId = BUILTIN[0].id;
    saveSettings();
  }

  function getPresetById(id) {
    var sid = String(id || '');
    var b = BUILTIN.filter(function (p) { return p.id === sid; })[0];
    if (b) return b;
    return settings.customPresets.filter(function (p) { return p.id === sid; })[0] || null;
  }

  function allPresets() {
    return BUILTIN.concat(settings.customPresets);
  }

  function getAudioContext() {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  }

  function resumeAudioContext() {
    var ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
    return ctx;
  }

  function stopPlaying() {
    if (playingAudio) {
      try {
        playingAudio.pause();
        playingAudio.removeAttribute('src');
        playingAudio.load();
      } catch (e) {}
      playingAudio = null;
    }
  }

  function playTone(ctx, freq, start, dur, type, gainVal) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainVal || 0.35, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  function playBuiltin(id) {
    var ctx = resumeAudioContext();
    if (!ctx) return Promise.resolve();
    var t = ctx.currentTime;
    if (id === 'preset-1') {
      playTone(ctx, 880, t, 0.18, 'sine', 0.4);
    } else if (id === 'preset-5') {
      [784, 988, 1175, 988].forEach(function (f, i) {
        playTone(ctx, f, t + i * 0.09, 0.22, 'sine', 0.26);
      });
    }
    return Promise.resolve();
  }

  function openAudioDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(AUDIO_DB, 1); } catch (e) { reject(e); return; }
      req.onerror = function () { reject(req.error); };
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
    });
  }

  function idbPutBlob(key, blob) {
    return openAudioDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(AUDIO_STORE, 'readwrite');
        tx.objectStore(AUDIO_STORE).put(blob, key);
        tx.oncomplete = function () { resolve(key); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGetBlob(key) {
    return openAudioDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(AUDIO_STORE, 'readonly');
        var req = tx.objectStore(AUDIO_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDeleteBlob(key) {
    return openAudioDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(AUDIO_STORE, 'readwrite');
        tx.objectStore(AUDIO_STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getBlobUrl(key) {
    if (blobUrlCache[key]) return Promise.resolve(blobUrlCache[key]);
    return idbGetBlob(key).then(function (blob) {
      if (!blob) return '';
      var url = URL.createObjectURL(blob);
      blobUrlCache[key] = url;
      return url;
    });
  }

  function invalidateBlobUrl(key) {
    if (blobUrlCache[key]) {
      try { URL.revokeObjectURL(blobUrlCache[key]); } catch (e) {}
      delete blobUrlCache[key];
    }
  }

  /*
   * 播放文件型音效（内置的 audio/*.mp3，以及用户上传的自定义音频）。
   *
   * 和 playCustom 的区别只在音源：这里是现成的 url（项目内相对路径），
   * 不用去 IndexedDB 取 blob。播放控制逻辑完全一致，所以合成一个函数，
   * 免得两份 <audio> 管理代码各自演化出不一致的行为。
   */
  function playUrl(url) {
    if (!url) return Promise.resolve();
    stopPlaying();
    var audio = new Audio(url);
    playingAudio = audio;
    audio.volume = 0.85;
    var p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(function () {});
    audio.onended = function () {
      if (playingAudio === audio) playingAudio = null;
    };
    return Promise.resolve();
  }

  function playCustom(id) {
    return getBlobUrl(id).then(function (url) {
      return playUrl(url);
    });
  }

  /*
   * 统一的「按预设播放」入口。
   *
   * 三种来源在这里收口，调用方不用关心 preset 是哪种：
   *   有 url  → 文件（内置的 audio/*.mp3）
   *   builtin → 现场合成
   *   其余    → IndexedDB 里的用户音频
   */
  function playPreset(preset) {
    if (!preset) return Promise.resolve();
    if (preset.url) return playUrl(preset.url);
    if (preset.builtin) return playBuiltin(preset.id);
    return playCustom(preset.id);
  }

  function playSelected() {
    if (!settings.enabled) return Promise.resolve();
    var preset = getPresetById(settings.selectedId);
    if (!preset) return Promise.resolve();
    stopPlaying();
    return playPreset(preset);
  }

  /*
   * ── 两个新的播放入口：生图成功 / 线下生成完毕 ──────────────────
   *
   * 为什么不让调用方直接用 playSelected() ——
   * playSelected 只受总开关（settings.enabled）控制，语义是「无条件播一声」。
   * 而这两处是**用户正在界面上操作**时的反馈音，跟「来了新消息」不是一回事：
   *
   *   · 它们**不该**受 shouldPlayForChat 里那条「聊天室开着就不响」的规则约束
   *     （那条是给新消息用的，防止你正看着聊天还响铃；而生成完成时
   *      你本来就盯着屏幕等结果，正需要这一声）。
   *   · 但它们**该**受总开关约束 —— 设置里关掉提示音，这几处也不该响，
   *     否则「关了还在响」会让人以为开关坏了。
   *
   * 所以这里只查总开关，不查聊天室前台。命名上明确是「UI 反馈」，
   * 免得以后有人顺手把消息那套抑制规则也套上来。
   */
  function playUiFeedback(reason) {
    if (!settings.enabled) return Promise.resolve();
    /* 记一个轻量标记，便于排查「到底响没响、为什么响」，
       也供自动化测试断言（测试跑在无音频输出的 headless 里，
       光听是听不到的）。 */
    lastPlay = { at: Date.now(), reason: String(reason || 'ui') };
    return playSelected();
  }

  /* 生图成功（线上角色发图 / 自由生图 / 测试生图 / 线下配图）*/
  function playForImageGenDone() {
    return playUiFeedback('image-gen');
  }

  /* 线下（约会场景）整段生成完毕 */
  function playForOfflineDone() {
    return playUiFeedback('offline-done');
  }

  function preview(id) {
    var preset = getPresetById(id);
    if (!preset) return Promise.resolve();
    stopPlaying();
    return playPreset(preset);
  }

  function selectPreset(id) {
    if (!getPresetById(id)) return;
    settings.selectedId = id;
    saveSettings();
    renderSettingsPanel();
  }

  function setEnabled(on) {
    settings.enabled = !!on;
    saveSettings();
    syncToggle();
  }

  function isAudioFile(file) {
    if (!file) return false;
    var name = String(file.name || '').toLowerCase();
    if (/\.(mp3|m4a|flac|aac|ogg|wav|opus|webm|mp4)(\?.*)?$/.test(name)) return true;
    return String(file.type || '').toLowerCase().indexOf('audio/') === 0;
  }

  function uuid() {
    return 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function promptName(defaultName) {
    if (global.miyaDialog && typeof global.miyaDialog.prompt === 'function') {
      return global.miyaDialog.prompt({
        title: '保存为预设',
        message: '为这段音频取个名字',
        defaultValue: defaultName || '我的提示音',
        confirmText: '保存',
        cancelText: '取消',
        maxLength: 32
      });
    }
    var n = prompt('为这段音频取个名字', defaultName || '我的提示音');
    return Promise.resolve(n ? String(n).trim() : '');
  }

  function uploadAudioFile(file) {
    if (!isAudioFile(file)) {
      toast('请选择音频文件');
      return Promise.resolve();
    }
    if (file.size > MAX_CUSTOM_BYTES) {
      toast('音频文件不能超过 1MB');
      return Promise.resolve();
    }
    if (settings.customPresets.length >= MAX_CUSTOM_PRESETS) {
      toast('自定义预设最多 ' + MAX_CUSTOM_PRESETS + ' 个');
      return Promise.resolve();
    }
    var baseName = String(file.name || '提示音').replace(/\.[^.]+$/, '').slice(0, 32);
    return promptName(baseName).then(function (name) {
      name = String(name || '').trim();
      if (!name) return;
      var id = uuid();
      var mime = String(file.type || 'audio/mpeg');
      return idbPutBlob(id, file).then(function () {
        settings.customPresets.push({ id: id, name: name, mime: mime, builtin: false });
        settings.selectedId = id;
        saveSettings();
        renderSettingsPanel();
        toast('已保存为「' + name + '」');
        return preview(id);
      }).catch(function () {
        toast('保存失败');
      });
    });
  }

  function deleteCustomPreset(id) {
    var preset = settings.customPresets.filter(function (p) { return p.id === id; })[0];
    if (!preset) return Promise.resolve();
    var doDelete = function () {
      return idbDeleteBlob(id).then(function () {
        invalidateBlobUrl(id);
        settings.customPresets = settings.customPresets.filter(function (p) { return p.id !== id; });
        if (settings.selectedId === id) settings.selectedId = BUILTIN[0].id;
        saveSettings();
        renderSettingsPanel();
        toast('已删除「' + preset.name + '」');
      });
    };
    if (global.miyaDialog && typeof global.miyaDialog.confirm === 'function') {
      return global.miyaDialog.confirm({
        title: '删除预设',
        message: '确定删除「' + preset.name + '」？',
        confirmText: '删除',
        cancelText: '取消'
      }).then(function (ok) { if (ok) return doDelete(); });
    }
    if (confirm('确定删除「' + preset.name + '」？')) return doDelete();
    return Promise.resolve();
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPresetItem(preset) {
    var selected = settings.selectedId === preset.id;
    var delBtn = preset.builtin
      ? ''
      : '<button type="button" class="st-msgsound-item__del" data-msgsound-del="' + esc(preset.id) + '" aria-label="删除">×</button>';
    return (
      '<div class="st-msgsound-item' + (selected ? ' is-selected' : '') + '" data-msgsound-id="' + esc(preset.id) + '">' +
        '<button type="button" class="st-msgsound-item__pick" data-msgsound-pick="' + esc(preset.id) + '" aria-label="选择 ' + esc(preset.name) + '">' +
          '<span class="st-msgsound-item__radio" aria-hidden="true"></span>' +
        '</button>' +
        '<span class="st-msgsound-item__name">' + esc(preset.name) + '</span>' +
        '<button type="button" class="st-msgsound-item__preview" data-msgsound-preview="' + esc(preset.id) + '">试听</button>' +
        delBtn +
      '</div>'
    );
  }

  function renderSettingsPanel() {
    var builtinEl = $('miya-st-msgsound-presets');
    var customEl = $('miya-st-msgsound-custom-list');
    if (builtinEl) {
      builtinEl.innerHTML = BUILTIN.map(renderPresetItem).join('');
    }
    if (customEl) {
      if (!settings.customPresets.length) {
        customEl.innerHTML = '<p class="st-msgsound-empty">暂无自定义预设，点击上方按钮上传</p>';
      } else {
        customEl.innerHTML = settings.customPresets.map(renderPresetItem).join('');
      }
    }
    syncToggle();
  }

  function syncToggle() {
    var sw = $('miya-st-sw-msgsound');
    if (!sw) return;
    sw.classList.toggle('is-on', settings.enabled);
    sw.setAttribute('aria-checked', settings.enabled ? 'true' : 'false');
  }

  function bindSettingsUi() {
    if (uiBound) return;
    uiBound = true;

    var sw = $('miya-st-sw-msgsound');
    if (sw) {
      sw.addEventListener('click', function () {
        var on = !sw.classList.contains('is-on');
        sw.classList.toggle('is-on', on);
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        setEnabled(on);
        if (on) preview(settings.selectedId);
      });
    }

    var uploadBtn = $('miya-st-msgsound-upload');
    var fileInput = $('miya-st-msgsound-file');
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (f) uploadAudioFile(f);
      });
    }

    var panel = $('miya-st-panel-msg-sound');
    if (panel) {
      panel.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        var pick = t.closest('[data-msgsound-pick]');
        if (pick) {
          selectPreset(pick.getAttribute('data-msgsound-pick'));
          return;
        }
        var prev = t.closest('[data-msgsound-preview]');
        if (prev) {
          preview(prev.getAttribute('data-msgsound-preview'));
          return;
        }
        var del = t.closest('[data-msgsound-del]');
        if (del) {
          deleteCustomPreset(del.getAttribute('data-msgsound-del'));
        }
      });
    }
  }

  function shouldPlayForChat(chatId) {
    if (!settings.enabled) return false;
    if (!chatId) return false;
    var store = global.miyaChatStore;
    if (store) {
      var chatSettings = store.getChatSettings(chatId);
      if (chatSettings && chatSettings.muteNotifications) return false;
    }
    if (
      global.MiyaChatNotify &&
      typeof global.MiyaChatNotify.isChatRoomForeground === 'function' &&
      global.MiyaChatNotify.isChatRoomForeground(chatId)
    ) {
      return false;
    }
    return true;
  }

  function playForIncomingMessage(chatId, msgs) {
    if (!shouldPlayForChat(chatId)) return;
    if (!Array.isArray(msgs) || !msgs.length) return;
    playSelected();
  }

  function invalidateCache() {
    Object.keys(blobUrlCache).forEach(invalidateBlobUrl);
    loadSettings();
  }

  loadSettings();
  bindSettingsUi();

  global.MiyaMsgSound = {
    play: playSelected,
    preview: preview,
    playForIncomingMessage: playForIncomingMessage,
    shouldPlayForChat: shouldPlayForChat,
    /* 场景化播放入口（生图成功 / 线下生成完毕）*/
    playUiFeedback: playUiFeedback,
    playForImageGenDone: playForImageGenDone,
    playForOfflineDone: playForOfflineDone,
    /* 测试后门：读最近一次 UI 反馈音的记录（headless 里听不到声，只能看记录）*/
    __testLastPlay: function () { return lastPlay ? Object.assign({}, lastPlay) : null; },
    __testResetLastPlay: function () { lastPlay = null; },
    isEnabled: function () { return settings.enabled; },
    /*
     * 开关的对外读写。
     *
     * 之前只有 isEnabled（只读），写入口是 UI 上那个开关独占的。
     * 现在三个场景都要受它管辖，测试也得能直接开合 ——
     * 否则「关掉总开关后到底还响不响」这条根本没法验证。
     * 顺手也让其它模块（比如将来的静音管理）有正规途径改这个状态。
     */
    setEnabled: setEnabled,
    getSettings: function () {
      return {
        enabled: settings.enabled,
        selectedId: settings.selectedId,
        customPresets: settings.customPresets.slice()
      };
    },
    onPanelOpen: function () {
      bindSettingsUi();
      renderSettingsPanel();
    },
    invalidateCache: invalidateCache,
    SETTINGS_KEY: SETTINGS_KEY,
    AUDIO_DB: AUDIO_DB
  };
})(window);
