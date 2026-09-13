/**
 * 群聊事件账本（Group Ledger）。
 *
 * 解决什么：
 *   群聊原本是一条封闭线程 —— 群里演完就没了，不留任何后续影响。
 *   本模块在群聊到一段落时，把它压成「事件账本」存进该群 chatSettings.groupLedger，
 *   之后各成员的【单聊】上下文就能读到自己在群里经历过的事。
 *
 * 为什么不能直接搬消息：
 *   群聊是多角色共享一条线程。若整段灌给单聊的 A，A 会「看到」你跟 B、C 的对话 ——
 *   而 A 根本不在场。这是致命穿帮。
 *   所以账本分两层：
 *     · eventText  —— 客观事件（全体在场成员共享，说法一致）
 *     · perMember  —— 每个角色一句私人视角（只发给本人）
 *   B 拿不到 A 的内心活动；A 挡了话，B 只知道「自己被顶了」，那是推测不是读取。
 *   顺带天然制造信息差 —— 这正是群聊独有的戏。
 *
 * 生命周期：
 *   账本存在 chatSettings[群chatId] 里，随 chat 对象一起活。
 *   群解散（deleteChat 删掉整个 chat）即自动清空 —— 无需额外代码。
 *   加人 / 踢人都不清账本，因为账本的生命周期 = 群的生命周期。
 */
