/**
 * miya-api-bridge.js — 通用 API 调用核心
 */
(function (global) {
  'use strict';

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

  function delayMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
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
      return r.json();
    }).then(function (j) {
      var choice = j && j.choices && j.choices[0];
      var text = '';
      var eng = global.miyaChatEngine;
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
        var stripEng = global.miyaChatEngine;
        if (stripEng && typeof stripEng.stripThinkingForApi === 'function') {
          text = stripEng.stripThinkingForApi(text);
        }
      }
      if (!text && choice && choice.finish_reason === 'length' && !reqOpts.skipLengthCheck) {
        return Promise.reject(new Error('输出被截断'));
      }
      return text;
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
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            if (sseBuf.trim()) consumeSseLine(sseBuf);
            return finalizeAccum(contentAcc, reasoningAcc, finishReason);
          }
          sseBuf += decoder.decode(result.value, { stream: true });
          var parts = sseBuf.split('\n');
          sseBuf = parts.pop() || '';
          parts.forEach(consumeSseLine);
          return pump();
        });
      }
      return pump();
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
