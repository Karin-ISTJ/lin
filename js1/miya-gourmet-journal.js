/**
 * 大陆美食物语 · 冒险者手札 —— 卡片渲染器
 *
 * 来源：SillyTavern 角色卡「🍳我是厨神」外挂正则脚本「状态栏」
 *   findRegex:    /<gourmet_journal>\s*([\s\S]*?)(?:<\/gourmet_journal>|$)/is
 *   placement:    [2]  （AI 输出后）
 *   replaceString: 一整个 HTML 页面（本文件同目录的 miya-gourmet-journal.html）
 *
 * ST 靠正则把 <gourmet_journal> 原文替换成 HTML。
 * Karinn 没有正则替换这套机制，所以这里等价实现：
 *   1. 从助手回复里切出 <gourmet_journal>...</gourmet_journal> 段
 *   2. 取出内部方括号数据，注入模板的 #gourmet-raw-data
 *   3. 用 Blob + 沙箱 iframe 渲染（与 miya-chat-html.js 同一套做法）
 *
 * 模板内的 CSS/JS/NPC 头像全部保持原样，未作改动。
 */
(function (global) {
    'use strict';

    var TEMPLATE_URL = 'js1/miya-gourmet-journal.html';

    /* 一段回复里可能有多处手札（极少见），逐个取出 */
    var RE_BLOCK = /<gourmet_journal>\s*([\s\S]*?)(?:<\/gourmet_journal>|$)/gi;
    /* 宽松识别：有些模型会漏掉闭合标签，或写成全角括号 */
    var RE_BLOCK_LOOSE = /<\s*gourmet_journal\s*>([\s\S]*?)(?:<\s*\/\s*gourmet_journal\s*>|$)/gi;

    var templateCache = null;
    var templatePromise = null;

    /* 每个 iframe 独立 blob，渲染后需要回收，避免内存堆积 */
    var liveBlobUrls = [];

    function trim(s) {
        return String(s || '').trim();
    }

    function esc(s) {
        return String(s == null ? '' : s);
    }

    /* 是否含手札标记（不需要完整解析，先快速判断） */
    function hasGourmetJournal(rawText) {
        var txt = String(rawText || '');
        if (!txt) return false;
        return /<\s*gourmet_journal\s*>/i.test(txt);
    }

    /**
     * 取出所有手札段。
     * @returns {Array<{raw:string, body:string, before:string, after:string}>}
     */
    function extractJournalParts(rawText) {
        var txt = String(rawText || '');
        if (!txt) return [];
        var out = [];
        var re = new RegExp(RE_BLOCK.source, 'gi');
        var m;
        while ((m = re.exec(txt)) !== null) {
            var full = m[0];
            out.push({
                raw: full,
                body: trim(m[1]),
                before: txt.slice(0, m.index).trim(),
                after: txt.slice(m.index + full.length).trim()
            });
            if (m.index === re.lastIndex) re.lastIndex++;
        }
        if (!out.length) {
            /* 兜底：闭合标签缺失或写法不规范时再试一次宽松匹配 */
            var re2 = new RegExp(RE_BLOCK_LOOSE.source, 'gi');
            while ((m = re2.exec(txt)) !== null) {
                var full2 = m[0];
                out.push({
                    raw: full2,
                    body: trim(m[1]),
                    before: txt.slice(0, m.index).trim(),
                    after: txt.slice(m.index + full2.length).trim()
                });
                if (m.index === re2.lastIndex) re2.lastIndex++;
            }
        }
        return out;
    }

    /* 从一段回复里剥掉手札标记，留下正文（用于气泡正文） */
    function stripJournalFromText(rawText) {
        var txt = String(rawText || '');
        if (!txt) return '';
        var parts = extractJournalParts(txt);
        if (!parts.length) return txt;
        /* 多段时只保留第一段的 before/after，其余整段丢弃 */
        var first = parts[0];
        var joined = [first.before, first.after].filter(Boolean).join('\n').trim();
        return joined;
    }

    /**
     * 注入数据到模板。
     * 模板里预留了 <div id="gourmet-raw-data">$1</div>，$1 是 ST 的捕获组占位符。
     * 这里把它替换成实际数据；数据里的 < > 需要转义，避免破坏 DOM 结构。
     *
     * 两处必要处理：
     * 1) 模板 <head> 里有一个阻塞渲染的 Google Fonts <link rel=stylesheet>。
     *    在沙箱 iframe 里该请求会失败（ERR_CONNECTION_CLOSED），而失败的外链
     *    会让文档永远停在 readyState="loading"，内联 <script> 因此永不执行，
     *    卡片只剩 "--" 占位骨架。这里改成 media=print + onload 切回的异步加载，
     *    字体可用时照常生效，不可用时也不阻塞。
     * 2) 不要把 <script> 插在 <body> 之后（实测会被解析器截断整个 body）。
     */
    function deblockFontLinks(html) {
        /* 逐条处理 <link ...>：只针对 href 指向 fonts.googleapis.com 的那条。
           属性顺序不固定（模板里 href 在 rel 之前），所以不能依赖顺序。 */
        return String(html).replace(/<link\b[^>]*>/gi, function (tag) {
            if (!/fonts\.googleapis\.com/i.test(tag)) return tag;
            if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
            var cleaned = tag
                .replace(/\s*media\s*=\s*["'][^"']*["']/gi, '')
                .replace(/\s*onload\s*=\s*["'][^"']*["']/gi, '')
                .replace(/\s*\/?>$/, '');
            return cleaned + ' media="print" onload="this.media=\'all\'" />';
        });
    }

    /* 高度上报脚本：让父页面按内容真实高度调整 iframe，避免大片留白。
       注意：不要用 ResizeObserver 直接监听 body 并立即上报——上报会改变
       父页面 iframe 高度，进而触发模板自身的缩放 ResizeObserver，两者互相
       激发会形成回环并拖垮渲染进程。这里改为轮询式的「稳定后上报」：
       只在高度连续两次一致时才发一次消息。 */
    var HEIGHT_REPORTER =
        '<script>(function(){' +
        'var last=-1,stable=0;' +
        'function measure(){' +
        'try{' +
        'var o=document.getElementById("outerContainer");' +
        'var w=document.getElementById("statusRoot");' +
        'var h=(o&&o.offsetHeight)||(w&&w.offsetHeight)||document.body.scrollHeight;' +
        'return Math.ceil(h||0);' +
        '}catch(e){return 0;}' +
        '}' +
        'function tick(){' +
        'var h=measure();' +
        'if(h>0&&h===last){stable++;}else{stable=0;}' +
        'if(h>0&&stable===2){try{parent.postMessage({__miyaGourmetHeight:h},"*");}catch(e){}}' +
        'last=h;' +
        '}' +
        'var t=setInterval(tick,220);' +
        'setTimeout(function(){clearInterval(t);},12000);' +
        'document.addEventListener("click",function(){stable=0;setTimeout(tick,160);},true);' +
        '})();<\/script>';

    function injectData(tpl, body) {
        var safe = esc(body)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        var marker = /<div id="gourmet-raw-data"[^>]*>[\s\S]*?<\/div>/;
        var out;
        if (marker.test(tpl)) {
            out = tpl.replace(marker, '<div id="gourmet-raw-data" style="display:none;">' + safe + '</div>');
        } else {
            /* 模板结构若有变动，退回整体插入 body 前 */
            out = tpl.replace(/<body([^>]*)>/i, '<body$1><div id="gourmet-raw-data" style="display:none;">' + safe + '</div>');
        }
        /* 上报脚本插在 </body> 之前 */
        if (/<\/body>/i.test(out)) {
            out = out.replace(/<\/body>/i, HEIGHT_REPORTER + '</body>');
        } else {
            out = out + HEIGHT_REPORTER;
        }
        return deblockFontLinks(out);
    }

    function loadTemplate() {
        if (templateCache) return Promise.resolve(templateCache);
        if (templatePromise) return templatePromise;
        templatePromise = fetch(TEMPLATE_URL, { cache: 'force-cache' })
            .then(function (res) {
                if (!res.ok) throw new Error('template_http_' + res.status);
                return res.text();
            })
            .then(function (tpl) {
                templateCache = String(tpl || '');
                if (!templateCache) throw new Error('template_empty');
                return templateCache;
            })
            .catch(function (err) {
                templatePromise = null;
                throw err;
            });
        return templatePromise;
    }

    /* 同步版：模板已在缓存时直接返回，否则 null（调用方走异步预热） */
    function getTemplateSync() {
        return templateCache;
    }

    function preloadTemplate() {
        return loadTemplate().catch(function () {
            return null;
        });
    }

    function buildSrcdoc(body) {
        var tpl = getTemplateSync();
        if (!tpl) return '';
        return injectData(tpl, body);
    }

    /*
     * 渲染后的 iframe：给一个稳定的 data 属性，便于统一回收。
     *
     * 模板是异步取的（fetch 一次后缓存）。首次水合时模板可能还没到位，
     * 此时不要直接放弃——把模板拉下来之后再补一次水合，
     * 否则第一张卡会永远停在空白 iframe。
     */
    /* 高度自适应：卡片折叠态约 160px、展开态几百 px，固定 420px 会留白。
       监听卡片上报的真实高度并同步给 iframe。
       注意：只在高度变化超过 4px 时才写样式，避免与卡片内部观察者形成回环。 */
    function applyFrameHeight(frame, h) {
        if (!frame || !h) return;
        var px = Math.max(120, Math.min(Math.ceil(h) + 4, 1600));
        var prev = parseInt(frame.getAttribute('data-miya-gourmet-h') || '0', 10) || 0;
        if (prev && Math.abs(prev - px) < 5) return;
        frame.style.height = px + 'px';
        frame.setAttribute('data-miya-gourmet-h', String(px));
    }

    var heightListenerBound = false;
    function bindHeightListener() {
        if (heightListenerBound) return;
        heightListenerBound = true;
        global.addEventListener('message', function (ev) {
            var d = ev.data;
            if (!d || typeof d.__miyaGourmetHeight !== 'number') return;
            /* 用 source 精确匹配到对应 iframe，避免多张卡串高度 */
            var frames = document.querySelectorAll('iframe[data-miya-gourmet-src="1"]');
            var i;
            for (i = 0; i < frames.length; i++) {
                if (frames[i].contentWindow === ev.source) {
                    applyFrameHeight(frames[i], d.__miyaGourmetHeight);
                    break;
                }
            }
        });
    }

    function hydrateJournalIframes(root) {
        var scope = root || document;
        var nodes = scope.querySelectorAll('[data-miya-gourmet-journal="1"]');
        if (!nodes.length) return;
        if (!templateCache) {
            loadTemplate()
                .then(function () {
                    hydrateJournalIframes(root);
                })
                .catch(function () {});
            return;
        }
        bindHeightListener();
        var i;
        for (i = 0; i < nodes.length; i++) {
            var host = nodes[i];
            var frame = host.querySelector('iframe[data-miya-gourmet-src="1"]');
            if (!frame) continue;
            if (frame.getAttribute('data-miya-gourmet-hydrated') === '1') continue;
            var body = host.getAttribute('data-miya-gourmet-body') || '';
            var srcdoc = buildSrcdoc(body);
            if (!srcdoc) continue;
            try {
                var blob = new Blob([srcdoc], { type: 'text/html;charset=utf-8' });
                var burl = URL.createObjectURL(blob);
                frame.src = burl;
                frame.setAttribute('data-miya-gourmet-hydrated', '1');
                frame.setAttribute('data-miya-gourmet-blob', burl);
                liveBlobUrls.push(burl);
            } catch (e) {}
        }
    }

    function revokeJournalBlobUrls() {
        var i;
        for (i = 0; i < liveBlobUrls.length; i++) {
            try {
                URL.revokeObjectURL(liveBlobUrls[i]);
            } catch (e) {}
        }
        liveBlobUrls = [];
    }

    /**
     * 生成气泡 HTML。
     * 结构与 miya-chat-room.js 的 renderHtmlMessageBody 保持一致：
     * 外层卡片 + 工具条 + 沙箱 iframe。
     */
    function renderJournalCardHTML(body, innerEsc) {
        var e = typeof innerEsc === 'function' ? innerEsc : function (s) { return String(s == null ? '' : s); };
        return (
            '<div class="qq-room__gourmet-journal" data-miya-gourmet-journal="1" data-miya-gourmet-body="' +
            e(body) +
            '">' +
            '<div class="qq-room__html-toolbar">' +
            '<button type="button" class="qq-room__gourmet-fs" data-miya-gourmet-fs="1">全屏查看</button>' +
            '</div>' +
            '<iframe class="qq-room__gourmet-iframe" data-miya-gourmet-src="1"' +
            ' sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"' +
            ' referrerpolicy="no-referrer" title="冒险者手札"></iframe>' +
            '</div>'
        );
    }

    function openJournalFullscreen(body) {
        var srcdoc = buildSrcdoc(body);
        if (!srcdoc) {
            /* 模板还没加载好：拉一次再开（不要递归自身，否则模板加载失败会死循环） */
            return loadTemplate()
                .then(function () {
                    openJournalFullscreen(body);
                })
                .catch(function () {});
        }
        closeJournalFullscreenLayer();
        var blob = new Blob([srcdoc], { type: 'text/html;charset=utf-8' });
        var burl = URL.createObjectURL(blob);
        global.__miyaGourmetFsBlobUrl = burl;
        var layer = document.createElement('div');
        layer.id = 'miya-gourmet-fs-layer';
        layer.className = 'miya-gourmet-fs-layer';
        layer.setAttribute('role', 'dialog');
        layer.setAttribute('aria-modal', 'true');
        layer.innerHTML =
            '<div class="miya-gourmet-fs-inner">' +
            '<header class="miya-gourmet-fs-head">' +
            '<button type="button" class="miya-gourmet-fs-back">返回</button>' +
            '</header>' +
            '<iframe class="miya-gourmet-fs-iframe" title="冒险者手札 全屏"' +
            ' sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"' +
            ' referrerpolicy="no-referrer"></iframe>' +
            '</div>';
        document.body.appendChild(layer);
        var iframe = layer.querySelector('.miya-gourmet-fs-iframe');
        if (iframe) iframe.src = burl;
        layer.addEventListener('click', function (ev) {
            var t = ev.target;
            if (t && t.closest && t.closest('.miya-gourmet-fs-back')) closeJournalFullscreenLayer();
        });
        return undefined;
    }

    function closeJournalFullscreenLayer() {
        var el = document.getElementById('miya-gourmet-fs-layer');
        if (el && el.parentNode) {
            try {
                el.parentNode.removeChild(el);
            } catch (e) {}
        }
        if (global.__miyaGourmetFsBlobUrl) {
            try {
                URL.revokeObjectURL(global.__miyaGourmetFsBlobUrl);
            } catch (e2) {}
            global.__miyaGourmetFsBlobUrl = '';
        }
    }

    global.MiyaGourmetJournal = {
        hasGourmetJournal: hasGourmetJournal,
        extractJournalParts: extractJournalParts,
        stripJournalFromText: stripJournalFromText,
        loadTemplate: loadTemplate,
        preloadTemplate: preloadTemplate,
        buildSrcdoc: buildSrcdoc,
        renderJournalCardHTML: renderJournalCardHTML,
        hydrateJournalIframes: hydrateJournalIframes,
        revokeJournalBlobUrls: revokeJournalBlobUrls,
        openJournalFullscreen: openJournalFullscreen,
        closeJournalFullscreenLayer: closeJournalFullscreenLayer
    };
})(window);
