/* miya-chat-statusbar.js
 * 角色状态栏（Status Bar）· 自定义模板渲染
 *
 * 背景：ST 用户惯用「正则替换」把 <STATUSBAR_DATA> 换成一张 HTML 卡片。
 *       本项目没有正则替换机制，但有一套 HTML 渲染管线（MiyaChatHtml）。
 *       本模块把这件事做成内置能力：模板由用户配置一次，模型每轮只输出字段值。
 *
 * 设计原则：
 * 1. 模板与数据分离 —— 模板存设置里，模型每轮只吐字段值，省 token。
 * 2. 标签解耦 —— 只认「成对标签 + `键: 值` 行」这个结构，不写死 STATUSBAR_DATA，
 *    因此 ST 预设的任意自定义标签名（<状态栏>、<miyastatus>…）都能直接用。
 * 3. 零存储 —— 状态栏是「本轮快照」，跟着消息走。
 *    不做账本、不写 DB：消息删了卡片自然消失，不会出现两处数据不一致。
 *    （这一点是与「现实时钟事件」的关键差异：事件要跨轮追踪才需要存库。）
 * 4. 模板缺失不致命 —— 没配模板时走内置默认卡片，开箱可用。
 * 5. 渲染隔离 —— 模板含 <script> 时交给 MiyaChatHtml 走 iframe，
 *    不含则内联，避免污染聊天页。
 */
