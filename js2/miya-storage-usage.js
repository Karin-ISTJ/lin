/*
 * 存储占用统计引擎。
 *
 * ── 这个模块做什么 ──────────────────────────────────────────────
 *
 * 把浏览器里散落的持久化数据（localStorage 键值 + 若干 IndexedDB
 * 对象库）按业务分类汇总成「哪个模块占了多少」，并支持按分类清理。
 *
 * ── 为什么从设置 App 里搬出来 ──────────────────────────────────
 *
 * 与 backup 同理：这些函数一个 DOM 都不碰（写入 DOM 的部分留在
 * 界面层 renderStoragePanel*），纯粹是数据统计。原先它们和设置界面
 * 混在一个文件里，导致「存储满了」这类与 UI 无关的场景也得等设置
 * 模块加载完才能算。
 *
 * ── 关于「清空全部数据」───────────────────────────────────────
 *
 * 旧设置 App 里有一个 clearAllStorageData()，一键 localStorage.clear()
 * 并把所有 IDB 库清空。这是一个**没有撤销、没有二次确认以外任何保护**
 * 的操作，而且入口就摆在「用量统计」面板底部，很容易误触。
 * 按需求已删除该功能，此模块不再导出对应接口。
 * 分类级的清理（clearCategory）保留 —— 它有明确范围，风险可控。
 */
