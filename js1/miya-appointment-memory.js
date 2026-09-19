(function (global) {
    'use strict';

    var apStore = function () {
        return global.MiyaAppointmentStore;
    };

    function clampInt(v, lo, hi, fb) {
        var n = parseInt(v, 10);
        if (!Number.isFinite(n)) return fb;
        return Math.min(hi, Math.max(lo, n));
    }

    function pickTs(v) {
        var n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function historyCountForChat(st, id) {
        if (!st || !id) return 0;
        var arr =
            st.getMessagesForApi && typeof st.getMessagesForApi === 'function'
                ? st.getMessagesForApi(id)
                : st.getMessages(id);
        return Array.isArray(arr) ? arr.length : 0;
    }

    /**
     * 与线上聊天室一致的 canonical chatId。
     * 当前打开的会话只要有历史，就以它为准（普通回复/续写/重回/主动消息共用）；
     * 仅当当前会话为空时，才回退到同联系人其它线程。
     */
    /**
     * 把「零散线程」的 chatId 归一到「规范聊天」。
     *
     * v11 加保护（修「聊得好好的会跳到另一个聊天记录的楼里」）：
     * 原实现只要当前聊天没有【线上消息】就去该角色的另一个聊天顶替，
     * 完全不管这个聊天自己有没有【线下场次】。于是用户在 chat_B 里
     * 已经聊了一大段线下剧情，只因 chat_B 没有线上消息，就被解析成 chat_A，
     * 随后场次迁移把内容搬走 —— 表现为莫名其妙跳到了别的聊天记录。
     *
     * 现在的规则：当前聊天只要有线下场次，就认定它是自己的宿主，原样返回。
     * 只有「线上没消息 且 线下也没场次」的空壳线程才允许被归并。
     */
    function resolveCanonicalChatId(chatId) {
        var st = global.miyaChatStore;
        if (!st || !chatId) return String(chatId || '').trim();
        var cid = String(chatId || '').trim();
        var chat = st.findChat(cid);
        if (!chat || !chat.contactId) return cid;
        if (chat.type === 'group') return cid;
        if (historyCountForChat(st, cid) > 0) return cid;
        /* 本聊天已有线下场次 —— 它就是自己的宿主，不许被别的聊天顶替 */
        if (hasOfflineSessions(cid)) return cid;
        var contact = st.findContact(chat.contactId);
        if (!contact) return cid;
        var profileHint = String(chat.profileId || contact.defaultProfileId || '').trim();
        var canonical = st.findChatByContact(chat.contactId, profileHint);
        if (canonical && canonical.id && historyCountForChat(st, canonical.id) > 0) return canonical.id;
        var any = st.findChatByContact(chat.contactId, '');
        if (any && any.id && historyCountForChat(st, any.id) > 0) return any.id;
        return cid;
    }

    /** 该聊天名下是否有线下场次（有则视为有内容，不做归一） */
    function hasOfflineSessions(chatId) {
        var aps = global.MiyaAppointmentStore;
        if (!aps || typeof aps.getSessions !== 'function') return false;
        try {
            return (aps.getSessions(chatId) || []).length > 0;
        } catch (e) {
            return false;
        }
    }

    function formatCrossTime(ts) {
        if (!ts) return '';
        try {
            return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    function formatCrossLine(role, contact, profile, body, ts) {
        var stamp = formatCrossTime(ts);
        var who = formatWho(role, contact, profile);
        var prefix = stamp ? '〔' + stamp + '·线下〕' : '〔线下〕';
        return prefix + who + '：' + body;
    }

    function resolveContactId(chatId) {
        var st = global.miyaChatStore;
        if (!st || !chatId) return '';
        var chat = st.findChat(chatId);
        return chat && chat.contactId ? String(chat.contactId).trim() : '';
    }

    function resolveContactIdFromInput(chatId, contact) {
        if (contact && contact.id) return String(contact.id).trim();
        return resolveContactId(chatId);
    }

    function onlineSummaryRanges(settings) {
        var sumMod = global.MiyaChatSummary;
        if (sumMod && typeof sumMod.onlineSummaryRanges === 'function') {
            return sumMod.onlineSummaryRanges(settings);
        }
        var list = settings && Array.isArray(settings.summaryList) ? settings.summaryList : [];
        var mega = settings && Array.isArray(settings.megaSummaryList) ? settings.megaSummaryList : [];
        var covered = {};
        if (sumMod && typeof sumMod.summaryIdsCoveredByMega === 'function') {
            covered = sumMod.summaryIdsCoveredByMega(mega);
        }
        var ranges = [];
        mega.forEach(function (row) {
            if (!row) return;
            ranges.push({
                start: clampInt(row.startIndex, 0, 9999999, 0),
                end: clampInt(row.endIndex, 0, 9999999, 0)
            });
        });
        list.forEach(function (row) {
            if (!row) return;
            var sid = row.id ? String(row.id) : '';
            if (sid && covered[sid]) return;
            var s = clampInt(row.startIndex, 0, 9999999, 0);
            var e = clampInt(row.endIndex, 0, 9999999, 0);
            if (!s || !e) return;
            if (
                !sid &&
                sumMod &&
                typeof sumMod.megaRangeFullyCovers === 'function' &&
                sumMod.megaRangeFullyCovers(s, e, ranges)
            ) {
                return;
            }
            ranges.push({ start: s, end: e });
        });
        return ranges;
    }

    function messageIndexCovered(idx, ranges) {
        if (!idx || !ranges.length) return false;
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            if (r.start && r.end && idx >= r.start && idx <= r.end) return true;
        }
        return false;
    }

    function offlineSummaryRanges(session) {
        return (session.summaryList || [])
            .filter(function (row) {
                return row && String(row.content || '').trim();
            })
            .map(function (row) {
                return {
                    start: clampInt(row.startIndex, 0, 9999999, 0),
                    end: clampInt(row.endIndex, 0, 9999999, 0)
                };
            });
    }

    /** 线下 session 总结范围 + 消息 id→序号，供线上 API 按条过滤镜像（仅去掉已总结段，保留未总结尾巴） */
    function buildOfflineMirrorFilterContext(chatId, contactId) {
        var ctx = {
            sessionRanges: Object.create(null),
            msgIndexById: Object.create(null),
            hiddenMsgIds: Object.create(null)
        };
        var aps = apStore();
        if (!aps || typeof aps.exportForMemory !== 'function') return ctx;
        var cid = String(contactId || '').trim();
        if (!cid && chatId) cid = resolveContactId(chatId);
        if (!cid) return ctx;
        (aps.exportForMemory(chatId, cid) || []).forEach(function (sess) {
            if (!sess) return;
            var sid = String(sess.id || '').trim();
            if (!sid) return;
            /*
             * 序号口径必须与总结区间一致。
             * summaryList 的 startIndex/endIndex 是按「可见消息（仅排除 deleted）」
             * 的 1-based 序号写入的，因此这里不能用 liveSessionMessages——它额外
             * 排除了 hidden，一旦区间之前存在隐藏层，映射出的序号就会整体偏小，
             * 导致已总结的镜像被判为「未覆盖」而重复注入。
             * 因此：索引一律按 deleted-only 口径建，hidden 另用一张表记录。
             */
            var idxMap = Object.create(null);
            (sess.messages || []).forEach(function (m, i) {
                if (!m || m.deleted) return;
                if (!m.id) return;
                var mid = String(m.id);
                idxMap[mid] = i + 1;
                if (m.hidden) ctx.hiddenMsgIds[mid] = true;
            });
            ctx.msgIndexById[sid] = idxMap;
            var ranges = offlineSummaryRanges(sess);
            /* 没有总结区间时无需过滤，但 hidden 集合仍要保留（隐藏是独立语义） */
            if (ranges.length) ctx.sessionRanges[sid] = ranges;
        });
        return ctx;
    }

    function shouldKeepOfflineMirror(m, filterCtx) {
        if (!m || !m.offlineMeet) return true;
        filterCtx = filterCtx || { sessionRanges: {}, msgIndexById: {}, hiddenMsgIds: {} };
        /*
         * 隐藏楼层不参与任何生成，线上上下文也不例外。
         * 镜像在消息创建时就已写到线上线程，之后用户点「隐藏」并不会回收它，
         * 若此处不拦，被隐藏的内容仍会经由镜像进入线上 API——与界面上的
         * 「隐藏这一层（不参与生成）」相矛盾。
         */
        var hiddenIds = filterCtx.hiddenMsgIds;
        var apId = String(m.appointmentMsgId || '').trim();
        if (apId && hiddenIds && hiddenIds[apId]) return false;
        var sid = String(m.appointmentSessionId || '').trim();
        if (!sid) return true;
        var ranges = filterCtx.sessionRanges[sid];
        if (!ranges || !ranges.length) return true;
        var mid = apId;
        if (!mid) return true;
        var idxMap = filterCtx.msgIndexById[sid];
        var idx = idxMap && idxMap[mid];
        if (!idx) return true;
        return !messageIndexCovered(idx, ranges);
    }

    function filterOfflineMirrorsForApiHistory(history, chatId, contactId) {
        var filterCtx = buildOfflineMirrorFilterContext(chatId, contactId);
        return (history || []).filter(function (m) {
            return shouldKeepOfflineMirror(m, filterCtx);
        });
    }

    function liveSessionMessages(session) {
        /* hidden 层同样排除：隐藏楼层不该被总结/提取进记忆，否则又绕回上下文里 */
        return (session && session.messages ? session.messages : []).filter(function (m) {
            return m && !m.deleted && !m.hidden && String(m.content || '').trim();
        });
    }

    function formatWho(role, contact, profile) {
        if (role === 'user') return (profile && profile.name) || '我';
        if (role === 'assistant') return (contact && contact.name) || '对方';
        return '系统';
    }

    function plainBody(m, fmt) {
        if (!m || m.deleted) return '';
        if (fmt && typeof fmt.formatMessageForApi === 'function') {
            return String(fmt.formatMessageForApi(m) || '').trim();
        }
        return String(m.content || '').trim();
    }

    function trimSlotsByTime(items, limit) {
        var list = (items || []).slice();
        list.sort(function (a, b) {
            return (a.orderKey || a.ts || 0) - (b.orderKey || b.ts || 0);
        });
        if (list.length > limit) list = list.slice(-limit);
        return list;
    }

    /** @returns {{slotItems:Array,summaryBlocks:Array}} */
    function collectOnlineSlots(chatId, contact, profile, settings, memoryCount) {
        var st = global.miyaChatStore;
        if (!st) return { slotItems: [], summaryBlocks: [] };
        var canonChatId = resolveCanonicalChatId(chatId);
        var limit = clampInt(memoryCount, 1, 500, 40);
        var history =
            st.getMessagesForApi && typeof st.getMessagesForApi === 'function'
                ? st.getMessagesForApi(canonChatId)
                : st.getMessages(canonChatId);
        history = (history || []).filter(function (m) {
            return m && !m.deleted;
        });
        var contactId = resolveContactIdFromInput(canonChatId, contact);
        history = filterOfflineMirrorsForApiHistory(history, canonChatId, contactId);
        var ranges = onlineSummaryRanges(settings);
        var fmt = global.MiyaChatOnlineFormat;
        var slots = [];
        history.forEach(function (m, i) {
            var idx = i + 1;
            if (m.role === 'system') return;
            if (m.offlineMeet) return;
            if (messageIndexCovered(idx, ranges)) return;
            var body = plainBody(m, fmt);
            if (!body) return;
            slots.push({
                channel: 'online',
                kind: 'message',
                ts: pickTs(m.createdAt),
                role: m.role,
                content:
                    (formatCrossTime(pickTs(m.createdAt)) ? '〔' + formatCrossTime(pickTs(m.createdAt)) + '·线上〕' : '〔线上〕') +
                    formatWho(m.role, contact, profile) +
                    '：' +
                    body,
                orderKey: pickTs(m.createdAt) || idx
            });
        });
        if (slots.length > limit) slots = trimSlotsByTime(slots, limit);

        var summaryBlocks = buildOnlineSummaryBlocks(settings);
        return { slotItems: slots, summaryBlocks: summaryBlocks };
    }

    function buildOnlineSummaryBlocks(settings) {
        var aw = global.MiyaChatAwareness;
        if (aw && typeof aw.buildSummaryContextBlock === 'function') {
            var block = aw.buildSummaryContextBlock(settings);
            if (block) return [{ channel: 'online', kind: 'summary_bundle', ts: 0, content: block }];
        }
        return [];
    }

    function buildOfflineSummaryBlocks(sessions) {
        var blocks = [];
        (sessions || []).forEach(function (sess) {
            (sess.summaryList || []).forEach(function (row) {
                var body = String((row && row.content) || '').trim();
                if (!body) return;
                blocks.push({
                    channel: 'offline',
                    kind: 'summary',
                    ts: pickTs(row.createdAt) || pickTs(sess.createdAt),
                    content:
                        '【线下场景总结 · 会话' +
                        String(sess.id || '').slice(-6) +
                        ' · 第' +
                        String(row.startIndex || '?') +
                        '–' +
                        String(row.endIndex || '?') +
                        '条】\n' +
                        body,
                    sessionId: sess.id,
                    orderKey: pickTs(row.createdAt) || pickTs(sess.createdAt)
                });
            });
        });
        return blocks;
    }

    function collectOfflineSlotsForOnline(chatId, contact, profile, memoryCount, opts) {
        var aps = apStore();
        if (!aps) return { slotItems: [] };
        var contactId = resolveContactIdFromInput(chatId, contact);
        /*
         * 排除「当前正在进行的会话」。
         *
         * exportForMemory 会按 contactId 取回该角色的**全部**会话，其中就包括
         * 用户此刻正在玩的那一场。而那一场的正文本来就已经在本轮请求的历史区里
         * （appendSessionHistory 负责拼进去）。若不排除，同一段正文会被**再一次**
         * 格式化进「记忆档案」块，造成三个后果：
         *   1) 白烧 token —— 同一段文字本轮付费两次；
         *   2) 提示缓存每轮必然重建 —— 该块位于历史之前的前缀区，而它每轮都会
         *      多追加一条「本场刚生成的消息」，前缀被改写，缓存 100% 失效。
         *   3) ⚠️ **最严重的**：同一段对话被贴上「跨场景记忆·已发生」的标签
         *      送进请求，而它在历史区里同时又作为「本轮要回应的新消息」出现。
         *      模型读到两个互相冲突的身份，会倾向把「记忆」当作既定事实继续，
         *      于是回到旧话题 —— 用户实测的「点刷新仍生成一模一样的内容」、
         *      「昨天下的飞机今天还答在飞机上吃了」，根源都在这里。
         * 记忆块的立意是「补上那些不在当前上下文里的过往」，本场内容无需它补。
         *
         * ⚠️ 排除必须**双保险**，只靠 activeSessionId 是不够的：
         *   getActiveSession 读的是 bucket.activeSessionId，而该字段只在
         *   「用户从界面正常进入某场次」时才被写上。若它为空（新建后未激活、
         *   数据迁移、或调用方直接按 sessionId 构造请求），排除就会静默失效，
         *   上面第 3 条的故障会原样复现。
         *   所以再接受一个显式的 excludeSessionId —— 调用方本来就知道自己在
         *   为哪一场构造请求，把它传进来是最可靠的判据。
         */
        var activeSessionId = '';
        try {
            var wantSid = String((opts && opts.sessionId) || '').trim();
            if (wantSid) activeSessionId = wantSid;
        } catch (eWant) {}
        if (!activeSessionId) {
            try {
                if (typeof aps.getActiveSessionId === 'function') {
                    activeSessionId = String(aps.getActiveSessionId(chatId) || '');
                }
            } catch (eActiveId) {}
        }
        if (!activeSessionId) {
            try {
                if (typeof aps.getActiveSession === 'function') {
                    var activeSess = aps.getActiveSession(chatId);
                    activeSessionId = String((activeSess && activeSess.id) || '');
                }
            } catch (eActive) {}
        }
        /* 最后一道兜底：会话桶里的 activeSessionId 若存在，也纳入排除 */
        var alsoExclude = Object.create(null);
        if (activeSessionId) alsoExclude[activeSessionId] = true;
        var sessions = (aps.exportForMemory(chatId, contactId) || []).filter(function (sess) {
            if (!sess) return false;
            /*
             * 封存概念已移除，原来的 `if (!sess.closedAt) return false` 必须去掉：
             * closedAt 现在恒为 0，那行会把**所有**会话都滤掉，
             * 结果是「记忆档案」块永远为空 —— 线上角色会彻底想不起线下发生的事。
             *
             * 排除本场仍然靠下面的 activeSessionId 判定，这条才是真正必要的。
             */
            if (alsoExclude[String(sess.id)]) return false;
            return true;
        });
        var limit = clampInt(memoryCount, 1, 500, 40);
        var items = [];
        sessions.forEach(function (sess) {
            var ranges = offlineSummaryRanges(sess);
            /*
             * 序号必须按「仅排除 deleted」的口径推进，与 summaryList 的
             * startIndex/endIndex 保持一致；hidden 只用于「是否注入内容」，
             * 不能参与序号计算，否则区间之前有隐藏层时整段序号都会错位。
             */
            var seq = 0;
            (sess.messages || []).forEach(function (m) {
                if (!m || m.deleted) return;
                seq += 1;
                if (m.hidden) return;              /* 隐藏层不注入，但仍占序号 */
                if (!String(m.content || '').trim()) return;
                var idx = seq;
                if (messageIndexCovered(idx, ranges)) return;
                var body = plainBody(m, null);
                if (!body) return;
                var ts = pickTs(m.createdAt) || pickTs(sess.createdAt);
                items.push({
                    channel: 'offline',
                    kind: 'message',
                    ts: ts,
                    role: m.role,
                    content: formatCrossLine(m.role, contact, profile, body, ts),
                    sessionId: sess.id,
                    orderKey: ts || idx
                });
            });
            (sess.summaryList || []).forEach(function (row) {
                var body = String((row && row.content) || '').trim();
                if (!body) return;
                var ts = pickTs(row.createdAt) || pickTs(sess.createdAt);
                items.push({
                    channel: 'offline',
                    kind: 'summary',
                    ts: ts,
                    role: 'system',
                    content:
                        (formatCrossTime(ts) ? '〔' + formatCrossTime(ts) + '·线下总结〕' : '〔线下总结〕') +
                        '\n' +
                        body,
                    sessionId: sess.id,
                    orderKey: ts
                });
            });
        });
        return { slotItems: trimSlotsByTime(items, limit) };
    }

    function collectOfflineCrossForAppointment(chatId, contact, profile, settings, memoryCount, opts) {
        var limit = clampInt(memoryCount, 1, 500, 40);
        var online = collectOnlineSlots(chatId, contact, profile, settings, memoryCount);
        var offline = collectOfflineSlotsForOnline(chatId, contact, profile, memoryCount, opts);
        var offlineMsgs = (offline.slotItems || []).filter(function (it) {
            return it && it.kind === 'message';
        });
        var mergedSlots = trimSlotsByTime((online.slotItems || []).concat(offlineMsgs), limit);
        var aps = apStore();
        var contactId = resolveContactIdFromInput(chatId, contact);
        var offlineSummaries = aps ? buildOfflineSummaryBlocks(aps.exportForMemory(chatId, contactId)) : [];
        var summaryBlocks = (online.summaryBlocks || []).concat(offlineSummaries);
        return {
            slotItems: mergedSlots,
            summaryBlocks: summaryBlocks
        };
    }

    /**
     * 把 summaryBlocks 转成 API system 消息。
     *
     * 必须走这里而不是 buildSummaryBlocksText：后者只把各块正文拼成
     * 一段裸文本，块头里的「【线下场景总结 · 会话xxx · 第a–b条】」会被丢掉，
     * 连带把「这是本场已经发生过的剧情总结、不是待接的新消息」这个定位也丢了。
     *
     * ── 为什么要按 channel 打来源前缀 ──
     * 「记忆档案」里的总结有两个互不相干的来源：
     *   offline ← session.summaryList      线下卷宗自己的总结
     *   online  ← chatSettings.summaryList 线上「记忆功能」的沉淀总结
     *
     * 两者是**两套独立存储**：删掉一个线下卷宗，只会清掉 offline 那份，
     * 线上那份原封不动。而线下剧情总结在生成时往往会被同时写进线上记忆，
     * 于是用户会遇到一个看似见鬼的现象 ——
     *   删掉卷宗 → 卷宗列表空了、记忆表格也空了 →
     *   线下思维链里却还整段读得到当年卷宗里的内容。
     * 那不是删除失败，是线上那份同源副本仍在按设计生效。
     *
     * 光靠「有内容」无法区分这两者。加上来源前缀后，
     * 用户看到的记忆块就能自己说明它来自哪里，
     * 想彻底清干净时也知道该去哪一处删（记忆功能 / 记忆表格里删对应总结）。
     */
    function summarizeBlocksToApiText(blocks) {
        var ordered = (blocks || [])
            .slice()
            .sort(function (a, b) {
                return (a.orderKey || a.ts || 0) - (b.orderKey || b.ts || 0);
            })
            .map(function (b) {
                var body = String((b && b.content) || '').trim();
                if (!body) return '';
                if (String((b && b.channel) || '') === 'online') {
                    return '【线上记忆-' + String(b.kind || 'summary') + '】\n' + body;
                }
                return body;
            })
            .filter(Boolean);
        if (!ordered.length) return '';
        return [
            '【对话历史记忆·总结】',
            '以下为线上与线下历史的压缩总结，请结合使用。',
            '注意：这些是「已经发生过的事」，不是当前待接的新消息，请勿当作本轮要回应的内容。',
            '',
            ordered.join('\n\n')
        ].join('\n');
    }

    function slotsToApiMessages(slotItems) {
        var out = [];
        (slotItems || []).forEach(function (it) {
            if (!it || !String(it.content || '').trim()) return;
            if (it.kind === 'summary' || it.kind === 'summary_bundle') {
                out.push({ role: 'system', content: String(it.content) });
                return;
            }
            var role = it.role === 'assistant' ? 'assistant' : 'user';
            out.push({ role: role, content: String(it.content) });
        });
        return out;
    }

    function buildCrossMemorySystemBlock(slotItems) {
        var lines = (slotItems || [])
            .slice()
            .sort(function (a, b) {
                return (a.orderKey || a.ts || 0) - (b.orderKey || b.ts || 0);
            })
            .map(function (it) {
                return String(it.content || '').trim();
            })
            .filter(Boolean);
        if (!lines.length) return '';
        return (
            '【跨场景记忆·按本地时间线】\n' +
            '以下为线上/线下互通的记忆片段（不含当前界面未展示的正文），请与上下文衔接，勿重复啰嗦。\n\n' +
            lines.join('\n\n')
        );
    }

    function buildSummaryBlocksText(blocks) {
        return (blocks || [])
            .slice()
            .sort(function (a, b) {
                return (a.orderKey || a.ts || 0) - (b.orderKey || b.ts || 0);
            })
            .map(function (b) {
                return String(b.content || '').trim();
            })
            .filter(Boolean)
            .join('\n\n');
    }

    function buildMemoryInteropPreambleBlock(mode) {
        var isOnline = String(mode || 'offline') === 'online';
        var tailLine = isOnline
            ? '重要：当前任务仍是「线上即时聊天」。记忆片段只供知晓背景，正文仍须严格按【线上格式规则】逐行输出气泡，禁止把本轮回复写成线下剧情叙事段落，禁止大段无分行的旁白/叙事正文。'
            : '重要：当前任务是「线下剧情叙事」。记忆片段只供知晓背景，禁止用「〔时间·线上〕角色名：」格式继续写线上聊天，禁止把本场写成即时通讯对话流。';
        return (
            '【线上线下记忆互通·必读】\n' +
            '以下内容为同一角色与用户之间已真实发生的剧情（含线上聊天与往期/其它场线下场景），按本地时间线整理。\n' +
            '你必须完全知晓并自然衔接，禁止表示不知情、没发生过、失忆、或「我们只在线上聊过/只在线下见过」等割裂说法。\n' +
            '若下文含「记忆总结」与「线上/线下」片段，须一并消化，不得只读其中一部分。\n' +
            tailLine
        );
    }

    function injectCrossMemoryToApiMessages(apiMessages, slotItems, sceneLabel) {
        if (!apiMessages) return;
        var label = String(sceneLabel || '跨场景').trim();
        var items = slotItems || [];
        if (!items.length) return;
        /* 一律以 system 文本注入，禁止用 user/assistant 角色，避免模型把线上记录当成当前对话继续写气泡 */
        var block = buildCrossMemorySystemBlock(items);
        if (!block) return;
        apiMessages.push({
            role: 'system',
            content:
                '【' +
                label +
                '·记忆档案·只读】\n' +
                '以下是「' +
                label +
                '」相关的过往记忆摘要（不是本场正在发生的线下剧情，也不是要你继续接的聊天记录）。\n' +
                '你必须知晓并自然衔接，但禁止复述成「〔时间·线上〕角色：」气泡格式，禁止用线上即时聊天口吻接话。\n\n' +
                block
        });
    }

    /** 线下 API：总结 + 时间线片段，带统一必读头 */
    function injectAppointmentCrossMemory(apiMessages, cross) {
        if (!apiMessages || !cross) return;
        var sumText = String(cross.summaryText || '').trim();
        var items = cross.slotItems || [];
        if (!sumText && !items.length) return;
        apiMessages.push({ role: 'system', content: buildMemoryInteropPreambleBlock('offline') });
        if (sumText) {
            /*
             * 总结已经带着自己的抬头，此处不再套一层 —— 原文案写成
             * 「【对话历史记忆·总结】\n以下为线上与线下历史的压缩总结…」，
             * 但 line 263 的 buildWorldbookContextText 会把这段文本
             * **原样**丢进世界书的检测上下文里。那层壳在上下文匹配里被当成
             * 「一条需要回应的消息」读，模型于是顺着总结里的旧剧情往下续，
             * 表现为「线下开场沿用早已删掉的往期剧情」。抬头只留一次，
             * 并明确标注这是历史而非待接内容。
             */
            apiMessages.push({ role: 'system', content: sumText });
        }
        if (items.length) {
            injectCrossMemoryToApiMessages(apiMessages, items, '线上及往期线下');
        }
    }

    var memory = {
        resolveCanonicalChatId: resolveCanonicalChatId,
        resolveContactId: resolveContactId,
        collectOnlineSlots: collectOnlineSlots,
        collectOfflineSlotsForOnline: collectOfflineSlotsForOnline,
        collectOfflineCrossForAppointment: collectOfflineCrossForAppointment,
        buildOnlineSummaryBlocks: buildOnlineSummaryBlocks,
        buildOfflineSummaryBlocks: buildOfflineSummaryBlocks,
        slotsToApiMessages: slotsToApiMessages,
        buildCrossMemorySystemBlock: buildCrossMemorySystemBlock,
        buildSummaryBlocksText: buildSummaryBlocksText,
        summarizeBlocksToApiText: summarizeBlocksToApiText,
        injectCrossMemoryToApiMessages: injectCrossMemoryToApiMessages,
        buildMemoryInteropPreambleBlock: buildMemoryInteropPreambleBlock,
        injectAppointmentCrossMemory: injectAppointmentCrossMemory,
        buildOfflineMirrorFilterContext: buildOfflineMirrorFilterContext,
        shouldKeepOfflineMirror: shouldKeepOfflineMirror,
        filterOfflineMirrorsForApiHistory: filterOfflineMirrorsForApiHistory,
        messageIndexCovered: messageIndexCovered,

        /** 线上 buildApiMessages 用：注入线下记忆。opts.sessionId 可选，用于显式排除本场 */
        buildOnlineCrossMemory: function (chatId, contact, profile, settings, opts) {
            var memoryCount =
                settings && settings.memoryCount ? clampInt(settings.memoryCount, 1, 500, 40) : 40;
            var pack = collectOfflineSlotsForOnline(chatId, contact, profile, memoryCount, opts);
            return {
                systemBlock: buildCrossMemorySystemBlock(pack.slotItems),
                slotItems: pack.slotItems
            };
        },

        /** 线下 buildApiMessages 用。opts.sessionId = 当前场次，用于把本场内容排除在「跨场景记忆」之外 */
        buildAppointmentCrossMemory: function (chatId, contact, profile, settings, opts) {
            var memoryCount =
                settings && settings.memoryCount ? clampInt(settings.memoryCount, 1, 500, 40) : 40;
            var pack = collectOfflineCrossForAppointment(chatId, contact, profile, settings, memoryCount, opts);
            var summaryText = summarizeBlocksToApiText(pack.summaryBlocks);
            var slotBlock = buildCrossMemorySystemBlock(pack.slotItems);
            return {
                summaryText: summaryText,
                slotBlock: slotBlock,
                summaryBlocks: pack.summaryBlocks,
                slotItems: pack.slotItems
            };
        }
    };

    global.MiyaAppointmentMemory = memory;
})(window);
