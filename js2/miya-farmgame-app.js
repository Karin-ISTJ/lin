/* miya-farmgame-app.js — 星露农场 · UI 与交互层
 *
 * 回合制小农场：播种→浇水→过夜生长→收获→卖出→升级开地。
 *
 * 交互（v3 简洁化）：
 *   · 直接点地块就干活，看地块状态自动判断：
 *     空地 → 选种播种（直接种好）· 缺水 → 浇水 · 缺肥 → 施肥 · 成熟 → 收获
 *   · 动作按钮一键化：播种=选种后种满空地，浇水/施肥=全田一键，
 *     锄头=面板勾选清理，「一键收获」保留。
 *   · 浇水/施肥/锄地在地块上播放进度条（单块 3 秒，一键波浪式快速过）；
 *     播种不需要进度条，直接完成。
 *   · 所有提示集中在屏幕中间的提示框（不再逐块冒气泡）。
 *   · 收获即时：作物直接消失 + 地块上方小「🍇+1」飘字上升渐隐。
 *   · 浇过的地块整块变深（湿土色）即代表浇过水，无 💧 角标。
 * 数据层在 miya-farmgame-store.js，本文件只管渲染与交互。
 *
 * 打开方式：桌面「星露农场」图标 → APP_HANDLERS.farmgame → MiyaFarmGame.open()
 * （懒加载组 farmUiGame 先确保 store/app 就绪）
 */
