(function (global) {
  'use strict';

  var STORE_KEY = 'miya-worldbook-v1';
  var DEFAULT_GROUP_ID = 'grp_default';
  var SCOPES = ['global', 'local'];
  var DEPTHS = ['front', 'middle', 'back'];
  var DEPTH_LABELS = {
    front: '前',
    middle: '中',
    back: '后'
  };
  var GLOBAL_REACHES = ['all', 'online', 'offline', 'online_offline'];
  var GLOBAL_REACH_LABELS = {
    all: '全软件',
    online: '仅线上',
    offline: '仅线下',
    online_offline: '线上线下'
  };

  var _cache = null;
  var _ready = null;
  /* 【W1 修复】水合竞态标记。
     模块加载时会发起一次异步读盘（whenReady），若在读盘返回之前就发生了写入
     （persist 已把新数据写进 _cache 并落盘），那个迟到的读盘结果就是**过期数据**。
     原先的无条件赋值会把刚写进去的新数据覆盖掉，造成「内存态旧、持久层新」的不一致。
     这里用 _dirtySinceRead 记录「读盘发起后是否被写过」，迟到结果只在未被写过时才采纳。 */
  var _dirtySinceRead = false;

  function nowId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalizeRoleIds(value) {
    if (!Array.isArray(value)) return [];
    var set = new Set();
    value.forEach(function (item) {
      var v = String(item || '').trim();
      if (v) set.add(v);
    });
    return Array.from(set);
  }

  function normalizeScope(raw) {
    var s = String(raw || '').trim();
    return SCOPES.indexOf(s) >= 0 ? s : 'global';
  }

  function normalizeGlobalReach(raw, scope) {
    var v = String(raw || '').trim();
    if (GLOBAL_REACHES.indexOf(v) >= 0) return v;
    // 旧版局部词条无此字段：等同「全软件」以保持原注入行为
    return normalizeScope(scope) === 'local' ? 'all' : 'online_offline';
  }

  function normalizeDepth(raw) {
    var v = String(raw || '').trim().toLowerCase();
    if (DEPTHS.indexOf(v) >= 0) return v;
    if (v === '前' || v === 'before' || v === 'top') return 'front';
    if (v === '后' || v === 'after' || v === 'bottom') return 'back';
    if (v === '中' || v === 'mid' || v === 'default') return 'middle';
    return 'middle';
  }

  function splitKeywords(raw) {
    var matcher = global.miyaWorldbookMatcher;
    if (matcher && typeof matcher.splitKeywordString === 'function') {
      return matcher.splitKeywordString(raw);
    }
    var src = String(raw || '').trim();
    if (!src) return [];
    return src.split(/[,，、;；]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function normalizeGroup(raw, index) {
    var id = String(raw && raw.id ? raw.id : nowId('grp'));
    if (id === DEFAULT_GROUP_ID) {
      return {
        id: DEFAULT_GROUP_ID,
        name: '未分组',
        /* 兜底容器固定排在最末位（普通分组 sort 从 10 递增，这里给一个足够大的值） */
        sort: 999999,
        fixed: true
      };
    }
    return {
      id: id,
      name: String((raw && raw.name) || '').trim() || '未命名分组',
      sort: typeof raw.sort === 'number' ? raw.sort : (index + 1) * 10,
      fixed: false
    };
  }

  function normalizeEntry(raw, groupsById) {
    raw = raw || {};
    var keywords = [];
    if (Array.isArray(raw.keywords)) keywords = raw.keywords;
    else if (Array.isArray(raw.key)) keywords = raw.key;
    else if (Array.isArray(raw.keys)) keywords = raw.keys;
    else if (raw.keywords != null && typeof raw.keywords !== 'object') {
      keywords = splitKeywords(String(raw.keywords));
    }
    var ts = Number(raw.updatedAt) || Date.now();
    /* 归属分组规整（三档）：
       1) 指定了有效分组 → 用它
       2) 未指定 / 分组失效 → 用**第一个真实分组**（默认归属）
       3) 连真实分组都没有 → 才退回未分组（纯兜底）
       这样「没给分组」不会被静默塞进未分组，未分组只承接真正的异常数据。 */
    var groupId = String(raw.groupId || '');
    if (!groupsById[groupId]) {
      var firstReal = null;
      Object.keys(groupsById).some(function (k) {
        if (k !== DEFAULT_GROUP_ID) { firstReal = k; return true; }
        return false;
      });
      groupId = firstReal || DEFAULT_GROUP_ID;
    }
    var scope = normalizeScope(raw.scope);
    var base = {
      id: String(raw.id ? raw.id : nowId('wb')),
      name: String(raw.name || raw.comment || '').trim() || '未命名片段',
      keywords: keywords.map(function (k) { return String(k || '').trim(); }).filter(Boolean),
      content: String(raw.content || ''),
      scope: scope,
      globalReach: normalizeGlobalReach(raw.globalReach, scope),
      depth: normalizeDepth(raw.depth),
      groupId: groupId,
      boundRoleIds: normalizeRoleIds(raw.boundRoleIds || raw.boundRoles),
      enabled: !(raw.enabled === false || raw.disable === true),
      createdAt: Number(raw.createdAt) || ts,
      updatedAt: ts
    };
    /* ST 字段对齐 */
    var stApi = global.miyaWorldbookST;
    if (stApi && typeof stApi.normalizeStFields === 'function') {
      var st = stApi.normalizeStFields(raw, base);
      base.key = st.key;
      base.keysecondary = st.keysecondary;
      base.keywords = st.key.length ? st.key : base.keywords;
      base.constant = st.constant;
      base.selective = st.selective;
      base.selectiveLogic = st.selectiveLogic;
      base.order = st.order;
      base.position = st.position;
      base.injection_depth = st.injection_depth;
      base.scanDepth = st.scanDepth;
      base.probability = st.probability;
      base.useProbability = st.useProbability;
      base.ignoreBudget = st.ignoreBudget;
      base.excludeRecursion = st.excludeRecursion;
      base.preventRecursion = st.preventRecursion;
      base.caseSensitive = st.caseSensitive;
      base.matchWholeWords = st.matchWholeWords;
      base.sticky = st.sticky;
      base.cooldown = st.cooldown;
      base.delay = st.delay;
      base.group = st.group;
      base.groupWeight = st.groupWeight;
      base.groupOverride = st.groupOverride;
      base.useGroupScoring = st.useGroupScoring;
      base.uid = st.uid;
      base.comment = st.comment;
      if (st.depth) base.depth = normalizeDepth(st.depth);
      base.enabled = st.enabled;
      if (st.name) base.name = st.name;
      if (st.content != null) base.content = st.content;
    } else {
      base.key = base.keywords.slice();
      base.keysecondary = [];
      base.constant = !!raw.constant;
      base.selective = !!raw.selective;
      base.selectiveLogic = 0;
      base.order = Number(raw.order) || 100;
      base.position = Number.isFinite(Number(raw.position)) ? Number(raw.position) : 1;
      base.injection_depth = 4;
      base.scanDepth = null;
      base.probability = 100;
      base.useProbability = false;
      base.ignoreBudget = !!raw.ignoreBudget;
      base.excludeRecursion = false;
      base.preventRecursion = false;
      base.caseSensitive = false;
      base.matchWholeWords = false;
      base.sticky = 0;
      base.cooldown = 0;
      base.delay = 0;
      base.uid = raw.uid;
      base.comment = base.name;
    }
    return base;
  }

  function normalizeState(state) {
    var rawGroups = Array.isArray(state && state.groups) ? state.groups : [];
    var groups = rawGroups.map(normalizeGroup).filter(function (g) { return g.id !== DEFAULT_GROUP_ID; });
    /* 未分组是「兜底容器」，不是「第一分组」。
       以前无条件 unshift 到列表首位，导致它看起来像主分组、永远占据视线第一行。
       现在追加到末尾，让它退居幕后；UI 层还会在它为空时直接隐藏。 */
    groups.push(normalizeGroup({ id: DEFAULT_GROUP_ID }));
    groups.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    var groupsById = {};
    groups.forEach(function (g) { groupsById[g.id] = g; });

    var rawEntries = Array.isArray(state && state.entries) ? state.entries : [];
    var entries = rawEntries.map(function (e) { return normalizeEntry(e, groupsById); });
    entries.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return { version: 2, groups: groups, entries: entries };
  }

  function hydrateCacheSync() {
    if (_cache) return _cache;
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var raw = global.miyaSyncReadJsonKey(STORE_KEY);
      if (raw != null) {
        _cache = normalizeState(raw);
        return _cache;
      }
    }
    return null;
  }

  function readState() {
    if (_cache) return normalizeState(_cache);
    var hydrated = hydrateCacheSync();
    if (hydrated) return hydrated;
    return normalizeState({ groups: [], entries: [] });
  }

  function persist(state) {
    var normalized = normalizeState(state);
    _cache = normalized;
    _dirtySinceRead = true; // 【W1】标记：读盘发起后已发生写入，迟到结果不得覆盖
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return global.miyaWriteLsJsonKey(STORE_KEY, normalized).then(function () { return normalized; });
    }
    var str = '';
    try { str = JSON.stringify(normalized); } catch (eStr) { return; }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(STORE_KEY, str);
    } else {
      try { localStorage.setItem(STORE_KEY, str); } catch (e) {}
    }
    return Promise.resolve(normalized);
  }

  function whenReady() {
    if (_ready) return _ready;
    _ready = (typeof global.miyaReadLsJsonKey === 'function'
      ? global.miyaReadLsJsonKey(STORE_KEY, { entries: [] })
      : Promise.resolve({ entries: [] })
    ).then(function (v) {
      /* 【W1】读盘期间若已发生写入，内存里的 _cache 才是最新真相，
         不能被这份迟到的、过期的盘数据覆盖。 */
      if (_cache && _dirtySinceRead) return _cache;
      _cache = normalizeState(v && typeof v === 'object' ? v : { entries: [] });
      return _cache;
    }).catch(function () {
      if (_cache) return _cache; // 【W1】读盘失败时，已有内存态优先，不做清零
      _cache = normalizeState({ entries: [] });
      return _cache;
    });
    return _ready;
  }

  /* ==================================================================
     分组视图接口（B 阶段·真解耦）
     ------------------------------------------------------------------
     「未分组」是 store 内部实现细节，UI 层不应知道它的 id、更不该自己判断
     它该不该显示。以下三个函数是 UI 唯一的入口：

       listRealGroups()   只给真实分组（新建时「第一个真实分组」从这里取）
       listVisibleGroups()给该显示的分组（未分组只在兜底了条目时才出现）
       visibleGroupId(id) 把任意 groupId 规整成「当前该显示的分组 id」

     这样 app.js 里那 10 处 DEFAULT_GROUP_ID 引用可以全部消除。
     ================================================================== */

  /** 只返回真实分组（不含未分组） */
  function listRealGroups() {
    return readState().groups.filter(function (g) { return g.id !== DEFAULT_GROUP_ID; });
  }

  /** 该分组是否应当出现在 UI 里：未分组只在确实兜底了条目时才露面 */
  function isGroupVisible(group) {
    if (!group) return false;
    if (group.id !== DEFAULT_GROUP_ID) return true;
    var state = readState();
    return state.entries.some(function (e) { return e.groupId === DEFAULT_GROUP_ID; });
  }

  /** 返回当前应当显示的分组列表（已做可见性过滤） */
  function listVisibleGroups() {
    return readState().groups.filter(isGroupVisible);
  }

  /** 分组总数（含未分组），仅在需要「全部」语义时使用 */
  function listGroups() {
    return readState().groups.slice();
  }

  /**
   * 把任意 groupId 规整成「当前应当显示的分组 id」。
   * 兜底条目（落在未分组里的）在列表渲染时需要一个真实存在的归属，
   * 这里统一处理，UI 不必自己写 `byGroup[x] ? x : DEFAULT_GROUP_ID`。
   */
  function visibleGroupId(groupId, visibleList) {
    var list = visibleList || listVisibleGroups();
    var id = String(groupId || '');
    var hit = list.filter(function (g) { return g.id === id; })[0];
    if (hit) return hit.id;
    // 归属分组被隐藏（未分组且当前无兜底条目）时，退回最后一个可见分组
    return list.length ? list[list.length - 1].id : DEFAULT_GROUP_ID;
  }

  /**
   * 同步取「默认归属分组」id —— 新建条目、编辑新建时用。
   * 规则：第一个真实分组；没有真实分组则返回 null（由调用方决定是否建组）。
   * **绝不返回未分组**，未分组只负责异常兜底。
   */
  function peekDefaultGroupId() {
    var real = listRealGroups()[0];
    return real ? real.id : null;
  }

  /**
   * 异步取「默认归属分组」id —— 导入等场景用。
   * 没有真实分组时按需新建一个，保证返回值一定是真实分组。
   */
  function resolveDefaultGroupId() {
    var id = peekDefaultGroupId();
    if (id) return Promise.resolve(id);
    return upsertGroup({ name: '我的世界书', sort: Date.now() })
      .then(function (g) { return (g && g.id) ? g.id : null; });
  }

  function listEntries() {
    return readState().entries.slice();
  }

  function getGroup(groupId) {
    var id = String(groupId || '');
    return listGroups().filter(function (g) { return g.id === id; })[0] || null;
  }

  function getEntry(entryId) {
    var id = String(entryId || '');
    return listEntries().filter(function (e) { return e.id === id; })[0] || null;
  }

  function upsertGroup(payload) {
    var st = readState();
    var next = normalizeGroup(payload || {}, st.groups.length);
    if (next.id === DEFAULT_GROUP_ID) return Promise.resolve(st.groups[0]);
    var idx = st.groups.findIndex(function (x) { return x.id === next.id; });
    if (idx >= 0) st.groups[idx] = next;
    else st.groups.push(next);
    return persist(st).then(function () { return next; });
  }

  function removeGroup(groupId) {
    var targetId = String(groupId || '');
    if (!targetId || targetId === DEFAULT_GROUP_ID) return Promise.resolve(false);
    var st = readState();
    st.groups = st.groups.filter(function (g) { return g.id !== targetId; });
    st.entries = st.entries.map(function (e) {
      if (e.groupId === targetId) e.groupId = DEFAULT_GROUP_ID;
      return e;
    });
    return persist(st).then(function () { return true; });
  }

  function upsertEntry(payload) {
    var st = readState();
    var groupsById = {};
    st.groups.forEach(function (g) { groupsById[g.id] = g; });
    var next = normalizeEntry(payload || {}, groupsById);
    next.updatedAt = Date.now();
    var idx = st.entries.findIndex(function (x) { return x.id === next.id; });
    if (idx >= 0) {
      next.createdAt = st.entries[idx].createdAt || next.createdAt;
      st.entries[idx] = next;
    } else {
      st.entries.unshift(next);
    }
    return persist(st).then(function () { return next; });
  }

  function removeEntry(entryId) {
    var st = readState();
    st.entries = st.entries.filter(function (e) { return e.id !== String(entryId || ''); });
    return persist(st);
  }

  function toggleEntryEnabled(entryId, enabled) {
    var st = readState();
    var target = st.entries.filter(function (e) { return e.id === String(entryId || ''); })[0];
    if (!target) return Promise.resolve(null);
    target.enabled = !!enabled;
    target.updatedAt = Date.now();
    return persist(st).then(function () { return target; });
  }

  function resolveAvailableRoles() {
    var map = {};
    var cs = global.miyaContactsStore;
    if (cs && typeof cs.resolveRolesForWorldbook === 'function') {
      cs.resolveRolesForWorldbook().forEach(function (row) {
        if (!row || !row.roleId) return;
        map[row.roleId] = {
          roleId: row.roleId,
          roleName: row.roleName || row.roleId,
          source: row.source || 'contacts',
          avatar: row.avatar || ''
        };
      });
    }
    listEntries().forEach(function (e) {
      (e.boundRoleIds || []).forEach(function (id) {
        if (!map[id]) map[id] = { roleId: id, roleName: id, source: 'custom', avatar: '' };
      });
    });
    return Object.keys(map)
      .sort(function (a, b) {
        var sa = map[a].source === 'contacts' ? 0 : 1;
        var sb = map[b].source === 'contacts' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return String(map[a].roleName).localeCompare(String(map[b].roleName), 'zh');
      })
      .map(function (id) { return map[id]; });
  }

  global.miyaWorldbookStore = {
    STORE_KEY: STORE_KEY,
    DEFAULT_GROUP_ID: DEFAULT_GROUP_ID,
    SCOPES: SCOPES.slice(),
    DEPTHS: DEPTHS.slice(),
    DEPTH_LABELS: Object.assign({}, DEPTH_LABELS),
    GLOBAL_REACHES: GLOBAL_REACHES.slice(),
    GLOBAL_REACH_LABELS: Object.assign({}, GLOBAL_REACH_LABELS),
    normalizeGlobalReach: normalizeGlobalReach,
    normalizeDepth: normalizeDepth,
    whenReady: whenReady,
    getState: readState,
    listGroups: listGroups,
    listEntries: listEntries,
    /* —— 分组视图接口（UI 唯一入口，未分组被封装在其内部）—— */
    listRealGroups: listRealGroups,
    listVisibleGroups: listVisibleGroups,
    isGroupVisible: isGroupVisible,
    visibleGroupId: visibleGroupId,
    peekDefaultGroupId: peekDefaultGroupId,
    resolveDefaultGroupId: resolveDefaultGroupId,
    getGroup: getGroup,
    getEntry: getEntry,
    upsertGroup: upsertGroup,
    removeGroup: removeGroup,
    upsertEntry: upsertEntry,
    removeEntry: removeEntry,
    toggleEntryEnabled: toggleEntryEnabled,
    resolveAvailableRoles: resolveAvailableRoles,
    invalidateCache: function () { _cache = null; _ready = null; _dirtySinceRead = false; },
    importStJson: function (data, opts) {
      var st = global.miyaWorldbookST;
      if (!st || typeof st.importIntoStore !== 'function') {
        return Promise.reject(new Error('ST 对齐模块未加载'));
      }
      return st.importIntoStore(data, opts);
    },
    exportStJson: function (meta) {
      var st = global.miyaWorldbookST;
      if (!st || typeof st.exportStWorldInfoJson !== 'function') return null;
      return st.exportStWorldInfoJson(listEntries(), meta);
    }
  };

  if (global.miyaRegisterKvStore) global.miyaRegisterKvStore(global.miyaWorldbookStore);
  whenReady();
})(window);
