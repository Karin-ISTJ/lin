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

    /* 【W12 修复】丢掉「无名占位行」。
       ------------------------------------------------------------------
       症状：世界书「绑定联系人」面板底部多出几张卡片，名字显示成
             ct_mtxj2rfh_a1ek7s 这类**裸 ID**，头像处是一个字母占位符。

       成因：normalizeCharacter 对 characterId 做了「缺省回落到 id」的处理：

             characterId: String((raw && raw.characterId) || id).trim() || id

       而 resolveRolesForWorldbook 把 [characterId, id] 两个都推成角色卡：

             [c.characterId, c.id].forEach(function (rid) { ...push... });

       所以一条 **name 为空** 的残留行，会以「与自身 id 同值的 characterId」
       身份被推出来，卡片名走 `row.roleName || row.roleId` 兜底 → 显示裸 ID。

       这些行不可能由正常写入路径产生 —— upsertCharacter 明确拒绝空名
       （`if (!next.name) return Promise.resolve({ error: '请填写姓名' })`）。
       它们来自旧版本数据、导入残留、或外部直接改写 localStorage。

       处理原则：**在读的边界上过滤，而不是在写的时候删数据。**
       把「名字为空且没有任何实义内容」的行判为占位垃圾，不进入内存视图。
       这样既不破坏用户真实数据（万一只是名字字段丢了、persona 还在，
       下面会保留），又能立即让面板干净。

       ⚠️ 必须保留「有 persona / 有 greetings / 有头像」的无名行 ——
       它们可能是用户真实档案但名字字段损坏，直接丢掉等于删用户的角色。 */
    chars = chars.filter(function (c) {
      if (!c) return false;
      var name = String(c.name || '').trim();
      if (name) return true;
      /* 无名：只有在完全空壳时才丢弃 */
      var hasPersona = String(c.persona || '').trim().length > 0;
      var hasGreetings = Array.isArray(c.greetings) && c.greetings.length > 0;
      var hasAvatar = String(c.avatar || '').trim().length > 0;
      var hasProfile = String(c.gender || '').trim() || String(c.age || '').trim() ||
        String(c.birthday || '').trim();
      if (hasPersona || hasGreetings || hasAvatar || hasProfile) return true;
      /* 完全空壳 —— 不是有效联系人 */
      return false;
    });

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
    var csStr = '';
    try { csStr = JSON.stringify(normalized); } catch (eStr) { return Promise.resolve(normalized); }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(STORE_KEY, csStr);
    } else {
      try { localStorage.setItem(STORE_KEY, csStr); } catch (e) {}
    }
    return Promise.resolve(normalized);
  }

  function whenReady() {
    if (_ready) return _ready;
    _ready = (typeof global.miyaReadLsJsonKey === 'function'
      ? global.miyaReadLsJsonKey(STORE_KEY, { groups: [], characters: [] })
      : Promise.resolve({ groups: [], characters: [] })
    ).then(function (v) {
      var raw = v && typeof v === 'object' ? v : { groups: [], characters: [] };
      var rawCount = Array.isArray(raw.characters) ? raw.characters.length : 0;
      _cache = normalizeState(raw);
      /* 【W12 自愈】磁盘上若存在「无名空壳行」，读时过滤只解决了内存视图，
         脏数据仍在 localStorage 里，每次加载都要再过滤一遍、且会持续出现在
         其它直接读 raw 的地方。这里做一次**一次性落盘清理**：
         只有当确实滤掉了东西（数量变少）才写回，避免无谓的写放大。
         写回的内容是 normalizeState 的结果 —— 与下次启动读到的完全一致，
         不存在二次漂移。 */
      if (rawCount > _cache.characters.length) {
        try {
          persist(_cache).catch(function () {});
        } catch (eHeal) { /* 自愈失败不影响本次读取 */ }
      }
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

  /*
   * 供世界书「绑定联系人」面板使用的角色列表。
   *
   * ⚠️【W12 修复】旧实现把 characterId 和 id **各推一张卡**：
   *
   *     [c.characterId, c.id].forEach(function (rid) { ...push... });
   *
   * 后果有两个，都是实打实的用户困扰：
   *
   *  ① 同一个角色在面板里出现两次，用户不知道点哪张才对。
   *     两张卡的 roleId 不同（一个是 characterId，一个是记录 id），
   *     存进 boundRoleIds 的值也就不同 —— 而下游比较绑定关系时两侧
   *     都得靠别名展开才能对上，白白引入一层脆弱依赖。
   *
   *  ② 对 characterId 缺省的行，normalizeCharacter 会让它回落到 id，
   *     于是两个值相同、去重后只剩一张卡，卡名走 `roleName || roleId`
   *     兜底 —— 名字为空的历史残留行就显示成 ct_mtxj2rfh_a1ek7s 这样的裸 ID。
   *
   * 现在改为**一个角色只出一张卡**，prioritize 记录 id（c.id）：
   * 它是稳定主键，且世界书面板、编辑器、删除逻辑都认它。
   * characterId 不再单独成卡 —— 它作为「别名」由 matcher.expandRoleAliases
   * 在比较绑定关系时统一展开，面板不需要让用户去选。
   */
  function resolveRolesForWorldbook() {
    var out = [];
    var seen = {};
    var chars = listCharacters();

    /* 已被现有词条绑定的 ID 集合。
       用途：某个角色的 characterId 若**已经被用户绑过**，就不能简单地把
       它的卡片拿掉 —— 那会让用户在面板上找不到自己已选中的项，误以为
       绑定丢了。（旧数据里 characterId 和 id 都可能被绑过。） */
    var boundSet = {};
    try {
      var wbStore = global.miyaWorldbookStore;
      if (wbStore && typeof wbStore.listEntries === 'function') {
        (wbStore.listEntries() || []).forEach(function (e) {
          (Array.isArray(e && e.boundRoleIds) ? e.boundRoleIds : []).forEach(function (bid) {
            var k = String(bid || '').trim();
            if (k) boundSet[k] = true;
          });
        });
      }
    } catch (eBound) { /* 取不到就不做兼容保留，退回「只出 id 卡」 */ }

    chars.forEach(function (c) {
      if (!c) return;
      var name = String(c.name || '').trim();
      /* 没有名字的行不进面板 —— 用户无法识别，选中它等于埋雷。
         （normalizeState 已在读边界滤掉纯空壳；这里再挡一道，
         应付「有 persona 但名字损坏」的行，避免它们以裸 ID 面貌出现。） */
      if (!name) return;

      var id = String(c.id || '').trim();
      var charId = String(c.characterId || '').trim();

      /* 主卡：记录 id（稳定主键，世界书面板/编辑器/删除逻辑都认它） */
      if (id && !seen[id]) {
        seen[id] = true;
        out.push({
          roleId: id,
          roleName: name,
          source: 'contacts',
          groupId: c.groupId,
          avatar: c.avatar || ''
        });
      }

      /* 兼容卡：characterId 与 id 不同、且**确实被绑过**时，补一张。
         这只是为了不破坏既有绑定，不是鼓励用户去选它 ——
         绑定关系比较时两侧都会展开别名，选哪个都能对上。 */
      if (charId && charId !== id && !seen[charId] && boundSet[charId]) {
        seen[charId] = true;
        out.push({
          roleId: charId,
          roleName: name + '（档案 ID）',
          source: 'contacts',
          groupId: c.groupId,
          avatar: c.avatar || ''
        });
      }
    });
    return out;
  }

  /**
   * 渲染角色档案块。
   *
   * opts.includeGreetings：是否带上开场白。
   *   **默认 false** —— 这是刻意的。开场白只在「对话第一楼」有意义，而本函数
   *   被 couple-whisper、朋友圈等多处调用，它们都不是第一楼场景。
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
