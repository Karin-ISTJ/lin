/**
 * Miya · 记忆表格存储（参考 st-memory-enhancement 的多表结构）
 * 按 chatId 保存多张表；全局设置控制读/写/注入。
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'miya-memory-tables-v1';
  var SETTINGS_KEY = 'miya-memory-table-settings-v1';

  function uid(prefix) {
    return (prefix || 'mt') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function defaultSettings() {
    return {
      enabled: true,
      isAiRead: true,
      isAiWrite: true,
      injectPosition: 'system', // system | before_user
      maxRowsPerTable: 40,
      tokenSoftLimit: 1800
    };
  }

  /** 默认五表，贴近记忆增强常用结构 */
  function defaultTables() {
    return [
      {
        id: 't_time',
        name: '时空',
        note: '记录当前时间、天气、地点与在场人物，保持时空连贯。',
        enabled: true,
        columns: ['月日', '天气气候', '地点', '参与人'],
        rows: []
      },
      {
        id: 't_char',
        name: '角色特征',
        note: '记录角色外貌、性格、职业等稳定信息，禁止捏造未知。',
        enabled: true,
        columns: ['角色', '身体特征', '性格', '职业', '爱好', '住所', '重要信息'],
        rows: []
      },
      {
        id: 't_social',
        name: '社交关系',
        note: '记录角色之间及与用户的关系与态度（勿写用户对角色的态度行）。',
        enabled: true,
        columns: ['角色', '关系', '态度', '好感/亲密度'],
        rows: []
      },
      {
        id: 't_event',
        name: '重要事件',
        note: '只记录对后续剧情有影响的事件。',
        enabled: true,
        columns: ['相关角色', '事件简述', '时间', '地点', '情绪'],
        rows: []
      },
      {
        id: 't_item',
        name: '重要物品',
        note: '记录关键物品归属与意义。',
        enabled: true,
        columns: ['相关角色', '物品', '描述', '重要性'],
        rows: []
      }
    ];
  }

  function loadAll() {
    try {
      var raw =
        typeof global.miyaSyncReadJsonKey === 'function'
          ? global.miyaSyncReadJsonKey(STORE_KEY)
          : JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return { chats: {} };
      if (!raw.chats || typeof raw.chats !== 'object') raw.chats = {};
      return raw;
    } catch (e) {
      return { chats: {} };
    }
  }

  function saveAll(data) {
    var payload = data && typeof data === 'object' ? data : { chats: {} };
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return global.miyaWriteLsJsonKey(STORE_KEY, payload);
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (e) {}
    return Promise.resolve();
  }

  function loadSettings() {
    try {
      var raw =
        typeof global.miyaSyncReadJsonKey === 'function'
          ? global.miyaSyncReadJsonKey(SETTINGS_KEY)
          : JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      return Object.assign(defaultSettings(), raw && typeof raw === 'object' ? raw : {});
    } catch (e) {
      return defaultSettings();
    }
  }

  function saveSettings(s) {
    var next = Object.assign(defaultSettings(), s || {});
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return global.miyaWriteLsJsonKey(SETTINGS_KEY, next);
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (e) {}
    return Promise.resolve(next);
  }

  function normalizeTable(t, index) {
    t = t || {};
    return {
      id: String(t.id || uid('t')),
      name: String(t.name || '表' + (index + 1)),
      note: String(t.note || ''),
      enabled: t.enabled !== false,
      columns: Array.isArray(t.columns)
        ? t.columns.map(function (c) {
            return String(c || '').trim() || '列';
          })
        : ['列1'],
      rows: Array.isArray(t.rows)
        ? t.rows.map(function (r) {
            if (Array.isArray(r)) return r.map(function (c) { return String(c == null ? '' : c); });
            if (r && typeof r === 'object') {
              return (t.columns || []).map(function (_, i) {
                return String(r[i] != null ? r[i] : r[String(i)] != null ? r[String(i)] : '');
              });
            }
            return [];
          })
        : []
    };
  }

  function getChatTables(chatId) {
    var id = String(chatId || '');
    if (!id) return defaultTables().map(normalizeTable);
    var all = loadAll();
    var pack = all.chats[id];
    if (!pack || !Array.isArray(pack.tables) || !pack.tables.length) {
      return defaultTables().map(normalizeTable);
    }
    return pack.tables.map(normalizeTable);
  }

  function setChatTables(chatId, tables) {
    var id = String(chatId || '');
    if (!id) return Promise.reject(new Error('no chatId'));
    var all = loadAll();
    all.chats[id] = {
      tables: (tables || []).map(normalizeTable),
      updatedAt: Date.now()
    };
    return saveAll(all);
  }

  function ensureChat(chatId) {
    var tables = getChatTables(chatId);
    return setChatTables(chatId, tables).then(function () {
      return tables;
    });
  }

  function resetChat(chatId) {
    return setChatTables(chatId, defaultTables());
  }

  function exportChat(chatId) {
    return {
      version: 1,
      chatId: String(chatId || ''),
      tables: getChatTables(chatId),
      settings: loadSettings()
    };
  }

  function importChat(chatId, data) {
    var tables = data && Array.isArray(data.tables) ? data.tables : data;
    if (!Array.isArray(tables)) return Promise.reject(new Error('invalid tables'));
    return setChatTables(chatId, tables);
  }

  global.MiyaMemoryTableStore = {
    STORE_KEY: STORE_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    defaultSettings: defaultSettings,
    defaultTables: defaultTables,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    getChatTables: getChatTables,
    setChatTables: setChatTables,
    ensureChat: ensureChat,
    resetChat: resetChat,
    exportChat: exportChat,
    importChat: importChat,
    normalizeTable: normalizeTable
  };
})(typeof window !== 'undefined' ? window : this);
