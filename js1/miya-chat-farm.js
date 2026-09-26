/* miya-chat-farm.js — 聊天页 🌱 · 星露速览
 *
 * 原「双人小农场」已整体并入星露农场（miya-farmgame-store/app，现实时钟制）。
 * 本模块改造为「星露速览 + 跳转 + 通知」四件事：
 *   1. 🌱 速览面板（保留原面板视觉）：熟 X 块 / 缺水 X 块 / 枯 X 块 / 可偷 X 块
 *      + 今日日期·季节 + 体力，纯状态展示、异常标亮、无就地操作；
 *   2. 头部「进入 →」+ 整头热区，一步跳进农场（来源=当前聊天，退出自动回跳）；
 *   3. 小太阳角标：顶栏 🌱 右上角，有熟地才亮（金黄渐变 + 轻呼吸）；
 *   4. 角色偷菜事件 → 聊天里收到一条系统消息（旧 <miyafarm> 标签解析与
 *      提示词注入已摘除，角色农场行为只走事件通知，杜绝幽灵指令）。
 *   5. 旧小农场仓库存货按售价折算进星露金币 + 告别信进农场信箱（一次性）。
 */
(function (global) {
  'use strict';

  var MAX_LOG = 3;
  var badgeTimer = 0;

  /* ── 旧小农场售价表（迁移折算用；id 与旧 miya-chat-farm.js 存档一致） ── */
  var LEGACY_PRICES = {
    hyacinth: 12, sunflower: 10, blossom: 6, clover: 8, fourleaf: 88,
    strawberry: 9, cherry: 11, apple: 8, greenapple: 8, tomato: 7, chili: 7,
    watermelon: 14, peach: 10, orange: 8, mango: 12, pineapple: 13, lemon: 7,
    melon: 11, pear: 8, blueberry: 12, grape: 10, kiwi: 11, avocado: 15,
    carrot: 6, corn: 7, pea: 6, leafy: 5, broccoli: 8, chestnut: 9, bean: 5,
    wheat: 5, rose: 16, green: 4,
    bear: 120, koala: 110, rabbit: 45, fox: 95, sheep: 70,
    squirrel: 55, beaver: 80, goose: 60, parrot: 100, eagle: 150
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── 懒加载：确保星露农场 store/app 就绪 ── */
  var storePromise = null;
  function ensureStore() {
    if (global.MiyaFarmGameStore) return Promise.resolve(global.MiyaFarmGameStore);
    if (typeof global.miyaLazyEnsureApp !== 'function') return Promise.resolve(null);
    if (!storePromise) {
      storePromise = Promise.resolve(global.miyaLazyEnsureApp('farmgame'))
        .then(function () { return global.MiyaFarmGameStore || null; })
        .catch(function () { return null; });
    }
    return storePromise;
  }

  /* ── 对手名（当前聊天对象） ── */
  function resolveRivalName(chatId) {
    var st = global.miyaChatStore;
    if (!st || !chatId) return '';
    try {
      var ch = st.findChat ? st.findChat(chatId) : null;
      if (!ch) return '';
      if (ch.type === 'group') return String(ch.title || '群聊').trim() || '群聊';
      var contact = ch.contactId && st.findContact ? st.findContact(ch.contactId) : null;
      return String((contact && (contact.remarkName || contact.name)) || ch.title || 'TA').trim() || 'TA';
    } catch (e) {
      return 'TA';
    }
  }

  /* ── 跳进星露农场（来源 = 聊天，退出自动回跳本聊天） ── */
  function enterFarm(chatId, toast) {
    /* 贴手势同步解锁 BGM：open() 在 ensureStore 异步链之后才执行，
       移动端 WebView 不再认它是用户手势、play() 会被拦；
       在点击的这一刻先把音频静音解锁，open 后恢复出声 */
    var fgEarly = global.MiyaFarmGame;
    if (fgEarly && typeof fgEarly.unlockAudio === 'function') fgEarly.unlockAudio();
    ensureStore().then(function (STORE) {
      var name = resolveRivalName(chatId);
      if (STORE && chatId && typeof STORE.setRival === 'function') {
        STORE.setRival(chatId, name);
      }
      var fg = global.MiyaFarmGame;
      if (fg && typeof fg.open === 'function') {
        fg.open({ source: 'chat', chatId: String(chatId || ''), chatName: name });
      } else if (toast) {
        toast('农场还没加载好，再点一次试试');
      }
    });
  }

  /* ── 角色偷菜事件 → 聊天系统消息 ── */
  function handleFarmEvents(evs) {
    (evs || []).forEach(function (ev) {
      if (ev && ev.type === 'rivalSteal' && ev.chatId) sendStealNotice(ev);
    });
  }

  function sendStealNotice(ev) {
    var st = global.miyaChatStore;
    if (!st || typeof st.addMessage !== 'function' || !ev.chatId) return;
    var text = '🕵️ ' + (ev.name || '对方') + '偷走了你的' + (ev.cropIcon || '') + (ev.cropName || '作物') +
      '！打开 🌱 星露农场，去TA的田里反击 →';
    Promise.resolve(st.addMessage(ev.chatId, { role: 'system', type: 'text', content: text }))
      .then(function () {
        var room = global.miyaChatRoom;
        if (room && typeof room.getOpenChatId === 'function' &&
            String(room.getOpenChatId()) === String(ev.chatId) &&
            typeof room.refresh === 'function') {
          room.refresh({ animate: false, preserveScrollTop: true, preserveLoadedCount: true, toBottom: true });
        }
      })
      .catch(function () {});
  }

  /* ── 小太阳角标：有熟地才亮 ── */
  function refreshSunBadge() {
    var sun = document.getElementById('qq-room-farm-sun');
    if (!sun) return;
    var STORE = global.MiyaFarmGameStore;
    if (!STORE) { sun.classList.remove('is-on'); ensureStore(); return; }
    try {
      STORE.sync();
      handleFarmEvents(STORE.takeEvents());
      var s = STORE.getState();
      var has = s.plots.some(function (p) {
        return p && STORE.plotMature(p) && !STORE.plotWithered(p);
      });
      sun.classList.toggle('is-on', has);
    } catch (e) {
      sun.classList.remove('is-on');
    }
  }

  /* ── 旧小农场仓库存货折算迁移（一次性；旧存档保留不清） ── */
  var migrateTried = 0;
  var migrateDone = false;
  function migrateLegacyFarms() {
    if (migrateDone) return;
    var st = global.miyaChatStore;
    var STORE = global.MiyaFarmGameStore;
    if (!st || typeof st.getChats !== 'function' || typeof st.getChatSettings !== 'function' || !STORE) {
      /* 聊天仓库尚未水合好：稍后重试（最多 ~10 次） */
      if (migrateTried++ < 10) setTimeout(migrateLegacyFarms, 5000);
      return;
    }
    migrateDone = true;
    try {
      var s = STORE.getState();
      if (s.legacyMigrated) return;
      var chats = [];
      try { chats = st.getChats() || []; } catch (e) { chats = []; }
      var total = 0, missFour = 0, missAnimal = 0;
      chats.forEach(function (ch) {
        if (!ch || !ch.id) return;
        var settings = null;
        try { settings = st.getChatSettings(ch.id) || null; } catch (e) { return; }
        var farm = settings && settings.backgroundMessage && settings.backgroundMessage.farm;
        if (!farm || typeof farm !== 'object') return;
        var wh = farm.warehouse || {};
        Object.keys(wh).forEach(function (k) {
          var q = Math.floor(Number(wh[k]) || 0);
          if (q > 0 && LEGACY_PRICES[k]) total += LEGACY_PRICES[k] * q;
        });
        missFour = Math.max(missFour, Math.floor(Number(farm.missFour) || 0), Math.floor(Number(farm.missFourRole) || 0));
        missAnimal = Math.max(missAnimal, Math.floor(Number(farm.missAnimal) || 0), Math.floor(Number(farm.missAnimalRole) || 0));
      });
      STORE.applyLegacyMigration(total, missFour, missAnimal);
    } catch (e) {
      migrateDone = false;
    }
  }

  /* ── 速览面板 ── */
  function shell(inner) {
    return '<div class="qq-sheet qq-sheet--farm">' +
      '<div class="qq-sheet__panel qq-sheet__panel--farm">' + inner + '</div></div>';
  }

  function statHtml(num, label, warn) {
    return '<span class="qq-farm__stat' + (warn ? ' is-warn' : '') + '">' +
      '<b>' + num + '</b><small>' + label + '</small></span>';
  }

  function renderPanel(STORE, chatId) {
    var s = STORE.getState();
    var cal = STORE.calendarNow();

    var mature = 0, dry = 0, withered = 0, rivalMature = 0;
    s.plots.forEach(function (p) {
      if (!p) return;
      if (STORE.plotWithered(p)) { withered++; return; }
      if (STORE.plotMature(p)) { mature++; return; }
      if (!p.watered) dry++;
    });
    s.rivalPlots.forEach(function (p) {
      if (p && STORE.plotMature(p) && !STORE.plotWithered(p)) rivalMature++;
    });

    var currentName = resolveRivalName(chatId);
    var rivalLine;
    if (s.rival.chatId && String(s.rival.chatId) === String(chatId)) {
      rivalLine = '🕵️ 对手：' + esc(s.rival.name || '对方') +
        (rivalMature > 0 ? ' · 熟 ' + rivalMature + ' 块可偷！' : ' · TA的田还没熟');
    } else if (s.rival.chatId) {
      rivalLine = '🕵️ 当前对手：' + esc(s.rival.name || '对方') +
        ' · 进入后切换为「' + esc(currentName || '当前聊天对象') + '」';
    } else {
      rivalLine = '🕵️ 进入后绑定对手：' + esc(currentName || '当前聊天对象');
    }

    var mailRows = (s.mail || []).slice(0, MAX_LOG).map(function (m) {
      var mc = STORE.calendarNow(m.ts || Date.now());
      return '<div class="qq-farm__log-item">' + esc(m.icon + ' ' + m.text) +
        ' <i class="qq-farm__log-time">' + mc.dateText + '</i></div>';
    }).join('') || '<div class="qq-farm__empty">暂无动态 · 天气、乌鸦和对手的偷袭都会写信来</div>';

    return '<div class="qq-farm" id="qq-farm-panel">' +
      '<button type="button" class="qq-farm__head qq-farm__head--go" data-farmgo aria-label="进入星露农场">' +
        '<span class="qq-farm__title">🌱 星露农场</span>' +
        '<span class="qq-farm__go">进入 →</span>' +
      '</button>' +
      '<div class="qq-farm__hint">现实一天 = 游戏一天 · 作物按现实时间生长（浇水才长）· 熟了会被偷，别忘回来收</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__stat-grid">' +
          statHtml(mature, '熟 (块)', mature > 0) +
          statHtml(dry, '缺水 (块)', dry > 0) +
          statHtml(withered, '枯萎 (块)', withered > 0) +
          statHtml(rivalMature, '可偷 (块)', rivalMature > 0) +
        '</div>' +
        '<div class="qq-farm__meta">📅 ' + cal.dateText + ' · ' + cal.weekday + ' · ' + cal.season.name + '天</div>' +
        '<div class="qq-farm__meta">⚡ 体力 ' + s.energy + '/' + s.maxEnergy + '（每天 0 点回满） · 🪙 金币 ' + s.gold + '</div>' +
        '<div class="qq-farm__meta">' + rivalLine + '</div>' +
      '</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">农场动态</div>' +
        '<div class="qq-farm__log">' + mailRows + '</div>' +
      '</div>' +
      '<button type="button" class="qq-farm__btn qq-farm__btn--main qq-farm__enter" data-farmgo>进入星露农场 →</button>' +
      '</div>';
  }

  function renderPanelLoading() {
    return '<div class="qq-farm" id="qq-farm-panel">' +
      '<button type="button" class="qq-farm__head qq-farm__head--go" data-farmgo aria-label="进入星露农场">' +
        '<span class="qq-farm__title">🌱 星露农场</span>' +
        '<span class="qq-farm__go">进入 →</span>' +
      '</button>' +
      '<div class="qq-farm__hint">现实一天 = 游戏一天 · 速览加载中…</div>' +
      '<div class="qq-farm__empty">正在唤醒星露农场…</div>' +
      '</div>';
  }

  /* store, chatId 参数保留旧签名兼容（room 的调用点不变） */
  function openPanel(store, chatId, openOverlay, toast) {
    if (!openOverlay) return;
    openOverlay(shell(renderPanelLoading()));
    ensureStore().then(function (STORE) {
      if (!STORE) {
        openOverlay(shell(renderPanelLoading()));
        return;
      }
      try {
        STORE.sync();
        handleFarmEvents(STORE.takeEvents());
        migrateLegacyFarms();
        refreshSunBadge();
      } catch (e) {}
      openOverlay(shell(renderPanel(STORE, chatId)));
    });
  }

  /* 兼容旧接口：速览是纯状态展示，无就地操作 */
  function handlePanelClick(store, chatId, el, toast, openOverlay) {
    if (!el || !el.closest) return false;
    if (el.closest('[data-farmgo]')) return false;   /* 跳转由聊天室统一处理 */
    return false;
  }

  /* 常驻轻量轮询：熟地亮太阳（面板/农场里的动作也会即时触发刷新） */
  function startBadgeTimer() {
    if (badgeTimer) return;
    badgeTimer = setInterval(function () {
      if (document.hidden) return;
      refreshSunBadge();
    }, 60000);
  }

  /* 启动：延迟做一次迁移扫描 + 角标轮询 */
  setTimeout(function () {
    ensureStore().then(function () { migrateLegacyFarms(); });
    startBadgeTimer();
  }, 3500);

  global.MiyaChatFarm = {
    openPanel: openPanel,
    handlePanelClick: handlePanelClick,
    enterFarm: enterFarm,
    refreshSunBadge: refreshSunBadge,
    handleFarmEvents: handleFarmEvents,
    migrateLegacyFarms: migrateLegacyFarms,
    ensureStore: ensureStore
  };
})(window);
