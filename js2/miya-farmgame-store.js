/* miya-farmgame-store.js — 星露农场 · 数据与存档层
 *
 * 回合制小农场（对标小红书海报的"星露谷 Lite"）：
 *   日历（年/季/日）· 体力 · 金币 · 等级经验 · 地块 · 仓库 · 信箱
 * 与 js1/miya-chat-farm.js（聊天双人农场，现实时钟制）完全独立，
 * 不共享存档、不抢入口；只复用「安全写盘」工具函数。
 *
 * 存档 key：miya-farmgame-v1（localStorage JSON）。
 * 写盘优先走 miyaSyncFlushJsonKey / miyaWriteLsJsonKey（带 IDB 冗余），
 * 与美化模块同一套兜底顺序 —— 配额满/隐私模式不会静默丢档。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-farmgame-v1';

  /* ── 日历 ───────────────────────────────────────────────
   * 一年 = 4 季 × 14 天 = 56 天。day 从 1 计。
   * 季节决定「当季可种作物」，冬天只有耐寒作物可种。 */
  var DAYS_PER_SEASON = 14;
  var SEASONS = [
    { id: 'spring', name: '春', icon: '🌱', tone: 'spring' },
    { id: 'summer', name: '夏', icon: '☀️', tone: 'summer' },
    { id: 'autumn', name: '秋', icon: '🍂', tone: 'autumn' },
    { id: 'winter', name: '冬', icon: '❄️', tone: 'winter' }
  ];

  /* ── 作物表 ─────────────────────────────────────────────
   * stages：生长阶段 emoji（最后一格 = 成熟）；seedPrice 买入，sellPrice 卖出。
   * seasons：可种季节；exp = 收获经验（= sellPrice，四舍五入已有梯度）。
   * 只收 16 种（每季 4 种），全部来自现有聊天农场作物表，emoji 一致。 */
  var CROPS = {
    /* 春 */
    strawberry: { id: 'strawberry', name: '草莓',   icon: '🍓', stages: ['🌱', '🌿', '🍓'], sellPrice: 9,  seasons: ['spring'] },
    hyacinth:   { id: 'hyacinth',   name: '风信子', icon: '🪻', stages: ['🌱', '🌿', '🪻'], sellPrice: 12, seasons: ['spring'] },
    blossom:    { id: 'blossom',    name: '小黄花', icon: '🌼', stages: ['🌱', '🌿', '🌼'], sellPrice: 6,  seasons: ['spring'] },
    pea:        { id: 'pea',        name: '豌豆',   icon: '🫛', stages: ['🌱', '🌿', '🫛'], sellPrice: 6,  seasons: ['spring'] },
    /* 夏 */
    sunflower:  { id: 'sunflower',  name: '向日葵', icon: '🌻', stages: ['🌱', '🌿', '🌻'], sellPrice: 10, seasons: ['summer'] },
    watermelon: { id: 'watermelon', name: '西瓜',   icon: '🍉', stages: ['🌱', '🌿', '🍉'], sellPrice: 14, seasons: ['summer'] },
    corn:       { id: 'corn',       name: '玉米',   icon: '🌽', stages: ['🌱', '🌿', '🌽'], sellPrice: 7,  seasons: ['summer'] },
    mango:      { id: 'mango',      name: '芒果',   icon: '🥭', stages: ['🌱', '🌿', '🥭'], sellPrice: 12, seasons: ['summer'] },
    /* 秋 */
    grape:      { id: 'grape',      name: '葡萄',   icon: '🍇', stages: ['🌱', '🌿', '🍇'], sellPrice: 10, seasons: ['autumn'] },
    pumpkin:    { id: 'pumpkin',    name: '南瓜',   icon: '🎃', stages: ['🌱', '🌿', '🎃'], sellPrice: 13, seasons: ['autumn'] },
    carrot:     { id: 'carrot',     name: '胡萝卜', icon: '🥕', stages: ['🌱', '🌿', '🥕'], sellPrice: 6,  seasons: ['autumn'] },
    chili:      { id: 'chili',      name: '辣椒',   icon: '🌶️', stages: ['🌱', '🌿', '🌶️'], sellPrice: 7,  seasons: ['autumn'] },
    /* 冬（耐寒冻棚） */
    broccoli:   { id: 'broccoli',   name: '西兰花', icon: '🥦', stages: ['🌱', '🌿', '🥦'], sellPrice: 8,  seasons: ['winter'] },
    chestnut:   { id: 'chestnut',   name: '板栗',   icon: '🌰', stages: ['🌱', '🌿', '🌰'], sellPrice: 9,  seasons: ['winter'] },
    leafy:      { id: 'leafy',      name: '生菜',   icon: '🥬', stages: ['🌱', '🌿', '🥬'], sellPrice: 5,  seasons: ['winter'] },
    kiwi:       { id: 'kiwi',       name: '猕猴桃', icon: '🥝', stages: ['🌱', '🌿', '🥝'], sellPrice: 11, seasons: ['winter'] }
  };

  /* 种子价 = 售价一半（向上取整），收获经验 = 售价 */
  Object.keys(CROPS).forEach(function (k) {
    var c = CROPS[k];
    c.seedPrice = Math.ceil(c.sellPrice / 2);
    c.exp = c.sellPrice;
  });

  /* ── 等级表 ─────────────────────────────────────────────
   * 升级需求 = level * 60。解锁线对齐海报节奏（一键收获低配版 Lv5）。 */
  var MAX_LEVEL = 20;
  var PLOT_CAP = 6;              /* 地块上限 */
  var expNeeded = function (level) { return level * 60; };

  var UNLOCKS = [
    { level: 2, text: '第 4 块农田开垦好了' },
    { level: 3, text: '第 5 块农田开垦好了 · 施肥解锁' },
    { level: 4, text: '第 6 块农田开垦好了' },
    { level: 5, text: '「一键收获」解锁' }
  ];

  /* ── 动作体力 ── */
  var ENERGY_COST = { sow: 2, water: 1, fert: 2, hoe: 1, harvest: 0 };
  var BASE_ENERGY = 20;          /* Lv1 体力上限，每级 +2，封顶 32 */

  /* ── 天气/事件掷签（进入次日） ── */
  var WEATHER = [
    { id: 'sunny', icon: '☀️', name: '晴天', weight: 65 },
    { id: 'rain',  icon: '🌧️', name: '雨天', weight: 20 },  /* 全田自动浇水 */
    { id: 'crow',  icon: '🐦', name: '乌鸦', weight: 10 },  /* 吃掉一块未浇水作物 */
    { id: 'gift',  icon: '🎁', name: '拾遗', weight: 5 }    /* 捡到金币 */
  ];

  /* ── 存档 ── */
  function defaultState() {
    return {
      v: 1,
      gold: 50,
      day: 1,
      weather: 'sunny',
      level: 1,
      exp: 0,
      maxEnergy: 20,
      energy: 20,
      plots: [null, null, null, null, null, null],  /* 6 槽，可见数由等级决定 */
      barn: {},          /* { cropId: 数量 } */
      mail: [],          /* { id, day, icon, text, read } */
      stats: { harvested: 0, earned: 0, daysPlayed: 0 },
      savedAt: 0
    };
  }

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  var stateCache = null;

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

  /** 非法值防御：读档时逐字段校验（存档可能来自旧版本/手改） */
  function sanitize(raw) {
    var d = defaultState();
    if (!raw || typeof raw !== 'object') return d;
    var s = d;
    s.gold    = clampInt(raw.gold, 0, 999999, d.gold);
    s.day     = clampInt(raw.day, 1, 99999, d.day);
    s.level   = clampInt(raw.level, 1, MAX_LEVEL, 1);
    s.exp     = clampInt(raw.exp, 0, 999999, 0);
    s.weather = ['sunny', 'rain', 'crow', 'gift'].indexOf(raw.weather) >= 0 ? raw.weather : 'sunny';
    s.maxEnergy = maxEnergyFor(s.level);
    s.energy  = clampInt(raw.energy, 0, s.maxEnergy, s.maxEnergy);
    if (Array.isArray(raw.plots)) {
      s.plots = d.plots.map(function (_, i) {
        var p = raw.plots[i];
        if (!p || typeof p !== 'object') return null;
        if (!CROPS[p.crop]) return null;
        return {
          crop: p.crop,
          stage: clampInt(p.stage, 0, CROPS[p.crop].stages.length - 1, 0),
          watered: !!p.watered,
          fert: !!p.fert,
          fertToday: !!p.fertToday
        };
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
          id: String(m.id || ''), day: clampInt(m.day, 1, 99999, 1),
          icon: String(m.icon || '📬').slice(0, 4), text: String(m.text || '').slice(0, 120),
          read: !!m.read
        } : null;
      }).filter(Boolean);
    }
    if (raw.stats && typeof raw.stats === 'object') {
      s.stats = {
        harvested: clampInt(raw.stats.harvested, 0, 999999, 0),
        earned: clampInt(raw.stats.earned, 0, 999999, 0),
        daysPlayed: clampInt(raw.stats.daysPlayed, 0, 99999, 0)
      };
    }
    return s;
  }

  function clampInt(v, lo, hi, fb) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = fb;
    return Math.max(lo, Math.min(hi, n));
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

  function calendarOf(day) {
    var idx = (day - 1) % (DAYS_PER_SEASON * 4);
    var season = SEASONS[Math.floor(idx / DAYS_PER_SEASON)];
    var dInSeason = (idx % DAYS_PER_SEASON) + 1;
    var year = Math.floor((day - 1) / (DAYS_PER_SEASON * 4)) + 1;
    return { year: year, season: season, day: dInSeason, dayAbs: day };
  }

  function seasonCrops(seasonId) {
    return Object.keys(CROPS).filter(function (k) {
      return CROPS[k].seasons.indexOf(seasonId) >= 0;
    });
  }

  /* ── 公开 API ── */
  function getState() {
    if (!stateCache) stateCache = sanitize(readStorage());
    return stateCache;
  }

  function save() { writeStorage(stateCache); return clone(stateCache); }

  /** 替换当前状态（过夜结算/重开档用），不落盘 —— 由调用方决定何时 save */
  function setState(next) { stateCache = sanitize(Object.assign(defaultState(), next)); return clone(stateCache); }

  function resetSave() { stateCache = defaultState(); writeStorage(stateCache); return clone(stateCache); }

  /**
   * 异步水合：项目的存储体系是「localStorage 镜像 + IDB 主存」——
   * miyaSyncFlushJsonKey 同步写镜像后异步落 IDB，IDB 确认成功会把镜像
   * 替换成 {"__storedInIdb":true} 占位符。此后冷启动时同步读
   * （miyaSyncReadJsonKey）只能拿到占位符，必须走 miyaReadLsJsonKey
   * 异步从 IDB 取回真档。savedAt 比较防止旧 IDB 快照覆盖更新的内存态。
   */
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

  /** 加金币/扣金币，返回是否成功（余额不足=false） */
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
    return ups;   /* 返回新达成的等级列表，UI 据此弹升级信 */
  }

  function unlockTexts(levels) {
    return levels.map(function (lv) {
      var u = UNLOCKS.filter(function (x) { return x.level === lv; })[0];
      return u ? { level: lv, text: u.text } : { level: lv, text: '农场主 Lv.' + lv + ' 了！' };
    });
  }

  function addMail(icon, text) {
    var s = getState();
    s.mail.unshift({ id: 'm' + Date.now() + Math.floor(Math.random() * 999), day: s.day, icon: icon, text: text, read: false });
    if (s.mail.length > 30) s.mail.length = 30;
  }

  function unreadMailCount() {
    return getState().mail.filter(function (m) { return !m.read; }).length;
  }

  /* 按权重掷一次天气/事件 */
  function rollWeather(rand) {
    var total = WEATHER.reduce(function (a, w) { return a + w.weight; }, 0);
    var r = (rand || Math.random()) * total;
    for (var i = 0; i < WEATHER.length; i++) {
      r -= WEATHER[i].weight;
      if (r < 0) return WEATHER[i];
    }
    return WEATHER[0];
  }

  global.MiyaFarmGameStore = {
    STORAGE_KEY: STORAGE_KEY,
    CROPS: CROPS,
    SEASONS: SEASONS,
    DAYS_PER_SEASON: DAYS_PER_SEASON,
    ENERGY_COST: ENERGY_COST,
    PLOT_CAP: PLOT_CAP,
    WEATHER: WEATHER,
    expNeeded: expNeeded,
    maxEnergyFor: maxEnergyFor,
    plotCountFor: plotCountFor,
    hasFert: hasFert,
    hasBulkHarvest: hasBulkHarvest,
    calendarOf: calendarOf,
    seasonCrops: seasonCrops,
    getState: getState,
    setState: setState,
    save: save,
    resetSave: resetSave,
    hydrateFromIdb: hydrateFromIdb,
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
