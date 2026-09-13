/**
 * miya-cache-probe.js — 提示缓存探针
 *
 * 解决什么问题
 * ------------
 * 提示缓存（prompt cache）命中与否，直接决定 API 账单：
 * 命中部分通常只按 10% 计价，未命中则全价。而缓存能不能命中，
 * 只取决于一件事——**本轮请求的前缀，是否与上一轮逐字节相同**。
 *
 * 只要 system 提示或历史里混进一处「每轮都变」的内容（时间戳、
 * 随机数、每次重排的世界书条目、刚改过的 always 记忆……），
 * 整段缓存就会重建，费用悄悄翻好几倍，而且**服务商不会告警**。
 *
 * 这个模块做两件事
 * ----------------
 * 1) 本地前缀比对（不依赖服务商返回字段，最可靠）：
 *    每轮请求发出前，把 messages 拼成一个规范化字符串，与上轮
 *    同一配置的字符串逐字符比对，记录「从第几个字符开始不同」。
 *    若变化点落在「最新一条消息」之前，说明前缀被污染了。
 * 2) 解析服务商返回的缓存用量字段（有则更好）：
 *    兼容 OpenAI / DeepSeek / Gemini / Anthropic 各家命名。
 *
 * 设计原则：只做观测，绝不改变请求内容；任何异常都静默降级。
 */