(function (global) {
    'use strict';

    var LEDGER_FIELD = 'groupLedger';
    var MAX_ITEMS = 30;

    /* ------------------------------------------------------------------ *
     * 基础工具
     * ------------------------------------------------------------------ */

    function clampInt(v, lo, hi, fallback) {
        var n = parseInt(v, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(hi, Math.max(lo, n));
    }

    function newLedgerId() {
        return 'gle_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function trim(t) {
        return String(t == null ? '' : t).trim();
    }

    function getApiConfig() {
        if (typeof global.miyaGetApiConfigCached === 'function') return global.miyaGetApiConfigCached();
        return {};
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

    function extractText(data) {
        if (!data) return '';
        if (data.choices && data.choices[0]) {
            var ch = data.choices[0];
            if (ch.message && ch.message.content != null) return String(ch.message.content).trim();
            if (ch.text != null) return String(ch.text).trim();
        }
        if (data.content != null) return String(data.content).trim();
        return '';
    }

    function toast(msg) {
        if (global.miyaChatApp && typeof global.miyaChatApp.toast === 'function') {
            global.miyaChatApp.toast(msg);
            return;
        }
        try { console.log('[group-ledger]', msg); } catch (e) {}
    }

    function store() { return global.miyaChatStore; }

    function groupMod() { return global.MiyaChatGroup; }

    /* ------------------------------------------------------------------ *
     * 数据读写
     * ------------------------------------------------------------------ */

    function normalizeItem(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var eventText = trim(raw.eventText);
        if (!eventText) return null;
        var perMember = {};
        if (raw.perMember && typeof raw.perMember === 'object') {
            Object.keys(raw.perMember).forEach(function (cid) {
                var v = trim(raw.perMember[cid]);
                if (v) perMember[cid] = v;
            });
        }
        var out = {
            id: trim(raw.id) || newLedgerId(),
            eventText: eventText,
            perMember: perMember,
            startIndex: clampInt(raw.startIndex, 0, 9999999, 0),
            endIndex: clampInt(raw.endIndex, 0, 9999999, 0),
            createdAt: Number(raw.createdAt) || Date.now()
        };
        /*
         * 来源标记必须显式保留。
         * 群聊里封存的和线下回流进来的，都写进同一个账本 —— 但设置页要把两种区分开
         * （"来自群聊" vs "来自线下 · 场景名"），否则用户看到一堆条目根本不知道哪条打哪来。
         * normalizeItem 是白名单构造，这里漏一个字段就会在读盘时被静默丢掉。
         */
        if (trim(raw.source)) out.source = trim(raw.source);
        if (trim(raw.sceneTitle)) out.sceneTitle = trim(raw.sceneTitle);
        return out;
    }

    /** 读出某群的账本（已归一化，按时间正序） */
    function listLedger(chatId) {
        var st = store();
        var cid = trim(chatId);
        if (!st || !cid) return [];
        var chat = st.findChat(cid);
        if (!chat || chat.type !== 'group') return [];
        var settings = st.getChatSettings ? st.getChatSettings(cid) : null;
        var raw = settings && Array.isArray(settings[LEDGER_FIELD]) ? settings[LEDGER_FIELD] : [];
        return raw
            .map(normalizeItem)
            .filter(Boolean)
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    }

    /** 覆盖写入某群账本 */
    function saveLedger(chatId, items) {
        var st = store();
        var cid = trim(chatId);
        if (!st || !cid) return Promise.resolve(false);
        var list = (Array.isArray(items) ? items : [])
            .map(normalizeItem)
            .filter(Boolean)
            .slice(-MAX_ITEMS);
        var patch = {};
        patch[LEDGER_FIELD] = list;
        return st.saveChatSettings(cid, patch).then(function () { return true; });
    }

    /* ------------------------------------------------------------------ *
     * 群成员与在场判定
     * ------------------------------------------------------------------ */

    function groupMembers(chat) {
        var gg = groupMod();
        var st = store();
        if (!gg || !st || !chat) return [];
        if (typeof gg.getMembers !== 'function') return [];
        return gg.getMembers(st, chat) || [];
    }

    /* ------------------------------------------------------------------ *
     * 生成账本
     * ------------------------------------------------------------------ */

    var GENERATE_PROMPT =
        '你是这场群聊的旁观记录者。请针对下面的群聊记录输出两部分内容。\n\n' +
        '【事件】\n' +
        '用一到两句话客观描述刚才发生了什么。只写事实，不写任何人的内心，必须保持中立。\n\n' +
        '【成员视角】\n' +
        '为每一位在场角色，各写一句「他/她此刻的感受与立场」。规则：\n' +
        '1. 只能基于该角色【能观察到】的信息 —— 他没看到、没听到的，不许写。\n' +
        '2. 用第一人称，贴合该角色人设与他和用户的关系。\n' +
        '3. 写出情绪与立场，不要复述事实（事实已在【事件】里）。\n' +
        '4. 每人一句话，不要展开，不要编造新的情节。\n\n' +
        '严格按下面格式输出，不要添加其他说明：\n\n' +
        '【事件】\n' +
        '<一到两句话>\n\n' +
        '【成员视角】\n' +
        '<角色名>: <一句感受>\n' +
        '<角色名>: <一句感受>\n';

    /**
     * 解析模型输出。
     * 容错策略：事件解析不到就整体失败；成员视角解析不到就退化为「只有事件」。
     * 宁可少给私人视角，也不能给错 —— 给错等于穿帮。
     */
    function parseLedgerOutput(text, members) {
        var raw = String(text || '').replace(/\r\n/g, '\n');
        if (!raw.trim()) return null;

        var eventText = '';
        var perMember = {};

        var evIdx = raw.indexOf('【事件】');
        var memIdx = raw.indexOf('【成员视角】');

        if (evIdx >= 0) {
            var evBody = memIdx > evIdx ? raw.slice(evIdx + 4, memIdx) : raw.slice(evIdx + 4);
            eventText = trim(evBody);
        } else {
            /* 模型没按格式来：把它当作纯事件文本兜底，但成员视角就放弃 */
            eventText = trim(raw);
        }
        if (!eventText) return null;

        if (memIdx >= 0) {
            var memBody = raw.slice(memIdx + 6);
            memBody.split('\n').forEach(function (line) {
                var ln = trim(line);
                if (!ln) return;
                /* 支持 "角色名: 内容" / "角色名 ：内容" / "- 角色名: 内容" */
                var m = ln.replace(/^[-*·•]\s*/, '').match(/^([^:：]{1,24})\s*[:：]\s*(.+)$/);
                if (!m) return;
                var label = trim(m[1]);
                var felt = trim(m[2]);
                if (!label || !felt) return;
                var matched = matchMemberByLabel(label, members);
                if (!matched) return;
                perMember[matched.id] = felt;
            });
        }

        return { eventText: eventText, perMember: perMember };
    }

    /** 把模型写的角色名映射回 contact。项目里已有同名逻辑，这里做容错版。 */
    function matchMemberByLabel(label, members) {
        var key = trim(label);
        if (!key) return null;
        var list = Array.isArray(members) ? members : [];
        var i, c, name, remark;
        /* 先精确匹配 */
        for (i = 0; i < list.length; i++) {
            c = list[i];
            if (!c) continue;
            if (trim(c.name) === key) return c;
            if (String(c.id) === key) return c;
        }
        /* 再去掉常见修饰后缀重试（"A（角色）" / "A 的角色"等） */
        var bare = key.replace(/[（(].*?[)）]\s*$/, '').replace(/\s*(的角色|角色|同学|先生|小姐)\s*$/, '').trim();
        if (bare && bare !== key) {
            for (i = 0; i < list.length; i++) {
                c = list[i];
                if (c && trim(c.name) === bare) return c;
            }
        }
        /* 最后做包含匹配，但要求唯一，避免张三/小张三互相误配 */
        var hits = [];
        for (i = 0; i < list.length; i++) {
            c = list[i];
            if (!c) continue;
            name = trim(c.name);
            remark = '';
            if (!name) continue;
            if (name.indexOf(bare || key) >= 0 || (bare || key).indexOf(name) >= 0) hits.push(c);
        }
        return hits.length === 1 ? hits[0] : null;
    }

    var generating = {};

    /**
     * 为某群生成一条账本。
     *
     * opts.start / opts.end：消息楼层范围（1-based，含端点）。
     * 不传则取「上一段账本结束之后 → 末尾」。
     */
    function generateLedger(chatId, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var st = store();
        var gg = groupMod();
        var cid = trim(chatId);
        if (!st || !cid) return Promise.resolve({ ok: false, error: 'store_missing' });

        var chat = st.findChat(cid);
        if (!chat || chat.type !== 'group') return Promise.resolve({ ok: false, error: 'not_group' });

        if (generating[cid]) {
            if (opts.onBusy && typeof opts.onBusy === 'function') opts.onBusy();
            return Promise.resolve({ ok: false, error: 'busy' });
        }

        var members = groupMembers(chat);
        if (members.length < 2) return Promise.resolve({ ok: false, error: 'group_members_missing' });

        var profiles = st.getProfiles ? st.getProfiles() : [];
        var profile =
            profiles.find(function (p) { return p && p.id === chat.profileId; }) ||
            (st.getActiveProfile ? st.getActiveProfile() : null);

        /* 群聊时间线：复用 summary 的 timeline（已排除删除项、已带发言人格式化） */
        var history = [];
        if (gg && typeof gg.formatGroupMessageBody === 'function') {
            history = (st.getMessagesForApi ? st.getMessagesForApi(cid) : st.getMessages(cid) || [])
                .filter(function (m) {
                    return m && !m.deleted && gg.formatGroupMessageBody(m, members, profile, st, cid);
                });
        } else {
            history = (st.getMessagesForApi ? st.getMessagesForApi(cid) : st.getMessages(cid) || [])
                .filter(function (m) { return m && !m.deleted; });
        }
        if (!history.length) return Promise.resolve({ ok: false, error: 'no_history' });

        var existing = listLedger(cid);
        var lastEnd = 0;
        existing.forEach(function (row) {
            if (row.endIndex > lastEnd) lastEnd = row.endIndex;
        });

        var start = clampInt(opts.start, 1, history.length, lastEnd + 1);
        var end = clampInt(opts.end, 1, history.length, history.length);
        start = Math.max(1, Math.min(start, history.length));
        end = Math.max(start, Math.min(end, history.length));
        /*
         * 没有新消息时必须显式拒绝。
         * 上面那行 `end = Math.max(start, ...)` 会把 start > end 静默压成 start === end ——
         * 于是「已经封存到底、再点一次」会重复封存最后一条，页面上多出一条重复账本。
         * 所以这里改用 lastEnd 判空，而不是依赖 start > end。
         */
        if (lastEnd >= history.length) {
            return Promise.resolve({ ok: false, error: 'empty_range' });
        }
        if (start > end) return Promise.resolve({ ok: false, error: 'empty_range' });

        var excerpt = history
            .slice(start - 1, end)
            .map(function (m) { return gg.formatGroupMessageBody(m, members, profile, st, cid); })
            .filter(Boolean)
            .join('\n');
        if (!excerpt) return Promise.resolve({ ok: false, error: 'empty_excerpt' });

        /* 生成也走「对话 API」：按用户要求沿用聊天 API，不另配总结 API */
        var cfg = getApiConfig();
        var base = normalizeBaseUrl(cfg.baseUrl);
        var apiKey = String(cfg.apiKey || '').trim();
        var model = String(cfg.model || '').trim();
        if (!base || !apiKey || !model) return Promise.resolve({ ok: false, error: 'api_missing' });

        var memberRoster = members
            .map(function (c) { return '- ' + (trim(c.name) || c.id); })
            .join('\n');
        var promptText =
            GENERATE_PROMPT +
            '\n本场在场角色名单（成员视角必须覆盖这些名字，逐一填写）：\n' +
            memberRoster +
            '\n\n群聊记录：\n' +
            excerpt;

        generating[cid] = true;
        var messages = [{ role: 'user', content: promptText }];
        var eng = global.miyaChatEngine;
        if (eng && typeof eng.prependUniversalWorldbookMessage === 'function') {
            messages = eng.prependUniversalWorldbookMessage(messages);
        }

        return fetch(base + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + apiKey
            },
            body: JSON.stringify({
                model: model,
                temperature: 0.5,
                messages: messages
            })
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                var text = extractText(data);
                if (!text) throw new Error('empty_reply');
                var parsed = parseLedgerOutput(text, members);
                if (!parsed) throw new Error('parse_failed');
                var row = normalizeItem({
                    id: newLedgerId(),
                    eventText: parsed.eventText,
                    perMember: parsed.perMember,
                    startIndex: start,
                    endIndex: end,
                    createdAt: Date.now()
                });
                if (!row) throw new Error('normalize_failed');
                return saveLedger(cid, existing.concat([row])).then(function () {
                    return {
                        ok: true,
                        item: row,
                        hasPerMember: Object.keys(row.perMember).length > 0,
                        start: start,
                        end: end
                    };
                });
            })
            .catch(function (err) {
                return { ok: false, error: (err && err.message) || 'failed' };
            })
            .then(function (res) {
                delete generating[cid];
                return res;
            });
    }

    /* ------------------------------------------------------------------ *
     * 单聊注入
     * ------------------------------------------------------------------ */

    /**
     * 某联系人「有群聊记忆」的所有群。
     *
     * 判据是【账本里有没有他的 perMember 视角】，而不是【他当前在不在 memberIds】。
     *
     * 为什么这么定：按用户规则，账本生命周期 = 群的生命周期，只有「群解散」才清空。
     * 若按当前成员过滤，踢人就会让被踢者当场失忆 —— 那等于用踢人把记忆删了，
     * 与「只有解散才清」的规则相悖。被踢的人继续记得群里的事（甚至念念不忘），
     * 是刻意保留的戏剧性。
     *
     * 反过来说：新加入的成员对入群前的账本没有 perMember 记录，自然就看不到 ——
     * 这正好符合「被加了人也不该突然全知」的直觉，无需额外的入群时间字段。
     */
    function groupChatsForContact(contactId) {
        var st = store();
        var cid = trim(contactId);
        if (!st || !cid) return [];
        var chats = st.getChats ? st.getChats() : [];
        return (chats || []).filter(function (ch) {
            if (!ch || ch.type !== 'group') return false;
            var items = listLedger(ch.id);
            return items.some(function (row) {
                return !!(row.perMember && trim(row.perMember[cid]));
            });
        });
    }

    function formatTs(ts) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return '';
        try {
            return new Date(t).toLocaleString('zh-CN', { hour12: false });
        } catch (e) {
            return '';
        }
    }

    /**
     * 该联系人的【群聊记忆】系统块（给单聊注入用）。
     *
     * 可见性（严格防穿帮）：
     *   ① 有 perMember[cid] 的条目 —— 他在场，且这是他自己那份视角。必给。
     *   ② 没有 perMember[cid] 但他是当前成员 —— 说明模型当时漏写了他的视角。
     *      只给客观事件，不给任何别人的内心。宁可少给，也不能让他读到别人的私密感受。
     *   ③ 既没视角又不是当前成员 —— 完全不知道，跳过。
     *
     * 加人 / 踢人都不清账本，账本随群生命周期走（只有群解散才清）。
     */
    function buildLedgerBlockForContact(contactId, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var limit = clampInt(opts.limit, 1, 20, 3);
        var cid = trim(contactId);
        if (!cid) return '';
        var st = store();
        if (!st) return '';

        var chats = st.getChats ? st.getChats() : [];
        chats = (chats || []).filter(function (ch) { return ch && ch.type === 'group'; });
        if (!chats.length) return '';

        var lines = [];
        chats.forEach(function (chat) {
            var items = listLedger(chat.id);
            if (!items.length) return;
            var isCurrentMember = (Array.isArray(chat.memberIds) ? chat.memberIds : []).some(function (x) {
                return String(x) === cid;
            });
            var recent = items.slice(-limit);
            var groupName = trim(chat.name) || '群聊';
            recent.forEach(function (row) {
                var felt = trim(row.perMember && row.perMember[cid]);
                /* 情形 ③：既无视角又不在群 —— 完全不知情 */
                if (!felt && !isCurrentMember) return;
                var ts = formatTs(row.createdAt);
                lines.push('〔' + groupName + (ts ? ' · ' + ts : '') + '〕');
                lines.push('- 当时群里：' + row.eventText);
                if (felt) lines.push('- 你的反应：' + felt);
            });
        });

        if (!lines.length) return '';
        return '【群聊记忆】\n' + lines.join('\n');
    }

    /* ------------------------------------------------------------------ *
     * 线下场次回流
     * ------------------------------------------------------------------ */

    /** 本场线下里「真实发生过」的楼层（滤掉已删、开场白、纯系统） */
    function offlineLiveTurns(sess) {
        var msgs = Array.isArray(sess && sess.messages) ? sess.messages : [];
        return msgs.filter(function (m) {
            if (!m || m.deleted || m.hidden) return false;
            var role = String(m.role || '');
            if (role === 'system') return false;
            if (trim(m.type) === 'opening') return false;
            return !!trim(m.content);
        });
    }

    /**
     * 把一场线下（群来源）沉淀成群账本。
     *
     * 与 generateLedger 的区别：
     *   那条路是「读群里的聊天记录 → 让模型总结」；
     *   这条路是「读线下场次的正文 → 让模型总结」，再把结果并进同一个账本。
     *   两条路写的是同一份账本（同一个 groupLedger 字段、同一个 MAX_ITEMS 上限），
     *   所以群里其他人之后的单聊里能看到「他们几个下线下去干了什么」。
     *
     * 为什么也要经过模型而不是直接塞原文：
     *   线下是小说体，整段塞进单聊会瞬间撑爆上下文，而且其中的心理描写属于
     *   全体在场角色的私密内容 —— 必须切片。perMember 只写给该角色自己。
     *
     * 失败不抛错、不阻塞关闭：账本是增强功能，不该拦住用户退出线下。
     * 返回 Promise<{ok, error?, item?}>，调用方可以 .catch 兜底。
     */
    function syncFromOfflineSession(groupChatId, sess) {
        var st = store();
        var gg = groupMod();
        var gid = trim(groupChatId);
        if (!st || !gid) return Promise.resolve({ ok: false, error: 'store_missing' });

        var chat = st.findChat(gid);
        if (!chat || chat.type !== 'group') return Promise.resolve({ ok: false, error: 'not_group' });
        if (!sess || typeof sess !== 'object') return Promise.resolve({ ok: false, error: 'no_session' });

        /* 没内容就不写，避免「进去看一眼就退出」产生空账本 */
        var turns = offlineLiveTurns(sess);
        if (!turns.length) return Promise.resolve({ ok: false, error: 'empty_session' });

        var members = groupMembers(chat);
        if (members.length < 2) return Promise.resolve({ ok: false, error: 'group_members_missing' });

        var cfg = getApiConfig();
        var base = normalizeBaseUrl(cfg.baseUrl);
        var apiKey = String(cfg.apiKey || '').trim();
        var model = String(cfg.model || '').trim();
        if (!base || !apiKey || !model) return Promise.resolve({ ok: false, error: 'api_missing' });

        var sceneTitle = trim(sess.title) || trim(chat.name) || '线下场景';
        var excerpt = turns
            .map(function (m) {
                return (m.role === 'assistant' ? '角色：' : '我：') + trim(m.content);
            })
            .join('\n');

        var memberRoster = members
            .map(function (c) { return '- ' + (trim(c.name) || c.id); })
            .join('\n');

        var promptText =
            '你是这场线下剧情的旁观记录者。下面记录的是几位角色与用户一起离线外出时发生的事。\n' +
            '请针对这段剧情输出两部分内容。\n\n' +
            '【事件】\n' +
            '用一到两句话客观描述你们这次一起出去做了什么、发生了什么关键转折。只写事实，保持中立。\n\n' +
            '【成员视角】\n' +
            '为每一位在场角色，各写一句「他/她此刻的感受与立场」。规则：\n' +
            '1. 只能基于该角色【能观察到】的信息 —— 他没看到、没听到的，不许写。\n' +
            '2. 用第一人称，贴合该角色人设与他和用户的关系。\n' +
            '3. 写出情绪与立场，不要复述事实（事实已在【事件】里）。\n' +
            '4. 每人一句话，不要展开，不要编造新的情节。\n\n' +
            '严格按下面格式输出，不要添加其他说明：\n\n' +
            '【事件】\n' +
            '<一到两句话>\n\n' +
            '【成员视角】\n' +
            '<角色名>: <一句感受>\n' +
            '<角色名>: <一句感受>\n\n' +
            '本场在场角色名单（成员视角必须覆盖这些名字，逐一填写）：\n' +
            memberRoster +
            '\n\n线下剧情记录（场景：' + sceneTitle + '）：\n' +
            excerpt;

        var messages = [{ role: 'user', content: promptText }];
        var eng = global.miyaChatEngine;
        if (eng && typeof eng.prependUniversalWorldbookMessage === 'function') {
            messages = eng.prependUniversalWorldbookMessage(messages);
        }

        return fetch(base + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + apiKey
            },
            body: JSON.stringify({
                model: model,
                temperature: 0.5,
                messages: messages
            })
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                var text = extractText(data);
                if (!text) throw new Error('empty_reply');
                var parsed = parseLedgerOutput(text, members);
                if (!parsed) throw new Error('parse_failed');

                var existing = listLedger(gid);
                var lastEnd = 0;
                existing.forEach(function (row) {
                    if (row.endIndex > lastEnd) lastEnd = row.endIndex;
                });
                var row = normalizeItem({
                    eventText: parsed.eventText,
                    perMember: parsed.perMember,
                    startIndex: lastEnd + 1,
                    endIndex: lastEnd + turns.length,
                    createdAt: Date.now(),
                    source: 'offline',
                    sceneTitle: sceneTitle
                });
                if (!row) throw new Error('normalize_failed');

                return saveLedger(gid, existing.concat([row])).then(function () {
                    return {
                        ok: true,
                        item: row,
                        hasPerMember: Object.keys(row.perMember).length > 0
                    };
                });
            })
            .catch(function (err) {
                return { ok: false, error: (err && err.message) || 'failed' };
            });
    }

    /* ------------------------------------------------------------------ *
     * 导出
     * ------------------------------------------------------------------ */

    global.MiyaChatGroupLedger = {
        LEDGER_FIELD: LEDGER_FIELD,
        listLedger: listLedger,
        saveLedger: saveLedger,
        generateLedger: generateLedger,
        syncFromOfflineSession: syncFromOfflineSession,
        buildLedgerBlockForContact: buildLedgerBlockForContact,
        groupChatsForContact: groupChatsForContact,
        isGenerating: function (chatId) { return !!generating[trim(chatId)]; },
        /* 测试用 */
        _parse: parseLedgerOutput,
        _match: matchMemberByLabel
    };
})(window);
