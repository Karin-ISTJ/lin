/* miya-chat-time-events.js
 * 现实时钟世界事件（World Timeline）
 *
 * 设计原则：
 * 1. 事件是独立账本，不依赖聊天上下文，离线时间照样流逝
 * 2. 只用绝对时间戳（createdAt / dueAt），读时补算状态
 * 3. 状态机：pending → due → claimed | missed | cancelled
 * 4. 正文上方用系统卡片呈现「世界变化」，不是伪装成角色消息
 * 5. 禁止纯剧情奖励；只接受本身需要现实等待的事情
 */
(function (global) {
  'use strict';

  var TAG = /<miyaevent>([\s\S]*?)<\/miyaevent\s*>/gi;
  var MAX_EVENTS = 120;
  var SCHEMA = 3;

  // 允许的现实事件类型
  var TYPES = {
    bank_interest: { label: '银行利息', icon: '🏦', claimable: true, missAfter: 0 },
    investment:    { label: '投资结算', icon: '📈', claimable: true, missAfter: 0 },
    refund:        { label: '退款',     icon: '💸', claimable: true, missAfter: 0 },
    salary:        { label: '工资',     icon: '💼', claimable: true, missAfter: 0 },
    settlement:    { label: '结算',     icon: '🧾', claimable: true, missAfter: 0 },
    delivery:      { label: '快递',     icon: '📦', claimable: true, missAfter: 0, needsClaimDefault: true },
    subscription:  { label: '会员/订阅', icon: '🔖', claimable: false, missAfter: 0 },
    lease:         { label: '租期',     icon: '🏠', claimable: false, missAfter: 0 },
    plant:         { label: '种植',     icon: '🌱', claimable: false, missAfter: 0 },
    fermentation:  { label: '发酵',     icon: '🫙', claimable: false, missAfter: 0 },
    repair:        { label: '维修/制作', icon: '🔧', claimable: true, missAfter: 0 },
    commission:    { label: '委托',     icon: '🛠️', claimable: true, missAfter: 0 },
    application:   { label: '申请/审核', icon: '📋', claimable: true, missAfter: 0 },
    appointment:   { label: '预约',     icon: '📅', claimable: false, missAfter: 3 * 3600000 },
    ticket:        { label: '演出/电影', icon: '🎫', claimable: false, missAfter: 6 * 3600000 },
    match:         { label: '比赛',     icon: '🏟️', claimable: false, missAfter: 6 * 3600000 },
    travel:        { label: '旅行',     icon: '✈️', claimable: false, missAfter: 12 * 3600000 },
    exam:          { label: '考试',     icon: '📝', claimable: false, missAfter: 6 * 3600000 },
    general:       { label: '事务',     icon: '⏳', claimable: false, missAfter: 48 * 3600000 }
  };

  var BLOCKED = /礼物|惊喜|惊喜礼物|送给你|给你准备|告白|浪漫奖励/;
  var REAL_HINT = /银行|利息|存款|定期|投资|收益|退款|快递|配送|到货|预约|演出|电影|比赛|考试|旅行|出发|维修|修理|委托|制作|办理|审核|审批|工资|发薪|结算|会员|租期|种植|发芽|开花|成熟|发酵|预售|发售/;

  function now() { return Date.now(); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }
  function uid() {
    return 'te_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
  }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function typeMeta(t) {
    return TYPES[t] || TYPES.general;
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }).format(new Date(ts));
    } catch (e) {
      return new Date(ts).toLocaleString();
    }
  }

  function formatDelta(ms) {
    var a = Math.abs(ms);
    var d = Math.floor(a / 86400000);
    var h = Math.floor((a % 86400000) / 3600000);
    var m = Math.floor((a % 3600000) / 60000);
    if (d > 0) return d + '天' + (h ? h + '小时' : '');
    if (h > 0) return h + '小时' + (m ? m + '分钟' : '');
    return Math.max(1, m) + '分钟';
  }

  function getBg(store, chatId) {
    var s = store && store.getChatSettings ? store.getChatSettings(chatId) || {} : {};
    return s.backgroundMessage || {};
  }

  function load(store, chatId) {
    var list = getBg(store, chatId).timeEvents;
    return Array.isArray(list) ? list.slice() : [];
  }

  function save(store, chatId, list) {
    if (!store || !store.saveChatSettings) return Promise.resolve();
    return store.saveChatSettings(chatId, {
      backgroundMessage: { timeEvents: list.slice(-MAX_EVENTS) }
    });
  }

  function resolveDueAt(raw, createdAt) {
    var direct = num(raw.dueAt);
    if (direct > 0) return direct < 1e11 ? direct * 1000 : direct;

    var iso = String(raw.dueAt || raw.dueDate || raw.at || '').trim();
    if (iso) {
      var p = Date.parse(iso.replace(/-/g, '/'));
      if (Number.isFinite(p)) return p;
    }

    var base = createdAt || now();
    var days = num(raw.afterDays || raw.delayDays);
    var hours = num(raw.afterHours || raw.delayHours);
    var minutes = num(raw.afterMinutes || raw.delayMinutes);
    if (days || hours || minutes) {
      return base + days * 86400000 + hours * 3600000 + minutes * 60000;
    }
    return 0;
  }

  function mapStatus(s) {
    if (s === 'waiting') return 'pending';
    if (s === 'ready') return 'due';
    if (s === 'resolved') return 'claimed';
    if (['pending', 'due', 'claimed', 'missed', 'cancelled'].indexOf(s) >= 0) return s;
    return 'pending';
  }

  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var createdAt = num(raw.createdAt) || now();
    var dueAt = resolveDueAt(raw, createdAt);
    var type = clean(raw.type || raw.kind, 40) || 'general';
    if (!TYPES[type]) type = 'general';
    var meta = typeMeta(type);

    var needsClaim = raw.needsClaim === true || raw.needsConfirmation === true;
    if (raw.needsClaim == null && raw.needsConfirmation == null && meta.needsClaimDefault) {
      needsClaim = true;
    }

    return {
      schema: SCHEMA,
      id: clean(raw.id, 80) || uid(),
      type: type,
      title: clean(raw.title, 80) || meta.label,
      description: clean(raw.description, 300),
      result: clean(raw.result, 400),
      payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : null,
      createdAt: createdAt,
      dueAt: dueAt,
      status: mapStatus(raw.status),
      needsClaim: needsClaim,
      natural: raw.natural !== false && raw.naturalTrigger !== false,
      claimedAt: num(raw.claimedAt || raw.resolvedAt),
      claimedBy: clean(raw.claimedBy || raw.resolvedBy, 40),
      stateUpdatedAt: num(raw.stateUpdatedAt) || createdAt,
      sourceMessageId: clean(raw.sourceMessageId, 100)
    };
  }

  function reconcile(store, chatId, at) {
    at = at || now();
    var list = load(store, chatId).map(normalize);
    var changed = false;

    list.forEach(function (e) {
      if (e.status === 'claimed' || e.status === 'cancelled') return;
      if (!e.dueAt) return;

      if (e.status === 'pending' && at >= e.dueAt) {
        e.status = 'due';
        e.stateUpdatedAt = at;
        changed = true;
      }

      if (e.status === 'due') {
        var missAfter = typeMeta(e.type).missAfter;
        if (missAfter > 0 && !e.needsClaim && at >= e.dueAt + missAfter) {
          e.status = 'missed';
          e.stateUpdatedAt = at;
          changed = true;
        }
      }
    });

    return { list: list, changed: changed };
  }

  function reconcileAndSave(store, chatId, at) {
    var r = reconcile(store, chatId, at);
    if (r.changed) save(store, chatId, r.list).catch(function () {});
    return r.list;
  }

  function isBlocked(type, text) {
    if (['gift', 'surprise', 'present', 'reward', 'romance', 'confession', 'relationship'].indexOf(type) >= 0) {
      return true;
    }
    return BLOCKED.test(text || '');
  }

  function hasRealBasis(type, text) {
    if (type !== 'general' && TYPES[type]) return true;
    return REAL_HINT.test(text || '');
  }

  function create(store, chatId, raw) {
    var e = normalize(raw);
    if (!e.dueAt) return null;

    var blob = (e.title + ' ' + e.description + ' ' + e.result).toLowerCase();
    if (isBlocked(e.type, blob)) return null;
    if (!hasRealBasis(e.type, blob)) return null;

    var list = load(store, chatId).map(normalize);
    var dup = list.some(function (x) {
      return x.id === e.id ||
        (x.title === e.title && Math.abs(x.dueAt - e.dueAt) < 60000 &&
          x.status !== 'cancelled' && x.status !== 'claimed');
    });
    if (dup) return null;

    e.stateUpdatedAt = e.createdAt;
    list.push(e);
    save(store, chatId, list).catch(function () {});
    return e;
  }

  function extractAndStore(store, chatId, text) {
    var src = String(text || '');
    var found = [];
    var m;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(src))) {
      var body = m[1].trim();
      var obj = null;
      try {
        obj = JSON.parse(body);
      } catch (err) {
        try {
          obj = JSON.parse(body.replace(/[“”]/g, '"').replace(/，/g, ',').replace(/：/g, ':'));
        } catch (err2) {}
      }
      if (obj) {
        if (!obj.type && obj.kind) obj.type = obj.kind;
        var created = create(store, chatId, obj);
        if (created) found.push(created);
      }
    }
    return { text: src.replace(TAG, '').trim(), events: found };
  }

  function claim(store, chatId, eventId, by) {
    var list = load(store, chatId).map(normalize);
    var hit = null;
    list.forEach(function (e) {
      if (e.id === eventId && (e.status === 'due' || e.status === 'pending')) {
        e.status = 'claimed';
        e.claimedAt = now();
        e.stateUpdatedAt = e.claimedAt;
        e.claimedBy = clean(by, 40) || 'user';
        hit = e;
      }
    });
    if (hit) save(store, chatId, list).catch(function () {});
    return hit;
  }

  function dismiss(store, chatId, eventId, by) {
    var list = load(store, chatId).map(normalize);
    var hit = null;
    list.forEach(function (e) {
      if (e.id !== eventId) return;
      if (e.status === 'due') {
        e.status = 'claimed';
        e.claimedAt = now();
        e.claimedBy = clean(by, 40) || 'user';
        e.stateUpdatedAt = e.claimedAt;
        hit = e;
      } else if (e.status === 'missed') {
        e.status = 'cancelled';
        e.stateUpdatedAt = now();
        hit = e;
      }
    });
    if (hit) save(store, chatId, list).catch(function () {});
    return hit;
  }

  function markMissed(store, chatId, eventId) {
    var list = load(store, chatId).map(normalize);
    var hit = null;
    list.forEach(function (e) {
      if (e.id === eventId && e.status !== 'claimed' && e.status !== 'cancelled') {
        e.status = 'missed';
        e.stateUpdatedAt = now();
        hit = e;
      }
    });
    if (hit) save(store, chatId, list).catch(function () {});
    return hit;
  }

  function getVisible(store, chatId, at) {
    var list = reconcileAndSave(store, chatId, at || now());
    return list.filter(function (e) {
      return e.status === 'due' || e.status === 'missed';
    });
  }

  function getActive(store, chatId, at) {
    var list = reconcileAndSave(store, chatId, at || now());
    return list.filter(function (e) {
      return e.status === 'pending' || e.status === 'due' || e.status === 'missed';
    });
  }

  function buildPromptContext(store, chatId, at) {
    at = at || now();
    var active = getActive(store, chatId, at);
    if (!active.length) return '';

    var lines = [
      '【现实时钟事件账本】独立于聊天记录保存。现实时间持续流逝，用户离线不会暂停。不要机械播报；只有剧情自然涉及才写进正文。'
    ];

    active.slice(0, 12).forEach(function (e) {
      var meta = typeMeta(e.type);
      var due = e.dueAt ? formatDate(e.dueAt) : '未定';
      var state =
        e.status === 'missed' ? '已错过/已结束' :
        e.status === 'due' ? (e.needsClaim ? '已到期，待领取/确认' : '已到期') :
        '等待中';

      lines.push('- ' + meta.icon + ' ' + e.title + '｜' + state + '｜时间：' + due +
        (e.description ? '｜' + e.description : ''));
      if (e.result) lines.push('  结果：' + e.result);
      if (e.status === 'missed') {
        lines.push('  → 事情已过去，禁止再提议「现在去做/去看」。');
      } else if (e.status === 'due' && e.needsClaim) {
        lines.push('  → 需用户确认后才算完成，不要脑补已领取/已签收。');
      } else if (e.natural) {
        lines.push('  → 到时间后自然衔接，不要为事件强行跳时。');
      }
    });

    return lines.join('\n');
  }

  function renderCards(store, chatId, at) {
    at = at || now();
    var items = getVisible(store, chatId, at);
    if (!items.length) return '';

    var html = '<div class="qq-room__time-events" aria-label="现实时钟事件">';
    items.slice(-8).forEach(function (e) {
      var meta = typeMeta(e.type);
      var isMissed = e.status === 'missed';
      var badge = isMissed ? '已错过' : (e.needsClaim ? '待确认' : '已到期');
      var age = e.dueAt && at > e.dueAt ? formatDelta(at - e.dueAt) : '';
      var resultLine = '';
      if (!isMissed && e.result) {
        resultLine = '<div class="qq-room__time-event-result">' + esc(e.result) + '</div>';
      }

      var actions = '';
      if (!isMissed && e.needsClaim) {
        actions = '<div class="qq-room__time-event-actions">' +
          '<button type="button" class="qq-room__time-event-btn qq-room__time-event-btn--claim" data-te-claim="' + esc(e.id) + '">领取 / 确认</button>' +
          '</div>';
      } else {
        actions = '<div class="qq-room__time-event-actions">' +
          '<button type="button" class="qq-room__time-event-btn" data-te-dismiss="' + esc(e.id) + '">知道了</button>' +
          '</div>';
      }

      html += '<div class="qq-room__time-event qq-room__time-event--' + (isMissed ? 'missed' : 'due') + '" data-te-id="' + esc(e.id) + '">' +
        '<div class="qq-room__time-event-head">' +
          '<span>' + meta.icon + ' ' + badge + '</span>' +
          '<time>' + esc(formatDate(e.dueAt)) + '</time>' +
        '</div>' +
        '<div class="qq-room__time-event-title">' + esc(e.title) + '</div>' +
        (e.description ? '<div class="qq-room__time-event-desc">' + esc(e.description) + '</div>' : '') +
        resultLine +
        (age ? '<div class="qq-room__time-event-age">已过去 ' + esc(age) + '</div>' : '') +
        actions +
        '</div>';
    });
    return html + '</div>';
  }

  function createBankInterest(store, chatId, opts) {
    opts = opts || {};
    var days = num(opts.days) || 7;
    var amount = opts.amount;
    var title = opts.title || '定期存款利息';
    var result = amount != null ? ('到账 +' + amount) : (opts.result || '利息已到账');
    return create(store, chatId, {
      type: 'bank_interest',
      title: title,
      description: opts.description || ('存入后 ' + days + ' 天可领取利息'),
      result: result,
      payload: amount != null ? { amount: amount } : null,
      afterDays: days,
      needsClaim: true,
      natural: true
    });
  }

  global.MiyaChatTimeEvents = {
    create: create,
    extractAndStore: extractAndStore,
    claim: claim,
    dismiss: dismiss,
    markMissed: markMissed,
    reconcile: reconcile,
    reconcileAndSave: reconcileAndSave,
    getVisible: getVisible,
    getActive: getActive,
    load: load,
    normalize: normalize,
    buildPromptContext: buildPromptContext,
    renderCards: renderCards,
    createBankInterest: createBankInterest,
    formatDate: formatDate,
    formatDelta: formatDelta,
    TYPES: TYPES
  };
})(window);