(function (global) {
  'use strict';

  var LS_KEY = 'miya-cache-probe';
  var MAX_ROUNDS = 40;      /* 最多留档多少轮 */
  var MAX_PREFIX_LEN = 400000; /* 前缀比对长度上限，防止超长会话拖慢 */

  /* 每家服务商对「缓存命中 token」的叫法都不一样，逐个认。 */
  var CACHE_READ_KEYS = [
    'prompt_cache_hit_tokens',                    /* DeepSeek */
    'cache_read_input_tokens',                    /* Anthropic 风格 */
    'cached_tokens',                              /* OpenAI: prompt_tokens_details.cached_tokens */
    'cachedContentTokenCount',                    /* Gemini 风格（usageMetadata） */
    'prompt_tokens_cached',
    'cache_hit_tokens'
  ];
  var CACHE_WRITE_KEYS = [
    'prompt_cache_miss_tokens',                   /* DeepSeek */
    'cache_creation_input_tokens',                /* Anthropic */
    'cache_write_tokens'
  ];

  /* 上一轮的前缀快照，按配置 id 分开存（多 API 端口互不干扰） */
  var lastByKey = Object.create(null);

  /* 探针自身出错的计数。原先异常被静默吞掉，report 会显示「一切正常」，
     把「探针坏了」伪装成「缓存健康」。这里留个脚印，让报告能说实话。 */
  var probeErrors = 0;
  var lastProbeError = '';

  function probeOn() {
    try {
      var v = localStorage.getItem('miyaCacheProbeOff');
      return v !== '1';
    } catch (e) {
      return true;
    }
  }

  function safeParse(s, fb) {
    try { return JSON.parse(s); } catch (e) { return fb; }
  }

  /* ── 前缀规范化：把 messages 拆成「逐条指纹」──
     为什么要逐条而不是拼成一个长字符串？
     因为拼串后只能靠「第一个不同字符的偏移」判断，而偏移会撒谎：
     若在历史中间插入一条，而插入点恰好落在上一轮最后一条消息起点之后，
     偏移判定就会误报「命中」。逐条比对则不会——能精确定位到是第几条变了。

     关键：指纹里不能带时间戳/随机数，否则每轮都不同，比对失去意义。
     所以只取 role 与内容本体。 */
  var SEP_ROLE = '\u0002';
  var SEP_BODY = '\u0003';

  /* 图片取「内容指纹」而非整串 base64：既能把图片变化纳入比对，
     又不会因为一张图几 MB 而撑爆 local 比对与 store 的内存。
     同一张图重发时 url 完全一致，指纹稳定；换图则必然不同。 */
  function hash64(s) {
    /* FNV-1a 变体，64 位拆两段 32 位做十六进制。纯用于缩短长串，不做安全用途。 */
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charCodeAt(i);
      h1 ^= ch; h1 = (h1 * 0x01000193) >>> 0;
      h2 = (h2 + ch) >>> 0; h2 = (h2 * 0x85ebca6b) >>> 0;
    }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  /* 超过这个长度的碎片才做哈希；短文本保留原文，便于报错时肉眼核对 */
  var HASH_THRESHOLD = 256;

  function shortenForFingerprint(s) {
    if (s.length <= HASH_THRESHOLD) return s;
    return '#len' + s.length + '#' + hash64(s);
  }

  function messageFingerprint(m) {
    var msg = m || {};
    var role = String(msg.role || '');
    var c = msg.content;
    var body;
    if (typeof c === 'string') {
      body = shortenForFingerprint(c);
    } else if (Array.isArray(c)) {
      /* 多模态：文本进指纹；图片/音视频取内容指纹。
         同时保留片段类型与顺序，避免把不同结构压成同一个串
         （例如 Anthropic 的 cache_control 断点位置变化）。 */
      var segs = [];
      for (var j = 0; j < c.length; j++) {
        var p = c[j] || {};
        var t = String(p.type || '');
        if (t === 'text' && p.text != null) {
          segs.push('t:' + shortenForFingerprint(String(p.text)));
        } else if (t === 'image_url' || t === 'image') {
          var url = '';
          if (p.image_url) url = typeof p.image_url === 'string' ? p.image_url : String(p.image_url.url || '');
          else if (p.source) url = String(p.source.data || p.source.url || p.source.media_type || '');
          segs.push('i:' + shortenForFingerprint(url));
        } else if (t) {
          /* 其余片段类型（音频、文档、工具调用等）只记类型与内容长度，
             保证「出现/消失/换序」能被察觉，又不把大对象塞进比对。 */
          var raw = p.text != null ? String(p.text) : JSON.stringify(p);
          segs.push(t + ':' + (raw ? raw.length : 0));
        }
      }
      body = segs.join('\u0001');
    } else if (c && typeof c === 'object') {
      /* 少数接口把 content 直接给成对象 */
      body = shortenForFingerprint(JSON.stringify(c));
    } else {
      body = c == null ? '' : String(c);
    }
    return SEP_ROLE + role + SEP_BODY + body;
  }

  function normalizeMessages(messages) {
    var arr = Array.isArray(messages) ? messages : [];
    var fps = [];
    var total = 0;
    for (var i = 0; i < arr.length; i++) {
      var fp = messageFingerprint(arr[i]);
      fps.push(fp);
      total += fp.length;
      if (total > MAX_PREFIX_LEN) break; /* 超长会话只比前段，够用了 */
    }
    return { fingerprints: fps, total: total, count: fps.length };
  }

  function firstDiff(a, b) {
    var n = Math.min(a.length, b.length);
    var i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  /**
   * 逐条比对两轮的消息指纹，找出第一处差异。
   *
   * 返回结构：
   *   sameCount   —— 从头开始有多少条完全一致
   *   reason      —— 差异性质：append（尾部追加）/ modified（改了某条）
   *                  / inserted（中间插入）/ removed（中间删除）/ unknown
   *   ok          —— 是否「只发生了尾部追加等正常演进」（缓存可命中）
   *
   * 判定命中（ok=true）的条件：
   *   两条消息列表从第 0 条起逐条一致，且本轮只是「在末尾追加了新消息」。
   *   也就是 prev 的全部指纹，按原顺序、原内容，原样出现在本轮的前缀里。
   *   只要中间被插入/删除/修改过，就判为未命中。
   */
  function compareRounds(prevFps, curFps) {
    var same = 0;
    var n = Math.min(prevFps.length, curFps.length);
    while (same < n && prevFps[same] === curFps[same]) same++;

    /* 从头到 same 一致。接下来看差异性质。 */
    var histUnchanged = same >= n ? true : (same >= prevFps.length - 1 ? true : false);

    var reason;
    var ok;

    if (same === prevFps.length && curFps.length === prevFps.length) {
      /* 完全相同（重发同一请求） */
      reason = 'identical';
      ok = true;
    } else if (same === prevFps.length && curFps.length > prevFps.length) {
      /* 上一轮的所有消息原样保留，本轮只是尾部多了几条 → 正常演进 */
      reason = 'append';
      ok = true;
    } else if (same === prevFps.length && curFps.length < prevFps.length) {
      /* 尾部截断（如上下文裁剪掉最后几条）→ 前缀仍完整，缓存通常仍有效 */
      reason = 'truncate_tail';
      ok = true;
    } else if (same < prevFps.length && (same >= curFps.length)) {
      /* 本轮消息在 same 处已经用尽，而上一轮还有剩余
         —— 本轮序列是上一轮序列的「真前缀」，多出来的消息全在尾部被裁掉。
         前缀缓存依然完整有效，不应判为未命中。
         （修复：此分支原先会落到下面的 curFps[same] 取到 undefined 并抛异常，
           异常被外层 catch 吞掉后返回 null，本轮诊断完全丢失且不留痕。） */
      reason = 'truncate_tail';
      ok = true;
    } else if (same < prevFps.length) {
      /* 在相同的部分之后，上一轮还有消息，本轮也还有 —— 说明中间出现了
         修改 / 插入 / 删除。历史被动了，缓存作废。
         判定顺序很重要：
           先查「上一轮这条在本轮是否被往后挤了」→ 插入；
           再查「本轮这条在上一轮是否本就在更后面」→ 删除；
           都不是，而角色又相同 → 内容被改写。
         不能先比角色就下结论：在两条 assistant 之间插入一条 assistant 时，
         同位置角色恰好相同，会被误判成「改写」。
         当前 user 永远是最后一条，插入基本都发生在它之前，所以往前找必能命中。 */
      var prevRest = prevFps[same];
      var curRest = curFps[same];
      /* 双保险：即便上面的分支将来被改动，也不能让这里再取到 undefined。 */
      if (prevRest == null || curRest == null) {
        return {
          ok: false,
          reason: 'unknown',
          sameCount: same,
          prevCount: prevFps.length,
          curCount: curFps.length,
          approxDiffAt: (function () {
            var acc = 0;
            for (var k = 0; k < same && k < prevFps.length; k++) acc += prevFps[k].length;
            return acc;
          })()
        };
      }
      var prevRoleEnd = prevRest.indexOf(SEP_BODY);
      var curRoleEnd = curRest.indexOf(SEP_BODY);
      var prevRole = prevRoleEnd >= 0 ? prevRest.slice(0, prevRoleEnd) : prevRest;
      var curRole = curRoleEnd >= 0 ? curRest.slice(0, curRoleEnd) : curRest;
      var inCur = curFps.indexOf(prevRest, same);
      var inPrev = prevFps.indexOf(curRest, same);
      if (inCur > same) {
        /* 上一轮的第 same 条，在本轮被往后推了 → 中间插入了新内容 */
        reason = 'inserted';
      } else if (inPrev > same) {
        /* 本轮的第 same 条，在上一轮位于更后面 → 中间有内容被删除 */
        reason = 'removed';
      } else if (prevRole === curRole) {
        reason = 'modified';
      } else {
        reason = 'unknown';
      }
      ok = false;
    } else {
      reason = 'unknown';
      ok = false;
    }

    return {
      ok: ok,
      reason: reason,
      sameCount: same,
      prevCount: prevFps.length,
      curCount: curFps.length,
      /* 为兼容旧的字符口径，附一个近似偏移（仅用于展示） */
      approxDiffAt: (function () {
        var acc = 0;
        for (var k = 0; k < same && k < prevFps.length; k++) acc += prevFps[k].length;
        return acc;
      })()
    };
  }

  /**
   * 记录一次请求的消息序列，并与上一轮比对。
   * @returns {object|null} 本轮诊断结果（首轮无基线时返回 first）
   */
  function trackRequest(cfg, messages) {
    if (!probeOn()) return null;
    try {
      var snap = normalizeMessages(messages);
      var key = String((cfg && (cfg.id || cfg._id)) || (cfg && cfg.model) || '__default__');
      var prev = lastByKey[key];
      lastByKey[key] = { fingerprints: snap.fingerprints, total: snap.total };

      if (!prev) {
        pushRound({
          at: Date.now(),
          key: key,
          first: true,
          ok: true,
          reason: 'baseline',
          sameCount: snap.count,
          prevCount: snap.count,
          curCount: snap.count,
          total: snap.total
        });
        return {
          first: true, ok: true, reason: 'baseline',
          sameCount: snap.count, prevCount: snap.count, curCount: snap.count,
          total: snap.total
        };
      }

      var cmp = compareRounds(prev.fingerprints, snap.fingerprints);
      cmp.first = false;
      cmp.total = snap.total;
      cmp.lenDelta = snap.total - prev.total;
      pushRound({
        at: Date.now(),
        key: key,
        first: false,
        ok: cmp.ok,
        reason: cmp.reason,
        sameCount: cmp.sameCount,
        prevCount: cmp.prevCount,
        curCount: cmp.curCount,
        total: snap.total,
        lenDelta: cmp.lenDelta
      });
      return cmp;
    } catch (e) {
      probeErrors++;
      lastProbeError = String((e && e.message) || e);
      return null;
    }
  }

  /**
   * 从响应里解析缓存相关用量。兼容各家字段命名。
   * @returns {object|null} { read, write, prompt, completion, total, raw }
   */
  function parseCacheUsage(data) {
    try {
      if (!data || typeof data !== 'object') return null;
      var u = data.usage || data.usageMetadata ||
        (data.choices && data.choices[0] && data.choices[0].usage) || null;
      if (!u || typeof u !== 'object') return null;

      function pick(obj, keys) {
        for (var i = 0; i < keys.length; i++) {
          var v = obj[keys[i]];
          if (v != null && Number.isFinite(Number(v))) return Number(v);
        }
        return null;
      }
      /* OpenAI 把缓存读放在嵌套的 prompt_tokens_details 里 */
      var details = u.prompt_tokens_details || u.promptTokensDetails || null;
      var read = pick(u, CACHE_READ_KEYS);
      if (read == null && details) read = pick(details, CACHE_READ_KEYS);
      /* Gemini 的 usageMetadata 有时嵌一层 */
      if (read == null && u.usageMetadata) {
        read = pick(u.usageMetadata, CACHE_READ_KEYS);
        if (read == null && u.usageMetadata.promptTokensDetails) {
          read = pick(u.usageMetadata.promptTokensDetails, CACHE_READ_KEYS);
        }
      }
      var write = pick(u, CACHE_WRITE_KEYS);
      if (write == null && details) write = pick(details, CACHE_WRITE_KEYS);

      var prompt = u.prompt_tokens != null ? Number(u.prompt_tokens)
        : u.input_tokens != null ? Number(u.input_tokens)
          : u.promptTokenCount != null ? Number(u.promptTokenCount) : null;
      var completion = u.completion_tokens != null ? Number(u.completion_tokens)
        : u.output_tokens != null ? Number(u.output_tokens)
          : u.candidatesTokenCount != null ? Number(u.candidatesTokenCount) : null;
      var total = u.total_tokens != null ? Number(u.total_tokens)
        : u.totalTokenCount != null ? Number(u.totalTokenCount) : null;

      if (read == null && write == null && prompt == null && completion == null && total == null) {
        return null;
      }
      return {
        read: read == null ? 0 : read,
        write: write == null ? 0 : write,
        prompt: prompt,
        completion: completion,
        total: total,
        hasCacheField: read != null || write != null
      };
    } catch (e) {
      return null;
    }
  }

  /* ── 留档 ── */
  function loadRounds() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var arr = safeParse(raw, []);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  /* 留档失败是「降级」不是「故障」，不应该弹窗打断聊天；
     但也绝不能悄无声息——否则探针自己写不进去，报告却显示「缓存健康」，
     又把「探针坏了」伪装成「一切正常」。所以打进控制台，并记进 probeErrors。 */
  function recordWriteFailure(where, err) {
    probeErrors += 1;
    lastProbeError = '留档写入失败(' + where + '): ' + ((err && err.name) || 'unknown');
    try { console.warn('[miya-cache-probe] ' + lastProbeError); } catch (e) {}
  }

  function pushRound(row) {
    var arr = loadRounds();
    arr.push(row);
    if (arr.length > MAX_ROUNDS) arr = arr.slice(arr.length - MAX_ROUNDS);
    var str = '';
    try { str = JSON.stringify(arr); } catch (eStr) { recordWriteFailure('pushRound', eStr); return; }
    try {
      localStorage.setItem(LS_KEY, str);
    } catch (e) { recordWriteFailure('pushRound', e); }
  }

  /** 把某轮的缓存用量补记到最近的留档上（响应回来时调用） */
  function attachUsage(usage) {
    if (!probeOn() || !usage) return;
    var arr = loadRounds();
    if (!arr.length) return;
    var last = arr[arr.length - 1];
    last.usage = usage;
    var str = '';
    try { str = JSON.stringify(arr); } catch (eStr) { recordWriteFailure('attachUsage', eStr); return; }
    try {
      localStorage.setItem(LS_KEY, str);
    } catch (e) { recordWriteFailure('attachUsage', e); }
  }

  /**
   * 汇总最近若干轮，给出「缓存健康度」判断。
   * @returns {object} { rounds, hits, misses, hitRate, issues, ... }
   */
  function summarize(limit) {
    var n = Number(limit) || 10;
    var arr = loadRounds().filter(function (r) { return r && !r.first; });
    var recent = arr.slice(-n);
    var hits = 0, misses = 0;
    recent.forEach(function (r) { if (r.ok) hits++; else misses++; });

    /* 未命中时按差异性质给出可操作的解释 */
    var issues = [];
    recent.forEach(function (r) {
      if (r.ok) return;
      var hint;
      switch (r.reason) {
        case 'modified':
          hint = '有历史消息被改写（第 ' + (r.sameCount + 1) + ' 条起）——检查记忆注入、时间线、' +
            '旁白文案是否每轮重新生成，这类内容必须放在历史之后、不能混进历史';
          break;
        case 'inserted':
          hint = '历史中间被插入了新消息（第 ' + (r.sameCount + 1) + ' 条位置）——' +
            '多半是「记忆/世界书/摘要」被插在了对话中间，应统一挪到 system 或末尾';
          break;
        case 'removed':
          hint = '历史中间有消息被删除（第 ' + (r.sameCount + 1) + ' 条位置）——' +
            '检查上下文裁剪逻辑是否从中间截断，应只裁最早的';
          break;
        default:
          hint = '消息序列结构发生变化（第 ' + (r.sameCount + 1) + ' 条起）——' +
            '需逐条核对该位置前后的注入内容';
      }
      issues.push({
        at: r.at,
        reason: r.reason,
        sameCount: r.sameCount,
        prevCount: r.prevCount,
        curCount: r.curCount,
        hint: hint
      });
    });

    /* 缓存读数汇总（服务商有返回时） */
    var withUsage = recent.filter(function (r) { return r.usage && r.usage.hasCacheField; });
    var readSum = 0, promptSum = 0;
    withUsage.forEach(function (r) {
      readSum += Number(r.usage.read) || 0;
      promptSum += Number(r.usage.prompt) || 0;
    });

    return {
      rounds: recent.length,
      hits: hits,
      misses: misses,
      hitRate: recent.length ? Math.round((hits / recent.length) * 100) : 0,
      issues: issues,
      hasUsageData: withUsage.length > 0,
      cacheReadTokens: readSum,
      promptTokens: promptSum,
      usageSamples: withUsage.length,
      /* 探针自身出错次数：>0 时上面的命中率不可信 */
      probeErrors: probeErrors,
      lastProbeError: lastProbeError,
      /* 留档被 MAX_ROUNDS 截断过，说明统计窗口不完整 */
      windowCapped: loadRounds().length >= MAX_ROUNDS,
      raw: recent
    };
  }

  function clear() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    lastByKey = Object.create(null);
  }

  /* 供调试查看：返回多行文本摘要 */
  function report(limit) {
    var s = summarize(limit);
    if (!s.rounds) {
      return '还没有足够的记录。给任一位角色连发两条消息后再来看。\n' +
        '（探针需要至少两轮才能比对。）';
    }
    var lines = [];
    lines.push('最近 ' + s.rounds + ' 轮：命中 ' + s.hits + ' 次，未命中 ' + s.misses +
      ' 次（命中率 ' + s.hitRate + '%）');
    if (s.probeErrors) {
      lines.push('⚠ 探针自身出错 ' + s.probeErrors + ' 次（最近一次：' + s.lastProbeError + '）——');
      lines.push('  受影响的轮次未计入统计，上面的命中率偏低，请先排查探针。');
    }
    if (s.windowCapped) {
      lines.push('注：留档已达上限（' + MAX_ROUNDS + ' 轮），更早的轮次已被丢弃，命中率只反映最近窗口。');
    }
    if (s.hasUsageData) {
      lines.push('服务商返回的缓存读 token 合计 ' + s.cacheReadTokens +
        '，输入 token 合计 ' + s.promptTokens);
    } else {
      lines.push('（服务商未返回缓存字段，以下结论仅依据本地比对）');
    }
    lines.push('');
    if (!s.issues.length) {
      lines.push('✓ 消息序列稳定，最近这些轮都能命中缓存。');
    } else {
      lines.push('✗ 有 ' + s.issues.length + ' 轮缓存失效：');
      s.issues.slice(-5).forEach(function (it) {
        var t = new Date(it.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        var label = {
          modified: '历史被改写',
          inserted: '中间插入',
          removed: '中间删除',
          unknown: '结构变化'
        }[it.reason] || '结构变化';
        lines.push('  · ' + t + ' ' + label +
          '（第 ' + (it.sameCount + 1) + ' 条起，上一轮共 ' + it.prevCount + ' 条）');
        lines.push('    ' + it.hint);
      });
      lines.push('');
      lines.push('说明：版本更新、改人设、动世界书开关、always 记忆改动之后的第一轮');
      lines.push('出现未命中是正常的；连续多轮未命中才说明有问题。');
    }
    return lines.join('\n');
  }

  global.miyaCacheProbe = {
    trackRequest: trackRequest,
    parseCacheUsage: parseCacheUsage,
    attachUsage: attachUsage,
    summarize: summarize,
    report: report,
    clear: clear,
    loadRounds: loadRounds
  };
})(typeof window !== 'undefined' ? window : self);
