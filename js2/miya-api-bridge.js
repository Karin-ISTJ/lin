/**
 * miya-api-bridge.js — 通用 API 调用核心
 */
(function (global) {
  'use strict';

  /*
   * 流式断线韧性。
   *
   * 背景：SSE 读取时 reader.read() 一旦 reject（弱网抖动、中转站掐连接、
   * 服务端超时断开），旧实现会让整个 Promise 失败，已经收进 contentAcc 的
   * 正文被一起丢掉——用户看到气泡打到一半突然消失，然后报错。
   *
   * ── 为什么去掉了「退避续读」 ──
   * 之前的实现是「中断后退避 400ms/800ms，再调一次 pump() 继续读」。
   * 但 pump() 首句就是 reader.read()，用的是**同一个已经出错的 reader**。
   * 实测（Node ReadableStream）：流被 error 之后，同一个 reader 的 read()
   * 会立刻 reject 同一个错误，重试多少次都一样。于是那 1.2 秒退避完全是
   * 白等，最后仍然只能部分收尾——等于用 1.2 秒延迟换了个空。
   *
   * 真正的续读必须**重新发起 fetch**（并让服务端支持断点续传），成本与
   * 正确性都需单独评估，这里不做。
   *
   * 现在的策略：
   *   1) 有内容 → 立即以已收内容收尾，标记 partial，不浪费用户时间；
   *      无内容 → 抛错，让上层走既有的整体重试。
   *   2) 空闲超时：只要超过 STREAM_IDLE_TIMEOUT_MS 没收到任何数据就主动
   *      断开并按上面的策略收尾。注意这**不是**请求级超时——长回复本就会
   *      持续几十秒，请求级一刀切会误杀正常的长生成。
   * 只对「读流过程」生效；HTTP 非 2xx、解析失败等仍按原样抛错。
   */
  var STREAM_IDLE_TIMEOUT_MS = 60000;  /* 多久没收到数据算「卡死」 */

    function extractJsonObject(text) {
    var t = String(text || '').trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    var i = t.indexOf('{');
    var j = t.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try {
      var obj = JSON.parse(t.slice(i, j + 1));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) {
      return null;
    }
  }

  function truncateStr(s, max) {
    var t = String(s == null ? '' : s);
    var n = max || 8000;
    return t.length <= n ? t : t.slice(0, n) + '\n…(截断)';
  }

  function normalizeBaseUrl(base) {
    var t = String(base || '').trim().replace(/\/+$/, '');
    if (!t) return '';
    try {
      var u = new URL(t);
      var path = (u.pathname || '/').replace(/\/+$/, '');
      var segs = path.split('/').filter(Boolean);
      if (segs.length && segs[segs.length - 1].toLowerCase() === 'v1') return u.origin + path;
      if (!path || path === '/') return u.origin + '/v1';
      return u.origin + path + '/v1';
    } catch (e) {
      return t.toLowerCase().endsWith('/v1') ? t : t + '/v1';
    }
  }

  function getApiCfg() {
    return typeof global.miyaGetApiConfigCached === 'function' ? global.miyaGetApiConfigCached() : {};
  }

  /**
   * Scoped API：某项留空时回退对话 API 对应字段。
   */
  function resolveScopedApiConfig(cfg, key) {
    cfg = cfg && typeof cfg === 'object' ? cfg : getApiCfg();
    var scoped = cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {};
    var baseUrl = String(scoped.baseUrl || '').trim();
    var apiKey = String(scoped.apiKey || '').trim();
    var model = String(scoped.model || '').trim();
    var temp = scoped.temperature;
    if (temp != null) {
      temp = Number(temp);
      if (!Number.isFinite(temp)) temp = cfg.temperature != null ? Number(cfg.temperature) : 1;
    } else {
      temp = cfg.temperature != null ? Number(cfg.temperature) : 1;
    }
    if (!Number.isFinite(temp)) temp = 1;
    return {
      baseUrl: baseUrl || String(cfg.baseUrl || '').trim(),
      apiKey: apiKey || String(cfg.apiKey || '').trim(),
      model: model || String(cfg.model || '').trim(),
      temperature: temp
    };
  }

  function resolveItineraryApiConfig(cfg) {
    return resolveScopedApiConfig(cfg, 'itineraryApi');
  }

  function resolveChatApiConfig(cfg) {
    cfg = cfg && typeof cfg === 'object' ? cfg : getApiCfg();
    var temp = cfg.temperature != null ? Number(cfg.temperature) : 1;
    if (!Number.isFinite(temp)) temp = 1;
    return {
      baseUrl: String(cfg.baseUrl || '').trim(),
      apiKey: String(cfg.apiKey || '').trim(),
      model: String(cfg.model || '').trim(),
      temperature: temp
    };
  }

  function resolveSecondaryApiConfig(cfg) {
    cfg = cfg && typeof cfg === 'object' ? cfg : getApiCfg();
    var sec = cfg.secondaryApi && typeof cfg.secondaryApi === 'object' ? cfg.secondaryApi : {};
    var temp = sec.temperature != null ? Number(sec.temperature) : (cfg.temperature != null ? Number(cfg.temperature) : 1);
    if (!Number.isFinite(temp)) temp = 1;
    return {
      baseUrl: String(sec.baseUrl || '').trim(),
      apiKey: String(sec.apiKey || '').trim(),
      model: String(sec.model || '').trim(),
      temperature: temp
    };
  }

  function apiSliceKey(slice) {
    if (!slice) return '';
    return [slice.baseUrl, slice.apiKey, slice.model].join('\0');
  }

  function isNetworkFetchError(err) {
    var msg = String((err && err.message) || err || '').toLowerCase();
    if (msg.indexOf('http ') === 0) return false;
    return msg === 'failed to fetch' ||
      msg.indexOf('load failed') >= 0 ||
      msg.indexOf('networkerror') >= 0 ||
      msg.indexOf('network request failed') >= 0 ||
      msg.indexOf('请求超时') >= 0 ||
      msg.indexOf('abort') >= 0;
  }

  function normalizeApiTextContent(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();
    if (Array.isArray(raw)) {
      return raw.map(function (p) {
        return p && p.text != null ? String(p.text) : (p && p.content != null ? String(p.content) : '');
      }).join('').trim();
    }
    return String(raw || '').trim();
  }

  function extractReasoningText(message) {
    if (!message || typeof message !== 'object') return '';
    var rc = message.reasoning_content != null ? message.reasoning_content : message.reasoning;
    return normalizeApiTextContent(rc);
  }

  function pickJsonLikeApiText(text, message) {
    var body = String(text || '').trim();
    if (body.indexOf('{') >= 0 || body.indexOf('[') >= 0) return body;
    var reasoning = extractReasoningText(message);
    if (reasoning && (reasoning.indexOf('{') >= 0 || reasoning.indexOf('[') >= 0)) return reasoning;
    return body || reasoning;
  }

  function extractStreamDelta(obj) {
    if (!obj || typeof obj !== 'object') return { content: '', reasoning: '' };
    var ch = obj.choices && obj.choices[0];
    if (!ch) return { content: '', reasoning: '' };
    var delta = ch.delta || ch.message || {};
    var content = normalizeApiTextContent(delta.content != null ? delta.content : delta.text);
    var reasoning = '';
    if (delta.reasoning_content != null) reasoning = normalizeApiTextContent(delta.reasoning_content);
    else if (delta.reasoning != null) reasoning = normalizeApiTextContent(delta.reasoning);
    if (!content && ch.text != null) content = normalizeApiTextContent(ch.text);
    return { content: content, reasoning: reasoning };
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    var ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return fetch(url, options);
    if (typeof AbortController === 'undefined') return fetch(url, options);
    var controller = new AbortController();
    var opts = Object.assign({}, options, { signal: controller.signal });
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      return res;
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error('请求超时（' + Math.round(ms / 1000) + 's），请稍后重试');
      }
      throw err;
    });
  }

  /**
   * 把「响应体」解析成最终文本。
   * 关键：服务端可能无视 stream:false，仍然返回 SSE（data: {...}）。
   * 这时 res.json() 会抛 `Unexpected token 'd', "data: {...}" is not valid JSON`。
   * 所以这里统一按「先看 content-type、再嗅探正文」来决定走哪条路。
   */
  function parseCompletionResponse(res, reqOpts) {
    var eng = global.miyaChatEngine;
    var contentType = '';
    try { contentType = String((res.headers && res.headers.get && res.headers.get('content-type')) || ''); } catch (e) {}

    /* 输出撞到 max_tokens 上限时通知调用方（reqOpts.onTruncated），
       这样上层可以提示用户「这话没说完」，而不是把半句当正常发言。 */
    function notifyTruncated() {
      if (typeof reqOpts.onTruncated === 'function') {
        try { reqOpts.onTruncated(); } catch (e) {}
      }
      if (reqOpts.throwOnTruncate) return Promise.reject(new Error('输出被截断'));
      return null;
    }

    /* 流式读被中断（断线 / 空闲超时）时通知调用方：
       这段内容是真的，但没说完。上层据此提示用户，
       避免把半句话当成完整发言存进历史。 */
    function markPartial(err) {
      if (typeof reqOpts.onPartial === 'function') {
        try {
          reqOpts.onPartial({
            reason: (err && err.name === 'StreamIdleTimeout') ? 'idle_timeout' : 'disconnected',
            message: String((err && err.message) || '流式中断')
          });
        } catch (e) {}
      }
      return null;
    }

    /* 从非流式 JSON 里抠文本 */
    function fromJson(j) {
      var choice = j && j.choices && j.choices[0];
      var text = '';
      if (reqOpts.useEngineExtract && eng && typeof eng.extractReplyContent === 'function') {
        text = eng.extractReplyContent(j);
      } else {
        var msg = choice && choice.message;
        var raw = msg && msg.content;
        if (typeof raw === 'string') text = raw.trim();
        else if (Array.isArray(raw)) {
          text = raw.map(function (p) { return p && p.text ? String(p.text) : ''; }).join('').trim();
        }
      }
      if (!text && choice && choice.message && !reqOpts.contentOnly) {
        text = extractReasoningText(choice.message);
      }
      if (reqOpts.preferJsonPayload && !reqOpts.contentOnly && choice && choice.message) {
        text = pickJsonLikeApiText(text, choice.message);
      }
      if (reqOpts.contentOnly && text) {
        if (eng && typeof eng.stripThinkingForApi === 'function') {
          text = eng.stripThinkingForApi(text);
        }
      }
      if (!text && choice && choice.finish_reason === 'length' && !reqOpts.skipLengthCheck) {
        return Promise.reject(new Error('输出被截断'));
      }
      /* 截断了但有内容：调用方可以据此提示「这话没说完」，而不是当成功静默返回半句 */
      if (text && choice && choice.finish_reason === 'length') notifyTruncated();
      return text;
    }

    /* 把一整段 SSE 正文解析成文本（复用流式分支的语义） */
    function fromSseText(raw) {
      var contentAcc = '';
      var reasoningAcc = '';
      var finishReason = '';
      String(raw || '').split('\n').forEach(function (line) {
        var trimmed = String(line || '').trim();
        if (!trimmed || trimmed === 'data: [DONE]' || trimmed === '[DONE]') return;
        if (trimmed.indexOf('data:') === 0) trimmed = trimmed.slice(5).trim();
        if (!trimmed || trimmed === '[DONE]') return;
        try {
          var obj = JSON.parse(trimmed);
          if (obj && obj.choices && obj.choices[0] && obj.choices[0].finish_reason) {
            finishReason = obj.choices[0].finish_reason;
          }
          var delta = extractStreamDelta(obj);
          if (delta.content) contentAcc += delta.content;
          if (delta.reasoning) reasoningAcc += delta.reasoning;
        } catch (e) { /* 跳过半截行 */ }
      });
      var text = String(contentAcc || '').trim();
      var reasoning = String(reasoningAcc || '').trim();
      if (!text && reasoning) text = reqOpts.contentOnly ? '' : reasoning;
      if (reqOpts.contentOnly && text && eng && typeof eng.stripThinkingForApi === 'function') {
        text = eng.stripThinkingForApi(text);
      }
      if (!text && finishReason === 'length' && !reqOpts.skipLengthCheck) {
        return Promise.reject(new Error('输出被截断'));
      }
      if (text && finishReason === 'length') notifyTruncated();
      return text;
    }

    /* 有 body reader 且像 SSE → 流式读 */
    var looksSse = contentType.indexOf('text/event-stream') >= 0;
    if (res.body && typeof res.body.getReader === 'function' && looksSse) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buf = '';
      var acc = '';
      var racc = '';
      var fr = '';
      function consume(line) {
        var t = String(line || '').trim();
        if (!t || t === 'data: [DONE]' || t === '[DONE]') return;
        if (t.indexOf('data:') === 0) t = t.slice(5).trim();
        if (!t || t === '[DONE]') return;
        try {
          var o = JSON.parse(t);
          if (o && o.choices && o.choices[0] && o.choices[0].finish_reason) fr = o.choices[0].finish_reason;
          var d = extractStreamDelta(o);
          if (d.content) acc += d.content;
          if (d.reasoning) racc += d.reasoning;
        } catch (e) {}
      }
      /* 中断收尾：以已收内容为准，并标记 partial。
         为什么不退避续读了：同一个 reader 出错后不会复活，
         重试只会白等（详见文件顶部说明）。 */
      function finishText(err) {
        if (buf.trim()) { try { consume(buf); } catch (e) {} }
        var text = String(acc || '').trim();
        var reasoning = String(racc || '').trim();
        if (!text && reasoning) text = reqOpts.contentOnly ? '' : reasoning;
        if (reqOpts.contentOnly && text && eng && typeof eng.stripThinkingForApi === 'function') {
          text = eng.stripThinkingForApi(text);
        }
        if (!text) {
          /* 什么都没收到，谈不上「部分内容」，交给上层重试 */
          throw (err || new Error('API 返回为空'));
        }
        if (fr === 'length') notifyTruncated();
        /* 标记这是被中断的半截回复，让上层能提示用户，
           而不是把半句话当正常发言存进历史。 */
        markPartial(err);
        return text;
      }
      /* done 分支与「正常读完」共用一份收尾逻辑 */
      function finishDone() {
        if (buf.trim()) consume(buf);
        var text = String(acc || '').trim();
        var reasoning = String(racc || '').trim();
        if (!text && reasoning) text = reqOpts.contentOnly ? '' : reasoning;
        if (reqOpts.contentOnly && text && eng && typeof eng.stripThinkingForApi === 'function') {
          text = eng.stripThinkingForApi(text);
        }
        if (!text && fr === 'length' && !reqOpts.skipLengthCheck) {
          throw new Error('输出被截断');
        }
        /* 流正常结束但一个字都没解析出来（例如对端其实是 JSON 不是 SSE），
           必须抛错让上层走既有重试，不能静默返回空串。
           旧实现在这个分支会返回空串，被上层当成「空回复」再重试一次，
           白白多花一次请求。 */
        if (!text) throw new Error('API 返回为空');
        if (fr === 'length') notifyTruncated();
        return text;
      }
      return (function pump() {
        var idleTimer = null;
        function clearIdle() {
          if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null; }
        }
        /* 空闲超时看门狗：每收到一块数据就重置。
           只判断「有没有进展」，不限制总时长——长回复本就会持续很久。 */
        var stalled = false;
        function armIdle() {
          clearIdle();
          idleTimer = setTimeout(function () {
            stalled = true;
            if (global.console && console.warn) {
              console.warn('[miya] 流式空闲超时（' + STREAM_IDLE_TIMEOUT_MS + 'ms 无数据），以已收内容收尾');
            }
            try { reader.cancel(); } catch (e) { /* 尽力而为 */ }
          }, STREAM_IDLE_TIMEOUT_MS);
        }
        function step() {
          if (stalled) {
            var e = new Error('流式空闲超时');
            e.name = 'StreamIdleTimeout';
            return finishText(e);
          }
          armIdle();
          return reader.read().then(function (r) {
            clearIdle();
            if (r.done) return finishDone();
            buf += decoder.decode(r.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop() || '';
            lines.forEach(consume);
            return step();
          }, function (err) {
            clearIdle();
            /* 用户主动中止 / 请求级超时 → 原样抛出，
               不做部分收尾（用户知道自己点了停止）。 */
            var aborted = !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
            if (aborted) throw err;
            if (global.console && console.warn) {
              console.warn('[miya] 流式中断，以已收内容收尾：', err && err.message);
            }
            return finishText(err);
          });
        }
        return step();
      })();
    }

    /* 没有 reader（或不是 SSE）：先取正文，嗅探是不是 data: 开头的 SSE */
    return res.text().then(function (raw) {
      var head = String(raw || '').trim();
      if (head.indexOf('data:') === 0 || head.indexOf('data: ') === 0) {
        return fromSseText(head);
      }
      if (!head) throw new Error('API 返回为空');
      try {
        return fromJson(JSON.parse(head));
      } catch (e) {
        /* 还有一些服务端把 JSON 包在事件流里但没有 data: 前缀 */
        if (head.indexOf('event:') >= 0) return fromSseText(head);
        throw new Error('API 返回格式无法解析：' + head.slice(0, 160));
      }
    });
  }

  function callCompletionsWithConfig(systemHint, userContent, imageParts, resolved, reqOpts) {
    var cfg = resolved || resolveChatApiConfig(getApiCfg());
    var base = normalizeBaseUrl(cfg.baseUrl);
    var model = String(cfg.model || '').trim();
    if (!base || !model || !cfg.apiKey) {
      return Promise.reject(new Error('请先在设置中配置 API'));
    }
    reqOpts = reqOpts && typeof reqOpts === 'object' ? reqOpts : {};
    var temp = cfg.temperature;
    if (typeof temp !== 'number' || !Number.isFinite(temp)) temp = Number(temp);
    if (!Number.isFinite(temp)) temp = 1;
    var parts = Array.isArray(imageParts) ? imageParts.filter(Boolean) : [];
    var userMsgContent;
    if (parts.length) {
      userMsgContent = [{ type: 'text', text: String(userContent || '') }].concat(parts);
    } else {
      userMsgContent = String(userContent || '');
    }
    var payload = {
      model: model,
      temperature: temp,
      messages: (function () {
        var eng = global.miyaChatEngine;
        var msgs = [
          { role: 'system', content: String(systemHint || '你会严格按要求输出，仅输出 JSON。') },
          { role: 'user', content: userMsgContent }
        ];
        if (reqOpts.skipUniversalWorldbook) return msgs;
        return eng && typeof eng.prependUniversalWorldbookMessage === 'function'
          ? eng.prependUniversalWorldbookMessage(msgs)
          : msgs;
      })()
    };
    if (reqOpts.max_tokens != null && Number.isFinite(Number(reqOpts.max_tokens))) {
      payload.max_tokens = Number(reqOpts.max_tokens);
    }
    if (reqOpts.temperature != null && Number.isFinite(Number(reqOpts.temperature))) {
      payload.temperature = Number(reqOpts.temperature);
    }
    if (reqOpts.response_format && typeof reqOpts.response_format === 'object') {
      payload.response_format = reqOpts.response_format;
    }
    if (reqOpts.disableThinking) {
      payload.thinking = { type: 'disabled' };
    }
    var fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(cfg.apiKey || '').trim()
      },
      body: JSON.stringify(payload)
    };
    var timeoutMs = Number(reqOpts.timeoutMs);
    return fetchWithTimeout(base + '/chat/completions', fetchOpts, timeoutMs).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 200) : ''));
        });
      }
      /* 服务端可能无视 stream:false 仍返回 SSE，统一交给解析器兼容 */
      return parseCompletionResponse(r, reqOpts);
    });
  }

  function callCompletionsStreamWithConfig(systemHint, userContent, imageParts, resolved, reqOpts) {
    var cfg = resolved || resolveChatApiConfig(getApiCfg());
    var base = normalizeBaseUrl(cfg.baseUrl);
    var model = String(cfg.model || '').trim();
    if (!base || !model || !cfg.apiKey) {
      return Promise.reject(new Error('请先在设置中配置 API'));
    }
    reqOpts = reqOpts && typeof reqOpts === 'object' ? reqOpts : {};
    var temp = cfg.temperature;
    if (typeof temp !== 'number' || !Number.isFinite(temp)) temp = Number(temp);
    if (!Number.isFinite(temp)) temp = 1;
    var parts = Array.isArray(imageParts) ? imageParts.filter(Boolean) : [];
    var userMsgContent = parts.length
      ? [{ type: 'text', text: String(userContent || '') }].concat(parts)
      : String(userContent || '');
    var payload = {
      model: model,
      temperature: temp,
      stream: true,
      messages: (function () {
        var eng = global.miyaChatEngine;
        var msgs = [
          { role: 'system', content: String(systemHint || '你会严格按要求输出，仅输出 JSON。') },
          { role: 'user', content: userMsgContent }
        ];
        if (reqOpts.skipUniversalWorldbook) return msgs;
        return eng && typeof eng.prependUniversalWorldbookMessage === 'function'
          ? eng.prependUniversalWorldbookMessage(msgs)
          : msgs;
      })()
    };
    if (reqOpts.max_tokens != null && Number.isFinite(Number(reqOpts.max_tokens))) {
      payload.max_tokens = Number(reqOpts.max_tokens);
    }
    if (reqOpts.temperature != null && Number.isFinite(Number(reqOpts.temperature))) {
      payload.temperature = Number(reqOpts.temperature);
    }
    if (reqOpts.response_format && typeof reqOpts.response_format === 'object') {
      payload.response_format = reqOpts.response_format;
    }
    if (reqOpts.disableThinking) {
      payload.thinking = { type: 'disabled' };
    }
    var fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(cfg.apiKey || '').trim()
      },
      body: JSON.stringify(payload)
    };
    var timeoutMs = Number(reqOpts.timeoutMs);
    return fetchWithTimeout(base + '/chat/completions', fetchOpts, timeoutMs).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : ''));
        });
      }
      function finalizeAccum(contentAcc, reasoningAcc, finishReason) {
        var text = String(contentAcc || '').trim();
        var reasoning = String(reasoningAcc || '').trim();
        if (reqOpts.preferJsonPayload) {
          text = pickJsonLikeApiText(text, { content: text, reasoning_content: reasoning });
        } else if (!text && reasoning) {
          text = reasoning;
        }
        if (reqOpts.useEngineExtract && !text) {
          var eng = global.miyaChatEngine;
          if (eng && typeof eng.extractReplyContent === 'function') {
            text = eng.extractReplyContent({
              choices: [{ message: { content: contentAcc, reasoning_content: reasoning } }]
            });
          }
        }
        if (reqOpts.contentOnly && text) {
          var stripEng = global.miyaChatEngine;
          if (stripEng && typeof stripEng.stripThinkingForApi === 'function') {
            text = stripEng.stripThinkingForApi(text);
          }
        }
        if (!text && finishReason === 'length' && !reqOpts.skipLengthCheck) {
          return Promise.reject(new Error('输出被截断'));
        }
        if (!text) return Promise.reject(new Error('API 返回为空'));
        return text;
      }
      if (!res.body || !res.body.getReader) {
        return res.json().then(function (j) {
          var choice = j && j.choices && j.choices[0];
          var msg = choice && choice.message;
          var contentAcc = msg ? normalizeApiTextContent(msg.content) : '';
          var reasoningAcc = msg ? extractReasoningText(msg) : '';
          if (!contentAcc) {
            var eng = global.miyaChatEngine;
            if (eng && typeof eng.extractReplyContent === 'function') {
              contentAcc = eng.extractReplyContent(j);
            }
          }
          return finalizeAccum(contentAcc, reasoningAcc, choice && choice.finish_reason);
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var sseBuf = '';
      var contentAcc = '';
      var reasoningAcc = '';
      var finishReason = '';
      function consumeSseLine(line) {
        var trimmed = String(line || '').trim();
        if (!trimmed || trimmed === 'data: [DONE]' || trimmed === '[DONE]') return;
        if (trimmed.indexOf('data:') === 0) trimmed = trimmed.slice(5).trim();
        if (!trimmed || trimmed === '[DONE]') return;
        try {
          var obj = JSON.parse(trimmed);
          if (obj && obj.choices && obj.choices[0] && obj.choices[0].finish_reason) {
            finishReason = obj.choices[0].finish_reason;
          }
          var delta = extractStreamDelta(obj);
          if (delta.content) contentAcc += delta.content;
          if (delta.reasoning) reasoningAcc += delta.reasoning;
        } catch (e) { /* ignore partial SSE */ }
      }
      /* 流式读被中断（断线 / 空闲超时）时通知调用方：
         这段内容是真的，但没说完。上层据此提示用户，
         避免把半句话当成完整发言存进历史。

         ⚠️ 本函数此前**引用了一个不存在的 markPartial** ——
         它实际定义在 parseCompletionResponse（第 207 行）内部，
         与本函数是两套独立的实现，闭包链并不相通，调用必抛 ReferenceError。
         后果：流式中断（最需要提示用户「话没说完」的时刻）自己先崩，
         且抛点在 finishPartial 内，导致 finalizeAccum 也走不到 ——
         已收内容连正常收尾都拿不到。

         这里补上本函数自己的实现（reqOpts 是第 497 行的形参，闭包可见）。 */
      function markPartial(err) {
        if (typeof reqOpts.onPartial === 'function') {
          try {
            reqOpts.onPartial({
              reason: (err && err.name === 'StreamIdleTimeout') ? 'idle_timeout' : 'disconnected',
              message: String((err && err.message) || '流式中断')
            });
          } catch (e) {}
        }
        return null;
      }
      /* 中断收尾：把已收内容交给 finalizeAccum 走正常后处理，并标记 partial。
         注意此时 finishReason 大概是空串，所以不会被当成「max_tokens 截断」误报。
         去掉了退避续读——同一个 reader 出错后不会复活，重试只是白等。 */
      function finishPartial(err) {
        if (sseBuf.trim()) { try { consumeSseLine(sseBuf); } catch (e) {} }
        markPartial(err);
        return finalizeAccum(contentAcc, reasoningAcc, finishReason);
      }
      return (function pump() {
        var idleTimer = null;
        var stalled = false;
        function clearIdle() {
          if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null; }
        }
        function armIdle() {
          clearIdle();
          idleTimer = setTimeout(function () {
            stalled = true;
            if (global.console && console.warn) {
              console.warn('[miya] 流式空闲超时（' + STREAM_IDLE_TIMEOUT_MS + 'ms 无数据），以已收内容收尾');
            }
            try { reader.cancel(); } catch (e) { /* 尽力而为 */ }
          }, STREAM_IDLE_TIMEOUT_MS);
        }
        function step() {
          if (stalled) {
            var e = new Error('流式空闲超时');
            e.name = 'StreamIdleTimeout';
            if (!String(contentAcc || '').length && !String(reasoningAcc || '').length) throw e;
            return finishPartial(e);
          }
          armIdle();
          return reader.read().then(function (result) {
            clearIdle();
            if (result.done) {
              if (sseBuf.trim()) consumeSseLine(sseBuf);
              return finalizeAccum(contentAcc, reasoningAcc, finishReason);
            }
            sseBuf += decoder.decode(result.value, { stream: true });
            var parts = sseBuf.split('\n');
            sseBuf = parts.pop() || '';
            parts.forEach(consumeSseLine);
            return step();
          }, function (err) {
            clearIdle();
            /* 用户主动中止/超时 → 原样抛出，不做部分收尾 */
            var aborted = !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
            if (aborted) throw err;
            /* 无内容可保 → 真失败，交给上层整体重试 */
            if (!String(contentAcc || '').length && !String(reasoningAcc || '').length) throw err;
            if (global.console && console.warn) {
              console.warn('[miya] 流式中断，以已收内容收尾：', err && err.message);
            }
            return finishPartial(err);
          });
        }
        return step();
      })();
    });
  }

  function callChatCompletionsRaw(systemHint, userContent, imageParts) {
    return callCompletionsWithConfig(systemHint, userContent, imageParts, resolveChatApiConfig(getApiCfg()));
  }

  function callMainChatCompletionsRaw(systemHint, userContent, imageParts, reqOpts) {
    return callCompletionsWithConfig(systemHint, userContent, imageParts, resolveChatApiConfig(getApiCfg()), reqOpts);
  }

  function callItineraryCompletionsRaw(systemHint, userContent, imageParts, reqOpts) {
    var callOpts = Object.assign({
      skipUniversalWorldbook: true,
      skipLengthCheck: true,
      useEngineExtract: true,
      preferJsonPayload: true,
      contentOnly: true,
      disableThinking: true,
      timeoutMs: 180000
    }, reqOpts || {});
    delete callOpts.preferJsonFormat;
    delete callOpts.preferStream;

    var cfg = getApiCfg();
    var resolved = resolveItineraryApiConfig(cfg);
    if (!resolved.baseUrl || !resolved.apiKey || !resolved.model) {
      return Promise.reject(new Error('请先在设置中配置 API'));
    }

    if (callOpts.stream === false) {
      return callCompletionsWithConfig(systemHint, userContent, imageParts, resolved, callOpts);
    }

    return callCompletionsStreamWithConfig(systemHint, userContent, imageParts, resolved, callOpts)
      .catch(function (err) {
        var retryOpts = Object.assign({}, callOpts, { stream: false });
        return callCompletionsWithConfig(systemHint, userContent, imageParts, resolved, retryOpts);
      });
  }

  global.miyaApiBridge = {
    callChatCompletionsRaw: callChatCompletionsRaw,
    callMainChatCompletionsRaw: callMainChatCompletionsRaw,
    callItineraryCompletionsRaw: callItineraryCompletionsRaw,
    resolveItineraryApiConfig: resolveItineraryApiConfig,
    resolveChatApiConfig: resolveChatApiConfig,
    resolveSecondaryApiConfig: resolveSecondaryApiConfig,
    extractJsonObject: extractJsonObject
  };
})(window);
