(function (global) {
  'use strict';

  var STORE_KEY = 'miya-contacts-v1';
  var DEFAULT_GROUP_ID = 'ct_default';
  var _cache = null;
  var _ready = null;
  var _wbCountMap = null;

  function invalidateWbCountMap() {
    _wbCountMap = null;
  }

  function buildWbCountMap() {
    if (_wbCountMap) return _wbCountMap;
    var map = Object.create(null);
    var wb = global.miyaWorldbookStore;
    if (wb && typeof wb.listEntries === 'function') {
      wb.listEntries().forEach(function (e) {
        (Array.isArray(e.boundRoleIds) ? e.boundRoleIds : []).forEach(function (bid) {
          var key = String(bid || '').trim();
          if (key) map[key] = (map[key] || 0) + 1;
        });
      });
    }
    _wbCountMap = map;
    return map;
  }

  function nowId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalizeGroup(raw, index) {
    var id = String(raw && raw.id ? raw.id : nowId('ctg'));
    if (id === DEFAULT_GROUP_ID) {
      return { id: DEFAULT_GROUP_ID, name: '未归档', sort: 0, fixed: true };
    }
    return {
      id: id,
      name: String((raw && raw.name) || '').trim() || '未命名卷',
      sort: typeof raw.sort === 'number' ? raw.sort : (index + 1) * 10,
      fixed: false
    };
  }

  function buildPersona(raw) {
    var persona = String((raw && raw.persona) || '').trim();
    if (persona) return persona;
    if (!raw) return '';
    if (raw.unified) return String(raw.unified).trim();
    var parts = [raw.background, raw.personality, raw.relationships, raw.other,
      raw.description, raw.scenario, raw.system_prompt]
      .map(function (x) { return String(x || '').trim(); })
      .filter(Boolean);
    return parts.join('\n\n');
  }

  /*
   * 开场白（greetings）：
   * 这是「对话第一楼」用的素材，原本被 Tavern 卡导入时塞进了 persona 字符串里
   * （【首条消息】【备选开场】两段），导致它跟着人设一起被反复注入每一轮提示词。
   * 拆成独立字段后，只有「第一楼」（对话还没有消息时）才需要它。
   *
   * 约定：greetings[0] 是「首条消息」（默认展示、可直接编辑），
   *       greetings[1..] 是备选开场，要用「切换」才看得到。
   *
   * 注意这里【不过滤空串】：用户会故意留一个空位，再把它编辑成首条消息。
   * 过滤掉的话，那个空位在保存后就消失了，等于每次都得多点一次「添加」。
   */
  function normalizeGreetings(raw) {
    var arr = raw && raw.greetings;
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      return String(x == null ? '' : x).replace(/\r\n/g, '\n').trim();
    });
  }

  /* 「备选开场」段落标题：Tavern 卡导入时用的是这个 */
  var GREETING_SECTION_TITLES = ['【备选开场】', '【开场白】', '【开场】'];

  /**
   * 从老数据的 persona 里把开场白拆出来。
   *
   * 背景：旧版导入把 alternate_greetings 用 '\n---\n' 拼成一个段落塞进 persona：
   *
   *     【备选开场】
   *     开场白甲…
   *     ---
   *     开场白乙…
   *
   * 这里按同样的规则反向切开。找不到就返回空数组（不抛错）。
   */
  function extractGreetingsFromPersona(persona) {
    var text = String(persona == null ? '' : persona);
    if (!text) return [];
    var hit = null;
    for (var i = 0; i < GREETING_SECTION_TITLES.length; i++) {
      var at = text.indexOf(GREETING_SECTION_TITLES[i]);
      if (at >= 0) { hit = { at: at, tag: GREETING_SECTION_TITLES[i] }; break; }
    }
    if (!hit) return [];

    /* 从标题行之后开始，一直取到下一个顶层【标题】之前 */
    var rest = text.slice(hit.at + hit.tag.length);
    var lines = rest.split('\n');
    var body = [];
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      if (j > 0 && /^\s*【[^】]{1,40}】/.test(ln)) break;
      body.push(ln);
    }
    var joined = body.join('\n').trim();
    if (!joined) return [];

    return joined.split(/\n\s*---\s*\n/)
      .map(function (s) { return String(s || '').replace(/\r\n/g, '\n').trim(); })
      .filter(Boolean);
  }

  /**
   * 把 persona 里的开场白段落剥掉，避免「独立字段 + persona 内嵌」两处重复占 token。
   * 与 extractGreetingsFromPersona 用同一套边界判据，保证拆出来的和剥掉的是同一段。
   */
  function stripGreetingSections(persona) {
    var text = String(persona == null ? '' : persona);
    if (!text) return text;
    var out = text;
    for (var i = 0; i < GREETING_SECTION_TITLES.length; i++) {
      var tag = GREETING_SECTION_TITLES[i];
      var at = out.indexOf(tag);
      if (at < 0) continue;
      var head = out.slice(0, at);
      var rest = out.slice(at + tag.length);
      var lines = rest.split('\n');
      var tail = [];
      var k = 0;
      for (; k < lines.length; k++) {
        if (k > 0 && /^\s*【[^】]{1,40}】/.test(lines[k])) break;
      }
      tail = lines.slice(k);
      out = (head.replace(/\s+$/, '') + (tail.length ? '\n\n' + tail.join('\n').replace(/^\s+/, '') : ''));
      break;
    }
    return out.trim();
  }

  function normalizeCharacter(raw, groupsById) {
    var gid = String((raw && raw.groupId) || '').trim();
    if (!gid || !groupsById[gid]) gid = DEFAULT_GROUP_ID;
    var id = String(raw && raw.id ? raw.id : nowId('ct'));
    var persona = buildPersona(raw);
    var greetings = normalizeGreetings(raw);
    /*
     * 老档案迁移（惰性）：greetings 还没有，但 persona 里内嵌着【备选开场】。
     * 就地拆出来 + 剥掉原件，这样老用户不必重新导入角色卡也能用上开场白功能。
     * 只做一次 —— 迁移后 greetings 非空，下次读就不会再走这条路。
     */
    if (!greetings.length && persona) {
      var legacy = extractGreetingsFromPersona(persona);
      if (legacy.length) {
        greetings = legacy;
        persona = stripGreetingSections(persona);
      }
    }
    return {
      id: id,
      characterId: String((raw && raw.characterId) || id).trim() || id,
      groupId: gid,
      name: String((raw && raw.name) || '').trim(),
      avatar: String((raw && raw.avatar) || ''),
      age: String((raw && raw.age) != null ? raw.age : '').trim(),
      gender: String((raw && raw.gender) || '').trim(),
      birthday: String((raw && raw.birthday) || '').trim(),
      persona: persona,
      greetings: greetings,
      tags: Array.isArray(raw && raw.tags) ? raw.tags.map(String).filter(Boolean) : [],
      updatedAt: Number(raw && raw.updatedAt) || Date.now()
    };
  }

  function normalizeState(state) {
    var rawGroups = Array.isArray(state && state.groups) ? state.groups : [];
    var groups = rawGroups.map(normalizeGroup).filter(function (g) { return g.id !== DEFAULT_GROUP_ID; });
    groups.unshift(normalizeGroup({ id: DEFAULT_GROUP_ID }));
    groups.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    var groupsById = {};
    groups.forEach(function (g) { groupsById[g.id] = g; });

    var chars = (Array.isArray(state && state.characters) ? state.characters : [])
      .map(function (row) { return normalizeCharacter(row, groupsById); });
    chars.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return { version: 1, groups: groups, characters: chars };
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
    return normalizeState({ groups: [], characters: [] });
  }

  function persist(state) {
    var normalized = normalizeState(state);
    _cache = normalized;
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return global.miyaWriteLsJsonKey(STORE_KEY, normalized).then(function () { return normalized; });
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(normalized)); } catch (e) {}
    return Promise.resolve(normalized);
  }

  function whenReady() {
    if (_ready) return _ready;
    _ready = (typeof global.miyaReadLsJsonKey === 'function'
      ? global.miyaReadLsJsonKey(STORE_KEY, { groups: [], characters: [] })
      : Promise.resolve({ groups: [], characters: [] })
    ).then(function (v) {
      _cache = normalizeState(v && typeof v === 'object' ? v : { groups: [], characters: [] });
      return _cache;
    }).catch(function () {
      _cache = normalizeState({ groups: [], characters: [] });
      return _cache;
    });
    return _ready;
  }

  function listGroups() { return readState().groups.slice(); }

  function listCharacters(groupId) {
    var rows = readState().characters;
    if (!groupId || groupId === 'all') return rows.slice();
    return rows.filter(function (c) { return c.groupId === String(groupId); });
  }

  function findCharacter(id) {
    var key = String(id || '').trim();
    return readState().characters.find(function (c) {
      return c.id === key || c.characterId === key;
    }) || null;
  }

  function getGroup(groupId) {
    return listGroups().filter(function (g) { return g.id === String(groupId || ''); })[0] || null;
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
    st.characters = st.characters.map(function (c) {
      if (c.groupId === targetId) c.groupId = DEFAULT_GROUP_ID;
      return c;
    });
    return persist(st).then(function () { return true; });
  }

  function upsertCharacter(payload) {
    var st = readState();
    var groupsById = {};
    st.groups.forEach(function (g) { groupsById[g.id] = g; });
    var body = Object.assign({}, payload || {}, { updatedAt: Date.now() });
    if (body.newGroupName) {
      return upsertGroup({ name: body.newGroupName, sort: Date.now() }).then(function (g) {
        body.groupId = g.id;
        delete body.newGroupName;
        return upsertCharacter(body);
      });
    }
    var next = normalizeCharacter(body, groupsById);
    if (!next.name) return Promise.resolve({ error: '请填写姓名' });
    var idx = st.characters.findIndex(function (c) { return c.id === next.id; });
    if (idx >= 0) st.characters[idx] = next;
    else st.characters.unshift(next);
    return persist(st).then(function () { return next; });
  }

  function removeCharacter(id) {
    var st = readState();
    var key = String(id || '');
    var removed = st.characters.filter(function (c) {
      return c.id === key || c.characterId === key;
    });
    st.characters = st.characters.filter(function (c) {
      return c.id !== key && c.characterId !== key;
    });
    return persist(st).then(function () {
      var rs = global.miyaContactsRelationshipStore;
      if (rs && typeof rs.purgeCharacter === 'function') {
        removed.forEach(function (c) {
          rs.purgeCharacter(c.id);
          if (c.characterId && c.characterId !== c.id) rs.purgeCharacter(c.characterId);
        });
      }
      return true;
    });
  }

  function countWorldbookBindings(characterId) {
    var row = findCharacter(characterId);
    if (!row) return 0;
    var map = buildWbCountMap();
    var total = 0;
    [row.id, row.characterId].filter(Boolean).forEach(function (id) {
      total += map[id] || 0;
    });
    return total;
  }

  function countWorldbookBindingsMap(characterIds) {
    var map = buildWbCountMap();
    var out = Object.create(null);
    (characterIds || []).forEach(function (characterId) {
      var row = findCharacter(characterId);
      if (!row) {
        out[characterId] = 0;
        return;
      }
      var total = 0;
      [row.id, row.characterId].filter(Boolean).forEach(function (id) {
        total += map[id] || 0;
      });
      out[characterId] = total;
    });
    return out;
  }

  function resolveRolesForWorldbook() {
    var out = [];
    var seen = {};
    listCharacters().forEach(function (c) {
      [c.characterId, c.id].forEach(function (rid) {
        rid = String(rid || '').trim();
        if (!rid || seen[rid]) return;
        seen[rid] = true;
        out.push({
          roleId: rid,
          roleName: c.name || rid,
          source: 'contacts',
          groupId: c.groupId,
          avatar: c.avatar || ''
        });
      });
    });
    return out;
  }

  /**
   * 渲染角色档案块。
   *
   * opts.includeGreetings：是否带上开场白。
   *   **默认 false** —— 这是刻意的。开场白只在「对话第一楼」有意义，而本函数
   *   被 deep 桥、couple-whisper、朋友圈等 9 处调用，它们都不是第一楼场景。
   *   默认不带，才能保证这些调用方的输出与加此功能之前【逐字节一致】。
   */
  function renderChronicleBlock(roleId, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var row = findCharacter(roleId);
    if (!row || !row.name) return '';
    var lines = ['【角色·档案·' + String(row.name) + '】'];
    if (row.gender) lines.push('- 性别: ' + row.gender);
    if (row.age) lines.push('- 年龄: ' + row.age);
    if (row.birthday) lines.push('- 生日: ' + row.birthday);
    if (row.persona) lines.push('- 人设与背景: ' + row.persona);
    /*
     * 开场白：只取第 1 条（首条消息）。
     * 备选开场不注入 —— 模型看到多条开场白时容易把它们当成「多轮对话」或
     * 在正文里重复场景，反而干扰。选哪条开场是用户在第一楼卡片上决定的事。
     */
    if (opts.includeGreetings) {
      var g = (row.greetings || []).filter(function (x) { return String(x || '').trim(); });
      if (g.length) lines.push('- 开场白（本次对话的开场，供你把握语气与场景）: ' + g[0]);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  global.miyaContactsStore = {
    STORE_KEY: STORE_KEY,
    DEFAULT_GROUP_ID: DEFAULT_GROUP_ID,
    whenReady: whenReady,
    getState: readState,
    listGroups: listGroups,
    listCharacters: listCharacters,
    findCharacter: findCharacter,
    getGroup: getGroup,
    upsertGroup: upsertGroup,
    removeGroup: removeGroup,
    upsertCharacter: upsertCharacter,
    removeCharacter: removeCharacter,
    countWorldbookBindings: countWorldbookBindings,
    countWorldbookBindingsMap: countWorldbookBindingsMap,
    invalidateWbCountMap: invalidateWbCountMap,
    resolveRolesForWorldbook: resolveRolesForWorldbook,
    renderChronicleBlock: renderChronicleBlock,
    extractGreetingsFromPersona: extractGreetingsFromPersona,
    stripGreetingSections: stripGreetingSections,
    normalizeGreetings: normalizeGreetings,
    invalidateCache: function () { _cache = null; _ready = null; invalidateWbCountMap(); }
  };

  if (global.miyaRegisterKvStore) global.miyaRegisterKvStore(global.miyaContactsStore);
  whenReady();
})(window);
