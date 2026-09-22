/* miya-farmgame-app.js — 星露农场 · UI 与交互层
 *
 * 回合制小农场：播种→浇水→过夜生长→收获→卖出→升级开地。
 * 玩法对标"星露谷 Lite"海报：先点动作（播种/浇水/施肥/锄头）再点地块，
 * 成熟地块直接点收；「进入次日」推进日历并结算天气事件。
 * 数据层在 miya-farmgame-store.js，本文件只管渲染与交互。
 *
 * 打开方式：桌面「星露农场」图标 → APP_HANDLERS.farmgame → MiyaFarmGame.open()
 * （懒加载组 farmUiGame 先确保 store/app 就绪）
 */
(function (global) {
  'use strict';

  var APP_ID = 'miya-farmgame-app';
  var STORE = global.MiyaFarmGameStore;

  var mode = null;          /* 'sow' | 'water' | 'fert' | 'hoe' | null */
  var pendingSowPlot = -1;  /* 播种浮层对应的地块下标 */
  var opened = false;

  /* ── 工具 ── */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    if (global.MiyaToast && typeof global.MiyaToast.show === 'function') { global.MiyaToast.show(msg); return; }
    if (typeof global.miyaToast === 'function') { global.miyaToast(msg); return; }
    /* 兜底：无 toast 系统时用临时浮条 */
    var t = document.createElement('div');
    t.className = 'farmgame-fallback-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }

  function getApp() { return $(APP_ID); }

  /* ── 打开 / 关闭 ── */
  function open() {
    var app = getApp();
    if (!app || !STORE) return;
    app.hidden = false;
    app.setAttribute('aria-hidden', 'false');
    mode = null;
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
    var plotN = STORE.plotCountFor(s.level);
    $('fg-energybar').style.width = (s.energy / s.maxEnergy * 100) + '%';
    $('fg-energynum').textContent = s.energy + '/' + s.maxEnergy;

    var bulk = $('fg-act-bulk');
    bulk.classList.toggle('is-locked', !STORE.hasBulkHarvest(s.level));
    bulk.querySelector('span').textContent = STORE.hasBulkHarvest(s.level)
      ? '一键收获' : '一键收获 Lv.5';

    var fert = $('fg-act-fert');
    fert.classList.toggle('is-locked', !STORE.hasFert(s.level));
    fert.title = STORE.hasFert(s.level) ? '给作物上肥料（收获 +1）' : 'Lv.3 解锁施肥';

    /* 选中态 + 可用性 */
    ['sow', 'water', 'fert', 'hoe'].forEach(function (m) {
      var btn = $('fg-act-' + m);
      btn.classList.toggle('is-active', mode === m);
      btn.classList.toggle('is-tired', s.energy < STORE.ENERGY_COST[m]);
    });

    var hint = $('fg-hint');
    if (mode === 'sow') hint.textContent = '点一块空地选种子（消耗体力 2）';
    else if (mode === 'water') hint.textContent = '点一块作物浇水（消耗体力 1）· 浇过水过夜才会生长';
    else if (mode === 'fert') hint.textContent = '点一块作物施肥（消耗体力 2）· 收获 +1';
    else if (mode === 'hoe') hint.textContent = '点一块作物挖掉并返还种子（消耗体力 1）';
    else hint.textContent = '先点上方动作按钮，再点农田；成熟作物直接点收';
  }

  function renderPlots(s) {
    var grid = $('fg-grid');
    var n = STORE.plotCountFor(s.level);
    var html = '';
    for (var i = 0; i < n; i++) {
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
          (p.watered && !mature ? '<span class="fg-plot__drop">💧</span>' : '') +
          (p.fert ? '<span class="fg-plot__fert">✨</span>' : '') +
          (mature ? '<span class="fg-plot__shine" aria-hidden="true"></span>' : '');
      } else {
        cls += ' is-empty';
        inner = '<span class="fg-plot__plus">+</span>';
      }
      html += '<button type="button" class="' + cls + '" data-plot="' + i + '" aria-label="农田 ' + (i + 1) + '">' + inner + '</button>';
    }
    grid.innerHTML = html;
  }

  function renderFoot(s) {
    $('fg-daycount').textContent = '已度过 ' + s.stats.daysPlayed + ' 天';
  }

  /* ── 动作执行 ── */
  function setMode(m) {
    var s = STORE.getState();
    if (m && s.energy < STORE.ENERGY_COST[m]) { toast('体力不够了，进入次日休息吧'); return; }
    if (m === 'fert' && !STORE.hasFert(s.level)) { toast('施肥 Lv.3 解锁'); return; }
    mode = (mode === m) ? null : m;
    pendingSowPlot = -1;
    renderAll();
  }

  function onPlotTap(i) {
    var s = STORE.getState();
    var p = s.plots[i];
    if (!p) {
      if (!mode) { toast('先选一个动作，或直接播种'); return; }
      if (mode === 'sow') { openSeedSheet(i); return; }
      if (mode === 'water' || mode === 'fert') { toast('这块地还是空的'); return; }
      if (mode === 'hoe') { toast('这里本来就没有作物'); return; }
      return;
    }
    var c = STORE.CROPS[p.crop];
    var mature = p.stage >= c.stages.length - 1;

    /* 成熟：无论什么模式，直接收获（海报同款交互） */
    if (mature) { harvestPlot(i); return; }

    if (!mode) { toast(c.name + '还在长，浇水过夜长得快'); return; }
    if (mode === 'sow') { toast('这里已经种了' + c.name); return; }
    if (mode === 'water') { doWater(i); return; }
    if (mode === 'fert') { doFert(i); return; }
    if (mode === 'hoe') { doHoe(i); return; }
  }

  function spendEnergy(n) {
    var s = STORE.getState();
    if (s.energy < n) { toast('体力不够了'); return false; }
    s.energy -= n;
    return true;
  }

  function doSow(i, cropId) {
    var c = STORE.CROPS[cropId];
    var s = STORE.getState();
    if (s.plots[i]) { toast('这块地已经种了'); return; }
    if (c.seasons.indexOf(STORE.calendarOf(s.day).season.id) < 0) {
      toast(c.name + '不是当季作物'); return;
    }
    if (!STORE.spendGold(c.seedPrice)) { toast('金币不够，先卖点仓库作物吧'); return; }
    if (!spendEnergy(STORE.ENERGY_COST.sow)) { STORE.gainGold(c.seedPrice); return; }
    s.plots[i] = { crop: cropId, stage: 0, watered: false, fert: false };
    mode = null;
    STORE.save();
    closeSheet();
    renderAll();
    toast('种下了' + c.name);
  }

  function doWater(i) {
    if (!spendEnergy(STORE.ENERGY_COST.water)) return;
    var s = STORE.getState();
    s.plots[i].watered = true;
    mode = null;
    STORE.save();
    renderAll();
    toast('浇好了，今晚就长');
  }

  function doFert(i) {
    if (!spendEnergy(STORE.ENERGY_COST.fert)) return;
    var s = STORE.getState();
    s.plots[i].fert = true;
    mode = null;
    STORE.save();
    renderAll();
    toast('施了肥，收获 +1');
  }

  function doHoe(i) {
    if (!spendEnergy(STORE.ENERGY_COST.hoe)) return;
    var s = STORE.getState();
    var cropId = s.plots[i].crop;
    s.plots[i] = null;
    mode = null;
    /* 锄头挖掉作物，种子折半退款（直观、不用引入"种子库存"概念） */
    var back = Math.floor(STORE.CROPS[cropId].seedPrice / 2);
    if (back > 0) STORE.gainGold(back);
    STORE.save();
    renderAll();
    toast('挖掉了' + STORE.CROPS[cropId].name + (back > 0 ? '，折价退回 ' + back + ' 金币' : ''));
  }

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
    mode = null;
    STORE.save();
    renderAll();
    toast('收获了 ' + c.name + ' ×' + yieldN + '（+' + (c.exp * yieldN) + ' 经验）');
    announceLevelUps(ups);
  }

  function bulkHarvest() {
    var s = STORE.getState();
    if (!STORE.hasBulkHarvest(s.level)) { toast('「一键收获」Lv.5 解锁'); return; }
    var total = 0, expSum = 0, crops = {};
    for (var i = 0; i < s.plots.length; i++) {
      var p = s.plots[i];
      if (!p) continue;
      var c = STORE.CROPS[p.crop];
      if (p.stage < c.stages.length - 1) continue;
      var y = 1 + (p.fert ? 1 : 0);
      crops[c.id] = (crops[c.id] || 0) + y;
      total += y;
      expSum += c.exp * y;
      s.plots[i] = null;
    }
    if (!total) { toast('没有成熟的作物'); return; }
    Object.keys(crops).forEach(function (k) { s.barn[k] = (s.barn[k] || 0) + crops[k]; });
    s.stats.harvested += total;
    var ups = STORE.addExp(expSum);
    mode = null;
    STORE.save();
    renderAll();
    var names = Object.keys(crops).map(function (k) { return STORE.CROPS[k].name + '×' + crops[k]; }).join('、');
    toast('一键收获 ' + names + '（+' + expSum + ' 经验）');
    announceLevelUps(ups);
  }

  function announceLevelUps(ups) {
    if (!ups || !ups.length) return;
    STORE.unlockTexts(ups).forEach(function (u) {
      STORE.addMail('🎉', '升到 Lv.' + u.level + '！' + u.text);
    });
    STORE.save();
    toast('升级！Lv.' + ups[ups.length - 1]);
  }

  /* ── 进入次日（过夜结算） ── */
  function nextDay() {
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
        eaten = vc.name;
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
    toast('第 ' + s.stats.daysPlayed + ' 天 · ' + (lines[w.id] || ''));
  }

  /* ── 浮层（种子 / 仓库 / 信箱） ── */
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

  function openSeedSheet(plotIdx) {
    var s = STORE.getState();
    var season = STORE.calendarOf(s.day).season;
    var crops = STORE.seasonCrops(season.id);
    pendingSowPlot = plotIdx;
    var rows = crops.map(function (id) {
      var c = STORE.CROPS[id];
      var afford = s.gold >= c.seedPrice;
      return '<button type="button" class="fg-seed' + (afford ? '' : ' is-poor') + '" data-seed="' + id + '">' +
        '<span class="fg-seed__icon">' + c.icon + '</span>' +
        '<span class="fg-seed__meta"><b>' + esc(c.name) + '</b>' +
        '<small>卖 ' + c.sellPrice + ' 金币 · + ' + c.exp + ' 经验</small></span>' +
        '<span class="fg-seed__price">' + c.seedPrice + '🪙</span>' +
        '</button>';
    }).join('');
    openSheet(
      '<div class="fg-sheet__head"><h3>选择种子 · ' + season.icon + season.name + '季</h3>' +
      '<button type="button" class="fg-sheet__close" data-fg-close>×</button></div>' +
      '<div class="fg-seed-list">' + rows + '</div>' +
      '<p class="fg-sheet__tip">金币 ' + s.gold + ' · 种子在次日成熟前需浇 1 次水</p>'
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
      '<div class="fg-sheet__head"><h3>仓库 · 卖出</h3>' +
      '<button type="button" class="fg-sheet__close" data-fg-close>×</button></div>' +
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
      '<div class="fg-sheet__head"><h3>农场信箱</h3>' +
      '<button type="button" class="fg-sheet__close" data-fg-close>×</button></div>' +
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
    /* 刷新仓库浮层（若开着） */
    var sheet = $('fg-sheet');
    if (sheet && !sheet.hidden && sheet.querySelector('[data-barn]')) openBarnSheet();
    toast('卖出 ' + c.name + ' ×' + n + '，+' + gold + ' 金币');
  }

  function resetGame() {
    if (!global.confirm || global.confirm('重开农场？金币、等级、仓库全部清零，存档不可恢复。')) {
      STORE.resetSave();
      mode = null;
      closeSheet();
      renderAll();
      toast('新农场开张，祝丰收！');
    }
  }

  /* ── 事件绑定（委托，只绑一次） ── */
  function bindEvents(root) {
    root.addEventListener('click', function (e) {
      var t = e.target;

      var closeBtn = t.closest && t.closest('[data-fg-close]');
      if (closeBtn) { closeSheet(); return; }

      var seedBtn = t.closest && t.closest('[data-seed]');
      if (seedBtn && pendingSowPlot >= 0) { doSow(pendingSowPlot, seedBtn.getAttribute('data-seed')); return; }

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
      if (t.closest && t.closest('[data-fg-save]')) { STORE.save(); toast('已存档'); return; }
      if (t.closest && t.closest('[data-fg-reset]')) { resetGame(); return; }
      if (t.closest && t.closest('[data-fg-next]')) { nextDay(); return; }
      if (t.closest && t.closest('[data-fg-bulk]')) { bulkHarvest(); return; }
      if (t.closest && t.closest('[data-fg-exit]')) { close(); return; }

      var act = t.closest && t.closest('[data-fg-act]');
      if (act) { setMode(act.getAttribute('data-fg-act')); return; }

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
