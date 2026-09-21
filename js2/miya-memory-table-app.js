/**
 * Miya · 记忆表格 UI（设置入口 + 全屏编辑）
 */
(function (global) {
  'use strict';

  var state = { chatId: '', tableIndex: 0 };

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg) {
    if (global.miyaChatRoom && global.miyaChatRoom.toast) global.miyaChatRoom.toast(msg);
    else try { console.log('[MemoryTable]', msg); } catch (e) {}
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function currentChatId() {
    if (state.chatId) return state.chatId;
    if (global.miyaChatRoom && global.miyaChatRoom.state && global.miyaChatRoom.state.chatId) {
      return String(global.miyaChatRoom.state.chatId);
    }
    return '';
  }

  function open(chatId) {
    state.chatId = String(chatId || currentChatId() || '');
    var store = global.MiyaMemoryTableStore;
    if (!store) {
      toast('记忆表模块未加载');
      return;
    }
    if (!state.chatId) {
      toast('请先打开一个聊天再编辑记忆表');
      return;
    }
    store.ensureChat(state.chatId).then(function () {
      var app = $('miya-memory-table-app');
      if (!app) return;
      app.classList.add('is-open');
      app.setAttribute('aria-hidden', 'false');
      render();
    });
  }

  function close() {
    var app = $('miya-memory-table-app');
    if (!app) return;
    app.classList.remove('is-open');
    app.setAttribute('aria-hidden', 'true');
  }

  function renderSettingsBar() {
    var store = global.MiyaMemoryTableStore;
    var s = store.loadSettings();
    var host = $('miya-mt-settings');
    if (!host) return;
    host.innerHTML =
      '<label class="miya-mt-check"><input type="checkbox" id="miya-mt-en" ' +
      (s.enabled ? 'checked' : '') +
      '> 启用记忆表</label>' +
      '<label class="miya-mt-check"><input type="checkbox" id="miya-mt-read" ' +
      (s.isAiRead ? 'checked' : '') +
      '> AI 读取</label>' +
      '<label class="miya-mt-check"><input type="checkbox" id="miya-mt-write" ' +
      (s.isAiWrite ? 'checked' : '') +
      '> AI 写入</label>' +
      '<label class="miya-mt-check" title="关闭后仅保留最小语法约束，每轮少约 300 tokens">' +
      '<input type="checkbox" id="miya-mt-detailed" ' +
      (s.detailedWriteRules !== false ? 'checked' : '') +
      '> 详细写入规则</label>';
    function bind(id, key) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        var cur = store.loadSettings();
        cur[key] = !!el.checked;
        store.saveSettings(cur);
        toast('已保存设置');
      });
    }
    bind('miya-mt-en', 'enabled');
    bind('miya-mt-read', 'isAiRead');
    bind('miya-mt-write', 'isAiWrite');
    bind('miya-mt-detailed', 'detailedWriteRules');
  }

  function renderTabs(tables) {
    var rail = $('miya-mt-tabs');
    if (!rail) return;
    rail.innerHTML = tables
      .map(function (t, i) {
        return (
          '<button type="button" class="miya-mt-tab' +
          (i === state.tableIndex ? ' is-active' : '') +
          (t.enabled === false ? ' is-off' : '') +
          '" data-mt-tab="' +
          i +
          '">' +
          esc(t.name) +
          '<i>' +
          (t.rows || []).length +
          '</i></button>'
        );
      })
      .join('');
  }

  function renderTable(table) {
    var wrap = $('miya-mt-table-wrap');
    if (!wrap || !table) return;
    var cols = table.columns || [];
    var rows = table.rows || [];
    var head =
      '<tr><th class="miya-mt-ri">#</th>' +
      cols
        .map(function (c, ci) {
          return '<th contenteditable="true" data-mt-col="' + ci + '">' + esc(c) + '</th>';
        })
        .join('') +
      '<th></th></tr>';
    var body = rows
      .map(function (row, ri) {
        return (
          '<tr data-mt-row="' +
          ri +
          '"><td class="miya-mt-ri">' +
          ri +
          '</td>' +
          cols
            .map(function (_, ci) {
              return (
                '<td contenteditable="true" data-mt-cell="' +
                ri +
                ',' +
                ci +
                '">' +
                esc(row[ci] || '') +
                '</td>'
              );
            })
            .join('') +
          '<td><button type="button" class="miya-mt-del" data-mt-del-row="' +
          ri +
          '">删</button></td></tr>'
        );
      })
      .join('');
    wrap.innerHTML =
      '<p class="miya-mt-note">' +
      esc(table.note || '') +
      '</p>' +
      '<div class="miya-mt-scroll"><table class="miya-mt-table"><thead>' +
      head +
      '</thead><tbody>' +
      body +
      '</tbody></table></div>';
  }

  function getTables() {
    return global.MiyaMemoryTableStore.getChatTables(state.chatId);
  }

  function persist(tables) {
    return global.MiyaMemoryTableStore.setChatTables(state.chatId, tables);
  }

  function readDomIntoTables() {
    var tables = getTables();
    var t = tables[state.tableIndex];
    if (!t) return tables;
    var wrap = $('miya-mt-table-wrap');
    if (!wrap) return tables;
    wrap.querySelectorAll('[data-mt-col]').forEach(function (th) {
      var ci = Number(th.getAttribute('data-mt-col'));
      if (Number.isFinite(ci) && t.columns[ci] != null) t.columns[ci] = th.textContent.trim() || t.columns[ci];
    });
    wrap.querySelectorAll('[data-mt-cell]').forEach(function (td) {
      var parts = String(td.getAttribute('data-mt-cell') || '').split(',');
      var ri = Number(parts[0]);
      var ci = Number(parts[1]);
      if (t.rows[ri] && Number.isFinite(ci)) t.rows[ri][ci] = td.textContent.trim();
    });
    tables[state.tableIndex] = t;
    return tables;
  }

  /**
   * 把 chatId 翻译成人能看懂的名字。
   *
   * 原来标题只显示 chatId 后 6 位（「记忆表格 · foxkak」），
   * 用户看到这个完全对不上是哪个聊天 —— 尤其在他想确认
   * 「AI 说的事件七到底存在哪」的时候，连该翻哪一页都不知道。
   *
   * 这里优先给「联系人名」（私聊）或「群名」（群聊），
   * 拿不到才退回 id 尾号，保证任何情况下都不会出现空标题。
   */
  function describeChat(chatId) {
    var cid = String(chatId || '');
    if (!cid) return '(未选择聊天)';
    var out = '';
    try {
      var st = global.miyaChatStore;
      if (st && typeof st.findChat === 'function') {
        var chat = st.findChat(cid);
        if (chat) {
          if (chat.type === 'group') {
            out = String(chat.title || '').trim();
            if (!out) out = '群聊';
          } else {
            var contact = chat.name ? null : (st.findContact ? st.findContact(chat.contactId) : null);
            out = String((contact && contact.name) || chat.title || chat.name || '').trim();
          }
        }
      }
    } catch (e) {}
    if (!out) out = '未命名';
    /* 附带 id 尾号，便于排查时对得上聊天记录 */
    return out + '（' + cid.slice(-6) + '）';
  }

  function render() {
    renderSettingsBar();
    var tables = getTables();
    if (state.tableIndex >= tables.length) state.tableIndex = 0;
    renderTabs(tables);
    renderTable(tables[state.tableIndex]);
    var title = $('miya-mt-title');
    if (title) title.textContent = '记忆表格 · ' + describeChat(state.chatId);
    renderScopeHint();
  }

  /**
   * 显示「本页只属于当前这个聊天」以及「还有哪些聊天也存着表格」。
   *
   * 存在的理由：记忆表格按 chatId 分桶，一个聊天一张表。
   * 用户遇到过「AI 说事件七，我哪里都找不到」——原因之一就是他不知道
   * 这里只显示**当前聊天**的表，别的聊天的表在别处。
   * 把这层信息摆明，就不需要靠猜。
   */
  function renderScopeHint() {
    var host = $('miya-mt-scope');
    if (!host) return;
    var store = global.MiyaMemoryTableStore;
    var others = [];
    try {
      var all = typeof store.listChatIds === 'function' ? store.listChatIds() : [];
      others = all.filter(function (id) { return String(id) !== String(state.chatId); });
    } catch (e) {}
    var rowsHtml = '';
    others.slice(0, 12).forEach(function (id) {
      var n = 0;
      try {
        var ts = store.getChatTables(id) || [];
        ts.forEach(function (t) {
          if (t && t.id === 't_event') n = (t.rows || []).length;
        });
      } catch (e2) {}
      rowsHtml +=
        '<button type="button" class="miya-mt-other" data-mt-other="' + esc(id) + '">' +
        esc(describeChat(id)) + '（事件 ' + n + ' 条）</button>';
    });
    if (!others.length) {
      host.innerHTML =
        '<p class="miya-mt-note">本表只属于「' + esc(describeChat(state.chatId)) +
        '」。目前没有其他聊天存有记忆表。</p>';
      return;
    }
    host.innerHTML =
      '<p class="miya-mt-note">本表只属于「' + esc(describeChat(state.chatId)) +
      '」——记忆表按聊天分开存，别的聊天看不到这里的行，反之亦然。</p>' +
      '<p class="miya-mt-note">其他聊天的记忆表：' + rowsHtml + '</p>';
  }

  function bind() {
    var app = $('miya-memory-table-app');
    if (!app || app.dataset.bound) return;
    app.dataset.bound = '1';
    var back = $('miya-mt-back');
    if (back) back.addEventListener('click', close);
    app.addEventListener('click', function (e) {
      /* 切到「其他聊天」的记忆表：先保存当前编辑，再换桶重新渲染 */
      var other = e.target.closest('[data-mt-other]');
      if (other) {
        var target = String(other.getAttribute('data-mt-other') || '').trim();
        if (!target) return;
        persist(readDomIntoTables()).then(function () {
          state.chatId = target;
          state.tableIndex = 0;
          render();
        });
        return;
      }
      var tab = e.target.closest('[data-mt-tab]');
      if (tab) {
        persist(readDomIntoTables()).then(function () {
          state.tableIndex = Number(tab.getAttribute('data-mt-tab')) || 0;
          render();
        });
        return;
      }
      var del = e.target.closest('[data-mt-del-row]');      if (del) {
        var tables = readDomIntoTables();
        var t = tables[state.tableIndex];
        var ri = Number(del.getAttribute('data-mt-del-row'));
        if (t && Number.isFinite(ri)) {
          t.rows.splice(ri, 1);
          persist(tables).then(render);
        }
        return;
      }
      if (e.target.closest('#miya-mt-add-row')) {
        var tables2 = readDomIntoTables();
        var t2 = tables2[state.tableIndex];
        if (t2) {
          t2.rows.push(t2.columns.map(function () { return ''; }));
          persist(tables2).then(render);
        }
        return;
      }
      if (e.target.closest('#miya-mt-save')) {
        persist(readDomIntoTables()).then(function () {
          toast('记忆表已保存');
          render();
        });
        return;
      }
      if (e.target.closest('#miya-mt-reset')) {
        if (!confirm('重置为默认空表？当前数据将清空。')) return;
        global.MiyaMemoryTableStore.resetChat(state.chatId).then(function () {
          state.tableIndex = 0;
          render();
          toast('已重置');
        });
        return;
      }
      if (e.target.closest('#miya-mt-export')) {
        var data = global.MiyaMemoryTableStore.exportChat(state.chatId);
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'miya-memory-table.json';
        a.click();
        return;
      }
      if (e.target.closest('#miya-mt-import-st')) {
        pickImportFile();
        return;
      }
    });

    /*
     * 导入：选一个 JSON 文件，解析后交给 store 做结构转换。
     *
     * 主要面向 SillyTavern「记忆增强表格」插件的导出文件
     * （sheet.content 二维数组 → 本项目的 columns + rows）。
     * 同时也吃本项目自己的导出文件（有 tables/columns 的那种），
     * 这样用户换设备搬数据不用另找入口。
     *
     * 为什么先读成文本再 JSON.parse，而不是直接用 FileReader.readAsJSON：
     * 文本方式才能在 parse 失败时把「像不像 JSON」判断清楚，
     * 给出「文件不是 JSON」还是「结构不认识」这两种不同的提示。
     */
    function pickImportFile() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var parsed;
          try {
            parsed = JSON.parse(String(reader.result || ''));
          } catch (eJson) {
            toast('文件不是合法的 JSON');
            return;
          }
          var st = global.MiyaMemoryTableStore;
          if (!st || typeof st.importFromSt !== 'function') {
            toast('记忆表模块未加载');
            return;
          }
          st.importFromSt(state.chatId, parsed, { mode: 'replace' })
            .then(function (res) {
              state.tableIndex = 0;
              render();
              toast(
                '已导入 ' + res.tables + ' 个表 · ' + res.rows + ' 行' +
                  (res.skipped ? '（跳过 ' + res.skipped + ' 个无法识别的表）' : '')
              );
            })
            .catch(function (err) {
              var code = String((err && err.message) || '');
              if (code === 'no_sheets') toast('这个文件里没找到表格数据');
              else if (code === 'no_valid_table') toast('文件里没有可识别的表格（表头为空）');
              else toast('导入失败：' + (code || '未知原因'));
            });
        };
        reader.onerror = function () { toast('文件读取失败'); };
        reader.readAsText(file, 'utf-8');
      });
      document.body.appendChild(input);
      input.click();
      /* 选完就丢掉这个临时 input，免得在 DOM 里越积越多 */
      setTimeout(function () {
        if (input.parentNode) input.parentNode.removeChild(input);
      }, 1000);
    }
  }

  // 生成钩子：生成前注入、生成后解析
  // 直接暴露同名方法，由 miya-chat-engine / miya-appointment-engine 直接调用。
  function beforeGenerate(ctx) {
    if (!ctx || !Array.isArray(ctx.messages)) return ctx;
    var chatId = ctx.chatId;
    if (global.MiyaMemoryTableEngine && global.MiyaMemoryTableEngine.injectIntoMessages) {
      global.MiyaMemoryTableEngine.injectIntoMessages(ctx.messages, chatId);
    }
    return ctx;
  }

  function afterGenerate(ctx) {
    if (!ctx || !ctx.result) return;
    var chatId = ctx.chatId;
    var eng = global.MiyaMemoryTableEngine;
    if (!eng) return;
    // online path 返回的是已落库的消息数组，离线/预约路径返回 { message, raw } 等
    var text = '';
    /*
     * sourceMsgIds 收集本轮落地消息的 id，供行溯源使用（见 processAssistantReply）。
     *
     * 在线路径 ctx.result = { messages: [...], thinking }，其中 messages 是
     * **已落库**的消息数组，每条都带 id；离线/预约路径 result 形如
     * { message, raw } 或字符串，只有能拿到 id 时才建立溯源。
     */
    var sourceMsgIds = [];
    function collectIds(list) {
      (Array.isArray(list) ? list : []).forEach(function (m) {
        if (!m || typeof m !== 'object') return;
        if (!m.id) return;
        var s = String(m.id).trim();
        if (s && sourceMsgIds.indexOf(s) < 0) sourceMsgIds.push(s);
      });
    }
    if (typeof ctx.result === 'string') {
      text = ctx.result;
    } else if (Array.isArray(ctx.result)) {
      // 在线路径：[{role, content}, ...]，取 assistant 正文拼接
      var assistantMsgs = ctx.result.filter(function (m) {
        return m && m.role === 'assistant' && !m.excludedFromContext &&
          String(m.type || 'text') === 'text' && m.content;
      });
      text = assistantMsgs
        .map(function (m) { return String(m.content); })
        .join('\n');
      /*
       * 溯源只认「确实承载了 <tableEdit> 的那条消息」。
       * 若一轮有多个气泡，不能把正文消息 id 也当作来源 ——
       * 那样删掉一条旁白就会连带回收正文写入的记忆。
       * 因此这里只收集正文里真的出现 tableEdit 的消息。
       */
      assistantMsgs.forEach(function (m) {
        if (/<tableEdit>/i.test(String(m.content || ''))) collectIds([m]);
      });
      if (!sourceMsgIds.length) collectIds(assistantMsgs);
    } else if (ctx.result.messages) {
      /* { messages: [...] } 形态（与在线路径同源，兼容直接透传 ctx.result 的调用方） */
      var msgs = (ctx.result.messages || []).filter(function (m) {
        return m && m.role === 'assistant' && String(m.content || '').trim();
      });
      text = msgs
        .map(function (m) { return String(m.content); })
        .join('\n');
      msgs.forEach(function (m) {
        if (/<tableEdit>/i.test(String(m.content || ''))) collectIds([m]);
      });
      if (!sourceMsgIds.length) collectIds(msgs);
    } else if (ctx.result.reply) {
      text = ctx.result.reply;
      if (ctx.result.message) collectIds([ctx.result.message]);
    } else if (ctx.result.message && ctx.result.message.content) {
      /*
       * 线下（预约）路径：引擎回传 result = { message, lines, raw }。
       * message 是**已落库**的 assistant 消息，带 id —— 正是线下楼层的来源标识。
       *
       * 注意这里的 id 是**线下会话消息 id**（appointment store 里的 id），
       * 不是线上聊天室的消息 id。两者互不冲突：线下的删除入口
       * （MiyaAppointmentStore.deleteMessage）拿到的也正是这个 id，
       * 因此删除时按同一口径回溯即可命中。
       */
      text = ctx.result.message.content;
      collectIds([ctx.result.message]);
    } else if (ctx.result.raw) {
      text = ctx.result.raw;
    }
    if (!text) return;
    var res = eng.processAssistantReply(chatId, text, { sourceMsgIds: sourceMsgIds });
    /*
     * 把「写入未生效」摆到用户眼前。
     *
     * 为什么需要：模型写了 tableEdit，但格式坏了 / 表序号越界时，旧实现
     * 只往 console 打一行就完事。用户看到的是模型「说了要记」、表格却
     * 没变，只能反复重试。给一句提示，至少知道是记忆写入失败而非剧情问题。
     */
    if (res && res.notice) toast(res.notice);
  }

  global.MiyaMemoryTableApp = {
    open: open,
    close: close,
    render: render,
    beforeGenerate: beforeGenerate,
    afterGenerate: afterGenerate
  };

  function boot() {
    bind();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
