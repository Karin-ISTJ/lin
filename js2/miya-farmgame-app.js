/* miya-farmgame-app.js — 星露农场 · UI 与交互层（v2 · 现实时钟制）
 *
 * 现实一天 = 游戏一天：作物按现实时间生长（浇水才长，离线也在长），
 * 成熟挂地超 24h 会枯萎；每天 0 点体力回满、天气掷签、浇水状态清零。
 *
 * 交互（沿用 v3 简洁化）：
 *   · 直接点地块就干活：空地播种 · 缺水浇水 · 缺肥施肥 · 熟了收获 · 枯萎锄掉
 *   · 动作按钮一键化；浇水/施肥/锄地播进度条；收获飘字（🍀/小动物也会来）。
 *   · 对手田（角色田）：角色自己种、浇、收，还会偷你的熟地；
 *     熟了的角色田可以直接偷回来。
 *   · 「睡觉按钮」已删除 —— 生长不再依赖过夜。
 * 数据层在 miya-farmgame-store.js，本文件只管渲染与交互。
 *
 * 打开方式：
 *   · 桌面「星露农场」图标 → APP_HANDLERS.farmgame → MiyaFarmGame.open()
 *   · 聊天页 🌱 速览 → MiyaFarmGame.open({ source:'chat', chatId, chatName })
 *     （记录来源，退出按来源回跳：聊天进 → 回原聊天；桌面进 → 回桌面）
 */
