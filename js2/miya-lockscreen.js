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
  var msgTimer = null;

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
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
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
    /*
     * 抖动动画 0.5s，但提示文字不能跟着一起消失。
     *
     * 原实现把 clearDigits()（内部会 setPassMsg('')）挂在 520ms 上，
     * 和抖动动画同步 —— 结果「密码不正确，请重试」只亮半秒就没了，
     * 用户眨个眼就看不到，只会觉得「输了没反应」。
     * 现在拆成三件事：
     *   ① 立即清空已输入的 4 位，用户可直接重输，不必先按删除；
     *   ② 写入提示文字（必须放在 clearDigits 之后，否则会被它抹掉）；
     *   ③ 抖动 0.5s 后摘掉 is-shake；提示文字留满 4s 再清。
     *      4s 是权衡：够用户读完，又不会长久占着键区上方那一行。
     */
    clearDigits();
    setPassMsg('密码不正确，请重试');
    overlayEl.classList.remove('is-shake');
    void overlayEl.offsetWidth;
    overlayEl.classList.add('is-shake');
    if (shakeTimer) clearTimeout(shakeTimer);
    shakeTimer = setTimeout(function () {
      if (overlayEl) overlayEl.classList.remove('is-shake');
    }, 520);
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(function () {
      msgTimer = null;
      if (phase === 'passcode') setPassMsg('');
    }, 4000);
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

  /* ── Swipe up gesture ──
   *
   * 手势绑在「时钟页整块」上，而不是底部那条 88px 的隐形热区。
   *
   * 历史坑：早先只把 touchstart 绑在 #miya-lock-swipe（min-height:88px，
   * 布局后位于屏幕最下方 y∈[799,887]）。用户在屏幕中部随手往上一划，
   * touchstart 落在 .miya-lockscreen__main 上，事件到不了热区，
   * 手势被静默丢弃 —— 观感就是「划一下没反应，得再划一下」，而用户
   * 每次起手的位置略有不同，于是时好时坏。
   * 现在整页可起手：从屏幕上任何位置往上滑都能解锁，
   * 顶部 120px 留空避免与系统下拉通知手势打架。
   */
  function bindSwipe() {
    var zone = $('miya-lock-swipe');
    if (!zone) return;
    /* 监听目标：时钟页主体；拿不到就退回热区，保证旧结构也能用 */
    var surface = document.querySelector('.miya-lockscreen__main') || zone;

    var startY = 0;
    var dragging = false;
    var hint = $('miya-lock-hint');

    /* 顶部安全区：这一段内的 touchstart 不接管，交给系统手势 */
    var TOP_SAFE_PX = 120;

    function onStart(y) {
      if (phase !== 'clock') return;
      if (y < TOP_SAFE_PX) return;
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
       * 只有真的上滑了才解锁。阈值 72px：
       * 竖屏拇指从任意位置起手都能舒服划够这个行程。
       */
      if ((startY - y) > 72) requestUnlockFromClock();
    }

    surface.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) onStart(e.touches[0].clientY);
    }, { passive: true });

    surface.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1) onMove(e.touches[0].clientY);
    }, { passive: true });

    surface.addEventListener('touchend', function (e) {
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
    surface.addEventListener('mousedown', function (e) {
      if (e.clientY < 120) return;
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
     * 整个时钟页都接受上滑（见 onEnd 的 72px 判定），手势语义单一；
     * 密码页 .is-clock 失效后数字键不受影响，不会吞掉任何一次点击。
     */
  }

  /* ── 数字键盘 ──
   *
   * ★ 为什么必须用 pointerup，而不是 click ★
   *
   * 这是「每次第一个密码数字都要点两下」的真正病根。
   *
   * Android Chromium（WebView / 各家套壳浏览器同样）有一条点击抑制规则：
   * 元素在**它自己这一次触摸进行期间**被移出过命中测试树（祖先被 display:none
   * 摘掉、又或祖先刚由隐藏切到显示），Chrome 就认为「手指下方的东西变了」，
   * 于是**不派发这一次的 mousedown / click**，只把 pointer/touch 序列走完，
   * 直到下一次用户手势才恢复正常。
   *
   * 我们用 CDP 真实触摸序列抓到的证据（进入密码页后第一次点「1」）：
   *
   *   pointerdown  → SPAN.miya-lockscreen__key-num
   *   touchstart   → SPAN.miya-lockscreen__key-num
   *   pointerup    → SPAN.miya-lockscreen__key-num
   *   touchend     → SPAN.miya-lockscreen__key-num
   *   （到此为止 —— 没有 mousedown，更没有 click）
   *
   * 第二次点同一个键，事件流里才补上 mousedown + click。
   * 而旧实现只监听 click，所以第一次点击被整条吞掉：手指看见了按键按下、
   * 按键自己也有 :active 反馈，界面却毫无变化 —— 观感就是「第一下没反应」。
   *
   * 触发这条规则的正是 setPhase('passcode')：
   *   .is-clock 下 .miya-lockscreen__pass 是 display:none（不在命中测试树里），
   *   setPhase 把它切成 display:flex —— 被点中的元素是在这次触摸期间
   *   才进入命中测试树的，Chrome 因此拒绝派发 click。
   * 桌面层/缓存/Service Worker 都与本现象无关（已逐一排除）。
   *
   * 修法：响应绑在 pointerup（每次点击都一定派发），click 仅作兜底，
   * 并用「最近一次已由 pointerup 处理过的指针 id + 时间窗」去重，
   * 避免同一次触摸被 pointerup 和 click 各记一次。
   *
   * 为什么不用 mousedown：安卓上 mousedown 同属被抑制的那条链路，
   * 第一次点击同样收不到；且 mousedown 属「按下即响应」，
   * 用户一旦想滑走会误输入。pointerup 既可靠又仍是「抬起才响应」。
   */
  var lastKeyPointer = { id: null, at: 0 };

  /* 同一次触摸的 pointerup 与 click 间隔通常 < 50ms；取 600ms 更稳：
     真人两次按键的间隔几乎不会短于这个值，不会误吞连续输入。 */
  var KEY_DEDUPE_MS = 600;

  function consumeKeyPress(e) {
    var keyBtn = e.target.closest ? e.target.closest('[data-lock-key]') : null;
    if (keyBtn) {
      onDigit(keyBtn.getAttribute('data-lock-key'));
      return true;
    }
    if (e.target.closest && e.target.closest('[data-lock-delete]')) {
      onDelete();
      return true;
    }
    return false;
  }

  function bindKeypad() {
    var pad = $('miya-lock-keypad');
    if (!pad) return;

    /* 主通道：pointerup —— 第一次点击也一定到达 */
    pad.addEventListener('pointerup', function (e) {
      if (!consumeKeyPress(e)) return;
      lastKeyPointer.id = e.pointerId;
      lastKeyPointer.at = Date.now();
      /* 顺带压掉这次触摸可能合成的后续 click，双保险 */
      if (e.cancelable) e.preventDefault();
    });

    /* 兜底通道：没有 Pointer Events 的环境（极老内核）仍走 click */
    pad.addEventListener('click', function (e) {
      if (e.pointerId != null &&
          lastKeyPointer.id === e.pointerId &&
          (Date.now() - lastKeyPointer.at) < KEY_DEDUPE_MS) {
        return;
      }
      consumeKeyPress(e);
    });
  }

  /* 取消按钮与数字键同病同治：
     密码页是 setPhase('passcode') 当场把 .miya-lockscreen__pass 由 display:none
     切成 display:flex 放出来的，Chromium 因此吞掉进入密码页后的第一次 click。
     只绑 click 的话，「取消」也要按两下 —— 已用真实触摸序列复现确认。
     同样改成 pointerup 主通道 + click 兜底去重。 */
  function bindPassCancel() {
    var btn = $('miya-lock-pass-cancel');
    if (!btn) return;

    var lastCancelPointer = { id: null, at: 0 };

    btn.addEventListener('pointerup', function (e) {
      if (phase !== 'passcode') return;
      lastCancelPointer.id = e.pointerId;
      lastCancelPointer.at = Date.now();
      setPhase('clock');
      if (e.cancelable) e.preventDefault();
    });

    btn.addEventListener('click', function (e) {
      if (e.pointerId != null &&
          lastCancelPointer.id === e.pointerId &&
          (Date.now() - lastCancelPointer.at) < KEY_DEDUPE_MS) {
        return;
      }
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
