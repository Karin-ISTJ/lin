/**
 * 线下楼层 · 剧情走向建议（剧情建议卡）
 *
 * 职责边界
 *   1. 只做「解析 + 出 HTML」，不碰 DOM、不绑事件、不读库。
 *      DOM 挂载点由 miya-appointment-app.js 决定（正文最底部），
 *      点击行为也由那边的 bindFloorToolsDelegate 统一委托。
 *   2. 标记用 <plot>…</plot>，与正文完全分离 —— 模型把建议写在里面，
 *      引擎解析时就整段摘走，标记本身永远不会进楼层正文，
 *      也就不会被下一轮当历史送回去、被模型当成一种写法跟着学。
 *
 * 为什么样式写得「死」
 *   这张卡的外观是用户指定的成品，不属于线下主题的一部分。
 *   所以色值不走 --xw-* 主题变量，而是自带一套局部变量（见 css/miya-offline-plot.css），
 *   无论博物馆 / 手账 / 自定义皮肤，它都长得一模一样。
 */
(function (global) {
    'use strict';

    /* ── 标记 ──────────────────────────────────────────────── */

    var TAG = 'plot';

    /* 允许 </plot> 缺失（流式截断时常见），用 $ 锚住尾部兜底 */
    function blockRegex() {
        return new RegExp('<' + TAG + '\\s*>([\\s\\S]*?)(?:<\\s*\\/\\s*' + TAG + '\\s*>|$)', 'i');
    }

    function hasPlotBlock(rawText) {
        var txt = String(rawText || '');
        if (!txt) return false;
        return new RegExp('<\\s*' + TAG + '\\s*>', 'i').test(txt);
    }

    /**
     * 取第一个 <plot> 块内部那段文本。
     * 没有块时返回空串 —— 调用方据此判断「这一版模型没给建议」。
     */
    function extractPlotRaw(rawText) {
        var txt = String(rawText || '');
        if (!txt) return '';
        var m = txt.match(blockRegex());
        if (!m) return '';
        return String(m[1] || '').trim();
    }

    /**
     * 把 <plot> 块整段从回复里剥掉，返回剥干净的正文。
     *
     * 这是「标记不进正文」的唯一保险：即使调用方忘了先解析，
     * 只要走一次 stripPlot，楼层里就不会残留标签。
     */
    function stripPlot(rawText) {
        var txt = String(rawText || '');
        if (!txt) return '';
        if (!hasPlotBlock(txt)) return txt;
        return txt.replace(new RegExp('<\\s*' + TAG + '\\s*>[\\s\\S]*?<\\s*\\/\\s*' + TAG + '\\s*>', 'gi'), ' ')
            .replace(new RegExp('<\\s*' + TAG + '\\s*>[\\s\\S]*$', 'gi'), ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /* ── 行解析 ────────────────────────────────────────────────
       期望格式（示例）：

           <plot>
           - 我说：He said "OK"，然后把手收回来
           - 我把纸条递过去，上面写着 <别走>
           - 什么都不说，只是站着
           - 问她要不要我送她回去
           </plot>

       容错：模型经常不听话。以下写法都收：
         · 行首用 - / – / — / · / • / * / 1. / 1、 等任意一种前缀
         · 直接写一行纯文字（无前缀）
         · 用「1) 」「①」「（1）」这类编号
         · 用 <br> / 全角空格分隔
       解析只负责「切行 + 去前缀」，内容一个字不改 —— 用户要求
       「不要改成别的」，那文案就原样呈现。
       ──────────────────────────────────────────────────────── */

    var MAX_ITEMS = 6;
    var MAX_ITEM_LEN = 120;

    /* ── 字号强绑定（防全局字号缩放）────────────────────────────
       style.css 里有一条 [data-miya-fs] 全局规则，把后代元素字号写成
       calc(1em * var(--miya-font-size-scale)) !important，命中每个标签、
       且是相对值会逐层累积。用户调过线下字号时卡片会爆炸
       （12px 滚成 48.83px）。唯一稳赢的写法是【内联 + !important】，
       因为内联样式的 !important 在层叠中优先级最高，
       而 CSS 文件里无论怎么堆选择器都追不平对家的 (0,10,1) 特异性。

       这三个常量代表设计稿里的绝对值，集中放这里便于校对：
         15px = 卡片根 / 中间容器的基准
         12px = 「剧情建议」标题
         14px = 每个选项按钮
       ──────────────────────────────────────────────────────── */
    var FIX_FS_15 = 'font-size:15px !important';
    var FIX_FS_12 = 'font-size:12px !important';
    var FIX_FS_14 = 'font-size:14px !important';
    var FIX_FS_13_5 = 'font-size:13.5px !important';

    /* ── 颜色强绑定（防自定义皮肤串色）──────────────────────────
       卡片是成品设计，八个色值全部写死。它们原先定义在
       css/miya-offline-plot.css 的 .xw-plot-card 规则里，看着没问题
       （没引用任何 --xw-*），但「线下 → 样式 → 自定义 CSS」一开，
       卡片就会被皮肤颜色染掉。

       原因不在卡片，而在 CSS 继承：
       · 自定义 CSS 由 miya-offline-beautify.js 的 injectCustomCss()
         注入到 #miya-offline-app **内部**，注入点就在卡片的祖先链上；
       · 皮肤里只要出现 `--ink` / `--soft` / `--hair` / `--gold` /
         `--purple` / `--panel` 这类通用名（几乎一定会撞），
         就会被卡片的子元素继承；
       · 自定义 <style> 在文档里的位置排在 miya-offline-plot.css 之后，
         同特异性下后者胜出 —— 卡片的紫调被皮肤里的暖金 / 暖米顶掉。

       只要变量还定义在卡片根上，它就在继承链里，就能被上游覆盖，
       所以修法不是「改选择器特异性」而是「换存放位置」：
       把变量内联写到卡片根这一个元素上，优先级压过任何继承值，
       且与加载顺序无关 —— 皮肤写什么名字都染不进来。

       改色值只改这里（CSS 文件里那份是给「裸开 CSS」用的同值兜底，
       两份必须一致，文件末尾有交叉引用注释）。
       ──────────────────────────────────────────────────────── */
    var INLINE_COLORS = [
        '--ink:#2A2436',
        '--soft:#7A7290',
        '--hair:rgba(107,78,158,.20)',
        '--purple:#6B4E9E',
        '--purple-l:#8B6FC4',
        '--gold:#C9A227',
        '--panel:#FCFAFF'
    ].join(';') + ';';

    /* 行首前缀：项目符号 / 编号 / 全角编号，后面可能跟一个空格或制表符 */
    var PREFIX_RE = /^\s*(?:[-–—·•*‧∙※]|\(?\d{1,2}[).、．]?|[①②③④⑤⑥⑦⑧⑨⑩]|（\d{1,2}）)\s*/;

    function normalizeLine(line) {
        var t = String(line == null ? '' : line);
        /* 先把可能混进来的 <br> 之类当分隔符处理掉 */
        t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n');
        t = t.replace(/\u3000/g, ' ');
        return t;
    }

    function parsePlotItems(rawBody) {
        var body = normalizeLine(rawBody);
        if (!body) return [];

        var out = [];
        var seen = Object.create(null);

        body.split(/\r?\n/).forEach(function (line) {
            var t = String(line || '').trim();
            if (!t) return;
            t = t.replace(PREFIX_RE, '').trim();
            if (!t) return;
            /* 把建议里的换行（模型偶尔塞进来的）压平，卡片是单行按钮 */
            t = t.replace(/\s*\n\s*/g, ' ');
            if (t.length > MAX_ITEM_LEN) t = t.slice(0, MAX_ITEM_LEN);
            if (seen[t]) return;
            seen[t] = true;
            out.push(t);
        });

        return out.slice(0, MAX_ITEMS);
    }

    /** 一步到位：从整段回复里取出建议列表 */
    function extractPlotItems(rawText) {
        var body = extractPlotRaw(rawText);
        return parsePlotItems(body);
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

    /**
     * 渲染「剧情建议」卡片。
     *
     * DOM 结构与用户在需求里给的片段逐字对齐：
     *   .wrap  >  .sec  >  .sec-title（「剧情建议」）
     *                  >  button.choice × N（左 ◇、右箭头）
     *
     * 与给定片段的唯一差别是外层多了 .xw-plot-card 作用域类：
     *   · 让这套「写死的外观」不干扰线下主题的其它元素；
     *   · 卡片自带一套局部 CSS 变量，任何主题下颜色一致。
     * 卡片内部的类名、层级、伪元素一个没动。
     *
     * ⚠️ 内联的 font-size + !important 是必需的，别删也别简化成纯 CSS：
     *
     *   css/style.css 里有一条全局字号缩放规则，展开后等价于
     *     [data-miya-fs] :where(div, button, span, …):not(×10) {
     *       font-size: calc(1em * var(--miya-font-size-scale, 1)) !important;
     *     }
     *   用户在线下设置里调过字号时，miya-theme.js 会给 .miya-offline-app
     *   加上 data-miya-fs，并用内联样式设 --miya-font-size-scale = 倍率。
     *   它用 1em（相对值）且命中每一个后代标签，卡片多层嵌套各乘一次，
     *   12px 的标题会滚成 48.83px，整张卡彻底走形 —— 这就是
     *   「单独打开 HTML 好看，放进项目里丑」的全部原因。
     *
     *   为什么必须写在 style 属性里：
     *   两个 !important 相撞时比特异性。对家是 (0,10,1)
     *   （10 个 :not(.class) + 1 个 :where(div)），
     *   CSS 文件里无论怎么堆选择器都追不平，
     *   而【内联样式 + !important】在层叠里是最高一级，必胜。
     *
     *   副作用（刻意接受）：用户调线下字号时卡片不跟着变大。
     *   这张卡是成品设计，字号/字距/内边距是一套调好的整体，
     *   跟着缩必然变形，那就又回到「和独立 HTML 不一样」了。
     *
     *   --miya-font-size-scale:1 同时写在根上做双保险：
     *   万一将来那条全局规则改了写法（比如去掉 !important），
     *   变量归零也能让 calc 退化成 1em。
     *
     * ⚠️ 八个颜色变量为什么也必须内联，而不是留在 CSS 文件里：
     *
     *   它们最初是写在 css/miya-offline-plot.css 的 .xw-plot-card 规则里，
     *   看起来完全自洽 —— 不引用任何 --xw-*，换主题也不会变。
     *   但只要用户碰过「线下 → 样式 → 自定义 CSS」，卡片就会被染黄：
     *   自定义 CSS 是由 miya-offline-beautify.js 的 injectCustomCss()
     *   注入到 #miya-offline-app **内部**的，注入点正好落在卡片的祖先链上。
     *   于是皮肤 CSS 里任何一句 `--ink` / `--soft` / `--hair` / `--gold` /
     *   `--purple` / `--panel`（这些名字太通用，几乎一定会撞）都会
     *   被卡片的子元素【继承】过去；而自定义 <style> 在文档里的位置
     *   排在 miya-offline-plot.css 之后，同特异性下后者胜出 ——
     *   卡片的紫调就被皮肤里的暖金 / 暖米顶掉，正是用户看到的「染黄」。
     *
     *   注意这不是「谁写错了」，而是「CSS 继承 + 文档顺序」的必然结果：
     *   只要变量还定义在卡片根上，它就在继承链里，就能被上游覆盖。
     *   内联声明把作用域压缩到卡片根这一个元素，优先级压过任何
     *   继承值，且与加载顺序无关 —— 皮肤写什么名字都染不进来。
     *   （顺带一提，index.html 里给这张卡的样式表加 ?v= 也治不了它：
     *     那是 HTTP 缓存版本号，跟层叠先后是两回事。）
     *
     * @param {string[]} items 建议文案（已解析、未转义）
     * @returns {string} HTML；无建议时返回空串
     */
    function renderPlotCardHtml(items) {
        var list = Array.isArray(items) ? items : [];
        list = list
            .map(function (x) {
                return String(x == null ? '' : x).trim();
            })
            .filter(Boolean)
            .slice(0, MAX_ITEMS);
        if (!list.length) return '';

        /*
         * 窄屏（≤420px）选项字号收一档，与设计稿的响应式规则一致。
         *
         * 为什么要在 JS 里判一次：字号是内联写的，而【内联的 !important
         * 永远压过样式表里的 !important】—— 媒体查询那条
         * `@media (max-width:420px){ .choice{font-size:13.5px} }`
         * 根本赢不了内联的 14px。所以这里主动把值改成 13.5px。
         *
         * matchMedia 不可用时（极老的 WebView）回退到窗口宽度，
         * 再不行就当宽屏 —— 宁可字号大一档，也不能让卡片不显示。
         */
        var narrow = false;
        try {
            if (typeof global.matchMedia === 'function') {
                narrow = global.matchMedia('(max-width: 420px)').matches;
            } else if (typeof global.innerWidth === 'number') {
                narrow = global.innerWidth <= 420;
            }
        } catch (eNarrow) {
            narrow = false;
        }
        var choiceFs = narrow ? FIX_FS_13_5 : FIX_FS_14;

        var choices = list
            .map(function (text) {
                return (
                    '<button type="button" class="choice" data-ap-plot-choice="' +
                    escAttr(text) +
                    '" style="' +
                    choiceFs +
                    '">' +
                    esc(text) +
                    '</button>'
                );
            })
            .join('');

        return (
            '<div class="xw-plot-card" data-ap-plot-card="1"' +
            ' style="' +
            '--miya-font-size-scale:1;' +
            INLINE_COLORS +
            FIX_FS_15 +
            '">' +
            '<div class="wrap" style="' +
            FIX_FS_15 +
            '">' +
            '<div class="sec" style="' +
            FIX_FS_15 +
            '">' +
            '<div class="sec-title" style="' +
            FIX_FS_12 +
            '">剧情建议</div>' +
            choices +
            '</div></div></div>'
        );
    }

    /**
     * 从「一条消息」上取建议。
     *
     * 建议存放在 msg.plotHints（引擎解析后随楼层落库）。
     * 兼容两种形态：
     *   · 字符串数组 —— 正常情况
     *   · 整段 <plot> 文本 —— 旧楼层 / 导入数据里可能残留标记
     * 后者顺手解析一次，保证老数据也能显出卡片。
     */
    function plotItemsFromMessage(m) {
        if (!m) return [];
        var hints = m.plotHints;
        if (Array.isArray(hints) && hints.length) {
            return hints
                .map(function (x) { return String(x == null ? '' : x).trim(); })
                .filter(Boolean)
                .slice(0, MAX_ITEMS);
        }
        if (typeof hints === 'string' && hints.trim()) {
            var s = hints.trim();
            if (hasPlotBlock(s)) return extractPlotItems(s);
            return parsePlotItems(s);
        }
        /* 极端兜底：正文里还留着标记（尚未过引擎解析的老数据） */
        if (hasPlotBlock(m.content)) return extractPlotItems(m.content);
        return [];
    }

    global.MiyaOfflinePlot = {
        TAG: TAG,
        MAX_ITEMS: MAX_ITEMS,
        MAX_ITEM_LEN: MAX_ITEM_LEN,
        hasPlotBlock: hasPlotBlock,
        extractPlotRaw: extractPlotRaw,
        stripPlot: stripPlot,
        parsePlotItems: parsePlotItems,
        extractPlotItems: extractPlotItems,
        renderPlotCardHtml: renderPlotCardHtml,
        plotItemsFromMessage: plotItemsFromMessage
    };
})(window);
