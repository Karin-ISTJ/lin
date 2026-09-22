/**
 * miya-diagnostics.js —— 统一诊断通道
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠️ 重要：关于 miyaSafeLsSet —— 本项目**已经有一个**了
 * ────────────────────────────────────────────────────────
 * 它定义在 `js2/miya-storage.js`，功能相当完善：
 *   · 配额检测 → 控制台告警（带 key 与字节数）
 *   · 节流后提示用户一次（30s 内不刷屏）
 *   · 失败信息挂 global.__miyaLastStorageError
 *   · 写成功自动复位失败计数
 *   · 大值溢出到 IndexedDB
 *
 * 本模块**不重新定义**它。早期版本这里也写了一份 safeLsSet，
 * 结果是「后来的覆盖先前的」—— 我的实现会把上面那些能力全部冲掉，
 * 属于典型的「修复引入更严重的回归」。
 *
 * 本模块真正补的是**另一个缺口**：
 *   项目里有 158 处 `catch (e) {}`，异常被就地掐断、没有任何出口。
 *   miyaNotifyStorageFull 只覆盖「存储」这一类，其余（解析失败、
 *   渲染异常、网络异常…）完全没有留痕手段。
 *   排查「时好时坏 / 复现不出来」的问题时，只能靠猜。
 *
 * 所以这里的职责是：**通用异常上报 + 环形缓冲 + 调试开关**。
 * 存储相关的写入一律走既有的 miyaSafeLsSet（见 miya-storage.js）。
 *
 * 设计原则
 * ────────
 *   1. **默认静默**：生产环境不因加上报就满屏 console
 *   2. **可开关**：打开开关能看到全部线索
 *   3. **环形缓冲**：最近 200 条，出问题可回溯
 *   4. **零依赖**：不依赖其它模块
 *
 * 调试开关的三种开法（任一）
 * ──────────────────────────
 *   · URL 参数：   ?miya_debug=1
 *   · localStorage：localStorage.setItem('miya-debug','1')
 *   · 控制台：     miyaDiag.enable()
 */
