/**
 * miya-memory-app.js — 各角色对话记忆总结 · 记忆阅览室（v12「暗色放映厅」）
 *
 * 界面结构移植自 preview-v12t.html：
 *   票根带（胶片孔 + 撕票线 + 票号）→ 取票；银幕面板 → 放映详情。
 * 与 preview 稿的两处刻意差异：
 *   1. 不渲染稿中的手机系统状态栏（时间/信号/Wi-Fi/电量）与底部手势条，
 *      那些属于真实设备，App 内不得伪造；
 *   2. 「在映票根」计数器（reel-counter）不再像 preview 稿那样把 01/02/03
 *      和总数写死在 HTML 里 —— 那是它计数显示错误的根源。这里按真实
 *      票根数动态生成每一位数字与总数，滚动时由 JS 同步点亮当前位。
 * 分镜/合卷（MiyaChatSummary）与角色记忆提炼（MiyaChatMemoryExtract）功能不变。
 */
(function (global) {
  'use strict';

  var selectedChatId = null;
  /** @type {{ type: 'sum'|'mega'|'cmem', id: string }|null} */
  var editingClip = null;
  /** 生成（放映）中标志：防止重复触发分镜/合卷 */
  var generating = false;

  var ICO_PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6.5v11l9-5.5z"/></svg>';
  var ICO_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7.5" y="7.5" width="9" height="9" rx="1.8"/></svg>';
  var FILM_HOLES = '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>';

  function $(id) { return document.getElementById(id); }

  function esc(t) {
    return String(t || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 按总票数的位数补零（3 张 → 01…03；100+ 张 → 001…，位数随总数自适应，至少 2 位） */
  function digitsFor(total) {
    return Math.max(2, String(Math.max(0, total || 0)).length);
  }
  function padNum(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function toast(msg) {
    var el = $('miya-mem-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('is-show'); }, 2400);
  }

  function ensureStore() {
    if (global.miyaChatContactsSync && global.miyaChatContactsSync.ensureBootstrap) {
      return global.miyaChatContactsSync.ensureBootstrap();
    }
    var chain = Promise.resolve();
    if (global.miyaContactsStore && global.miyaContactsStore.whenReady) {
      chain = chain.then(function () { return global.miyaContactsStore.whenReady(); });
    }
    if (global.miyaChatStore && global.miyaChatStore.init) {
      chain = chain.then(function () { return global.miyaChatStore.init(); });
    }
    if (global.miyaChatContactsSync && global.miyaChatContactsSync.syncAll) {
      chain = chain.then(function () {
        return global.miyaChatContactsSync.syncAll({ prune: false });
      });
    }
    return chain;
  }

  /* ---------- 角色票根数据 ---------- */

  /**
   * 收集所有私聊角色 → 票根数据。
   * memo  = memoryAutoRoundTrigger（每 N 轮自动提炼，0=未开启，票面上暗淡显示）
   * shots = 分镜数 / rolls = 合卷数 / momentos = 忆（角色记忆）数
   */
  function collectRoles() {
    var st = global.miyaChatStore;
    if (!st || !st.getChats) return [];
    return st.getChats('all').slice().filter(function (chat) {
      return chat && chat.type !== 'group';
    }).sort(function (a, b) {
      return (b.lastAt || 0) - (a.lastAt || 0);
    }).map(function (chat) {
      var contact = st.findContact(chat.contactId);
      var name = (contact && (contact.remarkName || contact.name)) || '未命名';
      var settings = st.getChatSettings(chat.id);
      return {
        id: chat.id,
        name: name,
        memo: settings.memoryAutoRoundTrigger != null ? settings.memoryAutoRoundTrigger : 0,
        shots: (settings.summaryList || []).length,
        rolls: (settings.megaSummaryList || []).length,
        momentos: (settings.charMemoryList || []).length
      };
    });
  }

  /* ---------- 票根带渲染 ---------- */

  function ticketHtml(d, idx, digits) {
    var active = selectedChatId === d.id;
    return (
      '<button type="button" class="mm-ticket' +
      (active ? ' selected' : '') +
      (d.memo > 0 ? ' has-memo' : '') +
      '" data-mem-chat="' + esc(d.id) +
      '" aria-pressed="' + active + '"' +
      ' aria-label="' + esc(d.name) + '的票根：记忆 ' + d.memo + ' 轮，分镜 ' + d.shots +
      '，合卷 ' + d.rolls + '，忆 ' + d.momentos + '">' +
      '<span class="mm-grain" aria-hidden="true"></span>' +
      '<span class="mm-film-holes" aria-hidden="true">' + FILM_HOLES + '</span>' +
      '<span class="mm-ticket-stub" aria-hidden="true"><span class="mm-stub-text">入场券</span></span>' +
      '<span class="mm-ticket-main">' +
        '<span class="mm-ticket-no">TICKET No.' + padNum(idx + 1, digits) + '</span>' +
        '<span class="mm-ticket-name">' + esc(d.name) + '</span>' +
        '<span class="mm-ticket-memo">' +
          '<span class="mm-memo-label">记忆</span>' +
          '<b class="mm-memo-num">' + d.memo + '</b>' +
          '<span class="mm-memo-unit">轮</span>' +
        '</span>' +
        '<span class="mm-ticket-tags">' +
          '<span>分镜 <b class="' + (d.shots > 0 ? 'on' : '') + '">' + d.shots + '</b></span>' +
          '<span>合卷 <b class="' + (d.rolls > 0 ? 'on' : '') + '">' + d.rolls + '</b></span>' +
          '<span>忆 <b class="' + (d.momentos > 0 ? 'on' : '') + '">' + d.momentos + '</b></span>' +
        '</span>' +
      '</span>' +
      '</button>'
    );
  }

  var cntEls = [];

  /**
   * 渲染「在映票根」计数器。
   *
   * ⚠️ 这里是 preview 稿计数 bug 的修复点：原稿把 <i class="cnt">01/02/03</i>
   * 和总数「/ 03」全部硬编码在 HTML 里，票根数不是 3 时计数必然错位。
   * 现在每一位数字和总数都按真实票根数生成，宽度按总位数设定。
   */
  function renderCounter(total) {
    var counter = $('miya-mem-counter');
    if (!counter) return;
    if (!total) {
      counter.innerHTML = '';
      cntEls = [];
      return;
    }
    var digits = digitsFor(total);
    var stack = '';
    for (var i = 0; i < total; i++) {
      stack += '<i class="mm-cnt" style="opacity:' + (i === syncState.lastI ? 1 : 0) + '">' +
        padNum(i + 1, digits) + '</i>';
    }
    counter.innerHTML =
      '<span class="mm-cnt-stack" style="width:' + digits + 'ch">' + stack + '</span> / ' +
      padNum(total, digits);
    cntEls = [];
    var nodes = counter.querySelectorAll('.mm-cnt');
    for (var k = 0; k < nodes.length; k++) cntEls.push(nodes[k]);
    /* 若当前索引超出新总数（角色被删），修正一次 */
    if (syncState.lastI > total - 1) {
      syncState.lastI = total - 1;
      applyCntOpacity(syncState.lastI);
    }
  }

  function applyCntOpacity(i) {
    for (var k = 0; k < cntEls.length; k++) {
      cntEls[k].style.opacity = (k === i ? 1 : 0);
    }
  }

  function renderDots(total) {
    var dotsWrap = $('miya-mem-dots');
    if (!dotsWrap) return;
    var html =
      '<span class="mm-dots-track" aria-hidden="true"></span>' +
      '<span class="mm-dots-fill" id="miya-mem-dots-fill" aria-hidden="true"></span>';
    for (var i = 0; i < total; i++) {
      html +=
        '<button type="button" class="mm-dot-btn" data-mm-dot="' + i + '"' +
        ' aria-label="第' + (i + 1) + '张票根" style="left:' +
        (((i + 0.5) / total) * 100).toFixed(2) + '%"><i></i></button>';
    }
    dotsWrap.innerHTML = html;
  }

  function renderRoleList() {
    var list = $('miya-mem-roles');
    if (!list) return;
    var roles = collectRoles();
    var st = global.miyaChatStore;
    if (!st) {
      list.innerHTML = '<p class="mm-strip-hint">载入中…</p>';
      renderCounter(0);
      renderDots(0);
      return;
    }
    /* 当前选中的聊天若已不在列表（被删/群聊过滤），退回空态 */
    if (selectedChatId && !roles.some(function (r) { return r.id === selectedChatId; })) {
      selectedChatId = null;
      editingClip = null;
      renderSummaryDetail(null);
    }
    if (!roles.length) {
      list.innerHTML = '<p class="mm-strip-hint">暂无会话<br>先在聊天中添加联系人</p>';
      syncState.lastI = -1;
      syncState.lastP = -1;
      syncState.lastEnd = null;
      renderCounter(0);
      renderDots(0);
      return;
    }
    var digits = digitsFor(roles.length);
    var html = '';
    for (var i = 0; i < roles.length; i++) html += ticketHtml(roles[i], i, digits);
    list.innerHTML = html;
    syncState.baseLeft = null;
    renderCounter(roles.length);
    renderDots(roles.length);
    requestAnimationFrame(syncFromRects);
  }

  /* ---------- 滚动进度同步：计数器 / 进度条 / 右侧渐隐 ---------- */

  var syncState = { baseLeft: null, lastP: -1, lastI: -1, lastEnd: null };
  var pollTimer = 0;

  function stripStep() {
    var list = $('miya-mem-roles');
    if (!list) return 1;
    var first = list.querySelector('.mm-ticket');
    return first ? first.offsetWidth + 14 : 1;
  }

  function applyProgress(p, i) {
    var fill = $('miya-mem-dots-fill');
    var fade = $('miya-mem-strip-fade');
    if (fill && Math.abs(p - syncState.lastP) > 0.0015) {
      syncState.lastP = p;
      fill.style.width = (8 + p * 92) + '%';
    }
    if (i !== syncState.lastI) {
      syncState.lastI = i;
      applyCntOpacity(i);
    }
    var end = p >= 0.995;
    if (fade && end !== syncState.lastEnd) {
      syncState.lastEnd = end;
      fade.classList.toggle('mm-off', end);
    }
  }

  /* 用首张票根的视觉位移反推滚动量：比直接读 scrollLeft 更抗 webview 节流 */
  function syncFromRects() {
    var list = $('miya-mem-roles');
    if (!list) return;
    var tickets = list.querySelectorAll('.mm-ticket');
    if (!tickets.length) return;
    var r0 = tickets[0].getBoundingClientRect();
    if (!r0.width) return;
    if (syncState.baseLeft === null) {
      syncState.baseLeft = r0.left + (list.scrollLeft || 0);
    }
    var shift = syncState.baseLeft - r0.left;
    var step = stripStep();
    var maxOff = Math.max(1, Math.max(list.scrollWidth - list.clientWidth, step * (tickets.length - 1)));
    var p = Math.max(0, Math.min(1, shift / maxOff));
    var i = Math.max(0, Math.min(tickets.length - 1, Math.round(shift / step)));
    applyProgress(p, i);
  }

  function goToIndex(i) {
    var list = $('miya-mem-roles');
    if (!list) return;
    var tickets = list.querySelectorAll('.mm-ticket');
    if (!tickets.length) return;
    i = Math.max(0, Math.min(tickets.length - 1, i));
    var behavior = 'smooth';
    try {
      if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) behavior = 'auto';
    } catch (e) {}
    try {
      list.scrollTo({ left: i * stripStep(), behavior: behavior });
    } catch (eScroll) {
      /* 老 webview 不支持 scrollTo options，退回直接赋值 */
      list.scrollLeft = i * stripStep();
    }
    applyProgress(i / Math.max(1, tickets.length - 1), i);
  }

  /* 打开期间 300ms 轮询兜底：个别 webview 在惯性滚动中节流 scroll 事件 */
  function startSyncPolling() {
    stopSyncPolling();
    pollTimer = setInterval(function () {
      var el = $('miya-memory-app');
      if (!el || !el.classList.contains('is-open')) {
        stopSyncPolling();
        return;
      }
      syncFromRects();
    }, 300);
  }

  function stopSyncPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  /* ---------- 详情（银幕）渲染 ---------- */

  function emptyInline(text) {
    return '<p class="mm-empty">' + esc(text) + '</p>';
  }

  function escTextarea(t) {
    return String(t || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function clipHeadActions(editAttr, delAttr, id, extraTag) {
    return (extraTag || '') +
      '<span class="mm-clip__acts">' +
        '<button type="button" class="mm-clip__edit" ' + editAttr + '="' + esc(id) + '">编辑</button>' +
        '<button type="button" class="mm-clip__del" ' + delAttr + '="' + esc(id) + '">删除</button>' +
      '</span>';
  }

  function renderClipContent(row, type, id) {
    if (editingClip && editingClip.type === type && editingClip.id === id) {
      return '<div class="mm-clip__edit-wrap">' +
        '<textarea class="mm-clip__textarea" id="miya-mem-edit-area" rows="8">' +
          escTextarea(row.content || '') +
        '</textarea>' +
        '<div class="mm-clip__edit-actions">' +
          '<button type="button" class="mm-btn mm-btn--fill" data-save-edit="' + esc(type) + '" data-edit-id="' + esc(id) + '">保存</button>' +
          '<button type="button" class="mm-btn" data-cancel-edit>取消</button>' +
        '</div>' +
      '</div>';
    }
    return '<div class="mm-clip__body">' + esc(row.content || '').replace(/\n/g, '<br>') + '</div>';
  }

  function buildTimelineCards(items, opts) {
    if (!items.length) {
      return emptyInline(opts.emptyLabel);
    }
    var html = '<div class="mm-timeline">';
    items.forEach(function (block, i) {
      if (i > 0) {
        html += '<span class="mm-clip__connector" aria-hidden="true"></span>';
      }
      html += block;
    });
    html += '</div>';
    return html;
  }

  function chapterHtml(no, title, sub, blocksHtml) {
    return '<section class="mm-chapter">' +
      '<div class="mm-chapter__head">' +
        '<span class="mm-chapter__no">' + no + '</span>' +
        '<h3 class="mm-chapter__title">' + title + '</h3>' +
        '<span class="mm-chapter__sub">' + sub + '</span>' +
      '</div>' +
      blocksHtml +
    '</section>';
  }

  /* 四项数据格：0 值暗淡，>0 琥珀点亮 */
  function cellHtml(key, label, value, unit) {
    var on = value > 0;
    return '<div class="mm-cell' + (on ? ' on' : '') + '">' +
      '<span class="mm-cell-key">' + key + '</span>' +
      '<span class="mm-cell-num">' + value +
      (unit ? '<i class="mm-unit">' + unit + '</i>' : '') + '</span>' +
      '<span class="mm-cell-label">' + label + '</span></div>';
  }

  function setPlaying(on, labelText) {
    var screenEl = $('miya-mem-screen');
    var btn = $('miya-mem-run-sum');
    var labelEl = btn ? btn.querySelector('.mm-play-label') : null;
    var icoEl = btn ? btn.querySelector('.mm-btn-ico') : null;
    var eyebrow = document.querySelector('#miya-mem-detail .mm-eyebrow');
    if (screenEl) screenEl.classList.toggle('lit', on);
    if (btn) {
      btn.classList.toggle('playing', on);
      btn.setAttribute('aria-pressed', String(on));
      if (labelEl) labelEl.textContent = on ? (labelText || '正在放映…') : '开始放映';
      if (icoEl) icoEl.innerHTML = on ? ICO_STOP : ICO_PLAY;
    }
    if (eyebrow) {
      eyebrow.textContent = on ? '正在放映' : '放映详情';
      eyebrow.classList.toggle('live', on);
    }
    /* 生成中锁住全部会改动数据的按钮 */
    ['miya-mem-run-sum', 'miya-mem-run-mega', 'miya-mem-save-auto'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !!on;
    });
  }

  function renderSummaryDetail(chatId) {
    var panel = $('miya-mem-detail');
    var empty = $('miya-mem-empty');
    var screenEl = $('miya-mem-screen');
    if (!panel) return;

    if (!chatId || !global.miyaChatStore) {
      /* 空态：放映机待机 */
      if (empty) empty.hidden = false;
      panel.hidden = true;
      panel.innerHTML = '';
      if (screenEl) screenEl.classList.remove('lit');
      return;
    }

    var st = global.miyaChatStore;
    var chat = st.findChat(chatId);
    if (!chat) {
      renderSummaryDetail(null);
      return;
    }
    var contact = st.findContact(chat.contactId);
    var name = (contact && (contact.remarkName || contact.name)) || '未命名';
    var settings = st.getChatSettings(chatId);
    var historyLen = st.getMessages(chatId).length;
    var sumList = settings.summaryList || [];
    var megaList = settings.megaSummaryList || [];
    var charMemList = settings.charMemoryList || [];

    /* 票号：按「在映票根」同一排序取当前角色的序号 */
    var roles = collectRoles();
    var idx = 0;
    for (var r = 0; r < roles.length; r++) {
      if (roles[r].id === chatId) { idx = r; break; }
    }
    var digits = roles.length ? digitsFor(roles.length) : 2;

    var sumMod = global.MiyaChatSummary;
    var covered = sumMod && sumMod.summaryIdsCoveredByMega
      ? sumMod.summaryIdsCoveredByMega(megaList) : {};

    var memMod = global.MiyaChatMemoryExtract;
    var memTrigger = settings.memoryAutoRoundTrigger != null ? settings.memoryAutoRoundTrigger : 0;
    var lastMemEnd = memMod && memMod.lastCharMemoryEnd ? memMod.lastCharMemoryEnd(settings) : 0;
    var pendingRounds = memMod && memMod.countAssistantRounds
      ? memMod.countAssistantRounds(st.getMessages(chatId), lastMemEnd) : 0;

    var sumBlocks = sumList.map(function (row, i) {
      var coveredTag = covered[row.id]
        ? '<em class="mm-tag">已并入合卷</em>' : '';
      return '<article class="mm-clip" data-sum-id="' + esc(row.id) + '">' +
        '<header class="mm-clip__head">' +
          '<strong>§' + (i + 1) + ' · 第 ' + row.startIndex + '–' + row.endIndex + ' 条</strong>' +
          coveredTag +
          clipHeadActions('data-edit-sum', 'data-del-sum', row.id) +
        '</header>' +
        renderClipContent(row, 'sum', row.id) +
      '</article>';
    });

    var megaBlocks = megaList.map(function (row, i) {
      return '<article class="mm-clip mm-clip--mega" data-mega-id="' + esc(row.id) + '">' +
        '<header class="mm-clip__head">' +
          '<strong>合卷 · 第 ' + (i + 1) + ' 幕</strong>' +
          clipHeadActions('data-edit-mega', 'data-del-mega', row.id) +
        '</header>' +
        renderClipContent(row, 'mega', row.id) +
      '</article>';
    });

    var charMemBlocks = charMemList.map(function (row, i) {
      return '<article class="mm-clip mm-clip--char" data-cmem-id="' + esc(row.id) + '">' +
        '<header class="mm-clip__head">' +
          '<strong>忆 · 第 ' + row.startIndex + '–' + row.endIndex + ' 条</strong>' +
          clipHeadActions('data-edit-cmem', 'data-del-cmem', row.id) +
        '</header>' +
        renderClipContent(row, 'cmem', row.id) +
      '</article>';
    });

    if (empty) empty.hidden = true;
    panel.hidden = false;

    panel.innerHTML =
      '<div class="mm-detail-head">' +
        '<span class="mm-eyebrow">放映详情</span>' +
        '<span class="mm-detail-ticket-no">TICKET No.' + padNum(idx + 1, digits) + '</span>' +
      '</div>' +
      '<h2 class="mm-detail-name">' + esc(name) + '</h2>' +
      '<div class="mm-stat-grid">' +
        cellHtml('场次', '对话消息', historyLen, '条') +
        cellHtml('镜头', '分镜', sumList.length, '') +
        cellHtml('胶卷', '合卷', megaList.length, '') +
        cellHtml('纪念', '角色记忆', charMemList.length, '') +
      '</div>' +
      '<section class="mm-console" aria-label="角色记忆自动提炼">' +
        '<span class="mm-eyebrow">角色记忆提炼</span>' +
        '<div class="mm-console__row">' +
          '<label class="mm-console__field">每<input type="number" id="miya-mem-auto-trigger" min="0" max="500" value="' + memTrigger + '">轮对话</label>' +
          '<button type="button" class="mm-btn mm-btn--fill" id="miya-mem-save-auto">保存</button>' +
        '</div>' +
        '<p class="mm-console__hint">' +
          (memTrigger > 0
            ? '已开启：每完成 ' + memTrigger + ' 轮角色回复后，自动提炼该段对话中对角色重要的记忆（进度 ' + pendingRounds + '/' + memTrigger + ' 轮）。'
            : '设为 0 关闭。') +
          '这里是<strong>角色记忆提炼</strong>（产出「忆」列表）；聊天设置里的「自动总结触发」是<strong>分镜/合卷总结</strong>，两套机制各自独立。' +
        '</p>' +
      '</section>' +
      '<section class="mm-console" aria-label="提炼分镜与合卷">' +
        '<span class="mm-eyebrow">提炼台</span>' +
        '<div class="mm-console__row">' +
          '<label class="mm-console__field">起始<input type="number" id="miya-mem-sum-start" min="1" max="' + historyLen + '" value="1"></label>' +
          '<label class="mm-console__field">结束<input type="number" id="miya-mem-sum-end" min="1" max="' + historyLen + '" value="' + historyLen + '"></label>' +
        '</div>' +
        '<button class="mm-play-btn" id="miya-mem-run-sum" type="button" aria-pressed="false"' +
          (historyLen > 0 ? '' : ' disabled') + '>' +
          '<span class="mm-btn-ico">' + ICO_PLAY + '</span>' +
          '<span class="mm-play-label">' + (historyLen > 0 ? '开始放映' : '暂无可放映内容') + '</span>' +
        '</button>' +
        '<button type="button" class="mm-btn mm-btn--wide" id="miya-mem-run-mega"' +
          (sumList.length > 0 ? '' : ' disabled') + '>生成合卷（合并未并入的分镜）</button>' +
      '</section>' +
      chapterHtml('01', '分镜', sumList.length + ' 则 · 对话总结',
        buildTimelineCards(sumBlocks, { emptyLabel: '尚无分镜' })) +
      chapterHtml('02', '合卷', megaList.length + ' 卷 · 分镜合并',
        buildTimelineCards(megaBlocks, { emptyLabel: '尚无合卷' })) +
      chapterHtml('03', '角色记忆', charMemList.length + ' 条 · 自动/角色视角',
        buildTimelineCards(charMemBlocks, { emptyLabel: '尚无角色记忆' }));
  }

  /* ---------- 票根带手势：拖拽标记（防拖动误触选中）+ 滚动同步 ---------- */

  var roleStripBound = false;

  function bindRoleStrip() {
    var el = $('miya-mem-roles');
    if (!el || roleStripBound) return;
    roleStripBound = true;
    var startX = 0;
    var moved = false;
    el.addEventListener(
      'touchstart',
      function (e) {
        if (e.touches.length !== 1) return;
        moved = false;
        startX = e.touches[0].clientX;
      },
      { passive: true }
    );
    el.addEventListener(
      'touchmove',
      function (e) {
        if (e.touches.length !== 1 || moved) return;
        if (Math.abs(e.touches[0].clientX - startX) > 6) moved = true;
      },
      { passive: true }
    );
    el.addEventListener(
      'touchend',
      function () {
        if (moved) el.dataset.mmDragged = '1';
        setTimeout(function () { delete el.dataset.mmDragged; }, 120);
      },
      { passive: true }
    );
    el.addEventListener('scroll', function () { syncFromRects(); }, { passive: true });
  }

  /* ---------- 业务动作 ---------- */

  function bindEvents() {
    var app = $('miya-memory-app');
    if (!app || app.dataset.bound) return;
    app.dataset.bound = '1';

    $('miya-mem-back').addEventListener('click', closeMemoryApp);

    var dotsWrap = $('miya-mem-dots');
    if (dotsWrap) {
      dotsWrap.addEventListener('click', function (e) {
        var t = e.target;
        var btn = t && t.closest ? t.closest('[data-mm-dot]') : null;
        if (!btn) return;
        goToIndex(Number(btn.getAttribute('data-mm-dot')) || 0);
      });
    }

    window.addEventListener('resize', function () {
      syncState.baseLeft = null;
      syncFromRects();
    });

    app.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var roleBtn = t.closest('[data-mem-chat]');
      if (roleBtn) {
        var rolesEl = $('miya-mem-roles');
        if (rolesEl && rolesEl.dataset.mmDragged) return;
        var cid = roleBtn.getAttribute('data-mem-chat');
        if (selectedChatId === cid) {
          /* 再点同一张票根 = 退票回空态（与放映厅交互一致） */
          selectedChatId = null;
          editingClip = null;
          renderRoleList();
          renderSummaryDetail(null);
          return;
        }
        editingClip = null;
        selectedChatId = cid;
        renderRoleList();
        renderSummaryDetail(selectedChatId);
        var roles = collectRoles();
        for (var i = 0; i < roles.length; i++) {
          if (roles[i].id === cid) { goToIndex(i); break; }
        }
        return;
      }
      if (t.id === 'miya-mem-run-sum' || t.closest('#miya-mem-run-sum')) {
        runSummary();
        return;
      }
      if (t.id === 'miya-mem-save-auto' || t.closest('#miya-mem-save-auto')) {
        saveAutoMemoryTrigger();
        return;
      }
      if (t.id === 'miya-mem-run-mega' || t.closest('#miya-mem-run-mega')) {
        runMegaSummary();
        return;
      }
      var editSum = t.closest('[data-edit-sum]');
      if (editSum) {
        startEditClip('sum', editSum.getAttribute('data-edit-sum'));
        return;
      }
      var editMega = t.closest('[data-edit-mega]');
      if (editMega) {
        startEditClip('mega', editMega.getAttribute('data-edit-mega'));
        return;
      }
      var editCmem = t.closest('[data-edit-cmem]');
      if (editCmem) {
        startEditClip('cmem', editCmem.getAttribute('data-edit-cmem'));
        return;
      }
      if (t.closest('[data-cancel-edit]')) {
        cancelEditClip();
        return;
      }
      var saveEdit = t.closest('[data-save-edit]');
      if (saveEdit) {
        saveEditClip(saveEdit.getAttribute('data-save-edit'), saveEdit.getAttribute('data-edit-id'));
        return;
      }
      var delSum = t.closest('[data-del-sum]');
      if (delSum) {
        deleteSummary(delSum.getAttribute('data-del-sum'));
        return;
      }
      var delMega = t.closest('[data-del-mega]');
      if (delMega) {
        deleteMegaSummary(delMega.getAttribute('data-del-mega'));
        return;
      }
      var delCmem = t.closest('[data-del-cmem]');
      if (delCmem) {
        deleteCharMemory(delCmem.getAttribute('data-del-cmem'));
      }
    });
  }

  function startEditClip(type, id) {
    if (!selectedChatId || !id) return;
    editingClip = { type: type, id: String(id) };
    renderSummaryDetail(selectedChatId);
    var area = $('miya-mem-edit-area');
    if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
  }

  function cancelEditClip() {
    editingClip = null;
    if (selectedChatId) renderSummaryDetail(selectedChatId);
  }

  function saveEditClip(type, id) {
    if (!selectedChatId || !id) return;
    var st = global.miyaChatStore;
    if (!st) return;
    var area = $('miya-mem-edit-area');
    var text = area ? String(area.value || '').trim() : '';
    if (!text) {
      toast('内容不能为空');
      return;
    }
    var settings = st.getChatSettings(selectedChatId);
    var patch = {};
    if (type === 'sum') {
      patch.summaryList = (settings.summaryList || []).map(function (r) {
        return r.id === id ? Object.assign({}, r, { content: text, updatedAt: Date.now() }) : r;
      });
    } else if (type === 'mega') {
      patch.megaSummaryList = (settings.megaSummaryList || []).map(function (r) {
        return r.id === id ? Object.assign({}, r, { content: text, updatedAt: Date.now() }) : r;
      });
    } else if (type === 'cmem') {
      patch.charMemoryList = (settings.charMemoryList || []).map(function (r) {
        return r.id === id ? Object.assign({}, r, { content: text, updatedAt: Date.now() }) : r;
      });
    } else {
      return;
    }
    st.saveChatSettings(selectedChatId, patch).then(function () {
      editingClip = null;
      toast('已保存');
      renderSummaryDetail(selectedChatId);
      renderRoleList();
    });
  }

  function deleteSummary(sumId) {
    if (!selectedChatId) return;
    if (editingClip && editingClip.id === sumId) editingClip = null;
    var st = global.miyaChatStore;
    if (!st) return;
    var settings = st.getChatSettings(selectedChatId);
    var list = (settings.summaryList || []).filter(function (r) { return r.id !== sumId; });
    st.saveChatSettings(selectedChatId, { summaryList: list }).then(function () {
      renderSummaryDetail(selectedChatId);
      renderRoleList();
    });
  }

  function deleteMegaSummary(megaId) {
    if (!selectedChatId) return;
    if (editingClip && editingClip.id === megaId) editingClip = null;
    var st = global.miyaChatStore;
    if (!st) return;
    var settings = st.getChatSettings(selectedChatId);
    var list = (settings.megaSummaryList || []).filter(function (r) { return r.id !== megaId; });
    st.saveChatSettings(selectedChatId, { megaSummaryList: list }).then(function () {
      renderSummaryDetail(selectedChatId);
      renderRoleList();
    });
  }

  function deleteCharMemory(memId) {
    if (!selectedChatId) return;
    if (editingClip && editingClip.id === memId) editingClip = null;
    var st = global.miyaChatStore;
    if (!st) return;
    var settings = st.getChatSettings(selectedChatId);
    var list = (settings.charMemoryList || []).filter(function (r) { return r.id !== memId; });
    st.saveChatSettings(selectedChatId, { charMemoryList: list }).then(function () {
      renderSummaryDetail(selectedChatId);
      renderRoleList();
    });
  }

  function saveAutoMemoryTrigger() {
    if (!selectedChatId) return;
    var st = global.miyaChatStore;
    if (!st) return;
    var input = $('miya-mem-auto-trigger');
    var raw = input ? parseInt(input.value, 10) : 0;
    var val = Number.isFinite(raw) ? Math.min(500, Math.max(0, raw)) : 0;
    st.saveChatSettings(selectedChatId, { memoryAutoRoundTrigger: val }).then(function () {
      toast(val > 0 ? '已设置每 ' + val + ' 轮自动提炼角色记忆' : '已关闭角色记忆自动提炼');
      renderSummaryDetail(selectedChatId);
      renderRoleList();
    });
  }

  /* 开始放映 = 按起始/结束范围生成分镜 */
  function runSummary() {
    if (!selectedChatId || !global.MiyaChatSummary || generating) return;
    var st = global.miyaChatStore;
    if (!st || !st.getMessages(selectedChatId).length) {
      toast('还没有可放映的消息');
      return;
    }
    var start = parseInt(($('miya-mem-sum-start') || {}).value, 10) || 1;
    var end = parseInt(($('miya-mem-sum-end') || {}).value, 10) || 1;
    generating = true;
    setPlaying(true);
    toast('正在生成分镜…');
    global.MiyaChatSummary.performSummary(selectedChatId, { start: start, end: end })
      .then(function (ok) {
        if (ok) toast('分镜完成');
      }, function () {
        toast('分镜生成失败，可重试');
      })
      .then(function () {
        generating = false;
        setPlaying(false);
        renderSummaryDetail(selectedChatId);
        renderRoleList();
      });
  }

  function runMegaSummary() {
    if (!selectedChatId || !global.MiyaChatSummary || generating) return;
    var st = global.miyaChatStore;
    if (!st) return;
    var settings = st.getChatSettings(selectedChatId);
    var list = settings.summaryList || [];
    var sumMod = global.MiyaChatSummary;
    var covered = sumMod && sumMod.summaryIdsCoveredByMega
      ? sumMod.summaryIdsCoveredByMega(settings.megaSummaryList || []) : {};
    var indices = [];
    list.forEach(function (row, i) {
      if (!row || !row.id || covered[row.id]) return;
      indices.push(i);
    });
    if (!indices.length) {
      toast('没有可合并的分镜');
      return;
    }
    generating = true;
    setPlaying(true, '正在放映…');
    toast('正在生成合卷…');
    global.MiyaChatSummary.performMegaSummary(selectedChatId, { sourceIndices: indices })
      .then(function (ok) {
        if (ok) toast('合卷完成');
      }, function () {
        toast('合卷生成失败，可重试');
      })
      .then(function () {
        generating = false;
        setPlaying(false);
        renderSummaryDetail(selectedChatId);
        renderRoleList();
      });
  }

  /* ---------- 开关 App ---------- */

  function doOpenMemoryApp(el) {
    selectedChatId = null;
    editingClip = null;
    el.removeAttribute('hidden');
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('miya-app-open');
    requestAnimationFrame(function () {
      renderRoleList();
      renderSummaryDetail(null);
      bindRoleStrip();
      syncState.baseLeft = null;
      syncFromRects();
      startSyncPolling();
    });
  }

  function openMemoryApp() {
    var el = $('miya-memory-app');
    if (!el) return;
    ensureStore()
      .then(function () {
        doOpenMemoryApp(el);
      })
      .catch(function (err) {
        /* ensureStore 里串了 contactsStore.whenReady / chatStore.init / syncAll，
           任一环 reject 都会让界面永远放不出来（点了没反应）。
           记忆本体只依赖 chatStore 的缓存，降级打开比静默失败好。
           注意：必须确保不留「hidden 摘了、is-open 没加」的半开残留。 */
        console.warn('[miyaMemoryApp] ensureStore failed, opening in degraded mode:', err);
        if (!el.classList.contains('is-open')) {
          el.setAttribute('hidden', '');
          el.setAttribute('aria-hidden', 'true');
        }
        doOpenMemoryApp(el);
      });
  }

  function closeMemoryApp() {
    var el = $('miya-memory-app');
    if (!el) return;
    el.classList.remove('is-open');
    el.setAttribute('hidden', '');
    el.setAttribute('aria-hidden', 'true');
    stopSyncPolling();
    if (!document.querySelector('.miya-beautify-app.is-open') &&
        !document.querySelector('.mi-set-page.is-open') &&
        !document.querySelector('.miya-worldbook-app.is-open') &&
        !document.querySelector('.miya-chat-app.is-open') &&
        !document.querySelector('.miya-memory-app.is-open')) {
      document.body.classList.remove('miya-app-open');
    }
  }

  function onCharMemoryUpdated(chatId) {
    if (selectedChatId === chatId) {
      renderSummaryDetail(chatId);
      renderRoleList();
    }
  }

  bindEvents();

  global.miyaMemoryApp = {
    open: openMemoryApp,
    close: closeMemoryApp,
    onCharMemoryUpdated: onCharMemoryUpdated
  };
})(window);