(function (global) {
  'use strict';

  var APP_ID = 'miya-farmgame-app';
  var STORE = global.MiyaFarmGameStore;

  var opened = false;
  var pendingSowPlot = -1;
  var busy = {};
  var openSource = 'desk';     /* 'desk' | 'chat' */
  var openChatId = '';
  var syncTimer = 0;

  /* ── 节奏常量 ── */
  var PROGRESS_MS = 1200;
  var BULK_STEP_MS = 900;
  var BULK_STAGGER_MS = 340;
  var HARVEST_STAGGER_MS = 260;
  var SYNC_INTERVAL_MS = 60000;   /* 农场开着时每分钟补算一次（倒计时/角色行为） */

  /* ── 操作提示 ── */
  var WATER_TOASTS = ['咕嘟咕嘟，浇好啦~', '水够啦~剩下的就交给时间吧~'];
  var FERT_TOASTS = ['撒一把魔法肥料～', '咕嘟咕嘟，营养渗进去啦~'];
  var waterAlt = 0, fertAlt = 0;
  function nextWater() { var m = WATER_TOASTS[waterAlt % WATER_TOASTS.length]; waterAlt++; return m; }
  function nextFert() { var m = FERT_TOASTS[fertAlt % FERT_TOASTS.length]; fertAlt++; return m; }

  /* ── BGM：进农场响起、退出暂停 ── */
  var BGM_URL = 'audio/farmgame/farm-bgm-1.mp3';
  var BGM_KEY = 'miya-farmgame-bgm';
  var bgmAudio = null;
  var bgmPending = false;

  function bgmPrefOn() {
    try { return localStorage.getItem(BGM_KEY) !== 'off'; } catch (e) { return true; }
  }
  function ensureBgm() {
    if (bgmAudio) return bgmAudio;
    bgmAudio = new Audio(BGM_URL);
    bgmAudio.loop = true;
    bgmAudio.volume = 0.38;
    return bgmAudio;
  }
  function bgmPlaying() { return !!bgmAudio && !bgmAudio.paused && !bgmAudio.ended; }
  /* play() 被自动播放策略拦下时：在 document 上挂一次性恢复。
     enterFarm 的 open() 走异步链，移动端 WebView 不认它是手势，
     用户进农场后第一次触摸屏幕（任意处）就把音乐续上。 */
  var bgmArm = null;
  function armBgmResume(force) {
    if (bgmArm) return;
    if (!force && !bgmPending) return;
    bgmArm = function () {
      document.removeEventListener('pointerdown', bgmArm, true);
      document.removeEventListener('touchstart', bgmArm, true);
      bgmArm = null;
      /* 已经在出声就不折腾；否则手势栈内重试 —— 手势内的 play()
         就是移动端认可的「解锁」，iOS unmute 失败的场景也靠这里救回 */
      if (bgmAudio && bgmPlaying() && !bgmAudio.muted) return;
      bgmPending = false;
      tryStartBgm();
    };
    document.addEventListener('pointerdown', bgmArm, true);
    document.addEventListener('touchstart', bgmArm, true);
  }
  function disarmBgmResume() {
    if (!bgmArm) return;
    document.removeEventListener('pointerdown', bgmArm, true);
    document.removeEventListener('touchstart', bgmArm, true);
    bgmArm = null;
  }
  function syncBgmBtn() {
    var btn = $('fg-bgm');
    if (!btn) return;
    btn.classList.toggle('is-on', bgmPlaying());
    btn.classList.toggle('is-off', !bgmPlaying());
  }
  function tryStartBgm() {
    if (!bgmPrefOn()) { syncBgmBtn(); return; }
    var a = ensureBgm();
    a.muted = false;
    var pr = a.play();
    if (pr && pr.catch) pr.catch(function () { bgmPending = true; armBgmResume(); });
    syncBgmBtn();
  }
  /* 手势同步栈内解锁音频（enterFarm 在点击时刻调用）：
     静音起播骗过自动播放策略——解锁过的元素之后随时可播可出声。
     open() 走异步链后 play() 不再被WebView 认作手势，必须提前在这里解锁。 */
  function unlockAudio() {
    if (!bgmPrefOn()) return false;
    var a = ensureBgm();
    if (bgmPlaying()) return true;
    a.muted = true;
    var pr = a.play();
    if (pr && pr.catch) pr.catch(function () { a.muted = false; bgmPending = true; });
    return true;
  }
  function stopBgm() {
    disarmBgmResume();
    if (bgmAudio) { bgmAudio.pause(); bgmAudio.muted = false; }
    bgmPending = false;
    syncBgmBtn();
  }
  function toggleBgm() {
    if (bgmPrefOn()) {
      try { localStorage.setItem(BGM_KEY, 'off'); } catch (e) {}
      stopBgm();
      toast('🔇 音乐已关');
    } else {
      try { localStorage.setItem(BGM_KEY, 'on'); } catch (e) {}
      tryStartBgm();
      toast(bgmPlaying() ? '🎵 晨雾漫过谷仓时' : '🎵 音乐稍后响起');
    }
  }

  /* ── 工具 ── */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getApp() { return $(APP_ID); }

  function toast(msg) {
    if (!msg) return;
    var box = $('fg-toasts');
    if (!box) {
      if (global.MiyaToast && typeof global.MiyaToast.show === 'function') { global.MiyaToast.show(msg); return; }
      if (typeof global.miyaToast === 'function') { global.miyaToast(msg); return; }
      box = document.createElement('div');
      box.id = 'fg-toasts';
      box.className = 'fg-toasts';
      var app = getApp();
      (app || document.body).appendChild(box);
    }
    var t = document.createElement('div');
    t.className = 'fg-toast';
    t.textContent = msg;
    while (box.children.length) box.removeChild(box.firstChild);
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, 1900);
  }

  function fmtDur(ms) {
    if (!ms || ms <= 0) return '马上';
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) {
      var d = Math.floor(h / 24);
      return d + '天' + (h % 24 ? (h % 24) + '小时' : '');
    }
    if (h > 0) return h + '小时' + (m ? m + '分' : '');
    return Math.max(1, m) + '分钟';
  }

  /* ── 地块飘字 ── */
  function gainFx(i, emoji, n, rival) {
    var plot = rival ? rivalPlotEl(i) : plotEl(i);
    if (!plot) return;
    plot.querySelectorAll('.fg-fx--gain').forEach(function (el) { el.remove(); });
    var el = document.createElement('span');
    el.className = 'fg-fx fg-fx--gain';
    el.innerHTML = '<i>' + emoji + '</i>+' + n;
    plot.appendChild(el);
    setTimeout(function () { el.remove(); }, 1300);
  }
  function gainFxLater(i, emoji, n, rival, delay) {
    setTimeout(function () { gainFx(i, emoji, n, rival); }, delay || 500);
  }

  function plotEl(i) { return document.querySelector('#fg-grid [data-plot="' + i + '"]'); }
  function rivalPlotEl(i) { return document.querySelector('#fg-rival-grid [data-rplot="' + i + '"]'); }

  /* ── 进度条 ── */
  function startProgress(i, ms, done, rival) {
    clearProgress(i, rival);
    busy[keyOf(i, rival)] = { end: Date.now() + ms, total: ms, timer: null, rival: !!rival, i: i };
    mountProgress(i, rival);
    busy[keyOf(i, rival)].timer = setTimeout(function () {
      var b = busy[keyOf(i, rival)];
      if (!b) return;
      delete busy[keyOf(i, rival)];
      var plot = rival ? rivalPlotEl(i) : plotEl(i);
      if (plot) {
        var bar = plot.querySelector('.fg-progress');
        if (bar) bar.remove();
        plot.classList.remove('is-busy');
      }
      if (done) done();
    }, ms + 40);
  }

  function keyOf(i, rival) { return (rival ? 'r' : 'p') + i; }

  function mountProgress(i, rival) {
    var b = busy[keyOf(i, rival)];
    var plot = rival ? rivalPlotEl(i) : plotEl(i);
    if (!b || !plot) return;
    var old = plot.querySelector('.fg-progress');
    if (old) old.remove();
    var bar = document.createElement('span');
    bar.className = 'fg-progress';
    var fill = document.createElement('i');
    var done = 1 - Math.max(0, b.end - Date.now()) / b.total;
    if (done > 0.02) fill.style.width = (done * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    plot.classList.add('is-busy');
    plot.appendChild(bar);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var left = Math.max(0, b.end - Date.now());
        fill.style.transitionDuration = left + 'ms';
        fill.style.width = '100%';
      });
    });
  }

  function clearProgress(i, rival) {
    var b = busy[keyOf(i, rival)];
    if (b && b.timer) clearTimeout(b.timer);
    delete busy[keyOf(i, rival)];
    var plot = rival ? rivalPlotEl(i) : plotEl(i);
    if (plot) {
      var bar = plot.querySelector('.fg-progress');
      if (bar) bar.remove();
      plot.classList.remove('is-busy');
    }
  }

  function clearAllBusy() {
    Object.keys(busy).forEach(function (k) {
      var b = busy[k];
      if (b) clearProgress(b.i, b.rival);
    });
  }

  function wave(idxs, stepMs, staggerMs, each, rival) {
    idxs.forEach(function (i, k) {
      setTimeout(function () {
        startProgress(i, stepMs, function () { each(i); }, rival);
      }, k * staggerMs);
    });
  }

  /* ── 同步：进农场/每分钟补算一次（生长/日结/角色行为），并分发事件 ── */
  function syncNow() {
    if (!STORE) return;
    STORE.sync();
    flushEvents();
  }

  function flushEvents() {
    var evs = STORE.takeEvents();
    if (!evs || !evs.length) return;
    evs.forEach(function (ev) {
      if (ev.type === 'rivalSteal') {
        toast('🕵️ ' + ev.name + '偷走了你的' + ev.cropIcon + ev.cropName + '！去TA的田反击');
        if (global.MiyaChatFarm && typeof global.MiyaChatFarm.handleFarmEvents === 'function') {
          global.MiyaChatFarm.handleFarmEvents([ev]);
        }
      }
    });
    if (global.MiyaChatFarm && typeof global.MiyaChatFarm.refreshSunBadge === 'function') {
      global.MiyaChatFarm.refreshSunBadge();
    }
  }

  /* ── 打开 / 关闭 ── */
  function open(opts) {
    var app = getApp();
    if (!app || !STORE) return;
    opts = opts && typeof opts === 'object' ? opts : {};
    if (opts.source === 'chat' && opts.chatId) {
      openSource = 'chat';
      openChatId = String(opts.chatId);
      STORE.setRival(openChatId, opts.chatName || '');
    } else {
      openSource = 'desk';
      openChatId = '';
    }
    app.hidden = false;
    app.setAttribute('aria-hidden', 'false');
    if (!opened) { bindEvents(app); opened = true; }
    syncNow();
    renderAll();
    tryStartBgm();
    /* 无论 play 是否被拦都挂触摸兜底：iOS 上「muted 预起播后 unmute」
       可能不生效且探测不到，首次触摸时在手势栈内重试必然解锁成功 */
    armBgmResume(true);
    STORE.hydrateFromIdb().then(function () { syncNow(); renderAll(); });
    if (!syncTimer) {
      syncTimer = setInterval(function () {
        if (!isOpened()) return;
        syncNow();
        renderAll();
      }, SYNC_INTERVAL_MS);
    }
  }

  function close() {
    var app = getApp();
    if (!app) return;
    STORE.save();
    stopBgm();
    if (syncTimer) { clearInterval(syncTimer); syncTimer = 0; }
    app.hidden = true;
    app.setAttribute('aria-hidden', 'true');
    closeSheet();
    /* 退出按来源回跳：聊天进 → 回原聊天界面（保持正在聊的人）；桌面进 → 回桌面 */
    if (openSource === 'chat' && openChatId) {
      var room = global.miyaChatRoom;
      if (room && typeof room.getOpenChatId === 'function' && room.getOpenChatId() !== openChatId &&
          typeof room.open === 'function') {
        room.open(openChatId);
      }
    }
    openSource = 'desk';
    openChatId = '';
    if (global.MiyaChatFarm && typeof global.MiyaChatFarm.refreshSunBadge === 'function') {
      global.MiyaChatFarm.refreshSunBadge();
    }
  }

  /* ── 渲染 ── */
  function renderAll() {
    if (!STORE) return;
    var s = STORE.getState();
    renderHead(s);
    renderActions(s);
    renderPlots(s);
    renderRival(s);
    renderFoot(s);
    var pc = $('fg-plotcount');
    if (pc) pc.textContent = '（' + STORE.plotCountFor(s.level) + ' 块地）';
    syncBgmBtn();
  }

  function renderHead(s) {
    var cal = STORE.calendarNow();
    $('fg-date').textContent = cal.season.icon + ' ' + cal.dateText + ' · ' + cal.season.name;
    $('fg-year').textContent = cal.weekday;
    var wm = weatherMeta(s.weather);
    $('fg-weather').textContent = wm.icon + ' ' + wm.name;

    $('fg-level').textContent = 'Lv.' + s.level + ' 休闲农场主';
    $('fg-expbar').style.width = Math.min(100, s.exp / STORE.expNeeded(s.level) * 100) + '%';
    $('fg-expneed').textContent = '距离升级还需 ' + Math.max(0, STORE.expNeeded(s.level) - s.exp) + ' 经验';
    $('fg-gold').textContent = s.gold;

    var eb = $('fg-energybar'), en = $('fg-energynum');
    if (eb) eb.style.width = (s.energy / s.maxEnergy * 100) + '%';
    if (en) en.textContent = s.energy + '/' + s.maxEnergy;

    var unread = STORE.unreadMailCount();
    var dot = $('fg-maildot');
    dot.hidden = unread <= 0;
    dot.textContent = unread > 9 ? '9+' : unread;
  }

  function weatherMeta(id) {
    return STORE.WEATHER.filter(function (w) { return w.id === id; })[0] ||
      { icon: '☀️', name: '晴天' };
  }

  function renderActions(s) {
    var fert = $('fg-act-fert');
    fert.classList.toggle('is-locked', !STORE.hasFert(s.level));
    fert.title = STORE.hasFert(s.level) ? '一键给所有缺肥的作物施肥' : 'Lv.3 解锁施肥';

    var bulk = $('fg-act-bulk');
    bulk.classList.toggle('is-locked', !STORE.hasBulkHarvest(s.level));
    bulk.querySelector('span').textContent = STORE.hasBulkHarvest(s.level)
      ? '✨ 一键收获' : '✨ 一键收获 Lv.5';

    ['sow', 'water', 'fert', 'hoe'].forEach(function (m) {
      var btn = $('fg-act-' + m);
      btn.classList.toggle('is-tired', s.energy < STORE.ENERGY_COST[m]);
    });

    var hint = $('fg-hint');
    hint.textContent = '点地块干活：空地播种 · 缺水浇水 · 缺肥施肥 · 熟了收获 · 枯了锄掉';
  }

  /* 地块小标签：倒计时 / 缺水 / 枯萎 */
  function plotTimerText(p) {
    if (STORE.plotWithered(p)) return '枯了 · 点它清理';
    if (STORE.plotMature(p)) {
      var wr = STORE.plotWitherRemainMs(p);
      if (wr >= 0 && wr <= 4 * 3600000) return '⏳ ' + fmtDur(wr) + '后枯萎';
      return '熟了，快收';
    }
    if (!p.watered) return '缺水 · 不长个';
    return fmtDur(STORE.plotRemainMs(p)) + '后熟';
  }

  function plotHtml(p, i, rival) {
    var cls = 'fg-plot';
    var inner = '';
    if (p) {
      var c = STORE.CROPS[p.crop];
      var stage = STORE.plotStage(p);
      var mature = STORE.plotMature(p);
      if (STORE.plotWithered(p)) {
        cls += ' is-withered';
        inner = '<span class="fg-plot__crop">🥀</span>';
      } else {
        if (mature) cls += ' is-mature';
        if (p.watered) cls += ' is-watered';
        inner =
          '<span class="fg-plot__crop' + (mature ? ' fg-plot__crop--mature' : '') + '">' + c.stages[stage] + '</span>' +
          (p.fertToday ? '<span class="fg-plot__fert">✨</span>' : '') +
          (mature ? '<span class="fg-plot__shine" aria-hidden="true"><i>✨</i><i>✨</i><i>✨</i></span>' : '');
      }
      inner += '<span class="fg-plot__timer">' + plotTimerText(p) + '</span>';
    } else if (!rival) {
      cls += ' is-empty';
      inner = '<span class="fg-plot__plus">+</span>';
    } else {
      cls += ' is-empty is-rival-empty';
      inner = '<span class="fg-plot__plus">·</span>';
    }
    var attr = rival ? 'data-rplot="' + i + '"' : 'data-plot="' + i + '"';
    var label = rival ? '对手农田 ' + (i + 1) : '农田 ' + (i + 1);
    return '<button type="button" class="' + cls + '" ' + attr + ' aria-label="' + label + '">' + inner + '</button>';
  }

  function renderGrid(elId, list, count, rival) {
    var grid = $(elId);
    if (!grid) return;
    var html = '';
    for (var i = 0; i < count; i++) {
      html += plotHtml(list[i], i, rival);
    }
    grid.innerHTML = html;
    Object.keys(busy).forEach(function (k) {
      var b = busy[k];
      if (b) mountProgress(b.i, b.rival);
    });
  }

  function renderPlots(s) {
    renderGrid('fg-grid', s.plots, STORE.plotCountFor(s.level), false);
  }

  function renderRival(s) {
    var section = $('fg-rival-section');
    if (!section) return;
    var hasRival = !!s.rival.chatId;
    section.hidden = !hasRival;
    if (!hasRival) return;
    var title = $('fg-rival-title');
    var stealable = 0;
    s.rivalPlots.forEach(function (p) { if (p && STORE.plotMature(p) && !STORE.plotWithered(p)) stealable++; });
    if (title) {
      title.innerHTML = esc((s.rival.name || '对手') + ' 的农田') +
        (stealable > 0 ? ' <small class="fg-rival-hot">熟 ' + stealable + ' 块 · 可以偷！</small>' : ' <small>TA 自己会照料</small>');
    }
    renderGrid('fg-rival-grid', s.rivalPlots, STORE.RIVAL_PLOT_COUNT, true);
  }

  function renderPlotCell(i, rival) {
    var s = STORE.getState();
    var grid = $(rival ? 'fg-rival-grid' : 'fg-grid');
    if (!grid) return;
    var attr = rival ? 'rplot' : 'plot';
    var old = grid.querySelector('[data-' + attr + '="' + i + '"]');
    if (!old) return;
    var p = rival ? s.rivalPlots[i] : s.plots[i];
    var tmp = document.createElement('div');
    tmp.innerHTML = plotHtml(p, i, rival);
    old.replaceWith(tmp.firstChild);
  }

  function renderFoot(s) {
    $('fg-daycount').textContent = '已打理 ' + s.stats.daysPlayed + ' 天';
  }

  /* ── 动作执行 ── */

  function spendEnergy(n) {
    var s = STORE.getState();
    if (s.energy < n) { toast('💤 体力不够了，明天 0 点回满'); return false; }
    s.energy -= n;
    return true;
  }

  /* 播种（单块） */
  function doSow(i, cropId) {
    var c = STORE.CROPS[cropId];
    var s = STORE.getState();
    if (s.plots[i]) { toast('这块地已经种了'); return; }
    if (c.seasons.indexOf(STORE.seasonNow()) < 0) {
      toast(c.name + '不是当季作物'); return;
    }
    if (!STORE.spendGold(c.seedPrice)) { toast('🪙 金币不够，先卖点仓库作物吧'); return; }
    if (!spendEnergy(STORE.ENERGY_COST.sow)) { STORE.gainGold(c.seedPrice); return; }
    s.plots[i] = STORE.newPlot(cropId);
    STORE.save();
    renderHead(s);
    closeSheet();
    renderPlotCell(i);
    toast('🌱 播下' + c.name + '，浇水才长个');
  }

  /* 一键播种 */
  function bulkSow(cropId) {
    var c = STORE.CROPS[cropId];
    var s = STORE.getState();
    if (c.seasons.indexOf(STORE.seasonNow()) < 0) {
      toast(c.name + '不是当季作物'); return;
    }
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) if (!s.plots[i]) targets.push(i);
    if (!targets.length) { toast('没有空地了，先收收获获吧'); return; }
    var per = STORE.ENERGY_COST.sow;
    var byEnergy = Math.floor(s.energy / per);
    var byGold = Math.floor(s.gold / c.seedPrice);
    var m = Math.min(targets.length, byEnergy, byGold);
    if (!m) {
      toast(s.gold < c.seedPrice ? '🪙 金币不够，先卖点仓库作物吧' : '💤 体力不够了，明天 0 点回满');
      return;
    }
    if (m < targets.length) toast('量力而行：这次只种得下 ' + m + ' 块');
    targets = targets.slice(0, m);
    STORE.spendGold(c.seedPrice * m);
    s.energy -= per * m;
    targets.forEach(function (i) { s.plots[i] = STORE.newPlot(cropId); });
    STORE.save();
    renderHead(s);
    closeSheet();
    renderAll();
    toast('🌱 播下' + c.name + '，浇水才长个');
  }

  /* 浇水（单块） */
  function doWater(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p || p.watered) return;
    if (STORE.plotMature(p) || STORE.plotWithered(p)) return;
    if (!spendEnergy(STORE.ENERGY_COST.water)) return;
    p.watered = true;
    STORE.save();
    renderHead(s);
    startProgress(i, PROGRESS_MS, function () {
      renderPlotCell(i);
      toast('💧 ' + nextWater());
    });
  }

  /* 一键浇水 */
  function bulkWater() {
    var s = STORE.getState();
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && !p.watered && !STORE.plotMature(p) && !STORE.plotWithered(p)) targets.push(i);
    }
    if (!targets.length) { toast('💧 都浇过水啦'); return; }
    var per = STORE.ENERGY_COST.water;
    var m = Math.min(targets.length, Math.floor(s.energy / per));
    if (!m) { toast('💤 体力不够了，明天 0 点回满'); return; }
    if (m < targets.length) toast('💤 体力只够浇 ' + m + ' 块');
    targets = targets.slice(0, m);
    s.energy -= per * m;
    targets.forEach(function (i) { s.plots[i].watered = true; });
    STORE.save();
    renderHead(s);
    wave(targets, BULK_STEP_MS, BULK_STAGGER_MS, function (i) {
      renderPlotCell(i);
      toast('💧 ' + nextWater());
    });
  }

  /* 施肥（单块） */
  function doFert(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p || p.fert) return;
    if (!spendEnergy(STORE.ENERGY_COST.fert)) return;
    p.fert = true; p.fertToday = true;
    STORE.save();
    renderHead(s);
    startProgress(i, PROGRESS_MS, function () {
      renderPlotCell(i);
      toast('✨ ' + nextFert());
    });
  }

  /* 一键施肥 */
  function bulkFert() {
    var s = STORE.getState();
    if (!STORE.hasFert(s.level)) { toast('✨ 施肥 Lv.3 解锁'); return; }
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && !p.fert && !STORE.plotMature(p) && !STORE.plotWithered(p)) targets.push(i);
    }
    if (!targets.length) { toast('✨ 都施过肥啦'); return; }
    var per = STORE.ENERGY_COST.fert;
    var m = Math.min(targets.length, Math.floor(s.energy / per));
    if (!m) { toast('💤 体力不够了，明天 0 点回满'); return; }
    if (m < targets.length) toast('💤 体力只够施 ' + m + ' 块');
    targets = targets.slice(0, m);
    s.energy -= per * m;
    targets.forEach(function (i) { s.plots[i].fert = true; s.plots[i].fertToday = true; });
    STORE.save();
    renderHead(s);
    wave(targets, BULK_STEP_MS, BULK_STAGGER_MS, function (i) {
      renderPlotCell(i);
      toast('✨ ' + nextFert());
    });
  }

  /* 锄头：枯萎 = 清理（不退钱）；生长中 = 挖掉返一半种子钱 */
  function doHoe(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) return;
    var c = STORE.CROPS[p.crop];
    var withered = STORE.plotWithered(p);
    if (!withered && STORE.plotMature(p)) { toast('都熟了，直接点它收获吧'); return; }
    if (!spendEnergy(STORE.ENERGY_COST.hoe)) return;
    s.plots[i] = null;
    var back = withered ? 0 : Math.floor(c.seedPrice / 2);
    if (back > 0) STORE.gainGold(back);
    STORE.save();
    renderHead(s);
    var plot = plotEl(i);
    if (plot) plot.classList.add('is-vanishing');
    startProgress(i, PROGRESS_MS, function () {
      renderPlotCell(i);
      toast(withered ? '🥀 清掉了枯萎的' + c.name
        : '⛏ 锄掉了' + c.name + (back > 0 ? '，退 ' + back + ' 金币' : ''));
    });
  }

  function doHoeAll() {
    var s = STORE.getState();
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && !STORE.plotMature(p)) targets.push(i);
    }
    if (!targets.length) { toast('没有可锄的作物'); return; }
    var per = STORE.ENERGY_COST.hoe;
    var m = Math.min(targets.length, Math.floor(s.energy / per));
    if (!m) { toast('💤 体力不够了，明天 0 点回满'); return; }
    targets = targets.slice(0, m);
    var backSum = 0;
    targets.forEach(function (i) {
      var p = s.plots[i];
      if (!STORE.plotWithered(p)) backSum += Math.floor(STORE.CROPS[p.crop].seedPrice / 2);
      s.plots[i] = null;
      var plot = plotEl(i);
      if (plot) plot.classList.add('is-vanishing');
    });
    s.energy -= per * m;
    if (backSum > 0) STORE.gainGold(backSum);
    STORE.save();
    renderHead(s);
    closeSheet();
    toast('⛏ 一键锄掉 ' + m + ' 块…');
    wave(targets, BULK_STEP_MS, BULK_STAGGER_MS, function (i) {
      renderPlotCell(i);
    });
  }

  /* 收获（单块）：彩蛋 —— 🍂 四叶草 6%、小动物 12%（概率池随失手上升） */
  function harvestPlot(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) return;
    var c = STORE.CROPS[p.crop];
    if (!STORE.plotMature(p)) return;
    if (STORE.plotWithered(p)) { toast('已经枯了，点它清理吧'); return; }
    var yieldN = 1 + (p.fert ? 1 : 0);
    s.barn[c.id] = (s.barn[c.id] || 0) + yieldN;
    s.stats.harvested += yieldN;
    var bonus = STORE.rollHarvestBonuses(s);
    var ups = STORE.addExp(c.exp * yieldN);
    s.plots[i] = null;
    STORE.save();
    renderHead(s);
    renderPlotCell(i);
    gainFx(i, c.icon, yieldN);
    toast('✨ 收获' + c.name + ' +' + yieldN);
    playBonusFx(i, bonus);
    announceLevelUps(ups);
  }

  function playBonusFx(i, bonus, rival) {
    if (bonus && bonus.fourleaf) {
      gainFxLater(i, '🍀', 1, rival, 450);
      toast('🍀 幸运四叶草 +1！');
    }
    if (bonus && bonus.animal) {
      var a = bonus.animal;
      gainFxLater(i, a.icon, 1, rival, bonus.fourleaf ? 850 : 450);
      toast(a.icon + ' ' + a.name + ' 被吸引来了！+' + a.sellPrice + ' 金币的宝贝');
    }
  }

  /* 一键收获 */
  function bulkHarvest() {
    var s = STORE.getState();
    if (!STORE.hasBulkHarvest(s.level)) { toast('「一键收获」Lv.5 解锁'); return; }
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && STORE.plotMature(p) && !STORE.plotWithered(p)) targets.push(i);
    }
    if (!targets.length) { toast('🌾 没有成熟的作物'); return; }
    var total = 0, expSum = 0, crops = {}, meta = [], bonuses = [];
    targets.forEach(function (i) {
      var p = s.plots[i];
      var c = STORE.CROPS[p.crop];
      var y = 1 + (p.fert ? 1 : 0);
      crops[c.id] = (crops[c.id] || 0) + y;
      meta.push({ i: i, icon: c.icon, name: c.name, y: y });
      total += y;
      expSum += c.exp * y;
      bonuses.push({ i: i, bonus: STORE.rollHarvestBonuses(s) });
      s.plots[i] = null;
    });
    Object.keys(crops).forEach(function (k) { s.barn[k] = (s.barn[k] || 0) + crops[k]; });
    s.stats.harvested += total;
    var ups = STORE.addExp(expSum);
    STORE.save();
    renderHead(s);
    meta.forEach(function (m, k) {
      setTimeout(function () {
        renderPlotCell(m.i);
        gainFx(m.i, m.icon, m.y);
        toast('✨ 收获' + m.name + ' +' + m.y);
      }, k * HARVEST_STAGGER_MS);
    });
    bonuses.forEach(function (b, k) {
      setTimeout(function () { playBonusFx(b.i, b.bonus); }, k * HARVEST_STAGGER_MS);
    });
    announceLevelUps(ups);
  }

  /* ── 偷角色田 ── */
  function doStealRival(i) {
    var r = STORE.stealRivalPlot(i);
    if (!r.ok) { toast(r.error || '偷不了'); return; }
    renderHead(STORE.getState());
    renderRival(STORE.getState());
    gainFx(i, r.crop.icon, 1, true);
    toast('🥷 偷到了' + r.crop.name + '，已入仓！');
    playBonusFx(i, r.bonus, true);
  }

  function announceLevelUps(ups) {
    if (!ups || !ups.length) return;
    STORE.unlockTexts(ups).forEach(function (u) {
      STORE.addMail('🎉', '升到 Lv.' + u.level + '！' + u.text);
    });
    STORE.save();
    toast('🎉 升级！Lv.' + ups[ups.length - 1]);
  }

  /* ── 浮层（种子 / 锄头 / 仓库 / 信箱） ── */
  function closeSheet() {
    var sheet = $('fg-sheet');
    if (sheet) {
      sheet.hidden = true;
      sheet.innerHTML = '';
    }
    pendingSowPlot = -1;
  }

  function openSheet(html) {
    var sheet = $('fg-sheet');
    sheet.innerHTML = html;
    sheet.hidden = false;
  }

  function sheetHead(title) {
    return '<div class="fg-sheet__head"><h3>' + title +
      '</h3><button type="button" class="fg-sheet__close" data-fg-close>×</button></div>';
  }

  function openSeedSheet(plotIdx) {
    var s = STORE.getState();
    var seasonId = STORE.seasonNow();
    var season = STORE.SEASONS.filter(function (x) { return x.id === seasonId; })[0] || STORE.SEASONS[0];
    var crops = STORE.seasonCrops(seasonId);
    pendingSowPlot = plotIdx;
    var emptyCount = 0;
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) if (!s.plots[i]) emptyCount++;

    var title = plotIdx >= 0
      ? '🌱 选种子 · 播到农田 ' + (plotIdx + 1)
      : '🌱 选种子 · 种满 ' + emptyCount + ' 块空地';
    var rows = crops.map(function (id) {
      var c = STORE.CROPS[id];
      var afford = s.gold >= c.seedPrice * (plotIdx >= 0 ? 1 : Math.max(1, emptyCount));
      return '<button type="button" class="fg-seed' + (afford ? '' : ' is-poor') + '" data-seed="' + id + '">' +
        '<span class="fg-seed__icon">' + c.icon + '</span>' +
        '<span class="fg-seed__meta"><b>' + esc(c.name) + '</b>' +
        '<small>卖 ' + c.sellPrice + ' 金币 · ' + c.hours + '小时熟</small></span>' +
        '<span class="fg-seed__price">' + c.seedPrice + '🪙' + (plotIdx < 0 ? '/块' : '') + '</span>' +
        '</button>';
    }).join('');
    openSheet(
      sheetHead(title) +
      '<div class="fg-seed-list">' + rows + '</div>' +
      '<p class="fg-sheet__tip">' + season.icon + ' ' + season.name + '季当令 · ' +
      (plotIdx >= 0
        ? '金币 ' + s.gold + ' · 种下后记得浇水，浇水才长'
        : '一键播满 ' + emptyCount + ' 块空地 · 种下后记得浇水') + '</p>'
    );
  }

  function openHoeSheet() {
    var s = STORE.getState();
    var rows = '';
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (!p) continue;
      var c = STORE.CROPS[p.crop];
      if (STORE.plotMature(p)) continue;
      var withered = STORE.plotWithered(p);
      rows += '<div class="fg-barn-row" data-hoe="' + i + '">' +
        '<span class="fg-barn-row__icon">' + (withered ? '🥀' : c.icon) + '</span>' +
        '<span class="fg-barn-row__meta"><b>' + esc(c.name) + (withered ? '（枯萎）' : '') + '</b>' +
        '<small>' + (withered ? '清理枯地，不返钱' : '锄掉返还 ' + Math.floor(c.seedPrice / 2) + ' 金币') + '</small></span>' +
        '<span class="fg-barn-row__btns">' +
        '<button type="button" class="fg-mini" data-hoe-one>' + (withered ? '清理' : '挖掉') + '</button>' +
        '</span></div>';
    }
    openSheet(
      sheetHead('⛏ 锄头 · 清理农田') +
      (rows
        ? '<div class="fg-barn-list">' + rows + '</div>' +
          '<button type="button" class="fg-btn fg-btn--wide" data-hoe-all>⛏ 全部锄掉</button>'
        : '<p class="fg-sheet__tip">没有可锄的作物，成熟的直接点它收获吧。</p>')
    );
  }

  function openBarnSheet() {
    var s = STORE.getState();
    var ids = Object.keys(s.barn).filter(function (k) { return s.barn[k] > 0 && STORE.itemMeta(k); });
    var rows = ids.map(function (id) {
      var c = STORE.itemMeta(id);
      var tag = STORE.BONUS[id] ? (id === 'fourleaf' ? ' · 幸运' : ' · 动物') : '';
      return '<div class="fg-barn-row" data-barn="' + id + '">' +
        '<span class="fg-barn-row__icon">' + c.icon + '</span>' +
        '<span class="fg-barn-row__meta"><b>' + esc(c.name) + ' ×' + s.barn[id] + esc(tag) + '</b>' +
        '<small>单价 ' + c.sellPrice + ' 金币</small></span>' +
        '<span class="fg-barn-row__btns">' +
        '<button type="button" class="fg-mini" data-sell-one>卖 1</button>' +
        '<button type="button" class="fg-mini fg-mini--gold" data-sell-all>全卖</button>' +
        '</span></div>';
    }).join('');
    openSheet(
      sheetHead('🧺 仓库 · 卖出') +
      (rows ? '<div class="fg-barn-list">' + rows + '</div>' : '<p class="fg-sheet__tip">仓库空空的，先去收获点什么吧。</p>') +
      (rows ? '<button type="button" class="fg-btn fg-btn--wide" data-sell-everything>全部卖出</button>' : '')
    );
  }

  function openMailSheet() {
    var s = STORE.getState();
    var rows = s.mail.map(function (m) {
      var cal = STORE.calendarNow(m.ts || Date.now());
      return '<div class="fg-mail-row' + (m.read ? '' : ' is-unread') + '">' +
        '<span class="fg-mail-row__icon">' + esc(m.icon) + '</span>' +
        '<div class="fg-mail-row__body"><b>' + esc(m.text) + '</b>' +
        '<small>' + cal.dateText + ' · ' + cal.weekday + '</small></div>' +
        '</div>';
    }).join('');
    openSheet(
      sheetHead('📬 农场信箱') +
      (rows ? '<div class="fg-mail-list">' + rows + '</div>' : '<p class="fg-sheet__tip">还没有来信。天气、乌鸦、对手的偷袭和升级都会写信来。</p>')
    );
    s.mail.forEach(function (m) { m.read = true; });
    STORE.save();
    renderHead(s);
  }

  function sellCrop(id, all) {
    var s = STORE.getState();
    var have = s.barn[id] || 0;
    if (!have) return;
    var n = all ? have : 1;
    var c = STORE.itemMeta(id);
    if (!c) return;
    var gold = c.sellPrice * n;
    s.barn[id] = have - n;
    STORE.gainGold(gold);
    s.stats.earned += gold;
    STORE.save();
    renderAll();
    toast('🪙 卖出 ' + c.name + ' ×' + n + '，+' + gold + ' 金币');
    var sheet = $('fg-sheet');
    if (sheet && !sheet.hidden && sheet.querySelector('[data-barn]')) openBarnSheet();
  }

  function resetGame() {
    if (!global.confirm || global.confirm('重开农场？金币、等级、仓库全部清零，存档不可恢复。')) {
      STORE.resetSave();
      clearAllBusy();
      closeSheet();
      renderAll();
      toast('🌱 新农场开张，祝丰收！');
    }
  }

  /* ── 点地块：看状态直接干活 ── */
  function onPlotTap(i) {
    if (busy[keyOf(i, false)]) return;
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) { openSeedSheet(i); return; }
    if (STORE.plotWithered(p)) { doHoe(i); return; }
    if (STORE.plotMature(p)) { harvestPlot(i); return; }
    if (!p.watered) { doWater(i); return; }
    if (!p.fert && STORE.hasFert(s.level)) { doFert(i); return; }
    toast(p.fert ? '💤 都伺候好了，等它长大吧' : '💤 等它长大吧（施肥 Lv.3 解锁）');
  }

  /* 点角色田：只有熟地能偷 */
  function onRivalTap(i) {
    if (busy[keyOf(i, true)]) return;
    var s = STORE.getState();
    var p = s.rivalPlots[i];
    if (!p) { toast('TA还没种上，等等再来'); return; }
    if (STORE.plotWithered(p)) { toast('枯了，TA自己会清理'); return; }
    if (!STORE.plotMature(p)) {
      toast('还没熟，等' + fmtDur(STORE.plotRemainMs(p)) + '再来偷');
      return;
    }
    doStealRival(i);
  }

  /* ── 事件绑定（委托，只绑一次） ── */
  function bindEvents(root) {
    root.addEventListener('click', function (e) {
      var t = e.target;

      if (bgmPending) { bgmPending = false; tryStartBgm(); }

      if (t.closest && t.closest('[data-fg-bgm-toggle]')) { toggleBgm(); return; }

      var closeBtn = t.closest && t.closest('[data-fg-close]');
      if (closeBtn) { closeSheet(); return; }

      var seedBtn = t.closest && t.closest('[data-seed]');
      if (seedBtn) {
        var cropId = seedBtn.getAttribute('data-seed');
        if (pendingSowPlot >= 0) doSow(pendingSowPlot, cropId);
        else bulkSow(cropId);
        return;
      }

      var hoeRow = t.closest && t.closest('[data-hoe]');
      if (hoeRow) {
        if (t.closest('[data-hoe-one]')) { doHoe(parseInt(hoeRow.getAttribute('data-hoe'), 10)); return; }
        return;
      }
      if (t.closest && t.closest('[data-hoe-all]')) { doHoeAll(); return; }

      var barnRow = t.closest && t.closest('[data-barn]');
      if (barnRow) {
        var id = barnRow.getAttribute('data-barn');
        if (t.closest('[data-sell-all]')) { sellCrop(id, true); return; }
        if (t.closest('[data-sell-one]')) { sellCrop(id, false); return; }
        return;
      }
      if (t.closest && t.closest('[data-sell-everything]')) {
        var s = STORE.getState();
        Object.keys(s.barn).forEach(function (k) { if (s.barn[k] > 0) sellCrop(k, true); });
        return;
      }

      if (t.closest && t.closest('[data-fg-mail-open]')) { openMailSheet(); return; }
      if (t.closest && t.closest('[data-fg-barn-open]')) { openBarnSheet(); return; }
      if (t.closest && t.closest('[data-fg-save]')) { STORE.save(); toast('🍃 已存档'); return; }
      if (t.closest && t.closest('[data-fg-reset]')) { resetGame(); return; }
      if (t.closest && t.closest('[data-fg-bulk]')) { bulkHarvest(); return; }
      if (t.closest && t.closest('[data-fg-exit]')) { close(); return; }

      var act = t.closest && t.closest('[data-fg-act]');
      if (act) {
        var m = act.getAttribute('data-fg-act');
        if (m === 'sow') openSeedSheet(-1);
        else if (m === 'water') bulkWater();
        else if (m === 'fert') bulkFert();
        else if (m === 'hoe') openHoeSheet();
        return;
      }

      var rplot = t.closest && t.closest('[data-rplot]');
      if (rplot) { onRivalTap(parseInt(rplot.getAttribute('data-rplot'), 10)); return; }

      var plot = t.closest && t.closest('[data-plot]');
      if (plot) { onPlotTap(parseInt(plot.getAttribute('data-plot'), 10)); return; }

      if (t.id === 'fg-sheet') { closeSheet(); return; }
    });
  }

  global.MiyaFarmGame = {
    open: open,
    close: close,
    unlockAudio: unlockAudio,
    isOpened: function () { var a = getApp(); return !!a && !a.hidden; }
  };
})(typeof window !== 'undefined' ? window : self);
