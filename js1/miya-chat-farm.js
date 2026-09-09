/* miya-chat-farm.js — 双人小农场：种植 / 浇水 / 收获 / 偷菜 / 帮收
 * 真实时钟推进作物阶段；AI 回复用正则 + <miyafarm> 标签写入账本。
 * UI：顶栏按钮打开卡片面板，不占聊天正文。
 */
(function (global) {
  'use strict';

  var TAG = /<miyafarm>([\s\S]*?)<\/miyafarm\s*>/gi;
  var MAX_PLOTS = 6;
  var MAX_LOG = 30;
  var STAGE_MS = 2 * 3600000;      // 每阶段约 2 小时（现实时间）
  var WATER_KEEP_MS = 8 * 3600000; // 浇水后 8 小时内不会枯死
  var DRY_KILL_MS = 16 * 3600000;  // 超过 16 小时未浇水且已发芽 → 枯死

  // 作物配置（按你给的阶段；枯死统一追加 🍂，不计入 matureIndex）
  var CROPS = {
    wheat:  { id: 'wheat',  name: '小麦', stages: ['🌱', '🌿', '🌾'], matureIndex: 2 },
    rose:   { id: 'rose',   name: '玫瑰', stages: ['🌱', '🌿', '🌷', '💐'], matureIndex: 3 },
    cherry: { id: 'cherry', name: '樱花', stages: ['🌱', '🌿', '🌸'], matureIndex: 2 },
    maple:  { id: 'maple',  name: '枫叶', stages: ['🌱', '🌿', '🍁'], matureIndex: 2 },
    green:  { id: 'green',  name: '绿植', stages: ['🌱', '🌿', '🍀'], matureIndex: 2 }
  };
  var DEAD_ICON = '🍂';
  var CROP_IDS = Object.keys(CROPS);

  // —— 工具 ——
  function now() { return Date.now(); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
  function uid(prefix) {
    return (prefix || 'fp') + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cropOf(id) { return CROPS[id] || null; }

  function formatDelta(ms) {
    if (ms <= 0) return '即将';
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return h + '小时' + (m ? m + '分' : '');
    return Math.max(1, m) + '分钟';
  }

  // —— 存储（挂在聊天 backgroundMessage.farm）——
  function getBg(store, chatId) {
    var s = store && store.getChatSettings ? store.getChatSettings(chatId) || {} : {};
    return s.backgroundMessage || {};
  }

  function emptyFarm() {
    return {
      playerPlots: [],
      rolePlots: [],
      log: [],
      updatedAt: now()
    };
  }

  function load(store, chatId) {
    var raw = getBg(store, chatId).farm;
    if (!raw || typeof raw !== 'object') return emptyFarm();
    return {
      playerPlots: Array.isArray(raw.playerPlots) ? raw.playerPlots.map(normPlot).filter(Boolean) : [],
      rolePlots: Array.isArray(raw.rolePlots) ? raw.rolePlots.map(normPlot).filter(Boolean) : [],
      log: Array.isArray(raw.log) ? raw.log.slice(-MAX_LOG) : [],
      updatedAt: num(raw.updatedAt) || now()
    };
  }

  function save(store, chatId, farm) {
    if (!store || !store.saveChatSettings) return Promise.resolve();
    farm.updatedAt = now();
    return store.saveChatSettings(chatId, { backgroundMessage: { farm: farm } });
  }

  function normPlot(p) {
    if (!p || typeof p !== 'object') return null;
    var crop = cropOf(p.cropId);
    if (!crop) return null;
    return {
      id: clean(p.id, 40) || uid('fp'),
      cropId: crop.id,
      stage: Math.max(0, Math.min(num(p.stage), crop.matureIndex)),
      plantedAt: num(p.plantedAt) || now(),
      wateredAt: num(p.wateredAt) || num(p.plantedAt) || now(),
      lastTickAt: num(p.lastTickAt) || num(p.plantedAt) || now(),
      dead: p.dead === true,
      stolen: p.stolen === true
    };
  }

  function pushLog(farm, text, kind) {
    farm.log = (farm.log || []).concat([{ at: now(), text: clean(text, 120), kind: clean(kind, 20) || 'info' }]);
    if (farm.log.length > MAX_LOG) farm.log = farm.log.slice(-MAX_LOG);
  }

  // —— 生长 / 枯死（现实时钟）——
  function tickPlot(plot, at) {
    at = at || now();
    if (!plot || plot.dead || plot.stolen) return plot;
    var crop = cropOf(plot.cropId);
    if (!crop) return plot;

    // 枯死：发芽后长期不浇水
    if (plot.stage >= 1) {
      var sinceWater = at - (plot.wateredAt || plot.plantedAt);
      if (sinceWater > DRY_KILL_MS) {
        plot.dead = true;
        plot.lastTickAt = at;
        return plot;
      }
    }

    // 已成熟不再涨
    if (plot.stage >= crop.matureIndex) {
      plot.lastTickAt = at;
      return plot;
    }

    // 按阶段时长推进
    var elapsed = at - (plot.plantedAt || at);
    var expected = Math.min(crop.matureIndex, Math.floor(elapsed / STAGE_MS));
    if (expected > plot.stage) {
      plot.stage = expected;
      plot.lastTickAt = at;
    }
    return plot;
  }

  function tickFarm(farm, at) {
    at = at || now();
    farm.playerPlots = (farm.playerPlots || []).map(function (p) { return tickPlot(p, at); });
    farm.rolePlots = (farm.rolePlots || []).map(function (p) { return tickPlot(p, at); });
    return farm;
  }

  function reconcile(store, chatId, at) {
    var farm = tickFarm(load(store, chatId), at || now());
    save(store, chatId, farm).catch(function () {});
    return farm;
  }

  function plotIcon(plot) {
    if (!plot) return '⬜';
    if (plot.dead) return DEAD_ICON;
    if (plot.stolen) return '🕳️';
    var crop = cropOf(plot.cropId);
    if (!crop) return '❓';
    var i = Math.max(0, Math.min(plot.stage, crop.stages.length - 1));
    return crop.stages[i];
  }

  function plotLabel(plot) {
    var crop = cropOf(plot.cropId);
    if (!crop) return '空地';
    if (plot.dead) return crop.name + '（枯了）';
    if (plot.stolen) return crop.name + '（被偷）';
    if (plot.stage >= crop.matureIndex) return crop.name + '（成熟）';
    return crop.name + '（生长中）';
  }

  function nextStageIn(plot, at) {
    at = at || now();
    if (!plot || plot.dead || plot.stolen) return 0;
    var crop = cropOf(plot.cropId);
    if (!crop || plot.stage >= crop.matureIndex) return 0;
    var nextAt = (plot.plantedAt || at) + (plot.stage + 1) * STAGE_MS;
    return Math.max(0, nextAt - at);
  }

  // —— 操作 ——
  function findPlot(list, plotId) {
    for (var i = 0; i < list.length; i++) if (list[i].id === plotId) return list[i];
    return null;
  }

  function plant(store, chatId, owner, cropId) {
    var crop = cropOf(cropId);
    if (!crop) return { ok: false, error: '未知作物' };
    var farm = reconcile(store, chatId);
    var key = owner === 'role' ? 'rolePlots' : 'playerPlots';
    if ((farm[key] || []).filter(function (p) { return !p.dead && !p.stolen; }).length >= MAX_PLOTS) {
      return { ok: false, error: '地块已满（最多' + MAX_PLOTS + '块）' };
    }
    var plot = {
      id: uid('fp'),
      cropId: crop.id,
      stage: 0,
      plantedAt: now(),
      wateredAt: now(),
      lastTickAt: now(),
      dead: false,
      stolen: false
    };
    farm[key].push(plot);
    pushLog(farm, (owner === 'role' ? '对方' : '你') + '种下了' + crop.name, 'plant');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, plot: plot, farm: farm };
  }

  function water(store, chatId, owner, plotId) {
    var farm = reconcile(store, chatId);
    var key = owner === 'role' ? 'rolePlots' : 'playerPlots';
    var plot = findPlot(farm[key], plotId);
    if (!plot) return { ok: false, error: '找不到这块地' };
    if (plot.dead) return { ok: false, error: '已经枯了，浇也救不活' };
    if (plot.stolen) return { ok: false, error: '已经被偷走了' };
    plot.wateredAt = now();
    pushLog(farm, (owner === 'role' ? '你帮对方' : '你') + '浇了' + (cropOf(plot.cropId) || {}).name, 'water');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, plot: plot, farm: farm };
  }

  function harvest(store, chatId, owner, plotId, by) {
    var farm = reconcile(store, chatId);
    var key = owner === 'role' ? 'rolePlots' : 'playerPlots';
    var plot = findPlot(farm[key], plotId);
    if (!plot) return { ok: false, error: '找不到这块地' };
    if (plot.dead) return { ok: false, error: '枯了，收不了' };
    if (plot.stolen) return { ok: false, error: '已经被偷走了' };
    var crop = cropOf(plot.cropId);
    if (!crop || plot.stage < crop.matureIndex) return { ok: false, error: '还没成熟' };
    // 移除地块
    farm[key] = farm[key].filter(function (p) { return p.id !== plotId; });
    var who = by || (owner === 'role' ? '你帮对方' : '你');
    pushLog(farm, who + '收获了' + crop.name, 'harvest');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, cropId: crop.id, name: crop.name, farm: farm };
  }

  /** 偷对方地里成熟的作物：fromOwner 的地 → 被盗 */
  function steal(store, chatId, fromOwner, plotId, by) {
    var farm = reconcile(store, chatId);
    var key = fromOwner === 'role' ? 'rolePlots' : 'playerPlots';
    var plot = findPlot(farm[key], plotId);
    if (!plot) return { ok: false, error: '找不到这块地' };
    if (plot.dead || plot.stolen) return { ok: false, error: '这块地没得偷' };
    var crop = cropOf(plot.cropId);
    if (!crop || plot.stage < crop.matureIndex) return { ok: false, error: '还没成熟，偷不了' };
    plot.stolen = true;
    var thief = by || (fromOwner === 'role' ? '你' : '对方');
    var victim = fromOwner === 'role' ? '对方' : '你';
    pushLog(farm, thief + '偷走了' + victim + '的' + crop.name, 'steal');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, cropId: crop.id, name: crop.name, farm: farm };
  }

  function clearDead(store, chatId, owner, plotId) {
    var farm = reconcile(store, chatId);
    var key = owner === 'role' ? 'rolePlots' : 'playerPlots';
    var plot = findPlot(farm[key], plotId);
    if (!plot) return { ok: false, error: '找不到' };
    farm[key] = farm[key].filter(function (p) { return p.id !== plotId; });
    pushLog(farm, '清理了枯萎的' + ((cropOf(plot.cropId) || {}).name || '作物'), 'clear');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, farm: farm };
  }

  // —— AI：标签 + 自然语言正则 ——
  // 自然语言：识别「偷了你的小麦/玫瑰…」「帮你收了…」「种了…」
  var NAME_TO_ID = {};
  CROP_IDS.forEach(function (id) { NAME_TO_ID[CROPS[id].name] = id; });
  // 也认常见别名
  NAME_TO_ID['番茄'] = 'wheat'; // 兜底不强制；无匹配配置名
  delete NAME_TO_ID['番茄'];

  var CROP_NAME_RE = Object.keys(NAME_TO_ID).sort(function (a, b) { return b.length - a.length; }).join('|');
  // 对方偷了玩家
  var RE_STEAL_PLAYER = new RegExp(
    '(?:偷(?:走|了)?|摘走了?|薅走了?)(?:了)?(?:你的|你种的|你家的)?(' + CROP_NAME_RE + ')',
    'g'
  );
  // 帮玩家收
  var RE_HELP_HARVEST = new RegExp(
    '(?:帮你(?:收|收获|摘)|给你收了|帮你把)(?:了)?(?:你的)?(' + CROP_NAME_RE + ')',
    'g'
  );
  // 角色自己种
  var RE_ROLE_PLANT = new RegExp(
    '(?:我(?:也)?种了|我在农场种了|我播了)(?:一[颗株垄批])?(' + CROP_NAME_RE + ')',
    'g'
  );

  function matchCropName(name) {
    return NAME_TO_ID[name] || null;
  }

  function firstMature(list) {
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var c = cropOf(p.cropId);
      if (c && !p.dead && !p.stolen && p.stage >= c.matureIndex) return p;
    }
    return null;
  }

  function firstMatureByCrop(list, cropId) {
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var c = cropOf(p.cropId);
      if (c && p.cropId === cropId && !p.dead && !p.stolen && p.stage >= c.matureIndex) return p;
    }
    return null;
  }

  function applyNaturalLanguage(store, chatId, text) {
    var src = String(text || '');
    if (!src || !CROP_NAME_RE) return { applied: 0 };
    var applied = 0;
    var m;

    // 偷玩家
    RE_STEAL_PLAYER.lastIndex = 0;
    while ((m = RE_STEAL_PLAYER.exec(src))) {
      var cid = matchCropName(m[1]);
      if (!cid) continue;
      var farm = reconcile(store, chatId);
      var target = firstMatureByCrop(farm.playerPlots, cid) || firstMature(farm.playerPlots);
      if (target) {
        steal(store, chatId, 'player', target.id, '对方');
        applied++;
      }
    }

    // 帮收玩家
    RE_HELP_HARVEST.lastIndex = 0;
    while ((m = RE_HELP_HARVEST.exec(src))) {
      var cid2 = matchCropName(m[1]);
      if (!cid2) continue;
      var farm2 = reconcile(store, chatId);
      var t2 = firstMatureByCrop(farm2.playerPlots, cid2) || firstMature(farm2.playerPlots);
      if (t2) {
        harvest(store, chatId, 'player', t2.id, '对方帮你');
        applied++;
      }
    }

    // 角色自种
    RE_ROLE_PLANT.lastIndex = 0;
    while ((m = RE_ROLE_PLANT.exec(src))) {
      var cid3 = matchCropName(m[1]);
      if (!cid3) continue;
      var r = plant(store, chatId, 'role', cid3);
      if (r.ok) applied++;
    }

    return { applied: applied };
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
      if (!obj || typeof obj !== 'object') continue;
      var action = clean(obj.action || obj.act, 20).toLowerCase();
      var cropId = clean(obj.cropId || obj.crop || '', 20);
      if (obj.cropName && !cropId) cropId = matchCropName(obj.cropName) || '';
      var res = null;
      if (action === 'plant') {
        res = plant(store, chatId, obj.owner === 'player' ? 'player' : 'role', cropId);
      } else if (action === 'water') {
        res = water(store, chatId, obj.owner === 'player' ? 'player' : 'role', obj.plotId);
      } else if (action === 'harvest') {
        res = harvest(store, chatId, obj.owner === 'player' ? 'player' : 'role', obj.plotId, obj.by || '对方');
      } else if (action === 'steal') {
        // 角色偷玩家：from player
        var from = obj.from === 'role' ? 'role' : 'player';
        var farm = reconcile(store, chatId);
        var list = from === 'role' ? farm.rolePlots : farm.playerPlots;
        var target = obj.plotId ? findPlot(list, obj.plotId) : (cropId ? firstMatureByCrop(list, cropId) : firstMature(list));
        if (target) res = steal(store, chatId, from, target.id, obj.by || '对方');
      } else if (action === 'help_harvest') {
        var farmH = reconcile(store, chatId);
        var tH = obj.plotId
          ? findPlot(farmH.playerPlots, obj.plotId)
          : (cropId ? firstMatureByCrop(farmH.playerPlots, cropId) : firstMature(farmH.playerPlots));
        if (tH) res = harvest(store, chatId, 'player', tH.id, '对方帮你');
      }
      if (res && res.ok) found.push(res);
    }

    // 自然语言正则（农场接入 AI 的关键路径）
    applyNaturalLanguage(store, chatId, src);

    return { text: src.replace(TAG, '').trim(), events: found };
  }

  function buildPromptContext(store, chatId, at) {
    var farm = reconcile(store, chatId, at || now());
    var lines = [
      '【双人小农场】真实时间生长，与聊天上下文独立。不要机械播报；剧情自然涉及农活时再写。'
    ];
    function summarize(list, title) {
      if (!list.length) {
        lines.push(title + '：空地');
        return;
      }
      list.slice(0, MAX_PLOTS).forEach(function (p) {
        var crop = cropOf(p.cropId);
        var icon = plotIcon(p);
        var extra = '';
        if (!p.dead && !p.stolen && crop && p.stage < crop.matureIndex) {
          extra = '，约' + formatDelta(nextStageIn(p, at)) + '后下一阶段';
        }
        lines.push(title + '：' + icon + ' ' + plotLabel(p) + extra);
      });
    }
    summarize(farm.playerPlots, '玩家田');
    summarize(farm.rolePlots, '角色田');
    if (farm.log && farm.log.length) {
      var last = farm.log[farm.log.length - 1];
      lines.push('最近动态：' + last.text);
    }
    lines.push(
      '可用标签（勿在正文展示）：<miyafarm>{"action":"plant|steal|help_harvest|harvest|water","cropId":"wheat|rose|cherry|maple|green","owner":"role|player"}</miyafarm>',
      '也可在正文自然说「我偷了你的小麦」「帮你收了玫瑰」「我种了樱花」——系统会用正则识别并改农场数据。'
    );
    return lines.join('\n');
  }

  // —— UI ——
  function renderPlotCard(plot, owner, at) {
    at = at || now();
    var crop = cropOf(plot.cropId);
    var icon = plotIcon(plot);
    var name = plotLabel(plot);
    var sub = '';
    if (plot.dead) sub = '脱水枯死了';
    else if (plot.stolen) sub = '被人偷走了';
    else if (crop && plot.stage >= crop.matureIndex) sub = '可以收获了';
    else sub = '约' + formatDelta(nextStageIn(plot, at)) + '后长大一点';

    var actions = '';
    if (plot.dead || plot.stolen) {
      actions = '<button type="button" class="qq-farm__btn" data-farm-act="clear" data-farm-owner="' + owner + '" data-farm-id="' + esc(plot.id) + '">清理</button>';
    } else if (crop && plot.stage >= crop.matureIndex) {
      if (owner === 'player') {
        actions =
          '<button type="button" class="qq-farm__btn qq-farm__btn--main" data-farm-act="harvest" data-farm-owner="player" data-farm-id="' + esc(plot.id) + '">收获</button>';
      } else {
        actions =
          '<button type="button" class="qq-farm__btn qq-farm__btn--main" data-farm-act="harvest" data-farm-owner="role" data-farm-id="' + esc(plot.id) + '">帮收</button>' +
          '<button type="button" class="qq-farm__btn qq-farm__btn--warn" data-farm-act="steal" data-farm-owner="role" data-farm-id="' + esc(plot.id) + '">偷菜</button>';
      }
    } else {
      actions =
        '<button type="button" class="qq-farm__btn" data-farm-act="water" data-farm-owner="' + owner + '" data-farm-id="' + esc(plot.id) + '">浇水</button>';
    }

    return '<div class="qq-farm__plot" data-farm-plot="' + esc(plot.id) + '">' +
      '<div class="qq-farm__plot-icon" aria-hidden="true">' + icon + '</div>' +
      '<div class="qq-farm__plot-body">' +
        '<div class="qq-farm__plot-name">' + esc(name) + '</div>' +
        '<div class="qq-farm__plot-sub">' + esc(sub) + '</div>' +
        '<div class="qq-farm__plot-actions">' + actions + '</div>' +
      '</div>' +
      '</div>';
  }

  function renderPanel(store, chatId, at) {
    at = at || now();
    var farm = reconcile(store, chatId, at);
    var plantOpts = CROP_IDS.map(function (id) {
      var c = CROPS[id];
      return '<button type="button" class="qq-farm__seed" data-farm-act="plant" data-farm-crop="' + id + '">' +
        c.stages[c.matureIndex] + ' ' + esc(c.name) + '</button>';
    }).join('');

    var playerHtml = farm.playerPlots.length
      ? farm.playerPlots.map(function (p) { return renderPlotCard(p, 'player', at); }).join('')
      : '<div class="qq-farm__empty">还没有作物，选一颗种子种下吧</div>';
    var roleHtml = farm.rolePlots.length
      ? farm.rolePlots.map(function (p) { return renderPlotCard(p, 'role', at); }).join('')
      : '<div class="qq-farm__empty">对方田里空空的</div>';

    var logHtml = (farm.log || []).slice(-6).reverse().map(function (l) {
      return '<div class="qq-farm__log-item">' + esc(l.text) + '</div>';
    }).join('') || '<div class="qq-farm__empty">暂无动态</div>';

    return '<div class="qq-farm" id="qq-farm-panel">' +
      '<div class="qq-farm__head">' +
        '<div class="qq-farm__title">🌱 小农场</div>' +
        '<button type="button" class="qq-farm__close" data-farm-close aria-label="关闭">关闭</button>' +
      '</div>' +
      '<div class="qq-farm__hint">现实时间生长 · 久不浇水会变成 ' + DEAD_ICON + ' · 可偷对方成熟作物</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">我的田</div>' +
        '<div class="qq-farm__plots">' + playerHtml + '</div>' +
        '<div class="qq-farm__seeds">' + plantOpts + '</div>' +
      '</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">对方的田</div>' +
        '<div class="qq-farm__plots">' + roleHtml + '</div>' +
      '</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">动态</div>' +
        '<div class="qq-farm__log">' + logHtml + '</div>' +
      '</div>' +
      '</div>';
  }

  function openPanel(store, chatId, openOverlay, toast) {
    if (!store || !chatId || !openOverlay) return;
    openOverlay(
      '<div class="qq-sheet qq-sheet--farm">' +
        '<div class="qq-sheet__panel qq-sheet__panel--farm">' +
          renderPanel(store, chatId, now()) +
        '</div>' +
      '</div>'
    );
  }

  function handlePanelClick(store, chatId, el, toast, openOverlay) {
    if (!el || !store || !chatId) return false;
    if (el.closest && el.closest('[data-farm-close]')) return true; // 让 sheet 关闭逻辑处理

    var btn = el.closest ? el.closest('[data-farm-act]') : null;
    if (!btn) return false;
    var act = btn.getAttribute('data-farm-act');
    var owner = btn.getAttribute('data-farm-owner') || 'player';
    var plotId = btn.getAttribute('data-farm-id');
    var cropId = btn.getAttribute('data-farm-crop');
    var res = null;

    if (act === 'plant' && cropId) res = plant(store, chatId, 'player', cropId);
    else if (act === 'water') res = water(store, chatId, owner, plotId);
    else if (act === 'harvest') res = harvest(store, chatId, owner, plotId, owner === 'role' ? '你帮对方' : '你');
    else if (act === 'steal') res = steal(store, chatId, 'role', plotId, '你');
    else if (act === 'clear') res = clearDead(store, chatId, owner, plotId);

    if (!res) return true;
    if (!res.ok) {
      if (toast) toast(res.error || '做不到');
      return true;
    }
    if (toast) {
      if (act === 'plant') toast('种下了' + (cropOf(cropId) || {}).name);
      else if (act === 'water') toast('浇好了');
      else if (act === 'harvest') toast('收获了' + (res.name || ''));
      else if (act === 'steal') toast('偷到了' + (res.name || ''));
      else if (act === 'clear') toast('清理了');
    }
    // 刷新面板
    if (openOverlay) openPanel(store, chatId, openOverlay, toast);
    return true;
  }

  global.MiyaChatFarm = {
    CROPS: CROPS,
    load: load,
    reconcile: reconcile,
    plant: plant,
    water: water,
    harvest: harvest,
    steal: steal,
    clearDead: clearDead,
    extractAndStore: extractAndStore,
    buildPromptContext: buildPromptContext,
    renderPanel: renderPanel,
    openPanel: openPanel,
    handlePanelClick: handlePanelClick,
    plotIcon: plotIcon
  };
})(window);
