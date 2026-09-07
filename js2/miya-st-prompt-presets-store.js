/**
 * ST-style prompt preset entries store (independent from built-in API presets).
 * Does NOT inject into chat requests yet — management only; reserved API for later.
 */
(function (global) {
  'use strict';

  var KEY = 'miya-st-prompt-presets-v1';

  function uid() {
    return 'stp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function emptyState() {
    return {
      version: 1,
      meta: {},
      entries: []
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return emptyState();
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return emptyState();
      if (!Array.isArray(data.entries)) data.entries = [];
      if (!data.meta || typeof data.meta !== 'object') data.meta = {};
      data.version = 1;
      return data;
    } catch (e) {
      return emptyState();
    }
  }

  function save(state) {
    var data = state && typeof state === 'object' ? state : emptyState();
    if (!Array.isArray(data.entries)) data.entries = [];
    data.version = 1;
    localStorage.setItem(KEY, JSON.stringify(data));
    return data;
  }

  function normalizeEntry(raw, order) {
    var e = raw && typeof raw === 'object' ? raw : {};
    var name = String(e.name || e.identifier || '未命名条目').trim() || '未命名条目';
    var content = e.content != null ? String(e.content) : '';
    var role = e.role ? String(e.role) : (e.system_prompt ? 'system' : 'system');
    if (role !== 'system' && role !== 'user' && role !== 'assistant') role = 'system';
    var enabled = e.enabled === undefined ? true : !!e.enabled;
    // marker-only ST slots have no content — still importable, default off if empty marker
    if (e.marker && !content) enabled = e.enabled === true;
    return {
      id: e.id ? String(e.id) : uid(),
      name: name,
      content: content,
      role: role,
      enabled: enabled,
      identifier: e.identifier != null ? String(e.identifier) : '',
      system_prompt: e.system_prompt !== false,
      marker: !!e.marker,
      order: typeof order === 'number' ? order : (typeof e.order === 'number' ? e.order : 0)
    };
  }

  function listEntries() {
    return load().entries.slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });
  }

  function getEntry(id) {
    var entries = load().entries;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) return entries[i];
    }
    return null;
  }

  function upsertEntry(partial) {
    var state = load();
    var found = -1;
    if (partial && partial.id) {
      for (var i = 0; i < state.entries.length; i++) {
        if (state.entries[i].id === partial.id) {
          found = i;
          break;
        }
      }
    }
    if (found >= 0) {
      var merged = Object.assign({}, state.entries[found], partial);
      state.entries[found] = normalizeEntry(merged, state.entries[found].order);
    } else {
      var order = state.entries.length;
      state.entries.push(normalizeEntry(partial || {}, order));
    }
    save(state);
    return state.entries;
  }

  function removeEntry(id) {
    var state = load();
    state.entries = state.entries.filter(function (e) {
      return e.id !== id;
    });
    state.entries.forEach(function (e, i) {
      e.order = i;
    });
    save(state);
    return state.entries;
  }

  function setEnabled(id, enabled) {
    var state = load();
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) {
        state.entries[i].enabled = !!enabled;
        break;
      }
    }
    save(state);
    return state.entries;
  }

  function clearAll() {
    save(emptyState());
  }

  /**
   * Import SillyTavern / OpenAI-completion style Default.json
   * extracts prompts[] as entries; stores light meta for later.
   */
  function importFromStJson(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('无效 JSON');
    var prompts = Array.isArray(obj.prompts) ? obj.prompts : null;
    if (!prompts) throw new Error('未找到 prompts 数组（请导入含 prompts 的预设 JSON）');

    var state = load();
    var baseOrder = state.entries.length;
    var added = 0;

    prompts.forEach(function (p, idx) {
      if (!p || typeof p !== 'object') return;
      var entry = normalizeEntry(
        {
          name: p.name || p.identifier || '条目' + (idx + 1),
          content: p.content || '',
          role: p.role || 'system',
          identifier: p.identifier || '',
          system_prompt: p.system_prompt !== false,
          marker: !!p.marker,
          enabled: p.marker && !(p.content && String(p.content).trim()) ? false : true
        },
        baseOrder + added
      );
      // skip pure empty markers by default still keep them disabled for order reference
      state.entries.push(entry);
      added++;
    });

    state.meta = Object.assign({}, state.meta, {
      lastImportAt: Date.now(),
      openai_model: obj.openai_model || state.meta.openai_model,
      temperature: obj.temperature,
      openai_max_tokens: obj.openai_max_tokens,
      prompt_order: obj.prompt_order || state.meta.prompt_order
    });

    save(state);
    return { added: added, total: state.entries.length };
  }

  /** Entries that would go into the request later (enabled + has content or non-marker) */
  function getEnabledForRequest() {
    return listEntries().filter(function (e) {
      return e.enabled && !e.marker && String(e.content || '').trim();
    });
  }

  global.miyaStPromptPresetsStore = {
    KEY: KEY,
    load: load,
    save: save,
    listEntries: listEntries,
    getEntry: getEntry,
    upsertEntry: upsertEntry,
    removeEntry: removeEntry,
    setEnabled: setEnabled,
    clearAll: clearAll,
    importFromStJson: importFromStJson,
    getEnabledForRequest: getEnabledForRequest,
    normalizeEntry: normalizeEntry
  };
})(typeof window !== 'undefined' ? window : this);
