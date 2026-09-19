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
      tokenSoftLimit: 1800,
      /*
       * 详细写入规则：教模型「分表职责 / insert 还是 update / 什么不该记」。
       * 默认开启 —— 没有它，模型会把所有东西无脑 insertRow，40 行上限很快
       * 被同一角色的重复行刷满，早期设定被截断挤出，等于把记忆弄丢。
       * 代价是每轮多约 300 tokens，追求极致省 token 的用户可关掉退回简版。
       */
      detailedWriteRules: true
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
    var str = '';
    try { str = JSON.stringify(payload); } catch (eStr) { return Promise.reject(eStr); }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(STORE_KEY, str);
    } else {
      try { localStorage.setItem(STORE_KEY, str); } catch (e) {}
    }
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
    var str = '';
    try { str = JSON.stringify(next); } catch (eStr) { return Promise.reject(eStr); }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(SETTINGS_KEY, str);
    } else {
      try { localStorage.setItem(SETTINGS_KEY, str); } catch (e) {}
    }
    return Promise.resolve(next);
  }

  /*
   * ══════════════════════════════════════════════════════════════════
   * 行溯源（rowSource）—— 为什么必须有，以及它解决什么问题
   * ══════════════════════════════════════════════════════════════════
   *
   * 记忆表的行由 AI 在生成回复时通过 <tableEdit> 里的 insertRow 写入，
   * 但**行本身不记录自己是被哪一层楼生成的**。于是「删除楼层」这条路径
   * 没有可依据的回收对象：
   *
   *   删掉第 12 层 → 聊天记录里那一层没了 → 但记忆表里由它归纳出来的行还在，
   *   而 chatId 没变、桶没变，下一轮生成立刻把它重新注入上下文。
   *   表现就是「我删过的那段剧情，AI 还记得」，且界面上会出现
   *   聊天记录里根本不存在的「幽灵行」。
   *
   * 另外三个删除入口（清空记录 resetChat / 删会话 dropChat / 删联系人 dropChat）
   * 都已收口，只有 deleteMessage / deleteMessages 这条最常用的路径漏了。
   * 但这条路径**不能**照搬另外三个的做法：它删的是「某几层」，不是「整个会话」，
   * 一刀清空等于「删一层 = 失忆」，误伤远大于收益。
   *
   * 正确解是让每一行带上来源楼层，删除时按来源精确回收。这就是 rowSource：
   *
   *   rowSource: { '<tableIndex>:<rowIndex>': '<messageId>', ... }
   *
   * 键用「表序号:行序号」而不是给每行加字段，理由有二：
   *   ① rows 是纯字符串数组，改成对象数组会波及 CSV 注入、UI 表格渲染、
   *      导入导出等所有既有消费方；
   *   ② rowSource 是**可选附带信息**，读不到时下游退化为「不回收」而非报错，
   *      老数据天然安全（见下方 removeRowsBySource）。
   *
   * ⚠️ 行号会失效的两种情形（实现里必须处理，否则溯源错位）：
   *   ① insertRow 超过 maxRowsPerTable 时从**头部**裁行（slice(-maxRows)），
   *      所有行号整体左移 —— 见 engine 侧的 applyActions 与下方的 reindexRowSource；
   *   ② 删除行时，前面的删除会让后面的行号失效 ——
   *      必须**从后往前**删（见 removeRowsBySource）。
   */

  /** 生成 rowSource 的键 */
  function rowKey(tableIndex, rowIndex) {
    return String(tableIndex) + ':' + String(rowIndex);
  }

  /** 解析 rowSource 的键；非法返回 null */
  function parseRowKey(k) {
    var m = /^(\d+):(\d+)$/.exec(String(k || ''));
    if (!m) return null;
    return { tableIndex: parseInt(m[1], 10), rowIndex: parseInt(m[2], 10) };
  }

  /**
   * 整表重排 rowSource —— 当行号发生整体位移时调用。
   *
   * @param {object} rowSource
   * @param {number} tableIndex
   * @param {function(number):(number|null)} mapRow 旧行号 → 新行号；返回 null 表示该行已不存在
   */
  function remapRowSourceForTable(rowSource, tableIndex, mapRow) {
    var src = rowSource && typeof rowSource === 'object' ? rowSource : {};
    var out = {};
    Object.keys(src).forEach(function (k) {
      var p = parseRowKey(k);
      if (!p || p.tableIndex !== tableIndex) {
        out[k] = src[k];
        return;
      }
      var nextRow = mapRow(p.rowIndex);
      if (nextRow == null) return; /* 该行已被裁掉/删除，溯源一并回收 */
      out[rowKey(tableIndex, nextRow)] = src[k];
    });
    return out;
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

  /**
   * 读取某个会话的行溯源表。
   *
   * 读不到一律返回空对象（老数据 / 桶不存在 / 存储异常），
   * 下游据此退化为「不回收」—— 宁可漏回收，也绝不能因为溯源缺失
   * 而误删用户有效的记忆行。
   */
  function getChatRowSource(chatId) {
    var id = String(chatId || '');
    if (!id) return {};
    var all = loadAll();
    var pack = all.chats[id];
    if (!pack || !pack.rowSource || typeof pack.rowSource !== 'object') return {};
    var out = {};
    Object.keys(pack.rowSource).forEach(function (k) {
      if (parseRowKey(k)) out[k] = String(pack.rowSource[k] || '');
    });
    return out;
  }

  /**
   * 写回表 + 行溯源。
   *
   * @param {string} chatId
   * @param {Array} tables
   * @param {object} [rowSource] 省略时保留桶里原有的溯源表。
   *
   * ── 为什么省略时要「保留」而不是「清空」 ──
   * setChatTables 有多个调用方：AI 写入路径（会带上新溯源）、记忆表 UI 的
   * 保存/增行/删行路径（不关心溯源）。若 UI 每次保存都把溯源清空，
   * 用户手动编辑一次表格就会让所有行的来源失效 —— 之后删楼层再也回收不了，
   * 等于这个修复被 UI 操作悄悄卸掉。因此默认保留，只在显式传入时覆盖。
   */
  function setChatTables(chatId, tables, rowSource) {
    var id = String(chatId || '');
    if (!id) return Promise.reject(new Error('no chatId'));
    var all = loadAll();
    var prev = all.chats[id];
    var prevSource =
      prev && prev.rowSource && typeof prev.rowSource === 'object' ? prev.rowSource : {};
    var nextSource;
    if (rowSource && typeof rowSource === 'object') {
      nextSource = {};
      Object.keys(rowSource).forEach(function (k) {
        if (parseRowKey(k)) nextSource[k] = String(rowSource[k] || '');
      });
    } else {
      nextSource = prevSource;
    }
    var nextTables = (tables || []).map(normalizeTable);
    all.chats[id] = {
      tables: nextTables,
      rowSource: nextSource,
      updatedAt: Date.now()
    };
    /*
     * 行数变化后必须校验溯源是否仍然自洽：
     * UI 增行/删行、导入表格、AI 写入越界裁剪都会让键指向不存在的行。
     * 指向越界行的键留着不会立刻出错（回收时会被忽略），
     * 但会随着后续插入被「撞上」并误判 —— 所以在这里统一剔除。
     */
    all.chats[id].rowSource = pruneRowSource(nextSource, nextTables);
    return saveAll(all);
  }

  /** 剔除指向不存在行的溯源键 */
  function pruneRowSource(rowSource, tables) {
    var out = {};
    Object.keys(rowSource || {}).forEach(function (k) {
      var p = parseRowKey(k);
      if (!p) return;
      var t = (tables || [])[p.tableIndex];
      if (!t || !Array.isArray(t.rows) || p.rowIndex >= t.rows.length) return;
      out[k] = rowSource[k];
    });
    return out;
  }

  function ensureChat(chatId) {
    var tables = getChatTables(chatId);
    return setChatTables(chatId, tables).then(function () {
      return tables;
    });
  }

  /** 重置为默认空表：行清空，溯源一并清空（表结构保留） */
  function resetChat(chatId) {
    return setChatTables(chatId, defaultTables(), {});
  }

  /**
   * 按来源楼层回收记忆表的行 —— 本修复的核心。
   *
   * 删除楼层时调用，把「由这些楼层生成的行」从表里精确摘掉，
   * 而不是像 resetChat 那样一刀清空整个会话的记忆。
   *
   * @param {string} chatId
   * @param {string[]} removedMsgIds 被删楼层的消息 id
   * @returns {Promise<{removed:number, tables:Array}>} removed 为实际删掉的行数
   *
   * ── 实现要点 ──
   * ① **按表分组、组内从后往前删**：
   *    删掉第 3 行后，原第 4 行变成第 3 行。若从小到大删，
   *    第 2 个待删行的目标位置已经被前一次删除挪走了，会删错行。
   *    从后往前删则前面待删行的行号不受影响。
   *
   * ② **删除后整表重排溯源**：
   *    一次删掉多行会造成后续行号前移，必须同步 remap，
   *    否则剩下的行溯源会整体错位（这正是「实现里最容易出错的地方」）。
   *
   * ③ **只回收「有标记且标记命中」的行**：
   *    没有溯源的旧数据行一律保留。用户手动在 UI 里加的行也没有溯源，
   *    同样保留 —— 手写内容不该因为删了某层楼而消失。
   */
  /**
   * 单个桶内的行回收（纯内存计算，不落盘）。
   *
   * @param {object} pack 桶 { tables, rowSource }
   * @param {object} drop 待回收的来源 id 集合
   * @returns {{removed:number, tables:Array, rowSource:object}}
   */
  function removeRowsInPack(pack, drop) {
    if (!pack || !Array.isArray(pack.tables)) {
      return { removed: 0, tables: [], rowSource: {} };
    }
    var tables = pack.tables.map(normalizeTable);
    var rowSource =
      pack.rowSource && typeof pack.rowSource === 'object' ? pack.rowSource : {};
    if (!Object.keys(rowSource).length) {
      /* 老数据没有溯源：保守不动，绝不猜 */
      return { removed: 0, tables: tables, rowSource: {} };
    }

    /* 按表分组收集待删行号 */
    var byTable = {};
    Object.keys(rowSource).forEach(function (k) {
      var p = parseRowKey(k);
      if (!p) return;
      var src = String(rowSource[k] || '').trim();
      if (!src || !drop[src]) return;
      if (!byTable[p.tableIndex]) byTable[p.tableIndex] = [];
      byTable[p.tableIndex].push(p.rowIndex);
    });

    var removedCount = 0;
    Object.keys(byTable).forEach(function (tiKey) {
      var ti = parseInt(tiKey, 10);
      var table = tables[ti];
      if (!table || !Array.isArray(table.rows)) return;
      /* 去重 + 降序（从后往前删，见要点①） */
      var rows = byTable[tiKey]
        .filter(function (n, i, arr) {
          return arr.indexOf(n) === i && n >= 0 && n < table.rows.length;
        })
        .sort(function (a, b) {
          return b - a;
        });
      if (!rows.length) return;
      rows.forEach(function (ri) {
        table.rows.splice(ri, 1);
        removedCount += 1;
      });
      tables[ti] = table;
    });

    if (!removedCount) {
      return { removed: 0, tables: tables, rowSource: rowSource };
    }

    /*
     * 重排溯源。
     *
     * ⚠️ 这里必须对**受影响的那几张表**做重排，而不是只重排「本表有溯源键」的行。
     *
     * 为什么：byTable 只装得下「有溯源且来源命中」的行号。
     * 但一行可能**还没有溯源**（例如它由 AI 写入时调用方未提供 sourceMsgIds，
     * 或该行是 UI 手动添加的）。这类行同样会被删楼层牵连着左移，
     * 却因为身上没有溯源键而不会进入 byTable。
     * 若重排时拿「有键的行数」去推算删除前行数，基准就会偏小，
     * 导致存活行的新位置算错 —— 实测表现为「删掉首行后，第二行的溯源
     * 仍然停在原来的行号上」，即溯源整体错位一格。
     *
     * 因此基准必须用**物理行数**：删除前该表的真实行数 = 当前行数 + 被删行数。
     * 被删行数由 byTable 给出（那些行必然既有溯源又命中了删除，确实被摘掉了）。
     */
    var nextSource = {};
    Object.keys(rowSource).forEach(function (k) {
      nextSource[k] = rowSource[k];
    });
    Object.keys(byTable).forEach(function (tiKey) {
      var ti = parseInt(tiKey, 10);
      var table = tables[ti];
      if (!table) return;
      var removedSet = {};
      byTable[tiKey].forEach(function (ri) {
        removedSet[ri] = true;
      });
      var rowCount = table.rows.length;
      /* 删除前的真实行数：当前行数 + 本表被摘掉的行数 */
      var removedInTable = Object.keys(removedSet).length;
      var oldRowCount = rowCount + removedInTable;
      var cursorMap = {};
      var alive = 0;
      for (var oldRow = 0; oldRow < oldRowCount; oldRow += 1) {
        if (removedSet[oldRow]) continue;
        cursorMap[oldRow] = alive;
        alive += 1;
      }
      nextSource = remapRowSourceForTable(nextSource, ti, function (oldRow) {
        return Object.prototype.hasOwnProperty.call(cursorMap, oldRow) ? cursorMap[oldRow] : null;
      });
    });

    return { removed: removedCount, tables: tables, rowSource: nextSource };
  }

  function removeRowsBySource(chatId, removedMsgIds) {
    var drop = {};
    (Array.isArray(removedMsgIds) ? removedMsgIds : []).forEach(function (m) {
      var s = String(m || '').trim();
      if (s) drop[s] = true;
    });
    if (!Object.keys(drop).length) {
      return Promise.resolve({ removed: 0, tables: [] });
    }

    var id = String(chatId || '').trim();
    var all = loadAll();
    /*
     * ── chatId 为空时遍历所有桶 ──
     *
     * 为什么需要这条路径：线下（预约）楼层删除时拿不到确定的 chatId ——
     * 一条线下消息的镜像可能散落在多个线上线程（主线 + castMirrors），
     * 而记忆行只认「线下消息 id」这一个坐标，桶归属取决于当时由哪个
     * chatId 的引擎发起生成。既然来源 id 本身就足够唯一，
     * 直接全桶扫描比猜 chatId 更可靠，也不会误伤（只删来源命中的行）。
     */
    var ids = id
      ? [id]
      : Object.keys(all.chats || {});
    if (!ids.length) return Promise.resolve({ removed: 0, tables: [] });

    var totalRemoved = 0;
    var lastTables = [];
    var touched = false;
    ids.forEach(function (cid) {
      var pack = all.chats[cid];
      if (!pack || !Array.isArray(pack.tables)) return;
      var res = removeRowsInPack(pack, drop);
      if (!res.removed) return;
      touched = true;
      totalRemoved += res.removed;
      lastTables = res.tables;
      all.chats[cid] = {
        tables: res.tables,
        rowSource: pruneRowSource(res.rowSource, res.tables),
        updatedAt: Date.now()
      };
    });

    if (!touched) {
      return Promise.resolve({ removed: 0, tables: id ? getChatTables(id) : [] });
    }
    return saveAll(all).then(function () {
      return { removed: totalRemoved, tables: lastTables };
    });
  }

  /**
   * 彻底删掉某个聊天的记忆表格桶。
   *
   * 与 resetChat 的区别很重要：
   *   resetChat 把桶重置为「默认空表」—— 桶**仍然存在**，只是行的内容被清空。
   *   dropChat  把桶**整个移除** —— 连桶一起消失，不留任何痕迹。
   *
   * 为什么需要后者：记忆表格是按 chatId 分桶存的，而 chatId 在
   * 「清空聊天记录 / 删除聊天 / 删除联系人」这些动作之后**可能被复用**
   * （createChat 对同一联系人是幂等的，会返回已有 chat）。
   * 若只做 reset，用户以后重新和这个角色聊天时，桶里的表结构会以
   * 「默认空表」的样子出现 —— 看起来干净，但只要哪天有旧数据回填，
   * 内容就又回来了。直接删桶才是真正的干净。
   */
  function dropChat(chatId) {
    var id = String(chatId || '');
    if (!id) return Promise.resolve(false);
    var all = loadAll();
    if (!all.chats || !Object.prototype.hasOwnProperty.call(all.chats, id)) {
      return Promise.resolve(false);
    }
    delete all.chats[id];
    return saveAll(all).then(function () {
      return true;
    });
  }

  /** 列出所有存在记忆表格的 chatId（供清理时遍历/排查残留） */
  function listChatIds() {
    var all = loadAll();
    return Object.keys(all.chats || {});
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
    /*
     * 导入是「外部数据整表替换」，来源楼层无从考证，
     * 因此显式传空溯源表覆盖掉旧桶里的记录 ——
     * 否则新导入的行会被旧溯源当作「某层生成的」而在删层时误删。
     */
    return setChatTables(chatId, tables, {});
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
    getChatRowSource: getChatRowSource,
    removeRowsBySource: removeRowsBySource,
    ensureChat: ensureChat,
    resetChat: resetChat,
    dropChat: dropChat,
    listChatIds: listChatIds,
    exportChat: exportChat,
    importChat: importChat,
    normalizeTable: normalizeTable,
    rowKey: rowKey,
    parseRowKey: parseRowKey
  };
})(typeof window !== 'undefined' ? window : this);
