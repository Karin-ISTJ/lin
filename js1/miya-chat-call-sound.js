/**
 * miya-chat-call-sound.js — 通话铃声与音效
 *
 * ── 与 miya-msg-sound.js 的关系 ────────────────────────────────
 *
 * 项目里已经有 js2/miya-msg-sound.js，负责**消息提示音**：
 * 内置 5 个预设、支持用户上传自定义音频（存 IndexedDB）、
 * 有总开关，还提供了 playUiFeedback 这类场景化入口。
 *
 * 本模块**不重复造那套基建**，只补它没覆盖的部分 —— 通话铃声：
 *
 *   · 消息提示音是**单次**的，响一声就完
 *   · 来电铃声必须**循环**，且要能在挂断时立刻掐断
 *
 * 所以这里做两件事：
 *   1. 新增循环播放能力（startLoop / stop）
 *   2. 用 Web Audio 合成四种通话场景音，零音频文件体积
 *
 * 总开关**复用 MiyaMsgSound.setEnabled/isEnabled** ——
 * 用户在设置里关掉提示音，铃声也应该一起静默，
 * 这是用户的直觉预期，分成两个开关反而奇怪。
 *
 * ── 音效设计 ───────────────────────────────────────────────────
 *
 *   voiceCall  双音交替来电铃（E6-C6 往复，triangle），循环
 *   videoCall  三音上行、更明亮（C6-E6-G6，sine），循环
 *   outgoing   去电等待音（C5 单音规律脉冲），循环
 *   message    新消息短促双音（G5-C6），单次
 *   hangup     挂断（A5→D5 单音下滑），单次
 *   accept     接通（E6-G6 双音上行），单次
 *   decline    拒接（D5 单音），单次
 *
 * ── 使用方式 ───────────────────────────────────────────────────
 *
 *   MiyaChatCallSound.startLoop('voiceCall')   // 来电，循环
 *   MiyaChatCallSound.stop()                   // 停止一切
 *   MiyaChatCallSound.playOnce('hangup')       // 挂断，单响
 *
 * 挂载：global.MiyaChatCallSound
 */
