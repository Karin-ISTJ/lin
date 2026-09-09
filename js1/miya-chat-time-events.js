/* miya-chat-time-events.js — 现实时间事件：等待、到期、自然剧情触发 */
(function (global) {
  'use strict';
  var TAG = /<miyaevent>([\s\S]*?)<\/miyaevent\s*>/gi;
  var MAX_EVENTS = 120;
  var EVENT_SCHEMA_VERSION = 2;
  // 时间事件不是“剧情奖励池”：只接受本身具有现实等待理由的事件。
  var ALLOWED_KINDS = ['bank_interest','investment','refund','delivery','appointment','ticket','travel','match','exam','repair','commission','application','salary','settlement','subscription','lease','plant','fermentation','general'];
  var BLOCKED_KINDS = ['gift','surprise','present','reward','romance','confession','relationship'];

  function now() { return Date.now(); }
  function id() { return 'te_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }
  function getSettings(store, chatId) { return store && store.getChatSettings ? (store.getChatSettings(chatId) || {}) : {}; }
  function getEvents(store, chatId) {
    var bg = getSettings(store, chatId).backgroundMessage || {};
    return Array.isArray(bg.timeEvents) ? bg.timeEvents.slice() : [];
  }
  function saveEvents(store, chatId, events) {
    if (!store || !store.saveChatSettings) return Promise.resolve();
    return store.saveChatSettings(chatId, { backgroundMessage: { timeEvents: events.slice(-MAX_EVENTS) } });
  }
  function resolveDueAt(e) {
    var direct = num(e.dueAt);
    if (direct > 0) return direct < 100000000000 ? direct * 1000 : direct;
    var iso = String(e.dueAt || e.dueDate || e.at || '').trim();
    if (iso) {
      var parsed = Date.parse(iso.replace(/-/g, '/'));
      if (Number.isFinite(parsed)) return parsed;
    }
    var base = num(e.createdAt) || now();
    var days = num(e.afterDays || e.delayDays);
    var hours = num(e.afterHours || e.delayHours);
    var minutes = num(e.afterMinutes || e.delayMinutes);
    if (days || hours || minutes) return base + days * 86400000 + hours * 3600000 + minutes * 60000;
    return 0;
  }
  function normalizeEvent(e) {
    e = e && typeof e === 'object' ? e : {};
    var createdAt = num(e.createdAt) || now();
    var dueAt = resolveDueAt(Object.assign({}, e, { createdAt: createdAt }));
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: clean(e.id, 80) || id(),
      title: clean(e.title, 80) || '等待事件',
      kind: clean(e.kind, 40) || 'general',
      description: clean(e.description, 300),
      result: clean(e.result, 400),
      dueAt: dueAt,
      createdAt: createdAt,
      status: ['waiting','ready','resolved','missed','cancelled'].indexOf(e.status) >= 0 ? e.status : 'waiting',
      autoResolve: e.autoResolve !== false,
      naturalTrigger: e.naturalTrigger !== false,
      triggeredAt: num(e.triggeredAt),
      resolvedAt: num(e.resolvedAt),
      resolvedBy: clean(e.resolvedBy, 40),
      lastNotifiedAt: num(e.lastNotifiedAt),
      stateUpdatedAt: num(e.stateUpdatedAt) || createdAt,
      sourceMessageId: clean(e.sourceMessageId, 100),
      needsConfirmation: e.needsConfirmation === true
    };
  }
  function formatDate(ts) {
    try { return new Intl.DateTimeFormat('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(ts)); }
    catch (e) { return new Date(ts).toLocaleString(); }
  }
  function formatDelta(ms) {
    var d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000), m = Math.floor(ms % 3600000 / 60000);
    if (d > 0) return d + '天' + (h ? h + '小时' : '');
    if (h > 0) return h + '小时' + (m ? m + '分钟' : '');
    return Math.max(1, m) + '分钟';
  }
  function reconcile(store, chatId, at) {
    var events = getEvents(store, chatId).map(normalizeEvent), changed = false;
    events.forEach(function (e) {
      if (e.status === 'waiting' && e.dueAt && at >= e.dueAt) {
        e.status = e.needsConfirmation ? 'ready' : 'ready';
        e.stateUpdatedAt = at;
        changed = true;
      }
    });
    return { events: events, changed: changed };
  }
  function getDueEvents(store, chatId, at) {
    var r = reconcile(store, chatId, at || now());
    if (r.changed) saveEvents(store, chatId, r.events).catch(function(){});
    return r.events.filter(function(e){ return e.status === 'ready' || e.status === 'missed'; });
  }
  function createFromObject(store, chatId, raw) {
    var e = normalizeEvent(raw);
    if (!e.dueAt) return null;
    var kind = String(e.kind || 'general').toLowerCase();
    var titleText = (e.title + ' ' + e.description + ' ' + e.result).toLowerCase();
    // 明确拒绝“几天后送你礼物/惊喜”这类纯剧情奖励，避免 AI 为了制造内容滥用时间事件。
    if (BLOCKED_KINDS.indexOf(kind) >= 0 || /礼物|惊喜|惊喜礼物|送给你|给你准备/.test(titleText)) return null;
    if (ALLOWED_KINDS.indexOf(kind) < 0) {
      // general 也必须有现实世界的等待依据；没有明确依据就不落库。
      if (!/银行|利息|存款|定期|投资|收益|退款|快递|配送|到货|预约|演出|电影|比赛|考试|旅行|出发|维修|修理|委托|制作|办理|审核|审批|工资|发薪|结算|会员|租期|种植|发芽|开花|成熟|发酵|预售|发售/.test(titleText)) return null;
    }
    var list = getEvents(store, chatId).map(normalizeEvent);
    var dup = list.some(function(x){ return x.id === e.id || (x.title === e.title && Math.abs(x.dueAt - e.dueAt) < 60000 && x.status !== 'cancelled'); });
    if (dup) return list;
    e.stateUpdatedAt = e.createdAt;
    list.push(e);
    // 事件账本独立于聊天正文保存：后续聊天再多，也不能因为上下文裁剪/总结而丢失。
    saveEvents(store, chatId, list).catch(function(){});
    return e;
  }
  function extractAndStore(store, chatId, text) {
    var src = String(text || ''), found = [], m;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(src))) {
      var raw = m[1].trim(), obj = null;
      try { obj = JSON.parse(raw); } catch (e) {
        try { obj = JSON.parse(raw.replace(/“|”/g,'"').replace(/，/g,',').replace(/：/g,':')); } catch (e2) {}
      }
      if (obj) {
        var e = createFromObject(store, chatId, obj);
        if (e) found.push(e);
      }
    }
    return { text: src.replace(TAG, '').trim(), events: found };
  }
  function markResolved(store, chatId, eventId, by) {
    var list = getEvents(store, chatId).map(normalizeEvent), hit = null;
    list.forEach(function(e){ if(e.id === eventId){ e.status='resolved'; e.resolvedAt=now(); e.stateUpdatedAt=e.resolvedAt; e.resolvedBy=clean(by,40)||'system'; hit=e; }});
    if (hit) saveEvents(store, chatId, list).catch(function(){});
    return hit;
  }
  function buildPromptContext(store, chatId, at) {
    var r = reconcile(store, chatId, at || now());
    if (r.changed) saveEvents(store, chatId, r.events).catch(function(){});
    var active = r.events.filter(function(e){ return e.status === 'waiting' || e.status === 'ready'; });
    if (!active.length) return '';
    var lines = ['【现实时间事件账本】这些事件独立保存在聊天设置中，不依赖聊天上下文；聊天再长、总结/裁剪都不能让它消失。现实时间继续推进，用户离线也不会暂停。不要机械播报，只有剧情自然涉及时才写进正文。'];
    active.slice(0, 12).forEach(function(e){
      var due = e.dueAt ? formatDate(e.dueAt) : '未定';
      var state = e.status === 'ready' ? '已到时间/可发生' : '等待中';
      if (e.status === 'ready' && e.dueAt && at > e.dueAt) state = '已到期，等待处理';
      lines.push('- ' + e.title + '｜' + state + '｜时间：' + due + (e.description ? '｜' + e.description : ''));
      if (e.result) lines.push('  预期结果：' + e.result);
      if (e.naturalTrigger) lines.push('  处理：到时间后优先自然衔接；不要为了事件强行跳时。');
      if (e.autoResolve && e.status === 'ready') lines.push('  处理：如果属于纯结算事件（利息、到货、完成等），可以直接在剧情上方以系统事件形式结算。');
    });
    return lines.join('\n');
  }
  function renderCards(store, chatId, at) {
    var due = getDueEvents(store, chatId, at || now());
    if (!due.length) return '';
    var html = '<div class="qq-room__time-events" aria-label="现实时间事件">';
    due.slice(-8).forEach(function(e){
      var title = e.status === 'missed' ? '已错过' : (e.dueAt && (at || now()) > e.dueAt ? '已到期' : '时间已到');
      var delta = e.dueAt ? (at || now()) - e.dueAt : 0;
      var extra = delta > 86400000 ? ' · 已过去 ' + formatDelta(delta) : '';
      html += '<div class="qq-room__time-event qq-room__time-event--' + (e.status === 'missed' ? 'missed' : 'ready') + '">'
        + '<div class="qq-room__time-event-head"><span>⏳ ' + title + '</span><time>' + formatDate(e.dueAt) + '</time></div>'
        + '<div class="qq-room__time-event-title">' + escapeHtml(e.title) + '</div>'
        + (e.description ? '<div class="qq-room__time-event-desc">' + escapeHtml(e.description) + '</div>' : '')
        + (e.result && e.autoResolve ? '<div class="qq-room__time-event-result">' + escapeHtml(e.result) + '</div>' : '')
        + (extra ? '<div class="qq-room__time-event-age">' + extra.slice(3) + '</div>' : '')
        + '</div>';
    });
    return html + '</div>';
  }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  global.MiyaChatTimeEvents = {
    normalizeEvent: normalizeEvent,
    getEvents: getEvents,
    create: createFromObject,
    extractAndStore: extractAndStore,
    markResolved: markResolved,
    buildPromptContext: buildPromptContext,
    renderCards: renderCards,
    reconcile: reconcile,
    getDueEvents: getDueEvents,
    formatDate: formatDate
  };
})(window);
