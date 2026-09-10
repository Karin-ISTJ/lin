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
      '> AI 写入</label>';
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

  function render() {
    renderSettingsBar();
    var tables = getTables();
    if (state.tableIndex >= tables.length) state.tableIndex = 0;
    renderTabs(tables);
    renderTable(tables[state.tableIndex]);
    var title = $('miya-mt-title');
    if (title) title.textContent = '记忆表格 · ' + (state.chatId || '').slice(-6);
  }

  function bind() {
    var app = $('miya-memory-table-app');
    if (!app || app.dataset.bound) return;
    app.dataset.bound = '1';
    var back = $('miya-mt-back');
    if (back) back.addEventListener('click', close);
    app.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-mt-tab]');
      if (tab) {
        persist(readDomIntoTables()).then(function () {
          state.tableIndex = Number(tab.getAttribute('data-mt-tab')) || 0;
          render();
        });
        return;
      }
      var del = e.target.closest('[data-mt-del-row]');
      if (del) {
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
    });
  }

  // 生成钩子：生成前注入、生成后解析
  // 原先通过 MiyaPlugins.register 注册，现直接暴露同名方法，
  // 由 miya-chat-engine / miya-appointment-engine 直接调用（插件宿主已移除）。
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
    if (typeof ctx.result === 'string') {
      text = ctx.result;
    } else if (Array.isArray(ctx.result)) {
      // 在线路径：[{role, content}, ...]，取 assistant 正文拼接
      text = ctx.result
        .filter(function (m) {
          return m && m.role === 'assistant' && !m.excludedFromContext &&
            String(m.type || 'text') === 'text' && m.content;
        })
        .map(function (m) { return String(m.content); })
        .join('\n');
    } else if (ctx.result.reply) {
      text = ctx.result.reply;
    } else if (ctx.result.message && ctx.result.message.content) {
      text = ctx.result.message.content;
    } else if (ctx.result.raw) {
      text = ctx.result.raw;
    }
    if (!text) return;
    eng.processAssistantReply(chatId, text);
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
