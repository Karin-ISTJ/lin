/* miya-chat-farm.js — 双人小农场
 * 自选播种 · 现实时钟生长 · 浇水 · 收获入仓 · 售卖进钱包
 * 四叶草基础6%+软保底；小动物基础12%+软保底；四叶草不可直接播种
 * AI：<miyafarm> 标签 + 自然语言正则
 */
(function (global) {
  'use strict';

  var TAG = /<miyafarm>([\s\S]*?)<\/miyafarm\s*>/gi;
  var MAX_PLOTS = 8;
  var MAX_LOG = 40;
  var STAGE_MS = 2 * 3600000;       // 每阶段约 2 小时
  var DRY_KILL_MS = 16 * 3600000;   // 发芽后 16 小时不浇水 → 枯死
  // 基础概率 + 软保底（连续未中时缓慢上升，出货后清零）
  var FOUR_LEAF_BASE = 0.06;        // 四叶草基础 6%
  var FOUR_LEAF_STEP = 0.005;       // 每空一次 +0.5%
  var FOUR_LEAF_CAP = 0.12;         // 封顶 12%
  var ANIMAL_BASE = 0.12;           // 小动物基础 12%
  var ANIMAL_STEP = 0.01;           // 每空一次 +1%
  var ANIMAL_CAP = 0.20;            // 封顶 20%

  // 小动物：不可种植，收获时概率出现；售价更高且各不相同
  var ANIMALS = {
    bear:     { id: 'bear',     name: '小熊', icon: '🐻', sellPrice: 120, kind: 'animal' },
    koala:    { id: 'koala',    name: '考拉', icon: '🐨', sellPrice: 110, kind: 'animal' },
    rabbit:   { id: 'rabbit',   name: '兔子', icon: '🐰', sellPrice: 45,  kind: 'animal' },
    fox:      { id: 'fox',      name: '狐狸', icon: '🦊', sellPrice: 95,  kind: 'animal' },
    sheep:    { id: 'sheep',    name: '小羊', icon: '🐑', sellPrice: 70,  kind: 'animal' },
    squirrel: { id: 'squirrel', name: '松鼠', icon: '🐿️', sellPrice: 55,  kind: 'animal' },
    beaver:   { id: 'beaver',   name: '海狸', icon: '🦫', sellPrice: 80,  kind: 'animal' },
    goose:    { id: 'goose',    name: '鹅',   icon: '🪿', sellPrice: 60,  kind: 'animal' },
    parrot:   { id: 'parrot',   name: '鹦鹉', icon: '🦜', sellPrice: 100, kind: 'animal' },
    eagle:    { id: 'eagle',    name: '鹰',   icon: '🦅', sellPrice: 150, kind: 'animal' }
  };
  var ANIMAL_IDS = Object.keys(ANIMALS);

  // 可播种作物：icon 为成熟外观；stages 含从种子到成熟
  // sellPrice：仓库售价（元）
  // seed: false 表示不可直接购买/播种（仅四叶草）
  var CROPS = {
    // 花草
    hyacinth: { id: 'hyacinth', name: '风信子', stages: ['🌱', '🌿', '🪻'], matureIndex: 2, sellPrice: 12, seed: true },
    sunflower: { id: 'sunflower', name: '向日葵', stages: ['🌱', '🌿', '🌻'], matureIndex: 2, sellPrice: 10, seed: true },
    blossom: { id: 'blossom', name: '小黄花', stages: ['🌱', '🌿', '🌼'], matureIndex: 2, sellPrice: 6, seed: true },
    clover: { id: 'clover', name: '三叶草', stages: ['🌱', '🌿', '☘️'], matureIndex: 2, sellPrice: 8, seed: true },
    fourleaf: { id: 'fourleaf', name: '四叶草', stages: ['🌱', '🌿', '🍀'], matureIndex: 2, sellPrice: 88, seed: false },

    // 浆果水果
    strawberry: { id: 'strawberry', name: '草莓', stages: ['🌱', '🌿', '🍓'], matureIndex: 2, sellPrice: 9, seed: true },
    cherry: { id: 'cherry', name: '樱桃', stages: ['🌱', '🌿', '🍒'], matureIndex: 2, sellPrice: 11, seed: true },
    apple: { id: 'apple', name: '苹果', stages: ['🌱', '🌿', '🍎'], matureIndex: 2, sellPrice: 8, seed: true },
    greenapple: { id: 'greenapple', name: '青苹果', stages: ['🌱', '🌿', '🍏'], matureIndex: 2, sellPrice: 8, seed: true },
    tomato: { id: 'tomato', name: '番茄', stages: ['🌱', '🌿', '🍅'], matureIndex: 2, sellPrice: 7, seed: true },
    chili: { id: 'chili', name: '辣椒', stages: ['🌱', '🌿', '🌶️'], matureIndex: 2, sellPrice: 7, seed: true },
    watermelon: { id: 'watermelon', name: '西瓜', stages: ['🌱', '🌿', '🍉'], matureIndex: 2, sellPrice: 14, seed: true },
    peach: { id: 'peach', name: '桃子', stages: ['🌱', '🌿', '🍑'], matureIndex: 2, sellPrice: 10, seed: true },
    orange: { id: 'orange', name: '橙子', stages: ['🌱', '🌿', '🍊'], matureIndex: 2, sellPrice: 8, seed: true },
    mango: { id: 'mango', name: '芒果', stages: ['🌱', '🌿', '🥭'], matureIndex: 2, sellPrice: 12, seed: true },
    pineapple: { id: 'pineapple', name: '菠萝', stages: ['🌱', '🌿', '🍍'], matureIndex: 2, sellPrice: 13, seed: true },
    lemon: { id: 'lemon', name: '柠檬', stages: ['🌱', '🌿', '🍋'], matureIndex: 2, sellPrice: 7, seed: true },
    melon: { id: 'melon', name: '甜瓜', stages: ['🌱', '🌿', '🍈'], matureIndex: 2, sellPrice: 11, seed: true },
    pear: { id: 'pear', name: '梨', stages: ['🌱', '🌿', '🍐'], matureIndex: 2, sellPrice: 8, seed: true },
    blueberry: { id: 'blueberry', name: '蓝莓', stages: ['🌱', '🌿', '🫐'], matureIndex: 2, sellPrice: 12, seed: true },
    grape: { id: 'grape', name: '葡萄', stages: ['🌱', '🌿', '🍇'], matureIndex: 2, sellPrice: 10, seed: true },
    kiwi: { id: 'kiwi', name: '猕猴桃', stages: ['🌱', '🌿', '🥝'], matureIndex: 2, sellPrice: 11, seed: true },
    avocado: { id: 'avocado', name: '牛油果', stages: ['🌱', '🌿', '🥑'], matureIndex: 2, sellPrice: 15, seed: true },

    // 蔬菜谷物
    carrot: { id: 'carrot', name: '胡萝卜', stages: ['🌱', '🌿', '🥕'], matureIndex: 2, sellPrice: 6, seed: true },
    corn: { id: 'corn', name: '玉米', stages: ['🌱', '🌿', '🌽'], matureIndex: 2, sellPrice: 7, seed: true },
    pea: { id: 'pea', name: '豌豆', stages: ['🌱', '🌿', '🫛'], matureIndex: 2, sellPrice: 6, seed: true },
    leafy: { id: 'leafy', name: '生菜', stages: ['🌱', '🌿', '🥬'], matureIndex: 2, sellPrice: 5, seed: true },
    broccoli: { id: 'broccoli', name: '西兰花', stages: ['🌱', '🌿', '🥦'], matureIndex: 2, sellPrice: 8, seed: true },
    chestnut: { id: 'chestnut', name: '板栗', stages: ['🌱', '🌿', '🌰'], matureIndex: 2, sellPrice: 9, seed: true },
    bean: { id: 'bean', name: '豆子', stages: ['🌱', '🌿', '🫘'], matureIndex: 2, sellPrice: 5, seed: true },

    // 兼容旧存档
    wheat: { id: 'wheat', name: '小麦', stages: ['🌱', '🌿', '🌾'], matureIndex: 2, sellPrice: 5, seed: true },
    rose: { id: 'rose', name: '玫瑰', stages: ['🌱', '🌿', '🌷', '💐'], matureIndex: 3, sellPrice: 16, seed: true },
    green: { id: 'green', name: '绿植', stages: ['🌱', '🌿', '🍀'], matureIndex: 2, sellPrice: 4, seed: true }
  };

  var DEAD_ICON = '🍂';
  var CROP_IDS = Object.keys(CROPS);
  var SEED_IDS = CROP_IDS.filter(function (id) { return CROPS[id].seed !== false; });

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
  function cropOf(id) { return CROPS[id] || ANIMALS[id] || null; }
  function isAnimal(id) { return !!ANIMALS[id]; }
  function matureIcon(crop) {
    if (!crop) return '❓';
    if (crop.kind === 'animal' && crop.icon) return crop.icon;
    if (!crop.stages) return crop.icon || '❓';
    return crop.stages[crop.matureIndex] || crop.stages[crop.stages.length - 1];
  }
  function formatDelta(ms) {
    if (ms <= 0) return '即将';
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return h + '小时' + (m ? m + '分' : '');
    return Math.max(1, m) + '分钟';
  }
  function formatMoney(n) {
    var v = Math.round((Number(n) || 0) * 100) / 100;
    var s = v.toFixed(2);
    if (s.slice(-3) === '.00') return s.slice(0, -3);
    return s;
  }

  function getBg(store, chatId) {
    var s = store && store.getChatSettings ? store.getChatSettings(chatId) || {} : {};
    return s.backgroundMessage || {};
  }

  function emptyFarm() {
    return { playerPlots: [], rolePlots: [], warehouse: {}, log: [], missFour: 0, missAnimal: 0, updatedAt: now() };
  }

  function load(store, chatId) {
    var raw = getBg(store, chatId).farm;
    if (!raw || typeof raw !== 'object') return emptyFarm();
    var wh = raw.warehouse && typeof raw.warehouse === 'object' ? raw.warehouse : {};
    var warehouse = {};
    Object.keys(wh).forEach(function (k) {
      var n = Math.floor(num(wh[k]));
      if (n > 0 && (CROPS[k] || ANIMALS[k])) warehouse[k] = n;
    });
    return {
      playerPlots: Array.isArray(raw.playerPlots) ? raw.playerPlots.map(normPlot).filter(Boolean) : [],
      rolePlots: Array.isArray(raw.rolePlots) ? raw.rolePlots.map(normPlot).filter(Boolean) : [],
      warehouse: warehouse,
      log: Array.isArray(raw.log) ? raw.log.slice(-MAX_LOG) : [],
      missFour: Math.max(0, Math.floor(num(raw.missFour))),
      missAnimal: Math.max(0, Math.floor(num(raw.missAnimal))),
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
    farm.log = (farm.log || []).concat([{ at: now(), text: clean(text, 140), kind: clean(kind, 20) || 'info' }]);
    if (farm.log.length > MAX_LOG) farm.log = farm.log.slice(-MAX_LOG);
  }

  function addToWarehouse(farm, cropId, qty) {
    qty = Math.floor(num(qty)) || 1;
    if ((!CROPS[cropId] && !ANIMALS[cropId]) || qty <= 0) return;
    farm.warehouse = farm.warehouse || {};
    farm.warehouse[cropId] = (farm.warehouse[cropId] || 0) + qty;
  }

  function fourLeafChance(farm) {
    var miss = Math.max(0, Math.floor(num(farm && farm.missFour)));
    return Math.min(FOUR_LEAF_CAP, FOUR_LEAF_BASE + miss * FOUR_LEAF_STEP);
  }

  function animalChance(farm) {
    var miss = Math.max(0, Math.floor(num(farm && farm.missAnimal)));
    return Math.min(ANIMAL_CAP, ANIMAL_BASE + miss * ANIMAL_STEP);
  }

  /** 三叶草收获：是否变为四叶草（软保底） */
  function rollFourLeaf(farm) {
    var p = fourLeafChance(farm);
    if (Math.random() < p) {
      farm.missFour = 0;
      return true;
    }
    farm.missFour = Math.max(0, Math.floor(num(farm.missFour))) + 1;
    return false;
  }

  function maybeAttractAnimal(farm, sourceName) {
    var p = animalChance(farm);
    if (Math.random() >= p) {
      farm.missAnimal = Math.max(0, Math.floor(num(farm.missAnimal))) + 1;
      return null;
    }
    farm.missAnimal = 0;
    var id = ANIMAL_IDS[Math.floor(Math.random() * ANIMAL_IDS.length)];
    var a = ANIMALS[id] || null;
    if (!a) return null;
    addToWarehouse(farm, a.id, 1);
    pushLog(farm, '收获' + (sourceName || '作物') + '时，吸引来了' + a.icon + a.name + '！', 'animal');
    return a;
  }

  function tickPlot(plot, at) {
    at = at || now();
    if (!plot || plot.dead || plot.stolen) return plot;
    var crop = cropOf(plot.cropId);
    if (!crop) return plot;

    if (plot.stage >= 1) {
      var sinceWater = at - (plot.wateredAt || plot.plantedAt);
      if (sinceWater > DRY_KILL_MS) {
        plot.dead = true;
        plot.lastTickAt = at;
        return plot;
      }
    }
    if (plot.stage >= crop.matureIndex) {
      plot.lastTickAt = at;
      return plot;
    }
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
    return crop.stages[Math.max(0, Math.min(plot.stage, crop.stages.length - 1))];
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
    return Math.max(0, (plot.plantedAt || at) + (plot.stage + 1) * STAGE_MS - at);
  }

  function findPlot(list, plotId) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === plotId) return list[i];
    return null;
  }

  function activePlotCount(list) {
    return (list || []).filter(function (p) { return !p.dead && !p.stolen; }).length;
  }

  // —— 操作 ——
  function plant(store, chatId, owner, cropId) {
    var crop = cropOf(cropId);
    if (!crop) return { ok: false, error: '未知作物' };
    if (isAnimal(cropId) || crop.seed === false) return { ok: false, error: crop.name + '不能用种子种，只能碰运气获得' };
    var farm = reconcile(store, chatId);
    var key = owner === 'role' ? 'rolePlots' : 'playerPlots';
    if (activePlotCount(farm[key]) >= MAX_PLOTS) {
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
    var cname = (cropOf(plot.cropId) || {}).name || '作物';
    pushLog(farm, (owner === 'role' ? '你帮对方' : '你') + '浇了' + cname, 'water');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, plot: plot, farm: farm };
  }

  /** 收获：进仓库；三叶草有概率变四叶草 */
  function harvest(store, chatId, owner, plotId, by) {
    var farm = reconcile(store, chatId);
    var key = owner === 'role' ? 'rolePlots' : 'playerPlots';
    var plot = findPlot(farm[key], plotId);
    if (!plot) return { ok: false, error: '找不到这块地' };
    if (plot.dead) return { ok: false, error: '枯了，收不了' };
    if (plot.stolen) return { ok: false, error: '已经被偷走了' };
    var crop = cropOf(plot.cropId);
    if (!crop || plot.stage < crop.matureIndex) return { ok: false, error: '还没成熟' };

    var gotId = crop.id;
    var gotName = crop.name;
    var lucky = false;
    // 种的是三叶草 → 收获时概率出四叶草（软保底）
    if (crop.id === 'clover' && rollFourLeaf(farm)) {
      gotId = 'fourleaf';
      gotName = '四叶草';
      lucky = true;
    }

    farm[key] = farm[key].filter(function (p) { return p.id !== plotId; });

    // 自己收 / 帮对方收 → 进玩家仓库；并有概率吸引小动物
    var animal = null;
    addToWarehouse(farm, gotId, 1);
    animal = maybeAttractAnimal(farm, gotName);

    var who = by || (owner === 'role' ? '你帮对方' : '你');
    if (lucky) {
      pushLog(farm, who + '收获三叶草时发现了幸运的四叶草！', 'lucky');
    } else {
      pushLog(farm, who + '收获了' + gotName + '（已入仓）', 'harvest');
    }
    save(store, chatId, farm).catch(function () {});
    return { ok: true, cropId: gotId, name: gotName, lucky: lucky, animal: animal, farm: farm };
  }

  function steal(store, chatId, fromOwner, plotId, by) {
    var farm = reconcile(store, chatId);
    var key = fromOwner === 'role' ? 'rolePlots' : 'playerPlots';
    var plot = findPlot(farm[key], plotId);
    if (!plot) return { ok: false, error: '找不到这块地' };
    if (plot.dead || plot.stolen) return { ok: false, error: '这块地没得偷' };
    var crop = cropOf(plot.cropId);
    if (!crop || plot.stage < crop.matureIndex) return { ok: false, error: '还没成熟，偷不了' };

    var gotId = crop.id;
    var gotName = crop.name;
    if (crop.id === 'clover' && rollFourLeaf(farm)) {
      gotId = 'fourleaf';
      gotName = '四叶草';
    }

    plot.stolen = true;
    var animal = null;
    // 玩家偷角色 → 进玩家仓库，并可能吸引小动物
    if (fromOwner === 'role') {
      addToWarehouse(farm, gotId, 1);
      animal = maybeAttractAnimal(farm, gotName);
    }

    var thief = by || (fromOwner === 'role' ? '你' : '对方');
    var victim = fromOwner === 'role' ? '对方' : '你';
    pushLog(farm, thief + '偷走了' + victim + '的' + gotName + (fromOwner === 'role' ? '（已入仓）' : ''), 'steal');
    save(store, chatId, farm).catch(function () {});
    return { ok: true, cropId: gotId, name: gotName, animal: animal, farm: farm };
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

  function resolveProfileId(store, chatId) {
    try {
      if (store.findChat) {
        var ch = store.findChat(chatId);
        if (ch && ch.profileId) return String(ch.profileId);
      }
      if (store.getActiveProfile) {
        var p = store.getActiveProfile();
        if (p && p.id) return String(p.id);
      }
    } catch (e) {}
    return '';
  }

  /** 售卖仓库作物 → 面具钱包 */
  function sell(store, chatId, cropId, qty) {
    var farm = reconcile(store, chatId);
    var crop = cropOf(cropId);
    if (!crop) return Promise.resolve({ ok: false, error: '未知作物' });
    qty = Math.floor(num(qty));
    if (!(qty > 0)) qty = farm.warehouse[cropId] || 0;
    var have = farm.warehouse[cropId] || 0;
    if (have <= 0) return Promise.resolve({ ok: false, error: '仓库里没有' + crop.name });
    if (qty > have) qty = have;

    var unit = num(crop.sellPrice) || 1;
    var total = Math.round(unit * qty * 100) / 100;
    var profileId = resolveProfileId(store, chatId);
    if (!profileId || typeof store.adjustWalletBalance !== 'function') {
      return Promise.resolve({ ok: false, error: '钱包不可用' });
    }

    return store.adjustWalletBalance(profileId, total).then(function (bal) {
      farm.warehouse[cropId] = have - qty;
      if (farm.warehouse[cropId] <= 0) delete farm.warehouse[cropId];
      pushLog(farm, '卖出' + crop.name + '×' + qty + '，+' + formatMoney(total) + ' 已入钱包', 'sell');
      save(store, chatId, farm).catch(function () {});
      if (global.MiyaChatWallet && global.miyaChatApp && typeof global.miyaChatApp.refreshProfileUI === 'function') {
        try { global.miyaChatApp.refreshProfileUI(); } catch (e) {}
      }
      return { ok: true, amount: total, balance: bal, name: crop.name, qty: qty, farm: farm };
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || '入账失败' };
    });
  }

  function sellAll(store, chatId) {
    var farm = reconcile(store, chatId);
    var ids = Object.keys(farm.warehouse || {}).filter(function (k) { return farm.warehouse[k] > 0; });
    if (!ids.length) return Promise.resolve({ ok: false, error: '仓库是空的' });

    var total = 0;
    var lines = [];
    ids.forEach(function (id) {
      var c = cropOf(id);
      var q = farm.warehouse[id] || 0;
      if (!c || q <= 0) return;
      var sub = Math.round((num(c.sellPrice) || 1) * q * 100) / 100;
      total += sub;
      lines.push(c.name + '×' + q);
    });
    total = Math.round(total * 100) / 100;
    var profileId = resolveProfileId(store, chatId);
    if (!profileId || typeof store.adjustWalletBalance !== 'function') {
      return Promise.resolve({ ok: false, error: '钱包不可用' });
    }

    return store.adjustWalletBalance(profileId, total).then(function (bal) {
      farm.warehouse = {};
      pushLog(farm, '清空仓库售出（' + lines.join('、') + '），+' + formatMoney(total) + ' 已入钱包', 'sell');
      save(store, chatId, farm).catch(function () {});
      if (global.miyaChatApp && typeof global.miyaChatApp.refreshProfileUI === 'function') {
        try { global.miyaChatApp.refreshProfileUI(); } catch (e) {}
      }
      return { ok: true, amount: total, balance: bal, farm: farm };
    }).catch(function (err) {
      return { ok: false, error: (err && err.message) || '入账失败' };
    });
  }

  // —— AI 正则 / 标签 ——
  var NAME_TO_ID = {};
  CROP_IDS.forEach(function (id) { NAME_TO_ID[CROPS[id].name] = id; });
  var CROP_NAME_RE = Object.keys(NAME_TO_ID).sort(function (a, b) { return b.length - a.length; }).join('|');
  var RE_STEAL_PLAYER = new RegExp('(?:偷(?:走|了)?|摘走了?|薅走了?)(?:了)?(?:你的|你种的|你家的)?(' + CROP_NAME_RE + ')', 'g');
  var RE_HELP_HARVEST = new RegExp('(?:帮你(?:收|收获|摘)|给你收了|帮你把)(?:了)?(?:你的)?(' + CROP_NAME_RE + ')', 'g');
  var RE_ROLE_PLANT = new RegExp('(?:我(?:也)?种了|我在农场种了|我播了)(?:一[颗株垄批])?(' + CROP_NAME_RE + ')', 'g');

  function matchCropName(name) { return NAME_TO_ID[name] || null; }

  function firstMature(list) {
    for (var i = 0; i < (list || []).length; i++) {
      var p = list[i];
      var c = cropOf(p.cropId);
      if (c && !p.dead && !p.stolen && p.stage >= c.matureIndex) return p;
    }
    return null;
  }
  function firstMatureByCrop(list, cropId) {
    for (var i = 0; i < (list || []).length; i++) {
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
    RE_STEAL_PLAYER.lastIndex = 0;
    while ((m = RE_STEAL_PLAYER.exec(src))) {
      var cid = matchCropName(m[1]);
      if (!cid) continue;
      var farm = reconcile(store, chatId);
      var target = firstMatureByCrop(farm.playerPlots, cid) || firstMature(farm.playerPlots);
      if (target) { steal(store, chatId, 'player', target.id, '对方'); applied++; }
    }
    RE_HELP_HARVEST.lastIndex = 0;
    while ((m = RE_HELP_HARVEST.exec(src))) {
      var cid2 = matchCropName(m[1]);
      if (!cid2) continue;
      var farm2 = reconcile(store, chatId);
      var t2 = firstMatureByCrop(farm2.playerPlots, cid2) || firstMature(farm2.playerPlots);
      if (t2) { harvest(store, chatId, 'player', t2.id, '对方帮你'); applied++; }
    }
    RE_ROLE_PLANT.lastIndex = 0;
    while ((m = RE_ROLE_PLANT.exec(src))) {
      var cid3 = matchCropName(m[1]);
      if (!cid3 || CROPS[cid3].seed === false) continue;
      if (plant(store, chatId, 'role', cid3).ok) applied++;
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
      try { obj = JSON.parse(body); } catch (err) {
        try { obj = JSON.parse(body.replace(/[“”]/g, '"').replace(/，/g, ',').replace(/：/g, ':')); } catch (err2) {}
      }
      if (!obj || typeof obj !== 'object') continue;
      var action = clean(obj.action || obj.act, 20).toLowerCase();
      var cropId = clean(obj.cropId || obj.crop || '', 20);
      if (obj.cropName && !cropId) cropId = matchCropName(obj.cropName) || '';
      var res = null;
      if (action === 'plant') res = plant(store, chatId, obj.owner === 'player' ? 'player' : 'role', cropId);
      else if (action === 'water') res = water(store, chatId, obj.owner === 'player' ? 'player' : 'role', obj.plotId);
      else if (action === 'harvest') res = harvest(store, chatId, obj.owner === 'player' ? 'player' : 'role', obj.plotId, obj.by || '对方');
      else if (action === 'steal') {
        var from = obj.from === 'role' ? 'role' : 'player';
        var farm = reconcile(store, chatId);
        var list = from === 'role' ? farm.rolePlots : farm.playerPlots;
        var target = obj.plotId ? findPlot(list, obj.plotId) : (cropId ? firstMatureByCrop(list, cropId) : firstMature(list));
        if (target) res = steal(store, chatId, from, target.id, obj.by || '对方');
      } else if (action === 'help_harvest') {
        var farmH = reconcile(store, chatId);
        var tH = obj.plotId ? findPlot(farmH.playerPlots, obj.plotId)
          : (cropId ? firstMatureByCrop(farmH.playerPlots, cropId) : firstMature(farmH.playerPlots));
        if (tH) res = harvest(store, chatId, 'player', tH.id, '对方帮你');
      }
      if (res && res.ok) found.push(res);
    }
    applyNaturalLanguage(store, chatId, src);
    return { text: src.replace(TAG, '').trim(), events: found };
  }

  function buildPromptContext(store, chatId, at) {
    var farm = reconcile(store, chatId, at || now());
    var lines = ['【双人小农场】真实时间生长。可播种作物由玩家在面板自选。四叶草不能播种，只能收三叶草时概率出现。'];
    function summarize(list, title) {
      if (!list.length) { lines.push(title + '：空地'); return; }
      list.slice(0, MAX_PLOTS).forEach(function (p) {
        var crop = cropOf(p.cropId);
        var extra = (!p.dead && !p.stolen && crop && p.stage < crop.matureIndex)
          ? ('，约' + formatDelta(nextStageIn(p, at)) + '后下一阶段') : '';
        lines.push(title + '：' + plotIcon(p) + ' ' + plotLabel(p) + extra);
      });
    }
    summarize(farm.playerPlots, '玩家田');
    summarize(farm.rolePlots, '角色田');
    var whKeys = Object.keys(farm.warehouse || {});
    if (whKeys.length) {
      lines.push('玩家仓库：' + whKeys.map(function (k) {
        return ((CROPS[k] || {}).name || k) + '×' + farm.warehouse[k];
      }).join('、'));
    }
    if (farm.log && farm.log.length) lines.push('最近动态：' + farm.log[farm.log.length - 1].text);
    lines.push(
      '标签：<miyafarm>{"action":"plant|steal|help_harvest|harvest|water","cropId":"tomato|clover|...","owner":"role|player"}</miyafarm>',
      '也可说「我偷了你的番茄」「帮你收了草莓」「我种了向日葵」。禁止直接种四叶草。'
    );
    return lines.join('\n');
  }

  // —— UI ——
  function renderPlotCard(plot, owner, at) {
    at = at || now();
    var crop = cropOf(plot.cropId);
    var icon = plotIcon(plot);
    var name = plotLabel(plot);
    var sub = plot.dead ? '脱水枯死了' : plot.stolen ? '被人偷走了'
      : (crop && plot.stage >= crop.matureIndex) ? '可以收获了'
      : '约' + formatDelta(nextStageIn(plot, at)) + '后长大一点';

    var actions = '';
    if (plot.dead || plot.stolen) {
      actions = '<button type="button" class="qq-farm__btn" data-farm-act="clear" data-farm-owner="' + owner + '" data-farm-id="' + esc(plot.id) + '">清理</button>';
    } else if (crop && plot.stage >= crop.matureIndex) {
      if (owner === 'player') {
        actions = '<button type="button" class="qq-farm__btn qq-farm__btn--main" data-farm-act="harvest" data-farm-owner="player" data-farm-id="' + esc(plot.id) + '">收获</button>';
      } else {
        actions =
          '<button type="button" class="qq-farm__btn qq-farm__btn--main" data-farm-act="harvest" data-farm-owner="role" data-farm-id="' + esc(plot.id) + '">帮收</button>' +
          '<button type="button" class="qq-farm__btn qq-farm__btn--warn" data-farm-act="steal" data-farm-owner="role" data-farm-id="' + esc(plot.id) + '">偷菜</button>';
      }
    } else {
      actions = '<button type="button" class="qq-farm__btn" data-farm-act="water" data-farm-owner="' + owner + '" data-farm-id="' + esc(plot.id) + '">浇水</button>';
    }

    return '<div class="qq-farm__plot">' +
      '<div class="qq-farm__plot-icon">' + icon + '</div>' +
      '<div class="qq-farm__plot-body">' +
        '<div class="qq-farm__plot-name">' + esc(name) + '</div>' +
        '<div class="qq-farm__plot-sub">' + esc(sub) + '</div>' +
        '<div class="qq-farm__plot-actions">' + actions + '</div>' +
      '</div></div>';
  }

  function renderWarehouse(farm) {
    var keys = Object.keys(farm.warehouse || {}).filter(function (k) { return farm.warehouse[k] > 0; });
    if (!keys.length) return '<div class="qq-farm__empty">仓库空空的，收获后会放在这里</div>';
    var rows = keys.map(function (id) {
      var c = CROPS[id];
      if (!c) return '';
      var q = farm.warehouse[id];
      var price = num(c.sellPrice) || 1;
      return '<div class="qq-farm__wh-row">' +
        '<span class="qq-farm__wh-icon">' + matureIcon(c) + '</span>' +
        '<span class="qq-farm__wh-name">' + esc(c.name) + ' ×' + q + (c.kind === 'animal' ? ' · 动物' : '') + '</span>' +
        '<span class="qq-farm__wh-price">¥' + formatMoney(price) + '/个</span>' +
        '<button type="button" class="qq-farm__btn qq-farm__btn--main" data-farm-act="sell" data-farm-crop="' + id + '" data-farm-qty="1">卖1</button>' +
        (q > 1 ? '<button type="button" class="qq-farm__btn" data-farm-act="sell" data-farm-crop="' + id + '" data-farm-qty="' + q + '">全卖</button>' : '') +
        '</div>';
    }).join('');
    return rows +
      '<div class="qq-farm__wh-foot">' +
        '<button type="button" class="qq-farm__btn qq-farm__btn--main" data-farm-act="sell_all">全部卖出到钱包</button>' +
      '</div>';
  }

  function renderPanel(store, chatId, at) {
    at = at || now();
    var farm = reconcile(store, chatId, at);

    var plantOpts = SEED_IDS.map(function (id) {
      var c = CROPS[id];
      return '<button type="button" class="qq-farm__seed" data-farm-act="plant" data-farm-crop="' + id + '" title="' + esc(c.name) + ' ¥' + formatMoney(c.sellPrice) + '">' +
        matureIcon(c) + '<span>' + esc(c.name) + '</span></button>';
    }).join('');

    var playerHtml = farm.playerPlots.length
      ? farm.playerPlots.map(function (p) { return renderPlotCard(p, 'player', at); }).join('')
      : '<div class="qq-farm__empty">还没有作物，在下方选种子种下</div>';
    var roleHtml = farm.rolePlots.length
      ? farm.rolePlots.map(function (p) { return renderPlotCard(p, 'role', at); }).join('')
      : '<div class="qq-farm__empty">对方田里空空的</div>';
    var logHtml = (farm.log || []).slice(-8).reverse().map(function (l) {
      return '<div class="qq-farm__log-item">' + esc(l.text) + '</div>';
    }).join('') || '<div class="qq-farm__empty">暂无动态</div>';

    return '<div class="qq-farm" id="qq-farm-panel">' +
      '<div class="qq-farm__head">' +
        '<div class="qq-farm__title">🌱 小农场</div>' +
        '<button type="button" class="qq-farm__close" data-sheet-close aria-label="关闭">关闭</button>' +
      '</div>' +
      '<div class="qq-farm__hint">自己选种子 · 浇水防枯 · 收获入仓 · 售卖进钱包<br/>☘️ 三叶草基础 ' + Math.round(FOUR_LEAF_BASE * 100) + '% 变 🍀（空则缓升，封顶 ' + Math.round(FOUR_LEAF_CAP * 100) + '%）· 收获基础 ' + Math.round(ANIMAL_BASE * 100) + '% 出小动物（封顶 ' + Math.round(ANIMAL_CAP * 100) + '%）</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">我的田（' + activePlotCount(farm.playerPlots) + '/' + MAX_PLOTS + '）</div>' +
        '<div class="qq-farm__plots">' + playerHtml + '</div>' +
        '<div class="qq-farm__section-title" style="margin-top:12px">选种子播种</div>' +
        '<div class="qq-farm__seeds">' + plantOpts + '</div>' +
      '</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">对方的田</div>' +
        '<div class="qq-farm__plots">' + roleHtml + '</div>' +
      '</div>' +
      '<div class="qq-farm__section">' +
        '<div class="qq-farm__section-title">仓库 / 售卖</div>' +
        '<div class="qq-farm__wh">' + renderWarehouse(farm) + '</div>' +
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
        '</div></div>'
    );
  }

  function handlePanelClick(store, chatId, el, toast, openOverlay) {
    if (!el || !store || !chatId) return false;
    var btn = el.closest ? el.closest('[data-farm-act]') : null;
    if (!btn) return false;
    var act = btn.getAttribute('data-farm-act');
    var owner = btn.getAttribute('data-farm-owner') || 'player';
    var plotId = btn.getAttribute('data-farm-id');
    var cropId = btn.getAttribute('data-farm-crop');
    var qty = num(btn.getAttribute('data-farm-qty'));

    function done(res, okMsg) {
      if (!res) return;
      if (!res.ok) { if (toast) toast(res.error || '做不到'); return; }
      if (toast && okMsg) toast(okMsg);
      if (openOverlay) openPanel(store, chatId, openOverlay, toast);
    }

    if (act === 'plant' && cropId) {
      var r = plant(store, chatId, 'player', cropId);
      done(r, r.ok ? ('种下了' + ((cropOf(cropId) || {}).name || '')) : '');
      return true;
    }
    if (act === 'water') {
      var w = water(store, chatId, owner, plotId);
      done(w, w.ok ? '浇好了' : '');
      return true;
    }
    if (act === 'harvest') {
      var h = harvest(store, chatId, owner, plotId, owner === 'role' ? '你帮对方' : '你');
      var hMsg = '';
      if (h.ok) {
        hMsg = h.lucky ? '幸运！收获了四叶草' : ('收获了' + (h.name || '') + '，已入仓');
        if (h.animal) hMsg += ' · 还来了' + h.animal.icon + h.animal.name + '！';
      }
      done(h, hMsg);
      return true;
    }
    if (act === 'steal') {
      var s = steal(store, chatId, 'role', plotId, '你');
      var sMsg = s.ok ? ('偷到了' + (s.name || '') + '，已入仓') : '';
      if (s.ok && s.animal) sMsg += ' · 还来了' + s.animal.icon + s.animal.name + '！';
      done(s, sMsg);
      return true;
    }
    if (act === 'clear') {
      done(clearDead(store, chatId, owner, plotId), '清理了');
      return true;
    }
    if (act === 'sell' && cropId) {
      sell(store, chatId, cropId, qty || 1).then(function (res) {
        done(res, res.ok ? ('卖出' + res.name + '，+' + formatMoney(res.amount) + ' 已入钱包') : '');
      });
      return true;
    }
    if (act === 'sell_all') {
      sellAll(store, chatId).then(function (res) {
        done(res, res.ok ? ('全部卖出，+' + formatMoney(res.amount) + ' 已入钱包') : '');
      });
      return true;
    }
    return true;
  }

  global.MiyaChatFarm = {
    CROPS: CROPS,
    ANIMALS: ANIMALS,
    SEED_IDS: SEED_IDS,
    load: load,
    reconcile: reconcile,
    plant: plant,
    water: water,
    harvest: harvest,
    steal: steal,
    clearDead: clearDead,
    sell: sell,
    sellAll: sellAll,
    extractAndStore: extractAndStore,
    buildPromptContext: buildPromptContext,
    renderPanel: renderPanel,
    openPanel: openPanel,
    handlePanelClick: handlePanelClick,
    plotIcon: plotIcon
  };
})(window);
