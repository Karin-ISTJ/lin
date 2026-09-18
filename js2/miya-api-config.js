/*
 * API 配置数据层。
 *
 * ── 为什么这个文件必须存在 ──────────────────────────────────────
 *
 * 这一段原本长在 `miya-settings-app.js` 里 —— 一个取名「设置 App」的文件。
 * 名字骗了人：它同时是整个应用的 API 配置数据引擎，被 **25 处外部调用**
 * 依赖，横跨对话、朋友圈、记忆提炼、语音合成、线下剧情、情侣密语、生图：
 *
 *   miyaGetApiConfigCached()      16 处
 *   miyaGetGlobalBreakPrompt()     5 处
 *   miyaGetSystemPrefs()           2 处
 *
 * 所以当决定「删掉桌面设置这个入口」时，不能直接把那个文件删掉 ——
 * 那会一次性打断 15 个模块。做法只能是把数据层先搬出来独立成文件，
 * 保证这 25 处调用**一字不改**仍然工作，然后才去动 UI。
 *
 * ── 这里保留了原实现里所有「看起来多余」的细节 ──────────────────
 *
 * 水合竞态防护（apiConfigDirty）、写前补齐磁盘底
 * （baseApiConfigForWrite）、占位符识别（__storedInIdb）……
 * 每一条都对应一个真实报过的 bug，注释里写明了是哪一类问题。
 * 搬迁时逐条原样保留，没有做任何「顺便优化」。
 */
