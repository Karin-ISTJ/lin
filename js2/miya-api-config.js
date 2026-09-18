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

  function ensureApiPresetsReady() {
    if (apiPresetsReady) return apiPresetsReady;
    apiPresetsReady = loadApiPresetsArr().then(function (list) {
      apiPresetsCache = Array.isArray(list) ? list.slice() : [];
      return apiPresetsCache;
    }).catch(function () {
      apiPresetsCache = [];
      return apiPresetsCache;
    });
    return apiPresetsReady;
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
     */
    upsert: function (name, payload) {
      var nm = String(name || '').trim();
      if (!nm) return Promise.resolve(null);
      return ensureApiPresetsReady().then(function (list) {
        var next = (list || []).slice();
        var hit = -1;
        for (var i = 0; i < next.length; i++) {
          if (next[i] && String(next[i].name) === nm) { hit = i; break; }
        }
        var item = Object.assign({}, payload || {}, { name: nm });
        if (hit >= 0) next[hit] = item; else next.push(item);
        return saveApiPresetsArr(next).then(function () {
          apiPresetsCache = next;
          return next;
        });
      });
    },
    remove: function (name) {
      var nm = String(name || '').trim();
      if (!nm) return Promise.resolve(null);
      return ensureApiPresetsReady().then(function (list) {
        var next = (list || []).filter(function (p) { return !(p && String(p.name) === nm); });
        return saveApiPresetsArr(next).then(function () {
          apiPresetsCache = next;
          return next;
        });
      });
    },
    find: function (name) {
      var nm = String(name || '').trim();
      return ensureApiPresetsReady().then(function (list) {
        for (var i = 0; i < (list || []).length; i++) {
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