(function (global) {
  'use strict';

  var DEBUG_KEY = 'miya-debug';
  var MAX_RECORDS = 200;

  /* ────────────── 调试开关 ────────────── */

  var debugOn = false;

  function readDebugFlag() {
    /* 1) URL 参数优先（方便手机上直接开，不用进设置） */
    try {
      if (typeof global.location !== 'undefined' && global.location.search) {
        var q = global.location.search;
        if (/[?&]miya_debug=1\b/.test(q)) return true;
      }
    } catch (e0) {}
    /* 2) localStorage */
    try {
      var v = localStorage.getItem(DEBUG_KEY);
      if (v === '1' || v === 'true') return true;
    } catch (e1) {}
    return false;
  }

  debugOn = readDebugFlag();

  /* ────────────── 环形缓冲 ────────────── */

  var records = [];
  var seq = 0;

  function record(level, scope, message, detail) {
    seq += 1;
    var rec = {
      n: seq,
      t: Date.now(),
      level: level,
      scope: scope || 'unknown',
      message: message || '',
      detail: detail || '',
    };
    records.push(rec);
    if (records.length > MAX_RECORDS) records.shift();

    if (debugOn) {
      var tag = '[miya:' + rec.scope + ']';
      var fn =
        level === 'error'
          ? console.error
          : level === 'warn'
          ? console.warn
          : console.log;
      try {
        fn.call(console, tag, message, detail || '');
      } catch (e2) {}
    }
    return rec;
  }

  /* ────────────── 对外：统一异常上报 ────────────── */

  /**
   * 上报一个异常。
   *
   * 用法（把 `catch (e) {}` 改成）：
   *     } catch (e) { miyaReportError('contacts.store', e); }
   *
   * 注意：**它不吞异常也不重抛**，只是记录。
   * 调用方原有的控制流完全不变 —— 这是刻意的，
   * 因为把 158 处 catch 全部改成重抛风险太大、收益不明。
   * 先做到「看得见」，再谈「要不要抛」。
   */
  function reportError(scope, err, extra) {
    var msg = '';
    if (err) {
      msg = (err.name ? err.name + ': ' : '') + (err.message || String(err));
    } else {
      msg = '(无错误对象)';
    }
    var detail = '';
    if (extra) {
      try {
        detail = typeof extra === 'string' ? extra : JSON.stringify(extra);
      } catch (e3) {
        detail = '[extra 无法序列化]';
      }
    }
    /* 配额错误单独标记 —— 这是本项目最可能静默发生的存储故障。
       注意：存储写入的**主出口**是 js2/miya-storage.js 的 miyaSafeLsSet，
       这里只是让「任何路径上报上来的配额错误」在诊断里更醒目。 */
    if (/QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED|quota/i.test(msg)) {
      record('error', scope, '存储配额已满：' + msg, detail);
    } else {
      record('warn', scope, msg, detail);
    }
    return msg;
  }

  /* ────────────── 对外：存储相关的「只读辅助」────────────── */

  /*
   * 注意：这里**不提供** miyaSafeLsSet / miyaSafeLsRemove。
   * 写入一律走 js2/miya-storage.js 既有的 miyaSafeLsSet
   * （它有配额检测、节流提示、IDB 溢出、失败计数复位）。
   * 本模块重复定义只会把它覆盖掉，是净损失。
   *
   * 只补两个既有的没有、且对各业务模块有用的小工具：
   *   - miyaDiag.safeRead(key, fallback)   读失败也上报（只读，不动写入语义）
   *   - miyaDiag.safeJson(str, fb, scope)  解析失败留痕
   * 它们都以 miyaDiag.* 暴露，不占用 global 顶层名字，
   * 避免将来又和别人撞名。
   */

  function safeRead(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? (fallback === undefined ? null : fallback) : v;
    } catch (e) {
      reportError('storage.read', e, 'key=' + key);
      return fallback === undefined ? null : fallback;
    }
  }

  /**
   * 安全 JSON 解析 —— 带「是否用了兜底值」的标记。
   * 项目里有大量 `JSON.parse(localStorage.getItem(K)) || fallback`，
   * 数据损坏时会静默变默认值，用户只会觉得「我的东西丢了」。
   */
  function safeJsonParse(str, fallback, scope) {
    if (str === null || str === undefined || str === '') {
      return { ok: true, value: fallback, wasFallback: true };
    }
    try {
      var v = JSON.parse(str);
      return { ok: true, value: v, wasFallback: false };
    } catch (e) {
      reportError(
        scope || 'storage.json',
        e,
        '内容前 80 字符：' + String(str).slice(0, 80)
      );
      return { ok: false, value: fallback, wasFallback: true };
    }
  }

  /* ────────────── 对外：诊断面板数据 ────────────── */

  function dump() {
    return {
      debug: debugOn,
      count: records.length,
      records: records.slice(),
    };
  }

  /**
   * 把诊断信息画在屏幕上 —— 手机用户没法开 DevTools 时的兜底。
   * 与本项目既有的 showImportDiagnostics 同思路：
   * **环境不可观测时，第一优先级是把可观测性做进产品。**
   */
  function showPanel() {
    try {
      var old = document.getElementById('miya-diag-panel');
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var d = dump();
      var lines = d.records
        .slice(-60)
        .map(function (r) {
          var ts = new Date(r.t).toTimeString().slice(0, 8);
          return ts + ' [' + r.scope + '] ' + r.message;
        })
        .join('\n');

      var box = document.createElement('div');
      box.id = 'miya-diag-panel';
      box.setAttribute(
        'style',
        'position:fixed;inset:0;z-index:2147483647;background:#111;color:#0f0;' +
          'font:11px/1.5 monospace;padding:12px;overflow:auto;white-space:pre-wrap;' +
          'word-break:break-all;-webkit-user-select:text;user-select:text'
      );
      /* 面板里一并显示既有的存储失败状态。
         数据源是 js2/miya-storage.js 写入的 global.__miyaLastStorageError ——
         这里只读取、不重复实现（存储写入的唯一出口仍在 miya-storage.js）。 */
      var lsErr = null;
      try {
        lsErr = global.__miyaLastStorageError || null;
      } catch (e4) {}
      var lsLine = lsErr
        ? '存储失败记录：key=' +
          lsErr.key +
          ' · ' +
          lsErr.name +
          ' · 连续 ' +
          lsErr.streak +
          ' 次'
        : '存储失败记录：无';

      var head =
        'MIYA 诊断（' +
        d.count +
        ' 条 · 调试' +
        (d.debug ? '开' : '关') +
        '）\n' +
        lsLine +
        '\n' +
        '─'.repeat(30) +
        '\n';
      box.textContent = head + lines;
      var btn = document.createElement('button');
      btn.textContent = '关闭 ✕';
      btn.setAttribute(
        'style',
        'position:fixed;top:8px;right:8px;z-index:2147483648;padding:6px 10px;' +
          'font:12px monospace;background:#333;color:#fff;border:1px solid #666;border-radius:4px'
      );
      btn.onclick = function () {
        if (box.parentNode) box.parentNode.removeChild(box);
      };
      document.body.appendChild(box);
      box.appendChild(btn);
    } catch (e) {
      reportError('diag.panel', e);
    }
  }

  /* ────────────── 导出 ────────────── */

  /* 通用异常上报 —— 顶层，因为要被各模块广泛调用 */
  global.miyaReportError = reportError;

  /* 其余一律挂在 miyaDiag 命名空间下，避免和既有 global 名字冲突。
     尤其是 **不导出** miyaSafeLsSet —— 那个名字属于 js2/miya-storage.js。 */
  global.miyaDiag = {
    enable: function () {
      debugOn = true;
      try {
        localStorage.setItem(DEBUG_KEY, '1');
      } catch (e) {}
      record('info', 'diag', '调试模式已开启');
      return true;
    },
    disable: function () {
      debugOn = false;
      try {
        localStorage.removeItem(DEBUG_KEY);
      } catch (e) {}
      return true;
    },
    isOn: function () {
      return debugOn;
    },
    report: reportError,
    safeRead: safeRead,
    safeJson: safeJsonParse,
    dump: dump,
    show: showPanel,
    clear: function () {
      records = [];
      return true;
    },
  };

  /* 自检：模块必须在最早加载，这里留一条记录便于确认它真的跑了 */
  record('info', 'diag', '诊断模块已就绪（调试' + (debugOn ? '开' : '关') + '）');
})(window);
