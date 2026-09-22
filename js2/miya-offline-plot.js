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

        var choices = list
            .map(function (text) {
                return (
                    '<button type="button" class="choice" data-ap-plot-choice="' +
                    escAttr(text) +
                    '">' +
                    esc(text) +
                    '</button>'
                );
            })
            .join('');

        return (
            '<div class="xw-plot-card" data-ap-plot-card="1">' +
            '<div class="wrap">' +
            '<div class="sec">' +
            '<div class="sec-title">剧情建议</div>' +
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
