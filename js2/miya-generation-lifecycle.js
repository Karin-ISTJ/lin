/**
 * Miya · 生成生命周期
 * 参考 TauriTavern generation-idle-gate / lifecycle 思路，适配浏览器包体：
 * - 按会话登记 AbortController
 * - busy / idle 门闩
 * - 统一 start / stop / finish / error 事件
 */
(function (global) {
  'use strict';

  function createIdleGate() {
    var idlePromise = Promise.resolve();
    var resolveIdle = null;
    return {
      wait: function () { return idlePromise; },
      markBusy: function () {
        if (resolveIdle) return;
        idlePromise = new Promise(function (resolve) { resolveIdle = resolve; });
      },
      markIdle: function () {
        var r = resolveIdle;
        if (!r) return;
        resolveIdle = null;
        r();
      },
      isBusy: function () { return !!resolveIdle; }
    };
  }

  var globalGate = createIdleGate();
  var controllers = Object.create(null);
  var meta = Object.create(null);
  var listeners = [];

  function emit(evt) {
    var i, fn;
    for (i = 0; i < listeners.length; i++) {
      fn = listeners[i];
      try { fn(evt); } catch (e) {}
    }
    try {
      document.dispatchEvent(new CustomEvent('miya-generation', { detail: evt }));
    } catch (e2) {}
  }

  function keyOf(scope) {
    return String(scope || 'default');
  }

  function begin(scope, info) {
    var key = keyOf(scope);
    stop(key, { silent: true, reason: 'supersede' });
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    controllers[key] = ctl;
    meta[key] = {
      scope: key,
      startedAt: Date.now(),
      info: info && typeof info === 'object' ? info : {},
      status: 'generating'
    };
    globalGate.markBusy();
    emit({ type: 'start', scope: key, meta: meta[key] });
    return ctl;
  }

  function getSignal(scope) {
    var ctl = controllers[keyOf(scope)];
    return ctl ? ctl.signal : null;
  }

  function getController(scope) {
    return controllers[keyOf(scope)] || null;
  }

  function isGenerating(scope) {
    if (scope == null || scope === '') return globalGate.isBusy();
    return !!controllers[keyOf(scope)];
  }

  function stop(scope, opts) {
    var key = keyOf(scope);
    var o = opts && typeof opts === 'object' ? opts : {};
    var ctl = controllers[key];
    if (ctl) {
      try { ctl.abort(); } catch (e) {}
    }
    delete controllers[key];
    if (meta[key]) {
      meta[key].status = 'aborted';
      meta[key].endedAt = Date.now();
    }
    if (!Object.keys(controllers).length) globalGate.markIdle();
    if (!o.silent) emit({ type: 'stop', scope: key, reason: o.reason || 'user', meta: meta[key] || null });
    return true;
  }

  function finish(scope, result) {
    var key = keyOf(scope);
    delete controllers[key];
    if (meta[key]) {
      meta[key].status = 'done';
      meta[key].endedAt = Date.now();
      meta[key].result = result || null;
    }
    if (!Object.keys(controllers).length) globalGate.markIdle();
    emit({ type: 'finish', scope: key, result: result || null, meta: meta[key] || null });
  }

  function fail(scope, error) {
    var key = keyOf(scope);
    delete controllers[key];
    if (meta[key]) {
      meta[key].status = 'error';
      meta[key].endedAt = Date.now();
      meta[key].error = error ? String(error.message || error) : 'error';
    }
    if (!Object.keys(controllers).length) globalGate.markIdle();
    emit({ type: 'error', scope: key, error: error, meta: meta[key] || null });
  }

  function isAbortError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    var msg = String(err.message || err);
    return msg === 'aborted' || msg === 'AbortError' || /aborted/i.test(msg);
  }

  function on(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  global.MiyaGenerationLifecycle = {
    createIdleGate: createIdleGate,
    begin: begin,
    stop: stop,
    finish: finish,
    fail: fail,
    getSignal: getSignal,
    getController: getController,
    isGenerating: isGenerating,
    isAbortError: isAbortError,
    waitIdle: function () { return globalGate.wait(); },
    on: on
  };
})(window);