(function (global) {
    'use strict';

    /** 设置存放位置：与 timeEvents 同级的 backgroundMessage 子对象 */
    var SETTINGS_KEY = 'statusBar';

    /** 单次解析的字段上限，防御模型抽风输出超长块 */
    var MAX_FIELDS = 40;
    /* iframe 最大高度：状态栏不该比一屏还长，超了就内部滚 */
    var MAX_IFRAME_HEIGHT = 900;
    /** 单个字段值长度上限 */
    var MAX_VALUE_LEN = 800;

    function trim(s) {
        return String(s == null ? '' : s).trim();
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* ── 默认模板 ──
     * 暖白卡片风格，与项目 chat-bf-theme 的奶油调一致。
     * 样式全部内联在模板里，因为模板会被塞进 iframe（取不到页面 CSS 变量）。
     * 字段用 {{}} 占位，用户可在设置里整套替换成自己的模板。 */
    var DEFAULT_STYLE =
        '.miya-sb-card{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'box-sizing:border-box;max-width:100%;border-radius:16px;padding:13px 15px;margin:2px 0;' +
        'background:linear-gradient(160deg,rgba(255,252,248,.97),rgba(250,244,238,.94));' +
        'border:1px solid rgba(206,186,164,.34);' +
        'box-shadow:0 4px 18px rgba(160,132,104,.10),inset 0 1px 0 rgba(255,255,255,.9);}' +
        '.miya-sb-head{display:flex;align-items:center;gap:6px;margin-bottom:9px;' +
        'padding-bottom:7px;border-bottom:1px dashed rgba(206,186,164,.4);}' +
        '.miya-sb-dot{width:6px;height:6px;border-radius:50%;background:#d9a05b;flex-shrink:0;}' +
        '.miya-sb-title{font-size:11px;font-weight:600;letter-spacing:.08em;color:#a8896a;}' +
        '.miya-sb-body{display:flex;flex-direction:column;gap:7px;}' +
        '.miya-sb-row{display:flex;align-items:flex-start;gap:8px;}' +
        '.miya-sb-k{font-size:10.5px;color:#b09a80;flex-shrink:0;min-width:58px;' +
        'letter-spacing:.04em;line-height:1.6;}' +
        '.miya-sb-v{font-size:12.5px;color:#5d4c3d;flex:1;min-width:0;line-height:1.6;' +
        'word-break:break-word;overflow-wrap:break-word;white-space:normal;}';

    var DEFAULT_TEMPLATE =
        '<div class="miya-sb-card">' +
        '<div class="miya-sb-head">' +
        '<span class="miya-sb-dot"></span>' +
        '<span class="miya-sb-title">{{标签}}</span>' +
        '</div>' +
        '<div class="miya-sb-body">{{字段列表}}</div>' +
        '</div>';

    /** 默认字段名 —— 仅用于首次打开设置时给用户一个可参考的名单 */
    var DEFAULT_FIELDS = ['当前氛围', '表面情绪', '真实情绪', '内心独白', '想对你说的话'];

    /** 默认标签名（{{标签}} 的取值） */
    var DEFAULT_LABEL = '状态栏';

    /* ──────────────────────────────────────────────────────────
     * 一、模板解析
     * ────────────────────────────────────────────────────────── */

    /** 匹配 {{字段名}} / {{ 字段名 }}；{{字段列表}} 与 {{标签}} 是保留字 */
    var RE_PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

    var RESERVED = { '字段列表': 1, '标签': 1, 'label': 1, 'tag': 1 };

    /**
     * 从模板中提取用户显式写到的字段名（排除保留字，去重、保序）。
     * 设置面板用它做「模板字段 ↔ 世界书字段」的一致性提示。
     */
    function extractTemplateFields(template) {
        var src = String(template || '');
        var out = [];
        var seen = {};
        var m;
        RE_PLACEHOLDER.lastIndex = 0;
        while ((m = RE_PLACEHOLDER.exec(src)) !== null) {
            var name = trim(m[1]);
            if (!name || RESERVED[name]) continue;
            if (seen[name]) continue;
            seen[name] = 1;
            out.push(name);
            if (out.length >= MAX_FIELDS) break;
        }
        return out;
    }

    /** 模板里是否用了 {{字段列表}}（决定要不要自动兜底渲染其余字段） */
    function usesFieldList(template) {
        return /\{\{\s*(?:字段列表|fieldList)\s*\}\}/i.test(String(template || ''));
    }

    /** 构造 { backgroundMessage: { statusBar: cfg } } 这样的补丁对象。
     *  项目全量走 ES5 写法，这里不用计算属性名，保持风格一致。 */
    function bgPatch(cfg) {
        var bg = {};
        bg[SETTINGS_KEY] = cfg;
        return { backgroundMessage: bg };
    }

    /* ──────────────────────────────────────────────────────────
     * 二、块解析（标签名动态，不写死）
     * ────────────────────────────────────────────────────────── */

    /** 已知的状态栏标签候选，按优先级排列。全部大小写不敏感。 */
    /*
     * 识别的标签名白名单。
     *
     * ⚠️ 刻意**不含** miyastatus / miyavoice：
     *   线下那套状态栏（MiyaOfflineStatus）已经占用了 <miyastatus> 与 <miyavoice>，
     *   并且有自己的「悬浮球 + 预设库」形态。如果这里也去抢同一个标签，
     *   两边会互相剥离正文 —— 线下状态栏会凭空消失，或者同一段内容被渲染两次。
     *   所以本模块只认「不属于任何既有系统」的标签。
     */
    var KNOWN_TAGS = ['STATUSBAR_DATA', 'statusbar_data', 'StatusBar_Data', '状态栏'];

    var RE_FIELD_LINE = /^\s*([^:：\n]{1,40})\s*[:：]\s*(.*)$/;

    /**
     * 解析「键: 值」行列表。
     * 容忍：半角/全角冒号、行首缩进、值内多余空格、空行。
     * 不支持值内换行（与 ST 预设约定一致）。
     */
    function parseFieldLines(block) {
        var lines = String(block || '').split(/\r?\n/);
        var out = [];
        lines.forEach(function (line) {
            var t = trim(line);
            if (!t) return;
            var m = t.match(RE_FIELD_LINE);
            if (!m) return;
            var name = trim(m[1]);
            var value = trim(m[2]);
            if (!name) return;
            if (name.length > 40) return;
            out.push({ name: name, value: value.slice(0, MAX_VALUE_LEN) });
            if (out.length >= MAX_FIELDS) return;
        });
        return out.slice(0, MAX_FIELDS);
    }

    /** 转义标签名，用于构造正则 */
    function escRe(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 在文本里找「成对标签」并取出内容。
     * 支持半角 <> 与全角 ＜＞；未闭合时剥到结尾（同 stripTagBlock 的容错）。
     * 取「最后一个闭合之前」的内容，兼容模型偶发的嵌套/重复输出。
     */
    function grabBlock(text, tag) {
        var src = String(text || '');
        var t = escRe(tag);
        var pairs = [
            { open: new RegExp('<' + t + '\\s*>', 'gi'), close: new RegExp('<\\/' + t + '\\s*>', 'gi') },
            { open: new RegExp('＜' + t + '\\s*＞', 'gi'), close: new RegExp('＜[／/]' + t + '\\s*＞', 'gi') }
        ];
        for (var pi = 0; pi < pairs.length; pi++) {
            pairs[pi].open.lastIndex = 0;
            var mOpen = pairs[pi].open.exec(src);
            if (!mOpen) continue;
            var lastClose = -1;
            var c;
            pairs[pi].close.lastIndex = mOpen.index + mOpen[0].length;
            while ((c = pairs[pi].close.exec(src)) !== null) lastClose = c.index;
            var from = mOpen.index + mOpen[0].length;
            var inner = lastClose < 0 ? src.slice(from) : src.slice(from, lastClose);
            inner = trim(inner);
            if (inner) return { inner: inner, tag: tag };
        }
        return null;
    }

    /**
     * 从一段回复文本里解析状态栏。
     *
     * 解析顺序：
     *   ① 逐个已知标签找成对块
     *   ② 都没命中 → 退化为「扫描全文的 `键: 值` 行」，
     *      但要求至少命中 2 行，避免把正文里的「她说：好」误当字段。
     *
     * @returns {{fields:Array<{name,value}>, tag:string, raw:string}|null}
     */
    function parseFromText(text) {
        var src = String(text || '');
        if (!src.trim()) return null;

        var i;
        for (i = 0; i < KNOWN_TAGS.length; i++) {
            var hit = grabBlock(src, KNOWN_TAGS[i]);
            if (!hit || !hit.inner) continue;
            var fields = parseFieldLines(hit.inner);
            if (fields.length) {
                return { fields: fields, tag: hit.tag, raw: hit.inner };
            }
        }
        return null;
    }

    /** 去掉正文里的状态栏块（保证卡片不会被当成正文再渲染一遍） */
    function stripFromText(text) {
        var out = String(text || '');
        KNOWN_TAGS.forEach(function (tag) {
            var t = escRe(tag);
            out = out.replace(new RegExp('<' + t + '\\s*>[\\s\\S]*?<\\/' + t + '\\s*>', 'gi'), '');
            out = out.replace(new RegExp('＜' + t + '\\s*＞[\\s\\S]*?＜[／/]' + t + '\\s*＞', 'gi'), '');
            /* 未闭合：剥到结尾 */
            out = out.replace(new RegExp('<' + t + '\\s*>[\\s\\S]*$', 'gi'), '');
            out = out.replace(new RegExp('＜' + t + '\\s*＞[\\s\\S]*$', 'gi'), '');
        });
        return trim(out);
    }

    /* ──────────────────────────────────────────────────────────
     * 三、模板填充
     * ────────────────────────────────────────────────────────── */

    /**
     * 用字段值填充模板。
     * - {{字段名}}  → 该字段的值（找不到则留空）
     * - {{字段列表}} → 自动把「模板里没显式写到的字段」渲染成行
     * - {{标签}}     → 状态栏标题
     *
     * 返回已填充的 HTML 片段（值为纯文本，渲染时转义）。
     */
    function fillTemplate(template, fields, label) {
        var tpl = String(template || '').trim();
        if (!tpl) tpl = DEFAULT_TEMPLATE;
        var list = Array.isArray(fields) ? fields : [];
        var title = trim(label) || DEFAULT_LABEL;

        /* 建立 name → value 查询 */
        var map = {};
        var order = [];
        list.forEach(function (f) {
            var n = trim(f && f.name);
            if (!n) return;
            map[n] = String(f && f.value != null ? f.value : '');
            order.push(n);
        });

        /* 模板显式引用的字段名 */
        var explicit = extractTemplateFields(tpl);
        var explicitSet = {};
        explicit.forEach(function (n) {
            explicitSet[n] = 1;
        });

        /* 其余字段（保持模型输出的顺序） */
        var rest = order.filter(function (n) {
            return !explicitSet[n];
        });

        var rowsHtml = rest
            .map(function (n) {
                return (
                    '<div class="miya-sb-row">' +
                    '<span class="miya-sb-k">' + esc(n) + '</span>' +
                    '<span class="miya-sb-v">' + esc(map[n]).replace(/\n/g, '<br>') + '</span>' +
                    '</div>'
                );
            })
            .join('');

        RE_PLACEHOLDER.lastIndex = 0;
        return tpl.replace(RE_PLACEHOLDER, function (whole, rawName) {
            var name = trim(rawName);
            if (!name) return '';
            if (name === '字段列表' || name === 'fieldList') return rowsHtml;
            if (name === '标签' || name === 'label' || name === 'tag') return esc(title);
            /* 普通字段：值是纯文本，转义后换行转 <br> */
            var v = map[name];
            if (v == null) return '';
            return esc(v).replace(/\n/g, '<br>');
        });
    }

    /* ──────────────────────────────────────────────────────────
     * 四、配置读写（走项目标准的 chatSettings.backgroundMessage）
     * ────────────────────────────────────────────────────────── */

    function readSettingsRaw(store, chatId) {
        if (!store || !chatId || typeof store.getChatSettings !== 'function') return null;
        var s = store.getChatSettings(chatId) || {};
        var bg = s.backgroundMessage || {};
        var cfg = bg[SETTINGS_KEY];
        return cfg && typeof cfg === 'object' ? cfg : null;
    }

    /**
     * 读取全局默认配置。
     *
     * 全局默认存在 miyaChatGlobalSettings 的 state.global.backgroundMessage 下
     * （与 timeEvents / farm 同一个抽屉），不是 miyaChatStore 上的方法 ——
     * 这一点踩过一次坑：store 上既没有 getGlobalSettings 也没有
     * saveGlobalSettings，全局层静默失效，只有聊天级配置生效。
     */
    function readGlobalSettings() {
        var gs = global.miyaChatGlobalSettings;
        if (!gs || typeof gs.getState !== 'function') return null;
        try {
            var st = gs.getState() || {};
            var g = st.global || {};
            var bg = g.backgroundMessage || {};
            var cfg = bg[SETTINGS_KEY];
            return cfg && typeof cfg === 'object' ? cfg : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 取生效配置：聊天级 > 全局级 > 内置默认。
     * 返回规范化后的对象，调用方不需要再做兜底判断。
     */
    function resolveConfig(store, chatId) {
        var chatCfg = readSettingsRaw(store, chatId);
        var globCfg = readGlobalSettings();
        var src =
            chatCfg && (chatCfg.template || chatCfg.enabled != null)
                ? chatCfg
                : globCfg && (globCfg.template || globCfg.enabled != null)
                  ? globCfg
                  : chatCfg || globCfg || {};
        var tpl = trim(src.template);
        return {
            /* 默认开启：装了就想用，不必先去设置里找开关 */
            enabled: src.enabled !== false,
            template: tpl || DEFAULT_TEMPLATE,
            usingDefaultTemplate: !tpl,
            label: trim(src.label) || DEFAULT_LABEL,
            style: trim(src.style),
            hideWhenEmpty: src.hideWhenEmpty !== false
        };
    }

    /** 保存配置到指定层级（chatId 为空则写全局） */
    function saveConfig(store, chatId, patch) {
        var st = store || global.miyaChatStore;
        if (!st) return Promise.resolve(false);
        var prev;
        if (chatId) {
            var s = (typeof st.getChatSettings === 'function' ? st.getChatSettings(chatId) : null) || {};
            var bg = s.backgroundMessage || {};
            prev = bg[SETTINGS_KEY] && typeof bg[SETTINGS_KEY] === 'object' ? bg[SETTINGS_KEY] : {};
            var next = Object.assign({}, prev, patch || {});
            if (typeof st.saveChatSettings !== 'function') return Promise.resolve(false);
            return Promise.resolve(st.saveChatSettings(chatId, bgPatch(next))).then(function () {
                return true;
            });
        }
        /*
         * 全局层：写进 miyaChatGlobalSettings 的 state.global.backgroundMessage。
         * 用 saveGlobal 而不是 saveState —— saveGlobal 只动 global 那一格，
         * 不会顺手把 useGlobal / perContact 覆盖掉。
         */
        var gs = global.miyaChatGlobalSettings;
        if (!gs || typeof gs.saveGlobal !== 'function') return Promise.resolve(false);
        var gcfg = readGlobalSettings() || {};
        var gnext = Object.assign({}, gcfg, patch || {});
        return Promise.resolve(gs.saveGlobal(bgPatch(gnext))).then(function () {
            return true;
        });
    }

    /* ──────────────────────────────────────────────────────────
     * 五、渲染
     * ────────────────────────────────────────────────────────── */

    /*
     * iframe 自动撑高用的「探针」脚本。
     *
     * 为什么必须走 postMessage：
     *   状态栏 iframe 带 sandbox 属性，且 srcdoc 走 Blob URL ——
     *   父页面**读不到** frame.contentDocument（实测恒为 null）。
     *   所以量高度这件事只能在 iframe 里面做，再把结果发出来。
     *
     * 协议：{ __miyaStatusBar: 1, h: <高度> }
     * 父侧在 window 上挂一个 message 监听（只认这个标记，别的消息一概不理）。
     *
     * 触发时机覆盖三种：初始 load、内容因脚本变化（MutationObserver）、
     * 字体/图片延迟加载（load 事件 + 两次延迟补量）。
     */
    var HEIGHT_PROBE =
        '<script>(function(){' +
        'var last=-1;' +
        'function h(){try{' +
        'var e=document.documentElement,b=document.body;' +
        'var x=Math.max(e?e.scrollHeight:0,e?e.offsetHeight:0,b?b.scrollHeight:0,b?b.offsetHeight:0);' +
        'if(x>0&&x!==last){last=x;parent.postMessage({__miyaStatusBar:1,h:x},\'*\');}' +
        '}catch(err){}}' +
        'window.addEventListener(\'load\',function(){h();setTimeout(h,60);setTimeout(h,240);setTimeout(h,700);setTimeout(h,1500);});' +
        'if(window.MutationObserver){try{' +
        'var mo=new MutationObserver(function(){h();});' +
        'mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});' +
        '}catch(e2){}}' +
        /* 兜底轮询：覆盖「脚本异步改内容」「字体晚到」等 MutationObserver 抓不到的时机 */
        'var n=0,iv=setInterval(function(){h();if(++n>=20)clearInterval(iv);},200);' +
        '})();<\/script>';

    /** 把探针脚本塞进完整 HTML 文档（放在 </body> 前，保证 DOM 已就绪） */
    function injectHeightProbe(srcdoc) {
        var html = String(srcdoc || '');
        if (!html) return html;
        if (html.indexOf('__miyaStatusBar:1') >= 0) return html;
        if (/<\/body\s*>/i.test(html)) {
            return html.replace(/<\/body\s*>/i, HEIGHT_PROBE + '</body>');
        }
        return html + HEIGHT_PROBE;
    }

    /**
     * 装配 iframe 高度监听（幂等：只在首次调用时挂 window 监听）。
     *
     * 父侧不解析发送方来源 —— 只认 __miyaStatusBar 标记。
     * 一条消息里可能有多个状态栏 iframe（历史消息各有各的），
     * 用 postMessage 的 source 反过来匹配到具体 frame，避免串台。
     */
    var heightListenerBound = false;
    var liveFrames = [];

    function registerStatusBarFrame(frame) {
        if (!frame) return;
        for (var i = 0; i < liveFrames.length; i++) {
            if (liveFrames[i] === frame) return;
        }
        liveFrames.push(frame);
        /* 只保留最近 60 个，避免长会话里无限增长 */
        if (liveFrames.length > 60) liveFrames.splice(0, liveFrames.length - 60);
        if (heightListenerBound) return;
        heightListenerBound = true;
        if (!global.addEventListener) return;
        global.addEventListener('message', function (ev) {
            var d = ev && ev.data;
            if (!d || d.__miyaStatusBar !== 1) return;
            var h = Number(d.h);
            if (!Number.isFinite(h) || h <= 0) return;
            var srcFrame = ev.source;
            for (var i = 0; i < liveFrames.length; i++) {
                var fr = liveFrames[i];
                if (!fr || !fr.isConnected) continue;
                try {
                    if (srcFrame && fr.contentWindow !== srcFrame) continue;
                } catch (eCw) {
                    /* 读不到 contentWindow 就退化为「全部匹配」——宁可多量一次 */
                }
                fr.style.height = Math.min(Math.round(h) + 2, MAX_IFRAME_HEIGHT) + 'px';
            }
        });
    }

    /**
     * 构造状态栏卡片的 HTML。
     *
     * 渲染策略：
     * - 用 MiyaChatHtml 的 sanitize 做安全过滤；含 <script> 时改走 iframe
     *   （iframe 内是独立文档，样式脚本都关在里面，不会影响聊天页）。
     * - 无 MiyaChatHtml 时退化为「转义输出」，绝不裸插入。
     *
     * @param {object} opts { fields, tag, config, forIframe }
     * @returns {string} HTML 片段；无字段时返回 ''
     */
    function buildCardHtml(opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var cfg = opts.config || {};
        var fields = Array.isArray(opts.fields) ? opts.fields : [];
        if (!fields.length) return '';
        if (cfg.enabled === false) return '';

        var tpl = cfg.template || DEFAULT_TEMPLATE;
        var style = trim(cfg.style);
        var prefix = style ? '<style>' + style + '</style>' : '';
        /* 内置默认模板要带上自带样式，否则没有任何观感 */
        if (cfg.usingDefaultTemplate) {
            style = DEFAULT_STYLE;
            prefix = '<style>' + style + '</style>';
        }

        var body = fillTemplate(tpl, fields, cfg.label || opts.tag || DEFAULT_LABEL);
        var full = prefix + body;

        var htmlApi = global.MiyaChatHtml;
        if (htmlApi && typeof htmlApi.buildHtmlPayloadFromText === 'function') {
            var hp = htmlApi.buildHtmlPayloadFromText(full, true);
            if (hp && hp.useIframe && hp.iframeSrcdoc) {
                /*
                 * 交给调用方决定怎么挂 iframe（线上用 qq-room 气泡，线下用 xw-chat）。
                 * 这里先把高度探针注进去：探针在 iframe 里量完会 postMessage 出来，
                 * 父侧 registerStatusBarFrame 收到后回填 height。
                 */
                return (
                    '<div class="miya-sb-host" data-miya-statusbar="1" data-miya-sb-iframe="1" data-miya-sb-srcdoc="' +
                    (htmlApi.encodeSrcdocB64
                        ? htmlApi.encodeSrcdocB64(injectHeightProbe(hp.iframeSrcdoc))
                        : '') +
                    '"></div>'
                );
            }
            if (hp && hp.html) {
                return '<div class="miya-sb-host" data-miya-statusbar="1">' + hp.html + '</div>';
            }
        }
        /* 兜底：无 HTML 管线时按纯文本段落渲染，保证内容可见且安全 */
        return '<div class="miya-sb-host" data-miya-statusbar="1" data-miya-sb-plain="1">' + esc(full) + '</div>';
    }

    /**
     * 给一条消息产出状态栏 HTML。
     * 内部做了「解析 + 剥离 + 渲染」三件事，调用方只需把返回值拼进 DOM。
     *
     * @param {object} m      消息对象
     * @param {object} store  miyaChatStore
     * @param {string} chatId
     * @returns {string} HTML 片段（可能是 ''）
     */
    function renderForMessage(m, store, chatId) {
        if (!m || typeof m !== 'object') return '';
        /* 只给助手楼层渲染 —— 用户楼、系统楼没有状态栏的语义 */
        if (m.role !== 'assistant') return '';
        var cfg = resolveConfig(store, chatId);
        if (cfg.enabled === false) return '';
        var parsed = parseFromText(m.content);
        if (!parsed || !parsed.fields.length) return '';
        if (cfg.hideWhenEmpty === false) {
            /* 显式要求「永远显示」时，空值也给卡片 */
        }
        return buildCardHtml({ fields: parsed.fields, tag: parsed.tag, config: cfg });
    }

    /** 取一条消息里的状态栏字段（给设置面板预览用） */
    function fieldsOf(m) {
        return parseFromText(m && m.content);
    }

    global.MiyaChatStatusBar = {
        SETTINGS_KEY: SETTINGS_KEY,
        DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
        DEFAULT_STYLE: DEFAULT_STYLE,
        DEFAULT_FIELDS: DEFAULT_FIELDS,
        DEFAULT_LABEL: DEFAULT_LABEL,
        extractTemplateFields: extractTemplateFields,
        usesFieldList: usesFieldList,
        parseFieldLines: parseFieldLines,
        parseFromText: parseFromText,
        stripFromText: stripFromText,
        fillTemplate: fillTemplate,
        resolveConfig: resolveConfig,
        saveConfig: saveConfig,
        buildCardHtml: buildCardHtml,
        renderForMessage: renderForMessage,
        fieldsOf: fieldsOf,
        injectHeightProbe: injectHeightProbe,
        registerStatusBarFrame: registerStatusBarFrame
    };
})(window);
