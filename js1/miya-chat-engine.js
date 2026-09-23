(function (global) {
    'use strict';

    var HISTORY_LIMIT = 40;
    var USER_MSG_JOIN = ' / ';
    var THINKING_EXTRACT_SEQ = [
        /<thinking>([\s\S]*?)<\/thinking>/i,
        /＜thinking＞([\s\S]*?)＜\/thinking＞/i,
        /\<think\>([\s\S]*?)<\/think>/i,
        /<think>([\s\S]*?)<\/think>/i,
        /<think>([\s\S]*?)<\/redacted_thinking>/i,
        /<redacted_thinking>([\s\S]*?)<\/think>/i,
        /＜think＞([\s\S]*?)＜\/think＞/i,
        /<reasoning>([\s\S]*?)<\/reasoning>/i
    ];

    var THINKING_CLOSE_PATTERNS = [
        /<\/thinking>/gi,
        /＜\/thinking＞/gi,
        /\[\/thinking\]/gi,
        /［\/thinking］/gi,
        /【\/thinking】/gi,
        /<\/think>/gi,
        /＜\/think＞/gi,
        /\[\/think\]/gi,
        /<\/redacted_thinking>/gi,
        /<\/reasoning>/gi
    ];

    function isSemanticAutoTranslate(s) {
        return !!(s && s.autoTranslate);
    }

    function getTranslateTargetFromSettings(s) {
        var tr = global.MiyaChatTranslate;
        if (tr && typeof tr.normalizeTargetCode === 'function') {
            return tr.normalizeTargetCode(s && s.translateTarget);
        }
        return 'zh-CN';
    }

    function normalizeBaseUrl(base) {
        var t = String(base || '').trim().replace(/\/+$/, '');
        if (!t) return '';
        try {
            var u = new URL(t);
            var path = (u.pathname || '/').replace(/\/+$/, '');
            var segs = path.split('/').filter(Boolean);
            if (segs.length && segs[segs.length - 1].toLowerCase() === 'v1') {
                return u.origin + path;
            }
            if (!path || path === '/') return u.origin + '/v1';
            return u.origin + path + '/v1';
        } catch (e) {
            return t.toLowerCase().endsWith('/v1') ? t : t + '/v1';
        }
    }

    function getApiConfig() {
        if (typeof global.miyaGetApiConfigCached === 'function') return global.miyaGetApiConfigCached();
        if (typeof global.miyaGetApiConfigCached === 'function') return global.miyaGetApiConfigCached();
        return {};
    }

    function getGlobalPrompt() {
        if (typeof global.miyaGetGlobalBreakPrompt === 'function') {
            return String(global.miyaGetGlobalBreakPrompt() || '').trim();
        }
        try {
            return String(localStorage.getItem('miya-global-break-prompt') || '').trim();
        } catch (e) {
            return '';
        }
    }

  function renderChronicleBlock(contact, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var cs = global.miyaContactsStore;
    if (!cs || !contact) return '';
    var rid = String(contact.characterId || contact.id || contact.chronicleId || '').trim();
    if (rid && typeof cs.renderChronicleBlock === 'function') {
      var fromStore = String(cs.renderChronicleBlock(rid, opts) || '').trim();
      if (fromStore) return fromStore;
    }
    var row = cs.findCharacter ? cs.findCharacter(rid) : null;
    if (!row) return '';
    var lines = ['【角色·档案·' + String(row.name || contact.name) + '】'];
    if (row.gender) lines.push('- 性别: ' + row.gender);
    if (row.age) lines.push('- 年龄: ' + row.age);
    if (row.birthday) lines.push('- 生日: ' + row.birthday);
    if (row.persona) lines.push('- 人设与背景: ' + row.persona);
    /* 开场白只在第一楼注入，兜底分支要与 store 版保持一致 */
    if (opts.includeGreetings) {
      var g = (row.greetings || []).filter(function (x) { return String(x || '').trim(); });
      if (g.length) lines.push('- 开场白（本次对话的开场，供你把握语气与场景）: ' + g[0]);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

    function renderProfileBlock(profile) {
        if (!profile) return '';
        var lines = ['【用户身份·我方·' + String(profile.name || '未命名') + '】'];
        if (profile.gender) lines.push('- 性别: ' + profile.gender);
        if (profile.birthday) lines.push('- 生日: ' + profile.birthday);
        if (profile.persona) lines.push('- 人设: ' + profile.persona);
        return lines.length > 1 ? lines.join('\n') : '';
    }

    function buildAvatarRecognitionBlock(chatSettings, contact, profile) {
        var ar = chatSettings && chatSettings.avatarRecognition;
        if (!ar || !ar.enabled) return '';
        var contactDesc = String(ar.contactDesc || '').trim();
        var profileDesc = String(ar.profileDesc || '').trim();
        var hasContactImg = !!String(ar.contactImageId || '').trim();
        var hasProfileImg = !!String(ar.profileImageId || '').trim();
        if (!contactDesc && !profileDesc && !hasContactImg && !hasProfileImg) return '';
        var roleName = String((contact && contact.name) || '对方').trim() || '对方';
        var userName = String((profile && profile.name) || '用户').trim() || '用户';
        var lines = ['【双方通话形象】'];
        if (hasContactImg) lines.push('- ' + roleName + '（角色）已上传通话形象参考图，按图呈现。');
        else if (contactDesc) lines.push('- ' + roleName + '（角色）通话形象: ' + contactDesc);
        if (hasProfileImg) lines.push('- ' + userName + '（用户）已上传通话形象参考图，按图呈现。');
        else if (profileDesc) lines.push('- ' + userName + '（用户）通话形象: ' + profileDesc);
        lines.push('请在对白与叙述中与此外观设定保持一致；双方形象已设定，勿随意改写外貌。');
        return lines.join('\n');
    }

    function appendDynamicAvatarContextBlock(parts, chatSettings, contact, profile) {
        if (
            !global.MiyaChatDynamicAvatar ||
            typeof global.MiyaChatDynamicAvatar.buildChatAvatarContextBlock !== 'function'
        ) {
            return;
        }
        var dynAvBlock = global.MiyaChatDynamicAvatar.buildChatAvatarContextBlock(
            chatSettings,
            contact,
            profile
        );
        if (dynAvBlock) parts.push(dynAvBlock);
    }

    function appendAlbumContextBlock(parts, profile, contact, chatSettings) {
        if (!global.MiyaChatAlbum || typeof global.MiyaChatAlbum.buildAlbumContextBlock !== 'function') {
            return;
        }
        var pid = profile && profile.id ? String(profile.id) : '';
        if (!pid) return;
        var cid = contact && contact.id ? String(contact.id) : '';
        var dynAv = (chatSettings && chatSettings.dynamicAvatar) || {};
        var block = global.MiyaChatAlbum.buildAlbumContextBlock(pid, cid, {
            charAvatarSwapEnabled: !!dynAv.charEnabled,
            userAvatarSwapEnabled: !!dynAv.userEnabled
        });
        if (block) parts.push(block);
    }

    function collectContactRoleIds(contact) {
        if (!contact) return [];
        var ordered = [];
        var seen = {};
        function add(v) {
            v = String(v || '').trim();
            if (!v || seen[v]) return;
            seen[v] = true;
            ordered.push(v);
        }
        add(contact.characterId);
        add(contact.chronicleId);
        var cs = global.miyaContactsStore;
        if (cs && typeof cs.findCharacter === 'function') {
            var row =
                cs.findCharacter(contact.characterId) ||
                cs.findCharacter(contact.chronicleId);
            if (row) {
                add(row.characterId);
                add(row.id);
            }
        }
        if (!ordered.length && contact.name && cs && typeof cs.listCharacters === 'function') {
            var wantName = String(contact.name || '').trim();
            cs.listCharacters().forEach(function (row) {
                if (String(row.name || '').trim() === wantName) {
                    add(row.characterId);
                    add(row.id);
                }
            });
        }
        return ordered;
    }

    function normalizeWorldbookExtraBindings(extraBindings) {
        if (!Array.isArray(extraBindings)) return [];
        return extraBindings
            .map(function (b) {
                if (!b || typeof b !== 'object') return null;
                var entryId = String(b.entryId || b.id || '').trim();
                if (!entryId) return null;
                return {
                    type: 'entry',
                    entryId: entryId,
                    force: b.force !== false
                };
            })
            .filter(Boolean);
    }

    /** 该角色绑定的全部局部世界书词条（强制注入，不依赖关键词命中） */
    function collectBoundLocalWorldbookBindings(contact) {
        var order = resolveContactWorldbookEntryOrder(contact, null);
        return collectBoundLocalBindingsForRoleIds(collectContactRoleIds(contact), order);
    }

    function collectBoundLocalBindingsForRoleIds(roleIds, entryOrder) {
        var wb = global.miyaWorldbookStore;
        var matcher = global.miyaWorldbookMatcher;
        if (!wb || typeof wb.listEntries !== 'function') return [];
        var ids = Array.isArray(roleIds)
            ? roleIds.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
            : [];
        if (!ids.length) return [];
        var cfg = { roleId: ids[0], roleIds: ids, contextText: '' };
        var bindings = wb.listEntries()
            .filter(function (entry) {
                if (!entry || entry.enabled === false) return false;
                var bound = Array.isArray(entry.boundRoleIds) ? entry.boundRoleIds : [];
                if (!bound.length) return false;
                if (matcher && typeof matcher.roleMatches === 'function') {
                    return matcher.roleMatches(entry, cfg);
                }
                return bound.some(function (bid) {
                    return ids.indexOf(String(bid || '').trim()) >= 0;
                });
            })
            .map(function (entry) {
                var keywords = Array.isArray(entry.keywords) ? entry.keywords.filter(Boolean) : [];
                var reach = matcher && typeof matcher.getEntryGlobalReach === 'function'
                    ? matcher.getEntryGlobalReach(entry)
                    : '';
                return {
                    type: 'entry',
                    entryId: String(entry.id),
                    // 全软件：强制纳入；无关键词：仍强制（跳过关键词，但受生效范围约束）
                    force: keywords.length === 0 || reach === 'all'
                };
            });
        return sortBindingsByEntryOrder(bindings, entryOrder);
    }

    function buildUniversalWorldbookTopLayer() {
        var builder = global.miyaWorldbookPrompt || global.miyaBuildWorldbookPrompt;
        if (!builder || typeof builder.buildWorldbookPrompt !== 'function') return '';
        var result = builder.buildWorldbookPrompt({ universalOnly: true });
        var sec = result && result.sections ? result.sections : {};
        return String(sec.universal || result && result.text || '').trim();
    }

    /** 侧路摘要/记忆等仍可用：仅注入「全软件」范围词条（与聊天深度槽无关） */
    function prependUniversalWorldbookMessage(apiMessages) {
        var layer = buildUniversalWorldbookTopLayer();
        if (!layer) return apiMessages;
        var msgs = Array.isArray(apiMessages) ? apiMessages.slice() : [];
        if (msgs.some(function (m) {
            return m && m.role === 'system' && String(m.content || '').indexOf(layer) >= 0;
        })) {
            return msgs;
        }
        msgs.unshift({ role: 'system', content: layer });
        return msgs;
    }

    function normalizeLayerList(list) {
        if (!Array.isArray(list)) return [];
        return list
            .map(function (x) {
                return String(x || '').trim();
            })
            .filter(Boolean);
    }

    function appendLayerList(parts, layers) {
        normalizeLayerList(layers).forEach(function (layer) {
            parts.push(layer);
        });
        return parts;
    }

    function appendWorldbookBackMessages(apiMessages, backLayers) {
        if (!Array.isArray(apiMessages)) return;
        normalizeLayerList(backLayers).forEach(function (layer) {
            apiMessages.push({ role: 'system', content: layer });
        });
    }

    /**
     * 深度注入：把 @深度 词条插进对话历史的指定位置。
     *
     * ST 语义：depth = 「从末尾往回数第几条」
     *   depth=0 → 最后一条之后（= 追加到末尾）
     *   depth=1 → 最后一条之前
     *   depth=2 → 倒数第二条之前，依此类推
     *
     * ⚠️ 必须**从深到浅**插入（depth 大的先插）。反过来会让先插的条目
     * 把后续索引整体推后，所有位置算错。
     * 这个 bug 的阴险之处在于：当所有条目 depth 相同、或 history 很短时，
     * 结果看起来是对的 —— 属于「测了但没测到」的典型坑。
     * 所以排序必须显式写死，且要有专门的单元测试盯着。
     *
     * 同 depth 时按 order 升序（低 order 在前），与 worldbook-st.js 里
     * applyTokenBudget 的既有约定保持一致。
     *
     * depth 越界（大于历史条数）时钳到开头，**不丢弃内容** ——
     * 位置不准是可接受的，内容静默消失不可接受。
     */
    function insertWorldbookInChatMessages(apiMessages, inChatItems) {
        if (!Array.isArray(apiMessages)) return;
        var items = Array.isArray(inChatItems) ? inChatItems.filter(Boolean) : [];
        if (!items.length) return;

        var sorted = items.slice().sort(function (a, b) {
            var da = Number(a.depth);
            var db = Number(b.depth);
            if (!Number.isFinite(da)) da = 0;
            if (!Number.isFinite(db)) db = 0;
            if (db !== da) return db - da;                       /* 深的先插 */
            var oa = Number(a.order); if (!Number.isFinite(oa)) oa = 100;
            var ob = Number(b.order); if (!Number.isFinite(ob)) ob = 100;
            return oa - ob;                                      /* 同深度：低 order 在前 */
        });

        sorted.forEach(function (item) {
            var text = String(item && item.content != null ? item.content : '');
            if (!text) return;
            var depth = Number(item.depth);
            if (!Number.isFinite(depth) || depth < 0) depth = 0;
            var idx = apiMessages.length - depth;
            if (idx < 0) idx = 0;                                 /* 越界钳到开头，不丢内容 */
            if (idx > apiMessages.length) idx = apiMessages.length;
            apiMessages.splice(idx, 0, { role: 'system', content: text });
        });
    }

    /** 深潜/单块上下文：按 前→中→后 拼成一段 */
    function joinWorldbookBundleText(bundle) {
        if (!bundle || typeof bundle !== 'object') return '';
        return []
            .concat(
                normalizeLayerList(bundle.frontLayers),
                normalizeLayerList(bundle.layers),
                normalizeLayerList(bundle.backLayers)
            )
            .join('\n\n')
            .trim();
    }

    function mergeWorldbookExtraBindings(extraBindings, more) {
        var out = normalizeWorldbookExtraBindings(extraBindings).slice();
        var seen = {};
        out.forEach(function (b) {
            seen[b.entryId] = true;
        });
        normalizeWorldbookExtraBindings(more).forEach(function (b) {
            if (seen[b.entryId]) return;
            seen[b.entryId] = true;
            out.push(b);
        });
        return out;
    }

    function sortBindingsByEntryOrder(bindings, orderIds) {
        if (!Array.isArray(bindings) || !bindings.length) return bindings || [];
        if (!Array.isArray(orderIds) || !orderIds.length) return bindings.slice();
        var rank = {};
        orderIds.forEach(function (id, i) {
            var key = String(id || '').trim();
            if (key) rank[key] = i;
        });
        return bindings.slice().sort(function (a, b) {
            var ra = rank[a.entryId];
            var rb = rank[b.entryId];
            var ha = ra !== undefined;
            var hb = rb !== undefined;
            if (ha && hb) return ra - rb;
            if (ha) return -1;
            if (hb) return 1;
            return 0;
        });
    }

    function listSortableWorldbookEntriesForContact(contact) {
        var wb = global.miyaWorldbookStore;
        var matcher = global.miyaWorldbookMatcher;
        if (!wb || typeof wb.listEntries !== 'function') return [];
        var roleIds = collectContactRoleIds(contact);
        var cfg = { roleId: roleIds[0] || '', roleIds: roleIds };
        var out = [];
        var seen = {};
        function push(entry) {
            if (!entry || !entry.id || seen[String(entry.id)]) return;
            seen[String(entry.id)] = true;
            out.push(entry);
        }
        wb.listEntries().forEach(function (entry) {
            if (!entry || entry.enabled === false) return;
            if (String(entry.scope) === 'local') {
                if (!roleIds.length) return;
                var bound = Array.isArray(entry.boundRoleIds) ? entry.boundRoleIds : [];
                if (!bound.length) return;
                if (matcher && typeof matcher.roleMatches === 'function') {
                    if (matcher.roleMatches(entry, cfg)) push(entry);
                    return;
                }
                if (bound.some(function (bid) {
                    return roleIds.indexOf(String(bid || '').trim()) >= 0;
                })) push(entry);
                return;
            }
            push(entry);
        });
        return out;
    }

    function collectSortableWorldbookEntryIdsForContact(contact) {
        return listSortableWorldbookEntriesForContact(contact).map(function (entry) {
            return String(entry.id);
        });
    }

    function resolveContactWorldbookEntryOrder(contact, opts) {
        if (opts && Array.isArray(opts.entryOrder) && opts.entryOrder.length) {
            return filterWorldbookEntryOrderForContact(
                contact,
                opts.entryOrder.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
            );
        }
        if (!contact || !Array.isArray(contact.worldbookEntryOrder)) return [];
        return filterWorldbookEntryOrderForContact(contact, contact.worldbookEntryOrder);
    }

    function filterWorldbookEntryOrderForContact(contact, orderIds) {
        var allowed = {};
        collectSortableWorldbookEntryIdsForContact(contact).forEach(function (id) {
            allowed[id] = true;
        });
        return (Array.isArray(orderIds) ? orderIds : [])
            .map(function (x) { return String(x || '').trim(); })
            .filter(function (id) { return id && allowed[id]; });
    }

    function ensureWorldbookDepsReady() {
        if (global.miyaBootstrapKvStores) {
            return global.miyaBootstrapKvStores();
        }
        var chain = Promise.resolve();
        var wb = global.miyaWorldbookStore;
        var cs = global.miyaContactsStore;
        if (wb && typeof wb.whenReady === 'function') {
            chain = chain.then(function () {
                return wb.whenReady();
            });
        }
        if (cs && typeof cs.whenReady === 'function') {
            chain = chain.then(function () {
                return cs.whenReady();
            });
        }
        return chain;
    }

    function sumLayerChars(layers) {
        if (!Array.isArray(layers)) return 0;
        return layers.reduce(function (n, layer) {
            return n + String(layer || '').length;
        }, 0);
    }

    function buildWorldbookBundle(contact, contextText, extraBindings, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var builder = global.miyaWorldbookPrompt || global.miyaBuildWorldbookPrompt;
        var empty = {
            universalLayer: '',
            frontLayers: [],
            layers: [],
            backLayers: [],
            matched: [],
            meta: { matched: 0, chars: 0, injectedChars: 0, matchedContentChars: 0, emptyMatched: 0, roleIds: [] }
        };
        if (!builder || typeof builder.buildWorldbookPrompt !== 'function') return empty;
        if (opts.universalOnly) {
            var universalOnly = String(buildUniversalWorldbookTopLayer() || '').trim();
            return {
                universalLayer: universalOnly,
                frontLayers: universalOnly ? [universalOnly] : [],
                layers: [],
                backLayers: [],
                matched: [],
                meta: Object.assign({}, empty.meta, {
                    universalChars: universalOnly.length,
                    chars: universalOnly.length,
                    injectedChars: universalOnly.length
                })
            };
        }
        var roleIds = Array.isArray(opts.roleIds) && opts.roleIds.length
            ? opts.roleIds.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
            : collectContactRoleIds(contact);
        var entryOrder = resolveContactWorldbookEntryOrder(contact, opts);
        var bindings = normalizeWorldbookExtraBindings(extraBindings);
        if (opts.includeAllBoundLocal) {
            bindings = mergeWorldbookExtraBindings(
                bindings,
                collectBoundLocalBindingsForRoleIds(roleIds, entryOrder)
            );
        }
        bindings = sortBindingsByEntryOrder(bindings, entryOrder);
        var promptContext = String(opts.promptContext || '').trim();
        var excludeEntryIds = Array.isArray(opts.excludeEntryIds) ? opts.excludeEntryIds : [];
        var result = builder.buildWorldbookPrompt({
            roleId: roleIds[0] || '',
            roleIds: roleIds,
            roleName: contact && contact.name,
            contextText: contextText || '',
            messages: opts.messages,
            skipChronicleProfile: true,
            extraBindings: bindings,
            scopeMode: String(opts.scopeMode || '').trim(),
            promptContext: promptContext,
            excludeEntryIds: excludeEntryIds,
            entryOrder: entryOrder,
            chatId: opts.chatId || '',
            tokenBudget: opts.tokenBudget,
            dryRun: !!opts.dryRun
        });
        var sec = result && result.sections ? result.sections : {};
        var frontLayers = normalizeLayerList([sec.front]);
        var layers = normalizeLayerList([sec.middle]);
        var backLayers = normalizeLayerList([sec.back]);
        // 旧字段回退：若深度段皆空，退回 ordered/global/local
        if (!frontLayers.length && !layers.length && !backLayers.length) {
            layers = normalizeLayerList([sec.ordered, sec.global, sec.local]);
            if (!layers.length && result && result.text) {
                var fullText = String(result.text || '').trim();
                if (fullText) layers = [fullText];
            }
        }
        var matched = result && Array.isArray(result.matched) ? result.matched : [];
        var injectedChars =
            sumLayerChars(frontLayers) + sumLayerChars(layers) + sumLayerChars(backLayers);
        var matchedContentChars = 0;
        var emptyMatched = 0;
        matched.forEach(function (entry) {
            var n = String((entry && entry.content) || '').trim().length;
            if (n) matchedContentChars += n;
            else emptyMatched += 1;
        });
        return {
            universalLayer: '',
            frontLayers: frontLayers,
            layers: layers,
            backLayers: backLayers,
            /*
             * 深度注入条目必须以**结构化数组**继续往下传，不能并进 backLayers。
             * 每项带各自的 injection_depth / order，engine 才知道插到第几条之前；
             * 一旦被拼成文本块，位置信息就没了。
             *
             * ⚠️ 曾经漏了这一行 —— buildWorldbookPrompt 已经产出 inChatItems，
             *    但本函数没把它挑出来，于是调用方拿到的 wbBundle.inChatItems
             *    恒为 undefined，insertWorldbookInChatMessages 空转。
             *    单元测试直接调插入函数，测不到这个断裂；集成测试才抓得到。
             */
            inChatItems: Array.isArray(result && result.inChatItems) ? result.inChatItems : [],
            matched: matched,
            meta: {
                matched: matched.length,
                chars: injectedChars,
                injectedChars: injectedChars,
                matchedContentChars: matchedContentChars,
                emptyMatched: emptyMatched,
                roleIds: roleIds,
                promptContext: promptContext,
                universalCount: result && result.universalCount ? result.universalCount : 0,
                frontCount: result && result.frontCount ? result.frontCount : frontLayers.length,
                middleCount: result && result.middleCount ? result.middleCount : layers.length,
                backCount: result && result.backCount ? result.backCount : backLayers.length,
                inChatCount: result && result.inChatCount ? result.inChatCount : 0,
                matchedSummary: result && result.matchedSummary ? result.matchedSummary : [],
                /* 预算裁决的账本透出：命中多少、最终留下多少、被裁掉哪些。
                   以前这里只往上传 matched.length，dropped 被丢在
                   result.budget 里无人消费 —— 用户看到「命中 2 条」时
                   没有任何线索判断是被预算裁了还是压根没匹配上。
                   这里带上去，让面板能把话说完整。 */
                budgetDropped: result && result.budget && Array.isArray(result.budget.dropped)
                    ? result.budget.dropped : [],
                budgetDroppedCount: result && result.budget && Array.isArray(result.budget.dropped)
                    ? result.budget.dropped.length : 0,
                budgetTokens: result && result.budget ? result.budget.budgetTokens : null,
                budgetUsedTokens: result && result.budget ? result.budget.usedTokens : 0,
                consideredCount: result && Number(result.consideredCount) ? Number(result.consideredCount) : 0
            }
        };
    }

    function buildWorldbookLayers(contact, contextText, opts) {
        return buildWorldbookBundle(contact, contextText, null, Object.assign({
            promptContext: 'online',
            includeAllBoundLocal: true
        }, opts && typeof opts === 'object' ? opts : {})).layers;
    }

    function buildChatModeBlock(contact, profile) {
        return (
            '【对话模式·线上单聊】\n' +
            '你正在以「' +
            String((contact && contact.name) || '对方') +
            '」的身份，与「' +
            String((profile && profile.name) || '用户') +
            '」进行二人私聊（即时通讯），不是群聊。\n' +
            '- 语气需要自然、口语化，模拟真人发微信，不要油腻；根据人设与情绪善用 emoji、表情包、颜文字、标点节奏（…！！？？等）\n' +
            '- 【单聊硬性边界】必须遵守下文「运转规则」「线上格式规则」：每轮 <thinking> → 正文 → <miyavoice> 三段式\n' +
            '- 【用户消息】用户普通文字无前缀；连发多条时以「 / 」分隔（仅分隔符，非正文）；引用时一次只能引用其中一条，勿把多条拼进同一行「引用-」；仅上下文里以「语音-」开头的才是语音条，勿把普通文字当语音回应\n' +
            '- 【禁止混用群聊格式】正文禁止「角色名：」多角色格式；群聊摘录/记忆仅作剧情参考，不得把群聊输出格式带入本单聊\n' +
            '- 提示词顺序：全局 → 用户身份 → 关系 → 世界书 → 线上格式 → … → 联系人档案 → 思维链 → 运转规则（置末，紧挨生成前）'
        );
    }

    function buildPrivateChatScopeFence() {
        return (
            '【场景锁定·单聊】\n' +
            '当前请求仅适用于本单聊线程：禁止套用群聊「角色名：」格式；禁止输出群聊专用格式。'
        );
    }

    var ONLINE_THREE_PART_TAIL =
        '仍须严格按顺序输出：<thinking>…</thinking> → 正文（每行一气泡，每条必须换行分隔，禁止空格/标点挤一行）→ <miyavoice>…</miyavoice>；正文只输出一遍，禁止先写草稿再复读；用户只能看到 </thinking> 与 <miyavoice> 之间；必须按照要求完整输出 miyavoice 模块（开闭标签与全部心声字段均不可缺），禁止省略思维链或心声、禁止截断心声、禁止挤成无换行的一大段。';

    function buildOnlineProactiveTailNudge() {
        return '（请主动发一条新消息：先读全上文带时间戳的历史；从对话最新状态续聊；默认勿报时；' + ONLINE_THREE_PART_TAIL + '）';
    }

    function buildAssistantContinueTailNudge(opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var llTail = global.MiyaChatLifeLike;
        var nextPushTail =
            opts.isLifeLike && llTail && llTail.TAG_OPEN && llTail.TAG_CLOSE
                ? '；全文最末另起一行输出 ' + llTail.TAG_OPEN + 'YYYY-MM-DD HH:mm' + llTail.TAG_CLOSE
                : '';
        return (
            '（末条是你方发言：主动轮请自然衔接上文末尾几条并兼顾时间间隔；禁止把用户上一轮当必答；勿催回/抱怨没回；' +
            ONLINE_THREE_PART_TAIL +
            nextPushTail +
            '）'
        );
    }

    function buildManualContinueTailNudge() {
        return (
            '（上下文中末条为你方发言、用户尚未回复：禁止重答用户旧话；须从你方最近一条自然续写或推进；' +
            ONLINE_THREE_PART_TAIL +
            '；禁止群聊「角色名：」多角色格式）'
        );
    }

    function buildManualReplyToUserTailNudge() {
        return '（' + buildManualReplyToUserTailNudgeInline() + '）';
    }

    /*
     * ── 重回的「改写」约束 ──
     *
     * 为什么需要这一段（用户报的原话）：
     *   「把角色发来的消息删掉，重新生成，还是会生成一模一样的消息」
     *
     * 根因：重新生成时，**上下文和采样参数与首发逐字相同** ——
     *   · temperature 只取自 ST 生成设置，没有 isRegenerate 分支
     *   · 请求体里没有 seed / repeat_penalty 之类的差异化字段
     *   · 原本这条 nudge 只说「重新生成本轮回复」，**没说「别跟上一次一样」**
     *
     * 输入相同 + 采样相同 ⇒ 输出趋同是数学上的必然，不是模型偷懒。
     *
     * ── 关于「换一个切入角度」的歧义（用户第二次反馈）──
     *
     * 用户原话：「『换个说法』这句话有歧义 是同一个意思换个说法还是换一种别的」
     *
     * 这个质疑是对的。原措辞只说「换一个切入角度」，模型完全可能理解成
     * 「同一个意思换套词」（同义改写），而不是「换一个回应的方向」。
     * 这两种理解差别很大：
     *   · 同义改写 → 用户看到的还是同一句话，等于没改
     *   · 换方向   → 才是用户真正想要的
     *
     * 所以这里改成**明确排他**的表述：先排除「只换词」这条歧义读法，
     * 再给出具体可执行的换法。宁可啰嗦一点，也不要让模型猜。
     *
     * 措辞上的几个约束（都踩过或推演过）：
     *   1. 必须要求「保持人设与剧情一致」—— 否则模型容易为了不一样
     *      而硬拗出不符合角色的反应，尤其冷硬人设会被写得跳脱。
     *   2. 禁止「解释自己在改写」—— 否则模型可能输出
     *      「那我换种说法……」这类元叙述，直接漏进气泡里。
     *   3. 只要求换角度，不要求换话题 —— 避免偏题。
     *   4. 长度不做硬性要求 —— 强行要求「更长/更短」会让长短
     *      这件小事喧宾夺主，反而不自然。
     */
    function buildRegenerateTailNudge(lastReplyText) {
        var prev = String(lastReplyText || '').trim();
        /*
         * 把上一版原文**直接引用**出来，比抽象地说「你上一版」有效得多。
         *
         * 原因：上下文已经被 omitTrailingAssistantRound 摘掉了那一轮，
         * 模型看到的对话历史里**根本没有自己上一版说过什么**。
         * 只对它说「不要重复上一版」，它其实无从对照 —— 只能凭空揣测。
         * 把原文贴出来，它才有明确的规避对象。
         *
         * 截断到 400 字：防止超长回复把 nudge 撑得过大，
         * 也避免喧宾夺主（我们只要它「知道说过什么」，不要它「重读一遍」）。
         */
        if (prev.length > 400) prev = prev.slice(0, 400) + '…';
        var avoidBlock = prev
            ? '你上一次的回复原文是：「' + prev + '」；本次严禁与其雷同。'
            : '';
        return (
            '（【重回·生成】须严格按上文 system 中【重回】块所列「本轮用户消息」重新生成本轮回复；更早对话仅作背景，禁止回应其它轮次用户发言；' +
            /*
             * 改写约束：放在【重回】块之后、格式约束之前，
             * 让「改写」这件事先于「怎么写」被读到。
             */
            '【本轮为重新生成·上一版回复已被用户丢弃】' +
            avoidBlock +
            '这里要求的「不要一样」**不是**让你把同一个意思换一组词再说一遍 —— ' +
            '同义改写仍然算重复，用户一眼就能看出是同一句话。' +
            '要换的是**回应的方向**：换一个角度切入、换一个情绪落点、' +
            '或换一个话题侧重（可以在原话题上另起一个侧面，也可以自然转到相关的新话题），' +
            '让这一版在内容和侧重上与前一次明显不同。' +
            '但必须保持人设、语气习惯与当前剧情连贯，不要为了求新而偏离角色或编造新设定；' +
            '禁止在回复里提及「重新生成」「换一种说法」「上一版」这类元叙述，直接给出新回复即可；' +
            ONLINE_THREE_PART_TAIL +
            '）'
        );
    }

    /*
     * 读「上一版回复原文」。
     *
     * 为什么需要单独一个函数：
     *
     * 重新生成时，上一版回复已经被 withdrawLastAssistantRound 删掉了，
     * **不在上下文里** —— 只对被删掉的东西说「别重复」，模型无从对照。
     *
     * chat.lastRawAssistantReply 是每一次生成成功后由引擎落盘的原始回复
     * （写 chatPatch 时记录，见 sendChat 内 lastRawAssistantReply 赋值），
     * 正好把上一版留住了。
     *
     * chatId 优先用外层 buildApiMessages 的形参透传进来的那个，
     * 回退到 opts.chatId。两条都拿不到就返回空串，
     * buildRegenerateTailNudge 会在 prev 为空时自动省略那一段引用，
     * 不影响主流程。
     */
    /*
     * 把「上一版原文」收拾成适合塞进 nudge 的形式。
     *
     * lastRawAssistantReply 存的是**模型原始输出**，
     * 里面通常带着 <thinking>…</thinking> 之类的思维链。
     * 把它整段贴进 nudge 有两个坏处：
     *   1. 思维链往往比正文长得多，一截就把 400 字的额度吃光了，
     *      真正要规避的**正文反而被截掉** —— 模型还是看不到要躲什么；
     *   2. 思维链里常有一堆自我推演的措辞，会干扰模型对
     *      「上一版说了什么」的判断。
     *
     * 所以先抽正文再截断。抽不出正文就退回原文（至少不是空的）。
     */
    function normalizePrevReplyForNudge(raw) {
        var text = String(raw || '').trim();
        if (!text) return '';
        try {
            if (typeof extractBodyForBubbles === 'function') {
                var body = String(extractBodyForBubbles(text) || '').trim();
                if (body) return body;
            }
        } catch (e) {}
        /* 退路：至少把思维链剥掉 */
        try {
            text = text.replace(/<(thinking|think)\b[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
        } catch (e2) {}
        return text;
    }

    /*
     * 「被撤回那一版的原文」快照，按 chatId 存，取一次即清。
     *
     * 为什么需要它：withdrawLastAssistantRound 会把 chat.lastRawAssistantReply
     * **清空**（这是有意为之 —— 防止翻译/心声等消费方继续拿到已弃用的正文）。
     * 但【重回】的改写 nudge 恰恰要引用这版原文（v8.4-a）：
     * 撤回先清、nudge 后读，读到的永远是空串 —— 引用块在线上从来没有出现过，
     * 模型被要求「别重复上一版」却根本不知道上一版说了什么。
     * 撤回**之前**先把原文快照到这里，readLastRawAssistantReply 在
     * chat 字段为空时回退取用。
     */
    var withdrawnPrevReplyByChat = Object.create(null);

    function readLastRawAssistantReply(chatId) {
        try {
            var st = global.miyaChatStore;
            if (!st || typeof st.findChat !== 'function') return '';
            var cid =
                typeof resolveApiChatId === 'function'
                    ? resolveApiChatId(chatId)
                    : String(chatId || '');
            var row = st.findChat(cid) || st.findChat(chatId);
            if (row && row.lastRawAssistantReply) {
                return normalizePrevReplyForNudge(row.lastRawAssistantReply);
            }
            /*
             * chat 字段为空时回退到「被撤回那一版」的快照（取一次即清）。
             * 覆盖两条路：
             *   1. 【重回】：撤回清空了 chat 字段，nudge 引用的正是这份快照 ——
             *      否则改写约束永远「无对照可避」；
             *   2. 重回请求失败后用户改走「删了/撤了再自己说一句」：
             *      快照里存的正是那版被弃掉的原文。
             */
            var fallbackKeys = [cid, String(chatId || '')];
            for (var i = 0; i < fallbackKeys.length; i++) {
                var k = fallbackKeys[i];
                if (k && withdrawnPrevReplyByChat[k]) {
                    var snap = withdrawnPrevReplyByChat[k];
                    delete withdrawnPrevReplyByChat[k];
                    return normalizePrevReplyForNudge(snap);
                }
            }
        } catch (e) {}
        return '';
    }

    /*
     * resumeRewrite：用户「删掉一条不满意的角色回复 → 自己再发一条」。
     *
     * 这种情况**点不到重新生成按钮**（那条消息已经没了），
     * 走的是普通发送，于是拿到的是 buildManualReplyToUserTailNudge ——
     * 里面**一句改写约束都没有**。上下文和上一次逐字相同，
     * 采样参数也相同，模型当然会把几乎一样的话再吐一遍。
     * 这正是用户第二次反馈「删除消息后还是会有概率发一模一样的消息」的原因。
     *
     * 与 isRegenerate 的区别只有一个：isRegenerate 走的是
     * 【重回】块那份专用 nudge（还要叠加 omitTrailingAssistantRound 等），
     * 这里只临时借用同一段改写约束，不动其它任何逻辑。
     */
    /*
     * 「删掉上一版 + 自己再说一句」路径专用的改写 nudge。
     *
     * 基础语义仍旧是 buildManualReplyToUserTailNudge（末条是用户发言，
     * 要回应刚说的话、别去接旧话题），只是在其后补上改写约束。
     * 这样即使模型把改写约束理解得过头，第一句也已经把它按回了
     * 「以用户刚发的话为主」这条正轨上。
     */
    function buildResumeRewriteTailNudge(lastReplyText) {
        var prev = String(lastReplyText || '').trim();
        if (prev.length > 400) prev = prev.slice(0, 400) + '…';
        var avoidBlock = prev
            ? '被你弃掉的那一版原话是：「' + prev + '」；本次严禁与其雷同。'
            : '';
        return (
            '（' +
            buildManualReplyToUserTailNudgeInline() +
            '；【你刚删掉了自己上一版的回复】该版已被弃用，' +
            avoidBlock +
            '这里要求的「不要一样」**不是**让你把同一个意思换一组词再说一遍 —— ' +
            '同义改写仍然算重复，用户一眼就能看出是同一句话。' +
            '要换的是**回应的方向**：换一个角度切入、换一个情绪落点、' +
            '或换一个话题侧重（可以在原话题上另起一个侧面，也可以自然转到相关的新话题），' +
            '让这一版在内容和侧重上与前一次明显不同。' +
            '但必须保持人设、语气习惯与当前剧情连贯，不要为了求新而偏离角色或编造新设定；' +
            '禁止在回复里提及「重新生成」「换一种说法」「上一版」这类元叙述；' +
            '）'
        );
    }

    /*
     * 抽出 buildManualReplyToUserTailNudge 的正文（不含最外层括号与格式尾），
     * 供上面那个串接版本复用，避免两处措辞各自漂移。
     */
    function buildManualReplyToUserTailNudgeInline() {
        return '上下文中末条为用户发言、你方尚未回复：须回应自你方上一条回复之后、截止上下文末尾连续出现的用户消息；更早用户发言仅作背景，禁止回应其它轮次旧话题；' +
            ONLINE_THREE_PART_TAIL +
            '；禁止群聊「角色名：」多角色格式';
    }

    /*
     * 判断这一次发送该不该套「删了上一版、重新答一遍」的改写约束。
     *
     * 判据（三条全中才算，宁可漏也不能误伤正常聊天）：
     *   1. 会话上确实挂着「刚删掉末尾角色回复」的标记（store 侧打的）；
     *   2. 标记还新鲜 —— store 里的标记是内存态、10 分钟有效；
     *   3. **上下文楼层与删除当时不同**。这条是关键：
     *      标记是一次性的，若用户删完只是刷新了页面、或者这一版根本没
     *      生成成功（末尾还是那条旧消息），标记不该被白白吃掉。
     *
     * 消费动作只做一次：取到就立刻 consume，
     * 免得用户连发两句时第二句也被当成「重答」。
     */
    function shouldApplyResumeRewrite(apiChatId, opts) {
        try {
            var st = global.miyaChatStore;
            if (!st || typeof st.peekRewriteResume !== 'function') return false;
            var cid = resolveApiChatId(apiChatId);
            var mark = st.peekRewriteResume(cid) || st.peekRewriteResume(apiChatId);
            if (!mark || !mark.armed) return false;
            /*
             * 新鲜度判定：只做**下限**护栏，不做等值比较。
             *
             * 真实流程是「删消息 → 打字发送 → 点触发回复」，
             * 那一条用户消息已经先落进 store 了，所以取用时的可见条数
             * 天然比删除那一刻多 1。早年用等值比较（cur === floorAt）
             * 的结果就是一条都命中不了 —— 这就是用户持续看到复读的原因。
             *
             * 上界不设：用户在删完之后隔了几轮才想起来点回复，
             * 那确实已经不该算「重答」；但那种情况本就罕见，
             * 而且下一条护栏（consume 一次性）已经能兜住连发。
             * 宁可放宽，也不要再次出现「明明删了却完全不生效」。
             */
            var cur = 0;
            try {
                if (typeof st.getMessages === 'function') {
                    cur = (st.getMessages(cid) || []).length;
                }
            } catch (eCur) {}
            if (cur && mark.floorAt && cur < mark.floorAt - 1) return false;
            if (typeof st.consumeRewriteResume === 'function') {
                /*
                 * 消费也要带兜底：peek 是「两个 id 都试」，consume 若只认
                 * cid（canonical id），标记挂在原始 chatId 上时会出现
                 * 「peek 得到、consume 不到」的半吊子状态 —— 判定通过、
                 * nudge 却没换。两个 key 都试一遍。
                 */
                return !!(st.consumeRewriteResume(cid) || st.consumeRewriteResume(apiChatId));
            }
        } catch (e) {}
        return false;
    }

    function appendManualActionTailNudge(apiMessages, opts, historyTailState, hasExtraUserText, apiChatId, resumeRewrite) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (!Array.isArray(apiMessages)) return;
        if (opts.isAutoPush || opts.isOffline || opts.isMomentsAuto || opts.isLifeLike) return;
        if (opts.callMode || opts.appointmentMode) return;
        if (!opts.skipUserMessage || hasExtraUserText) return;
        var tail;
        if (opts.isRegenerate) {
            if (historyTailState === 'user_spoke_last') {
                /*
                 * 优先用 opts._regenCtx.prevRaw（sendChat 在 buildApiMessages
                 * 之前统一取好的那份）。直接再调 readLastRawAssistantReply
                 * 会把撤回快照**重复消费**——后调的一方拿到空串，
                 * nudge 里的引用块就会凭空消失。
                 */
                var regenPrevRaw =
                    opts._regenCtx && typeof opts._regenCtx.prevRaw === 'string'
                        ? opts._regenCtx.prevRaw
                        : readLastRawAssistantReply(apiChatId || opts.chatId);
                tail = buildRegenerateTailNudge(regenPrevRaw);
            }
        } else if (resumeRewrite && historyTailState === 'user_spoke_last') {
            /*
             * 只借用改写约束那一段，不套【重回】块。
             *
             * 为什么不能整段复用 buildRegenerateTailNudge：
             * 那一版开头写着「须严格按上文 system 中【重回】块所列『本轮用户消息』」，
             * 而这条路径下 system 里**根本没有【重回】块**，
             * 模型会去找一个不存在的东西，反而更容易胡来。
             */
            tail = buildResumeRewriteTailNudge(
                readLastRawAssistantReply(apiChatId || opts.chatId)
            );
        } else if (historyTailState === 'assistant_spoke_last') {
            tail = buildManualContinueTailNudge();
        } else if (historyTailState === 'user_spoke_last') {
            tail = buildManualReplyToUserTailNudge();
        }
        if (tail) apiMessages.push({ role: 'user', content: tail });
    }

    function buildCallModeBlock(contact, profile, callKind) {
        var kindLabel = callKind === 'video' ? '视频' : '语音';
        return (
            '【对话模式·实时' +
            kindLabel +
            '通话】\n' +
            '你正在以「' +
            String((contact && contact.name) || '对方') +
            '」的身份，与「' +
            String((profile && profile.name) || '用户') +
            '」进行实时' +
            kindLabel +
            '通话。\n' +
            '- 【重要】这是实时通话，不是微信文字聊天；你必须始终按通话情境反应。\n' +
            '- 语气口语化、有呼吸感；禁止表情包/语音条/图片/位置/转账等线上格式。\n' +
            '- 提示词顺序：全局 → 联系人档案 → 用户身份 → 关系 → 世界书；请严格区分角色与用户。'
        );
    }

    function buildCallFormatRules(contact, callKind) {
        var roleName = String((contact && contact.name) || '角色');
        var kindLabel = callKind === 'video' ? '视频' : '语音';
        return [
            '【通话格式规则·' + roleName + '】',
            '【通话态·强制】你正处于与用户进行的实时' + kindLabel + '通话中；禁止当作文字聊天。',
            '1、可用 <thinking>...</thinking> 写简短思考；禁止输出 <miyavoice>、心声段或线上三段式尾部。',
            '2、正文每行一句口语对白，条数 1–15 行，由你根据人设、情绪与当下情境自行决定；禁止「语音-」「表情包-」「图片-」等线上专属前缀。',
            '3、禁止在正文输出发起语音通话 / 发起视频通话 / 【拨打视频电话】 等拨号指令行，以及外卖- / 送礼- 等专属单行；你已在通话中，不得再次拨号。',
            '4、若系统注入「用户摄像头画面」，可结合画面自然回应，勿编造看不见的内容；若注入「用户摄像头状态」为已关闭，则完全看不到任何画面，禁止描述、猜测或编造用户外貌、表情、动作、穿着、环境等视觉内容。',
            '5、保持人设与关系一致；勿复读上一轮相同句式。'
        ].join('\n');
    }

    function buildCallRingRules(contact, profile, callKind) {
        var roleName = String((contact && contact.name) || '角色');
        var userName = String((profile && profile.name) || '用户');
        var kindLabel = callKind === 'video' ? '视频' : '语音';
        return [
            '【来电接通判定·专属】',
            userName + ' 正在向 ' + roleName + ' 发起' + kindLabel + '通话。',
            '你必须在本轮仅输出以下结构（禁止线上聊天气泡格式）：',
            '· 若接听：第一行写「通话接听」；第二行起写接通后先对 ' + userName + ' 说的口语（每行一句）。',
            '· 若拒接：第一行写「通话拒接」；第二行可写一句简短说明（可省略第二行）。',
            '禁止输出 <miyavoice>、心声段、表情包/语音条/图片/转账等线上格式。',
            '禁止输出「发起视频通话」「发起语音通话」等拨号指令；用户已在呼叫你，只需决定接听或拒接。'
        ].join('\n');
    }

    /**
     * 通话专用系统提示：不含线上格式/表情包/心声规则
     */
    function buildCallSystemPrompt(input) {
        var cfg = input && typeof input === 'object' ? input : {};
        var contact = cfg.contact;
        var profile = cfg.profile;
        var chatSettings = cfg.chatSettings || null;
        var history = cfg.history || [];
        var contextText = String(cfg.contextText || '').trim();
        var callKind = cfg.callKind === 'video' ? 'video' : 'voice';
        var parts = [];
        var aw = global.MiyaChatAwareness;

        appendLayerList(parts, cfg.worldbookFrontLayers);

        var globalP = getGlobalPrompt();
        if (globalP) parts.push('【全局提示词】\n' + globalP);

        parts.push(buildCallModeBlock(contact, profile, callKind));

        var chronicle = renderChronicleBlock(contact);
        if (chronicle) parts.push(chronicle);

        var userBlock = renderProfileBlock(profile);
        if (userBlock) parts.push(userBlock);

        var avatarBlock = buildAvatarRecognitionBlock(chatSettings, contact, profile);
        if (avatarBlock) parts.push(avatarBlock);
        appendDynamicAvatarContextBlock(parts, chatSettings, contact, profile);
        appendAlbumContextBlock(parts, profile, contact, chatSettings);

        if (aw) {
            var relLine = aw.buildRelationshipLine(chatSettings, contact);
            if (relLine) parts.push(relLine);
            var netBlockCall = aw.buildChronicleRelationshipBlock(contact);
            if (netBlockCall) parts.push(netBlockCall);
        }

        buildAwarenessBlocks(chatSettings, contact, profile, history).forEach(function (b) {
            parts.push(b);
        });

        var wbLayers = Array.isArray(cfg.worldbookLayers)
            ? cfg.worldbookLayers
            : buildWorldbookLayers(contact, contextText);
        appendLayerList(parts, wbLayers);
        appendLayerList(parts, cfg.worldbookBackLayers);

        parts.push(
            '【运转规则·通话】\n' +
                '你是' +
                String((contact && contact.name) || '对方') +
                '，正在真实通话；须消化人设与世界书；严禁辱骂用户；每轮正文仅口语对白行。'
        );

        parts.push(buildCallFormatRules(contact, callKind));

        return parts.filter(Boolean).join('\n\n');
    }

    function buildPromptCapabilitiesBlock(chatSettings) {
        var caps = (chatSettings && chatSettings.promptCapabilities) || {};
        var lines = [
            '- 可为用户点外卖（单独一行：外卖-店铺｜菜品与数量｜合计金额｜送达备注）',
            '- 可向用户送礼（单独一行：送礼-物品名｜数量｜赠言）'
        ];
        if (caps.song !== false) lines.push('- 可为用户点歌');
        if (caps.shop !== false) lines.push('- 用户可在聊天「更多」中点外卖或送礼');
        if (caps.call !== false && global.MiyaChatCalls) {
            lines.push('- 可主动发起视频通话（正文最末单独一行：发起视频通话）');
        }
        if (caps.countdown !== false) lines.push('- 可发起倒计时（约定一段时间后提醒或继续话题，须符合人设）');
        if (!lines.length) return '';
        return '【角色能力开关】\n' + lines.join('\n');
    }

    function getOnlineFormatApi() {
        return global.MiyaChatOnlineFormat || null;
    }

    function trimLine(s) {
        return String(s || '').trim();
    }

    /** 单聊：去掉模型误带的「角色真名：」群聊式前缀，避免解析/展示掉格式 */
    function stripPrivateRolePrefixLines(lines, contact) {
        if (!contact || !Array.isArray(lines)) return lines;
        var names = [trimLine(contact.name), trimLine(contact.remarkName)].filter(Boolean);
        if (!names.length) return lines;
        return lines.map(function (line) {
            var raw = trimLine(line);
            if (!raw) return raw;
            var i;
            for (i = 0; i < names.length; i++) {
                var hit = raw.match(
                    new RegExp('^' + escapeRegExp(names[i]) + '[：:]\\s*([\\s\\S]+)$')
                );
                if (hit) return trimLine(hit[1]);
            }
            var legacy = raw.match(/^【([^】]{1,32})】\s*([\s\S]+)$/);
            if (legacy) {
                var label = trimLine(legacy[1]);
                for (i = 0; i < names.length; i++) {
                    if (label === names[i]) return trimLine(legacy[2]);
                }
            }
            return raw;
        });
    }

    function isContactImageGenEnabled(chatSettings) {
        if (!global.MiyaImageGen || typeof global.MiyaImageGen.isGlobalEnabled !== 'function') return false;
        if (!global.MiyaImageGen.isGlobalEnabled()) return false;
        var ig = chatSettings && chatSettings.imageGen;
        return !!(ig && ig.enabled);
    }

    function getRecentAssistantLinesForContinuation(history, limit) {
        var lines = [];
        var fmt = getOnlineFormatApi();
        var aw = global.MiyaChatAwareness;
        var list = Array.isArray(history) ? history : [];
        for (var i = list.length - 1; i >= 0 && lines.length < (limit || 6); i--) {
            var m = list[i];
            if (!m || m.deleted || m.role !== 'assistant') continue;
            if (fmt && typeof fmt.shouldOmitMessage === 'function' && fmt.shouldOmitMessage(m)) continue;
            var t =
                fmt && typeof fmt.formatMessageForApi === 'function'
                    ? fmt.formatMessageForApi(m)
                    : String(m.content || '').trim();
            t = stripThinkingForApi(t);
            if (aw && typeof aw.stripTimelinePrefixForDisplay === 'function') {
                t = aw.stripTimelinePrefixForDisplay(t);
            }
            t = String(t || '').trim();
            if (!t) continue;
            if (t.length > 140) t = t.slice(0, 137) + '…';
            lines.unshift(t);
        }
        return lines;
    }

    function getTrailingSpeakerState(history) {
        if (!Array.isArray(history) || !history.length) return 'empty';
        var fmt = getOnlineFormatApi();
        for (var i = history.length - 1; i >= 0; i--) {
            var row = history[i];
            if (!row || row.deleted) continue;
            /* 与 appendHistory 一致：已 omit 的空壳/回执等不参与末条判定 */
            if (fmt && typeof fmt.shouldOmitMessage === 'function' && fmt.shouldOmitMessage(row)) {
                continue;
            }
            if (row.role === 'user') return 'user_spoke_last';
            if (row.role === 'assistant') return 'assistant_spoke_last';
        }
        return 'empty';
    }

    function buildPostHistoryContinuationBlock(history, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (!Array.isArray(history) || !history.length) return '';
        var state = getTrailingSpeakerState(history);
        if (state !== 'assistant_spoke_last') return '';
        var lines = [
            '【紧挨上文·对话末条状态】',
            '上下文中最后一条可见消息来自你方；你已回应过用户此前的话，用户尚未回复。',
            '本轮禁止把用户更早的发言当作「本轮必答对象」再答一遍；禁止复读、改写或换皮重复你方上一轮已说过的内容、话题、语气与结构。',
            '须从你方最近一条发言自然续写：可补充半句、追问、调侃、分享新事、换角度或换话题；像真人隔一会再发微信，而不是重新答用户旧问题。'
        ];
        if (opts.isAutoPush || opts.isOffline || opts.isLifeLike) {
            lines.push('【主动/离线触发】这是主动找用户续聊，不是重新回答用户旧话。');
        }
        var recentAsst = getRecentAssistantLinesForContinuation(history, 6);
        if (recentAsst.length) {
            lines.push('【你方最近已发原文·须在此基础上推进，禁止复读】');
            recentAsst.forEach(function (t, idx) {
                lines.push(String(idx + 1) + '. ' + t);
            });
        }
        return lines.join('\n');
    }

    function buildConversationStateBlock(history, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (!Array.isArray(history) || !history.length) return '';
        var state = getTrailingSpeakerState(history);
        var isProactiveTurn = !!(opts.isAutoPush || opts.isOffline || opts.isLifeLike);
        var lines = [
            '【本轮对话衔接·必读】',
            '上文已按时间顺序注入最近若干条完整聊天记录（用户与你的消息均已包含，条数由聊天设置决定），须通读全段后再决定如何衔接，勿只看孤立一句或只盯用户很久以前说过的话。'
        ];
        if (state === 'user_spoke_last') {
            if (isProactiveTurn) {
                lines.push(
                    '本轮为主动触发，且时间线末条是用户：须自然衔接上文末尾几条（含用户刚发），兼顾各条真实发送时刻与间隔；更早对话仅作背景；禁止假装未见、禁止抱怨用户没回。'
                );
                var fmtRound = getOnlineFormatApi();
                var pendingRound =
                    fmtRound && typeof fmtRound.formatUserRoundLinesForRegenerate === 'function'
                        ? String(
                              fmtRound.formatUserRoundLinesForRegenerate(history, opts.chatSettings) || ''
                          ).trim()
                        : '';
                if (pendingRound) {
                    lines.push('【末尾用户侧原文·纳入衔接】');
                    lines.push(pendingRound);
                    lines.push('把以上内容当作最新状态自然接下去；禁止抛开末尾去接更早旧话题。');
                }
            } else {
                lines.push(
                    '上下文末条为用户发言：本轮须回应自你方上一条回复之后、截止上下文末尾连续出现的用户消息；更早用户发言仅作背景，禁止逐条复读或接续好几轮之前的旧话题，除非用户在本轮末尾再次明确提起。'
                );
            }
        } else if (state === 'assistant_spoke_last') {
            if (isProactiveTurn) {
                lines.push(
                    '本轮为主动触发，且时间线末条是你方：须自然衔接上文末尾几条消息，并按各条真实时刻理解间隔，像真人隔一会再发。',
                    '禁止把用户上一轮或更早发言当成本轮必答对象；禁止假装用户没回你而催问；勿复读你方上轮相似内容。'
                );
            } else {
                lines.push(
                    '上下文末条为你方发言，用户尚未回复：你已在上下文中回应过用户；本轮须从你方最近一条自然续写或推进，禁止回头把用户旧句当成本轮必答对象，禁止复读上轮相似内容。'
                );
            }
        }
        return lines.join('\n');
    }

    function buildPerTurnOnlineInjectBlocks(chat, contact, chatSettings, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (opts.callMode || opts.appointmentMode) return [];
        var blocks = [buildPrivateChatScopeFence()];
        var roleName = (contact && contact.name) || '角色';
        var s = chatSettings;
        var bubbleMin = 1;
        var bubbleMax = 5;
        if (s) {
            bubbleMin = s.roleReplyBubbleMin != null ? s.roleReplyBubbleMin : 1;
            bubbleMax = s.roleReplyBubbleMax != null ? s.roleReplyBubbleMax : 5;
        }
        var fmt = getOnlineFormatApi();
        if (!opts.htmlMode && fmt && typeof fmt.buildPerTurnFormatReminder === 'function') {
            blocks.push(
                fmt.buildPerTurnFormatReminder({
                    roleName: roleName,
                    bubbleMin: bubbleMin,
                    bubbleMax: bubbleMax,
                    autoTranslate: isSemanticAutoTranslate(s),
                    translateTarget: getTranslateTargetFromSettings(s),
                    onlineNarrationEnabled: !!(s && s.onlineNarrationEnabled),
                    onlineNarrationCharPerson: (s && s.onlineNarrationCharPerson) || '3',
                    onlineNarrationUserPerson: (s && s.onlineNarrationUserPerson) || '2',
                    imageGenEnabled: isContactImageGenEnabled(s),
                    charAvatarSwapEnabled: !!(s && s.dynamicAvatar && s.dynamicAvatar.charEnabled),
                    userAvatarSwapEnabled: !!(s && s.dynamicAvatar && s.dynamicAvatar.userEnabled)
                })
            );
        }
        if (
            opts.isRegenerate &&
            fmt &&
            typeof fmt.buildRegenerateRoundInjectBlock === 'function'
        ) {
            var regenBlock = fmt.buildRegenerateRoundInjectBlock(contact, {
                history: Array.isArray(opts.history) ? opts.history : [],
                chatSettings: s
            });
            if (regenBlock) blocks.push(regenBlock);
        }
        if (
            !opts.callMode &&
            !opts.appointmentMode &&
            fmt &&
            typeof fmt.buildLastHeartVoiceInjectBlock === 'function'
        ) {
            /* 含重回：自定义/默认心声都需上一轮快照，避免重回退回默认四行 */
            var hvPrev = fmt.buildLastHeartVoiceInjectBlock(chat, contact);
            if (hvPrev) blocks.push(hvPrev);
        }
        if (
            !opts.callMode &&
            !opts.appointmentMode &&
            chat &&
            chat.type !== 'group' &&
            global.MiyaChatLifeLike &&
            typeof global.MiyaChatLifeLike.isEnabled === 'function' &&
            global.MiyaChatLifeLike.isEnabled(s) &&
            typeof global.MiyaChatLifeLike.buildNextPushRulesBlock === 'function'
        ) {
            blocks.push(global.MiyaChatLifeLike.buildNextPushRulesBlock(contact, s));
        }
        var isProactiveTurn = !!(opts.isAutoPush || opts.isOffline || opts.isLifeLike);
        if (
            !opts.isRegenerate &&
            !opts.callMode &&
            !opts.appointmentMode &&
            Array.isArray(opts.history) &&
            opts.history.length
        ) {
            var contBlock = buildConversationStateBlock(
                opts.history,
                Object.assign({}, opts, { chatSettings: s })
            );
            if (contBlock) blocks.push(contBlock);
        }
        return blocks;
    }

    function buildOnlineRulesBundle(contact, chatSettings) {
        var fmt = getOnlineFormatApi();
        var st = global.miyaChatStore;
        var catalog =
            fmt && st && typeof fmt.collectStickerCatalog === 'function'
                ? fmt.collectStickerCatalog(st, contact && contact.id)
                : [];
        var s = chatSettings;
        var bubbleMin = 1;
        var bubbleMax = 5;
        if (s) {
            bubbleMin = s.roleReplyBubbleMin != null ? s.roleReplyBubbleMin : 1;
            bubbleMax = s.roleReplyBubbleMax != null ? s.roleReplyBubbleMax : 5;
        }
        var roleName = (contact && contact.name) || '角色';
        var blocks = [];
        if (fmt && typeof fmt.buildStickerAllowlistBlock === 'function') {
            blocks.push(fmt.buildStickerAllowlistBlock(catalog, roleName));
        }
        if (fmt && typeof fmt.buildOnlineRules === 'function') {
            var dynAv = (s && s.dynamicAvatar) || {};
            var hvTplMod = global.MiyaChatHeartVoiceTemplates;
            var hvPreset =
                hvTplMod && typeof hvTplMod.resolvePresetForChat === 'function'
                    ? hvTplMod.resolvePresetForChat(s)
                    : null;
            blocks.push(
                fmt.buildOnlineRules({
                    roleName: roleName,
                    bubbleMin: bubbleMin,
                    bubbleMax: bubbleMax,
                    catalog: catalog,
                    chatSettings: s,
                    heartVoicePreset: hvPreset,
                    promptCallEnabled: !!(global.MiyaChatCalls && s && s.promptCapabilities && s.promptCapabilities.call !== false),
                    autoTranslate: isSemanticAutoTranslate(s),
                    translateTarget: getTranslateTargetFromSettings(s),
                    momentsTranslate: !!(s && s.autoTranslate && s.momentsTranslate && isSemanticAutoTranslate(s)),
                    onlineNarrationEnabled: !!(s && s.onlineNarrationEnabled),
                    onlineNarrationCharPerson: (s && s.onlineNarrationCharPerson) || '3',
                    onlineNarrationUserPerson: (s && s.onlineNarrationUserPerson) || '2',
                    imageGenEnabled: isContactImageGenEnabled(s),
                    charAvatarSwapEnabled: !!(dynAv.charEnabled),
                    userAvatarSwapEnabled: !!(dynAv.userEnabled)
                })
            );
        } else {
            blocks.push('【线上格式规则】\n每行一气泡（必须换行，禁止空格挤一行）；语音-内容；表情包-名称；引用-原话独占一行，每条回复各占一行；用户连发多条以「 / 」分隔，引用时一次只引其中一条。');
        }
        return blocks.join('\n\n');
    }

    function buildAwarenessBlocks(chatSettings, contact, profile, history) {
        var aw = global.MiyaChatAwareness;
        if (!aw) return [];
        var blocks = [];
        var itBr = global.miyaItineraryBridge;
        if (itBr && typeof itBr.buildChatItineraryBlock === 'function' && contact) {
            var itBlock = itBr.buildChatItineraryBlock(contact, chatSettings);
            if (itBlock) blocks.push(itBlock);
        }
        var placeRules = aw.buildPlaceAwarenessRules(chatSettings, contact, profile);
        if (placeRules) blocks.push('【地点运转】\n' + placeRules);
        var weatherRules = aw.buildWeatherAwarenessRules(chatSettings);
        if (weatherRules) blocks.push(weatherRules);
        return blocks;
    }

    /**
     * 系统主提示：角色资料、世界书、记忆/感知与线上格式等基础上下文。
     * ST 预设会在 buildApiMessages 中作为最前面的规则层注入。
     */
    /* buildSystemPrompt 最近一次的分段结果（由调用方在拼接后取走挂到 message 上） */
    var lastSystemSections = null;

    function takeLastSystemSections() {
        var s = lastSystemSections;
        lastSystemSections = null;
        return s;
    }

    function buildSystemPrompt(input) {
        var cfg = input && typeof input === 'object' ? input : {};
        var contact = cfg.contact;
        var profile = cfg.profile;
        var chatSettings = cfg.chatSettings || null;
        var history = cfg.history || [];
        var contextText = String(cfg.contextText || '').trim();
        var parts = [];
        /* 同步记录每个 section 的名称与字数，供「Token 来源分布」把主系统提示拆开看。
           主系统提示原本是一整块拼出来的，不记这个就只能看到「系统主提示」一个总数。 */
        var sections = [];
        var aw = global.MiyaChatAwareness;

        function push(label, text) {
            if (!text) return;
            var s = String(text);
            parts.push(s);
            sections.push({ name: label, chars: s.length });
        }

        appendLayerList(parts, cfg.worldbookFrontLayers);
        if (cfg.worldbookFrontLayers && cfg.worldbookFrontLayers.length) {
            sections.push({ name: '世界书 · 前置层', chars: sumLayerChars(cfg.worldbookFrontLayers) });
        }

        var globalP = getGlobalPrompt();
        if (globalP) push('全局提示词', '【全局提示词】\n' + globalP);

        push('对话模式', buildChatModeBlock(contact, profile));

        var userBlock = renderProfileBlock(profile);
        push('我的档案', userBlock);

        var avatarBlock = buildAvatarRecognitionBlock(chatSettings, contact, profile);
        push('头像识别', avatarBlock);
        appendDynamicAvatarContextBlock(parts, chatSettings, contact, profile);
        appendAlbumContextBlock(parts, profile, contact, chatSettings);

        if (aw) {
            var relLine = aw.buildRelationshipLine(chatSettings, contact);
            push('关系描述', relLine);
            var netBlock = aw.buildChronicleRelationshipBlock(contact);
            push('角色关系网', netBlock);
        }

        buildAwarenessBlocks(chatSettings, contact, profile, history).forEach(function (b) {
            push('认知层', b);
        });

        var wbLayers = Array.isArray(cfg.worldbookLayers)
            ? cfg.worldbookLayers
            : buildWorldbookLayers(contact, contextText);
        appendLayerList(parts, wbLayers);
        if (wbLayers && wbLayers.length) {
            sections.push({ name: '世界书 · 命中层', chars: sumLayerChars(wbLayers) });
        }

        var capBlock = buildPromptCapabilitiesBlock(chatSettings);
        push('能力开关', capBlock);

        push('线上运转规则', buildOnlineRulesBundle(contact, chatSettings));

        var joined = parts.filter(Boolean).join('\n\n');
        lastSystemSections = sections;
        return joined;
    }

  /**
   * 线上单聊：联系人档案（含人设与背景）置末注入，紧挨运转规则之前。
   *
   * 开场白只在「第一楼」注入 —— 也就是这段对话还没有任何消息的时候。
   * 道理很简单：开场白是用来决定「这场对话从哪开始」的，一旦已经聊起来，
   * 它既没有指导意义，又会白白占上下文（实测一张卡的开场白能到几 k）。
   */
  function appendChronicleBeforeOperationRulesMessage(apiMessages, contact, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    if (!Array.isArray(apiMessages)) return;
    if (opts.callMode || opts.appointmentMode) return;
    var chronicleOpts = { includeGreetings: isFirstFloorChat(opts.chatId) };
    var chronicle = renderChronicleBlock(contact, chronicleOpts);
    if (!chronicle) return;
    apiMessages.push({ role: 'system', content: chronicle });
  }

  /**
   * 是否「第一楼」：这段对话还没有任何可见消息。
   *
   * 拿不到 chatId 时返回 false（保守：宁可不注入开场白，也不要重复塞）。
   * 用 getMessages 而不是直接读数组，是因为它已经过滤了 deleted /
   * offlineMeet / 朋友圈留痕，计数与用户看到的楼层一致。
   */
  function isFirstFloorChat(chatId) {
    var store = global.miyaChatStore;
    var id = String(chatId || '').trim();
    if (!store || !id) return false;
    if (typeof store.getMessages !== 'function') return false;
    try {
      var msgs = store.getMessages(id) || [];
      return msgs.length === 0;
    } catch (e) {
      return false;
    }
  }

    /**
     * ST 预设：正常聊天的唯一可编辑规则入口。
     * 没有启用条目时只保留极短的代码级兜底，世界书不依赖旧的思维链/运转规则模块。
     */
    /**
     * ST 预设：正常聊天的唯一可编辑规则入口。
     * position 可传 front/back：
     * - front：相对聊天记录前置，作为背景/身份设定
     * - back：相对聊天记录后置，紧挨历史，更适合强执行规则
     * 不传 position 时保持旧行为：返回全部启用条目（兼容外部调用）。
     */
    /**
     * ST COT/思维链条目：用于把预设中明确属于 COT 的规则单独送到
     * 生成前的最近位置。这里只负责识别与原文保留，不伪造模型的隐藏 reasoning。
     */
    function buildStCotPromptBlock() {
        /*
         * 线下“思维链”不能靠猜条目名字是不是 COT。
         * ST 预设的 enabled 条目本身就是本场规则源：身份、环境、叙事、COT、格式
         * 等都必须在生成前可见。过去这里用 COT/思维链关键词筛选，导致像
         * “PARADISE / CULTIVATOR” 这种没有写 COT 字样的关键条目根本不会进入该层。
         *
         * 因此这里改为：把所有已启用、非 marker 的 ST 条目原文按原顺序组成
         * “ST 执行上下文”。这不是伪造 reasoning_content；它的作用是让模型在生成
         * 前明确读取完整 ST 规则集。真正的 reasoning 仍由模型/API 产生。
         */
        var rows = [];
        try {
            var stpStore = global.miyaStPromptPresetsStore;
            var entries = stpStore && typeof stpStore.getEnabledForRequest === 'function'
                ? (stpStore.getEnabledForRequest() || [])
                : [];
            entries.forEach(function (entry) {
                var body = String(entry && entry.content || '').trim();
                if (!body) return;
                var name = String(entry && (entry.name || entry.identifier) || '').trim();
                var id = String(entry && entry.identifier || '').trim();
                /*
                 * 位置标签兼容两套语义：
                 * - 旧版 UI 的 front / back；
                 * - ST 原生 position='in_chat' 或 injection_position=1。
                 * store 现在统一产出 relative / in_chat，
                 * 只判断 'back' 会把所有后置条目误标成「前置」。
                 */
                var posRaw = String(entry && entry.position || '').toLowerCase();
                var isBack = posRaw === 'back' || posRaw === 'in_chat' || posRaw === 'in-chat' ||
                    Number(entry && entry.injection_position) === 1;
                var position = isBack ? '后置' : '前置';
                rows.push({
                    name: name || id || '未命名 ST 条目',
                    identifier: id,
                    position: position,
                    content: body
                });
            });
        } catch (e) {}
        if (!rows.length) return '';

        var out = [
            '【ST 预设·线下生成执行上下文】',
            '以下是本轮实际启用的全部 ST 预设条目。它们是本场最高优先级的可编辑生成规则之一，必须在生成当前回复前完整读取、逐条应用；不得因为条目名称、位置或内容没有出现“COT/思维链”字样而跳过。',
            '身份、环境、叙事方式、世界观、COT/推理方法、人称、格式、行为约束等均属于 ST 预设的一部分。若模型产生 reasoning/<thinking>，其任务分析必须以这些条目为依据，而不是自行另起一套角色心理规则。',
            '特别注意：不要把“读取 ST 条目”理解成只在正文里模仿风格；生成前必须实际检查这些规则是否影响本轮决策。',
            ''
        ];
        rows.forEach(function (row, i) {
            out.push('【ST-' + (i + 1) + '｜' + row.name + '｜' + row.position + '】');
            if (row.identifier) out.push('identifier: ' + row.identifier);
            out.push(row.content);
            out.push('');
        });
        out.push('【ST 执行检查】');
        out.push('生成前：确认以上每一条已启用 ST 规则都已被读取；尤其不要遗漏身份/环境类条目。');
        out.push('生成中：优先依据 ST 规则进行任务分析与决策，不以角色内心独白替代规则执行。');
        out.push('生成后：检查正文是否违反任何已启用 ST 条目。');
        return out.join('\n').trim();
    }

    /**
     * 轻量版「执行检查」提示。
     *
     * 条目正文已经通过 buildStPresetMessages 注入到最前 / 历史内了，末尾再贴一遍全文
     * 属于重复注入。这里只保留一句元指令：提醒模型「本轮有 ST 规则在生效、必须逐条落实」，
     * 以及本轮实际生效的条目名清单（仅名字，不含正文），既能起到点名作用又不重复占额度。
     */
    function buildStPresetCheckHint() {
        var names = [];
        try {
            var stpStore = global.miyaStPromptPresetsStore;
            var entries = stpStore && typeof stpStore.getEnabledForRequest === 'function'
                ? (stpStore.getEnabledForRequest() || [])
                : [];
            entries.forEach(function (entry) {
                if (!String(entry && entry.content || '').trim()) return;
                var name = String(entry && (entry.name || entry.identifier) || '').trim();
                if (name && names.indexOf(name) < 0) names.push(name);
            });
        } catch (e) {}
        if (!names.length) return '';
        var lines = [
            '【ST 预设·执行检查】',
            '本轮有 ' + names.length + ' 条 ST 预设条目已注入上下文（正文见前文与历史内相应位置）。',
            '必须在生成前完整读取并逐条应用；不得因条目名称或位置未出现“COT/思维链”字样而跳过。',
            '生效条目：' + names.join(' / ')
        ];
        return lines.join('\n');
    }

    /**
     * ST 预设条目的宏（占位符）解析。
     *
     * SillyTavern 的条目正文里可以写 {{char}} {{user}} 这类占位符，发送前替换成真实值，
     * 于是同一条预设能跨角色复用，不必为每个角色各写一份。
     *
     * 兼容原则：**向后兼容，不认识的原样放行**。
     * 老预设正文里没有 {{...}}，替换器扫不到任何东西，输出与改动前逐字节一致；
     * 万一条目里本来就写了 {{某某}} 而这里不认识，也原样保留，不会被吞掉。
     *
     * 支持列表（大小写不敏感，内部空白容忍，如 {{ char }} / {{CHAR}} 均可）：
     *   {{char}}             当前角色名
     *   {{user}}             当前用户名（未设置时为「用户」）
     *   {{persona}}          同 {{user}}，兼容 ST 习惯称呼
     *   {{time}}             当前时间 HH:MM
     *   {{date}}             当前日期 YYYY-MM-DD
     *   {{weekday}}          星期几，如「星期三」
     *   {{datetime}}         完整日期时间
     *   {{isotime}}          ISO 时间戳
     *   {{lastMessage}}      最近一条对话消息正文
     *   {{random:a,b,c}}     随机取一项
     *   {{roll:1d6}}         掷骰
     *   {{cron}}             cron 表达式（ST 兼容，本轮不解析，原样保留）
     *
     * 未知宏（含 {{}} 空内容）一律原样保留，保证不会把用户正文吃掉。
     */
    var ST_MACRO_CJK_WEEK = ['日', '一', '二', '三', '四', '五', '六'];

    function stMacroPad2(n) {
        return (Number(n) < 10 ? '0' : '') + Number(n);
    }

    function stMacroNow() {
        return new Date();
    }

    function stMacroTimeText(d) {
        return stMacroPad2(d.getHours()) + ':' + stMacroPad2(d.getMinutes());
    }

    function stMacroDateText(d) {
        return d.getFullYear() + '-' + stMacroPad2(d.getMonth() + 1) + '-' + stMacroPad2(d.getDate());
    }

    /** 掷骰：支持 1d6 / 2d20+3 / d6 等写法 */
    function stMacroRoll(expr) {
        var m = /^\s*(\d*)\s*d\s*(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(String(expr || ''));
        if (!m) return null;
        var count = m[1] ? Math.max(1, Math.min(100, parseInt(m[1], 10))) : 1;
        var faces = Math.max(2, Math.min(1000000, parseInt(m[2], 10)));
        var mod = m[3] ? parseInt(String(m[3]).replace(/\s+/g, ''), 10) : 0;
        var sum = 0;
        for (var i = 0; i < count; i++) sum += Math.floor(Math.random() * faces) + 1;
        return sum + mod;
    }

    /**
     * 解析单条正文里的宏。
     *
     * ctx: { char, user, lastMessage }
     */
    function resolveStMacros(text, ctx) {
        var src = text == null ? '' : String(text);
        if (!src) return src;
        /* 没有 {{ 就直接返回，零开销、绝对不影响既有内容 */
        if (src.indexOf('{{') < 0) return src;

        var c = ctx && typeof ctx === 'object' ? ctx : {};
        var charName = String(c.char == null ? '' : c.char);
        var userName = String(c.user == null ? '' : c.user);
        var lastMessage = String(c.lastMessage == null ? '' : c.lastMessage);

        return src.replace(/\{\{([^{}]*)\}\}/g, function (whole, rawName) {
            var name = String(rawName == null ? '' : rawName).trim();
            if (!name) return whole;
            var lower = name.toLowerCase();
            /* 带参数的宏先处理（random / roll），它们的参数里可能有冒号 */
            var mm = /^(random|roll)\s*:\s*([\s\S]*)$/i.exec(name);
            if (mm) {
                var kind = mm[1].toLowerCase();
                var arg = mm[2];
                if (kind === 'random') {
                    var pool = String(arg || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
                    if (!pool.length) return whole;
                    return pool[Math.floor(Math.random() * pool.length)];
                }
                var rolled = stMacroRoll(arg);
                return rolled == null ? whole : String(rolled);
            }
            switch (lower) {
                case 'char':
                    return charName || whole;
                case 'user':
                case 'persona':
                    return userName || whole;
                case 'time':
                    return stMacroTimeText(stMacroNow());
                case 'date':
                    return stMacroDateText(stMacroNow());
                case 'weekday': {
                    var d = stMacroNow();
                    return '星期' + ST_MACRO_CJK_WEEK[d.getDay()];
                }
                case 'datetime': {
                    var dt = stMacroNow();
                    return stMacroDateText(dt) + ' ' + stMacroTimeText(dt);
                }
                case 'isotime':
                    return new Date().toISOString();
                case 'lastmessage':
                    return lastMessage || whole;
                default:
                    /* 不认识的宏 —— 原样保留，绝不吞内容 */
                    return whole;
            }
        });
    }

    /**
     * 按当前会话组装宏上下文。
     * 拿不到就留空字符串，resolveStMacros 那边会退回原样输出，不会产生「undefined」字样。
     */
    function buildStMacroContext(contact, profile, history) {
        var ctx = { char: '', user: '', lastMessage: '' };
        try {
            ctx.char = String((contact && (contact.name || contact.nickname)) || '').trim();
        } catch (e1) {}
        try {
            ctx.user = String((profile && profile.name) || '').trim() || '用户';
        } catch (e2) {
            ctx.user = '用户';
        }
        try {
            if (Array.isArray(history) && history.length) {
                for (var i = history.length - 1; i >= 0; i--) {
                    var h = history[i];
                    var body = String((h && h.content) || '').trim();
                    if (body) {
                        ctx.lastMessage = body;
                        break;
                    }
                }
            }
        } catch (e3) {}
        return ctx;
    }

    /**
     * ST-compatible prompt export.
     *
     * SillyTavern does NOT implement "back" as simply appending a system message.
     * It has two concepts:
     *   injection_position = 0 (relative): participate in the ordered prompt stack.
     *   injection_position = 1 (in-chat): inject into chat history at injection_depth,
     *   with injection_order controlling priority when several prompts share a depth.
     *
     * Miya's UI keeps the friendly front/back labels, but the request layer now
     * preserves these ST semantics.
     *
     * opts（可选）: { contact, profile, history } —— 用于解析条目正文里的 {{char}} 等宏。
     * 不传时宏不解析、原样输出，等价于改动前的行为。
     */
    function buildStPresetMessages(position, opts) {
        var macroCtx = null;
        try {
            var o = opts && typeof opts === 'object' ? opts : null;
            if (o) macroCtx = buildStMacroContext(o.contact, o.profile, o.history);
        } catch (eMacroCtx) {
            macroCtx = null;
        }
        var out = [];
        var wanted = position === 'back' ? 'back' : position === 'front' ? 'front' : '';
        try {
            var stpStore = global.miyaStPromptPresetsStore;
            var entries = stpStore && typeof stpStore.getEnabledForRequest === 'function'
                ? (stpStore.getEnabledForRequest() || [])
                : [];
            entries.forEach(function (entry, idx) {
                var body = String(entry && entry.content || '').trim();
                if (!body) return;
                /* 宏解析：只在传了上下文时执行；未传则 body 原样返回，行为与改动前一致 */
                if (macroCtx) {
                    try {
                        body = resolveStMacros(body, macroCtx);
                    } catch (eResolve) {}
                }
                if (!String(body || '').trim()) return;
                var entryPosition = entry && (entry.position === 'back' || Number(entry.injection_position) === 1) ? 'back' : 'front';
                if (wanted && entryPosition !== wanted) return;
                var role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : 'system';
                out.push({
                    role: role,
                    content: body,
                    /* name 是预设条目的显示名（如「角色设定」），「Token 来源分布」靠它
                       才能告诉用户「占比最大的 ST 条目到底是哪一条」。原来没带，补上。 */
                    name: String(entry.name || '').trim(),
                    position: entryPosition,
                    injection_position: entryPosition === 'back' ? 1 : 0,
                    injection_depth: Number.isFinite(Number(entry.injection_depth)) ? Math.max(0, Number(entry.injection_depth)) : 4,
                    injection_order: Number.isFinite(Number(entry.injection_order)) ? Number(entry.injection_order) : 100,
                    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : idx,
                    identifier: String(entry.identifier || entry.id || '')
                });
            });
        } catch (e) {}
        if (!out.length && !wanted) {
            out.push({
                role: 'system',
                content: '【基础回复规则】遵循角色设定、世界书与当前聊天格式，自然回应最新消息；不得编造上下文中没有依据的事实。',
                position: 'front', injection_position: 0, injection_depth: 4, injection_order: 100, order: 0,
                identifier: '__fallback__'
            });
        }
        return out;
    }

    /**
     * Apply SillyTavern's in-chat injection semantics to a flat API message list.
     * historyStart points to the first message belonging to chat history.
     * Depth 0 = immediately after the latest history message; depth 4 = four
     * history messages from the end, matching ST's in-chat concept.
     */
    /*
     * ST 预设条目的来源标记。
     *
     * 背景：buildStPresetMessages 里每条都带着 name / identifier / position / depth，
     * 但注入 apiMessages 时只留了 {role, content}，条目名被丢掉了 —— 结果「Token 来源分布」
     * 只能笼统地说「ST 预设」，看不出到底是哪一条占了上下文。
     *
     * 这里把来源信息挂在 message 的非标准字段 __src 上，一路带到 buildPromptSourceBreakdown。
     * __src 是纯本地字段，发 API 前由 stripInternalFields 剥离，不会进入 request body。
     */
    var INTERNAL_MSG_FIELDS = ['__src', '__genSection'];

    function stTaggedMessage(m) {
        var name = String((m && m.name) || '').trim();
        var ident = String((m && m.identifier) || '').trim();
        var pos = m && m.position === 'back' ? 'back' : 'front';
        var depth = Number.isFinite(Number(m && m.injection_depth)) ? Number(m.injection_depth) : null;
        return {
            role: m && (m.role === 'user' || m.role === 'assistant') ? m.role : 'system',
            content: (m && m.content) || '',
            __src: {
                key: 'st_preset',
                label: PROMPT_SOURCE_LABELS.st_preset || 'ST 预设',
                name: name || ident || '未命名条目',
                identifier: ident,
                position: pos,
                depth: depth
            }
        };
    }

    /** 剥离本地私有字段，确保发往 API 的 body 保持标准三字段 */
    function stripInternalFields(messages) {
        if (!Array.isArray(messages)) return messages;
        return messages.map(function (m) {
            if (!m || typeof m !== 'object') return m;
            var hasInternal = false;
            var i;
            for (i = 0; i < INTERNAL_MSG_FIELDS.length; i++) {
                if (m[INTERNAL_MSG_FIELDS[i]] !== undefined) { hasInternal = true; break; }
            }
            if (!hasInternal) return m;
            var out = {};
            Object.keys(m).forEach(function (k) {
                if (INTERNAL_MSG_FIELDS.indexOf(k) < 0) out[k] = m[k];
            });
            return out;
        });
    }

    function injectStInChatMessages(apiMessages, historyStart, stEntries) {
        if (!Array.isArray(apiMessages) || !Array.isArray(stEntries) || !stEntries.length) return;
        var historyEnd = apiMessages.length;
        var historyLength = Math.max(0, historyEnd - historyStart);
        if (!historyLength) {
            stEntries.forEach(function (m) {
                apiMessages.push(stTaggedMessage(m));
            });
            return;
        }

        var groups = Object.create(null);
        stEntries.forEach(function (m) {
            var depth = Number.isFinite(Number(m.injection_depth)) ? Math.max(0, Number(m.injection_depth)) : 4;
            var key = String(depth);
            if (!groups[key]) groups[key] = [];
            groups[key].push(m);
        });

        Object.keys(groups).map(Number).sort(function (a, b) { return b - a; }).forEach(function (depth) {
            var group = groups[String(depth)] || [];
            group.sort(function (a, b) {
                var ao = Number.isFinite(Number(a.injection_order)) ? Number(a.injection_order) : 100;
                var bo = Number.isFinite(Number(b.injection_order)) ? Number(b.injection_order) : 100;
                return bo - ao; // ST: higher order is inserted first within the same depth
            });
            var idx = Math.max(historyStart, historyEnd - Math.min(depth, historyLength));
            var msgs = group.map(function (m) {
                return stTaggedMessage(m);
            });
            apiMessages.splice(idx, 0, ...msgs);
            historyEnd += msgs.length;
        });
    }

    function appendOnlineHeartVoicePriorityMessage(apiMessages, contact, settings, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (!Array.isArray(apiMessages) || opts.callMode || opts.appointmentMode || opts.isMomentsAuto) return;
        var hvTpl = global.MiyaChatHeartVoiceTemplates;
        if (!hvTpl || typeof hvTpl.resolvePresetForChat !== 'function' || typeof hvTpl.buildCustomHeartVoicePriorityBlock !== 'function') return;
        var hvPreset = hvTpl.resolvePresetForChat(settings);
        if (!hvPreset) return;
        var roleName = String((contact && contact.name) || '角色');
        var block = hvTpl.buildCustomHeartVoicePriorityBlock(roleName, hvPreset);
        if (block) apiMessages.push({ role: 'system', content: block });
    }

    function extractThinkingBlock(rawText) {
        var src = String(rawText || '');
        var i;
        for (i = 0; i < THINKING_EXTRACT_SEQ.length; i++) {
            var m = src.match(THINKING_EXTRACT_SEQ[i]);
            if (m && m[1] && String(m[1]).trim()) return String(m[1]).trim();
        }
        var tailPatterns = [
            /<thinking>([\s\S]*)$/i,
            /＜thinking＞([\s\S]*)$/i,
            /\<think\>([\s\S]*)$/i,
            /＜think＞([\s\S]*)$/i,
            /<think>([\s\S]*)$/i
        ];
        for (i = 0; i < tailPatterns.length; i++) {
            var t = src.match(tailPatterns[i]);
            if (t && t[1] && String(t[1]).trim()) return String(t[1]).trim();
        }
        return '';
    }

    function findLastThinkingCloseEnd(raw) {
        var src = String(raw || '');
        var lastEnd = -1;
        var i;
        for (i = 0; i < THINKING_CLOSE_PATTERNS.length; i++) {
            var re = THINKING_CLOSE_PATTERNS[i];
            re.lastIndex = 0;
            var m;
            while ((m = re.exec(src)) !== null) {
                var end = m.index + m[0].length;
                if (end > lastEnd) lastEnd = end;
            }
        }
        return lastEnd;
    }

    /** 正文只取最后一个思维链闭合标签之后的内容，避免 [正文] 草稿与重复输出泄漏 */
    function extractBodyAfterThinkingClose(text) {
        var end = findLastThinkingCloseEnd(text);
        if (end < 0) return String(text || '');
        return String(text || '').slice(end).trim();
    }

    function escapeRegExp(s) {
        return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function stripStructuralMarkerLines(text) {
        var lines = String(text || '').split(/\n/);
        var fmt = getOnlineFormatApi();
        var out = [];
        lines.forEach(function (line) {
            var t = trimLine(line);
            if (!t) return;
            if (fmt && typeof fmt.isStructuralLeakLine === 'function' && fmt.isStructuralLeakLine(t)) {
                return;
            }
            out.push(line);
        });
        return out.join('\n').trim();
    }

    /** 未闭合 thinking 时勿吞掉正文/心声：仅剥思维段，保留其后内容 */
    function stripUnclosedThinkingTail(text) {
        var out = String(text || '');
        var markers = [
            { open: /<thinking>/i, close: /<\/thinking>/i },
            { open: /＜thinking＞/i, close: /＜\/thinking＞/i },
            { open: /\<think\>/i, close: /<\/think>/i },
            { open: /＜think＞/i, close: /＜\/think＞/i },
            { open: /<think>/i, close: /<\/redacted_thinking>|<\/think>/i },
            { open: /<reasoning>/i, close: /<\/reasoning>/i }
        ];
        var guard = 0;
        while (guard < 6) {
            guard += 1;
            var changed = false;
            markers.forEach(function (mk) {
                var m = out.match(mk.open);
                if (!m || m.index == null) return;
                var tail = out.slice(m.index);
                if (mk.close.test(tail)) return;
                var inner = tail.replace(mk.open, '');
                var hvIdx = inner.search(/<miyavoice|＜miyavoice|<heartvoice|＜heartvoice|<心声|＜心声/i);
                if (hvIdx >= 0) {
                    out = out.slice(0, m.index) + inner.slice(hvIdx);
                    changed = true;
                    return;
                }
                var para = inner.search(/\n\s*\n/);
                /*
                 * ⚠️ 这里必须是 x.trim()，不能写成 trim(x)。
                 *
                 * 本文件从未定义过名为 trim 的全局函数，写成 trim(...)
                 * 会直接抛 ReferenceError: trim is not defined。
                 *
                 * 为什么这个错误能潜伏很久：它只在「未闭合 thinking」这条
                 * 分支里执行 —— 即某一层开了 <thinking> 却没闭合。
                 * 常规聊天里思维段都是成对的，走不到这里；一旦遇到
                 * 只有思维段、正文为空的那种楼层（ST 导入很常见），
                 * 异常就会在渲染期爆出来，表现为「界面刷新出错」。
                 */
                if (para >= 0 && inner.slice(para).trim()) {
                    out = out.slice(0, m.index) + inner.slice(para).trim();
                } else {
                    out = out.slice(0, m.index).trim();
                }
                changed = true;
            });
            if (!changed) break;
        }
        return out.trim();
    }

    function stripThinkingBlocks(text) {
        var out = String(text || '');
        var closedRegs = [
            /<thinking>[\s\S]*?(?:<\/thinking>|\[\/thinking\]|＜\/thinking＞|［\/thinking］|【\/thinking】)/gi,
            /＜thinking＞[\s\S]*?(?:＜\/thinking＞|\[\/thinking\]|［\/thinking］)/gi,
            /\[thinking\][\s\S]*?\[\/thinking\]/gi,
            /\<think\>[\s\S]*?(?:<\/think>|\[\/think\])/gi,
            /＜think＞[\s\S]*?＜\/think＞/gi,
            /<think>[\s\S]*?<\/redacted_thinking>/gi,
            /<think>[\s\S]*?<\/think>/gi,
            /<reasoning>[\s\S]*?<\/reasoning>/gi
        ];
        var prev;
        var guard = 0;
        while (guard < 10 && prev !== out) {
            prev = out;
            guard += 1;
            closedRegs.forEach(function (re) {
                out = out.replace(re, '');
            });
            out = out.trim();
        }
        out = stripUnclosedThinkingTail(out);
        out = extractBodyAfterThinkingClose(out);
        return stripStructuralMarkerLines(out);
    }

    function parseThinking(text) {
        var raw = String(text || '');
        var thinking = extractThinkingBlock(raw);
        var afterClose = extractBodyAfterThinkingClose(raw);
        var content =
            findLastThinkingCloseEnd(raw) >= 0
                ? stripHeartVoiceTags(afterClose)
                : stripThinkingBlocks(raw);
        content = stripStructuralMarkerLines(stripHeartVoiceTags(content));
        return { thinking: thinking, content: content.trim() };
    }

    function stripThinkingForApi(text) {
        return stripThinkingBlocks(text);
    }

    function extractReasoningFromApi(data) {
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!msg || typeof msg !== 'object') return '';
        var r0 = msg.reasoning_content != null ? msg.reasoning_content : msg.reasoning;
        if (typeof r0 === 'string') return r0.trim();
        return String(r0 || '').trim();
    }

    function extractThinkingFromResponse(data, replyRaw) {
        var raw = String(replyRaw || '');
        var tagged = extractThinkingBlock(raw);
        if (tagged) return tagged;
        var rsn = extractReasoningFromApi(data);
        if (rsn) return extractThinkingBlock(rsn) || rsn;
        return '';
    }

    /** 剥掉泄漏的 miyavoice/heartvoice 标签碎片（含 </miyavo> 等截断闭合） */
    function stripHeartVoiceTagFragments(text) {
        var out = String(text || '');
        out = out.replace(/<\/?miyav[\w]*\s*>/gi, '');
        out = out.replace(/＜\/?miyav[\w]*＞/gi, '');
        out = out.replace(/<\/?heartvoice\s*>/gi, '');
        out = out.replace(/＜\/?heartvoice＞/gi, '');
        out = out.replace(/<\/?心声\s*>/gi, '');
        out = out.replace(/＜\/?心声＞/gi, '');
        return out.trim();
    }

    function stripHeartVoiceTags(text) {
        var out = String(text || '');
        var closed = [
            /<miyavoice>[\s\S]*?<\/miyav[\w]*\s*>/gi,
            /＜miyavoice＞[\s\S]*?＜\/miyav[\w]*＞/gi,
            /<miyavoice>[\s\S]*?<\/miyavoice>/gi,
            /＜miyavoice＞[\s\S]*?＜\/miyavoice＞/gi,
            /<heartvoice>[\s\S]*?<\/heart[\w]*\s*>/gi,
            /＜heartvoice＞[\s\S]*?＜\/heart[\w]*＞/gi,
            /<heartvoice>[\s\S]*?<\/heartvoice>/gi,
            /＜heartvoice＞[\s\S]*?＜\/heartvoice＞/gi,
            /<心声>[\s\S]*?<\/心声\s*>/gi,
            /＜心声＞[\s\S]*?＜\/心声＞/gi
        ];
        var i;
        for (i = 0; i < closed.length; i++) out = out.replace(closed[i], '');
        out = out.replace(/<miyavoice>[\s\S]*$/gi, '');
        out = out.replace(/＜miyavoice＞[\s\S]*$/gi, '');
        out = out.replace(/<heartvoice>[\s\S]*$/gi, '');
        out = out.replace(/＜heartvoice＞[\s\S]*$/gi, '');
        out = out.replace(/<心声>[\s\S]*$/gi, '');
        out = out.replace(/【心声】[\s\S]*?(?:【\/心声】|【／心声】|$)/gi, '');
        return stripHeartVoiceTagFragments(out);
    }

    function extractHeartVoiceBlock(rawText) {
        var src = String(rawText || '');
        var patterns = [
            /<miyavoice>([\s\S]*?)<\/miyav[\w]*\s*>/i,
            /＜miyavoice＞([\s\S]*?)＜\/miyav[\w]*＞/i,
            /<miyavoice>([\s\S]*?)<\/miyavoice>/i,
            /＜miyavoice＞([\s\S]*?)＜\/miyavoice＞/i,
            /<heartvoice>([\s\S]*?)<\/heart[\w]*\s*>/i,
            /＜heartvoice＞([\s\S]*?)＜\/heart[\w]*＞/i,
            /<heartvoice>([\s\S]*?)<\/heartvoice>/i,
            /＜heartvoice＞([\s\S]*?)＜\/heartvoice＞/i,
            /<心声>([\s\S]*?)<\/心声\s*>/i,
            /＜心声＞([\s\S]*?)＜／心声＞/i,
            /【心声】([\s\S]*?)【\/心声】/i,
            /【心声】([\s\S]*?)【／心声】/i
        ];
        var i;
        for (i = 0; i < patterns.length; i++) {
            var m = src.match(patterns[i]);
            if (m && m[1] && String(m[1]).trim()) {
                return stripHeartVoiceTagFragments(String(m[1]).trim());
            }
        }
        var tailPatterns = [
            /<miyavoice>([\s\S]*)$/i,
            /＜miyavoice＞([\s\S]*)$/i,
            /<heartvoice>([\s\S]*)$/i,
            /＜heartvoice＞([\s\S]*)$/i,
            /<心声>([\s\S]*)$/i
        ];
        for (i = 0; i < tailPatterns.length; i++) {
            var t = src.match(tailPatterns[i]);
            if (t && t[1] && String(t[1]).trim()) {
                return stripHeartVoiceTagFragments(String(t[1]).trim());
            }
        }
        return '';
    }

    function parseHeartVoiceFieldLine(line, allowedNames) {
        var raw = stripHeartVoiceTagFragments(trimLine(line));
        if (!raw) return null;
        var names = Array.isArray(allowedNames) && allowedNames.length
            ? allowedNames
            : ['好感度', '欲望值', '行为动作', '角色心声'];
        var i;
        for (i = 0; i < names.length; i++) {
            var label = String(names[i] || '').trim();
            if (!label) continue;
            var escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var re = new RegExp('^' + escaped + '\\s*[-－—：:]\\s*([\\s\\S]+)$');
            var m = raw.match(re);
            if (m) {
                return {
                    key: label,
                    value: stripHeartVoiceTagFragments(trimLine(m[1]))
                };
            }
        }
        return null;
    }

    function clampHeartVoiceScore(n) {
        var v = Math.round(Number(n));
        if (!Number.isFinite(v)) return null;
        return Math.min(100, Math.max(0, v));
    }

    /** 心声单字段上限：禁止对自定义字段做短截断（仅防极端撑爆存储） */
    var HEART_VOICE_FIELD_VALUE_MAX = 100000;
    var HEART_VOICE_LEGACY_LINE_MAX = 20000;

    function clipHeartVoiceFieldValue(v, max) {
        var s = String(v == null ? '' : v);
        var lim = max != null ? max : HEART_VOICE_FIELD_VALUE_MAX;
        if (s.length <= lim) return s;
        return s.slice(0, lim);
    }

    function tryParseCustomJsonFields(inner, fieldNames) {
        var src = String(inner || '').trim();
        if (!src || src.charAt(0) !== '{' ) {
            var m = src.match(/\{[\s\S]*\}/);
            if (!m) return null;
            src = m[0];
        }
        var obj;
        try {
            obj = JSON.parse(src);
        } catch (e1) {
            try {
                obj = JSON.parse(src.replace(/,\s*([}\]])/g, '$1'));
            } catch (e2) {
                return null;
            }
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
        var fields = {};
        var aliasMap = {
            t_top_left: '年月',
            t_top_right: '天气',
            t_content: '心声',
            t_bottom_title: '署名',
            t_bottom_desc: '短文',
            t_typewriter_logo: '品牌',
            dialog: '对话',
            dialogue: '对话',
            monologue: '心声',
            action: '动作',
            thought: '心声'
        };
        fieldNames.forEach(function (name) {
            if (obj[name] != null && String(obj[name]).trim()) {
                fields[name] = clipHeartVoiceFieldValue(String(obj[name]).trim());
            }
        });
        Object.keys(aliasMap).forEach(function (ak) {
            var cn = aliasMap[ak];
            if (fieldNames.indexOf(cn) < 0) return;
            if (fields[cn]) return;
            if (obj[ak] != null && String(obj[ak]).trim()) {
                fields[cn] = clipHeartVoiceFieldValue(String(obj[ak]).trim());
            }
        });
        var matched = 0;
        fieldNames.forEach(function (n) {
            if (String(fields[n] || '').trim()) matched += 1;
        });
        if (!matched) return null;
        return fields;
    }

    function parseHeartVoiceInner(inner, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var fieldNames = Array.isArray(opts.fieldNames) ? opts.fieldNames.filter(Boolean) : [];
        var customMode = fieldNames.length > 0;
        var lines = String(inner || '')
            .split(/\n/)
            .map(function (s) {
                return trimLine(s);
            })
            .filter(Boolean);
        if (customMode) {
            var fields = {};
            var currentKey = null;
            var i;
            for (i = 0; i < lines.length; i++) {
                var row = parseHeartVoiceFieldLine(lines[i], fieldNames);
                if (row) {
                    currentKey = row.key;
                    fields[currentKey] = clipHeartVoiceFieldValue(row.value || '');
                    continue;
                }
                if (currentKey && lines[i]) {
                    fields[currentKey] = String(fields[currentKey] || '');
                    if (fields[currentKey]) fields[currentKey] += '\n';
                    fields[currentKey] = clipHeartVoiceFieldValue(fields[currentKey] + lines[i]);
                }
            }
            var matched = 0;
            fieldNames.forEach(function (name) {
                if (String(fields[name] || '').trim()) matched += 1;
            });
            if (!matched) {
                var fromJson = tryParseCustomJsonFields(inner, fieldNames);
                if (fromJson) {
                    fields = fromJson;
                    matched = 0;
                    fieldNames.forEach(function (name) {
                        if (String(fields[name] || '').trim()) matched += 1;
                    });
                }
            }
            var ok = matched > 0;
            return {
                extracted: {
                    mode: 'custom',
                    fields: fields,
                    affection: null,
                    desire: null,
                    action: '',
                    monologue: ''
                },
                extractedOk: ok
            };
        }
        var out = {
            affection: null,
            desire: null,
            action: '',
            monologue: ''
        };
        var j;
        for (j = 0; j < lines.length; j++) {
            var legacy = parseHeartVoiceFieldLine(lines[j]);
            if (!legacy) continue;
            if (legacy.key === '好感度') out.affection = clampHeartVoiceScore(legacy.value);
            else if (legacy.key === '欲望值') out.desire = clampHeartVoiceScore(legacy.value);
            else if (legacy.key === '行为动作')
                out.action = clipHeartVoiceFieldValue(legacy.value || '', HEART_VOICE_LEGACY_LINE_MAX);
            else if (legacy.key === '角色心声')
                out.monologue = clipHeartVoiceFieldValue(legacy.value || '', HEART_VOICE_LEGACY_LINE_MAX);
        }
        var legacyOk =
            out.affection != null &&
            out.desire != null &&
            !!out.action &&
            !!out.monologue;
        return { extracted: out, extractedOk: legacyOk };
    }

    function parseHeartVoiceFromReply(rawText, opts) {
        var src = String(rawText || '');
        var inner = extractHeartVoiceBlock(src);
        var rawHasHeartVoiceTag = /<miyavoice|＜miyavoice|<heartvoice|＜heartvoice|<心声|＜心声|【心声】/i.test(src);
        if (!inner) {
            return {
                rawHasHeartVoiceTag: rawHasHeartVoiceTag,
                extractedOk: false,
                extracted: null,
                updatedAt: Date.now()
            };
        }
        var parsed = parseHeartVoiceInner(inner, opts);
        return {
            rawHasHeartVoiceTag: rawHasHeartVoiceTag,
            extractedOk: !!parsed.extractedOk,
            extracted: parsed.extracted,
            updatedAt: Date.now()
        };
    }

    var HEART_VOICE_LOG_MAX = 100;

    function appendHeartVoiceLog(prevLog, entry) {
        var log = Array.isArray(prevLog) ? prevLog.slice() : [];
        log.unshift(entry);
        if (log.length > HEART_VOICE_LOG_MAX) log.length = HEART_VOICE_LOG_MAX;
        return log;
    }


    /*
     * Token 估算统一走 MiyaToken（js2/miya-token.js）单一来源。
     *
     * 本处原为 Math.ceil(s.length / 1.6) —— 把所有字符一律按 1/1.6 折算，
     * 英文会被显著高估（100 字符英文得 63，而按 4 字符/token 应为 25），
     * 且与世界书、记忆表所用的口径不一致，导致「面板显示」与「预算裁剪」
     * 对同一个 prompt 给出不同的数字。
     *
     * 现在与另两处共用同一实现（中英分别折算）。影响：上下文面板显示的
     * token 数会比以前略低（中文约 -11%，英文显著下降），这是修正高估，
     * 不是把内容算少了。
     *
     * 兜底：MiyaToken 尚未加载时退回等价的内联实现。
     */
    function estimateTokensFromText(text) {
        var t = global.MiyaToken;
        if (t && typeof t.fromText === 'function') return t.fromText(text);
        var s = String(text || '');
        if (!s) return 0;
        var cjk = (s.match(/[\u3400-\u9fff]/g) || []).join('').length;
        var rest = s.length - cjk;
        return Math.max(1, Math.ceil(cjk / 1.8 + rest / 4));
    }

    /** 仅知字符数、无正文时的 token 估算（勿把数字转成字符串再估） */
    function estimateTokensFromCharCount(charCount) {
        var t = global.MiyaToken;
        if (t && typeof t.fromCharCount === 'function') return t.fromCharCount(charCount);
        var n = Number(charCount);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.max(1, Math.ceil(n / 4));
    }

    function estimateMessagesTokens(messages) {
        if (!Array.isArray(messages)) return 0;
        var sum = 0;
        messages.forEach(function (m) {
            if (!m) return;
            sum += estimateTokensFromText(m.content);
            if (m.role) sum += 4;
        });
        return sum;
    }

    /** 实际发往 API 的 messages 正文合计字符数（与请求体 content 一致） */
    function countMessagesChars(messages) {
        if (!Array.isArray(messages)) return 0;
        var sum = 0;
        messages.forEach(function (m) {
            if (!m) return;
            sum += String(m.content || '').length;
        });
        return sum;
    }

    function buildPromptMeta(apiMessages, wbMeta) {
        var list = Array.isArray(apiMessages) ? apiMessages : [];
        var systemChars = 0;
        var historyChars = 0;
        var totalChars = 0;
        var systemText = '';
        list.forEach(function (m) {
            var n = String((m && m.content) || '').length;
            totalChars += n;
            if (m && m.role === 'system') {
                systemChars += n;
                systemText += String(m.content || '') + '\n';
            } else historyChars += n;
        });
        var wb = wbMeta && typeof wbMeta === 'object' ? wbMeta : {};
        var wbChars = Number(wb.injectedChars != null ? wb.injectedChars : wb.chars) || 0;
        var hasHvRules = /miyavoice|heartvoice|心声段|【线上格式规则·心声】/i.test(systemText);
        return {
            estimated_prompt_tokens: estimateMessagesTokens(list),
            total_prompt_chars: totalChars,
            system_chars: systemChars,
            history_chars: historyChars,
            message_count: list.length,
            system_message_count: list.filter(function (m) {
                return m && m.role === 'system';
            }).length,
            has_heartvoice_rules: hasHvRules,
            worldbook_matched: Number(wb.matched) || 0,
            /* 候选数（matcher 判定应当注入的总数）与被预算裁掉的条目数。
               有这两个数，面板才能把「命中 2 条」说成
               「候选 6 条，命中 2 条，预算不足裁剪 4 条」，而不是让人
               对着一个孤零零的 2 猜是不是世界书没生效。 */
            worldbook_considered: Number(wb.consideredCount) || Number(wb.matched) || 0,
            worldbook_dropped: Number(wb.budgetDroppedCount) || 0,
            worldbook_budget_tokens: wb.budgetTokens == null ? 0 : Number(wb.budgetTokens) || 0,
            worldbook_chars: wbChars,
            worldbook_in_system: wb.inSystem !== false,
            worldbook_empty_matched: Number(wb.emptyMatched) || 0,
            updatedAt: Date.now()
        };
    }

    var PROMPT_SOURCE_LABELS = {
        system_lead: '前置系统指令',
        system_main: '系统主提示（人设/档案/规则）',
        st_preset: 'ST 预设',
        worldbook: '世界书（嵌入系统提示）',
        summary: '对话总结记忆',
        char_memory: '角色长期记忆',
        moments_ctx: '朋友圈互动记忆',
        offline: '线下场景总结',
        transfer: '待确认转账',
        per_turn_inject: '本轮注入（格式/心声/单聊锁定）',
        chronicle: '角色档案（人设·背景）',
        call: '通话态指令',
        call_vision: '通话画面/视觉',
        group_memory: '群聊记忆摘录',
        return_prompt: '线上回归提示',
        history_user: '历史·用户消息',
        history_assistant: '历史·角色回复',
        nudge: '续聊/主动推送指令',
        moments_task: '朋友圈自动任务',
        current_user: '本轮用户输入',
        other_system: '其它系统块',
        last_completion: '上轮模型完整回复',
        last_thinking: '上轮思维链（<thinking>）',
        unknown: '未知来源'
    };

    function messageContentText(msg) {
        if (!msg) return '';
        var c = msg.content;
        if (c == null) return '';
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            return c
                .map(function (part) {
                    if (part == null) return '';
                    if (typeof part === 'string') return part;
                    if (part.type === 'text') return String(part.text || '');
                    if (part.type === 'image_url') return '[image]';
                    return '';
                })
                .join('\n');
        }
        return String(c);
    }

    function classifyApiMessageSource(msg, index, messages) {
        var role = msg && msg.role ? msg.role : '';
        var text = String(messageContentText(msg) || '').trim();
        var chars = text.length;
        function row(key, extra) {
            var out = {
                key: key,
                label: PROMPT_SOURCE_LABELS[key] || key,
                chars: chars,
                tokens: estimateTokensFromText(text),
                preview: text.slice(0, 160)
            };
            /* 主系统提示带 __genSection（内部各段），无论走标记还是关键词分支都要带上，
               否则「系统主提示」这一组在面板里展不开具体构成。 */
            if (msg && Array.isArray(msg.__genSection) && msg.__genSection.length) {
                out.genSection = msg.__genSection;
            }
            if (extra && typeof extra === 'object') {
                Object.keys(extra).forEach(function (k) {
                    out[k] = extra[k];
                });
            }
            return out;
        }
        /* 优先用构建期打上的标记：比关键词猜测准，且能带上 ST 条目名。
           __src 由 injectStInChatMessages / 主系统提示拼接处写入。 */
        if (msg && msg.__src && msg.__src.key) {
            var src = msg.__src;
            var tagged = row(src.key, {
                name: src.name || '',
                identifier: src.identifier || '',
                position: src.position || '',
                depth: src.depth == null ? null : src.depth
            });
            tagged.label = src.label || PROMPT_SOURCE_LABELS[src.key] || src.key;
            if (msg.__genSection && msg.__genSection.length) {
                tagged.genSection = msg.__genSection;
                tagged.isMainSystem = true;
            }
            return tagged;
        }
        if (role === 'user') {
            if (/^（请从新的一轮继续|^（请主动发一条|^（通话中：/.test(text)) {
                return row('nudge');
            }
            if (/这是我当前视频画面/.test(text)) return row('call_vision');
            if (index === messages.length - 1) return row('current_user');
            return row('history_user');
        }
        if (role === 'assistant') return row('history_assistant');
        if (role === 'system') {
            if (text.indexOf('【强制任务·仅发朋友圈】') === 0) return row('moments_task');
            if (text.indexOf('【通话态·强制提醒】') === 0) return row('call');
            if (text.indexOf('【用户摄像头画面】') === 0) return row('call_vision');
            if (text.indexOf('【用户摄像头状态】') === 0) return row('call_vision');
            if (text.indexOf('【本轮 · 用户向你转账') === 0) return row('transfer');
            if (text.indexOf('【长期记忆·对话总结】') === 0 || text.indexOf('【本群·记忆总结】') === 0) {
                return row('summary');
            }
            if (text.indexOf('【长期记忆·角色重要记忆】') === 0 || text.indexOf('【角色记忆') >= 0) {
                return row('char_memory');
            }
            if (text.indexOf('【朋友圈·近期互动记忆】') === 0 || text.indexOf('【朋友圈记忆') >= 0) {
                return row('moments_ctx');
            }
            if (text.indexOf('【线下场景总结') >= 0 || text.indexOf('【线下场次总结') >= 0) {
                return row('offline');
            }
            if (
                text.indexOf('【场景锁定·单聊】') === 0 ||
                text.indexOf('【本轮 · 格式') >= 0 ||
                text.indexOf('【重新生成') >= 0 ||
                text.indexOf('【上轮心声') >= 0 ||
                text.indexOf('【本轮 · 单聊') >= 0
            ) {
                return row('per_turn_inject');
            }
            if (text.indexOf('【群聊记忆') >= 0 || text.indexOf('【私聊·群记忆') >= 0) {
                return row('group_memory');
            }
            if (text.indexOf('【线上回归') >= 0 || text.indexOf('【从线下回归') >= 0) {
                return row('return_prompt');
            }
            if (text.indexOf('【角色·档案·') === 0) {
                return row('chronicle');
            }
            var firstSystemIdx = -1;
            for (var si = 0; si < messages.length; si++) {
                if (messages[si] && messages[si].role === 'system') {
                    firstSystemIdx = si;
                    break;
                }
            }
            if (
                index === firstSystemIdx &&
                (text.indexOf('【运转规则') >= 0 ||
                    text.indexOf('【全局提示词】') >= 0 ||
                    text.indexOf('【对话模式') >= 0)
            ) {
                return row('system_main', { isMainSystem: true });
            }
            if (index === 0 && role === 'system' && text.length < 800 && text.indexOf('【运转规则') < 0) {
                return row('system_lead');
            }
            return row('other_system');
        }
        return row('unknown');
    }

    /** 按来源分区统计 prompt 字符/token（供设置页展示） */
    /* 世界书来源项的一句话说明。
       命中数与候选数不一致时（候选 > 命中）必须把差额讲明，否则
       读者会以为世界书没生效。差额来源见 wb.meta.budgetDropped。 */
    function worldbookSourcePreview(wb) {
        var meta = wb && typeof wb === 'object' ? wb : {};
        var matched = Number(meta.matched) || 0;
        var considered = Number(meta.consideredCount) || matched;
        var dropped = Number(meta.budgetDroppedCount) || 0;
        var text = '命中 ' + matched + ' 条世界书条目';
        if (dropped > 0) {
            text = '候选 ' + (considered || matched + dropped) + ' 条，注入 ' + matched +
                ' 条，预算不足裁剪 ' + dropped + ' 条';
        } else if (considered > matched) {
            text = '候选 ' + considered + ' 条，注入 ' + matched + ' 条';
        }
        return text;
    }

    function buildPromptSourceBreakdown(apiMessages, wbMeta) {
        var list = Array.isArray(apiMessages) ? apiMessages : [];
        var wb = wbMeta && typeof wbMeta === 'object' ? wbMeta : {};
        var wbChars = Number(wb.injectedChars != null ? wb.injectedChars : wb.chars) || 0;
        var rawItems = [];
        var mainSystemAdjusted = false;

        list.forEach(function (m, i) {
            var src = classifyApiMessageSource(m, i, list);
            if (src.isMainSystem && wbChars > 0 && src.chars > wbChars) {
                var mainChars = src.chars - wbChars;
                var wbTokens = estimateTokensFromCharCount(wbChars);
                /* 拆出世界书那部分后，剩下的主系统正文仍要带上分段信息，
                   否则「系统主提示」在面板里就永远展不开内部构成。 */
                rawItems.push({
                    key: 'system_main',
                    label: PROMPT_SOURCE_LABELS.system_main,
                    chars: mainChars,
                    tokens: estimateTokensFromCharCount(mainChars),
                    preview: src.preview,
                    genSection: src.genSection || null
                });
                rawItems.push({
                    key: 'worldbook',
                    label: PROMPT_SOURCE_LABELS.worldbook,
                    chars: wbChars,
                    tokens: wbTokens,
                    preview: worldbookSourcePreview(wb)
                });
                mainSystemAdjusted = true;
            } else if (src.isMainSystem && wbChars > 0 && src.chars <= wbChars) {
                rawItems.push({
                    key: 'worldbook',
                    label: PROMPT_SOURCE_LABELS.worldbook,
                    chars: src.chars,
                    tokens: src.tokens,
                    preview: src.preview
                });
                mainSystemAdjusted = true;
            } else {
                rawItems.push(src);
            }
        });

        if (!mainSystemAdjusted && wbChars > 0) {
            rawItems.push({
                key: 'worldbook',
                label: PROMPT_SOURCE_LABELS.worldbook,
                chars: wbChars,
                tokens: estimateTokensFromCharCount(wbChars),
                preview: worldbookSourcePreview(wb)
            });
        }

        var groupedMap = {};
        rawItems.forEach(function (item) {
            var key = item.key || 'unknown';
            if (!groupedMap[key]) {
                groupedMap[key] = {
                    key: key,
                    label: item.label || PROMPT_SOURCE_LABELS[key] || key,
                    chars: 0,
                    tokens: 0,
                    count: 0,
                    items: []
                };
            }
            var g = groupedMap[key];
            g.chars += Number(item.chars) || 0;
            g.tokens += Number(item.tokens) || 0;
            g.count += 1;
            g.items.push(item);
        });

        /*
         * 子项聚合：让「ST 预设」不再是一个笼统的总数，而是能点开看到
         * 具体哪一条（条目名）占了多少。主系统提示则拆成内部各段。
         * 同名条目会合并累加（ST 预设允许重名副本）。
         */
        Object.keys(groupedMap).forEach(function (k) {
            var g = groupedMap[k];
            var subMap = Object.create(null);
            var order = [];
            g.items.forEach(function (item) {
                var subs = [];
                if (Array.isArray(item.genSection) && item.genSection.length) {
                    item.genSection.forEach(function (sec) {
                        subs.push({ name: String(sec.name || '未命名段'), chars: Number(sec.chars) || 0 });
                    });
                } else if (item.name) {
                    subs.push({ name: String(item.name), chars: Number(item.chars) || 0 });
                }
                subs.forEach(function (s) {
                    var subKey = s.name;
                    if (!subMap[subKey]) {
                        subMap[subKey] = { name: s.name, chars: 0, tokens: 0, count: 0 };
                        order.push(subKey);
                    }
                    subMap[subKey].chars += s.chars;
                    subMap[subKey].tokens += estimateTokensFromCharCount(s.chars);
                    subMap[subKey].count += 1;
                });
            });
            var subItems = order
                .map(function (n) { return subMap[n]; })
                .sort(function (a, b) { return (b.chars || 0) - (a.chars || 0); });
            /* 只有一项且与组名重复时不必展示子项；字数全为 0 的也没意义 */
            var totalSub = subItems.reduce(function (n, s) { return n + s.chars; }, 0);
            g.subItems = (subItems.length > 1 || (subItems[0] && subItems[0].name !== g.label)) && totalSub > 0
                ? subItems
                : [];
        });

        var grouped = Object.keys(groupedMap)
            .map(function (k) {
                return groupedMap[k];
            })
            .sort(function (a, b) {
                return (b.chars || 0) - (a.chars || 0);
            });

        var promptChars = countMessagesChars(list);
        var promptTokens = estimateMessagesTokens(list);

        return {
            sources: rawItems,
            grouped: grouped,
            promptChars: promptChars,
            promptTokens: promptTokens,
            worldbookMatched: Number(wb.matched) || 0,
            /* 候选数也进快照：consideredCount 是 matcher 判定「应当注入」的
               总数（ST 概率/分组/预算裁决之前）。快照只记 matched 的话，
               「候选 6 → 注入 2」的差额（4 条被概率/分组/预算裁掉）在回看
               「上次发送」时永远说不出来，只能看到一个孤零零的 2。 */
            worldbookConsidered: Number(wb.consideredCount) || Number(wb.matched) || 0,
            /* 被预算裁掉的条目数：快照也必须记，否则回看历史时同样
               只有命中数、看不到差额，问题会被永久掩盖。 */
            worldbookDropped: Number(wb.budgetDroppedCount) || 0,
            worldbookInSystem: wb.inSystem !== false,
            updatedAt: Date.now()
        };
    }

    /** 调试用：保存本轮实际发往 API 的 messages 快照 */
    function buildPromptDebug(apiMessages) {
        var list = Array.isArray(apiMessages) ? apiMessages : [];
        var systemText = '';
        var totalChars = 0;
        list.forEach(function (m) {
            var c = String((m && m.content) || '');
            totalChars += c.length;
            if (m && m.role === 'system') systemText += c + '\n';
        });
        var opIdx = systemText.indexOf('【运转规则');
        var hvIdx = systemText.indexOf('【线上格式规则·心声');
        var snippet = '';
        if (hvIdx >= 0) snippet = systemText.slice(hvIdx, hvIdx + 600);
        else if (opIdx >= 0) snippet = systemText.slice(opIdx, opIdx + 600);
        var hasHvRules = hvIdx >= 0 || /miyavoice|heartvoice|心声段/i.test(systemText);
        var slim = list.map(function (m, i) {
            return {
                i: i,
                role: m && m.role ? m.role : '',
                chars: String((m && m.content) || '').length,
                content: String((m && m.content) || '')
            };
        });
        var json = '';
        try {
            json = JSON.stringify(slim);
        } catch (e) {
            json = '[]';
        }
        return {
            messagesJson: json,
            hasHeartVoiceRules: hasHvRules,
            heartVoiceRulesSnippet: snippet,
            total_chars: totalChars,
            estimated_tokens: estimateMessagesTokens(list),
            message_count: list.length,
            updatedAt: Date.now()
        };
    }

    /** 从 chat/completions 响应提取 token 用量（如实记录 API 返回字段） */
    function extractUsageFromApi(data) {
        var u =
            (data && data.usage) ||
            (data && data.choices && data.choices[0] && data.choices[0].usage) ||
            null;
        if (!u || typeof u !== 'object') return null;
        var prompt =
            u.prompt_tokens != null
                ? u.prompt_tokens
                : u.input_tokens != null
                  ? u.input_tokens
                  : u.promptTokens;
        var completion =
            u.completion_tokens != null
                ? u.completion_tokens
                : u.output_tokens != null
                  ? u.output_tokens
                  : u.completionTokens;
        var total = u.total_tokens != null ? u.total_tokens : u.totalTokens;
        var p = Number(prompt);
        var c = Number(completion);
        var t = Number(total);
        if (!Number.isFinite(p) && !Number.isFinite(c) && !Number.isFinite(t)) return null;
        var out = {
            prompt_tokens: Number.isFinite(p) ? Math.max(0, Math.floor(p)) : 0,
            completion_tokens: Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0,
            total_tokens: Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0
        };
        if (!out.total_tokens && (out.prompt_tokens || out.completion_tokens)) {
            out.total_tokens = out.prompt_tokens + out.completion_tokens;
        }
        out.updatedAt = Date.now();
        return out;
    }

    /**
     * 单条消息能否写出非空 API 正文（与 appendHistoryToApiMessages 纳入规则一致）。
     * memoryCount 只统计线上可注入消息；关闭注入的角色旁白/空壳不计名额。
     */
    function getHistoryRowApiBody(m, fmtHist) {
        if (!m || m.deleted) return '';
        fmtHist = fmtHist || getOnlineFormatApi();
        if (m.role === 'system' && m.type === 'diary_peek_context') {
            if (fmtHist && typeof fmtHist.formatDiaryPeekContextForApi === 'function') {
                return String(fmtHist.formatDiaryPeekContextForApi(m) || '').trim();
            }
            return String(m.content || '').trim();
        }
        if (fmtHist && typeof fmtHist.shouldOmitMessage === 'function' && fmtHist.shouldOmitMessage(m)) {
            return '';
        }
        if (m.role === 'system') {
            if (fmtHist && typeof fmtHist.isOnlineNarrationMessage === 'function' && fmtHist.isOnlineNarrationMessage(m)) {
                var rowIsUserNarr =
                    fmtHist && typeof fmtHist.isUserOnlineNarrationMessage === 'function'
                        ? fmtHist.isUserOnlineNarrationMessage(m)
                        : String(m.narrationFrom || '') === 'user';
                /* 用户旁白始终可注入；角色旁白才看 excludedFromContext */
                if (!rowIsUserNarr && m.excludedFromContext) return '';
                if (typeof fmtHist.formatNarrationForApi === 'function') {
                    return String(fmtHist.formatNarrationForApi(m) || '').trim();
                }
                return String(m.content || '').trim() ? '旁白-' + String(m.content).trim() : '';
            }
            if (m.type === 'call_capsule' && fmtHist && typeof fmtHist.formatCallCapsuleForApi === 'function') {
                return String(fmtHist.formatCallCapsuleForApi(m) || '').trim();
            }
            if (
                fmtHist &&
                typeof fmtHist.isAlbumAvatarChangeMessage === 'function' &&
                fmtHist.isAlbumAvatarChangeMessage(m)
            ) {
                if (typeof fmtHist.formatAlbumAvatarChangeForApi === 'function') {
                    return String(fmtHist.formatAlbumAvatarChangeForApi(m) || '').trim();
                }
                return String(m.content || '').trim();
            }
            return '';
        }
        if (m.role !== 'user' && m.role !== 'assistant') return '';
        var body =
            fmtHist && typeof fmtHist.formatMessageForApi === 'function'
                ? fmtHist.formatMessageForApi(m)
                : String(m.content || '').trim();
        if (m.role === 'assistant') body = stripThinkingForApi(body);
        return String(body || '').trim();
    }

    /**
     * 按设定 memoryCount 从尾部取最近可注入消息。
     * 线上气泡、线下镜像、可注入系统旁白/胶囊等一律按一条计入名额（与设定条数一致）。
     * 保持时间线原序；空壳不计。
     */
    function sliceHistoryForApiContext(history, limit) {
        var list = Array.isArray(history) ? history : [];
        var lim = Math.min(500, Math.max(1, Number(limit) || HISTORY_LIMIT));
        var fmtHist = getOnlineFormatApi();
        var eligible = [];
        list.forEach(function (m) {
            if (getHistoryRowApiBody(m, fmtHist)) eligible.push(m);
        });
        return eligible.length <= lim ? eligible.slice() : eligible.slice(-lim);
    }

    /**
     * 连续用户消息合并为一条；连续角色气泡/可注入旁白合并为一条 assistant（防网关折叠中间 assistant）。
     * 严格按时间线顺序写出；user / assistant / system 身份不混淆。
     * 开启时间感知时每条带发送时刻前缀。
     */
    function appendHistoryToApiMessages(apiMessages, history, chatSettings) {
        var buf = [];
        var bufStamped = [];
        var asstBuf = [];
        var aw = global.MiyaChatAwareness;
        var nowTs = Date.now();
        var lastStampedTs = 0;
        var fmtHist = getOnlineFormatApi();
        function flushUser() {
            if (!buf.length) return;
            /* stamped 为空时回退原文，避免单条用户消息被时间戳剥离后整段丢掉 */
            var parts = buf.map(function (raw, i) {
                var stamped = bufStamped[i];
                return stamped != null && String(stamped).trim() ? stamped : raw;
            });
            apiMessages.push({
                role: 'user',
                content: parts.join(USER_MSG_JOIN)
            });
            buf = [];
            bufStamped = [];
        }
        function flushAssistant() {
            if (!asstBuf.length) return;
            apiMessages.push({ role: 'assistant', content: asstBuf.join('\n') });
            asstBuf = [];
        }
        function pushAssistantLine(body, m) {
            if (!body) return;
            flushUser();
            var stamped = body;
            if (aw && typeof aw.stampMessageForApi === 'function') {
                stamped = aw.stampMessageForApi(body, m || { role: 'assistant' }, chatSettings, nowTs, lastStampedTs);
            }
            asstBuf.push(stamped);
            lastStampedTs = pickMessageTs(m, lastStampedTs);
        }
        function pushSystemBlock(block) {
            if (!block) return;
            flushUser();
            flushAssistant();
            apiMessages.push({ role: 'system', content: block });
        }
        history.forEach(function (m) {
            if (!m || m.deleted) return;
            if (m.role === 'system' && m.type === 'diary_peek_context') {
                var peekBlock =
                    fmtHist && typeof fmtHist.formatDiaryPeekContextForApi === 'function'
                        ? fmtHist.formatDiaryPeekContextForApi(m)
                        : String(m.content || '').trim();
                pushSystemBlock(peekBlock);
                return;
            }
            if (fmtHist && typeof fmtHist.shouldOmitMessage === 'function' && fmtHist.shouldOmitMessage(m)) {
                return;
            }
            if (m.role === 'system') {
                if (fmtHist && typeof fmtHist.isOnlineNarrationMessage === 'function' && fmtHist.isOnlineNarrationMessage(m)) {
                    var isUserNarr =
                        fmtHist && typeof fmtHist.isUserOnlineNarrationMessage === 'function'
                            ? fmtHist.isUserOnlineNarrationMessage(m)
                            : String(m.narrationFrom || '') === 'user';
                    /* 用户旁白始终注入；角色旁白才受「旁白注入上下文」开关影响 */
                    if (!isUserNarr && m.excludedFromContext) return;
                    var narrBody =
                        typeof fmtHist.formatNarrationForApi === 'function'
                            ? fmtHist.formatNarrationForApi(m)
                            : String(m.content || '').trim()
                              ? '旁白-' + String(m.content).trim()
                              : '';
                    narrBody = String(narrBody || '').trim();
                    if (!narrBody) return;
                    if (isUserNarr) {
                        /* 用户旁白：固定以 system 注入，始终进上下文 */
                        var narrStamp =
                            aw && typeof aw.stampMessageForApi === 'function'
                                ? aw.stampMessageForApi(
                                      narrBody,
                                      Object.assign({}, m, { role: 'user' }),
                                      chatSettings,
                                      nowTs,
                                      lastStampedTs
                                  )
                                : narrBody;
                        pushSystemBlock(narrStamp);
                        lastStampedTs = pickMessageTs(m, lastStampedTs);
                    } else {
                        pushAssistantLine(narrBody, m);
                    }
                    return;
                }
                if (m.type === 'call_capsule' && fmtHist && typeof fmtHist.formatCallCapsuleForApi === 'function') {
                    pushSystemBlock(fmtHist.formatCallCapsuleForApi(m));
                } else if (
                    fmtHist &&
                    typeof fmtHist.isAlbumAvatarChangeMessage === 'function' &&
                    fmtHist.isAlbumAvatarChangeMessage(m)
                ) {
                    var albBlock =
                        fmtHist && typeof fmtHist.formatAlbumAvatarChangeForApi === 'function'
                            ? fmtHist.formatAlbumAvatarChangeForApi(m)
                            : String(m.content || '').trim();
                    pushSystemBlock(albBlock);
                }
                return;
            }
            if (m.role === 'user') {
                var ut =
                    fmtHist && typeof fmtHist.formatMessageForApi === 'function'
                        ? fmtHist.formatMessageForApi(m)
                        : String(m.content || '').trim();
                if (!ut) return;
                flushAssistant();
                ut = applyOfflineMeetLabel(ut, m);
                var stamped =
                    aw && typeof aw.stampMessageForApi === 'function'
                        ? aw.stampMessageForApi(ut, m, chatSettings, nowTs, lastStampedTs)
                        : ut;
                buf.push(ut);
                bufStamped.push(stamped);
                lastStampedTs = pickMessageTs(m, lastStampedTs);
                return;
            }
            if (m.role === 'assistant') {
                var body =
                    fmtHist && typeof fmtHist.formatMessageForApi === 'function'
                        ? fmtHist.formatMessageForApi(m)
                        : String(m.content || '').trim();
                body = stripThinkingForApi(body);
                if (!body) return;
                body = applyOfflineMeetLabel(body, m);
                pushAssistantLine(body, m);
            }
        });
        flushUser();
        flushAssistant();
    }

    function pickMessageTs(m, fallback) {
        var t = Number(m && m.createdAt);
        return Number.isFinite(t) && t > 0 ? t : fallback || 0;
    }

    var pendingOnlineReturnPromptByChat = Object.create(null);

    function filterOfflineMirrorsFromApiHistory(history, apiChatId, contactId) {
        var apMem = global.MiyaAppointmentMemory;
        if (apMem && typeof apMem.filterOfflineMirrorsForApiHistory === 'function') {
            return apMem.filterOfflineMirrorsForApiHistory(history, apiChatId, contactId);
        }
        return (history || []).filter(function (m) {
            return !m || !m.offlineMeet;
        });
    }

    /** 与 buildApiMessages 一致：消息读写用 canonical chatId，避免撤回与上下文错位 */
    function resolveApiChatId(chatId) {
        var cid = String(chatId || '').trim();
        if (!cid) return '';
        var apMem = global.MiyaAppointmentMemory;
        if (apMem && typeof apMem.resolveCanonicalChatId === 'function') {
            return apMem.resolveCanonicalChatId(cid) || cid;
        }
        return cid;
    }

    function omitTrailingAssistantRound(messages) {
        var drop = {};
        getTrailingAssistantRound(messages).forEach(function (m) {
            if (m && m.id) drop[String(m.id)] = true;
        });
        if (!Object.keys(drop).length) return messages || [];
        return (messages || []).filter(function (m) {
            return m && !drop[String(m.id)];
        });
    }

    function applyOfflineMeetLabel(body, m) {
        var text = String(body || '').trim();
        if (!text || !m || !m.offlineMeet) return text;
        var stamp = '';
        try {
            var ts = Number(m.createdAt);
            if (Number.isFinite(ts) && ts > 0) {
                stamp = new Date(ts).toLocaleString('zh-CN', {
                    hour12: false,
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
        } catch (eStamp) {}
        return (stamp ? '〔' + stamp + '·线下〕' : '〔线下〕') + text;
    }

    function formatOfflineMirrorForApiContext(m, fmtCtx) {
        if (!m || m.deleted) return '';
        var body =
            fmtCtx && typeof fmtCtx.formatMessageForApi === 'function'
                ? fmtCtx.formatMessageForApi(m)
                : String(m.content || '').trim();
        return applyOfflineMeetLabel(body, m);
    }

    function getStGenerationSettings() {
        try {
            var st = global.miyaStPromptPresetsStore;
            if (st && typeof st.getActiveGeneration === 'function') return st.getActiveGeneration() || {};
        } catch (e) {}
        return {};
    }

    function buildApiMessages(chatId, userText, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var store = global.miyaChatStore;
        if (!store) return { error: 'store_missing', messages: [] };
        var chat = store.findChat(chatId);
        if (!chat) return { error: 'chat_not_found', messages: [] };
        if (
            chat.type === 'group' &&
            global.MiyaChatGroup &&
            typeof global.MiyaChatGroup.buildApiMessages === 'function'
        ) {
            return global.MiyaChatGroup.buildApiMessages(chatId, userText, opts);
        }
        var contact = store.findContact(chat.contactId);
        if (!contact) return { error: 'contact_not_found', messages: [] };
        var profiles = store.getProfiles();
        var profile = profiles.find(function (p) { return p.id === chat.profileId; }) || store.getActiveProfile();
        if (!profile) return { error: 'profile_missing', messages: [] };

        var apMemCanon = global.MiyaAppointmentMemory;
        var apiChatId = chatId;
        if (apMemCanon && typeof apMemCanon.resolveCanonicalChatId === 'function') {
            apiChatId = apMemCanon.resolveCanonicalChatId(chatId) || chatId;
        }
        if (
            contact &&
            contact.id &&
            global.MiyaAppointmentStore &&
            typeof global.MiyaAppointmentStore.syncAllSessionsToChat === 'function'
        ) {
            try {
                global.MiyaAppointmentStore.syncAllSessionsToChat(apiChatId, contact.id);
            } catch (e) {}
        }

        var history =
            store.getMergedMessagesForApi && typeof store.getMergedMessagesForApi === 'function'
                ? store.getMergedMessagesForApi(chatId)
                : store.getMessagesForApi && typeof store.getMessagesForApi === 'function'
                  ? store.getMessagesForApi(apiChatId)
                  : store.getMessages(apiChatId).filter(function (m) {
                        return m && !m.deleted;
                    });
        var settings = store.getChatSettings ? store.getChatSettings(chatId) : null;
        if (opts.chatSettings && typeof opts.chatSettings === 'object') {
            settings = Object.assign({}, settings || {}, opts.chatSettings);
        }
        var stGeneration = getStGenerationSettings();
        var limit = settings && settings.memoryCount
            ? Math.min(500, Math.max(1, settings.memoryCount))
            : HISTORY_LIMIT;
        /* ST 预设的 contextLength 原先被换算成 stContextChars，却只用于把 limit
           夹到 500，任何正值结果都一样，等于没生效。这里改为真正按 contextLength
           预留历史预算：按约 4 字符/Token 估算可容纳的字符数，再按历史配置取小。 */
        var stContextChars = Number(stGeneration.contextLength) * 4;
        if (Number.isFinite(stContextChars) && stContextChars > 0) {
            limit = Math.min(limit, Math.max(1, Math.floor(stContextChars / 400)));
        }
        /*
         * 每次触发回复都从 store 现读时间线：按 memoryCount 注入最近完整一段
         *（用户 / 角色 / 可注入系统消息 / 线下镜像，各占 1 条名额），顺序与时刻不改写。
         * 已沉淀的分镜/合卷只作为【长期记忆】系统块；不从本窗口剔除原文，以免少注、断档。
         * 线下镜像同样进入分镜/合卷总结时间线（带〔线下〕标记）。
         */
        var historyForAppend = filterOfflineMirrorsFromApiHistory(
            history,
            apiChatId,
            contact && contact.id
        );
        var sliceAppend = sliceHistoryForApiContext(historyForAppend, limit);
        var sliceContext = sliceAppend;
        if (opts.isRegenerate) {
            sliceAppend = omitTrailingAssistantRound(sliceAppend);
            sliceContext = omitTrailingAssistantRound(sliceContext);
        }
        var fmtCtx = getOnlineFormatApi();
        var contextText =
            sliceContext
                .map(function (m) {
                    return formatOfflineMirrorForApiContext(m, fmtCtx);
                })
                .filter(Boolean)
                .join('\n') +
            '\n' +
            userText;
        var timeEventsApi = global.MiyaChatTimeEvents;
        var timeEventsContext =
            !opts.callMode && !opts.appointmentMode && timeEventsApi && typeof timeEventsApi.buildPromptContext === 'function'
                ? timeEventsApi.buildPromptContext(store, chatId, Date.now())
                : '';
        if (timeEventsContext) contextText += '\n\n' + timeEventsContext;
        var farmApi = global.MiyaChatFarm;
        var farmContext =
            !opts.callMode && !opts.appointmentMode && farmApi && typeof farmApi.buildPromptContext === 'function'
                ? farmApi.buildPromptContext(store, chatId, Date.now())
                : '';
        if (farmContext) contextText += '\n\n' + farmContext;
        /*
         * ST 预设分成相对聊天记录的「前置 / 后置」两层。
         * 前置保留背景设定语义；后置在历史注入后再追加，给人称/格式/行为等强执行规则更高的就近性。
         * 传 contact / profile / sliceContext 进去，让条目正文里的 {{char}} / {{user}} / {{lastMessage}}
         * 等宏能被解析成真实值；同一条预设因此可以跨角色复用。
         */
        var stPresetFrontMessages = buildStPresetMessages('front', { contact: contact, profile: profile, history: sliceContext });
        var stPresetBackMessages = buildStPresetMessages('back', { contact: contact, profile: profile, history: sliceContext });

        var wbBundle = buildWorldbookBundle(contact, contextText, null, {
            promptContext: 'online',
            includeAllBoundLocal: true
        });
        var systemContent = opts.callMode
            ? buildCallSystemPrompt({
                  contact: contact,
                  profile: profile,
                  contextText: contextText,
                  chatSettings: settings,
                  history: sliceContext,
                  worldbookFrontLayers: wbBundle.frontLayers,
                  worldbookLayers: wbBundle.layers,
                  worldbookBackLayers: wbBundle.backLayers,
                  callKind: opts.callKind
              })
            : buildSystemPrompt({
                  contact: contact,
                  profile: profile,
                  contextText: contextText,
                  chatSettings: settings,
                  history: sliceContext,
                  worldbookFrontLayers: wbBundle.frontLayers,
                  worldbookLayers: wbBundle.layers
              });
        /* 主系统提示的分段明细：仅非通话路径有，通话走独立构造函数不记分段 */
        var systemSections = opts.callMode ? null : takeLastSystemSections();

        if (wbBundle.meta) {
            var systemLayers = []
                .concat(wbBundle.frontLayers || [], wbBundle.layers || []);
            wbBundle.meta.inSystem =
                systemLayers.length === 0 ||
                systemLayers.every(function (layer) {
                    var chunk = String(layer || '').trim();
                    return !chunk || systemContent.indexOf(chunk) >= 0;
                });
            wbBundle.meta.injectedChars = sumLayerChars(systemLayers) + sumLayerChars(wbBundle.backLayers);
            wbBundle.meta.chars = wbBundle.meta.injectedChars;
        }

        if (timeEventsContext) {
            systemContent += '\n\n' +
                '【现实时钟事件规则】\n' +
                '世界有一份独立的现实时钟账本。时间持续流逝，用户离线不会暂停。到期前不要提前完成；有固定时刻的事件到了当天后，结合当前剧情时间自然推进，禁止突然跳跃。\n' +
                '用户隔多天回来时：已到期事件由系统在正文上方显示卡片；标记为「已错过」的事件，角色必须知道事情已结束，禁止再提议「现在去做/去看」。\n' +
                '需要领取/确认的事件（利息、快递签收等）到期后是「待确认」，只有用户点确认后才算完成，禁止脑补已领取。\n' +
                '只有当事情本身客观需要等待、且本轮剧情已真正发生（存款/下单/预约/委托/报名/种下等）时，才可创建事件。禁止因角色随口说「几天后」「给你准备个东西」就创建。禁止把事件当奖励生成器。\n' +
                '事件是持久化世界状态：不要假装不存在，不要因聊天未再提及而删除或重建。\n' +
                '允许类型：bank_interest, investment, refund, salary, settlement, delivery, appointment, ticket, match, travel, exam, repair, commission, application, plant, fermentation, subscription, lease, general。\n' +
                '禁止：礼物、惊喜、告白、纯浪漫奖励等没有现实等待依据的内容。\n' +
                '创建格式（不要在正文展示标签）：<miyaevent>{"title":"定期利息","type":"bank_interest","description":"存入3万定期","result":"利息到账","dueAt":时间戳毫秒,"needsClaim":true,"natural":true}</miyaevent>\n' +
                '也可用 afterDays 代替 dueAt，例如 "afterDays":7。快递建议 needsClaim:true。';
        }

        var htmlApi = global.MiyaChatHtml;
        var pendingUserText = String(userText || '').trim();
        var htmlMode =
            !opts.callMode &&
            !opts.appointmentMode &&
            htmlApi &&
            typeof htmlApi.detectHtmlModeFromWorldbook === 'function' &&
            htmlApi.detectHtmlModeFromWorldbook(wbBundle);
        if (htmlMode) {
            systemContent =
                systemContent + '\n\n' + htmlApi.buildHtmlGenerationRules({ mode: 'online', fromWorldbook: true });
        }

        var ggMem = global.MiyaChatGroup;
        if (
            !opts.appointmentMode &&
            !opts.callMode &&
            ggMem &&
            typeof ggMem.buildGroupMemoryBlockForPrivate === 'function'
        ) {
            var groupMemBlock = ggMem.buildGroupMemoryBlockForPrivate(
                store,
                contact,
                chat.profileId,
                chatId
            );
            if (groupMemBlock) {
                systemContent = systemContent + '\n\n' + groupMemBlock;
            }
        }

        /* front 预设逐条打来源标记（原来直接 concat 原始对象，条目名丢了）；
           主系统提示单独挂 __genSection + __src，让分类不依赖消息位置，
           这样即使 front 预设把主系统挤到第二个位置也能认出来。 */
        var frontTagged = stPresetFrontMessages.map(function (m) { return stTaggedMessage(m); });
        var mainSystemMsg = {
            role: 'system',
            content: systemContent,
            __src: { key: 'system_main', label: PROMPT_SOURCE_LABELS.system_main, name: '' }
        };
        if (systemSections && systemSections.length) {
            mainSystemMsg.__genSection = systemSections;
        }
        var apiMessages = frontTagged.concat([mainSystemMsg]);
        var awInject = global.MiyaChatAwareness;
        var summaryBlock =
            awInject && typeof awInject.buildSummaryContextBlock === 'function'
                ? awInject.buildSummaryContextBlock(settings)
                : '';
        if (summaryBlock) {
            apiMessages.push({ role: 'system', content: summaryBlock });
        }
        var memExtract = global.MiyaChatMemoryExtract;
        var charMemBlock =
            memExtract && typeof memExtract.buildCharMemoryContextBlock === 'function'
                ? memExtract.buildCharMemoryContextBlock(settings)
                : '';
        if (charMemBlock) {
            apiMessages.push({ role: 'system', content: charMemBlock });
        }
        /*
         * 【时间线纪律】防「时空错位」的硬约束。
         *
         * 用户实测症状：昨天下的飞机，今天说「那你路上吃点东西」，角色答「在飞机上吃了」。
         * 根因是模型把历史里的旧场景当成了「当下」，拿过期事件回答新问题。
         *
         * 只看近期原文窗口是不够的 —— 旧事件往往还在窗口内，模型仍可能误判。
         * 所以这里显式写死三条判读规则：以最新一条消息为「现在」，旧事件的完成态不得
         * 当成当下进行态，需要旧细节时以总结/记忆为准而非脑补。
         * 仅在时间运转开启时注入（时间关闭时无从判断先后，加了反而误导）。
         */
        try {
            var taCfg = settings && settings.timeAwareness;
            if (taCfg && taCfg.enabled && taCfg.mode === 'real') {
                var timelineDiscipline = [
                    '【时间线纪律·强制】',
                    '1、判断「现在」只依据最新一条消息；更早消息里的场景属于过去，已完成的事不得当成正在发生。',
                    '2、历史消息前缀 ⧗…› 是该条真实发送时刻，与「现在」可能有数天差距；跨天时按天差理解，勿把昨天的场景接到今天。',
                    '3、用户提到的事若与某条旧消息冲突，以「时间更晚的那条」为准；不确定时先如实说记不清，禁止拿旧细节硬编成当下。',
                    '4、已知发生过的事（如已抵达、已结束）不要重复提议「现在去做/现在去经历」。',
                    '5、需要追溯窗口外的细节时，优先依据上方【长期记忆】块，而不是自行补全。'
                ].join('\n');
                apiMessages.push({ role: 'system', content: timelineDiscipline });
            }
        } catch (eTimeline) {}
        var mmApi = global.MiyaChatMoments;
        var momentsBlock =
            mmApi && typeof mmApi.buildMomentsContextBlock === 'function'
                ? mmApi.buildMomentsContextBlock(settings)
                : '';
        if (momentsBlock) {
            apiMessages.push({ role: 'system', content: momentsBlock });
        }
        var returnPrompt = String(pendingOnlineReturnPromptByChat[apiChatId] || pendingOnlineReturnPromptByChat[chatId] || '').trim();
        var apMem = global.MiyaAppointmentMemory;
        var offSumText = '';
        if (!opts.appointmentMode && !opts.callMode && apMem && typeof apMem.buildOfflineSummaryBlocks === 'function') {
            var aps = global.MiyaAppointmentStore;
            if (aps && aps.exportForMemory) {
                var offSum = apMem.buildOfflineSummaryBlocks(aps.exportForMemory(apiChatId, contact.id));
                offSumText = apMem.buildSummaryBlocksText ? apMem.buildSummaryBlocksText(offSum) : '';
            }
        }
        var hasOfflineMirror = (sliceAppend || []).some(function (m) {
            return m && m.offlineMeet;
        });
        /*
         * 备用注入：镜像因 chatMirrorId 失效 / 线程迁移 / 落盘冲掉而未进时间线时，
         * 仍从线下 session 拉总结与未总结尾巴，避免「封存了线上却失忆」。
         */
        var offlineCrossSlots = [];
        if (
            !opts.appointmentMode &&
            !opts.callMode &&
            apMem &&
            typeof apMem.buildOnlineCrossMemory === 'function' &&
            (!hasOfflineMirror || !offSumText)
        ) {
            try {
                var crossMem = apMem.buildOnlineCrossMemory(apiChatId, contact, profile, settings);
                var crossSlots = (crossMem && crossMem.slotItems) || [];
                if (!offSumText) {
                    var sumSlots = crossSlots.filter(function (it) {
                        return it && it.kind === 'summary' && String(it.content || '').trim();
                    });
                    if (sumSlots.length) {
                        offSumText = sumSlots
                            .map(function (it) {
                                return String(it.content || '').trim();
                            })
                            .join('\n\n');
                    }
                }
                if (!hasOfflineMirror) {
                    offlineCrossSlots = crossSlots.filter(function (it) {
                        return it && it.kind === 'message' && String(it.content || '').trim();
                    });
                }
            } catch (eCross) {}
        }
        if (
            !opts.appointmentMode &&
            !opts.callMode &&
            apMem &&
            typeof apMem.buildMemoryInteropPreambleBlock === 'function' &&
            (offSumText || hasOfflineMirror || offlineCrossSlots.length || returnPrompt)
        ) {
            apiMessages.push({ role: 'system', content: apMem.buildMemoryInteropPreambleBlock('online') });
        }
        if (returnPrompt) {
            apiMessages.push({ role: 'system', content: returnPrompt });
            delete pendingOnlineReturnPromptByChat[apiChatId];
            delete pendingOnlineReturnPromptByChat[chatId];
        }
        if (offSumText) {
            apiMessages.push({ role: 'system', content: offSumText });
        }
        /*
         * 群聊记忆：该联系人在群里经历过的事，渗入他的单聊上下文。
         *
         * 只在单聊注入 —— 群聊自己不需要看到「自己在群里的记忆」（那是它正发生在的事）。
         * 账本按 contactId 取本人视角，天然不穿帮：A 拿不到 B 的内心活动。
         */
        if (!opts.appointmentMode && !opts.callMode && contact && contact.id) {
            var gleMod = global.MiyaChatGroupLedger;
            if (gleMod && typeof gleMod.buildLedgerBlockForContact === 'function') {
                try {
                    var gleBlock = String(gleMod.buildLedgerBlockForContact(contact.id) || '').trim();
                    if (gleBlock) {
                        apiMessages.push({
                            role: 'system',
                            content:
                                '【群聊记忆·只读】\n' +
                                '以下是该角色在群聊中亲身经历过的事（不是本次私聊的内容）。\n' +
                                '他知道这些事，可以自然提及或受其影响，但不要复述成聊天记录格式，也不要在私聊里假装那是你们两人的对话。\n\n' +
                                gleBlock
                        });
                    }
                } catch (eGle) {}
            }
        }
        if (
            offlineCrossSlots.length &&
            apMem &&
            typeof apMem.injectCrossMemoryToApiMessages === 'function'
        ) {
            apMem.injectCrossMemoryToApiMessages(apiMessages, offlineCrossSlots, '线下');
        }
        var historySettings = settings;
        if (!opts.callMode && !opts.appointmentMode) {
            historySettings = Object.assign({}, settings || {}, { timeAwareness: { enabled: false } });
        }
        var onlineHistoryStart = apiMessages.length;
        appendHistoryToApiMessages(apiMessages, sliceAppend, historySettings);
        if (!opts.callMode && !opts.appointmentMode) {
            attachTrailingRoundPhotosToApiMessages(apiMessages, sliceAppend);
        }
        /*
         * ST-compatible In-Chat injection. Do not append these prompts as a generic
         * system tail: they belong at injection_depth inside the conversation.
         */
        injectStInChatMessages(apiMessages, onlineHistoryStart, stPresetBackMessages);
        appendOnlineHeartVoicePriorityMessage(apiMessages, contact, settings, opts);
        var historyTailState = getTrailingSpeakerState(sliceAppend);
        /*
         * 主动/离线的 systemLead 必须紧挨历史之后：先看见带时间戳的对话，再读触发说明。
         * 原先 unshift 到最前会抢注意力，模型容易忽视上下文、只盯时间空话。
         */
        if (opts.systemLead) {
            apiMessages.push({ role: 'system', content: String(opts.systemLead) });
        }
        /* 末条续写块按本轮实际注入历史判断；有 systemLead 时也要加，避免预生成 lead 与历史脱节 */
        var postHistBlock = buildPostHistoryContinuationBlock(sliceAppend, opts);
        if (postHistBlock) {
            apiMessages.push({ role: 'system', content: postHistBlock });
        }

        var fmtXfer = getOnlineFormatApi();
        if (
            fmtXfer &&
            typeof fmtXfer.collectPendingUserTransfersInRound === 'function' &&
            typeof fmtXfer.buildTransferUserRespondBlock === 'function' &&
            !opts.isAutoPush &&
            !opts.isOffline &&
            !opts.isMomentsAuto
        ) {
            var pendingUserXfer = fmtXfer.collectPendingUserTransfersInRound(sliceAppend);
            if (pendingUserXfer.length) {
                var xferBlock = fmtXfer.buildTransferUserRespondBlock(
                    pendingUserXfer,
                    (contact && contact.name) || '角色'
                );
                if (xferBlock) {
                    apiMessages.push({ role: 'system', content: xferBlock });
                }
            }
        }

        var cpBridge = global.miyaCoupleBridge;
        if (
            cpBridge &&
            typeof cpBridge.collectPendingCoupleInvitesInRound === 'function' &&
            typeof cpBridge.buildCoupleInviteRespondBlock === 'function' &&
            !opts.isAutoPush &&
            !opts.isOffline &&
            !opts.isMomentsAuto
        ) {
            var pendingCoupleInv = cpBridge.collectPendingCoupleInvitesInRound(sliceAppend);
            if (pendingCoupleInv.length) {
                var coupleBlock = cpBridge.buildCoupleInviteRespondBlock(
                    pendingCoupleInv,
                    (contact && contact.name) || '角色'
                );
                if (coupleBlock) {
                    apiMessages.push({ role: 'system', content: coupleBlock });
                }
            }
        }

        if (
            cpBridge &&
            typeof cpBridge.buildCoupleCommemorationBlock === 'function' &&
            !opts.isAutoPush &&
            !opts.isOffline &&
            !opts.isMomentsAuto &&
            !opts.callMode &&
            contact &&
            contact.id
        ) {
            var commBlock = cpBridge.buildCoupleCommemorationBlock(contact);
            if (commBlock) {
                apiMessages.push({ role: 'system', content: commBlock });
            }
        }

        if (
            opts.lovePoemMode &&
            String(opts.lovePoemStyle || '').trim() &&
            !opts.isAutoPush &&
            !opts.isOffline &&
            !opts.isMomentsAuto &&
            !opts.callMode
        ) {
            var poemUi = global.MiyaChatLovePoem;
            var poemBlock =
                poemUi && typeof poemUi.buildLovePoemInjectBlock === 'function'
                    ? poemUi.buildLovePoemInjectBlock({
                          style: opts.lovePoemStyle,
                          roleName: (contact && contact.name) || '角色'
                      })
                    : '';
            if (poemBlock) {
                apiMessages.push({ role: 'system', content: poemBlock });
            }
        }

        /*
         * 每轮固定注入块（场景锁定、格式提醒等）。
         *
         * 这些块的内容**每轮都发、且每轮都一样**，所以它们本身不该破坏缓存。
         * 但如果把它们 append 在历史之后，位置就会随历史增长而**逐轮后移**：
         * 第 2 轮它前面有 4 条历史，第 5 轮它前面有 10 条——它在整个请求里的
         * 偏移每轮都在变，于是它之前的内容虽然没动，服务商看到的却是
         * 「前缀每一轮都不一样」，提示缓存 100% 重建。
         *
         * 实测（真机浏览器，线上四连轮）：修复前命中率 0%。
         *
         * 修法：锚定到历史区起点之前（onlineHistoryStart 已在上面记好），
         * 让这些块跟在「模式/预设/记忆」之后、历史之前。
         * 位置固定 → 前缀稳定 → 缓存可命中；语义上它们本就是「本轮规则」，
         * 放在历史前同样成立，且不再挡在生成末端。
         */
        var perTurnBlocks = buildPerTurnOnlineInjectBlocks(chat, contact, settings, {
            callMode: !!opts.callMode,
            appointmentMode: !!opts.appointmentMode,
            isOffline: !!opts.isOffline,
            isAutoPush: !!opts.isAutoPush,
            isLifeLike: !!opts.isLifeLike,
            isRegenerate: !!opts.isRegenerate,
            htmlMode: !!htmlMode,
            history: sliceAppend
        });
        if (perTurnBlocks && perTurnBlocks.length) {
            var injectAt = (typeof onlineHistoryStart === 'number' && onlineHistoryStart >= 0)
                ? onlineHistoryStart
                : apiMessages.length;
            var perTurnMsgs = perTurnBlocks.map(function (block) {
                return { role: 'system', content: block };
            });
            /* splice 展开传参，保持与原 push 顺序一致 */
            apiMessages.splice.apply(apiMessages, [injectAt, 0].concat(perTurnMsgs));
        }

        var last = apiMessages[apiMessages.length - 1];
        var extra = String(userText || '').trim();
        if (extra) {
            if (last && last.role === 'user') {
                last.content = last.content ? last.content + USER_MSG_JOIN + extra : extra;
            } else {
                apiMessages.push({ role: 'user', content: extra });
            }
        }

        if (opts.callMode) {
            apiMessages.push({
                role: 'system',
                content:
                    '【通话态·强制提醒】你正在与用户进行实时' +
                    (opts.callKind === 'video' ? '视频' : '语音') +
                    '通话；绝不是线上文字聊天。请只输出通话口语对白。'
            });
            if (
                global.MiyaChatCalls &&
                typeof global.MiyaChatCalls.buildActiveTranscriptSystemBlock === 'function'
            ) {
                var callTb = global.MiyaChatCalls.buildActiveTranscriptSystemBlock(opts.callId);
                if (callTb) apiMessages.push({ role: 'system', content: callTb });
            }
        }
        if (opts.callMode && opts.cameraFrameDataUrl) {
            apiMessages.push({
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '这是我当前视频画面，请结合画面与对话继续视频通话。'
                    },
                    { type: 'image_url', image_url: { url: String(opts.cameraFrameDataUrl) } }
                ]
            });
        } else if (opts.callMode && opts.cameraVisionNote) {
            apiMessages.push({
                role: 'system',
                content: '【用户摄像头画面】\n' + String(opts.cameraVisionNote).trim()
            });
        } else if (opts.callMode && opts.cameraOff) {
            apiMessages.push({
                role: 'system',
                content:
                    '【用户摄像头状态】用户已关闭摄像头。你当前看不到任何画面，禁止描述、猜测或编造用户外貌、表情、动作、穿着、环境等视觉内容；只根据语音/文字对白继续通话。'
            });
        }

        if (opts.callMode && opts.skipUserMessage && !extra && historyTailState === 'assistant_spoke_last') {
            apiMessages.push({
                role: 'user',
                content:
                    '（通话中：请用口语继续，每行一句对白，1–15 行由你根据人设与情境自行决定，遵守通话格式规则）'
            });
        }

        if (!opts.isAutoPush && !opts.isOffline && !opts.isMomentsAuto && !opts.isLifeLike) {
            /*
             * resumeRewrite 的判定条件与下发给 nudge 的条件**刻意不同**：
             *
             * nudge 只在 skipUserMessage && !extra 时下发（即「本轮用户话已经在历史里」），
             * 但引擎调用方一律是 buildApiMessages(chatId, '', options)，
             * 所以 !extra 恒成立；而普通发送不会传 skipUserMessage ——
             * 用户那句话是 persistUser 刚写进 store、以「历史里最后一条」的身份出现的。
             *
             * 也就是说：真正的普通发送 path 里 opts.skipUserMessage 是 undefined。
             * 早期版本在这里也要求 skipUserMessage，结果就是**一条都没命中** ——
             * 用户报的「删除后还有概率复读」依旧存在。
             *
             * 所以判定只认两件事：末条是用户发言 + store 上挂着新鲜的「删了角色回复」标记。
             *
             * 另外，通话/预约模式**不消费标记**：这两种流程的 nudge 有自己的
             * 专用模板（appendManualActionTailNudge 对 callMode/appointmentMode
             * 直接 return），标记若被它们吃掉，用户挂了电话回来再打字时
             * 改写约束就凭空消失了 —— 又是一条「标记被静默消费」的复读缝。
             */
            var resumeRewrite = false;
            if (!opts.isRegenerate && !opts.callMode && !opts.appointmentMode &&
                !extra && historyTailState === 'user_spoke_last') {
                resumeRewrite = shouldApplyResumeRewrite(apiChatId, opts);
            }
            appendManualActionTailNudge(
                apiMessages,
                opts,
                historyTailState,
                !!extra,
                apiChatId,
                resumeRewrite
            );
        }
        if (opts.isMomentsAuto) {
            var momentsLines = [
                '【强制任务·仅发朋友圈】',
                '忽略上文所有聊天气泡、<thinking>、<miyavoice>、旁白等格式要求。',
                '你必须只输出恰好一行：【发朋友圈：正文|配图1：图片描述】',
                '禁止输出任何其它文字。'
            ];
            var trMoments = global.MiyaChatTranslate;
            if (
                trMoments &&
                settings &&
                settings.autoTranslate &&
                settings.momentsTranslate &&
                isSemanticAutoTranslate(settings) &&
                typeof trMoments.buildMomentsAutoSemanticInject === 'function'
            ) {
                momentsLines.splice(
                    3,
                    0,
                    trMoments.buildMomentsAutoSemanticInject(getTranslateTargetFromSettings(settings))
                );
            }
            apiMessages.push({
                role: 'system',
                content: momentsLines.join('\n')
            });
        } else if (opts.isAutoPush || opts.isOffline || opts.isLifeLike) {
            var tail = apiMessages[apiMessages.length - 1];
            if (!tail || tail.role !== 'user') {
                var proactiveTail;
                if (historyTailState === 'assistant_spoke_last') {
                    proactiveTail = buildAssistantContinueTailNudge({ isLifeLike: !!opts.isLifeLike });
                } else if (historyTailState === 'user_spoke_last') {
                    var llTailUser = global.MiyaChatLifeLike;
                    var nextPushTailUser =
                        opts.isLifeLike && llTailUser && llTailUser.TAG_OPEN && llTailUser.TAG_CLOSE
                            ? '；全文最末必须另起一行输出 ' +
                              llTailUser.TAG_OPEN +
                              'YYYY-MM-DD HH:mm' +
                              llTailUser.TAG_CLOSE
                            : '';
                    var fmtPin = getOnlineFormatApi();
                    var pinRound =
                        fmtPin && typeof fmtPin.formatUserRoundLinesForRegenerate === 'function'
                            ? String(
                                  fmtPin.formatUserRoundLinesForRegenerate(sliceAppend, settings) || ''
                              ).trim()
                            : '';
                    if (pinRound) {
                        proactiveTail =
                            '（【末尾用户侧·纳入衔接】\n' +
                            pinRound +
                            '\n顺着上文末尾几条（含以上）自然发微信，兼顾时间间隔；禁止假装未见或抱怨没回；禁止抛开末尾接旧话题；' +
                            ONLINE_THREE_PART_TAIL +
                            nextPushTailUser +
                            '）';
                    } else {
                        proactiveTail =
                            '（主动轮：自然衔接上文末尾几条并兼顾时间；末条是用户时勿假装未见；禁止抱怨没回；' +
                            ONLINE_THREE_PART_TAIL +
                            nextPushTailUser +
                            '）';
                    }
                } else {
                    proactiveTail = buildOnlineProactiveTailNudge();
                }
                apiMessages.push({ role: 'user', content: proactiveTail });
            }
        }

        if (!opts.callMode && !opts.appointmentMode) {
            /*
             * 先插深度注入，再追加 back。
             * 顺序有讲究：深度注入按 depth 从末尾往回定位，它算的是
             * 「此刻 apiMessages 的长度」。若先 append back，那些 back 块
             * 会参与计数，导致深度位置整体偏移。back 追加到末尾不影响
             * 已插好的中间位置，所以先深度、后 back 是安全的。
             */
            insertWorldbookInChatMessages(apiMessages, wbBundle.inChatItems);
            appendWorldbookBackMessages(apiMessages, wbBundle.backLayers);
        }
        /*
         * chatId 显式带上：appendChronicle 要靠它判断是不是「第一楼」，
         * 而 opts 是上游传进来的，不保证一定含 chatId。
         */
        appendChronicleBeforeOperationRulesMessage(
          apiMessages, contact, Object.assign({}, opts, { chatId: chatId })
        );
        /*
         * ST 最终执行层（线上）：把启用中的 ST 预设条目原文送到生成前最近位置。
         *
         * ST 的工作流是「先读提示词与预设 → 生成思维链 CoT → 再输出正文」，
         * 所以身份 / 环境 / 世界观 / 人称 / 格式等规则必须出现在思维链开始之前，
         * 否则模型会另起一套默认角色设定，表现为「思维链里没有预设身份」。
         *
         * 位置取在所有世界书后置与编年史之后、【生成前最后确认】之前：
         * 既贴近生成点拿到强注意力，又不会打断「最后确认」紧贴末尾的衔接语义。
         * 原先 buildStCotPromptBlock() 只定义与导出、从未被调用，属于断链，此处补上。
         *
         * 去重：全部启用条目都已在 buildStPresetMessages 阶段分配了去处 ——
         * relative 条目拼进 apiMessages 最前面，in_chat 条目按深度插进历史内部。
         * 若这里再把整份原文拼一遍，同一段规则会出现两次，既浪费预算又稀释注意力。
         * 因此本层默认只做「执行检查」提示，不再重复正文；
         * 仅当本轮压根没有任何 ST 条目落到 apiMessages 时，才退化为全量兜底输出。
         */
        if (!opts.callMode) {
            try {
                var stCotBlockOnline = String(buildStCotPromptBlock() || '').trim();
                if (stCotBlockOnline) {
                    var stPresetInjected = (stPresetFrontMessages || []).concat(stPresetBackMessages || [])
                        .some(function (m) { return String(m && m.content || '').trim(); });
                    /* 正文已在上文注入过，这里只补一条轻量的执行检查提示。 */
                    if (!stPresetInjected) {
                        apiMessages.push({ role: 'system', content: stCotBlockOnline });
                    } else {
                        var stCheckHint = buildStPresetCheckHint();
                        if (stCheckHint) apiMessages.push({ role: 'system', content: stCheckHint });
                    }
                }
            } catch (eStCotOnline) {}
        }
        if (
            historyTailState === 'assistant_spoke_last' &&
            !opts.callMode &&
            !opts.appointmentMode &&
            !opts.isMomentsAuto &&
            !opts.isRegenerate
        ) {
            apiMessages.push({
                role: 'system',
                content:
                    opts.isAutoPush || opts.isOffline || opts.isLifeLike
                        ? '【生成前最后确认】主动轮且末条是你方：自然衔接上文末尾几条并兼顾时间间隔；禁止把用户上一轮当必答；禁止催回/抱怨没回；勿复读上轮相似内容。'
                        : '【生成前最后确认】上下文末条是你方发言、用户尚未回复：禁止重答用户旧话或复读上轮相似内容；须从你方最近一条自然续写。'
            });
        } else if (
            historyTailState === 'user_spoke_last' &&
            (opts.isAutoPush || opts.isOffline || opts.isLifeLike) &&
            !opts.callMode &&
            !opts.appointmentMode
        ) {
            var fmtFinal = getOnlineFormatApi();
            var finalPin =
                fmtFinal && typeof fmtFinal.formatUserRoundLinesForRegenerate === 'function'
                    ? String(fmtFinal.formatUserRoundLinesForRegenerate(sliceAppend, settings) || '').trim()
                    : '';
            if (finalPin) {
                apiMessages.push({
                    role: 'system',
                    content:
                        '【生成前最后确认·末尾衔接】时间线末尾用户侧原文：\n' +
                        finalPin +
                        '\n须把以上纳入自然衔接（兼顾时间间隔）；禁止假装未见、禁止抱怨没回、禁止抛开末尾接旧话题。'
                });
            } else {
                apiMessages.push({
                    role: 'system',
                    content:
                        '【生成前最后确认】主动轮且末条是用户：自然衔接上文末尾几条并兼顾时间；勿假装未见，勿抱怨没回，勿接旧话题。'
                });
            }
        }

        return {
            messages: apiMessages,
            contact: contact,
            profile: profile,
            chat: chat,
            latestHumanRole: sliceAppend.length ? sliceAppend[sliceAppend.length - 1].role : '',
            htmlMode: !!htmlMode,
            promptMeta: buildPromptMeta(apiMessages, wbBundle.meta),
            worldbookMeta: wbBundle.meta
        };
    }

    function normalizeMessageContent(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content.trim();
        if (Array.isArray(content)) {
            var parts = [];
            content.forEach(function (part) {
                if (part == null) return;
                if (typeof part === 'string') {
                    if (part.trim()) parts.push(part.trim());
                    return;
                }
                if (typeof part === 'object') {
                    var t =
                        part.text != null
                            ? part.text
                            : part.content != null
                              ? part.content
                              : part.output_text != null
                                ? part.output_text
                                : part.value;
                    if (t != null && String(t).trim()) parts.push(String(t).trim());
                }
            });
            return parts.join('\n').trim();
        }
        var s = String(content).trim();
        return s === '[object Object]' ? '' : s;
    }

    function extractReplyContent(data) {
        if (!data) return '';
        if (data.error && typeof data.error === 'object') return '';

        function pickFromChoice(ch) {
            if (!ch) return '';
            var body = '';
            var msg = ch.message;
            if (msg && typeof msg === 'object') {
                var main = normalizeMessageContent(msg.content);
                if (main) return main;
                if (msg.refusal != null) {
                    body = normalizeMessageContent(msg.refusal);
                    if (body) return body;
                }
                return '';
            }
            if (ch.delta && ch.delta.content != null) {
                body = normalizeMessageContent(ch.delta.content);
                if (body) return body;
            }
            if (ch.text != null) {
                body = normalizeMessageContent(ch.text);
                if (body) return body;
            }
            return '';
        }

        var choices = data.choices;
        if (Array.isArray(choices)) {
            var i;
            for (i = 0; i < choices.length; i++) {
                var picked = pickFromChoice(choices[i]);
                if (picked) return picked;
            }
        }

        var top =
            data.output != null
                ? data.output
                : data.content != null
                  ? data.content
                  : data.result != null
                    ? data.result
                    : data.response != null
                      ? data.response
                      : data.text != null
                        ? data.text
                        : null;
        if (top != null) {
            var normalized = normalizeMessageContent(top);
            if (normalized) return normalized;
        }
        if (data.message && typeof data.message === 'object') {
            var msgBody = normalizeMessageContent(data.message.content);
            if (msgBody) return msgBody;
        }
        return '';
    }

    function buildSalvageBubbleText(replyRaw) {
        var s = stripHeartVoiceTags(stripThinkingBlocks(String(replyRaw || ''))).trim();
        if (s) return s;
        var bare = String(replyRaw || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return bare.slice(0, 2000);
    }

    var CHAT_COMPLETION_MAX_ATTEMPTS = 3;

    function resolveChatApiSlice(cfg, useSecondary) {
        if (useSecondary) {
            var sec = cfg.secondaryApi && typeof cfg.secondaryApi === 'object' ? cfg.secondaryApi : {};
            return {
                baseUrl: normalizeBaseUrl(sec.baseUrl),
                apiKey: String(sec.apiKey || '').trim(),
                model: String(sec.model || '').trim(),
                temperature: sec.temperature != null ? Number(sec.temperature) : (cfg.temperature != null ? Number(cfg.temperature) : 1)
            };
        }
        return {
            baseUrl: normalizeBaseUrl(cfg.baseUrl),
            apiKey: String(cfg.apiKey || '').trim(),
            model: String(cfg.model || '').trim(),
            temperature: cfg.temperature != null ? Number(cfg.temperature) : 1
        };
    }

    function hasSecondaryApiConfigured(cfg) {
        var sec = cfg.secondaryApi && typeof cfg.secondaryApi === 'object' ? cfg.secondaryApi : {};
        return !!(normalizeBaseUrl(sec.baseUrl) && String(sec.apiKey || '').trim() && String(sec.model || '').trim());
    }

    function fetchChatCompletion(url, headers, payload, attempt, signal) {
        var tryNo = Math.max(1, Number(attempt) || 1);
        var opts = {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        };
        if (signal) opts.signal = signal;
        return fetch(url, opts)
            .then(function (r) {
                if (!r.ok) {
                    return r.text().then(function (t) {
                        throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 200) : ''));
                    });
                }
                return r.json();
            })
            .then(function (data) {
                var replyRaw = extractReplyContent(data);
                if (!replyRaw && tryNo < CHAT_COMPLETION_MAX_ATTEMPTS) {
                    if (signal && signal.aborted) {
                        var abortErr = new Error('aborted');
                        abortErr.name = 'AbortError';
                        throw abortErr;
                    }
                    return fetchChatCompletion(url, headers, payload, tryNo + 1, signal);
                }
                return { data: data, replyRaw: replyRaw };
            });
    }

    function extractBodyForBubbles(rawText) {
        var raw = String(rawText || '');
        var hvIdx = raw.search(/<miyavoice\b|＜miyavoice|<heartvoice\b|＜heartvoice/i);
        if (hvIdx >= 0) raw = raw.slice(0, hvIdx);
        if (findLastThinkingCloseEnd(raw) >= 0) {
            raw = extractBodyAfterThinkingClose(raw);
        } else {
            raw = stripThinkingBlocks(raw);
        }
        raw = stripHeartVoiceTags(raw);
        if (global.MiyaChatLifeLike && typeof global.MiyaChatLifeLike.stripNextPushTags === 'function') {
            raw = global.MiyaChatLifeLike.stripNextPushTags(raw);
        }
        raw = stripStructuralMarkerLines(raw);
        return raw.trim();
    }

    function splitBubbles(text) {
        var raw = stripStructuralMarkerLines(stripHeartVoiceTags(stripThinkingBlocks(String(text || '')))).trim();
        if (!raw) return [];

        if (raw.indexOf('|||') >= 0) {
            return raw
                .split('|||')
                .map(function (s) {
                    return s.trim();
                })
                .filter(Boolean);
        }

        var lines = raw
            .split(/\n/)
            .map(function (s) {
                return s.trim();
            })
            .filter(Boolean);
        var aw = global.MiyaChatAwareness;
        if (aw && typeof aw.splitCollapsedTimelineSegments === 'function') {
            var expanded = [];
            lines.forEach(function (line) {
                var segs = aw.splitCollapsedTimelineSegments(line);
                if (segs.length > 1) {
                    segs.forEach(function (s) {
                        if (s) expanded.push(s);
                    });
                } else {
                    expanded.push(segs[0] || line);
                }
            });
            lines = expanded.filter(Boolean);
        }
        if (aw && typeof aw.stripTimelinePrefixForDisplay === 'function') {
            lines = lines.map(function (line) {
                return aw.stripTimelinePrefixForDisplay(line);
            }).filter(Boolean);
        }
        var fmtSplit = getOnlineFormatApi();
        if (fmtSplit && typeof fmtSplit.splitCollapsedOnlineTypeLines === 'function') {
            var expanded = [];
            lines.forEach(function (line) {
                var parts = fmtSplit.splitCollapsedOnlineTypeLines(line);
                if (parts.length > 1) parts.forEach(function (p) { if (p) expanded.push(p); });
                else expanded.push(parts[0] || line);
            });
            lines = expanded.filter(Boolean);
        }
        if (fmtSplit && typeof fmtSplit.sanitizeRoleOutputLines === 'function') {
            lines = fmtSplit.sanitizeRoleOutputLines(lines);
        }
        if (fmtSplit && typeof fmtSplit.filterStructuralLeakLines === 'function') {
            lines = fmtSplit.filterStructuralLeakLines(lines);
        }
        if (fmtSplit && typeof fmtSplit.collapseDuplicateBubbleLines === 'function') {
            lines = fmtSplit.collapseDuplicateBubbleLines(lines);
        }
        if (lines.length > 1) return lines;
        if (lines.length === 1) return lines;
        return [];
    }

    function photoNeedsVision(m) {
        if (!m || m.deleted || m.role !== 'user') return false;
        var fmt = getOnlineFormatApi();
        if (fmt && typeof fmt.isRealChatPhotoMessage === 'function') {
            if (!fmt.isRealChatPhotoMessage(m)) return false;
        } else if (m.type !== 'image' || !m.imageDataKey || m.imageKind === 'text') {
            return false;
        }
        return !String(m.imageVisionText || '').trim();
    }

    var roundPhotoDataUrlCache = Object.create(null);
    var ROUND_PHOTO_BATCH_MAX = 5;

    function resolveMessageBucket(st, chatId, msg) {
        if (
            st &&
            st.findMessageChatId &&
            typeof st.findMessageChatId === 'function' &&
            msg &&
            msg.id
        ) {
            return st.findMessageChatId(msg.id) || chatId;
        }
        return chatId;
    }

    function loadChatPhotoDataUrl(st, imgApi, blobId) {
        var key = String(blobId || '').trim();
        if (!key || !st || typeof st.getAvatarUrl !== 'function') return Promise.resolve('');
        return st
            .getAvatarUrl(key)
            .then(function (url) {
                if (!url) return '';
                return fetch(url).then(function (res) {
                    if (!res.ok) return '';
                    return res.blob();
                });
            })
            .then(function (blob) {
                if (!blob) return '';
                if (imgApi && typeof imgApi.readBlobAsDataUrl === 'function') {
                    return imgApi.readBlobAsDataUrl(blob);
                }
                return '';
            })
            .catch(function () {
                return '';
            });
    }

    function applyRoundPhotoVisionText(st, chatId, row, desc) {
        var text = String(desc || '').trim();
        if (!text || !st || !row || !row.m) return Promise.resolve(null);
        return st
            .updateMessage(resolveMessageBucket(st, chatId, row.m), row.m.id, { imageVisionText: text })
            .catch(function () {
                return null;
            });
    }

    function recognizeRoundPhotoBatch(st, chatId, imgApi, batch) {
        if (!batch.length) return Promise.resolve();
        var urls = batch.map(function (row) {
            return row.dataUrl;
        });
        function recognizeSequential() {
            var chain = Promise.resolve();
            batch.forEach(function (row) {
                chain = chain.then(function () {
                    return imgApi
                        .recognizeImageDataUrl(row.dataUrl)
                        .then(function (desc) {
                            return applyRoundPhotoVisionText(st, chatId, row, desc);
                        })
                        .catch(function () {
                            return null;
                        });
                });
            });
            return chain;
        }
        if (batch.length === 1 || typeof imgApi.recognizeImageBatchDataUrls !== 'function') {
            return recognizeSequential();
        }
        return imgApi
            .recognizeImageBatchDataUrls(urls)
            .then(function (descs) {
                return Promise.all(
                    batch.map(function (row, idx) {
                        return applyRoundPhotoVisionText(st, chatId, row, descs && descs[idx]);
                    })
                );
            })
            .catch(function () {
                return recognizeSequential();
            });
    }

    /** 触发 AI 回复前：识别本轮尚未识图的真实图片，写入 imageVisionText，并缓存 dataUrl 供主模型多模态看图 */
    function recognizeRoundPhotos(chatId) {
        var st = global.miyaChatStore;
        var imgApi = global.MiyaChatImage;
        if (!st || !imgApi || typeof imgApi.recognizeImageDataUrl !== 'function') {
            return Promise.resolve();
        }
        var fmt = getOnlineFormatApi();
        var isRealPhoto =
            fmt && typeof fmt.isRealChatPhotoMessage === 'function'
                ? fmt.isRealChatPhotoMessage
                : function (m) {
                      return !!(m && m.type === 'image' && m.imageDataKey && m.imageKind !== 'text');
                  };
        var round = getTrailingUserRound(loadApiHistory(st, chatId));
        var photos = round.filter(isRealPhoto);
        if (!photos.length) return Promise.resolve();
        photos.forEach(function (m) {
            if (m && m.id) delete roundPhotoDataUrlCache[m.id];
        });
        return Promise.all(
            photos.map(function (m) {
                return loadChatPhotoDataUrl(st, imgApi, m.imageDataKey).then(function (dataUrl) {
                    if (dataUrl && m.id) roundPhotoDataUrlCache[m.id] = dataUrl;
                    return { m: m, dataUrl: dataUrl };
                });
            })
        ).then(function (rows) {
            var pending = rows.filter(function (row) {
                return photoNeedsVision(row.m) && row.dataUrl;
            });
            if (!pending.length) return;
            var chain = Promise.resolve();
            for (var i = 0; i < pending.length; i += ROUND_PHOTO_BATCH_MAX) {
                (function (batch) {
                    chain = chain.then(function () {
                        return recognizeRoundPhotoBatch(st, chatId, imgApi, batch);
                    });
                })(pending.slice(i, i + ROUND_PHOTO_BATCH_MAX));
            }
            return chain;
        });
    }

    function attachTrailingRoundPhotosToApiMessages(apiMessages, history) {
        if (!Array.isArray(apiMessages) || !apiMessages.length) return;
        var fmt = getOnlineFormatApi();
        if (!fmt || typeof fmt.isRealChatPhotoMessage !== 'function') return;
        var round = getTrailingUserRound(history);
        var photos = round.filter(fmt.isRealChatPhotoMessage);
        if (!photos.length) return;
        var imageParts = [];
        photos.forEach(function (m) {
            var url = m && m.id ? roundPhotoDataUrlCache[m.id] : '';
            if (url && /^data:image\//i.test(url)) {
                imageParts.push({ type: 'image_url', image_url: { url: url } });
            }
        });
        if (!imageParts.length) return;
        var lastUserIdx = -1;
        var i;
        for (i = apiMessages.length - 1; i >= 0; i--) {
            if (apiMessages[i] && apiMessages[i].role === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0) {
            apiMessages.push({
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '（用户本轮发送了真实图片，请结合画面与对话理解后再回复）'
                    }
                ].concat(imageParts)
            });
            return;
        }
        var last = apiMessages[lastUserIdx];
        if (Array.isArray(last.content)) {
            last.content = last.content.concat(imageParts);
            return;
        }
        var textPart = String(last.content || '').trim();
        if (!textPart) {
            textPart = '（用户本轮发送了真实图片，请结合画面与对话理解后再回复）';
        }
        last.content = [{ type: 'text', text: textPart }].concat(imageParts);
    }

    /** 本轮 = 自最后一条角色消息（含角色旁白）之后连续的用户消息 */
    function getTrailingUserRound(messages) {
        var list = (messages || []).filter(function (m) {
            return m && !m.deleted;
        });
        var round = [];
        for (var i = list.length - 1; i >= 0; i--) {
            var row = list[i];
            if (row.role === 'assistant') break;
            if (isOnlineNarrationRow(row)) break;
            if (row.role === 'user') round.unshift(row);
        }
        return round;
    }

    function isOnlineNarrationRow(m) {
        var fmt = getOnlineFormatApi();
        return !!(
            fmt &&
            typeof fmt.isCharacterOnlineNarrationMessage === 'function' &&
            fmt.isCharacterOnlineNarrationMessage(m)
        );
    }

    /** 末尾一轮角色回复（含穿插的线上旁白 system 行） */
    function getTrailingAssistantRound(messages) {
        var list = (messages || []).filter(function (m) {
            return m && !m.deleted;
        });
        if (!list.length) return [];
        var batchId = '';
        var i;
        for (i = list.length - 1; i >= 0; i--) {
            var tail = list[i];
            if (tail.role === 'assistant') {
                batchId = String(tail.replyBatchId || '').trim();
                break;
            }
            if (!isOnlineNarrationRow(tail)) break;
        }
        if (batchId) {
            var byBatch = list.filter(function (m) {
                return (
                    String(m.replyBatchId || '') === batchId &&
                    (m.role === 'assistant' || isOnlineNarrationRow(m))
                );
            });
            if (byBatch.length) return byBatch;
        }
        var firstIdx = -1;
        var lastIdx = -1;
        for (i = list.length - 1; i >= 0; i--) {
            var row = list[i];
            if (row.role === 'assistant' || isOnlineNarrationRow(row)) {
                lastIdx = i;
                break;
            }
            if (row.role !== 'assistant' && !isOnlineNarrationRow(row)) break;
        }
        if (lastIdx < 0) return [];
        for (i = lastIdx; i >= 0; i--) {
            var prev = list[i];
            if (prev.role === 'assistant' || isOnlineNarrationRow(prev)) firstIdx = i;
            else break;
        }
        if (firstIdx < 0) return [];
        var round = [];
        for (i = firstIdx; i <= lastIdx; i++) {
            var mid = list[i];
            if (mid.role === 'assistant' || isOnlineNarrationRow(mid)) round.push(mid);
        }
        return round;
    }

    function collectTrailingReplyRoundIds(messages) {
        return getTrailingAssistantRound(messages)
            .map(function (m) {
                return m && m.id;
            })
            .filter(Boolean);
    }

    /** 与末尾角色回复对应的本轮用户消息（紧邻其前的连续 user） */
    function getUserRoundBeforeAssistant(messages, assistantRound) {
        var asst = Array.isArray(assistantRound) ? assistantRound : [];
        if (!asst.length) return getTrailingUserRound(messages);
        var list = (messages || []).filter(function (m) {
            return m && !m.deleted;
        });
        var firstId = String((asst[0] && asst[0].id) || '');
        var firstIdx = -1;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === firstId) {
                firstIdx = i;
                break;
            }
        }
        if (firstIdx < 0) return getTrailingUserRound(messages);
        var userRound = [];
        for (var j = firstIdx - 1; j >= 0; j--) {
            if (list[j].role === 'assistant') break;
            if (isOnlineNarrationRow(list[j])) break;
            if (list[j].role === 'user') userRound.unshift(list[j]);
        }
        return userRound;
    }

    function sanitizeAssistantPayload(fields) {
        var payload = Object.assign({}, fields || {});
        if (payload.content) payload.content = stripThinkingForApi(payload.content);
        if (payload.voiceText) payload.voiceText = stripThinkingForApi(payload.voiceText);
        if (payload.callLine) payload.callLine = stripThinkingForApi(payload.callLine);
        return payload;
    }

    function loadApiHistory(st, chatId) {
        if (!st || !chatId) return [];
        if (st.getMergedMessagesForApi && typeof st.getMergedMessagesForApi === 'function') {
            return st.getMergedMessagesForApi(chatId) || [];
        }
        return st.getMessages(resolveApiChatId(chatId)) || [];
    }

    function withdrawLastAssistantRound(chatId) {
        var st = global.miyaChatStore;
        if (!st) return Promise.reject(new Error('store_missing'));
        var cid = String(chatId || '').trim();
        if (!cid) return Promise.reject(new Error('invalid_chat'));
        var msgChatId = resolveApiChatId(cid);
        var msgs = loadApiHistory(st, cid);
        var ids = collectTrailingReplyRoundIds(msgs);
        if (!ids.length) return Promise.reject(new Error('no_assistant_round'));
        /*
         * 撤回会清空 chat.lastRawAssistantReply，但【重回】的改写 nudge 需要
         * 引用这版原文（见 readLastRawAssistantReply 的回退说明）。
         * 必须**在清空之前**把原文快照下来，晚了就只剩空串。
         */
        try {
            var prevRow = st.findChat ? (st.findChat(msgChatId) || st.findChat(cid)) : null;
            var prevRaw = String((prevRow && prevRow.lastRawAssistantReply) || '');
            if (prevRaw) {
                withdrawnPrevReplyByChat[cid] = prevRaw;
                if (msgChatId && msgChatId !== cid) {
                    withdrawnPrevReplyByChat[msgChatId] = prevRaw;
                }
            }
        } catch (eSnap) {}
        var byBucket = Object.create(null);
        ids.forEach(function (id) {
            var bucket =
                st.findMessageChatId && typeof st.findMessageChatId === 'function'
                    ? st.findMessageChatId(id)
                    : '';
            if (!bucket) bucket = msgChatId;
            if (!byBucket[bucket]) byBucket[bucket] = [];
            byBucket[bucket].push(id);
        });
        var chain = Promise.resolve(0);
        Object.keys(byBucket).forEach(function (bucket) {
            chain = chain.then(function () {
                return st.deleteMessages(bucket, byBucket[bucket]);
            });
        });
        return chain.then(function () {
            var patch = {
                activeThinking: '',
                activeThinkingMsgId: '',
                lastRawAssistantReply: '',
                lastHeartVoiceParse: null
            };
            var updateChain = st.updateChat(msgChatId, patch);
            if (msgChatId !== cid) {
                updateChain = updateChain.then(function () {
                    return st.updateChat(cid, patch);
                });
            }
            return updateChain.then(function () {
                return { removed: ids.length, ids: ids, msgChatId: msgChatId };
            });
        });
    }

    function regenerateLastRound(chatId) {
        var cid = String(chatId || '').trim();
        if (!cid) return Promise.reject(new Error('invalid_chat'));
        if (isChatApiBusy(cid)) return Promise.reject(new Error('chat_api_busy'));
        return withdrawLastAssistantRound(cid).then(function () {
            return sendChat(cid, '', { skipUserMessage: true, isRegenerate: true });
        });
    }

    var replyInFlight = Object.create(null);

    function acquireChatApi(chatId) {
        var id = String(chatId || '');
        if (!id) return false;
        replyInFlight[id] = (replyInFlight[id] || 0) + 1;
        return true;
    }

    function releaseChatApi(chatId) {
        var id = String(chatId || '');
        if (!id || !replyInFlight[id]) return;
        replyInFlight[id] -= 1;
        if (replyInFlight[id] <= 0) delete replyInFlight[id];
    }

    function isChatApiBusy(chatId) {
        return !!(chatId && replyInFlight[String(chatId)]);
    }

    function isReplyInFlight(chatId) {
        return isChatApiBusy(chatId);
    }

    /*
     * 停止线上生成。
     *
     * 返回值语义：true = 确实中断了一个在跑的生成。
     *
     * 与线下 stopAppointment 对齐 —— 旧版这里也是无脑 return true，
     * 界面据此弹「已停止生成」。线上当前是好的（sendChat 会 begin，
     * 且它是唯一的生成入口），但同样的谎言不该留着：
     * 一旦将来有人再加一条绕过 sendChat 的生成路径，
     * 这里就会重演线下那个「提示说停了、内容还在蹦」的 bug。
     */
    function stopChatGeneration(chatId) {
        var id = String(chatId || '');
        var scope = id ? 'chat:' + id : 'chat:';
        var genLife = global.MiyaGenerationLifecycle;
        var ctl = (genLife && typeof genLife.getController === 'function')
            ? genLife.getController(scope) : null;
        if (genLife && typeof genLife.stop === 'function') {
            genLife.stop(scope, { reason: 'user' });
        }
        if (id) releaseChatApi(id);
        return !!ctl;
    }

    function buildLocalTokenUsage(built, replyRaw) {
        var pm = (built && built.promptMeta) || {};
        var promptChars = countMessagesChars(built && built.messages);
        if (!promptChars && pm.total_prompt_chars) {
            promptChars = Math.max(0, Math.floor(Number(pm.total_prompt_chars) || 0));
        }
        var completionChars = String(replyRaw || '').length;
        var totalChars = promptChars + completionChars;
        return {
            prompt_chars: promptChars,
            completion_chars: completionChars,
            total_chars: totalChars,
            prompt_tokens: promptChars,
            completion_tokens: completionChars,
            total_tokens: totalChars,
            updatedAt: Date.now(),
            source: 'local_chars'
        };
    }

    /*
     * ═══════════════════════════════════════════════════════════════
     * 重答防雷同（三重机制）—— 针对「重新生成还是一模一样」的根治
     *
     * ── 为什么前三轮修复（全是提示词）没压住 ──
     *
     * 前三轮修的全是「提示词」：nudge 引用上一版原文、排除同义改写歧义、
     * resumeRewrite 补约束。方向没错，但它们有一个共同盲区：
     * **从头到尾没有任何一处验证过「新回复是否真的和上一版不同」**。
     * 提示词只是祈祷，输出侧没有闭环。
     *
     * 而且有两个提示词永远压不住的雷：
     *
     *   1. 中转站/网关的请求级缓存。大量 OpenAI 兼容中转（为省钱）
     *      会按请求体哈希缓存 completion——短时间内同 body 的请求
     *      直接回放缓存内容。线上重回的 nudge 引用「上一版原文」，
     *      一旦第 1 次重答就和原版一样（温度低时很常见），第 2 次重答的
     *      上下文与 nudge 引用文本就与第 1 次**逐字节相同**——
     *      网关直接把缓存吐回来，用户看到一字不差的内容。
     *
     *   2. 采样参数零差异化。请求体里 temperature 固定取自 ST 生成设置，
     *      没有 seed，也没有重答分支。用户预设温度为 0~0.2 时，
     *      「输入几乎相同 + 贪心解码」在长 system + 强人设锚定下
     *      完全可以复现出逐字相同的回复——nudge 只是末尾一小段，
     *      压不过几千字的上下文锚。
     *
     * 所以这次改成三层，缺一不可：
     *
     *   ① 请求唯一化：每次重答在 messages 末尾注入一条唯一的「查重码」
     *      （nonce + 尝试序号）。保证**任何一层**按 body 缓存都不可能命中，
     *      同时给模型一个可区分的输入信号。
     *   ② 采样差异化：仅重答请求温度上浮（+0.15 × 尝试序号，上限 1.6）。
     *      只动这一个请求、只往多样性方向推——用户点「重新生成」本身就是
     *      「要一版不一样的」，这是对配置意图的正确解读，不算偷改。
     *   ③ 输出查重闭环：生成成功后把新正文与上一版（撤回前快照）做
     *      归一化比对（剥思维链/标签/空白/全半角标点后按字符二元组
     *      算 Dice 相似度）；判定雷同就**自动换向重试**（附更硬的
     *      系统块 + 更高温度），最多 3 次。这才是唯一能保证
     *      「用户看到的不一样」的机制——因为它验证的是结果本身。
     * ═══════════════════════════════════════════════════════════════
     */
    function makeRegenNonce() {
        return (
            Date.now().toString(36) +
            '-' +
            Math.floor(Math.random() * 0xffffffff).toString(36)
        );
    }

    /*
     * 把两版回复收拾成可比对的形态：
     * 先抽正文（剥思维链/心声/状态栏/推送标签），再剥掉剩余标签、
     * 全部空白与全半角标点，转小写。两边走同一套归一化，
     * 差的只有"实义内容"，比对才公平。
     */
    function normalizeReplyForRegenCompare(raw) {
        var s = String(raw || '');
        try {
            if (typeof extractBodyForBubbles === 'function') {
                var body = String(extractBodyForBubbles(s) || '');
                if (body) s = body;
            }
        } catch (e) {}
        if (!s) s = String(raw || '');
        s = s
            .replace(/<thinking[\s\S]*?<\/thinking>/gi, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<miyavoice[\s\S]*?<\/miyavoice>/gi, '')
            .replace(/<STATUSBAR_DATA>[\s\S]*?<\/STATUSBAR_DATA>/gi, '')
            .replace(/<miyanextpush[\s\S]*?<\/miyanextpush>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .toLowerCase()
            .replace(/[\s\u3000]+/g, '')
            .replace(/[，。！？；：、·…—～“”‘’（）《》〈〉【】〔〕]/g, '')
            .replace(/[,.;:!?"'`()\[\]{}<>|\/\\_\-~=+*&^%$#@！？]/g, '');
        return s.slice(0, 2400);
    }

    /*
     * 字符二元组（bigram）Dice 相似度，O(n)。
     * 比 LCS 快得多（正文几百字时 LCS 是十万格级，这里线性），
     * 对中文短文本的"复读"判定足够准：逐字复述 ≈ 1，
     * 正常换向重写通常 < 0.5，同义改写在 0.6~0.8 之间。
     */
    function charBigramDice(a, b) {
        a = String(a || '');
        b = String(b || '');
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
        var map = Object.create(null);
        var i;
        for (i = 0; i < a.length - 1; i++) {
            var k = a.substr(i, 2);
            map[k] = (map[k] || 0) + 1;
        }
        var hit = 0;
        var bTotal = 0;
        for (i = 0; i < b.length - 1; i++) {
            var k2 = b.substr(i, 2);
            bTotal++;
            var c = map[k2];
            if (c) {
                hit++;
                map[k2] = c - 1;
            }
        }
        var denom = a.length - 1 + bTotal;
        return denom ? (2 * hit) / denom : 0;
    }

    /*
     * 判定「这次重答是否与上一版雷同」。
     * 三条命中任意一条即算雷同：
     *   · 归一化后完全相等；
     *   · Dice 相似度 ≥ 0.88；
     *   · 较短一方 ≥ 24 字且被较长一方完整包含
     *     （抓"旧文原样 + 尾巴上多补一句"的偷懒形态，此时 Dice 会偏低）。
     */
    function regenLooksIdentical(prevBody, rawNow) {
        var prev = String(prevBody || '');
        if (!prev) return false;
        var now = normalizeReplyForRegenCompare(rawNow);
        if (!now) return false;
        if (now === prev) return true;
        if (charBigramDice(prev, now) >= 0.88) return true;
        var short = prev.length <= now.length ? prev : now;
        var long = prev.length <= now.length ? now : prev;
        if (short.length >= 24 && long.indexOf(short) >= 0) return true;
        return false;
    }

    /*
     * 查重未通过（重试）时附加的系统块。
     * 比首轮 nudge 硬得多：直接告知"上一版没过查重、用户不会看到"，
     * 并给出可执行的换向要求 + 新查重码。
     */
    function buildRegenRejectedBlock(attemptNo) {
        return [
            '【系统查重·上一版无效·这是第 ' + attemptNo + ' 次尝试】',
            '你刚才生成的回复与被弃用的上一版高度雷同，未通过系统查重，用户不会看到那一版。',
            '请重新生成本轮回复：必须换一个实质不同的演绎方向——不同的事件切入点、不同的动作与对白内容、不同的情绪落点；仅调整措辞、语序或段落仍视为无效。',
            '角色的身份、性格、说话习惯、与用户的关系，以及世界书核心设定与格式规则保持不变；不要提及本次查重或「重新生成」等字眼。',
            '（系统内部查重码：' + makeRegenNonce() + '。仅供系统区分请求，与剧情无关；禁止回应本条，禁止在回复中提及或输出该编号。）'
        ].join('\n');
    }

    function sendChat(chatId, userText, opts) {
        var store = global.miyaChatStore;
        var options = opts && typeof opts === 'object' ? opts : {};
        var text = String(userText || '').trim();
        if (!text && !options.skipUserMessage) return Promise.reject(new Error('empty_message'));

        if (isChatApiBusy(chatId)) return Promise.reject(new Error('chat_api_busy'));

        acquireChatApi(chatId);
        var genLife = global.MiyaGenerationLifecycle;
        var genCtl = genLife && typeof genLife.begin === 'function'
            ? genLife.begin('chat:' + String(chatId), { kind: 'chat' })
            : null;
        var genSignal = genCtl && genCtl.signal ? genCtl.signal : null;

        var cfg = getApiConfig();
        var baseUrl = normalizeBaseUrl(cfg.baseUrl);
        var apiKey = String(cfg.apiKey || '').trim();
        var model = String(cfg.model || '').trim();
        if (!baseUrl || !apiKey || !model) {
            releaseChatApi(chatId);
            if (genLife && typeof genLife.fail === 'function') genLife.fail('chat:' + String(chatId), new Error('api_not_configured'));
            return Promise.reject(new Error('api_not_configured'));
        }

        var persistUser = options.skipUserMessage
            ? Promise.resolve()
            : store.addMessage(chatId, { role: 'user', content: text });

        function clearInFlight(status, err) {
            releaseChatApi(chatId);
            var genLife = global.MiyaGenerationLifecycle;
            if (!genLife) return;
            if (status === 'abort' || (err && genLife.isAbortError && genLife.isAbortError(err))) {
                /* stop() 已由用户触发时状态为 aborted；此处兜底 */
                if (typeof genLife.stop === 'function') genLife.stop('chat:' + String(chatId), { silent: true, reason: 'clear' });
            } else if (status === 'error' && typeof genLife.fail === 'function') {
                genLife.fail('chat:' + String(chatId), err);
            } else if (typeof genLife.finish === 'function') {
                genLife.finish('chat:' + String(chatId));
            }
        }

        function maybeRefreshWeatherBeforeChat() {
            var aw = global.MiyaChatAwareness;
            if (!store || !aw || typeof aw.refreshWeatherIfStale !== 'function') return Promise.resolve();
            var chatRow = store.findChat ? store.findChat(chatId) : null;
            if (
                chatRow &&
                chatRow.type === 'group' &&
                typeof aw.refreshGroupMembersWeatherIfStale === 'function'
            ) {
                return aw.refreshGroupMembersWeatherIfStale(store, chatRow);
            }
            var settings = store.getChatSettings ? store.getChatSettings(chatId) : null;
            var wa =
                aw.normalizeWeatherAwareness && settings
                    ? aw.normalizeWeatherAwareness(settings.weatherAwareness)
                    : null;
            if (!wa || !wa.enabled) return Promise.resolve();
            var stale =
                (typeof aw.needsWeatherDailyRefresh === 'function' && aw.needsWeatherDailyRefresh(wa)) ||
                (typeof aw.weatherNeedsInitialFetch === 'function' && aw.weatherNeedsInitialFetch(wa)) ||
                (typeof aw.weatherDataIncomplete === 'function' && aw.weatherDataIncomplete(wa));
            if (!stale) return Promise.resolve();
            return aw
                .refreshWeatherIfStale(Object.assign({}, settings, { weatherAwareness: wa }), { force: true })
                .then(function (refreshed) {
                    if (refreshed && refreshed.weatherAwareness && store.saveChatSettings) {
                        return store.saveChatSettings(chatId, { weatherAwareness: refreshed.weatherAwareness });
                    }
                })
                .catch(function () {});
        }

        return persistUser
            .then(function () {
                var peek = global.miyaDiaryPeek;
                if (
                    peek &&
                    typeof peek.tryTriggerPeek === 'function' &&
                    !options.skipPeek &&
                    !options.isRegenerate &&
                    !options.callMode
                ) {
                    return peek.tryTriggerPeek(chatId);
                }
            })
            .then(function () {
                return recognizeRoundPhotos(chatId);
            })
            .then(function () {
                return maybeRefreshWeatherBeforeChat();
            })
            .then(function () {
                return ensureWorldbookDepsReady();
            })
            .then(function () {
                if (typeof global.miyaYieldToMain === 'function') {
                    return global.miyaYieldToMain();
                }
            })
            .then(function () {
            /*
             * 重答防雷同（机制③的前置）：
             * 在 buildApiMessages 之前先取走「上一版原文」。
             *
             * 为什么必须在这里取：readLastRawAssistantReply 的撤回快照
             * 是「取一次即清」的——若让 nudge 在 buildApiMessages 里
             * 自己去取，这里就拿不到了；反过来这里先取、再把原文
             * 经 opts._regenCtx 递给 nudge，两边共用同一份，快照恰好
             * 只被消费一次。
             */
            if (options.isRegenerate && !options._regenCtx) {
                var prevRawForRegen = readLastRawAssistantReply(chatId);
                options._regenCtx = {
                    attempt: 1,
                    nonce: makeRegenNonce(),
                    prevRaw: prevRawForRegen
                };
                options._regenCtx.prevBody = normalizeReplyForRegenCompare(prevRawForRegen);
            }
            var built = buildApiMessages(chatId, '', options);
            if (built.error) return Promise.reject(new Error(built.error));

            var pluginCtx = {
                scope: 'chat',
                chatId: chatId,
                messages: built.messages,
                userText: text,
                options: options,
                signal: genSignal
            };
            var pluginReady;
            if (global.MiyaMemoryTableApp && typeof global.MiyaMemoryTableApp.beforeGenerate === 'function') {
                pluginReady = Promise.resolve(global.MiyaMemoryTableApp.beforeGenerate(pluginCtx));
            } else {
                pluginReady = Promise.resolve(pluginCtx);
            }

            return pluginReady.then(function (ctxOut) {
            if (ctxOut && Array.isArray(ctxOut.messages)) built.messages = ctxOut.messages;

            function callWithSlice(slice, usedSecondary, messagesOverride, regenAttemptNo, regenCtx) {
                if (!slice.baseUrl || !slice.apiKey || !slice.model) {
                    return Promise.reject(new Error(usedSecondary ? 'secondary_api_not_configured' : 'api_not_configured'));
                }
                var url = slice.baseUrl + '/chat/completions';
                var reqHeaders = {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer ' + slice.apiKey
                };
                var stGen = getStGenerationSettings();
                /* built.messages 上挂着 __src / __genSection 等本地来源标记，
                   是纯前端用于「Token 来源分布」的，绝不能进 request body —— 这里剥掉。 */
                var apiSafeMessages = stripInternalFields(messagesOverride || built.messages);
                /*
                 * 重答防雷同·机制①：请求唯一化。
                 * 每次重答请求（含查重重试）都带一个全请求唯一的「查重码」，
                 * 保证请求体逐字节不同 —— 任何按 body 哈希做缓存的中转/网关
                 * 都不可能再回放缓存的旧回复。
                 */
                if (regenAttemptNo > 0) {
                    apiSafeMessages = apiSafeMessages.concat([
                        {
                            role: 'user',
                            content:
                                '（系统内部查重码：' +
                                ((regenCtx && regenCtx.nonce) || makeRegenNonce()) +
                                '-' +
                                regenAttemptNo +
                                '。仅供系统区分请求，与剧情无关；禁止回应本条，禁止在回复中提及或输出该编号。）'
                        }
                    ]);
                }
                var reqPayload = {
                    model: slice.model,
                    messages: apiSafeMessages,
                    temperature: stGen.temperature != null ? Number(stGen.temperature) : slice.temperature
                };
                if (stGen.maxTokens != null && Number(stGen.maxTokens) > 0) reqPayload.max_tokens = Math.floor(Number(stGen.maxTokens));
                if (stGen.n != null && Number(stGen.n) > 1) reqPayload.n = Math.floor(Number(stGen.n));
                if (stGen.topP != null) reqPayload.top_p = Number(stGen.topP);
                if (stGen.frequencyPenalty != null) reqPayload.frequency_penalty = Number(stGen.frequencyPenalty);
                if (stGen.presencePenalty != null) reqPayload.presence_penalty = Number(stGen.presencePenalty);
                /*
                 * 重答防雷同·机制②：采样差异化（仅重答请求）。
                 * 温度上浮 +0.15 × 尝试序号（上限 1.6），把「低温度 + 输入几乎
                 * 相同」的贪心收敛打开。只作用于重答这一个请求、只往多样性
                 * 方向推；普通发送的采样参数保持用户配置，一字不动。
                 *
                 * 刻意**不发 seed**：seed 是「可复现」，与重答要的「不可复现」
                 * 正好相反；而且个别严格网关会对非预期字段报 400，得不偿失。
                 */
                if (regenAttemptNo > 0) {
                    var regenTempBase = Number(reqPayload.temperature);
                    if (!isFinite(regenTempBase)) regenTempBase = 1;
                    reqPayload.temperature = Math.min(
                        1.6,
                        regenTempBase + 0.15 * regenAttemptNo
                    );
                }
                /*
                 * ⚠️ 这里固定非流式，是**当前实现的限制**，不是有意设计。
                 *
                 * 原因：本引擎走的是自己这套 fetchChatCompletion，按整体 JSON
                 * 解析响应，没有接 miya-api-bridge 里那套 SSE 读取能力。
                 * 所以 ST 预设里的「流式」开关无法在此生效。
                 *
                 * 相应地，UI 上那个开关已改成只读状态展示，不再让用户
                 * 误以为可以切换 —— 见 miya-st-prompt-presets-app.js 与 index.html。
                 *
                 * 要真正支持流式，需要改造：
                 *   1. SSE 分帧读取（getReader + 解析 data: 帧）
                 *   2. 增量拼接 replyRaw
                 *   3. 思考块（<thinking>）的实时剥离
                 *   4. 断流重试与 AbortSignal 处理
                 *   5. 气泡渲染的增量更新
                 * 在完成这些之前，保持 false 是唯一正确的值。
                 */
                reqPayload.stream = false;
                return fetchChatCompletion(url, reqHeaders, reqPayload, 1, genSignal).then(function (completion) {
                    if (!completion.replyRaw) throw new Error('empty_reply');
                    completion._usedSecondaryApi = !!usedSecondary;
                    return completion;
                });
            }

            var primarySlice = resolveChatApiSlice(cfg, false);
            /*
             * 重答防雷同·机制③：输出查重闭环。
             * 每次生成成功后，把新正文与上一版（撤回前快照）做归一化比对；
             * 判定雷同就自动换向重试（附系统查重块 + 温度再上浮），最多 3 次。
             * 这是唯一能真正保证「用户看到的和上一版不一样」的一层——
             * 因为它验证的是**结果本身**，而不是指望模型听话。
             */
            function callSliceGuarded(slice, usedSecondary) {
                if (!options.isRegenerate || !options._regenCtx) {
                    return callWithSlice(slice, usedSecondary, null, 0, null);
                }
                var rctx = options._regenCtx;
                var REGEN_MAX_TRIES = 3;
                function tryOnce(no) {
                    var msgsForTry = built.messages;
                    if (no > 1) {
                        msgsForTry = built.messages.concat([
                            { role: 'system', content: buildRegenRejectedBlock(no) }
                        ]);
                    }
                    return callWithSlice(slice, usedSecondary, msgsForTry, no, rctx).then(
                        function (completion) {
                            if (!rctx.prevBody || no >= REGEN_MAX_TRIES) return completion;
                            if (!regenLooksIdentical(rctx.prevBody, completion.replyRaw)) {
                                return completion;
                            }
                            try {
                                if (global.console && console.warn) {
                                    console.warn(
                                        '[regen] 第 ' +
                                            no +
                                            ' 次重答与上一版雷同（查重未过），自动换向重试'
                                    );
                                }
                            } catch (eLog) {}
                            return tryOnce(no + 1);
                        }
                    );
                }
                return tryOnce(1);
            }
            return callSliceGuarded(primarySlice, false).catch(function (err) {
                if (!cfg.fallbackToSecondary || !hasSecondaryApiConfigured(cfg)) throw err;
                return callSliceGuarded(resolveChatApiSlice(cfg, true), true);
            }).then(function (completion) {
                var data = completion.data;
                var replyRawOriginal = String(completion.replyRaw || '');
                var replyRaw = replyRawOriginal;
                var timeEventsExtract = null;
                var timeEventsMod = global.MiyaChatTimeEvents;
                var chatRowEarlyForEvents = built.chat || (store.findChat ? store.findChat(chatId) : null);
                if (
                    timeEventsMod &&
                    typeof timeEventsMod.extractAndStore === 'function' &&
                    chatRowEarlyForEvents &&
                    chatRowEarlyForEvents.type !== 'group'
                ) {
                    timeEventsExtract = timeEventsMod.extractAndStore(store, chatId, replyRaw);
                    if (timeEventsExtract && timeEventsExtract.text != null) replyRaw = timeEventsExtract.text;
                }
                try {
                    var farmMod = global.MiyaChatFarm;
                    if (
                        farmMod &&
                        typeof farmMod.extractAndStore === 'function' &&
                        chatRowEarlyForEvents &&
                        chatRowEarlyForEvents.type !== 'group'
                    ) {
                        var farmExtract = farmMod.extractAndStore(store, chatId, replyRaw);
                        if (farmExtract && farmExtract.text != null) replyRaw = farmExtract.text;
                    }
                } catch (eFarm) {}
                /* 记忆表格：解析 tableEdit 并剥离标签 */
                try {
                    var mtEng = global.MiyaMemoryTableEngine;
                    if (mtEng && typeof mtEng.processAssistantReply === 'function') {
                        var mtRes = mtEng.processAssistantReply(chatId, replyRaw);
                        if (mtRes && mtRes.text != null) replyRaw = mtRes.text;
                    }
                } catch (eMt) {}
                var lifeLikeNextPushPatch = null;
                var llMod = global.MiyaChatLifeLike;
                var chatRowEarly = built.chat || (store.findChat ? store.findChat(chatId) : null);
                if (
                    llMod &&
                    typeof llMod.isEnabled === 'function' &&
                    typeof llMod.extractNextPushFromReply === 'function' &&
                    chatRowEarly &&
                    chatRowEarly.type !== 'group' &&
                    !options.callMode &&
                    !options.isMomentsAuto
                ) {
                    var llSettings = store.getChatSettings ? store.getChatSettings(chatId) : null;
                    if (llMod.isEnabled(llSettings)) {
                        var extractSrc = replyRawOriginal;
                        if (!/miyanextpush/i.test(extractSrc)) {
                            var rsnForPush = extractReasoningFromApi(data);
                            if (rsnForPush && /miyanextpush/i.test(rsnForPush)) {
                                extractSrc = extractSrc ? extractSrc + '\n' + rsnForPush : rsnForPush;
                            }
                        }
                        var npExtract = llMod.extractNextPushFromReply(extractSrc, { settings: llSettings });
                        if (npExtract && npExtract.stripped != null) replyRaw = npExtract.stripped;
                        if (npExtract && npExtract.ok) {
                            lifeLikeNextPushPatch = {
                                backgroundMessage: {
                                    lifeLikeNextPushAt: npExtract.atMs || 0,
                                    lifeLikeNextPushAnonymous: !!npExtract.anonymous
                                }
                            };
                        } else if (npExtract && npExtract.foundTag) {
                            console.warn(
                                '[MiyaChatLifeLike] 调度块解析失败 chat=' +
                                    chatId +
                                    ' raw=' +
                                    String(npExtract.raw || '').slice(0, 80) +
                                    (npExtract.parseReason ? ' reason=' + npExtract.parseReason : '')
                            );
                        }
                    }
                }

                var thinking = extractThinkingFromResponse(data, replyRaw);
                var parsed = parseThinking(replyRaw);
                var bodyForBubbles = extractBodyForBubbles(replyRaw);
                if (!String(bodyForBubbles || '').trim()) {
                    bodyForBubbles = stripHeartVoiceTags(parsed.content);
                }
                if (!String(bodyForBubbles || '').trim()) {
                    bodyForBubbles = buildSalvageBubbleText(replyRaw);
                }
                if (!String(bodyForBubbles || '').trim() && thinking && !options.callMode) {
                    throw new Error('empty_reply');
                }
                /*
                 * 状态栏块先从正文里摘掉，并把字段留给气泡。
                 *
                 * 为什么必须在 splitBubbles 之前：
                 *   <STATUSBAR_DATA> 里是「字段: 值」逐行排列，splitBubbles 会按行
                 *   把它们拆成一个个独立气泡（「当前氛围」一个泡、「表面情绪」一个泡…），
                 *   整块状态栏就被拆碎了，后面再想拼回去已经无从下手。
                 *   所以在分段前剥走，把解析结果挂到 pendingStatusBar，
                 *   等这条消息存下来之后写进消息字段。
                 */
                var pendingStatusBar = null;
                var sbMod = global.MiyaChatStatusBar;
                if (sbMod && typeof sbMod.parseFromText === 'function') {
                    try {
                        var sbCfg = typeof sbMod.resolveConfig === 'function'
                            ? sbMod.resolveConfig(store, chatId)
                            : null;
                        if (!sbCfg || sbCfg.enabled !== false) {
                            var sbParsed = sbMod.parseFromText(bodyForBubbles);
                            if (sbParsed && sbParsed.fields.length) {
                                pendingStatusBar = {
                                    fields: sbParsed.fields,
                                    tag: sbParsed.tag
                                };
                                bodyForBubbles =
                                    typeof sbMod.stripFromText === 'function'
                                        ? sbMod.stripFromText(bodyForBubbles)
                                        : bodyForBubbles;
                            }
                        }
                    } catch (eSb) {}
                }
                var fmtEarly = getOnlineFormatApi();
                var htmlApi = global.MiyaChatHtml;
                var userWantsHtml = !!(built && built.htmlMode);
                var htmlOnly =
                    userWantsHtml &&
                    htmlApi &&
                    typeof htmlApi.extractHtmlOnlyFromReply === 'function'
                        ? htmlApi.extractHtmlOnlyFromReply(bodyForBubbles)
                        : null;
                var bubbles = splitBubbles(bodyForBubbles);
                var roleMomentsIntent = null;
                if (fmtEarly && typeof fmtEarly.stripRoleMomentsFromLines === 'function') {
                    var momentsStrip = fmtEarly.stripRoleMomentsFromLines(bubbles);
                    bubbles = momentsStrip.lines;
                    roleMomentsIntent = momentsStrip.intent;
                }

                var chain = Promise.resolve([]);
                var firstMsgId = null;
                var lastMsgId = null;

                var fmt = fmtEarly || getOnlineFormatApi();
                var chatRow = store.findChat(chatId);
                var contactRow = chatRow && store.findContact(chatRow.contactId);
                var catalog =
                    fmt && typeof fmt.collectStickerCatalog === 'function'
                        ? fmt.collectStickerCatalog(store, contactRow && contactRow.id)
                        : [];
                var profileId =
                    built.profile && built.profile.id ? built.profile.id : '';
                var updatedTransferMsgIds = [];
                var updatedCoupleInviteMsgIds = [];
                var receiptChain =
                    fmt && typeof fmt.applyRoleTransferReceipts === 'function'
                        ? fmt.applyRoleTransferReceipts(chatId, bubbles, store, profileId)
                        : Promise.resolve([]);

                var pendingRoleCall = null;
                var callApiMeta = null;
                var pendingAvatarSwaps = [];

                return receiptChain
                    .then(function (xferIds) {
                        updatedTransferMsgIds = Array.isArray(xferIds) ? xferIds : [];
                        var cpBridge = global.miyaCoupleBridge;
                        if (
                            cpBridge &&
                            typeof cpBridge.applyRoleCoupleSpaceReceipts === 'function'
                        ) {
                            return cpBridge
                                .applyRoleCoupleSpaceReceipts(chatId, bubbles, store)
                                .then(function (cpIds) {
                                    updatedCoupleInviteMsgIds = Array.isArray(cpIds) ? cpIds : [];
                                    if (typeof cpBridge.applyRoleCoupleCommemorations === 'function') {
                                        return cpBridge
                                            .applyRoleCoupleCommemorations(chatId, bubbles, store)
                                            .then(function () { return xferIds; });
                                    }
                                    return xferIds;
                                });
                        }
                        if (
                            cpBridge &&
                            typeof cpBridge.applyRoleCoupleCommemorations === 'function'
                        ) {
                            return cpBridge
                                .applyRoleCoupleCommemorations(chatId, bubbles, store)
                                .then(function () { return xferIds; });
                        }
                        return xferIds;
                    })
                    .then(function (xferIds) {
                        updatedTransferMsgIds = Array.isArray(xferIds) ? xferIds : [];
                        var displayLines = bubbles;
                        if (fmt && typeof fmt.stripTransferReceiptLines === 'function') {
                            displayLines = fmt.stripTransferReceiptLines(bubbles);
                        }
                        var cpBridgeStrip = global.miyaCoupleBridge;
                        if (
                            cpBridgeStrip &&
                            typeof cpBridgeStrip.stripCoupleSpaceReceiptLines === 'function'
                        ) {
                            displayLines = cpBridgeStrip.stripCoupleSpaceReceiptLines(displayLines);
                        }
                        if (
                            cpBridgeStrip &&
                            typeof cpBridgeStrip.stripCommemorationLines === 'function'
                        ) {
                            displayLines = cpBridgeStrip.stripCommemorationLines(displayLines);
                        }
                        if (fmt && typeof fmt.stripUnknownStickerLines === 'function') {
                            displayLines = fmt.stripUnknownStickerLines(displayLines, catalog);
                        }
                        if (
                            chatRow &&
                            chatRow.type !== 'group' &&
                            contactRow &&
                            displayLines.length
                        ) {
                            displayLines = stripPrivateRolePrefixLines(displayLines, contactRow);
                        }
                        var chatSettingsForNarr =
                            store.getChatSettings && typeof store.getChatSettings === 'function'
                                ? store.getChatSettings(chatId)
                                : null;
                        var narrationOn =
                            !options.callMode &&
                            chatRow &&
                            chatRow.type !== 'group' &&
                            !!(chatSettingsForNarr && chatSettingsForNarr.onlineNarrationEnabled);
                        var narrationInjectCtx =
                            !chatSettingsForNarr || chatSettingsForNarr.onlineNarrationInjectContext !== false;
                        var narrationOps = [];
                        if (fmt && typeof fmt.extractNarrationFromLines === 'function') {
                            var narrParsed = fmt.extractNarrationFromLines(displayLines, {
                                narrationEnabled: narrationOn
                            });
                            displayLines = narrParsed.lines;
                            narrationOps = Array.isArray(narrParsed.narrationOps) ? narrParsed.narrationOps : [];
                        }
                        if (
                            !options.callMode &&
                            chatRow &&
                            chatRow.type !== 'group' &&
                            contactRow &&
                            fmt &&
                            typeof fmt.extractAvatarSwapFromLines === 'function'
                        ) {
                            var dynAvSet =
                                (chatSettingsForNarr && chatSettingsForNarr.dynamicAvatar) || {};
                            var avExtract = fmt.extractAvatarSwapFromLines(displayLines, {
                                charAvatarSwapEnabled: !!dynAvSet.charEnabled,
                                userAvatarSwapEnabled: !!dynAvSet.userEnabled
                            });
                            displayLines = avExtract.lines;
                            pendingAvatarSwaps = Array.isArray(avExtract.swaps) ? avExtract.swaps : [];
                        }
                        var parsedBubbles;
                        if (options.callMode && global.MiyaChatCalls && typeof global.MiyaChatCalls.parseCallApiLines === 'function') {
                            callApiMeta = global.MiyaChatCalls.parseCallApiLines(displayLines, {
                                mode: options.callParseMode || 'turn',
                                callId: options.callId,
                                callKind: options.callKind
                            });
                            parsedBubbles = callApiMeta.bubbles || [];
                        } else if (
                            chatRow &&
                            chatRow.type === 'group' &&
                            global.MiyaChatGroup &&
                            typeof global.MiyaChatGroup.parseGroupOutputLines === 'function'
                        ) {
                            var gMembers = global.MiyaChatGroup.getMembers(store, chatRow);
                            var gCatalog =
                                typeof global.MiyaChatGroup.collectStickerCatalog === 'function'
                                    ? global.MiyaChatGroup.collectStickerCatalog(store, gMembers)
                                    : catalog;
                            parsedBubbles = global.MiyaChatGroup.parseGroupOutputLines(
                                displayLines,
                                gMembers,
                                store,
                                chatId,
                                gCatalog,
                                built.profile
                            );
                            pendingRoleCall = null;
                        } else if (fmt && typeof fmt.parseRoleOutputLinesMeta === 'function') {
                            var metaParsed = fmt.parseRoleOutputLinesMeta(displayLines, catalog);
                            parsedBubbles = metaParsed.bubbles;
                            pendingRoleCall = metaParsed.pendingRoleCall;
                            if (userWantsHtml && htmlOnly && htmlOnly.raw) {
                                parsedBubbles = [
                                    {
                                        role: 'assistant',
                                        type: 'html',
                                        content: '[HTML]',
                                        htmlRaw: htmlOnly.raw,
                                        renderAsHtml: true
                                    }
                                ];
                                pendingRoleCall = null;
                            }
                        } else if (fmt && typeof fmt.parseRoleOutputLines === 'function') {
                            parsedBubbles = fmt.parseRoleOutputLines(displayLines, catalog);
                        } else {
                            parsedBubbles = bubbles.map(function (b) {
                                return { role: 'assistant', type: 'text', content: b };
                            });
                        }

                        if (!parsedBubbles.length && displayLines.length && !options.callMode) {
                            parsedBubbles = displayLines.map(function (b) {
                                return { role: 'assistant', type: 'text', content: b };
                            });
                            pendingRoleCall = null;
                        }
                        if (!parsedBubbles.length && !options.callMode && bubbles.length) {
                            parsedBubbles = bubbles.map(function (b) {
                                return { role: 'assistant', type: 'text', content: b };
                            });
                            pendingRoleCall = null;
                        }
                        if (!parsedBubbles.length && !options.callMode) {
                            var salvageRaw = buildSalvageBubbleText(replyRaw);
                            if (salvageRaw) {
                                parsedBubbles = [{ role: 'assistant', type: 'text', content: salvageRaw }];
                                pendingRoleCall = null;
                            }
                        }
                        if (!parsedBubbles.length && options.callMode && callApiMeta && callApiMeta.ringRejected) {
                            parsedBubbles = [];
                        }
                        if (
                            !parsedBubbles.length &&
                            !narrationOps.length &&
                            !pendingRoleCall &&
                            !(
                                options.callMode &&
                                callApiMeta &&
                                (callApiMeta.ringAccepted || callApiMeta.ringRejected)
                            )
                        ) {
                            var lastResort = buildSalvageBubbleText(replyRaw);
                            var skipCallSalvage =
                                options.callMode &&
                                global.MiyaChatCalls &&
                                typeof global.MiyaChatCalls.isCallDialCommandLine === 'function' &&
                                global.MiyaChatCalls.isCallDialCommandLine(lastResort);
                            if (lastResort && !skipCallSalvage) {
                                parsedBubbles = [{ role: 'assistant', type: 'text', content: lastResort }];
                            } else if (!options.callMode) {
                                throw new Error('empty_reply');
                            }
                        }

                        parsedBubbles = (parsedBubbles || []).filter(function (fields) {
                            if (!fields) return false;
                            if (fields.type === 'recall') return !!String(fields.recallTarget || '').trim();
                            if (fields.callLine) return !!String(fields.callLine).trim();
                            if (fields.type === 'html') {
                                return !!String(fields.htmlRaw || fields.content || '').trim();
                            }
                            if (fields.type === 'sticker') return !!(fields.stickerBlobId || fields.stickerUrl || fields.stickerName);
                            if (fields.type === 'voice') return !!String(fields.voiceText || fields.content || '').trim();
                            if (fields.type === 'image') return !!String(fields.content || fields.imageDataKey || '').trim();
                            return !!String(fields.content || '').trim();
                        });
                        if (
                            !options.callMode &&
                            fmt &&
                            typeof fmt.dedupeParsedRoleBubbles === 'function' &&
                            parsedBubbles.length > 1
                        ) {
                            parsedBubbles = fmt.dedupeParsedRoleBubbles(parsedBubbles);
                        }

                        var awSanitize = global.MiyaChatAwareness;
                        var ggSanitize = global.MiyaChatGroup;
                        var gMembersSan =
                            chatRow && chatRow.type === 'group' && ggSanitize
                                ? ggSanitize.getMembers(store, chatRow)
                                : [];
                        var replyBatchId =
                            !options.callMode && chatRow && chatRow.type !== 'group'
                                ? 'rb-' + Date.now() + '-' + String(Math.floor(Math.random() * 1e9))
                                : '';
                        var replyBaseTs = Date.now();
                        var replySeq = 0;
                        function nextReplyCreatedAt() {
                            var ts = replyBaseTs + replySeq;
                            replySeq += 1;
                            return ts;
                        }
                        function appendNarrationAfterBubble(acc, bubbleIndex) {
                            if (!narrationOps.length || !replyBatchId) return Promise.resolve(acc);
                            var chainN = Promise.resolve(acc);
                            narrationOps.forEach(function (op) {
                                if (!op || op._done) return;
                                if (Number(op.afterBubbleIndex) !== Number(bubbleIndex)) return;
                                var narrText = String(op.text || '').trim();
                                if (!narrText) {
                                    op._done = true;
                                    return;
                                }
                                chainN = chainN.then(function (innerAcc) {
                                    return store
                                        .addMessage(chatId, {
                                            role: 'system',
                                            type: 'text',
                                            content: narrText,
                                            systemKind: 'online-narration',
                                            excludedFromContext: !narrationInjectCtx,
                                            replyBatchId: replyBatchId,
                                            createdAt: nextReplyCreatedAt()
                                        })
                                        .then(function (msg) {
                                            op._done = true;
                                            innerAcc.push(msg);
                                            return innerAcc;
                                        });
                                });
                            });
                            return chainN;
                        }
                        chain = chain.then(function (acc) {
                            return appendNarrationAfterBubble(acc, -1);
                        });
                        for (var bubbleIdx = 0; bubbleIdx < parsedBubbles.length; bubbleIdx++) {
                            (function (fields, unitIndex) {
                                chain = chain.then(function (acc) {
                                var payload = sanitizeAssistantPayload(
                                    Object.assign({ role: 'assistant' }, fields || {})
                                );
                                if (replyBatchId) payload.replyBatchId = replyBatchId;
                                payload.createdAt = nextReplyCreatedAt();
                                if (options.anonymous && payload.role === 'assistant') payload.anonymousDisguise = true;
                                if (options.callId) payload.callId = String(options.callId);
                                if (options.callKind) payload.callKind = options.callKind === 'video' ? 'video' : 'voice';
                                if (
                                    chatRow &&
                                    chatRow.type === 'group' &&
                                    ggSanitize &&
                                    typeof ggSanitize.stripGroupSpeakerPrefixForDisplay === 'function' &&
                                    gMembersSan.length
                                ) {
                                    if (payload.content) {
                                        payload.content = ggSanitize.stripGroupSpeakerPrefixForDisplay(
                                            payload.content,
                                            gMembersSan,
                                            store,
                                            chatId,
                                            built.profile
                                        );
                                    }
                                    if (payload.voiceText) {
                                        payload.voiceText = ggSanitize.stripGroupSpeakerPrefixForDisplay(
                                            payload.voiceText,
                                            gMembersSan,
                                            store,
                                            chatId,
                                            built.profile
                                        );
                                    }
                                }
                                /*
                                 * 状态栏只挂在**最后一条**助手气泡上。
                                 * 语义上它属于「整段回复的收尾」，挂中间会让用户
                                 * 看到一半正文、一半卡片再接着正文，很割裂。
                                 *
                                 * 注意位置：必须放在 sanitizeRoleMessageFields 之后。
                                 * sanitize 会重建 payload 字段，先挂会被冲掉。
                                 */
                                if (
                                    pendingStatusBar &&
                                    unitIndex === parsedBubbles.length - 1 &&
                                    payload.role === 'assistant'
                                ) {
                                    payload.statusBar = pendingStatusBar;
                                }
                                if (awSanitize && typeof awSanitize.sanitizeRoleMessageFields === 'function') {
                                    payload = awSanitize.sanitizeRoleMessageFields(payload);
                                } else if (
                                    awSanitize &&
                                    typeof awSanitize.stripTimelinePrefixForDisplay === 'function'
                                ) {
                                    if (payload.content) {
                                        payload.content = awSanitize.stripTimelinePrefixForDisplay(payload.content);
                                    }
                                    if (payload.voiceText) {
                                        payload.voiceText = awSanitize.stripTimelinePrefixForDisplay(
                                            payload.voiceText
                                        );
                                    }
                                    if (payload.callLine) {
                                        payload.callLine = awSanitize.stripTimelinePrefixForDisplay(payload.callLine);
                                    }
                                }
                                if (options.callEphemeral) {
                                    var lineText = String(
                                        payload.callLine ||
                                            payload.voiceText ||
                                            payload.content ||
                                            ''
                                    )
                                        .replace(/^语音[-－—]\s*/, '')
                                        .trim();
                                    if (
                                        !lineText ||
                                        (global.MiyaChatCalls &&
                                            typeof global.MiyaChatCalls.isCallDialCommandLine === 'function' &&
                                            global.MiyaChatCalls.isCallDialCommandLine(lineText))
                                    ) {
                                        return acc;
                                    }
                                    var ep = {
                                        role: 'assistant',
                                        text: lineText,
                                        ephemeral: true,
                                        callId: options.callId
                                    };
                                    acc.push(ep);
                                    return acc;
                                }
                                if (payload.type === 'recall') {
                                    var recallOpts = {
                                        role: 'assistant',
                                        targetText: payload.recallTarget,
                                        byName: contactRow && contactRow.name ? contactRow.name : ''
                                    };
                                    if (chatRow && chatRow.type === 'group' && payload.senderContactId) {
                                        recallOpts.senderContactId = payload.senderContactId;
                                    }
                                    var recallChain = store.recallMessageByTarget
                                        ? store.recallMessageByTarget(chatId, recallOpts)
                                        : Promise.resolve(null);
                                    return recallChain.then(function (recalledMsg) {
                                        if (recalledMsg) acc.push(recalledMsg);
                                        return appendNarrationAfterBubble(acc, unitIndex);
                                    });
                                }
                                var holdXfer = Promise.resolve();
                                if (
                                    !options.callMode &&
                                    contactRow &&
                                    payload.type === 'transfer' &&
                                    payload.redPacket &&
                                    payload.redPacket.dir === 'in' &&
                                    String(payload.redPacket.status || 'pending').trim() === 'pending' &&
                                    global.MiyaChatWallet &&
                                    typeof global.MiyaChatWallet.holdRoleOutgoingTransfer === 'function'
                                ) {
                                    holdXfer = global.MiyaChatWallet
                                        .holdRoleOutgoingTransfer(
                                            contactRow.id,
                                            payload.redPacket.amount
                                        )
                                        .then(function () {
                                            payload.redPacket = Object.assign({}, payload.redPacket, {
                                                walletHeld: true
                                            });
                                        })
                                        .catch(function () {
                                            /* 余额不足时仍展示转账，但不记账 */
                                        });
                                }
                                /* 单聊红包：角色发红包 → 从角色钱包预扣托管，落库后安排用户自动领取 */
                                if (
                                    !options.callMode &&
                                    chatRow &&
                                    chatRow.type !== 'group' &&
                                    contactRow &&
                                    payload.type === 'red_packet' &&
                                    payload.singleRedPacket &&
                                    global.MiyaChatSingleRedPacket &&
                                    typeof global.MiyaChatSingleRedPacket.holdOutgoing === 'function'
                                ) {
                                    var srpModEngine = global.MiyaChatSingleRedPacket;
                                    var srpCtxEngine = {
                                        chat: chatRow,
                                        contact: contactRow,
                                        profile: built.profile,
                                        isGroup: false
                                    };
                                    holdXfer = holdXfer.then(function () {
                                        return srpModEngine
                                            .holdOutgoing(payload.singleRedPacket, srpCtxEngine)
                                            .then(function (held) {
                                                payload.singleRedPacket = Object.assign(
                                                    {},
                                                    payload.singleRedPacket,
                                                    { walletHeld: !!held }
                                                );
                                            })
                                            .catch(function () {
                                                /* 余额不足时仍展示红包，但不托管、不自动领取 */
                                            });
                                    });
                                }
                                if (
                                    !options.callMode &&
                                    chatRow &&
                                    chatRow.type !== 'group' &&
                                    contactRow &&
                                    payload.type === 'image' &&
                                    !payload.imageDataKey &&
                                    (payload.imageKind === 'text' || !payload.imageKind) &&
                                    isContactImageGenEnabled(chatSettingsForNarr)
                                ) {
                                    payload.imageGenPending = true;
                                }
                                if (
                                    !options.callMode &&
                                    chatRow &&
                                    chatRow.type === 'group' &&
                                    ggSanitize &&
                                    typeof ggSanitize.processAssistantBubbleForTitleChange === 'function'
                                ) {
                                    var titleChangeResult = ggSanitize.processAssistantBubbleForTitleChange(
                                        payload,
                                        {
                                            store: store,
                                            chatId: chatId,
                                            members: gMembersSan,
                                            profile: built.profile
                                        }
                                    );
                                    if (titleChangeResult && titleChangeResult.skipBubble) {
                                        var titleChain = holdXfer;
                                        if (titleChangeResult.settingsPatch) {
                                            titleChain = titleChain.then(function () {
                                                return store.saveChatSettings(
                                                    chatId,
                                                    titleChangeResult.settingsPatch
                                                );
                                            });
                                        }
                                        return titleChain.then(function () {
                                            if (!titleChangeResult.systemMessage) {
                                                return appendNarrationAfterBubble(acc, unitIndex);
                                            }
                                            return store
                                                .addMessage(chatId, titleChangeResult.systemMessage)
                                                .then(function (msg) {
                                                    if (!firstMsgId) firstMsgId = msg.id;
                                                    lastMsgId = msg.id;
                                                    acc.push(msg);
                                                    return appendNarrationAfterBubble(acc, unitIndex);
                                                });
                                        });
                                    }
                                }
                                return holdXfer.then(function () {
                                    return store.addMessage(chatId, payload).then(function (msg) {
                                        if (!firstMsgId) firstMsgId = msg.id;
                                        lastMsgId = msg.id;
                                        acc.push(msg);
                                        /* 角色发的单聊红包：等全部气泡显示后安排用户领取 */
                                        if (
                                            msg &&
                                            msg.type === 'red_packet' &&
                                            msg.singleRedPacket &&
                                            global.MiyaChatSingleRedPacket &&
                                            typeof global.MiyaChatSingleRedPacket.scheduleAutoClaims === 'function'
                                        ) {
                                            global.MiyaChatSingleRedPacket.scheduleAutoClaims(
                                                store,
                                                chatId,
                                                msg.id,
                                                {
                                                    chat: chatRow,
                                                    contact: contactRow,
                                                    profile: built.profile,
                                                    isGroup: false
                                                }
                                            );
                                        }
                                        return appendNarrationAfterBubble(acc, unitIndex);
                                    });
                                });
                            });
                            })(parsedBubbles[bubbleIdx], bubbleIdx);
                        }
                        chain = chain.then(function (acc) {
                            if (!narrationOps.length || !replyBatchId) return acc;
                            var chainLeft = Promise.resolve(acc);
                            narrationOps.forEach(function (op) {
                                if (!op || op._done) return;
                                var leftText = String(op.text || '').trim();
                                if (!leftText) {
                                    op._done = true;
                                    return;
                                }
                                chainLeft = chainLeft.then(function (innerAcc) {
                                    return store
                                        .addMessage(chatId, {
                                            role: 'system',
                                            type: 'text',
                                            content: leftText,
                                            systemKind: 'online-narration',
                                            excludedFromContext: !narrationInjectCtx,
                                            replyBatchId: replyBatchId,
                                            createdAt: nextReplyCreatedAt()
                                        })
                                        .then(function (msg) {
                                            op._done = true;
                                            innerAcc.push(msg);
                                            return innerAcc;
                                        });
                                });
                            });
                            return chainLeft;
                        });
                        return chain;
                    })
                    .then(function (msgs) {
                var localUsage = buildLocalTokenUsage(built, replyRaw);
                var hvChatSettings =
                    store.getChatSettings && typeof store.getChatSettings === 'function'
                        ? store.getChatSettings(chatId)
                        : null;
                var hvTplMod = global.MiyaChatHeartVoiceTemplates;
                var hvPreset =
                    hvTplMod && typeof hvTplMod.resolvePresetForChat === 'function'
                        ? hvTplMod.resolvePresetForChat(hvChatSettings)
                        : null;
                var hvParseOpts = {};
                if (hvPreset && hvTplMod && typeof hvTplMod.getFieldNames === 'function') {
                    hvParseOpts.fieldNames = hvTplMod.getFieldNames(hvPreset);
                }
                var hvParsed = parseHeartVoiceFromReply(replyRaw, hvParseOpts);
                var thinkingText = thinking ? String(thinking).trim() : '';
                var isGroupReply = !!(chatRow && chatRow.type === 'group');
                var chatPatch = {
                    activeThinking: thinkingText,
                    activeThinkingMsgId: firstMsgId || lastMsgId || '',
                    lastPromptMeta: built.promptMeta || null,
                    lastRawAssistantReply: replyRawOriginal,
                    lastPromptDebug: buildPromptDebug(built.messages),
                    lastHeartVoiceParse: hvParsed,
                    activeHeartVoiceMsgId: isGroupReply ? '' : (lastMsgId || firstMsgId || '')
                };
                chatPatch.lastTokenUsage = localUsage;
                /* 记录「这一次真实发送」的来源分布快照。
                   buildPromptSourceBreakdown 传入的是 built.messages（真正发往 API 的数组）
                   与 built.worldbookMeta（本轮世界书命中信息），因此结果就是本轮实际分布，
                   而非下一次请求的预估。聊天设置里的「Token 来源分布」优先读这份快照。 */
                chatPatch.lastPromptBreakdown = (function () {
                    try {
                        var bd = buildPromptSourceBreakdown(built.messages, built.worldbookMeta);
                        if (!bd) return null;
                        bd.replyMsgId = lastMsgId || firstMsgId || '';
                        bd.isGroupReply = isGroupReply;
                        return bd;
                    } catch (eBd) {
                        return null;
                    }
                })();
                if (!isGroupReply && hvParsed.extractedOk && hvParsed.extracted && lastMsgId) {
                    var hvEntry = {
                        id: 'hv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
                        msgId: lastMsgId,
                        affection: hvParsed.extracted.affection,
                        desire: hvParsed.extracted.desire,
                        action: hvParsed.extracted.action,
                        monologue: hvParsed.extracted.monologue,
                        updatedAt: Date.now()
                    };
                    if (hvParsed.extracted.mode === 'custom' || (hvPreset && hvParsed.extracted.fields)) {
                        hvEntry.mode = 'custom';
                        hvEntry.presetName = hvPreset
                            ? String(hvPreset.name || '')
                            : String((hvChatSettings && hvChatSettings.heartVoicePreset) || '');
                        hvEntry.fields = hvParsed.extracted.fields || {};
                        var tplHtml = hvPreset ? String(hvPreset.htmlTemplate || '') : '';
                        if (
                            !tplHtml &&
                            hvChatSettings &&
                            hvChatSettings.heartVoicePresetSnapshot
                        ) {
                            tplHtml = String(
                                hvChatSettings.heartVoicePresetSnapshot.htmlTemplate || ''
                            );
                        }
                        hvEntry.htmlTemplate = tplHtml;
                    }
                    chatPatch.heartVoiceLog = appendHeartVoiceLog(
                        chatRow && chatRow.heartVoiceLog,
                        hvEntry
                    );
                    chatPatch.activeHeartVoiceMsgId = lastMsgId;
                }

                    return store
                        .updateChat(chatId, chatPatch)
                        .then(function () {
                            /*
                             * 一版新回复已经落库：这个会话上任何还挂着的
                             * 「删了重说」标记都作废 —— 被删的那版不再是末条，
                             * 「紧接着重答一次」的语境已经不存在。
                             *
                             * 关键场景是【重回】：撤回末条角色消息走的是
                             * store.deleteMessages（会打标）。若重回**成功**后
                             * 不清掉它，用户下一次普通发送就会被误判成
                             * 「删掉上一版要求重答」，还会把刚生成、
                             * 明明还在历史里的回复当成「被弃版本」去规避。
                             * 反过来，重回**失败**（没走到这里）时标记保留，
                             * 用户改走「自己再说一句」仍能拿到改写约束 —— 两条路都对。
                             */
                            try {
                                if (store.clearRewriteResume) {
                                    store.clearRewriteResume(chatId);
                                    var canonClearId =
                                        typeof resolveApiChatId === 'function'
                                            ? resolveApiChatId(chatId)
                                            : '';
                                    if (canonClearId && canonClearId !== chatId) {
                                        store.clearRewriteResume(canonClearId);
                                    }
                                }
                            } catch (eClear) {}
                            if (lifeLikeNextPushPatch && store.saveChatSettings) {
                                return store.saveChatSettings(chatId, lifeLikeNextPushPatch);
                            }
                        })
                        .then(function () {
                            if (
                                lifeLikeNextPushPatch &&
                                global.MiyaChatBackground &&
                                typeof global.MiyaChatBackground.kickScan === 'function'
                            ) {
                                global.MiyaChatBackground.kickScan();
                            }
                        })
                        .then(function () {
                            if (
                                pendingAvatarSwaps.length &&
                                global.MiyaChatDynamicAvatar &&
                                typeof global.MiyaChatDynamicAvatar.applySwaps === 'function' &&
                                contactRow
                            ) {
                                return global.MiyaChatDynamicAvatar.applySwaps(
                                    chatId,
                                    pendingAvatarSwaps,
                                    msgs,
                                    contactRow.id,
                                    built.profile && built.profile.id ? built.profile.id : ''
                                );
                            }
                        })
                        .then(function () {
                            if (
                                global.miyaChatRoomExtras &&
                                typeof global.miyaChatRoomExtras.patchTokenUsageInSettings === 'function'
                            ) {
                                global.miyaChatRoomExtras.patchTokenUsageInSettings(chatId);
                            }
                            if (global.MiyaChatSummary && typeof global.MiyaChatSummary.maybeAutoSummary === 'function') {
                                global.MiyaChatSummary.maybeAutoSummary(chatId);
                            }
                            if (
                                global.MiyaChatMemoryExtract &&
                                typeof global.MiyaChatMemoryExtract.maybeAutoMemoryExtract === 'function'
                            ) {
                                global.MiyaChatMemoryExtract.maybeAutoMemoryExtract(chatId);
                            }
                            if (
                                global.MiyaChatMoments &&
                                typeof global.MiyaChatMoments.maybeAutoMomentsAfterRound === 'function'
                            ) {
                                global.MiyaChatMoments.maybeAutoMomentsAfterRound(chatId);
                            }
                            var bgPush = !!(options.isAutoPush || options.isOffline || options.isLifeLike);
                            var roomOpen =
                                global.miyaChatRoom &&
                                global.miyaChatRoom.getOpenChatId &&
                                global.miyaChatRoom.getOpenChatId() === chatId;
                            if (roomOpen) {
                                if (
                                    updatedTransferMsgIds.length &&
                                    typeof global.miyaChatRoom.patchMessageBubble === 'function'
                                ) {
                                    updatedTransferMsgIds.forEach(function (xferMsgId) {
                                        global.miyaChatRoom.patchMessageBubble(xferMsgId);
                                    });
                                }
                                if (
                                    updatedCoupleInviteMsgIds.length &&
                                    typeof global.miyaChatRoom.patchMessageBubble === 'function'
                                ) {
                                    updatedCoupleInviteMsgIds.forEach(function (cpMsgId) {
                                        global.miyaChatRoom.patchMessageBubble(cpMsgId);
                                    });
                                }
                                if (hvParsed.extractedOk && global.MiyaChatHeartVoice && typeof global.MiyaChatHeartVoice.onRoundUpdated === 'function') {
                                    global.MiyaChatHeartVoice.onRoundUpdated(chatId);
                                }
                                if (bgPush && typeof global.miyaChatRoom.refresh === 'function') {
                                    global.miyaChatRoom.refresh({
                                        animate: false,
                                        preserveScrollTop: true,
                                        preserveLoadedCount: true,
                                        toBottom: document.hidden
                                    });
                                } else if (
                                    msgs.length &&
                                    typeof global.miyaChatRoom.revealAssistantMessages === 'function'
                                ) {
                                    global.miyaChatRoom.revealAssistantMessages(msgs);
                                }
                            }
                            if (
                                global.miyaChatApp &&
                                typeof global.miyaChatApp.refreshLists === 'function' &&
                                !roomOpen
                            ) {
                                global.miyaChatApp.refreshLists();
                            }
                            if (
                                global.MiyaChatNotify &&
                                typeof global.MiyaChatNotify.notifyAssistantMessages === 'function' &&
                                msgs.length
                            ) {
                                global.MiyaChatNotify.notifyAssistantMessages(chatId, msgs, {
                                    isAutoPush: !!options.isAutoPush,
                                    isOffline: !!options.isOffline,
                                    roomWasOpen: roomOpen
                                });
                            }
                            var out = { messages: msgs, thinking: thinking };
                            if (callApiMeta) {
                                out.callApiMeta = callApiMeta;
                            }
                            if (
                                pendingRoleCall &&
                                global.MiyaChatCalls &&
                                typeof global.MiyaChatCalls.onRoleCallIntent === 'function' &&
                                !(
                                    typeof global.MiyaChatCalls.isActive === 'function' &&
                                    global.MiyaChatCalls.isActive()
                                )
                            ) {
                                try {
                                    global.MiyaChatCalls.onRoleCallIntent(chatId, pendingRoleCall);
                                } catch (callErr) {}
                            }
                            if (
                                roleMomentsIntent &&
                                contactRow &&
                                chatRow &&
                                chatRow.type !== 'group' &&
                                global.MiyaChatMoments &&
                                typeof global.MiyaChatMoments.createRolePostFromIntent === 'function'
                            ) {
                                try {
                                    global.MiyaChatMoments.createRolePostFromIntent(
                                        contactRow.id,
                                        roleMomentsIntent
                                    );
                                } catch (momErr) {}
                            }
                            if (
                                global.MiyaImageGen &&
                                typeof global.MiyaImageGen.processAssistantMessages === 'function' &&
                                chatRow &&
                                chatRow.type !== 'group'
                            ) {
                                global.MiyaImageGen.processAssistantMessages(chatId, msgs).catch(function () {});
                            }
                            return out;
                        });
                    });
            });
            }); /* pluginReady.then */
        })
            .then(function (value) {
                clearInFlight('done');
                if (global.MiyaMemoryTableApp && typeof global.MiyaMemoryTableApp.afterGenerate === 'function') {
                    try {
                        global.MiyaMemoryTableApp.afterGenerate({
                            scope: 'chat',
                            chatId: chatId,
                            result: value,
                            options: options
                        });
                    } catch (eMtAfter) {}
                }
                return value;
            }, function (err) {
                var genLife = global.MiyaGenerationLifecycle;
                if (genLife && genLife.isAbortError && genLife.isAbortError(err)) {
                    clearInFlight('abort', err);
                } else {
                    clearInFlight('error', err);
                }
                throw err;
            });
    }

    global.miyaChatEngine = {
        getApiConfig: getApiConfig,
        getGlobalPrompt: getGlobalPrompt,
        buildAvatarRecognitionBlock: buildAvatarRecognitionBlock,
        collectContactRoleIds: collectContactRoleIds,
        collectBoundLocalWorldbookBindings: collectBoundLocalWorldbookBindings,
        collectBoundLocalBindingsForRoleIds: collectBoundLocalBindingsForRoleIds,
        listSortableWorldbookEntriesForContact: listSortableWorldbookEntriesForContact,
        collectSortableWorldbookEntryIdsForContact: collectSortableWorldbookEntryIdsForContact,
        buildUniversalWorldbookTopLayer: buildUniversalWorldbookTopLayer,
        prependUniversalWorldbookMessage: prependUniversalWorldbookMessage,
        appendWorldbookBackMessages: appendWorldbookBackMessages,
        insertWorldbookInChatMessages: insertWorldbookInChatMessages,
        joinWorldbookBundleText: joinWorldbookBundleText,
        ensureWorldbookDepsReady: ensureWorldbookDepsReady,
        buildWorldbookBundle: buildWorldbookBundle,
        buildSystemPrompt: buildSystemPrompt,
        buildStPresetMessages: buildStPresetMessages,
        injectStInChatMessages: injectStInChatMessages,
        /* 【V9】导出来源打标器：线下链路（miya-appointment-engine）此前手工重建
           {role, content}，把 __src 丢掉，导致 20+ 条 ST 预设全被分类成
           「其它系统块」。导出后两条链路共用同一个打标实现，不再各写一份。 */
        stTaggedMessage: stTaggedMessage,
        buildStCotPromptBlock: buildStCotPromptBlock,
        buildStPresetCheckHint: buildStPresetCheckHint,
        buildApiMessages: buildApiMessages,
        setPendingOnlineReturnPrompt: function (chatId, text) {
            var key = String(chatId || '').trim();
            if (!key) return;
            pendingOnlineReturnPromptByChat[key] = String(text || '').trim();
        },
        sendChat: sendChat,
        stopChatGeneration: stopChatGeneration,
        acquireChatApi: acquireChatApi,
        releaseChatApi: releaseChatApi,
        isChatApiBusy: isChatApiBusy,
        isReplyInFlight: isReplyInFlight,
        estimateTokensFromText: estimateTokensFromText,
        estimateTokensFromCharCount: estimateTokensFromCharCount,
        estimateMessagesTokens: estimateMessagesTokens,
        countMessagesChars: countMessagesChars,
        buildPromptSourceBreakdown: buildPromptSourceBreakdown,
        extractBodyForBubbles: extractBodyForBubbles,
        splitBubbles: splitBubbles,
        stripThinkingForApi: stripThinkingForApi,
        stripHeartVoiceTags: stripHeartVoiceTags,
        stripHeartVoiceTagFragments: stripHeartVoiceTagFragments,
        parseThinking: parseThinking,
        extractHeartVoiceBlock: extractHeartVoiceBlock,
        parseHeartVoiceFromReply: parseHeartVoiceFromReply,
        getTrailingUserRound: getTrailingUserRound,
        getTrailingAssistantRound: getTrailingAssistantRound,
        getUserRoundBeforeAssistant: getUserRoundBeforeAssistant,
        withdrawLastAssistantRound: withdrawLastAssistantRound,
        regenerateLastRound: regenerateLastRound,
        resolveApiChatId: resolveApiChatId,
        extractReplyContent: extractReplyContent,
        extractThinkingBlock: extractThinkingBlock,
        extractThinkingFromResponse: extractThinkingFromResponse,
        buildOnlineRulesBundle: buildOnlineRulesBundle,
        buildCallSystemPrompt: buildCallSystemPrompt,
        buildCallRingRules: buildCallRingRules
    };
})(window);
