/**
 * Miya · 聊天备份 / 恢复
 * 参考 TauriTavern chat-backups 思路，适配本包 localStorage 聊天数据。
 */
(function (global) {
  'use strict';

  function store() { return global.miyaChatStore || null; }

  function downloadJson(filename, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  function exportChat(chatId) {
    var st = store();
    if (!st || !chatId) return null;
    var chat = st.findChat ? st.findChat(chatId) : null;
    var messages = st.getMessagesForApi
      ? st.getMessagesForApi(chatId)
      : (st.getMessages ? st.getMessages(chatId) : []);
    var settings = st.getChatSettings ? st.getChatSettings(chatId) : null;
    return {
      version: 1,
      kind: 'miya-chat-backup',
      exportedAt: Date.now(),
      chat: chat || { id: chatId },
      settings: settings || null,
      messages: messages || []
    };
  }

  function exportChatToFile(chatId) {
    var pack = exportChat(chatId);
    if (!pack) return false;
    var name = 'miya-chat-' + String(chatId).slice(0, 12) + '-' + new Date().toISOString().slice(0, 10) + '.json';
    downloadJson(name, pack);
    return true;
  }

  function exportAllChats() {
    var st = store();
    if (!st || !st.listChats) return false;
    var chats = st.listChats() || [];
    var packs = chats.map(function (c) { return exportChat(c.id); }).filter(Boolean);
    downloadJson('miya-chats-all-' + new Date().toISOString().slice(0, 10) + '.json', {
      version: 1,
      kind: 'miya-chat-backup-bundle',
      exportedAt: Date.now(),
      chats: packs
    });
    return true;
  }

  function importChatPack(pack, opts) {
    var st = store();
    if (!st || !pack || typeof pack !== 'object') return Promise.reject(new Error('invalid_pack'));
    opts = opts || {};
    if (pack.kind === 'miya-chat-backup-bundle' && Array.isArray(pack.chats)) {
      var seq = Promise.resolve();
      pack.chats.forEach(function (one) {
        seq = seq.then(function () { return importChatPack(one, opts); });
      });
      return seq;
    }
    var chatId = pack.chat && pack.chat.id ? String(pack.chat.id) : '';
    if (!chatId) return Promise.reject(new Error('missing_chat_id'));
    var messages = Array.isArray(pack.messages) ? pack.messages : [];
    if (typeof st.replaceChatMessages === 'function') {
      return st.replaceChatMessages(chatId, messages);
    }
    if (typeof st.importMessages === 'function') {
      return st.importMessages(chatId, messages);
    }
    /* 兜底：逐条 add（可能重复，仅在没有专用 API 时） */
    var p = Promise.resolve();
    messages.forEach(function (m) {
      p = p.then(function () {
        if (st.addMessage) return st.addMessage(chatId, m);
      });
    });
    return p;
  }

  function pickAndImport() {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) return reject(new Error('no_file'));
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var pack = JSON.parse(String(reader.result || ''));
            importChatPack(pack).then(resolve).catch(reject);
          } catch (e) {
            reject(e);
          }
        };
        reader.onerror = function () { reject(new Error('read_failed')); };
        reader.readAsText(file);
      };
      input.click();
    });
  }

  global.MiyaChatBackups = {
    exportChat: exportChat,
    exportChatToFile: exportChatToFile,
    exportAllChats: exportAllChats,
    importChatPack: importChatPack,
    pickAndImport: pickAndImport
  };
})(window);
