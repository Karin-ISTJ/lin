/**
 * Miya · 扩展宿主（Plugin Host）
 * 目标：提供接近 ST 扩展的注册 / 钩子 / 设置能力，供 GitHub 插件与本地脚本使用。
 *
 * 插件脚本约定：
 *   MiyaPlugins.register({
 *     id: 'demo',
 *     name: '示例',
 *     version: '1.0.0',
 *     onLoad: function (api) {},
 *     onUnload: function () {},
 *     hooks: {
 *       beforeGenerate: function (ctx) { return ctx; },
 *       afterGenerate: function (ctx) {},
 *       onGenerateError: function (ctx) {},
 *       onRoomOpen: function (ctx) {},
 *       onMessageRender: function (ctx) {}
 *     }
 *   });
 *
 * beforeGenerate ctx:
 *   { scope: 'chat'|'offline', chatId, sessionId?, messages, userText, options, signal }
 *   可返回修改后的 ctx（或 Promise），可改 messages。
 */
(function (global) {
  'use strict';

  var SETTINGS_KEY = 'miya-plugin-settings-v1';
  var registry = Object.create(null);
  var hookLists = Object.create(null);
  var listeners = Object.create(null);

  var HOOK_NAMES = [
    'beforeGenerate',
    'afterGenerate',
    'onGenerateError',
    'onRoomOpen',
    'onRoomClose',
    'onMessageRender',
    'onSettingsOpen'
  ];

  function loadAllSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveAllSettings(all) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(all || {}));
    } catch (e) {}
  }

  function ensureHook(name) {
    if (!hookLists[name]) hookLists[name] = [];
    return hookLists[name];
  }

  function emit(eventName, payload) {
    var list = listeners[eventName] || [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (e) {
        console.warn('[MiyaPlugins] listener error', eventName, e);
      }
    }
    try {
      document.dispatchEvent(
        new CustomEvent('miya-plugin:' + eventName, { detail: payload })
      );
    } catch (e2) {}
  }

  function on(eventName, fn) {
    if (typeof fn !== 'function') return function () {};
    if (!listeners[eventName]) listeners[eventName] = [];
    listeners[eventName].push(fn);
    return function () {
      var arr = listeners[eventName] || [];
      var i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  function createPluginApi(pluginId) {
    return {
      id: pluginId,
      getSettings: function () {
        var all = loadAllSettings();
        return all[pluginId] && typeof all[pluginId] === 'object' ? all[pluginId] : {};
      },
      setSettings: function (patch) {
        var all = loadAllSettings();
        var cur = all[pluginId] && typeof all[pluginId] === 'object' ? all[pluginId] : {};
        var next = Object.assign({}, cur, patch && typeof patch === 'object' ? patch : {});
        all[pluginId] = next;
        saveAllSettings(all);
        emit('settingsChanged', { pluginId: pluginId, settings: next });
        return next;
      },
      toast: function (msg) {
        if (global.miyaChatRoom && typeof global.miyaChatRoom.toast === 'function') {
          global.miyaChatRoom.toast(String(msg || ''));
          return;
        }
        try {
          console.log('[MiyaPlugin]', pluginId, msg);
        } catch (e) {}
      },
      on: on,
      emit: emit,
      getChatStore: function () {
        return global.miyaChatStore || null;
      },
      getChatEngine: function () {
        return global.miyaChatEngine || null;
      },
      getGenerationLifecycle: function () {
        return global.MiyaGenerationLifecycle || null;
      },
      /** 在设置 → 插件面板追加说明文字（轻量 UI 扩展） */
      registerHelpHtml: function (html) {
        var box = document.getElementById('miya-st-plugin-ext-help');
        if (!box) return;
        var div = document.createElement('div');
        div.className = 'st-form-hint';
        div.setAttribute('data-miya-plugin-help', pluginId);
        div.innerHTML = String(html || '');
        box.appendChild(div);
      }
    };
  }

  function register(def) {
    if (!def || typeof def !== 'object') {
      console.warn('[MiyaPlugins] register: invalid definition');
      return null;
    }
    var id = String(def.id || def.name || '').trim();
    if (!id) {
      console.warn('[MiyaPlugins] register: id required');
      return null;
    }
    if (registry[id]) {
      try {
        unregister(id);
      } catch (e) {}
    }

    var entry = {
      id: id,
      name: String(def.name || id),
      version: String(def.version || ''),
      description: String(def.description || ''),
      def: def,
      api: createPluginApi(id),
      enabled: true,
      loadedAt: Date.now()
    };

    registry[id] = entry;

    HOOK_NAMES.forEach(function (h) {
      var fn = def.hooks && typeof def.hooks[h] === 'function' ? def.hooks[h] : null;
      if (!fn && typeof def[h] === 'function') fn = def[h];
      if (fn) {
        ensureHook(h).push({ pluginId: id, fn: fn });
      }
    });

    try {
      if (typeof def.onLoad === 'function') def.onLoad(entry.api);
    } catch (e) {
      console.warn('[MiyaPlugins] onLoad error', id, e);
    }

    emit('pluginRegistered', { id: id, name: entry.name });
    console.log('[MiyaPlugins] registered:', id, entry.version || '');
    return entry;
  }

  function unregister(id) {
    id = String(id || '');
    var entry = registry[id];
    if (!entry) return false;
    try {
      if (entry.def && typeof entry.def.onUnload === 'function') entry.def.onUnload();
    } catch (e) {}
    HOOK_NAMES.forEach(function (h) {
      hookLists[h] = (hookLists[h] || []).filter(function (x) {
        return x.pluginId !== id;
      });
    });
    delete registry[id];
    emit('pluginUnregistered', { id: id });
    return true;
  }

  function list() {
    return Object.keys(registry).map(function (k) {
      var e = registry[k];
      return {
        id: e.id,
        name: e.name,
        version: e.version,
        description: e.description,
        enabled: e.enabled,
        loadedAt: e.loadedAt
      };
    });
  }

  function get(id) {
    return registry[String(id || '')] || null;
  }

  function runHookSync(name, ctx) {
    var list = hookLists[name] || [];
    var cur = ctx;
    for (var i = 0; i < list.length; i++) {
      try {
        var ret = list[i].fn(cur);
        if (ret && typeof ret === 'object' && typeof ret.then !== 'function') cur = ret;
      } catch (e) {
        console.warn('[MiyaPlugins] hook error', name, list[i].pluginId, e);
      }
    }
    return cur;
  }

  function runHook(name, ctx) {
    var list = hookLists[name] || [];
    var chain = Promise.resolve(ctx);
    list.forEach(function (item) {
      chain = chain.then(function (cur) {
        try {
          var ret = item.fn(cur);
          return Promise.resolve(ret).then(function (next) {
            if (next && typeof next === 'object') return next;
            return cur;
          });
        } catch (e) {
          console.warn('[MiyaPlugins] hook error', name, item.pluginId, e);
          return cur;
        }
      });
    });
    return chain;
  }

  /** 生成前：允许插件改 messages */
  function beforeGenerate(ctx) {
    emit('beforeGenerate', ctx);
    return runHook('beforeGenerate', ctx || {});
  }

  function afterGenerate(ctx) {
    emit('afterGenerate', ctx);
    return runHook('afterGenerate', ctx || {});
  }

  function onGenerateError(ctx) {
    emit('onGenerateError', ctx);
    return runHook('onGenerateError', ctx || {});
  }

  function notifyRoomOpen(chatId) {
    var ctx = { chatId: chatId };
    emit('roomOpen', ctx);
    return runHook('onRoomOpen', ctx);
  }

  function notifyRoomClose(chatId) {
    var ctx = { chatId: chatId };
    emit('roomClose', ctx);
    return runHook('onRoomClose', ctx);
  }

  global.MiyaPlugins = {
    register: register,
    unregister: unregister,
    list: list,
    get: get,
    on: on,
    emit: emit,
    runHook: runHook,
    runHookSync: runHookSync,
    beforeGenerate: beforeGenerate,
    afterGenerate: afterGenerate,
    onGenerateError: onGenerateError,
    notifyRoomOpen: notifyRoomOpen,
    notifyRoomClose: notifyRoomClose,
    HOOK_NAMES: HOOK_NAMES.slice()
  };

  // 兼容别名
  global.MiyaExtension = global.MiyaPlugins;
})(typeof window !== 'undefined' ? window : this);
