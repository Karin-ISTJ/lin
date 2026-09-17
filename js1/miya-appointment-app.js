(function (global) {
    'use strict';

    var ui = {
        view: 'story',
        chatId: '',
        contactId: '',
        sessionId: '',
        streamingLines: [],
        streamingRaw: '',
        streamingRevealLen: 0,
        status: 'idle',
        summaryBusy: false,
        catalogNo: '',
        stableStoryKey: '',
        dockCollapsed: false,
        pickSelected: [],
        /* 从群聊进来时记住来源，用于关闭时把本场内容回流成群账本 */
        groupChatId: '',
        sceneTitle: ''
    };

    var streamUi = {
        raf: 0,
        scrollRaf: 0,
        revealRaf: 0,
        paraCount: 0,
        /*
         * 用户是否「贴着底部」。只决定「要不要跟着新内容滚」，
         * 不代表「可以主动抢滚动位置」。
         */
        userPinnedBottom: false,
        /* 用户在这个场景里是否亲手滚动过。没滚过 = 还没表达过立场，
           此时绝不主动改 scrollTop，免得正文一生成完就把人拽到最底下。 */
        userTouchedScroll: false,
        /*
         * 用户的「跟随意图」：他最后一次亲手滚动时，是不是停在底部。
         *
         * 与 userPinnedBottom 的区别很关键：
         *   userPinnedBottom 表达「此刻在哪」，内容增长后就会过时；
         *   userIntendsFollowBottom 表达「他想不想跟最新」，是意图，不过时。
         *
         * 生成结束时内容会从流式片段变成完整正文、高度骤增。
         * 若那时才去量「此刻是否贴底」，本来贴着底的用户也会被判成不贴底，
         * 于是真正的跟随被误伤；反之若直接用可能过期的 pinned=true，
         * 又会把静看的用户拽下去。用意图就同时避开这两个坑。
         * 只在真实手势滚动时更新，程序滚动不参与。
         */
        userIntendsFollowBottom: false,
        /* 进入场景时已由程序定位到最新楼层。它只是一个「视图落点」的记号，
           不等于用户表达了跟随意图——两者必须分开，否则静看也会被拽走。 */
        landedAtLatest: false
    };

    var SCROLL_PIN_THRESHOLD = 72;

    /* 程序滚动后，连续多少帧内把 scroll 事件视作「自己造的」。
       1 帧会被移动端惯性/渲染延迟漏掉，取 6 帧留出安全余量。 */
    var SELF_SCROLL_FRAMES = 6;

    /* 进入场景后的贴底锚定句柄（见 anchorToLatestForAWhile） */
    var enterAnchorRaf = 0;
    var enterAnchorTimer = 0;
    /* 锚定期间挂上的「用户接管」监听清理函数 */
    var enterAnchorDisposers = [];

    /*
     * 能让「入场锚定」立刻收手的用户输入。
     * 必须覆盖触摸/鼠标/滚轮/键盘/触控笔，少一个就会在那个交互方式下卡住。
     */
    var ENTER_ANCHOR_EVENTS = [
        'wheel',
        'touchstart',
        'touchmove',
        'pointerdown',
        'pointermove',
        'mousedown',
        'keydown'
    ];


    /* 统一简约 Ins 线框图标（stroke 1.5 / round） */
    var _I = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
    var ICON_BACK =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5.5L9 12l6.5 6.5" ' + _I + '/></svg>';
    var ICON_EDIT =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5l4 4L8 20H4v-4L14.5 5.5z" ' + _I + '/><path d="M12.5 7.5l4 4" ' + _I + '/></svg>';
    var ICON_DELETE =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M8.5 7l.7 12.2a1.5 1.5 0 0 0 1.5 1.4h2.6a1.5 1.5 0 0 0 1.5-1.4L15.5 7" ' + _I + '/></svg>';
    var ICON_SET =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" ' + _I + '/><path d="M12 3v1.8M12 19.2V21M4.9 4.9l1.3 1.3M17.8 17.8l1.3 1.3M3 12h1.8M19.2 12H21M4.9 19.1l1.3-1.3M17.8 6.2l1.3-1.3" ' + _I + '/></svg>';
    var ICON_ARCHIVE =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5V8z" ' + _I + '/><path d="M3 8l1.8-3.2A1.5 1.5 0 0 1 6.1 4h11.8a1.5 1.5 0 0 1 1.3.8L21 8M10 13h4" ' + _I + '/></svg>';
    var ICON_SEAL =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10A1.5 1.5 0 0 1 18.5 6v14.2l-6.5-3.4-6.5 3.4V6A1.5 1.5 0 0 1 7 4.5z" ' + _I + '/></svg>';
    var ICON_SWITCH =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11M7 7l3-3M7 7l3 3M17 17H6M17 17l-3-3M17 17l-3 3" ' + _I + '/></svg>';
    var ICON_SEARCH =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" ' + _I + '/><path d="M16.2 16.2L21 21" ' + _I + '/></svg>';
    var ICON_MORE =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg>';
    var ICON_STYLE =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.35 4.05L17.5 9l-4.15 1.45L12 14.5l-1.35-4.05L6.5 9l4.15-1.45L12 3.5z" ' + _I + '/><path d="M18.2 14.2l.85 2.55L21.6 17.6l-2.55.85-.85 2.55-.85-2.55-2.55-.85 2.55-.85.85-2.55z" ' + _I + '/></svg>';
    var ICON_BRANCH =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v6a4 4 0 0 0 4 4h6" ' + _I + '/><path d="M15 12l4 3-4 3" ' + _I + '/><path d="M7 5v14" ' + _I + '/></svg>';
    var ICON_EYE =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" ' + _I + '/><circle cx="12" cy="12" r="2.5" ' + _I + '/></svg>';
    /*
     * 闭眼（带斜杠）：表示「这一层当前是隐藏的」。
     * 与 ICON_EYE 成对使用——用户一眼就能分辨楼层状态，不用回想点过几次。
     */
    var ICON_EYE_OFF =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6c1.6 0 3 .4 4.3 1" ' + _I + '/><path d="M20.4 9.2c.7 1 1.1 1.8 1.1 1.8s-3.5 6-9.5 6c-1.2 0-2.3-.2-3.3-.6" ' + _I + '/><path d="M9.9 9.9a2.5 2.5 0 0 0 3.4 3.4" ' + _I + '/><path d="M4 4l16 16" ' + _I + '/></svg>';
    var ICON_PLUS =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" ' + _I + '/></svg>';
    var ICON_EMOJI =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" ' + _I + '/><path d="M9 10.2h.01M15 10.2h.01M8.8 14.4c1.1 1.3 2.3 1.9 3.2 1.9s2.1-.6 3.2-1.9" ' + _I + '/></svg>';
    /*
     * 刷新（顺时针循环箭头）。
     *
     * 原来这里叫 ICON_UNDO，配的是输入框左边的「重回 ↶」键 —— 那个键已移除。
     * 图形本身（回环）正是「重来一遍」的意思，与现在「刷新这一层」的语义对得上，
     * 所以沿用图形、改名归位，挂在楼层工具行的 ↻ 上（见 refreshToolHtml）。
     *
     * ⚠️ 几何修正：旧图形是
     *     M9 8H4.5v4.5            （左边一小段折线）
     *     M5 12.5a7 7 0 1 0 2.1-5 （半径 7 的大弧）
     * 这条弧的弦长只有 5.42，却声明半径 7 —— 弦长不足，浏览器在 24×24 里
     * 只能画出一小块残缺曲线，末端又绕回起点形成闭合，最终糊成一个
     * 「空心破圈」。放大 6 倍看就是一团圆疙瘩，完全读不出「刷新」，
     * 用户因此把它当成一个多余的乱码键。
     *
     * 现在改成标准写法：以 (12,12) 为圆心、r=7 的圆上，
     * 从正上方 (12,5) 逆时针扫 270° 到正左方 (5,12)，
     * 留出右上角 90° 的缺口，再补一个箭头；缺口处就是箭头的着力点，
     * 一眼能认出是「重来一遍」。
     *   A 7 7 0 1 1 5 12  → large-arc=1（大弧 270°）、sweep=1
     */
    var ICON_REFRESH =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5A7 7 0 1 1 5 12" ' + _I + '/><path d="M12 2.2v5.6M9.2 5L12 7.8 14.8 5" ' + _I + '/></svg>';
    var ICON_SEND =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 3.5L10.2 14.2" ' + _I + '/><path d="M21.5 3.5L14.8 21l-3.3-7.5L4 10.2 21.5 3.5z" ' + _I + '/></svg>';
    var ICON_RESEND =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 0 1 12.4-5.7" ' + _I + '/><path d="M19.5 12a7.5 7.5 0 0 1-12.4 5.7" ' + _I + '/><path d="M16.5 3.8V7h-3.2M7.5 20.2V17h3.2" ' + _I + '/></svg>';
    /* 生成中：发送钮变实心方块（与线上聊天室同款语义） */
    var ICON_STOP =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></svg>';

    function $(id) {
        return document.getElementById(id);
    }

    function esc(t) {
        return String(t || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escAttr(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function chatStore() {
        return global.miyaChatStore;
    }

    function apStore() {
        return global.MiyaAppointmentStore;
    }

    function apEngine() {
        return global.MiyaAppointmentEngine;
    }

    function timeEventsApi() {
        return global.MiyaChatTimeEvents;
    }

    /**
     * 现实时钟事件账本挂在聊天设置上（与线上同一份数据），
     * 所以线下读写的 key 必须是 chatId，不能用 sessionId。
     * 没有 chatId（还没绑定联系人）时不做任何事，免得写出一份孤儿账本。
     */
    function timeEventsHtml(chatId, at) {
        var api = timeEventsApi();
        if (!api || typeof api.renderCards !== 'function') return '';
        var id = String(chatId || ui.chatId || '').trim();
        if (!id) return '';
        try {
            return api.renderCards(chatStore(), id, at || Date.now()) || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * 把「现实时钟事件」提示块塞进本次请求的 system 层。
     *
     * 为什么必须在引擎里拼、不能只靠注入函数：
     * 线下 prompt 的最终顺序是
     *   ST 前置 → 线下上下文（本函数所在位置）→ 会话历史 → ST 后置 → 当前 user
     * 只有落在这一层，模型才会把「账本现状」当成世界状态读；
     * 排在历史之后会被历史覆盖，排在最前又会被后面的世界书冲淡。
     *
     * 注意这里【不】判断 appointmentMode：线下本身就是 appointment 流程，
     * 线上引擎那边是靠这个开关避免把账本重复注入两次，
     * 线下没有这条路径，直接注入即可。
     */
    function buildTimeEventsContext(chatId, at) {
        var api = timeEventsApi();
        if (!api || typeof api.buildPromptContext !== 'function') return '';
        var id = String(chatId || '').trim();
        if (!id) return '';
        try {
            return api.buildPromptContext(chatStore(), id, at || Date.now()) || '';
        } catch (e) {
            return '';
        }
    }

    function dialog(opts) {
        if (global.miyaDialog) {
            if (opts.mode === 'prompt' && global.miyaDialog.prompt) return global.miyaDialog.prompt(opts);
            if (opts.mode === 'confirm' && global.miyaDialog.confirm) return global.miyaDialog.confirm(opts);
            if (global.miyaDialog.alert) return global.miyaDialog.alert(opts);
        }
        if (opts.mode === 'prompt') return Promise.resolve(prompt(opts.message || '', opts.defaultValue || ''));
        if (opts.mode === 'confirm') return Promise.resolve(confirm((opts.title || '') + '\n' + (opts.message || '')));
        return Promise.resolve(true);
    }

    function toast(msg) {
        var el = $('xw-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'xw-toast';
            el.className = 'xw-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('is-show');
        clearTimeout(el._t);
        el._t = setTimeout(function () {
            el.classList.remove('is-show');
        }, 2200);
    }

    function formatTs(ts) {
        try {
            return new Date(ts || Date.now()).toLocaleString('zh-CN', { hour12: false });
        } catch (e) {
            return '';
        }
    }

    function isJournalTheme() {
        var app = document.getElementById('miya-offline-app');
        return !!(app && app.classList.contains('xw-theme-korean'));
    }

    function activeContact() {
        var st = chatStore();
        var chat = st && ui.chatId && st.findChat(ui.chatId);
        return chat && st.findContact(chat.contactId);
    }

    /** 当前场次出演名单（含单人兜底） */
    function activeSessionCast() {
        if (!ui.chatId || !ui.sessionId) {
            if (ui.contactId) {
                return [{ contactId: ui.contactId, chatId: ui.chatId || '' }];
            }
            return [];
        }
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess) {
            if (ui.contactId) {
                return [{ contactId: ui.contactId, chatId: ui.chatId || '' }];
            }
            return [];
        }
        var cast = Array.isArray(sess.cast) ? sess.cast : [];
        if (cast.length) return cast;
        var cid = String(sess.contactId || ui.contactId || '').trim();
        if (!cid) return [];
        return [{ contactId: cid, chatId: String(sess.chatId || ui.chatId || '') }];
    }

    function resolveCastContacts(cast) {
        var st = chatStore();
        if (!st) return [];
        var list = [];
        var seen = Object.create(null);
        (Array.isArray(cast) ? cast : []).forEach(function (row) {
            var cid = String((row && row.contactId) || '').trim();
            if (!cid || seen[cid]) return;
            var c = st.findContact(cid);
            if (!c) return;
            seen[cid] = true;
            list.push(c);
        });
        return list;
    }

    /** 导航栏用：最多 max 字，超出加省略号 */
    function ellipsizeChars(text, max) {
        var t = String(text || '').trim();
        var n = Math.max(0, Number(max) || 0);
        if (!n || t.length <= n) return t;
        return t.slice(0, n) + '…';
    }

    function castDisplayName(contacts, maxChars) {
        var joined = (Array.isArray(contacts) ? contacts : [])
            .map(function (c) {
                return characterRealName(c) || '';
            })
            .filter(Boolean)
            .join(' · ');
        if (maxChars == null) return joined;
        return ellipsizeChars(joined, maxChars);
    }

    /** 导航栏头像最多两个 */
    function castFacesHtml(contacts, imgClass, maxFaces) {
        var cls = imgClass || 'xw-cast-face';
        var all = Array.isArray(contacts) ? contacts : [];
        if (!all.length) return '';
        var limit = maxFaces == null ? all.length : Math.max(0, Number(maxFaces) || 0);
        var list = all.slice(0, limit);
        if (!list.length) return '';
        return (
            '<div class="xw-cast-faces" data-n="' +
            String(list.length) +
            '">' +
            list
                .map(function (c, i) {
                    return (
                        '<img class="' +
                        cls +
                        '" src="' +
                        escAttr(contactAvatar(c)) +
                        '" alt="" data-ap-cast-cid="' +
                        escAttr(c && c.id) +
                        '" style="--xw-fi:' +
                        String(i) +
                        '">'
                    );
                })
                .join('') +
            '</div>'
        );
    }

    /** 线下：优先用联系人绑定的用户面具，与引擎 / API 注入一致 */
    function resolveUserProfile() {
        var st = chatStore();
        if (!st) return null;
        var eng = global.MiyaAppointmentEngine;
        var chat = ui.chatId && st.findChat ? st.findChat(ui.chatId) : null;
        var contact = chat && st.findContact ? st.findContact(chat.contactId) : activeContact();
        if (eng && typeof eng.resolveProfileForContact === 'function') {
            return eng.resolveProfileForContact(st, contact, chat);
        }
        var profiles = st.getProfiles ? st.getProfiles() : [];
        var boundId = '';
        if (contact && contact.defaultProfileId) boundId = String(contact.defaultProfileId).trim();
        if (!boundId && chat && chat.profileId) boundId = String(chat.profileId).trim();
        if (boundId) {
            var found = profiles.find(function (p) {
                return p && p.id === boundId;
            });
            if (found) return found;
        }
        return st.getActiveProfile ? st.getActiveProfile() : null;
    }

    function profileAvatar(profile) {
        var st = chatStore();
        if (!profile) return contactAvatar({ name: '我' });
        if (profile.avatar) return profile.avatar;
        if (profile.avatarId && st && st.getCachedBlobUrl) {
            var cached = st.getCachedBlobUrl(profile.avatarId);
            if (cached) return cached;
        }
        return contactAvatar({ name: profile.name || '我' });
    }

    function userAvatar() {
        return profileAvatar(resolveUserProfile());
    }

    function isSvgAvatarSrc(src) {
        return /^data:image\/svg/i.test(String(src || '').trim());
    }

    function applyOfflineContactAvatar(contact, img, url) {
        if (!contact || !img || !url || isSvgAvatarSrc(url)) return;
        img.src = url;
    }

    function hydrateOfflineContactAvatar(contact, img) {
        if (!contact || !img) return;
        var sync = contactAvatar(contact);
        if (sync && !isSvgAvatarSrc(sync)) {
            applyOfflineContactAvatar(contact, img, sync);
            return;
        }
        if (sync) img.src = sync;
        resolveOfflineContactAvatarAsync(contact).then(function (url) {
            applyOfflineContactAvatar(contact, img, url);
        });
    }

    function hydrateOfflineAvatars(root) {
        root = root || $('xw-root');
        if (!root) return;
        var st = chatStore();
        if (!st) return;

        root.querySelectorAll('[data-ap-toggle], [data-ap-contact]').forEach(function (node) {
            var cid =
                node.getAttribute('data-ap-toggle') ||
                node.getAttribute('data-ap-contact') ||
                '';
            var contact = cid && st.findContact ? st.findContact(cid) : null;
            var img =
                node.querySelector('.xw-cast-node__face') ||
                (node.tagName === 'IMG' ? node : null);
            hydrateOfflineContactAvatar(contact, img);
        });

        var contact = activeContact();
        root.querySelectorAll(
            '.xw-journal-bar__ava, img.xw-chat__ava[data-ap-role-ava="1"]'
        ).forEach(function (img) {
            var cid = String(img.getAttribute('data-ap-cast-cid') || '').trim();
            var faceContact = cid && st.findContact ? st.findContact(cid) : contact;
            if (faceContact) hydrateOfflineContactAvatar(faceContact, img);
        });

        var profile = resolveUserProfile();
        if (profile && profile.avatarId && st.getAvatarUrl) {
            var cachedProfile = st.getCachedBlobUrl && st.getCachedBlobUrl(profile.avatarId);
            if (cachedProfile) {
                root.querySelectorAll('img.xw-chat__ava[data-ap-user-ava="1"]').forEach(function (img) {
                    img.src = cachedProfile;
                });
            } else {
                st.getAvatarUrl(profile.avatarId).then(function (url) {
                    if (!url) return;
                    root.querySelectorAll('img.xw-chat__ava[data-ap-user-ava="1"]').forEach(function (img) {
                        img.src = url;
                    });
                });
            }
        }
    }

    function userDisplayName() {
        var profile = resolveUserProfile();
        return String((profile && profile.name) || '我').trim();
    }

    function formatMsgTime(ts) {
        try {
            return new Date(ts || Date.now()).toLocaleString('zh-CN', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } catch (e) {
            return '';
        }
    }

    function formatDateDivider(ts) {
        try {
            var d = new Date(ts || Date.now());
            var date = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
            var time = d.toLocaleString('zh-CN', { hour: 'numeric', minute: '2-digit', hour12: true });
            return date + ' ' + time;
        } catch (e) {
            return '';
        }
    }

    function dayKeyFromTs(ts) {
        try {
            var d = new Date(ts || Date.now());
            return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        } catch (e) {
            return '';
        }
    }

    function findContactsAppAvatar(contact) {
        if (!contact) return '';
        var cs = global.miyaContactsStore;
        if (!cs || typeof cs.findCharacter !== 'function') return '';
        var ids = [
            contact.chronicleId,
            contact.characterId,
            contact.id
        ];
        var i;
        for (i = 0; i < ids.length; i++) {
            var id = String(ids[i] || '').trim();
            if (!id) continue;
            try {
                var row = cs.findCharacter(id);
                var av = row && String(row.avatar || '').trim();
                if (av) return av;
            } catch (e) {}
        }
        return '';
    }

    function contactAvatar(contact) {
        /* 优先：联系人软件上传的头像 */
        var fromContacts = findContactsAppAvatar(contact);
        if (fromContacts) return fromContacts;

        var extras = global.miyaChatRoomExtras;
        if (extras && typeof extras.resolveContactAvatarUrl === 'function') {
            var url = extras.resolveContactAvatarUrl(contact);
            if (url && !isSvgAvatarSrc(url)) return url;
        }
        if (contact && contact.avatar && !isSvgAvatarSrc(contact.avatar)) {
            return contact.avatar;
        }
        var st = chatStore();
        var blobId = String((contact && contact.avatarBlobId) || '').trim();
        if (st && blobId && st.getCachedBlobUrl) {
            var cached = st.getCachedBlobUrl(blobId);
            if (cached) return cached;
        }
        var ch = Array.from(String((contact && contact.name) || '?').trim() || '?')[0];
        return (
            'data:image/svg+xml,' +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="40" fill="#f0e6d8"/>' +
                '<text x="40" y="48" text-anchor="middle" font-family="Georgia,serif" font-size="28" fill="#b88476">' +
                ch +
                '</text></svg>'
            )
        );
    }

    function resolveOfflineContactAvatarAsync(contact) {
        if (!contact) return Promise.resolve('');
        var sync = contactAvatar(contact);
        if (sync && !isSvgAvatarSrc(sync)) return Promise.resolve(sync);
        var extras = global.miyaChatRoomExtras;
        if (extras && typeof extras.resolveContactAvatarUrlAsync === 'function') {
            return extras.resolveContactAvatarUrlAsync(contact).then(function (url) {
                if (url && !isSvgAvatarSrc(url)) return url;
                return findContactsAppAvatar(contact) || sync || '';
            });
        }
        var st = chatStore();
        var blobId = String(contact.avatarBlobId || '').trim();
        if (st && blobId && st.getAvatarUrl) {
            return st.getAvatarUrl(blobId).then(function (url) {
                return url || findContactsAppAvatar(contact) || sync || '';
            });
        }
        return Promise.resolve(findContactsAppAvatar(contact) || sync || '');
    }

    function characterRealName(contact) {
        return String((contact && contact.name) || '未命名').trim();
    }

    /** 已发送或正在生成叙事（不含进入时的空白态） */
    function storyHasContent() {
        if (ui.view !== 'story' || !ui.chatId || !ui.sessionId) return false;
        var msgs = apStore().getSessionMessages(ui.chatId, ui.sessionId);
        if (msgs.length > 0 || ui.streamingLines.length > 0 || ui.status === 'coming') return true;
        /*
         * ⚠️ 还要看「原始会话里有没有行」，不能只看活着的消息。
         *
         * 场景：用户点楼层右下角的 › 刷新某一层。刷新的时序是
         * 「先把那一层软删（存成候选锚点）→ 再让引擎重答」。
         * 如果那一层正好是场上**唯一**的楼层（比如只有一层角色回复，
         * 或生成失败后只剩一条我发的消息），软删之后
         * getSessionMessages() 就返回空数组 —— 上面两行为 false，
         * 于是 storyHasContent() 判假，render() 直接把整个场景
         * **换成了开场白选择页**。
         *
         * 用户的体感正是：「我一刷新，整场戏没了，跳回了选开场白」。
         * 这不是刷新该有的样子 —— 刷新只是要把那一层重生成一遍，
         * 场景本身还在，屏上应当只剩一个「书写中」。
         *
         * 所以这里补一条：只要原始会话里还留有任何一行（软删的行也在
         * 数组里，只是 content 被清空），就认为场景有内容，
         * 从而留在正片视图里等生成回填。
         */
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        var raw = (sess && sess.messages) || [];
        return raw.length > 0;
    }

    function sessionHasUserMessages() {
        var msgs = apStore().getSessionMessages(ui.chatId, ui.sessionId);
        return msgs.some(function (m) {
            return m && m.role === 'user';
        });
    }

    function resendToolHtml(msgId) {
        return (
            '<button type="button" class="xw-block__tool" data-ap-msg-resend="' +
            esc(msgId) +
            '" title="重发" aria-label="重发">' +
            ICON_RESEND +
            '</button>'
        );
    }

    /*
     * 楼层工具行的「刷新」键 —— **当前没有任何楼层渲染它**。
     *
     * ⚠️ 保留这个函数，但别把它挂回工具行。
     *
     * 它经历过两轮删除：
     *   第 1 轮：角色楼层上的 ↻ 与「重发」实测完全等价 → 撤掉。
     *   第 2 轮：「我发的消息」楼层上的 ↻ 与「重发」同样逐字节等价
     *     （都产出 [user:原文][assistant:新楼层]）→ 也撤掉。
     *
     * 两种楼层的工具行现在统一为三枚键：改 / 重发 / 删除。
     * 重试、重答、换版本分别由「重发」和右下角的 › 覆盖。
     *
     * 之所以不把函数和 regenerateAfterUserFloor 一起删掉：
     * 它们是「生成失败后从我的消息层重试」这条语义的唯一完整实现，
     * 留着当备案；真要用时再挂一个入口即可，不用重新推导一遍。
     *
     * keep 参数依旧区分两种语义（见 regenerateFloor 的说明），
     * 但既然没有调用方，它只作为这族能力的参数化入口存在。
     */
    function refreshToolHtml(msgId, keep) {
        var keepVersion = keep !== false;
        var title = keepVersion
            ? '刷新这一层（保留这一版，重新生成）'
            : '刷新这一层（不保留这一版，重新生成）';
        return (
            '<button type="button" class="xw-block__tool" data-ap-msg-refresh="' +
            esc(msgId) +
            '" data-ap-refresh-keep="' +
            (keepVersion ? '1' : '0') +
            '" title="' +
            title +
            '" aria-label="刷新">' +
            ICON_REFRESH +
            '</button>'
        );
    }

    function openingBlockHtml(m, canEdit) {
        var body = String(m.content || '').trim();
        if (!body) return '';
        var tools = '';
        if (canEdit && !sessionHasUserMessages()) {
            tools =
                '<div class="xw-opening__tools">' +
                '<button type="button" class="xw-block__tool xw-block__tool--drop" data-ap-opening-del="' +
                esc(m.id) +
                '" title="移除" aria-label="移除">' +
                ICON_DELETE +
                '</button></div>';
        }
        return (
            '<div class="xw-opening" data-ap-opening-id="' +
            esc(m.id) +
            '">' +
            '<span class="xw-opening__tag">开场白</span>' +
            '<div class="xw-opening__body">' +
            esc(body).replace(/\n/g, '<br>') +
            '</div>' +
            tools +
            '</div>'
        );
    }

    /*
     * 联系人档案里的「开场白」搬到线下用。
     *
     * 背景：线下开场白原本只认 MiyaAppointmentStore.contactOpeningPresets（调参里手动加的），
     * 而「联系人」App 的档案编辑页把开场白存在另一个库（miyaContactsStore.greetings）。
     * 两套数据互不相通，导致在档案里编辑好的开场白，线下「选择开场白」永远看不到。
     *
     * 这里做一层只读桥接：按 chronicleId / characterId / id 找到对应档案，
     * 把 greetings 映射成与预设同构的行（id 加 'ct-greeting:' 前缀，避免与预设 id 撞车）。
     * 桥接行不写库，纯展示；用户选中后同样走 setSessionOpeningMessage 落成开场白消息，
     * 之后由引擎作为【本场线下·开场白】注入 —— 使用体验与调参里加预设完全一致。
     */
    var CT_GREETING_ID_PREFIX = 'ct-greeting:';

    function contactProfileGreetingRows(contact) {
        if (!contact) return [];
        var cs = global.miyaContactsStore;
        if (!cs || typeof cs.findCharacter !== 'function') return [];
        var ids = [contact.chronicleId, contact.characterId, contact.id];
        var row = null;
        for (var i = 0; i < ids.length; i++) {
            var id = String(ids[i] || '').trim();
            if (!id) continue;
            try {
                row = cs.findCharacter(id);
            } catch (e) {
                row = null;
            }
            if (row) break;
        }
        if (!row || !Array.isArray(row.greetings)) return [];
        return row.greetings
            .map(function (text, idx) {
                var body = String(text == null ? '' : text).trim();
                /* 空串是用户故意留的占位，跳过它 —— 但下标 idx 必须保留，
                   否则「首条消息」标签会错位到备选开场头上。 */
                if (!body) return null;
                return {
                    id: CT_GREETING_ID_PREFIX + String(row.id || row.characterId || '') + ':' + String(idx),
                    name: idx === 0 ? '首条消息' : '备选开场 ' + String(idx),
                    content: body,
                    fromProfile: true
                };
            })
            .filter(Boolean);
    }

    /* 线下预设 + 联系人档案开场白，档案的排前面（它是角色卡原生的，优先级更高）。 */
    function openingPresetRowsForContact(contact) {
        var manual =
            contact && apStore().getContactOpeningPresets
                ? apStore().getContactOpeningPresets(contact.id)
                : [];
        var fromProfile = contactProfileGreetingRows(contact);
        if (!fromProfile.length) return manual;
        var seen = Object.create(null);
        var merged = [];
        fromProfile
            .concat(manual)
            .forEach(function (p) {
                if (!p || !p.id || seen[p.id]) return;
                seen[p.id] = true;
                merged.push(p);
            });
        return merged;
    }

    /*
     * 开场白选择：正文默认【完整展示】，不再截成一行省略号。
     *
     * 改版前的问题：列表项把正文压成单行 56 字（.xw-opening-pick__preview 无换行、
     * 无高度），长开场白只剩一个开头，用户必须点下去（＝真的发送、并触发一次生成）
     * 才知道后面写了什么 —— 选错就得整场重来。
     *
     * 现在：
     * - 正文保留原始换行与段落，默认最多 OPENING_PREVIEW_CLAMP 行；
     * - 确实被压住的长开场白，行内给一枚「展开全文 / 收起」，
     *   只切换显示，不发送、不触发任何生成。
     *
     * 注意：展开按钮【不能】靠字数猜，必须量真实高度。
     * 同样的 105 字，全角中文、换行位置、主题字号都会改变实际占几行
     * （实测按字数估会漏判：明明被裁到 5 行，却拿不到展开按钮）。
     * 所以这里先用 CSS 行数兜底，再由 syncOpeningPreviewMore() 在渲染后实测校正。
     */
    var OPENING_PREVIEW_CLAMP = 5;

    /* 先按保守估计渲染，渲染完由实测结果决定按钮去留 */
    function openingPreviewBlock(p) {
        var full = String(p.content || '').trim();
        var body = esc(full).replace(/\n/g, '<br>');
        return (
            '<div class="xw-opening-pick__preview" data-ap-opening-preview style="--xw-preview-clamp:' +
            OPENING_PREVIEW_CLAMP +
            '">' +
            body +
            '</div>' +
            '<button type="button" class="xw-opening-pick__more" data-ap-opening-more aria-expanded="false" hidden>展开全文</button>'
        );
    }

    /**
     * 渲染后实测：正文真的被行数限制压住了才显示「展开全文」。
     *
     * 量的是未展开状态下的 scrollHeight 与 clientHeight 之差。
     * 判定完立刻把按钮切好，避免用户看到闪一下的多余按钮。
     */
    function syncOpeningPreviewMore(scope) {
        var root = scope || document;
        root.querySelectorAll('.xw-opening-pick__item').forEach(function (item) {
            var body = item.querySelector('[data-ap-opening-preview]');
            var more = item.querySelector('[data-ap-opening-more]');
            if (!body || !more) return;
            var clipped = body.scrollHeight > body.clientHeight + 1;
            if (clipped) more.removeAttribute('hidden');
            else more.setAttribute('hidden', '');
        });
    }

    function renderOpeningPicker() {
        var contact = activeContact();
        var name = characterRealName(contact);
        var presets = openingPresetRowsForContact(contact);
        var listHtml = presets.length
            ? '<div class="xw-opening-pick__list">' +
              presets
                  .map(function (p) {
                      return (
                          '<div class="xw-opening-pick__item">' +
                          '<button type="button" class="xw-opening-pick__head" data-ap-apply-opening="' +
                          esc(p.id) +
                          '">' +
                          '<strong class="xw-opening-pick__name">' +
                          esc(p.name) +
                          '</strong>' +
                          '<span class="xw-opening-pick__go">发送</span>' +
                          '</button>' +
                          openingPreviewBlock(p) +
                          '</div>'
                      );
                  })
                  .join('') +
              '</div>'
            : '';
        return (
            '<div class="xw-opening-pick">' +
            '<p class="xw-opening-pick__kicker">与 ' +
            esc(name) +
            ' · 新场景</p>' +
            '<h2 class="xw-opening-pick__title">选择开场白</h2>' +
            '<p class="xw-opening-pick__hint">选一条作为第一楼，系统只会把它摆好，不会自动替你往下生成。</p>' +
            listHtml +
            '</div>'
        );
    }

    function applyOpeningPreset(presetId) {
        var contact = activeContact();
        if (!contact) return;
        /* 走合并列表：档案开场白的 id 带前缀，只有这里才找得到 */
        var presets = openingPresetRowsForContact(contact);
        var preset = presets.find(function (p) {
            return p.id === presetId;
        });
        if (!preset) {
            toast('预设不存在');
            return;
        }
        if (sessionHasUserMessages()) {
            toast('已有对话，不能再改开场白');
            return;
        }
        var row = apStore().setSessionOpeningMessage(ui.chatId, ui.sessionId, {
            content: preset.content,
            openingPresetId: preset.id
        });
        if (!row) {
            toast('开场白未能写入');
            return;
        }
        if (typeof persistAppointmentPresetFromSheet === 'function') {
            try {
                persistAppointmentPresetFromSheet();
            } catch (e) {}
        }
        /*
         * 只落地开场白，【不自动生成二楼】。
         *
         * 以前这里会紧接着 regenerateAppointment()，于是用户刚点完「发送」，
         * 一楼还没看清，角色就已经接了一整段话 —— 想自己接着往下写的人
         * 全被抢先了，而且那一楼还落进了存档、不好收回。
         *
         * 现在选中开场白 = 把这一楼摆好，然后停在原地等你自己动：
         * 想继续就手动点生成，想改就换个预设或直接打字。
         * 落库后 storyHasContent() 自然为真，会切到正文视图显示这一楼。
         */
        render();
        pinScrollToBottom();
        scrollStoryToEnd(true);
        toast('开场白已就位，可继续生成或直接输入');
    }

    function removeSessionOpening(openingId) {
        if (sessionHasUserMessages()) {
            toast('已有对话，不能移除开场白');
            return;
        }
        apStore().deleteMessage(ui.chatId, ui.sessionId, openingId);
        toast('已移除开场白');
        render();
    }

    /*
     * renderSheetOpeningPresetList() 已删除。
     *
     * 它只服务于调参抽屉里那块「开场白预设」面板（列表 + 删除按钮），
     * 而那块面板因为与联系人 App 的档案开场白重复、且挤占抽屉纵向空间，
     * 已从界面上移除 —— 于是这个函数没有任何调用方了。
     *
     * 注意别把它和下面这些混淆，它们【都还在用】：
     *   - renderOpeningPicker()        新场景首屏的「选择开场白」
     *   - openingPresetRowsForContact() 选择器读的数据源
     *   - contactProfileGreetingRows()  联系人档案 greetings 的桥接
     */

    function ensureChatForContact(contactId) {
        var st = chatStore();
        if (!st) return null;
        var contact = st.findContact(contactId);
        if (!contact) return null;
        var existing = st.findChatByContact(contactId, contact.defaultProfileId);
        if (existing) return existing;
        existing = st.findChatByContact(contactId, '');
        if (existing) return existing;
        var profile = resolveUserProfile();
        var created = st.createChat({
            contactId: contactId,
            profileId: contact.defaultProfileId || (profile && profile.id),
            type: 'private'
        });
        if (created && typeof created.then === 'function') return null;
        return created;
    }

    function storyEditDialogOpts(title, message, defaultValue) {
        return {
            mode: 'prompt',
            multiline: true,
            size: 'large',
            rows: 14,
            title: title,
            message: message,
            defaultValue: defaultValue
        };
    }

    function renderBackdrop() {
        if (isJournalTheme()) return renderJournalBackdrop();
        return (
            '<div class="xw-bg" aria-hidden="true">' +
            '<span class="xw-bg__mesh"></span>' +
            '<span class="xw-bg__dots"></span></div>'
        );
    }

    function renderJournalBackdrop() {
        return '<div class="xw-bg xw-bg--journal" aria-hidden="true"></div>';
    }

    function renderVaultBackBtn(extraClass) {
        return (
            '<button type="button" class="xw-vault-back' + (extraClass ? ' ' + extraClass : '') +
            '" id="xw-exit" aria-label="返回">' +
            '<svg width="10" height="18" viewBox="0 0 10 18" fill="none" aria-hidden="true"><path d="M9 1L1 9l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<span>返回</span></button>'
        );
    }

    function isVaultLikeView() {
        return ui.view === 'history';
    }

    function renderExitBtn() {
        if (isJournalTheme()) return '';
        if (isVaultLikeView()) return renderVaultBackBtn('xw-exit');
        return '<button type="button" class="xw-exit" id="xw-exit" aria-label="离开现场">收起</button>';
    }

    /*
     * 楼层范围输入框本体。手帐主题塞进顶栏，素纸/自定义主题没有顶栏，
     * 所以单独渲染成右上角悬浮胶囊（见 renderFloatFloorScope）。
     * 只在正片页出现：卷宗/回顾页不该改动已封存的内容。
     *
     * 「隐藏」「显示」做成两个独立按钮而非一个切换键：
     * 填入范围后按哪个就是哪个，同一个范围连点两次结果不变（幂等），
     * 不会再出现「隐藏了 1 层、显示了 2 层」这种要心算的结果。
     */
    function renderFloorScopeHtml() {
        if (ui.view !== 'story') return '';
        return (
            '<div class="xw-floor-scope">' +
            /* inputmode="numeric" 在手机上只弹数字键盘，想填 “0-1” 连那个连字符都敲不出来；
               改成 text 并把范围写在 placeholder 里，用户才能按提示原样输入。 */
            '<input type="text" class="xw-floor-scope__input" id="xw-floor-scope-input"' +
            ' inputmode="text" enterkeyhint="done" autocomplete="off" spellcheck="false"' +
            ' placeholder="0-1" title="填楼层范围，如 0-1 或 5（支持 0-1,11）"' +
            ' aria-label="楼层范围">' +
            '<button type="button" class="xw-floor-scope__go xw-floor-scope__go--hide" id="xw-floor-scope-hide"' +
            ' title="隐藏范围内楼层（不参与生成）" aria-label="隐藏范围内楼层">' + ICON_EYE_OFF + '</button>' +
            '<button type="button" class="xw-floor-scope__go xw-floor-scope__go--show" id="xw-floor-scope-show"' +
            ' title="显示范围内楼层" aria-label="显示范围内楼层">' + ICON_EYE + '</button>' +
            '</div>'
        );
    }

    /** 非手帐主题：右上角悬浮的范围输入框 */
    function renderFloatFloorScope() {
        if (isJournalTheme()) return '';
        var inner = renderFloorScopeHtml();
        if (!inner) return '';
        return '<div class="xw-floor-scope-float">' + inner + '</div>';
    }

    function renderDockBeautifyBtn() {
        return (
            '<button type="button" class="xw-dock__btn" id="xw-dock-beautify" title="现场样式">' +
            '<span class="xw-dock__glyph">式</span><span class="xw-dock__lbl">样式</span></button>'
        );
    }

    function renderDockExpandBtn() {
        return (
            '<button type="button" class="xw-dock-expand" id="xw-dock-expand" title="展开工具栏" aria-label="展开工具栏">' +
            ICON_PLUS +
            '</button>'
        );
    }

    function syncDockCollapsedUi() {
        var app = document.getElementById('miya-offline-app');
        var collapsed = !isJournalTheme() && !!ui.dockCollapsed;
        if (app) app.classList.toggle('xw-dock-collapsed', collapsed);
        var dock = document.querySelector('#xw-root .xw-dock');
        var expand = $('xw-dock-expand');
        if (dock) {
            dock.classList.toggle('is-collapsed', collapsed);
            dock.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
        }
        if (expand) {
            expand.hidden = !collapsed;
            expand.setAttribute('aria-hidden', collapsed ? 'false' : 'true');
        }
    }

    function setDockCollapsed(collapsed) {
        ui.dockCollapsed = !!collapsed;
        syncDockCollapsedUi();
    }

    function renderDock() {
        // 卷宗相关页面（历史场景列表 / 查看某一卷具体聊天记录）顶部不再放置
        // 样式/回场景等功能按钮，返回改由左上角的「← 返回」按钮（见 renderExitBtn）承担。
        // 现场故事页的三个工具已移到输入栏四角星菜单，这里同样不渲染顶部工具栏。
        return '';
    }

    function renderJournalChrome() {
        var castContacts = resolveCastContacts(activeSessionCast());
        if (!castContacts.length) {
            var one = activeContact();
            if (one) castContacts = [one];
        }
        var showWho = castContacts.length && (ui.view === 'story' || ui.view === 'history');
        var statusLine = '在线';
        if (ui.view === 'history') {
            statusLine = '往日卷宗';
        } else if (castContacts.length > 1) {
            statusLine = String(castContacts.length) + ' 人同场';
        }
        var whoName = castDisplayName(castContacts, 6);
        var whoHtml = showWho
            ? (
                '<div class="xw-journal-bar__who">' +
                castFacesHtml(castContacts, 'xw-journal-bar__ava', 2) +
                '<div class="xw-journal-bar__id">' +
                '<strong class="xw-journal-bar__name" title="' +
                escAttr(castDisplayName(castContacts)) +
                '">' +
                esc(whoName) +
                (castContacts.length === 1 && whoName.indexOf('…') < 0 ? '.' : '') +
                '</strong>' +
                '<span class="xw-journal-bar__status"><i aria-hidden="true"></i>' + esc(statusLine) + '</span></div></div>'
            )
            : '<div class="xw-journal-bar__brand">手帐</div>';

        var isVault = isVaultLikeView();

        // 卷宗页（往日卷宗列表）顶部不再放置样式/调参/卷宗这些功能按钮。
        var toolHtml = '';
        if (!isVault) {
            if (ui.view === 'story' || ui.view === 'history') {
                toolHtml +=
                    '<button type="button" class="xw-journal-bar__ico" id="xw-dock-vault" title="卷宗" aria-label="卷宗">' +
                    ICON_ARCHIVE + '</button>';
            }
            if (ui.view === 'story') {
                toolHtml +=
                    '<button type="button" class="xw-journal-bar__ico" id="xw-dock-prefs" title="调参" aria-label="调参">' +
                    ICON_SET + '</button>';
            }
            toolHtml +=
                '<button type="button" class="xw-journal-bar__ico" id="xw-dock-beautify" title="样式" aria-label="样式">' +
                ICON_STYLE + '</button>';
        }

        /*
         * 楼层范围隐藏：填 3-8 就把第 3~8 层一次切换（隐藏的显示、显示的隐藏）。
         * 只在正片页出现——卷宗/回顾页不该改动已封存的内容。
         */
        var floorScopeHtml = renderFloorScopeHtml();

        // 卷宗页的返回键改为与「聊天设置」一致的「← 返回」样式，放在左上角。
        var backHtml = isVault
            ? renderVaultBackBtn('xw-journal-bar__back')
            : (
                '<button type="button" class="xw-journal-bar__back" id="xw-exit" aria-label="离开">' +
                ICON_BACK + '</button>'
            );

        return (
            '<header class="xw-journal-bar' + (isVault ? ' xw-journal-bar--vault' : '') + '">' +
            backHtml +
            whoHtml +
            /*
             * 右侧区域：楼层范围输入框 + 原有功能按钮。
             * 包一层 __right 让它整体贴右上角；输入框排在按钮左侧，
             * 这样按钮组位置不变，不会因为多一个输入框把「样式/卷宗」挤走。
             */
            ((floorScopeHtml || toolHtml)
                ? '<div class="xw-journal-bar__right">' +
                  (toolHtml ? '<div class="xw-journal-bar__tools">' + toolHtml + '</div>' : '') +
                  floorScopeHtml +
                  '</div>'
                : '') +
            '</header>'
        );
    }

    function renderHistoryRecoverBanner() {
        var st = apStore();
        if (!st || typeof st.previewChatMirrorRecovery !== 'function') return '';
        /*
         * 把 chatId 传进去 —— 判定逻辑靠它做两件事：
         *   1. 只在【这个会话本地一卷都没有】时才提示（避免孤儿镜像造成常驻误报）
         *   2. 查这个会话是否已被用户「不再提示」
         * 不传的话退化为旧口径，那正是横幅之前「一旦出现就消不掉」的原因。
         */
        var preview = st.previewChatMirrorRecovery(ui.chatId);
        if (!preview || (!preview.sessions && !preview.messages)) return '';
        return (
            '<div class="xw-vault-recover">' +
            /*
             * 加一个关闭键。
             *
             * 横幅是「本地空了、线上还有痕迹」时的救援入口，但它毕竟占一整块高度。
             * 用户判断「我不需要这个」的时候，得有个地方能把它收掉 ——
             * 否则只要有残留镜像在，它就永远贴在卷宗页顶上（这正是上一版的毛病）。
             * 关闭是【按会话】记的，不影响别的会话。
             */
            '<button type="button" class="xw-vault-recover__close" data-ap-dismiss-recover aria-label="不再提示">×</button>' +
            '<p class="xw-vault-recover__hint">聊天里仍存着 ' +
            String(preview.messages || 0) +
            ' 条线下镜像，可重建约 ' +
            String(preview.sessions || 0) +
            ' 卷封存记录（即线上 AI 记得的那些剧情）。</p>' +
            '<button type="button" class="xw-btn xw-btn--solid" data-ap-recover-mirrors>从线上记忆恢复</button></div>'
        );
    }

    /** 用户点「不再提示」：记下这个会话不再显示恢复横幅。 */
    function dismissRecoverBanner() {
        var st = apStore();
        if (st && typeof st.dismissMirrorHold === 'function') {
            st.dismissMirrorHold(ui.chatId);
        }
        render();
    }

    function recoverFromOnlineMemory() {
        var st = apStore();
        if (!st || typeof st.restoreFromChatMirrors !== 'function') {
            toast('恢复模块未加载');
            return Promise.resolve();
        }
        toast('正在从线上记忆恢复…');
        return st
            .restoreFromChatMirrors()
            .then(function (res) {
                if (res && res.ok) {
                    toast(
                        '已恢复 ' +
                            String(res.sessions || 0) +
                            ' 卷 · 共 ' +
                            String(res.messages || 0) +
                            ' 条消息'
                    );
                    render();
                    return;
                }
                if (res && res.reason === 'no_mirror') {
                    toast('聊天里没有找到可恢复的线下镜像');
                    return;
                }
                if (res && res.reason === 'already_up_to_date') return;
                toast('封存记录已是最新');
            })
            .catch(function () {
                toast('恢复失败，请稍后再试');
            });
    }

    function renderHistory() {
        var sessions = apStore().getSessions(ui.chatId);
        var recoverBanner = renderHistoryRecoverBanner();
        /*
         * 空的卷宗列表也【必须】渲染顶部工具栏。
         *
         * 以前这里是一句 `if (!sessions.length) return '<p class="xw-empty">…'`，
         * 直接把整块 DOM 提前返回掉了 —— 连带把「新建聊天 / 导入聊天」两个按钮
         * 一起吞了。后果是：一卷都没有的时候，页面上只剩「还没有保存过的场景。」，
         * 而唯一能把内容弄进来的「导入聊天」入口看不见、点不着，
         * 于是永远停在空态里出不来。
         *
         * 现在把工具栏提出来，空态只替换【列表那一段】——
         * 有卷就列卷，没卷就显示提示，工具栏两种情况都在。
         */
        var listHtml = sessions.length
            ? '<div class="xw-vault__list">' +
              sessions
                .map(function (s, i) {
                    var n = (s.messages || []).filter(function (m) {
                        return m && !m.deleted;
                    }).length;
                    var sumN = (s.summaryList || []).length;
                    var castN = Array.isArray(s.cast) ? s.cast.length : 0;
                    /*
                     * 一行一卷：左半边是「什么时候 / 什么名字 / 多厚」，
                     * 右半边是导出与删除。之前是双列卡片，标题被挤成两行、
                     * 时间缩成 10px 小字，扫一眼根本分不清哪卷是哪卷。
                     * 改成通栏一行之后，名字有整行宽度，日期也终于看得清。
                     *
                     * 镜 → 层：和正片正文、顶栏楼层输入框的说法统一。
                     * 同一件东西在不同界面叫两个名字，最容易让人以为
                     * 「镜」和「层」是两种东西。
                     */
                    return (
                        '<article class="xw-vault-row" style="--xw-i:' + String(i) + '">' +
                        '<button type="button" class="xw-vault-row__open" data-ap-view-session="' + esc(s.id) + '">' +
                        '<strong class="xw-vault-row__name">' + esc(s.title || '未命名场景') + '</strong>' +
                        '<span class="xw-vault-row__stat">' +
                        '<time class="xw-vault-row__when">' + esc(formatTs(s.createdAt)) + '</time>' +
                        (castN > 1 ? ' · ' + castN + ' 人' : '') +
                        ' · ' + n + ' 层' +
                        (sumN ? ' · ' + sumN + ' 份纪要' : '') +
                        (s.parentSessionId ? ' · 分支' : '') +
                        '</span></button>' +
                        '<div class="xw-vault-row__acts">' +
                        '<button type="button" class="xw-vault-row__mini" data-ap-rename-session="' + esc(s.id) + '" title="命名此卷">命名</button>' +
                        '<button type="button" class="xw-vault-row__mini" data-ap-export-txt="' + esc(s.id) + '" title="导出 TXT">TXT</button>' +
                        '<button type="button" class="xw-vault-row__mini" data-ap-export-json="' + esc(s.id) + '" title="导出 JSON">JSON</button>' +
                        '<button type="button" class="xw-vault-row__mini xw-vault-row__mini--del" data-ap-del-session="' + esc(s.id) +
                        '" aria-label="删除此卷">删</button></div></article>'
                    );
                })
                .join('') +
              '</div>'
            : '<p class="xw-empty">还没有保存过的场景。' +
              '<br><span class="xw-empty__hint">用上面的「新建聊天」开一段，或「导入聊天」把已有记录搬进来。</span></p>';
        /*
         * 标题只写「聊天记录」四个字。
         *
         * 以前这里拼的是 `角色名 · 聊天记录`，看着像在说「闻述的聊天记录」，
         * 但卷宗列表是整段会话共用的 —— 一卷里可能同时有主角、配角、旁白，
         * 挂某个角色的名字会让人以为是单聊，点进去发现是群戏，反而更迷惑。
         * 角色是谁，顶部那条状态栏已经在显示了，这里重复一遍没有信息量。
         */
        return (
            '<div class="xw-vault">' +
            recoverBanner +
            '<header class="xw-vault__head">' +
            '<h2 class="xw-vault__title">聊天记录</h2>' +
            '<div class="xw-vault__actions">' +
            '<button type="button" class="xw-ribbon__act" id="xw-new-offline-chat">新建聊天</button>' +
            '<button type="button" class="xw-ribbon__act" id="xw-import-offline-chat">导入聊天</button>' +
            '</div></header>' +
            listHtml +
            '</div>'
        );
    }

    function parseThinkingPayload(text) {
        var eng = apEngine();
        if (eng && typeof eng.parseThinkingPayload === 'function') {
            return eng.parseThinkingPayload(text);
        }
        return { thinking: '', content: String(text || '').trim() };
    }

    function resolveShowThinking() {
        if (!ui.chatId) return true;
        var st = chatStore();
        if (!st) return true;
        var chat = st.findChat(ui.chatId);
        if (!chat) return true;
        var preset = apStore().resolvePresetForContact(chat.contactId);
        return !preset || preset.showThinking !== false;
    }

    /**
     * 正文美化是否启用。
     *
     * 【恒为 true】
     * 对应的「正文美化」开关已从调参抽屉移除（见 renderSheet 里那段说明），
     * 这里不再读 preset.textDecor —— 否则以前手动关过的用户，存量数据里
     * 存着 false，而 UI 已没有打开的入口，会永久停在「正文没美化」的状态。
     *
     * 保留这个函数而不是把调用点直接写 true：调用点有好几处（保底回退、
     * 渲染分支等），留一个语义化的名字更好读；日后若想恢复开关，改这里即可。
     */
    function resolveTextDecor() {
        return true;
    }

    function thinkingToggleHtml(thinking, extraAttrs) {
        if (!resolveShowThinking()) return '';
        var t = String(thinking || '').trim();
        if (!t) return '';
        return (
            '<details class="xw-think"' +
            (extraAttrs ? ' ' + extraAttrs : '') +
            '>' +
            '<summary class="xw-think__toggle">展开推理过程</summary>' +
            '<div class="xw-think__body">' +
            esc(t).replace(/\n/g, '<br>') +
            '</div></details>'
        );
    }

    function decodeApHtmlSrcdocB64(encoded) {
        try {
            return decodeURIComponent(escape(atob(String(encoded || ''))));
        } catch (e) {
            return '';
        }
    }

    function encodeApHtmlSrcdocB64(text) {
        try {
            return btoa(unescape(encodeURIComponent(String(text || ''))));
        } catch (e) {
            return '';
        }
    }

    function hydrateAppointmentHtmlPanels(root) {
        if (!root || !root.querySelectorAll) return;
        var frames = root.querySelectorAll('iframe[data-ap-html-iframe="1"]');
        var i;
        for (i = 0; i < frames.length; i++) {
            var frame = frames[i];
            if (!frame || frame.getAttribute('data-ap-html-hydrated') === '1') continue;
            var srcdoc = decodeApHtmlSrcdocB64(frame.getAttribute('data-ap-html-srcdoc-b64'));
            if (!srcdoc) continue;
            try {
                var prev = frame.getAttribute('data-ap-html-blob');
                if (prev) {
                    try {
                        URL.revokeObjectURL(prev);
                    } catch (e0) {}
                }
                var blob = new Blob([srcdoc], { type: 'text/html;charset=utf-8' });
                var burl = URL.createObjectURL(blob);
                frame.src = burl;
                frame.setAttribute('data-ap-html-blob', burl);
                frame.setAttribute('data-ap-html-hydrated', '1');
            } catch (e) {}
        }
    }

    function buildHtmlPanelHtml(raw) {
        var htmlApi = global.MiyaChatHtml;
        var src = String(raw || '').trim();
        if (!src) return '';
        var hp =
            htmlApi && typeof htmlApi.buildHtmlPayloadFromText === 'function'
                ? htmlApi.buildHtmlPayloadFromText(src, true)
                : null;
        if (hp && hp.useIframe && hp.iframeSrcdoc) {
            return (
                '<div class="xw-embed is-interactive" data-ap-html-panel="1">' +
                '<div class="xw-embed__bar">' +
                '<button type="button" class="xw-embed__zoom" data-ap-html-fs="1">放大页面</button>' +
                '</div>' +
                '<iframe class="xw-embed__frame" data-ap-html-iframe="1" data-ap-html-srcdoc-b64="' +
                encodeApHtmlSrcdocB64(hp.iframeSrcdoc) +
                '" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="no-referrer" title="嵌入页面"></iframe>' +
                '</div>'
            );
        }
        var safe = hp && hp.html ? hp.html : esc(src);
        return (
            '<div class="xw-embed" data-ap-html-panel="1">' +
            '<div class="xw-embed__body">' +
            safe +
            '</div></div>'
        );
    }

    function splitStoryParagraphs(text) {
        var body = String(parseThinkingPayload(text).content || '').trim();
        var eng = apEngine();
        if (eng && typeof eng.splitDisplayParagraphs === 'function') {
            var parts = eng.splitDisplayParagraphs(body);
            if (parts.length) return parts;
        }
        var t = body;
        if (!t) return [];
        var blocks = t.split(/\n\s*\n+/).map(function (s) {
            return String(s || '').trim();
        }).filter(Boolean);
        if (blocks.length <= 1 && /\n/.test(t)) {
            var lines = t
                .split(/\n/)
                .map(function (s) {
                    return String(s || '').trim();
                })
                .filter(Boolean);
            if (lines.length > 1) return lines;
        }
        return blocks.length ? blocks : [t];
    }

    function wrapSymbolDecor(html) {
        var decor = global.MiyaOfflineTextDecor;
        if (decor && typeof decor.wrapGlyphs === 'function') return decor.wrapGlyphs(html);
        return String(html || '').replace(
            /([†✞✧*⊹⌂♡✦◇◆☆★])/g,
            '<span class="xw-sym xw-sym--glyph">$1</span>'
        );
    }

    function plainParagraphHtml(text, role) {
        var t = String(text || '').trim();
        if (!t) return '';
        var cls = role === 'user' ? 'xw-txt--mine' : 'xw-txt--theirs';
        return '<p class="xw-txt ' + cls + '">' + esc(t).replace(/\n/g, '<br>') + '</p>';
    }

    function decorateParagraph(text, role) {
        if (!resolveTextDecor()) return plainParagraphHtml(text, role);
        var decor = global.MiyaOfflineTextDecor;
        if (decor && typeof decor.decorateParagraph === 'function') {
            return decor.decorateParagraph(text, role);
        }
        var t = String(text || '').trim();
        if (!t) return '';
        if (/^†|✞|✧|THE SEASON/i.test(t) || (t.length < 48 && /[†✞✧⊹]/.test(t) && !/\*[^*]+\*/.test(t))) {
            return '<p class="xw-txt xw-txt--aside">' + wrapSymbolDecor(esc(t)) + '</p>';
        }
        if (/未接來電|未接来电|⌂|♡/.test(t)) {
            return (
                '<p class="xw-txt xw-txt--callout">' +
                '<span class="xw-sym xw-sym--quote">「</span> ' +
                wrapSymbolDecor(esc(t)) +
                ' <span class="xw-sym xw-sym--quote">」</span></p>'
            );
        }
        var cls = role === 'user' ? 'xw-txt--mine' : 'xw-txt--theirs';
        return '<p class="xw-txt ' + cls + '">' + esc(t).replace(/\n/g, '<br>') + '</p>';
    }

    function journalBodyHtml(m) {
        if (m.renderAsHtml) return buildHtmlPanelHtml(m.htmlRaw || m.content);

        /*
         * 通用卡片：回复里带 <card>…</card> 时，把那一段渲染成卡片，
         * 正文其余部分照常走排版。
         * 卡片是内联 DOM 而非 iframe，所以能直接继承线下主题的 CSS 变量。
         */
        var cardHtml = offlineCardHtmlFor(m.content);
        if (cardHtml) return cardHtml;

        var paras = splitStoryParagraphs(m.content);
        if (!paras.length) return '';
        if (!resolveTextDecor()) {
            var plain = paras
                .map(function (para) {
                    return esc(String(para || '').trim()).replace(/\n/g, '<br>');
                })
                .filter(Boolean)
                .join('<br><br>');
            return plain ? '<div class="xw-chat__text">' + plain + '</div>' : '';
        }
        var decor = global.MiyaOfflineTextDecor;
        if (decor && typeof decor.decorateJournalBody === 'function') {
            return decor.decorateJournalBody(paras);
        }
        var html = paras
            .map(function (para) {
                return esc(String(para || '').trim()).replace(/\n/g, '<br>');
            })
            .filter(Boolean)
            .join('<br><br>');
        return html ? '<div class="xw-chat__text">' + html + '</div>' : '';
    }

    /**
     * 若消息里含卡片标记，返回「正文 + 卡片」的 HTML；否则返回 ''。
     * 正文在前、卡片在后，符合跑楼层时「先读剧情、再看状态」的习惯。
     */
    function offlineCardHtmlFor(rawContent) {
        var api = global.MiyaOfflineCard;
        if (!api || typeof api.hasCardBlock !== 'function') return '';
        var text = String(rawContent || '');
        if (!api.hasCardBlock(text)) return '';
        var parts = api.extractCardParts(text);
        if (!parts.length) return '';
        var first = parts[0];
        var cardBody = '';
        try {
            cardBody = api.renderCardBody(first.body || '');
        } catch (e) {
            cardBody = '';
        }
        var rest = [first.before, first.after].filter(Boolean).join('\n').trim();
        var restHtml = '';
        if (rest) {
            var paras = splitStoryParagraphs(rest);
            var decor = resolveTextDecor() && global.MiyaOfflineTextDecor;
            if (decor && typeof decor.decorateJournalBody === 'function') {
                restHtml = decor.decorateJournalBody(paras);
            } else {
                var flat = paras
                    .map(function (para) { return esc(String(para || '').trim()).replace(/\n/g, '<br>'); })
                    .filter(Boolean)
                    .join('<br><br>');
                restHtml = flat ? '<div class="xw-chat__text">' + flat + '</div>' : '';
            }
        }
        if (!restHtml && !cardBody) return '';
        return restHtml + cardBody;
    }

    function journalMessageBlockHtml(m, canEdit, thinkingHtml) {
        if (m.role === 'system' && m.type === 'opening') {
            return openingBlockHtml(m, canEdit);
        }
        var isUser = m.role === 'user';
        var contact = activeContact();
        var avaUrl = isUser ? userAvatar() : contactAvatar(contact);
        var ava = escAttr(avaUrl);
        var avaAttrs = isUser ? ' data-ap-user-ava="1"' : ' data-ap-role-ava="1"';
        var sign = esc(isUser ? userDisplayName() : characterRealName(contact)) + '.';
        var time = esc(formatMsgTime(m.createdAt || m.timestamp || Date.now()));
        var roleCls = isUser ? 'xw-chat--mine' : 'xw-chat--theirs';
        var body = journalBodyHtml(m);
        if (!body && !thinkingHtml) return '';
        var tools = '';
        if (canEdit) {
            tools =
                '<div class="xw-chat__tools">' +
                '<button type="button" class="xw-block__tool" data-ap-msg-edit="' +
                esc(m.id) +
                '" title="改" aria-label="改">' +
                ICON_EDIT +
                '</button>' +
                resendToolHtml(m.id) +
                /*
                 * ⚠️ 这里**不再**挂第 3 枚刷新键 —— 两种楼层都不挂了。
                 *
                 * 演进过程（两轮都被用户当场抓住，记在这里免得再走回头路）：
                 *
                 *   第 1 轮：两枚 ↻ 同时挂在角色楼层上。实测两者完全等价，
                 *     用户问「我第二个键不就是刷新键？为什么要那个第三个键？」
                 *     → 撤掉角色楼层那枚。
                 *
                 *   第 2 轮：只给「我发的消息」楼层留了一枚 ↻。用户又发现
                 *     「我发消息的这一层也还有两个一样的刷新键」—— 实测
                 *     这一层的「重发」与「刷新」产出也是逐字节相同：
                 *         点重发: [user:原文] [assistant:第 1 版新内容。]
                 *         点刷新: [user:原文] [assistant:第 1 版新内容。]
                 *     都是「保留我这句 → 删掉后面的角色层 → 重新生成一个新楼层」。
                 *     → 用户层这枚也撤掉。
                 *
                 * 所以现在两种楼层都只有三枚键：改 / 重发 / 删除。
                 *
                 * 重试能力没有丢：生成失败时最新楼层停在我的消息上，
                 * 点这一层的「重发」走 redoFromMessage 的 user 分支 ——
                 * 保留原话、只删它之后的楼层、再让引擎接着写，
                 * 正是原来那枚 ↻ 的语义。refreshToolHtml 与
                 * regenerateAfterUserFloor 的实现都保留着（没有其它调用方，
                 * 但删掉会让「重试」这条路径失去唯一的备案），
                 * 只是不再从工具行暴露入口。
                 */
                '<button type="button" class="xw-block__tool xw-block__tool--drop" data-ap-msg-del="' +
                esc(m.id) +
                '" title="删除" aria-label="删除">' +
                ICON_DELETE +
                '</button></div>';
        }
        var deco =
            !isUser
                ? '<span class="xw-chat__deco" aria-hidden="true">' +
                  '<span class="xw-chat__deco-branch"></span></span>'
                : '';
        /*
         * 候选切换键在手帐主题里原来完全缺失 —— 用户刷出来的历史版本
         * 一个都翻不回去。这里跟素纸主题对齐，补在气泡尾部。
         */
        var swipeBar = offlineSwipeBarHtml(m);
        var bubbleInner =
            deco +
            (isUser
                ? '<span class="xw-chat__sign">' + sign + '</span>'
                : '<span class="xw-chat__quote" aria-hidden="true">“</span>') +
            (thinkingHtml ? '<div class="xw-chat__think">' + thinkingHtml + '</div>' : '') +
            body +
            '<time class="xw-chat__time">' +
            time +
            (isUser ? '<span class="xw-chat__ticks" aria-hidden="true">✓✓</span>' : '') +
            '</time>' +
            /*
             * 和素纸主题同一个结构：工具靠左、候选切换靠右，
             * 由 .xw-chat__foot 这个 flex 行统一管布局。
             */
            '<div class="xw-chat__foot">' +
            tools +
            swipeBar +
            '</div>';
        var attrs =
            ' data-ap-msg-id="' + esc(m.id) + '" data-ap-msg-role="' + esc(m.role) + '"' +
            (canEdit ? ' tabindex="0"' : '');
        if (isUser) {
            return (
                '<div class="xw-chat ' + roleCls + '"' + attrs + '>' +
                '<div class="xw-chat__frame">' +
                '<div class="xw-chat__bubble">' + bubbleInner + '</div>' +
                '<img class="xw-chat__ava"' + avaAttrs + ' src="' + ava + '" alt="">' +
                '</div></div>'
            );
        }
        return (
            '<div class="xw-chat ' + roleCls + '"' + attrs + '>' +
            '<div class="xw-chat__frame">' +
            '<img class="xw-chat__ava"' + avaAttrs + ' src="' + ava + '" alt="">' +
            '<div class="xw-chat__bubble">' + bubbleInner + '</div>' +
            '</div></div>'
        );
    }


    /**
     * 楼层右下角的候选切换键。
     *
     * 三种形态（括号里是 › 此刻真正会做的事，写进 title 提示）：
     *
     *   只有 1 条内容（还没刷过）  →  只显示 [›]（点上 = 生成新的一版）
     *   有 2 条以上、不在最后一版  →  [‹ 2 / 3 ›]（› = 翻到下一版）
     *   有 2 条以上、已在最后一版  →  [‹ 2 / 3 ›]（› = 生成新的一版）
     *   生成中                     →  按钮置灰、禁止重复点击
     *
     * 为什么要区分「生成」和「翻看」：
     * 旧实现是「候选不足两条就什么都不显示」，于是刚生成出来的那一层
     * 右下角干干净净，用户根本不知道还能再刷一版 —— 想换个说法只能
     * 去点上方的「重回」，而那个按钮的语义是「让角色重答这一轮」，
     * 藏得也深。
     *
     * 现在把入口摆在这一层自己的右下角：先给一个 [›]，点一下生成；
     * 攒够两条之后它自然变成 [‹ N/M ›]，继续翻。
     * 「生成」和「翻看」共用同一个键，但**不再靠候选数量猜**，
     * 而是看当前位置：只有站在最后一版（或只有一版）时，往右才是生成。
     *
     * 这个区分对用户是直观的：还有下一版就翻过去，翻到头了再往右
     * 就是「多来一版」。title 会跟着当前语义变，鼠标一悬停就知道
     * 这一下点下去是翻页还是重刷。
     */
    function offlineSwipeBarHtml(m) {
        if (!m || m.role !== 'assistant') return '';
        /*
         * 空内容不渲染：这一层正在生成中（正文还没落下来），
         * 或者刚被软删待重写。此时给它一个 › 是没有意义的。
         */
        if (!String(m.content || '').trim()) return '';
        var pos = swipePosition(m);
        var swipes = pos.swipes;
        var total = pos.total;
        var sid = pos.sid;
        var mid = esc(m.id);
        var atLast = total < 2 || sid >= total - 1;

        /*
         * 单键形态：还没翻过，也没有候选可翻。
         * 这一枚 › 的唯一含义就是生成。
         */
        if (total < 2) {
            return (
                '<div class="xw-swipe xw-swipe--single" data-ap-swipe="' + mid + '">' +
                '<button type="button" class="xw-swipe__btn" data-ap-swipe-next="' + mid + '"' +
                ' aria-label="再生成一版" title="再生成一版">›</button>' +
                '</div>'
            );
        }

        /*
         * 双键形态。› 的 title 随位置切换 ——
         * 这两句提示是用户唯一能分辨「翻页 / 重刷」的地方，
         * 不能两边都写成模糊的「下一个」。
         */
        var nextTitle = atLast ? '再生成一版（保留这一版）' : '下一个候选';
        var prevTitle = sid <= 0 ? '已经是最早的一版' : '上一个候选';
        return (
            '<div class="xw-swipe" data-ap-swipe="' + mid + '">' +
            '<button type="button" class="xw-swipe__btn" data-ap-swipe-prev="' + mid + '" aria-label="上一个候选" title="' + prevTitle + '">‹</button>' +
            '<span class="xw-swipe__idx">' + (sid + 1) + ' / ' + total + '</span>' +
            '<button type="button" class="xw-swipe__btn" data-ap-swipe-next="' + mid + '" aria-label="' + nextTitle + '" title="' + nextTitle + '">›</button>' +
            '</div>'
        );
    }

    /**
     * 读一层楼的候选位置：候选表、总版数、当前第几版。
     *
     * total 用 `swipes.length || 1` 而不是 `swipes.length`：
     * 候选表可能还是空的（这一层从没刷过），但**当前正文本身就是第 1 版**，
     * 只是还没归档进 swipes。按「1 条」算，渲染和翻页判断才不会各自跑偏。
     *
     * 抽成公共助手是因为这个换算要在两处保持一致：
     * offlineSwipeBarHtml 决定画什么键，applyOfflineSwipe 决定点下去做什么。
     * 早先两边各写一遍，任何一边改动都容易让「显示的」和「实际做的」错位。
     */
    function swipePosition(m) {
        var swipes = m && Array.isArray(m.swipes) ? m.swipes : [];
        var total = swipes.length || 1;
        var sid = Number(m && m.swipeId);
        if (!Number.isFinite(sid)) sid = swipes.length ? swipes.length - 1 : 0;
        sid = Math.max(0, Math.min(total - 1, Math.floor(sid)));
        return { swipes: swipes, total: total, sid: sid };
    }

    /**
     * 处理楼层右下角候选键的点击。
     *
     * delta = -1 是 ‹，delta = +1 是 ›。
     *
     * 这里是「翻看」与「生成」的分岔口：
     *
     *   · 候选 ≥ 2：› 落在已有序号范围内 → 纯翻看，改 content / swipeId 后重绘；
     *   · 候选 ≥ 2 且当前已在**最后一版**：› 不再是翻看，而是**再生成一版**
     *     （这与「只有一条时点 ›」是同一件事，只是入口不同）；
     *   · 候选 < 2：› 只能是生成。
     *   · ‹ 永远只翻看，不会触发生成。
     *
     * 这样处理之后，右下角那一个 › 键就同时承担了「多来一版」和
     * 「看下一版」两件事，用户不需要去理解两种模式的区别。
     */
    function applyOfflineSwipe(msgId, delta) {
        var aps = global.MiyaAppointmentStore;
        if (!aps || !ui.chatId || !ui.sessionId) return;
        var sess = aps.getSession(ui.chatId, ui.sessionId);
        if (!sess) return;
        var m = (sess.messages || []).find(function (x) { return x && x.id === msgId; });
        if (!m) return;
        var pos = swipePosition(m);
        var swipes = pos.swipes;
        var total = pos.total;
        var sid = pos.sid;

        /*
         * ── 分岔：› 到底该生成还是该翻页 ──
         *
         * 判据是**当前站在候选表的哪一端**，而不是简单的「有没有下一版」。
         *
         *   只有一版时点 ›：没有别的候选可翻，用户想看「另一版」→ 生成。
         *   已在最后一版时点 ›：同样没有更靠后的了 → 生成新的一版。
         *   已在第一版时点 ›：还有旧候选可翻 → 老老实实翻页。
         *
         * 「已在第一版」这一支原先是**生成**（条件写的是 sid>=total-1，
         * 而 total<2 时两端重合，才掩盖了这个分支的问题）。这次明确成
         * 「滚动而非生成」，好处是 ‹ › 真的变成一条首尾相接的环：
         * 从头往右翻能一路看到最新，翻到底往右才追加新版。
         *
         * 注意这里生成时**保留旧版**（regenerateFloor 的 keepVersion
         * 不传即 true）：› 对用户的承诺始终是「多留一版给我翻」，
         * 和删除键旁边那个「这一版不要了」的刷新键是两件事。
         */
        var atLast = total < 2 || sid >= total - 1;
        var wantGenerate = delta > 0 && atLast;
        if (wantGenerate) {
            generateSwipeForMessage(m);
            return;
        }

        /* ── 以下是纯翻看 ── */
        if (total < 2) return;
        var next = Math.max(0, Math.min(total - 1, sid + delta));
        /*
         * 候选序号被截在两端时不做无谓的写盘与重绘。
         * 以前这里照样往下走，于是「已经在最早一版还一直点 ‹」
         * 会反复写 localStorage —— 用户体感就是「点了半天没反应」。
         */
        if (next === sid) return;
        var content = String(swipes[next] || '');
        aps.updateMessage(ui.chatId, ui.sessionId, msgId, {
            content: content,
            swipeId: next,
            swipes: swipes
        });
        /*
         * ⚠️ 这里原来写的是 renderStory()。
         *
         * renderStory() 是「**返回一段 HTML 字符串**」的构造函数，
         * 它自己不碰 DOM —— 收下它的人才会把字符串塞进页面。
         * 单独调它一句，等于辛辛苦苦改了数据、然后把渲染结果随手扔掉：
         * 界面上一个字都不会变。
         *
         * 这正是用户报的「‹ › 出现了，点了没反应」的第二重原因
         * （第一重是这两枚按钮压根没绑上事件，见 bindFloorToolsDelegate）。
         * 两个缺陷叠在一起，才会出现「按钮在、点了却纹丝不动」。
         *
         * 正解是走 patchStoryBody()：它会比对稳定 key、就地重写
         * mol-story-body，而且不会把输入框里的草稿清掉。
         */
        patchStoryBody();
    }

    /**
     * 楼层右下角 › 键在「只有一版」时的动作：给这一层再生成一版。
     *
     * 这里只剩一层薄薄的转接 —— 真正的实现在 regenerateFloor() 那一族里，
     * 和「我发的消息」楼层的刷新键共用同一条路径。
     * 候选的归档、上限截断、楼层写回位置这些规则自然也都在那边统一处理，
     * 不需要在这里再维护第二套逻辑。
     *
     * 之所以要留这个包装而不是直接改名：
     *   · 调用点（applyOfflineSwipe）的语义是「› 推进一下」，
     *     「推进」在一版时就是「生成新的一版」，这个意图值得在调用点保留；
     *   · 而「刷新」是另一条入口（点在 user 楼层上，语义是「重试生成」）。
     *     两者对用户是两件事，对底层是同一族能力。
     *
     * ⚠️ keepVersion 必须显式传 true，不能靠默认值。
     *
     * › 是全应用**唯一**允许归档候选的入口：它要把当前这版存进
     * swipes，用户才能按 ‹ 翻回去。刷新键走的则是不归档的 false 分支。
     * 早先 refreshToolHtml 默认传 true，害得刷新键也长出了候选、
     * 跟 › 完全重复 —— 所以现在把「归档候选」这件事写死在这一个调用点上，
     * regenerateFloor 的缺省值也改成了 false，不再有第二个地方能误开。
     */
    function generateSwipeForMessage(m) {
        regenerateFloor(m, true);
    }

    function messageBlockHtml(m, canEdit) {
        if (m.role === 'system' && m.type === 'opening') {
            return openingBlockHtml(m, canEdit);
        }
        var thinkingHtml = m.role === 'assistant' ? thinkingToggleHtml(m.thinking) : '';
        if (isJournalTheme()) {
            return journalMessageBlockHtml(m, canEdit, thinkingHtml);
        }
        var lines = '';
        if (m.renderAsHtml) {
            lines = buildHtmlPanelHtml(m.htmlRaw || m.content);
        } else {
            /* 通用卡片优先：与手账主题保持一致的渲染结果 */
            lines = offlineCardHtmlFor(m.content);
            if (!lines) {
                lines = splitStoryParagraphs(m.content)
                    .map(function (para) {
                        return decorateParagraph(para, m.role);
                    })
                    .filter(Boolean)
                    .join('');
            }
        }
        if (!lines) return '';
        var swipeBar = offlineSwipeBarHtml(m);
        if (!canEdit) {
            /*
             * locked 态也要带 data-ap-msg-id：隐藏楼层的 CSS 是按 id 精确命中的，
             * 原来这里没有 id，导致锁定/归档视图下「隐藏」只显示占位符、正文照旧露出来。
             */
            return (
                '<div class="xw-block xw-block--locked" data-ap-msg-id="' +
                esc(m.id) +
                '" data-ap-msg-role="' +
                esc(m.role) +
                '">' +
                thinkingHtml +
                lines +
                swipeBar +
                '</div>'
            );
        }
        return (
            '<div class="xw-block" data-ap-msg-id="' +
            esc(m.id) +
            '" data-ap-msg-role="' +
            esc(m.role) +
            '">' +
            thinkingHtml +
            '<div class="xw-block__lines">' +
            lines +
            '</div>' +
            /*
             * 底部一行：左边是「改 / 重发 / 删」，右边是候选切换 ‹ ›。
             *
             * 两者必须放进同一个 flex 行里 —— 早先把 swipeBar 单独放在正文下面，
             * 结果它和 __tools 各占一行、还互相压；而单纯给 swipeBar 加
             * margin-left:auto 也无效，因为 .xw-block 不是 flex 容器。
             * 现在由 __foot 这个 flex 行统一管布局：工具靠左，切换键靠右。
             */
            '<div class="xw-block__foot">' +
            '<div class="xw-block__tools">' +
            '<button type="button" class="xw-block__tool" data-ap-msg-edit="' +
            esc(m.id) +
            '" title="改" aria-label="改">' +
            ICON_EDIT +
            '</button>' +
            resendToolHtml(m.id) +
            /*
             * 跟手帐主题同款：两种楼层都**不再**挂第 3 枚刷新键。
             *
             * 理由与完整演进过程见 journalMessageBlockHtml 里那段注释 ——
             * 「重发」在两种楼层上都已经覆盖了刷新键的语义，实测产出
             * 逐字节相同，所以第 3 枚是纯重复。
             *
             * 现在统一为三枚键：改 / 重发 / 删除。
             * 角色楼层换版本用右下角的 ›（保留旧版进候选）。
             */
            '<button type="button" class="xw-block__tool xw-block__tool--drop" data-ap-msg-del="' +
            esc(m.id) +
            '" title="删除" aria-label="删除">' +
            ICON_DELETE +
            '</button></div>' +
            swipeBar +
            '</div></div>'
        );
    }

    /*
     * 场次纪要卡片已移除：正片里不再插入「场次纪要」卡片。
     * 纪要数据本身仍保留（记忆总结/记忆页仍在使用），只是不再渲染卡片。
     */

    function renderStoryLines(messages, summaries, extraStreaming, canEdit) {
        var live = (messages || []).filter(function (m) {
            return m && !m.deleted && String(m.content || '').trim();
        });
        var html = '';
        if (live.length && !isJournalTheme()) {
            html += '<div class="xw-script__mark" aria-hidden="true"><span>正片</span></div>';
        }
        var lastDay = '';

        (messages || []).forEach(function (m, i) {
            if (!m || m.deleted) return;
            if (isJournalTheme()) {
                var dayKey = dayKeyFromTs(m.createdAt || m.timestamp || Date.now());
                if (dayKey && dayKey !== lastDay) {
                    html +=
                        '<div class="xw-chat-date"><span>' +
                        esc(formatDateDivider(m.createdAt || m.timestamp || Date.now())) +
                        '</span></div>';
                    lastDay = dayKey;
                }
            }
            var block = messageBlockHtml(m, canEdit);
            if (block) {
                var floorNo = i + 1;
                var hiddenCls = m.hidden ? ' is-floor-hidden' : '';
                /*
                 * 隐藏中显示闭眼（带斜杠）+ 高亮底色，显示中显示实心眼。
                 * 之前两种状态用的是同一个图标，用户点完根本看不出来生效没有。
                 */
                var floorTools = canEdit
                    ? '<div class="xw-floor__tools">' +
                      '<button type="button" class="xw-floor__tool" data-ap-floor-branch="' + esc(m.id) + '" title="从这一层建立分支">' + ICON_BRANCH + '</button>' +
                      '<button type="button" class="xw-floor__tool' + (m.hidden ? ' is-off' : '') + '" data-ap-floor-hide="' + esc(m.id) + '"' +
                      ' data-floor-hidden="' + (m.hidden ? '1' : '0') + '"' +
                      ' aria-pressed="' + (m.hidden ? 'true' : 'false') + '"' +
                      ' title="' + (m.hidden ? '已隐藏 · 点一下恢复这一层' : '隐藏这一层（不参与生成）') + '">' +
                      (m.hidden ? ICON_EYE_OFF : ICON_EYE) + '</button>' +
                      '</div>' : '';
                html += '<section class="xw-floor' + hiddenCls + '" data-ap-floor="' + esc(m.id) + '">' +
                    /*
                     * 编号单独包一层 .xw-floor__no。
                     *
                     * 以前「第 N 层」和「 · 已隐藏」是同一个 span 里的裸文本，
                     * 想给编号单独加粗染色都没法下手。拆开之后：
                     *   · 编号 → .xw-floor__no，常态就是加粗的深色字
                     *   · 「已隐藏」→ 留在外层，跟着 hidden 标记走
                     * 视觉目标：翻找时编号一眼可见（用户反馈编号不明显、容易翻过头）。
                     */
                    '<header class="xw-floor__head"><span' + (m.hidden ? ' data-floor-tag="hidden"' : '') + '>' +
                    '<span class="xw-floor__no">第 ' + String(floorNo) + ' 层</span>' +
                    (m.hidden ? ' · 已隐藏' : '') + '</span>' + floorTools + '</header>' + block + '</section>';
            }
        });

        return html;
    }

    function hasVisibleStreamBody() {
        return !!streamingVisibleText().trim();
    }

    function shouldShowStreamWait() {
        if (ui.status !== 'coming') return false;
        if (hasVisibleStreamBody()) return false;
        if (resolveShowThinking() && streamingThinkingText()) return false;
        return true;
    }

    function renderComingHtml() {
        var label =
            String(ui.streamingRaw || '').trim() && !hasVisibleStreamBody() ? '构思中' : '书写中';
        return (
            '<div class="xw-wait"><span class="xw-wait__label">' +
            label +
            '</span>' +
            '<span class="xw-wait__dots"><i></i><i></i><i></i></span></div>'
        );
    }

    function patchStreamWait(mount) {
        var wait = mount.querySelector('.xw-wait');
        if (shouldShowStreamWait()) {
            if (!wait) {
                mount.insertAdjacentHTML('beforeend', renderComingHtml());
            } else {
                var label = wait.querySelector('.xw-wait__label');
                if (label) {
                    label.textContent =
                        String(ui.streamingRaw || '').trim() && !hasVisibleStreamBody()
                            ? '构思中'
                            : '书写中';
                }
            }
        } else if (wait) {
            wait.remove();
        }
    }

    function formatStreamParaHtml(para) {
        var htmlApi = global.MiyaChatHtml;
        if (htmlApi && typeof htmlApi.looksLikeHtmlReply === 'function' && htmlApi.looksLikeHtmlReply(para)) {
            return buildHtmlPanelHtml(para);
        }
        return esc(para).replace(/\n/g, '<br>');
    }

    /**
     * 内容指纹 —— 只用于判断「要不要重绘」，不进任何持久化数据。
     *
     * 为什么不能只记长度：模型对着同一份上下文重答时，
     * 「他停了一下，把茶杯放回桌上」和「他顿了一顿，将茶杯放回桌上」
     * 这类改写**长度经常一模一样**。旧实现只把 content.length 放进 key，
     * 于是内容真的换了、key 却纹丝不动，patchStoryBody 判定「无变化」
     * —— 直接跳过重建，用户看到的就是「点了刷新，内容还是之前的」。
     *
     * 这里改用「长度 + 逐字符累积哈希」。不需要密码学强度，
     * 只要对「等长但不同内容」敏感即可；30 位十进制累加和
     * 不会溢出（30 * 0xFFFF * 长度，长度上万也只到 2e9 量级）。
     */
    function contentFingerprint(text) {
        var s = String(text || '');
        var sum = 0;
        for (var i = 0; i < s.length; i++) {
            sum = (sum + s.charCodeAt(i) * (i + 1)) % 2147483647;
        }
        return s.length + '.' + sum.toString(36);
    }

    function computeStableStoryKey(msgs) {
        var m = msgs || [];
        var last = m.length ? m[m.length - 1] : null;
        return (
            String(m.length) +
            ':' +
            (last
                ? String(last.id || '') +
                  '|' +
                  String(last.editedAt || '') +
                  '|' +
                  /*
                   * 用内容指纹而不是长度（见 contentFingerprint 的说明）。
                   * 这里同时还要带上 swipeId：切候选时 content 换、swipeId 也换，
                   * 两个信号互为备份，避免「等长候选」把重绘整个吃掉。
                   */
                  contentFingerprint(last.content) +
                  '|' +
                  String(last.swipeId == null ? '' : last.swipeId) +
                  '|' +
                  (Array.isArray(last.swipes) ? String(last.swipes.length) : '0')
                : '') +
            /*
             * 注意：summaryList 不再进稳定 key。
             * 纪要已不渲染成卡片，若仍把纪要指纹算进来，
             * 自动纪要一变会触发整段正片 DOM 重建（白闪 + 流式挂载重置）。
             */
            ':td' +
            (resolveTextDecor() ? '1' : '0') +
            /*
             * 楼层隐藏指纹必须进 key：原来只看最后一条消息，
             * 隐藏第 1~3 层时 key 不变 → patchStoryBody 判定「无变化」→ DOM 不重建，
             * 于是眼睛图标永远停在旧状态（用户以为没生效）。
             */
            ':fh' +
            floorHiddenFingerprint(m) +
            /*
             * 现实时钟事件指纹也要进 key。
             * 事件卡不属于任何楼层，只靠消息判断「有没有变化」会漏掉它：
             * 点「领取 / 确认」后账本状态变了（due → claimed）、
             * 卡片该消失，但消息一条没动 → key 不变 → patchStoryBody 判定
             * 「无变化」→ DOM 不重建 → 按钮原地不动，用户以为没点上。
             * 跟 :fh 是同一类坑，所以按同样的办法补指纹。
             */
            ':te' +
            timeEventsFingerprint()
        );
    }

    /**
     * 事件卡指纹：只取「当前可见的那几条」的 id + 状态。
     *
     * 不能直接把整本账本 stringify：pending 里的项随时在补算状态，
     * 会让指纹频繁变化、引起无意义的整段 DOM 重建（白闪 + 流式挂载重置）。
     * 只有「看得见的部分真的变了」才值得重建。
     */
    function timeEventsFingerprint() {
        var api = timeEventsApi();
        var chatId = String(ui.chatId || '').trim();
        if (!api || !chatId || typeof api.getVisible !== 'function') return '';
        try {
            return api.getVisible(chatStore(), chatId, Date.now())
                .map(function (e) { return e.id + '#' + e.status; })
                .join(',');
        } catch (e) {
            return '';
        }
    }

    /** 楼层隐藏状态指纹：只关心「哪些位置是隐藏的」，与内容无关 */
    function floorHiddenFingerprint(msgs) {
        var out = '';
        var list = msgs || [];
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (!m || m.deleted) continue;
            out += m.hidden ? '1' : '0';
        }
        return out;
    }

    function getStoryBodyEl() {
        var body = $('mol-story-body');
        if (!body || body.classList.contains('xw-script-host')) return null;
        return body;
    }

    function ensureStreamMount(body) {
        var mount = body.querySelector('[data-ap-stream-mount]');
        if (mount) return mount;
        mount = document.createElement('div');
        mount.className = 'xw-stream-mount';
        mount.setAttribute('data-ap-stream-mount', '');
        mount.setAttribute('aria-live', 'polite');
        mount.setAttribute('aria-atomic', 'false');
        body.appendChild(mount);
        return mount;
    }

    function clearStreamMount(body) {
        if (!body) body = getStoryBodyEl();
        if (!body) return;
        var mount = body.querySelector('[data-ap-stream-mount]');
        if (mount) mount.remove();
        streamUi.paraCount = 0;
    }

    function streamingTargetText() {
        return String(ui.streamingRaw || '');
    }

    function streamingDisplayTarget() {
        var body = String(parseThinkingPayload(streamingTargetText()).content || '');
        var statusApi = global.MiyaOfflineStatus;
        if (statusApi && typeof statusApi.stripStatusFromText === 'function') {
            body = statusApi.stripStatusFromText(body);
        }
        return body;
    }

    function streamingThinkingText() {
        if (!resolveShowThinking()) return '';
        return String(parseThinkingPayload(streamingTargetText()).thinking || '').trim();
    }

    function streamingVisibleText() {
        var raw = streamingDisplayTarget();
        var len = clampInt(ui.streamingRevealLen, 0, raw.length, 0);
        return raw.slice(0, len);
    }

    function resolveStreamingParagraphs() {
        var shown = streamingVisibleText().trim();
        if (!shown) return [];
        var htmlApi = global.MiyaChatHtml;
        if (
            htmlApi &&
            (htmlApi.looksLikeHtmlReply(shown) || /```(?:html|htm|xml)\b/i.test(shown))
        ) {
            return [shown];
        }
        var eng = apEngine();
        if (eng && typeof eng.splitDisplayParagraphs === 'function') {
            var parts = eng.splitDisplayParagraphs(shown);
            if (parts.length) return parts;
        }
        return [shown];
    }

    function startStreamRevealLoop() {
        if (streamUi.revealRaf) return;
        function tick() {
            var target = streamingDisplayTarget();
            var targetLen = target.length;
            if (ui.streamingRevealLen < targetLen) {
                var backlog = targetLen - ui.streamingRevealLen;
                /* backlog 大时加快追平，避免流式已到却还在「慢慢打字」 */
                var step =
                    backlog > 80
                        ? backlog
                        : Math.max(2, Math.min(24, Math.ceil(backlog / 6)));
                ui.streamingRevealLen = Math.min(targetLen, ui.streamingRevealLen + step);
                scheduleStreamMountPatch();
            }
            if (ui.status === 'coming' || ui.streamingRevealLen < targetLen) {
                streamUi.revealRaf = requestAnimationFrame(tick);
            } else {
                streamUi.revealRaf = 0;
            }
        }
        streamUi.revealRaf = requestAnimationFrame(tick);
    }

    function stopStreamRevealLoop() {
        if (streamUi.revealRaf) {
            cancelAnimationFrame(streamUi.revealRaf);
            streamUi.revealRaf = 0;
        }
    }

    function flushStreamReveal() {
        ui.streamingRevealLen = streamingDisplayTarget().length;
        stopStreamRevealLoop();
    }

    function clampInt(v, lo, hi, fb) {
        var n = parseInt(v, 10);
        if (!Number.isFinite(n)) return fb;
        return Math.min(hi, Math.max(lo, n));
    }

    function patchStreamThinking(mount) {
        if (!resolveShowThinking()) {
            var gone = mount.querySelector('[data-ap-stream-thinking]');
            if (gone) gone.remove();
            return;
        }
        var thinking = streamingThinkingText();
        var existing = mount.querySelector('[data-ap-stream-thinking]');
        if (!thinking) {
            if (existing) existing.remove();
            return;
        }
        var wasOpen = existing && existing.open;
        if (!existing) {
            mount.insertAdjacentHTML(
                'afterbegin',
                '<details class="xw-think xw-think--stream" data-ap-stream-thinking>' +
                    '<summary class="xw-think__toggle">查看思维链</summary>' +
                    '<div class="xw-think__body">' +
                    esc(thinking).replace(/\n/g, '<br>') +
                    '</div></details>'
            );
            existing = mount.querySelector('[data-ap-stream-thinking]');
        } else {
            var body = existing.querySelector('.xw-think__body');
            if (body) {
                var nextHtml = esc(thinking).replace(/\n/g, '<br>');
                if (body.innerHTML !== nextHtml) body.innerHTML = nextHtml;
            }
        }
        if (existing && wasOpen) existing.open = true;
    }

    function patchStreamMount() {
        var body = getStoryBodyEl();
        if (!body) return;
        var mount = ensureStreamMount(body);
        patchStreamThinking(mount);
        var lines = resolveStreamingParagraphs();

        var paraCount = lines.length;
        var existing = mount.querySelectorAll('[data-ap-stream]');

        if (paraCount > streamUi.paraCount) {
            for (var i = streamUi.paraCount; i < paraCount; i++) {
                var p = document.createElement('p');
                var isLive = i === paraCount - 1;
                p.className =
                    'xw-txt xw-txt--theirs is-stream' +
                    (isLive ? ' is-stream-live' : '');
                p.setAttribute('data-ap-stream', String(i));
                p.innerHTML = formatStreamParaHtml(lines[i]);
                mount.appendChild(p);
            }
            streamUi.paraCount = paraCount;
        } else if (paraCount < streamUi.paraCount) {
            for (var j = existing.length - 1; j >= paraCount; j--) {
                if (existing[j] && existing[j].parentNode) existing[j].parentNode.removeChild(existing[j]);
            }
            streamUi.paraCount = paraCount;
        }

        patchStreamWait(mount);

        if (paraCount > 0) {
            var live = mount.querySelector('[data-ap-stream="' + String(paraCount - 1) + '"]');
            if (live) {
                live.classList.add('is-stream-live');
                var nextHtml = formatStreamParaHtml(lines[paraCount - 1]);
                if (live.innerHTML !== nextHtml) live.innerHTML = nextHtml;
            }
            mount.querySelectorAll('[data-ap-stream]').forEach(function (node, idx) {
                if (idx < paraCount - 1) node.classList.remove('is-stream-live');
            });
        }

        scheduleStreamScroll();
        hydrateAppointmentHtmlPanels(mount);
    }

    function scheduleStreamMountPatch() {
        if (streamUi.raf) return;
        streamUi.raf = requestAnimationFrame(function () {
            streamUi.raf = 0;
            patchStreamMount();
        });
    }

    function isScrollNearBottom(sc, threshold) {
        if (!sc) return true;
        var gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
        return gap <= (threshold != null ? threshold : SCROLL_PIN_THRESHOLD);
    }

    function pinScrollToBottom() {
        streamUi.userPinnedBottom = true;
        /* 主动贴底（用户按下发送/重回）＝用户已经表态，允许跟随滚动。 */
        streamUi.userTouchedScroll = true;
        /* 这是明确的「我要看最新」意图，后续生成可以继续跟随。 */
        streamUi.userIntendsFollowBottom = true;
    }

    function bindScrollPin() {
        var sc = $('xw-main');
        if (!sc || ui.view !== 'story') return;
        if (sc._xwScrollPin) return;
        sc._xwScrollPin = true;
        /* 注意：程序改 scrollTop 也会触发 scroll 事件。
           所以这里不直接置 userTouchedScroll，而是用 rAF 标记接下来若干帧，
           把「我们自己的滚动」排除掉，只认用户的真实手势。
           只挡 1 帧是不够的：移动端惯性滚动 / 渲染延迟会让 scroll 事件晚到，
           漏标之后程序滚动会被误认成用户手势，进而污染跟随意图。 */
        var markSelf = function () {
            sc._xwScrollSelf = true;
            var frames = 0;
            (function holdSelf() {
                frames++;
                if (frames >= SELF_SCROLL_FRAMES) {
                    sc._xwScrollSelf = false;
                    return;
                }
                requestAnimationFrame(holdSelf);
            })();
        };
        sc._xwMarkSelfScroll = markSelf;
        ['touchstart', 'pointerdown', 'wheel', 'keydown'].forEach(function (evt) {
            sc.addEventListener(
                evt,
                function () {
                    streamUi.userTouchedScroll = true;
                },
                { passive: true }
            );
        });
        sc.addEventListener(
            'scroll',
            function () {
                if (!sc._xwScrollSelf) {
                    /* 真实滚动（手指/滚轮/键盘）：从此按用户的位置说话。 */
                    streamUi.userTouchedScroll = true;
                }
                if (sc._xwScrollSelf) return; /* 自己滚的，不覆盖用户立场 */
                streamUi.userPinnedBottom = isScrollNearBottom(sc);
                /*
                 * 意图要等手势停下来再结算，不能在滚动过程中就地采信。
                 *
                 * 原因：一次下滑手势会产生很多个 scroll 事件。页面短的时候，
                 * 中途某一帧可能恰好「贴底」，若当场就把意图记成 true，
                 * 用户明明只是滑了一小段、最终停在半空，也会被当成「要跟最新」，
                 * 生成结束就被拽到底。
                 *
                 * 所以这里只吊销意图（离开底部就立刻停止跟随），
                 * 而把「确立意图」交给手势结束后的 settle 判定。
                 */
                streamUi.userIntendsFollowBottom = false;
                scheduleFollowIntentSettle(sc);
            },
            { passive: true }
        );
    }

    var followIntentTimer = 0;

    /*
     * 滚动停稳后，按「最终停留位置」确立跟随意图。
     * 只有真正停在底部（阈值内）才算「用户要跟最新」。
     */
    function scheduleFollowIntentSettle(sc) {
        if (followIntentTimer) clearTimeout(followIntentTimer);
        followIntentTimer = setTimeout(function () {
            followIntentTimer = 0;
            if (!sc || !sc.isConnected) return;
            /* 程序滚动不参与意图判定 */
            if (sc._xwScrollSelf) return;
            if (!streamUi.userTouchedScroll) return;
            streamUi.userIntendsFollowBottom = isScrollNearBottom(sc);
            streamUi.userPinnedBottom = streamUi.userIntendsFollowBottom;
        }, 160);
    }

    /* 供程序滚动前调用：标记「接下来这几帧的 scroll 事件是我自己造的」 */
    function markSelfScroll() {
        var sc = $('xw-main');
        if (sc && typeof sc._xwMarkSelfScroll === 'function') sc._xwMarkSelfScroll();
    }

    /*
     * 流式跟随滚动。
     *
     * 旧实现第一行就是 `return;`（死代码），整个函数体永不执行——
     * 等于「跟最新」能力被直接关掉，而不是修好判定。这里恢复实现，
     * 但判据仍严格用「用户意图」而非「当前位置」，避免误伤静看的用户。
     */
    function scheduleStreamScroll() {
        if (!streamUi.userTouchedScroll) return;
        if (!streamUi.userIntendsFollowBottom) return;
        if (streamUi.scrollRaf) return;
        streamUi.scrollRaf = requestAnimationFrame(function () {
            streamUi.scrollRaf = 0;
            if (!streamUi.userTouchedScroll) return;
            if (!streamUi.userIntendsFollowBottom) return;
            var sc = $('xw-main');
            if (!sc) return;
            markSelfScroll();
            sc.scrollTop = sc.scrollHeight;
        });
    }

    function resetStreamUi() {
        if (streamUi.raf) {
            cancelAnimationFrame(streamUi.raf);
            streamUi.raf = 0;
        }
        stopStreamRevealLoop();
        streamUi.paraCount = 0;
        ui.streamingRevealLen = 0;
    }

    /*
     * 清空「滚动立场」。
     *
     * 为什么必须有这个函数：
     *   旧代码只在用户手势里更新这几个值，从不在「换场景 / 生成结束」时清空。
     *   于是只要用户某次按过发送（pinScrollToBottom 把三个值全置 true），
     *   这个「我要跟最新」的立场就会一直残留——跨会话、跨退出进入都还在。
     *   之后任何一次全量重绘（render 的 innerHTML 重建会把 scrollTop 归零），
     *   紧接着 scrollStoryToEnd() 判定成立 -> 强行推到最底。
     *   用户看到的就是「生成完就跳到底部」，而且怎么改都复现。
     *
     * 所以立场必须跟着场景走：进新场景、重开一轮生成，都从「没表达过」开始。
     */
    function resetScrollUiState() {
        if (followIntentTimer) {
            clearTimeout(followIntentTimer);
            followIntentTimer = 0;
        }
        if (streamUi.scrollRaf) {
            cancelAnimationFrame(streamUi.scrollRaf);
            streamUi.scrollRaf = 0;
        }
        /* 换场景时停掉上一场的入场锚定，避免它接着在新场景里写 scrollTop */
        cancelEnterAnchor();
        streamUi.userPinnedBottom = false;
        streamUi.userTouchedScroll = false;
        streamUi.userIntendsFollowBottom = false;
        streamUi.landedAtLatest = false;
    }

    /*
     * 进入场景后把视图落到最新楼层（最底部）。
     *
     * 关键设计：程序定位 ≠ 用户立场。
     *   这里刻意**不**置 userTouchedScroll / userIntendsFollowBottom。
     *   自动贴底只是「默认视图起点」，用户并没有表达「我要跟最新」。
     *   若这里顺手把立场置 true，就退化成旧代码的老毛病：
     *   用户进来啥也没动，生成一结束就被拽到新底部。
     *   只有他真正滚到底、或主动按发送，才进入跟随模式。
     */
    function scrollToLatestOnEnter() {
        var sc = $('xw-main');
        if (!sc) return;
        /* 无动画直落底部：进入场景时若用平滑动画，用户会看到一段莫名滚动。 */
        markSelfScroll();
        sc.scrollTop = sc.scrollHeight;
        streamUi.landedAtLatest = true;
        streamUi.userPinnedBottom = true;
        streamUi.userTouchedScroll = false;
        streamUi.userIntendsFollowBottom = false;

        /*
         * 补锚：真实设备上「贴底」不是一个瞬间完成的状态。
         *   头像 / 内嵌 HTML 面板 / 图片 / 自定义字体都会在首帧之后才撑高内容，
         *   只滚一次的话会停在「差一点到底」的位置，用户看起来就是
         *   「并没有跳到最新楼层」。移动端图片解码慢时尤其明显。
         */
        anchorToLatestForAWhile();
    }

    /*
     * 入场后的贴底锚定 —— 必须「不跟用户抢」。
     *
     * 这里有一个极其危险的坑（之前踩过）：
     *   锚定如果靠 rAF 高频写 scrollTop，就会把用户的滑动手势直接压掉
     *   （手指在动，位置纹丝不动）。更糟的是，程序写入会触发我们自己的
     *   markSelfScroll 标记，真实的 scroll 事件被吞掉，于是
     *   userTouchedScroll 永远变不成 true —— 释放条件永远不成立，
     *   锚定自己把自己锁死，表现就是「页面卡住 + 生成后一直跳到底部」。
     *
     * 所以现在的做法是：
     *   · 用「输入事件」而不是「scroll 能否生效」来判断用户是否接管，
     *     手指一碰、滚轮一转、按键一按，立刻永久放弃锚定；
     *   · 只在内容确实长高了（scrollHeight 变化）时才补一次，
     *     不再每帧无条件写 scrollTop；
     *   · 窗口很短（约 1.2 秒），到点自动收工。
     */
    function anchorToLatestForAWhile() {
        cancelEnterAnchor();
        var deadline = Date.now() + 1200;
        var lastH = 0;
        var el = $('xw-main');
        if (el) lastH = el.scrollHeight;

        /*
         * 用户接管的即时判据：任何一种输入都算。
         * 在 window 上以 capture 阶段监听（不 preventDefault），
         * 只用来「认输」——一旦触发就永久停掉本次锚定，把位置完全交还用户。
         * 注意必须用 once:false + 手动摘除，才能保证失败路径也能清理干净。
         */
        function onUserInput() { cancelEnterAnchor(); }
        ENTER_ANCHOR_EVENTS.forEach(function (evt) {
            window.addEventListener(evt, onUserInput, { capture: true, passive: true });
            enterAnchorDisposers.push(function () {
                window.removeEventListener(evt, onUserInput, { capture: true });
            });
        });

        function tick() {
            enterAnchorRaf = 0;
            var node = $('xw-main');
            if (!node || !streamUi.landedAtLatest) { cancelEnterAnchor(); return; }
            /* 内容又长高了（图片/字体/面板加载完）→ 补一次贴底 */
            if (node.scrollHeight !== lastH) {
                lastH = node.scrollHeight;
                markSelfScroll();
                node.scrollTop = node.scrollHeight;
            }
            if (Date.now() < deadline) {
                enterAnchorRaf = requestAnimationFrame(tick);
            } else {
                cancelEnterAnchor();
            }
        }
        enterAnchorRaf = requestAnimationFrame(tick);
    }

    /* 停掉入场锚定，并摘掉它的输入监听（避免残留监听误伤下一场） */
    function cancelEnterAnchor() {
        if (enterAnchorRaf) {
            cancelAnimationFrame(enterAnchorRaf);
            enterAnchorRaf = 0;
        }
        if (enterAnchorTimer) {
            clearTimeout(enterAnchorTimer);
            enterAnchorTimer = 0;
        }
        enterAnchorDisposers.splice(0).forEach(function (off) {
            try { off(); } catch (e) {}
        });
    }

    function patchSummaryBusyUi() {
        var body = getStoryBodyEl();
        var busyEl = $('xw-note-busy');
        if (ui.summaryBusy) {
            if (body && !busyEl) {
                var el = document.createElement('div');
                el.id = 'xw-note-busy';
                el.className = 'xw-note-busy';
                el.setAttribute('role', 'status');
                el.textContent = '纪要生成中…';
                body.appendChild(el);
            } else if (busyEl) {
                busyEl.textContent = '纪要生成中…';
            }
        } else if (busyEl) {
            busyEl.remove();
        }
        var runBtn = $('xw-note-run');
        if (runBtn) {
            runBtn.disabled = !!ui.summaryBusy;
            runBtn.textContent = ui.summaryBusy ? '纪要生成中…' : '生成纪要';
        }
        /* xw-ribbon-sum（卷宗条上的「归档成纪要」）随卷宗条一并移除，
           纪要入口现在只在设置抽屉里的「生成纪要」一处。 */
    }

    function setSummaryBusy(busy) {
        ui.summaryBusy = !!busy;
        patchSummaryBusyUi();
    }

    function runManualSummary(opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (ui.summaryBusy) return Promise.resolve(null);
        var eng = apEngine();
        if (!eng || typeof eng.appointmentSummary !== 'function') {
            return Promise.reject(new Error('engine_missing'));
        }
        setSummaryBusy(true);
        var callOpts = Object.assign({ silent: true }, opts);
        return eng
            .appointmentSummary(ui.chatId, ui.sessionId, callOpts)
            .then(function (sum) {
                if (!sum) {
                    toast('没有新的镜头可归档');
                    return sum;
                }
                if (!opts.silent) toast('纪要已写好');
                patchStoryBody();
                return sum;
            })
            .catch(function (err) {
                if (err && err.message === 'api_not_configured') toast('请先在「设置」里填好 API');
                else toast('纪要生成失败');
                throw err;
            })
            .finally(function () {
                setSummaryBusy(false);
            });
    }

    function renderStory() {
        var st = chatStore();
        var chat = st && st.findChat(ui.chatId);
        var contact = chat && st.findContact(chat.contactId);
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess) return '<p class="xw-empty">场景找不到了</p>';
        var msgs = apStore().getSessionMessages(ui.chatId, ui.sessionId);
        var castContacts = resolveCastContacts(
            Array.isArray(sess.cast) && sess.cast.length
                ? sess.cast
                : [{ contactId: (contact && contact.id) || ui.contactId, chatId: ui.chatId }]
        );
        if (!castContacts.length && contact) castContacts = [contact];
        var primaryFace = castContacts[0] || contact;
        var ava = esc(contactAvatar(primaryFace));
        var sceneTitle = String((sess && sess.title) || '').trim() || '未命名场景';
        /*
         * 卷宗条（.xw-ribbon）已整体移除。
         *
         * 它原本出现在「从卷宗点开一卷」时，挂在正文最上方，提供
         * 「续写这一幕 / 命名 / TXT / JSON / 归档成纪要」。
         * 实测下来它有两个硬伤，且是设计自相矛盾留下的残留：
         *
         *   1. 位置错。它排在正文【最上方】，而进入一场戏时视图会自动落到
         *      最新楼层，于是这张卡永远在屏幕外——用户根本不知道它存在，
         *      更别说那张卡正是「输入框为什么不见了」的唯一解法。
         *
         *   2. 职能重叠。TXT / JSON 导出在【上一个页面】的卷宗列表里每行都有；
         *      而「续写这一幕」的存在本身，源于「卷宗一律只读」这条早已废弃的规则
         *      （封存概念已整体移除，见 store 说明）。既然所有卷都能续写，
         *      就没必要先进只读态、再点一下按钮解除——点进来直接能写才对。
         *
         * 现在：点开卷宗即视为续写，输入框常驻。「命名」挪到卷宗列表每行。
         */
        /* 卷宗条位置原本放 ribbon 变量，随该条一并删除（见上方说明）。 */
        /*
         * 与 storyHasContent() 同一口径：刷新期间被刷的那一层处于软删态，
         * msgs 会是空数组，但场景并没有消失 —— 不能因此把正片换成空白页。
         */
        var hasStory =
            msgs.length > 0 ||
            ui.streamingLines.length > 0 ||
            ui.status === 'coming' ||
            ((sess && sess.messages) || []).length > 0;
        var charCount = msgs.reduce(function (n, m) {
            return n + String(m.content || '').length;
        }, 0);

        if (!hasStory) {
            return '<div id="mol-story-body" class="xw-script-host" hidden aria-hidden="true"></div>';
        }

        var streamingActive = ui.streamingLines.length > 0 || ui.status === 'coming';
        /*
         * 现实时钟事件卡片挂在正文【上方】。
         *
         * 为什么不进 renderStoryLines：那张卡不属于任何楼层，
         * 它是「世界在这段时间里发生的变化」。房间在用户离线时照样在走，
         * 用户隔了几天回来，第七天该到的利息要在正文之前先告诉他，
         * 而不是等他读完第十四天的剧情再从楼层里找。
         *
         * 归档视图（旧卷只读）刻意不显示：那里是回看历史，
         * 插一张当下的账本会跟卷宗里的时间线打架。
         */
        var teHtml = timeEventsHtml(ui.chatId, Date.now());
        var scriptInner =
            '<article class="xw-script" id="mol-story-body">' +
            teHtml +
            renderStoryLines(msgs, [], [], true) +
            (streamingActive
                ? '<div class="xw-stream-mount" data-ap-stream-mount aria-live="polite"></div>'
                : '') +
            '</article>';

        /*
         * 正片上方不再放宽屏卡片（原 xw-scene__band：角色头像横条 + 开镜时间 / 镜数 / 字数）。
         * 角色名、头像在顶栏（手帐）与状态行里已经有，这里重复占位反而把正文挤下去，
         * 所以整块移除，正文直接从卷宗条 / 正文列开始。
         */
        return (
            '<div class="xw-scene' + (isJournalTheme() ? ' xw-scene--journal' : '') + '"' +
            (isJournalTheme() ? ' style="--xw-stream-face:url(' + ava + ')"' : '') + '>' +
            '<div class="xw-script-col">' + scriptInner + '</div></div>'
        );
    }

    function render() {
        var root = $('xw-root');
        if (!root) return;

        /*
         * 重建 DOM 前先记住滚动位置。
         *
         * 原因：下面用 root.innerHTML 整体重建，#xw-main 是新节点，
         * 浏览器对新建的可滚动元素一律把 scrollTop 归零。
         * 生成结束时 patchStoryBody() 会走到这里，于是：
         *   用户正看历史楼层 -> scrollTop 被清 0 -> 又被 scrollStoryToEnd 推到底
         * 表现为「生成完就跳到底部」。所以位置必须自己保。
         */
        var scBefore = $('xw-main');
        var keepTop = scBefore ? scBefore.scrollTop : 0;
        var keepFollow = streamUi.userTouchedScroll && streamUi.userIntendsFollowBottom;
        var keepLand = streamUi.landedAtLatest && !streamUi.userTouchedScroll;

        var body = '';
        if (ui.view === 'history') body = renderHistory();
        else if (ui.view === 'story') {
            /*
             * 卷宗视图不再走只读分支：点进来就是想接着写，直接渲染正文。
             * （原条件里的 !ui.viewingArchive 连同开场白选择器的互斥一起放开——
             *   有内容的卷本来就不会落到开场白分支。）
             */
            if (!storyHasContent()) body = renderOpeningPicker();
            else body = renderStory();
        }

        var mainCls = 'xw-main';
        if (ui.view === 'story' && !storyHasContent()) {
            mainCls += ' xw-main--blank';
        }
        if (isJournalTheme()) mainCls += ' xw-main--journal';

        root.innerHTML =
            renderBackdrop() +
            '<div class="xw-shell' + (isJournalTheme() ? ' xw-shell--journal' : '') + '">' +
            (isJournalTheme() ? renderJournalChrome() : renderExitBtn()) +
            (isJournalTheme() ? '' : renderDock()) +
            renderFloatFloorScope() +
            '<main class="' + mainCls + '" id="xw-main">' + body + '</main>' +
            /*
             * 输入框恒常驻：进 story 视图就有，不再区分「卷宗只读」。
             * 这是本次改动的核心 —— 用户点进一卷，下面就该能直接说话。
             */
            (ui.view === 'story'
                ? isJournalTheme()
                    ? renderJournalWriter()
                    : renderWriter()
                : isJournalTheme()
                    ? renderJournalDockStubs()
                    : '') +
            '</div>';

        bindEvents();
        /* DOM 已就位，此时量高度才准：只给真的被压住的开场白露出「展开全文」 */
        syncOpeningPreviewMore(root);
        syncDockCollapsedUi();
        hydrateOfflineAvatars(root);
        if (ui.view === 'story' && ui.chatId && ui.sessionId) {
            var msgsR = apStore().getSessionMessages(ui.chatId, ui.sessionId);
            ui.stableStoryKey = computeStableStoryKey(msgsR);
            if (ui.status === 'coming' || String(ui.streamingRaw || '').length > 0) {
                startStreamRevealLoop();
                patchStreamMount();
            }
            patchSummaryBusyUi();
        }

        /* 重建后把滚动位置还回去（见本函数开头 keepTop / keepFollow / keepLand）。 */
        restoreScrollAfterRender(keepTop, keepFollow, keepLand);

        syncStatusFab();
    }

    /*
     * render() 重建 DOM 后的滚动位置恢复。
     *
     * 三种立场，优先级从高到低：
     *   1. keepFollow —— 用户明确要跟最新：贴到底。
     *   2. keepLand   —— 进入场景时的程序定位：重新贴到底，别停在半路。
     *   3. 其余         —— 用户在看历史：回到原来的 scrollTop，原地不动。
     *
     * 第 3 条正是「生成完跳到底部」的解药：静看的用户位置被原样保留。
     */
    function restoreScrollAfterRender(keepTop, keepFollow, keepLand) {
        var sc = $('xw-main');
        if (!sc) return;
        if (keepFollow) {
            markSelfScroll();
            sc.scrollTop = sc.scrollHeight;
            streamUi.userPinnedBottom = true;
            return;
        }
        if (keepLand) {
            markSelfScroll();
            sc.scrollTop = sc.scrollHeight;
            streamUi.userPinnedBottom = true;
            return;
        }
        if (keepTop > 0) {
            markSelfScroll();
            var max = Math.max(0, sc.scrollHeight - sc.clientHeight);
            sc.scrollTop = Math.min(keepTop, max);
            streamUi.userPinnedBottom = isScrollNearBottom(sc);
        }
    }

    function syncStatusFab() {
        var statusApi = global.MiyaOfflineStatus;
        if (!statusApi) return;
        var enabled = typeof statusApi.isEnabled !== 'function' || statusApi.isEnabled();
        /* 悬浮球已移除，不再需要计算显示条件；保留关闭面板的行为即可 */
        if (!enabled && typeof statusApi.closePanel === 'function') statusApi.closePanel();
    }

    function getStatusContext() {
        return {
            chatId: ui.chatId,
            sessionId: ui.sessionId,
            contactId: ui.contactId
        };
    }

function renderWriter() {
        return (
            '<footer class="xw-writer">' +
            '<div class="xw-writer__tools">' +
            '<button type="button" class="xw-writer__tools-toggle" id="xw-writer-tools-toggle" aria-label="更多功能" title="更多功能">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.25 5.95L20.2 12l-5.95 2.25L12 20.2l-2.25-5.95L3.8 12l5.95-2.25L12 3.8z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M18 4.5l.65 1.35L20 6.5l-1.35.65L18 8.5l-.65-1.35L16 6.5l1.35-.65L18 4.5z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>' +
            '</button>' +
            '<div class="xw-writer__tools-menu" id="xw-writer-tools-menu" hidden>' +
            '<button type="button" class="xw-writer__tool" id="xw-writer-tool-beautify">样式</button>' +
            '<button type="button" class="xw-writer__tool" id="xw-writer-tool-prefs">调参</button>' +
            '<button type="button" class="xw-writer__tool" id="xw-writer-tool-vault">卷宗</button>' +
            '</div></div>' +
            /*
             * 「重回」键已移除（原来在输入框左边，id 为 xw-writer-undo）。
             *
             * 它的功能和楼层右下角的候选切换键 ‹ › 完全重叠 —— 两者最终都走
             * 引擎的 regenerateAppointment（让角色把这一轮重答一次），
             * 只是入口一左一右。两个入口做同一件事，用户反而要猜该点哪个。
             *
             * 现在统一以「楼层自带的重刷入口」为准：每一层右下角的 › 
             * 既是「再生成一版」，也是「翻看已有候选」，语义归属明确
             * （它是这一层的版本，不是整个场景的），位置也不占输入栏。
             */
            '<textarea class="xw-writer__field" id="xw-writer-input" rows="1" placeholder=""></textarea>' +
            '<button type="button" class="xw-writer__go" id="xw-writer-go" aria-label="推进场景">↑</button>' +
            '</footer>'
        );
    }

    function renderJournalDockStubs() {
        return (
            '<div class="xw-journal-dock-stubs" hidden aria-hidden="true">' +
            '<button type="button" id="xw-dock-prefs"></button>' +
            '<button type="button" id="xw-dock-beautify"></button>' +
            '<button type="button" id="xw-dock-vault"></button></div>'
        );
    }

    function renderJournalWriter() {
        return (
            '<footer class="xw-journal-writer">' +
            /* 同 renderWriter：「重回」键已移除，重刷走楼层右下角的 › */
            '<div class="xw-journal-writer__input">' +
            '<textarea class="xw-journal-writer__field" id="xw-writer-input" rows="1" placeholder="输入消息..."></textarea></div>' +
            '<button type="button" class="xw-journal-writer__send" id="xw-writer-go" title="发送" aria-label="发送">' +
            ICON_SEND + '</button></footer>'
        );
    }

    /*
     * 生成态开关：输入框锁住，发送钮由「发送」变为「停止」。
     *
     * 与线上聊天室（miya-chat-room.js 的 setSendButtonGenerating）保持同一套
     * 语义和观感：is-stop 类 + 实心方块图标 + aria-label「停止生成」。
     * 生成中按钮必须保持可点，否则用户没法中断。
     */
    function setWriterGenerating(on) {
        var input = $('xw-writer-input');
        var send = $('xw-writer-go');
        if (input) input.disabled = !!on;
        if (!send) return;
        if (on) {
            send.classList.add('is-stop');
            send.disabled = false;
            send.setAttribute('aria-label', '停止生成');
            send.setAttribute('title', '停止生成');
            send.innerHTML = ICON_STOP;
        } else {
            send.classList.remove('is-stop');
            send.disabled = false;
            send.setAttribute('aria-label', '发送');
            send.setAttribute('title', '发送');
            send.innerHTML = ICON_SEND;
        }
    }

    /* 当前是否处于「生成中」，供发送钮点击时判定走发送还是走停止 */
    function isWriterGenerating() {
        var app = document.getElementById('miya-offline-app');
        return !!(app && app.classList.contains('xw-generating'));
    }

    /*
     * 这一个错误是不是「用户主动停止」造成的？
     *
     * 为什么要单独抽成函数：
     *   原先只有 runStream 内部的 catch 认得 abort（见那里的 isAbort 判断），
     *   而 runStream 外面还有 3 个调用点各自挂了 .catch() 做「失败后还原楼层」。
     *   用户点停止时，内部 catch 静默 return 了，异常却继续往外冒到那 3 个外层 catch，
     *   于是被当成故障处理 —— 弹「没生成出来」的错、把楼层恢复、再重绘一次。
     *   重绘会把正在生成的那层重新挂上「书写中」提示，而停止流程已经结束了，
     *   没有任何东西再去清它 —— 表现就是「停止后书写中还在，要重进界面才消失」。
     *
     *   所以 abort 判定必须是每个 catch 都能用的公共能力，而不是某处的局部变量。
     */
    function isAbortError(err) {
        if (!err) return false;
        var genLife = global.MiyaGenerationLifecycle;
        return !!(
            err.name === 'AbortError' ||
            err.message === 'aborted' ||
            err.message === 'abort' ||
            err.code === 'aborted' ||
            (genLife && genLife.isAbortError && genLife.isAbortError(err))
        );
    }

    /*
     * 停止线下生成。
     *
     * 引擎侧早就备好了 MiyaAppointmentEngine.stopAppointment(chatId, sessionId)，
     * 内部会走 MiyaGenerationLifecycle.stop('offline:'+key) 并按 '::' 规则清理
     * replyInFlight 忙碌标记——只是一直没有界面接上去。这里把它接出来。
     * 直接调引擎方法而不是自己拼 key，避免和引擎的键规则（'::'）写岔。
     */
    function stopOfflineGeneration() {
        var eng = apEngine();
        var stopped = false;
        if (eng && typeof eng.stopAppointment === 'function') {
            try {
                eng.stopAppointment(ui.chatId, ui.sessionId);
                stopped = true;
            } catch (e) { /* 停不掉也要把 UI 放回可交互，别把人卡住 */ }
        } else {
            var genLife = global.MiyaGenerationLifecycle;
            if (genLife && typeof genLife.stop === 'function') {
                try {
                    genLife.stop('offline:' + String(ui.chatId || '') + '::' + String(ui.sessionId || ''), { reason: 'user' });
                    stopped = true;
                } catch (e2) {}
            }
        }
        if (stopped) toast('已停止生成');
        /* 交给 runStream 的 finally 收尾；这里只兜底恢复 UI，避免引擎没抛错时一直锁着 */
        var app = document.getElementById('miya-offline-app');
        if (app) app.classList.remove('xw-generating');
        setWriterGenerating(false);
        restoreWriterInput();
    }

    /* 统一的「生成中」包裹：管开头、管收尾，5 个调用点共用 */
    function beginWriterGeneration() {
        var app = document.getElementById('miya-offline-app');
        if (app) app.classList.add('xw-generating');
        setWriterGenerating(true);
    }

    function endWriterGeneration() {
        var app = document.getElementById('miya-offline-app');
        if (app) app.classList.remove('xw-generating');
        setWriterGenerating(false);
        var input = $('xw-writer-input');
        if (input && !input.disabled) {
            try { input.focus(); } catch (e) {}
        }
    }

    /*
     * ── 线下生成完毕的提示音 ───────────────────────────────────
     *
     * 为什么**不能**直接挂在 endWriterGeneration() 上 ——
     * 它被 4 处调用的方式是 `.finally(endWriterGeneration)`，
     * 也就是**成功、失败、用户中止都会走**。挂在那里的话，
     * 接口报错、「刷新中断」、用户点停止 全都会「叮」一声 ——
     * 而那一声本来的意思是「角色写完了，可以看了」，
     * 在失败时响等于报假信，用户会白等一下。
     *
     * 所以只在**真正生成成功**的 .then() 分支里显式调这个函数。
     * 调用点有 4 个（发消息 / 重生成 / 开场白 等），
     * 都紧跟在 runAppointmentCompletion 成功之后。
     *
     * 走 playForOfflineDone() 而不是 play()：受总开关控制，
     * 但不受「聊天室开着就不响」那条规则约束 —— 这条规则是给
     * 新消息用的（防止你正看着聊天还响铃），而生成完毕时
     * 你本来就盯着屏幕等结果，正需要这一声。
     */
    function playOfflineDoneSound() {
        try {
            if (global.MiyaMsgSound && typeof global.MiyaMsgSound.playForOfflineDone === 'function') {
                global.MiyaMsgSound.playForOfflineDone();
            }
        } catch (e) {}
    }

    /* 生成结束时统一把输入框交还给用户（原来 5 处各写了一遍） */
    function restoreWriterInput() {
        var input = $('xw-writer-input');
        if (input) {
            input.disabled = false;
            try { input.focus(); } catch (e) {}
        }
        var send = $('xw-writer-go');
        if (send) send.disabled = false;
    }

    function scrollStoryToEnd(force) {
        var sc = $('xw-main');
        if (!sc) return;
        /*
         * 「跟随最新」的判据：用户碰过滚动条 + 他**打算**待在底部。
         *
         * 为什么不能只看 userPinnedBottom：它只在真实滚动事件里更新，
         * 而程序自己的滚动会被 markSelfScroll 标记后跳过更新。
         * 于是「用户滚到底 → 内容继续增长 → 用户没再动」这种情况下，
         * pinned 会停留在一个过期的 true，把人硬拽到新底部。
         *
         * 为什么也不能「滚之前重新量一次」：本函数在内容已重绘之后才被调用，
         * 那时页面已经被新内容撑高，用户原本贴底的位置自然不再贴底 ——
         * 真·跟随的用户会被误判成「不跟随」。
         *
         * 正确做法：用「重绘前」记下的意图（streamUi.userIntendsFollowBottom）。
         * 该值在每次真实滚动时按当时的内容高度结算，代表用户的真实意图，
         * 不受后续内容增长影响。
         */
        if (!streamUi.userTouchedScroll) return;
        if (!streamUi.userIntendsFollowBottom) return;
        requestAnimationFrame(function () {
            if (!streamUi.userTouchedScroll) return;
            if (!streamUi.userIntendsFollowBottom) return;
            markSelfScroll();
            sc.scrollTop = sc.scrollHeight;
            streamUi.userPinnedBottom = isScrollNearBottom(sc);
        });
    }

    function patchStoryBody(opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        if (ui.view !== 'story') return;
        var body = $('mol-story-body');
        if (!storyHasContent()) {
            render();
            return;
        }
        if (!body || body.classList.contains('xw-script-host')) {
            render();
            return;
        }
        var msgs = apStore().getSessionMessages(ui.chatId, ui.sessionId);
        if (!body) return;
        var stableKey = computeStableStoryKey(msgs);
        var streaming = ui.streamingLines.length > 0 || ui.status === 'coming';

        if (!opts.streamOnly && stableKey !== ui.stableStoryKey) {
            ui.stableStoryKey = stableKey;
            var watermark = body.querySelector('.mol-story-watermark');
            var wmHtml = watermark ? watermark.outerHTML : '';
            /*
             * 这里必须跟 renderStory() 用同一套拼法（事件卡在正文上方），
             * 否则发完一镜、patchStoryBody 就地重写 innerHTML 时，
             * 卡片会被整块抹掉——表现就是「刚回来能看到利息卡，
             * 一说话就没了」，用户会以为钱没到账。
             */
            body.innerHTML =
                wmHtml +
                timeEventsHtml(ui.chatId, Date.now()) +
                renderStoryLines(msgs, [], [], true);
            hydrateAppointmentHtmlPanels(body);
            resetStreamUi();
            if (streaming) ensureStreamMount(body);
            else clearStreamMount(body);
            hydrateOfflineAvatars();
        }

        if (streaming) {
            scheduleStreamMountPatch();
        } else {
            clearStreamMount(body);
            resetStreamUi();
        }

        /*
         * 只有用户「想跟最新」时才在重绘后贴底。
         * 判据用意图（userIntendsFollowBottom）而不是此刻位置
         * （userPinnedBottom）——重绘已经把内容撑高，此刻位置必然失真。
         */
        if (!opts.streamOnly && streamUi.userTouchedScroll && streamUi.userIntendsFollowBottom) {
            scrollStoryToEnd(true);
        }
    }

    function syncSessionOnLeave() {
        if (!ui.chatId) return;
        var chatId = ui.chatId;
        var contactId = ui.contactId;
        if (typeof apStore().syncSessionCastToChats === 'function' && ui.sessionId) {
            apStore().syncSessionCastToChats(chatId, ui.sessionId);
        } else if (contactId && typeof apStore().syncAllSessionsToChat === 'function') {
            apStore().syncAllSessionsToChat(chatId, contactId);
        }
    }

    /*
     * 「封存本场景」功能已整体移除。
     *
     * 原来的 sealActiveSession() 在这里：它会盖 closedAt、把场次变成只读，
     * 并给线上角色塞一条「刚见过面」的衔接提示。但入口按钮早已被删掉，
     * 这个函数从那时起就是死代码 —— 零调用点，只占篇幅、还让读代码的人
     * 误以为「封存」是条活路径。
     *
     * 现在连底层概念一起去掉：场次一律可续写，不再有只读状态。
     * 需要「把这卷的事告诉线上角色」时，走模式切换（线下→线上）那条正常通路。
     */

    function leaveStoryToPick() {
        syncSessionOnLeave();
        closeApp();
    }

    function enterDirectOffline() {
        var st = chatStore();
        if (!st) {
            toast('聊天数据未就绪，请先打开聊天应用');
            return false;
        }
        var openId = '';
        if (global.miyaChatRoom && typeof global.miyaChatRoom.getOpenChatId === 'function') {
            openId = String(global.miyaChatRoom.getOpenChatId() || '').trim();
        }
        var chat = openId ? st.findChat(openId) : null;
        if (!chat) {
            var contacts = st.getContacts('all');
            var fallback = contacts && contacts.length ? contacts[0] : null;
            if (!fallback) {
                toast('还没有可用角色，请先在聊天里添加联系人');
                return false;
            }
            chat = ensureChatForContact(fallback.id);
        }
        if (!chat) {
            toast('无法进入线下场景，请稍后重试');
            return false;
        }
        openWithChat(String(chat.id), String(chat.contactId));
        return true;
    }

    function openWithChat(chatId, contactId, castOpt) {
        var mem = global.MiyaAppointmentMemory;
        /*
         * canonical chatId 的默认值就是「用户点进来的这个聊天」。
         *
         * v127 修复「聊得好好的会跳到另一个聊天记录的楼里」：
         * resolveCanonicalChatId 在「当前聊天没有历史消息」时，会去找该角色
         * 另一个「有历史消息」的聊天顶替上来；随后 migrateSessionsToCanonicalChat
         * 又把本聊天已有的线下场次搬过去 —— 用户于是被动换了聊天记录。
         *
         * 现在的规则：只有在用户没有显式指定目标聊天（群聊入口会传 ctx.chatId）、
         * 且当前聊天确实是「空壳」时才做规范化；否则一律以用户点进来的聊天为准。
         * 换句话说：跨聊天归并从「默认动作」降级为「空壳兜底」。
         */
        var requestedChatId = String(chatId || '').trim();
        var canonId = requestedChatId;
        if (mem && typeof mem.resolveCanonicalChatId === 'function' && requestedChatId) {
            var resolved = String(mem.resolveCanonicalChatId(requestedChatId) || '').trim();
            /*
             * 只在「当前聊天没有任何线下场次」时才接受被换成另一个聊天。
             * 已经有场次的聊天必须原地续写，不能被顶替。
             */
            var hasLocalSessions = false;
            try {
                var localList = apStore().getSessions(requestedChatId) || [];
                hasLocalSessions = localList.length > 0;
            } catch (eLs) { hasLocalSessions = false; }
            if (!hasLocalSessions && resolved) canonId = resolved;
        }
        /* 归并只在「用户没指定聊天 + 当前聊天确实空壳」时才有意义，
           且有内容保护的 migrateSessionsToCanonicalChat 自己会再判一次。 */
        if (canonId && canonId !== requestedChatId && contactId &&
            typeof apStore().migrateSessionsToCanonicalChat === 'function') {
            apStore().migrateSessionsToCanonicalChat(canonId, contactId);
        }
        var hostChatId = canonId || requestedChatId;
        var cast = Array.isArray(castOpt)
            ? castOpt
            : [{ contactId: contactId, chatId: hostChatId }];
        cast.forEach(function (row) {
            var cid = String((row && row.contactId) || '').trim();
            if (cid && typeof apStore().syncAllSessionsToChat === 'function') {
                var cChat = String((row && row.chatId) || '').trim() || hostChatId;
                apStore().syncAllSessionsToChat(cChat, cid);
            }
        });
        /*
         * 未封存场次按出演名单续上（多人此前每次强制新开导致内容像“没保存”）。
         * 显式传入 hostChatId：要求「先在本聊天里找」，不跨聊天抓。
         */
        var active =
            typeof apStore().findResumableSessionByCast === 'function'
                ? apStore().findResumableSessionByCast(cast, { chatId: hostChatId })
                : apStore().getActiveSession(hostChatId);
        var sess = active;
        var brokeNew = false;
        if (!sess) {
            sess = apStore().startNewSession(hostChatId, contactId, cast);
            brokeNew = true;
        }
        if (!sess) return;
        if ((!sess.cast || !sess.cast.length) && cast.length) {
            sess.cast = cast;
            apStore()._writeSession(sess);
        }
        /*
         * 群来源的新场次：把群名写进场景标题。
         * 否则卷宗里只会显示「未命名场景」，一群人下去玩过几次之后根本分不清哪场是哪场。
         * 只在新开场次时写 —— 续上的旧场次可能已被用户手动改名，不该覆盖。
         */
        if (brokeNew && ui.sceneTitle && !String(sess.title || '').trim()) {
            sess.title = ui.sceneTitle;
            apStore()._writeSession(sess);
        }
        ui.chatId = String(sess.chatId || hostChatId);
        ui.contactId = String(sess.contactId || contactId || '').trim();
        ui.sessionId = sess.id;
        ui.streamingLines = [];
        ui.streamingRaw = '';
        ui.status = 'idle';
        ui.view = 'story';
        /* 换场景必须先清滚动立场，否则上一场的「跟最新」会残留下来，
           配合重建 DOM 就会在生成结束时把人拽到底部。 */
        resetScrollUiState();
        render();
        /* 楼层高时直接落到最新楼层，不用手动滑到底。 */
        scrollToLatestOnEnter();
    }

    function startPickedCast() {
        var selected = Array.isArray(ui.pickSelected) ? ui.pickSelected.slice() : [];
        if (!selected.length) {
            toast('请先选择角色');
            return;
        }
        var cast = [];
        selected.forEach(function (cid) {
            var chat = ensureChatForContact(cid);
            if (!chat) return;
            cast.push({ contactId: String(cid), chatId: String(chat.id) });
        });
        if (!cast.length) {
            toast('无法创建会话，请稍后重试');
            return;
        }
        openWithChat(cast[0].chatId, cast[0].contactId, cast);
    }

    /**
     * 从卷宗列表点开一卷 —— 现在等同于「就地续写」。
     *
     * 原先分两步：点进来先置 viewingArchive = true（只读、输入框藏起），
     * 再由卷宗条上的「续写这一幕」摘掉标记。但封存概念早已整体移除，
     * 「所有卷都能续写」，那个中间态纯属历史残留，还顺带制造了
     * 「为什么进来不能打字」的困惑。
     *
     * 现在：点开即续写。同时把它标为 active，避免下一次 render 落到
     * 开场白选择器上（会盖住用户正在看的这一卷）。
     */
    function openArchiveSession(sessionId) {
        if (!ui.chatId || !sessionId) return;
        var st = apStore();
        var sess = st.getSession(ui.chatId, sessionId);
        if (!sess) {
            toast('这一卷找不到了');
            return;
        }
        if (typeof st.setActiveSession === 'function') {
            try { st.setActiveSession(ui.chatId, sessionId); } catch (e) {}
        }
        ui.sessionId = sessionId;
        ui.view = 'story';
        ui.status = 'idle';
        ui.streamingLines = [];
        ui.streamingRaw = '';
        resetScrollUiState();
        render();
        scrollToLatestOnEnter();
    }

    /*
     * 关于「续写这一幕」按钮与卷宗条：
     *
     * 该按钮曾与整条卷宗条（.xw-ribbon）一起存在，作用是「从只读的卷宗里
     * 点开的卷，切回可续写的正片」。
     *
     * 封存概念整体移除后，「所有卷一律可续写」成了唯一规则 —— 只读态本身
     * 就不该存在，那个按钮也就失去了存在前提。整条卷宗条已在 renderStory()
     * 里移除（见该函数注释），输入框改为常驻（见 render()）。
     *
     * 因此原来的 resumeArchiveSession() 已删除：它唯一的效果就是把
     * ui.viewingArchive 从 true 改成 false，而全项目再无任何地方把它置为 true。
     * 同理，只服务于「卷宗条上的改名」的 renameActiveSessionTitle() 也已删除 ——
     * 命名入口统一到了卷宗列表每行，走下面的 renameSessionById()。
     */

    /**
     * 按 sessionId 重命名（卷宗列表每行的「命名」按钮用）。
     *
     * 与 renameActiveSessionTitle 的差别：后者只认「当前打开的场次」，
     * 而卷宗列表里点命名的那一卷未必是当前活动卷 —— 改名不该顺带切场次。
     * 所以这里走显式 id，保存后只刷新列表，不动 ui.sessionId。
     */
    function renameSessionById(sessionId) {
        var sid = String(sessionId || '').trim();
        if (!ui.chatId || !sid) return;
        var sess = apStore().getSession(ui.chatId, sid);
        if (!sess) {
            toast('这一卷找不到了');
            return;
        }
        dialog({
            mode: 'prompt',
            title: '场景命名',
            message: '给这一卷场景起个名字，保存后会出现在卷宗列表里',
            defaultValue: String(sess.title || '').trim(),
            confirmText: '保存',
            cancelText: '取消'
        }).then(function (name) {
            if (name == null) return;
            var trimmed = String(name || '').trim();
            if (typeof apStore().setSessionTitle === 'function') {
                apStore().setSessionTitle(ui.chatId, sid, trimmed);
            } else {
                sess.title = trimmed;
                apStore()._writeSession(sess);
            }
            toast(trimmed ? '场景名称已保存' : '已恢复为未命名');
            render();
        });
    }

    function restoreToLiveStory() {
        ui.streamingLines = [];
        ui.streamingRaw = '';
        ui.status = 'idle';
        var active = apStore().getActiveSession(ui.chatId);
        if (active) {
            ui.sessionId = active.id;
        } else {
            var st = chatStore();
            var chat = st && st.findChat(ui.chatId);
            if (chat) {
                var sess = apStore().startNewSession(ui.chatId, chat.contactId);
                if (sess) ui.sessionId = sess.id;
            }
        }
        ui.view = 'story';
        render();
        scrollToLatestOnEnter();
    }

    function runStream(handlers) {
        ui.streamingLines = [];
        ui.streamingRaw = '';
        ui.streamingRevealLen = 0;
        ui.status = 'coming';
        resetStreamUi();
        startStreamRevealLoop();
        patchStoryBody({ streamOnly: true });
        /*
         * 注意：这里**不**重置滚动立场。
         * 用户按发送时 pinScrollToBottom() 已明确表态「我要跟最新」，
         * 那份立场必须在这一轮生成里保留，否则跟随会失效。
         * 立场只在「换场景」时清（openWithChat 等入口的 resetScrollUiState）。
         */
        return handlers
            .then(function () {
                flushStreamReveal();
                patchStreamMount();
                ui.streamingLines = [];
                ui.streamingRaw = '';
                ui.status = 'idle';
                resetStreamUi();
                patchStoryBody();
            })
            .catch(function (err) {
                ui.status = 'idle';
                ui.streamingLines = [];
                ui.streamingRaw = '';
                resetStreamUi();
                patchStoryBody();
                /* 用户主动停止：不是故障，别弹「没连上」吓人 */
                if (isAbortError(err)) return;
                if (err && err.message === 'api_not_configured') toast('请先在「设置」里填好 API');
                else if (err && err.message === 'session_not_found') toast('会话无效，请返回重选角色');
                else if (err && err.message === 'busy') toast('请稍候');
                else toast('这次没连上，稍后再试');
            });
    }

    function streamHandlers() {
        return {
            onStatus: function (s) {
                ui.status = s === 'coming' ? 'coming' : 'idle';
                if (s === 'idle') {
                    flushStreamReveal();
                    patchStoryBody();
                    resetStreamUi();
                    return;
                }
                startStreamRevealLoop();
                scheduleStreamMountPatch();
            },
            onDelta: function (full) {
                ui.streamingRaw = String(full || '');
                startStreamRevealLoop();
                scheduleStreamMountPatch();
            },
            /* 断线/空闲超时导致回复没写完：内容照常保留，但明确告诉用户
               这不是完整的回复，避免他以为角色话说到一半就停了。 */
            onPartial: function (info) {
                var why = info && info.reason === 'idle_timeout' ? '连接卡住了' : '网络中断';
                toast(why + '，这段回复没能写完');
            }
        };
    }

    var persistAppointmentPresetFromSheet = null;

    function isEnterToSend() {
        var chat = chatStore().findChat(ui.chatId);
        if (!chat) return true;
        var preset = apStore().resolvePresetForContact(chat.contactId);
        return !preset || preset.enterToSend !== false;
    }

    function sendMessage() {
        var input = $('xw-writer-input');
        if (!input) return;
        var text = String(input.value || '').trim();
        if (!text) return;
        if (typeof persistAppointmentPresetFromSheet === 'function') {
            try {
                persistAppointmentPresetFromSheet();
            } catch (e) {}
        }
        var eng = apEngine();
        if (!eng || eng.isBusy(ui.chatId, ui.sessionId)) {
            toast('等上一镜结束再说');
            return;
        }
        var wasEmpty = !storyHasContent();
        var userMsg = apStore().addMessage(ui.chatId, ui.sessionId, { role: 'user', content: text });
        if (!userMsg) {
            toast('没发出去，请退回重选角色');
            return;
        }
        input.value = '';
        input.disabled = true;
        var sendBtn = $('xw-writer-go');
        if (sendBtn) sendBtn.disabled = true;
        if (wasEmpty) {
            render();
        } else {
            patchStoryBody();
        }

        /* 先进入 runStream 显示「书写中」，再启动 completion，避免同步拼 prompt 卡住首帧 */
        var handlers = streamHandlers();
        beginWriterGeneration();
        runStream(
            Promise.resolve()
                .then(function () {
                    if (typeof eng.runAppointmentCompletion === 'function') {
                        return eng.runAppointmentCompletion(ui.chatId, ui.sessionId, handlers);
                    }
                    return eng.sendAppointment(ui.chatId, ui.sessionId, text, handlers);
                })
                .then(function (r) {
                    /* 到这里才算真的写完了。失败/中止不会进这个分支（走 finally）。 */
                    playOfflineDoneSound();
                    return r;
                })
                .finally(function () {
                    endWriterGeneration();
                })
        );
    }

    /*
     * ═══════════════════════════════════════════════════════════
     * 楼层刷新（统一的「再生成一版」入口）
     * ═══════════════════════════════════════════════════════════
     *
     * 历史沿革 —— 这里原来有两个入口，做的是同一件事：
     *
     *   · quickRedoLastAssistant()  —— 输入框左边的「重回 ↶」键，
     *     只作用于**末尾那一轮**，而且是全局按钮（不指向任何具体楼层）。
     *   · generateSwipeForMessage() —— 楼层右下角的候选键 ›，
     *     作用于**被点的那一层**。
     *
     * 两者最终都调引擎的 regenerateAppointment（让角色把这一轮重答一次），
     * 只是作用范围与落点不同。用户面对两个做同一件事的按钮，只能靠试错
     * 去猜该点哪个 —— 而它们的差别（末轮 vs 指定层）在界面上完全看不出来。
     *
     * 现在统一成一条路径：**刷新是楼层自己的能力**。
     * 入口只剩一个（楼层右下角的 ›），语义也唯一 ——
     * 「这一层，再给我一版」。输入框左边的「重回 ↶」已移除。
     *
     * 三条不变式（改这里之前请先读完）：
     *
     *   ① 刷新谁，就只动谁。
     *      软删范围 == 写回范围 == 被点的那一层。绝不能顺手删整轮 ——
     *      引擎只复活 replaceTargetId 指向的那一层，多删的层会永久消失。
     *
     *   ② 原版必须留成候选锚点。
     *      走 softDeleteForRegenerate，它会先把当前正文归档进 swipes[0]，
     *      这样「原版 / 历次刷新 / 最新」从第一次起就都在，
     *      右下角的 ‹ › 也能立刻用起来。
     *
     *   ③ 刷新的过程要「看得见」。
     *      被刷的那一层立刻从屏上消失，原地只剩一个「书写中」。
     *      不复用旧正文做占位 —— 那会让人以为「点了没反应」。
     *
     * 注：原来这里还有一个 getTrailingAssistantRound()，用来给「重回」
     * 找「末尾那一轮的角色楼层」。那个键移除后它就没有调用点了 ——
     * 现在目标层由点击事件直接带过来（data-ap-msg-* 上的 id），
     * 不再需要「猜末轮」这种间接做法，所以一并删掉。
     */

    /*
     * 目标楼层现在有几个候选？
     *
     * 这个数字有两个用途：
     *   · 作为 regenerateAppointment 的 attempt（告诉模型「这是第几次重答」）。
     *     连点两三次刷新后仍出同一段话是很常见的抱怨，根因是每轮 prompt
     *     几乎一模一样、模型不知道自己正在重答（详见引擎侧
     *     buildRegenerateHintBlock 的说明）。把序号带上，至少让「再刷一次」
     *     在输入侧是可区分的。
     *   · 判断刷新后要不要提示「可以用 ‹ › 翻看」。
     *
     * 为什么用候选表长度而不是自己维护计数器：候选表就是「这一层被重答过
     * 几次」的权威记录，跟随软删/复活/切换候选自动同步，不会漂。
     * 取 0 时调用方兜底成 1（第一次重答）。
     */
    function floorSwipeCount(m) {
        return m && Array.isArray(m.swipes) ? m.swipes.length : 0;
    }

    /**
     * 刷新失败时的统一兜底：把被刷的那一层原样放回去。
     *
     * 为什么必须还原：上面已经把这一层软删了（正文清空、content 变 ''）。
     * 只要这一次生成没成功（断网、额度、接口报错、用户中途停止），
     * 这一层就已经永久空了 —— 用户点一下按钮等于把内容删掉，还没有撤销。
     * 这和重发（redoFromMessage）暴露的是同一类问题，处理方式也一致：
     * 失败就把存好的那一版放回原位，并明确告诉用户「已放回去」。
     */
    function restoreFloorAfterFailedRegenerate(m) {
        var aps = apStore();
        if (!aps || !m) return;
        if (typeof aps.restoreMessage === 'function') {
            aps.restoreMessage(ui.chatId, ui.sessionId, m);
        }
    }

    /**
     * 让指定楼层「再生成一版」。
     *
     * 三个调用方，语义两两不同：
     *
     *   · 楼层右下角的候选键 ›  —— 点在**角色楼层**上，重刷这一层自己。
     *     语义是「多来一版」，所以要把旧版**归档成候选**（可 ‹ 翻回）。
     *     这是**唯一**会产生候选项的入口 —— 只有它传 keepVersion=true。
     *
     *   · 刷新键                —— 也在**角色楼层**上，同样是重刷这一层。
     *     语义是「这一版不要了，重写一版干净的」，**绝不留下候选**。
     *
     *   · 刷新键                —— 点在**我发的消息**上（生成失败后它就
     *     成了最新楼层），此时要「保留我发的这条、在它后面生成新楼层」，
     *     而不是重写我自己写的话。这一条不看 keepVersion（user 楼层压根
     *     没有候选表的概念），详见 regenerateAfterUserFloor 的注释。
     *
     * ⚠️ 曾经踩过的坑：早期把 refreshToolHtml 的 keep 参数默认成 true，
     * 于是角色楼层的刷新键走的是 keepVersion=true —— 那和 › 键**完全等价**，
     * 连「生成出候选内容、显示 2 / 2」都一模一样。用户一眼就看穿了：
     * 「刷新键怎么会生成出候选内容啊，这不是 › 键的活吗」—— 说得对。
     * 候选归档从此只属于 ›（见 applyOfflineSwipe → generateSwipeForMessage），
     * 刷新键一律 keepVersion=false，默认值也跟着调成 false，
     * 免得再有调用方漏传参数就悄悄变成「第二个 › 键」。
     */
    function regenerateFloor(m, keepVersion) {
        if (!m || !m.id) return;
        var eng = apEngine();
        if (!eng) return;
        if (eng.isBusy(ui.chatId, ui.sessionId)) {
            toast('等上一镜结束再说');
            return;
        }
        if (m.role === 'assistant') {
            regenerateAssistantFloor(m, keepVersion);
            return;
        }
        regenerateAfterUserFloor(m);
    }

    /**
     * 角色楼层刷新：就地再生成一版，写回**同一层**。
     *
     * 前置校验只有一条 —— 它得是有正文的角色回复。
     * 允许它不是最后一层：重答会就地替换这一层当前显示的那版，
     * 它后面的楼层不受影响（后面的内容只把这一层的**当前版**当历史，
     * 而我们要做的正是把当前这版换掉）。
     *
     * keepVersion **没有「默认保留」语义**，缺省即 false（不留候选）。
     *
     * 只有 › 键那条路（generateSwipeForMessage）显式传 true 才会归档旧版。
     * 这个默认值的方向是刻意选的：漏传参数的代价是「少一个候选项」，
     * 而不是「凭空多出一个和 › 重复的行为」—— 后者正是这次修掉的问题。
     */
    function regenerateAssistantFloor(m, keepVersion) {
        if (!String(m.content || '').trim()) {
            toast('这一层还没有内容，先让它生成完');
            return;
        }
        /* 缺省 false：不归档候选。候选只属于 › 键 */
        var keep = keepVersion === true;
        var eng = apEngine();
        var aps = apStore();
        var attempt = Math.max(1, floorSwipeCount(m));
        var hadSwipes = floorSwipeCount(m) >= 2;

        /*
         * ⚠️ 顺序很重要：先进入「生成中」，再重绘。
         *
         * 反过来（先 patchStoryBody 再 beginWriterGeneration）会有两个后果：
         *   1. 被刷的那一层已经软删、屏上是空的，而此刻 ui.status 还是 idle
         *      —— 「书写中」没有任何东西去渲染它，用户看到的是**一片空白**，
         *      要等 runStream 把 status 置成 coming 之后才补上提示，
         *      中间那一下空白就是「点了刷新，楼层直接没了」的观感来源。
         *   2. storyHasContent() 在软删后依赖「原始会话还有行」才判真
         *      （见该函数的说明），早一步进入 coming 状态可以让它多一层保险。
         */
        beginWriterGeneration();

        /*
         * 归档原版 → 软删这一层。
         *
         * keep === true（**只有右下角 › 会走到**）：走 softDeleteForRegenerate。
         *   它会把当前正文归档进 swipes[0] 作为锚点，所以引擎随后
         *   「不重复补第一条候选」的判断也认这个标记 —— 见引擎侧那段
         *   keepRegenCandidate 的说明。这是全应用**唯一**生成候选的入口。
         *
         * keep === false（刷新键，也是缺省）：走 deleteMessage，传入
         *   swipes: [] 顺手把候选表清空，「不保留」才是一句真话 ——
         *   否则旧候选还挂在行上，用户翻 ‹ 依然能看到它们。
         *   这里也**不**通过 extra 传 content，deleteMessage 自己会置 ''。
         */
        if (aps && keep && typeof aps.softDeleteForRegenerate === 'function') {
            aps.softDeleteForRegenerate(ui.chatId, ui.sessionId, m.id);
        } else if (aps && typeof aps.deleteMessage === 'function') {
            aps.deleteMessage(ui.chatId, ui.sessionId, m.id, keep ? undefined : { swipes: [] });
        }

        /*
         * 就地重绘：被刷的那一层此刻已经是软删态，
         * renderStoryLines 会跳过它 —— 屏上只剩正文里别的楼层 + 一个「书写中」。
         * 这正是需求要的「刷新之后这一层消失，只留书写中的提示」。
         */
        var inp = $('xw-writer-input');
        if (inp) inp.disabled = true;
        patchStoryBody();
        patchStreamMount();

        runStream(
            Promise.resolve()
                .then(function () {
                    return eng.regenerateAppointment(
                        ui.chatId,
                        ui.sessionId,
                        streamHandlers(),
                        {
                            replaceTargetId: m.id,
                            attempt: attempt,
                            /* 见引擎侧 keepRegenCandidate：› 留旧版，刷新键不留 */
                            keepRegenCandidate: keep
                        }
                    );
                })
                .then(function (r) {
                    playOfflineDoneSound();
                    return r;
                })
                .catch(function (err) {
                    /*
                     * 用户点「停止」也走这里 —— 那不是故障，别把楼层搬回去、
                     * 别弹错、更别重绘（重绘会把「书写中」重新挂回去并残留）。
                     * 停止该做的事只有一件：把界面放回可交互，收尾交给 .finally。
                     */
                    if (isAbortError(err)) return;
                    restoreFloorAfterFailedRegenerate(m);
                    patchStoryBody();
                    toast('没生成出来，已把这一层放回去');
                    if (global.console && console.warn) {
                        console.warn('[floor] regenerate failed', err);
                    }
                })
                .finally(function () {
                    endWriterGeneration();
                })
        );

        if (keep && hadSwipes) {
            toast('已刷新，用右下角 ‹ › 翻看各个版本');
        }
    }

    /**
     * 「我发的消息」楼层刷新：保留这条消息，在它**后面**生成新楼层。
     *
     * 场景（用户报的）：上一轮生成失败，于是最新楼层停在「我发的那条」上。
     * 这时用户点这一层的刷新键，期望显然是「再试一次、让角色答我」——
     * 而不是把**我自己写的那句话**重写一遍。
     *
     * 所以这里和角色楼层走的是两条路径：
     *
     *   · 角色楼层 → regenerateAppointment(replaceTargetId=本层)
     *     写回本层，本层内容被替换成新候选。
     *
     *   · 我发的消息 → 先删掉它**之后**的所有楼层（失败时留下的空壳、
     *     或半截回复），**保留这条 user 本身**，再让引擎接着往下写。
     *     新内容以一条**新的角色楼层**出现，我发的那条原封不动。
     *
     * 为什么用 runAppointmentCompletion 而不是 sendAppointment：
     * 那条 user 楼层**已经在库里了**，不能再 addMessage 一遍 ——
     * 那会凭空多出一条同内容楼层（这正是「删了楼再重发结果还是老样子」
     * 的成因之一）。runAppointmentCompletion 不写 user、只生成 assistant，
     * 语义正好是「上下文已经摆好，请接着答」。
     *
     * 为什么只删「之后」而不是「含自己」：见上面 redoFromMessage 里那段
     * 长注释 —— 删掉自己再重发会让 prompt 里出现两份同样的问题，
     * 模型读到的就是「问题A、问题A」，重答出来的内容必然高度雷同。
     */
    function regenerateAfterUserFloor(m) {
        var store = apStore();
        var sess = store.getSession(ui.chatId, ui.sessionId);
        if (!sess || !Array.isArray(sess.messages)) return;
        var idx = sess.messages.findIndex(function (x) {
            return x && x.id === m.id;
        });
        if (idx < 0) return;

        /*
         * 快照 + 删除，都走 redoFromMessage 里那套经过验证的区间语义：
         * removeMessagesFrom 自己枚举、自己删，全部成功才返回 true。
         * 失败就把快照原样放回，绝不留下「删了一半」的中间态。
         */
        var snap = snapshotMessagesFrom(sess, idx + 1);
        if (!removeMessagesFrom(idx + 1)) {
            toast('刷新中断：没能清掉后面的楼层');
            return;
        }

        beginWriterGeneration();
        var inp = $('xw-writer-input');
        if (inp) inp.disabled = true;
        /* 删完立刻重绘：这条 user 还在屏上，它后面干净的等新内容 */
        patchStoryBody();
        patchStreamMount();

        var eng = apEngine();
        runStream(
            Promise.resolve()
                .then(function () {
                    /*
                     * ⚠️ keepRegenCandidate 显式传 false。
                     *
                     * 这条路径会生成**全新的角色楼层**（不是就地重写），
                     * 所以它本身就不该归档任何候选 —— 归档的前提是
                     * 「同一层里有多版可以互相翻」，而这里连被覆盖的层都没有。
                     *
                     * 不传的后果和 redoFromMessage 那次一样：引擎落到
                     * `!== false` 的默认 true 分支。虽然本路径下引擎那条
                     * 「并入候选」的代码因为目标层是新建的、走不到归档，
                     * 但语义不该靠「碰巧走不到」来保证 —— 显式写死 false，
                     * 免得以后引擎侧调整了回退逻辑，这里又悄悄长出候选。
                     */
                    return eng.runAppointmentCompletion(
                        ui.chatId,
                        ui.sessionId,
                        Object.assign(streamHandlers(), { keepRegenCandidate: false })
                    );
                })
                .then(function (r) {
                    playOfflineDoneSound();
                    return r;
                })
                .catch(function (err) {
                    /* 用户主动停止：同上层，不当故障处理 */
                    if (isAbortError(err)) return;
                    /* 失败把刚才删掉的楼层原样放回，这条 user 从头到尾没被碰过 */
                    restoreMessageSnapshot(snap);
                    patchStoryBody();
                    toast('刷新失败，已还原原来的楼层');
                    if (global.console && console.warn) {
                        console.warn('[floor] regenerate after user failed', err);
                    }
                })
                .finally(function () {
                    endWriterGeneration();
                })
        );
    }

    function openSettingsSheet() {
        var chat = chatStore().findChat(ui.chatId);
        if (!chat) return;
        var preset = apStore().resolvePresetForContact(chat.contactId);
        var sheet = document.createElement('div');
        sheet.className = 'xw-drawer xw-drawer--manga';
        sheet.id = 'xw-settings-sheet';

        var wbEntries = [];
        var wbs = global.miyaWorldbookStore;
        if (wbs && typeof wbs.listEntries === 'function') {
            wbEntries = wbs.listEntries();
        }

        var bindingRows = (preset.worldbookBindings || [])
            .map(function (b) {
                var ent = wbEntries.find(function (e) {
                    return e.id === b.entryId;
                });
                return { entryId: b.entryId, name: (ent && ent.name) || b.entryId, order: b.order };
            })
            .sort(function (a, b) {
                return a.order - b.order;
            });

        var summaries = apStore().getSessionSummaries(ui.chatId, ui.sessionId);

        function renderWbList() {
            return bindingRows
                .map(function (row) {
                    return (
                        '<div class="xw-wb-row" data-ap-wb-id="' +
                        esc(row.entryId) +
                        '"><span class="xw-wb-row__name">' +
                        esc(row.name) +
                        '</span><button type="button" data-ap-wb-rm="' +
                        esc(row.entryId) +
                        '" aria-label="移除">×</button></div>'
                    );
                })
                .join('');
        }

        function renderSumList() {
            if (!summaries.length) {
                return '<p class="xw-empty" style="padding:8px;font-size:11px">还没有纪要</p>';
            }
            return summaries
                .map(function (row) {
                    return (
                        '<article class="xw-note-entry" data-ap-sum-entry="' +
                        esc(row.id) +
                        '">' +
                        '<div class="xw-note-entry-meta">第 ' +
                        esc(String(row.startIndex)) +
                        '–' +
                        esc(String(row.endIndex)) +
                        ' 条 · ' +
                        esc(formatTs(row.createdAt)) +
                        '</div>' +
                        '<p class="xw-note-entry-body">' +
                        esc(row.content).replace(/\n/g, '<br>') +
                        '</p>' +
                        '<div class="xw-note-entry-actions">' +
                        '<button type="button" data-ap-sum-edit="' +
                        esc(row.id) +
                        '">改</button>' +
                        '<button type="button" data-ap-sum-redo="' +
                        esc(row.id) +
                        '">重写纪要</button>' +
                        '<button type="button" data-ap-sum-del="' +
                        esc(row.id) +
                        '">删除</button></div></article>'
                    );
                })
                .join('');
        }

        function renderPresetOptions() {
            var presets = apStore().getSavedParamPresets();
            return (
                '<option value="">读取参数预设…</option>' +
                presets
                    .map(function (p) {
                        return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
                    })
                    .join('')
            );
        }

        sheet.innerHTML =
            '<div class="xw-drawer__panel">' +
            '<div class="xw-drawer__head xw-manga-head">' +
            '<span class="xw-drawer__kicker">线下 · 设置</span>' +
            '<h3>这一场的设置</h3>' +
            '<p>文风、人称、篇幅与分段完全由 ST 预设控制；这里仅保留线下模块自身的功能设置。</p></div>' +
            '<section class="xw-manga-panel">' +
            '<div class="xw-field xw-field--panel"><label>参数预设</label>' +
            '<div class="xw-field--split">' +
            '<select id="mol-preset-load" class="xw-wb-add">' +
            renderPresetOptions() +
            '</select>' +
            '<button type="button" class="xw-btn" id="mol-preset-save">存为预设</button>' +
            '<button type="button" class="xw-btn" id="mol-preset-del">删预设</button></div>' +
            '<p class="xw-field__hint">预设不含世界书；读取后写入表单，须点「保存参数」才会绑定到当前角色。</p></div>' +
            /*
             * 自动纪要开关已移除：自动归档不再触发，这个输入框填任何值都无效。
             * summaryTrigger 字段仍在预设里保留读写，老配置不会串位。
             */
            '<div class="xw-field xw-field--panel"><label>输出方式</label><select id="mol-stream-mode">' +
            (function () {
                var cfg =
                    typeof global.miyaGetApiConfigCached === 'function' ? global.miyaGetApiConfigCached() : {};
                var streamOn = cfg.appointmentStream !== false;
                return (
                    '<option value="true"' +
                    (streamOn ? ' selected' : '') +
                    '>流式</option><option value="false"' +
                    (streamOn ? '' : ' selected') +
                    '>非流式</option>'
                );
            })() +
            '</select></div>' +
            '<div class="xw-field xw-field--panel"><label>查看思维链</label>' +
            '<select id="mol-show-thinking">' +
            (preset.showThinking !== false
                ? '<option value="true" selected>开</option><option value="false">关</option>'
                : '<option value="true">开</option><option value="false" selected>关</option>') +
            '</select>' +
            '<p class="xw-field__hint">关则本场不显示推理过程（仍写入记录）</p></div>' +
            '<div class="xw-field xw-field--panel"><label>回车发送</label>' +
            '<select id="mol-enter-send">' +
            (preset.enterToSend !== false
                ? '<option value="true" selected>开</option><option value="false">关</option>'
                : '<option value="true">开</option><option value="false" selected>关</option>') +
            '</select></div>' +
            /*
             * 「正文美化」与「状态栏」两个开关已从调参抽屉移除，
             * 改为**恒定开启**（见 resolveTextDecor() 与 MiyaOfflineStatus.isEnabled()）。
             *
             * 为什么删：这两项开着才是「正常好看」的状态，几乎没人会去关；
             * 留着开关反而让抽屉更长，还把「关掉后正文变丑」这种坑暴露给用户。
             *
             * 为什么是强制开、而不是「只看默认值」：
             * 以前手动关过的用户，存量数据里存的就是 false。UI 一删，
             * 他们就再也找不到打开的入口，会永久停在关闭状态 —— 那是个死胡同。
             * 所以判定逻辑直接恒返回 true，旧数据里的 false 不再生效。
             *
             * ⚠️ 字段本身（preset.textDecor / statusBar.enabled）仍然保留在数据层：
             *    不去清理用户数据，万一以后要恢复开关，值还在。
             */
            /*
             * 「开场白预设」面板也已从这里移除。
             *
             * 原因：它和联系人 App 档案里的「开场白」功能重复，而且位置在调参抽屉
             * 底部 —— 预设一多，整个抽屉要下滑很久才能摸到下面的「额外挂世界书」
             * 和「本卷纪要」。维护入口收敛到联系人 App 一处即可：在那里加/改，
             * 线下「选择开场白」首屏会自动读到（见 contactProfileGreetingRows 的桥接）。
             *
             * ⚠️ 注意：删掉的只是【手工预设的管理界面】。
             * 下面这些【都还在】、都还要用，别一起删了：
             *   - renderOpeningPicker()          新场景首屏的「选择开场白」
             *   - openingPresetRowsForContact()  选择器读的数据（档案 + 手工预设合并）
             *   - contactProfileGreetingRows()   把联系人档案 greetings 桥接过来
             */
            '</section>' +
            '<section class="xw-manga-panel">' +
            '<div class="xw-field xw-field--panel"><label>额外挂世界书</label>' +
            '<div class="xw-wb-list" id="xw-wb-list">' +
            renderWbList() +
            '</div>' +
            '<select id="mol-wb-add" class="xw-wb-add"><option value="">＋ 绑定词条</option>' +
            wbEntries
                .map(function (e) {
                    return '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>';
                })
                .join('') +
            '</select></div>' +
            '<div class="xw-field xw-field--panel"><label>本卷纪要</label>' +
            '<div class="xw-note-list" id="xw-note-list">' +
            renderSumList() +
            '</div></div></section>' +
            '<div class="xw-drawer__foot xw-manga-foot">' +
            '<button type="button" id="mol-params-save" class="xw-btn xw-btn--solid">保存参数</button>' +
            '<button type="button" id="xw-note-run" class="xw-btn">生成纪要</button>' +
            '<button type="button" id="mol-sheet-close">收起</button></div></div>';

        document.body.appendChild(sheet);
        requestAnimationFrame(function () {
            sheet.classList.add('is-open');
        });

        function bindWbRm() {
            sheet.querySelectorAll('[data-ap-wb-rm]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var id = btn.getAttribute('data-ap-wb-rm');
                    bindingRows = bindingRows.filter(function (r) {
                        return r.entryId !== id;
                    });
                    $('xw-wb-list').innerHTML = renderWbList();
                    bindWbRm();
                });
            });
        }
        bindWbRm();

        $('mol-wb-add').addEventListener('change', function () {
            var id = String(this.value || '').trim();
            this.value = '';
            if (!id) return;
            if (bindingRows.some(function (r) { return r.entryId === id; })) return;
            var ent = wbEntries.find(function (e) { return e.id === id; });
            bindingRows.push({
                entryId: id,
                name: (ent && ent.name) || id,
                order: bindingRows.length
            });
            $('xw-wb-list').innerHTML = renderWbList();
            bindWbRm();
        });

        function persistAppointmentStreamMode() {
            var sel = $('mol-stream-mode');
            if (!sel) return;
            var streamOn = sel.value !== 'false';
            if (typeof global.miyaSetApiConfig === 'function') {
                var prev =
                    typeof global.miyaGetApiConfigCached === 'function' ? global.miyaGetApiConfigCached() : {};
                global.miyaSetApiConfig(Object.assign({}, prev, { appointmentStream: streamOn }));
            } else if (typeof global.setFruitApiConfig === 'function') {
                var prev2 =
                    typeof global.getFruitApiConfigCached === 'function' ? global.getFruitApiConfigCached() : {};
                global.setFruitApiConfig(Object.assign({}, prev2, { appointmentStream: streamOn }));
            }
        }

        function readFormParams() {
            persistAppointmentStreamMode();
            /*
             * summaryTrigger 输入框已移除。这里沿用预设原值，不再从表单读，
             * 避免 $('xw-note-trigger') 为 null 时抛错，也避免把用户旧配置写丢。
             */
            var summaryTrigger =
                preset && preset.summaryTrigger != null ? preset.summaryTrigger : 0;
            /*
             * textDecor 恒为 true：对应的「正文美化」开关已从抽屉移除，
             * $('mol-text-decor') 不再存在（直接读 .value 会抛 TypeError）。
             *
             * 为什么不写成「沿用 preset 原值」：
             * 那样旧数据里的 false 会被一直续写下去，用户永远停在「正文没美化」
             * 且无法恢复的状态。这里直接置 true，下次保存就把旧值覆盖掉，
             * 等于顺手完成一次温和的数据修正。
             */
            return {
                summaryTrigger: summaryTrigger,
                summaryPrompt: String((preset && preset.summaryPrompt) || '').trim(),
                showThinking: $('mol-show-thinking').value !== 'false',
                enterToSend: $('mol-enter-send').value !== 'false',
                textDecor: true
            };
        }

        function readForm() {
            var params = readFormParams();
            return Object.assign({}, params, {
                id: preset.id,
                name: preset.name,
                worldbookBindings: bindingRows.map(function (r, i) {
                    return { entryId: r.entryId, order: i };
                })
            });
        }

        function applyParamsToForm(params) {
            if (!params) return;
            /* summaryTrigger 输入框已移除；字段仍在预设里流转，此处不再回填 UI。 */
            if ($('mol-show-thinking')) {
                $('mol-show-thinking').value = params.showThinking !== false ? 'true' : 'false';
            }
            if ($('mol-enter-send')) {
                $('mol-enter-send').value = params.enterToSend !== false ? 'true' : 'false';
            }
            /* textDecor 回填已移除：对应开关不在抽屉里了（恒为开）。 */
        }

        function refreshPresetSelect(selectedId) {
            var sel = $('mol-preset-load');
            if (!sel) return;
            sel.innerHTML = renderPresetOptions();
            if (selectedId) sel.value = selectedId;
        }

        function persistPresetFromForm() {
            if (!chat || !chat.contactId) return false;
            var params = readFormParams();
            apStore().saveContactParams(chat.contactId, params);
            apStore().saveContactWorldbook(
                chat.contactId,
                bindingRows.map(function (r, i) {
                    return { entryId: r.entryId, order: i };
                })
            );
            /*
             * 状态栏恒为开：对应的开关已从抽屉移除，$('mol-status-fab') 不再存在。
             * 但仍然显式写一次 enabled: true —— 这是把旧数据里可能残留的 false
             * 「扶正」的唯一时机（用户下次点「保存参数」时就顺手修好了）。
             */
            if (typeof apStore().saveStatusBar === 'function') {
                apStore().saveStatusBar({ enabled: true });
            }
            syncStatusFab();
            ui.stableStoryKey = '';
            try {
                patchStoryBody();
            } catch (e) {}
            return true;
        }

        /* 悬浮球已移除：原 paintStatusFabPreview / readFabIconFile 一并删除 */


        /* 悬浮球功能已整体移除：图标预览 / 上传 / 重置 三段 UI 与逻辑一并删除，
           MiyaOfflineStatus.ensureFab / applyFabAppearance 现在都是 no-op。 */

        persistAppointmentPresetFromSheet = persistPresetFromForm;


        $('xw-note-run').addEventListener('click', function () {
            persistPresetFromForm();
            runManualSummary({})
                .then(function () {
                    refreshSumList();
                })
                .catch(function () {});
        });

        function refreshSumList() {
            summaries = apStore().getSessionSummaries(ui.chatId, ui.sessionId);
            var el = $('xw-note-list');
            if (el) el.innerHTML = renderSumList();
            bindSumActions();
        }

        function bindSumActions() {
            sheet.querySelectorAll('[data-ap-sum-edit]').forEach(function (btn) {
                btn.onclick = function () {
                    var sid = btn.getAttribute('data-ap-sum-edit');
                    var row = summaries.find(function (r) { return r.id === sid; });
                    if (!row) return;
                    dialog(storyEditDialogOpts('改总结', '修改总结内容', row.content)).then(function (val) {
                        if (val == null) return;
                        apStore().updateSummary(ui.chatId, ui.sessionId, sid, {
                            content: String(val).trim()
                        });
                        refreshSumList();
                        patchStoryBody();
                        toast('总结已更新');
                    });
                };
            });
            sheet.querySelectorAll('[data-ap-sum-redo]').forEach(function (btn) {
                btn.onclick = function () {
                    var sid = btn.getAttribute('data-ap-sum-redo');
                    runManualSummary({ replaceSummaryId: sid })
                        .then(function () {
                            refreshSumList();
                        })
                        .catch(function () {});
                };
            });
            sheet.querySelectorAll('[data-ap-sum-del]').forEach(function (btn) {
                btn.onclick = function () {
                    dialog({
                        mode: 'confirm',
                        title: '删除总结',
                        message: '删除后，对应段落将按原文参与记忆注入。',
                        confirmText: '删除',
                        cancelText: '取消'
                    }).then(function (ok) {
                        if (!ok) return;
                        apStore().deleteSummary(ui.chatId, ui.sessionId, btn.getAttribute('data-ap-sum-del'));
                        refreshSumList();
                        patchStoryBody();
                        toast('总结已删除');
                    });
                };
            });
        }
        bindSumActions();

        /*
         * 「开场白预设」的增删绑定已随之移除：
         *   refreshOpeningPresetList() / bindOpeningPresetActions() / 存为预设按钮
         * 那三块代码服务的 DOM（#xw-opening-preset-list / -name / -content / -add）
         * 已经不在抽屉里，留着只会是永不命中的空绑定。
         *
         * 数据接口（apStore().getContactOpeningPresets / upsert / delete）保留在 store 层：
         * 历史数据还在，且「选择开场白」的合并逻辑仍会把已有预设读出来展示。
         */

        $('mol-params-save').addEventListener('click', function () {
            if (persistPresetFromForm()) toast('已保存当前角色参数');
        });

        $('mol-preset-save').addEventListener('click', function () {
            dialog({
                mode: 'prompt',
                title: '存为参数预设',
                message: '预设名称（不含世界书绑定）',
                defaultValue: '',
                confirmText: '保存',
                cancelText: '取消'
            }).then(function (name) {
                if (name == null) return;
                var trimmed = String(name || '').trim();
                if (!trimmed) {
                    toast('请输入预设名称');
                    return;
                }
                var row = apStore().upsertSavedParamPreset(
                    Object.assign({}, readFormParams(), { name: trimmed })
                );
                if (row) {
                    refreshPresetSelect(row.id);
                    toast('预设已保存');
                }
            });
        });

        $('mol-preset-del').addEventListener('click', function () {
            var sel = $('mol-preset-load');
            var pid = sel ? String(sel.value || '').trim() : '';
            if (!pid) {
                toast('请先选择要删除的预设');
                return;
            }
            dialog({
                mode: 'confirm',
                title: '删除参数预设',
                message: '删除后不可恢复，确认删除？',
                confirmText: '删除',
                cancelText: '取消'
            }).then(function (ok) {
                if (!ok) return;
                apStore().deleteSavedParamPreset(pid);
                refreshPresetSelect('');
                toast('预设已删除');
            });
        });

        $('mol-preset-load').addEventListener('change', function () {
            var pid = String(this.value || '').trim();
            this.value = '';
            if (!pid) return;
            var hit = apStore().getSavedParamPresets().find(function (p) {
                return p.id === pid;
            });
            if (!hit) return;
            applyParamsToForm(hit);
            toast('已读取预设，点「保存参数」写入当前角色');
        });

        $('mol-sheet-close').addEventListener('click', closeSheet);
        sheet.addEventListener('click', function (e) {
            if (e.target === sheet) closeSheet();
        });

        function closeSheet() {
            try {
                persistPresetFromForm();
            } catch (e) {}
            persistAppointmentPresetFromSheet = null;
            sheet.classList.remove('is-open');
            setTimeout(function () {
                sheet.remove();
            }, 320);
        }
    }


    /**
     * 「从这一层开始，往后全删」。
     *
     * ⚠️ 目前已无调用者 —— 保留是因为它的语义本身没错，只是**不适合重发**。
     *
     * 重发（redoFromMessage）曾经用它，出过两个问题：
     *   ① 它把被点的那条 user 自己也删了，调用方只好再 addMessage 一遍，
     *      于是 prompt 里同一条提问出现两次；
     *   ② 它与 removeMessagesFrom() 职责重叠，容易选错。
     * 现在重发统一走 removeMessagesFrom(idx + 1)，区间是明确的。
     *
     * 如果以后要加「从这里截断对话」这类功能，可以直接用它；
     * 但凡涉及「重发 / 重答」，请用 removeMessagesFrom()。
     */
    function deleteFromMessage(msgId) {
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess) return;
        var idx = sess.messages.findIndex(function (m) {
            return m.id === msgId;
        });
        if (idx < 0) return;
        sess.messages.slice(idx).forEach(function (m) {
            apStore().deleteMessage(ui.chatId, ui.sessionId, m.id);
        });
        patchStoryBody();
    }

    function deleteSingleMessage(msgId) {
        apStore().deleteMessage(ui.chatId, ui.sessionId, msgId);
        patchStoryBody();
        toast('已删除');
    }

    function editMessage(msgId) {
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess) return;
        var msg = (sess.messages || []).find(function (m) {
            return m.id === msgId;
        });
        if (!msg || msg.deleted) return;
        dialog(storyEditDialogOpts('改', '修改本条内容', msg.content)).then(function (val) {
            if (val == null) return;
            var text = String(val).trim();
            if (!text) {
                toast('内容不能为空');
                return;
            }
            apStore().updateMessage(ui.chatId, ui.sessionId, msgId, { content: text });
            patchStoryBody();
            toast('已保存');
        });
    }

    function assistantRoundStartId(sess, msg) {
        var list = (sess.messages || []).filter(function (m) {
            return m && !m.deleted;
        });
        var idx = list.findIndex(function (m) {
            return m.id === msg.id;
        });
        if (idx < 0) return msg.id;
        var start = idx;
        while (start > 0 && list[start - 1].role === 'assistant') start -= 1;
        return list[start].id;
    }

    /*
     * 楼层上的那个「重发」按钮。
     *
     * 这里原来是直接调 deleteFromMessage() 把「被点的那层 + 之后的所有层」删掉，
     * 然后才去请求模型。问题是：删除是立刻落库的，而重发只是发了一个网络请求。
     * 只要这一下没成功（断网、额度、接口报错、用户中途点停止），
     * 那几层就已经永久没了 —— 点一下按钮等于删档，而且还没有撤销。
     *
     * 现在改成：
     *   1. 先把「要重写的区间」整段快照下来（内容、思考、swipes、隐藏状态、时间戳，全都要）；
     *   2. 精确删掉「被点那层的起点」之后的楼层，只动需要重写的那一段；
     *   3. 重发失败就把快照按原顺序原样放回去，并明确告诉用户「已撤销」，而不是假装无事发生。
     *
     * 成功路径不变：区间被新生成的内容替换掉，这正是「重发」该有的样子。
     */
    function redoFromMessage(msg, autoSend) {
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess || !msg) return;
        var idx = sess.messages.findIndex(function (m) {
            return m.id === msg.id;
        });
        if (idx < 0) return;

        if (msg.role === 'user') {
            var text = msg.content;
            var userSnap = snapshotMessagesFrom(sess, idx);
            /*
             * ⚠️ 只删「这一层之后」的楼层，**这一层本身要留着**。
             *
             * 原来调的是 deleteFromMessage(msg.id)，它从 idx 开始删 ——
             * 把被点的那条 user 自己也删了。然后下面 sendAppointment 会
             * 在末尾 addMessage 一条**新的** user，内容就是原文。
             *
             * 于是 prompt 里出现两份同样的内容：
             *
             *   deleteFromMessage 删掉 user:问题A
             *     → 库里只剩 … / assistant:回复X
             *   sendAppointment 追加 user:问题A
             *     → 历史变成 … / assistant:回复X / user:问题A
             *   而 buildApiMessages 又会因为「当前轮 user 是最后一条」再收一次尾
             *
             * 更糟的是当这条提问后面还跟着同类的 user 楼层时
             * （用户连发过几句、或删过中间的角色层），
             * appendSessionHistory 会把它们粘成一条，模型读到的是
             * 「问题A、问题A」这种原地重复 —— 直接后果就是
             * 重答出来的内容跟被删掉的那一版高度雷同。
             *
             * 保留原层、只删它**之后**的楼层，得到的上下文才是干净的：
             * 这条 user 就是当前轮，它以前的内容是历史，它以后的内容被清空待重写。
             * 这正是「从这一楼重新回答」应有的语义。
             */
            if (!removeMessagesFrom(idx + 1)) {
                toast('重发中断：没能清掉后面的楼层');
                return;
            }
            if (autoSend) {
                var eng = apEngine();
                if (!eng || eng.isBusy(ui.chatId, ui.sessionId)) {
                    toast('请稍候');
                    return;
                }
                var input = $('xw-writer-input');
                if (input) input.disabled = true;
                var sendBtn = $('xw-writer-go');
                if (sendBtn) sendBtn.disabled = true;
                beginWriterGeneration();
                runStream(
                    Promise.resolve()
                        .then(function () {
                            /*
                             * 用 runAppointmentCompletion 而不是 sendAppointment。
                             *
                             * 这条 user 楼层**已经在库里了**，不能再 addMessage 一遍
                             * —— 那会凭空多出一条同内容楼层，也正是「删了楼再重发
                             * 结果还是老样子」的成因之一。runAppointmentCompletion
                             * 不写 user、只生成 assistant，正是这里要的语义：
                             * 「上下文已经摆好，请接着答」。
                             */
                            return eng.runAppointmentCompletion(
                                ui.chatId,
                                ui.sessionId,
                                Object.assign(streamHandlers(), { keepRegenCandidate: false })
                            );
                        })
                        .then(function (r) {
                            playOfflineDoneSound();
                            return r;
                        })
                        .catch(function (err) {
                            /* 用户主动停止：别弹「没发出去」，也别重绘 */
                            if (isAbortError(err)) return;
                            restoreMessageSnapshot(userSnap);
                            renderStory();
                            toast('没发出去，已把这层放回去');
                            if (global.console && console.warn) console.warn('[redo] send failed', err);
                        })
                        .finally(function () {
                            endWriterGeneration();
                        })
                );
            } else {
                var inp = $('xw-writer-input');
                if (inp) {
                    inp.value = text;
                    inp.focus();
                }
                toast('已回溯，可改后发送');
            }
            return;
        }

        if (msg.role === 'assistant') {
            /*
             * 起点要回到「这一轮」的开头：通常就是紧挨着的那条用户消息。
             * 这样重发才是让角色重新答一次，而不是凭空重写、把提问也丢掉。
             */
            var roundStartId = assistantRoundStartId(sess, msg);
            var startIdx = sess.messages.findIndex(function (m) {
                return m.id === roundStartId;
            });
            if (startIdx < 0) {
                startIdx = (sess.messages || []).findIndex(function (m) {
                    return m && m.id === msg.id;
                });
            }
            if (startIdx < 0) return;
            var snap = snapshotMessagesFrom(sess, startIdx);
            if (!snap.length) return;
            if (!removeMessagesFrom(startIdx)) {
                toast('重发中断：没能清掉旧楼层');
                return;
            }
            var eng2 = apEngine();
            if (!eng2 || eng2.isBusy(ui.chatId, ui.sessionId)) {
                restoreMessageSnapshot(snap);
                renderStory();
                toast('上一镜还没结束，已撤销');
                return;
            }
            var input2 = $('xw-writer-input');
            if (input2) input2.disabled = true;
            var sendBtn2 = $('xw-writer-go');
            if (sendBtn2) sendBtn2.disabled = true;
            beginWriterGeneration();
            runStream(
                Promise.resolve()
                    .then(function () {
                        /*
                         * ⚠️ 必须把「要写回哪一层」显式交给引擎。
                         *
                         * 上面刚用 removeMessagesFrom(startIdx) 把这一轮整段软删了，
                         * 而引擎在不给 replaceTargetId 时会回退成「倒着找最后一条
                         * 还活着的 assistant」—— 被删掉的这几层它看不见，
                         * 于是一路向上摸到**更早的、不相干**的一层，把新内容写进去。
                         *
                         * 用户报的「第九层的内容跳到第七层，把第七层换了」
                         * 就是这么来的：点第 9 层的重发 → 第 8、9 层被软删 →
                         * 引擎摸到第 6 层 → 第 6 层原本的内容被覆盖掉。
                         *
                         * 传 replaceTargetId 之后，引擎会直读原始数组（不看 deleted）
                         * 精确命中被点的那一层，内容写回原位。
                         */
                        return eng2.regenerateAppointment(ui.chatId, ui.sessionId, streamHandlers(), {
                            replaceTargetId: msg.id,
                            /*
                             * 同样带上重答次数：楼层内的「重发」和楼层自身的
                             * 「刷新」在语义上是同一件事（让角色把这一轮重答），
                             * 所以也需要让模型知道「这不是第一次」。
                             * 候选表长度就是权威计数，见 floorSwipeCount 的说明。
                             */
                            attempt: Math.max(1, Array.isArray(msg.swipes) ? msg.swipes.length : 0),
                            /*
                             * ⚠️ 必须显式传 false —— 「重发」是纯重写，不产候选。
                             *
                             * 这里曾经**漏传**这个参数，于是引擎落到
                             * `handlers.keepRegenCandidate !== false` 的默认 true 分支，
                             * 把旧正文归档成了 swipes[0]。实测点角色层「重发」后：
                             *     {"content":"第 1 版新内容。","swipes":1,"swipeId":0}
                             * 而点 › 键是 {"swipes":2,"swipeId":1}。
                             *
                             * 两者在当时看起来都「没有候选条」（候选指示器要
                             * swipes.length >= 2 才渲染），所以视觉上骗过了测试 ——
                             * 但这个长度为 1 的候选表是真的写着库里的：
                             * 它会污染 attempt 计数（floorSwipeCount 拿它当权威），
                             * 让下一次重答一上来就被模型告知「这是第 2 次」，
                             * 而且和「重发不产候选」这条约定直接冲突。
                             *
                             * 用户报「角色楼层还是会生成候选内容」时，指的就是
                             * 这个 —— 它挂在「重发」上，不是刷新键（刷新键早已撤掉）。
                             * 候选归档从此只属于 ›（generateSwipeForMessage 是
                             * 全应用唯一显式传 true 的地方）。
                             */
                            keepRegenCandidate: false
                        });
                    })
                    .then(function (r) {
                        playOfflineDoneSound();
                        return r;
                    })
                    .catch(function (err) {
                        restoreMessageSnapshot(snap);
                        renderStory();
                        toast('重发失败，已还原这几层');
                        if (global.console && console.warn) console.warn('[redo] regenerate failed', err);
                    })
                    .finally(function () {
                        endWriterGeneration();
                    })
            );
        }
    }

    /** 从 startIdx 起把剩下的楼层整段抄一份，用于失败时原样放回 */
    function snapshotMessagesFrom(sess, startIdx) {
        if (!sess || !Array.isArray(sess.messages)) return [];
        return sess.messages.slice(startIdx).map(function (m) {
            var copy = {};
            Object.keys(m || {}).forEach(function (k) {
                copy[k] = m[k];
            });
            if (Array.isArray(m && m.swipes)) copy.swipes = m.swipes.slice();
            return copy;
        });
    }

    /**
     * 精确回滚到 startIdx，一条不落、一条不多。
     *
     * 这里刻意不用上面那个 deleteFromMessage()：它内部是「从被点的那条往后全删」，
     * 但它的入参语义容易被误用成「删到某人为止」，调用方一不小心就会漏删角色楼层，
     * 表现为「重发之后旧回复还挂着，新回复又叠了一层」。
     * 重发这条路径要的是确定的区间，所以在这里自己枚举、自己删，全部成功才返回 true。
     */
    function removeMessagesFrom(startIdx) {
        var store = apStore();
        if (!store || !ui.chatId || !ui.sessionId) return false;
        var s = store.getSession(ui.chatId, ui.sessionId);
        if (!s || !Array.isArray(s.messages) || startIdx >= s.messages.length) return true;
        var targets = s.messages.slice(startIdx).filter(function (m) {
            return m && !m.deleted;
        });
        if (!targets.length) return true;
        for (var i = 0; i < targets.length; i++) {
            store.deleteMessage(ui.chatId, ui.sessionId, targets[i].id);
        }
        return true;
    }

    /**
     * 把快照按原顺序原样放回。
     *
     * 只放「活着的」那几条 —— 已删除的楼层保持删除，不该被这次撤销顺手复活。
     *
     * ⚠️ 这里曾经用 addMessage 还原，是个严重 bug：
     * addMessage 是 push 到末尾，而被删的那一行其实还在数组里（软删）。
     * 于是回滚一次就多出一条「同 id 同内容」的行 ——
     *   · 屏幕上凭空多一层和刚才一模一样的内容（用户报的「刷新楼层生成出一层一模一样」）
     *   · 两条同 id，之后按 id 找的删除 / 隐藏按钮全部指向第一条死行，
     *     活行永远删不掉（用户报的「删除楼层删不掉」）
     * 现在改用 store.restoreMessage()：优先原位复活，
     * 只有原行确实不在了才追加，并保证不会出现重复 id。
     */
    function restoreMessageSnapshot(snap) {
        if (!snap || !snap.length) return false;
        var store = apStore();
        if (!store || !ui.chatId || !ui.sessionId) return false;
        if (typeof store.restoreMessage !== 'function') {
            /* 老版本 store：没有原位还原能力，宁可不还原也不能制造重复行 */
            if (global.console && console.warn) {
                console.warn('[restore] store.restoreMessage 不存在，跳过还原以免产生重复楼层');
            }
            return false;
        }
        var ok = true;
        snap.forEach(function (m) {
            if (!m || m.deleted) return;
            if (!String(m.content || '').trim()) return;
            var res = store.restoreMessage(ui.chatId, ui.sessionId, m);
            if (!res || !res.ok) ok = false;
        });
        /* 收尾压实：万一历史数据里已经有重复 id，这次一并清掉 */
        if (typeof store._dedupeMessages === 'function') {
            store._dedupeMessages(ui.chatId, ui.sessionId);
        }
        return ok;
    }

    function safeFileName(name) { return String(name || '聊天记录').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || '聊天记录'; }
    function downloadOfflineText(sess) {
        if (!sess) return;
        var lines = ['# ' + (sess.title || '未命名场景'), ''];
        (sess.messages || []).forEach(function (m, i) {
            if (!m || m.deleted) return;
            lines.push('【第 ' + String(i + 1) + ' 层】 ' + (m.role === 'assistant' ? '角色' : m.role === 'user' ? '我' : '系统'));
            if (m.thinking) lines.push('[思考]\n' + m.thinking);
            lines.push(String(m.content || ''), '');
        });
        var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }); var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'miya-线下-' + safeFileName(sess.title || sess.id) + '.txt'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    function downloadOfflineJson(sess) {
        if (!sess) return;
        var payload = { format: 'miya-offline-chat-v2', exportedAt: Date.now(), session: sess, messages: sess.messages || [] };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }); var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'miya-线下-' + safeFileName(sess.title || sess.id) + '.json'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    function branchFromFloor(messageId) {
        if (!ui.chatId || !ui.sessionId) return;
        var sess = apStore().getSession(ui.chatId, ui.sessionId); if (!sess) return;
        var idx = (sess.messages || []).findIndex(function (m) { return m && m.id === messageId; }); if (idx < 0) return;
        dialog({ mode: 'confirm', title: '建立剧情分支', message: '从第 ' + String(idx + 1) + ' 层复制到新聊天记录，并从这里继续剧情？', confirmText: '建立分支', cancelText: '取消' }).then(function (ok) {
            if (!ok) return;
            var branch = apStore().createBranch(ui.chatId, ui.sessionId, idx + 1);
            if (!branch) { toast('分支创建失败'); return; }
            ui.sessionId = branch.id; ui.view = 'story'; ui.status = 'idle';
            resetScrollUiState();
            render();
            scrollToLatestOnEnter();
            toast('已建立剧情分支');
        });
    }
    function toggleFloor(messageId) {
        var sess = apStore().getSession(ui.chatId, ui.sessionId); if (!sess) return;
        var m = (sess.messages || []).find(function (x) { return x && x.id === messageId; }); if (!m) return;
        apStore().updateMessage(ui.chatId, ui.sessionId, messageId, { hidden: !m.hidden }); patchStoryBody();
    }

    /*
     * 范围批量切换隐藏：楼层号即用户在界面上看到的席号。
     * 编号口径必须与 renderStoryLines 完全一致（跳过 deleted 后按序 i+1），
     * 否则删过楼之后输入的范围就会和界面显示的对不上。
     */
    function floorNumbersOf(sess) {
        var map = {};
        var msgs = (sess && sess.messages) || [];
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (!m || m.deleted) continue;
            map[i + 1] = m;
        }
        return map;
    }

    /** 解析 "3-8" / "5" / "3-8,11" → [[3,8],[11,11]]；非法返回 null */
    /*
     * 楼层范围输入框的解析。
     *
     * 归一化顺序有讲究，不能把「并列分隔符」和「区间连接符」一锅端：
     *   1. 先把各种区间符号（～－—–~ 到 至）统一成半角连字符 —— 这一步只认区间符号；
     *   2. 去掉「第 / 层 / 楼」这类修饰字；
     *   3. 把连字符两边的空白吃掉（"1 - 3" / "1- 3" 否则会被拆成 ["1","-","3"]）；
     *   4. 用「数字之后的并列分隔符」来切块（逗号、顿号、分号、斜杠、空格都算），
     *      分隔符本身连同其两侧空白一起吃掉，不留残渣。
     *
     * 第 4 步之所以用 lookbehind 定点切，是因为早先的实现把逗号也统一成空格再按空格切，
     * 于是 "1-3,11" 会被切成 ["1-3","11"] 之外的怪东西；而 "1,3" 这种正常的并列
     * 又会被误当成区间。现在两件事彻底分开，互不干扰。
     */
    function splitFloorChunks(raw) {
        return String(raw || '')
            .trim()
            .replace(/[～－—–~到至]/g, '-')
            .replace(/[第层楼]/g, '')
            .replace(/(\d)\s*-\s*(?=\d)/g, '$1-')
            .split(/(?<=\d)(?:\s+|\s*[,，、；;\/|]+\s*)(?=\d)/)
            .map(function (s) {
                return String(s || '').replace(/^\s*[,，、；;\/|]+\s*|\s*[,，、；;\/|]+\s*$/g, '').trim();
            })
            .filter(Boolean);
    }

    /*
     * 楼层是从 1 开始编号的，所以 0 在这里永远不是一个有效楼层。
     * 之前 0-1 会在解析阶段直接返回 null，用户看到的是「格式不对」——
     * 可 0-1 正是输入框自己给的示例，照着填却被骂，纯属自己打自己脸。
     * 现在把两端分别夹到合法区间：0-1 → 1-1（第 1 层），1-0 → 1-1，
     * 0-5 → 1-5，6-0 → 1-6，既不再报错，也不会把 0 当成真实楼层。
     */
    function parseFloorRange(text) {
        var chunks = splitFloorChunks(text);
        if (!chunks.length) return null;
        var ranges = [];
        for (var i = 0; i < chunks.length; i++) {
            var mt = chunks[i].match(/^(\d+)(?:-(\d+))?$/);
            if (!mt) return null;
            var a = parseInt(mt[1], 10);
            var b = mt[2] != null ? parseInt(mt[2], 10) : a;
            if (!isFinite(a) || !isFinite(b)) return null;
            if (a < 1) a = 1;
            if (b < 1) b = 1;
            if (a > b) { var t = a; a = b; b = t; }
            ranges.push([a, b]);
        }
        return ranges;
    }

    /*
     * 范围内统一设为隐藏或显示。
     * 语义从「取反」改为「设定」——取反的问题是你不知道点之前是什么状态，
     * 填 1-3 可能出来「隐藏 1 层、显示 2 层」这种看不懂的结果。
     * 现在填 1-3 点「隐藏」就是把 1~3 楼设成隐藏，幂等，重复点结果一致。
     */
    function setFloorRange(text, mode) {
        var wantHidden = mode === 'hide';
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess) { toast('当前没有打开的场次'); return false; }
        var ranges = parseFloorRange(text);
        if (!ranges) { toast('格式不对，示例：0-1 或 5'); return false; }
        var byNo = floorNumbersOf(sess);
        var maxNo = 0;
        Object.keys(byNo).forEach(function (k) { maxNo = Math.max(maxNo, parseInt(k, 10)); });
        if (!maxNo) { toast('本场还没有楼层'); return false; }

        var hit = 0, changed = 0, same = 0;
        var touched = {};
        var changedNos = [];   // 本次真正改动的楼层
        var sameNos = [];      // 已经是目标状态、无需改动的楼层
        ranges.forEach(function (r) {
            for (var n = r[0]; n <= r[1]; n++) {
                if (n > maxNo) break;
                var m = byNo[n];
                if (!m || touched[m.id]) continue;
                touched[m.id] = 1;
                hit += 1;
                if (!!m.hidden === wantHidden) { same += 1; sameNos.push(n); continue; }
                apStore().updateMessage(ui.chatId, ui.sessionId, m.id, { hidden: wantHidden });
                changed += 1;
                changedNos.push(n);
            }
        });
        if (!hit) { toast('范围内没有楼层（本场共 ' + maxNo + ' 层）'); return false; }
        patchStoryBody();
        changedNos.sort(function (a, b) { return a - b; });
        sameNos.sort(function (a, b) { return a - b; });
        var fmt = function (arr) {
            return arr.length > 12
                ? arr.slice(0, 12).join('、') + ' 等 ' + String(arr.length) + ' 层'
                : arr.join('、');
        };
        /*
         * 提示必须以「本次实际改变的楼层」为主语。
         * 之前的写法把范围内所有楼层都列进去，导致「先隐藏 1-3、再隐藏 1-4」
         * 会提示「已隐藏第 1、2、3、4 层（另 3 层已是该状态）」——
         * 真正新增的第 4 层被淹没，看起来像重复劳动。
         */
        if (!changed) {
            toast(wantHidden
                ? '第 ' + fmt(sameNos) + ' 层已经是隐藏的，无需重复操作'
                : '第 ' + fmt(sameNos) + ' 层已经是显示的，无需重复操作');
            return true;
        }
        var msg = (wantHidden ? '已隐藏第 ' : '已显示第 ') + fmt(changedNos) + ' 层';
        if (same) msg += '（第 ' + fmt(sameNos) + ' 层原本就是该状态）';
        toast(msg);
        return true;
    }
    function newOfflineChat() {
        var st = chatStore(); var chat = st && st.findChat(ui.chatId); if (!chat) { toast('请先选择角色'); return; }
        var sess = apStore().startNewSession(ui.chatId, chat.contactId, activeSessionCast()); if (!sess) return;
        ui.sessionId = sess.id; ui.view = 'story'; ui.status = 'idle';
        resetScrollUiState();
        render();
        scrollToLatestOnEnter();
    }
    function importOfflineChat() {
        var input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.txt';
        input.addEventListener('change', function () { var file = input.files && input.files[0]; if (!file) return; var reader = new FileReader(); reader.onload = function () {
            try {
                var text = String(reader.result || ''), payload;
                if (/\.json$/i.test(file.name)) payload = JSON.parse(text);
                else { var lines = text.split(/\r?\n/), msgs = [], role = 'assistant', buf = []; lines.forEach(function (line) { var hit = line.match(/^【第\s*\d+\s*层】\s*(.*)$/); if (hit) { if (buf.join('\n').trim()) msgs.push({ role: role, content: buf.join('\n').trim() }); buf = []; role = /我/.test(hit[1]) ? 'user' : /系统/.test(hit[1]) ? 'system' : 'assistant'; return; } if (/^#\s*/.test(line)) return; buf.push(line); }); if (buf.join('\n').trim()) msgs.push({ role: role, content: buf.join('\n').trim() }); payload = { session: { title: file.name.replace(/\.[^.]+$/, '') }, messages: msgs }; }
                var sess = apStore().importSession(ui.chatId, payload); if (!sess) throw new Error('invalid');
                ui.sessionId = sess.id; ui.view = 'story'; ui.status = 'idle';
                resetScrollUiState();
                render();
                scrollToLatestOnEnter();
                toast('聊天已导入');
            } catch (e) { console.error(e); toast('导入失败：文件格式不正确'); }
        }; reader.readAsText(file); }); input.click();
    }

    /*
     * 楼层工具按钮改用事件委托，绑在 #xw-root 上。
     * 原因：patchStoryBody() 会重写 mol-story-body 的 innerHTML，
     * 直接绑在按钮元素上的监听器会随旧节点一起消失——表现就是
     * 「第一次点有效，之后怎么点都没反应」。委托只绑一次，DOM 换了也照样生效。
     */
    function bindFloorToolsDelegate() {
        var root = $('xw-root');
        if (!root || root.__miyaFloorToolsBound) return;
        root.__miyaFloorToolsBound = true;
        root.addEventListener('click', function (e) {
            /*
             * 现实时钟事件卡的两枚按钮（领取 / 确认、知道了）。
             * 跟楼层工具一样走委托：卡片每次 patch 都会被重建，
             * 直接绑元素上的监听器会一起消失。
             */
            var teBtn = e.target && e.target.closest
                ? e.target.closest('[data-te-claim],[data-te-dismiss]')
                : null;
            if (teBtn) {
                e.stopPropagation();
                e.preventDefault();
                var teApi = timeEventsApi();
                var teId = teBtn.getAttribute('data-te-claim') || teBtn.getAttribute('data-te-dismiss');
                var teChatId = String(ui.chatId || '').trim();
                if (teApi && teId && teChatId) {
                    if (teBtn.hasAttribute('data-te-claim')) {
                        if (typeof teApi.claim === 'function') teApi.claim(chatStore(), teChatId, teId, 'user');
                    } else if (typeof teApi.dismiss === 'function') {
                        teApi.dismiss(chatStore(), teChatId, teId, 'user');
                    }
                    /*
                     * 领完/确认完立刻重画：卡片的状态是从账本实时补算的，
                     * 不重画的话按钮会停在原地，用户会以为没点上。
                     * 走 patchStoryBody 而不是 render()，免得输入框里的草稿被清空。
                     */
                    patchStoryBody();
                }
                return;
            }
            /*
             * 楼层里的候选切换键 ‹ ›。
             *
             * 这两枚按钮以前是在 bindEvents() 里用 querySelectorAll 逐个绑的，
             * 于是踩了和上面同一个坑：render() 之后确实紧跟一次 bindEvents()，
             * 但**生成结束时走的是 patchStoryBody()** —— 它只重写
             * mol-story-body 的 innerHTML，并不会重跑 bindEvents()。
             * 结果就是：刚生成完那一层新渲染出来的 ‹ › 是「裸」的，
             * 没有任何监听器，点下去毫无反应。
             *
             * 而复现条件其实很常见：点「刷新楼层 / 重回」生成一版新的 →
             * runStream 收尾调 patchStoryBody() → 这一层的切换键当场变成摆设。
             * 用户看到的正是「‹ › 出现了，但点了没反应」。
             *
             * 放进委托里，DOM 换多少次都照样生效。
             */
            var swipeBtn = e.target && e.target.closest
                ? e.target.closest('[data-ap-swipe-prev],[data-ap-swipe-next]')
                : null;
            if (swipeBtn) {
                e.stopPropagation();
                e.preventDefault();
                var prevId = swipeBtn.getAttribute('data-ap-swipe-prev');
                if (prevId != null) applyOfflineSwipe(prevId, -1);
                else applyOfflineSwipe(swipeBtn.getAttribute('data-ap-swipe-next'), 1);
                return;
            }
            var hideBtn = e.target && e.target.closest ? e.target.closest('[data-ap-floor-hide]') : null;
            if (hideBtn) {
                e.stopPropagation();
                e.preventDefault();
                toggleFloor(hideBtn.getAttribute('data-ap-floor-hide'));
                return;
            }
            var brBtn = e.target && e.target.closest ? e.target.closest('[data-ap-floor-branch]') : null;
            if (brBtn) {
                e.stopPropagation();
                e.preventDefault();
                branchFromFloor(brBtn.getAttribute('data-ap-floor-branch'));
            }
        });
    }

    function bindEvents() {
        bindFloorToolsDelegate();

        /*
         * 范围输入框：两个按钮各管一件事，回车 = 隐藏（最常用的那个）。
         * 操作完只就地 patch，不整页重渲染，输入框里的文本和焦点都保得住，
         * 方便连着调范围。
         */
        var scopeInput = $('xw-floor-scope-input');
        if (scopeInput) {
            scopeInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    e.stopPropagation();
                    setFloorRange(scopeInput.value, 'hide');
                }
            });
            /* 数字/范围之外的字符直接挡掉，省得用户打完才发现格式不对 */
            scopeInput.addEventListener('input', function () {
                var cleaned = String(scopeInput.value || '').replace(/[^\d\-~\s,，、]/g, '');
                if (cleaned !== scopeInput.value) scopeInput.value = cleaned;
            });
        }
        var scopeHide = $('xw-floor-scope-hide');
        if (scopeHide) {
            scopeHide.addEventListener('click', function (e) {
                e.stopPropagation();
                setFloorRange(scopeInput ? scopeInput.value : '', 'hide');
            });
        }
        var scopeShow = $('xw-floor-scope-show');
        if (scopeShow) {
            scopeShow.addEventListener('click', function (e) {
                e.stopPropagation();
                setFloorRange(scopeInput ? scopeInput.value : '', 'show');
            });
        }
        /*
         * 候选切换键 ‹ › 的绑定已整体挪进 bindFloorToolsDelegate() 的事件委托。
         *
         * 原来在这里用 querySelectorAll 逐个绑。问题在于本函数只在 render()
         * 之后被调用一次，而生成结束走的是 patchStoryBody() —— 它只重写
         * mol-story-body 的 innerHTML，不会重跑 bindEvents()。
         * 于是「刷新楼层」刚生成出来的那一层，它的 ‹ › 是裸的、点了没反应。
         * 挪进委托后 DOM 换多少次都照样生效，这里不再重复绑定。
         */
        document.querySelectorAll('[data-ap-export-txt]').forEach(function (btn) { btn.addEventListener('click', function (e) { e.stopPropagation(); downloadOfflineText(apStore().getSession(ui.chatId, btn.getAttribute('data-ap-export-txt'))); }); });
        document.querySelectorAll('[data-ap-export-json]').forEach(function (btn) { btn.addEventListener('click', function (e) { e.stopPropagation(); downloadOfflineJson(apStore().getSession(ui.chatId, btn.getAttribute('data-ap-export-json'))); }); });
        /* 命名按钮挪到卷宗列表每行（原先只在卷宗条上，而那条已移除） */
        document.querySelectorAll('[data-ap-rename-session]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                renameSessionById(btn.getAttribute('data-ap-rename-session'));
            });
        });
        var nc = $('xw-new-offline-chat'); if (nc) nc.addEventListener('click', newOfflineChat);
        var ic = $('xw-import-offline-chat'); if (ic) ic.addEventListener('click', importOfflineChat);
        var toolsToggle = $('xw-writer-tools-toggle');
        var toolsMenu = $('xw-writer-tools-menu');
        if (toolsToggle && toolsMenu) {
            toolsToggle.addEventListener('click', function (e) {
                e.stopPropagation();
                toolsMenu.hidden = !toolsMenu.hidden;
            });
            var toolBeautify = $('xw-writer-tool-beautify');
            if (toolBeautify) toolBeautify.addEventListener('click', function () {
                toolsMenu.hidden = true;
                var api = global.MiyaOfflineBeautify;
                if (api && typeof api.openBeautifyDrawer === 'function') api.openBeautifyDrawer();
                else toast('样式模块未加载');
            });
            var toolPrefs = $('xw-writer-tool-prefs');
            if (toolPrefs) toolPrefs.addEventListener('click', function () {
                toolsMenu.hidden = true;
                openSettingsSheet();
            });
            var toolVault = $('xw-writer-tool-vault');
            if (toolVault) toolVault.addEventListener('click', function () {
                toolsMenu.hidden = true;
                ui.view = 'history';
                render();
            });
        }

        bindScrollPin();
        var back = $('xw-exit');
        if (back) {
            back.onclick = function () {
                if (ui.view === 'history') {
                    restoreToLiveStory();
                    return;
                }
                if (ui.view === 'story') {
                    leaveStoryToPick();
                    return;
                }
                closeApp();
            };
        }

        var dockEl = document.querySelector('#xw-root .xw-dock');
        if (dockEl) {
            dockEl.addEventListener('click', function (e) {
                if (e.target.closest('.xw-dock__btn')) return;
                setDockCollapsed(true);
            });
        }
        var dockExpand = $('xw-dock-expand');
        if (dockExpand) {
            dockExpand.addEventListener('click', function () {
                setDockCollapsed(false);
            });
        }

        var histBtn = $('xw-dock-vault');
        if (histBtn) {
            histBtn.addEventListener('click', function () {
                /* 卷宗与正片之间来回切：从卷宗点回来就落到当前活动场次。
                   viewingArchive 已不再参与（卷宗点开即续写，没有只读态）。 */
                if (ui.view === 'history') {
                    restoreToLiveStory();
                    return;
                }
                ui.view = 'history';
                render();
            });
        }

        document.querySelectorAll('[data-ap-apply-opening]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                applyOpeningPreset(btn.getAttribute('data-ap-apply-opening'));
            });
        });

        /*
         * 「展开全文 / 收起」：只改 display，不发送、不重绘。
         * 单独绑在按钮上并拦掉冒泡 —— 它内嵌在整行卡片里，
         * 不拦的话会顺带触发外层那颗 data-ap-apply-opening 的发送逻辑。
         */
        document.querySelectorAll('[data-ap-opening-more]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var item = btn.closest('.xw-opening-pick__item');
                var body = item ? item.querySelector('[data-ap-opening-preview]') : null;
                if (!body) return;
                var expanded = body.classList.toggle('is-expanded');
                btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                btn.textContent = expanded ? '收起' : '展开全文';
            });
        });

        var setBtn = $('xw-dock-prefs');
        if (setBtn) setBtn.addEventListener('click', openSettingsSheet);

        var bfBtn = $('xw-dock-beautify');
        if (bfBtn) {
            bfBtn.addEventListener('click', function () {
                if (global.MiyaOfflineBeautify && global.MiyaOfflineBeautify.openBeautifyDrawer) {
                    global.MiyaOfflineBeautify.openBeautifyDrawer();
                } else {
                    toast('样式模块未加载');
                }
            });
        }

        /* 卷宗条（xw-ribbon-*）已整体移除，其上的
           「归档成纪要 / 命名 / 续写这一幕」三个绑定一并删除：
             · 归档成纪要 → 设置抽屉里的「生成纪要」
             · 命名       → 卷宗列表每行的 [data-ap-rename-session]
             · 续写这一幕 → 点开卷宗即续写，不再需要                          */

        document.querySelectorAll('[data-ap-view-session]').forEach(function (row) {
            row.addEventListener('click', function (e) {
                if (e.target.closest('[data-ap-del-session]')) return;
                if (e.target.closest('[data-ap-rename-session]')) return;
                if (e.target.closest('[data-ap-export-txt]')) return;
                if (e.target.closest('[data-ap-export-json]')) return;
                openArchiveSession(row.getAttribute('data-ap-view-session'));
            });
        });

        document.querySelectorAll('[data-ap-del-session]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                dialog({
                    mode: 'confirm',
                    title: '删掉卷宗',
                    message: '确定删掉这一卷场景吗？',
                    confirmText: '删除',
                    cancelText: '取消'
                }).then(function (ok) {
                    if (!ok) return;
                    apStore().deleteSession(ui.chatId, btn.getAttribute('data-ap-del-session'));
                    render();
                });
            });
        });

        document.querySelectorAll('[data-ap-recover-mirrors]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                recoverFromOnlineMemory();
            });
        });

        /* 「不再提示」：把恢复横幅收掉，并按会话记住这个选择。 */
        document.querySelectorAll('[data-ap-dismiss-recover]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                dismissRecoverBanner();
            });
        });

        var story = $('mol-story-body');
        if (story) {
            story.addEventListener('click', function (e) {
                var editBtn = e.target.closest('[data-ap-msg-edit]');
                if (editBtn) {
                    e.stopPropagation();
                    editMessage(editBtn.getAttribute('data-ap-msg-edit'));
                    return;
                }
                var htmlFs = e.target.closest('[data-ap-html-fs]');
                if (htmlFs) {
                    e.stopPropagation();
                    var panel = htmlFs.closest('[data-ap-html-panel]');
                    var frame = panel && panel.querySelector('iframe[data-ap-html-iframe]');
                    var srcdoc = frame && decodeApHtmlSrcdocB64(frame.getAttribute('data-ap-html-srcdoc-b64'));
                    var htmlApi = global.MiyaChatHtml;
                    if (htmlApi && srcdoc && typeof htmlApi.openChatHtmlFullscreen === 'function') {
                        htmlApi.openChatHtmlFullscreen(srcdoc);
                    }
                    return;
                }
                var delBtn = e.target.closest('[data-ap-msg-del]');
                if (delBtn) {
                    e.stopPropagation();
                    var delId = delBtn.getAttribute('data-ap-msg-del');
                    dialog({
                        mode: 'confirm',
                        title: '删除',
                        message: '确定删除这条消息？',
                        confirmText: '删除',
                        cancelText: '取消'
                    }).then(function (ok) {
                        if (!ok) return;
                        deleteSingleMessage(delId);
                    });
                    return;
                }
                var resendBtn = e.target.closest('[data-ap-msg-resend]');
                if (resendBtn) {
                    e.stopPropagation();
                    var resendId = resendBtn.getAttribute('data-ap-msg-resend');
                    var sessResend = apStore().getSession(ui.chatId, ui.sessionId);
                    var msgResend = sessResend
                        ? (sessResend.messages || []).find(function (m) {
                              return m && m.id === resendId && !m.deleted;
                          })
                        : null;
                    if (!msgResend || msgResend.role === 'system') return;
                    if (apEngine() && apEngine().isBusy(ui.chatId, ui.sessionId)) {
                        toast('等上一镜结束再说');
                        return;
                    }
                    redoFromMessage(msgResend, true);
                    return;
                }
                /*
                 * 楼层工具行里的「刷新」键 —— 现在没有任何楼层会渲染它，
                 * 这段处理保留为**备案入口**。
                 *
                 * 两种楼层的这枚键都已撤掉（角色层第 1 轮、我发的消息层
                 * 第 2 轮），因为实测它们各自和同层的「重发」产出逐字节
                 * 相同。详见 refreshToolHtml 与 journalMessageBlockHtml
                 * 里的说明。
                 *
                 * 留着这段是因为：属性一旦从别处（插件、旧缓存 DOM、
                 * 未来的新入口）出现，它能保证点击仍然走到正确的实现，
                 * 而不是变成一个「点了没反应」的死键。
                 *
                 * regenerateFloor 的 assistant 分支一律传 keepVersion=false：
                 * 就地重写本层、不归档候选 —— 候选归档是 › 键的专属行为。
                 */
                var refreshBtn = e.target.closest('[data-ap-msg-refresh]');
                if (refreshBtn) {
                    e.stopPropagation();
                    var refreshId = refreshBtn.getAttribute('data-ap-msg-refresh');
                    /*
                     * 一律 false：刷新键不保留旧版、不生成候选。
                     *
                     * 曾经读 data-ap-refresh-keep 来决定，结果角色楼层的
                     * 那枚被写成 "1"，行为就跟 › 键一模一样（连 2 / 2 的
                     * 候选条都出来了）。用户直接质问「刷新键怎么会生成出
                     * 候选内容」。现在这个属性只用于「我发的消息」楼层自己
                     * 的分支判断，不再驱动候选归档。
                     */
                    var refreshKeep = false;
                    var sessRefresh = apStore().getSession(ui.chatId, ui.sessionId);
                    var msgRefresh = sessRefresh
                        ? (sessRefresh.messages || []).find(function (m) {
                              return m && m.id === refreshId && !m.deleted;
                          })
                        : null;
                    if (!msgRefresh || msgRefresh.role === 'system') return;
                    regenerateFloor(msgRefresh, refreshKeep);
                    return;
                }
                var openingDelBtn = e.target.closest('[data-ap-opening-del]');
                if (openingDelBtn) {
                    e.stopPropagation();
                    removeSessionOpening(openingDelBtn.getAttribute('data-ap-opening-del'));
                    return;
                }
            });
        }

        var input = $('xw-writer-input');
        var sendBtn = $('xw-writer-go');
        if (input) {
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey && isEnterToSend()) {
                    e.preventDefault();
                    sendMessage();
                }
            });
        }
        if (sendBtn) sendBtn.addEventListener('click', function () {
            /* 生成中按钮已变成「停止」：点击即中断，不再走发送 */
            if (sendBtn.classList.contains('is-stop') || isWriterGenerating()) {
                stopOfflineGeneration();
                return;
            }
            sendMessage();
        });

        /*
         * 「重回」键的绑定已随按钮一并移除。
         * 重刷入口现在只有一处：楼层右下角的候选切换键 ›，
         * 它由 bindFloorToolsDelegate() 的事件委托统一接住 ——
         * 委托是必要的，因为 patchStoryBody() 会重建楼层 DOM。
         */
    }

    function applyOfflineBeautify() {
        if (global.MiyaOfflineBeautify && global.MiyaOfflineBeautify.applyBeautify) {
            global.MiyaOfflineBeautify.applyBeautify();
        }
    }

    /**
     * 从群聊进入线下：全群成员作为出演名单入场，一个群对应一场专属场景。
     *
     * 复用点：
     *   · findResumableSessionByCast 按「出演名单」找回未封存场次 —— 同一个群的成员集合
     *     天然映射到同一场，所以反复进出会续上同一场戏，而不是每次新开。
     *   · 镜像机制会把线下内容写回各成员的单聊线程（offlineMeet 标记），
     *     线上 UI 不展示这些镜像，但 API 上下文会带上 —— 这正是「线下内容进得来」的既有通道。
     *
     * 与单人入口的区别：单人走 openWithChat(chatId, contactId)，这里带完整 cast。
     */
    function openForGroup(groupChatId) {
        var st = chatStore();
        var gg = global.MiyaChatGroup;
        var gid = String(groupChatId || '').trim();
        if (!st || !gid) return false;
        var groupChat = st.findChat(gid);
        if (!groupChat || groupChat.type !== 'group') {
            toast('群聊不存在');
            return false;
        }
        var members = gg && typeof gg.getMembers === 'function'
            ? (gg.getMembers(st, groupChat) || [])
            : [];
        if (members.length < 2) {
            toast('群成员不足两人，无法开线下');
            return false;
        }
        /*
         * 出演名单：每位成员各自的主私聊作为镜像落点。
         * 拿不到私聊线程的成员直接跳过 —— cast 里的 chatId 是镜像落点，
         * 空字符串会让回流写不回去，进而让这个人在群里「参加了但没记忆」。
         * 与其静默降级，不如少带一个人。
         */
        var cast = [];
        members.forEach(function (c) {
            if (!c || !c.id) return;
            var cChat =
                (st.findChatByContact && st.findChatByContact(c.id, c.defaultProfileId)) ||
                (st.findChatByContact && st.findChatByContact(c.id, '')) ||
                null;
            if (!cChat || !cChat.id) return;
            cast.push({
                contactId: String(c.id),
                chatId: String(cChat.id)
            });
        });
        if (cast.length < 2) {
            toast('群成员不足两人有私聊，无法开线下');
            return false;
        }
        /* 用群名作为场景名，便于在卷宗里区分「这是哪群人」 */
        var sceneTitle = String(groupChat.name || '').trim();
        openApp({
            groupChatId: gid,
            cast: cast,
            sceneTitle: sceneTitle,
            contactId: cast[0].contactId,
            chatId: cast[0].chatId || gid
        });
        return true;
    }

    function openApp(ctx) {
        var app = $('miya-offline-app');
        if (!app) return;
        var st = apStore();
        if (st) st.load();
        applyOfflineBeautify();
        ui.view = 'story';
        ui.chatId = '';
        ui.sessionId = '';
        ui.contactId = '';
        ui.streamingLines = [];
        ui.streamingRaw = '';
        ui.pickSelected = [];
        /*
         * groupChatId / sceneTitle 必须一起清。
         * 只清 groupChatId 的话，上一次从群进来的群名会残留，
         * 紧接着走单人入口新开的场次会被错误地冠上那个群名。
         * 这两个字段由 ctx 分支按需重新写入。
         */
        ui.groupChatId = '';
        ui.sceneTitle = '';
        /* 每次打开线下都从干净的滚动立场开始，
           避免上一次会话残留的「跟最新」把这次生成结束后的位置拽到底部。 */
        resetScrollUiState();
        ui.catalogNo = '现场·' + String(Date.now()).slice(-6);
        if (global.MiyaOfflineStatus && global.MiyaOfflineStatus.hideAll) {
            global.MiyaOfflineStatus.hideAll();
        }
        app.removeAttribute('hidden');
        app.classList.add('is-open');
        app.setAttribute('aria-hidden', 'false');
        document.body.classList.add('miya-app-open');

        var hydrate = Promise.resolve();
        if (global.miyaChatStore && typeof global.miyaChatStore.init === 'function') {
            hydrate = global.miyaChatStore.init().catch(function () {});
        }
        if (st && typeof st.whenReady === 'function') {
            hydrate = hydrate.then(function () { return st.whenReady(); });
        }
        if (global.MiyaOfflineBeautify && global.MiyaOfflineBeautify.whenPresetsReady) {
            hydrate = hydrate.then(function () {
                return global.MiyaOfflineBeautify.whenPresetsReady();
            });
        }
        /* 封存记录以本地落盘为准；勿每次进入都从线上镜像自动重建。
         * 手动删除会同步清掉线上镜像；「从线上记忆恢复」仅用于本地丢失且镜像仍在的情况。 */
        var entry = ctx && ctx.cast && ctx.cast.length
            ? function () {
                  ui.groupChatId = String(ctx.groupChatId || '');
                  ui.sceneTitle = String(ctx.sceneTitle || '');
                  openWithChat(
                      String(ctx.chatId || ctx.cast[0].chatId || ''),
                      String(ctx.contactId || ctx.cast[0].contactId || ''),
                      ctx.cast
                  );
              }
            : function () { enterDirectOffline(); };
        hydrate
            .then(function () {
                entry();
                applyOfflineBeautify();
            })
            .catch(function () {});
    }

    function closeApp() {
        syncSessionOnLeave();
        /* 关掉线下时停掉入场锚定与滚动立场，避免残留到下次打开。 */
        resetScrollUiState();
        if (global.MiyaOfflineStatus && global.MiyaOfflineStatus.hideAll) {
            global.MiyaOfflineStatus.hideAll();
        }
        var app = $('miya-offline-app');
        if (!app) return;
        app.classList.remove('is-open');
        app.setAttribute('hidden', '');
        app.setAttribute('aria-hidden', 'true');
        if (!document.querySelector('.miya-beautify-app.is-open') &&
            !document.querySelector('.miya-settings-app.is-open') &&
            !document.querySelector('.miya-worldbook-app.is-open') &&
            !document.querySelector('#miya-chat-app.is-open') &&
            !document.querySelector('.miya-memory-app.is-open') &&
            !document.querySelector('.miya-contacts-app.is-open')) {
            document.body.classList.remove('miya-app-open');
        }
        /*
         * 从群聊进来的场次：离开时把本场内容回流成群账本。
         * 与「封存本次群聊」共用同一个账本 —— 群里其他人之后也能知道你们去线下做了什么。
         */
        flushGroupLedger();
        ui.groupChatId = '';
        ui.sceneTitle = '';
    }

    /**
     * 把本场（群来源）线下的内容沉淀成群聊账本。
     *
     * 只在「本场确实有内容」时才写，避免只是进来看看就产生空账本。
     * 生成失败不阻塞关闭 —— 账本是增强，不该拦住用户退出。
     */
    function flushGroupLedger() {
        var gid = String(ui.groupChatId || '').trim();
        if (!gid) return;
        var ledger = global.MiyaChatGroupLedger;
        if (!ledger || typeof ledger.syncFromOfflineSession !== 'function') return;
        if (!ui.sessionId || !ui.chatId) return;
        var sess = apStore().getSession(ui.chatId, ui.sessionId);
        if (!sess) return;
        try {
            ledger.syncFromOfflineSession(gid, sess);
        } catch (e) {}
    }

    global.miyaOfflineApp = {
        open: openApp,
        openForGroup: openForGroup,
        close: closeApp,
        toast: toast,
        rerender: render,
        getStatusContext: getStatusContext,
        contactAvatar: contactAvatar,
        resolveOfflineContactAvatarAsync: resolveOfflineContactAvatarAsync,
        findContactsAppAvatar: findContactsAppAvatar,
        /*
         * 测试专用后门：直连楼层重生成。
         *
         * 角色楼层的刷新键撤掉之后，自动化测试就没有 UI 入口去验证
         * 「keep=false 就地重写」这条底层路径了 —— 而它仍然活着
         * （regenerateFloor 的 assistant 分支、引擎的 keepRegenCandidate）。
         * 留这个钩子让测试能直接调用，确认能力没被删残，也让后来者
         * 一眼看到：撤掉的是那枚按钮，不是这套逻辑。
         *
         * 只做透传，不含任何业务判断。
         */
        __testRegenFloor: function (msg, keepVersion) {
            regenerateFloor(msg, keepVersion);
        }
    };
})(window);
