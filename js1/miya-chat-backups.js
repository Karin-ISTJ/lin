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

  /*
   * 导出全部会话。
   *
   * 修正说明：原实现依赖 st.listChats()，但 store 的公开 API 名为 getChats()，
   * listChats 从未存在，于是该函数恒返回 false（静默失败）。
   * 这里改为优先 getChats，并保留 listChats 作为兼容回退。
   */
  function exportAllChats() {
    var st = store();
    if (!st) return false;
    var chats = [];
    if (typeof st.getChats === 'function') chats = st.getChats() || [];
    else if (typeof st.listChats === 'function') chats = st.listChats() || [];
    else return false;
    var packs = chats.map(function (c) { return exportChat(c && c.id); }).filter(Boolean);
    downloadJson('miya-chats-all-' + new Date().toISOString().slice(0, 10) + '.json', {
      version: 1,
      kind: 'miya-chat-backup-bundle',
      exportedAt: Date.now(),
      chats: packs
    });
    return true;
  }

  /* 把备份包中的消息回写到指定会话。
   *
   * 关键：必须走 store.importChatMessages —— 它会整体替换 messagesByChat 并
   * 保留消息原始 id / createdAt。绝不能退化成逐条 addMessage：
   * addMessage -> addMessagesImmediate 会强制 Object.assign({}, msg, { id: uid('msg') })
   * 覆盖消息 ID 并重写 createdAt，导致备份包里的 quoteRef、activeThinkingMsgId、
   * heartVoiceLog 等引用全部失配，等于把备份导入成一份「形似而神不似」的假数据。 */
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

    /* 目标会话必须已存在，否则 importChatMessages 会往一个不存在的 chat 上挂消息，
     * 刷新预览时拿不到 chat 行，最终变成孤儿消息。 */
    var chat = typeof st.findChat === 'function' ? st.findChat(chatId) : null;
    if (chat) {
      return st.importChatMessages(chatId, messages);
    }

    /* 会话不存在：按备份包里的 chat 元信息重建，再灌入消息。
     * 仅重建一个最小可用的私聊会话（依赖 chat.contactId 指向的联系人）。 */
    if (!opts.recreate || typeof st.createChat !== 'function') {
      return Promise.reject(new Error('chat_not_found'));
    }
    var src = pack.chat || {};
    if (!src.contactId && !Array.isArray(chatInquiryMembers(src))) {
      return Promise.reject(new Error('chat_not_found'));
    }
    if (!src.contactId) {
      /* 群聊重建依赖成员联系人已存在，这里不代劳，明确报错而非静默产出坏数据 */
      return Promise.reject(new Error('recreate_group_unsupported'));
    }
    return st
      .createChat({ contactId: src.contactId, title: src.title, groupId: src.groupId })
      .then(function (created) {
        var newId = created && created.id ? created.id : chatId;
        return st.importChatMessages(newId, messages).then(function () {
          return newId;
        });
      });
  }

  function chatInquiryMembers(src) {
    return src && Array.isArray(src.memberIds) ? src.memberIds : [];
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

  /* 备份面板：导出当前会话 / 导入备份文件。
   * 原实现只有 pickAndImport 而没有任何 UI 入口，导入功能等于不存在；
   * 这里补一个轻量弹层，导出与导入成对出现。 */
  function openPanel(chatId) {
    var cid = String(chatId || '').trim();
    if (!cid) return;
    var old = document.getElementById('miya-backup-mask');
    if (old) old.remove();

    var mask = document.createElement('div');
    mask.id = 'miya-backup-mask';
    mask.setAttribute('style',
      'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;');

    var box = document.createElement('div');
    box.setAttribute('style',
      'width:100%;max-width:340px;background:var(--bg-1,#fff);color:var(--text-1,#111);' +
      'border-radius:14px;padding:18px 16px 10px;box-shadow:0 12px 40px rgba(0,0,0,.28);');

    var title = document.createElement('div');
    title.textContent = '聊天备份';
    title.setAttribute('style', 'font-size:16px;font-weight:600;margin-bottom:12px;');

    var mkBtn = function (text, hint, fn) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('style',
        'display:block;width:100%;text-align:left;padding:12px 12px;margin-bottom:8px;' +
        'border:1px solid rgba(128,128,128,.25);border-radius:10px;background:transparent;' +
        'color:inherit;font-size:14px;cursor:pointer;');
      var t = document.createElement('div');
      t.textContent = text;
      var h = document.createElement('div');
      h.textContent = hint;
      h.setAttribute('style', 'font-size:12px;opacity:.6;margin-top:3px;');
      btn.appendChild(t);
      btn.appendChild(h);
      btn.addEventListener('click', function () { fn(btn); });
      return btn;
    };

    var close = function () { mask.remove(); };

    var exportBtn = mkBtn('导出当前会话', '保存为 JSON 备份文件', function () {
      close();
      if (exportChatToFile(cid)) notify('已导出聊天备份');
      else notify('备份失败');
    });

    var importBtn = mkBtn('导入备份文件', '用备份内容覆盖当前会话消息', function () {
      pickAndImport()
        .then(function (res) {
          var n = typeof res === 'number' ? res : (res && res.count) || 0;
          close();
          notify(n ? '已导入 ' + n + ' 条消息' : '导入完成');
          if (global.miyaChatRoom && global.miyaChatRoom.refresh) global.miyaChatRoom.refresh();
        })
        .catch(function (err) {
          var msg = err && err.message;
          if (msg === 'no_file') return;
          close();
          notify(
            msg === 'chat_not_found'
              ? '导入失败：目标会话不存在'
              : msg === 'invalid_pack'
                ? '导入失败：文件格式不对'
                : '导入失败：' + (msg || String(err))
          );
        });
    });

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.setAttribute('style',
      'display:block;width:100%;padding:10px;margin-top:2px;border:0;border-radius:10px;' +
      'background:transparent;color:inherit;opacity:.65;font-size:14px;cursor:pointer;');
    cancel.addEventListener('click', close);

    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });

    box.appendChild(title);
    box.appendChild(exportBtn);
    box.appendChild(importBtn);
    box.appendChild(cancel);
    mask.appendChild(box);
    document.body.appendChild(mask);
  }

  function notify(msg) {
    if (global.miyaToast && typeof global.miyaToast === 'function') return global.miyaToast(msg);
    if (global.miyaChatRoom && typeof global.miyaChatRoom.toast === 'function') {
      return global.miyaChatRoom.toast(msg);
    }
    console.log('[miya-backup] ' + msg);
  }

  global.MiyaChatBackups = {
    exportChat: exportChat,
    exportChatToFile: exportChatToFile,
    exportAllChats: exportAllChats,
    importChatPack: importChatPack,
    pickAndImport: pickAndImport,
    openPanel: openPanel
  };
})(window);