(function (global) {
  'use strict';

  /* ── 存储 key ────────────────────────────────────────────────
   * 与旧文件完全同名。改这些名字等于让所有老用户的数据失联。
   * 注意：对话 API 与语音 TTS（minimaxTts）**同住** API_CONFIG_KEY，
   * 不是两个键 —— 拆成两个会导致老数据只迁移一半。 */
  var API_CONFIG_KEY = 'miya-api-config';
  var API_PRESETS_KEY = 'miya-api-presets';
  var GLOBAL_BREAK_KEY = 'miya-global-break-prompt';
  var SYSTEM_PREFS_KEY = 'miya-system-prefs-v1';
  var MODEL_CACHE_KEY = 'miya-api-model-cache-v1';

  /* 模型列表兜底缓存的保鲜期：超过这个时长就不先用旧值，避免填出一份过期列表 */
  var MODEL_CACHE_TTL = 14 * 24 * 60 * 60 * 1000;

  var apiConfigCache = null;
  var apiConfigHydrated = false;

  /*
   * 水合竞态防护：用户在本轮会话里改过配置后置真。
   * 背景：配置正本在 IndexedDB，localStorage 只留占位符时，冷启动要异步水合才读得回来。
   * 若用户在「读回来」之前就点了保存，随后的水合会把磁盘旧值灌回缓存，
   * 把刚保存的选择覆盖掉 —— 表现为「明明选了非流式，保存后重开又变回流式」。
   * 有了这个标记，水合只补齐本地没有的键，已在本会话写过的键一律以内存为准。
   */
  var apiConfigDirty = false;

  var apiPresetsCache = null;
  var apiPresetsReady = null;

  /*
   * 预设写操作的串行队列。
   *
   * 为什么必须有它 —— 这是一个真实报过的 bug：
   * 「对话 API 的预设没法保存和删除」。
   *
   * 原先 upsert / remove 都写 `ensureApiPresetsReady().then(function (list) {...})`，
   * 而 ensureApiPresetsReady() 只会在**第一次**真正加载，之后永远返回当初那个
   * 已 resolve 的 promise —— 它闭包里捕获的是**首次加载的列表**。
   * 于是每次保存都变成「首次快照 + 这一条」，上一次保存的必然被冲掉：
   *   连存 4 条 → 磁盘上只剩最后 1 条；背靠背两次 upsert → 只剩第 2 条。
   * 用户感知就是「存不上、删不掉」。
   *
   * （find() 当初就避开了这个坑 —— 它 ensureReady().then 里重新读 apiPresetsCache，
   *   注释里也写明了原因。但 upsert / remove 漏了。）
   *
   * 修法：所有读-改-写都排进这条链，轮到它时才取**当前**的 apiPresetsCache。
   * 这样不但修掉陈旧快照，也顺带把「用户连点两下保存」的并发覆盖一并挡掉。
   */
  var apiPresetsChain = Promise.resolve();

  var systemPrefs = {
    notify: false
  };

  /* ── 基础读写 ──────────────────────────────────────────────── */

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  }

  function isIdbPlaceholderConfig(obj) {
    return !!(obj && typeof obj === 'object' && obj.__storedInIdb === true);
  }

  /* ── 对话 / 语音 API 配置 ──────────────────────────────────── */

  function getApiConfig() {
    if (apiConfigCache && !isIdbPlaceholderConfig(apiConfigCache)) {
      return Object.assign({}, apiConfigCache);
    }
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var sync = global.miyaSyncReadJsonKey(API_CONFIG_KEY);
      if (sync && typeof sync === 'object' && !isIdbPlaceholderConfig(sync)) {
        apiConfigCache = sync;
        return Object.assign({}, apiConfigCache);
      }
    }
    var loaded = loadJson(API_CONFIG_KEY, {});
    if (isIdbPlaceholderConfig(loaded)) return {};
    apiConfigCache = loaded;
    return Object.assign({}, apiConfigCache);
  }

  /*
   * 异步水合：把 IndexedDB 里的配置正本读回内存缓存。
   *
   * 关键约束（v66 修复）：水合期间若用户已经改过配置（apiConfigDirty），
   * 不能整体覆盖缓存 —— 那会把用户刚保存的选择退回到磁盘旧值。
   * 此时改为「补齐式合并」：磁盘上有而内存里没有的键才补进来
   * （典型是冷启动时 baseUrl / apiKey / model 这些没被本会话动过的字段），
   * 内存里已有的键一律保留。
   */
  function hydrateApiConfigFromIdb() {
    if (typeof global.miyaReadLsJsonKey !== 'function') return Promise.resolve();
    var needsAsync = global.miyaKvKeyNeedsAsyncHydrate && global.miyaKvKeyNeedsAsyncHydrate(API_CONFIG_KEY);
    if (apiConfigHydrated && apiConfigCache && !isIdbPlaceholderConfig(apiConfigCache) && !needsAsync) {
      return Promise.resolve();
    }
    return global.miyaReadLsJsonKey(API_CONFIG_KEY, null).then(function (v) {
      if (v && typeof v === 'object' && !isIdbPlaceholderConfig(v)) {
        if (apiConfigDirty) {
          var live = apiConfigCache && !isIdbPlaceholderConfig(apiConfigCache) ? apiConfigCache : null;
          if (live) {
            /* 以内存为准，磁盘只补空缺键 */
            var merged = Object.assign({}, v, live);
            apiConfigCache = merged;
            if (typeof global.miyaWriteLsJsonKey === 'function') {
              global.miyaWriteLsJsonKey(API_CONFIG_KEY, merged).catch(function () {
                saveJson(API_CONFIG_KEY, merged);
              });
            } else {
              saveJson(API_CONFIG_KEY, merged);
            }
          } else {
            apiConfigCache = v;
          }
        } else {
          apiConfigCache = v;
        }
      }
      apiConfigHydrated = true;
    });
  }

  /*
   * 把磁盘上的配置补进内存（磁盘为底，内存为面）。
   *
   * 为什么需要它：冷启动时 localStorage 可能只剩占位符，真数据要异步读 IDB 才拿得到。
   * 若用户在这之前就点了保存，setApiConfig 会以「空对象」为底合并，
   * 把 baseUrl / apiKey / model 连同用户的新值一起写回磁盘 —— 配置被清空。
   * 所以保存动作本身必须先确认「磁盘数据已经读进来」。
   *
   * 同步路径（miyaSyncReadJsonKey）能拿到就直接用；拿不到再走异步读 IDB，
   * 读完才落盘。整个过程对调用方仍是同步返回，只是写盘被安排在合并之后。
   */
  function baseApiConfigForWrite() {
    var cur = apiConfigCache && !isIdbPlaceholderConfig(apiConfigCache) ? apiConfigCache : null;
    if (cur) return Promise.resolve(Object.assign({}, cur));
    if (!apiConfigHydrated && typeof global.miyaReadLsJsonKey === 'function') {
      return global.miyaReadLsJsonKey(API_CONFIG_KEY, null).then(function (v) {
        var disk = v && typeof v === 'object' && !isIdbPlaceholderConfig(v) ? v : {};
        apiConfigHydrated = true;
        return Object.assign({}, disk, cur || {});
      }).catch(function () {
        apiConfigHydrated = true;
        return Object.assign({}, cur || {});
      });
    }
    return Promise.resolve(Object.assign({}, cur || {}));
  }

  function setApiConfig(next) {
    /* 先把已有的内存值并上本次改动，保证「读回立即生效」是同步的 */
    var optimistic = Object.assign({}, getApiConfig(), next || {});
    apiConfigCache = optimistic;
    /* 记下「本会话已改动」，供 hydrateApiConfigFromIdb 判断能否整体覆盖 */
    apiConfigDirty = true;

    function persist(cfg) {
      if (typeof global.miyaWriteLsJsonKey === 'function') {
        global.miyaWriteLsJsonKey(API_CONFIG_KEY, cfg).catch(function () {
          saveJson(API_CONFIG_KEY, cfg);
        });
      } else {
        saveJson(API_CONFIG_KEY, cfg);
      }
    }

    /*
     * 落盘前先补齐磁盘上的历史字段，避免用空底覆盖。
     * 若同步路径已经读到完整配置（common case），这里直接落盘，行为与旧版一致。
     */
    baseApiConfigForWrite().then(function (base) {
      var merged = Object.assign({}, base, optimistic);
      apiConfigCache = merged;
      persist(merged);
    }).catch(function () {
      persist(optimistic);
    });
  }

  /* ── 对外：25 处调用依赖的三个只读函数 ─────────────────────── */

  global.miyaGetApiConfigCached = getApiConfig;
  global.miyaSetApiConfig = setApiConfig;
  global.miyaEnsureApiConfigHydrated = hydrateApiConfigFromIdb;

  global.miyaInvalidateApiConfigCache = function () {
    apiConfigCache = null;
    apiConfigHydrated = false;
    /* 外部数据被整体替换（清空存储 / 导入备份 / 云同步拉取），
       本会话的「已改动」标记随之作废，否则水合会拿旧内存压掉新数据。 */
    apiConfigDirty = false;
    hydrateApiConfigFromIdb();
  };

  /*
   * 全局破限提示词（global break prompt）。
   * 原先就是一个裸 localStorage 读，没有缓存也没有走 KV 层 ——
   * 搬迁时保持原样，因为对话引擎在每次请求前都会调它（5 处），
   * 改成异步会破坏调用方「同步取字符串」的假设。
   */
  global.miyaGetGlobalBreakPrompt = function () {
    try { return localStorage.getItem(GLOBAL_BREAK_KEY) || ''; } catch (e) { return ''; }
  };

  global.miyaSetGlobalBreakPrompt = function (text) {
    try {
      localStorage.setItem(GLOBAL_BREAK_KEY, String(text == null ? '' : text));
      return true;
    } catch (e) {
      return false;
    }
  };

  /* ── 系统偏好（通知开关） ──────────────────────────────────── */

  function loadSystemPrefs() {
    var p = loadJson(SYSTEM_PREFS_KEY, {});
    if (typeof p.notify === 'boolean') systemPrefs.notify = p.notify;
    var perm = getNotificationPermission();
    if (perm !== 'unsupported' && systemPrefs.notify && perm !== 'granted') {
      systemPrefs.notify = false;
      saveJson(SYSTEM_PREFS_KEY, systemPrefs);
    }
  }

  function persistSystemPrefs() {
    saveJson(SYSTEM_PREFS_KEY, systemPrefs);
  }

  global.miyaGetSystemPrefs = function () {
    return Object.assign({}, systemPrefs);
  };

  global.miyaSetSystemPrefs = function (patch) {
    if (patch && typeof patch === 'object') {
      if (typeof patch.notify === 'boolean') systemPrefs.notify = patch.notify;
    }
    persistSystemPrefs();
    return Object.assign({}, systemPrefs);
  };

  global.miyaLoadSystemPrefs = loadSystemPrefs;

  /* ── 浏览器通知通道 ─────────────────────────────────────────
   * 这段原本也在设置 App 里，但它其实与 UI 无关：只是包一层
   * Notification API 的兼容取用（含 iframe 场景的 window.top 回退），
   * 被 miya-chat-notify.js 等模块使用。 */

  function getNotificationApi() {
    try {
      if (typeof Notification !== 'undefined') return Notification;
      if (window.top && window.top !== window && typeof window.top.Notification !== 'undefined') {
        return window.top.Notification;
      }
      if (window.parent && window.parent !== window && typeof window.parent.Notification !== 'undefined') {
        return window.parent.Notification;
      }
    } catch (e) {}
    return null;
  }

  global.miyaGetNotificationApi = getNotificationApi;

  function getNotificationPermission() {
    var N = getNotificationApi();
    if (!N) return 'unsupported';
    try { return N.permission || 'default'; } catch (e) { return 'unsupported'; }
  }

  global.miyaGetNotificationPermission = getNotificationPermission;

  function requestNotificationPermission() {
    var N = getNotificationApi();
    if (!N || typeof N.requestPermission !== 'function') return Promise.resolve('unsupported');
    try {
      var p = N.requestPermission();
      if (p && typeof p.then === 'function') return p;
    } catch (e) {}
    return Promise.resolve(getNotificationPermission());
  }

  global.miyaRequestNotificationPermission = requestNotificationPermission;

  function normalizeNotificationOpts(opts) {
    opts = opts && typeof opts === 'object' ? Object.assign({}, opts) : {};
    if (opts.icon) {
      try {
        opts.icon = new URL(opts.icon, location.href).href;
      } catch (e) {
        delete opts.icon;
      }
    }
    if (opts.icon && /^data:/i.test(opts.icon)) delete opts.icon;
    if (!opts.data || typeof opts.data !== 'object') opts.data = {};
    if (!opts.data.url) {
      try {
        opts.data.url = location.href.split('#')[0];
      } catch (e2) {
        opts.data.url = './';
      }
    }
    return opts;
  }

  function showViaNotificationConstructor(N, title, opts) {
    try {
      return new N(String(title || 'miya小手机'), opts);
    } catch (e) {
      return null;
    }
  }

  function showSystemNotification(title, opts) {
    var N = getNotificationApi();
    if (!N || getNotificationPermission() !== 'granted') return Promise.resolve(null);
    var normalized = normalizeNotificationOpts(opts);
    var displayTitle = String(title || 'miya小手机');

    if ('serviceWorker' in navigator) {
      return navigator.serviceWorker.ready
        .then(function (reg) {
          if (reg && typeof reg.showNotification === 'function') {
            return reg
              .showNotification(displayTitle, normalized)
              .then(function () {
                return { _viaSw: true, close: function () {} };
              })
              .catch(function () {
                return showViaNotificationConstructor(N, displayTitle, normalized);
              });
          }
          return showViaNotificationConstructor(N, displayTitle, normalized);
        })
        .catch(function () {
          return showViaNotificationConstructor(N, displayTitle, normalized);
        });
    }
    return Promise.resolve(showViaNotificationConstructor(N, displayTitle, normalized));
  }

  global.miyaShowSystemNotification = showSystemNotification;

  /* ── 接口预设（对话 API 的多套线路） ───────────────────────── */

  async function loadApiPresetsArr() {
    if (typeof global.miyaReadLsJsonKey === 'function') {
      var v = await global.miyaReadLsJsonKey(API_PRESETS_KEY, []);
      return Array.isArray(v) ? v : [];
    }
    return loadJson(API_PRESETS_KEY, []);
  }

  async function saveApiPresetsArr(arr) {
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return !!(await global.miyaWriteLsJsonKey(API_PRESETS_KEY, arr));
    }
    try {
      saveJson(API_PRESETS_KEY, arr);
      return true;
    } catch (e) {
      return false;
    }
  }

  function invalidateApiPresetsCache() {
    apiPresetsCache = null;
    apiPresetsReady = null;
  }

  /* ── 预设的导出 / 导入 ────────────────────────────────────────
   *
   * 为什么需要：预设是用户手打出来的线路配置（网关、密钥、模型、副线路…），
   * 攒起来要花不少时间，但在此之前它们只活在这台设备的浏览器存储里 ——
   * 换设备、清缓存、换浏览器，全部归零。用户明确提了「方便我保存」。
   *
   * 数据层只负责两件事：**产出文件** 和 **解析文件**。
   * 「导出了几条」「要不要提示成功」这类属于 UI，留给调用方 ——
   * 与这个文件既有的分工一致（见上面 upsert 的注释）。
   *
   * ⚠️ 导出内容含密钥明文。这是有意的：用户要的是「能 1:1 还原配置的备份」，
   *    脱敏后的文件还原回来线路就不通了。文件落到下载目录后，
   *    请用户自行注意别转发到公开场合。
   */

  var PRESET_EXPORT_KIND = 'api-presets';
  var PRESET_EXPORT_VERSION = 1;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function presetExportStamp(d) {
    d = d || new Date();
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* 文件名清洗：与项目里其它导出（如 ST 预设）同一套规则 */
  function safeFileLabel(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  /*
   * 把「读进来的一坨 JSON」归一成预设数组。
   *
   * 两种都认：
   *   1. 本模块导出的包装格式 { app, kind, version, presets: [...] }
   *   2. 裸数组 [...]  —— 用户手改过文件、或从别处复制来的，不该直接报错
   * 反向地，导入自己导出的文件必须逐字段还原（含 fallbackApiKey），
   * 否则这个功能就是一次性的。
   */
  function normalizeImportedPresets(raw) {
    var rows = null;
    if (Array.isArray(raw)) {
      rows = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.presets)) {
      rows = raw.presets;
    }
    if (!rows) return null;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== 'object') continue;
      var nm = String(r.name == null ? '' : r.name).trim();
      if (!nm) continue;   /* 没名字的条目没法在下拉里选中，跳过 */
      /* 原样保留所有字段，只把 name 规范化 */
      var item = Object.assign({}, r);
      item.name = nm;
      out.push(item);
    }
    return out;
  }

  /* 按 name 合并：同名覆盖（新值赢），新名追加。与 upsert 语义一致。 */
  function mergeApiPresets(current, incoming) {
    var next = Array.isArray(current) ? current.slice() : [];
    var byName = Object.create(null);
    for (var i = 0; i < next.length; i++) {
      if (next[i] && next[i].name) byName[String(next[i].name)] = i;
    }
    var added = 0, updated = 0;
    for (var j = 0; j < incoming.length; j++) {
      var row = incoming[j];
      var key = String(row.name);
      if (Object.prototype.hasOwnProperty.call(byName, key)) {
        next[byName[key]] = row;
        updated += 1;
      } else {
        next.push(row);
        byName[key] = next.length - 1;
        added += 1;
      }
    }
    return { list: next, added: added, updated: updated };
  }

  /* 导出全部预设。返回 { ok, count, filename } 或 { ok:false, reason } */
  function exportApiPresetsFile() {
    return ensureApiPresetsReady().then(function () {
      var list = Array.isArray(apiPresetsCache) ? apiPresetsCache.slice() : [];
      if (!list.length) return { ok: false, reason: 'empty', count: 0 };

      var payload = {
        app: 'miya-mini-phone',
        kind: PRESET_EXPORT_KIND,
        version: PRESET_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        count: list.length,
        presets: list
      };

      var json;
      try {
        json = JSON.stringify(payload, null, 2);
      } catch (e) {
        return { ok: false, reason: 'stringify_failed', count: list.length };
      }

      var filename = '接口预设-' + presetExportStamp() + '.json';
      try {
        if (typeof global.miyaDownloadBlob === 'function') {
          global.miyaDownloadBlob(
            new Blob([json], { type: 'application/json;charset=utf-8' }),
            filename
          );
        } else {
          /* 极老环境：连 storage 层都没起来，退到裸 a[download] */
          var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e2) {} }, 60000);
        }
      } catch (e3) {
        return { ok: false, reason: 'download_failed', count: list.length };
      }
      return { ok: true, count: list.length, filename: filename };
    });
  }

  /*
   * 从 File 对象导入预设。
   * 走队列写盘，所以「导入的同时手动保存」不会互相覆盖。
   * resolve: { ok, added, updated, total } / { ok:false, reason }
   */
  function importApiPresetsFile(file) {
    return new Promise(function (resolve) {
      if (!file) { resolve({ ok: false, reason: 'no_file' }); return; }
      var reader = new FileReader();
      reader.onerror = function () { resolve({ ok: false, reason: 'read_failed' }); };
      reader.onload = function () {
        var parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (e) {
          resolve({ ok: false, reason: 'invalid_json' });
          return;
        }
        var incoming = normalizeImportedPresets(parsed);
        if (!incoming) { resolve({ ok: false, reason: 'invalid_format' }); return; }
        if (!incoming.length) { resolve({ ok: false, reason: 'empty' }); return; }

        enqueueApiPresets(function (list) {
          return mergeApiPresets(list, incoming).list;
        }).then(function (merged) {
          var stat = mergeApiPresets([], incoming);
          resolve({
            ok: true,
            added: stat.added,
            updated: stat.updated,
            total: Array.isArray(merged) ? merged.length : 0
          });
        }).catch(function () {
          resolve({ ok: false, reason: 'save_failed' });
        });
      };
      reader.readAsText(file, 'utf-8');
    });
  }

  global.miyaApiPresetsExport = {
    exportAll: exportApiPresetsFile,
    importFromFile: importApiPresetsFile,
    /* 测试后门：纯函数，供 e2e 直接验格式归一与合并语义 */
    __normalize: normalizeImportedPresets,
    __merge: mergeApiPresets
  };

  /*
   * ⚠️ 返回的 promise **只保证「首轮加载已完成」**，不再代表「当前数据」。
   *
   * 历史坑（很隐蔽，两处踩过）：
   *   apiPresetsReady 是个只 resolve 一次的 promise，它闭包里捕获的是
   *   **首次加载时的那个数组对象**。upsert / remove 只做
   *   `apiPresetsCache = list.slice()` —— 换成了新对象，但老 promise
   *   仍然指向旧的空数组。
   *
   *   于是「先进面板（那时还没预设）→ 保存一条 → 返回 → 再进面板」时：
   *     getCached()   → ['新预设']   （内存缓存是对的）
   *     ensureReady() → []           （仍是首轮快照）
   *   调用方若拿 ensureReady() 的返回值去重绘，就把正确的下拉**覆盖成空** ——
   *   用户看到「保存成功了，返回再进来就没了」，而数据其实一直好好躺在盘里。
   *
   *   find() 早就因为同一个原因被修过（见下方 find 的注释），
   *   但 hydrateApiPresets / ensureReady 的调用方没跟上，所以同一个 bug 复发。
   *
   * 现在统一约定：**要数据请读 apiPresetsCache（或 getCached()），
   * ensureReady() 只用来等首轮水合完成。** 为兼容既有调用方，
   * 这里额外在 resolve 时把值重定向为「当前缓存」，让老写法也能拿到新数据。
   */
  function ensureApiPresetsReady() {
    if (apiPresetsReady) {
      /* 已就绪：直接返回「此刻」的缓存，而不是当初那个快照 */
      return Promise.resolve(apiPresetsCache || []);
    }
    apiPresetsReady = loadApiPresetsArr().then(function (list) {
      /*
       * 注意这里不能无脑赋值。
       *
       * 冷启动时数据正本在 IndexedDB，异步水合要几十毫秒。若用户手快，
       * 在水合「读回来」之前就点了保存，写操作会先把新列表写进 apiPresetsCache；
       * 随后水合落地，拿到的却是磁盘上的旧值 —— 一旦无脑覆盖，
       * 刚保存的预设连同此前所有预设一起消失。所以只在缓存还没被写操作
       * 更新过时才采用磁盘值。
       */
      if (!Array.isArray(apiPresetsCache)) {
        apiPresetsCache = Array.isArray(list) ? list.slice() : [];
      }
      return apiPresetsCache;
    }).catch(function () {
      if (!Array.isArray(apiPresetsCache)) apiPresetsCache = [];
      return apiPresetsCache;
    });
    return apiPresetsReady;
  }

  /*
   * 把一个读-改-写动作排进串行队列。
   *
   * mutator(currentList) 返回**新的完整列表**；本函数负责落盘并在成功后
   * 把最新列表写回缓存。调用方拿到的 resolve 值永远是「写完之后」的列表，
   * 可以直接拿去重绘下拉框。
   *
   * 队列自身用 .catch(function () {}) 兜住失败：一次写失败（配额满等）
   * 只该让那一次操作 reject，不能毒化后续所有操作 —— 否则用户重试也永远失败。
   */
  function enqueueApiPresets(mutator) {
    var run = apiPresetsChain.then(function () {
      return ensureApiPresetsReady().then(function () {
        var base = Array.isArray(apiPresetsCache) ? apiPresetsCache.slice() : [];
        return Promise.resolve(mutator(base)).then(function (next) {
          var list = Array.isArray(next) ? next : base;
          return saveApiPresetsArr(list).then(function (ok) {
            /*
             * miyaWriteLsJsonKey 的契约是「失败 resolve(false)」而非 reject。
             * 早期这里不看返回值，存储全挂时照样提示「已保存」，刷新后预设消失。
             */
            if (ok === false) throw new Error('api_presets_save_failed');
            apiPresetsCache = list.slice();
            return apiPresetsCache.slice();
          });
        });
      });
    });
    apiPresetsChain = run.catch(function () {});
    return run;
  }

  /*
   * 读写预设的公开接口。渲染下拉框的部分留在 UI 层（已随设置 App 一起
   * 迁进聊天设置），这里只负责数据 —— 数据层不该知道 DOM 长什么样。
   */
  global.miyaApiPresets = {
    KEY: API_PRESETS_KEY,
    load: loadApiPresetsArr,
    save: saveApiPresetsArr,
    ensureReady: ensureApiPresetsReady,
    invalidate: invalidateApiPresetsCache,
    getCached: function () {
      return apiPresetsCache ? apiPresetsCache.slice() : null;
    },
    /*
     * 同名覆盖，其余保持顺序 —— 与旧实现一致。
     * 返回写入后的完整列表，供调用方直接拿去重绘下拉框。
     *
     * ⚠️ 必须走 enqueueApiPresets，不能自己 ensureReady().then 拿 list。
     * 后者拿到的是「首次加载的列表」这个不再更新的快照，会把上一次保存冲掉。
     */
    upsert: function (name, payload) {
      var nm = String(name || '').trim();
      if (!nm) return Promise.resolve(null);
      return enqueueApiPresets(function (list) {
        var next = list.slice();
        var hit = -1;
        for (var i = 0; i < next.length; i++) {
          if (next[i] && String(next[i].name) === nm) { hit = i; break; }
        }
        var item = Object.assign({}, payload || {}, { name: nm });
        if (hit >= 0) next[hit] = item; else next.push(item);
        return next;
      });
    },
    remove: function (name) {
      var nm = String(name || '').trim();
      if (!nm) return Promise.resolve(null);
      return enqueueApiPresets(function (list) {
        return list.filter(function (p) { return !(p && String(p.name) === nm); });
      });
    },
    find: function (name) {
      var nm = String(name || '').trim();
      if (!nm) return Promise.resolve(null);
      /*
       * ★ 必须读 apiPresetsCache，不能读 ensureApiPresetsReady() 的返回值。
       *
       * ensureApiPresetsReady() 只在第一次真正加载，之后永远返回当初
       * 那个已 resolve 的 promise —— 它闭包里捕获的是**首次加载的列表**。
       * upsert / remove 只更新 apiPresetsCache，不会把这个 promise 换掉，
       * 于是走 ready 这条路拿到的永远是陈旧快照：
       * 刚保存的预设 find() 不到，刚删除的还能 find() 到。
       *
       * （旧版设置 App 自己直接读 apiPresetsCache，所以这个坑一直没暴露；
       *   迁移到聊天设置后改用 find()，问题才浮出来。）
       *
       * ensureReady() 仍要等 —— 首次进入时缓存可能还没就绪。
       */
      return ensureApiPresetsReady().then(function () {
        var list = apiPresetsCache || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && String(list[i].name) === nm) return list[i];
        }
        return null;
      });
    }
  };

  /* ── 模型列表缓存 ────────────────────────────────────────────
   *
   * 解决的问题（用户报的）：「怎么每次回去换模型，都要把模型刷出来一遍」。
   *
   * 原先的流程是：点「获取模型」→ fetch /models → 把 ids 填进 <select>。
   * 这份 ids **只活在 DOM 里**：没有持久化、没有缓存，页面一刷新就没了。
   * 下次回来只会把当前选中的那一个填回下拉，想换模型必须再点一次 ⟳。
   *
   * 修法分两层，都不动存储层的数据结构：
   *   1. HTTP 缓存（stale-while-revalidate）—— 给 /models 请求加
   *      cache: 'force-cache'，浏览器自己的 HTTP 缓存会把结果留住。
   *   2. localStorage 兜底 —— HTTP 缓存可能被浏览器清理、或在某些壳浏览器里
   *      不生效。落一份到 localStorage，按 `baseUrl|apiKey尾4位` 分桶。
   *
   * 注意分桶键含 API key 尾部：换密钥时列表会重新拉，
   * 不会把上一个账号的模型列表串到新账号上。
   */

  function normalizeBaseUrl(s) {
    return String(s || '').trim().replace(/\/+$/, '');
  }

  function openAiCompatibleApiRoot(base) {
    var t = normalizeBaseUrl(base);
    if (!t) return '';
    try {
      var u = new URL(t);
      var path = (u.pathname || '/').replace(/\/+$/, '');
      var segs = path.split('/').filter(Boolean);
      if (segs.length && segs[segs.length - 1].toLowerCase() === 'v1') return u.origin + path;
      if (!path || path === '/') return u.origin + '/v1';
      return u.origin + path + '/v1';
    } catch (e) {
      return t.toLowerCase().endsWith('/v1') ? t : t + '/v1';
    }
  }

  function modelCacheBucket(base, key) {
    var tail = String(key || '').trim();
    tail = tail ? tail.slice(-4) : '';
    return openAiCompatibleApiRoot(base) + '|' + tail;
  }

  function readModelCacheAll() {
    try {
      var raw = localStorage.getItem(MODEL_CACHE_KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function readModelCache(base, key) {
    var bucket = modelCacheBucket(base, key);
    var hit = readModelCacheAll()[bucket];
    if (!hit || !Array.isArray(hit.ids) || !hit.ids.length) return null;
    if (hit.at && Date.now() - hit.at > MODEL_CACHE_TTL) return null;
    return hit.ids;
  }

  function writeModelCache(base, key, ids) {
    if (!ids || !ids.length) return;
    try {
      var all = readModelCacheAll();
      all[modelCacheBucket(base, key)] = { ids: ids, at: Date.now() };
      /*
       * 只留最近 8 个桶。这个缓存是「锦上添花」，不该无限膨胀 ——
       * 用户可能试过很多个中转站地址，每个都留着会撑爆 localStorage。
       */
      var keys = Object.keys(all);
      if (keys.length > 8) {
        keys.sort(function (a, b) { return (all[b].at || 0) - (all[a].at || 0); });
        keys.slice(8).forEach(function (k) { delete all[k]; });
      }
      localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(all));
    } catch (e) {
      /* 配额满 / 隐私模式：缓存失败不影响主流程 */
    }
  }

  global.miyaApiModelCache = {
    KEY: MODEL_CACHE_KEY,
    bucket: modelCacheBucket,
    read: readModelCache,
    write: writeModelCache,
    readAll: readModelCacheAll
  };

  /* 供生图 / 语音等模块复用同一条 URL 归一逻辑，避免各写一份 */
  global.miyaNormalizeBaseUrl = normalizeBaseUrl;
  global.miyaOpenAiApiRoot = openAiCompatibleApiRoot;

  /* ── 初始化 ──────────────────────────────────────────────────
   * 与旧文件一样，注册到 KV 层并立即尝试水合，
   * 保证 js1/ 里的调用方拿到的是已经补齐的配置。 */

  loadSystemPrefs();

  if (global.miyaRegisterKvStore) {
    global.miyaRegisterKvStore({ whenReady: hydrateApiConfigFromIdb });
  }
  hydrateApiConfigFromIdb();
  ensureApiPresetsReady();
})(typeof window !== 'undefined' ? window : globalThis);
