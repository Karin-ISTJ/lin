/**
 * miya-image-gen.js — 生图 API（OpenAI 兼容 / NovelAI）、预设、聊天与朋友圈集成
 */
(function (global) {
  'use strict';

  var PRESETS_KEY = 'miya-image-gen-presets-v1';
  var MAX_PRESETS = 24;

  var OPENAI_SIZES = [
    { v: '1792x1024', label: '16:9 横版' },
    { v: '1024x1792', label: '9:16 竖版' },
    { v: '1024x1024', label: '1:1 正方形' },
    { v: '512x512', label: '1:1 正方形（小）' },
    { v: '256x256', label: '1:1 正方形（极小）' }
  ];
  var NOVELAI_SIZES = [
    { v: '1216x832', label: '3:2 横版' },
    { v: '832x1216', label: '2:3 竖版' },
    { v: '1536x1024', label: '3:2 横版' },
    { v: '1024x1536', label: '2:3 竖版' },
    { v: '1024x1024', label: '1:1 正方形' },
    { v: '1472x1472', label: '1:1 正方形（高清）' }
  ];

  var NOVELAI_MODELS = [
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-full',
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-3',
    'nai-diffusion-furry-3'
  ];

  var NOVELAI_SAMPLERS = [
    'k_euler_ancestral',
    'k_euler',
    'k_dpmpp_2m',
    'k_dpmpp_sde',
    'k_lms',
    'ddim_v3'
  ];

  var REF_LEGAL_NOTE =
    '参考图仅针对支持图片输入的模型生效。严禁上传无版权、无授权的图片信息；严禁未经他人允许上传他人肖像信息。';

  var presetsCache = null;
  var presetsReady = null;
  var inFlight = Object.create(null);

  function trim(s) {
    return String(s == null ? '' : s).trim();
  }

  function toast(msg) {
    if (global.miyaSettingsApp && global.miyaSettingsApp.toast) {
      global.miyaSettingsApp.toast(msg);
      return;
    }
    if (global.miyaChatApp && global.miyaChatApp.toast) {
      global.miyaChatApp.toast(msg);
      return;
    }
    var div = document.createElement('div');
    div.className = 'ins-toast';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 2400);
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function defaultImageGenConfig() {
    return {
      enabled: false,
      provider: 'openai',
      positivePrompt: '',
      negativePrompt: '',
      size: '1024x1024',
      openai: {
        baseUrl: '',
        apiKey: '',
        model: ''
      },
      novelai: {
        baseUrl: 'https://image.novelai.net',
        apiKey: '',
        model: 'nai-diffusion-4-5-full',
        sampler: 'k_euler_ancestral',
        steps: 28,
        scale: 5,
        sm: false,
        smDyn: false
      }
    };
  }

  function normalizeImageGenConfig(raw) {
    var d = defaultImageGenConfig();
    if (!raw || typeof raw !== 'object') return d;
    var out = Object.assign({}, d, raw);
    out.provider = out.provider === 'novelai' ? 'novelai' : 'openai';
    out.enabled = !!out.enabled;
    out.positivePrompt = trim(out.positivePrompt).slice(0, 4000);
    out.negativePrompt = trim(out.negativePrompt).slice(0, 4000);
    var sz = trim(out.size);
    out.size = sz || d.size;
    var oa = raw.openai && typeof raw.openai === 'object' ? raw.openai : {};
    out.openai = {
      baseUrl: trim(oa.baseUrl),
      apiKey: trim(oa.apiKey),
      model: trim(oa.model)
    };
    var na = raw.novelai && typeof raw.novelai === 'object' ? raw.novelai : {};
    var steps = parseInt(na.steps, 10);
    var scale = parseFloat(na.scale);
    out.novelai = {
      baseUrl: trim(na.baseUrl) || d.novelai.baseUrl,
      apiKey: trim(na.apiKey),
      model: trim(na.model) || d.novelai.model,
      sampler: trim(na.sampler) || d.novelai.sampler,
      steps: Number.isFinite(steps) ? Math.min(50, Math.max(1, steps)) : d.novelai.steps,
      scale: Number.isFinite(scale) ? Math.min(10, Math.max(0, scale)) : d.novelai.scale,
      sm: !!na.sm,
      smDyn: !!(na.smDyn != null ? na.smDyn : na.sm_dyn)
    };
    return out;
  }

  function normalizeContactImageGen(raw) {
    if (!raw || typeof raw !== 'object') {
      return { enabled: false, customPrompt: '', refUrl: '', refBlobId: null };
    }
    return {
      enabled: !!raw.enabled,
      customPrompt: trim(raw.customPrompt).slice(0, 4000),
      refUrl: trim(raw.refUrl),
      refBlobId: raw.refBlobId ? String(raw.refBlobId) : null
    };
  }

  function getApiConfig() {
    return typeof global.miyaGetApiConfigCached === 'function' ? global.miyaGetApiConfigCached() : {};
  }

  function getImageGenConfig() {
    var cfg = getApiConfig();
    return normalizeImageGenConfig(cfg.imageGen);
  }

  function saveImageGenConfig(patch) {
    var cur = getImageGenConfig();
    var next = normalizeImageGenConfig(Object.assign({}, cur, patch || {}));
    if (patch && patch.openai) next.openai = Object.assign({}, cur.openai, patch.openai);
    if (patch && patch.novelai) next.novelai = Object.assign({}, cur.novelai, patch.novelai);
    if (typeof global.miyaSetApiConfig === 'function') {
      global.miyaSetApiConfig({ imageGen: next });
    }
    return next;
  }

  function isGlobalEnabled() {
    var cfg = getImageGenConfig();
    if (!cfg.enabled) return false;
    if (cfg.provider === 'novelai') {
      return !!(cfg.novelai.apiKey && cfg.novelai.model);
    }
    return !!(cfg.openai.baseUrl && cfg.openai.apiKey && cfg.openai.model);
  }

  function getStore() {
    return global.miyaChatStore || null;
  }

  function findChatByContactId(contactId) {
    var st = getStore();
    if (!st || typeof st.findChatByContact !== 'function') return null;
    return st.findChatByContact(String(contactId || '').trim()) || null;
  }

  function getContactImageGenSettings(contactId) {
    var cid = String(contactId || '').trim();
    if (!cid) return normalizeContactImageGen(null);
    var st = getStore();
    if (!st) return normalizeContactImageGen(null);
    var chat = findChatByContactId(cid);
    if (!chat) return normalizeContactImageGen(null);
    var settings = st.getChatSettings(chat.id) || {};
    return normalizeContactImageGen(settings.imageGen);
  }

  function isContactEnabled(contactId) {
    if (!isGlobalEnabled()) return false;
    return !!getContactImageGenSettings(contactId).enabled;
  }

  function parseSize(sizeStr) {
    var s = trim(sizeStr);
    var m = s.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!m) return { width: 1024, height: 1024 };
    return { width: parseInt(m[1], 10) || 1024, height: parseInt(m[2], 10) || 1024 };
  }

  function openAiCompatibleApiRoot(base) {
    var t = trim(base).replace(/\/+$/, '');
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

  function novelAiEndpoint(base) {
    var t = trim(base).replace(/\/+$/, '');
    if (!t) t = 'https://image.novelai.net';
    if (/\/ai\/generate-image$/i.test(t)) return t;
    return t + '/ai/generate-image';
  }

  function extractPersonaAppearance(contact) {
    if (!contact) return '';
    var persona = trim(contact.persona || contact.description || '');
    if (!persona) {
      var parts = [contact.background, contact.personality, contact.appearance, contact.other]
        .map(trim)
        .filter(Boolean);
      persona = parts.join('；');
    }
    if (!persona) return '';
    var slice = persona.slice(0, 600);
    return slice.replace(/\s+/g, ' ').trim();
  }

  function resolveContactGenderKey(contact) {
    if (!contact) return '';
    var g = trim(contact.gender).toLowerCase();
    if (!g) return '';
    if (/^(男|男性|男生|男人|boy|male|m)$/i.test(g) || /男/.test(g)) return 'male';
    if (/^(女|女性|女生|女人|girl|female|f)$/i.test(g) || /女/.test(g)) return 'female';
    return '';
  }

  function buildGenderPromptTags(contact) {
    var key = resolveContactGenderKey(contact);
    if (key === 'male') {
      return {
        positive: '1boy, male, man',
        negative: '1girl, female, woman, feminine, breasts'
      };
    }
    if (key === 'female') {
      return {
        positive: '1girl, female, woman',
        negative: '1boy, male, man, masculine, beard'
      };
    }
    return { positive: '', negative: '' };
  }

  function buildPromptBundle(contactId, sceneDesc) {
    var cfg = getImageGenConfig();
    var contact = null;
    var st = getStore();
    if (st && contactId) contact = st.findContact(contactId);
    var cImg = getContactImageGenSettings(contactId);
    var genderTags = buildGenderPromptTags(contact);
    var posParts = [];
    if (cfg.positivePrompt) posParts.push(cfg.positivePrompt);
    if (genderTags.positive) posParts.push(genderTags.positive);
    if (cImg.customPrompt) {
      posParts.push(cImg.customPrompt);
    } else {
      var personaHint = extractPersonaAppearance(contact);
      if (personaHint) posParts.push(personaHint);
    }
    var scene = trim(sceneDesc);
    if (scene) posParts.push(scene);
    posParts.push('masterpiece, best quality, highly detailed, coherent composition, natural lighting');
    var negParts = [];
    if (cfg.negativePrompt) negParts.push(cfg.negativePrompt);
    if (genderTags.negative) negParts.push(genderTags.negative);
    negParts.push('lowres, bad anatomy, bad hands, blurry, watermark, text, logo, cropped, worst quality');
    return {
      positive: posParts.filter(Boolean).join(', '),
      negative: negParts.filter(Boolean).join(', ')
    };
  }

  function dataUrlToBase64(dataUrl) {
    var s = String(dataUrl || '');
    var i = s.indexOf(',');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      if (!blob) return reject(new Error('no_blob'));
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('read_failed')); };
      fr.readAsDataURL(blob);
    });
  }

  function resolveReferenceDataUrl(contactId) {
    var cImg = getContactImageGenSettings(contactId);
    if (cImg.refUrl) return Promise.resolve(cImg.refUrl);
    if (!cImg.refBlobId) return Promise.resolve('');
    var st = getStore();
    if (!st || typeof st.getAvatarUrl !== 'function') return Promise.resolve('');
    return st.getAvatarUrl(cImg.refBlobId).catch(function () { return ''; });
  }

  function fetchOpenAiModels(base, key) {
    var root = openAiCompatibleApiRoot(base);
    if (!root) return Promise.reject(new Error('empty_base'));
    return fetch(root + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + trim(key) }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!Array.isArray(j.data)) return [];
      return j.data.map(function (x) { return x && x.id ? String(x.id) : ''; }).filter(Boolean).sort();
    });
  }

  function extractFirstImageBlobFromZip(arrayBuffer) {
    if (!global.JSZip) return Promise.reject(new Error('jszip_missing'));
    return global.JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var names = Object.keys(zip.files || {}).filter(function (n) {
        var f = zip.files[n];
        return f && !f.dir && /\.(png|jpg|jpeg|webp)$/i.test(n);
      });
      if (!names.length) throw new Error('zip_empty');
      return zip.files[names[0]].async('blob');
    });
  }

  function generateOpenAi(opts) {
    var cfg = getImageGenConfig();
    var root = openAiCompatibleApiRoot(cfg.openai.baseUrl);
    if (!root || !cfg.openai.apiKey || !cfg.openai.model) {
      return Promise.reject(new Error('openai_not_configured'));
    }
    var size = trim(opts.size || cfg.size) || '1024x1024';
    var payload = {
      model: cfg.openai.model,
      prompt: trim(opts.prompt),
      n: 1,
      size: size,
      response_format: 'b64_json'
    };
    if (trim(opts.negative)) payload.negative_prompt = trim(opts.negative);

    function callGenerations() {
      return fetch(root + '/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.openai.apiKey
        },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.text().then(function (t) {
          if (!r.ok) throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 160) : ''));
          var j;
          try { j = JSON.parse(t); } catch (e) { throw new Error('invalid_json'); }
          var item = j.data && j.data[0];
          if (!item) throw new Error('empty_image');
          if (item.b64_json) {
            var bin = atob(item.b64_json);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new Blob([u8], { type: 'image/png' });
          }
          if (item.url) {
            return fetch(item.url).then(function (imgR) {
              if (!imgR.ok) throw new Error('url_fetch_failed');
              return imgR.blob();
            });
          }
          throw new Error('no_image_data');
        });
      });
    }

    if (opts.referenceDataUrl) {
      var refB64 = dataUrlToBase64(opts.referenceDataUrl);
      var editPayload = {
        model: cfg.openai.model,
        prompt: trim(opts.prompt),
        n: 1,
        size: size,
        response_format: 'b64_json',
        image: refB64
      };
      return fetch(root + '/images/edits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.openai.apiKey
        },
        body: JSON.stringify(editPayload)
      }).then(function (r) {
        return r.text().then(function (t) {
          if (r.ok) {
            var j = JSON.parse(t);
            var item = j.data && j.data[0];
            if (item && item.b64_json) {
              var bin = atob(item.b64_json);
              var u8 = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
              return new Blob([u8], { type: 'image/png' });
            }
          }
          return callGenerations();
        });
      }).catch(function () {
        return callGenerations();
      });
    }
    return callGenerations();
  }

  function generateNovelAi(opts) {
    var cfg = getImageGenConfig();
    var na = cfg.novelai;
    if (!na.apiKey || !na.model) return Promise.reject(new Error('novelai_not_configured'));
    var dim = parseSize(opts.size || cfg.size);
    var body = {
      input: trim(opts.prompt),
      model: na.model,
      action: 'generate',
      parameters: {
        width: dim.width,
        height: dim.height,
        scale: na.scale,
        sampler: na.sampler,
        steps: na.steps,
        n_samples: 1,
        seed: Math.floor(Math.random() * 999999999),
        negative_prompt: trim(opts.negative) || '',
        sm: !!na.sm,
        sm_dyn: !!na.smDyn,
        qualityToggle: true,
        ucPreset: 0
      }
    };
    if (opts.referenceDataUrl) {
      body.parameters.reference_image_multiple = [dataUrlToBase64(opts.referenceDataUrl)];
      body.parameters.reference_strength_multiple = [0.6];
      body.parameters.add_original_image = true;
    }
    return fetch(novelAiEndpoint(na.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + na.apiKey
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 160) : ''));
        });
      }
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('json') >= 0) {
        return r.json().then(function (j) {
          if (j && j.image) {
            var bin = atob(j.image);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new Blob([u8], { type: 'image/png' });
          }
          throw new Error('invalid_novelai_json');
        });
      }
      return r.arrayBuffer().then(function (buf) {
        if (ct.indexOf('zip') >= 0 || ct.indexOf('octet-stream') >= 0) {
          return extractFirstImageBlobFromZip(buf);
        }
        return new Blob([buf], { type: 'image/png' });
      });
    });
  }

  function ensureApiConfigReady() {
    if (typeof global.miyaEnsureApiConfigHydrated === 'function') {
      return global.miyaEnsureApiConfigHydrated();
    }
    return Promise.resolve();
  }

  function formatImageGenError(err) {
    var code = err && err.message ? String(err.message) : '';
    if (code === 'image_gen_disabled' || code === 'openai_not_configured' || code === 'novelai_not_configured') {
      return '生图配置未加载或已失效，请到设置里重新保存生图配置后再试';
    }
    if (code === 'contact_disabled') return '该联系人未开启生图';
    if (code === 'empty_prompt') return '图片描述为空，无法生图';
    if (code.indexOf('HTTP ') === 0) return '生图 API 返回错误：' + code.slice(0, 120);
    if (code) return '生图失败：' + code.slice(0, 120);
    return '生图失败，请检查配置与网络';
  }

  function generateImageForScene(contactId, sceneDesc, overrides) {
    overrides = overrides && typeof overrides === 'object' ? overrides : {};
    return ensureApiConfigReady().then(function () {
      if (!isGlobalEnabled()) return Promise.reject(new Error('image_gen_disabled'));
      if (contactId && !overrides.skipContactCheck && !isContactEnabled(contactId)) {
        return Promise.reject(new Error('contact_disabled'));
      }
      var cfg = getImageGenConfig();
      var bundle = buildPromptBundle(contactId, sceneDesc);
      if (!trim(bundle.positive)) return Promise.reject(new Error('empty_prompt'));
      var refPromise = overrides.referenceDataUrl != null
        ? Promise.resolve(overrides.referenceDataUrl)
        : resolveReferenceDataUrl(contactId);
      return refPromise.then(function (refUrl) {
        var req = {
          prompt: bundle.positive,
          negative: bundle.negative,
          size: overrides.size || cfg.size,
          referenceDataUrl: refUrl || ''
        };
        if (cfg.provider === 'novelai') return generateNovelAi(req);
        return generateOpenAi(req);
      });
    });
  }

  function storeImageBlob(blob) {
    var st = getStore();
    if (!st || typeof st.storeMediaBlob !== 'function') return Promise.reject(new Error('store_missing'));
    return st.storeMediaBlob(blob, 'chat');
  }

  function markChatMessagePending(chatId, msgId) {
    var st = getStore();
    if (!st) return Promise.resolve();
    return st.updateMessage(chatId, msgId, { imageGenPending: true, imageGenFailed: false }).then(function () {
      if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId &&
        global.miyaChatRoom.getOpenChatId() === chatId &&
        typeof global.miyaChatRoom.patchMessageBubble === 'function') {
        global.miyaChatRoom.patchMessageBubble(msgId);
      }
    });
  }

  function finalizeChatMessage(chatId, msgId, blobId, caption) {
    var st = getStore();
    if (!st) return Promise.resolve();
    return st.updateMessage(chatId, msgId, {
      type: 'image',
      imageKind: 'photo',
      imageDataKey: blobId,
      imageGenPending: false,
      imageGenFailed: false
    }).then(function () {
      if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId &&
        global.miyaChatRoom.getOpenChatId() === chatId &&
        typeof global.miyaChatRoom.patchMessageBubble === 'function') {
        global.miyaChatRoom.patchMessageBubble(msgId);
      }
    });
  }

  function markChatMessageFailed(chatId, msgId) {
    var st = getStore();
    if (!st) return Promise.resolve();
    return st.updateMessage(chatId, msgId, { imageGenPending: false, imageGenFailed: true }).then(function () {
      if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId &&
        global.miyaChatRoom.getOpenChatId() === chatId &&
        typeof global.miyaChatRoom.patchMessageBubble === 'function') {
        global.miyaChatRoom.patchMessageBubble(msgId);
      }
    });
  }

  function extractSceneFromChatMessage(msg) {
    if (!msg || msg.type !== 'image') return '';
    if (msg.imageKind === 'text' || (!msg.imageDataKey && trim(msg.content))) {
      return trim(msg.content).replace(/^图片[-－—]\s*/, '');
    }
    return '';
  }

  function canGenerateChatMessage(chatId, msg) {
    if (!msg || msg.role !== 'assistant') return false;
    if (msg.imageDataKey || msg.imageGenFailed) return false;
    var scene = extractSceneFromChatMessage(msg);
    if (!scene) return false;
    var st = getStore();
    if (!st) return false;
    var chat = st.findChat(chatId);
    if (!chat || chat.type === 'group') return false;
    return isContactEnabled(chat.contactId);
  }

  function shouldAutoGenerateChatMessage(chatId, msg) {
    if (!msg || msg.imageDataKey) return false;
    if (msg.imageGenPending) return true;
    if (msg.imageGenFailed) return false;
    return canGenerateChatMessage(chatId, msg);
  }

  function abortChatMessageGeneration(chatId, msgId) {
    return markChatMessageFailed(chatId, msgId).then(function () {
      return false;
    });
  }

  function processChatMessage(chatId, msg) {
    if (!msg || msg.role !== 'assistant') return Promise.resolve(false);
    if (msg.imageDataKey) return Promise.resolve(false);
    var st = getStore();
    if (!st) return Promise.resolve(false);
    var live = typeof st.findMessage === 'function' ? st.findMessage(chatId, msg.id) : msg;
    msg = live || msg;
    if (msg.imageDataKey) return Promise.resolve(false);
    if (!canGenerateChatMessage(chatId, msg) && !msg.imageGenPending) return Promise.resolve(false);
    var scene = extractSceneFromChatMessage(msg);
    if (!scene) {
      if (msg.imageGenPending) return abortChatMessageGeneration(chatId, msg.id);
      return Promise.resolve(false);
    }
    var chat = st.findChat(chatId);
    if (!chat || chat.type === 'group') {
      if (msg.imageGenPending) return abortChatMessageGeneration(chatId, msg.id);
      return Promise.resolve(false);
    }
    var key = chatId + ':' + msg.id;
    if (inFlight[key]) return inFlight[key];
    var pendingStep = msg.imageGenPending ? Promise.resolve() : markChatMessagePending(chatId, msg.id);
    inFlight[key] = pendingStep
      .then(function () {
        return generateImageForScene(chat.contactId, scene);
      })
      .then(function (blob) {
        return storeImageBlob(blob).then(function (blobId) {
          if (!blobId) throw new Error('store_failed');
          return finalizeChatMessage(chatId, msg.id, blobId, scene);
        });
      })
      .then(function () {
        delete inFlight[key];
        return true;
      })
      .catch(function (err) {
        return markChatMessageFailed(chatId, msg.id).then(function () {
          delete inFlight[key];
          toast(formatImageGenError(err));
          return false;
        });
      });
    return inFlight[key];
  }

  function retryChatMessage(chatId, msgId) {
    var st = getStore();
    if (!st || !chatId || !msgId) return Promise.resolve(false);
    var msg = typeof st.findMessage === 'function' ? st.findMessage(chatId, msgId) : null;
    if (!msg || msg.imageDataKey) return Promise.resolve(false);
    var key = chatId + ':' + msgId;
    delete inFlight[key];
    return st.updateMessage(chatId, msgId, { imageGenFailed: false, imageGenPending: false })
      .then(function (next) {
        return processChatMessage(chatId, next || msg);
      });
  }

  function processAssistantMessages(chatId, msgs) {
    if (!isGlobalEnabled()) return Promise.resolve();
    var list = Array.isArray(msgs) ? msgs : [];
    var eligible = list.filter(function (m) {
      return canGenerateChatMessage(chatId, m);
    });
    if (!eligible.length) return Promise.resolve();
    return Promise.all(eligible.map(function (m) {
      return markChatMessagePending(chatId, m.id);
    })).then(function () {
      var chain = Promise.resolve();
      eligible.forEach(function (m) {
        chain = chain.then(function () {
          return processChatMessage(chatId, m);
        });
      });
      return chain;
    });
  }

  function resumeChatImageGeneration(chatId) {
    if (!isGlobalEnabled()) return Promise.resolve();
    var st = getStore();
    if (!st || typeof st.getMessages !== 'function') return Promise.resolve();
    var chat = st.findChat(chatId);
    if (!chat || chat.type === 'group') return Promise.resolve();
    var msgs = st.getMessages(chatId) || [];
    var pending = [];
    var stuckPending = [];
    msgs.forEach(function (m) {
      if (!m || m.role !== 'assistant' || m.imageDataKey) return;
      if (m.imageGenFailed) return;
      if (m.imageGenPending) {
        stuckPending.push(m);
        return;
      }
      if (canGenerateChatMessage(chatId, m)) pending.push(m);
    });
    if (!pending.length && !stuckPending.length) return Promise.resolve();
    var chain = Promise.resolve();
    pending.forEach(function (m) {
      chain = chain.then(function () {
        return markChatMessagePending(chatId, m.id).then(function () {
          return processChatMessage(chatId, m);
        });
      });
    });
    stuckPending.forEach(function (m) {
      chain = chain.then(function () {
        delete inFlight[chatId + ':' + m.id];
        return processChatMessage(chatId, m);
      });
    });
    return chain;
  }

  function updateMomentPostMedia(postId, mutator) {
    if (!global.MiyaChatMoments || typeof global.MiyaChatMoments.mutatePostMedia !== 'function') {
      return Promise.reject(new Error('moments_missing'));
    }
    return global.MiyaChatMoments.mutatePostMedia(postId, mutator);
  }

  function refreshMomentFeed(postId) {
    if (global.MiyaChatMoments && typeof global.MiyaChatMoments.refreshFeedUI === 'function') {
      global.MiyaChatMoments.refreshFeedUI({ postId: postId, mediaChanged: true });
    }
  }

  function momentMediaKey(postId, idx) {
    return 'mom:' + postId + ':' + idx;
  }

  function markMomentMediaPending(postId, idx) {
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx].imageGenPending = true;
      p.media[idx].imageGenFailed = false;
    }).then(function () {
      refreshMomentFeed(postId);
    });
  }

  function markMomentMediaFailed(postId, idx) {
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx].imageGenPending = false;
      p.media[idx].imageGenFailed = true;
    }).then(function () {
      refreshMomentFeed(postId);
    });
  }

  function finalizeMomentMedia(postId, idx, blobId, blob, desc) {
    var summary = trim(desc);
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx] = {
        kind: 'real-image',
        imageKey: blobId,
        mime: blob.type || 'image/png',
        sourceDesc: summary,
        visionSummary: summary
      };
    }).then(function () {
      refreshMomentFeed(postId);
    });
  }

  function shouldProcessMomentMediaItem(m) {
    return !!(m && m.kind === 'text-image' && trim(m.textImageDesc) && !m.imageGenFailed);
  }

  function processMomentMediaItem(postId, contactId, idx, desc) {
    var key = momentMediaKey(postId, idx);
    if (inFlight[key]) return inFlight[key];
    inFlight[key] = markMomentMediaPending(postId, idx)
      .then(function () {
        return generateImageForScene(contactId, desc);
      })
      .then(function (blob) {
        return storeImageBlob(blob).then(function (blobId) {
          if (!blobId) throw new Error('store_failed');
          return finalizeMomentMedia(postId, idx, blobId, blob, desc);
        });
      })
      .catch(function (err) {
        toast(formatImageGenError(err));
        return markMomentMediaFailed(postId, idx).then(function () { return false; });
      })
      .then(function (result) {
        delete inFlight[key];
        return result !== false;
      });
    return inFlight[key];
  }

  function processMomentTextImages(postId, contactId) {
    if (!isContactEnabled(contactId)) return Promise.resolve(false);
    var postKey = 'mom:' + postId;
    if (inFlight[postKey]) return inFlight[postKey];
    inFlight[postKey] = updateMomentPostMedia(postId, function () {})
      .then(function (post) {
        if (!post || !Array.isArray(post.media)) return false;
        var tasks = [];
        post.media.forEach(function (m, idx) {
          if (!shouldProcessMomentMediaItem(m)) return;
          tasks.push(processMomentMediaItem(postId, contactId, idx, trim(m.textImageDesc)));
        });
        if (!tasks.length) return false;
        return Promise.all(tasks).then(function () { return true; });
      })
      .catch(function () {
        return false;
      })
      .then(function (result) {
        delete inFlight[postKey];
        return result;
      });
    return inFlight[postKey];
  }

  function retryMomentMediaItem(postId, mediaIdx) {
    var idx = parseInt(mediaIdx, 10);
    if (!postId || !Number.isFinite(idx) || idx < 0) return Promise.resolve(false);
    var post = global.MiyaChatMoments && typeof global.MiyaChatMoments.findPost === 'function'
      ? global.MiyaChatMoments.findPost(postId)
      : null;
    if (!post || post.authorType !== 'role') return Promise.resolve(false);
    var contactId = String(post.authorId || '').trim();
    if (!contactId || !isContactEnabled(contactId)) return Promise.resolve(false);
    var m = post.media && post.media[idx];
    if (!m || m.kind !== 'text-image' || !trim(m.textImageDesc)) return Promise.resolve(false);
    var desc = trim(m.textImageDesc);
    delete inFlight[momentMediaKey(postId, idx)];
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx].imageGenFailed = false;
      p.media[idx].imageGenPending = false;
    }).then(function () {
      return processMomentMediaItem(postId, contactId, idx, desc);
    });
  }

  function resumeMomentsImageGeneration() {
    if (!isGlobalEnabled()) return Promise.resolve();
    if (!global.MiyaChatMoments || typeof global.MiyaChatMoments.whenReady !== 'function') {
      return Promise.resolve();
    }
    return global.MiyaChatMoments.whenReady().then(function () {
      var posts = typeof global.MiyaChatMoments.getPosts === 'function'
        ? global.MiyaChatMoments.getPosts()
        : [];
      var chain = Promise.resolve();
      posts.forEach(function (post) {
        if (!post || post.authorType !== 'role') return;
        var contactId = String(post.authorId || '').trim();
        if (!contactId || !isContactEnabled(contactId)) return;
        if (!Array.isArray(post.media)) return;
        var needs = post.media.some(function (m) { return shouldProcessMomentMediaItem(m); });
        if (!needs) return;
        chain = chain.then(function () {
          return processMomentTextImages(post.id, contactId);
        });
      });
      return chain;
    });
  }

  function runTestGeneration(previewEl, btnEl) {
    if (!previewEl) return Promise.resolve();
    var cfg = getImageGenConfig();
    var testPrompt = trim(cfg.positivePrompt) || 'a serene landscape, soft morning light, cinematic';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '生成中…';
    }
    previewEl.innerHTML = '<div class="miya-ig-test miya-ig-test--busy"><span class="miya-ig-test__spin"></span><p>生成中…</p></div>';
    return generateImageForScene('', testPrompt, { skipContactCheck: true, referenceDataUrl: '' })
      .then(function (blob) {
        return blobToDataUrl(blob).then(function (url) {
          previewEl.innerHTML = '<div class="miya-ig-test miya-ig-test--done"><img src="' + esc(url) + '" alt="测试生图"></div>';
        });
      })
      .catch(function (err) {
        previewEl.innerHTML = '<div class="miya-ig-test miya-ig-test--err"><p>' + esc(formatImageGenError(err)) + '</p></div>';
      })
      .then(function () {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.textContent = '测试生图';
        }
      });
  }

  /* 自由生图：不绑定联系人，直接按用户输入的画面描述出图。
     复用 generateImageForScene('', prompt, { skipContactCheck: true })，
     提示词仍会带上全局正向/反向提示词与画质标签。 */
  var freeGenState = { blob: null, prompt: '', busy: false };

  function renderFreePreview(html) {
    var el = document.getElementById('miya-st-ig-free-preview');
    if (el) el.innerHTML = html;
  }

  function renderFreeIdle() {
    renderFreePreview('<div class="miya-ig-test miya-ig-test--idle"><p>输入描述后点击「生成图片」</p></div>');
  }

  function getFreePrompt() {
    var el = document.getElementById('miya-st-ig-free-prompt');
    return el ? trim(el.value) : '';
  }

  function getFreeSize() {
    var el = document.getElementById('miya-st-ig-free-size');
    var v = el ? trim(el.value) : '';
    return v || getImageGenConfig().size;
  }

  function setFreeBusy(busy) {
    freeGenState.busy = !!busy;
    var run = document.getElementById('miya-st-ig-free-run');
    if (run) {
      run.disabled = !!busy;
      run.textContent = busy ? '生成中…' : '生成图片';
    }
    var save = document.getElementById('miya-st-ig-free-save');
    if (save) save.disabled = !!busy;
  }

  function runFreeGeneration() {
    if (freeGenState.busy) return Promise.resolve(false);
    var el = document.getElementById('miya-st-ig-free-preview');
    if (!el) return Promise.resolve(false);
    var prompt = getFreePrompt();
    if (!prompt) {
      toast('请先输入画面描述');
      return Promise.resolve(false);
    }
    setFreeBusy(true);
    freeGenState.blob = null;
    renderFreePreview('<div class="miya-ig-test miya-ig-test--busy"><span class="miya-ig-test__spin"></span><p>生成中…</p></div>');
    return generateImageForScene('', prompt, {
      skipContactCheck: true,
      referenceDataUrl: '',
      size: getFreeSize()
    })
      .then(function (blob) {
        return blobToDataUrl(blob).then(function (url) {
          freeGenState.blob = blob;
          freeGenState.prompt = prompt;
          renderFreePreview('<div class="miya-ig-test miya-ig-test--done">' +
            '<img src="' + esc(url) + '" alt="自由生图">' +
            '<p class="miya-ig-free-caption">' + esc(prompt) + '</p>' +
            /*
             * 给移动端留一句「长按可存」的提示。
             * 桌面端下载按钮直接可用，这句显示出来也无害；
             * 但在 iOS 上它往往是唯一真正能存进照片的办法
             * （Safari 对 <a download> 支持残缺，分享面板是主路径，
             *  而分享面板被取消时用户还能靠长按兜底）。
             */
            '<p class="miya-ig-free-hint">点击「保存到本地」下载，手机端也可长按图片保存</p>' +
          '</div>');
          return true;
        });
      })
      .catch(function (err) {
        renderFreePreview('<div class="miya-ig-test miya-ig-test--err"><p>' + esc(formatImageGenError(err)) + '</p></div>');
        return false;
      })
      .then(function (ok) {
        setFreeBusy(false);
        return ok;
      });
  }

  /*
   * ── 自由生图结果的去向：下载到本地 ──────────────────────────────
   *
   * 用户报的：「生图功能生成出来的图片不能保存到本地啊？
   *            只能在聊天功能的我的相册找到」。
   *
   * 原先这里只有 saveFreeGenerationToAlbum() —— 它把 blob 交给
   * MiyaChatAlbum.addPhotos() 塞进 App 内的相册，仅此一条路。
   * 相册是「App 内素材库」，供后续在聊天里当素材引用；
   * 可用户要的往往是「把这张图拿到手机/电脑上去」—— 这两件事不一样，
   * 而当时**根本没有**第二条路，所以图怎么都出不了 App。
   *
   * 现在改成直接下载到设备，复用已有的 miyaDownloadBlobAsync ——
   * 它内部已经处理好了几个平台坑，不该在这里重造一遍：
   *   · iOS 上优先走 navigator.share（Safari 对 <a download> 支持残缺，
   *     直接 click 常常毫无反应，只有分享面板能真正存进照片）
   *   · 大文件（≥24MB）避开 new File 的内存拷贝
   *   · 兜底还有 Service Worker 拉流那条路
   */
  function downloadFreeGeneration() {
    if (!freeGenState.blob) {
      toast('请先生成一张图片');
      return Promise.resolve(false);
    }
    var blob = freeGenState.blob;
    /*
     * 文件名带上画面描述的前几个字，比一律 free-gen-<时间戳>.png 好认 ——
     * 连着生成好几张时，下载目录里能一眼看出哪张是什么。
     */
    var name = buildFreeGenFileName(freeGenState.prompt, blob);
    var dl = global.miyaDownloadBlobAsync;
    if (typeof dl !== 'function') {
      /* 兜底：miya-storage.js 没加载时自己拼一个 <a download>，聊胜于无 */
      try {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          try { document.body.removeChild(a); } catch (e0) {}
          URL.revokeObjectURL(url);
        }, 2000);
        toast('已保存到下载目录');
        return Promise.resolve(true);
      } catch (e) {
        toast('保存失败，可长按图片另存');
        return Promise.resolve(false);
      }
    }
    return dl(blob, name).then(function (ok) {
      /*
       * ok=false 有两种含义，提示语要分开，不能混成一句：
       *   · 用户在系统分享面板上点了取消 —— 说明「我不要了」，
       *     不该说成失败；
       *   · 分享不可用或出错 —— 这时要告诉他还能怎么补救。
       */
      if (ok) toast('已保存，可在系统面板里选「保存到相册」');
      else toast('没保存成功，可在系统面板里选「保存到相册」再试');
      return !!ok;
    }).catch(function () {
      toast('保存失败，可长按图片另存');
      return Promise.resolve(false);
    });
  }

  /**
   * 由画面描述推一个可读的文件名。
   *
   * 只取描述开头的若干字符，并且把文件系统不友好的字符换掉 ——
   * 描述里常有「，」「。」「/」这类标点和换行，
   * 原样丢进 <a download> 有些浏览器会直接拒收整个文件名。
   */
  function buildFreeGenFileName(prompt, blob) {
    var ext = '.png';
    var type = String((blob && blob.type) || '');
    if (/jpe?g/i.test(type)) ext = '.jpg';
    else if (/webp/i.test(type)) ext = '.webp';
    var slug = String(prompt || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      /*
       * 截断到 12 个字符。
       *
       * 曾经取 24 —— 但中文描述一个字就是一个字符，24 个字加上时间戳
       * 会让文件名接近 50 字符，在下载列表里被截断、也难扫读。
       * 12 个字足够认出「这张画的是什么」，又不至于喧宾夺主。
       */
      .slice(0, 12)
      .trim();
    /* 截断可能在标点处留下尾缀，去掉结尾的逗号/顿号一类字符 */
    slug = slug.replace(/[，,。.、；;：:！!？?\-—\s]+$/, '').trim();
    if (!slug) slug = 'miya-free-gen';
    return slug + '-' + Date.now() + ext;
  }

  /* 老名字保留为别名：外部（含测试与其它模块）可能仍在引用它 */
  function saveFreeGenerationToAlbum() {
    return downloadFreeGeneration();
  }

  function syncFreeSizeOptions(provider, keepValue) {
    var sel = document.getElementById('miya-st-ig-free-size');
    if (!sel) return;
    fillSizeSelect(sel, provider, keepValue);
  }

  function resetFreeGenPreview() {
    freeGenState.blob = null;
    freeGenState.prompt = '';
    renderFreeIdle();
  }

  async function loadPresetsArr() {
    var raw = [];
    if (typeof global.miyaReadLsJsonKey === 'function') {
      var v = await global.miyaReadLsJsonKey(PRESETS_KEY, []);
      raw = Array.isArray(v) ? v : [];
    } else {
      try {
        var stored = localStorage.getItem(PRESETS_KEY);
        raw = stored ? JSON.parse(stored) : [];
      } catch (e) {
        raw = [];
      }
    }
    return raw.map(normalizePresetRow).filter(Boolean);
  }

  async function savePresetsArr(arr) {
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return !!(await global.miyaWriteLsJsonKey(PRESETS_KEY, arr));
    }
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      return false;
    }
  }

  function commitPresetsCache(list) {
    presetsCache = Array.isArray(list) ? list.slice() : [];
    renderPresetOptions(presetsCache);
    return presetsCache;
  }

  function ensurePresetsReady() {
    if (presetsCache != null) {
      renderPresetOptions(presetsCache);
      return Promise.resolve(presetsCache);
    }
    if (presetsReady) return presetsReady;
    presetsReady = loadPresetsArr().then(function (list) {
      return commitPresetsCache(list);
    }).catch(function () {
      return commitPresetsCache([]);
    });
    return presetsReady;
  }

  function normalizePresetRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = trim(raw.name);
    if (!name) return null;
    return {
      name: name,
      config: normalizeImageGenConfig(raw.config),
      savedAt: raw.savedAt || Date.now()
    };
  }

  function findPresetByName(list, name) {
    var label = trim(name);
    if (!label) return null;
    return (list || []).filter(function (x) { return x && x.name === label; })[0] || null;
  }

  function renderPresetOptions(list) {
    var pick = document.getElementById('miya-st-ig-preset-pick');
    if (!pick) return;
    var names = (list || []).map(function (p) { return p && p.name ? String(p.name) : ''; }).filter(Boolean);
    var namesKey = names.join('\0');
    if (pick.dataset.presetNames === namesKey) return;
    var current = pick.value;
    pick.innerHTML = '<option value="">选择已存预设</option>';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      pick.appendChild(opt);
    });
    if (current && names.indexOf(current) >= 0) pick.value = current;
    pick.dataset.presetNames = namesKey;
  }

  function syncPresetNameInput(name) {
    var nameInput = document.getElementById('miya-st-ig-preset-name');
    if (nameInput && name != null) nameInput.value = String(name);
  }

  function applyImageGenPreset(preset) {
    if (!preset || !preset.config) return false;
    saveImageGenConfig(preset.config);
    syncSettingsFormFromConfig();
    syncPresetNameInput(preset.name);
    return true;
  }

  function loadPresetByName(name) {
    var pickName = trim(name);
    if (!pickName) {
      toast('请先选择或输入预设名称');
      return Promise.resolve(false);
    }
    return ensurePresetsReady().then(function (list) {
      var pr = findPresetByName(list, pickName);
      if (!pr) {
        toast('未找到该预设');
        return false;
      }
      applyImageGenPreset(pr);
      var pick = document.getElementById('miya-st-ig-preset-pick');
      if (pick) pick.value = pickName;
      if (global.miyaSettingsApp && typeof global.miyaSettingsApp.markIgPresetActive === 'function') {
        global.miyaSettingsApp.markIgPresetActive(pickName);
      }
      toast('已读取「' + pickName + '」');
      return true;
    });
  }

  function savePresetByName(name) {
    var label = trim(name);
    if (!label) {
      toast('请输入预设名称');
      return Promise.resolve(false);
    }
    var snap = readSettingsForm();
    return ensurePresetsReady().then(function (list) {
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      if (next.length >= MAX_PRESETS && !findPresetByName(list, label)) {
        toast('预设最多 ' + MAX_PRESETS + ' 个');
        return false;
      }
      var row = normalizePresetRow({ name: label, config: snap, savedAt: Date.now() });
      if (!row) return false;
      next.push(row);
      return savePresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitPresetsCache(result);
      var pick = document.getElementById('miya-st-ig-preset-pick');
      if (pick) pick.value = label;
      syncPresetNameInput(label);
      toast('预设已保存');
      return true;
    }).catch(function () {
      toast('预设保存失败');
      return false;
    });
  }

  function deletePresetByName(name) {
    var label = trim(name);
    if (!label) {
      toast('请先选择要删除的预设');
      return Promise.resolve(false);
    }
    return ensurePresetsReady().then(function (list) {
      if (!findPresetByName(list, label)) {
        toast('预设不存在');
        return false;
      }
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      return savePresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitPresetsCache(result);
      var pick = document.getElementById('miya-st-ig-preset-pick');
      if (pick && pick.value === label) pick.value = '';
      toast('预设已删除');
      return true;
    }).catch(function () {
      toast('预设删除失败');
      return false;
    });
  }

  /* ─── OpenAI 兼容接口预设（独立存储，只存网关/密钥/模型） ───
     与上面的「生图预设」互不影响：那个存整套生图配置，这个只存接口三元组，
     方便在多个中转/供应商之间快速切换，交互对齐「对话 API」面板。 */
  var OA_PRESETS_KEY = 'miya-image-gen-oa-presets-v1';
  var MAX_OA_PRESETS = 24;
  var oaPresetsCache = null;
  var oaPresetsReady = null;

  async function loadOaPresetsArr() {
    if (typeof global.miyaReadLsJsonKey === 'function') {
      var v = await global.miyaReadLsJsonKey(OA_PRESETS_KEY, []);
      return Array.isArray(v) ? v : [];
    }
    try {
      var raw = JSON.parse(localStorage.getItem(OA_PRESETS_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  async function saveOaPresetsArr(arr) {
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return !!(await global.miyaWriteLsJsonKey(OA_PRESETS_KEY, arr));
    }
    try {
      localStorage.setItem(OA_PRESETS_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      return false;
    }
  }

  function readOaForm() {
    function val(id) {
      var el = document.getElementById(id);
      return el ? trim(el.value) : '';
    }
    return {
      baseUrl: val('miya-st-ig-oa-base'),
      apiKey: val('miya-st-ig-oa-key'),
      model: val('miya-st-ig-oa-model')
    };
  }

  function commitOaPresetsCache(list) {
    oaPresetsCache = Array.isArray(list) ? list.slice() : [];
    renderOaPresetOptions(oaPresetsCache);
    return oaPresetsCache;
  }

  function ensureOaPresetsReady() {
    if (oaPresetsCache != null) {
      renderOaPresetOptions(oaPresetsCache);
      return Promise.resolve(oaPresetsCache);
    }
    if (oaPresetsReady) return oaPresetsReady;
    oaPresetsReady = loadOaPresetsArr().then(function (list) {
      return commitOaPresetsCache(list);
    }).catch(function () {
      return commitOaPresetsCache([]);
    });
    return oaPresetsReady;
  }

  function renderOaPresetOptions(list) {
    var pick = document.getElementById('miya-st-ig-oa-preset-pick');
    if (!pick) return;
    var names = (list || []).map(function (p) { return p && p.name ? String(p.name) : ''; }).filter(Boolean);
    var namesKey = names.join('\0');
    if (pick.dataset.presetNames === namesKey) return;
    var current = pick.value;
    pick.innerHTML = '<option value="">选择已存预设</option>';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      pick.appendChild(opt);
    });
    if (current && names.indexOf(current) >= 0) pick.value = current;
    pick.dataset.presetNames = namesKey;
  }

  function findOaPresetByName(list, name) {
    var label = trim(name);
    if (!label) return null;
    return (list || []).filter(function (x) { return x && x.name === label; })[0] || null;
  }

  function saveOaPreset() {
    var nameEl = document.getElementById('miya-st-ig-oa-preset-name');
    var label = nameEl ? trim(nameEl.value) : '';
    if (!label) {
      toast('请输入预设名称');
      return Promise.resolve(false);
    }
    var snap = readOaForm();
    if (!snap.baseUrl && !snap.apiKey && !snap.model) {
      toast('请先填写接口信息');
      return Promise.resolve(false);
    }
    /* 注意：exists 必须在两个 then 都能访问到的外层作用域声明。
       之前它写在第一个 then 的回调里，第二个 then 里引用会抛 ReferenceError，
       被下面的 catch 捕获后统一报「保存失败」——数据其实已写入，
       表现为「提示失败但列表里确实多了这条预设」。 */
    var existedBefore = false;
    return ensureOaPresetsReady().then(function (list) {
      existedBefore = !!findOaPresetByName(list, label);
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      if (!existedBefore && next.length >= MAX_OA_PRESETS) {
        toast('接口预设最多 ' + MAX_OA_PRESETS + ' 个');
        return false;
      }
      next.push({ name: label, openai: snap, savedAt: Date.now() });
      return saveOaPresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitOaPresetsCache(result);
      var pick = document.getElementById('miya-st-ig-oa-preset-pick');
      if (pick) pick.value = label;
      toast(existedBefore ? '接口预设已覆盖' : '接口预设已保存');
      return true;
    }).catch(function () {
      toast('接口预设保存失败');
      return false;
    });
  }

  function applyOaPresetRow(row) {
    if (!row || !row.openai) return;
    var oa = row.openai;
    function set(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v == null ? '' : String(v);
    }
    set('miya-st-ig-oa-base', oa.baseUrl);
    set('miya-st-ig-oa-key', oa.apiKey);
    // 模型可能不在当前下拉里（预设存的是文本），补一项再选中，避免静默回退
    var modelSel = document.getElementById('miya-st-ig-oa-model');
    var model = trim(oa.model);
    if (modelSel && model) {
      var has = Array.prototype.some.call(modelSel.options, function (o) { return o.value === model; });
      if (!has) {
        var opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        modelSel.appendChild(opt);
      }
      modelSel.value = model;
    }
    var nameEl = document.getElementById('miya-st-ig-oa-preset-name');
    if (nameEl) nameEl.value = row.name || '';
  }

  function loadOaPreset() {
    var pick = document.getElementById('miya-st-ig-oa-preset-pick');
    var label = pick ? trim(pick.value) : '';
    if (!label) {
      toast('请先选择要载入的预设');
      return Promise.resolve(false);
    }
    return ensureOaPresetsReady().then(function (list) {
      var row = findOaPresetByName(list, label);
      if (!row) {
        toast('预设不存在');
        return false;
      }
      applyOaPresetRow(row);
      toast('已载入「' + label + '」');
      return true;
    }).catch(function () {
      toast('预设载入失败');
      return false;
    });
  }

  function deleteOaPreset() {
    var pick = document.getElementById('miya-st-ig-oa-preset-pick');
    var label = pick ? trim(pick.value) : '';
    if (!label) {
      toast('请先选择要删除的预设');
      return Promise.resolve(false);
    }
    return ensureOaPresetsReady().then(function (list) {
      if (!findOaPresetByName(list, label)) {
        toast('预设不存在');
        return false;
      }
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      return saveOaPresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitOaPresetsCache(result);
      var pick2 = document.getElementById('miya-st-ig-oa-preset-pick');
      if (pick2 && pick2.value === label) pick2.value = '';
      toast('接口预设已删除');
      return true;
    }).catch(function () {
      toast('接口预设删除失败');
      return false;
    });
  }

  function readSettingsForm() {
    function val(id) {
      var el = document.getElementById(id);
      return el ? trim(el.value) : '';
    }
    function toggleOn(id) {
      var el = document.getElementById(id);
      return el ? el.classList.contains('is-on') : false;
    }
    var providerEl = document.querySelector('input[name="miya-st-ig-provider"]:checked');
    var provider = providerEl && providerEl.value === 'novelai' ? 'novelai' : 'openai';
    var steps = parseInt(val('miya-st-ig-na-steps'), 10);
    var scale = parseFloat(val('miya-st-ig-na-scale'));
    return {
      enabled: toggleOn('miya-st-ig-enabled'),
      provider: provider,
      positivePrompt: val('miya-st-ig-pos'),
      negativePrompt: val('miya-st-ig-neg'),
      size: val('miya-st-ig-size') || '1024x1024',
      openai: {
        baseUrl: val('miya-st-ig-oa-base'),
        apiKey: val('miya-st-ig-oa-key'),
        model: val('miya-st-ig-oa-model')
      },
      novelai: {
        baseUrl: val('miya-st-ig-na-base') || 'https://image.novelai.net',
        apiKey: val('miya-st-ig-na-key'),
        model: val('miya-st-ig-na-model'),
        sampler: val('miya-st-ig-na-sampler'),
        steps: Number.isFinite(steps) ? steps : 28,
        scale: Number.isFinite(scale) ? scale : 5,
        sm: toggleOn('miya-st-ig-na-sm'),
        smDyn: toggleOn('miya-st-ig-na-smdyn')
      }
    };
  }

  function fillModelSelect(sel, ids, keepValue) {
    if (!sel) return;
    var cur = trim(keepValue != null ? keepValue : sel.value);
    var list = (ids || []).map(function (id) { return trim(id); }).filter(Boolean);
    var idsKey = list.join('\0');
    if (sel.dataset.modelIds === idsKey && (!cur || sel.value === cur)) return;
    sel.innerHTML = '<option value="">选择模型</option>';
    list.forEach(function (id) {
      var op = document.createElement('option');
      op.value = id;
      op.textContent = id;
      sel.appendChild(op);
    });
    if (cur && list.indexOf(cur) >= 0) sel.value = cur;
    else if (cur) {
      var o = document.createElement('option');
      o.value = cur;
      o.textContent = cur;
      sel.appendChild(o);
      sel.value = cur;
      idsKey = idsKey + (idsKey ? '\0' : '') + cur;
    }
    sel.dataset.modelIds = idsKey;
  }

  function fillSizeSelect(sel, provider, keepValue) {
    if (!sel) return;
    var cur = trim(keepValue || sel.value) || '1024x1024';
    sel.innerHTML = '';
    var sizes = provider === 'novelai' ? NOVELAI_SIZES : OPENAI_SIZES;
    sizes.forEach(function (item) {
      var op = document.createElement('option');
      op.value = item.v;
      op.textContent = item.label || item.v;
      sel.appendChild(op);
    });
    /* 已存尺寸不在当前供应商的预设列表里（例如换过接口、或手填过自定义尺寸）时，
       不能悄悄回退到第一项——那会让下拉框显示的尺寸和实际请求用的尺寸对不上。
       改为把该尺寸补成一项并选中，保证「所见即所用」。 */
    if (!sizes.some(function (x) { return x.v === cur; })) {
      var custom = document.createElement('option');
      custom.value = cur;
      custom.textContent = cur;
      sel.appendChild(custom);
    }
    sel.value = cur;
  }

  function syncProviderPanels(provider) {
    var oa = document.getElementById('miya-st-ig-openai-block');
    var na = document.getElementById('miya-st-ig-novelai-block');
    if (oa) oa.hidden = provider !== 'openai';
    if (na) na.hidden = provider !== 'novelai';
    fillSizeSelect(document.getElementById('miya-st-ig-size'), provider);
    syncFreeSizeOptions(provider);
    var contactsBlock = document.getElementById('miya-st-ig-contacts-block');
    if (contactsBlock) contactsBlock.hidden = !isFormEnabled();
  }

  function syncSettingsFormFromConfig() {
    var cfg = getImageGenConfig();
    function setVal(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v == null ? '' : String(v);
    }
    function setToggle(id, on) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('is-on', !!on);
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    setToggle('miya-st-ig-enabled', cfg.enabled);
    var providerRadio = document.querySelector('input[name="miya-st-ig-provider"][value="' + cfg.provider + '"]');
    if (providerRadio) providerRadio.checked = true;
    setVal('miya-st-ig-pos', cfg.positivePrompt);
    setVal('miya-st-ig-neg', cfg.negativePrompt);
    setVal('miya-st-ig-oa-base', cfg.openai.baseUrl);
    setVal('miya-st-ig-oa-key', cfg.openai.apiKey);
    fillModelSelect(document.getElementById('miya-st-ig-oa-model'), cfg.openai.model ? [cfg.openai.model] : [], cfg.openai.model);
    setVal('miya-st-ig-na-base', cfg.novelai.baseUrl);
    setVal('miya-st-ig-na-key', cfg.novelai.apiKey);
    setVal('miya-st-ig-na-steps', cfg.novelai.steps);
    setVal('miya-st-ig-na-scale', cfg.novelai.scale);
    setToggle('miya-st-ig-na-sm', cfg.novelai.sm);
    setToggle('miya-st-ig-na-smdyn', cfg.novelai.smDyn);
    fillModelSelect(document.getElementById('miya-st-ig-na-model'), NOVELAI_MODELS, cfg.novelai.model);
    var samplerSel = document.getElementById('miya-st-ig-na-sampler');
    if (samplerSel && !samplerSel.options.length) {
      NOVELAI_SAMPLERS.forEach(function (s) {
        var op = document.createElement('option');
        op.value = s;
        op.textContent = s;
        samplerSel.appendChild(op);
      });
    }
    if (samplerSel) samplerSel.value = cfg.novelai.sampler || NOVELAI_SAMPLERS[0];
    fillSizeSelect(document.getElementById('miya-st-ig-size'), cfg.provider, cfg.size);
    syncFreeSizeOptions(cfg.provider, cfg.size);
    syncProviderPanels(cfg.provider);
    syncContactsBlockVisibility();
    renderContactToggleList();
  }

  function isFormEnabled() {
    var el = document.getElementById('miya-st-ig-enabled');
    return el ? el.classList.contains('is-on') : false;
  }

  function syncContactsBlockVisibility() {
    var block = document.getElementById('miya-st-ig-contacts-block');
    if (block) block.hidden = !isFormEnabled();
  }

  function renderContactToggleList() {
    var box = document.getElementById('miya-st-ig-contacts-list');
    if (!box) return;
    syncContactsBlockVisibility();
    if (!isFormEnabled()) {
      box.innerHTML = '<p class="st-form-hint">请先启用生图接口</p>';
      return;
    }
    var st = getStore();
    if (!st || typeof st.getContacts !== 'function') {
      box.innerHTML = '<p class="st-form-hint">联系人未就绪</p>';
      return;
    }
    var contacts = st.getContacts().filter(function (c) { return c && !c.deleted; });
    if (!contacts.length) {
      box.innerHTML = '<p class="st-form-hint">暂无联系人</p>';
      return;
    }
    box.innerHTML = contacts.map(function (c) {
      var ig = getContactImageGenSettings(c.id);
      var name = esc(c.remarkName || c.name || c.id);
      return '<div class="st-toggle-in-form miya-ig-contact-row" data-ig-contact-id="' + esc(c.id) + '">' +
        '<div class="st-toggle-in-form__text"><strong>' + name + '</strong></div>' +
        '<button type="button" class="ins-toggle' + (ig.enabled ? ' is-on' : '') +
        '" data-ig-contact-toggle role="switch" aria-checked="' + (ig.enabled ? 'true' : 'false') + '"></button>' +
      '</div>';
    }).join('');
  }

  function saveContactImageGenEnabled(contactId, enabled) {
    var st = getStore();
    if (!st) return Promise.resolve();
    var chat = findChatByContactId(contactId);
    if (!chat) return Promise.resolve();
    var cur = getContactImageGenSettings(contactId);
    return st.saveChatSettings(chat.id, {
      imageGen: Object.assign({}, cur, { enabled: !!enabled })
    });
  }

  function bindSettingsPanelEvents() {
    if (bindSettingsPanelEvents._done) return;
    bindSettingsPanelEvents._done = true;
    var root = document.getElementById('miya-st-panel-imagegen');
    if (!root) return;

    root.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('#miya-st-ig-enabled')) {
        var btn = t.closest('#miya-st-ig-enabled');
        var on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        syncContactsBlockVisibility();
        renderContactToggleList();
        return;
      }
      if (t.closest('#miya-st-ig-na-sm')) {
        var sm = t.closest('#miya-st-ig-na-sm');
        var smOn = !sm.classList.contains('is-on');
        sm.classList.toggle('is-on', smOn);
        sm.setAttribute('aria-checked', smOn ? 'true' : 'false');
        return;
      }
      if (t.closest('#miya-st-ig-na-smdyn')) {
        var sd = t.closest('#miya-st-ig-na-smdyn');
        var sdOn = !sd.classList.contains('is-on');
        sd.classList.toggle('is-on', sdOn);
        sd.setAttribute('aria-checked', sdOn ? 'true' : 'false');
        return;
      }
      if (t.closest('[data-ig-contact-toggle]')) {
        var sw = t.closest('[data-ig-contact-toggle]');
        var row = sw.closest('[data-ig-contact-id]');
        if (!row) return;
        var cid = row.getAttribute('data-ig-contact-id');
        var on2 = !sw.classList.contains('is-on');
        sw.classList.toggle('is-on', on2);
        sw.setAttribute('aria-checked', on2 ? 'true' : 'false');
        saveContactImageGenEnabled(cid, on2).then(function () {
          toast(on2 ? '已为此联系人开启生图' : '已关闭此联系人生图');
        });
        return;
      }
      if (t.closest('#miya-st-ig-oa-fetch')) {
        var b = trim((document.getElementById('miya-st-ig-oa-base') || {}).value);
        var k = trim((document.getElementById('miya-st-ig-oa-key') || {}).value);
        if (!b || !k) { toast('请填写 OpenAI 网关与密钥'); return; }
        fetchOpenAiModels(b, k).then(function (ids) {
          fillModelSelect(document.getElementById('miya-st-ig-oa-model'), ids,
            (document.getElementById('miya-st-ig-oa-model') || {}).value);
          toast('已载入 ' + ids.length + ' 个模型');
        }).catch(function () { toast('拉取模型失败'); });
        return;
      }
      if (t.closest('#miya-st-ig-save')) {
        var next = readSettingsForm();
        saveImageGenConfig(next);
        syncProviderPanels(next.provider);
        renderContactToggleList();
        toast('生图配置已保存');
        return;
      }
      if (t.closest('#miya-st-ig-preset-save')) {
        var saveName = trim((document.getElementById('miya-st-ig-preset-name') || {}).value);
        savePresetByName(saveName);
        return;
      }
      if (t.closest('#miya-st-ig-preset-load')) {
        var loadPick = document.getElementById('miya-st-ig-preset-pick');
        var loadName = trim((loadPick && loadPick.value) || (document.getElementById('miya-st-ig-preset-name') || {}).value);
        loadPresetByName(loadName);
        return;
      }
      if (t.closest('#miya-st-ig-preset-delete')) {
        var delPick = document.getElementById('miya-st-ig-preset-pick');
        var delName = trim((delPick && delPick.value) || (document.getElementById('miya-st-ig-preset-name') || {}).value);
        if (!delName) {
          toast('请先选择要删除的预设');
          return;
        }
        var confirmFn = global.miyaDialog && global.miyaDialog.confirm
          ? global.miyaDialog.confirm.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(confirm(o.message || '确定？')); };
        confirmFn({
          title: '删除预设',
          message: '确定删除「' + delName + '」？',
          confirmText: '删除',
          cancelText: '取消'
        }).then(function (ok) {
          if (!ok) return;
          return deletePresetByName(delName);
        });
        return;
      }
      if (t.closest('#miya-st-ig-test')) {
        runTestGeneration(
          document.getElementById('miya-st-ig-test-preview'),
          document.getElementById('miya-st-ig-test')
        );
        return;
      }
      if (t.closest('#miya-st-ig-free-run')) {
        runFreeGeneration();
        return;
      }
      if (t.closest('#miya-st-ig-free-save')) {
        downloadFreeGeneration();
        return;
      }
      if (t.closest('#miya-st-ig-oa-preset-save')) {
        saveOaPreset();
        return;
      }
      if (t.closest('#miya-st-ig-oa-preset-delete')) {
        deleteOaPreset();
        return;
      }
      if (t.closest('#miya-st-ig-oa-preset-pick')) {
        loadOaPreset();
        return;
      }
    });

    root.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'miya-st-ig-provider') {
        syncProviderPanels(e.target.value === 'novelai' ? 'novelai' : 'openai');
      }
      if (e.target && e.target.id === 'miya-st-ig-preset-pick') {
        var pickName = trim(e.target.value);
        syncPresetNameInput(pickName);
        if (!pickName) return;
        loadPresetByName(pickName);
      }
    });
  }

  function onSettingsPanelOpen() {
    bindSettingsPanelEvents();
    ensurePresetsReady();
    ensureOaPresetsReady();
    syncSettingsFormFromConfig();
    /* 上次会话残留的结果图没有对应的内存 blob（刷新后必然拿不到），
       留着会让人以为「点了保存却没反应」，所以每次进面板都清回待输入状态。 */
    resetFreeGenPreview();
    setFreeBusy(false);
  }

  global.MiyaImageGen = {
    PRESETS_KEY: PRESETS_KEY,
    REF_LEGAL_NOTE: REF_LEGAL_NOTE,
    NOVELAI_MODELS: NOVELAI_MODELS,
    defaultImageGenConfig: defaultImageGenConfig,
    normalizeImageGenConfig: normalizeImageGenConfig,
    normalizeContactImageGen: normalizeContactImageGen,
    getImageGenConfig: getImageGenConfig,
    saveImageGenConfig: saveImageGenConfig,
    isGlobalEnabled: isGlobalEnabled,
    isContactEnabled: isContactEnabled,
    getContactImageGenSettings: getContactImageGenSettings,
    buildPromptBundle: buildPromptBundle,
    generateImageForScene: generateImageForScene,
    fetchOpenAiModels: fetchOpenAiModels,
    processChatMessage: processChatMessage,
    processAssistantMessages: processAssistantMessages,
    resumeChatImageGeneration: resumeChatImageGeneration,
    retryChatMessage: retryChatMessage,
    shouldAutoGenerateChatMessage: shouldAutoGenerateChatMessage,
    processMomentTextImages: processMomentTextImages,
    retryMomentMediaItem: retryMomentMediaItem,
    resumeMomentsImageGeneration: resumeMomentsImageGeneration,
    resolveReferenceDataUrl: resolveReferenceDataUrl,
    runTestGeneration: runTestGeneration,
    runFreeGeneration: runFreeGeneration,
    downloadFreeGeneration: downloadFreeGeneration,
    saveFreeGenerationToAlbum: saveFreeGenerationToAlbum,
    resetFreeGenPreview: resetFreeGenPreview,
    saveOaPreset: saveOaPreset,
    loadOaPreset: loadOaPreset,
    deleteOaPreset: deleteOaPreset,
    onSettingsPanelOpen: onSettingsPanelOpen,
    syncSettingsFormFromConfig: syncSettingsFormFromConfig,
    ensurePresetsReady: ensurePresetsReady,
    loadPresetByName: loadPresetByName,
    savePresetByName: savePresetByName,
    deletePresetByName: deletePresetByName,
    invalidatePresetsCache: function () {
      presetsCache = null;
      presetsReady = null;
    },
    /*
     * 测试专用后门：把一张现成的图直接摆成「刚刚生成完」的状态。
     *
     * 为什么需要它：真实生图请求的返回格式因服务商而异
     * （b64_json / url / 各种中转站的变体），要写一套稳定的 mock 成本很高，
     * 而这里真正要验证的是**保存链路**，不是生图链路 ——
     * 把生图那一段换成一根桩，测试才盯得住该盯的东西。
     */
    __testSetFreeBlob: function (blob, prompt) {
      freeGenState.blob = blob || null;
      freeGenState.prompt = String(prompt || '');
      return !!freeGenState.blob;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
