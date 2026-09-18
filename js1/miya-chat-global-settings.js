/**
 * 联系人聊天全局设置：感知 / 记忆 / 后台
 * 默认全员生效；perContact[contactId].useGlobal === false 时使用单独配置
 */
(function (global) {
  'use strict';

  var KEY = 'miya-chat-global-settings-v1';

  /** 由全局模块管理的字段（weatherAwareness 仅 per-contact 聊天设置里配置，不在此列） */
  var MANAGED_KEYS = [
    'memoryCount',
    'summaryTrigger',
    'summaryLength',
    'backgroundMessage'
  ];

  var cache = null;
  var ready = null;

  function defaultGlobalSlice() {
    var d = global.miyaChatStore && global.miyaChatStore.defaultChatSettings
      ? global.miyaChatStore.defaultChatSettings()
      : {};
    var out = {};
    MANAGED_KEYS.forEach(function (k) {
      if (d[k] != null) {
        out[k] = typeof d[k] === 'object' && !Array.isArray(d[k])
          ? JSON.parse(JSON.stringify(d[k]))
          : d[k];
      }
    });
    return out;
  }

  function defaultState() {
    return {
      version: 1,
      useGlobal: true,
      global: defaultGlobalSlice(),
      perContact: {}
    };
  }

  function normalizePerContact(raw) {
    if (!raw || typeof raw !== 'object') return {};
    var out = {};
    Object.keys(raw).forEach(function (cid) {
      var row = raw[cid];
      if (!row || typeof row !== 'object') return;
      var settings = {};
      MANAGED_KEYS.forEach(function (k) {
        if (row.settings && row.settings[k] != null) settings[k] = row.settings[k];
      });
      out[cid] = {
        useGlobal: row.useGlobal !== false ? !!row.useGlobal : false,
        settings: settings
      };
    });
    return out;
  }

  function normalizeState(raw) {
    var d = defaultState();
    if (!raw || typeof raw !== 'object') return d;
    var g = Object.assign({}, d.global, raw.global || {});
    MANAGED_KEYS.forEach(function (k) {
      if (g[k] == null && d.global[k] != null) g[k] = d.global[k];
    });
    return {
      version: 1,
      useGlobal: raw.useGlobal !== false,
      global: g,
      perContact: normalizePerContact(raw.perContact)
    };
  }

  function readState() {
    if (cache) return normalizeState(cache);
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var raw = global.miyaSyncReadJsonKey(KEY);
      if (raw != null) {
        cache = normalizeState(raw);
        return cache;
      }
    }
    return normalizeState(null);
  }

  function persist(state) {
    cache = normalizeState(state);
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return global.miyaWriteLsJsonKey(KEY, cache).then(function () { return cache; });
    }
    var gsStr = '';
    try { gsStr = JSON.stringify(cache); } catch (eStr) { return Promise.resolve(cache); }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(KEY, gsStr);
    } else {
      try { localStorage.setItem(KEY, gsStr); } catch (e) {}
    }
    return Promise.resolve(cache);
  }

  function whenReady() {
    if (ready) return ready;
    ready = (typeof global.miyaReadLsJsonKey === 'function'
      ? global.miyaReadLsJsonKey(KEY, null)
      : Promise.resolve(null)
    ).then(function (v) {
      cache = normalizeState(v);
      return cache;
    }).catch(function () {
      cache = defaultState();
      return cache;
    });
    return ready;
  }

  function getState() { return readState(); }

  function saveGlobal(patch) {
    var st = readState();
    var next = Object.assign({}, st.global, patch || {});
    return persist({ useGlobal: st.useGlobal, global: next, perContact: st.perContact });
  }

  function savePerContact(contactId, patch) {
    var cid = String(contactId || '').trim();
    if (!cid) return Promise.resolve(false);
    var st = readState();
    var prev = st.perContact[cid] || { useGlobal: false, settings: {} };
    var row = {
      useGlobal: patch && patch.useGlobal != null ? !!patch.useGlobal : prev.useGlobal,
      settings: Object.assign({}, prev.settings, (patch && patch.settings) || {})
    };
    if (patch && patch.settings) {
      Object.keys(patch.settings).forEach(function (k) {
        if (MANAGED_KEYS.indexOf(k) >= 0) row.settings[k] = patch.settings[k];
      });
    }
    var perContact = Object.assign({}, st.perContact);
    perContact[cid] = row;
    return persist({ useGlobal: st.useGlobal, global: st.global, perContact: perContact });
  }

  function removePerContact(contactId) {
    var cid = String(contactId || '').trim();
    if (!cid) return Promise.resolve();
    var st = readState();
    if (!st.perContact[cid]) return Promise.resolve();
    var perContact = Object.assign({}, st.perContact);
    delete perContact[cid];
    return persist({ useGlobal: st.useGlobal, global: st.global, perContact: perContact });
  }

  /** 是否对该联系人使用全局配置 */
  function contactUsesGlobal(contactId) {
    var st = readState();
    if (!st.useGlobal) return false;
    var cid = String(contactId || '').trim();
    if (!cid) return st.useGlobal;
    var row = st.perContact[cid];
    if (row && row.useGlobal === false) return false;
    return true;
  }

  /**
   * 在聊天设置里改「记忆 / 后台」时的统一落库入口。
   *
   * 为什么不能直接 store.saveChatSettings：
   * getChatSettings() 的顺序是「联系人级 ⊕ 会话级」→ normalize → applyToChatSettings。
   * 最后一步会用全局配置里的 memoryCount / summaryTrigger / summaryLength /
   * backgroundMessage 把前面算出来的值**整个盖掉**（实测确认），
   * 所以只写 contact.chatSettings 是「存得进去、读不出来」。
   *
   * 这里的做法：把用户的改动登记为该联系人的 perContact 覆盖，
   * 该联系人随即脱离全局默认。这样既尊重「全局默认」这一概念，
   * 又让用户在聊天页改完立刻生效，不必再理解「全局 / 单独」的切换。
   */
  function applyContactOverride(contactId, settings) {
    var cid = String(contactId || '').trim();
    if (!cid) return Promise.resolve(false);
    var slice = {};
    MANAGED_KEYS.forEach(function (k) {
      if (!settings || settings[k] == null) return;
      if (k === 'backgroundMessage') {
        /* backgroundMessage 里混着会话级运行时字段（下次推送时间、基线时间戳等）。
           它们由每个会话自己维护，不属于「这个联系人的配置」，
           存进全局配置只会变成脏数据，这里先剔干净。 */
        var clean = Object.assign({}, settings[k]);
        CHAT_LEVEL_BM_KEYS.forEach(function (bk) { delete clean[bk]; });
        slice[k] = clean;
        return;
      }
      slice[k] = settings[k];
    });
    if (!Object.keys(slice).length) return Promise.resolve(false);
    return savePerContact(cid, { useGlobal: false, settings: slice });
  }

  /** 取消该联系人的单独配置，回到全局默认 */
  function resetContactOverride(contactId) {
    return removePerContact(contactId);
  }

  /** 合并全局/单独配置到 chat settings 对象（浅拷贝后 patch） */
  /**
   * backgroundMessage 里「按会话独立」的字段。
   *
   * 这些字段不属于全局配置的管理范围，但 defaultChatSettings() 会给它们
   * 填一份空模板（playerPlots: [] / timeEvents: [] 等），
   * defaultGlobalSlice() 又会把整份模板拷进全局配置。
   * 于是 applyToChatSettings 做浅合并时，这份空模板会盖掉真实数据 ——
   * 表现就是「存进去就没了」。
   *
   * 每加一个会话级的 backgroundMessage 字段，都要登记到这里，
   * 否则就会踩同一个坑（farm 和 timeEvents 已经各踩过一次）。
   */
  var SESSION_SCOPED_BM_KEYS = [
    'farm',
    'timeEvents'
  ];

  /**
   * backgroundMessage 里由「会话」自己维护的运行时字段。
   *
   * 与 miya-chat-store.js 的 getChatSettings() 里 chatLevelBgKeys 是同一份清单：
   * 那些字段永远是「会话级 ⊕ 全局配置」里的会话级优先，
   * 所以它们混进全局配置既无意义、又会造成难以排查的脏数据。
   * 两处若增删字段，需要同步。
   */
  var CHAT_LEVEL_BM_KEYS = [
    'lifeLikeEnabled',
    'lifeLikeNextPushAt',
    'lifeLikeNextPushAnchorTs',
    'lifeLikeEnabledAt',
    'lastAutoPushAt',
    'lastProactiveAttemptAt',
    'lastPushFailAt',
    'proactiveBaselineAt',
    'lastOfflineAt',
    'offlineRollAnchor',
    'offlineRollGapMs'
  ];

  function applyToChatSettings(base, contactId) {
    var out = Object.assign({}, base || {});
    var st = readState();
    var cid = String(contactId || '').trim();
    var useGlobal = contactUsesGlobal(cid);
    var slice = useGlobal ? st.global : (st.perContact[cid] && st.perContact[cid].settings) || {};
    MANAGED_KEYS.forEach(function (k) {
      if (slice[k] == null) return;
      if (k === 'backgroundMessage') {
        /*
         * farm 是会话级（每个聊天独立的）数据，不属于全局配置的管理范围。
         * defaultChatSettings() 里带了一个 farm 空模板（playerPlots: [] 等），
         * 它会被 defaultGlobalSlice() 拷进全局配置；若无条件浅合并，这个空模板
         * 就会盖掉真实农场 —— 表现为「作物种下去就消失」。
         *
         * timeEvents（现实时钟事件账本）同理：它是每个聊天各自的时间线，
         * 被空数组盖掉后表现为「利息写进去了，一读就没了」。
         *
         * 这里剔除全局 slice 里的这些会话级字段，只让 backgroundMessage
         * 的其它字段生效。
         */
        var clean = Object.assign({}, slice[k]);
        SESSION_SCOPED_BM_KEYS.forEach(function (bk) {
          delete clean[bk];
        });
        out[k] = Object.assign({}, out[k] || {}, clean);
        return;
      }
      out[k] = typeof slice[k] === 'object' && !Array.isArray(slice[k])
        ? Object.assign({}, out[k] || {}, slice[k])
        : slice[k];
    });
    return out;
  }

  function saveState(patch) {
    var st = readState();
    if (patch && patch.useGlobal != null) st.useGlobal = !!patch.useGlobal;
    if (patch && patch.global) {
      st.global = Object.assign({}, st.global, patch.global);
      if (patch.global.backgroundMessage) {
        st.global.backgroundMessage = Object.assign(
          {},
          st.global.backgroundMessage || {},
          patch.global.backgroundMessage
        );
      }
    }
    if (patch && patch.perContact) st.perContact = patch.perContact;
    return persist(st);
  }

  global.miyaChatGlobalSettings = {
    KEY: KEY,
    MANAGED_KEYS: MANAGED_KEYS,
    whenReady: whenReady,
    getState: getState,
    saveGlobal: saveGlobal,
    saveState: saveState,
    savePerContact: savePerContact,
    removePerContact: removePerContact,
    contactUsesGlobal: contactUsesGlobal,
    applyContactOverride: applyContactOverride,
    resetContactOverride: resetContactOverride,
    applyToChatSettings: applyToChatSettings,
    defaultGlobalSlice: defaultGlobalSlice,
    invalidateCache: function () { cache = null; ready = null; }
  };

  if (global.miyaRegisterKvStore) global.miyaRegisterKvStore(global.miyaChatGlobalSettings);
  whenReady();
})(window);
