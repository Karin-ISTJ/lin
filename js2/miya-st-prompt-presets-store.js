/**
 * ST prompt preset packs (multi-preset, independent from built-in API presets).
 * Active pack's enabled entries inject into chat API messages.
 */
(function (global) {
  'use strict';

  var KEY = 'miya-st-prompt-presets-v2';
  var LEGACY_KEY = 'miya-st-prompt-presets-v1';

  function uid(prefix) {
    return (prefix || 'stp') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    return { version: 2, activeId: '', packs: [] };
  }

  function normalizeEntry(raw, order) {
    var e = raw && typeof raw === 'object' ? raw : {};
    var role = e.role ? String(e.role) : 'system';
    if (role !== 'system' && role !== 'user' && role !== 'assistant') role = 'system';
    return {
      id: e.id ? String(e.id) : uid('ent'),
      name: String(e.name || e.identifier || '未命名').trim() || '未命名',
      content: e.content != null ? String(e.content) : '',
      role: role,
      enabled: e.enabled === undefined ? true : !!e.enabled,
      identifier: e.identifier != null ? String(e.identifier) : '',
      system_prompt: e.system_prompt !== false,
      marker: !!e.marker,
      order: typeof order === 'number' ? order : (typeof e.order === 'number' ? e.order : 0)
    };
  }

  function migrateLegacy() {
    try {
      var raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      var old = JSON.parse(raw);
      if (!old || !Array.isArray(old.entries) || !old.entries.length) return null;
      var pack = {
        id: uid('pack'),
        name: '已导入（旧数据）',
        createdAt: Date.now(),
        entries: old.entries.map(function (e, i) { return normalizeEntry(e, i); })
      };
      return { version: 2, activeId: pack.id, packs: [pack] };
    } catch (err) {
      return null;
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.packs)) {
          data.version = 2;
          if (!data.activeId) data.activeId = data.packs[0] ? data.packs[0].id : '';
          return data;
        }
      }
    } catch (e) { /* fallthrough */ }
    var migrated = migrateLegacy();
    if (migrated) {
      save(migrated);
      try { localStorage.removeItem(LEGACY_KEY); } catch (e2) {}
      return migrated;
    }
    return emptyState();
  }

  function save(state) {
    var data = state && typeof state === 'object' ? state : emptyState();
    if (!Array.isArray(data.packs)) data.packs = [];
    data.version = 2;
    localStorage.setItem(KEY, JSON.stringify(data));
    return data;
  }

  function listPacks() {
    return load().packs.slice();
  }

  function getActivePack() {
    var state = load();
    if (!state.packs.length) return null;
    for (var i = 0; i < state.packs.length; i++) {
      if (state.packs[i].id === state.activeId) return state.packs[i];
    }
    return state.packs[0];
  }

  function setActivePack(id) {
    var state = load();
    for (var i = 0; i < state.packs.length; i++) {
      if (state.packs[i].id === id) {
        state.activeId = id;
        save(state);
        return state.packs[i];
      }
    }
    return null;
  }

  function renamePack(id, name) {
    var state = load();
    name = String(name || '').trim() || '未命名预设';
    for (var i = 0; i < state.packs.length; i++) {
      if (state.packs[i].id === id) {
        state.packs[i].name = name;
        save(state);
        return state.packs[i];
      }
    }
    return null;
  }

  function removePack(id) {
    var state = load();
    state.packs = state.packs.filter(function (p) { return p.id !== id; });
    if (state.activeId === id) {
      state.activeId = state.packs[0] ? state.packs[0].id : '';
    }
    save(state);
    return state;
  }

  function listEntries() {
    var pack = getActivePack();
    if (!pack) return [];
    return (pack.entries || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });
  }

  function getEntry(id) {
    var entries = listEntries();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) return entries[i];
    }
    return null;
  }

  function updateActiveEntries(mutator) {
    var state = load();
    var pack = null;
    for (var i = 0; i < state.packs.length; i++) {
      if (state.packs[i].id === state.activeId) {
        pack = state.packs[i];
        break;
      }
    }
    if (!pack && state.packs.length) {
      pack = state.packs[0];
      state.activeId = pack.id;
    }
    if (!pack) return [];
    mutator(pack);
    save(state);
    return (pack.entries || []).slice();
  }

  function upsertEntry(partial) {
    return updateActiveEntries(function (pack) {
      var found = -1;
      if (partial && partial.id) {
        for (var i = 0; i < pack.entries.length; i++) {
          if (pack.entries[i].id === partial.id) {
            found = i;
            break;
          }
        }
      }
      if (found >= 0) {
        pack.entries[found] = normalizeEntry(
          Object.assign({}, pack.entries[found], partial),
          pack.entries[found].order
        );
      } else {
        pack.entries.push(normalizeEntry(partial || {}, pack.entries.length));
      }
    });
  }

  function removeEntry(id) {
    return updateActiveEntries(function (pack) {
      pack.entries = pack.entries.filter(function (e) { return e.id !== id; });
      pack.entries.forEach(function (e, i) { e.order = i; });
    });
  }

  function setEnabled(id, enabled) {
    return updateActiveEntries(function (pack) {
      for (var i = 0; i < pack.entries.length; i++) {
        if (pack.entries[i].id === id) {
          pack.entries[i].enabled = !!enabled;
          break;
        }
      }
    });
  }

  function clearActiveEntries() {
    return updateActiveEntries(function (pack) {
      pack.entries = [];
    });
  }

  /**
   * Build ordered entries from ST Default.json using prompts + prompt_order.
   */
  function entriesFromStJson(obj) {
    var prompts = Array.isArray(obj.prompts) ? obj.prompts : [];
    var byId = Object.create(null);
    prompts.forEach(function (p, idx) {
      if (!p || typeof p !== 'object') return;
      var ident = p.identifier != null ? String(p.identifier) : ('__idx_' + idx);
      byId[ident] = p;
      if (p.name) byId['name:' + String(p.name)] = p;
    });

    var orderList = null;
    if (Array.isArray(obj.prompt_order) && obj.prompt_order.length) {
      // prefer first order block (ST default character)
      var block = obj.prompt_order[0];
      if (block && Array.isArray(block.order)) orderList = block.order;
    }

    var entries = [];
    var used = Object.create(null);

    function pushFromPrompt(p, enabled, order) {
      if (!p) return;
      var ident = p.identifier != null ? String(p.identifier) : '';
      var key = ident || ('n:' + (p.name || '') + ':' + order);
      if (used[key]) return;
      used[key] = true;
      var hasContent = String(p.content || '').trim().length > 0;
      var en = enabled;
      if (en === undefined) {
        // marker-only empty slots default off; content slots default on
        en = p.marker && !hasContent ? false : true;
      }
      entries.push(
        normalizeEntry(
          {
            name: p.name || ident || '条目',
            content: p.content || '',
            role: p.role || 'system',
            identifier: ident,
            system_prompt: p.system_prompt !== false,
            marker: !!p.marker,
            enabled: !!en
          },
          order
        )
      );
    }

    if (orderList && orderList.length) {
      orderList.forEach(function (row, idx) {
        if (!row) return;
        var ident = row.identifier != null ? String(row.identifier) : '';
        var p = ident ? byId[ident] : null;
        if (!p) {
          // order references missing prompt — skip
          return;
        }
        var enabled = row.enabled === undefined ? true : !!row.enabled;
        pushFromPrompt(p, enabled, idx);
      });
      // append prompts not listed in order (keep at end, default off if marker)
      prompts.forEach(function (p) {
        if (!p) return;
        var ident = p.identifier != null ? String(p.identifier) : '';
        if (ident && used[ident]) return;
        if (!ident) {
          // 无 identifier：用 name 粗去重
          var nkey = 'name:' + String(p.name || '');
          if (p.name && used[nkey]) return;
          if (p.name) used[nkey] = true;
        }
        pushFromPrompt(p, p.marker ? false : true, entries.length);
      });
    } else {
      prompts.forEach(function (p, idx) {
        pushFromPrompt(p, undefined, idx);
      });
    }

    return entries;
  }

  function importFromStJson(obj, packName) {
    if (!obj || typeof obj !== 'object') throw new Error('无效 JSON');
    if (!Array.isArray(obj.prompts)) throw new Error('未找到 prompts 数组');

    var entries = entriesFromStJson(obj);
    var state = load();
    var pack = {
      id: uid('pack'),
      name: String(packName || obj.name || '预设 ' + (state.packs.length + 1)).trim() || '未命名预设',
      createdAt: Date.now(),
      entries: entries
    };
    state.packs.push(pack);
    state.activeId = pack.id;
    save(state);
    return { pack: pack, added: entries.length, total: entries.length };
  }

  /** 按 id 数组重排当前预设包条目，并重写 order */
  function reorderEntries(orderedIds) {
    return updateActiveEntries(function (pack) {
      var map = Object.create(null);
      (pack.entries || []).forEach(function (e) {
        if (e && e.id) map[e.id] = e;
      });
      var next = [];
      (orderedIds || []).forEach(function (id) {
        if (map[id]) {
          next.push(map[id]);
          delete map[id];
        }
      });
      Object.keys(map).forEach(function (id) {
        next.push(map[id]);
      });
      next.forEach(function (e, i) {
        e.order = i;
      });
      pack.entries = next;
    });
  }

  function getEnabledForRequest() {
    return listEntries().filter(function (e) {
      return e.enabled && !e.marker && String(e.content || '').trim();
    });
  }

  global.miyaStPromptPresetsStore = {
    KEY: KEY,
    load: load,
    save: save,
    listPacks: listPacks,
    getActivePack: getActivePack,
    setActivePack: setActivePack,
    renamePack: renamePack,
    removePack: removePack,
    listEntries: listEntries,
    getEntry: getEntry,
    upsertEntry: upsertEntry,
    removeEntry: removeEntry,
    setEnabled: setEnabled,
    clearActiveEntries: clearActiveEntries,
    reorderEntries: reorderEntries,
    importFromStJson: importFromStJson,
    getEnabledForRequest: getEnabledForRequest
  };
})(typeof window !== 'undefined' ? window : this);
