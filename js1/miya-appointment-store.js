(function (global) {
    'use strict';

    var LS_KEY = 'miya-appointment-v1';
    var LS_BACKUP_KEY = 'miya-appointment-v1-backup';
    var LEGACY_BUILTIN_PRESET_ID = '__ap_builtin_cool__';
    var DEFAULT_SUMMARY_PROMPT =
        '以时间线客观总结本段线下剧情，区分双方，保留关键情节、情绪转折与约定；100–280字，不要复述修辞。';

    var cache = null;
    var _hydrated = false;
    var _hydratePromise = null;
    var _lastRecoveryInfo = null;
    var _saveTimer = 0;
    var _dirtyBeforeHydrate = false;
    var SAVE_DEBOUNCE_MS = 280;

    function uid(prefix) {
        return (prefix || 'ap') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function clampInt(v, lo, hi, fb) {
        var n = parseInt(v, 10);
        if (!Number.isFinite(n)) return fb;
        return Math.min(hi, Math.max(lo, n));
    }

    function defaultContactParams() {
        return {
            summaryTrigger: 15,
            summaryPrompt: DEFAULT_SUMMARY_PROMPT,
            showThinking: true,
            enterToSend: true,
            textDecor: true,
            updatedAt: Date.now()
        };
    }

    function defaultBeautify() {
        return {
            themeId: 'museum',
            customCss: ''
        };
    }

    function defaultStatusBar() {
        return {
            enabled: true,
            presetName: ''
        };
    }

    function normalizeStatusBar(raw) {
        var d = defaultStatusBar();
        if (!raw || typeof raw !== 'object') return Object.assign({}, d);
        /* fabIconUrl 随悬浮球功能一并移除，不再读取也不再写回。
           历史数据里残留的该字段会在下次保存时自然消失。 */
        return {
            enabled: raw.enabled !== false,
            presetName: String(raw.presetName || '').trim()
        };
    }

    function normalizeCastMember(row) {
        if (!row || typeof row !== 'object') return null;
        var contactId = String(row.contactId || '').trim();
        var chatId = String(row.chatId || '').trim();
        if (!contactId) return null;
        return { contactId: contactId, chatId: chatId };
    }

    function normalizeCast(raw, fallbackContactId, fallbackChatId) {
        var list = Array.isArray(raw)
            ? raw.map(normalizeCastMember).filter(Boolean)
            : [];
        if (!list.length && fallbackContactId) {
            list = [
                {
                    contactId: String(fallbackContactId).trim(),
                    chatId: String(fallbackChatId || '').trim()
                }
            ];
        }
        /* 同一 contactId 出现多条时不能整条丢弃 —— 那会让 mirrorMessageToCast 漏掉目标
           （多面具 / 多线程场景：同一角色在多个 chat 里各有一条 cast 记录）。
           改为按 contactId 合并：优先保留带 chatId 的那条作为镜像目标，
           若两条都没有 chatId，则保留先出现的一条。 */
        var indexOf = Object.create(null);
        var merged = [];
        list.forEach(function (row) {
            if (!row || !row.contactId) return;
            var key = row.contactId;
            var hit = indexOf[key];
            if (hit == null) {
                indexOf[key] = merged.length;
                merged.push({ contactId: row.contactId, chatId: row.chatId });
                return;
            }
            var cur = merged[hit];
            if (!cur.chatId && row.chatId) {
                cur.chatId = row.chatId;
            }
        });
        return merged;
    }

    function normalizeCastMirrors(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var out = {};
        Object.keys(raw).forEach(function (k) {
            var mid = String(raw[k] || '').trim();
            if (mid) out[String(k)] = mid;
        });
        return Object.keys(out).length ? out : null;
    }

    function normalizeStatusLogEntry(row) {
        if (!row || typeof row !== 'object') return null;
        var fields = row.fields && typeof row.fields === 'object' ? row.fields : {};
        var out = {
            contactId: String(row.contactId || '').trim(),
            roleName: String(row.roleName || '').trim(),
            mode: row.mode === 'custom' ? 'custom' : 'builtin',
            fields: fields,
            updatedAt: Number(row.updatedAt) || Date.now()
        };
        if (row.presetName) out.presetName = String(row.presetName || '').trim();
        if (row.htmlTemplate) out.htmlTemplate = String(row.htmlTemplate || '');
        return out;
    }

    function normalizeStatusLogRound(row) {
        if (!row || typeof row !== 'object') return null;
        var entries = Array.isArray(row.entries)
            ? row.entries.map(normalizeStatusLogEntry).filter(Boolean)
            : [];
        if (!entries.length) return null;
        return {
            updatedAt: Number(row.updatedAt) || Date.now(),
            entries: entries
        };
    }

    function normalizeThemeId(rawId, fallback) {
        var id = String(rawId || fallback || 'museum');
        if (id === 'ins') id = 'korean';
        if (id === 'gufeng') id = 'museum';
        if (['museum', 'korean', 'custom'].indexOf(id) >= 0) return id;
        return fallback || 'museum';
    }

    function normalizeBeautify(raw) {
        var d = defaultBeautify();
        if (!raw || typeof raw !== 'object') return Object.assign({}, d);
        /* wallpaperMode / wallpaperId / wallpaperUrl 随「线下壁纸」功能一并移除，
           不再读取也不再写回。历史数据里残留的这三个字段会在下次保存时自然消失。 */
        return {
            themeId: normalizeThemeId(raw.themeId, d.themeId),
            customCss: String(raw.customCss || '')
        };
    }

    function defaultState() {
        return {
            version: 1,
            presets: [],
            contactPresetId: {},
            contactParams: {},
            contactWorldbook: {},
            contactOpeningPresets: {},
            savedParamPresets: [],
            beautify: defaultBeautify(),
            statusBar: defaultStatusBar(),
            byChat: {},
            /** 用户手动删除的卷宗 id → 删除时间；双保险，防止残留镜像把已删剧情复活 */
            deletedSessionIds: {}
        };
    }

    /* 墓碑保留窗口：超过该时长的墓碑视为不再必要。
       理由：镜像恢复只可能「复活」仍存在镜像消息的卷宗，而镜像会随线上消息一起被清理；
       墓碑的作用是跨重启兜住「删除已落盘、镜像尚未清理干净」的窄窗口，
       该窗口以分钟计，保留 30 天已远超必要，同时避免墓碑表无限膨胀。 */
    var TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    /* 墓碑条数硬上限：即便时间未到，也只保留最近 N 条，防止极端批量删除撑爆存储 */
    var TOMBSTONE_MAX = 500;

    /** 淘汰过期 / 超量的墓碑。keep(可选) 为额外的保护集合，永不淘汰。 */
    function pruneDeletedSessionIds(map, keep) {
        var rows = [];
        Object.keys(map || {}).forEach(function (sid) {
            var ts = Number(map[sid]) || 0;
            rows.push({ id: sid, ts: ts });
        });
        var guard = keep && typeof keep === 'object' ? keep : null;
        var now = Date.now();
        // 先按时间淘汰
        rows = rows.filter(function (r) {
            if (guard && guard[r.id]) return true;
            return now - r.ts <= TOMBSTONE_TTL_MS;
        });
        // 再按条数淘汰（保留最新的）
        if (rows.length > TOMBSTONE_MAX) {
            rows.sort(function (a, b) {
                return b.ts - a.ts;
            });
            var kept = [];
            var keptGuarded = 0;
            var out = {};
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var isGuarded = !!(guard && guard[r.id]);
                if (isGuarded) {
                    keptGuarded += 1;
                    out[r.id] = r.ts;
                    continue;
                }
                if (kept.length + keptGuarded >= TOMBSTONE_MAX) continue;
                kept.push(r);
                out[r.id] = r.ts;
            }
            return out;
        }
        var result = {};
        rows.forEach(function (r) {
            result[r.id] = r.ts;
        });
        return result;
    }

    function normalizeDeletedSessionIds(raw) {
        var out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(function (k) {
            var sid = String(k || '').trim();
            if (!sid) return;
            var ts = Number(raw[k]);
            out[sid] = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
        });
        return pruneDeletedSessionIds(out);
    }

    function isSessionTombstoned(sessionId) {
        var sid = String(sessionId || '').trim();
        if (!sid) return false;
        var map = (cache && cache.deletedSessionIds) || {};
        return !!map[sid];
    }

    function markSessionTombstone(sessionId) {
        var sid = String(sessionId || '').trim();
        if (!sid) return;
        load();
        if (!cache.deletedSessionIds || typeof cache.deletedSessionIds !== 'object') {
            cache.deletedSessionIds = {};
        }
        cache.deletedSessionIds[sid] = Date.now();
        /* 顺手淘汰：刚写入的这条必须保住，否则墓碑会当场失效 */
        var guard = {};
        guard[sid] = true;
        cache.deletedSessionIds = pruneDeletedSessionIds(cache.deletedSessionIds, guard);
    }

    function normalizeOpeningPreset(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var content = String(raw.content || '').trim();
        if (!content) return null;
        return {
            id: String(raw.id || '').trim() || uid('aop'),
            name: String(raw.name || '').trim() || '开场白',
            content: content,
            updatedAt: Number(raw.updatedAt) || Date.now()
        };
    }

    function normalizeContactParams(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var d = defaultContactParams();
        return {
            summaryTrigger: clampInt(raw.summaryTrigger, 0, 500, d.summaryTrigger),
            summaryPrompt: String(raw.summaryPrompt || '').trim() || d.summaryPrompt,
            showThinking: raw.showThinking !== false,
            enterToSend: raw.enterToSend !== false,
            textDecor: raw.textDecor !== false,
            updatedAt: Number(raw.updatedAt) || Date.now()
        };
    }

    function normalizeSavedParamPreset(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var params = normalizeContactParams(raw);
        if (!params) return null;
        return Object.assign({}, params, {
            id: String(raw.id || '').trim() || uid('apsp'),
            name: String(raw.name || '').trim() || '未命名预设',
            updatedAt: Number(raw.updatedAt) || Date.now()
        });
    }

    function normalizeBindings(raw) {
        if (!Array.isArray(raw)) return [];
        return raw
            .map(function (row, i) {
                if (!row || typeof row !== 'object') return null;
                var entryId = String(row.entryId || row.id || '').trim();
                if (!entryId) return null;
                return {
                    entryId: entryId,
                    order: clampInt(row.order, 0, 9999, i)
                };
            })
            .filter(Boolean)
            .sort(function (a, b) {
                return a.order - b.order;
            });
    }

    function normalizePreset(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var id = String(raw.id || '').trim() || uid('preset');
        if (id === LEGACY_BUILTIN_PRESET_ID) return null;
        var params = normalizeContactParams(raw) || defaultContactParams();
        return Object.assign({}, params, {
            id: id,
            name: String(raw.name || '').trim() || '未命名预设',
            builtin: false,
            // 旧参数预设可能还带这些字段：继续保存，避免升级时破坏已有数据；
            // appointment-engine 已不再读取它们作为输出硬规则。
            outputWordCount: raw.outputWordCount,
            styleGuide: String(raw.styleGuide || '').trim(),
            rolePerson: ['first', 'second', 'third'].indexOf(raw.rolePerson) >= 0 ? raw.rolePerson : undefined,
            userPerson: ['first', 'second', 'third'].indexOf(raw.userPerson) >= 0 ? raw.userPerson : undefined,
            worldbookBindings: normalizeBindings(raw.worldbookBindings),
            updatedAt: Number(raw.updatedAt) || Date.now()
        });
    }

    function normalizeSummary(row, i) {
        if (!row || typeof row !== 'object') return null;
        var id = String(row.id || '').trim() || uid('sum');
        return {
            id: id,
            content: String(row.content || '').trim(),
            startIndex: clampInt(row.startIndex, 0, 999999, 0),
            endIndex: clampInt(row.endIndex, 0, 999999, 0),
            createdAt: Number(row.createdAt) || Date.now()
        };
    }

    function normalizeMessage(row) {
        if (!row || typeof row !== 'object') return null;
        var role = row.role === 'assistant' ? 'assistant' : row.role === 'system' ? 'system' : 'user';
        var out = {
            id: String(row.id || '').trim() || uid('msg'),
            role: role,
            content: String(row.content || '').trim(),
            createdAt: Number(row.createdAt) || Date.now(),
            deleted: !!row.deleted,
            hidden: !!row.hidden,
            editedAt: Number(row.editedAt) || 0
        };
        /*
         * 该楼层被「刷新 / 重回」重答过的累计次数。
         *
         * ⚠️ 为什么必须单独存一个字段、而不能从 swipes.length 推：
         *   刷新键（不保留旧版）走 deleteMessage 并显式传 { swipes: [] }，
         *   候选表被清空 → swipes.length 恒为 0。早先 attempt 就取
         *   floorSwipeCount（= swipes.length），于是**每次刷新 attempt 都被
         *   重置回 1**，引擎那句「这是同一提问的第 N 次重答，请比上一次差异
         *   更明显」永远发不出去（见 buildRegenerateHintBlock 的 n > 1 分支）。
         *   模型每轮收到的输入完全相同，输出自然高度雷同 —— 这正是
         *   「刷新又生成一模一样内容」的根因。
         *   此字段与候选表解耦，只在重答成功后自增，清空 swipes 不影响它。
         */
        if (Number.isFinite(Number(row.regenCount)) && Number(row.regenCount) > 0) {
            out.regenCount = Math.floor(Number(row.regenCount));
        }
        if (row.chatMirrorId) out.chatMirrorId = String(row.chatMirrorId).trim();
        var thinking = String(row.thinking || '').trim();
        if (thinking) out.thinking = thinking;
        if (row.renderAsHtml) {
            out.renderAsHtml = true;
            if (row.htmlRaw) out.htmlRaw = String(row.htmlRaw || '').trim();
        }
        if (row.type) out.type = String(row.type || '').trim();
        /*
         * 角色状态栏：字段数组随消息一起落库（与线上 MiyaChatStore 同构）。
         * 存解析结果而不是原始 <STATUSBAR_DATA> 文本，渲染层就不必重复解析，
         * 也不受模型换标签名的影响。
         */
        if (row.statusBar && typeof row.statusBar === 'object' && Array.isArray(row.statusBar.fields)) {
            var sbFields = row.statusBar.fields
                .map(function (f) {
                    if (!f || typeof f !== 'object') return null;
                    var n = String(f.name || '').trim();
                    if (!n) return null;
                    return {
                        name: n.slice(0, 40),
                        value: String(f.value == null ? '' : f.value).slice(0, 800)
                    };
                })
                .filter(Boolean)
                .slice(0, 40);
            if (sbFields.length) {
                out.statusBar = { fields: sbFields, tag: String(row.statusBar.tag || '').trim() };
            }
        }
        if (row.openingPresetId) out.openingPresetId = String(row.openingPresetId || '').trim();
        var castMirrors = normalizeCastMirrors(row.castMirrors);
        if (castMirrors) out.castMirrors = castMirrors;
        /*
         * 线下楼层 Swipe 候选。
         *
         * ⚠️ 这里必须区分「没传 swipes」和「传了个空数组」——
         * 两者语义完全相反，早先只用 `row.swipes.length` 一个条件判，
         * 把它们混成了一种：
         *
         *   · 没传（undefined/null）→ 「这次别动候选表」，沿用旧值。
         *     这是绝大多数 patch 的形态（改 content、改 hidden…），
         *     绝不能顺手把候选清掉。
         *
         *   · 传了空数组           → 「候选全部作废」，显式清空。
         *     这是「删除键旁边的刷新键」那条路径要的行为：用户说了
         *     不保留这一版，翻 ‹ 就不该还能翻出来。
         *
         * 旧写法下空数组因为 length 为 0 被跳过，Object.assign 于是保留
         * 了**旧候选表** —— 表现就是「点了不保留的刷新，旧版本还挂在
         * 候选里」，和用户的要求正好相反。所以这里按「传没传」而不是
         * 「长不长」来分流。
         */
        if (Array.isArray(row.swipes)) {
            if (row.swipes.length) {
                out.swipes = row.swipes.map(function (x) { return String(x == null ? '' : x); });
                var sid = Number(row.swipeId);
                out.swipeId = Number.isFinite(sid)
                    ? Math.max(0, Math.min(out.swipes.length - 1, Math.floor(sid)))
                    : out.swipes.length - 1;
                /*
                 * 候选各自的「待落库记忆标记」，与 swipes 一一对齐。
                 *
                 * 候选表存的是各版剥离后的正文，剥离后就再也解析不出
                 * 「这一版原本要写什么记忆」（见下面 mtRaw 的说明）。
                 * 用户可能翻 ‹ 回到第 1 版再确认 —— 那时要写的是第 1 版的
                 * 记忆，不是最新那版的。所以标记必须**按候选分别保存**，
                 * 只留一份「当前版」的标记是不够的。
                 *
                 * 长度以 swipes 为准：短了补空串、长了截断，
                 * 保证 swipeMtRaw[swipeId] 恒等于当前显示那一版的标记。
                 */
                if (Array.isArray(row.swipeMtRaw)) {
                    out.swipeMtRaw = out.swipes.map(function (_x, i) {
                        return String(row.swipeMtRaw[i] == null ? '' : row.swipeMtRaw[i]);
                    });
                }
            } else {
                /* 显式清空：候选表归零，当前版就是唯一一版（swipeId 0） */
                out.swipes = [];
                out.swipeId = 0;
                out.swipeMtRaw = [];
            }
        }
        /*
         * 记忆表待落库的原始标记（线下候选专用）。
         *
         * 为什么需要这个字段
         * ──────────────────
         * 线下生成时，正文里的 <tableEdit> 必须在**解析正文之前**就剥掉，
         * 否则标签会顺着 content 写进楼层，下一轮又被当历史送回，模型照着模仿。
         * 但剥离之后就再也解析不出「这一版原本要写什么记忆」了。
         *
         * 而候选还悬着时我们**故意不落库**（见引擎的
         * shouldDeferMemoryForPendingSwipe）—— 等用户选定那一版再补写。
         * 补写总得知道原文，所以剥离时顺手把原始标记留在这里。
         *
         * 这个字段记的是**当前显示那一版**的标记（随 swipeId 切换而更新）；
         * 各候选各自的标记在 swipeMtRaw 里按序号并存。
         *
         * 只在「有标记」时才写这个字段，普通楼层不会多出一个空键。
         * 一旦落库成功（commitConfirmedFloor），调用方会传 mtRaw: ''
         * 把它清掉，避免同一段标记被重复应用。
         */
        if (row.mtRaw && String(row.mtRaw).trim()) {
            out.mtRaw = String(row.mtRaw);
        }
        /*
         * 剧情走向建议（线下正文底部那张卡的数据源）。
         *
         * 与 swipes 同样按「传没传」分流：
         *   · 没传（undefined）→ 不动这个字段，沿用旧值。
         *     普通 patch（改 hidden、改 content）不该顺手把建议抹掉。
         *   · 传了数组        → 以本次为准，空数组即「清空建议」。
         *
         * 空数组必须能生效：模型某轮没吐 <plot> 时引擎会显式传 []，
         * 若被当成「没传」跳过，卡片就会挂着上一轮那批已经过期的选项 ——
         * 用户点了，模型接的是另一段剧情的台词。
         *
         * 长度和单条长度都在这里夹一次：数据可能来自导入的存档或
         * 手改过的 JSON，落库层是最后一道闸。上限与渲染模块保持一致
         * （MiyaOfflinePlot.MAX_ITEMS / MAX_ITEM_LEN），但不直接依赖它 ——
         * 那个模块不在 store 的加载顺序保证范围内。
         */
        if (Array.isArray(row.plotHints)) {
            out.plotHints = row.plotHints
                .map(function (x) { return String(x == null ? '' : x).trim(); })
                .filter(Boolean)
                .slice(0, 6)
                .map(function (x) { return x.slice(0, 120); });
        }
        return out;
    }

    function isOpeningMessage(msg) {
        return !!(msg && msg.role === 'system' && msg.type === 'opening');
    }

    /**
     * 同一个 id 只保留一行（保留靠后的那条 —— 它更接近当前状态）。
     *
     * 为什么需要：旧版 restoreMessageSnapshot 用 addMessage 还原被软删的楼层，
     * 而 addMessage 是 push，于是数组里出现「同 id 两行」：一条 deleted 的死行
     * 加一条活行。后续所有按 id 的查找/删除都会歧义，且每存一次盘就多占一份体积。
     * 读盘时统一压实，让内存里始终保持「一个 id 一行」。
     */
    function dedupeMessagesById(list) {
        var arr = Array.isArray(list) ? list : [];
        if (arr.length < 2) return arr;
        var seen = Object.create(null);
        var dup = false;
        for (var i = 0; i < arr.length; i++) {
            var id = arr[i] && arr[i].id;
            if (id && seen[id]) { dup = true; break; }
            if (id) seen[id] = true;
        }
        if (!dup) return arr;
        var keep = Object.create(null);
        var out = [];
        for (var j = arr.length - 1; j >= 0; j--) {
            var m = arr[j];
            var mid = m && m.id;
            if (!m || !mid || keep[mid]) continue;
            keep[mid] = true;
            out.push(m);
        }
        out.reverse();
        return out;
    }

    /** 目标线程上是否仍有可用线下镜像（含已删除判定；不可用 getMessages，因其会滤掉 offlineMeet） */
    function liveMirrorOnChat(st, chatId, mirrorId) {
        var mid = String(mirrorId || '').trim();
        if (!st || !chatId || !mid) return null;
        var arr =
            st.getMessagesForApi && typeof st.getMessagesForApi === 'function'
                ? st.getMessagesForApi(chatId)
                : null;
        if (!Array.isArray(arr)) return null;
        for (var i = 0; i < arr.length; i++) {
            var m = arr[i];
            if (m && !m.deleted && String(m.id) === mid && m.offlineMeet) return m;
        }
        return null;
    }

    function mirrorMessageToChat(chatId, sess, msg, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var deferWrite = !!opts.deferSessionWrite;
        var knownMirrors = opts.knownMirrors || null;
        var targetChatId = String(opts.targetChatId || chatId || '').trim();
        var primaryChatId = String((sess && sess.chatId) || chatId || '').trim();
        var st = global.miyaChatStore;
        if (!st || !msg || msg.deleted || isOpeningMessage(msg)) return;
        if (!String(msg.content || '').trim()) return;
        if (!targetChatId) return;
        var existingMirrorId = getMirrorIdForChat(msg, targetChatId, primaryChatId);
        /* chatMirrorId 可能指向已丢线程/被 IDB 恢复冲掉的旧 id，必须校验目标 chat 上是否仍活着 */
        if (existingMirrorId) {
            if (knownMirrors && knownMirrors[existingMirrorId]) return;
            if (!knownMirrors && liveMirrorOnChat(st, targetChatId, existingMirrorId)) return;
            if (msg.castMirrors && msg.castMirrors[targetChatId]) delete msg.castMirrors[targetChatId];
            if (targetChatId === primaryChatId) msg.chatMirrorId = '';
        }
        if (typeof st.findMirrorByAppointmentMsgId === 'function') {
            var existing = st.findMirrorByAppointmentMsgId(targetChatId, msg.id);
            if (existing && existing.id && !existing.deleted) {
                setMirrorIdForChat(msg, targetChatId, existing.id, primaryChatId);
                if (knownMirrors) knownMirrors[existing.id] = existing;
                if (!deferWrite) store._writeSession(sess);
                return;
            }
        }
        var row = null;
        if (typeof st.mirrorOfflineMessage === 'function') {
            row = st.mirrorOfflineMessage(targetChatId, {
                role: msg.role,
                content: msg.content,
                createdAt: msg.createdAt || Date.now(),
                appointmentSessionId: sess.id,
                appointmentMsgId: msg.id,
                renderAsHtml: !!msg.renderAsHtml,
                htmlRaw: msg.htmlRaw || msg.content,
                type: msg.renderAsHtml ? 'html' : undefined
            });
        } else if (st.addMessage) {
            st.addMessage(targetChatId, {
                role: msg.role,
                content: msg.content,
                createdAt: msg.createdAt || Date.now(),
                offlineMeet: true,
                renderAsHtml: !!msg.renderAsHtml,
                htmlRaw: msg.htmlRaw || msg.content,
                type: msg.renderAsHtml ? 'html' : 'text',
                appointmentSessionId: sess.id,
                appointmentMsgId: msg.id
            })
                .then(function (r) {
                    if (!r || !r.id) return;
                    setMirrorIdForChat(msg, targetChatId, r.id, primaryChatId);
                    store._writeSession(sess);
                })
                .catch(function () {});
            return;
        }
        if (row && row.id) {
            setMirrorIdForChat(msg, targetChatId, row.id, primaryChatId);
            if (knownMirrors) knownMirrors[row.id] = row;
            if (!deferWrite) store._writeSession(sess);
        }
    }

    function mirrorMessageToCast(sess, msg, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var targets = sessionCastTargets(sess);
        if (!targets.length && sess && sess.chatId) {
            targets = [{ contactId: sess.contactId, chatId: sess.chatId }];
        }
        targets.forEach(function (t) {
            var tid = String((t && t.chatId) || '').trim();
            if (!tid) return;
            mirrorMessageToChat(tid, sess, msg, Object.assign({}, opts, { targetChatId: tid }));
        });
    }

    function softDeleteChatMirror(st, chatId, mirrorId) {
        var tid = String(chatId || '').trim();
        var mid = String(mirrorId || '').trim();
        if (!st || !tid || !mid || typeof st.updateMessage !== 'function') return;
        /* 镜像删除失败不能静默吞：失败时记入待重试队列，随下次 flush 再试一次。
           否则"墓碑尚未落盘 + 镜像删除失败"叠加会导致已删卷宗被 mirror 复活。 */
        st.updateMessage(tid, mid, { deleted: true, content: '' }).catch(function () {
            _pendingMirrorDeletes.push({ chatId: tid, mirrorId: mid });
            scheduleMirrorRetry();
        });
    }

    var _pendingMirrorDeletes = [];
    var _mirrorRetryTimer = 0;

    /** 重试失败的镜像删除；仍失败则保留在队列，等下一次触发 */
    function retryPendingMirrorDeletes() {
        if (!_pendingMirrorDeletes.length) return;
        var st = global.miyaChatStore;
        if (!st || typeof st.updateMessage !== 'function') return;
        var queue = _pendingMirrorDeletes.slice();
        _pendingMirrorDeletes.length = 0;
        queue.forEach(function (job) {
            st.updateMessage(job.chatId, job.mirrorId, { deleted: true, content: '' }).catch(function () {
                _pendingMirrorDeletes.push(job);
            });
        });
    }

    function scheduleMirrorRetry() {
        if (_mirrorRetryTimer) return;
        _mirrorRetryTimer = setTimeout(function () {
            _mirrorRetryTimer = 0;
            retryPendingMirrorDeletes();
        }, 1200);
    }

    /** 彻底删除某卷宗在线上的镜像：不再注入 API / 不再被镜像恢复 */
    function purgeSessionOnlineMirrors(sess) {
        if (!sess || !sess.id) return;
        var st = global.miyaChatStore;
        if (!st) return;
        var sid = String(sess.id).trim();
        var primary = String(sess.chatId || '').trim();
        var touched = Object.create(null);

        function mark(tid, mid) {
            var t = String(tid || '').trim();
            var m = String(mid || '').trim();
            if (!t || !m) return;
            var key = t + '\0' + m;
            if (touched[key]) return;
            touched[key] = true;
            softDeleteChatMirror(st, t, m);
        }

        /*
         * 第一路：卷宗自己的消息上记着镜像 id（chatMirrorId / castMirrors）。
         * 精确、便宜，但有前提 —— 卷宗对象必须是**真正那一份**。
         * deleteSession 在宿主桶找不到时会退化成 {messages: []} 的空壳，
         * 这一路就什么都点不到，全靠下面的第二路兜底。
         */
        (sess.messages || []).forEach(function (msg) {
            if (!msg) return;
            if (msg.chatMirrorId) mark(primary, msg.chatMirrorId);
            if (msg.castMirrors && typeof msg.castMirrors === 'object') {
                Object.keys(msg.castMirrors).forEach(function (tid) {
                    mark(tid, msg.castMirrors[tid]);
                });
            }
        });

        /*
         * 第二路：全库扫镜像，按 appointmentSessionId 认领。
         *
         * 这是删除能否清干净的关键。镜像散布在「主线程 + 每个 cast 成员的私聊」
         * 多条线程上，只靠第一路（需要卷宗对象完好）不够。
         *
         * 口径放宽的缘由：appointmentSessionId 在某些历史数据里可能缺失或被
         * 迁移改写过，一旦不等就永远扫不到，镜像便以 deleted:false 存活，
         * 而 recoverSessionsFromChatMirrors 又能凭这些存活镜像把**已删卷宗
         * 整卷复活** —— 表现就是「删过的卷宗过一阵又回来了」。
         * 因此这里额外接受「appointmentMsgId 命中本卷宗消息 id」的镜像。
         */
        var meta = typeof st.getMeta === 'function' ? st.getMeta() : null;
        var messagesByChat = meta && meta.messagesByChat;
        if (!messagesByChat || typeof messagesByChat !== 'object') return;

        /* 卷宗内所有消息 id，用于第二路补充匹配 */
        var ownMsgIds = Object.create(null);
        (sess.messages || []).forEach(function (msg) {
            if (msg && msg.id) ownMsgIds[String(msg.id)] = true;
        });

        Object.keys(messagesByChat).forEach(function (tid) {
            var arr = messagesByChat[tid] || [];
            for (var i = 0; i < arr.length; i++) {
                var m = arr[i];
                if (!m || m.deleted || !m.offlineMeet) continue;
                var hit = String(m.appointmentSessionId || '').trim() === sid;
                if (!hit) {
                    var apMid = String(m.appointmentMsgId || '').trim();
                    if (apMid && ownMsgIds[apMid]) hit = true;
                }
                if (!hit) continue;
                mark(tid, m.id);
            }
        });
    }

    function purgeMessageOnlineMirrors(chatId, msg) {
        if (!msg) return;
        var st = global.miyaChatStore;
        if (!st) return;
        var primary = String(chatId || '').trim();
        if (msg.chatMirrorId) softDeleteChatMirror(st, primary, msg.chatMirrorId);
        if (msg.castMirrors && typeof msg.castMirrors === 'object') {
            Object.keys(msg.castMirrors).forEach(function (tid) {
                softDeleteChatMirror(st, tid, msg.castMirrors[tid]);
            });
        }
    }

    /**
     * 删除线下楼层时，回收由该楼层写入的记忆表内容。
     *
     * ── 与线上版（miya-chat-store 的 purgeMemoryRowsBySource）的关系 ──
     * 两者调用的是同一个底层实现 MiyaMemoryTableStore.removeRowsBySource，
     * 差别只在**传什么 id**：
     *   · 线上：传聊天室消息 id（记忆表写入时记的来源就是它）
     *   · 线下：传线下会话消息 id（线下引擎回传的 result.message.id）
     *
     * 记忆表按 chatId 分桶，线上线下共用同一个桶 —— 所以这里**不需要**
     * 传 chatId，removeRowsBySource 会遍历所有桶按来源 id 回收。
     * 这是刻意设计：一条线下消息的镜像可能散落在多个线上线程
     *（主线 + castMirrors），而记忆行只认「线下消息 id」这一个坐标。
     *
     * 老数据没有溯源信息时底层会退化为「不回收」，不会误删。
     *
     * @param {string} messageId 线下会话消息 id
     */
    function purgeMemoryRowsBySource(messageId) {
        var mid = String(messageId || '').trim();
        if (!mid) return;
        var mts = global.MiyaMemoryTableStore;
        if (!mts || typeof mts.removeRowsBySource !== 'function') return;
        try {
            return mts.removeRowsBySource(null, [mid]).then(function (res) {
                var n = res && Number(res.removed) || 0;
                /* 只有真的删掉了行才提示，避免每删一条都弹（多数楼层没写过记忆） */
                if (n > 0) {
                    try {
                        if (global.miyaChatRoom && global.miyaChatRoom.toast) {
                            global.miyaChatRoom.toast('已同步回收 ' + n + ' 行记忆表内容');
                        }
                    } catch (eToast) {}
                }
                return n;
            }).catch(function () {
                /* 记忆回收失败不应阻断删除流程本身 */
                return 0;
            });
        } catch (e) {
            return Promise.resolve(0);
        }
    }

    /**
     * 把一条线下消息的最新内容同步到它在线上的全部镜像。
     *
     * 与 purgeMessageOnlineMirrors 成对：删除会清掉所有落点，编辑也应覆盖所有落点，
     * 否则多人场里只有主线镜像被更新，其余角色看到的仍是旧内容。
     * 枚举口径刻意与 purge 保持一致（主线 chatMirrorId + castMirrors 全量）。
     * 落点缺失或不合法时跳过，不抛错——镜像只是增强，不该阻断编辑本身。
     */
    function syncMessageToOnlineMirrors(chatId, msg) {
        if (!msg) return;
        /*
         * 已删除的消息绝不能走这里。
         * deleteMessage 的流程是「先 purgeMessageOnlineMirrors 软删镜像，再
         * updateMessage({deleted:true})」；若不拦住，本次同步会以 edited 的身份
         * 把刚删掉的镜像复活成空内容。删除语义一律由 purgeMessageOnlineMirrors 负责。
         */
        if (msg.deleted) return;
        var st = global.miyaChatStore;
        if (!st || typeof st.updateMessage !== 'function') return;
        var primary = String(chatId || '').trim();
        var content = String(msg.content || '');
        var touched = Object.create(null);

        function sync(tid, mid) {
            var t = String(tid || '').trim();
            var m = String(mid || '').trim();
            if (!t || !m) return;
            var key = t + '\0' + m;
            if (touched[key]) return;
            touched[key] = true;
            st.updateMessage(t, m, {
                content: content,
                edited: true,
                editedAt: Date.now()
            }).catch(function () {});
        }

        if (msg.chatMirrorId) sync(primary, msg.chatMirrorId);
        if (msg.castMirrors && typeof msg.castMirrors === 'object') {
            Object.keys(msg.castMirrors).forEach(function (tid) {
                sync(tid, msg.castMirrors[tid]);
            });
        }
    }

    function normalizeSession(raw) {
        if (!raw || typeof raw !== 'object') return null;
        /*
         * 读盘时顺手把重复 id 压实。
         *
         * 历史脏数据来自旧版 restoreMessageSnapshot：它用 addMessage 还原，
         * 会在数组末尾再 push 一条同 id 的行。这类数据一旦落盘就会一直存在，
         * 表现为「同一层出现两遍」+「点删除删不掉」（find 总是命中第一条死行）。
         * 在唯一的读盘入口收口，老用户一打开就自愈，不用手动清数据。
         * 保留靠后的那一条（更接近当前状态）。
         */
        var msgs = Array.isArray(raw.messages)
            ? dedupeMessagesById(raw.messages.map(normalizeMessage).filter(Boolean))
            : [];
        var sums = Array.isArray(raw.summaryList) ? raw.summaryList.map(normalizeSummary).filter(Boolean) : [];
        var chatId = String(raw.chatId || '').trim();
        var contactId = String(raw.contactId || '').trim();
        var cast = normalizeCast(raw.cast, contactId, chatId);
        var statusLog = Array.isArray(raw.statusLog)
            ? raw.statusLog.map(normalizeStatusLogRound).filter(Boolean)
            : [];
        return {
            id: String(raw.id || '').trim() || uid('sess'),
            chatId: chatId,
            contactId: contactId,
            cast: cast,
            createdAt: Number(raw.createdAt) || Date.now(),
            /*
             * 所有场次一律「可续写」——封存概念已整体移除。
             *
             * 历史数据里可能残留 closedAt 字段，归一化时统一压成 0，
             * 让旧数据也表现为可续写，不必让用户去做数据迁移。
             */
            closedAt: 0,
            title: String(raw.title || '').trim(),
            messages: msgs,
            summaryList: sums,
            statusLog: statusLog,
            parentSessionId: String(raw.parentSessionId || '').trim(),
            branchFromMessageId: String(raw.branchFromMessageId || '').trim(),
            branchFromFloor: clampInt(raw.branchFromFloor, 0, 999999, 0)
        };
    }

    function sessionCastTargets(sess) {
        var cast = normalizeCast(
            sess && sess.cast,
            sess && sess.contactId,
            sess && sess.chatId
        );
        if (cast.length) return cast;
        if (sess && sess.chatId) {
            return [{ contactId: String(sess.contactId || '').trim(), chatId: String(sess.chatId) }];
        }
        return [];
    }

    function getMirrorIdForChat(msg, targetChatId, primaryChatId) {
        var tid = String(targetChatId || '').trim();
        if (!msg || !tid) return '';
        if (msg.castMirrors && msg.castMirrors[tid]) return String(msg.castMirrors[tid]);
        if (tid === String(primaryChatId || '') && msg.chatMirrorId) return String(msg.chatMirrorId);
        return '';
    }

    function setMirrorIdForChat(msg, targetChatId, mirrorId, primaryChatId) {
        if (!msg) return;
        var tid = String(targetChatId || '').trim();
        var mid = String(mirrorId || '').trim();
        if (!tid || !mid) return;
        if (!msg.castMirrors) msg.castMirrors = {};
        msg.castMirrors[tid] = mid;
        if (tid === String(primaryChatId || '')) msg.chatMirrorId = mid;
    }

    function needsAsyncHydrate() {
        return !!(global.miyaKvKeyNeedsAsyncHydrate && global.miyaKvKeyNeedsAsyncHydrate(LS_KEY));
    }

    function stateRichness(state) {
        if (!state || typeof state !== 'object') return 0;
        return sessionDataRichness(state) + presetMetaRichness(state);
    }

    function sessionDataRichness(state) {
        if (!state || typeof state !== 'object') return 0;
        var n = 0;
        var byChat = state.byChat || {};
        Object.keys(byChat).forEach(function (chatId) {
            var bucket = byChat[chatId];
            if (!bucket || !Array.isArray(bucket.sessions)) return;
            bucket.sessions.forEach(function (sess) {
                n += countLiveMessages(sess);
                n += (sess.summaryList || []).length;
            });
        });
        return n;
    }

    function presetMetaRichness(state) {
        if (!state || typeof state !== 'object') return 0;
        var n = 0;
        n += (state.savedParamPresets || []).length * 3;
        n += ((state.presets || []).length || 0);
        n += Object.keys(state.contactParams || {}).length;
        n += Object.keys(state.contactOpeningPresets || {}).length * 2;
        return n;
    }

    function finalizeByChat(byChat) {
        var rowMap = byChat && typeof byChat === 'object' ? byChat : {};
        Object.keys(rowMap).forEach(function (chatId) {
            var row = rowMap[chatId];
            if (!row || typeof row !== 'object') {
                delete rowMap[chatId];
                return;
            }
            row.sessions = Array.isArray(row.sessions) ? row.sessions.map(normalizeSession).filter(Boolean) : [];
            row.activeSessionId = String(row.activeSessionId || '').trim();
            row.sessions = row.sessions.filter(function (s) {
                return countLiveMessages(s) > 0;
            });
            if (
                row.activeSessionId &&
                !row.sessions.some(function (s) {
                    return s.id === row.activeSessionId;
                })
            ) {
                row.activeSessionId = '';
            }
        });
        return rowMap;
    }

    function buildStateFromParsed(parsed) {
        var d = defaultState();
        var presetDirty = false;
        if (parsed && typeof parsed === 'object') {
            d.version = Number(parsed.version) || 1;
            var rawPresets = Array.isArray(parsed.presets) ? parsed.presets : [];
            if (rawPresets.some(function (p) { return p && String(p.id || '') === LEGACY_BUILTIN_PRESET_ID; })) {
                presetDirty = true;
            }
            d.presets = rawPresets.map(normalizePreset).filter(Boolean);
            d.contactPresetId =
                parsed.contactPresetId && typeof parsed.contactPresetId === 'object'
                    ? parsed.contactPresetId
                    : {};
            d.contactParams =
                parsed.contactParams && typeof parsed.contactParams === 'object'
                    ? parsed.contactParams
                    : {};
            d.contactWorldbook =
                parsed.contactWorldbook && typeof parsed.contactWorldbook === 'object'
                    ? parsed.contactWorldbook
                    : {};
            d.contactOpeningPresets =
                parsed.contactOpeningPresets && typeof parsed.contactOpeningPresets === 'object'
                    ? parsed.contactOpeningPresets
                    : {};
            d.savedParamPresets = Array.isArray(parsed.savedParamPresets)
                ? parsed.savedParamPresets.map(normalizeSavedParamPreset).filter(Boolean)
                : [];
            d.byChat = parsed.byChat && typeof parsed.byChat === 'object' ? parsed.byChat : {};
            d.beautify = normalizeBeautify(parsed.beautify);
            d.statusBar = normalizeStatusBar(parsed.statusBar);
            d.deletedSessionIds = normalizeDeletedSessionIds(parsed.deletedSessionIds);
        }
        d.byChat = finalizeByChat(d.byChat);
        return { state: d, presetDirty: presetDirty };
    }

    function filterTombstonedRecoveredByChat(byChat, tombstoneMap) {
        var tombs = tombstoneMap && typeof tombstoneMap === 'object' ? tombstoneMap : {};
        var out = {};
        var sessionCount = 0;
        var messageCount = 0;
        Object.keys(byChat || {}).forEach(function (chatId) {
            var src = byChat[chatId];
            if (!src || !Array.isArray(src.sessions)) return;
            var kept = src.sessions.filter(function (sess) {
                if (!sess || !sess.id) return false;
                if (tombs[String(sess.id)]) return false;
                return countLiveMessages(sess) > 0;
            });
            if (!kept.length) return;
            out[chatId] = {
                sessions: kept,
                activeSessionId: String(src.activeSessionId || '').trim()
            };
            kept.forEach(function (sess) {
                sessionCount += 1;
                messageCount += countLiveMessages(sess);
            });
        });
        if (!sessionCount) return null;
        return { byChat: out, sessionCount: sessionCount, messageCount: messageCount };
    }

    function currentTombstoneMap() {
        if (cache && cache.deletedSessionIds && typeof cache.deletedSessionIds === 'object') {
            return cache.deletedSessionIds;
        }
        return {};
    }

    function richestDiskTombstones(candidates) {
        var map = {};
        (candidates || []).forEach(function (row) {
            if (!row || typeof row !== 'object' || row.__fromMirror) return;
            var ids = normalizeDeletedSessionIds(row.deletedSessionIds);
            Object.keys(ids).forEach(function (sid) {
                var prev = Number(map[sid]) || 0;
                var next = Number(ids[sid]) || 0;
                if (next >= prev) map[sid] = next;
            });
        });
        return map;
    }

    function buildSessionFromMirrorMsgs(chatId, contactId, sessionId, msgs) {
        var sid = String(sessionId || '').trim() || uid('sess');
        var sorted = (msgs || []).slice().sort(function (a, b) {
            return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
        });
        if (!sorted.length) return null;
        var createdAt = Number(sorted[0].createdAt) || Date.now();
        var normMsgs = sorted
            .map(function (m) {
                var ts = Number(m.createdAt) || createdAt;
                return normalizeMessage({
                    id: String(m.appointmentMsgId || m.id || '').trim() || uid('msg'),
                    role: m.role,
                    content: m.content,
                    createdAt: ts,
                    chatMirrorId: m.id,
                    renderAsHtml: !!m.renderAsHtml,
                    htmlRaw: m.htmlRaw || m.content,
                    type: m.type,
                    thinking: m.thinking
                });
            })
            .filter(Boolean);
        return normalizeSession({
            id: sid,
            chatId: chatId,
            contactId: contactId,
            createdAt: createdAt,
            title: '恢复 · ' + new Date(createdAt).toLocaleDateString('zh-CN'),
            messages: normMsgs,
            summaryList: []
        });
    }

    function recoverSessionsFromChatMirrors(tombstoneOverride) {
        var st = global.miyaChatStore;
        if (!st || typeof st.getMeta !== 'function') return null;
        var meta = st.getMeta();
        var messagesByChat = meta && meta.messagesByChat;
        if (!messagesByChat || typeof messagesByChat !== 'object') return null;
        try {
            load();
        } catch (e) {}
        var tombs =
            tombstoneOverride && typeof tombstoneOverride === 'object'
                ? tombstoneOverride
                : currentTombstoneMap();
        var mem = global.MiyaAppointmentMemory;
        var byChat = {};
        var sessionCount = 0;
        var messageCount = 0;
        var GAP_MS = 3 * 60 * 60 * 1000;
        Object.keys(messagesByChat).forEach(function (chatKey) {
            var chatId =
                mem && typeof mem.resolveCanonicalChatId === 'function'
                    ? mem.resolveCanonicalChatId(chatKey) || chatKey
                    : chatKey;
            var chat = st.findChat ? st.findChat(chatKey) : null;
            var contactId = chat && chat.contactId ? String(chat.contactId).trim() : '';
            var msgs = (messagesByChat[chatKey] || []).filter(function (m) {
                return m && m.offlineMeet && !m.deleted && String(m.content || '').trim();
            });
            if (!msgs.length) return;
            var explicitMap = Object.create(null);
            var noSid = [];
            msgs.forEach(function (m) {
                var sid = String(m.appointmentSessionId || '').trim();
                if (sid) {
                    if (!explicitMap[sid]) explicitMap[sid] = [];
                    explicitMap[sid].push(m);
                } else {
                    noSid.push(m);
                }
            });
            var sessions = [];
            Object.keys(explicitMap).forEach(function (sid) {
                var sess = buildSessionFromMirrorMsgs(chatId, contactId, sid, explicitMap[sid]);
                if (sess) sessions.push(sess);
            });
            noSid.sort(function (a, b) {
                return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
            });
            var block = [];
            noSid.forEach(function (m) {
                var ts = Number(m.createdAt) || Date.now();
                if (block.length) {
                    var prevTs = Number(block[block.length - 1].createdAt) || 0;
                    if (ts - prevTs > GAP_MS) {
                        var built = buildSessionFromMirrorMsgs(
                            chatId,
                            contactId,
                            'rec_' + chatId + '_' + String(Number(block[0].createdAt) || Date.now()),
                            block
                        );
                        if (built) sessions.push(built);
                        block = [];
                    }
                }
                block.push(m);
            });
            if (block.length) {
                var builtLast = buildSessionFromMirrorMsgs(
                    chatId,
                    contactId,
                    'rec_' + chatId + '_' + String(Number(block[0].createdAt) || Date.now()),
                    block
                );
                if (builtLast) sessions.push(builtLast);
            }
            sessions = sessions.filter(function (s) {
                return s && countLiveMessages(s) > 0;
            });
            if (!sessions.length) return;
            if (!byChat[chatId]) byChat[chatId] = { sessions: [], activeSessionId: '' };
            sessions.forEach(function (sess) {
                if (!sess || !sess.id || tombs[String(sess.id)]) return;
                byChat[chatId].sessions.push(sess);
                sessionCount += 1;
                messageCount += countLiveMessages(sess);
            });
        });
        if (!sessionCount) return null;
        return { byChat: byChat, sessionCount: sessionCount, messageCount: messageCount };
    }

    function countPendingMirrorRecovery(byChat) {
        load();
        var pendingSessions = 0;
        var pendingMessages = 0;
        var pendingChats = 0;
        Object.keys(byChat || {}).forEach(function (chatId) {
            var src = byChat[chatId];
            if (!src || !Array.isArray(src.sessions)) return;
            var chatPending = 0;
            src.sessions.forEach(function (sess) {
                var norm = normalizeSession(Object.assign({}, sess, { chatId: chatId }));
                if (!norm || countLiveMessages(norm) <= 0) return;
                if (isSessionTombstoned(norm.id)) return;
                var bucket = cache.byChat && cache.byChat[chatId];
                var existing =
                    bucket && Array.isArray(bucket.sessions)
                        ? bucket.sessions.find(function (s) {
                              return s && s.id === norm.id;
                          })
                        : null;
                if (existing) {
                    var ids = Object.create(null);
                    (existing.messages || []).forEach(function (m) {
                        if (m && m.id) ids[m.id] = true;
                    });
                    var added = 0;
                    (norm.messages || []).forEach(function (m) {
                        if (!m || !String(m.content || '').trim() || ids[m.id]) return;
                        added += 1;
                    });
                    if (added > 0) {
                        pendingMessages += added;
                        chatPending += 1;
                    }
                } else {
                    pendingSessions += 1;
                    pendingMessages += countLiveMessages(norm);
                    chatPending += 1;
                }
            });
            if (chatPending > 0) pendingChats += 1;
        });
        return { sessions: pendingSessions, messages: pendingMessages, chats: pendingChats };
    }

    function mergeRecoveredByChat(byChat) {
        load();
        var newSessions = 0;
        var newMessages = 0;
        var mergedSessions = 0;
        Object.keys(byChat || {}).forEach(function (chatId) {
            var src = byChat[chatId];
            if (!src || !Array.isArray(src.sessions)) return;
            var bucket = chatBucket(chatId);
            if (!bucket) return;
            src.sessions.forEach(function (sess) {
                var norm = normalizeSession(Object.assign({}, sess, { chatId: chatId }));
                if (!norm || countLiveMessages(norm) <= 0) return;
                if (isSessionTombstoned(norm.id)) return;
                var idx = bucket.sessions.findIndex(function (s) {
                    return s && s.id === norm.id;
                });
                if (idx >= 0) {
                    var ex = bucket.sessions[idx];
                    var ids = Object.create(null);
                    (ex.messages || []).forEach(function (m) {
                        if (m && m.id) ids[m.id] = true;
                    });
                    var added = 0;
                    (norm.messages || []).forEach(function (m) {
                        if (!m || !String(m.content || '').trim() || ids[m.id]) return;
                        ex.messages.push(m);
                        ids[m.id] = true;
                        added += 1;
                    });
                    if (added > 0) {
                        ex.messages.sort(function (a, b) {
                            return (a.createdAt || 0) - (b.createdAt || 0);
                        });
                        /* 封存已移除：合并时不再抬高 closedAt，场次一律保持可续写 */
                        if (!String(ex.contactId || '').trim() && norm.contactId) ex.contactId = norm.contactId;
                        bucket.sessions[idx] = normalizeSession(ex);
                        newMessages += added;
                        mergedSessions += 1;
                    }
                } else {
                    bucket.sessions.unshift(norm);
                    newSessions += 1;
                    newMessages += countLiveMessages(norm);
                }
            });
            bucket.sessions = bucket.sessions.filter(function (s) {
                return countLiveMessages(s) > 0;
            });
        });
        save();
        return {
            sessions: newSessions,
            messages: newMessages,
            mergedSessions: mergedSessions,
            totalSessions: newSessions + mergedSessions
        };
    }

    /**
     * 该会话下，用户是否已选择「不再提示从线上记忆恢复」。
     *
     * 存在 byChat[chatId].mirrorHoldDismissedAt（时间戳）。
     * 每个会话分别记 —— 在某个会话里嫌横幅碍事，就只让那个会话不再提示，
     * 别的会话真丢了数据时仍然会救人。
     */
    function isMirrorHoldDismissed(chatId) {
        var cid = String(chatId || '').trim();
        if (!cid) return false;
        load();
        var row = cache && cache.byChat && cache.byChat[cid];
        return !!(row && Number(row.mirrorHoldDismissedAt) > 0);
    }

    /** 记下「不再提示」。再次主动恢复出新内容时会被清掉（见 restoreFromChatMirrors）。 */
    function dismissMirrorHold(chatId) {
        var cid = String(chatId || '').trim();
        if (!cid) return;
        load();
        if (!cache.byChat) cache.byChat = {};
        if (!cache.byChat[cid]) cache.byChat[cid] = { sessions: [], activeSessionId: '' };
        cache.byChat[cid].mirrorHoldDismissedAt = Date.now();
        save();
    }

    function previewChatMirrorRecovery(chatId) {
        var pack = recoverSessionsFromChatMirrors();
        if (!pack || !pack.byChat) return { sessions: 0, messages: 0, chats: 0 };
        /*
         * 【只在本地一卷都没有的会话里报「待恢复」】
         *
         * 背景：判定原本是「镜像的 appointmentSessionId 在本地找不到同名会话 → 算 1 卷待恢复」，
         * 这个口径会把【孤儿镜像】也算进来 —— 比如本地卷宗被换过 id、换过设备、
         * 清过站点数据，聊天里却还留着老 sid 的镜像。这些镜像永远找不到归宿，
         * 于是横幅一旦出现就再也消不掉（用户反馈「莫名其妙出现，有点碍事」）。
         *
         * 现在收紧口径：只有该 chat 本地确实一卷都没有时才提示。
         * 那才是真正需要救援的场景 —— 本地空了，但线上还留着痕迹。
         * 本地已经有卷的情况下，缺的那几条消息不值得拿一条常驻横幅去换。
         *
         * chatId 可选；不传时退化为旧的统计口径（供恢复流程内部判断用）。
         */
        var cid = String(chatId || '').trim();
        if (cid) {
            if (isMirrorHoldDismissed(cid)) return { sessions: 0, messages: 0, chats: 0 };
            var bucket = cache && cache.byChat && cache.byChat[cid];
            var localCount = bucket && Array.isArray(bucket.sessions) ? bucket.sessions.length : 0;
            if (localCount > 0) return { sessions: 0, messages: 0, chats: 0 };
        }
        return countPendingMirrorRecovery(pack.byChat);
    }

    function mirrorHydrationCandidate(recovered, tombstones) {
        if (!recovered || !recovered.byChat) return null;
        var filtered = filterTombstonedRecoveredByChat(recovered.byChat, tombstones);
        if (!filtered || !filtered.byChat) return null;
        return {
            version: 1,
            presets: [],
            contactPresetId: {},
            contactParams: {},
            contactWorldbook: {},
            contactOpeningPresets: {},
            savedParamPresets: [],
            beautify: defaultBeautify(),
            byChat: filtered.byChat,
            deletedSessionIds: normalizeDeletedSessionIds(tombstones),
            __fromMirror: true,
            __mirrorSessions: filtered.sessionCount
        };
    }

    function collectHydrationCandidates() {
        var read = global.miyaReadLsJsonKey;
        if (typeof read !== 'function') {
            var tombs0 = currentTombstoneMap();
            var recoveredOnly = recoverSessionsFromChatMirrors(tombs0);
            var onlyCand = mirrorHydrationCandidate(recoveredOnly, tombs0);
            return Promise.resolve({
                candidates: onlyCand ? [onlyCand] : [],
                mirrorSessions: onlyCand ? onlyCand.__mirrorSessions : 0
            });
        }
        return Promise.all([
            read(LS_KEY, null),
            read(LS_BACKUP_KEY, null),
            global.miyaWidgetKvIdbGet ? global.miyaWidgetKvIdbGet(LS_KEY) : Promise.resolve(null),
            global.miyaWidgetKvIdbGet ? global.miyaWidgetKvIdbGet(LS_BACKUP_KEY) : Promise.resolve(null)
        ]).then(function (rows) {
            var out = [];
            rows.forEach(function (row) {
                if (row && typeof row === 'object') out.push(row);
            });
            var diskScore = sessionDataRichness(pickRichestParsed(out));
            var tombs = richestDiskTombstones(out);
            if (!Object.keys(tombs).length) tombs = currentTombstoneMap();
            var recovered = recoverSessionsFromChatMirrors(tombs);
            var mirrorCand = diskScore === 0 ? mirrorHydrationCandidate(recovered, tombs) : null;
            var mirrorSessions = mirrorCand ? mirrorCand.__mirrorSessions : 0;
            if (mirrorCand) out.push(mirrorCand);
            return { candidates: out, mirrorSessions: mirrorSessions };
        }).catch(function () {
            var tombs = currentTombstoneMap();
            var recovered = recoverSessionsFromChatMirrors(tombs);
            var cand = mirrorHydrationCandidate(recovered, tombs);
            return {
                candidates: cand ? [cand] : [],
                mirrorSessions: cand ? cand.__mirrorSessions : 0
            };
        });
    }

    function pickRichestParsed(candidates) {
        var best = null;
        var bestScore = -1;
        (candidates || []).forEach(function (row) {
            if (!row || typeof row !== 'object') return;
            var score = stateRichness(row);
            if (score > bestScore) {
                bestScore = score;
                best = row;
            }
        });
        return best;
    }

    function applyParsedState(parsed, opts) {
        opts = opts || {};
        var built = buildStateFromParsed(parsed);
        cache = built.state;
        if (global.__miyaKvMem) global.__miyaKvMem[LS_KEY] = cache;
        if (built.presetDirty && _hydrated && !opts.skipSave) save();
        return cache;
    }

    /** 合并各候选墓碑，并从 byChat 剔除已删卷宗，避免旧备份把手动删除的剧情加回来 */
    function applyTombstonesToParsed(parsed, candidates) {
        if (!parsed || typeof parsed !== 'object') return parsed;
        var tombs = richestDiskTombstones(candidates);
        var selfTombs = normalizeDeletedSessionIds(parsed.deletedSessionIds);
        Object.keys(selfTombs).forEach(function (sid) {
            var prev = Number(tombs[sid]) || 0;
            var next = Number(selfTombs[sid]) || 0;
            if (next >= prev) tombs[sid] = next;
        });
        if (cache && cache.deletedSessionIds) {
            var live = normalizeDeletedSessionIds(cache.deletedSessionIds);
            Object.keys(live).forEach(function (sid) {
                var prev = Number(tombs[sid]) || 0;
                var next = Number(live[sid]) || 0;
                if (next >= prev) tombs[sid] = next;
            });
        }
        if (!Object.keys(tombs).length) return parsed;
        var next = Object.assign({}, parsed, { deletedSessionIds: tombs });
        if (next.byChat && typeof next.byChat === 'object') {
            var byChat = {};
            Object.keys(next.byChat).forEach(function (chatId) {
                var row = next.byChat[chatId];
                if (!row || typeof row !== 'object') return;
                var sessions = Array.isArray(row.sessions)
                    ? row.sessions.filter(function (s) {
                          return s && s.id && !tombs[String(s.id)];
                      })
                    : [];
                byChat[chatId] = Object.assign({}, row, { sessions: sessions });
            });
            next.byChat = byChat;
        }
        return next;
    }

    function ensureHydrated() {
        if (_hydrated) return Promise.resolve(cache || load());
        if (_hydratePromise) return _hydratePromise;
        var chatBoot = Promise.resolve();
        if (global.miyaChatStore && typeof global.miyaChatStore.init === 'function') {
            chatBoot = global.miyaChatStore.init().catch(function () {});
        }
        _hydratePromise = chatBoot
            .then(function () {
                return collectHydrationCandidates();
            })
            .then(function (pack) {
                var candidates = pack && pack.candidates ? pack.candidates : [];
                var mirrorSessions = pack && pack.mirrorSessions ? pack.mirrorSessions : 0;
                var best = applyTombstonesToParsed(pickRichestParsed(candidates), candidates);
                var currentScore = cache ? stateRichness(cache) : 0;
                var bestScore = stateRichness(best);
                if (best && bestScore >= currentScore) {
                    applyParsedState(best, { skipSave: true });
                } else if (!cache) {
                    applyParsedState(null, { skipSave: true });
                } else if (cache) {
                    /* 即便未采用更富候选，也要保留已收集的墓碑 */
                    var tombs = richestDiskTombstones(candidates);
                    if (Object.keys(tombs).length) {
                        cache.deletedSessionIds = Object.assign(
                            {},
                            normalizeDeletedSessionIds(cache.deletedSessionIds),
                            tombs
                        );
                        Object.keys(cache.byChat || {}).forEach(function (chatId) {
                            var bucket = cache.byChat[chatId];
                            if (!bucket || !Array.isArray(bucket.sessions)) return;
                            bucket.sessions = bucket.sessions.filter(function (s) {
                                return s && s.id && !cache.deletedSessionIds[String(s.id)];
                            });
                        });
                    }
                }
                _hydrated = true;
                _hydratePromise = null;
                if (bestScore > 0 && bestScore > currentScore) {
                    if (best && best.__fromMirror && mirrorSessions > 0) {
                        _lastRecoveryInfo = { sessions: mirrorSessions, from: 'mirror' };
                    } else if (currentScore === 0) {
                        _lastRecoveryInfo = { sessions: bestScore, from: 'backup' };
                    }
                    flushSave();
                } else if (_dirtyBeforeHydrate) {
                    /* 水合期间被延后的强写（如全新安装时立刻删角色/删场次），
                       此处补落盘，避免"只改内存、杀进程即丢"。 */
                    retryPendingMirrorDeletes();
                    writeNow();
                }
                _dirtyBeforeHydrate = false;
                return cache;
            })
            .catch(function () {
                if (!cache) applyParsedState(null, { skipSave: true });
                _hydrated = true;
                _hydratePromise = null;
                if (_dirtyBeforeHydrate) {
                    writeNow();
                    _dirtyBeforeHydrate = false;
                }
                return cache;
            });
        return _hydratePromise;
    }

    function load() {
        if (cache && (_hydrated || !needsAsyncHydrate())) return cache;
        var parsed = null;
        if (typeof global.miyaSyncReadJsonKey === 'function') {
            parsed = global.miyaSyncReadJsonKey(LS_KEY);
        }
        try {
            if (!parsed) {
                var raw = localStorage.getItem(LS_KEY);
                if (raw && !(global.miyaLsIsIdbPlaceholder && global.miyaLsIsIdbPlaceholder(raw))) {
                    parsed = JSON.parse(raw);
                }
            }
        } catch (e) {}
        if (parsed && typeof parsed === 'object') {
            _hydrated = true;
            return applyParsedState(parsed);
        }
        if (needsAsyncHydrate()) {
            if (!cache) applyParsedState(null, { skipSave: true });
            ensureHydrated();
            return cache;
        }
        _hydrated = true;
        return applyParsedState(null);
    }

    function saveNow() {
        if (!cache) load();
        if (!_hydrated && needsAsyncHydrate()) {
            /* 数据还在 IDB、异步水合未完成：此刻写盘会用空 cache 覆盖真数据，
               所以只能延后。但必须记下"有未落盘的修改"，等水合完成后补写，
               否则全新安装（bestScore === 0）时这段强写会永久丢失。 */
            _dirtyBeforeHydrate = true;
            return cache;
        }
        return writeNow();
    }

    /** 真正执行落盘（调用方需保证 _hydrated 或无需异步水合） */
    function writeNow() {
        if (typeof global.miyaSyncFlushJsonKey === 'function') {
            global.miyaSyncFlushJsonKey(LS_KEY, cache);
            if (stateRichness(cache) > 0) {
                global.miyaSyncFlushJsonKey(LS_BACKUP_KEY, cache);
            }
            return cache;
        }
        if (typeof global.miyaWriteLsJsonKey === 'function') {
            global.miyaWriteLsJsonKey(LS_KEY, cache).catch(function () {});
            if (stateRichness(cache) > 0) {
                global.miyaWriteLsJsonKey(LS_BACKUP_KEY, cache).catch(function () {});
            }
            return cache;
        }
        /* 纪念日数据：主 key 与备份 key 都要确认写成功，
           失败必须上报——否则用户看到「已保存」，重开后纪念日凭空消失。 */
        var apptStr = '';
        try { apptStr = JSON.stringify(cache); } catch (eStr) { return cache; }
        var apptSet = function (k) {
            if (typeof global.miyaSafeLsSet === 'function') {
                global.miyaSafeLsSet(k, apptStr);
            } else {
                try { localStorage.setItem(k, apptStr); } catch (e) {}
            }
        };
        apptSet(LS_KEY);
        if (stateRichness(cache) > 0) apptSet(LS_BACKUP_KEY);
        return cache;
    }

    function scheduleSave() {
        if (_saveTimer) return;
        _saveTimer = setTimeout(function () {
            _saveTimer = 0;
            saveNow();
        }, SAVE_DEBOUNCE_MS);
    }

    function flushSave() {
        if (_saveTimer) {
            clearTimeout(_saveTimer);
            _saveTimer = 0;
        }
        return saveNow();
    }

    /** 热路径默认防抖；封存/迁移等关键路径传 { force: true } */
    function save(opts) {
        if (opts && opts.force) return flushSave();
        scheduleSave();
        return cache;
    }

    function chatBucket(chatId) {
        load();
        var id = String(chatId || '').trim();
        if (!id) return null;
        if (!cache.byChat[id]) {
            cache.byChat[id] = { sessions: [], activeSessionId: '' };
        }
        return cache.byChat[id];
    }

    function lastSummaryEnd(session) {
        var mx = 0;
        (session.summaryList || []).forEach(function (row) {
            var e = clampInt(row && row.endIndex, 0, 9999999, 0);
            if (e > mx) mx = e;
        });
        return mx;
    }

    function summaryRangesOverlap(aStart, aEnd, bStart, bEnd) {
        var s1 = clampInt(aStart, 0, 9999999, 0);
        var e1 = clampInt(aEnd, 0, 9999999, 0);
        var s2 = clampInt(bStart, 0, 9999999, 0);
        var e2 = clampInt(bEnd, 0, 9999999, 0);
        if (!s1 || !e1 || !s2 || !e2) return false;
        return !(e1 < s2 || e2 < s1);
    }

    function countLiveMessages(session) {
        return (session && session.messages ? session.messages : []).filter(function (m) {
            return m && !m.deleted && String(m.content || '').trim();
        }).length;
    }

    /*
     * 删除某联系人的全部约会数据。
     * 删除联系人时调用。约会数据是独立存储的（LS_KEY = miya-appointment-v1）：
     *   - contactPresetId / contactParams / contactWorldbook / contactOpeningPresets 按 contactId 分桶
     *   - byChat[chatId].sessions[] 里每个会话带 contactId 字段
     * 若不清，重新添加同 id 角色会读到上一段关系的约会预设与剧情。
     * 只清与该联系人相关的桶；群聊会话里若该角色是 cast 成员，一并剔除该成员。
     *
     * 异步化原因：本函数原先只调一次同步 load()，而当数据落在 IndexedDB 时
     * load() 会拿到空 cache（见 load 的 needsAsyncHydrate 分支），于是在「空数据」
     * 上删了个寂寞——returns false 且不打墓碑，真数据仍在 IDB，下次 hydrate 又回来。
     * 现在改为「先等 hydrate 完成，再执行同一套清理逻辑」，返回 Promise<boolean>。
     * 调用方 miya-chat-store 的 purgeContactScopedData 用 safe() 同步包裹且不读返回值，
     * 因此返回 Promise 兼容；旧调用方若按同步用法读返回值，会得到真值（Promise 恒真）。
     */
    function removeAllForContact(contactId) {
        var cid = String(contactId || '').trim();
        if (!cid) return Promise.resolve(false);
        return ensureHydrated()
            .catch(function () {
                /* hydrate 失败仍尝试清理，至少清掉当前 cache 里已有的部分 */
                return cache;
            })
            .then(function () {
                return purgeAllForContact(cid);
            });
    }

    /** 同步清理实体：调用方必须保证此刻 cache 已完成 hydrate */
    function purgeAllForContact(cid) {
        var touched = false;

        ['contactPresetId', 'contactParams', 'contactWorldbook', 'contactOpeningPresets'].forEach(function (bucket) {
            if (cache[bucket] && Object.prototype.hasOwnProperty.call(cache[bucket], cid)) {
                delete cache[bucket][cid];
                touched = true;
            }
        });

        Object.keys(cache.byChat || {}).forEach(function (chatId) {
            var row = cache.byChat[chatId];
            if (!row || !Array.isArray(row.sessions)) return;
            var before = row.sessions.length;

            /*
             * 区分「该联系人自己的单人场」与「包含该联系人的多人场」。
             * 多人场（cast > 1）的 contactId 只是宿主/第一顺位，并不代表
             * 「这一卷属于他一个人」——它同样属于其他出演角色。
             * 旧实现只看 contactId，于是删掉群里任一位成员都会把整卷群戏删掉，
             * 其他人下次进线下就发现「我们一起玩的那场没了」。
             * 所以：多人场只剔除该成员（并在剔到不足两人时保留该卷，
             * 因为剩余内容仍属其他角色），单人场才整卷移除。
             */
            var isMultiCast = function (s) {
                return !!(s && Array.isArray(s.cast) && s.cast.length > 1);
            };

            var removedIds = [];
            var kept = row.sessions.filter(function (s) {
                if (!s) return false;
                if (String(s.contactId || '').trim() !== cid) return true;
                /* 多人场：不整卷删，留给下面的 cast 剔除分支处理 */
                if (isMultiCast(s)) return true;
                if (s.id) removedIds.push(String(s.id));
                return false;
            });

            /* 群聊会话里该角色作为 cast 成员：只剔除成员，不删整段会话 */
            kept = kept.map(function (s) {
                if (!Array.isArray(s.cast) || !s.cast.length) return s;
                var castKept = s.cast.filter(function (m) {
                    return String((m && m.contactId) || '').trim() !== cid;
                });
                if (castKept.length === s.cast.length) return s;
                return Object.assign({}, s, { cast: castKept });
            });

            if (kept.length === before && removedIds.length === 0) {
                /* 长度没变但仍可能有 cast 变化，用 JSON 比对兜底 */
                if (JSON.stringify(kept) === JSON.stringify(row.sessions)) return;
            }

            removedIds.forEach(function (sid) {
                if (!cache.deletedSessionIds) cache.deletedSessionIds = {};
                cache.deletedSessionIds[sid] = Date.now();
            });
            if (removedIds.length) {
                /* 批量删除：本批 id 全部保护，避免刚写完就被条数上限淘汰 */
                var guardIds = {};
                removedIds.forEach(function (sid) {
                    guardIds[sid] = true;
                });
                cache.deletedSessionIds = pruneDeletedSessionIds(cache.deletedSessionIds, guardIds);
            }

            cache.byChat[chatId] = Object.assign({}, row, { sessions: kept });
            if (
                removedIds.indexOf(String(row.activeSessionId || '')) >= 0 ||
                !kept.some(function (s) { return s && String(s.id) === String(row.activeSessionId || ''); })
            ) {
                cache.byChat[chatId].activeSessionId = kept.length ? String(kept[0].id) : '';
            }
            touched = true;
        });

        if (touched) flushSave();
        return touched;
    }

    var store = {
        BUILTIN_PRESET_ID: null,
        load: load,
        save: save,
        whenReady: ensureHydrated,
        removeAllForContact: removeAllForContact,
        recoverFromChatMirrors: recoverSessionsFromChatMirrors,
        previewChatMirrorRecovery: previewChatMirrorRecovery,
        isMirrorHoldDismissed: isMirrorHoldDismissed,
        dismissMirrorHold: dismissMirrorHold,
        restoreFromChatMirrors: function () {
            var chatBoot = Promise.resolve();
            if (global.miyaChatStore && typeof global.miyaChatStore.init === 'function') {
                chatBoot = global.miyaChatStore.init().catch(function () {});
            }
            return chatBoot.then(function () {
                var recovered = recoverSessionsFromChatMirrors();
                if (!recovered || !recovered.byChat) {
                    return { ok: false, reason: 'no_mirror', sessions: 0, messages: 0 };
                }
                var pending = countPendingMirrorRecovery(recovered.byChat);
                if (!pending.sessions && !pending.messages) {
                    return { ok: false, reason: 'already_up_to_date', sessions: 0, messages: 0 };
                }
                var result = mergeRecoveredByChat(recovered.byChat);
                var ok = result.totalSessions > 0 || result.messages > 0;
                if (ok) {
                    /*
                     * 恢复成功后，把本次涉及的会话的「不再提示」标记清掉。
                     *
                     * 理由：这个标记表达的是「我现在不需要救援」，而用户刚刚
                     * 主动点了恢复 —— 说明情况变了。清掉之后，将来这批会话
                     * 若真再次丢失，横幅还能重新出现。
                     */
                    Object.keys(recovered.byChat || {}).forEach(function (cid) {
                        var row = cache && cache.byChat && cache.byChat[cid];
                        if (row && row.mirrorHoldDismissedAt) delete row.mirrorHoldDismissedAt;
                    });
                    save();
                }
                return {
                    ok: ok,
                    reason: ok ? 'restored' : 'already_up_to_date',
                    sessions: result.totalSessions,
                    newSessions: result.sessions,
                    mergedSessions: result.mergedSessions,
                    messages: result.messages
                };
            });
        },
        consumeRecoveryInfo: function () {
            var info = _lastRecoveryInfo;
            _lastRecoveryInfo = null;
            return info;
        },
        getState: function () {
            return load();
        },
        getPresets: function () {
            return load().presets.slice();
        },
        getPreset: function (presetId) {
            var id = String(presetId || '').trim();
            return load().presets.find(function (p) { return p.id === id; }) || null;
        },
        getBuiltinPreset: function () {
            // 仅保留兼容层：这是运行时默认参数，不是可见的内置预设，
            // 不包含任何文风、人称或字数规则。
            return Object.assign({}, defaultContactParams(), {
                id: '__ap_runtime_default__',
                name: '线下默认',
                builtin: false,
                worldbookBindings: []
            });
        },
        upsertPreset: function (patch) {
            load();
            var row = normalizePreset(patch);
            if (!row) return null;
            var idx = cache.presets.findIndex(function (p) { return p.id === row.id; });
            if (idx >= 0) {
                cache.presets[idx] = Object.assign({}, cache.presets[idx], row, { updatedAt: Date.now() });
            } else {
                cache.presets.push(row);
            }
            save();
            return store.getPreset(row.id);
        },
        deletePreset: function (presetId) {
            var id = String(presetId || '').trim();
            if (!id) return false;
            load();
            var before = cache.presets.length;
            cache.presets = cache.presets.filter(function (p) { return p.id !== id; });
            Object.keys(cache.contactPresetId).forEach(function (cid) {
                if (cache.contactPresetId[cid] === id) delete cache.contactPresetId[cid];
            });
            save();
            return cache.presets.length < before;
        },
        getContactPresetId: function (contactId) {
            var cid = String(contactId || '').trim();
            if (!cid) return '';
            load();
            return cache.contactPresetId[cid] || '';
        },
        setContactPresetId: function (contactId, presetId) {
            var cid = String(contactId || '').trim();
            var pid = String(presetId || '').trim();
            if (!cid || !pid) return;
            load();
            cache.contactPresetId[cid] = pid;
            save();
        },
        resolvePresetForContact: function (contactId) {
            var cid = String(contactId || '').trim();
            load();
            var merged = Object.assign({}, defaultContactParams(), {
                id: '__ap_runtime_default__',
                name: '线下默认',
                builtin: false,
                worldbookBindings: []
            });
            if (cid && cache.contactParams[cid]) {
                var cp = normalizeContactParams(cache.contactParams[cid]);
                if (cp) merged = Object.assign(merged, cp);
            }
            merged.worldbookBindings = cid && cache.contactWorldbook[cid]
                ? normalizeBindings(cache.contactWorldbook[cid])
                : [];
            return merged;
        },

        getContactParams: function (contactId) {
            var cid = String(contactId || '').trim();
            if (!cid) return null;
            load();
            return normalizeContactParams(cache.contactParams[cid]);
        },
        saveContactParams: function (contactId, params) {
            var cid = String(contactId || '').trim();
            if (!cid) return null;
            load();
            var row = normalizeContactParams(params);
            if (!row) return null;
            cache.contactParams[cid] = row;
            save();
            return row;
        },
        getContactWorldbook: function (contactId) {
            var cid = String(contactId || '').trim();
            if (!cid) return [];
            load();
            return normalizeBindings(cache.contactWorldbook[cid]);
        },
        saveContactWorldbook: function (contactId, bindings) {
            var cid = String(contactId || '').trim();
            if (!cid) return [];
            load();
            var rows = normalizeBindings(bindings);
            cache.contactWorldbook[cid] = rows;
            save();
            return rows;
        },
        getContactOpeningPresets: function (contactId) {
            var cid = String(contactId || '').trim();
            if (!cid) return [];
            load();
            var rows = cache.contactOpeningPresets && cache.contactOpeningPresets[cid];
            if (!Array.isArray(rows)) return [];
            return rows
                .map(normalizeOpeningPreset)
                .filter(Boolean)
                .sort(function (a, b) {
                    return (b.updatedAt || 0) - (a.updatedAt || 0);
                });
        },
        upsertContactOpeningPreset: function (contactId, patch) {
            var cid = String(contactId || '').trim();
            if (!cid) return null;
            load();
            var row = normalizeOpeningPreset(patch);
            if (!row) return null;
            if (!cache.contactOpeningPresets) cache.contactOpeningPresets = {};
            if (!Array.isArray(cache.contactOpeningPresets[cid])) cache.contactOpeningPresets[cid] = [];
            var idx = cache.contactOpeningPresets[cid].findIndex(function (p) {
                return p.id === row.id;
            });
            if (idx >= 0) {
                cache.contactOpeningPresets[cid][idx] = Object.assign({}, cache.contactOpeningPresets[cid][idx], row, {
                    updatedAt: Date.now()
                });
            } else {
                cache.contactOpeningPresets[cid].push(row);
            }
            save();
            return cache.contactOpeningPresets[cid].find(function (p) {
                return p.id === row.id;
            });
        },
        deleteContactOpeningPreset: function (contactId, presetId) {
            var cid = String(contactId || '').trim();
            var pid = String(presetId || '').trim();
            if (!cid || !pid) return false;
            load();
            if (!cache.contactOpeningPresets || !Array.isArray(cache.contactOpeningPresets[cid])) return false;
            var before = cache.contactOpeningPresets[cid].length;
            cache.contactOpeningPresets[cid] = cache.contactOpeningPresets[cid].filter(function (p) {
                return p && p.id !== pid;
            });
            save();
            return cache.contactOpeningPresets[cid].length < before;
        },
        getSessionOpeningMessage: function (chatId, sessionId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            return (sess.messages || []).find(function (m) {
                return m && !m.deleted && isOpeningMessage(m);
            }) || null;
        },
        setSessionOpeningMessage: function (chatId, sessionId, fields) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            (sess.messages || []).forEach(function (m) {
                if (m && !m.deleted && isOpeningMessage(m)) {
                    store.deleteMessage(chatId, sessionId, m.id);
                }
            });
            var content = String((fields && fields.content) || '').trim();
            if (!content) return null;
            return store.addMessage(chatId, sessionId, {
                role: 'system',
                type: 'opening',
                content: content,
                openingPresetId: fields && fields.openingPresetId ? String(fields.openingPresetId).trim() : ''
            });
        },
        getSavedParamPresets: function () {
            load();
            return (cache.savedParamPresets || []).slice().sort(function (a, b) {
                return (b.updatedAt || 0) - (a.updatedAt || 0);
            });
        },
        upsertSavedParamPreset: function (patch) {
            load();
            var row = normalizeSavedParamPreset(patch);
            if (!row) return null;
            var idx = cache.savedParamPresets.findIndex(function (p) {
                return p.id === row.id;
            });
            if (idx >= 0) {
                cache.savedParamPresets[idx] = Object.assign({}, cache.savedParamPresets[idx], row, {
                    updatedAt: Date.now()
                });
            } else {
                cache.savedParamPresets.push(row);
            }
            save();
            return cache.savedParamPresets.find(function (p) {
                return p.id === row.id;
            });
        },
        deleteSavedParamPreset: function (presetId) {
            var id = String(presetId || '').trim();
            if (!id) return false;
            load();
            var before = cache.savedParamPresets.length;
            cache.savedParamPresets = cache.savedParamPresets.filter(function (p) {
                return p.id !== id;
            });
            save();
            return cache.savedParamPresets.length < before;
        },
        getBeautify: function () {
            return normalizeBeautify(load().beautify);
        },
        saveBeautify: function (patch) {
            load();
            cache.beautify = normalizeBeautify(Object.assign({}, cache.beautify, patch || {}));
            save();
            return cache.beautify;
        },
        getSessions: function (chatId) {
            var b = chatBucket(chatId);
            if (!b) return [];
            return b.sessions
                .filter(function (s) {
                    return countLiveMessages(s) > 0;
                })
                .slice()
                .sort(function (a, b2) {
                    return (b2.createdAt || 0) - (a.createdAt || 0);
                });
        },
        getSession: function (chatId, sessionId) {
            var b = chatBucket(chatId);
            if (!b) return null;
            var sid = String(sessionId || '').trim();
            return b.sessions.find(function (s) { return s.id === sid; }) || null;
        },
        getActiveSession: function (chatId) {
            var b = chatBucket(chatId);
            if (!b || !b.activeSessionId) return null;
            var sess = store.getSession(chatId, b.activeSessionId);
            if (!sess) return null;
            return sess;
        },
        /**
         * 取该聊天下「当前激活场次」的 id。
         *
         * 与 getActiveSession 的区别：这里只回 id 字符串，拿不到时回空串，
         * 不会因为「场次不存在」而返回 null 掩盖原因。给记忆层做「排除本场」
         * 判据用 —— 那边只需要一个 id，不需要整个 session 对象。
         */
        getActiveSessionId: function (chatId) {
            try {
                var b = chatBucket(chatId);
                return b && b.activeSessionId ? String(b.activeSessionId) : '';
            } catch (e) {
                return '';
            }
        },
        /** 出演名单指纹（与顺序无关），用于续上场次 */
        castContactKey: function (castOpt, fallbackContactId, fallbackChatId) {
            return normalizeCast(castOpt, fallbackContactId, fallbackChatId)
                .map(function (row) {
                    return row.contactId;
                })
                .sort()
                .join('\0');
        },
        /**
         * 从出演名单里取出「宿主聊天」—— 即这场戏该归属在哪个聊天记录下。
         *
         * 单人入口：cast 里那条就是 { contactId, chatId: 私聊 id }。
         * 群聊入口：各成员带的是自己的私聊 id（作镜像落点用），
         *          但场次本身挂在群合成的 chat 上，此时以显式传入的 chatId 为准
         *          （见 findResumableSessionByCast 的 opts.chatId）。
         *
         * 取不到时返回空串，由调用方决定是否回退到跨聊天搜索。
         */
        castHostChatId: function (castOpt) {
            var list = normalizeCast(castOpt);
            for (var i = 0; i < list.length; i++) {
                var cid = String((list[i] && list[i].chatId) || '').trim();
                if (cid) return cid;
            }
            return '';
        },
        /**
         * 按出演名单找回未封存场次：优先有正文的，其次当前激活，再取最近一场。
         * 多人/单人均适用；找回后会重新标为 active。
         *
         * v48 修复「聊得好好的会跳到另一个聊天记录的楼里」：
         * 原实现遍历 **全部** chat 的 byChat，只要出演名单指纹相同就参与打分，
         * 且「正文多」权重极高（live * 1e9）。于是当同一个角色在多个聊天里
         * 都有线下内容时，请求方在 chat_B，却会被带到 chat_A 那条 60 楼的场次里。
         *
         * 现在的边界规则（按优先级）：
         *   1. 先只在「请求方自己的 chat」里找 —— 命中就直接用，绝不跨聊天抓；
         *   2. 本聊天确实没有可用场次时，才回退到跨聊天搜索，
         *      且此时只在「该聊天的 bucket」里挑，避免把别的聊天的场次抢过来；
         *   3. 群聊入口传进来的 cast 自带 chatId，走的是同样规则，行为不变。
         *
         * 换言之：跨聊天搜索从「默认行为」降级为「本聊天无场次时的兜底」。
         */
        findResumableSessionByCast: function (castOpt, opts) {
            var want = store.castContactKey(castOpt);
            if (!want) return null;
            load();
            var preferChatId =
                opts && opts.chatId
                    ? String(opts.chatId).trim()
                    : store.castHostChatId(castOpt);

            function pickFromBucket(chatKey) {
                var b = cache.byChat[chatKey];
                if (!b || !Array.isArray(b.sessions)) return null;
                var hit = null;
                var hitScore = -1;
                b.sessions.forEach(function (sess) {
                    if (!sess) return;
                    var key = store.castContactKey(
                        sess.cast,
                        sess.contactId,
                        sess.chatId || chatKey
                    );
                    if (key !== want) return;
                    var live = countLiveMessages(sess);
                    var isActive = !!(b.activeSessionId && b.activeSessionId === sess.id);
                    /* 有正文 >> 激活空场 >> 创建时间 */
                    var score =
                        live * 1e9 + (isActive ? 1e6 : 0) + (Number(sess.createdAt) || 0);
                    if (score > hitScore) {
                        hitScore = score;
                        hit = sess;
                    }
                });
                return hit;
            }

            var best = null;
            /* ① 先在本聊天内找 —— 这是绝大多数情况的正确结果 */
            if (preferChatId) best = pickFromBucket(preferChatId);

            /* ② 本聊天没有可用场次，才允许跨聊天兜底（保持老数据的可续写性） */
            if (!best) {
                var bestScore = -1;
                Object.keys(cache.byChat || {}).forEach(function (chatKey) {
                    if (chatKey === preferChatId) return;
                    var b = cache.byChat[chatKey];
                    if (!b || !Array.isArray(b.sessions)) return;
                    b.sessions.forEach(function (sess) {
                        if (!sess) return;
                        var key = store.castContactKey(
                            sess.cast,
                            sess.contactId,
                            sess.chatId || chatKey
                        );
                        if (key !== want) return;
                        var live = countLiveMessages(sess);
                        var isActive = !!(b.activeSessionId && b.activeSessionId === sess.id);
                        var score =
                            live * 1e9 + (isActive ? 1e6 : 0) + (Number(sess.createdAt) || 0);
                        if (score > bestScore) {
                            bestScore = score;
                            best = sess;
                        }
                    });
                });
            }
            if (!best) return null;
            var hostId = String(best.chatId || '').trim();
            if (!hostId) return best;
            var host = chatBucket(hostId);
            if (host && host.activeSessionId !== best.id) {
                host.activeSessionId = best.id;
                flushSave();
            }
            return best;
        },
        createBranch: function (chatId, sessionId, floorIndex) {
            var source = store.getSession(chatId, sessionId);
            if (!source) return null;
            var idx = clampInt(floorIndex, 1, (source.messages || []).length, 0) - 1;
            if (idx < 0) return null;
            var snapshot = (source.messages || []).slice(0, idx + 1).map(function (m) {
                return normalizeMessage(JSON.parse(JSON.stringify(m)));
            }).filter(Boolean);
            var b = chatBucket(chatId);
            if (!b) return null;
            var base = String(source.title || '').trim() || '未命名场景';
            var existing = b.sessions.map(function (x) { return String(x && x.title || ''); });
            var n = 1, title = base + ' · 分支 ' + n;
            while (existing.indexOf(title) >= 0) { n += 1; title = base + ' · 分支 ' + n; }
            var branch = normalizeSession({
                id: uid('sess'), chatId: source.chatId, contactId: source.contactId,
                cast: source.cast, createdAt: Date.now(), title: title,
                messages: snapshot, summaryList: [], statusLog: source.statusLog || [],
                parentSessionId: source.id,
                branchFromMessageId: snapshot.length ? snapshot[snapshot.length - 1].id : '',
                branchFromFloor: idx + 1
            });
            b.sessions.unshift(branch);
            b.activeSessionId = branch.id;
            save({ force: true });
            return branch;
        },
        /**
         * 导入一份聊天记录，建成一个线下场次。
         *
         * ⚠️ 这里必须拒绝「空 messages」，这条判据是修
         *    「导入报格式不正确、却留下一个点不进去的记录」的关键。
         *
         * 早先只判 `Array.isArray(messages)`，于是 `messages: []`
         * 照样能 unshift 进桶、并把 activeSessionId 指向它。随之而来的是
         * 一组自相矛盾的表现：
         *   · getSessions()   —— 用 countLiveMessages > 0 过滤，**看不见**这个空壳
         *   · getActiveSession —— 不看消息数，**看得见**这个空壳
         *   · storyHasContent() —— 判假，于是点进去落到「选择开场白」页
         * 用户体感正是：列表里/状态里像是多了那么一个，点却点不进去。
         *
         * 三个入口对「空会话是否合法」的判断本来就不一致；这里从源头收口：
         * 空会话一律不入库，三个入口的分歧也就不存在了。
         * （startNewSession 是唯一的例外 —— 它就是要建一个空场次等用户开写，
         *   所以那边保留 filter 逻辑，不受本判据影响。）
         */
        importSession: function (chatId, payload) {
            if (!payload || typeof payload !== 'object') return null;
            var source = payload.session && typeof payload.session === 'object' ? payload.session : payload;
            var messages = Array.isArray(payload.messages) ? payload.messages : source.messages;
            if (!Array.isArray(messages)) return null;
            /*
             * 判「有没有活着的行」而不是 `messages.length`：
             * 直接传进来的数组未必经过 normalizeSession，可能混着
             * null / 空 content / deleted 占位。用最终会被展示的口径判，
             * 才不会出现「通过了校验、入库后列表里却还是看不见」的二次落空。
             */
            var normalized = messages.map(normalizeMessage).filter(Boolean);
            var live = normalized.filter(function (m) {
                return !m.deleted && String(m.content || '').trim();
            });
            if (!live.length) return null;
            var sess = normalizeSession(Object.assign({}, source, {
                id: uid('sess'), chatId: chatId || source.chatId,
                createdAt: Date.now(), messages: messages
            }));
            if (!sess || !sess.chatId) return null;
            var b = chatBucket(sess.chatId);
            b.sessions.unshift(sess); b.activeSessionId = sess.id;
            save({ force: true });
            return sess;
        },
        startNewSession: function (chatId, contactId, castOpt) {
            var b = chatBucket(chatId);
            if (!b) return null;
            b.sessions = b.sessions.filter(function (s) {
                return countLiveMessages(s) > 0;
            });
            b.activeSessionId = '';
            var cast = normalizeCast(castOpt, contactId, chatId);
            var sess = normalizeSession({
                id: uid('sess'),
                chatId: chatId,
                contactId: contactId,
                cast: cast,
                createdAt: Date.now(),
                messages: [],
                summaryList: [],
                statusLog: []
            });
            b.sessions.unshift(sess);
            b.activeSessionId = sess.id;
            save();
            return sess;
        },
        _writeSession: function (session) {
            if (!session || !session.chatId) return;
            var b = chatBucket(session.chatId);
            if (!b) return;
            var idx = b.sessions.findIndex(function (s) { return s.id === session.id; });
            /* 热路径：已是 cache 内同一引用时跳过整表 remap，只防抖落盘 */
            if (idx >= 0 && b.sessions[idx] === session) {
                save();
                return;
            }
            var norm = normalizeSession(session);
            if (!norm) return;
            if (idx >= 0) b.sessions[idx] = norm;
            else b.sessions.unshift(norm);
            save();
        },
        setSessionTitle: function (chatId, sessionId, title) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            sess.title = String(title || '').trim();
            store._writeSession(sess);
            return sess;
        },
        addMessage: function (chatId, sessionId, fields) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            var msg = normalizeMessage(
                Object.assign({ id: uid('msg'), createdAt: Date.now() }, fields || {})
            );
            if (!msg || !String(msg.content || '').trim()) return null;
            sess.messages.push(msg);
            mirrorMessageToCast(sess, msg, { deferSessionWrite: true });
            store._writeSession(sess);
            return msg;
        },
        /*
         * 原位还原一条被软删的消息 —— 「重发失败回滚」专用。
         *
         * 为什么不能继续用 addMessage：addMessage 是 push。
         * 重发失败回滚时那一行其实还在数组里（deleteMessage 只置 deleted），
         * 用 addMessage 还原就等于再塞一条同 id 的同内容行进来，于是
         *   · 屏幕上多出「一模一样的一层」（用户报的就是这个）
         *   · 两条同 id，后续按 id 的删除/隐藏全部指向第一条死行（删除失效）
         * 所以还原必须回到原来那一格，而不是在末尾新建一格。
         *
         * 返回值语义：
         *   { ok:true, mode:'restored' }  原位复活成功
         *   { ok:true, mode:'appended' }  原行已不在数组（被压实掉了），只能追加
         *   { ok:false, mode:'invalid' }  快照本身没内容，跳过
         */
        restoreMessage: function (chatId, sessionId, snapshot) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return { ok: false, mode: 'no_session' };
            var snap = snapshot || {};
            var mid = String(snap.id || '').trim();
            if (!mid || !String(snap.content || '').trim()) {
                return { ok: false, mode: 'invalid' };
            }
            var idx = (sess.messages || []).findIndex(function (m) {
                return m && m.id === mid;
            });
            if (idx >= 0) {
                /*
                 * 原位复活：显式把 deleted 置回 false（patch 里必须带 deleted:false，
                 * 否则 normalizeMessage 会沿用旧的 true），content 用快照里的原文本。
                 * createdAt 也一并还原，楼层顺序不会因为回滚而漂移。
                 */
                sess.messages[idx] = normalizeMessage(
                    Object.assign({}, sess.messages[idx], {
                        role: snap.role,
                        type: snap.type,
                        content: snap.content,
                        thinking: snap.thinking,
                        swipes: Array.isArray(snap.swipes) ? snap.swipes.slice() : undefined,
                        swipeId: snap.swipeId,
                        hidden: !!snap.hidden,
                        renderAsHtml: !!snap.renderAsHtml,
                        htmlRaw: snap.htmlRaw,
                        createdAt: snap.createdAt,
                        deleted: false
                    })
                );
                mirrorMessageToCast(sess, sess.messages[idx], { deferSessionWrite: true });
                store._writeSession(sess);
                return { ok: true, mode: 'restored' };
            }
            /* 原行确实没了（比如已被压实清理），退回追加，但绝不静默 */
            var row = store.addMessage(chatId, sessionId, {
                id: mid,
                role: snap.role,
                type: snap.type,
                content: snap.content,
                thinking: snap.thinking,
                swipes: Array.isArray(snap.swipes) ? snap.swipes.slice() : undefined,
                swipeId: snap.swipeId,
                hidden: !!snap.hidden,
                renderAsHtml: !!snap.renderAsHtml,
                htmlRaw: snap.htmlRaw,
                createdAt: snap.createdAt
            });
            return row ? { ok: true, mode: 'appended' } : { ok: false, mode: 'append_failed' };
        },
        /*
         * 把「同一个 id 出现多行」压实成一行（保留最后一条活着的，否则保留最后一条）。
         * deleteMessage 收尾会调它，防止历史脏数据一直膨胀下去。
         */
        _dedupeMessages: function (chatId, sessionId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess || !Array.isArray(sess.messages)) return 0;
            var seen = Object.create(null);
            var out = [];
            var removed = 0;
            /* 倒着遍历：同 id 时保留更靠后的那一条（更接近当前状态） */
            for (var i = sess.messages.length - 1; i >= 0; i--) {
                var m = sess.messages[i];
                if (!m || !m.id) { removed++; continue; }
                if (seen[m.id]) { removed++; continue; }
                seen[m.id] = true;
                out.push(m);
            }
            out.reverse();
            if (removed > 0) {
                sess.messages = out;
                store._writeSession(sess);
            }
            return removed;
        },
        updateMessage: function (chatId, sessionId, messageId, patch) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            var idx = sess.messages.findIndex(function (m) { return m.id === messageId; });
            if (idx < 0) return null;
            /*
             * ⚠️ 补上 role。
             *
             * normalizeMessage 对缺失的 role 是**兜底成 'user'**，不是报错。
             * 而这里走的是 Object.assign(旧行, patch) —— 调用方几乎都只传
             * 要改的那几个字段（改 content、改 hidden、改 swipes…），
             * 于是合并出来的对象**没有 role**，落进 normalizeMessage 就被
             * 判成了 'user'：
             *
             *   · 角色楼层被 updateMessage 一改就变成「我发的消息」，
             *     渲染时换了气泡方向，候选切换键也一并消失
             *     （offlineSwipeBarHtml 只给 assistant 出键）；
             *   · 而且是静默的 —— 改一次内容，楼层就换了身份。
             *
             * 补一句把旧行的 role 显式带上，patch 想改 role 时仍然能改
             * （patch 在后，优先级更高）。这是修一个已有的数据损坏点，
             * 不是为本次的新功能打的补丁。
             */
            sess.messages[idx] = normalizeMessage(
                Object.assign({}, sess.messages[idx], { role: sess.messages[idx].role }, patch || {}, { editedAt: Date.now() })
            );
            store._writeSession(sess);
            /*
             * 镜像同步必须覆盖全部出演角色的线程。
             * 旧实现只取 msg.chatMirrorId（主线），多人场里 castMirrors 中的
             * 其余落点不会被更新 —— 表现为「主线聊天记录改了，但别的角色
             * 回线上时记的还是旧文本」。这里与 purgeMessageOnlineMirrors
             * 保持同一套枚举口径：主线 + castMirrors 全量。
             */
            syncMessageToOnlineMirrors(chatId, sess.messages[idx]);
            return sess.messages[idx];
        },
        deleteMessage: function (chatId, sessionId, messageId, extra) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            /*
             * 这里必须把「所有 id 相同的行」全部软删，不能只删第一条。
             *
             * 出过的故障：restoreMessageSnapshot() 早先用 addMessage 还原，
             * 而 addMessage 是 push —— 数组里于是同时存在两条 id 相同的行
             * （一条软删的死行 + 一条活着的新行）。旧实现用 find() 只命中
             * 第一条，也就是那条早就死了的，于是「点删除」反复改死行，
             * 活行永远不动，表现就是「删除楼层删不掉」。
             *
             * 现在：枚举全部同 id 行逐条软删，并在收尾时把重复行清掉，
             * 让数组回到「一个 id 只有一行」的不变式。
             */
            var targets = (sess.messages || []).filter(function (m) {
                return m && m.id === messageId;
            });
            if (!targets.length) return null;
            var last = null;
            targets.forEach(function (row) {
                if (!row.deleted) purgeMessageOnlineMirrors(chatId, row);
                /*
                 * ⚠️ 必须用 _patchAllById 而不是 updateMessage：
                 * updateMessage 内部是 findIndex，只改第一条同 id 行。
                 * 脏数据里若有两行同 id，第二条就漏掉了 —— 而收尾的
                 * _dedupeMessages 保留的是靠后那条，于是「删完反而剩一条活的」。
                 */
                last = store._patchAllById(chatId, sessionId, messageId, Object.assign({
                    deleted: true,
                    content: ''
                }, extra || {}));
            });
            /*
             * 清掉重复的死行：软删本身不动数组长度，重复行会一直躺在
             * localStorage 里，每存一次都在放大体积，而且会让后续任何
             * 基于 id 的查找继续歧义。软删后立刻压实。
             */
            store._dedupeMessages(chatId, sessionId);
            /*
             * 回收由这一层写入的记忆表内容 —— 线下侧的对应收口。
             *
             * 记忆表（miya-memory-tables-v1）按 chatId 分桶，线上线下共用同一个桶
             * （线下引擎也是拿线上 chatId 调 MiyaMemoryTableApp）。
             * 但行溯源记的是**线下消息 id**（见 afterGenerate 的 result.message），
             * 因此这里必须用线下消息 id 去回溯，才能命中线下写入的那些行。
             *
             * 为什么必须在本函数收口，而不是在调用方：
             * 线下删除楼层的入口有多个（单条删除、刷新键、removeMessagesFrom
             * 的批量循环），但它们最终**全部**收敛到本函数。
             * 在这一处收口，上面的删除链路不用各改一遍，也不会漏。
             *
             * 位置放在 _dedupeMessages 之后：压实完成后再回收，
             * 避免一边删行一边还在按 id 查找的中间态干扰。
             */
            purgeMemoryRowsBySource(messageId);
            return last;
        },
        /*
         * 把「所有 id 相同的行」都打上同一个 patch（updateMessage 只打第一条）。
         * 返回最后被改的那一条，供调用方沿用旧的返回语义。
         */
        _patchAllById: function (chatId, sessionId, messageId, patch) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess || !Array.isArray(sess.messages)) return null;
            var last = null;
            var touched = false;
            for (var i = 0; i < sess.messages.length; i++) {
                var m = sess.messages[i];
                if (!m || m.id !== messageId) continue;
                sess.messages[i] = normalizeMessage(
                    Object.assign({}, m, patch || {}, { editedAt: Date.now() })
                );
                last = sess.messages[i];
                touched = true;
            }
            if (!touched) return null;
            store._writeSession(sess);
            return last;
        },
        /*
         * 「重回/刷新楼层」专用软删：删之前先把当前正文存成候选锚点。
         *
         * 为什么不能直接用 deleteMessage：
         * 重回的时序是「先软删那一层 → 再让引擎重答」，而 deleteMessage 会
         * 把 content 清成 ''（普通删除应该这样，楼层不该再显示旧文本）。
         * 但引擎随后要读 lastAsst.content 来补第一条候选：
         *     var prevSwipes = lastAsst.swipes || [];
         *     if (!prevSwipes.length && lastAsst.content) prevSwipes.push(content);
         * 内容已被清空，这句就永远不成立 —— 于是**第一次刷新**时候选表里
         * 只有新刷出来那一条（swipes.length === 1），而右下角的 ‹ › 需要
         * 「至少两条候选」才渲染（offlineSwipeBarHtml 里的 swipes.length < 2）。
         * 用户的体感正是：刷新后既没有切换键，原来的内容也再也找不回来了。
         * 第二次之后能翻，是因为那时 swipes 里已经有上一轮留下的文本。
         *
         * 所以这里在清空正文之前，先把它归档进 swipes[0] 当作对照锚点，
         * 这样「原版 / 历次刷新 / 最新」三者从第一次起就都在。
         */
        softDeleteForRegenerate: function (chatId, sessionId, messageId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess || !Array.isArray(sess.messages)) return null;
            var row = null;
            for (var i = 0; i < sess.messages.length; i++) {
                if (sess.messages[i] && sess.messages[i].id === messageId) {
                    row = sess.messages[i];
                    break;
                }
            }
            if (!row) return null;
            var text = String(row.content || '').trim();
            var swipes = Array.isArray(row.swipes) ? row.swipes.slice() : [];
            /*
             * 记忆标记必须与候选表**同步归档**。
             *
             * 候选表里的每一版都对应一段「它原本要写的记忆」
             * （见 normalizeMessage.swipeMtRaw）。这里把当前正文补进
             * 候选表第 0 位，它的标记也必须跟着补 —— 否则标记数组
             * 与候选表错位，翻回第 1 版确认时补写的会是别的版本的记忆。
             *
             * ⚠️ 为什么补在这里而不是让引擎补：
             *   本函数会**先于**引擎把候选表填好，于是引擎那边
             *   「候选表还空着才补」的判断就不会成立，标记也就跟着漏了。
             *   归档动作发生在哪，归档就要在哪做全 —— 分两处就会漏一处。
             */
            var swipeMtRaw = Array.isArray(row.swipeMtRaw) ? row.swipeMtRaw.slice() : [];
            /*
             * 锚点只在「候选表还是空的、且当前有正文」时补一次。
             * 已经有候选说明历次刷新都归档过了，再补会把自己重复塞进去。
             */
            if (!swipes.length && text) {
                swipes.push(text);
                if (!swipeMtRaw.length) swipeMtRaw.push(String(row.mtRaw || ''));
            }
            return store.deleteMessage(chatId, sessionId, messageId, {
                swipes: swipes,
                swipeMtRaw: swipeMtRaw
            });
        },
        /**
         * 重答次数 +1（该楼层被刷新/重回的累计次数）。
         *
         * 与 swipes 解耦：刷新键会显式清空 swipes，若把计数寄存在候选表长度上，
         * 计数会每次归零，导致引擎的「第 N 次重答」提示发不出去 —— 见
         * normalizeMessage 里 regenCount 字段的说明。
         *
         * 在**重答成功写入新内容之后**调用，失败/中止不计数，
         * 这样「连续失败几次再成功」不会虚增序号。
         */
        bumpRegenCount: function (chatId, sessionId, messageId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess || !messageId) return 0;
            var cur = 0;
            (sess.messages || []).forEach(function (m) {
                if (m && m.id === messageId && Number(m.regenCount) > cur) {
                    cur = Math.floor(Number(m.regenCount));
                }
            });
            var next = cur + 1;
            store._patchAllById(chatId, sessionId, messageId, { regenCount: next });
            flushSave();
            return next;
        },
        /** 读取某楼层累计重答次数（无记录返回 0） */
        getRegenCount: function (chatId, sessionId, messageId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess || !messageId) return 0;
            var cur = 0;
            (sess.messages || []).forEach(function (m) {
                if (m && m.id === messageId && Number(m.regenCount) > cur) {
                    cur = Math.floor(Number(m.regenCount));
                }
            });
            return cur;
        },
        syncAllSessionsToChat: function (chatId, contactId) {
            var cid = String(contactId || '').trim();
            var sessions = cid ? store.getSessionsByContact(cid) : store.getSessions(chatId);
            var st = global.miyaChatStore;
            sessions.forEach(function (sess) {
                var targets = sessionCastTargets(sess);
                if (!targets.length) {
                    targets = [{ contactId: cid, chatId: chatId }];
                }
                targets.forEach(function (t) {
                    var tid = String((t && t.chatId) || '').trim();
                    if (!tid) return;
                    var knownMirrors = Object.create(null);
                    if (st && typeof st.getMessagesForApi === 'function') {
                        var apiMsgs = st.getMessagesForApi(tid) || [];
                        for (var i = 0; i < apiMsgs.length; i++) {
                            var row = apiMsgs[i];
                            if (row && row.id && row.offlineMeet && !row.deleted) {
                                knownMirrors[row.id] = row;
                            }
                        }
                    }
                    (sess.messages || []).forEach(function (m) {
                        mirrorMessageToChat(tid, sess, m, {
                            knownMirrors: knownMirrors,
                            targetChatId: tid
                        });
                    });
                });
            });
            flushSave();
        },
        /** 封存后：把本场消息镜像到每一位出演角色的线上线程 */
        syncSessionCastToChats: function (chatId, sessionId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return;
            var st = global.miyaChatStore;
            var targets = sessionCastTargets(sess);
            targets.forEach(function (t) {
                var tid = String((t && t.chatId) || '').trim();
                if (!tid) return;
                var knownMirrors = Object.create(null);
                if (st && typeof st.getMessagesForApi === 'function') {
                    var apiMsgs = st.getMessagesForApi(tid) || [];
                    for (var i = 0; i < apiMsgs.length; i++) {
                        var row = apiMsgs[i];
                        if (row && row.id && row.offlineMeet && !row.deleted) {
                            knownMirrors[row.id] = row;
                        }
                    }
                }
                (sess.messages || []).forEach(function (m) {
                    mirrorMessageToChat(tid, sess, m, {
                        knownMirrors: knownMirrors,
                        targetChatId: tid
                    });
                });
            });
            flushSave();
            return targets;
        },
        getSessionCastTargets: sessionCastTargets,
        getStatusBar: function () {
            return normalizeStatusBar(load().statusBar);
        },
        saveStatusBar: function (patch) {
            load();
            cache.statusBar = normalizeStatusBar(Object.assign({}, cache.statusBar, patch || {}));
            save();
            return cache.statusBar;
        },
        getSessionMessages: function (chatId, sessionId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return [];
            return (sess.messages || []).filter(function (m) {
                return m && !m.deleted && String(m.content || '').trim();
            });
        },
        addSummary: function (chatId, sessionId, row) {
            return store.replaceOrAddSummary(chatId, sessionId, row);
        },
        /** 同范围总结会替换/合并，供手动与自动总结写入该时刻上下文 */
        replaceOrAddSummary: function (chatId, sessionId, row) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            var patch = row && typeof row === 'object' ? row : {};
            var start = clampInt(patch.startIndex, 1, 9999999, 0);
            var end = clampInt(patch.endIndex, 1, 9999999, 0);
            if (!start || !end || end < start) return null;
            var keepId = String(patch.id || '').trim();
            sess.summaryList = (sess.summaryList || []).filter(function (r) {
                if (!r) return false;
                if (keepId && r.id === keepId) return false;
                return !summaryRangesOverlap(r.startIndex, r.endIndex, start, end);
            });
            var sum = normalizeSummary(
                Object.assign(
                    { id: keepId || uid('sum'), createdAt: Date.now() },
                    patch,
                    { startIndex: start, endIndex: end }
                )
            );
            if (!sum) return null;
            sess.summaryList.push(sum);
            store._writeSession(sess);
            return sum;
        },
        updateSummary: function (chatId, sessionId, summaryId, patch) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return null;
            var idx = (sess.summaryList || []).findIndex(function (r) {
                return r.id === summaryId;
            });
            if (idx < 0) return null;
            sess.summaryList[idx] = normalizeSummary(
                Object.assign({}, sess.summaryList[idx], patch || {}, { editedAt: Date.now() })
            );
            store._writeSession(sess);
            return sess.summaryList[idx];
        },
        deleteSummary: function (chatId, sessionId, summaryId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return false;
            var before = (sess.summaryList || []).length;
            sess.summaryList = (sess.summaryList || []).filter(function (r) {
                return r.id !== summaryId;
            });
            if (sess.summaryList.length === before) return false;
            store._writeSession(sess);
            return true;
        },
        getSessionSummaries: function (chatId, sessionId) {
            var sess = store.getSession(chatId, sessionId);
            if (!sess) return [];
            return (sess.summaryList || []).slice().sort(function (a, b) {
                return (a.endIndex || 0) - (b.endIndex || 0);
            });
        },
        lastSummaryEnd: lastSummaryEnd,
        deleteSession: function (chatId, sessionId) {
            var sid = String(sessionId || '').trim();
            if (!sid) return;
            load();
            var sess = store.getSession(chatId, sid);
            /*
             * 宿主桶里找不到时，**先去别的桶把真身捞出来**，再退化到空壳。
             *
             * 原实现直接构造 {id, chatId, messages: []}，丢掉两样东西：
             *   · 真实 chatId —— 第一路 mark(primary, chatMirrorId) 会指向错误线程，
             *     镜像软删打空；
             *   · messages   —— 第一路整个失效（没有 chatMirrorId 可点名）。
             * 于是只剩「按 appointmentSessionId 全库扫」一条路可走，而那条路
             * 对 appointmentSessionId 缺失的历史数据又无效 —— 镜像留在原处，
             * 后续 recoverSessionsFromChatMirrors 还会把它复活成卷宗。
             *
             * 真实场景确实会出现桶不匹配：migrateSessionsToCanonicalChat 会把
             * 卷宗搬到 canonical chat 下，UI 若还拿着旧 chatId 调删除就会落空。
             */
            if (!sess) {
                Object.keys(cache.byChat || {}).some(function (key) {
                    var bucket = cache.byChat[key];
                    if (!bucket || !Array.isArray(bucket.sessions)) return false;
                    var found = bucket.sessions.filter(function (s) {
                        return s && String(s.id) === sid;
                    })[0];
                    if (!found) return false;
                    sess = found;
                    /* 用真身自己的 chatId 覆盖，保证第一路点到正确线程 */
                    return true;
                });
            }
            if (!sess) {
                /* 确实全库都没有：仍按 id 扫全库镜像，避免多人/迁移残留 */
                sess = { id: sid, chatId: chatId, messages: [] };
            }
            /* 彻底删除：线下卷宗 + 线上镜像一并清掉，不再注入上下文 */
            purgeSessionOnlineMirrors(sess);
            retryPendingMirrorDeletes();
            load();
            Object.keys(cache.byChat || {}).forEach(function (key) {
                var bucket = cache.byChat[key];
                if (!bucket || !Array.isArray(bucket.sessions)) return;
                bucket.sessions = bucket.sessions.filter(function (s) { return !s || s.id !== sid; });
                if (bucket.activeSessionId === sid) bucket.activeSessionId = '';
            });
            markSessionTombstone(sid);
            /* 破坏性操作必须强落盘：墓碑若因防抖未落盘就被杀进程，
               recoverSessionsFromChatMirrors 会把已删卷宗复活。 */
            flushSave();
        },
        /*
         * 导入回滚专用：把刚由 importSession 写进去的那一条【干净地】撤回。
         *
         * 为什么不能直接复用 deleteSession：
         *   · deleteSession 是「用户主动删卷宗」的语义，它会同时清线上镜像、
         *     写墓碑、flushSave —— 对一条「刚写入、用户根本没见过的」记录
         *     来说全是多余的副作用，尤其墓碑会污染 tombstone 表；
         *   · 它还允许「找不到就构造空壳」继续往下走，而回滚场景下
         *     找不到就说明本来就没写成功，什么都不该做。
         *
         * 这里只做一件事：在内存桶里按 id 摘掉这条，并把 activeSessionId
         * 从它身上挪开（如果正指着它）。然后强落盘 —— 回滚是破坏性操作，
         * 不能留给防抖，否则进程被杀就会留下「内存里没了、盘上还在」的错位。
         *
         * 只认 id，不认标题，避免误伤用户已有的同名记录。
         */
        discardImportedSession: function (chatId, sessionId) {
            var sid = String(sessionId || '').trim();
            if (!sid) return false;
            load();
            var b = chatBucket(chatId);
            if (!b || !Array.isArray(b.sessions)) return false;
            var before = b.sessions.length;
            b.sessions = b.sessions.filter(function (s) {
                return !(s && String(s.id) === sid);
            });
            if (b.sessions.length === before) return false;
            /* activeSessionId 正指着被撤回的那条时要一并挪开，
               否则会留下悬空指针 —— 后续 getSession 恒取不到。 */
            if (String(b.activeSessionId || '') === sid) {
                b.activeSessionId = b.sessions.length ? String(b.sessions[0].id || '') : '';
            }
            flushSave();
            return true;
        },
        setActiveSession: function (chatId, sessionId) {
            var b = chatBucket(chatId);
            if (!b) return;
            var sid = String(sessionId || '').trim();
            /* 空串语义是「清空当前场次」，合法放行；
               非空时必须校验该卷宗确实存在，否则会写入悬空 activeSessionId —— 
               后续 getSession(chatId, activeSessionId) 恒取不到，
               UI 表现为「明明选了场次却打不开」，且脏数据会一直留在存储里。 */
            if (sid) {
                var exists = (b.sessions || []).some(function (s) {
                    return s && String(s.id) === sid;
                });
                if (!exists) return;
            }
            if (String(b.activeSessionId || '') === sid) return;
            b.activeSessionId = sid;
            save();
        },
        countLiveMessages: countLiveMessages,
        getSessionsByContact: function (contactId) {
            var cid = String(contactId || '').trim();
            if (!cid) return [];
            load();
            var st = global.miyaChatStore;
            var all = [];
            Object.keys(cache.byChat).forEach(function (chatKey) {
                var bucket = cache.byChat[chatKey];
                if (!bucket || !Array.isArray(bucket.sessions)) return;
                bucket.sessions.forEach(function (sess) {
                    if (!sess || countLiveMessages(sess) <= 0) return;
                    var sessCid = String(sess.contactId || '').trim();
                    if (sessCid === cid) {
                        all.push(sess);
                        return;
                    }
                    var cast = Array.isArray(sess.cast) ? sess.cast : [];
                    var inCast = cast.some(function (row) {
                        return row && String(row.contactId || '').trim() === cid;
                    });
                    if (inCast) {
                        all.push(sess);
                        return;
                    }
                    if (!sessCid && st && sess.chatId) {
                        var chat = st.findChat(sess.chatId);
                        if (chat && String(chat.contactId || '').trim() === cid) {
                            all.push(sess);
                        }
                    }
                });
            });
            return all.slice().sort(function (a, b) {
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
        },
        /**
         * 把零散线程上的线下场次归并到「规范聊天」下。
         *
         * v48 收紧（修「聊得好好的会跳到另一个聊天记录的楼里」）：
         * 原实现会把该 contactId 在 **其它所有聊天** 里的场次全部搬到 canonical，
         * 连根拔起、原地不留。于是用户在 chat_B 里正聊着，一进线下就被搬进 chat_A，
         * 表现就是「莫名其妙跳到另一个聊天记录的楼里」，且 chat_B 的内容凭空消失。
         *
         * 现在的规则：只归并「空壳线程」上的场次 —— 即那个 chat 本身几乎没内容
         * （没有线上聊天记录、且离线场次仅此一条）。真正有独立内容的聊天，
         * 其线下场次属于该聊天自己，不再被搬走。
         */
        migrateSessionsToCanonicalChat: function (canonicalChatId, contactId) {
            var canonId = String(canonicalChatId || '').trim();
            var cid = String(contactId || '').trim();
            if (!canonId || !cid) return;
            load();
            var canonical = chatBucket(canonId);
            if (!canonical) return;
            var st = global.miyaChatStore;
            /*
             * 判断一个 chat 是不是「空壳线程」——只有空壳才允许被归并。
             * 判据：该聊天没有线上消息（或拿不到 chatStore 时无法证实有内容，
             * 此时按保守处理：不搬，宁可少归并也不误伤）。
             */
            function isHollowChat(chatKey) {
                if (!st || typeof st.findChat !== 'function') return false;
                var chat = null;
                try { chat = st.findChat(chatKey); } catch (e) { chat = null; }
                /* 聊天已不存在（典型：被删掉的旧线程）—— 属于空壳，可安全归并 */
                if (!chat) return true;
                var n = 0;
                try {
                    if (typeof st.getMessagesForApi === 'function') {
                        n = (st.getMessagesForApi(chatKey) || []).length;
                    }
                } catch (e2) { n = 0; }
                return n === 0;
            }
            var moved = false;
            Object.keys(cache.byChat).forEach(function (chatKey) {
                if (chatKey === canonId) return;
                if (!isHollowChat(chatKey)) return;
                var bucket = cache.byChat[chatKey];
                if (!bucket || !Array.isArray(bucket.sessions)) return;
                var keep = [];
                bucket.sessions.forEach(function (sess) {
                    if (sess && String(sess.contactId || '').trim() === cid) {
                        sess.chatId = canonId;
                        /* 旧线程上的 mirror id 对 canonical 无效，清空以便 sync 重写镜像 */
                        (sess.messages || []).forEach(function (m) {
                            if (m && m.chatMirrorId) m.chatMirrorId = '';
                        });
                        canonical.sessions.push(sess);
                        moved = true;
                    } else {
                        keep.push(sess);
                    }
                });
                bucket.sessions = keep;
            });
            if (moved) {
                flushSave();
                store.syncAllSessionsToChat(canonId, cid);
            }
        },
        exportForMemory: function (chatId, contactIdHint) {
            var contactId = String(contactIdHint || '').trim();
            var st = global.miyaChatStore;
            if (!contactId && st && chatId) {
                var chat = st.findChat(chatId);
                contactId = chat && chat.contactId ? String(chat.contactId).trim() : '';
            }
            var sessions = contactId ? store.getSessionsByContact(contactId) : store.getSessions(chatId);
            return sessions.map(function (sess) {
                return {
                    id: sess.id,
                    createdAt: sess.createdAt,
                    /* 封存已移除：恒为 0，保留字段只为兼容既有读取方 */
                    closedAt: 0,
                    contactId: sess.contactId || contactId,
                    messages: (sess.messages || []).filter(function (m) { return m && !m.deleted; }),
                    summaryList: sess.summaryList || []
                };
            });
        },
        closeActiveSession: function (chatId) {
            /*
             * 封存概念已整体移除：这里不再给场次盖 closedAt，
             * 只把「当前激活场次」清空。
             *
             * 之所以还要保留这个函数：它同时被用于「离开场景时收尾」，
             * 调用方只想要「这一场不再作为当前场次」的效果，
             * 而不是要把它变成只读。把 closedAt 相关分支删掉，
             * 语义反而更贴合调用方的真实意图。
             */
            var b = chatBucket(chatId);
            if (!b || !b.activeSessionId) return null;
            var sess = store.getSession(chatId, b.activeSessionId);
            b.activeSessionId = '';
            flushSave();
            return sess;
        },
        /*
         * 墓碑查询对外开口。
         *
         * 为什么必须开这个口子：
         *   「删掉卷宗后，AI 仍然读得到里面的内容」这个现象，根子在
         *   镜像过滤（MiyaAppointmentMemory.shouldKeepOfflineMirror）
         *   **只看「卷宗是否还活着且带总结区间」**。而 exportForMemory
         *   只返回活着的卷宗，于是删完之后过滤器查不到任何区间，
         *   把「没有区间」误当成「无需过滤」，把所有镜像一律放行 ——
         *   删除动作反而让内容更容易进 API，完全反直觉。
         *
         *   墓碑（deletedSessionIds）是删除动作留下的**物理事实**，
         *   与卷宗是否还在列表里无关。让过滤器能直接读到它，
         *   才能把「已删」与「从未总结」这两种语义分开。
         */
        isSessionTombstoned: function (sessionId) {
            var sid = String(sessionId || '').trim();
            if (!sid) return false;
            load();
            return isSessionTombstoned(sid);
        },
        getDeletedSessionIds: function () {
            load();
            var map = currentTombstoneMap();
            return Object.keys(map || {});
        },
        flushSave: flushSave,
        invalidateCache: function () { cache = null; }
    };

    global.MiyaAppointmentStore = store;

    if (global.miyaRegisterPagehideFlush) {
        global.miyaRegisterPagehideFlush(function (opts) {
            if (!(cache && _hydrated)) return;
            if (opts && opts.urgent === false) {
                scheduleSave();
                return;
            }
            flushSave();
        });
    }

    if (global.miyaRegisterKvStore) {
        global.miyaRegisterKvStore({
            whenReady: ensureHydrated
        });
    }
})(window);
