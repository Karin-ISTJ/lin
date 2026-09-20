/**
 * Miya · 世界书 ST 对齐层
 * - 词条字段兼容 SillyTavern World Info / Lorebook
 * - 扫描触发（constant / key / keysecondary / selectiveLogic）
 * - 注入排序 + token 预算
 * - 导入/导出 ST JSON（entries 为对象或数组）
 *
 * ── 来源声明 ────────────────────────────────────────────────
 * 本文件为**独立实现**：为了能读写 SillyTavern 的 World Info /
 * Lorebook 数据格式而自行编写，**未复制、未改编 SillyTavern 源代码**，
 * 也未依赖其任何模块。
 *
 * 其中与 ST 取值一致的常量（如 selectiveLogic 的 0/1/2/3、
 * position 的 0–4）属于**数据格式约定** —— 要正确解析 ST 导出的
 * JSON 就必须认这些数值，等同于「读一个文件要知道它的文件头格式」，
 * 不构成对 ST 代码的衍生。判断逻辑、匹配算法、注入排序、
 * 位置分桶（front/middle/back）等均为本项目自研。
 * ────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  var SELECTIVE_AND_ANY = 0;
  var SELECTIVE_NOT_ALL = 1;
  var SELECTIVE_NOT_ANY = 2;
  var SELECTIVE_AND_ALL = 3;

  /** ST position → Miya depth 桶 */
  function positionToDepth(position) {
    var p = Number(position);
    if (!Number.isFinite(p)) return 'middle';
    // 0 before char, 1 after char, 2 before AN, 3 after AN, 4 @depth in-chat
    if (p === 0 || p === 2) return 'front';
    if (p === 4) return 'back';
    return 'middle';
  }

  function depthToPosition(depth) {
    var d = String(depth || 'middle');
    if (d === 'front') return 0;
    if (d === 'back') return 4;
    return 1;
  }

  function asStringArray(raw) {
    if (Array.isArray(raw)) {
      return raw.map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
    }
    if (raw == null || raw === '') return [];
    if (typeof raw === 'string') {
      return raw.split(/[,，、;；\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return [String(raw).trim()].filter(Boolean);
  }

  /*
   * Token 估算统一走 MiyaToken（js2/miya-token.js）单一来源。
   *
   * 本文件原来内联了一份 cjk/1.8 + rest/4 的公式，与
   * js2/miya-memory-table-engine.js 里的那份逐字相同（复制粘贴产物），
   * 而 js1/miya-chat-engine.js 又是第三套口径（length / 1.6），
   * 同一段文本两边能差 150%。现在三处收敛到同一实现。
   *
   * 保留 estimateTokens 这个名字：本模块对外导出它，调用方按旧名取用。
   * 兜底：万一 MiyaToken 尚未加载，退回等价的内联实现，行为完全一致。
   */
  function estimateTokens(text) {
    var t = global.MiyaToken;
    if (t && typeof t.fromText === 'function') return t.fromText(text);
    var s = String(text || '');
    if (!s) return 0;
    var cjk = (s.match(/[\u3400-\u9fff]/g) || []).join('').length;
    var rest = s.length - cjk;
    return Math.max(1, Math.ceil(cjk / 1.8 + rest / 4));
  }

  function clampInt(v, min, max, fallback) {
    var n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }

  /**
   * 将任意原始对象规范为 Miya 词条（含 ST 字段）
   */
  function normalizeStFields(raw, base) {
    base = base && typeof base === 'object' ? base : {};
    var key = asStringArray(raw.key != null ? raw.key : raw.keys != null ? raw.keys : raw.keywords);
    var keysecondary = asStringArray(
      raw.keysecondary != null ? raw.keysecondary : raw.secondary_keys != null ? raw.secondary_keys : raw.keySecondary
    );
    var constant = !!(raw.constant === true || raw.alwaysActive === true);
    var selective = raw.selective === true || (keysecondary.length > 0 && raw.selective !== false);
    var selectiveLogic = clampInt(
      raw.selectiveLogic != null ? raw.selectiveLogic : raw.selective_logic,
      0,
      3,
      SELECTIVE_AND_ANY
    );
    var order = Number(raw.order != null ? raw.order : raw.insertion_order);
    if (!Number.isFinite(order)) order = 100;
    var position = Number(raw.position);
    if (!Number.isFinite(position) && raw.extensions && Number.isFinite(Number(raw.extensions.position))) {
      position = Number(raw.extensions.position);
    }
    if (!Number.isFinite(position)) {
      position = depthToPosition(base.depth || raw.depth);
    }
    /*
     * injection_depth = 「@深度」条目插进聊天历史的第几条。取值优先级：
     *
     *   1) raw.injection_depth —— 用户在 UI「深度」输入框里**显式填写**的值
     *   2) raw.depth（仅 position=4） —— 纯 ST JSON 导入的入口
     *   3) raw.extensions.depth —— 部分 ST 卡片的嵌套写法
     *
     * ⚠️ 1 必须排在 2 前面。旧实现把 2 放在最前，导致 position=4 时
     * 永远优先取 raw.depth；而 UI 提交的 raw.depth 是 app.js 用 position
     * 推导出来的**字符串**（"back"），clampInt("back") 得到非数字，
     * 于是兜底成默认值 4 —— 用户填的深度被静默覆盖，
     * 表现是「深度输入框填什么都是 4」，且不报错、无提示。
     *
     * 保留分支 2 是因为 ST 格式里 depth 本身就是数值、且没有
     * injection_depth 字段，那条路径必须继续可用。
     */
    var injectionDepth = clampInt(
      raw.injection_depth != null
        ? raw.injection_depth
        : raw.depth != null && Number(raw.position) === 4
          ? raw.depth
          : raw.extensions && raw.extensions.depth,
      0,
      1000,
      4
    );
    var scanDepth = raw.scanDepth != null ? raw.scanDepth : raw.scan_depth;
    if (scanDepth === '' || scanDepth === undefined) scanDepth = null;
    else scanDepth = clampInt(scanDepth, 0, 1000, null);

    var probability = clampInt(raw.probability, 0, 100, 100);
    var useProbability = raw.useProbability === true || raw.use_probability === true;
    var ignoreBudget = raw.ignoreBudget === true || raw.ignore_budget === true;
    /*
     * ⚠️ 这里必须显式 !! 归一化成布尔。
     * 旧写法是 `a === true || b === true || (raw.extensions && raw.extensions.x === true)`，
     * 当 raw.extensions 不存在时，最后一项求出的是 **undefined**（不是 false），
     * 于是整个字段变成 undefined。后果是 JSON 里该键被丢掉、
     * UI 的 checked 属性拿到 undefined、导出 ST 世界书时字段凭空消失。
     */
    var excludeRecursion = !!(
      raw.excludeRecursion === true ||
      raw.exclude_recursion === true ||
      (raw.extensions && raw.extensions.exclude_recursion === true)
    );
    var preventRecursion = !!(
      raw.preventRecursion === true ||
      raw.prevent_recursion === true ||
      (raw.extensions && raw.extensions.prevent_recursion === true)
    );
    var caseSensitive = raw.caseSensitive === true || raw.match_case === true;
    var matchWholeWords = raw.matchWholeWords === true || raw.match_whole_words === true;
    var disabled = raw.disable === true || raw.enabled === false || raw.disabled === true;
    var comment = String(raw.comment != null ? raw.comment : raw.name || base.name || '').trim();
    var content = String(raw.content != null ? raw.content : base.content || '');
    var uid = raw.uid != null ? raw.uid : raw.id;
    var sticky = clampInt(raw.sticky, 0, 9999, 0);
    var cooldown = clampInt(raw.cooldown, 0, 9999, 0);
    var delay = clampInt(raw.delay, 0, 9999, 0);
    var group = String(
      raw.group != null
        ? raw.group
        : raw.extensions && raw.extensions.group != null
          ? raw.extensions.group
          : ''
    ).trim();
    var groupWeight = clampInt(
      raw.groupWeight != null
        ? raw.groupWeight
        : raw.extensions && raw.extensions.group_weight,
      1,
      10000,
      100
    );
    var groupOverride = !!(
      raw.groupOverride === true ||
      raw.group_override === true ||
      (raw.extensions && raw.extensions.group_override === true)
    );
    var useGroupScoring = !!(
      raw.useGroupScoring === true ||
      (raw.extensions && raw.extensions.use_group_scoring === true)
    );

    var depth = base.depth;
    if (!depth) depth = positionToDepth(position);

    return {
      // ST 对齐字段
      key: key,
      keysecondary: keysecondary,
      keywords: key.length ? key : asStringArray(base.keywords),
      constant: constant,
      selective: selective,
      selectiveLogic: selectiveLogic,
      order: order,
      position: position,
      injection_depth: injectionDepth,
      scanDepth: scanDepth,
      probability: probability,
      useProbability: useProbability,
      ignoreBudget: ignoreBudget,
      excludeRecursion: excludeRecursion,
      preventRecursion: preventRecursion,
      caseSensitive: caseSensitive,
      matchWholeWords: matchWholeWords,
      sticky: sticky,
      cooldown: cooldown,
      delay: delay,
      group: group,
      groupWeight: groupWeight,
      groupOverride: groupOverride,
      useGroupScoring: useGroupScoring,
      uid: uid,
      comment: comment,
      // 与 Miya 共用
      name: comment || String(base.name || '未命名片段'),
      content: content,
      depth: depth,
      enabled: !disabled
    };
  }

  function keywordMatches(haystack, keyword, opts) {
    opts = opts || {};
    var h = String(haystack || '');
    var k = String(keyword || '');
    if (!k) return false;
    if (!opts.caseSensitive) {
      h = h.toLowerCase();
      k = k.toLowerCase();
    }
    // 简单正则：/pattern/flags
    var m = k.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
      try {
        return new RegExp(m[1], m[2] || (opts.caseSensitive ? '' : 'i')).test(String(haystack || ''));
      } catch (e) {
        return false;
      }
    }
    if (opts.matchWholeWords) {
      /*
       * 全词匹配 =「关键词两侧不能紧邻同为"词字符"的字符」。
       *
       * ⚠️ 中文必须单独走一条路。
       * `\b` 和 `\w` 都只认 ASCII，中文在它们眼里**全是非词字符** ——
       * 也就是说对中文做全词匹配等于要求「龙」两侧必须是非中文，
       * 而「一条龙服务」两侧都是中文 → 永远不命中。
       * 实测：旧实现下 一条龙服务/我是龙/龙的传人/龙飞凤舞 全部返回 false，
       * 用户一旦勾上「全词匹配」，所有中文关键词就**静默失效**。
       *
       * 中文没有词边界的概念（分词需要词典），所以对 CJK 关键词的合理语义是：
       * 退化为「包含匹配」，与未开启时一致 —— 宁可放宽，也不要让功能哑掉。
       */
      if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(k)) {
        return h.indexOf(k) >= 0;
      }
      var esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp('(?:^|[^\\w])' + esc + '(?:$|[^\\w])', opts.caseSensitive ? '' : 'i');
      return re.test(String(haystack || ''));
    }
    return h.indexOf(k) >= 0;
  }

  function anyKeyMatch(text, keys, opts) {
    if (!keys || !keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (keywordMatches(text, keys[i], opts)) return true;
    }
    return false;
  }

  function allKeysMatch(text, keys, opts) {
    if (!keys || !keys.length) return true;
    for (var i = 0; i < keys.length; i++) {
      if (!keywordMatches(text, keys[i], opts)) return false;
    }
    return true;
  }

  function secondaryOk(text, entry, opts) {
    var sec = entry.keysecondary || [];
    if (!entry.selective || !sec.length) return true;
    var logic = Number(entry.selectiveLogic) || 0;
    if (logic === SELECTIVE_AND_ANY) return anyKeyMatch(text, sec, opts);
    if (logic === SELECTIVE_AND_ALL) return allKeysMatch(text, sec, opts);
    if (logic === SELECTIVE_NOT_ANY) return !anyKeyMatch(text, sec, opts);
    if (logic === SELECTIVE_NOT_ALL) return !allKeysMatch(text, sec, opts);
    return anyKeyMatch(text, sec, opts);
  }

  /**
   * 构造用于关键词扫描的文本。
   *
   * ST 语义里 scanDepth 是「扫描最近 N 条消息」。本项目有两条来源：
   *  1) messages 数组存在 —— 按 ST 原意取末尾 N 条；
   *  2) 只有 contextText —— 这是把历史按行拼成的长字符串。历史上这里直接返回
   *     全文，导致 scanDepth 完全失效，且角色自己过去的发言也会触发词条
   *     （「AI 说了句话，就把对应词条激活了」）。现在按行截取末尾 N 行近似 ST 行为。
   */
  function buildScanText(input) {
    if (input.scanText) return String(input.scanText);
    var msgs = Array.isArray(input.messages) ? input.messages : [];
    var depth = input.scanDepth != null ? clampInt(input.scanDepth, 0, 1000, 50) : 50;
    if (msgs.length) {
      var slice = msgs.slice(-Math.max(0, depth));
      return slice
        .map(function (m) {
          if (typeof m === 'string') return m;
          return String((m && (m.content || m.text)) || '');
        })
        .join('\n');
    }
    var ctx = String(input.contextText || '');
    if (!ctx) return '';
    /* contextText 是逐行拼接的上下文：按行取末尾 depth 行，使 scanDepth 真正生效，
       避免整段历史（含角色自己的历史发言）无差别参与关键词扫描。 */
    if (ctx.indexOf('\n') < 0) return ctx;
    var lines = ctx.split('\n');
    if (lines.length <= depth) return ctx;
    return lines.slice(-Math.max(1, depth)).join('\n');
  }

  /**
   * ST 风格激活
   * @returns {{ activated: object[], deferred: object[], debug: object }}
   *
   * ⚠️ input.skipProbability —— 概率由谁负责，必须二选一，否则会掷骰两次。
   *
   * 真实调用链（见 miya-worldbook-prompt.js）是两段式的：
   *   ① matcher.matchEntry  → 本函数（只验证「关键词是否命中」）
   *   ② applyStDecoration   → 概率掷骰 + 分组互斥 + token 预算
   * 两处都带 probability 判定时，同一条词条会被裁决两次，
   * 实际生效概率从 p 变成 **p²**（设 50% → 真实 25%；设 10% → 真实 1%）。
   * 用户感知是「这个概率开关时灵时不灵」，且不会报错，极难排查。
   *
   * 所以约定：**准入阶段不掷骰**。matcher 那一路必须传 skipProbability:true，
   * 概率统一交给 applyStDecoration 掷一次。
   * 保留本函数自身的概率能力，是因为 runPipeline（应用内的调试/预览路径）
   * 直接调它、后面没有 applyStDecoration，那条路需要概率照常生效。
   */
  function activateEntries(entries, input) {
    input = input || {};
    var skipProbability = input.skipProbability === true;
    var list = Array.isArray(entries) ? entries : [];
    var globalScanDepth = input.scanDepth != null ? clampInt(input.scanDepth, 0, 1000, 50) : 50;
    var scanText = buildScanText({
      contextText: input.contextText,
      messages: input.messages,
      scanDepth: globalScanDepth,
      scanText: input.scanText
    });
    var activated = [];
    var deferred = [];
    var debug = { scanTextLength: scanText.length, checked: 0, constant: 0, keyed: 0, rejected: 0 };

    list.forEach(function (entry) {
      if (!entry || entry.enabled === false) {
        debug.rejected++;
        return;
      }
      debug.checked++;
      var opts = {
        caseSensitive: !!entry.caseSensitive,
        matchWholeWords: !!entry.matchWholeWords
      };
      var entryScan = entry.scanDepth != null ? entry.scanDepth : globalScanDepth;
      var text = buildScanText({
        contextText: input.contextText,
        messages: input.messages,
        scanDepth: entryScan,
        scanText: input.scanText
      });

      if (entry.constant) {
        if (!skipProbability && entry.useProbability && entry.probability < 100) {
          if (Math.random() * 100 >= entry.probability) {
            debug.rejected++;
            return;
          }
        }
        activated.push(entry);
        debug.constant++;
        return;
      }

      var keys = entry.key && entry.key.length ? entry.key : entry.keywords || [];
      if (!keys.length) {
        debug.rejected++;
        return;
      }
      if (!anyKeyMatch(text, keys, opts)) {
        debug.rejected++;
        return;
      }
      if (!secondaryOk(text, entry, opts)) {
        debug.rejected++;
        return;
      }
      /*
       * 概率判定：准入阶段（skipProbability）不做，留给 applyStDecoration。
       * 详见函数头注释 —— 两边都判会把实际概率压成 p²。
       */
      if (!skipProbability && entry.useProbability && entry.probability < 100) {
        if (Math.random() * 100 >= entry.probability) {
          debug.rejected++;
          return;
        }
      }
      activated.push(entry);
      debug.keyed++;
    });

    // 简单递归：用已激活 content 再扫一轮（忽略 preventRecursion 源触发的）
    if (!input.disableRecursion) {
      var extraText = activated
        .filter(function (e) { return !e.preventRecursion; })
        .map(function (e) { return e.content || ''; })
        .join('\n');
      if (extraText) {
        var combined = scanText + '\n' + extraText;
        list.forEach(function (entry) {
          if (!entry || entry.enabled === false || entry.constant) return;
          if (activated.indexOf(entry) >= 0) return;
          if (entry.excludeRecursion) return;
          var opts = {
            caseSensitive: !!entry.caseSensitive,
            matchWholeWords: !!entry.matchWholeWords
          };
          var keys = entry.key && entry.key.length ? entry.key : entry.keywords || [];
          if (!keys.length || !anyKeyMatch(combined, keys, opts)) return;
          if (!secondaryOk(combined, entry, opts)) return;
          activated.push(entry);
          debug.keyed++;
        });
      }
    }

    return { activated: activated, deferred: deferred, debug: debug, scanText: scanText };
  }


  /**
   * 同名 group：默认只保留 groupWeight 最高的一条；groupOverride 可并列保留。
   *
   * 【常驻豁免】constant === true 的词条**不参与分组互斥**，一律保留。
   *
   * 为什么必须豁免：
   *   group 是 ST 世界书的字段，同组语义是「同一场景的互斥变体，只挑一条」——
   *   这是 ST 的正当玩法。但 Miya 的「常驻」（constant）表达的是**无条件注入**：
   *   用户把它设成常驻，意思就是「这条一定得在」。两套语义冲突时，常驻优先。
   *
   *   历史问题：一批从 ST 导入的常驻词条恰好共享同一个 group（ST 里很常见），
   *   于是被这里按 groupWeight 压成一条，其余静默消失 —— 用户在世界书页
   *   明明全部启用，实际注入却只剩一条，且**没有任何提示**。
   *   更隐蔽的是：若用户后来把某条通过「强制绑定」注入，那条会因为绕过
   *   本函数而出现，让人误以为「必须绑定才生效」，把根因彻底带偏。
   *
   * 返回值改为 { entries, dropped }：被互斥挤掉的条目要记账，
   * 否则「命中数比预期少」永远只能靠猜。
   */
  function applyGroupScoring(entries) {
    var list = entries || [];
    var groups = {};
    var free = [];
    list.forEach(function (e) {
      if (!e) return;
      /* 常驻豁免：不分组、不参与互斥 */
      if (e.constant === true) {
        free.push(e);
        return;
      }
      var g = String((e && e.group) || '').trim();
      if (!g) {
        free.push(e);
        return;
      }
      if (!groups[g]) groups[g] = [];
      groups[g].push(e);
    });
    var winners = free.slice();
    var dropped = [];
    Object.keys(groups).forEach(function (g) {
      var arr = groups[g].slice().sort(function (a, b) {
        var aw = Number(a.groupWeight) || 100;
        var bw = Number(b.groupWeight) || 100;
        if (bw !== aw) return bw - aw;
        return (Number(a.order) || 0) - (Number(b.order) || 0);
      });
      var top = arr[0];
      winners.push(top);
      arr.slice(1).forEach(function (e) {
        if (e.groupOverride) winners.push(e);
        else dropped.push({ id: e.id, name: e.name, group: g });
      });
    });
    return { entries: winners, dropped: dropped };
  }

  /**
   * 调试报告：与「期望激活 id 列表」对比
   */
  function compareActivation(entries, input, expectedIds) {
    var pipe = runPipeline(entries, input || {});
    var got = (pipe.selected || []).map(function (e) { return String(e.id); });
    var exp = (expectedIds || []).map(String);
    var missing = exp.filter(function (id) { return got.indexOf(id) < 0; });
    var extra = got.filter(function (id) { return exp.indexOf(id) < 0; });
    return {
      ok: missing.length === 0 && extra.length === 0,
      got: got,
      expected: exp,
      missing: missing,
      extra: extra,
      pipeline: pipe
    };
  }

  /**
   * 按 order 排序并应用 token 预算
   * ST：order 越大越靠近上下文末端、通常优先保留；预算不够时丢弃低 order
   */
  function applyTokenBudget(entries, budgetTokens, opts) {
    opts = opts || {};
    var budget = budgetTokens == null || budgetTokens <= 0 ? Infinity : Number(budgetTokens);
    var list = (entries || []).slice().sort(function (a, b) {
      var ao = Number(a.order);
      var bo = Number(b.order);
      if (!Number.isFinite(ao)) ao = 100;
      if (!Number.isFinite(bo)) bo = 100;
      if (bo !== ao) return bo - ao; // 高 order 优先纳入预算
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    var kept = [];
    var dropped = [];
    var used = 0;
    list.forEach(function (entry) {
      var tokens = estimateTokens(entry.content);
      if (entry.ignoreBudget || used + tokens <= budget) {
        kept.push(entry);
        if (!entry.ignoreBudget) used += tokens;
      } else {
        dropped.push({ id: entry.id, name: entry.name, tokens: tokens });
      }
    });
    // 注入顺序：低 order 在前（先出现在 prompt 前部）
    kept.sort(function (a, b) {
      var ao = Number(a.order);
      var bo = Number(b.order);
      if (!Number.isFinite(ao)) ao = 100;
      if (!Number.isFinite(bo)) bo = 100;
      if (ao !== bo) return ao - bo;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    return {
      entries: kept,
      dropped: dropped,
      usedTokens: used,
      budgetTokens: budget === Infinity ? null : budget
    };
  }

  /**
   * 按 ST position 分桶。
   *
   * position=4（@depth / 聊天内）的处置：**只进 inChat，不进 back**。
   *
   *   ST 原语义是「按 injection_depth 插到聊天记录倒数第 N 条之前」。
   *   深度注入已实现（v7）：inChat 由 miya-worldbook-prompt.js 以结构化
   *   数组 inChatItems 透出，再由 miya-chat-engine.js 的
   *   insertWorldbookInChatMessages() 按 depth 插进 apiMessages。
   *
   *   历史上这里推两个桶（back + inChat），是深度注入实现前的「明确降级」：
   *   归 back 保证内容不丢，记 inChat 留作将来取用。**该降级已作废** ——
   *   保留它会让面板预览显示「按后注入」，而实际按深度插，直接说反。
   *
   *   ⚠️ 本函数必须与 miya-worldbook-prompt.js 的同名函数保持语义一致。
   *      两条路（面板预览 / 主流程）分桶不同过一次，教训见
   *      test/injection_unit.py 的【10】两路一致性断言。
   */
  function partitionByDepth(entries) {
    var buckets = { front: [], middle: [], back: [], inChat: [] };
    (entries || []).forEach(function (e) {
      if (!e) return;
      if (Number(e.position) === 4) {
        /* 深度注入：位置由 injection_depth 决定，不落 back */
        buckets.inChat.push(e);
        return;
      }
      var d = e.depth || positionToDepth(e.position);
      if (d === 'front') buckets.front.push(e);
      else if (d === 'back') buckets.back.push(e);
      else buckets.middle.push(e);
    });
    return buckets;
  }

  /**
   * 增量裁决：对「已经由 Miya matcher 判定应当注入」的候选集，
   * 只施加 ST 的**排序 / 互斥 / 预算 / 概率**能力，**不再做 activate / reject**。
   *
   * 与 runPipeline 的区别（W2 修复的核心）：
   *   runPipeline      = 准入判定（constant / 关键词）+ 排序 + 预算 —— ST 独占「要不要用」
   *   applyStDecoration= 仅排序 + 预算 + 概率掷骰           —— ST 只管「用了怎么排怎么裁」
   *
   * 为什么需要它：Miya 的 scope（全局/局部）与 globalReach（全软件/线上/线下）
   * 是 ST 世界观里不存在的概念，runPipeline 的 activateEntries 会用 ST 语义
   * 把「Miya 认为该注入」的词条静默筛掉。改用本函数后，准入权归还 matcher，
   * ST 只负责它真正擅长的部分。
   */
  function applyStDecoration(entries, input) {
    input = input || {};
    var list = (Array.isArray(entries) ? entries : []).slice();
    var debug = { checked: list.length, probabilityRejected: 0, afterGroup: 0 };

    /* 1) probability 掷骰（原本在 activateEntries 内，随准入一起被移除，此处补回） */
    var survived = list.filter(function (entry) {
      if (!entry) return false;
      if (entry.constant) return true; // 常驻条目不受概率约束
      if (entry.useProbability && entry.probability < 100) {
        if (Math.random() * 100 >= entry.probability) {
          debug.probabilityRejected++;
          return false;
        }
      }
      return true;
    });

    /* 2) 同组互斥（groupWeight / groupOverride）
       常驻词条豁免互斥（见 applyGroupScoring 注释）。
       被互斥挤掉的条目记进 groupDropped，最后与预算丢弃合并上报 ——
       以前这里是个静默的黑洞：丢了不记账，用户只能靠猜。 */
    var groupRes = applyGroupScoring(survived);
    var filtered = groupRes.entries;
    var groupDropped = groupRes.dropped || [];
    debug.afterGroup = filtered.length;
    debug.groupRejected = groupDropped.length;

    /* 3) token 预算
       ---------------------------------------------------------------
       未显式配置预算 → 不裁剪（budget = null 时 applyTokenBudget 内部
       会退化成 Infinity）。这里以前写死 2048，是把「没配置」和
       「配了 2048」当成同一件事，结果给出一个隐形、不可见、不可调的
       上限，把命中的词条按 order 静默裁掉，UI 却只报剩余数量。
       真要限流请显式传 tokenBudget / budget。 */
    var budget = input.tokenBudget != null ? input.tokenBudget : input.budget;
    var bud = applyTokenBudget(filtered, budget, input);

    return {
      selected: bud.entries,
      /* 分组互斥丢弃 + 预算丢弃，统一上报。
         两类原因都在 dropped 里带 kind 字段，面板可据此分别措辞。 */
      dropped: groupDropped.map(function (d) {
        return { id: d.id, name: d.name, group: d.group, kind: 'group' };
      }).concat((bud.dropped || []).map(function (d) {
        return { id: d.id, name: d.name, tokens: d.tokens, kind: 'budget' };
      })),
      usedTokens: bud.usedTokens,
      budgetTokens: bud.budgetTokens,
      debug: debug
    };
  }

  /**
   * 完整流水线：激活 → 预算 → 分桶
   */
  function runPipeline(entries, input) {
    input = input || {};
    var act = activateEntries(entries, input);
    var groupRes = applyGroupScoring(act.activated || []);
    var filtered = groupRes.entries;
    var groupDropped = groupRes.dropped || [];
    /* 未配置预算 → 不裁剪，理由见 applyStDecoration 内注释 */
    var budget = input.tokenBudget != null ? input.tokenBudget : input.budget;
    var bud = applyTokenBudget(filtered, budget, input);
    var buckets = partitionByDepth(bud.entries);
    return {
      activated: act.activated,
      selected: bud.entries,
      dropped: groupDropped.map(function (d) {
        return { id: d.id, name: d.name, group: d.group, kind: 'group' };
      }).concat((bud.dropped || []).map(function (d) {
        return { id: d.id, name: d.name, tokens: d.tokens, kind: 'budget' };
      })),
      usedTokens: bud.usedTokens,
      budgetTokens: bud.budgetTokens,
      buckets: buckets,
      debug: Object.assign({}, act.debug, { afterGroup: filtered.length }),
      scanText: act.scanText
    };
  }

  /** 解析 ST 世界书 JSON 根对象 → 词条数组（尚未 normalize 到 store） */
  function parseStWorldInfoJson(data) {
    if (!data) return [];
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        throw new Error('JSON 解析失败');
      }
    }
    var rawEntries = null;
    if (Array.isArray(data)) rawEntries = data;
    else if (data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
      rawEntries = Object.keys(data.entries)
        .sort(function (a, b) {
          return Number(a) - Number(b);
        })
        .map(function (k) {
          return data.entries[k];
        });
    } else if (Array.isArray(data.entries)) rawEntries = data.entries;
    else if (data.originalData && data.originalData.entries) {
      return parseStWorldInfoJson(data.originalData);
    } else if (data.data && data.data.character_book && Array.isArray(data.data.character_book.entries)) {
      rawEntries = data.data.character_book.entries;
    } else {
      throw new Error('无法识别的世界书格式（需要 entries 对象或数组）');
    }

    function bookNameFrom(data) {
      if (!data || typeof data !== 'object') return '';
      var n =
        data.name ||
        data.worldInfoName ||
        data.world_info_name ||
        (data.originalData && data.originalData.name) ||
        (data.data && data.data.name) ||
        '';
      return String(n || '').trim();
    }

    var entries = rawEntries.map(function (raw, index) {
      var st = normalizeStFields(raw, {});
      var id =
        raw.uid != null
          ? 'st_' + String(raw.uid) + '_' + Date.now().toString(36).slice(-4)
          : raw.id != null
            ? String(raw.id)
            : 'st_import_' + index + '_' + Date.now().toString(36);
      return Object.assign({}, st, {
        id: id,
        scope: 'global',
        globalReach: 'all',
        /* 分组归属由 importIntoStore 决定（它会新建/复用真实分组）。
           这里**不能**预填 'grp_default' —— 预填会让「兜底容器」变成「默认归属」，
           一旦后续赋值环节出错，条目就真留在未分组里，出现「未分组与分组内同款条目」。 */
        groupId: '',
        boundRoleIds: [],
        source: 'st-import',
        /*
         * createdAt 按**原始顺序**分配，而不是全部写 Date.now()。
         *
         * 列表现在是按 createdAt 降序排的（见 store 的 normalizeState）。
         * 以前这里全写 Date.now()，一次导入 100 条就得到 100 个几乎相同的
         * 时间戳（甚至同毫秒完全相同）——排序退化成靠 id 兜底，
         * 导入进来的条目会以不可预期的顺序摊在分组里。
         *
         * 现在：以「当前时间」为基准，**按索引往前递减 1 毫秒**。
         * 效果是原文件的第 0 条时间戳最大 → 排在列表最顶，往后依次递减。
         * 这样两次导入之间仍有先后（后来的整体更靠前），
         * 同一批内部也严格保持原文件顺序。
         */
        createdAt: Date.now() - index,
        updatedAt: Date.now()
      });
    });
    entries._bookName = bookNameFrom(data);
    return entries;
  }

  function exportStWorldInfoJson(entries, meta) {
    var map = {};
    (entries || []).forEach(function (e, i) {
      var uid = e.uid != null ? Number(e.uid) : i;
      if (!Number.isFinite(uid)) uid = i;
      map[String(uid)] = {
        uid: uid,
        key: e.key && e.key.length ? e.key : e.keywords || [],
        keysecondary: e.keysecondary || [],
        comment: e.comment || e.name || '',
        content: e.content || '',
        constant: !!e.constant,
        selective: !!e.selective,
        selectiveLogic: Number(e.selectiveLogic) || 0,
        order: Number(e.order) || 100,
        position: Number.isFinite(Number(e.position)) ? Number(e.position) : depthToPosition(e.depth),
        disable: e.enabled === false,
        excludeRecursion: !!e.excludeRecursion,
        probability: Number(e.probability) || 100,
        useProbability: !!e.useProbability,
        depth: Number(e.injection_depth) || 4,
        scanDepth: e.scanDepth,
        caseSensitive: !!e.caseSensitive,
        matchWholeWords: !!e.matchWholeWords,
        ignoreBudget: !!e.ignoreBudget,
        sticky: e.sticky || 0,
        cooldown: e.cooldown || 0,
        delay: e.delay || 0,
        group: e.group || '',
        groupWeight: e.groupWeight || 100,
        groupOverride: !!e.groupOverride
      };
    });
    return {
      name: (meta && meta.name) || 'Miya Worldbook Export',
      description: (meta && meta.description) || '',
      entries: map
    };
  }

  /**
   * 生成不重复的分组名。
   * 场景：同一本世界书二次导入做「二改」时，两次的书名完全一样，
   * 列表里会出现两个同名分组，分不清原件与二改稿。
   * 这里自动加序号：某世界书 → 某世界书 (2) → 某世界书 (3) …
   */
  function uniqueGroupName(store, baseName) {
    var base = String(baseName || '').trim() || '导入世界书';
    var existing = {};
    (store.listGroups ? store.listGroups() : []).forEach(function (g) {
      if (g && g.name) existing[String(g.name)] = true;
    });
    if (!existing[base]) return base;
    var n = 2;
    while (existing[base + ' (' + n + ')']) n++;
    return base + ' (' + n + ')';
  }

  /** 导入到 store（合并或替换） */
  function importIntoStore(data, options) {
    options = options || {};
    var store = global.miyaWorldbookStore;
    if (!store) return Promise.reject(new Error('worldbook store missing'));
    var parsed = parseStWorldInfoJson(data);
    var bookName =
      options.groupName ||
      options.bookName ||
      parsed._bookName ||
      '导入世界书 ' + new Date().toLocaleString();
    var chain = Promise.resolve();
    if (options.replace) {
      chain = chain.then(function () {
        var existing = store.listEntries();
        return existing.reduce(function (p, e) {
          return p.then(function () {
            return store.removeEntry(e.id);
          });
        }, Promise.resolve());
      });
    }
    var groupId = null;
    var finalGroupName = bookName;
    return chain
      .then(function () {
        if (options.groupId) {
          groupId = options.groupId;
          var g0 = store.getGroup ? store.getGroup(groupId) : null;
          if (g0 && g0.name) finalGroupName = g0.name;
          return null;
        }
        /* 二次导入自动加序号，避免与已有分组重名 */
        finalGroupName = uniqueGroupName(store, bookName);
        return store.upsertGroup({
          name: finalGroupName,
          sort: Date.now()
        });
      })
      .then(function (g) {
        if (g && g.id) groupId = g.id;
        /* 建组失败就必须让导入整体失败。
           以前这里静默降级成 'grp_default'，条目会落进未分组——正是
           「未分组里出现本该在分组中的条目」的根因。
           宁可报错让用户重试，也不悄悄把数据放进兜底容器。 */
        if (!groupId) throw new Error('分组创建失败，已取消导入');
        return parsed.reduce(function (p, entry) {
          return p.then(function () {
            entry.groupId = groupId;
            return store.upsertEntry(entry);
          });
        }, Promise.resolve());
      })
      .then(function () {
        return {
          count: parsed.length,
          entries: parsed,
          groupId: groupId,
          /* 返回「实际建成的分组名」而非原始书名，
             这样二次导入时调用方 alert 出来的名字带序号，能分辨原件与二改稿。 */
          groupName: finalGroupName
        };
      });
  }

  global.miyaWorldbookST = {
    SELECTIVE_AND_ANY: SELECTIVE_AND_ANY,
    SELECTIVE_NOT_ALL: SELECTIVE_NOT_ALL,
    SELECTIVE_NOT_ANY: SELECTIVE_NOT_ANY,
    SELECTIVE_AND_ALL: SELECTIVE_AND_ALL,
    positionToDepth: positionToDepth,
    depthToPosition: depthToPosition,
    normalizeStFields: normalizeStFields,
    estimateTokens: estimateTokens,
    keywordMatches: keywordMatches,
    activateEntries: activateEntries,
    applyTokenBudget: applyTokenBudget,
    partitionByDepth: partitionByDepth,
    runPipeline: runPipeline,
    applyStDecoration: applyStDecoration,
    parseStWorldInfoJson: parseStWorldInfoJson,
    exportStWorldInfoJson: exportStWorldInfoJson,
    importIntoStore: importIntoStore,
    buildScanText: buildScanText,
    applyGroupScoring: applyGroupScoring,
    compareActivation: compareActivation
  };
})(typeof window !== 'undefined' ? window : globalThis);
