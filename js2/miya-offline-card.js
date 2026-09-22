/**
 * 线下楼层 · 通用卡片渲染器（可复用 / 自适应原卡）
 *
 * 设计目标
 *   1. 可复用：不绑定任何单一角色卡。任何卡只要在回复里输出
 *      <card>...</card> 或 [类型|字段|字段] 结构，都能渲染成卡片。
 *   2. 自适应原卡：不使用 iframe（iframe 会隔离 CSS 变量，反而无法继承主题），
 *      直接内联 DOM，颜色/字体/字号全部走线下已有的 --xw-* 变量，
 *      于是自动跟随博物馆 / 手账 / 自定义等任意主题。
 *   3. 不抢风头：所有样式都是「透明底 + 继承字体 + 变量描边」，
 *      原卡若提供了配色就跟随，没提供就退化成最朴素的中性样式。
 *
 * 解析逻辑与视觉样式完全解耦：
 *   本模块只负责「把结构化文本变成语义化的 DOM」，
 *   长什么样交给线下主题的 CSS 变量决定，所以换卡不用改这里。
 */
(function (global) {
    'use strict';

    /* ── 触发标记 ─────────────────────────────────────────── */
    var BLOCK_TAGS = ['card'];

    function buildBlockRegex(tag) {
        return new RegExp('<' + tag + '\\s*>([\\s\\S]*?)(?:<\\s*\\/\\s*' + tag + '\\s*>|$)', 'gi');
    }

    function hasCardBlock(rawText) {
        var txt = String(rawText || '');
        if (!txt) return false;
        for (var i = 0; i < BLOCK_TAGS.length; i++) {
            var re = new RegExp('<\\s*' + BLOCK_TAGS[i] + '\\s*>', 'i');
            if (re.test(txt)) return true;
        }
        return false;
    }

    /**
     * 取出所有卡片段。
     * @returns {Array<{raw:string, body:string, before:string, after:string}>}
     */
    function extractCardParts(rawText) {
        var txt = String(rawText || '');
        if (!txt) return [];
        var out = [];
        var seen = [];
        BLOCK_TAGS.forEach(function (tag) {
            var re = buildBlockRegex(tag);
            var m;
            while ((m = re.exec(txt)) !== null) {
                var full = m[0];
                var at = m.index;
                /* 同一段文字可能被多个标签正则命中，按起始位置去重 */
                var dup = seen.some(function (s) { return s.at === at; });
                if (!dup) {
                    seen.push({ at: at, end: at + full.length });
                    out.push({
                        raw: full,
                        body: String(m[1] || '').trim(),
                        before: txt.slice(0, at).trim(),
                        after: txt.slice(at + full.length).trim()
                    });
                }
                if (m.index === re.lastIndex) re.lastIndex++;
            }
        });
        out.sort(function (a, b) { return a.raw.length - b.raw.length; });
        /* 只保留最外层（长度最大的那条覆盖范围通常最准），其余按位置排 */
        out.sort(function (a, b) {
            var ia = txt.indexOf(a.raw);
            var ib = txt.indexOf(b.raw);
            return ia - ib;
        });
        return out;
    }

    /* 从回复里剥掉卡片标记，留下正文 */
    function stripCardFromText(rawText) {
        var txt = String(rawText || '');
        if (!txt) return '';
        var parts = extractCardParts(txt);
        if (!parts.length) return txt;
        var first = parts[0];
        return [first.before, first.after].filter(Boolean).join('\n').trim();
    }

    /* ── 解析 ───────────────────────────────────────────────
       [类型|字段1|字段2|...] → 区块
       已知类型给语义化字段名；未知类型自动降级为「标题 + 字段列表」，
       于是别的卡自定义的类型也能显示出来，不会丢内容。 */

    /* 每种类型对应一组字段名。字段数量不匹配时多余的部分忽略、缺的部分留空。 */
    /*
     * 字段表。key = 类型名（小写），value = 该类型按顺序的字段名。
     *
     * ⚠️ 关于 choice（剧情建议）：
     * 与其余类型的关键区别 —— **这一条是可点的**。
     * 点一下就把文本当作自己的发言发出去（见 appointment-app 的
     * root 点击委托里 [data-mi-choice] 分支）。
     *   text = 建议正文（点击后真正发出去的内容）
     *   hint = 可选的一句话补充，只用于展示，不参与发送
     */
    var SCHEMA = {
        profile:      ['name', 'title', 'level', 'fame', 'quote'],
        pinned:       ['emoji', 'tag', 'title', 'desc', 'cue'],
        card:         ['category', 'title', 'desc', 'cue'],
        npc:          ['name', 'tag', 'impression', 'heart'],
        mail:         ['sender', 'date', 'subject', 'body', 'sign', 'giftName', 'giftNote'],
        mainquest:    ['title', 'progress', 'desc', 'reward'],
        sidequest:    ['title', 'progress', 'desc', 'reward'],
        todo:         ['done', 'text'],
        post:         ['author', 'role', 'title', 'desc'],
        reply:        ['author', 'time', 'text'],
        choice:       ['text', 'hint']
    };

    /* 类型 → 归属的分区。未知类型统一进「更多」，保证不丢内容。 */
    var GROUP_OF = {
        profile: 'profile',
        pinned: 'pinned',
        card: 'intel',
        npc: 'npc',
        mail: 'mail',
        mainquest: 'quest',
        sidequest: 'quest',
        todo: 'todo',
        post: 'board',
        reply: 'board',
        choice: 'choice'
    };

    /* 分区标题。可被卡片自己的 [Section|key|标题] 覆盖。 */
    var DEFAULT_SECTIONS = {
        intel: '情报',
        npc: '人物',
        mail: '信件',
        quest: '任务',
        todo: '待办',
        board: '公告',
        choice: '剧情建议',
        more: '更多'
    };

    function parseCardBlocks(rawText) {
        var text = String(rawText || '');
        /* 去掉思考块，避免把思维链里的方括号也当成数据 */
        var clean = text.replace(/^[\s\S]*?<\/(?:think|thinking)>/i, '').trim();
        var blocks = [];
        var cur = '';
        var depth = 0;
        var i, ch;
        for (i = 0; i < clean.length; i++) {
            ch = clean.charAt(i);
            if (ch === '[') {
                if (depth > 0) cur += ch;
                depth++;
            } else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    if (cur.trim()) blocks.push(cur);
                    cur = '';
                } else if (depth > 0) {
                    cur += ch;
                } else {
                    depth = 0;
                }
            } else if (depth > 0) {
                cur += ch;
            }
        }
        return blocks;
    }

    /* 分区标题的常见写法：[Intel] [NPCs] [Quests] ...
       这类行没有 | ，容易和未知类型混淆。统一映射到内部分区 key。 */
    var SECTION_ALIAS = {
        intro: 'intel', intel: 'intel', intels: 'intel', info: 'intel',
        npc: 'npc', npcs: 'npc', characters: 'npc', cast: 'npc',
        mail: 'mail', mails: 'mail', letters: 'mail',
        quest: 'quest', quests: 'quest', task: 'quest', tasks: 'quest',
        todo: 'todo', todos: 'todo', checklist: 'todo',
        board: 'board', boards: 'board', posts: 'board', notice: 'board',
        /*
         * 剧情建议。必须登记，否则 [Choices] 这行会走「未知题材」分支 ——
         * 标题虽然保留下来，但 __cursor 会指向一个不在 GROUP_OF 里的 key，
         * 后续 [Choice|…] 条目反而落不进去，四条建议会集体消失。
         */
        choice: 'choice', choices: 'choice', options: 'choice', option: 'choice'
    };

    function parseCard(rawText) {
        var blocks = parseCardBlocks(rawText);
        var out = { profile: null, pinned: null, sections: {}, order: [], unknown: [] };

        blocks.forEach(function (blockStr) {
            var parts = blockStr.split('|').map(function (s) { return String(s == null ? '' : s).trim(); });
            var header = (parts[0] || '').toLowerCase();
            var fields = parts.slice(1);

            /* 纯分区标题行：[Intel] [NPCs] —— 没有字段，只用来声明分区。
               中文标题也会走这里，作为自定义分区名保留。
               连续出现时以后者为准，便于卡片自定义题材（如「其他线索」）。 */
            if (parts.length === 1 && header) {
                var alias = SECTION_ALIAS[header];
                var key = alias || header;
                if (!out.sections[key]) {
                    out.sections[key] = DEFAULT_SECTIONS[key] || (alias ? DEFAULT_SECTIONS[alias] : '') || parts[0];
                }
                if (out.order.indexOf(key) < 0) out.order.push(key);
                if (!out.sections.__items) out.sections.__items = {};
                if (!out.sections.__items[key]) out.sections.__items[key] = [];
                /* 未知题材的分区：记住标题，供后续未知类型条目归入 */
                if (!alias) out.__declaredMore = parts[0];
                /*
                 * 记住「当前声明中的分区」。后续条目优先落进这里，
                 * 而不是按类型重新归类 —— 否则卡片自己分的区会被类型名覆盖掉：
                 * 比如 [其他线索] 下面放 [Card|…]，Card 属于情报组，
                 * 就会把这批内容抢回「情报」分区，卡片的分区意图被抹掉。
                 */
                out.__cursor = key;
                return;
            }

            /* 卡片自己声明分区标题：[Section|intel|自定义标题] */
            if (header === 'section') {
                var skey = (fields[0] || '').toLowerCase();
                if (skey) {
                    out.sections[skey] = fields[1] || DEFAULT_SECTIONS[skey] || skey;
                    if (out.order.indexOf(skey) < 0) out.order.push(skey);
                    if (!out.sections.__items) out.sections.__items = {};
                    if (!out.sections.__items[skey]) out.sections.__items[skey] = [];
                }
                return;
            }

            var schema = SCHEMA[header];
            var item = { __type: header, __raw: fields };

            if (schema) {
                schema.forEach(function (k, idx) { item[k] = fields[idx] || ''; });
            } else {
                /* 未知类型：首个字段当标题，其余按「字段 N」列出 */
                item.title = fields[0] || header;
                item.__extra = fields.slice(1);
            }

            if (header === 'profile') { out.profile = item; return; }
            if (header === 'pinned') { out.pinned = item; return; }

            var group = GROUP_OF[header] || 'more';
            /*
             * 卡片显式分过区（有 __cursor）时，条目就落进当前分区，
             * 不再按类型重新归类 —— 尊重卡片自己的分区意图。
             * 仅在条目直接出现在 <card> 顶层（无任何分区声明）时才走类型归类。
             */
            if (out.__cursor) group = out.__cursor;
            /* 若是首次进入 'more' 且卡片自己声明过中文分区名，就用那个名字，
               避免自定义题材（如「其他线索」）被统一吞成"更多"。 */
            if (!out.sections[group]) {
                out.sections[group] = DEFAULT_SECTIONS[group] || group;
                if (group === 'more') {
                    var declared = out.__declaredMore;
                    if (declared) out.sections[group] = declared;
                }
            }
            if (out.order.indexOf(group) < 0) out.order.push(group);
            if (!out.sections.__items) out.sections.__items = {};
            if (!out.sections.__items[group]) out.sections.__items[group] = [];
            out.sections.__items[group].push(item);
        });

        /* 每个分区若没有任何条目，就从顺序里剔除，避免出现空标签页 */
        out.order = out.order.filter(function (g) {
            return out.sections.__items && out.sections.__items[g] && out.sections.__items[g].length;
        });
        return out;
    }

    /* ── 渲染 ─────────────────────────────────────────────── */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escAttr(s) {
        return esc(s).replace(/'/g, '&#39;');
    }

    /* 头像：优先用给定的 URL；没有就用名字首字。这样不依赖某张卡的固定头像表。 */
    function avatarHtml(url, name) {
        var u = String(url || '').trim();
        var n = String(name || '').trim();
        if (u) {
            return '<span class="xwc__ava"><img src="' + escAttr(u) + '" alt="" loading="lazy"' +
                ' onerror="this.style.display=\'none\'"></span>';
        }
        return '<span class="xwc__ava xwc__ava--txt">' + esc(n.slice(0, 1) || '?') + '</span>';
    }

    function rowHtml(label, value) {
        if (!String(value || '').trim()) return '';
        return '<div class="xwc__row"><span class="xwc__row-k">' + esc(label) + '</span>' +
            '<span class="xwc__row-v">' + esc(value) + '</span></div>';
    }

    function itemHtml(item) {
        var t = item.__type;

        if (t === 'pinned') {
            return '<div class="xwc__item xwc__item--pinned">' +
                (item.emoji ? '<span class="xwc__item-emoji">' + esc(item.emoji) + '</span>' : '') +
                '<div class="xwc__item-main">' +
                (item.tag ? '<span class="xwc__tag">' + esc(item.tag) + '</span>' : '') +
                '<div class="xwc__item-title">' + esc(item.title) + '</div>' +
                (item.desc ? '<div class="xwc__item-desc">' + esc(item.desc) + '</div>' : '') +
                (item.cue ? '<div class="xwc__item-cue">' + esc(item.cue) + '</div>' : '') +
                '</div></div>';
        }

        if (t === 'npc') {
            return '<div class="xwc__item xwc__item--npc">' +
                avatarHtml('', item.name) +
                '<div class="xwc__item-main">' +
                '<div class="xwc__item-head"><span class="xwc__item-title">' + esc(item.name) + '</span>' +
                (item.tag ? '<span class="xwc__tag">' + esc(item.tag) + '</span>' : '') + '</div>' +
                (item.impression ? '<div class="xwc__item-desc">' + esc(item.impression) + '</div>' : '') +
                (item.heart ? '<div class="xwc__item-cue">' + esc(item.heart) + '</div>' : '') +
                '</div></div>';
        }

        if (t === 'mail') {
            return '<div class="xwc__item xwc__item--mail">' +
                '<div class="xwc__item-head"><span class="xwc__item-title">' + esc(item.subject) + '</span>' +
                (item.date ? '<span class="xwc__tag">' + esc(item.date) + '</span>' : '') + '</div>' +
                (item.sender ? '<div class="xwc__item-desc">来自 ' + esc(item.sender) + '</div>' : '') +
                (item.body ? '<div class="xwc__item-body">' + esc(item.body) + '</div>' : '') +
                rowHtml('附赠', [item.giftName, item.giftNote].filter(Boolean).join(' · ')) +
                (item.sign ? '<div class="xwc__item-cue">' + esc(item.sign) + '</div>' : '') +
                '</div>';
        }

        if (t === 'mainquest' || t === 'sidequest') {
            return '<div class="xwc__item xwc__item--quest">' +
                '<div class="xwc__item-head"><span class="xwc__item-title">' + esc(item.title) + '</span>' +
                (item.progress ? '<span class="xwc__tag">' + esc(item.progress) + '</span>' : '') + '</div>' +
                (item.desc ? '<div class="xwc__item-desc">' + esc(item.desc) + '</div>' : '') +
                (item.reward ? '<div class="xwc__item-cue">奖励：' + esc(item.reward) + '</div>' : '') +
                '</div>';
        }

        if (t === 'todo') {
            /*
             * done 的判定放宽：模型可能给 0/1、true/false、√/×、是/否……
             * 只认数字 1 太窄，会把「已完成」误显示成未完成。
             */
            var raw = String(item.done == null ? '' : item.done).trim().toLowerCase();
            var isDone = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y'
                || raw === 'done' || raw === '√' || raw === '✓' || raw === '✔'
                || raw === '是' || raw === '已完成' || raw === '完成';
            return '<div class="xwc__item xwc__item--todo' + (isDone ? ' is-done' : '') + '">' +
                '<span class="xwc__dot"></span>' +
                '<span class="xwc__todo-text">' + esc(item.text) + '</span></div>';
        }

        if (t === 'post') {
            return '<div class="xwc__item xwc__item--post">' +
                '<div class="xwc__item-head"><span class="xwc__item-title">' + esc(item.title) + '</span>' +
                (item.role ? '<span class="xwc__tag">' + esc(item.role) + '</span>' : '') + '</div>' +
                (item.desc ? '<div class="xwc__item-desc">' + esc(item.desc) + '</div>' : '') +
                (item.author ? '<div class="xwc__item-cue">—— ' + esc(item.author) + '</div>' : '') +
                '</div>';
        }

        if (t === 'reply') {
            return '<div class="xwc__item xwc__item--reply">' +
                '<div class="xwc__item-head"><span class="xwc__item-title">' + esc(item.author) + '</span>' +
                (item.time ? '<span class="xwc__tag">' + esc(item.time) + '</span>' : '') + '</div>' +
                (item.text ? '<div class="xwc__item-body">' + esc(item.text) + '</div>' : '') +
                '</div>';
        }

        if (t === 'card') {
            return '<div class="xwc__item xwc__item--card">' +
                '<div class="xwc__item-head">' +
                (item.category ? '<span class="xwc__tag">' + esc(item.category) + '</span>' : '') +
                '<span class="xwc__item-title">' + esc(item.title) + '</span></div>' +
                (item.desc ? '<div class="xwc__item-desc">' + esc(item.desc) + '</div>' : '') +
                (item.cue ? '<div class="xwc__item-cue">' + esc(item.cue) + '</div>' : '') +
                '</div>';
        }

        /*
         * 剧情建议：渲染成**可点的一整行**。
         *
         * 点击后把 text 当作自己的发言发出去（委托在 appointment-app）。
         * 所以这里不能用 div —— 用 button 才有原生键盘可达性
         * （Tab 焦点、Enter/Space 触发），也不必自己补 tabindex/role。
         *
         * ⚠️ 放进属性的是 escAttr 转义过的文本，不是原文：
         * 建议里出现引号 / 尖括号（很常见，比如「他说：『好』」）
         * 会直接破坏 HTML 结构，甚至把后半段解析成标签。
         * 委托那边读的是 dataset，取回来就是原文，无需再反转义。
         *
         * 不需要「第几条」这种索引：发送内容就是 text 本身，
         * 索引除了让 HTML 变复杂之外没有用处。
         */
        if (t === 'choice') {
            var ctext = String(item.text || '').trim();
            if (!ctext) return '';
            return '<button type="button" class="xwc__choice" data-mi-choice="' + escAttr(ctext) + '">' +
                '<span class="xwc__choice-text">' + esc(ctext) + '</span>' +
                (item.hint ? '<span class="xwc__choice-hint">' + esc(item.hint) + '</span>' : '') +
                '</button>';
        }

        /* 未知类型：标题 + 字段列表，保证内容不丢 */
        var extra = (item.__extra || []).filter(function (x) { return String(x || '').trim(); });
        return '<div class="xwc__item">' +
            '<div class="xwc__item-title">' + esc(item.title) + '</div>' +
            (extra.length ? '<div class="xwc__item-desc">' + extra.map(esc).join(' · ') + '</div>' : '') +
            '</div>';
    }

    /**
     * 渲染卡片主体（内联 DOM，不带 iframe）。
     * @param {string} rawBody 卡片标记内部的原始文本
     * @returns {string} HTML
     */
    function renderCardBody(rawBody) {
        var data = parseCard(rawBody);
        var html = '';

        /* 顶部：身份 + 箴言。字段缺失就不渲染，避免出现空壳。 */
        if (data.profile) {
            var p = data.profile;
            html += '<div class="xwc__profile">' +
                '<div class="xwc__profile-name">' + esc(p.name) + '</div>' +
                '<div class="xwc__profile-meta">' +
                [p.title, p.level, p.fame].filter(Boolean).map(function (x) {
                    return '<span class="xwc__meta-chip">' + esc(x) + '</span>';
                }).join('') +
                '</div>' +
                (p.quote ? '<blockquote class="xwc__quote">' + esc(p.quote) + '</blockquote>' : '') +
                '</div>';
        }

        if (data.pinned) {
            html += '<div class="xwc__pin-wrap">' + itemHtml(data.pinned) + '</div>';
        }

        /* 分区：默认全部平铺展开。
           不做标签页——楼层里需要一眼看完，多一次点击反而更麻烦。 */
        data.order.forEach(function (g) {
            var items = data.sections.__items[g] || [];
            if (!items.length) return;
            var title = data.sections[g] || DEFAULT_SECTIONS[g] || g;
            html += '<section class="xwc__sec">' +
                '<h4 class="xwc__sec-title">' + esc(title) + '</h4>' +
                '<div class="xwc__sec-body">' + items.map(itemHtml).join('') + '</div>' +
                '</section>';
        });

        if (!html) return '';
        return '<div class="xwc" data-xw-card="1">' + html + '</div>';
    }

    global.MiyaOfflineCard = {
        hasCardBlock: hasCardBlock,
        extractCardParts: extractCardParts,
        stripCardFromText: stripCardFromText,
        parseCardBlocks: parseCardBlocks,
        parseCard: parseCard,
        renderCardBody: renderCardBody,
        SECTIONS: DEFAULT_SECTIONS
    };
})(window);
