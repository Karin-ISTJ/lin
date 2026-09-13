/**
 * Miya · 记忆表格引擎
 * - 生成前注入表格正文 + 编辑规则
 * - 生成后解析 <tableEdit> 中的 insertRow/updateRow/deleteRow
 */
(function (global) {
  'use strict';

  function estimateTokens(text) {
    var s = String(text || '');
    if (!s) return 0;
    var cjk = (s.match(/[\u3400-\u9fff]/g) || []).join('').length;
    var rest = s.length - cjk;
    return Math.max(1, Math.ceil(cjk / 1.8 + rest / 4));
  }

  /*
   * 单元格清洗：表格是以 `rowIndex,列0,列1,...` 的裸 CSV 形式喂给模型的，
   * 所以单元格里任何「换行 / 逗号 / 引号 / 竖线」都会把结构撑破，
   * 让模型误读列归属，进而写回错行的 updateRow。
   *
   * 旧实现只 replace(/,/g,'/')，换行直接漏出去把一行拆成两行。
   * 现在统一替换为安全字符，并限长，避免单个单元格吃掉整段 token 预算。
   */
  var CELL_MAX_LEN = 200;

  function sanitizeCell(v) {
    var s = v == null ? '' : String(v);
    if (!s) return '';
    s = s
      /* 换行/回车/制表：绝不能留，否则破坏行结构 */
      .replace(/[\r\n\t]+/g, ' ')
      /* 逗号：CSV 分隔符 */
      .replace(/,/g, '/')
      /* 引号：部分模型会误判为字段包裹符 */
      .replace(/["'`]/g, '')
      /* 竖线：保留会与部分表格标记混淆 */
      .replace(/\|/g, '/')
      /* 连续空白折叠 */
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (s.length > CELL_MAX_LEN) s = s.slice(0, CELL_MAX_LEN) + '…';
    return s;
  }

  /** 表名/说明同样进上下文，一并清洗，防止注入换行伪造表格结构 */
  function sanitizeLabel(v) {
    return String(v == null ? '' : v)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function tableToCsvBlock(table, index, maxRows) {
    if (!table || table.enabled === false) return '';
    var cols = table.columns || [];
    var rows = table.rows || [];
    if (maxRows > 0 && rows.length > maxRows) {
      rows = rows.slice(-maxRows);
    }
    var lines = [];
    lines.push('* ' + index + ':' + sanitizeLabel(table.name || '表'));
    if (table.note) lines.push('【说明】' + sanitizeLabel(table.note));
    lines.push('【表格内容】');
    lines.push(
      'rowIndex,' +
        cols
          .map(function (c, i) {
            return i + ':' + sanitizeLabel(c);
          })
          .join(',')
    );
    rows.forEach(function (row, ri) {
      var cells = cols.map(function (_, ci) {
        return sanitizeCell(row[ci]);
      });
      lines.push(ri + ',' + cells.join(','));
    });
    return lines.join('\n');
  }

  function buildTablesPrompt(chatId, opts) {
    opts = opts || {};
    var store = global.MiyaMemoryTableStore;
    if (!store) return '';
    var settings = store.loadSettings();
    if (settings.enabled === false || settings.isAiRead === false) return '';
    var tables = store.getChatTables(chatId);
    var maxRows = Number(settings.maxRowsPerTable) || 40;
    var soft = Number(settings.tokenSoftLimit) || 1800;
    var parts = [];
    var used = 0;
    tables.forEach(function (t, i) {
      var block = tableToCsvBlock(t, i, maxRows);
      if (!block) return;
      var tok = estimateTokens(block);
      if (used + tok > soft && parts.length) return;
      parts.push(block);
      used += tok;
    });
    if (!parts.length) {
      parts.push('(当前记忆表为空，请在剧情推进时按规则写入重要信息。)');
    }
    var editRules = '';
    if (settings.isAiWrite !== false) {
      editRules =
        '\n\n【记忆表操作规则】\n' +
        '若本轮剧情产生需要长期记住的信息，在回复末尾追加 <tableEdit><!-- ... --></tableEdit>。\n' +
        '仅使用下列函数（tableIndex 从 0 开始，rowIndex 从 0 开始，列用数字下标）：\n' +
        'insertRow(tableIndex, {0:"值",1:"值"})\n' +
        'updateRow(tableIndex, rowIndex, {0:"值"})\n' +
        'deleteRow(tableIndex, rowIndex)\n' +
        '原则：禁止捏造未知；单元格勿用英文逗号，用 / 分隔；勿写用户对角色的态度到社交表；只记录重要信息。\n' +
        'tableEdit 必须用 <!-- --> 包住函数调用。无更新时不要输出 tableEdit。';
    }
    return (
      '【记忆增强表格·长期记忆】\n' +
      '以下为已结构化的角色/时空/关系/事件/物品记忆，生成时必须知晓并保持一致，禁止遗忘或矛盾。\n\n' +
      parts.join('\n\n') +
      editRules
    );
  }

  function stripTableEditFromReply(text) {
    var s = String(text || '');
    return s
      .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseTableEditBlock(text) {
    var s = String(text || '');
    var m = s.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/i);
    if (!m) return [];
    var body = m[1].replace(/<!--([\s\S]*?)-->/g, '$1');
    var actions = [];
    var re = /(insertRow|updateRow|deleteRow)\s*\(([\s\S]*?)\)\s*(?=$|;|\n)/g;
    var hit;
    while ((hit = re.exec(body))) {
      actions.push({ op: hit[1], rawArgs: hit[2].trim() });
    }
    return actions;
  }

  /*
   * 安全参数解析器：替代原来的正则改写 + new Function 兜底。
   *
   * 旧实现有两个问题：
   * 1) 兜底走 new Function，等于拿模型输出直接 eval，属于代码注入面；
   * 2) 预处理把单引号无差别换成双引号，单元格里本来就有引号时必然解析失败。
   *
   * 现在改为手写扫描：严格按 JS 字面量语法取值，不执行任何代码。
   * 支持数字、单/双引号字符串（含转义）、true/false/null、嵌套对象/数组。
   */

  function isIdentStart(ch) {
    return /[A-Za-z_$]/.test(ch);
  }

  function isIdentChar(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
  }

  function skipWs(s, i) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    return i;
  }

  /** 解析带引号的字符串，返回 {value, next}；未闭合返回 null */
  function readString(s, i, quote) {
    i += 1;
    var out = '';
    while (i < s.length) {
      var ch = s[i];
      if (ch === '\\') {
        var esc = s[i + 1];
        if (esc === undefined) return null;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'u') {
          var hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        } else if (esc === 'x') {
          var h2 = s.slice(i + 2, i + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(h2)) return null;
          out += String.fromCharCode(parseInt(h2, 16));
          i += 4;
          continue;
        } else out += esc;
        i += 2;
        continue;
      }
      if (ch === quote) return { value: out, next: i + 1 };
      /* 反引号模板串不支持：直接判失败，交由上层打日志，避免误吞内容 */
      if (ch === '`') return null;
      out += ch;
      i += 1;
    }
    return null;
  }

  /** 解析数字；不合法返回 null */
  function readNumber(s, i) {
    var m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) return null;
    var n = Number(m[0]);
    if (!Number.isFinite(n)) return null;
    return { value: n, next: i + m[0].length };
  }

  /** 解析标识符字面量：true / false / null / undefined / NaN */
  function readIdent(s, i) {
    var j = i;
    while (j < s.length && isIdentChar(s[j])) j += 1;
    var word = s.slice(i, j);
    if (word === 'true') return { value: true, next: j };
    if (word === 'false') return { value: false, next: j };
    if (word === 'null' || word === 'undefined') return { value: null, next: j };
    if (word === 'NaN') return { value: NaN, next: j };
    if (!word) return null;
    /* 未知标识符（变量、函数调用等）：拒绝，不执行 */
    return null;
  }

  function parseValue(s, i) {
    i = skipWs(s, i);
    if (i >= s.length) return null;
    var ch = s[i];
    if (ch === '{') {
      var obj = {};
      i = skipWs(s, i + 1);
      if (s[i] === '}') return { value: obj, next: i + 1 };
      for (;;) {
        i = skipWs(s, i);
        var key;
        if (s[i] === '"' || s[i] === "'") {
          var k = readString(s, i, s[i]);
          if (!k) return null;
          key = k.value;
          i = k.next;
        } else {
          /* 裸键：数字下标 0 / 1，或标识符键 */
          var kn = readNumber(s, i);
          if (kn) {
            key = String(kn.value);
            i = kn.next;
          } else {
            var st = i;
            while (i < s.length && isIdentChar(s[i])) i += 1;
            if (i === st) return null;
            key = s.slice(st, i);
          }
        }
        i = skipWs(s, i);
        if (s[i] !== ':') return null;
        var v = parseValue(s, i + 1);
        if (!v) return null;
        obj[key] = v.value;
        i = skipWs(s, v.next);
        if (s[i] === ',') { i += 1; continue; }
        if (s[i] === '}') return { value: obj, next: i + 1 };
        return null;
      }
    }
    if (ch === '[') {
      var arr = [];
      i = skipWs(s, i + 1);
      if (s[i] === ']') return { value: arr, next: i + 1 };
      for (;;) {
        var item = parseValue(s, i);
        if (!item) return null;
        arr.push(item.value);
        i = skipWs(s, item.next);
        if (s[i] === ',') { i = skipWs(s, i + 1); continue; }
        if (s[i] === ']') return { value: arr, next: i + 1 };
        return null;
      }
    }
    if (ch === '"' || ch === "'") return readString(s, i, ch);
    var num = readNumber(s, i);
    if (num) return num;
    return readIdent(s, i);
  }

  /** 解析 "0, {0:\"a\"}" 这类逗号分隔的实参，返回数组或 null */
  function parseArgs(raw) {
    // insertRow(0, {0:"a",1:"b"}) | updateRow(0,1,{2:"x"}) | deleteRow(0,1)
    var src = String(raw || '').trim();
    if (!src) return null;
    var out = [];
    var i = 0;
    for (;;) {
      var v = parseValue(src, i);
      if (!v) return null;
      out.push(v.value);
      i = skipWs(src, v.next);
      if (i >= src.length) return out;
      if (src[i] !== ',') return null;
      i += 1;
      if (i >= src.length) return null; /* 尾逗号 */
    }
  }

  function applyActions(tables, actions, settings) {
    var maxRows = (settings && settings.maxRowsPerTable) || 40;
    var next = tables.map(function (t) {
      return {
        id: t.id,
        name: t.name,
        note: t.note,
        enabled: t.enabled,
        columns: t.columns.slice(),
        rows: t.rows.map(function (r) {
          return r.slice();
        })
      };
    });
    var log = [];
    actions.forEach(function (act) {
      var args = parseArgs(act.rawArgs);
      if (!args || !args.length) {
        log.push('skip bad args: ' + act.op);
        return;
      }
      var ti = Number(args[0]);
      if (!Number.isFinite(ti) || ti < 0 || ti >= next.length) {
        log.push('bad tableIndex ' + ti);
        return;
      }
      var table = next[ti];
      if (act.op === 'insertRow') {
        var data = args[1] && typeof args[1] === 'object' ? args[1] : {};
        var row = table.columns.map(function (_, ci) {
          var v = data[ci] != null ? data[ci] : data[String(ci)];
          /* 入库即清洗：脏字符不落盘，避免下一轮注入时污染表格结构 */
          return sanitizeCell(v);
        });
        table.rows.push(row);
        if (table.rows.length > maxRows) table.rows = table.rows.slice(-maxRows);
        log.push('insertRow ' + ti);
      } else if (act.op === 'deleteRow') {
        var ri = Number(args[1]);
        if (Number.isFinite(ri) && ri >= 0 && ri < table.rows.length) {
          table.rows.splice(ri, 1);
          log.push('deleteRow ' + ti + ',' + ri);
        }
      } else if (act.op === 'updateRow') {
        var riu = Number(args[1]);
        var dataU = args[2] && typeof args[2] === 'object' ? args[2] : {};
        if (Number.isFinite(riu) && riu >= 0 && riu < table.rows.length) {
          table.columns.forEach(function (_, ci) {
            if (dataU[ci] != null || dataU[String(ci)] != null) {
              var v = dataU[ci] != null ? dataU[ci] : dataU[String(ci)];
              /* 同上：写回时也清洗，模型常把整段剧情塞进单元格 */
              table.rows[riu][ci] = sanitizeCell(v);
            }
          });
          log.push('updateRow ' + ti + ',' + riu);
        }
      }
    });
    return { tables: next, log: log };
  }

  function processAssistantReply(chatId, replyText) {
    var store = global.MiyaMemoryTableStore;
    if (!store) return { text: replyText, applied: false };
    var settings = store.loadSettings();
    if (settings.enabled === false || settings.isAiWrite === false) {
      return { text: stripTableEditFromReply(replyText), applied: false };
    }
    var actions = parseTableEditBlock(replyText);
    var clean = stripTableEditFromReply(replyText);
    if (!actions.length) return { text: clean, applied: false };
    var tables = store.getChatTables(chatId);
    var result = applyActions(tables, actions, settings);
    store.setChatTables(chatId, result.tables);
    try {
      console.log('[MiyaMemoryTable] applied', result.log);
    } catch (e) {}
    return { text: clean, applied: true, log: result.log };
  }

  function injectIntoMessages(apiMessages, chatId) {
    var store = global.MiyaMemoryTableStore;
    if (!store) return apiMessages;
    var settings = store.loadSettings();
    if (settings.enabled === false || settings.isAiRead === false) return apiMessages;
    var block = buildTablesPrompt(chatId);
    if (!block) return apiMessages;
    var msg = { role: 'system', content: block };
    if (!Array.isArray(apiMessages)) return apiMessages;

    /* ── 为什么必须固定插入点（提示缓存） ──
       记忆块的内容本身每轮也在变（表格会被模型改写），这点无法避免；
       但如果**位置**也在变，那就是雪上加霜——位置一变，它后面所有内容的
       偏移全部平移，等于每轮都把历史写花一遍，缓存 100% 重建。
       实测（真机浏览器三连轮）：修复前命中率 0%。
       所以这里的所有分支，一律锚定到**同一处**：紧跟开头的 system 区
       （即第一条 user 之前）。有没有 user、历史多长，都不影响锚点。 */

    /* 计算「开头连续 system 区」的末尾位置 */
    var anchor = 0;
    while (anchor < apiMessages.length && apiMessages[anchor] &&
           apiMessages[anchor].role === 'system') {
      anchor++;
    }
    /* 兜底：万一开头不是 system（异常拼接），就退到第一条 user 之前 */
    if (anchor === 0) {
      var fu = -1;
      for (var k = 0; k < apiMessages.length; k++) {
        if (apiMessages[k] && apiMessages[k].role === 'user') { fu = k; break; }
      }
      anchor = fu >= 0 ? fu : 0;
    }
    /* before_user 语义上要求「贴着用户消息」，但锚点仍固定在 system 区末尾，
       只是当 system 区后面紧邻的就是 user 时，两者结果一致。
       这样无论对话多长，记忆块深度都恒定。 */
    apiMessages.splice(anchor, 0, msg);
    return apiMessages;
  }

  global.MiyaMemoryTableEngine = {
    buildTablesPrompt: buildTablesPrompt,
    processAssistantReply: processAssistantReply,
    stripTableEditFromReply: stripTableEditFromReply,
    parseTableEditBlock: parseTableEditBlock,
    applyActions: applyActions,
    injectIntoMessages: injectIntoMessages,
    tableToCsvBlock: tableToCsvBlock,
    parseArgs: parseArgs,
    sanitizeCell: sanitizeCell
  };
})(typeof window !== 'undefined' ? window : this);
