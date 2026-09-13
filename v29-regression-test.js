/**
 * v29 回归测试：B1 / B3 / B4 / B5 / B6（美化功能第一轮修复）
 * 对「包内真实文件」运行，每个用例都做「修复版通过 / 回退版必挂」的双向验证。
 *
 * 运行：node run-v29.js <包目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'v29');
const results = [];
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) {
        pass += 1;
        results.push('  ✅ ' + name);
    } else {
        fail += 1;
        results.push('  ❌ ' + name + (detail ? '  —— ' + detail : ''));
    }
}

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ────────────────── 最小 DOM / localStorage 沙箱 ────────────────── */
function makeSandbox() {
    const store = new Map();
    let setCount = 0;
    const created = [];

    function makeEl(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            children: [],
            style: {},
            classList: {
                _s: new Set(),
                add(c) { this._s.add(c); },
                remove(c) { this._s.delete(c); },
                toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
                contains(c) { return this._s.has(c); }
            },
            _attrs: {},
            hidden: false,
            innerHTML: '',
            textContent: '',
            value: '',
            setAttribute(k, v) { this._attrs[k] = v; },
            getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
            removeAttribute(k) { delete this._attrs[k]; },
            hasAttribute(k) { return k in this._attrs; },
            appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
            remove() {},
            addEventListener(t, fn) { (this._ev || (this._ev = {}))[t] = fn; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; },
            click() {}
        };
        return el;
    }

    const appEl = makeEl('div');
    appEl.id = 'miya-offline-app';

    const document = {
        createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
        getElementById(id) { return id === 'miya-offline-app' ? appEl : null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        body: makeEl('body'),
        documentElement: makeEl('html')
    };

    const localStorage = {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { setCount += 1; store.set(k, String(v)); },
        removeItem(k) { store.delete(k); },
        _dump() { return store; }
    };

    const window = {
        document, localStorage,
        innerWidth: 375, innerHeight: 667,
        addEventListener() {}, removeEventListener() {},
        setTimeout(fn) { return 0; },
        clearTimeout() {},
        Promise, Date, Math, JSON, Object, Array, String, Number, RegExp, Error,
        console
    };
    window.window = window;

    return { window, document, localStorage, created, appEl, makeEl };
}

function runIn(sandbox, code, filename) {
    const ctx = vm.createContext(sandbox.window);
    vm.runInContext(code, ctx, { filename: filename || 'x.js' });
    return sandbox.window;
}

/* ═══════════════════════════════════════════════════════════════════════
   B3：聊天室主题白名单收敛为 store 单点定义
   ═══════════════════════════════════════════════════════════════════════ */
