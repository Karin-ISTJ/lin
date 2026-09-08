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

  function tableToCsvBlock(table, index, maxRows) {
    if (!table || table.enabled === false) return '';
    var cols = table.columns || [];
    var rows = table.rows || [];
    if (maxRows > 0 && rows.length > maxRows) {
      rows = rows.slice(-maxRows);
    }
    var lines = [];
    lines.push('* ' + index + ':' + (table.name || '表'));
    if (table.note) lines.push('【说明】' + table.note);
    lines.push('【表格内容】');
    lines.push('rowIndex,' + cols.map(function (c, i) { return i + ':' + c; }).join(','));
    rows.forEach(function (row, ri) {
      var cells = cols.map(function (_, ci) {
        var v = row[ci] != null ? String(row[ci]) : '';
        return v.replace(/,/g, '/').replace(/"/g, "'");
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

  function parseArgs(raw) {
    // insertRow(0, {0:"a",1:"b"}) | updateRow(0,1,{2:"x"}) | deleteRow(0,1)
    var src = String(raw || '').trim();
    try {
      // normalize JS-object-like to JSON
      var normalized = '[' + src
        .replace(/(\d+)\s*:/g, '"$1":')
        .replace(/'/g, '"') + ']';
      // fix already quoted keys double
      normalized = normalized.replace(/""+/g, '"');
      var arr = JSON.parse(normalized);
      return arr;
    } catch (e) {
      // fallback split by first commas carefully
      try {
        var fn = new Function('return [' + src + ']');
        return fn();
      } catch (e2) {
        return null;
      }
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
          return v != null ? String(v) : '';
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
              table.rows[riu][ci] = String(v);
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
    if (settings.injectPosition === 'before_user') {
      // 插在最后一条 user 之前
      var i = apiMessages.length - 1;
      while (i >= 0 && apiMessages[i].role !== 'user') i--;
      if (i >= 0) {
        apiMessages.splice(i, 0, msg);
      } else {
        apiMessages.push(msg);
      }
    } else {
      // 靠前 system：插在靠后的 system 区，尽量靠近历史
      var insertAt = 0;
      for (var j = 0; j < apiMessages.length; j++) {
        if (apiMessages[j].role === 'system') insertAt = j + 1;
        else break;
      }
      // 更稳：放在 messages 中部偏后——在第一条 user 前
      var firstUser = apiMessages.findIndex(function (m) { return m.role === 'user'; });
      if (firstUser >= 0) apiMessages.splice(firstUser, 0, msg);
      else apiMessages.push(msg);
    }
    return apiMessages;
  }

  global.MiyaMemoryTableEngine = {
    buildTablesPrompt: buildTablesPrompt,
    processAssistantReply: processAssistantReply,
    stripTableEditFromReply: stripTableEditFromReply,
    parseTableEditBlock: parseTableEditBlock,
    applyActions: applyActions,
    injectIntoMessages: injectIntoMessages,
    tableToCsvBlock: tableToCsvBlock
  };
})(typeof window !== 'undefined' ? window : this);
