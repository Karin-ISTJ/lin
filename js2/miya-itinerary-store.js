/**
 * miya-itinerary-store.js — 行程轨迹数据持久化
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'miya-itinerary-v1';
  var WEEK_DAYS = 7;
  var WD_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var cache = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function isoDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseIso(s) {
    var parts = String(s || '').split('-').map(Number);
    if (parts.length < 3) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  /* 清理历史遗留的失败冷却数据。
     旧版本会把 failCooldown 写进 STORAGE_KEY，机制删掉之后这些字段没有任何读者，
     但会一直躺在存储里。这里在首次读取时顺手抹掉，避免脏数据长期残留。 */
  function dropLegacyFailCooldown(obj) {
    if (obj && typeof obj === 'object' && obj.failCooldown) {
      delete obj.failCooldown;
      return true;
    }
    return false;
  }

  function loadRaw() {
    if (cache) return cache;
    if (typeof global.miyaSyncReadJsonKey === 'function') {
      var mem = global.miyaSyncReadJsonKey(STORAGE_KEY);
      if (mem && typeof mem === 'object') {
        cache = mem;
        if (dropLegacyFailCooldown(cache)) saveRaw();
        if (!cache.settings || typeof cache.settings !== 'object') cache.settings = { autoGenerate: false };
        if (!cache.enabled || typeof cache.enabled !== 'object') cache.enabled = {};
        if (!cache.schedules || typeof cache.schedules !== 'object') cache.schedules = {};
        return cache;
      }
    }
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw && !(global.miyaLsIsIdbPlaceholder && global.miyaLsIsIdbPlaceholder(raw))) {
        cache = JSON.parse(raw);
      } else {
        cache = null;
      }
    } catch (e) {
      cache = null;
    }
    if (!cache || typeof cache !== 'object') {
      cache = { settings: { autoGenerate: false }, enabled: {}, schedules: {} };
    }
    if (dropLegacyFailCooldown(cache)) saveRaw();
    if (!cache.settings || typeof cache.settings !== 'object') cache.settings = { autoGenerate: false };
    if (!cache.enabled || typeof cache.enabled !== 'object') cache.enabled = {};
    if (!cache.schedules || typeof cache.schedules !== 'object') cache.schedules = {};
    return cache;
  }

  function saveRaw() {
    if (!cache) return;
    if (typeof global.miyaSyncFlushJsonKey === 'function') {
      global.miyaSyncFlushJsonKey(STORAGE_KEY, cache);
      return;
    }
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      global.miyaWriteLsJsonKey(STORAGE_KEY, cache).catch(function () {});
      return;
    }
    var str = '';
    try { str = JSON.stringify(cache); } catch (eStr) { return; }
    if (typeof global.miyaSafeLsSet === 'function') {
      global.miyaSafeLsSet(STORAGE_KEY, str);
    } else {
      try { localStorage.setItem(STORAGE_KEY, str); } catch (e) {}
    }
  }

  function todayStart() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /* 行程窗口是**过去七天**：weekStart 为最早的一天，weekStart+6 = 今天。
     因此它的终点就是「今天」，过期判定用当天 23:59:59.999。
     注意：这里不能用「weekStart + 6 天 23:59」之外的口径，
     否则会出现「列表说进行中、其实今天已不在窗口内」的错位。 */
  function weekEndDate(weekStartIso) {
    var start = parseIso(weekStartIso);
    if (!start) return null;
    var end = new Date(start);
    end.setDate(end.getDate() + WEEK_DAYS - 1);
    end.setHours(23, 59, 59, 999);
    return end;
  }

  /* 过去七天的起点 = 今天往前推 (WEEK_DAYS - 1) 天，终点是今天。
     这样「今天」始终落在窗口最后一天，当天对话一定能查到当前时段。 */
  function pastWindowStartIso(nowTs) {
    var d = new Date(Number(nowTs) > 0 ? Number(nowTs) : Date.now());
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (WEEK_DAYS - 1));
    return isoDate(d);
  }

  /* 判定一条 schedule 的窗口是不是**旧口径**（前向窗口）。
     新口径的硬性结构特征是：weekStart + 6 天**必须**等于今天 ——
     因为窗口是「过去七天」，今天固定落在最后一天。

     为什么不用日期阈值（比如「weekStart 早于今天就算旧」）来判：
     那会把「今天刚生成的新数据」误判成旧数据，直接作废用户刚拿到的东西。
     用「终点是不是今天」这个结构判据，只对真正不自洽的窗口下手。 */
  function isLegacyWindow(weekStartIso, nowTs) {
    var start = parseIso(weekStartIso);
    if (!start) return true;                 // 解析不出来的脏值，一并作废
    var expected = new Date(start);
    expected.setDate(expected.getDate() + (WEEK_DAYS - 1));
    var now = new Date(Number(nowTs) > 0 ? Number(nowTs) : Date.now());
    now.setHours(0, 0, 0, 0);
    return isoDate(expected) !== isoDate(now);
  }

  function isScheduleExpired(schedule) {
    if (!schedule || !schedule.weekStart) return true;
    var end = weekEndDate(schedule.weekStart);
    if (!end) return true;
    return Date.now() > end.getTime();
  }

  function expandSlotArray(item) {
    if (!Array.isArray(item)) return null;
    var timeRaw = String(item[0] || '').trim();
    var start = '';
    var end = '';
    var tm = timeRaw.match(/^(\d{1,2}:\d{2})\s*[-–—~到]\s*(\d{1,2}:\d{2})$/);
    if (tm) {
      start = tm[1];
      end = tm[2];
    } else {
      var parts = timeRaw.split(/\s*[-–—~]\s*/);
      start = parts[0] || '';
      end = parts[1] || '';
    }
    var location = String(item[1] || '').trim();
    var activity = String(item[2] || item[1] || '').trim();
    if (!start && !activity && !location) return null;
    return {
      timeStart: start,
      timeEnd: end,
      period: String(item[5] || '').trim(),
      title: activity,
      location: location,
      activity: activity,
      detail: String(item[3] || '').trim(),
      mood: String(item[4] || '').trim(),
      involvesUser: !!item.involvesUser,
      innerNote: String(item.innerNote || item.note || '').trim()
    };
  }

  function normalizeSlot(raw) {
    if (Array.isArray(raw)) {
      raw = expandSlotArray(raw);
    }
    if (!raw || typeof raw !== 'object') return null;
    var start = String(raw.timeStart || raw.start || '').trim();
    var end = String(raw.timeEnd || raw.end || '').trim();
    var activity = String(raw.activity || raw.title || '').trim();
    if (!start && !activity) return null;
    return {
      timeStart: start,
      timeEnd: end,
      period: String(raw.period || '').trim(),
      title: String(raw.title || raw.activity || '').trim(),
      location: String(raw.location || '').trim(),
      activity: activity,
      detail: String(raw.detail || raw.description || '').trim(),
      mood: String(raw.mood || '').trim(),
      involvesUser: !!raw.involvesUser,
      innerNote: String(raw.innerNote || raw.note || '').trim()
    };
  }

  function normalizeDay(raw, dayIndex, weekStartIso) {
    if (!raw || typeof raw !== 'object') return null;
    var slotsRaw = raw.slots || raw.s || raw.items;
    var slots = Array.isArray(slotsRaw) ? slotsRaw.map(normalizeSlot).filter(Boolean) : [];
    if (!slots.length) return null;
    var start = parseIso(weekStartIso);
    var dayDate = start ? new Date(start) : new Date();
    if (start) dayDate.setDate(dayDate.getDate() + dayIndex);
    return {
      dayIndex: dayIndex,
      weekday: String(raw.weekday || raw.wd || raw.d || WD_ZH[dayDate.getDay()] || '').trim(),
      dateLabel: isoDate(dayDate),
      dayMood: String(raw.dayMood || raw.mood || '').trim(),
      dayTheme: String(raw.dayTheme || raw.theme || '').trim(),
      slots: slots
    };
  }

  function makeFallbackDay(dayIndex, weekStartIso, prevDay) {
    var dayDate = parseIso(weekStartIso) || todayStart();
    dayDate = new Date(dayDate);
    dayDate.setDate(dayDate.getDate() + dayIndex);
    var mood = prevDay && prevDay.dayMood ? prevDay.dayMood : '日常';
    return {
      dayIndex: dayIndex,
      weekday: WD_ZH[dayDate.getDay()] || '',
      dateLabel: isoDate(dayDate),
      dayMood: mood,
      dayTheme: (prevDay && prevDay.dayTheme) || '日常安排',
      slots: [
        normalizeSlot({
          timeStart: '07:00', timeEnd: '09:00', period: 'morning',
          title: '晨间日常', location: '住处', activity: '起床洗漱',
          detail: '简单的早晨例行安排', mood: '平静'
        }),
        normalizeSlot({
          timeStart: '12:00', timeEnd: '13:30', period: 'noon',
          title: '午餐', location: '住处或附近', activity: '用餐休息',
          detail: '准备或享用午餐', mood: '放松'
        }),
        normalizeSlot({
          timeStart: '18:00', timeEnd: '21:00', period: 'evening',
          title: '晚间活动', location: '日常场所', activity: '自由活动',
          detail: '处理私事或放松', mood: '平淡'
        }),
        normalizeSlot({
          timeStart: '23:00', timeEnd: '07:00', period: 'night',
          title: '睡眠', location: '卧室', activity: '休息入睡',
          detail: '结束一天入睡休息', mood: '困倦'
        })
      ].filter(Boolean)
    };
  }

  function normalizeSchedule(raw, contactId) {
    if (!raw || typeof raw !== 'object') return null;
    var weekStart = String(raw.weekStart || '').trim();
    if (!weekStart) {
      /* 缺省窗口是**过去七天**（今天往前 6 天起），不是「从今天起」。 */
      weekStart = pastWindowStartIso();
    } else if (isLegacyWindow(weekStart)) {
      /* 旧口径数据：weekStart 是「以今天为起点」的前向窗口（weekStart+6 ≠ 今天）。
         v16 只修了生成侧，存量数据没被迁移，于是界面继续按旧窗口渲染
         （今天起铺 7 天 = 未来七天），而 isScheduleExpired 又从 weekStart+6 起算，
         这份数据还有 6 天不过期 —— 巡检不会重生成，用户只能一直看到错窗口。

         这里直接作废（返回 null），由调用方走空态并等重新生成。
         不清内容、而是整体作废，是因为旧内容是按「未来」写的，
         日期改成过去后会出现「日期说过去、内容写将来」的矛盾。 */
      return null;
    }
    var daysRaw = Array.isArray(raw.days) ? raw.days : [];
    var days = [];
    for (var i = 0; i < WEEK_DAYS; i++) {
      var dayRaw = daysRaw[i] || null;
      var day = normalizeDay(dayRaw, i, weekStart);
      if (!day) day = makeFallbackDay(i, weekStart, days[i - 1]);
      days.push(day);
    }
    if (days.length < WEEK_DAYS) return null;
    return {
      contactId: String(contactId || raw.contactId || '').trim(),
      characterName: String(raw.characterName || '').trim(),
      weekStart: weekStart,
      weekEnd: isoDate(weekEndDate(weekStart) || todayStart()),
      weekTheme: String(raw.weekTheme || '').trim(),
      generatedAt: Number(raw.generatedAt) || Date.now(),
      seed: Number(raw.seed) || Math.floor(Math.random() * 99999),
      days: days
    };
  }

  function getSettings() {
    var d = loadRaw();
    return {
      autoGenerate: !!d.settings.autoGenerate
    };
  }

  function setAutoGenerate(on) {
    loadRaw().settings.autoGenerate = !!on;
    saveRaw();
  }

  function isEnabled(contactId) {
    return !!loadRaw().enabled[String(contactId || '').trim()];
  }

  function setEnabled(contactId, on) {
    var id = String(contactId || '').trim();
    if (!id) return;
    loadRaw().enabled[id] = !!on;
    if (!on) delete loadRaw().enabled[id];
    saveRaw();
  }

  function getEnabledContactIds() {
    return Object.keys(loadRaw().enabled).filter(function (id) {
      return loadRaw().enabled[id];
    });
  }

  /* 已被作废（旧口径）的行程 id。作用只有一个：让「作废」这件事**只发生一次**。

     为什么需要它：旧数据作废后如果生成本身失败（网络/API 报错），
     该角色会一直处于「没有 schedule」的状态。若不作任何记录，
     每次 getSchedule 读到的都是同一条旧数据 → 每次触发都判「待生成」→ 反复重试，
     用户看到的是不停闪的「生成中」，且每次都是真实的 API 调用。

     v12 特意移除了「失败冷却」机制（理由见下方注释：冷却会让用户看不出为什么不再生成），
     所以这里**不重引入冷却**，只做「同一条旧数据不重复作废」——
     作废后它会从存储里被清掉，之后走的是正常的「无行程 → 生成」流程。 */
  var purgedLegacyIds = {};

  function getSchedule(contactId) {
    var id = String(contactId || '').trim();
    if (!id) return null;
    var raw = loadRaw().schedules[id];
    if (!raw) return null;
    var norm = normalizeSchedule(raw, id);
    if (!norm) {
      /* normalizeSchedule 返回 null 表示这条是旧口径数据（或结构损坏）。
         就地清掉并落盘，避免它反复参与判定 / 反复触发重生成。
         只清一次：清完 schedules[id] 就不存在了，后续走到上面的 !raw 提前返回。 */
      if (!purgedLegacyIds[id]) {
        purgedLegacyIds[id] = true;
        delete loadRaw().schedules[id];
        saveRaw();
        if (global.console && typeof console.warn === 'function') {
          console.warn('[itinerary] 检测到旧口径行程窗口（非「过去七天」），已作废并等待重新生成：' + id);
        }
      }
      return null;
    }
    return norm;
  }

  function saveSchedule(contactId, schedule) {
    var id = String(contactId || '').trim();
    var norm = normalizeSchedule(schedule, id);
    if (!id || !norm) return null;
    norm.contactId = id;
    loadRaw().schedules[id] = norm;
    saveRaw();
    return norm;
  }

  function removeSchedule(contactId) {
    var id = String(contactId || '').trim();
    if (!id) return;
    delete loadRaw().schedules[id];
    saveRaw();
  }

  function getExpiredEnabledContacts() {
    var cs = global.miyaChatStore;
    if (!cs || typeof cs.getContacts !== 'function') return [];
    var enabled = getEnabledContactIds();
    var contacts = cs.getContacts() || [];
    var map = {};
    contacts.forEach(function (c) { if (c && c.id) map[c.id] = c; });
    return enabled.filter(function (id) {
      if (!map[id]) return false;
      var sch = getSchedule(id);
      return !sch || isScheduleExpired(sch);
    }).map(function (id) {
      return map[id];
    });
  }

  /* 失败冷却机制已整体移除。
     原本生成失败会写 6 小时冷却，getExpiredEnabledContacts 期间静默跳过该角色；
     但界面仍显示「无行程·待生成」，用户看不出为什么不再生成，且取消勾选再勾选也无法恢复。
     现在失败只写控制台日志，下一个巡检周期会正常重试。 */

  function getAllContactRows() {
    var cs = global.miyaChatStore;
    if (!cs || typeof cs.getContacts !== 'function') return [];
    return (cs.getContacts() || []).filter(function (c) {
      return c && c.id;
    });
  }

  function parseTimeToMinutes(timeStr) {
    var m = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function isoDateForTz(ts, tz) {
    var t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) t = Date.now();
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date(t));
    } catch (e) {
      return isoDate(new Date(t));
    }
  }

  function minutesInDayForTz(ts, tz) {
    var aw = global.MiyaChatAwareness;
    var clock = aw && typeof aw.formatHmForTz === 'function' ? aw.formatHmForTz(ts, tz) : '';
    var parsed = parseTimeToMinutes(clock);
    if (parsed != null) return parsed;
    var d = new Date(Number(ts) || Date.now());
    return d.getHours() * 60 + d.getMinutes();
  }

  function findDayForDate(schedule, dateIso) {
    if (!schedule || !Array.isArray(schedule.days)) return null;
    var target = String(dateIso || '').trim();
    if (!target) return null;
    for (var i = 0; i < schedule.days.length; i++) {
      var day = schedule.days[i];
      if (day && day.dateLabel === target) return day;
    }
    return null;
  }

  function findSlotForMinutes(day, minutes) {
    if (!day || !Array.isArray(day.slots) || !day.slots.length) return null;
    if (!Number.isFinite(minutes)) return day.slots[0];
    var slots = day.slots;
    var i;
    for (i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var start = parseTimeToMinutes(slot.timeStart);
      var end = parseTimeToMinutes(slot.timeEnd);
      if (start == null) continue;
      if (end == null) end = start + 60;
      if (end <= start) {
        if (minutes >= start || minutes < end) return slot;
      } else if (minutes >= start && minutes < end) {
        return slot;
      }
    }
    var best = null;
    var bestStart = -1;
    for (i = 0; i < slots.length; i++) {
      var st = parseTimeToMinutes(slots[i].timeStart);
      if (st != null && st <= minutes && st >= bestStart) {
        bestStart = st;
        best = slots[i];
      }
    }
    return best || slots[0];
  }

  function resolveCurrentItinerarySlice(schedule, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    if (!schedule || !Array.isArray(schedule.days) || !schedule.days.length) return null;
    var ts = Number(opts.nowTs);
    if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
    var tz = String(opts.roleTz || '').trim();
    if (!tz) {
      var aw = global.MiyaChatAwareness;
      tz = aw && typeof aw.localTz === 'function' ? aw.localTz() : 'Asia/Shanghai';
    }
    var dateIso = isoDateForTz(ts, tz);
    /* 兜底：窗口与「今天」必须自洽（schedule.weekStart + 6 == 今天）。

       不自洽时宁可**不注入**，也不注入错的一天。原因是旧的前向窗口下
       dateLabel = [今天, 今天+1, …]，今天恰好落成**第 1 天**，
       findDayForDate 照样能匹配到 —— 于是「今天」被错当成窗口最早那天，
       角色会拿着最早那天的行程演当下的对话。这种错误不会报错、也不会空，
       只会让内容悄悄对不上时间，比彻底不注入更难查。

       正常情况下这条守卫不会触发（getSchedule 已在读取时作废旧窗口），
       留着是为了防止将来又有别的路径把不自洽的 schedule 送进来。 */
    if (isLegacyWindow(schedule.weekStart, ts)) return null;
    var day = findDayForDate(schedule, dateIso);
    if (!day) return null;
    var slot = findSlotForMinutes(day, minutesInDayForTz(ts, tz));
    if (!slot) return null;
    var awClock = global.MiyaChatAwareness;
    return {
      dateIso: dateIso,
      roleTz: tz,
      day: day,
      slot: slot,
      clock: awClock && typeof awClock.formatClockForTz === 'function'
        ? awClock.formatClockForTz(ts, tz)
        : ''
    };
  }

  global.miyaItineraryStore = {
    STORAGE_KEY: STORAGE_KEY,
    /* 缓存作废时一并清掉「已作废」标记。
       恢复备份（miya-backup.js）会调这里，恢复进来的数据要能被重新判定 —— 
       否则还原了一份旧口径数据，却因为标记还在而被静默跳过、永远不清。 */
    invalidateCache: function () { cache = null; purgedLegacyIds = {}; },
    WEEK_DAYS: WEEK_DAYS,
    WD_ZH: WD_ZH,
    isoDate: isoDate,
    parseIso: parseIso,
    weekEndDate: weekEndDate,
    pastWindowStartIso: pastWindowStartIso,
    isLegacyWindow: isLegacyWindow,
    isScheduleExpired: isScheduleExpired,
    getSettings: getSettings,
    setAutoGenerate: setAutoGenerate,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    getEnabledContactIds: getEnabledContactIds,
    getSchedule: getSchedule,
    saveSchedule: saveSchedule,
    removeSchedule: removeSchedule,
    getExpiredEnabledContacts: getExpiredEnabledContacts,
    getAllContactRows: getAllContactRows,
    normalizeSchedule: normalizeSchedule,
    parseTimeToMinutes: parseTimeToMinutes,
    isoDateForTz: isoDateForTz,
    findDayForDate: findDayForDate,
    findSlotForMinutes: findSlotForMinutes,
    resolveCurrentItinerarySlice: resolveCurrentItinerarySlice
  };

  if (global.miyaRegisterKvStore) {
    global.miyaRegisterKvStore({
      whenReady: function () {
        return global.miyaReadLsJsonKey(STORAGE_KEY, { settings: { autoGenerate: false }, enabled: {}, schedules: {} }).then(function (v) {
          cache = v && typeof v === 'object' ? v : { settings: { autoGenerate: false }, enabled: {}, schedules: {} };
          if (!cache.settings || typeof cache.settings !== 'object') cache.settings = { autoGenerate: false };
          if (!cache.enabled || typeof cache.enabled !== 'object') cache.enabled = {};
          if (!cache.schedules || typeof cache.schedules !== 'object') cache.schedules = {};
          if (global.__miyaKvMem) global.__miyaKvMem[STORAGE_KEY] = cache;
        });
      }
    });
  }
})(typeof window !== 'undefined' ? window : global);