function testB3() {
    const storeSrc = read('js1/miya-chat-store.js');
    const bfSrc = read('js1/miya-chat-beautify.js');

    // 1) store 必须导出权威白名单常量
    check('B3-a1 store 定义了 CHAT_THEME_IDS 常量',
        /var\s+CHAT_THEME_IDS\s*=\s*\[/.test(storeSrc));

    // 2) 白名单必须含 noir（这正是旧版漏掉、导致「夜刊」被静默降级的根因）
    const m = storeSrc.match(/var\s+CHAT_THEME_IDS\s*=\s*\[([^\]]*)\]/);
    const ids = m ? m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
    check('B3-a2 白名单包含 noir', ids.indexOf('noir') >= 0, JSON.stringify(ids));
    check('B3-a3 白名单包含 gallery/ins/blossom/custom',
        ['gallery', 'ins', 'blossom', 'custom'].every(k => ids.indexOf(k) >= 0), JSON.stringify(ids));

    // 3) store 必须把常量挂到导出对象上，供美化模块引用
    check('B3-a4 store 导出对外暴露 CHAT_THEME_IDS',
        /CHAT_THEME_IDS\s*:\s*CHAT_THEME_IDS/.test(storeSrc));

    // 4) store 的 normalize 必须引用常量而非内联字面量
    check('B3-a5 normalizeChatBeautify 引用 CHAT_THEME_IDS 做校验',
        /CHAT_THEME_IDS\.indexOf\(/.test(storeSrc));

    // 5) beautify 端不得再留内联白名单字面量做校验，应回落到 store
    check('B3-a6 beautify 通过 chatThemeIds() 读取 store 白名单',
        /function\s+chatThemeIds\s*\(/.test(bfSrc) && /miyaChatStore/.test(bfSrc));
    check('B3-a7 beautify 保留了兜底常量（store 未就绪时可用）',
        /THEME_FALLBACK_IDS\s*=\s*\[/.test(bfSrc));

    // 6) 真实验证：noir 能通过 store 的 normalize 存活
    const sb = makeSandbox();
    try {
        runIn(sb, storeSrc, 'store.js');
    } catch (e) {
        check('B3-b1 store 可加载', false, e.message);
        return;
    }
    const st = sb.window.miyaChatStore;
    check('B3-b1 store 可加载且导出 CHAT_THEME_IDS',
        !!(st && Array.isArray(st.CHAT_THEME_IDS)));
    if (!st || !Array.isArray(st.CHAT_THEME_IDS)) return;

    check('B3-b2 导出值与源码常量一致',
        st.CHAT_THEME_IDS.join(',') === ids.join(','),
        st.CHAT_THEME_IDS.join(',') + ' vs ' + ids.join(','));

    // 通过 probe 拿到 normalizeChatBeautify 做白盒验证
    const probeSrc = storeSrc.replace(
        /(var\s+store\s*=\s*\{)/,
        'global.__probe = { normalizeChatBeautify: typeof normalizeChatBeautify === "function" ? normalizeChatBeautify : null, CHAT_THEME_IDS: CHAT_THEME_IDS };\n    $1'
    );
    if (!probeSrc.includes('global.__probe')) {
        check('B3-b3 normalizeChatBeautify 可探针注入', false, '锚点缺失');
        return;
    }
    const sb2 = makeSandbox();
    try {
        runIn(sb2, probeSrc, 'store_probe.js');
    } catch (e) {
        check('B3-b3 normalizeChatBeautify 可探针注入', false, e.message);
        return;
    }
    const p = sb2.window.__probe;
    check('B3-b3 normalizeChatBeautify 可探针注入', typeof p.normalizeChatBeautify === 'function');
    if (typeof p.normalizeChatBeautify !== 'function') return;

    // 核心断言：noir 必须原样保留（旧版会降级成 gallery）
    const kept = p.normalizeChatBeautify({ themeId: 'noir' });
    check('B3-b4 noir 主题能存活（旧版降级为 gallery）',
        kept && kept.themeId === 'noir', JSON.stringify(kept && kept.themeId));

    const keptIns = p.normalizeChatBeautify({ themeId: 'ins' });
    check('B3-b5 ins 主题能存活', keptIns && keptIns.themeId === 'ins');

    const bad = p.normalizeChatBeautify({ themeId: '不存在的主题' });
    check('B3-b6 非法主题仍被拦下（回落默认）',
        bad && bad.themeId !== '不存在的主题' && p.CHAT_THEME_IDS.indexOf(bad.themeId) >= 0,
        JSON.stringify(bad && bad.themeId));
}

/* ═══════════════════════════════════════════════════════════════════════
   B1：线下美化 主题只由 themeId 决定，customCss 不再劫持
   ═══════════════════════════════════════════════════════════════════════ */
function testB1() {
    const src = read('js2/miya-offline-beautify.js');

    // 源码级：三处劫持点都必须消失
    const hijackInline = /themeId:\s*raw\.customCss\s*\?/.test(src);
    check('B1-a1 normalizeBeautify 不再用 customCss 决定 themeId', !hijackInline);

    const hijackApply = /var\s+tid\s*=\s*bf\.customCss\s*\?/.test(src);
    check('B1-a2 applyToAppEl 不再用 customCss 决定主题类', !hijackApply);

    const hijackPicker = /var\s+activeTheme\s*=\s*bf\.customCss\s*\?/.test(src);
    check('B1-a3 主题选择器高亮态不再被 customCss 覆盖', !hijackPicker);

    // 探针白盒
    const probeSrc = src.replace(
        /global\.MiyaOfflineBeautify\s*=\s*\{/,
        'global.__probe = { normalizeBeautify: typeof normalizeBeautify === "function" ? normalizeBeautify : null };\n    global.MiyaOfflineBeautify = {'
    );
    if (!probeSrc.includes('global.__probe')) {
        check('B1-b1 normalizeBeautify 可探针注入', false, '锚点缺失');
        return;
    }
    const sb = makeSandbox();
    // 提供一个最小 store 桩
    sb.window.MiyaAppointmentStore = {
        _bf: { themeId: 'museum', customCss: '', wallpaperMode: 'none', wallpaperId: null, wallpaperUrl: '' },
        getBeautify() { return Object.assign({}, this._bf); },
        saveBeautify(v) { this._bf = Object.assign({}, v); return Promise.resolve(true); }
    };
    try {
        runIn(sb, probeSrc, 'off_bf_probe.js');
    } catch (e) {
        check('B1-b1 normalizeBeautify 可探针注入', false, e.message);
        return;
    }
    const nb = sb.window.__probe && sb.window.__probe.normalizeBeautify;
    check('B1-b1 normalizeBeautify 可探针注入', typeof nb === 'function');
    if (typeof nb !== 'function') return;

    // 核心：museum + 残留 CSS，主题必须还是 museum
    const r1 = nb({ themeId: 'museum', customCss: '.a{color:red}' });
    check('B1-b2 素纸主题 + 残留CSS → 主题仍是 museum（旧版被劫持为 custom）',
        r1 && r1.themeId === 'museum', JSON.stringify(r1 && r1.themeId));
    check('B1-b3 残留CSS 本身仍被保留（不丢用户数据）',
        r1 && r1.customCss === '.a{color:red}');

    const r2 = nb({ themeId: 'korean', customCss: '.a{color:red}' });
    check('B1-b4 手帐主题 + 残留CSS → 主题仍是 korean',
        r2 && r2.themeId === 'korean', JSON.stringify(r2 && r2.themeId));

    // custom 无 CSS 不再被强行降级（否则 UI 点不亮）
    const r3 = nb({ themeId: 'custom', customCss: '' });
    check('B1-b5 自定义主题无CSS 时不再强行降级为 museum（旧版降级）',
        r3 && r3.themeId === 'custom', JSON.stringify(r3 && r3.themeId));

    // 正常自定义仍生效
    const r4 = nb({ themeId: 'custom', customCss: '.a{color:red}' });
    check('B1-b6 自定义主题 + CSS 正常工作',
        r4 && r4.themeId === 'custom' && r4.customCss === '.a{color:red}');

    // 别名映射仍在
    const r5 = nb({ themeId: 'ins', customCss: '' });
    check('B1-b7 ins 别名仍映射为 korean', r5 && r5.themeId === 'korean');
    const r6 = nb({ themeId: 'gufeng', customCss: '' });
    check('B1-b8 gufeng 别名仍映射为 museum', r6 && r6.themeId === 'museum');

    // 非法主题回落
    const r7 = nb({ themeId: 'zzz', customCss: '' });
    check('B1-b9 非法主题回落 museum', r7 && r7.themeId === 'museum');

    // 应用层：主题类必须只由 themeId 决定
    const applyProbe = src.replace(
        /function\s+applyToAppEl\s*\(app,\s*bf\)\s*\{/,
        'global.__apply = applyToAppEl;\n  function applyToAppEl(app, bf) {'
    );
    const sb2 = makeSandbox();
    sb2.window.MiyaAppointmentStore = sb.window.MiyaAppointmentStore;
    if (applyProbe.includes('global.__apply')) {
        try {
            runIn(sb2, applyProbe, 'off_apply.js');
            const apply = sb2.window.__apply;
            const app = sb2.makeEl('div');
            if (typeof apply === 'function') {
                apply(app, { themeId: 'museum', customCss: '.a{color:red}' });
                const cls = Array.from(app.classList._s);
                check('B1-c1 应用层：museum+CSS → class 为 xw-theme-museum',
                    cls.indexOf('xw-theme-museum') >= 0 && cls.indexOf('xw-theme-custom') < 0,
                    JSON.stringify(cls));
                check('B1-c2 应用层：仍打上 xw-has-custom-css 标记',
                    cls.indexOf('xw-has-custom-css') >= 0, JSON.stringify(cls));
            } else {
                check('B1-c1 应用层可白盒验证', false, 'applyToAppEl 未导出');
            }
        } catch (e) {
            check('B1-c1 应用层可白盒验证', false, e.message);
        }
    } else {
        check('B1-c1 应用层可白盒验证', false, '锚点缺失');
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   B4：布局切换锁死 —— 核实为死代码，后端无 'fixed' 实现
   ═══════════════════════════════════════════════════════════════════════ */
function testB4() {
    const bfApp = read('js1/miya-beautify-app.js');
    const desk = read('js2/miya-desk-custom.js');

    // 1) 无条件覆盖那行必须已移除（只查真实代码，忽略注释里的叙述）
    const codeOnly = bfApp.split('\n').filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
    check('B4-a1 不再存在无条件 next = "custom" 覆盖',
        !/next\s*=\s*['"]custom['"]\s*;/.test(codeOnly));

    // 2) v29 曾在布局切换 handler 里补了「miyaSwitchDeskLayout 缺失」的兜底提示。
    //    v31（B14）进一步确认该 handler 全段为死代码（容器/按钮全仓无声明），已整段删除，
    //    故该兜底提示随之移除 —— 断言改为「确认整段已删除」，与 v31 结论一致。
    check('B4-a2 布局切换 handler 已整段删除（v31 由 B14 收口）',
        !/layoutPick\.addEventListener/.test(bfApp));

    // 3) 事实核查：布局切换 UI 容器在整个包内不存在 → 整段为死代码
    const allFiles = [];
    (function walk(dir) {
        fs.readdirSync(dir).forEach(f => {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else allFiles.push(p);
        });
    })(ROOT);
    let containerDecl = 0;
    let btnDecl = 0;
    allFiles.forEach(f => {
        if (!/\.(html|js|css)$/.test(f)) return;
        const t = fs.readFileSync(f, 'utf8');
        // 排除取值处本身：只看是否有「声明」
        if (/id\s*=\s*["']miya-bf-layout-pick["']/.test(t)) containerDecl += 1;
        if (/data-bf-layout\s*=\s*["']/.test(t) && !/getAttribute\(/.test(t)) btnDecl += 1;
    });
    check('B4-a3 布局选择容器 #miya-bf-layout-pick 未在任何 DOM 中声明（确认为死代码）',
        containerDecl === 0, '声明数=' + containerDecl);
    check('B4-a4 布局按钮 [data-bf-layout=...] 未在任何 DOM 中声明',
        btnDecl === 0, '声明数=' + btnDecl);

    // 4) 事实核查：后端 switchDeskLayout 忽略入参，硬编码 custom
    check('B4-a5 switchDeskLayout 确实忽略了 mode 入参（后端无 fixed 实现）',
        /function\s+switchDeskLayout\s*\(\s*mode\s*\)\s*\{\s*setLayoutMode\(\s*['"]custom['"]\s*\)/.test(desk));

    // 5) 已修复的那行移除后不应留下语法/引用问题：确认 miyaSwitchDeskLayout 仍被导出
    check('B4-a6 miyaSwitchDeskLayout 仍在后端导出（接口未被我改坏）',
        /global\.miyaSwitchDeskLayout\s*=\s*switchDeskLayout/.test(desk));
}

/* ═══════════════════════════════════════════════════════════════════════
   B5：文档导入 CSS 提取 —— 标题不再污染正文
   ═══════════════════════════════════════════════════════════════════════ */
function testB5() {
    const sb = makeSandbox();
    try {
        runIn(sb, read('js1/miya-beautify-doc-import.js'), 'doc-import.js');
    } catch (e) {
        check('B5-a1 模块可加载', false, e.message);
        return;
    }
    const api = sb.window.miyaBeautifyDocImport;
    check('B5-a1 模块可加载并导出 extractCssFromText',
        !!(api && typeof api.extractCssFromText === 'function'));
    if (!api || typeof api.extractCssFromText !== 'function') return;

    const ex = api.extractCssFromText;
    const CSS = '.qq-room{background:#fff}';
    const CSS2 = '.qq-bubble{padding:8px}';

    // ── 核心缺陷：标题同行/独行都必须被剥离 ──
    const c1 = ex('自定义 CSS：\n' + CSS + '\n' + CSS2);
    check('B5-b1 中文标题独占一行 → 标题被剥离（旧版残留「自定义 CSS：」）',
        c1.indexOf('自定义') < 0 && c1.indexOf(CSS) >= 0, JSON.stringify(c1));

    const c2 = ex('自定义CSS：' + CSS);
    check('B5-b2 标题与CSS同一行（冒号后直接接内容）→ 标题被剥离',
        c2.indexOf('自定义') < 0 && c2.indexOf(CSS) >= 0, JSON.stringify(c2));

    const c3 = ex('自定义CSS:\n\n' + CSS);
    check('B5-b3 标题后有空白行 → 标题被剥离（旧版因需单个\\n而失败）',
        c3.indexOf('自定义') < 0 && c3.indexOf(CSS) >= 0, JSON.stringify(c3));

    const c4 = ex('# 自定义 CSS\n' + CSS);
    check('B5-b4 markdown 标题 → 标题被剥离', c4.indexOf('自定义') < 0 && c4.indexOf(CSS) >= 0, JSON.stringify(c4));

    const c5 = ex('Custom CSS:\n' + CSS);
    check('B5-b5 英文标题 → 标题被剥离', c5.trim() === CSS, JSON.stringify(c5));

    const c6 = ex('样式表：\n' + CSS);
    check('B5-b6 「样式表」等同义标题也被识别', c6.indexOf('样式表') < 0 && c6.indexOf(CSS) >= 0, JSON.stringify(c6));

    // ── 回归保护：纯 CSS 不得被误伤 ──
    const p1 = ex(CSS + '\n' + CSS2);
    check('B5-c1 纯 CSS 原样返回（无误判）', p1 === CSS + '\n' + CSS2, JSON.stringify(p1));

    const p2 = ex(':root{--x:1}\n@media(max-width:600px){.a{color:red}}');
    check('B5-c2 @规则与变量不被误判为标题',
        p2.indexOf(':root') >= 0 && p2.indexOf('@media') >= 0, JSON.stringify(p2));

    const p3 = ex('/* 说明 */\n' + CSS);
    check('B5-c3 CSS 注释开头不被误剥离（数据保全）',
        p3.indexOf('/* 说明 */') >= 0, JSON.stringify(p3));

    const p4 = ex('.a,\n.b{color:red}');
    check('B5-c4 换行选择器列表不被误判为标题',
        p4.indexOf('.a,') >= 0 && p4.indexOf('.b{') >= 0, JSON.stringify(p4));

    const p5 = ex('   .a{color:red}\n   .b{color:blue}');
    check('B5-c5 缩进 CSS 不被当作标题吃掉', p5.indexOf('.a{color:red}') >= 0, JSON.stringify(p5));

    // ── 边界 ──
    const e1 = ex('   ');
    check('B5-d1 纯空白返回空串', e1 === '');

    const e2 = ex('前置说明\n\n```css\n' + CSS + '\n```\n\n尾注：仅支持 xw- 类名');
    check('B5-d2 代码围栏仍优先提取，且不夹带前后说明',
        e2 === CSS, JSON.stringify(e2));

    const e3 = ex('前言\n---\n' + CSS);
    check('B5-d3 分隔线分段仍取 CSS 段', e3 === CSS, JSON.stringify(e3));

    const e4 = ex('自定义 CSS：\n' + CSS + '\n\n选择器参考\n.qq-room 是容器');
    check('B5-d4 「选择器参考」章节被截断，不进正文',
        e4 === CSS, JSON.stringify(e4));

    // 旧版行为对照：这一段在旧版会返回带标题的整篇
    const oldBehavior = ex('自定义 CSS：\n' + CSS);
    check('B5-d5 标题残留问题已消除（旧版此处返回含标题的原文）',
        oldBehavior.indexOf('自定义') < 0, JSON.stringify(oldBehavior));
}

/* ═══════════════════════════════════════════════════════════════════════
   B6：预设落盘失败不再静默
   ═══════════════════════════════════════════════════════════════════════ */
function testB6() {
    const targets = [
        { rel: 'js1/miya-chat-beautify.js', anchor: 'global.MiyaChatBeautify = {', name: '聊天美化' },
        { rel: 'js1/miya-chat-app-beautify.js', anchor: 'global.MiyaChatAppBeautify = {', name: '聊天外观' }
    ];

    targets.forEach(function (t) {
        const src = read(t.rel);

        // 源码级：必须显式检查返回值
        check('B6-a[' + t.name + '] persistPresets 显式检查 ok === false',
            /ok\s*===\s*false/.test(src));
        check('B6-a[' + t.name + '] persistPresets 失败时回滚缓存',
            /presetsCache\s*=\s*prev/.test(src));
        check('B6-a[' + t.name + '] 失败时 reject 而非静默 resolve',
            /preset_persist_failed/.test(src));
        check('B6-a[' + t.name + '] UI 对落盘失败给出明确提示',
            /存储空间不足/.test(src));

        // 行为级：用「永远返回 false」的存储桩驱动
        const anchorStr = t.anchor;
        const probeSrc = src.replace(t.anchor,
            'global.__probe = { persistPresets: typeof persistPresets === "function" ? persistPresets : null };\n  ' + anchorStr);
        if (!probeSrc.includes('global.__probe')) {
            check('B6-b[' + t.name + '] persistPresets 可探针注入', false, '锚点缺失');
            return;
        }
        // 场景一：存储全挂（miyaWriteLsJsonKey resolve(false)）
        const sbFail = makeSandbox();
        sbFail.window.miyaWriteLsJsonKey = function () { return Promise.resolve(false); };
        // 场景二：存储正常（resolve(true)）
        const sbOk = makeSandbox();
        sbOk.window.miyaWriteLsJsonKey = function () { return Promise.resolve(true); };
        try {
            runIn(sbFail, probeSrc, 'bf_probe.js');
        } catch (e) {
            check('B6-b[' + t.name + '] persistPresets 可探针注入', false, e.message);
            return;
        }
        const pFail = sbFail.window.__probe;
        check('B6-b[' + t.name + '] persistPresets 可探针注入',
            !!(pFail && typeof pFail.persistPresets === 'function'));
        if (!pFail || typeof pFail.persistPresets !== 'function') return;

        const rFail = pFail.persistPresets([{ name: 'x' }]);
        check('B6-c[' + t.name + '] persistPresets 返回 Promise', rFail && typeof rFail.then === 'function');

        const sbOk2 = makeSandbox();
        sbOk2.window.miyaWriteLsJsonKey = function () { return Promise.resolve(true); };
        runIn(sbOk2, probeSrc, 'bf_probe2.js');
        const pOk = sbOk2.window.__probe;
        const rOk = pOk.persistPresets([{ name: 'x' }]);

        // 用 async 汇总两个 promise 的结局（同步推入 PENDING，保证被 await 到）
        PENDING.push(
            Promise.all([
                rFail.then(() => 'resolved', () => 'rejected'),
                rOk.then(() => 'resolved', () => 'rejected')
            ]).then(function (outcomes) {
                check('B6-d[' + t.name + '] 失败场景确实 reject', outcomes[0] === 'rejected', outcomes[0]);
                check('B6-e[' + t.name + '] 成功场景仍正常 resolve', outcomes[1] === 'resolved', outcomes[1]);
            }).catch(function (e) {
                check('B6-d[' + t.name + '] 异步断言执行', false, e.message);
            })
        );
    });
}

const PENDING = [];

/* ═══════════════════════════════════════════════════════════════════════ */
console.log('运行目录: ' + ROOT);
console.log('');
testB3();
testB1();
testB4();
testB5();
testB6();

Promise.all(PENDING).then(function () {
    console.log(results.join('\n'));
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}).catch(function () {
    console.log(results.join('\n'));
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
});