(function (global) {
  'use strict';

  var APP_ID = 'miya-farmgame-app';
  var STORE = global.MiyaFarmGameStore;

  var opened = false;
  var pendingSowPlot = -1;   /* 种子面板服务的地块下标；-1 = 一键种满空地 */
  var busy = {};             /* 地块动画中：i -> { end, total, timer } */

  /* ── 节奏常量 ── */
  var PROGRESS_MS = 3000;      /* 单块操作：进度条 3 秒 */
  var BULK_STEP_MS = 900;      /* 一键操作：单块进度条时长 */
  var BULK_STAGGER_MS = 340;   /* 一键操作：地块依次错开启动 */
  var HARVEST_STAGGER_MS = 260;/* 一键收获：逐块动效间隔 */

  /* ── 操作提示（随机 pool，每次干完活抽一句） ── */
  var WATER_TOASTS = ['咕嘟咕嘟，浇好啦~', '水够啦~剩下的就交给时间吧~'];
  var FERT_TOASTS = ['撒一把魔法肥料～', '咕嘟咕嘟，营养渗进去啦~'];

  /* ── 工具 ── */
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getApp() { return $(APP_ID); }

  /* ── 屏幕中间提示框：所有操作反馈都显示在这里 ── */
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
    box.appendChild(t);
    while (box.children.length > 2) box.removeChild(box.firstChild);
    setTimeout(function () { t.remove(); }, 1900);
  }

  /* ── 地块飘字：小尺寸「🍇+1」上升渐隐（收获用） ── */
  function gainFx(i, emoji, n) {
    var plot = plotEl(i);
    if (!plot) return;
    plot.querySelectorAll('.fg-fx--gain').forEach(function (el) { el.remove(); });
    var el = document.createElement('span');
    el.className = 'fg-fx fg-fx--gain';
    el.innerHTML = '<i>' + emoji + '</i>+' + n;
    plot.appendChild(el);
    setTimeout(function () { el.remove(); }, 1300);
  }

  function plotEl(i) { return document.querySelector('#fg-grid [data-plot="' + i + '"]'); }

  /* ── 进度条：土地上的劳作进度（3 秒 / 一键快速） ── */
  function startProgress(i, ms, done) {
    clearProgress(i);
    busy[i] = { end: Date.now() + ms, total: ms, timer: null };
    mountProgress(i);
    busy[i].timer = setTimeout(function () {
      var b = busy[i];
      if (!b) return;             /* 已被 nextDay/重置清掉 */
      delete busy[i];
      var plot = plotEl(i);
      if (plot) {
        var bar = plot.querySelector('.fg-progress');
        if (bar) bar.remove();
        plot.classList.remove('is-busy');
      }
      if (done) done();
    }, ms + 40);
  }

  function mountProgress(i) {
    var b = busy[i];
    var plot = plotEl(i);
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

  function clearProgress(i) {
    var b = busy[i];
    if (b && b.timer) clearTimeout(b.timer);
    delete busy[i];
    var plot = plotEl(i);
    if (plot) {
      var bar = plot.querySelector('.fg-progress');
      if (bar) bar.remove();
      plot.classList.remove('is-busy');
    }
  }

  function clearAllBusy() {
    Object.keys(busy).forEach(function (k) { clearProgress(+k); });
  }

  /* 一键波浪：地块依次启动进度条，完成后逐块回调 */
  function wave(idxs, stepMs, staggerMs, each) {
    idxs.forEach(function (i, k) {
      setTimeout(function () {
        startProgress(i, stepMs, function () { each(i); });
      }, k * staggerMs);
    });
  }

  /* ── 打开 / 关闭 ── */
  function open() {
    var app = getApp();
    if (!app || !STORE) return;
    app.hidden = false;
    app.setAttribute('aria-hidden', 'false');
    if (!opened) { bindEvents(app); opened = true; }
    renderAll();
    /* IDB 水合完成后重渲染：冷启动时同步读可能只拿到占位符，
       真档在 IDB 里，异步取回后需要刷新一次界面 */
    STORE.hydrateFromIdb().then(function () { renderAll(); });
  }

  function close() {
    var app = getApp();
    if (!app) return;
    STORE.save();
    app.hidden = true;
    app.setAttribute('aria-hidden', 'true');
    closeSheet();
  }

  /* ── 渲染 ── */
  function renderAll() {
    if (!STORE) return;
    var s = STORE.getState();
    renderHead(s);
    renderActions(s);
    renderPlots(s);
    renderFoot(s);
    var pc = $('fg-plotcount');
    if (pc) pc.textContent = '（' + STORE.plotCountFor(s.level) + ' 块地）';
  }

  function renderHead(s) {
    var cal = STORE.calendarOf(s.day);
    $('fg-year').textContent = '第 ' + cal.year + ' 年';
    $('fg-date').textContent = cal.season.icon + ' ' + cal.season.name + '月' + numCN(cal.day) + '日';
    $('fg-weather').textContent = weatherMeta(s.weather).icon + ' ' + weatherMeta(s.weather).name;

    $('fg-level').textContent = 'Lv.' + s.level + ' 休闲农场主';
    $('fg-expbar').style.width = Math.min(100, s.exp / STORE.expNeeded(s.level) * 100) + '%';
    $('fg-expneed').textContent = '距离升级还需 ' + Math.max(0, STORE.expNeeded(s.level) - s.exp) + ' 经验';
    $('fg-gold').textContent = s.gold;

    /* 体力即时刷新（动画期间也会调） */
    var eb = $('fg-energybar'), en = $('fg-energynum');
    if (eb) eb.style.width = (s.energy / s.maxEnergy * 100) + '%';
    if (en) en.textContent = s.energy + '/' + s.maxEnergy;

    var unread = STORE.unreadMailCount();
    var dot = $('fg-maildot');
    dot.hidden = unread <= 0;
    dot.textContent = unread > 9 ? '9+' : unread;
  }

  function numCN(n) {
    var cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
      '十一', '十二', '十三', '十四'];
    return cn[n - 1] || String(n);
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

    /* 体力不足的动作变灰提示 */
    ['sow', 'water', 'fert', 'hoe'].forEach(function (m) {
      var btn = $('fg-act-' + m);
      btn.classList.toggle('is-tired', s.energy < STORE.ENERGY_COST[m]);
    });

    var hint = $('fg-hint');
    hint.textContent = '直接点地块干活：空地播种 · 缺水浇水 · 缺肥施肥 · 熟了收获';
  }

  function plotHtml(s, i) {
    var p = s.plots[i];
    var cls = 'fg-plot';
    var inner = '';
    if (p) {
      var c = STORE.CROPS[p.crop];
      var mature = p.stage >= c.stages.length - 1;
      if (mature) cls += ' is-mature';
      if (p.watered) cls += ' is-watered';
      inner =
        '<span class="fg-plot__crop' + (mature ? ' fg-plot__crop--mature' : '') + '">' + c.stages[p.stage] + '</span>' +
        (p.fert ? '<span class="fg-plot__fert">✨</span>' : '') +
        (mature ? '<span class="fg-plot__shine" aria-hidden="true"></span>' : '');
    } else {
      cls += ' is-empty';
      inner = '<span class="fg-plot__plus">+</span>';
    }
    return '<button type="button" class="' + cls + '" data-plot="' + i + '" aria-label="农田 ' + (i + 1) + '">' + inner + '</button>';
  }

  function renderPlots(s) {
    var grid = $('fg-grid');
    var n = STORE.plotCountFor(s.level);
    var html = '';
    for (var i = 0; i < n; i++) html += plotHtml(s, i);
    grid.innerHTML = html;
    /* 动画中的地块恢复进度条（避免重绘打断观感） */
    Object.keys(busy).forEach(function (k) { mountProgress(+k); });
  }

  /* 只重绘一块地（动画结束/状态更新用，不打断其他地块动效） */
  function renderPlotCell(i) {
    var s = STORE.getState();
    var grid = $('fg-grid');
    var old = grid.querySelector('[data-plot="' + i + '"]');
    if (!old) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = plotHtml(s, i);
    old.replaceWith(tmp.firstChild);
  }

  function renderFoot(s) {
    $('fg-daycount').textContent = '已度过 ' + s.stats.daysPlayed + ' 天';
  }

  /* ── 动作执行 ── */

  function spendEnergy(n) {
    var s = STORE.getState();
    if (s.energy < n) { toast('💤 体力不够了，进入次日休息吧'); return false; }
    s.energy -= n;
    return true;
  }

  /* 播种（单块）：点空地 → 选种 → 直接种好（无进度条） */
  function doSow(i, cropId) {
    var c = STORE.CROPS[cropId];
    var s = STORE.getState();
    if (s.plots[i]) { toast('这块地已经种了'); return; }
    if (c.seasons.indexOf(STORE.calendarOf(s.day).season.id) < 0) {
      toast(c.name + '不是当季作物'); return;
    }
    if (!STORE.spendGold(c.seedPrice)) { toast('🪙 金币不够，先卖点仓库作物吧'); return; }
    if (!spendEnergy(STORE.ENERGY_COST.sow)) { STORE.gainGold(c.seedPrice); return; }
    s.plots[i] = { crop: cropId, stage: 0, watered: false, fert: false };
    STORE.save();
    renderHead(s);
    closeSheet();
    renderPlotCell(i);
    toast('🌱 播下' + c.name + '种子');
  }

  /* 一键播种：选种后种满所有空地（体力/金币不够时量力而行），直接完成 */
  function bulkSow(cropId) {
    var c = STORE.CROPS[cropId];
    var s = STORE.getState();
    if (c.seasons.indexOf(STORE.calendarOf(s.day).season.id) < 0) {
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
      toast(s.gold < c.seedPrice ? '🪙 金币不够，先卖点仓库作物吧' : '💤 体力不够了，进入次日休息吧');
      return;
    }
    if (m < targets.length) toast('量力而行：这次只种得下 ' + m + ' 块');
    targets = targets.slice(0, m);
    STORE.spendGold(c.seedPrice * m);
    s.energy -= per * m;
    targets.forEach(function (i) { s.plots[i] = { crop: cropId, stage: 0, watered: false, fert: false }; });
    STORE.save();
    renderHead(s);
    closeSheet();
    renderAll();
    toast('🌱 播下' + c.name + '种子 ×' + m);
  }

  /* 浇水（单块） */
  function doWater(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p || p.watered) return;
    if (!spendEnergy(STORE.ENERGY_COST.water)) return;
    p.watered = true;
    STORE.save();
    renderHead(s);
    startProgress(i, PROGRESS_MS, function () {
      renderPlotCell(i);
      toast('💧 ' + pick(WATER_TOASTS));
    });
  }

  /* 一键浇水：给所有缺水的地块浇水 */
  function bulkWater() {
    var s = STORE.getState();
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && !p.watered && p.stage < STORE.CROPS[p.crop].stages.length - 1) targets.push(i);
    }
    if (!targets.length) { toast('💧 都浇过水啦'); return; }
    var per = STORE.ENERGY_COST.water;
    var m = Math.min(targets.length, Math.floor(s.energy / per));
    if (!m) { toast('💤 体力不够了，进入次日休息吧'); return; }
    if (m < targets.length) toast('💤 体力只够浇 ' + m + ' 块');
    targets = targets.slice(0, m);
    s.energy -= per * m;
    targets.forEach(function (i) { s.plots[i].watered = true; });
    STORE.save();
    renderHead(s);
    toast('💧 一键浇水 ' + m + ' 块…');
    wave(targets, BULK_STEP_MS, BULK_STAGGER_MS, function (i) {
      renderPlotCell(i);
    });
  }

  /* 施肥（单块） */
  function doFert(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p || p.fert) return;
    if (!spendEnergy(STORE.ENERGY_COST.fert)) return;
    p.fert = true;
    STORE.save();
    renderHead(s);
    startProgress(i, PROGRESS_MS, function () {
      renderPlotCell(i);
      toast('✨ ' + pick(FERT_TOASTS));
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
      if (p && !p.fert && p.stage < STORE.CROPS[p.crop].stages.length - 1) targets.push(i);
    }
    if (!targets.length) { toast('✨ 都施过肥啦'); return; }
    var per = STORE.ENERGY_COST.fert;
    var m = Math.min(targets.length, Math.floor(s.energy / per));
    if (!m) { toast('💤 体力不够了，进入次日休息吧'); return; }
    if (m < targets.length) toast('💤 体力只够施 ' + m + ' 块');
    targets = targets.slice(0, m);
    s.energy -= per * m;
    targets.forEach(function (i) { s.plots[i].fert = true; });
    STORE.save();
    renderHead(s);
    toast('✨ 一键施肥 ' + m + ' 块…');
    wave(targets, BULK_STEP_MS, BULK_STAGGER_MS, function (i) {
      renderPlotCell(i);
    });
  }

  /* 锄头（面板触发）：挖掉作物返还一半种子钱 */
  function doHoe(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) return;
    var c = STORE.CROPS[p.crop];
    if (p.stage >= c.stages.length - 1) { toast('都熟了，直接点它收获吧'); return; }
    if (!spendEnergy(STORE.ENERGY_COST.hoe)) return;
    s.plots[i] = null;
    var back = Math.floor(c.seedPrice / 2);
    if (back > 0) STORE.gainGold(back);
    STORE.save();
    renderHead(s);
    /* 作物缩小消失 → 土地进度条 → 气泡 */
    var plot = plotEl(i);
    if (plot) plot.classList.add('is-vanishing');
    startProgress(i, PROGRESS_MS, function () {
      renderPlotCell(i);
      toast('⛏ 锄掉了' + c.name + (back > 0 ? '，退 ' + back + ' 金币' : ''));
    });
  }

  function doHoeAll() {
    var s = STORE.getState();
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && p.stage < STORE.CROPS[p.crop].stages.length - 1) targets.push(i);
    }
    if (!targets.length) { toast('没有可锄的作物'); return; }
    var per = STORE.ENERGY_COST.hoe;
    var m = Math.min(targets.length, Math.floor(s.energy / per));
    if (!m) { toast('💤 体力不够了，进入次日休息吧'); return; }
    targets = targets.slice(0, m);
    var backSum = 0;
    targets.forEach(function (i) {
      var p = s.plots[i];
      backSum += Math.floor(STORE.CROPS[p.crop].seedPrice / 2);
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

  /* 收获（单块）：作物直接消失，土地上方飘小「🍇+1」 */
  function harvestPlot(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) return;
    var c = STORE.CROPS[p.crop];
    var yieldN = 1 + (p.fert ? 1 : 0);
    s.barn[c.id] = (s.barn[c.id] || 0) + yieldN;
    s.stats.harvested += yieldN;
    var ups = STORE.addExp(c.exp * yieldN);
    s.plots[i] = null;
    STORE.save();
    renderHead(s);
    renderPlotCell(i);
    gainFx(i, c.icon, yieldN);
    toast('✨ 收获' + c.name + ' +' + yieldN);
    announceLevelUps(ups);
  }

  /* 一键收获：逐块播放上升动效 */
  function bulkHarvest() {
    var s = STORE.getState();
    if (!STORE.hasBulkHarvest(s.level)) { toast('「一键收获」Lv.5 解锁'); return; }
    var targets = [];
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) {
      var p = s.plots[i];
      if (p && p.stage >= STORE.CROPS[p.crop].stages.length - 1) targets.push(i);
    }
    if (!targets.length) { toast('🌾 没有成熟的作物'); return; }
    var total = 0, expSum = 0, crops = {}, meta = [];
    targets.forEach(function (i) {
      var p = s.plots[i];
      var c = STORE.CROPS[p.crop];
      var y = 1 + (p.fert ? 1 : 0);
      crops[c.id] = (crops[c.id] || 0) + y;
      meta.push({ i: i, icon: c.icon, name: c.name, y: y });
      total += y;
      expSum += c.exp * y;
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
      }, k * HARVEST_STAGGER_MS);
    });
    var names = Object.keys(crops).map(function (k) { return STORE.CROPS[k].name + '×' + crops[k]; }).join('、');
    setTimeout(function () { toast('🧺 收入仓库：' + names + '（+' + expSum + ' 经验）'); },
      meta.length * HARVEST_STAGGER_MS + 300);
    announceLevelUps(ups);
  }

  function announceLevelUps(ups) {
    if (!ups || !ups.length) return;
    STORE.unlockTexts(ups).forEach(function (u) {
      STORE.addMail('🎉', '升到 Lv.' + u.level + '！' + u.text);
    });
    STORE.save();
    toast('🎉 升级！Lv.' + ups[ups.length - 1]);
  }

  /* ── 进入次日（过夜结算） ── */
  function nextDay() {
    clearAllBusy();
    var s = STORE.getState();
    var cal = STORE.calendarOf(s.day);
    s.day += 1;
    s.stats.daysPlayed += 1;

    var w = STORE.rollWeather();
    var nextCal = STORE.calendarOf(s.day);

    /* 换季提醒 */
    if (nextCal.season.id !== cal.season.id && nextCal.day === 1) {
      STORE.addMail(nextCal.season.icon, nextCal.season.name + '天来了！当季种子换了一批，去种子铺看看。');
    }

    /* 乌鸦：用「昨晚的浇水状态」判定候选，先于生长结算 */
    if (w.id === 'crow') {
      var candidates = [];
      for (var ci = 0; ci < s.plots.length; ci++) {
        if (s.plots[ci] && !s.plots[ci].watered) candidates.push(ci);
      }
      if (candidates.length) {
        var victim = candidates[Math.floor(Math.random() * candidates.length)];
        var vc = STORE.CROPS[s.plots[victim].crop];
        s.plots[victim] = null;
        STORE.addMail('🐦', '乌鸦把一块没浇水的' + vc.name + '叼走了…记得天天浇水。');
      }
    }

    /* ① 浇水促成生长：昨晚浇过水的未成熟作物 +1 阶段 */
    for (var g = 0; g < s.plots.length; g++) {
      var gp = s.plots[g];
      if (!gp) continue;
      var gc = STORE.CROPS[gp.crop];
      if (gp.watered && gp.stage < gc.stages.length - 1) {
        gp.stage = Math.min(gc.stages.length - 1, gp.stage + 1);
      }
    }
    /* ② 重置浇水状态（新的一天重新浇） */
    for (var r = 0; r < s.plots.length; r++) {
      if (s.plots[r]) s.plots[r].watered = false;
    }
    /* ③ 今日天气：雨天 = 全田自动浇透 */
    if (w.id === 'rain') {
      for (var rn = 0; rn < s.plots.length; rn++) {
        var rp = s.plots[rn];
        if (rp && rp.stage < STORE.CROPS[rp.crop].stages.length - 1) rp.watered = true;
      }
    }

    /* 拾遗 */
    if (w.id === 'gift') {
      var bonus = 10 + Math.floor(Math.random() * 21);
      STORE.gainGold(bonus);
      STORE.addMail('🎁', '在田埂边捡到一个钱袋，+' + bonus + ' 金币！');
    }

    s.weather = w.id;
    s.energy = s.maxEnergy;
    STORE.save();
    renderAll();

    var lines = { sunny: '新的一天，晴天', rain: '下雨了，全田都浇透了', crow: '有乌鸦出没…', gift: '今天有好运' };
    toast('🌙 第 ' + s.stats.daysPlayed + ' 天 · ' + (lines[w.id] || ''));
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

  /* plotIdx = -1 表示「种满空地」模式，否则是点某块空地弹出的单块播种 */
  function openSeedSheet(plotIdx) {
    var s = STORE.getState();
    var season = STORE.calendarOf(s.day).season;
    var crops = STORE.seasonCrops(season.id);
    pendingSowPlot = plotIdx;
    var emptyCount = 0;
    var n = STORE.plotCountFor(s.level);
    for (var i = 0; i < n; i++) if (!s.plots[i]) emptyCount++;

    var title = plotIdx >= 0
      ? '🌱 选种子 · 播到农田 ' + numCN(plotIdx + 1)
      : '🌱 选种子 · 种满 ' + emptyCount + ' 块空地';
    var rows = crops.map(function (id) {
      var c = STORE.CROPS[id];
      var afford = s.gold >= c.seedPrice * (plotIdx >= 0 ? 1 : Math.max(1, emptyCount));
      return '<button type="button" class="fg-seed' + (afford ? '' : ' is-poor') + '" data-seed="' + id + '">' +
        '<span class="fg-seed__icon">' + c.icon + '</span>' +
        '<span class="fg-seed__meta"><b>' + esc(c.name) + '</b>' +
        '<small>卖 ' + c.sellPrice + ' 金币 · + ' + c.exp + ' 经验</small></span>' +
        '<span class="fg-seed__price">' + c.seedPrice + '🪙' + (plotIdx < 0 ? '/块' : '') + '</span>' +
        '</button>';
    }).join('');
    openSheet(
      sheetHead(title) +
      '<div class="fg-seed-list">' + rows + '</div>' +
      '<p class="fg-sheet__tip">' + (plotIdx >= 0
        ? '金币 ' + s.gold + ' · 种下后记得浇水，过夜就长'
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
      if (p.stage >= c.stages.length - 1) continue;
      var back = Math.floor(c.seedPrice / 2);
      rows += '<div class="fg-barn-row" data-hoe="' + i + '">' +
        '<span class="fg-barn-row__icon">' + c.icon + '</span>' +
        '<span class="fg-barn-row__meta"><b>' + esc(c.name) + '</b>' +
        '<small>锄掉返还 ' + back + ' 金币</small></span>' +
        '<span class="fg-barn-row__btns">' +
        '<button type="button" class="fg-mini" data-hoe-one>挖掉</button>' +
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
    var ids = Object.keys(s.barn).filter(function (k) { return s.barn[k] > 0; });
    var rows = ids.map(function (id) {
      var c = STORE.CROPS[id];
      return '<div class="fg-barn-row" data-barn="' + id + '">' +
        '<span class="fg-barn-row__icon">' + c.icon + '</span>' +
        '<span class="fg-barn-row__meta"><b>' + esc(c.name) + ' ×' + s.barn[id] + '</b>' +
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
      return '<div class="fg-mail-row' + (m.read ? '' : ' is-unread') + '">' +
        '<span class="fg-mail-row__icon">' + esc(m.icon) + '</span>' +
        '<div class="fg-mail-row__body"><b>' + esc(m.text) + '</b>' +
        '<small>' + esc(STORE.calendarOf(m.day).season.name) + '季 第 ' + STORE.calendarOf(m.day).day + ' 天</small></div>' +
        '</div>';
    }).join('');
    openSheet(
      sheetHead('📬 农场信箱') +
      (rows ? '<div class="fg-mail-list">' + rows + '</div>' : '<p class="fg-sheet__tip">还没有来信。天气、乌鸦和升级都会写信来。</p>')
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
    var c = STORE.CROPS[id];
    var gold = c.sellPrice * n;
    s.barn[id] = have - n;
    STORE.gainGold(gold);
    s.stats.earned += gold;
    STORE.save();
    renderAll();
    toast('🪙 卖出 ' + c.name + ' ×' + n + '，+' + gold + ' 金币');
    /* 刷新仓库浮层（若开着） */
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
    if (busy[i]) return;          /* 这块地正忙着 */
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) { openSeedSheet(i); return; }             /* 空地 → 播种 */
    var c = STORE.CROPS[p.crop];
    var mature = p.stage >= c.stages.length - 1;
    if (mature) { harvestPlot(i); return; }           /* 成熟 → 收获 */
    if (!p.watered) { doWater(i); return; }           /* 缺水 → 浇水 */
    if (!p.fert && STORE.hasFert(s.level)) { doFert(i); return; }  /* 缺肥 → 施肥 */
    toast(p.fert ? '💤 都伺候好了，等它长大吧' : '💤 等它长大吧（施肥 Lv.3 解锁）');
  }

  /* ── 事件绑定（委托，只绑一次） ── */
  function bindEvents(root) {
    root.addEventListener('click', function (e) {
      var t = e.target;

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
      if (t.closest && t.closest('[data-fg-next]')) { nextDay(); return; }
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

      var plot = t.closest && t.closest('[data-plot]');
      if (plot) { onPlotTap(parseInt(plot.getAttribute('data-plot'), 10)); return; }

      /* 点浮层遮罩空白处关闭 */
      if (t.id === 'fg-sheet') { closeSheet(); return; }
    });
  }

  global.MiyaFarmGame = {
    open: open,
    close: close,
    isOpened: function () { var a = getApp(); return !!a && !a.hidden; }
  };
})(typeof window !== 'undefined' ? window : self);
