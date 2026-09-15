/* ============================================================
   Karin「点聊天图标 → 自动跳进第一个角色」诊断脚本
   ------------------------------------------------------------
   用法：在出问题的页面（Via）上
     1) 先做一次「点聊天图标」的动作（复现问题）
     2) 打开开发者工具 / 或用地址栏输入 javascript: 前缀
     3) 整段粘贴本文件内容，回车
     4) 把控制台输出整段发我
   ------------------------------------------------------------
   注意：Via 对开发者工具支持有限。若无法打开控制台，
   请用「把输出渲染到页面上」的版本（见文件末尾说明）。
   ============================================================ */
(function () {
  var R = {};

  R['1_地址'] = location.href;
  R['1_hash'] = location.hash || '(空)';
  R['1_是否PWA独立窗口'] = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ? '是' : '否';

  var app = document.getElementById('miya-chat-app');
  var room = document.getElementById('qq-room');
  R['2_聊天App_is_open'] = !!(app && app.classList.contains('is-open'));
  R['2_聊天App_qq_room_open'] = !!(app && app.classList.contains('qq-room-open'));
  R['2_房间节点存在'] = !!room;
  R['2_房间hidden'] = room ? room.hidden : '(无节点)';
  R['2_当前chatId'] = (window.miyaChatRoom && window.miyaChatRoom.getOpenChatId)
    ? (window.miyaChatRoom.getOpenChatId() || '(空)') : '(无miyaChatRoom)';

  // 列表第一条会话（判断是否"第一个"）
  try {
    var firstRow = document.querySelector('#qq-chat-list [data-chat-id]');
    R['3_列表第一条chatId'] = firstRow ? firstRow.getAttribute('data-chat-id') : '(列表未渲染)';
    var rows = document.querySelectorAll('#qq-chat-list [data-chat-id]');
    R['3_列表条数'] = rows.length;
  } catch (e) { R['3_列表读取'] = '失败:' + e.message; }

  // 数据规模
  try {
    var meta = JSON.parse(localStorage.getItem('miya-chat-meta') || '{}');
    R['4_会话数'] = (meta.chats || []).length;
    R['4_联系人数'] = (meta.contacts || []).length;
    R['4_会话顺序前3'] = (meta.chats || []).slice(0, 3).map(function (c) {
      return { id: c.id, title: c.title, lastAt: c.lastAt };
    });
  } catch (e) { R['4_meta'] = '失败:' + e.message; }

  // 关键：已消费的深链标记（我最新一版加的）
  R['5_深链已消费标记'] = localStorage.getItem('miya-notify-deeplink-consumed-v1') || '(无)';

  // 版本号（判断到底加载了哪版）
  R['6_脚本版本'] = (function () {
    var o = {};
    ['miya-chat-room', 'miya-chat-app', 'miya-chat-notify', 'app.js'].forEach(function (k) {
      var n = document.querySelector('script[src*="' + k + '"]');
      o[k] = n ? n.getAttribute('src').split('/').pop() : '(未找到)';
    });
    return o;
  })();

  // store 里第一个会话（和列表第一条对比）
  try {
    var st = window.miyaChatStore;
    if (st && st.getChats) {
      var cs = st.getChats() || [];
      R['7_store会话数'] = cs.length;
      R['7_store第一条'] = cs.length ? { id: cs[0].id, title: cs[0].title } : '(空)';
    }
  } catch (e) { R['7_store'] = '失败:' + e.message; }

  var out = [];
  out.push('====== Karin 诊断结果（请整段复制发我）======');
  try {
    out.push(JSON.stringify(R, null, 2));
  } catch (e) {
    for (var k in R) out.push(k + ' = ' + String(R[k]));
  }
  out.push('====== 结果结束 ======');
  var text = out.join('\n');

  if (typeof console !== 'undefined' && console.log) console.log(text);

  // 同时渲染到页面顶部，方便在无法开控制台的浏览器里截图
  try {
    var box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
      'background:#fff;color:#000;font:12px/1.5 monospace;padding:10px;overflow:auto;white-space:pre-wrap;';
    box.textContent = text + '\n\n（截图这一屏发我即可）';
    box.addEventListener('click', function () { box.remove(); });
    document.body.appendChild(box);
  } catch (e) {}

  return text;
})();
