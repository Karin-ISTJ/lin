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

    /* 允许 </plot> 缺失（流式截断时常见），用 $ 锚住尾部兜底。
       ⚠️ 但不能吞到 <miyastatus>：模型偶尔不按规则把状态栏写在 plot 之后，
       未闭合兜底若一路吞到 $ 会连状态栏块一起吃掉 —— 用前瞻在 miyastatus 处刹住
       （全角 ＜miyastatus＞ 同防）。 */
    function blockRegex() {
        /* 半角/全角开标均可开（中文语境模型爱输出 ＜plot＞），闭标同理；
           未闭合兜底仍在 miyastatus（半/全角）处刹住。 */
        return new RegExp(
            '(?:<\\s*' + TAG + '\\s*>|＜\\s*' + TAG + '\\s*＞)' +
            '([\\s\\S]*?)' +
            '(?:<\\s*\\/\\s*' + TAG + '\\s*>|＜\\s*\\/\\s*' + TAG + '\\s*＞' +
            '|(?=<miyastatus|＜miyastatus)|$)',
            'i'
        );
    }

    function hasPlotBlock(rawText) {
        var txt = String(rawText || '');
        if (!txt) return false;
        return new RegExp('(?:<\\s*' + TAG + '\\s*>|＜\\s*' + TAG + '\\s*＞)', 'i').test(txt);
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
        if (!txt) return txt;
        if (!hasPlotBlock(txt)) return txt;
        var OPEN = '(?:<\\s*' + TAG + '\\s*>|＜\\s*' + TAG + '\\s*＞)';
        var CLOSE = '(?:<\\s*\\/\\s*' + TAG + '\\s*>|＜\\s*\\/\\s*' + TAG + '\\s*＞)';
        return txt.replace(new RegExp(OPEN + '[\\s\\S]*?' + CLOSE, 'gi'), ' ')
            /* 未闭合：剥到结尾；但 <miyastatus> 之前必须刹住，别把状态栏一起剥掉 */
            .replace(new RegExp(OPEN + '[\\s\\S]*?(?=<miyastatus|＜miyastatus|$)', 'gi'), ' ')
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

       这几个常量代表设计稿（v3 紧凑紫韵版）里的绝对值，集中放这里便于校对：
         13px    = 卡片根 / 中间容器 / 选项按钮 / 文案列（.choice-text）的基准
         11px    = 「剧情建议」标题
         11px    = 选项左侧 ◇ 图标（line-height 1.9 让它对齐 13px×1.6 的首行中线）
       ──────────────────────────────────────────────────────── */
    var FIX_FS_13 = 'font-size:13px !important';
    var FIX_FS_TITLE = 'font-size:11px !important';
    var FIX_FS_ICON = 'font-size:11px !important';
    /* 按钮字号：设计稿单值 13px，无宽窄屏分支（v3 已删窄屏媒体查询） */
    var FIX_FS_BTN = 'font-size:13px !important';

    /* ── 字体强绑定（防全局字体/字重覆盖）────────────────────────
       和上面的字号是同一类问题，两条全局规则会改掉卡片字形：
         1. .miya-offline-app 根节点 font-family:var(--xw-sans)
            （黑体）+ font-weight:300 —— 卡片不写死就会变成「细黑体」；
         2. 用户启用自定义字体时，style.css 里有
            html.miya-custom-font-active body :where(:not(...)×5) {
              font-family: var(--miya-font) !important;
            }
            特异性 (0,3,3) 且带 !important，命中 body 下每一个元素，
            CSS 文件里无论怎么堆选择器都追不平 ——
            唯一稳赢的还是【内联 + !important】。

       设计稿指定的是衬线宋体，所以这里整卡钉死 serif 栈：
       Android 的 Noto Serif CJK SC / Noto Serif SC、
       iOS/macOS 的 Songti SC、部分国产 ROM 的 Source Han Serif SC，
       最后落 generic serif（Android 上通常也是 Noto Serif 系）。
       与独立打开设计 HTML 用的是同一栈 → 同一设备同一观感。
       ──────────────────────────────────────────────────────── */
    /* ⚠️ 字体名必须用【单引号】：这段字符串要拼进 style="..." 双引号属性里，
       若字体名也用双引号，第一个 " 就会把 style 属性截断，整条声明失效
       （实测踩过：computed 落回全局字体，卡片又变黑体）。 */
    var FIX_FF = "font-family:'Noto Serif CJK SC','Noto Serif SC','Songti SC','Source Han Serif SC',serif !important";
    var FIX_FW_400 = 'font-weight:400 !important';
    var FIX_FW_600 = 'font-weight:600 !important';

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
     * 渲染「剧情建议」卡片（v3 紧凑紫韵版）。
     *
     * DOM 结构与用户 2026-09 给的最新设计稿片段逐字对齐：
     *   .wrap  >  .sec  >  h4.sec-title（「剧情建议」，渐变竖条 + 渐隐线）
     *                  >  .body
     *                       >  button.choice × N
     *                            >  span.choice-icon（◇）
     *                            >  span.choice-text（文案）
     *
     * 与给定片段的唯一差别是外层多了 .xw-plot-card 作用域类：
     *   · 让这套「写死的外观」不干扰线下主题的其它元素；
     *   · 卡片自带一套局部 CSS 变量，任何主题下颜色一致。
     * 卡片内部的类名、层级、伪元素一个没动。
     *
     * ⚠️ 点击交互只认 button 上的 data-ap-plot-choice 属性
     * （miya-appointment-app 的 bindFloorToolsDelegate 用 closest 找它，
     * 测试钩子 click(i) 也按它索引）—— icon/text 只是视觉子元素，
     * 改布局时别动这个属性。
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
     *   v2 新增的 .choice-icon / .choice-text 两个 span 同样被那条规则
     *   命中，所以也逐个内联钉死（v3：图标 11px / 文案 13px）。
     *
     *   副作用（刻意接受）：用户调线下字号时卡片不跟着变大。
     *   这张卡是成品设计，字号/字距/内边距是一套调好的整体，
     *   跟着缩必然变形，那就又回到「和独立 HTML 不一样」了。
     *
     *   --miya-font-size-scale:1 同时写在根上做双保险：
     *   万一将来那条全局规则改了写法（比如去掉 !important），
     *   变量归零也能让 calc 退化成 1em。
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
         * v3 设计稿是单值 13px，无宽窄屏字号分支（窄屏媒体查询已随
         * 设计稿一起移除，见样式表）。
         *
         * 之所以不在这里写媒体查询：字号是内联 !important，
         * 样式表里的媒体查询永远赢不了它 —— 分支没有意义。
         */

        var choiceFs = FIX_FS_BTN;

        var choices = list
            .map(function (text) {
                return (
                    '<button type="button" class="choice" data-ap-plot-choice="' +
                    escAttr(text) +
                    '" style="' +
                    choiceFs +
                    ';' +
                    FIX_FF +
                    ';' +
                    FIX_FW_400 +
                    '">' +
                    '<span class="choice-icon" style="' +
                    FIX_FS_ICON +
                    '" aria-hidden="true">◇</span>' +
                    '<span class="choice-text" style="' +
                    FIX_FS_13 +
                    '">' +
                    esc(text) +
                    '</span>' +
                    '</button>'
                );
            })
            .join('');

        return (
            '<div class="xw-plot-card" data-ap-plot-card="1"' +
            ' style="--miya-font-size-scale:1;' +
            FIX_FS_13 +
            ';' +
            FIX_FF +
            ';' +
            FIX_FW_400 +
            '">' +
            '<div class="wrap" style="' +
            FIX_FS_13 +
            ';' +
            FIX_FF +
            ';' +
            FIX_FW_400 +
            '">' +
            '<div class="sec" style="' +
            FIX_FS_13 +
            ';' +
            FIX_FF +
            ';' +
            FIX_FW_400 +
            '">' +
            '<h4 class="sec-title" style="' +
            FIX_FS_TITLE +
            ';' +
            FIX_FF +
            ';' +
            FIX_FW_600 +
            '">剧情建议</h4>' +
            '<div class="body">' +
            choices +
            '</div>' +
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