(function (global) {
  'use strict';

  /* ── 存储分类清单 ────────────────────────────────────────────
   * 每一项就是一「类」数据，面板按这里的顺序与标题展示。
   * lsKeys 是 localStorage 逻辑键；widgetKvKeys 是需要额外
   * 从 IDB KV 里核对的键（同一份数据可能两端都有）。
   */
  var API_CONFIG_KEY = 'miya-api-config';
  var API_PRESETS_KEY = 'miya-api-presets';
  var IMAGE_GEN_PRESETS_KEY = 'miya-image-gen-presets-v1';
  var SYSTEM_PREFS_KEY = 'miya-system-prefs-v1';
  var MSG_SOUND_SETTINGS_KEY = 'miya-msg-sound-v1';
  var GLOBAL_BREAK_KEY = 'miya-global-break-prompt';
  var THEME_META_KEY = 'miya-theme-meta';
  var THEME_PRESETS_KEY = 'miya-theme-presets';
  var BACKUP_VERSION = 4;
  var LS_PLACEHOLDER_JSON = '{"__storedInIdb":true}';
  var LS_SPILL_BYTES = global.miyaLsSpillBytes || 49152;

  var WORLDBOOK_KEY = 'miya-worldbook-v1';
  var CONTACTS_KEY = 'miya-contacts-v1';
  var CONTACTS_REL_KEY = 'miya-contacts-relationships';
  var CHAT_META_KEY = 'miya-chat-meta';
  var CHAT_GLOBAL_SETTINGS_KEY = 'miya-chat-global-settings-v1';
  var CHAT_MOMENTS_KEY = 'miya-moments-v1';
  var CHAT_BEAUTIFY_KEY = 'miya-chat-beautify-presets-v1';
  var CHAT_APP_BEAUTIFY_KEY = 'miya-chat-app-beautify-v1';
  var CHAT_APP_BEAUTIFY_PRESETS_KEY = 'miya-chat-app-beautify-presets-v1';
  var CHAT_META_BACKUP_KEY = 'miya-chat-meta:backup';
  var CHAT_OPERATION_RULES_KEY = 'miya-chat-operation-rules-presets-v1';
  var CHAT_THINKING_RULES_KEY = 'miya-chat-thinking-rules-presets-v1';
  var CHAT_UI_THEME_KEY = 'miya-chat-ui-theme';
  var CHAT_TIMESTAMPS_KEY = 'miya-chat-show-timestamps-v1';
  var DIARY_KEY = 'miya-diary-v1';
  var APPOINTMENT_KEY = 'miya-appointment-v1';
  var APPOINTMENT_BACKUP_KEY = 'miya-appointment-v1-backup';
  var OFFLINE_BEAUTIFY_PRESETS_KEY = 'miya-offline-beautify-presets-v1';
  var ITINERARY_KEY = 'miya-itinerary-v1';
  var WEATHER_KEY = 'miya-weather-v1';
  var COUPLE_KEY = 'miya-couple-v1';
  var COUPLE_WHISPER_KEY = 'miya-couple-whisper-v1';
  var ALBUM_KEY = 'miya-album-v1';
  var LOCK_KEY = 'miya-lock-meta';
  var DESK_LAYOUT_KEY = 'miya-desk-layout-mode';
  var DESK_CUSTOM_KEY = 'miya-desk-custom-v1';
  var DESK_CUSTOM_PRESETS_KEY = 'miya-desk-custom-presets-v1';
  var DESK_WIDGET_PRESETS_KEY = 'miya-desk-custom-widget-presets-v1';
  var DESK_WIDGET_DRAFT_KEY = 'miya-desk-custom-widget-draft-v1';
  /* 各业务模块的存储键。改这里等于改面板的分类口径，必须与
     真正写数据的地方保持一致，否则统计会出现「漏算」或「重复计」。 */
  var STORAGE_CATALOG = [
    {
      id: 'theme',
      title: '外观与桌面',
      lsKeys: [
        THEME_META_KEY,
        THEME_PRESETS_KEY,
        LOCK_KEY,
        DESK_LAYOUT_KEY,
        DESK_CUSTOM_KEY,
        DESK_CUSTOM_PRESETS_KEY,
        DESK_WIDGET_PRESETS_KEY,
        DESK_WIDGET_DRAFT_KEY
      ],
      widgetKvKeys: [THEME_META_KEY, THEME_PRESETS_KEY, DESK_LAYOUT_KEY, DESK_CUSTOM_KEY, DESK_CUSTOM_PRESETS_KEY, DESK_WIDGET_PRESETS_KEY],
      themeMediaIdb: true
    },
    {
      id: 'api',
      title: '系统与接口',
      lsKeys: [API_CONFIG_KEY, API_PRESETS_KEY, IMAGE_GEN_PRESETS_KEY, GLOBAL_BREAK_KEY, SYSTEM_PREFS_KEY, MSG_SOUND_SETTINGS_KEY],
      widgetKvKeys: [API_CONFIG_KEY, API_PRESETS_KEY, IMAGE_GEN_PRESETS_KEY],
      msgSoundIdb: true
    },
    { id: 'worldbook', title: '典籍片段', lsKeys: [WORLDBOOK_KEY], widgetKvKeys: [WORLDBOOK_KEY] },
    { id: 'contacts', title: '联系人档案', lsKeys: [CONTACTS_KEY, CONTACTS_REL_KEY], widgetKvKeys: [CONTACTS_KEY, CONTACTS_REL_KEY] },
    {
      id: 'chat',
      title: '聊天与会话',
      lsKeys: [CHAT_META_KEY, CHAT_META_BACKUP_KEY, CHAT_GLOBAL_SETTINGS_KEY, CHAT_MOMENTS_KEY, CHAT_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_PRESETS_KEY, CHAT_OPERATION_RULES_KEY, CHAT_THINKING_RULES_KEY, CHAT_UI_THEME_KEY, CHAT_TIMESTAMPS_KEY, ALBUM_KEY],
      widgetKvKeys: [CHAT_META_KEY, CHAT_META_BACKUP_KEY, CHAT_GLOBAL_SETTINGS_KEY, CHAT_MOMENTS_KEY, CHAT_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_PRESETS_KEY, CHAT_OPERATION_RULES_KEY, CHAT_THINKING_RULES_KEY, CHAT_TIMESTAMPS_KEY, ALBUM_KEY],
      chatMediaIdb: true
    },
    { id: 'diary', title: '日记', lsKeys: [DIARY_KEY], widgetKvKeys: [DIARY_KEY] },
    {
      id: 'offline',
      title: '线下剧情',
      lsKeys: [APPOINTMENT_KEY, APPOINTMENT_BACKUP_KEY, OFFLINE_BEAUTIFY_PRESETS_KEY],
      widgetKvKeys: [APPOINTMENT_KEY, APPOINTMENT_BACKUP_KEY, OFFLINE_BEAUTIFY_PRESETS_KEY]
    },
    { id: 'itinerary', title: '行程轨迹', lsKeys: [ITINERARY_KEY], widgetKvKeys: [ITINERARY_KEY] },
    { id: 'weather', title: '天气', lsKeys: [WEATHER_KEY], widgetKvKeys: [WEATHER_KEY] },
    { id: 'couple', title: '情侣空间', lsKeys: [COUPLE_KEY, COUPLE_WHISPER_KEY], widgetKvKeys: [COUPLE_KEY, COUPLE_WHISPER_KEY] }
  ];

  function formatBytes(n) {
    var x = Number(n) || 0;
    if (x < 1024) return x + ' B';
    if (x < 1048576) return (x / 1024).toFixed(1) + ' KB';
    return (x / 1048576).toFixed(2) + ' MB';
  }

  function lsUtf8Bytes(s) {
    try { return new Blob([s == null ? '' : String(s)]).size; } catch (e) {
      return (s && String(s).length) || 0;
    }
  }

  function estimateValueBytes(val, seen) {
    if (val == null) return 0;
    if (typeof Blob !== 'undefined' && val instanceof Blob) return Number(val.size) || 0;
    if (typeof ArrayBuffer !== 'undefined' && val instanceof ArrayBuffer) return Number(val.byteLength) || 0;
    if (typeof val !== 'object') return lsUtf8Bytes(val);
    if (!seen && typeof WeakSet !== 'undefined') seen = new WeakSet();
    if (seen && seen.has(val)) return 0;
    if (seen) seen.add(val);
    if (Array.isArray(val)) {
      var sum = 0;
      for (var i = 0; i < val.length; i++) sum += estimateValueBytes(val[i], seen);
      return sum;
    }
    var objSum = 0;
    Object.keys(val).forEach(function (k) { objSum += estimateValueBytes(val[k], seen); });
    return objSum;
  }

  function isLsIdbPlaceholder(raw) {
    return global.miyaLsIsIdbPlaceholder ? global.miyaLsIsIdbPlaceholder(raw) : false;
  }

  function widgetKvFullKey(logical) {
    return 'widgetKV:' + String(logical || '');
  }

  /** 统计某逻辑键在 IDB KV 中的占用（含 plain key 与旧版 widgetKV: 前缀） */
  function estimateLogicalKvBytes(idbMap, logical, lsSizes, lsPlaceholder) {
    var key = String(logical || '');
    if (!key) return 0;
    var plain = estimateValueBytes(idbMap[key]);
    var legacy = estimateValueBytes(idbMap[widgetKvFullKey(key)]);
    var bytes = plain + legacy;
    if (!bytes) return 0;
    var lsB = Number(lsSizes[key]) || 0;
    var isPh = !!(lsPlaceholder && lsPlaceholder[key]);
    /* LS 已有完整镜像时只计 IDB 多出来的部分，避免双计；占位符则整段计入 IDB */
    if (!isPh && lsB > 0) return Math.max(0, bytes - lsB);
    return bytes;
  }

  function catalogLogicalKeys(cat) {
    var seen = {};
    var out = [];
    function push(k) {
      k = String(k || '');
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(k);
    }
    (cat.lsKeys || []).forEach(push);
    (cat.widgetKvKeys || []).forEach(push);
    return out;
  }

  /*
   * 存储用量快照。
   *
   * force 参数以前是「接了但不用」—— collectStorageContext 无参数、也无缓存，
   * 注释却承诺 force=true 绕过缓存。文档与实现不符比没有文档更糟：
   * 调用方按注释以为拿到了新鲜数据，实际拿到的是什么全看运气。
   *
   * 现在改成**真缓存 + force 语义落地**：
   *   collect()        → 命中缓存则复用（默认 TTL 内不重复扫 IDB）
   *   collect(true)    → 强制重扫，并把结果写回缓存
   * 扫描要遍历 localStorage + 多个 IDB 库，是重活；
   * 重新扫描按钮和后台上下文统计都在调它，不加缓存会白扫很多遍。
   */
  var STORAGE_CTX_TTL_MS = 4000;
  var storageCtxCache = null;
  var storageCtxCacheAt = 0;

  async function collectStorageContext(force) {
    var now = Date.now();
    if (!force && storageCtxCache && now - storageCtxCacheAt < STORAGE_CTX_TTL_MS) {
      return storageCtxCache;
    }
    var lsSizes = {};
    var lsPlaceholder = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        var v = localStorage.getItem(k);
        lsSizes[k] = lsUtf8Bytes(v);
        if (isLsIdbPlaceholder(v)) lsPlaceholder[k] = true;
      }
    } catch (e) {}

    var idbMap = {};
    try {
      idbMap = await global.miyaKvIdbExportAllEntries();
    } catch (e2) {}

    var themeMediaBytes = 0;
    try {
      var tm = await global.miyaKvExportNamedDbKv('miya-theme-media', 'blobs');
      Object.keys(tm || {}).forEach(function (key) {
        themeMediaBytes += estimateValueBytes(tm[key]);
      });
    } catch (e3) {}

    var chatMediaBytes = 0;
    try {
      var cm = await global.miyaKvExportNamedDbKv('miya-chat-media', 'blobs');
      Object.keys(cm || {}).forEach(function (key) {
        chatMediaBytes += estimateValueBytes(cm[key]);
      });
    } catch (eChat) {}

    var msgSoundBytes = 0;
    try {
      var ms = await global.miyaKvExportNamedDbKv('miya-msg-sound-v1', 'blobs');
      Object.keys(ms || {}).forEach(function (key) {
        msgSoundBytes += estimateValueBytes(ms[key]);
      });
    } catch (eMsgSound) {}

    var groupLs = {};
    STORAGE_CATALOG.forEach(function (c) { groupLs[c.id] = 0; });
    STORAGE_CATALOG.forEach(function (c) {
      (c.lsKeys || []).forEach(function (k) {
        groupLs[c.id] += Number(lsSizes[k]) || 0;
      });
      catalogLogicalKeys(c).forEach(function (logical) {
        groupLs[c.id] += estimateLogicalKvBytes(idbMap, logical, lsSizes, lsPlaceholder);
      });
      if (c.themeMediaIdb) groupLs[c.id] += themeMediaBytes;
      if (c.chatMediaIdb) groupLs[c.id] += chatMediaBytes;
      if (c.msgSoundIdb) groupLs[c.id] += msgSoundBytes;
    });

    var stableTotal = 0;
    Object.keys(groupLs).forEach(function (gid) { stableTotal += groupLs[gid] || 0; });

    var quota = 0;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        var est = await navigator.storage.estimate();
        quota = Number(est.quota) || 0;
      } catch (e4) {}
    }
    /*
     * 写回缓存。注意 quota 要走 navigator.storage.estimate()，偶发较慢，
     * 缓存下来正好省掉重复的异步往返。
     */
    storageCtxCache = { groupLs: groupLs, stableTotal: stableTotal, quota: quota };
    storageCtxCacheAt = Date.now();
    return storageCtxCache;
  }


  /*
   * 失效存储用量快照缓存。
   *
   * 外部数据被整体替换后（导入备份、清空分类）必须调用，否则会拿到
   * 4 秒内的旧数字 —— 「导入完了但用量没变」就是这么来的。
   * 早期实现引用了从未声明的 storageContextCache /
   * storageContextPromise / storageSummaryHydrated，strict mode 下
   * 一调用就 ReferenceError，所以一度退化成空操作；现在缓存层补上了，
   * 这里也恢复成真失效。
   */
  function invalidateStorageCache() {
    storageCtxCache = null;
    storageCtxCacheAt = 0;
  }


  async function collectChatMediaImages() {
    var items = [];
    try {
      if (global.miyaChatStore && global.miyaChatStore.init) {
        await global.miyaChatStore.init();
      }
      var msgKeys = global.miyaChatStore && typeof global.miyaChatStore.collectMessageImageBlobKeys === 'function'
        ? global.miyaChatStore.collectMessageImageBlobKeys()
        : {};
      var raw = await global.miyaKvExportNamedDbKv('miya-chat-media', 'blobs');
      Object.keys(raw || {}).forEach(function (key) {
        if (!msgKeys[key]) return;
        var rec = raw[key];
        if (!rec || !rec.blob) return;
        var blob = rec.blob;
        var size = Number(rec.size) || (blob && blob.size) || estimateValueBytes(blob);
        items.push({ key: key, size: size, mime: String(rec.mime || (blob && blob.type) || ''), rec: rec });
      });
    } catch (e) {}
    items.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    var totalBytes = 0;
    items.forEach(function (it) { totalBytes += it.size || 0; });
    return { items: items, totalBytes: totalBytes, count: items.length };
  }


  function idbDeleteNamedDbKey(dbName, storeName, key) {
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(dbName, 1); } catch (e) { resolve(); return; }
      req.onerror = function () { resolve(); };
      req.onsuccess = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(storeName)) { resolve(); return; }
        try {
          var tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).delete(key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e2) { resolve(); }
      };
    });
  }

  function idbPutNamedDbKey(dbName, storeName, key, value) {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(dbName, 1); } catch (e) { reject(e); return; }
      req.onerror = function () { reject(req.error); };
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(storeName)) { reject(new Error('no_store')); return; }
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }


  function compressBlobToJpeg(blob, opts) {
    opts = opts || {};
    var maxEdge = opts.maxEdge != null ? opts.maxEdge : 1280;
    var quality = opts.quality != null ? opts.quality : 0.72;
    return new Promise(function (resolve, reject) {
      if (!blob || typeof blob.slice !== 'function') {
        reject(new Error('no_blob'));
        return;
      }
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        if (!w || !h) { reject(new Error('invalid')); return; }
        var scale = Math.min(1, maxEdge / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, 0, 0, cw, ch);
        canvas.toBlob(function (out) {
          if (!out) { reject(new Error('compress')); return; }
          resolve(out);
        }, 'image/jpeg', quality);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('decode'));
      };
      img.src = url;
    });
  }

  async function compressAllChatImages(items) {
    var ok = 0;
    var saved = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var rec = it.rec || {};
      var blob = rec.blob;
      if (!blob || typeof blob.slice !== 'function') continue;
      try {
        var compressed = await compressBlobToJpeg(blob);
        if (compressed.size >= (it.size || blob.size)) continue;
        var nextRec = Object.assign({}, rec, {
          blob: compressed,
          mime: 'image/jpeg',
          size: compressed.size,
          updatedAt: Date.now()
        });
        await idbPutNamedDbKey('miya-chat-media', 'blobs', it.key, nextRec);
        if (global.miyaChatStore && typeof global.miyaChatStore.invalidateBlobUrl === 'function') {
          global.miyaChatStore.invalidateBlobUrl(it.key);
        }
        saved += Math.max(0, (it.size || blob.size) - compressed.size);
        ok++;
      } catch (e) {}
    }
    /* 改过数据就要让用量快照失效，否则面板还会显示压缩前的数字 */
    if (ok > 0) invalidateStorageCache();
    return { ok: ok, saved: saved };
  }

  /**
   * 删除 collectChatMediaImages() 给出的聊天图片记录。
   * 导出接口早期就挂着这个名字，但函数本体在从设置 App 搬出时丢了，
   * 调用即 TypeError —— 这里补上（与 compressAllChatImages 同构：
   * 逐条删 IDB 记录 + 失效 blob URL，单条失败不中断整批）。
   */
  async function deleteAllChatImages(items) {
    var ok = 0;
    var freed = 0;
    var list = Array.prototype.slice.call(items || []);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || !it.key) continue;
      try {
        await idbDeleteNamedDbKey('miya-chat-media', 'blobs', it.key);
        if (global.miyaChatStore && typeof global.miyaChatStore.invalidateBlobUrl === 'function') {
          global.miyaChatStore.invalidateBlobUrl(it.key);
        }
        freed += Number(it.size) || 0;
        ok++;
      } catch (e) {}
    }
    /* 同上：删过就必须失效，否则「点了清空、用量没降」 */
    if (ok > 0) invalidateStorageCache();
    return { ok: ok, freed: freed };
  }


  async function clearStorageCategory(catId) {
    var cat = STORAGE_CATALOG.filter(function (c) { return c.id === catId; })[0];
    if (!cat) return;
    var logicals = catalogLogicalKeys(cat);
    logicals.forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
      if (global.__miyaKvMem) {
        try { delete global.__miyaKvMem[k]; } catch (eMem) {}
      }
    });
    if (typeof global.miyaKvIdbExportAllEntries === 'function' && typeof global.miyaKvIdbReplaceAllEntries === 'function') {
      var idbMap = await global.miyaKvIdbExportAllEntries().catch(function () { return {}; });
      var next = Object.assign({}, idbMap);
      logicals.forEach(function (logical) {
        delete next[logical];
        delete next[widgetKvFullKey(logical)];
      });
      await global.miyaKvIdbReplaceAllEntries(next);
    }
    if (cat.themeMediaIdb && global.miyaKvReplaceNamedDbKv) {
      await global.miyaKvReplaceNamedDbKv('miya-theme-media', 'blobs', {});
    }
    if (cat.chatMediaIdb && global.miyaKvReplaceNamedDbKv) {
      await global.miyaKvReplaceNamedDbKv('miya-chat-media', 'blobs', {}).catch(function () {});
    }
    if (cat.msgSoundIdb && global.miyaKvReplaceNamedDbKv) {
      await global.miyaKvReplaceNamedDbKv('miya-msg-sound-v1', 'blobs', {}).catch(function () {});
      if (global.MiyaMsgSound && typeof global.MiyaMsgSound.invalidateCache === 'function') {
        global.MiyaMsgSound.invalidateCache();
      }
    }
    if (cat.id === 'api') {
      global.miyaInvalidateApiConfigCache && global.miyaInvalidateApiConfigCache();
      /* 早期这里调用了一个不存在的 invalidateApiPresetsCache()，
         strict mode 下 ReferenceError —— 预设列表的内存缓存也漏掉了失效。
         改为与 miya-backup.js 一致的守卫调用。 */
      if (global.miyaApiPresets && typeof global.miyaApiPresets.invalidate === 'function') {
        global.miyaApiPresets.invalidate();
      }
    }
    if (cat.id === 'worldbook' && global.miyaWorldbookStore) global.miyaWorldbookStore.invalidateCache && global.miyaWorldbookStore.invalidateCache();
    if (cat.id === 'contacts' && global.miyaContactsStore) global.miyaContactsStore.invalidateCache && global.miyaContactsStore.invalidateCache();
    if (cat.id === 'chat' && global.miyaChatStore && global.miyaChatStore.invalidateCache) global.miyaChatStore.invalidateCache();
    if (cat.id === 'chat' && global.miyaChatGlobalSettings) global.miyaChatGlobalSettings.invalidateCache && global.miyaChatGlobalSettings.invalidateCache();
    if (cat.id === 'chat' && global.MiyaChatAlbum && typeof global.MiyaChatAlbum.invalidateCache === 'function') {
      global.MiyaChatAlbum.invalidateCache();
    }
    if (cat.id === 'diary' && global.miyaDiaryStore && global.miyaDiaryStore.invalidateCache) {
      global.miyaDiaryStore.invalidateCache();
    }
    if (cat.id === 'weather' && global.miyaWeatherStore && global.miyaWeatherStore.invalidateCache) {
      global.miyaWeatherStore.invalidateCache();
    }
    if (cat.id === 'couple') {
      if (global.miyaCoupleStore && global.miyaCoupleStore.invalidateCache) global.miyaCoupleStore.invalidateCache();
      if (global.miyaCoupleWhisperStore && global.miyaCoupleWhisperStore.invalidateCache) {
        global.miyaCoupleWhisperStore.invalidateCache();
      }
    }
    if (cat.id === 'itinerary' && global.miyaItineraryStore && global.miyaItineraryStore.invalidateCache) {
      global.miyaItineraryStore.invalidateCache();
    }
    if (cat.id === 'offline' && global.MiyaAppointmentStore && global.MiyaAppointmentStore.invalidateCache) {
      global.MiyaAppointmentStore.invalidateCache();
    }
    /*
     * 最后必须失效**自己的**用量快照缓存。
     *
     * 上面一长串都在失效「别人」的缓存，唯独漏了自己 —— 加了 4 秒 TTL
     * 之后，清完分类紧接着刷新面板会读到旧数字，表现为
     * 「点了清理，用量没降」。所有分类共用这一处出口，放在末尾最稳。
     */
    invalidateStorageCache();
  }

  /* ── 对外接口 ────────────────────────────────────────────────
   * 界面层（原设置 App 的 #miya-st-panel-storage，现迁入聊天设置）
   * 通过 miyaStorageUsage 读数据并自行渲染。
   */
  global.miyaStorageUsage = {
    CATALOG: STORAGE_CATALOG,
    IDB_STORES_BASE_BYTES: function () { return estimateValueBytes; },
    /* 汇总一次完整上下文；force=true 时绕过缓存重新扫描 */
    collect: function (force) { return collectStorageContext(force); },
    /* 只求一个「已用 / 配额 / 百分比」的轻量摘要，给面板首屏用 */
    summary: function () { return collectStorageContext(false); },
    formatBytes: formatBytes,
    /* 按分类清理。返回 true 表示至少清掉了一项。 */
    clearCategory: function (catId) { return clearStorageCategory(catId); },
    collectChatMediaImages: function () { return collectChatMediaImages(); },
    compressAllChatImages: function (items) { return compressAllChatImages(items); },
    deleteAllChatImages: function (items) { return deleteAllChatImages(items); },
    /* 外部数据被替换（导入备份）后让统计缓存失效 */
    invalidate: function () { invalidateStorageCache(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
