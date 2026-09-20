(function (global) {
  'use strict';

  function normalizeDepth(raw) {
    var wb = global.miyaWorldbookStore;
    if (wb && typeof wb.normalizeDepth === 'function') {
      return wb.normalizeDepth(raw);
    }
    var v = String(raw || '').trim().toLowerCase();
    if (v === 'front' || v === '前') return 'front';
    if (v === 'back' || v === '后') return 'back';
    return 'middle';
  }

  function depthTitle(depth) {
    if (depth === 'front') return '世界书·前';
    if (depth === 'back') return '世界书·后';
    return '世界书·中';
  }

  function renderBlock(title, entries) {
    if (!entries || !entries.length) return '';
    var lines = ['【' + title + '】'];
    entries.forEach(function (entry) {
      var name = String(entry.name || '').trim() || '未命名片段';
      var content = String(entry.content || '').trim();
      if (!content) return;
      lines.push('- ' + name + ': ' + content);
    });
    return lines.length > 1 ? lines.join('\n') : '';
  }

  function summarizeMatched(entries) {
    return (entries || []).map(function (entry) {
      var keywords = Array.isArray(entry.keywords) ? entry.keywords.filter(Boolean) : [];
      var content = String(entry.content || '');
      return {
        id: String(entry.id || ''),
        name: String(entry.name || '').trim() || '未命名片段',
        scope: String(entry.scope || 'global'),
        depth: normalizeDepth(entry && entry.depth),
        keywordCount: keywords.length,
        charCount: content.trim() ? content.length : 0
      };
    });
  }

  function applyEntryOrder(merged, orderIds) {
    if (!Array.isArray(merged) || !merged.length) {
      return { ordered: [], rest: merged || [] };
    }
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return { ordered: [], rest: merged.slice() };
    }
    var rank = {};
    var inOrder = {};
    orderIds.forEach(function (id, i) {
      id = String(id || '').trim();
      if (!id) return;
      rank[id] = i;
      inOrder[id] = true;
    });
    if (!Object.keys(rank).length) {
      return { ordered: [], rest: merged.slice() };
    }

    var ordered = [];
    merged.forEach(function (entry) {
      if (!entry || !entry.id || inOrder[String(entry.id)] === undefined) return;
      ordered.push(entry);
    });
    ordered.sort(function (a, b) {
      return rank[String(a.id)] - rank[String(b.id)];
    });

    var rest = merged.filter(function (entry) {
      return !entry || !entry.id || inOrder[String(entry.id)] === undefined;
    });
    return { ordered: ordered, rest: rest };
  }

  function mergeForcedMatches(input) {
    var cfg = input && typeof input === 'object' ? input : {};
    var matched = Array.isArray(cfg.matched) ? cfg.matched.slice() : [];
    var entries = Array.isArray(cfg.entries) ? cfg.entries : [];
    var bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
    var forcedIds = Array.isArray(cfg.forcedEntryIds) ? cfg.forcedEntryIds : [];
    var contextText = String(cfg.contextText || '');
    var matcher = global.miyaWorldbookMatcher;
    var entryMap = {};
    entries.forEach(function (entry) {
      if (entry && entry.id) entryMap[String(entry.id)] = entry;
    });
    var exists = {};
    matched.forEach(function (entry) {
      if (entry && entry.id) exists[String(entry.id)] = true;
    });

  /**
   * 条目两层开关：自身 + 所属分组。
   * 分组开关不改写条目 enabled，所以这里每次都实时问 store。
   */
  function entryActive(entry) {
    if (!entry || entry.enabled === false || !entry.id) return false;
    var store = global.miyaWorldbookStore;
    if (store && typeof store.isEntryGroupEnabled === 'function') {
      return store.isEntryGroupEnabled(entry);
    }
    return true;
  }

    function pushIfNeeded(entry) {
      if (!entryActive(entry)) return;
      var id = String(entry.id);
      if (exists[id]) return;
      if (matcher && typeof matcher.matchEntry === 'function') {
        if (!matcher.matchEntry(entry, {
          roleId: cfg.roleId,
          roleIds: cfg.roleIds,
          contextText: contextText,
          promptContext: cfg.promptContext
        })) return;
      }
      exists[id] = true;
      matched.push(entry);
    }

    function allowForcedReach(entry) {
      if (!matcher) return true;
      var reach = typeof matcher.getEntryGlobalReach === 'function'
        ? matcher.getEntryGlobalReach(entry)
        : '';
      if (typeof matcher.forceReachAllows === 'function') {
        return matcher.forceReachAllows(reach, cfg.promptContext);
      }
      return true;
    }

    bindings.forEach(function (binding) {
      if (!binding || typeof binding !== 'object') return;
      if (String(binding.type || '').trim() !== 'entry') return;
      var entry = entryMap[String(binding.entryId || binding.id || '').trim()];
      if (!entryActive(entry)) return;
      if (binding.force) {
        if (!allowForcedReach(entry)) return;
        var fid = String(entry.id);
        if (exists[fid]) return;
        exists[fid] = true;
        matched.push(entry);
        return;
      }
      pushIfNeeded(entry);
    });

    forcedIds.forEach(function (id) {
      var entry = entryMap[String(id || '').trim()];
      if (!entryActive(entry) || exists[String(entry.id)]) return;
      if (matcher && typeof matcher.matchEntry === 'function') {
        if (!matcher.matchEntry(entry, {
          roleId: cfg.roleId,
          roleIds: cfg.roleIds,
          contextText: contextText,
          promptContext: cfg.promptContext
        })) return;
      }
      exists[String(entry.id)] = true;
      matched.push(entry);
    });
    return matched;
  }

  function renderChronicleProfile(roleId) {
    var cs = global.miyaContactsStore;
    if (cs && typeof cs.renderChronicleBlock === 'function') {
      return cs.renderChronicleBlock(roleId);
    }
    return '';
  }

  function renderRelationshipBlock(roleId) {
    var rs = global.miyaContactsRelationshipStore;
    if (rs && typeof rs.buildPromptBlockForCharacterId === 'function') {
      return rs.buildPromptBlockForCharacterId(roleId);
    }
    return '';
  }

  /** 同一深度内：角色绑定排序 → 全软件 → 全局 → 局部 */
  function renderDepthSection(depth, rows, entryOrder, universalIdSet) {
    if (!rows || !rows.length) return '';
    var prefix = depthTitle(depth);
    var split = applyEntryOrder(rows, entryOrder);
    var orderedBlock = split.ordered.length
      ? renderBlock(prefix + '·设定', split.ordered)
      : '';
    var universalRows = [];
    var globalRows = [];
    var localRows = [];
    split.rest.forEach(function (entry) {
      if (!entry) return;
      var id = String(entry.id || '');
      if (universalIdSet && universalIdSet[id]) {
        universalRows.push(entry);
      } else if (String(entry.scope) === 'local') {
        localRows.push(entry);
      } else {
        globalRows.push(entry);
      }
    });
    return [
      orderedBlock,
      renderBlock(prefix + '·全软件设定', universalRows),
      renderBlock(prefix + '·全局设定', globalRows),
      renderBlock(prefix + '·局部设定', localRows)
    ].filter(Boolean).join('\n\n');
  }

  /**
   * 按注入位置分桶。
   *
   * ⚠️ position 是权威字段，depth 只是它的派生显示值。二者不可混用：
   *
   *   position=0/2 → front（角色定义前 / AN 前）
   *   position=1/3 → middle（角色定义后 / AN 后）
   *   position=4   → inChat（@深度，插进对话历史中间）
   *
   * 旧实现只看 entry.depth，而 position=4 归一化后 depth 会变成 "middle"
   * 或 "back"（取决于录入路线：UI 表单给 "back"，ST JSON 导入给 "middle"），
   * 于是同一条 @深度 词条从哪进来就往不同位置注入 —— 属于隐性的行为不一致。
   * 现在统一以 position 判定，两条录入路线结果一致。
   *
   * 注意 inChat 里的条目**不再进 back**（替换而非共存）：深度注入的语义
   * 就是「插进历史中间」，同时也塞进末尾会让同一内容在 prompt 里出现两次。
   */
  function partitionByDepth(entries) {
    var buckets = { front: [], middle: [], back: [], inChat: [] };
    (entries || []).forEach(function (entry) {
      if (!entry) return;
      if (Number(entry.position) === 4) {
        buckets.inChat.push(entry);
        return;
      }
      var d = normalizeDepth(entry.depth);
      buckets[d].push(entry);
    });
    return buckets;
  }

  /* 未显式配置预算时的默认值：**不裁剪**。
     ---------------------------------------------------------------
     这里曾经硬编码 2048。那是一处凭空而来的数字：既不是 ST 的原义
     （ST 默认关闭预算，由用户按需开启），也不来自 Miya 的任何设置项
     —— buildWorldbookBundle 的 opts.tokenBudget 全线没人传，
     applyStDecoration 的兜底同样写死 2048，于是它成了**实际生效且
     不可见、不可调**的隐形上限。

     后果是「命中了但注入不全」：6 条各 1200 字的词条约 4500 token，
     按 order 倒序贪心装入 2048 后只剩 2 条，另外 4 条进入 dropped[]。
     而主聊天链路上没有任何 UI 消费 dropped，用户只看到「命中 2 条」，
     无从判断是被裁了还是压根没匹配上。

     现在：没配置就不裁剪，把「要不要限流」的决定权交还使用者；
     真要限流，走 tokenBudget / budget 显式传入（ST 调试台即走此路）。 */
  var DEFAULT_BUDGET = Infinity;

  function resolveWorldbookBudget(cfg) {
    var c = cfg && typeof cfg === 'object' ? cfg : {};
    if (c.tokenBudget != null && Number(c.tokenBudget) > 0) return Number(c.tokenBudget);
    if (c.budget != null && Number(c.budget) > 0) return Number(c.budget);
    return DEFAULT_BUDGET;
  }

  function buildWorldbookPrompt(input) {
    var cfg = input && typeof input === 'object' ? input : {};
    var store = global.miyaWorldbookStore;
    var matcher = global.miyaWorldbookMatcher;
    if (!store || typeof store.listEntries !== 'function') {
      return { text: '', sections: {}, matched: [], matchedSummary: [] };
    }

    /* 允许调用方显式传入词条集合（预览/调试/单测用）。
       不传时仍以 store 为准 —— 保持线上行为完全不变。
       旧实现无条件读 store，导致外部传入的 entries 被静默忽略，
       「预览」与「实际注入」可能走的不是同一批词条。 */
    var entries = Array.isArray(cfg.entries)
      ? cfg.entries.slice()
      : store.listEntries();
    var scopeMode = String(cfg.scopeMode || '').trim();
    var promptContext = String(cfg.promptContext || '').trim();
    var universalOnly = cfg.universalOnly === true;
    var excludeSet = {};
    (Array.isArray(cfg.excludeEntryIds) ? cfg.excludeEntryIds : []).forEach(function (id) {
      var key = String(id || '').trim();
      if (key) excludeSet[key] = true;
    });
    function notExcluded(entry) {
      return entry && entry.id && !excludeSet[String(entry.id)];
    }
    var matchPool = entries;
    /* scopeMode === 'appointment'（线下会话）曾在此处把「未绑定角色的条目」
       整段滤出匹配池 —— 与 matcher 的判据正面冲突：
         · matcher.roleMatches()：未绑定角色 = 通用条目，对任何会话放行；
         · 诊断台 runDiag()：走 matcher，同样判「会注入」；
         · 线上链路（无 scopeMode）：matchPool = 全量，未绑定角色的词条正常命中。
       三处都放行的词条，唯独线下被这道过滤静默排除 —— 用户在世界书诊断里
       看到「会注入」，线下生成后「模型高级」却显示「世界书未命中」，
       两套判据各说各话。绑定角色与否的裁决权本就属于 matcher
       （绑定了其它角色 → roleMatches 拒绝；globalReach=online → 仅线上），
       prompt 层不应再加一道更严的暗门。故删除此过滤，线下与线上同权。 */
    var roleIds = Array.isArray(cfg.roleIds)
      ? cfg.roleIds.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
      : [];
    var roleId = String(cfg.roleId || '').trim();
    if (!roleIds.length && roleId) roleIds = [roleId];
    if (!roleId && roleIds.length) roleId = roleIds[0];
    var contextText = String(cfg.contextText || '');

    /* 「全软件层」= globalReach 为 all 的全局词条。
       注意：all 只表示「线上线下都生效」，**不等于无条件注入**。
       带关键词的 all 词条仍须关键词命中；只有无关键词（或 constant）的
       才天然常驻。此处拆成两组分别处理，避免关键词未命中的词条被强行注入。 */
    var allReachRows = matcher && typeof matcher.collectUniversalGlobalEntries === 'function'
      ? matcher.collectUniversalGlobalEntries(entries).filter(notExcluded)
      : [];
    /* ⚠️ 判据必须与 matcher 完全一致，禁止各写一份。
       历史教训：这里曾手写
           var k = Array.isArray(entry.key) && entry.key.length ? entry.key : (entry.keywords || []);
           return Array.isArray(k) && k.length > 0;      // 只看长度，不剔空串
       而 matcher.entryKeywords() 是 filter(Boolean) 后判长度。
       key=[''] 时两边结论相反：prompt 认为「有关键词」→ 丢进 keywordPool；
       matcher 认为「无关键词」→ 按常驻直接放行。
       最终该词条既不进常驻组，又不在关键词命中结果里，整条静默丢失，
       还会连带把同深度桶的其它词条一起吞掉。 */
    function entryHasKeys(entry) {
      if (matcher && typeof matcher.hasAnyKeywords === 'function') {
        return matcher.hasAnyKeywords(entry);
      }
      return false;
    }
    /* 无条件常驻：无关键词且非关键词触发态（或 constant） */
    var universalRows = allReachRows.filter(function (entry) {
      return entry.constant === true || !entryHasKeys(entry);
    });
    /* 其余 all 词条照常参与关键词匹配，只是命中后归入「全软件设定」分组 */
    var universalIdSet = {};
    allReachRows.forEach(function (entry) {
      if (entry && entry.id) universalIdSet[String(entry.id)] = true;
    });
    var universalBlock = renderBlock('全软件·全局设定', universalRows);

    if (universalOnly) {
      return {
        text: universalBlock,
        sections: { universal: universalBlock },
        matched: universalRows,
        matchedSummary: summarizeMatched(universalRows),
        globalCount: 0,
        localCount: 0,
        universalCount: universalRows.length
      };
    }

    var excludeFromKeyword = {};
    universalRows.forEach(function (entry) {
      if (entry && entry.id) excludeFromKeyword[String(entry.id)] = true;
    });
    var keywordPool = matchPool.filter(function (entry) {
      return entry && entry.id && !excludeFromKeyword[String(entry.id)] && notExcluded(entry);
    });

    var includeProfile = cfg.skipChronicleProfile !== true && cfg.layersOnly !== true;
    var profileBlock = includeProfile ? renderChronicleProfile(roleId) : '';
    var relationBlock = includeProfile ? renderRelationshipBlock(roleId) : '';
    /* 【W2 修复】准入判定归 matcher，ST 只做增量裁决。
       历史问题：useStPipeline 开启时把 keywordMatched 硬置为空，导致
       「全局+online/offline」「局部+绑定角色但无关键词」等词条在进入 ST 之前
       就已被丢弃；而 ST 的世界观里没有 Miya 的 scope / globalReach 概念，
       即便放行也会被 ST 的 activateEntries 按「非常驻且无关键词」二次筛掉。
       现在：matcher 负责「要不要用」，ST 负责「用了之后怎么排和裁」。 */
    var st = global.miyaWorldbookST;
    var keywordMatched = matcher && typeof matcher.matchEntries === 'function'
      ? matcher.matchEntries({
          roleId: roleId,
          roleIds: roleIds,
          contextText: contextText,
          promptContext: promptContext,
          entries: keywordPool
        })
      : { matched: [], global: [], local: [] };

    var merged = mergeForcedMatches({
      matched: (keywordMatched.matched || []).filter(notExcluded),
      entries: entries,
      bindings: Array.isArray(cfg.extraBindings) ? cfg.extraBindings : [],
      forcedEntryIds: cfg.forcedEntryIds || cfg.entryIds || [],
      contextText: contextText,
      roleId: roleId,
      roleIds: roleIds,
      promptContext: promptContext
    }).filter(notExcluded);

    // 全软件词条仍始终纳入匹配，但按各自 depth 注入，不再强制顶置
    universalRows.forEach(function (entry) {
      if (!entry || !entry.id) return;
      var id = String(entry.id);
      if (merged.some(function (m) { return m && String(m.id) === id; })) return;
      merged.push(entry);
    });

    /* ST 增量裁决：概率掷骰 + 分组互斥 + token 预算。
       不再调用 runPipeline —— 那会用 ST 语义重新裁决「要不要注入」，
       把 Miya 的生效范围语义（scope / globalReach）覆盖掉。
       （sticky/cooldown/delay 见下方说明，本项目未实现） */
    var budgetMeta = null;
    /* 进入 ST 裁决前的候选总数：即 Miya matcher 判定「应当注入」的词条数
       （含 universalRows 合流之后）。面板据此把账说全：
       候选 N → 命中 M → 实际注入 K，K < M 时差额就是被裁的。 */
    var consideredCount = merged.length;
    if (st && typeof st.applyStDecoration === 'function') {
      var budget = resolveWorldbookBudget(cfg);
      var dec = st.applyStDecoration(merged, {
        contextText: contextText,
        messages: cfg.messages,
        scanDepth: cfg.scanDepth,
        tokenBudget: budget,
        chatId: cfg.chatId,
        dryRun: !!cfg.dryRun
      });
      merged = (dec.selected || []).slice();
      budgetMeta = {
        usedTokens: dec.usedTokens,
        budgetTokens: dec.budgetTokens,
        dropped: dec.dropped,
        debug: dec.debug
      };
    } else if (st && typeof st.applyTokenBudget === 'function') {
      /* 兜底：ST 模块版本较旧、无 applyStDecoration 时，至少保住 token 预算能力 */
      var budget2 = resolveWorldbookBudget(cfg);
      var bud = st.applyTokenBudget(merged, budget2);
      merged = bud.entries;
      budgetMeta = { usedTokens: bud.usedTokens, budgetTokens: bud.budgetTokens, dropped: bud.dropped };
    }

    var entryOrder = Array.isArray(cfg.entryOrder)
      ? cfg.entryOrder.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
      : [];

    var buckets = partitionByDepth(merged);
    var frontBlock = renderDepthSection('front', buckets.front, entryOrder, universalIdSet);
    var middleBlock = renderDepthSection('middle', buckets.middle, entryOrder, universalIdSet);
    var backBlock = renderDepthSection('back', buckets.back, entryOrder, universalIdSet);

    /*
     * @深度 条目以**结构化数组**透出，不参与上面的文本块拼接。
     *
     * 原因：深度注入要逐条插进对话历史的不同位置，必须保留每条自己的
     * depth / order；一旦提前拼成一个大字符串，这些信息就丢了。
     *
     * 每条渲染成独立文本块（复用 renderBlock，保持与其它桶同样的
     * 「【标题】+ 正文」格式），由 engine 层的插入函数决定落点。
     */
    var inChatItems = (buckets.inChat || []).map(function (entry) {
      var depth = Number(entry.injection_depth);
      if (!Number.isFinite(depth) || depth < 0) depth = 0;
      var order = Number(entry.order);
      if (!Number.isFinite(order)) order = 100;
      return {
        id: String(entry.id || ''),
        content: renderBlock('世界书·深度注入', [entry]),
        depth: depth,
        order: order
      };
    }).filter(function (item) { return !!item.content; });

    // 兼容旧字段：未按深度拆分时的合集视图
    var legacySplit = applyEntryOrder(merged, entryOrder);
    var orderedBlock = legacySplit.ordered.length
      ? renderBlock('设定', legacySplit.ordered)
      : '';
    var globalRows = [];
    var localRows = [];
    legacySplit.rest.forEach(function (entry) {
      if (String(entry.scope) === 'local') localRows.push(entry);
      else globalRows.push(entry);
    });
    var globalBlock = renderBlock('全局设定', globalRows);
    var localBlock = renderBlock('局部设定', localRows);

    var joined = [
      profileBlock,
      relationBlock,
      frontBlock,
      middleBlock,
      backBlock
    ].filter(Boolean).join('\n\n');

    return {
      text: joined,
      sections: {
        profile: profileBlock,
        relations: relationBlock,
        universal: '',
        front: frontBlock,
        middle: middleBlock,
        back: backBlock,
        ordered: orderedBlock,
        global: globalBlock,
        local: localBlock
      },
      matched: merged,
      matchedSummary: summarizeMatched(merged),
      /* @深度 条目：结构化透出，供 engine 层插进对话历史。
         不进 text / sections —— 那些是「拼成一段」的消费方式，
         深度注入必须逐条定位。 */
      inChatItems: inChatItems,
      globalCount: globalRows.length,
      localCount: localRows.length,
      orderedCount: legacySplit.ordered.length,
      universalCount: universalRows.length,
      frontCount: buckets.front.length,
      middleCount: buckets.middle.length,
      backCount: buckets.back.length,
      inChatCount: buckets.inChat.length,
      budget: budgetMeta,
      consideredCount: consideredCount
    };
  }

  global.miyaWorldbookPrompt = {
    buildWorldbookPrompt: buildWorldbookPrompt,
    normalizeDepth: normalizeDepth
  };
  global.miyaBuildWorldbookPrompt = buildWorldbookPrompt;
})(window);
