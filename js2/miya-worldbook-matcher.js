(function (global) {
  'use strict';

  function splitKeywordString(raw) {
    var src = String(raw || '').trim();
    if (!src) return [];
    return src.split(/[,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /**
   * 关键词命中判断。
   *
   * 注意：这里必须与 miya-worldbook-st.keywordMatches 保持同一套语义。
   * 历史上本函数是独立的 indexOf 实现，只做小写化字面量匹配，不认正则、
   * 不认 matchWholeWords / caseSensitive。而词条随后还会被 ST 流水线再匹配
   * 一次（miya-worldbook-prompt.js 的 runPipeline），两套判定不一致时，
   * 「第一套命中、第二套未命中」的词条会被静默丢弃。
   * 现在统一委托给 ST 实现，保证单点语义。
   */
  function includesKeyword(text, keywords, opts) {
    if (!Array.isArray(keywords) || keywords.length === 0) return true;
    var st = global.miyaWorldbookST;
    if (st && typeof st.keywordMatches === 'function') {
      return keywords.some(function (kw) {
        return st.keywordMatches(text, kw, opts || {});
      });
    }
    var source = String(text || '').toLowerCase();
    return keywords.some(function (kw) {
      var k = String(kw || '').trim().toLowerCase();
      return !!k && source.indexOf(k) >= 0;
    });
  }

  function expandRoleAliases(roleId) {
    var set = {};
    function add(v) {
      v = String(v || '').trim();
      if (v) set[v] = true;
    }
    add(roleId);
    var cs = global.miyaContactsStore;
    if (cs && typeof cs.findCharacter === 'function') {
      var row = cs.findCharacter(roleId);
      if (row) {
        add(row.id);
        add(row.characterId);
      }
    }
    return Object.keys(set);
  }

  function collectCfgRoleIds(cfg) {
    var out = [];
    var seen = {};
    function push(v) {
      v = String(v || '').trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      out.push(v);
    }
    if (Array.isArray(cfg && cfg.roleIds)) {
      cfg.roleIds.forEach(push);
    }
    push(cfg && cfg.roleId);
    return out;
  }

  function getEntryGlobalReach(entry) {
    if (!entry) return '';
    var wb = global.miyaWorldbookStore;
    if (wb && typeof wb.normalizeGlobalReach === 'function') {
      return wb.normalizeGlobalReach(entry.globalReach, entry.scope);
    }
    var v = String(entry.globalReach || '').trim();
    if (v) return v;
    return String(entry.scope) === 'local' ? 'all' : 'online_offline';
  }

  function globalReachApplies(reach, promptContext) {
    var ctx = String(promptContext || '').trim();
    if (!reach || reach === 'all' || !ctx) return false;
    if (ctx === 'online') return reach === 'online' || reach === 'online_offline';
    if (ctx === 'offline') return reach === 'offline' || reach === 'online_offline';
    return false;
  }

  /** force 注入时是否仍受生效范围约束（全软件 / 无 context 不拦截） */
  function forceReachAllows(reach, promptContext) {
    var r = String(reach || '').trim();
    if (!r || r === 'all') return true;
    var ctx = String(promptContext || '').trim();
    if (!ctx) return true;
    return globalReachApplies(r, ctx);
  }

  function roleMatches(entry, cfg) {
    var bound = Array.isArray(entry.boundRoleIds) ? entry.boundRoleIds : [];
    if (!bound.length) return true;
    var roleIds = collectCfgRoleIds(cfg);
    if (!roleIds.length) return false;

    var contactAliases = [];
    roleIds.forEach(function (rid) {
      expandRoleAliases(rid).forEach(function (alias) {
        if (contactAliases.indexOf(alias) < 0) contactAliases.push(alias);
      });
    });

    return bound.some(function (bid) {
      return expandRoleAliases(bid).some(function (alias) {
        return contactAliases.indexOf(alias) >= 0;
      });
    });
  }

  /**
   * 条目是否「两层都放行」：自身开关开着，且所属分组的总开关也开着。
   * 分组开关是独立的一层，不改写条目 enabled —— 关组再开组能原样恢复。
   */
  function entryActive(entry) {
    if (!entry || entry.enabled === false) return false;
    var store = global.miyaWorldbookStore;
    if (store && typeof store.isEntryGroupEnabled === 'function') {
      return store.isEntryGroupEnabled(entry);
    }
    return true;
  }

  function matchEntry(entry, cfg) {
    if (!entryActive(entry)) return false;
    var contextText = String(cfg.contextText || '');
    var scope = String(entry.scope || 'global');
    var promptContext = String(cfg.promptContext || '').trim();
    var reach = getEntryGlobalReach(entry);
    var st = global.miyaWorldbookST;

    function stKeywordMatch() {
      var opts = { caseSensitive: !!entry.caseSensitive, matchWholeWords: !!entry.matchWholeWords };
      if (!st || typeof st.activateEntries !== 'function') {
        if (entry.constant) return true;
        return includesKeyword(contextText, entry.key || entry.keywords || [], opts);
      }
      /*
       * ⚠️ skipProbability 必须传 true。
       *
       * 这里只回答「关键词命中没有」——是**准入判定**，不是最终裁决。
       * 命中的词条随后会进 applyStDecoration，那里才掷概率骰。
       * 若此处也让 activateEntries 掷一次，同一条词条一轮内被裁决两次，
       * 实际生效概率变成 p²（设 50% → 真实 25%；设 10% → 真实 1%），
       * 表现为「概率开关时灵时不灵」，且静默无报错。
       *
       * disableRecursion 同理：单条判定不该触发递归扫描，
       * 递归由最终的 applyStDecoration 之后的流程统一处理。
       */
      var res = st.activateEntries([entry], {
        contextText: contextText,
        messages: cfg.messages,
        scanDepth: cfg.scanDepth,
        disableRecursion: true,
        skipProbability: true
      });
      return (res.activated || []).length > 0;
    }

    if (scope === 'local') {
      if (!roleMatches(entry, cfg)) return false;
      // 局部·全软件：绑定角色后任意场景注入（不依赖关键词 / promptContext）
      if (reach === 'all') return true;
      if (promptContext && reach && !globalReachApplies(reach, promptContext)) return false;
      var bound = Array.isArray(entry.boundRoleIds) ? entry.boundRoleIds : [];
      if (entry.constant) return true;
      /* ⚠️ 必须用 entryKeywords()，不能手写等价判断。
         key=[''] / [' '] 这类「有数组长度但没有有效关键词」的条目，
         若只判 Array.length 就会被当成「带关键词」而走去掷关键词，
         实际永远不可能命中 —— 表现为「明明没填关键词，词条却不注入」。
         entryKeywords() 会先 filter(Boolean)，是本文件的唯一权威判据。 */
      if (bound.length && !entryKeywords(entry).length) return true;
      return stKeywordMatch();
    }
    /* 全局·全软件：等同 ST constant / 无关键词限制的全局层 */
    if (reach === 'all') {
      /* ⚠️ 括号不可省。`||` 优先级低于 `&&`，写成
             entry.constant || !hasKey && !hasKeywords ? true : stKeywordMatch()
         会被解析成 (constant || 无关键词) ? true : stKeywordMatch()，
         「有 key 但 key 全是空串」的条目会掉进 stKeywordMatch() 并被判负，
         整条静默丢失。 */
      return entry.constant || !hasAnyKeywords(entry)
        ? true
        : stKeywordMatch();
    }
    if (promptContext && reach && !globalReachApplies(reach, promptContext)) return false;
    if (entry.constant) return true;
    return stKeywordMatch();
  }

  function matchEntries(input) {
    var cfg = input && typeof input === 'object' ? input : {};
    var entries = Array.isArray(cfg.entries) ? cfg.entries : [];
    var matched = entries.filter(function (entry) { return matchEntry(entry, cfg); });
    var globalRows = [];
    var localRows = [];
    matched.forEach(function (entry) {
      if (String(entry.scope) === 'local') localRows.push(entry);
      else globalRows.push(entry);
    });
    return {
      matched: matched,
      global: globalRows,
      local: localRows
    };
  }

  function collectUniversalGlobalEntries(entries) {
    return (entries || []).filter(function (entry) {
      return entryActive(entry) && String(entry.scope) !== 'local' &&
        getEntryGlobalReach(entry) === 'all';
    });
  }

  function collectReachGlobalEntries(entries, promptContext) {
    var ctx = String(promptContext || '').trim();
    if (!ctx) return [];
    return (entries || []).filter(function (entry) {
      if (!entryActive(entry) || String(entry.scope) === 'local') return false;
      return globalReachApplies(getEntryGlobalReach(entry), ctx);
    });
  }

  /* ------------------------------------------------------------------
   * 激活诊断：解释「这条词条为什么没被注入」
   *
   * 与 matchEntry 的关系：判定顺序、短路条件完全一致（本函数是它的展开版），
   * 但每一步都记录结论 —— matchEntry 只回 true/false，排查时无从下手。
   *
   * 三条硬约束：
   *   1. 只读。不掷概率、不写 store、不产生副作用，可安全反复调用。
   *   2. 不改变注入行为。注入链路仍走 matchEntry，本函数仅供展示。
   *   3. 概率只报「不参与判定」，不预测结果 —— 掷骰子不可解释，
   *      提前说「会命中」或「不会命中」都是撒谎。
   * ------------------------------------------------------------------ */
  var REASON_LABELS = {
    ok: '已注入',
    entry_disabled: '条目被关闭',
    group_disabled: '所在世界书被整组关闭',
    scope_local_no_binding: '未绑定联系人（视为不限角色）',
    scope_local_role_mismatch: '绑定的联系人与当前对话不符',
    reach_all_local: '局部·全软件：已无条件注入（不应出现在未命中列表）',
    reach_mismatch: '生效场景不符',
    no_keywords: '非常驻且没有关键词',
    keyword_miss: '关键词未命中',
    probability: '触发概率：每次生成时掷骰'
  };

  /** 词条的关键词数组（key 优先，回落 keywords） */
  function entryKeywords(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.key) && entry.key.length) return entry.key.filter(Boolean);
    if (Array.isArray(entry.keywords)) return entry.keywords.filter(Boolean);
    return [];
  }

  /**
   * 词条是否「真的配了关键词」。
   *
   * 判据是**剔除空串后还有没有内容**，而不是数组长度 —— key=[''] 属于
   * UI 里留了空输入框 / 逗号切分残留 / ST 导入的空 key，语义上等于「没配关键词」，
   * 应当按常驻处理。历史上这里有三套写法各自为政：
   *   - matchEntry 局部分支：只看 entry.key.length（空串也当真）
   *   - matchEntry 全软件分支：同上看长度，且漏了括号
   *   - prompt.js entryHasKeys：filter(Boolean) 后判长度，与 matcher 不一致
   * 三条路给出三种结果，同一条词条「有没有关键词」取决于走的哪条分支。
   * 现在统一收敛到本函数。
   */
  function hasAnyKeywords(entry) {
    return entryKeywords(entry).length > 0;
  }

  /**
   * 逐层展开判定，返回带原因的裁决。
   * @returns {{id,name,injected,reason,reasonLabel,detail,keywords,scope,reach,constant}}
   */
  function explainEntry(entry, cfg) {
    cfg = cfg || {};
    var out = {
      id: String((entry && entry.id) || ''),
      name: String((entry && entry.name) || '').trim() || '未命名片段',
      injected: false,
      reason: 'ok',
      reasonLabel: REASON_LABELS.ok,
      detail: '',
      keywords: entryKeywords(entry),
      scope: String((entry && entry.scope) || 'global'),
      reach: getEntryGlobalReach(entry),
      constant: !!(entry && entry.constant),
      probability: !!(entry && entry.useProbability && entry.probability < 100)
    };

    if (!entry) {
      out.reason = 'entry_disabled';
      out.reasonLabel = REASON_LABELS.entry_disabled;
      return out;
    }

    /* 第 1 层：条目开关 */
    if (entry.enabled === false) {
      out.reason = 'entry_disabled';
      out.reasonLabel = REASON_LABELS.entry_disabled;
      out.detail = '条目自身的开关处于关闭状态';
      return out;
    }

    /* 第 2 层：分组开关（独立于条目开关，关组不改写条目 enabled） */
    if (!entryActive(entry)) {
      out.reason = 'group_disabled';
      out.reasonLabel = REASON_LABELS.group_disabled;
      out.detail = '所属世界书被整组关闭，条目本身仍是开启的';
      return out;
    }

    var contextText = String(cfg.contextText || '');
    var promptContext = String(cfg.promptContext || '').trim();
    var reach = out.reach;
    var roleIds = collectCfgRoleIds(cfg);

    /* 第 3 层：局部词条的绑定角色
       注意 roleMatches 的语义：**未绑定任何角色时返回 true**（视为不限制）。
       正常操作路径下不可能出现这种条目 —— 世界书编辑器保存时会拦截
       「局部但未绑定」（见 miya-worldbook-app.js 的 saveEditor），
       ST 导入也只产出 scope=global。所以这里按「未绑定 = 不限制」如实报告，
       不擅自说它是错的；只把它标成需要注意的状态。 */
    if (out.scope === 'local') {
      var bound = Array.isArray(entry.boundRoleIds) ? entry.boundRoleIds.filter(Boolean) : [];
      if (!bound.length) {
        out.injected = roleMatches(entry, cfg);
        out.reason = 'scope_local_no_binding';
        out.reasonLabel = REASON_LABELS.scope_local_no_binding;
        out.detail = out.injected
          ? '局部词条未绑定任何联系人 —— 按当前实现视为「不限制角色」，会对所有联系人注入'
          : '局部词条未绑定任何联系人，且当前上下文没有角色 id，故不注入';
        return out;
      }
      if (!roleMatches(entry, cfg)) {
        out.reason = 'scope_local_role_mismatch';
        out.reasonLabel = REASON_LABELS.scope_local_role_mismatch;
        out.detail = '绑定的联系人与当前对话角色不一致（绑定 ' + bound.length + ' 位，' +
          (roleIds.length ? '当前 ' + roleIds.join('、') : '当前上下文无角色 id') + '）';
        return out;
      }
      /* 局部·全软件：绑定角色后任意场景注入 */
      if (reach === 'all') {
        out.injected = true;
        out.reason = 'ok';
        out.reasonLabel = REASON_LABELS.ok;
        out.detail = '局部词条已绑定当前角色且生效场景为全软件，无条件注入';
        return out;
      }
      if (promptContext && reach && !globalReachApplies(reach, promptContext)) {
        out.reason = 'reach_mismatch';
        out.reasonLabel = REASON_LABELS.reach_mismatch;
        out.detail = '词条限定「' + reachLabel(reach) + '」，当前场景是「' + reachLabel(promptContext) + '」';
        return out;
      }
      var localKws = out.keywords;
      if (entry.constant || (bound.length && !localKws.length)) {
        out.injected = true;
        out.reason = 'ok';
        out.reasonLabel = REASON_LABELS.ok;
        out.detail = entry.constant ? '常驻条目' : '已绑定角色且无关键词，无条件注入';
        return out;
      }
      return explainKeywordLayer(entry, cfg, out, contextText);
    }

    /* 第 4 层：全局词条的生效场景 */
    if (reach === 'all') {
      if (entry.constant || !out.keywords.length) {
        out.injected = true;
        out.reason = 'ok';
        out.reasonLabel = REASON_LABELS.ok;
        out.detail = entry.constant ? '常驻条目' : '全局·全软件且无关键词，无条件注入';
        return out;
      }
      return explainKeywordLayer(entry, cfg, out, contextText);
    }
    if (promptContext && reach && !globalReachApplies(reach, promptContext)) {
      out.reason = 'reach_mismatch';
      out.reasonLabel = REASON_LABELS.reach_mismatch;
      out.detail = '词条限定「' + reachLabel(reach) + '」，当前场景是「' + reachLabel(promptContext) + '」';
      return out;
    }
    if (entry.constant) {
      out.injected = true;
      out.reason = 'ok';
      out.reasonLabel = REASON_LABELS.ok;
      out.detail = '常驻条目';
      return out;
    }
    return explainKeywordLayer(entry, cfg, out, contextText);
  }

  function reachLabel(v) {
    var s = String(v || '').trim();
    if (s === 'all') return '全软件';
    if (s === 'online') return '仅线上';
    if (s === 'offline') return '仅线下';
    if (s === 'online_offline') return '线上和线下';
    return s || '未限定';
  }

  /** 关键词层：给出「哪些关键词没中、扫描了多少字」 */
  function explainKeywordLayer(entry, cfg, out, contextText) {
    var kws = out.keywords;
    if (!kws.length) {
      out.reason = 'no_keywords';
      out.reasonLabel = REASON_LABELS.no_keywords;
      out.detail = '该词条非常驻，但没有配置任何关键词，永远不会被触发';
      return out;
    }
    var opts = { caseSensitive: !!entry.caseSensitive, matchWholeWords: !!entry.matchWholeWords };
    var st = global.miyaWorldbookST;

    /* ⚠️ 这里必须自己判定，**不能调 st.activateEntries**。
       activateEntries 在 useProbability 时会 Math.random() 掷骰
       （实测 200 次调用命中 65 次 ≈ 30%，就是词条设的 30% 概率）。
       拿它做诊断，同一份数据每次点开结论都不一样，等于给用户看随机数。
       诊断只回答「关键词层面中没中」，概率单独如实标注（见下方 probability 分支）。 */
    var scan = contextText;
    if (st && typeof st.buildScanText === 'function') {
      try {
        scan = st.buildScanText({
          contextText: contextText,
          messages: cfg.messages,
          scanDepth: cfg.scanDepth
        });
      } catch (e) {
        scan = contextText;
      }
    }
    var km = st && typeof st.keywordMatches === 'function'
      ? st.keywordMatches
      : function (hay, kw, o) { return includesKeyword(hay, [kw], o); };
    var hit = kws.some(function (kw) { return km(scan, kw, opts); });

    if (hit) {
      out.injected = true;
      out.reason = 'ok';
      out.reasonLabel = REASON_LABELS.ok;
      if (out.probability) {
        out.reason = 'probability';
        out.reasonLabel = REASON_LABELS.probability;
        out.detail = '关键词已命中，但该条目设置了 ' + entry.probability +
          '% 触发概率 —— 每次生成时独立掷骰，可能命中也可能不命中';
      } else {
        out.detail = '关键词已命中' + (kws.length > 1 ? '（共 ' + kws.length + ' 个）' : '');
      }
      return out;
    }
    out.reason = 'keyword_miss';
    out.reasonLabel = REASON_LABELS.keyword_miss;
    var missing = kws.filter(function (kw) { return !km(scan, kw, opts); });
    out.detail = '扫描了 ' + String(scan || '').length + ' 字上下文；' +
      missing.length + '/' + kws.length + ' 个关键词未命中' +
      (missing.length && missing.length <= 6 ? '：' + missing.join('、') : '') +
      (entry.matchWholeWords ? '（全词匹配已开启）' : '') +
      (entry.caseSensitive ? '（区分大小写已开启）' : '');
    return out;
  }

  /**
   * 批量诊断。顺序与注入链路一致：先排除 → 再逐条判定。
   * @returns {{rows: object[], stats: object}}
   */
  function diagnoseEntries(entries, cfg) {
    cfg = cfg || {};
    var list = Array.isArray(entries) ? entries : [];
    var excludeSet = {};
    (Array.isArray(cfg.excludeEntryIds) ? cfg.excludeEntryIds : []).forEach(function (id) {
      var k = String(id || '').trim();
      if (k) excludeSet[k] = true;
    });
    var rows = list.map(function (entry) {
      var row = explainEntry(entry, cfg);
      if (row.id && excludeSet[row.id]) {
        row.injected = false;
        row.reason = 'excluded';
        row.reasonLabel = '被本轮排除（excludeEntryIds）';
        row.detail = '调用方显式排除了该条目（如侧路摘要等不注入世界书的场景）';
      }
      return row;
    });
    var stats = { total: rows.length, injected: 0, blocked: 0, byReason: {} };
    rows.forEach(function (r) {
      if (r.injected) stats.injected++;
      else {
        stats.blocked++;
        stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;
      }
    });
    return { rows: rows, stats: stats };
  }

  global.miyaWorldbookMatcher = {
    splitKeywordString: splitKeywordString,
    includesKeyword: includesKeyword,
    expandRoleAliases: expandRoleAliases,
    matchEntries: matchEntries,
    matchEntry: matchEntry,
    roleMatches: roleMatches,
    getEntryGlobalReach: getEntryGlobalReach,
    globalReachApplies: globalReachApplies,
    forceReachAllows: forceReachAllows,
    collectUniversalGlobalEntries: collectUniversalGlobalEntries,
    collectReachGlobalEntries: collectReachGlobalEntries,
    explainEntry: explainEntry,
    diagnoseEntries: diagnoseEntries,
    entryKeywords: entryKeywords,
    hasAnyKeywords: hasAnyKeywords,
    REASON_LABELS: REASON_LABELS
  };
})(window);
