/* miya-farmgame-store.js — 星露农场 · 数据与存档层（v2 · 现实时钟制）
 *
 * 「现实一天 = 游戏一天，季节跟真实月份走」（QQ 农场节奏）：
 *   · 生长：现实时间戳驱动，离线补算（grownMs 只在「浇了水」的时段累积，
 *     缺水=停止生长；成熟挂地超 24h 枯萎）。
 *   · 日历：现实日期定季节 —— 3~5 春 / 6~8 夏 / 9~11 秋 / 12~2 冬。
 *   · 体力：每天 0 点回满；天气掷签：每天 0 点一次（雨天全田浇水/乌鸦/拾遗）。
 *   · 角色田：对手 = 当前聊天对象，角色离线也自己种、浇、收，还会偷你的熟地
 *     （事件进农场信箱 + 聊天通知，由 UI 层分发）。
 *   · 彩蛋：四叶草 6% / 小动物 12%，概率累计池随存档迁移（自旧聊天双人农场）。
 *
 * 存档 key：miya-farmgame-v1（localStorage JSON，v2 结构）。
 * 写盘走 miyaSyncFlushJsonKey / miyaWriteLsJsonKey（带 IDB 冗余）。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-farmgame-v1';

  /* ── 现实日历 ───────────────────────────────────────────
   * 月份定季节：3~5 春 / 6~8 夏 / 9~11 秋 / 12~2 冬。 */
  var SEASONS = [
    { id: 'spring', name: '春', icon: '🌱', months: [3, 4, 5] },
    { id: 'summer', name: '夏', icon: '☀️', months: [6, 7, 8] },
    { id: 'autumn', name: '秋', icon: '🍂', months: [9, 10, 11] },
    { id: 'winter', name: '冬', icon: '❄️', months: [12, 1, 2] }
  ];
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  /* ── 作物表 ─────────────────────────────────────────────
   * 时长按售价分档（上限 20h）：5~7 元 → 4~6h；8~12 元 → 8~12h；
   * 13 元以上 → 16~20h。seasons：可种季节（跟现实月份）。 */
  var CROPS = {
    /* 春 */
    strawberry: { id: 'strawberry', name: '草莓',   icon: '🍓', stages: ['🌱', '🌿', '🍓'], sellPrice: 9,  hours: 9,  seasons: ['spring'] },
    hyacinth:   { id: 'hyacinth',   name: '风信子', icon: '🪻', stages: ['🌱', '🌿', '🪻'], sellPrice: 12, hours: 12, seasons: ['spring'] },
    blossom:    { id: 'blossom',    name: '小黄花', icon: '🌼', stages: ['🌱', '🌿', '🌼'], sellPrice: 6,  hours: 5,  seasons: ['spring'] },
    pea:        { id: 'pea',        name: '豌豆',   icon: '🫛', stages: ['🌱', '🌿', '🫛'], sellPrice: 6,  hours: 5,  seasons: ['spring'] },
    /* 夏 */
    sunflower:  { id: 'sunflower',  name: '向日葵', icon: '🌻', stages: ['🌱', '🌿', '🌻'], sellPrice: 10, hours: 10, seasons: ['summer'] },
    watermelon: { id: 'watermelon', name: '西瓜',   icon: '🍉', stages: ['🌱', '🌿', '🍉'], sellPrice: 14, hours: 20, seasons: ['summer'] },
    corn:       { id: 'corn',       name: '玉米',   icon: '🌽', stages: ['🌱', '🌿', '🌽'], sellPrice: 7,  hours: 6,  seasons: ['summer'] },
    mango:      { id: 'mango',      name: '芒果',   icon: '🥭', stages: ['🌱', '🌿', '🥭'], sellPrice: 12, hours: 12, seasons: ['summer'] },
    /* 秋 */
    grape:      { id: 'grape',      name: '葡萄',   icon: '🍇', stages: ['🌱', '🌿', '🍇'], sellPrice: 10, hours: 10, seasons: ['autumn'] },
    pumpkin:    { id: 'pumpkin',    name: '南瓜',   icon: '🎃', stages: ['🌱', '🌿', '🎃'], sellPrice: 13, hours: 16, seasons: ['autumn'] },
    carrot:     { id: 'carrot',     name: '胡萝卜', icon: '🥕', stages: ['🌱', '🌿', '🥕'], sellPrice: 6,  hours: 5,  seasons: ['autumn'] },
    chili:      { id: 'chili',      name: '辣椒',   icon: '🌶️', stages: ['🌱', '🌿', '🌶️'], sellPrice: 7,  hours: 6,  seasons: ['autumn'] },
    /* 冬（耐寒冻棚） */
    broccoli:   { id: 'broccoli',   name: '西兰花', icon: '🥦', stages: ['🌱', '🌿', '🥦'], sellPrice: 8,  hours: 8,  seasons: ['winter'] },
    chestnut:   { id: 'chestnut',   name: '板栗',   icon: '🌰', stages: ['🌱', '🌿', '🌰'], sellPrice: 9,  hours: 9,  seasons: ['winter'] },
    leafy:      { id: 'leafy',      name: '生菜',   icon: '🥬', stages: ['🌱', '🌿', '🥬'], sellPrice: 5,  hours: 4,  seasons: ['winter'] },
    kiwi:       { id: 'kiwi',       name: '猕猴桃', icon: '🥝', stages: ['🌱', '🌿', '🥝'], sellPrice: 11, hours: 11, seasons: ['winter'] }
  };

  Object.keys(CROPS).forEach(function (k) {
    var c = CROPS[k];
    c.seedPrice = Math.ceil(c.sellPrice / 2);
    c.exp = c.sellPrice;
    c.durationMs = c.hours * 3600000;
  });

  /* ── 彩蛋物品（不可种植，收获/偷菜时概率出货；卖价更高） ── */
  var BONUS = {
    fourleaf:  { id: 'fourleaf',  name: '四叶草', icon: '🍀', sellPrice: 88 },
    bear:      { id: 'bear',      name: '小熊',   icon: '🐻', sellPrice: 120 },
    koala:     { id: 'koala',     name: '考拉',   icon: '🐨', sellPrice: 110 },
    rabbit:    { id: 'rabbit',    name: '兔子',   icon: '🐰', sellPrice: 45 },
    fox:       { id: 'fox',       name: '狐狸',   icon: '🦊', sellPrice: 95 },
    sheep:     { id: 'sheep',     name: '小羊',   icon: '🐑', sellPrice: 70 },
    squirrel:  { id: 'squirrel',  name: '松鼠',   icon: '🐿️', sellPrice: 55 },
    beaver:    { id: 'beaver',    name: '海狸',   icon: '🦫', sellPrice: 80 },
    goose:     { id: 'goose',     name: '鹅',     icon: '🪿', sellPrice: 60 },
    parrot:    { id: 'parrot',    name: '鹦鹉',   icon: '🦜', sellPrice: 100 },
    eagle:     { id: 'eagle',     name: '鹰',     icon: '🦅', sellPrice: 150 }
  };
  var BONUS_ANIMAL_IDS = ['bear', 'koala', 'rabbit', 'fox', 'sheep', 'squirrel', 'beaver', 'goose', 'parrot', 'eagle'];

  /* 四叶草/小动物概率池（旧聊天农场同款参数，进度随存档迁移） */
  var FOUR_LEAF_BASE = 0.06, FOUR_LEAF_STEP = 0.005, FOUR_LEAF_CAP = 0.12;
  var ANIMAL_BASE = 0.12, ANIMAL_STEP = 0.01, ANIMAL_CAP = 0.20;

  /* ── 等级 / 地块 / 体力 ── */
  var MAX_LEVEL = 20;
  var PLOT_CAP = 6;
  var RIVAL_PLOT_COUNT = 4;                 /* 角色田固定 4 块 */
  var expNeeded = function (level) { return level * 60; };
  var UNLOCKS = [
    { level: 2, text: '第 4 块农田开垦好了' },
    { level: 3, text: '第 5 块农田开垦好了 · 施肥解锁' },
    { level: 4, text: '第 6 块农田开垦好了' },
    { level: 5, text: '「一键收获」解锁' }
  ];
  var ENERGY_COST = { sow: 2, water: 1, fert: 2, hoe: 1, harvest: 0 };
  var BASE_ENERGY = 20;

  /* ── 现实时钟节奏常量 ── */
  var WITHER_MS = 24 * 3600000;             /* 成熟挂地超 24h 枯萎 */
  var DAY_TICK_CAP = 7;                     /* 离线日结最多补 7 天 */
  var RIVAL_ACT_MS = 40 * 60000;            /* 角色每 40 分钟做一个农活 */
  var RIVAL_HARVEST_DELAY_MS = 20 * 60000;  /* 熟了 20 分钟后角色才自己收（留偷窗） */
  var RIVAL_STEAL_COOLDOWN_MS = 4 * 3600000;/* 角色偷菜冷却 4h */
  var RIVAL_STEAL_CHECK_MS = 30 * 60000;    /* 偷菜判定 30 分钟最多掷一次 */
  var RIVAL_STEAL_CHANCE = 0.65;

  /* ── 天气/事件掷签（每天 0 点一次） ── */
  var WEATHER = [
    { id: 'sunny', icon: '☀️', name: '晴天', weight: 65 },
    { id: 'rain',  icon: '🌧️', name: '雨天', weight: 20 },
    { id: 'crow',  icon: '🐦', name: '乌鸦', weight: 10 },
    { id: 'gift',  icon: '🎁', name: '拾遗', weight: 5 }
  ];

  /* ── 存档（v2） ── */
  function defaultState() {
    var now = Date.now();
    return {
      v: 2,
      gold: 50,
      weather: 'sunny',
      lastDayKey: '',                /* 上次日结的现实日期 YYYY-MM-DD */
      level: 1,
      exp: 0,
      maxEnergy: 20,
      energy: 20,
      rival: { chatId: '', name: '', seeded: false, lastActAt: 0, lastStealAt: 0, lastStealCheckAt: 0 },
      plots: newPlotArray(PLOT_CAP),
      rivalPlots: newPlotArray(RIVAL_PLOT_COUNT),
      barn: {},
      mail: [],
      missFour: 0,
      missAnimal: 0,
      stats: { harvested: 0, earned: 0, daysPlayed: 0, stolenByRival: 0, stolenByMe: 0 },
      legacyMigrated: false,
      savedAt: now
    };
  }

  function newPlotArray(n) {
    var arr = [];
    for (var i = 0; i < n; i++) arr.push(null);
    return arr;
  }

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  var stateCache = null;
  var events = [];            /* 待 UI 层分发的事件（角色偷菜等 → 聊天通知） */

  function readStorage() {
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var synced = global.miyaSyncReadJsonKey(STORAGE_KEY);
      if (synced && typeof synced === 'object') return synced;
    }
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      if (global.miyaLsIsIdbPlaceholder && global.miyaLsIsIdbPlaceholder(raw)) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(state) {
    if (!state) return;
    state.savedAt = Date.now();
    if (typeof global.miyaSyncFlushJsonKey === 'function') {
      global.miyaSyncFlushJsonKey(STORAGE_KEY, state);
      return;
    }
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      global.miyaWriteLsJsonKey(STORAGE_KEY, state).catch(function () {});
      return;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function clampInt(v, lo, hi, fb) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = fb;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ── 旧 v1（过夜制）→ v2（现实时钟制）迁移 ── */
  function migrateV1(raw) {
    var s = defaultState();
    var now = Date.now();
    s.gold = clampInt(raw.gold, 0, 999999, s.gold);
    s.level = clampInt(raw.level, 1, MAX_LEVEL, 1);
    s.exp = clampInt(raw.exp, 0, 999999, 0);
    s.maxEnergy = maxEnergyFor(s.level);
    s.energy = s.maxEnergy;          /* 新的一天从满体力开始 */
    if (Array.isArray(raw.plots)) {
      raw.plots.forEach(function (p, i) {
        if (i >= PLOT_CAP || !p || !CROPS[p.crop]) return;
        var c = CROPS[p.crop];
        var stage = clampInt(p.stage, 0, c.stages.length - 1, 0);
        var np;
        if (stage >= c.stages.length - 1) {
          /* 已熟：按刚成熟处理，给满 24h 收获窗 */
          np = newPlot(c.id, now - c.durationMs);
          np.grownMs = c.durationMs;
          np.matureAt = now;
          np.fert = !!p.fert;
        } else {
          var grown = stage >= 1 ? Math.floor(c.durationMs * 0.6) : 0;
          np = newPlot(c.id, now - grown);
          np.grownMs = grown;
          /* v1 的 watered 是「过夜前浇了水」，对现实时钟制没有意义；
             且 lastTickAt 已对齐到 grown 起点，保留 true 会被 sync 再翻倍。
             迁移日视为新的一天：一律重新浇。 */
          np.watered = false;
          np.fert = !!p.fert;
        }
        s.plots[i] = np;
      });
    }
    if (raw.barn && typeof raw.barn === 'object') {
      Object.keys(raw.barn).forEach(function (k) {
        if (CROPS[k]) s.barn[k] = clampInt(raw.barn[k], 0, 9999, 0);
      });
    }
    if (Array.isArray(raw.mail)) {
      s.mail = raw.mail.slice(0, 30).map(function (m) {
        return m && typeof m === 'object' ? {
          id: String(m.id || ('lm' + now + Math.floor(Math.random() * 999))),
          ts: now, icon: String(m.icon || '📬').slice(0, 4),
          text: String(m.text || '').slice(0, 120), read: !!m.read
        } : null;
      }).filter(Boolean);
    }
    if (raw.stats && typeof raw.stats === 'object') {
      s.stats.harvested = clampInt(raw.stats.harvested, 0, 999999, 0);
      s.stats.earned = clampInt(raw.stats.earned, 0, 999999, 0);
      s.stats.daysPlayed = clampInt(raw.stats.daysPlayed, 0, 99999, 0);
    }
    s.lastDayKey = dayKeyOf(now);
    return s;
  }

  function normPlot(p) {
    if (!p || typeof p !== 'object' || !CROPS[p.crop]) return null;
    return {
      crop: p.crop,
      plantedAt: clampInt(p.plantedAt, 0, 4102444800000, Date.now()),
      grownMs: Math.max(0, Number(p.grownMs) || 0),
      watered: !!p.watered,
      fert: !!p.fert,
      fertToday: !!p.fertToday,
      lastTickAt: clampInt(p.lastTickAt, 0, 4102444800000, Date.now()),
      matureAt: clampInt(p.matureAt, 0, 4102444800000, 0),
      withered: !!p.withered
    };
  }

  /** 非法值防御：读档时逐字段校验 */
  function sanitize(raw) {
    if (raw && raw.v === 1) return migrateV1(raw);
    var d = defaultState();
    if (!raw || typeof raw !== 'object') return d;
    var s = d;
    s.gold    = clampInt(raw.gold, 0, 999999, d.gold);
    s.level   = clampInt(raw.level, 1, MAX_LEVEL, 1);
    s.exp     = clampInt(raw.exp, 0, 999999, 0);
    s.weather = ['sunny', 'rain', 'crow', 'gift'].indexOf(raw.weather) >= 0 ? raw.weather : 'sunny';
    s.lastDayKey = String(raw.lastDayKey || '').slice(0, 10);
    s.maxEnergy = maxEnergyFor(s.level);
    s.energy  = clampInt(raw.energy, 0, s.maxEnergy, s.maxEnergy);
    if (raw.rival && typeof raw.rival === 'object') {
      s.rival = {
        chatId: String(raw.rival.chatId || '').slice(0, 60),
        name: String(raw.rival.name || '').slice(0, 30),
        seeded: !!raw.rival.seeded,
        lastActAt: clampInt(raw.rival.lastActAt, 0, 4102444800000, 0),
        lastStealAt: clampInt(raw.rival.lastStealAt, 0, 4102444800000, 0),
        lastStealCheckAt: clampInt(raw.rival.lastStealCheckAt, 0, 4102444800000, 0)
      };
    }
    if (Array.isArray(raw.plots)) {
      s.plots = d.plots.map(function (_, i) { return normPlot(raw.plots[i]); });
    }
    if (Array.isArray(raw.rivalPlots)) {
      s.rivalPlots = d.rivalPlots.map(function (_, i) { return normPlot(raw.rivalPlots[i]); });
    }
    if (raw.barn && typeof raw.barn === 'object') {
      Object.keys(raw.barn).forEach(function (k) {
        if (CROPS[k] || BONUS[k]) s.barn[k] = clampInt(raw.barn[k], 0, 9999, 0);
      });
    }
    if (Array.isArray(raw.mail)) {
      s.mail = raw.mail.slice(0, 30).map(function (m) {
        return m && typeof m === 'object' ? {
          id: String(m.id || ''), ts: clampInt(m.ts, 0, 4102444800000, Date.now()),
          icon: String(m.icon || '📬').slice(0, 4), text: String(m.text || '').slice(0, 120),
          read: !!m.read
        } : null;
      }).filter(Boolean);
    }
    s.missFour = Math.max(0, clampInt(raw.missFour, 0, 999, 0));
    s.missAnimal = Math.max(0, clampInt(raw.missAnimal, 0, 999, 0));
    if (raw.stats && typeof raw.stats === 'object') {
      s.stats = {
        harvested: clampInt(raw.stats.harvested, 0, 999999, 0),
        earned: clampInt(raw.stats.earned, 0, 999999, 0),
        daysPlayed: clampInt(raw.stats.daysPlayed, 0, 99999, 0),
        stolenByRival: clampInt(raw.stats.stolenByRival, 0, 99999, 0),
        stolenByMe: clampInt(raw.stats.stolenByMe, 0, 99999, 0)
      };
    }
    s.legacyMigrated = !!raw.legacyMigrated;
    return s;
  }

  /* ── 派生量 ── */
  function maxEnergyFor(level) { return Math.min(32, BASE_ENERGY + (level - 1) * 2); }
  function plotCountFor(level) {
    if (level >= 4) return 6;
    if (level >= 3) return 5;
    if (level >= 2) return 4;
    return 3;
  }
  function hasFert(level) { return level >= 3; }
  function hasBulkHarvest(level) { return level >= 5; }

  /* ── 现实日历 ── */
  function seasonByMonth(month) {
    for (var i = 0; i < SEASONS.length; i++) {
      if (SEASONS[i].months.indexOf(month) >= 0) return SEASONS[i];
    }
    return SEASONS[0];
  }
  function calendarNow(ts) {
    var d = new Date(ts || Date.now());
    var season = seasonByMonth(d.getMonth() + 1);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      weekday: '周' + WEEKDAYS[d.getDay()],
      season: season,
      dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日'
    };
  }
  function dayKeyOf(ts) {
    var d = new Date(ts);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }
  /* 某日 key 的次日 0 点时间戳 */
  function nextDayTs(key) {
    var p = String(key || '').split('-');
    var y = parseInt(p[0], 10) || 1970;
    var mo = parseInt(p[1], 10) || 1;
    var da = parseInt(p[2], 10) || 1;
    return new Date(y, mo - 1, da + 1, 0, 0, 0, 0).getTime();
  }

  function seasonCrops(seasonId) {
    return Object.keys(CROPS).filter(function (k) {
      return CROPS[k].seasons.indexOf(seasonId) >= 0;
    });
  }
  function seasonNow(ts) { return calendarNow(ts).season.id; }

  /* ── 地块状态（现实时钟推导） ── */
  function newPlot(cropId, plantedAt) {
    return {
      crop: cropId,
      plantedAt: plantedAt || Date.now(),
      grownMs: 0,
      watered: false,
      fert: false,
      fertToday: false,
      lastTickAt: plantedAt || Date.now(),
      matureAt: 0,
      withered: false
    };
  }
  function plotStage(p) {
    if (!p) return -1;
    var c = CROPS[p.crop];
    if (!c) return -1;
    if (p.grownMs >= c.durationMs) return c.stages.length - 1;
    return p.grownMs >= c.durationMs * 0.5 ? 1 : 0;
  }
  function plotMature(p) {
    if (!p) return false;
    var c = CROPS[p.crop];
    return !!c && p.grownMs >= c.durationMs;
  }
  function plotWithered(p) { return !!(p && p.withered); }
  function plotDurMs(p) { return p && CROPS[p.crop] ? CROPS[p.crop].durationMs : 0; }
  function plotProgress(p) {
    var d = plotDurMs(p);
    return d ? Math.min(1, (p.grownMs || 0) / d) : 1;
  }
  /* 距成熟还剩多久（已熟返回 0） */
  function plotRemainMs(p) {
    if (!p || plotMature(p)) return 0;
    return Math.max(0, plotDurMs(p) - (p.grownMs || 0));
  }
  /* 距枯萎还剩多久（未熟/已枯返回 Infinity 语义用 0 区分：<=0 且已熟=已枯） */
  function plotWitherRemainMs(p, now) {
    if (!p || !plotMature(p) || p.withered) return -1;
    return Math.max(0, p.matureAt + WITHER_MS - (now || Date.now()));
  }

  /**
   * 推进一块地：只在「浇了水」的时段累积生长。
   * 缺水 = 暂停生长（雨天才替你浇）；成熟后不再需要水，挂地超 24h 枯萎。
   */
  function advancePlot(p, now) {
    if (!p) return false;
    var c = CROPS[p.crop];
    if (!c) return false;
    var dirty = false;
    if (p.withered) { p.lastTickAt = now; return false; }
    var wasMature = p.grownMs >= c.durationMs;
    if (!wasMature && p.watered) {
      var dt = Math.max(0, now - (p.lastTickAt || now));
      if (dt > 0) { p.grownMs += dt; dirty = true; }
    }
    if (!wasMature && p.grownMs >= c.durationMs) {
      /* 刚好成熟的时刻 ≈ 现在 - 超长出来的部分 */
      p.matureAt = now - Math.max(0, p.grownMs - c.durationMs);
      if (p.matureAt < p.plantedAt) p.matureAt = p.plantedAt;
      dirty = true;
    } else if (wasMature && !p.matureAt) {
      p.matureAt = p.plantedAt + c.durationMs;
      dirty = true;
    }
    if (p.grownMs >= c.durationMs && !p.withered &&
        p.matureAt && now - p.matureAt >= WITHER_MS) {
      p.withered = true;
      dirty = true;
    }
    p.lastTickAt = now;
    return dirty;
  }

  function advanceAll(s, now) {
    var dirty = false;
    var i, p;
    for (i = 0; i < s.plots.length; i++) {
      if (advancePlot(s.plots[i], now)) dirty = true;
      p = s.plots[i];
      if (p && p.withered && !p._witherMail) {
        p._witherMail = true;
        var pc = CROPS[p.crop];
        addMail('🥀', '挂地太久，' + pc.icon + pc.name + '枯萎了…点它清理，别让田荒了。');
        dirty = true;
      }
    }
    for (i = 0; i < s.rivalPlots.length; i++) {
      if (advancePlot(s.rivalPlots[i], now)) dirty = true;
    }
    return dirty;
  }

  /* ── 日结（每天 0 点一次；离线最多补 7 天） ── */
  function doDayTick(s, ts) {
    var cal = calendarNow(ts);
    var prevMonth = s.lastDayKey ? parseInt(s.lastDayKey.split('-')[1], 10) : cal.month;
    var w = rollWeather();
    var i, p;

    /* 新的一天：浇水状态清零（下雨再浇回来）、施肥当日标记清零 */
    for (i = 0; i < s.plots.length; i++) {
      p = s.plots[i];
      if (!p) continue;
      p.watered = false;
      p.fertToday = false;
    }

    /* 乌鸦：叼走一块没浇水的未成熟作物（先于下雨判定，机制原样保留） */
    if (w.id === 'crow') {
      var candidates = [];
      for (i = 0; i < s.plots.length; i++) {
        p = s.plots[i];
        if (p && !p.watered && p.grownMs < plotDurMs(p) && !p.withered) candidates.push(i);
      }
      if (candidates.length) {
        var vi = candidates[Math.floor(Math.random() * candidates.length)];
        var vc = CROPS[s.plots[vi].crop];
        s.plots[vi] = null;
        addMail('🐦', '乌鸦把一块没浇水的' + vc.icon + vc.name + '叼走了…记得天天浇水。');
      }
    }

    /* 雨天：全田自动浇透 */
    if (w.id === 'rain') {
      for (i = 0; i < s.plots.length; i++) {
        p = s.plots[i];
        if (p && !p.withered && p.grownMs < plotDurMs(p)) p.watered = true;
      }
    }

    /* 拾遗 */
    if (w.id === 'gift') {
      var bonus = 10 + Math.floor(Math.random() * 21);
      s.gold = Math.min(999999, s.gold + bonus);
      addMail('🎁', '在田埂边捡到一个钱袋，+' + bonus + ' 金币！');
    }

    s.weather = w.id;
    s.energy = s.maxEnergy;         /* 体力每天 0 点回满 */
    s.stats.daysPlayed = clampInt(s.stats.daysPlayed, 0, 99998, 0) + 1;

    /* 换月 = 换季提醒 */
    if (prevMonth !== cal.month) {
      addMail(cal.season.icon, cal.month + '月到了，' + cal.season.name + '天正当时，当季种子换了一批，去种子铺看看。');
    }
  }

  function runDayTicks(s, now) {
    if (!s.lastDayKey) {
      s.lastDayKey = dayKeyOf(now);
      return false;
    }
    var dirty = false;
    var guard = 0;
    var next = nextDayTs(s.lastDayKey);
    while (next <= now && guard < DAY_TICK_CAP) {
      doDayTick(s, next);
      s.lastDayKey = dayKeyOf(next);
      next = nextDayTs(s.lastDayKey);
      guard++;
      dirty = true;
    }
    if (guard >= DAY_TICK_CAP && next <= now) {
      /* 离线太久：剩余的日子直接翻过，不再逐日掷签 */
      s.lastDayKey = dayKeyOf(now);
    }
    return dirty;
  }

  /* ── 角色田（对手 = 当前聊天对象） ── */
  function setRival(chatId, name) {
    var s = getState();
    var id = String(chatId || '');
    if (!id) return s;
    if (s.rival.chatId !== id) {
      s.rival = { chatId: id, name: String(name || '').slice(0, 30), seeded: false, lastActAt: 0, lastStealAt: 0, lastStealCheckAt: 0 };
    } else if (name && s.rival.name !== String(name).slice(0, 30)) {
      s.rival.name = String(name).slice(0, 30);
    }
    save();
    return s;
  }

  function rivalSow(s, ts, count) {
    var ids = seasonCrops(seasonNow(ts));
    if (!ids.length) return 0;
    var n = 0;
    for (var i = 0; i < s.rivalPlots.length && n < count; i++) {
      if (!s.rivalPlots[i]) {
        var p = newPlot(ids[Math.floor(Math.random() * ids.length)], ts);
        p.watered = true;         /* 角色很勤快，种下就浇 */
        s.rivalPlots[i] = p;
        n++;
      }
    }
    return n;
  }

  function rivalDoAction(s, ts) {
    var i, p;
    /* 1) 熟了有一会儿的先收进自家粮仓（给玩家留偷窗） */
    for (i = 0; i < s.rivalPlots.length; i++) {
      p = s.rivalPlots[i];
      if (p && plotMature(p) && !p.withered && ts - p.matureAt >= RIVAL_HARVEST_DELAY_MS) {
        s.rivalPlots[i] = null;
        return;
      }
    }
    /* 2) 枯了的自己锄掉 */
    for (i = 0; i < s.rivalPlots.length; i++) {
      p = s.rivalPlots[i];
      if (p && p.withered) { s.rivalPlots[i] = null; return; }
    }
    /* 3) 空地补种 */
    rivalSow(s, ts, 1);
  }

  function rivalTick(s, now) {
    if (!s.rival.chatId) return false;
    var dirty = false;
    if (!s.rival.seeded) {
      /* 初次绑定：先给两块正在长的地，营造「对方也在经营」的感觉 */
      rivalSow(s, now - 30 * 60000, 2);
      s.rival.seeded = true;
      s.rival.lastActAt = now - RIVAL_ACT_MS;
      dirty = true;
    }
    var guard = 0;
    while (now - s.rival.lastActAt >= RIVAL_ACT_MS && guard < 12) {
      s.rival.lastActAt += RIVAL_ACT_MS;
      rivalDoAction(s, Math.min(s.rival.lastActAt, now));
      guard++;
      dirty = true;
    }
    return dirty;
  }

  function rivalStealCheck(s, now) {
    if (!s.rival.chatId) return false;
    if (!s.rival.lastStealCheckAt) { s.rival.lastStealCheckAt = now; return false; }
    if (now - s.rival.lastStealCheckAt < RIVAL_STEAL_CHECK_MS) return false;
    s.rival.lastStealCheckAt = now;
    if (now - (s.rival.lastStealAt || 0) < RIVAL_STEAL_COOLDOWN_MS) return false;
    var candidates = [];
    for (var i = 0; i < s.plots.length; i++) {
      var p = s.plots[i];
      if (p && plotMature(p) && !p.withered) candidates.push(i);
    }
    if (!candidates.length) return false;
    if (Math.random() >= RIVAL_STEAL_CHANCE) return false;
    var vi = candidates[Math.floor(Math.random() * candidates.length)];
    var c = CROPS[s.plots[vi].crop];
    s.plots[vi] = null;
    s.rival.lastStealAt = now;
    s.stats.stolenByRival = clampInt(s.stats.stolenByRival, 0, 99998, 0) + 1;
    var who = s.rival.name || '对方';
    addMail('🕵️', who + '偷走了你的' + c.icon + c.name + '！打开TA的田去反击。');
    events.push({
      type: 'rivalSteal',
      chatId: s.rival.chatId,
      name: who,
      cropIcon: c.icon,
      cropName: c.name
    });
    return true;
  }

  /* ── 总同步：生长补算 + 日结 + 角色行为。所有入口（农场/速览/角标）都走这里 ── */
  function sync(now) {
    now = now || Date.now();
    var s = getState();
    var dirty = false;
    var nextTs = s.lastDayKey ? nextDayTs(s.lastDayKey) : 0;
    var t1 = nextTs ? Math.min(now, nextTs) : now;
    if (advanceAll(s, t1)) dirty = true;
    if (runDayTicks(s, now)) dirty = true;
    if (advanceAll(s, now)) dirty = true;
    if (rivalTick(s, now)) dirty = true;
    if (rivalStealCheck(s, now)) dirty = true;
    if (dirty) save();
    return getState();
  }

  function takeEvents() {
    var e = events;
    events = [];
    return e;
  }

  /* ── 彩蛋掷签（收获/偷菜共用；概率池按玩家独立累计） ── */
  function fourLeafChance(s) {
    return Math.min(FOUR_LEAF_CAP, FOUR_LEAF_BASE + s.missFour * FOUR_LEAF_STEP);
  }
  function animalChance(s) {
    return Math.min(ANIMAL_CAP, ANIMAL_BASE + s.missAnimal * ANIMAL_STEP);
  }
  function rollHarvestBonuses(s) {
    var out = { fourleaf: null, animal: null };
    if (Math.random() < fourLeafChance(s)) {
      s.missFour = 0;
      s.barn.fourleaf = (s.barn.fourleaf || 0) + 1;
      out.fourleaf = BONUS.fourleaf;
    } else {
      s.missFour++;
    }
    if (Math.random() < animalChance(s)) {
      s.missAnimal = 0;
      var id = BONUS_ANIMAL_IDS[Math.floor(Math.random() * BONUS_ANIMAL_IDS.length)];
      s.barn[id] = (s.barn[id] || 0) + 1;
      out.animal = BONUS[id];
    } else {
      s.missAnimal++;
    }
    return out;
  }

  /* ── 偷角色田（UI 层调用；免费、无体力） ── */
  function stealRivalPlot(i, now) {
    now = now || Date.now();
    var s = getState();
    var p = s.rivalPlots[i];
    if (!p) return { ok: false, error: '这块地空着' };
    if (!plotMature(p)) return { ok: false, error: '还没熟，偷不了' };
    if (p.withered) return { ok: false, error: '已经枯了，下手太晚啦' };
    var c = CROPS[p.crop];
    s.rivalPlots[i] = null;
    s.barn[c.id] = (s.barn[c.id] || 0) + 1;
    s.stats.stolenByMe = clampInt(s.stats.stolenByMe, 0, 99998, 0) + 1;
    var bonus = rollHarvestBonuses(s);
    addMail('🥷', '你从' + (s.rival.name || '对方') + '田里偷走了' + c.icon + c.name + '，反击成功！');
    save();
    return { ok: true, crop: c, bonus: bonus };
  }

  /* ── 旧聊天农场仓库存货折算迁移（由 MiyaChatFarm 扫描后调用，一次性） ── */
  function applyLegacyMigration(totalGold, missFour, missAnimal) {
    var s = getState();
    if (s.legacyMigrated) return { applied: false, gold: 0 };
    s.legacyMigrated = true;
    var gold = Math.max(0, Math.floor(totalGold) || 0);
    s.gold = Math.min(999999, s.gold + gold);
    s.missFour = Math.max(s.missFour, Math.max(0, Math.floor(missFour) || 0));
    s.missAnimal = Math.max(s.missAnimal, Math.max(0, Math.floor(missAnimal) || 0));
    if (gold > 0) {
      addMail('🌱', '小农场光荣退休：仓库存货折算 ' + gold + ' 金币已到账。以后常回星露看看！');
    } else {
      addMail('🌱', '小农场光荣退休，家当都搬进了星露农场。以后常回来看看！');
    }
    save();
    return { applied: true, gold: gold };
  }

  /* ── 公开 API ── */
  function getState() {
    if (!stateCache) stateCache = sanitize(readStorage());
    return stateCache;
  }
  function save() { writeStorage(stateCache); return clone(stateCache); }
  function setState(next) { stateCache = sanitize(Object.assign(defaultState(), next)); return clone(stateCache); }
  function resetSave() { stateCache = defaultState(); writeStorage(stateCache); return clone(stateCache); }

  function hydrateFromIdb() {
    if (typeof global.miyaReadLsJsonKey !== 'function') return Promise.resolve(getState());
    return global.miyaReadLsJsonKey(STORAGE_KEY, null).then(function (v) {
      if (!v || typeof v !== 'object') return getState();
      var cur = getState();
      var idbTime = parseInt(v.savedAt, 10) || 0;
      var curTime = parseInt(cur.savedAt, 10) || 0;
      if (idbTime >= curTime) stateCache = sanitize(v);
      return getState();
    }).catch(function () {
      return getState();
    });
  }

  function spendGold(n) {
    var s = getState();
    if (s.gold < n) return false;
    s.gold -= n;
    return true;
  }
  function gainGold(n) { getState().gold = Math.min(999999, getState().gold + n); }

  function addExp(n) {
    var s = getState();
    var ups = [];
    s.exp += n;
    while (s.level < MAX_LEVEL && s.exp >= expNeeded(s.level)) {
      s.exp -= expNeeded(s.level);
      s.level += 1;
      s.maxEnergy = maxEnergyFor(s.level);
      ups.push(s.level);
    }
    if (s.level >= MAX_LEVEL) s.exp = Math.min(s.exp, expNeeded(MAX_LEVEL));
    return ups;
  }

  function unlockTexts(levels) {
    return levels.map(function (lv) {
      var u = UNLOCKS.filter(function (x) { return x.level === lv; })[0];
      return u ? { level: lv, text: u.text } : { level: lv, text: '农场主 Lv.' + lv + ' 了！' };
    });
  }

  function addMail(icon, text) {
    var s = getState();
    s.mail.unshift({
      id: 'm' + Date.now() + Math.floor(Math.random() * 999),
      ts: Date.now(), icon: icon, text: text, read: false
    });
    if (s.mail.length > 30) s.mail.length = 30;
  }

  function unreadMailCount() {
    return getState().mail.filter(function (m) { return !m.read; }).length;
  }

  function rollWeather(rand) {
    var total = WEATHER.reduce(function (a, w) { return a + w.weight; }, 0);
    var r = (rand || Math.random()) * total;
    for (var i = 0; i < WEATHER.length; i++) {
      r -= WEATHER[i].weight;
      if (r < 0) return WEATHER[i];
    }
    return WEATHER[0];
  }

  function itemMeta(id) { return CROPS[id] || BONUS[id] || null; }

  global.MiyaFarmGameStore = {
    STORAGE_KEY: STORAGE_KEY,
    CROPS: CROPS,
    BONUS: BONUS,
    BONUS_ANIMAL_IDS: BONUS_ANIMAL_IDS,
    SEASONS: SEASONS,
    ENERGY_COST: ENERGY_COST,
    PLOT_CAP: PLOT_CAP,
    RIVAL_PLOT_COUNT: RIVAL_PLOT_COUNT,
    WITHER_MS: WITHER_MS,
    WEATHER: WEATHER,
    FOUR_LEAF_BASE: FOUR_LEAF_BASE,
    expNeeded: expNeeded,
    maxEnergyFor: maxEnergyFor,
    plotCountFor: plotCountFor,
    hasFert: hasFert,
    hasBulkHarvest: hasBulkHarvest,
    calendarNow: calendarNow,
    seasonCrops: seasonCrops,
    seasonNow: seasonNow,
    itemMeta: itemMeta,
    newPlot: newPlot,
    plotStage: plotStage,
    plotMature: plotMature,
    plotWithered: plotWithered,
    plotDurMs: plotDurMs,
    plotProgress: plotProgress,
    plotRemainMs: plotRemainMs,
    plotWitherRemainMs: plotWitherRemainMs,
    getState: getState,
    setState: setState,
    save: save,
    resetSave: resetSave,
    hydrateFromIdb: hydrateFromIdb,
    sync: sync,
    takeEvents: takeEvents,
    setRival: setRival,
    stealRivalPlot: stealRivalPlot,
    rollHarvestBonuses: rollHarvestBonuses,
    applyLegacyMigration: applyLegacyMigration,
    spendGold: spendGold,
    gainGold: gainGold,
    addExp: addExp,
    unlockTexts: unlockTexts,
    addMail: addMail,
    unreadMailCount: unreadMailCount,
    rollWeather: rollWeather,
    defaultState: defaultState
  };
})(typeof window !== 'undefined' ? window : self);
