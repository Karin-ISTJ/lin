/**
 * Miya · 世界书 ST 对齐层
 * - 词条字段兼容 SillyTavern World Info / Lorebook
 * - 扫描触发（constant / key / keysecondary / selectiveLogic）
 * - 注入排序 + token 预算
 * - 导入/导出 ST JSON（entries 为对象或数组）
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

  function estimateTokens(text) {
    var s = String(text || '');
    if (!s) return 0;
    // 中英混合粗估：约 1 token ≈ 2 汉字 或 4 英文字符
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
    var injectionDepth = clampInt(
      raw.depth != null && Number(raw.position) === 4
        ? raw.depth
        : raw.injection_depth != null
          ? raw.injection_depth
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
    var excludeRecursion =
      raw.excludeRecursion === true ||
      raw.exclude_recursion === true ||
      (raw.extensions && raw.extensions.exclude_recursion === true);
    var preventRecursion =
      raw.preventRecursion === true ||
      raw.prevent_recursion === true ||
      (raw.extensions && raw.extensions.prevent_recursion === true);
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
      var re = new RegExp(
        '(?:^|[^\\w\\u3400-\\u9fff])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\w\\u3400-\\u9fff])',
        opts.caseSensitive ? '' : 'i'
      );
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

  function buildScanText(input) {
    if (input.scanText) return String(input.scanText);
    var msgs = Array.isArray(input.messages) ? input.messages : [];
    var depth = input.scanDepth != null ? clampInt(input.scanDepth, 0, 1000, 50) : 50;
    if (!msgs.length) return String(input.contextText || '');
    var slice = msgs.slice(-Math.max(0, depth));
    return slice
      .map(function (m) {
        if (typeof m === 'string') return m;
        return String((m && (m.content || m.text)) || '');
      })
      .join('\n');
  }

  /**
   * ST 风格激活
   * @returns {{ activated: object[], deferred: object[], debug: object }}
   */
  function activateEntries(entries, input) {
    input = input || {};
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
        if (entry.useProbability && entry.probability < 100) {
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
      if (entry.useProbability && entry.probability < 100) {
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
   * 同名 group：默认只保留 groupWeight 最高的一条；groupOverride 可并列保留
   */
  function applyGroupScoring(entries) {
    var list = entries || [];
    var groups = {};
    var free = [];
    list.forEach(function (e) {
      var g = String((e && e.group) || '').trim();
      if (!g) {
        free.push(e);
        return;
      }
      if (!groups[g]) groups[g] = [];
      groups[g].push(e);
    });
    var winners = free.slice();
    Object.keys(groups).forEach(function (g) {
      var arr = groups[g].slice().sort(function (a, b) {
        var aw = Number(a.groupWeight) || 100;
        var bw = Number(b.groupWeight) || 100;
        if (bw !== aw) return bw - aw;
        return (Number(b.order) || 0) - (Number(a.order) || 0);
      });
      var top = arr[0];
      winners.push(top);
      arr.slice(1).forEach(function (e) {
        if (e.groupOverride) winners.push(e);
      });
    });
    return winners;
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

  function partitionByDepth(entries) {
    var buckets = { front: [], middle: [], back: [], inChat: [] };
    (entries || []).forEach(function (e) {
      if (!e) return;
      if (Number(e.position) === 4) {
        buckets.inChat.push(e);
        buckets.back.push(e);
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
   * 完整流水线：激活 → 预算 → 分桶
   */
  function runPipeline(entries, input) {
    input = input || {};
    var act = activateEntries(entries, input);
    var filtered = applyGroupScoring(act.activated || []);
    var budget = input.tokenBudget != null ? input.tokenBudget : input.budget;
    if (budget == null) budget = 2048;
    var bud = applyTokenBudget(filtered, budget, input);
    var buckets = partitionByDepth(bud.entries);
    return {
      activated: act.activated,
      selected: bud.entries,
      dropped: bud.dropped,
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

    return rawEntries.map(function (raw, index) {
      var st = normalizeStFields(raw, {});
      var id =
        raw.uid != null
          ? 'st_' + String(raw.uid)
          : raw.id != null
            ? String(raw.id)
            : 'st_import_' + index + '_' + Date.now().toString(36);
      return Object.assign({}, st, {
        id: id,
        scope: 'global',
        globalReach: 'all',
        groupId: 'grp_default',
        boundRoleIds: [],
        source: 'st-import',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    });
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

  /** 导入到 store（合并或替换） */
  function importIntoStore(data, options) {
    options = options || {};
    var store = global.miyaWorldbookStore;
    if (!store) return Promise.reject(new Error('worldbook store missing'));
    var parsed = parseStWorldInfoJson(data);
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
    return chain.then(function () {
      return parsed.reduce(function (p, entry) {
        return p.then(function () {
          return store.upsertEntry(entry);
        });
      }, Promise.resolve());
    }).then(function () {
      return { count: parsed.length, entries: parsed };
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
    parseStWorldInfoJson: parseStWorldInfoJson,
    exportStWorldInfoJson: exportStWorldInfoJson,
    importIntoStore: importIntoStore,
    buildScanText: buildScanText,
    applyGroupScoring: applyGroupScoring,
    compareActivation: compareActivation
  };
})(typeof window !== 'undefined' ? window : globalThis);
