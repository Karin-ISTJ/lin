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

  /*
   * 默认六表。
   *
   * ── note 为什么写成「思考…应…」而不是「记录…」──
   * 参考 SillyTavern 记忆增强插件的成熟预设后得出的结论：
   * note 不是给用户看的字段说明，而是**每轮注入给 AI 的行动指令**。
   *
   * 旧写法「记录角色外貌、性格、职业等稳定信息」只回答了"这是什么"，
   * 没回答"我什么时候该看它、看完做什么"。实测后果就是模型面对
   * 五六张表无从下手，索性一张都不写 —— 表格长期空着。
   *
   * 新写法一律用「思考本轮…应…」句式，把 note 变成一句自检指令，
   * 模型每轮扫到这个清单就知道该核对哪张表、该产出什么动作。
   */
  function defaultTables() {
    return [
      {
        id: 't_time',
        name: '时空',
        note: '当前场景的时空快照，**恒定保持一行**；场景发生切换时用 updateRow 覆盖第 0 行，不要新增行。',
        enabled: true,
        columns: ['日期', '时间', '地点', '天气', '此地角色'],
        rows: []
      },
      {
        id: 't_char',
        name: '角色特征',
        note: '角色天生或不易改变的特征；思考本轮出场的角色，他应当作出什么反应。',
        enabled: true,
        columns: ['角色名', '身体特征', '性格', '职业', '爱好', '喜欢的事物', '住所', '其他重要信息'],
        rows: []
      },
      {
        id: 't_social',
        name: '社交关系',
        note: '思考本轮若有角色与<user>互动，他对<user>的态度应有何变化（勿写<user>对角色的态度）。',
        enabled: true,
        columns: ['角色名', '对<user>关系', '对<user>态度', '对<user>好感'],
        rows: []
      },
      {
        id: 't_task',
        name: '任务约定',
        note: '思考本轮是否有人交代了任务、或双方定下了约定（含时间地点），以及旧约定是否已到期完成。',
        enabled: true,
        columns: ['角色', '任务/约定', '地点', '持续时间', '状态'],
        rows: []
      },
      {
        id: 't_event',
        name: '重要事件',
        note: '记录<user>或角色经历的重要事件；思考本轮是否发生了对后续剧情有影响、值得留档的事。',
        enabled: true,
        columns: ['相关角色', '事件简述', '日期', '地点', '情绪'],
        rows: []
      },
      {
        id: 't_item',
        name: '重要物品',
        note: '对某人贵重或有特殊纪念意义的物品；思考本轮是否有物品易主、首次出现或失去。',
        enabled: true,
        columns: ['拥有人', '物品名', '物品描述', '重要原因'],
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
    var merged;
    try {
      var raw =
        typeof global.miyaSyncReadJsonKey === 'function'
          ? global.miyaSyncReadJsonKey(SETTINGS_KEY)
          : JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      merged = Object.assign(defaultSettings(), raw && typeof raw === 'object' ? raw : {});
    } catch (e) {
      merged = defaultSettings();
    }
    /*
     * 固定启用：总开关已从界面移除（用户要求记忆表永远开启）。
     * 无论旧存储里写过 enabled:false，读出来一律强制 true ——
     * 引擎三处检查（injectIntoMessages / 写入许可 / 上下文注入）
     * 都走 loadSettings().enabled，这里兜底即可全覆盖。
     */
    merged.enabled = true;
    return merged;
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

  /*
   * ══════════════════════════════════════════════════════════════════
   * 从 SillyTavern「记忆增强表格」插件（muyoou/st-memory-enhancement）导入
   * ══════════════════════════════════════════════════════════════════
   *
   * 两个插件是同源思路（都用 <tableEdit> + insertRow/updateRow 驱动 AI 写表），
   * 但落盘结构完全不同：
   *
   *   ST 插件（每个 sheet 一个对象）：
   *     {
   *       uid:    "sheet_ab12cd34",
   *       name:   "角色特征",
   *       enable: true,
   *       content: [ ["角色","性格"], ["小雨","温柔"] ],   ← 含表头的二维数组
   *       sourceData: { note: "记录外貌性格", insertNode: "...", ... }
   *     }
   *
   *   本项目（每个表一个对象）：
   *     {
   *       id: "t_char", name: "角色特征", note: "记录外貌性格",
   *       enabled: true, columns: ["角色","性格"], rows: [["小雨","温柔"]]
   *     }
   *
   * 对应的桥接点很干净：
   *   name     ← name
   *   columns  ← content[0]          （第一行是表头）
   *   rows     ← content[1..]        （其余是数据行）
   *   note     ← sourceData.note
   *   enabled  ← enable !== false    （注意字段名差一个 d）
   *
   * 几种要兜住的现实情况：
   *   · 用户可能直接给数组（部分版本导出的是 sheet 数组本身，不带外层包装）
   *   · 用户可能给的是插件的「模板」导出，结构与表格一致，照收
   *   · AI 写表格时可能用全角逗号 / 多余空白，这里不清洗（清洗是引擎的事），
   *     但**要保证列数对齐** —— 数据行比表头长就截断，比表头短就补空串，
   *     否则渲染成表时会出现「行长短不一」的错位。
   *   · 表头整行为空（ST 里 origin 单元格在 (0,0)，某些导出会把表头前多留一列）
   *     → 丢掉前导空列，避免导入后第一列是个空列名的怪现象。
   */

  /* 把一行内容规整成「长度 = 列数」的字符串数组 */
  function normalizeImportedRow(row, colCount) {
    var arr = Array.isArray(row) ? row : [];
    var out = [];
    for (var i = 0; i < colCount; i++) {
      var v = arr[i];
      out.push(v == null ? '' : String(v));
    }
    return out;
  }

  /* 去掉表头行可能存在的「前导空列」（ST 的 origin 列在导出时偶有残留） */
  function trimLeadingEmptyHeader(content) {
    if (!content.length) return content;
    var width = content.reduce(function (w, r) {
      return Math.max(w, Array.isArray(r) ? r.length : 0);
    }, 0);
    if (width < 1) return content;

    /* 逐列判断：该列在本表里是否为「全空」且位于最前 */
    var drop = 0;
    for (var c = 0; c < width; c++) {
      var allEmpty = content.every(function (r) {
        var v = Array.isArray(r) ? r[c] : '';
        return String(v == null ? '' : v).trim() === '';
      });
      if (allEmpty) drop++;
      else break;
    }
    if (!drop || drop >= width) return content;
    return content.map(function (r) {
      return (Array.isArray(r) ? r : []).slice(drop);
    });
  }

  /* 判断一个对象是不是 ST 插件的 sheet（而不是本项目自己的表或导出包） */
  function looksLikeStSheet(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    var hasContent = Array.isArray(o.content);
    var hasUid = typeof o.uid === 'string' && /^sheet_/.test(o.uid);
    /* content 是二维数组也算 —— 老版本可能没有 uid */
    var contentIsMatrix =
      hasContent &&
      o.content.length > 0 &&
      Array.isArray(o.content[0]);
    return contentIsMatrix && (hasUid || 'name' in o || 'domain' in o || 'sourceData' in o);
  }

  /**
   * 把 ST 插件的一个 sheet 转成本项目的表对象。
   * 转不出来（没有有效表头）时返回 null，由调用方跳过并计数。
   */
  function convertStSheet(sheet) {
    var content = Array.isArray(sheet.content) ? sheet.content.slice() : [];
    content = trimLeadingEmptyHeader(content);
    if (!content.length) return null;

    var header = Array.isArray(content[0]) ? content[0] : [];
    var columns = header.map(function (c) {
      return String(c == null ? '' : c).trim();
    });
    /* 表头可能被 trimLeadingEmptyHeader 削成 0 列 */
    if (!columns.length) return null;
    /* 列名为空的列补一个占位名，否则渲染和 AI 指令都会错位 */
    columns = columns.map(function (c, i) {
      return c || '列' + (i + 1);
    });

    var rows = content
      .slice(1)
      .map(function (r) {
        return normalizeImportedRow(r, columns.length);
      })
      .filter(function (r) {
        /* 整行全空的行没有意义，丢掉（常见于 ST 表格尾部的空白行） */
        return r.some(function (cell) {
          return String(cell || '').trim() !== '';
        });
      });

    var src = sheet.sourceData && typeof sheet.sourceData === 'object' ? sheet.sourceData : {};
    var note = String(src.note != null ? src.note : sheet.note != null ? sheet.note : '').trim();

    return {
      id: uid('t'),
      name: String(sheet.name || '').trim() || '导入表',
      note: note,
      enabled: sheet.enable !== false && sheet.enabled !== false,
      columns: columns,
      rows: rows
    };
  }

  /**
   * 从任意「ST 插件导出物」里抽出 sheet 数组。
   *
   * 真实世界里这个 JSON 的外层包装有好几种（插件版本 / 不同导出入口 /
   * 用户自己从别处扒下来的片段），所以这里只做一件事：
   * 一层层把「不含 sheet 的壳」剥掉，直到看见数组或死心。
   *
   * 能认的形态：
   *   [ ... ]                   裸数组
   *   { sheets:[...] }          插件列表导出
   *   { tables:[...] }          本项目自己的导出
   *   { data:[...] }            data 直接是数组
   *   { data:{ sheets:[...] } } data 是个对象壳
   *   { preset:{...} }          预设壳
   *   { sheet_xxx:{...}, ... }  ★「以 uid 为键」的字典形态
   *
   * ── 最后那种是踩过的坑 ──
   * ST 插件的 _table_data.json 顶层就是 { "sheet_ab12":{sheet对象}, ...,
   * "mate":{type:"chatSheets"} }，既不是数组也没有 sheets 字段。
   * 旧实现碰到它就 return []，用户拿自己导出的文件来导入直接报 no_sheets。
   * 现在多一条兜底：**对象的值里如果成片地长得像 sheet，就当字典收下**。
   */
  function extractStSheets(input) {
    var node = input;
    /* 最多剥 5 层：足够覆盖现实里的包装深度，又能防畸形数据自引用绕死 */
    for (var depth = 0; depth < 6; depth++) {
      if (!node || typeof node !== 'object') return [];
      if (Array.isArray(node)) return node;
      if (Array.isArray(node.sheets)) return node.sheets;
      if (Array.isArray(node.tables)) return node.tables;
      /* data / preset 是「壳」，对象或数组都继续往下剥 */
      if (node.data && typeof node.data === 'object') { node = node.data; continue; }
      if (node.preset && typeof node.preset === 'object') { node = node.preset; continue; }

      /*
       * 兜底：字典形态 { uid: sheet }。
       * 判据用 looksLikeStSheet 逐值筛，而不是「所有值」——
       * 因为真实文件里混着 "mate" 这类元信息项（type:"chatSheets"），
       * 它长得不像 sheet，正好被自然过滤掉。
       */
      var vals = Object.keys(node).map(function (k) { return node[k]; });
      var sheetVals = vals.filter(looksLikeStSheet);
      if (sheetVals.length) return sheetVals;

      return [];
    }
    return [];
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

  /**
   * 从 ST 记忆增强插件的导出数据导入。
   *
   * @param {string} chatId
   * @param {object|Array} input  插件导出的 JSON（已 parse）
   * @param {object} [opts]
   * @param {'replace'|'append'} [opts.mode='replace']  替换本项目的表 / 追加到现有表后面
   * @returns {Promise<{tables:number, rows:number, skipped:number, mode:string}>}
   */
  function importFromSt(chatId, input, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var mode = opts.mode === 'append' ? 'append' : 'replace';
    var cid = String(chatId || '').trim();
    if (!cid) return Promise.reject(new Error('no_chat_id'));

    var raw = extractStSheets(input);
    if (!raw.length) return Promise.reject(new Error('no_sheets'));

    var converted = [];
    var skipped = 0;
    raw.forEach(function (s) {
      /* 只认像 ST sheet 的对象；本项目自己的表导回来也顺带兼容（有 columns） */
      if (looksLikeStSheet(s)) {
        var t = convertStSheet(s);
        if (t) { converted.push(t); return; }
        skipped++;
        return;
      }
      if (s && typeof s === 'object' && Array.isArray(s.columns)) {
        converted.push(normalizeTable(s, converted.length));
        return;
      }
      skipped++;
    });

    if (!converted.length) return Promise.reject(new Error('no_valid_table'));

    var next;
    if (mode === 'append') {
      next = getChatTables(cid).concat(converted);
    } else {
      next = converted;
    }

    return setChatTables(cid, next, {}).then(function () {
      return {
        tables: converted.length,
        rows: converted.reduce(function (a, t) { return a + (t.rows || []).length; }, 0),
        skipped: skipped,
        mode: mode
      };
    });
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
    importFromSt: importFromSt,
    normalizeTable: normalizeTable,
    rowKey: rowKey,
    parseRowKey: parseRowKey
  };
})(typeof window !== 'undefined' ? window : this);