(function (global) {
  'use strict';

  var ctx = null;
  var loopTimer = null;
  var activeNodes = [];
  var activeKind = '';

  /* 频率常量，按音名命名便于调音时对照 */
  var C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880.0;
  var C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98;

  /*
   * ── 音效定义 ──────────────────────────────────────────────────
   *
   * notes 每项：[频率, 起始秒, 时长秒, 音量]
   * span：一轮的总秒数，决定循环间隔。
   *
   * 循环音效刻意留出静默间隙 —— 连续不断的蜂鸣听着刺耳，
   * 真实的电话铃也是「响一阵、停一下」。
   */
  var PATTERNS = {
    voiceCall: {
      wave: 'triangle',
      span: 1.6,
      notes: [
        [E6, 0.0, 0.45, 0.16],
        [C6, 0.5, 0.45, 0.16],
        [E6, 0.95, 0.45, 0.16]
      ]
    },
    videoCall: {
      wave: 'sine',
      span: 1.8,
      notes: [
        [C6, 0.0, 0.32, 0.15],
        [E6, 0.36, 0.32, 0.15],
        [G6, 0.72, 0.5, 0.16]
      ]
    },
    outgoing: {
      wave: 'sine',
      span: 2.0,
      notes: [
        [C5, 0.0, 0.7, 0.12]
      ]
    },
    message: {
      wave: 'sine',
      span: 0.5,
      notes: [
        [G5, 0.0, 0.12, 0.12],
        [C6, 0.14, 0.18, 0.13]
      ]
    },
    hangup: {
      wave: 'sine',
      span: 0.4,
      notes: [
        [A5, 0.0, 0.14, 0.13],
        [D5, 0.12, 0.22, 0.13]
      ]
    },
    accept: {
      wave: 'sine',
      span: 0.35,
      notes: [
        [E6, 0.0, 0.12, 0.13],
        [G6, 0.13, 0.18, 0.13]
      ]
    },
    decline: {
      wave: 'sine',
      span: 0.35,
      notes: [
        [D5, 0.0, 0.28, 0.13]
      ]
    },

    /*
     * 未接：单声、低沉、短。
     *
     * 与 decline（拒接）刻意做出区别 —— 拒接是 D5 单音 0.28s，
     * 未接用更低的 A4 且更短促，听感上「轻」一些。
     * 用户不该为「没接到」感到被责备，声音也不该那么重。
     */
    missed: {
      wave: 'sine',
      span: 0.3,
      notes: [
        [440.0, 0.0, 0.2, 0.1]
      ]
    }
  };

  /*
   * ── 静音判定 ──────────────────────────────────────────────────
   *
   * 复用 miya-msg-sound.js 的总开关。
   * 那个模块可能还没加载（懒加载、旧缓存），此时**默认允许发声** ——
   * 宁可多响一声，也不要因为模块没到就整个通话静默。
   */
  function isMuted() {
    var ms = global.MiyaMsgSound;
    if (ms && typeof ms.isEnabled === 'function') {
      try {
        return !ms.isEnabled();
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /*
   * ── AudioContext ─────────────────────────────────────────────
   *
   * 浏览器要求 AudioContext 必须由用户手势触发才能出声。
   * 策略是懒创建 + 每次播放前尝试 resume，覆盖「首次点击才解锁」。
   */
  function getCtx() {
    if (ctx && ctx.state !== 'closed') return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function unlock() {
    var c = getCtx();
    if (!c) return Promise.resolve(null);
    if (c.state === 'suspended' && typeof c.resume === 'function') {
      return c.resume()
        .then(function () { return c; })
        .catch(function () { return c; });
    }
    return Promise.resolve(c);
  }

  /*
   * 播一个音符。
   *
   * 包络用「快速淡入 + 平缓淡出」：直接 0→gain 切换会产生 click 爆音，
   * 必须靠斜坡过渡。这里不用 exponentialRamp 是因为它不能到 0，
   * 而线性斜坡在听感上对这种短促音足够干净。
   */
  function tone(c, freq, startAt, dur, gainVal, wave) {
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = wave || 'sine';
    osc.frequency.value = freq;

    var t0 = c.currentTime + startAt;
    var t1 = t0 + dur;
    var gv = gainVal || 0.15;

    var fadeIn = Math.min(0.015, dur * 0.2);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gv, t0 + fadeIn);
    g.gain.setValueAtTime(gv, Math.max(t0 + fadeIn, t1 - 0.06));
    g.gain.linearRampToValueAtTime(0, t1);

    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);

    activeNodes.push(osc);

    /* 播完自动清理引用，避免长会话下数组无限增长 */
    osc.onended = function () {
      var idx = activeNodes.indexOf(osc);
      if (idx >= 0) activeNodes.splice(idx, 1);
      try {
        osc.disconnect();
        g.disconnect();
      } catch (e) {}
    };
  }

  function playPattern(name) {
    var pat = PATTERNS[name];
    if (!pat) return;
    var c = getCtx();
    if (!c) return;
    for (var i = 0; i < pat.notes.length; i++) {
      var n = pat.notes[i];
      tone(c, n[0], n[1], n[2], n[3], pat.wave);
    }
  }

  /**
   * 循环播放（来电铃声、去电等待音）。
   *
   * 重复调用同一个 kind 是幂等的，不会叠加出两轨。
   * 换成不同 kind 会先停掉旧的。
   *
   * @param {string} kind voiceCall | videoCall | outgoing
   */
  function startLoop(kind) {
    if (isMuted()) return Promise.resolve();
    if (!PATTERNS[kind]) return Promise.resolve();
    /* 同类已在循环 → 不重启，避免铃声被打断重来 */
    if (activeKind === kind && loopTimer) return Promise.resolve();

    stop();

    return unlock().then(function () {
      if (isMuted()) return;
      activeKind = kind;
      playPattern(kind);
      var span = PATTERNS[kind].span;
      loopTimer = setInterval(function () {
        /*
         * 每轮开始前再 resume。
         *
         * 移动端切后台再回来时 AudioContext 可能被系统挂起，
         * 不重新 resume 铃声会静默停掉，用户以为漏接了电话。
         */
        unlock().then(function () {
          if (!isMuted() && activeKind === kind) playPattern(kind);
        });
      }, span * 1000);
    });
  }

  /**
   * 立即停止所有循环音效，并掐掉正在响的音符。
   *
   * 用 stop(0) 而不是等自然结束 —— 挂断那一刻铃声必须断干净，
   * 拖半秒的尾音听感很怪。
   */
  function stop() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    activeKind = '';
    for (var i = 0; i < activeNodes.length; i++) {
      try {
        activeNodes[i].stop(0);
      } catch (e) {
        /* 已停过的节点再 stop 会抛错，忽略 */
      }
    }
    activeNodes = [];
  }

  /**
   * 播放一次音效，不循环。
   *
   * @param {string} kind message | hangup | accept | decline
   */
  function playOnce(kind) {
    if (isMuted()) return Promise.resolve();
    if (!PATTERNS[kind]) return Promise.resolve();
    return unlock().then(function () {
      if (isMuted()) return;
      playPattern(kind);
    });
  }

  /**
   * 是否存在正在循环的铃声。
   */
  function isLooping() {
    return !!loopTimer;
  }

  /**
   * 当前循环的 kind。
   */
  function getActiveKind() {
    return activeKind;
  }

  /**
   * 释放资源：停掉一切并关闭 AudioContext。
   * 由通话模块在会话彻底结束后调用。
   */
  function release() {
    stop();
    if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
      try {
        ctx.close();
      } catch (e) {}
    }
    ctx = null;
  }

  global.MiyaChatCallSound = {
    startLoop: startLoop,
    stop: stop,
    playOnce: playOnce,
    preview: playOnce,
    isLooping: isLooping,
    getActiveKind: getActiveKind,
    isMuted: isMuted,
    release: release,
    /* 暴露供设置面板列出可选音效 */
    PATTERNS: PATTERNS
  };
})(window);
