/**
 * miya-diary-scheduler.js — 角色定时自动写日记
 */
(function (global) {
  'use strict';

  var SCAN_MS = 30000;
  var SCAN_MS_MOBILE = 60000;
  var tickTimer = null;
  var tickBooted = false;
  var queue = [];
  var queued = Object.create(null);
  var workerBusy = false;
  var inFlight = Object.create(null);

  function isMobileDevice() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && window.matchMedia('(hover: none)').matches);
  }

  function getScanMs() {
    return isMobileDevice() ? SCAN_MS_MOBILE : SCAN_MS;
  }

  function stopTick() {
    if (!tickTimer) return;
    if (typeof tickTimer === 'function') {
      tickTimer();
    } else {
      clearInterval(tickTimer);
    }
    tickTimer = null;
  }

  /* 轮询每 30~60s 触发一次，失败会被反复重试，所以同一条原因最多每 10 分钟记一次，
     避免把一个正常的偶发失败刷成满屏日志。 */
  var WARN_MIN_GAP_MS = 10 * 60 * 1000;
  var lastWarnAt = Object.create(null);
  function warnOnce(key, msg, contactId) {
    var now = Date.now();
    if (lastWarnAt[key] && now - lastWarnAt[key] < WARN_MIN_GAP_MS) return;
    lastWarnAt[key] = now;
    if (global.console && typeof console.warn === 'function') {
      console.warn('[miyaDiaryScheduler] ' + msg + (contactId ? '（contactId=' + contactId + '）' : ''));
    }
  }

  function startIntervalTick(ms) {
    if (global.miyaBgSetInterval) return global.miyaBgSetInterval(checkAllContacts, ms);
    return setInterval(checkAllContacts, ms);
  }

  function store() { return global.miyaDiaryStore || null; }
  function bridge() { return global.miyaDiaryBridge || null; }

  function displayName(contact) {
    if (!contact) return 'TA';
    return String(contact.remarkName || contact.name || 'TA').trim();
  }

  function getContact(id) {
    var cs = global.miyaChatStore;
    if (!cs || !id) return null;
    return (cs.getContacts() || []).find(function (c) { return c && c.id === id; }) || null;
  }

  function todayIsoForContact(contact) {
    var br = bridge();
    if (br && typeof br.buildDiaryContext === 'function') {
      return br.buildDiaryContext(contact).todayIso;
    }
    var st = store();
    return st && st.isoDate ? st.isoDate(new Date()) : '';
  }

  function notifyDiaryReady(contact) {
    var name = displayName(contact);
    var title = name + '今天的日记写好了';
    var body = '「' + name + '」的今日日记已自动写好，点开日记本看看吧。';
    if (global.miyaShowSystemNotification) {
      global.miyaShowSystemNotification(title, {
        body: body,
        tag: 'miya-diary-auto-' + String(contact.id || ''),
        data: { kind: 'diary_auto', contactId: String(contact.id || '') }
      });
    }
  }

  function enqueue(contactId) {
    var key = String(contactId || '');
    if (!key || queued[key]) return;
    queued[key] = true;
    queue.push(key);
    runWorker();
  }

  function runWorker() {
    if (workerBusy) return;
    workerBusy = true;
    (function next() {
      if (!queue.length) {
        workerBusy = false;
        return;
      }
      var cid = queue.shift();
      delete queued[cid];
      if (inFlight[cid]) return next();
      inFlight[cid] = true;
      triggerAutoWrite(cid).finally(function () {
        delete inFlight[cid];
        next();
      });
    })();
  }

  function triggerAutoWrite(contactId) {
    var st = store();
    var br = bridge();
    if (!st || !br || typeof br.generateTodayDiary !== 'function') {
      /* 依赖缺失时不静默放弃：正常路径下 store/bridge 在 index.html 关键路径中，
         调度器是懒加载的，所以顺序本来就有保证；这里留下日志是为了以后
         有人改懒加载分组（miya-lazy-boot.js 的 diaryUi 只含 scheduler + app）
         拆掉依赖时能被立刻发现，而不是表现为「自动日记莫名其妙不写」。 */
      warnOnce('nodep', '自动日记依赖缺失（miyaDiaryStore / miyaDiaryBridge），本次跳过', contactId);
      return Promise.resolve(false);
    }
    var contact = getContact(contactId);
    if (!contact) return Promise.resolve(false);
    var settings = st.getDiarySettings(contactId);
    if (!settings.autoWrite.enabled) return Promise.resolve(false);

    var today = todayIsoForContact(contact);
    if (settings.autoWrite.lastRunDateIso === today) return Promise.resolve(false);

  return br.generateTodayDiary(contact).then(function (row) {
      if (row) {
        st.saveDiarySettings(contactId, {
          autoWrite: { lastRunDateIso: today }
        });
        notifyDiaryReady(contact);
        if (global.miyaDiaryApp && typeof global.miyaDiaryApp.onAutoDiaryReady === 'function') {
          global.miyaDiaryApp.onAutoDiaryReady(contactId, row);
        }
        return true;
      }
      /* 生成返回空：不算成功，也不写 lastRunDateIso。
         旧实现连这里都静默返回，配合 30s 轮询会一直重试、反复烧 token。 */
      warnOnce('empty:' + contactId, '自动日记生成返回空，稍后重试', contactId);
      return false;
    }).catch(function (err) {
      /* 旧实现 .catch(function(){ return false; })，错误被完全吞掉：
         用户看不到失败，lastRunDateIso 又没写，于是每 30s 重试一次，
         一直烧 token。这里保留重试语义，但把原因记下来、并做频率限制。 */
      warnOnce('err:' + contactId, '自动日记生成失败：' + ((err && err.message) || err), contactId);
      return false;
    });
  }

  function isDueNow(settings, now) {
    if (!settings || !settings.autoWrite || !settings.autoWrite.enabled) return false;
    var aw = settings.autoWrite;
    var h = Number(aw.hour);
    var m = Number(aw.minute);
    if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return false;
    /* 旧实现要求 now.getHours()===h && now.getMinutes()===m（精确到分钟）。
       轮询间隔是 30~60s，且后台/息屏时会暂停，很容易整分钟错过；
       一旦错过，lastRunDateIso 当天也不会再补，这一天的自动日记就被静默跳过了。
       改为「已到达今日的设定时刻」即视为到期，是否已跑由 lastRunDateIso 去重。 */
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var targetMin = h * 60 + m;
    return nowMin >= targetMin;
  }

  function checkAllContacts() {
    var st = store();
    if (!st) return;
    var contacts = st.getAllContactRows();
    if (!contacts.length) return;
    var now = new Date();
    contacts.forEach(function (contact) {
      if (!contact || !contact.id) return;
      var settings = st.getDiarySettings(contact.id);
      if (!isDueNow(settings, now)) return;
      var today = todayIsoForContact(contact);
      if (settings.autoWrite.lastRunDateIso === today) return;
      enqueue(contact.id);
    });
  }

  function startTick() {
    if (tickBooted) return;
    tickBooted = true;
    checkAllContacts();
    if (!document.hidden) {
      tickTimer = startIntervalTick(getScanMs());
    }
    if (!global.__miyaDiaryAutoVisBound) {
      global.__miyaDiaryAutoVisBound = true;
      function onDiaryForeground() {
        checkAllContacts();
        if (tickBooted && !tickTimer) {
          tickTimer = startIntervalTick(getScanMs());
        }
      }
      if (typeof global.miyaBindForeground === 'function') {
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) stopTick();
        });
        global.miyaBindForeground(onDiaryForeground);
      } else {
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) {
            stopTick();
            return;
          }
          onDiaryForeground();
        });
        window.addEventListener('pageshow', function () {
          if (!document.hidden) onDiaryForeground();
        });
      }
    }
  }

  function boot() {
    var chain = Promise.resolve();
    if (global.miyaBootstrapKvStores) {
      chain = chain.then(function () { return global.miyaBootstrapKvStores(); });
    }
    var cs = global.miyaChatStore;
    if (cs && typeof cs.init === 'function') {
      chain = chain.then(function () { return cs.init(); });
    }
    chain.then(function () {
      startTick();
    }).catch(function () {
      startTick();
    });
  }

  global.miyaDiaryScheduler = {
    boot: boot,
    checkAllContacts: checkAllContacts,
    triggerAutoWrite: triggerAutoWrite
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : global);
