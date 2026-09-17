(function (global) {
  'use strict';

  var LOCK_KEY = 'miya-lock-meta';

  var defaultLock = {
    wallpaperEnabled: false,
    wallpaper: null,
    passcodeEnabled: false,
    passcode: null
  };

  var lockState = null;
  var sessionUnlocked = false;
  var overlayEl = null;
  var visible = false;
  var phase = 'clock';
  var enteredDigits = [];
  var shakeTimer = null;

  function $(id) { return document.getElementById(id); }

  function loadLock() {
    try {
      var raw = localStorage.getItem(LOCK_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          return Object.assign({}, defaultLock, {
            wallpaperEnabled: !!p.wallpaperEnabled,
            wallpaper: p.wallpaper || null,
            passcodeEnabled: !!p.passcodeEnabled,
            passcode: p.passcodeEnabled && /^\d{4}$/.test(String(p.passcode || ''))
              ? String(p.passcode)
              : null
          });
        }
      }
    } catch (e) {}
    return Object.assign({}, defaultLock);
  }

  function saveLock(state) {
    var lean = {
      wallpaperEnabled: !!state.wallpaperEnabled,
      wallpaper: state.wallpaper || null,
      passcodeEnabled: !!state.passcodeEnabled,
      passcode: state.passcodeEnabled && state.passcode ? String(state.passcode) : null
    };
    if (!lean.passcodeEnabled) lean.passcode = null;
    localStorage.setItem(LOCK_KEY, JSON.stringify(lean));
    return lean;
  }

  global.miyaGetLockSettings = function () {
    if (!lockState) lockState = loadLock();
    return Object.assign({}, lockState);
  };

  global.miyaSetLockSettings = function (partial) {
    lockState = Object.assign({}, global.miyaGetLockSettings(), partial || {});
    if (!lockState.passcodeEnabled) lockState.passcode = null;
    saveLock(lockState);
    return lockState;
  };

  global.miyaIsLockActive = function () {
    var s = global.miyaGetLockSettings();
    return !!(s.wallpaperEnabled || s.passcodeEnabled);
  };

  global.miyaSetLockWallpaper = function (ref) {
    global.miyaSetLockSettings({ wallpaper: ref || null });
    return Promise.resolve();
  };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  var WD_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function syncClock() {
    var d = new Date();
    var timeText = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var timeEl = $('miya-lock-time');
    var dateEl = $('miya-lock-date');
    if (timeEl) timeEl.textContent = timeText;
    if (dateEl) {
      dateEl.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WD_ZH[d.getDay()];
    }
  }

  function setPassMsg(text) {
    var msgEl = $('miya-lock-pass-msg');
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.toggle('is-visible', !!text);
  }

  function syncCancelButton() {
    var btn = $('miya-lock-pass-cancel');
    if (!btn) return;
    var s = global.miyaGetLockSettings();
    var show = phase === 'passcode' && !!s.wallpaperEnabled;
    btn.hidden = !show;
  }

  function applyWallpaper() {
    var bg = $('miya-lock-bg');
    if (!bg) return;
    var s = global.miyaGetLockSettings();
    if (!s.wallpaperEnabled || !s.wallpaper) {
      bg.style.backgroundImage = '';
      bg.classList.remove('has-wallpaper');
      return;
    }
    if (!global.miyaResolveMediaUrl) {
      bg.classList.add('has-wallpaper');
      return;
    }
    global.miyaResolveMediaUrl(s.wallpaper).then(function (url) {
      if (url) {
        bg.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
        bg.classList.add('has-wallpaper');
      } else {
        bg.style.backgroundImage = '';
        bg.classList.remove('has-wallpaper');
      }
    });
  }

  function clearDigits() {
    enteredDigits = [];
    setPassMsg('');
  }

  function setPhase(next) {
    phase = next;
    if (!overlayEl) return;
    overlayEl.classList.toggle('is-passcode', phase === 'passcode');
    overlayEl.classList.toggle('is-clock', phase === 'clock');
    if (phase === 'passcode') clearDigits();
    syncCancelButton();
  }

  function resolveInitialPhase() {
    var s = global.miyaGetLockSettings();
    if (s.wallpaperEnabled) return 'clock';
    if (s.passcodeEnabled) return 'passcode';
    return 'clock';
  }

  function finishUnlock() {
    sessionUnlocked = true;
    visible = false;
    if (!overlayEl) return;
    overlayEl.classList.remove('is-show', 'is-shake');
    overlayEl.setAttribute('aria-hidden', 'true');
    overlayEl.hidden = true;
    document.body.classList.remove('miya-lock-active');
    clearDigits();
    if (global.MiyaChatBackground && typeof global.MiyaChatBackground.kickScan === 'function') {
      global.MiyaChatBackground.kickScan();
    }
  }

  function failPasscode() {
    if (!overlayEl) return;
    setPassMsg('密码不正确，请重试');
    overlayEl.classList.remove('is-shake');
    void overlayEl.offsetWidth;
    overlayEl.classList.add('is-shake');
    if (shakeTimer) clearTimeout(shakeTimer);
    shakeTimer = setTimeout(function () {
      if (overlayEl) overlayEl.classList.remove('is-shake');
      clearDigits();
    }, 520);
  }

  function tryPasscode() {
    var s = global.miyaGetLockSettings();
    var code = enteredDigits.join('');
    if (code.length < 4) return;
    if (s.passcode && code === s.passcode) {
      finishUnlock();
      return;
    }
    failPasscode();
  }

  function onDigit(d) {
    if (phase !== 'passcode' || enteredDigits.length >= 4) return;
    if (enteredDigits.length === 0) setPassMsg('');
    enteredDigits.push(String(d));
    if (enteredDigits.length === 4) {
      setTimeout(tryPasscode, 120);
    }
  }

  function onDelete() {
    if (!enteredDigits.length) return;
    enteredDigits.pop();
  }

  function requestUnlockFromClock() {
    var s = global.miyaGetLockSettings();
    if (s.passcodeEnabled) {
      setPhase('passcode');
      return;
    }
    finishUnlock();
  }

  function showOverlay() {
    if (!global.miyaIsLockActive()) return Promise.resolve();
    if (visible) return Promise.resolve();

    overlayEl = overlayEl || $('miya-lockscreen');
    if (!overlayEl) return Promise.resolve();

    visible = true;
    sessionUnlocked = false;
    syncClock();
    applyWallpaper();
    setPhase(resolveInitialPhase());

    overlayEl.hidden = false;
    overlayEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('miya-lock-active');

    overlayEl.classList.add('is-show');
    return Promise.resolve();
  }

  function showIfNeeded() {
    if (sessionUnlocked || !global.miyaIsLockActive()) return Promise.resolve();
    return showOverlay();
  }

  /* ── Swipe up gesture ── */
  function bindSwipe() {
    var zone = $('miya-lock-swipe');
    if (!zone) return;

    var startY = 0;
    var dragging = false;
    var hint = $('miya-lock-hint');

    function onStart(y) {
      if (phase !== 'clock') return;
      dragging = true;
      startY = y;
      zone.classList.add('is-dragging');
    }

    function onMove(y) {
      if (!dragging) return;
      var dy = startY - y;
      if (dy > 0 && hint) {
        hint.style.transform = 'translateY(' + Math.min(dy * 0.35, 48) + 'px)';
        hint.style.opacity = String(Math.max(0.35, 1 - dy / 180));
      }
    }

    function onEnd(y) {
      if (!dragging) return;
      dragging = false;
      zone.classList.remove('is-dragging');
      if (hint) {
        hint.style.transform = '';
        hint.style.opacity = '';
      }
      /*
       * 只有真的上滑了才解锁。阈值 72px 与热区高度（88px）配套：
       * 热区略高于阈值，保证在热区内起手就能划够行程。
       */
      if ((startY - y) > 72) requestUnlockFromClock();
    }

    zone.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) onStart(e.touches[0].clientY);
    }, { passive: true });

    zone.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1) onMove(e.touches[0].clientY);
    }, { passive: true });

    zone.addEventListener('touchend', function (e) {
      var y = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : startY;
      onEnd(y);
    });

    /*
     * mousedown 不再无条件 preventDefault。
     *
     * 原先这里直接 preventDefault()，目的是压掉桌面端的文字选中/拖拽。
     * 但在触摸屏上，浏览器会在 touchend 之后合成一套 mousedown/mouseup/click，
     * 对合成事件调用 preventDefault() 会连带取消后续的 click，
     * 让这一次轻点既不解锁、也不落到下面的元素上 —— 也就是"白按一下"。
     * 现在不再阻断点击链路，只在多击时避免选中文字。
     */
    zone.addEventListener('mousedown', function (e) {
      onStart(e.clientY);
      if (e.detail > 1) e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (dragging) onMove(e.clientY);
    });

    window.addEventListener('mouseup', function (e) {
      if (dragging) onEnd(e.clientY);
    });

    /*
     * 这里**故意不再**监听 click 解锁。
     *
     * 历史问题：本区域原先同时接受"轻点"和"上滑"两种解锁方式。
     * 提示文字与横条移除后，这块区域变成 88px 高的隐形热区 —— 它就在
     * 屏幕底部，正是拇指的自然落点。于是用户在时钟页想直接按数字键时，
     * 第一下落在热区上被我吃掉（用于解锁），必须再按一下才输得进第一位，
     * 表现为「按第一下没反应」。实测在时钟页点击空白处也会莫名跳进密码页。
     *
     * 现在只认上滑（见 onEnd 里的 72px 判定）：手势语义单一，且与
     * 键盘区完全不重叠，时钟页底部不会再吞掉任何一次点击。
     */
  }

  function bindKeypad() {
    var pad = $('miya-lock-keypad');
    if (!pad) return;

    pad.addEventListener('click', function (e) {
      var keyBtn = e.target.closest('[data-lock-key]');
      if (keyBtn) {
        onDigit(keyBtn.getAttribute('data-lock-key'));
        return;
      }
      if (e.target.closest('[data-lock-delete]')) onDelete();
    });
  }

  function bindPassCancel() {
    var btn = $('miya-lock-pass-cancel');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (phase !== 'passcode') return;
      setPhase('clock');
    });
  }

  function init() {
    overlayEl = $('miya-lockscreen');
    bindSwipe();
    bindKeypad();
    bindPassCancel();
    syncClock();
    setInterval(syncClock, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.miyaLockscreen = {
    show: showOverlay,
    showIfNeeded: showIfNeeded,
    refreshWallpaper: applyWallpaper,
    lock: function () {
      sessionUnlocked = false;
      return showIfNeeded();
    }
  };
})(window);
