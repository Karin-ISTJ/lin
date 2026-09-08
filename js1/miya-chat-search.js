/**
 * Miya · 聊天内消息搜索
 */
(function (global) {
  'use strict';

  function searchInChat(chatId, query, opts) {
    var st = global.miyaChatStore;
    opts = opts || {};
    var q = String(query || '').trim().toLowerCase();
    if (!st || !chatId || !q) return [];
    var msgs = st.getMessagesForApi
      ? st.getMessagesForApi(chatId)
      : (st.getMessages ? st.getMessages(chatId) : []);
    var limit = Math.max(1, Number(opts.limit) || 50);
    var out = [];
    for (var i = 0; i < (msgs || []).length; i++) {
      var m = msgs[i];
      if (!m || m.deleted) continue;
      var text = String(m.content || m.voiceText || '').toLowerCase();
      if (text.indexOf(q) >= 0) {
        out.push({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          index: i
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  function escapeAttr(v) {
    return String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function scrollToMessage(msgId) {
    var id = escapeAttr(msgId);
    var el = document.querySelector('[data-msg-id="' + id + '"]');
    if (!el) el = document.querySelector('[data-ap-msg-id="' + id + '"]');
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-search-hit');
    setTimeout(function () { el.classList.remove('is-search-hit'); }, 1600);
    return true;
  }

  function openSearchUi(chatId) {
    var q = window.prompt('搜索本聊天消息', '');
    if (q == null) return;
    var hits = searchInChat(chatId, q);
    if (!hits.length) {
      if (global.miyaChatRoom && global.miyaChatRoom.toast) global.miyaChatRoom.toast('未找到相关消息');
      else window.alert('未找到相关消息');
      return hits;
    }
    scrollToMessage(hits[0].id);
    if (global.miyaChatRoom && global.miyaChatRoom.toast) {
      global.miyaChatRoom.toast('找到 ' + hits.length + ' 条，已定位到第一条');
    }
    return hits;
  }

  global.MiyaChatSearch = {
    searchInChat: searchInChat,
    scrollToMessage: scrollToMessage,
    openSearchUi: openSearchUi
  };
})(window);
