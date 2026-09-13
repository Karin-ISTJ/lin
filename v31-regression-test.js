/**
 * v31 回归测试：B7 / B8 / B9 / B13 / B14
 * 针对「死数据 / 空壳 class / 僵尸资源 / 跨标签页同步 / 恒真死分支」五类清理。
 *
 * 每个用例都做「修复版通过 / 回退版必挂」的双向验证：
 *   - 正向：断言清理后的现状（例如 wallpaper 字段已不存在）
 *   - 反向：断言旧形态的痕迹已消失（例如 mq-theme-atelier 全仓零命中）
 *
 * 运行：node v31-regression-test.js [包目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 包目录解析顺序（先命中先用）：
     1) 命令行参数            node v31-regression-test.js /path/to/pkg
     2) 环境变量 PKG_ROOT     PKG_ROOT=/path/to/pkg node v31-regression-test.js
     3) ../v31（本仓默认布局）
     4) __dirname（套件被放进包内时）
   最后兜底会打印解析结果，避免「路径猜错 → 静默 7 连挂」这种难排查的假失败。 */
function resolveRoot() {
    if (process.argv[2]) return path.resolve(process.argv[2]);
    if (process.env.PKG_ROOT) return path.resolve(process.env.PKG_ROOT);
    const candidates = [
        path.join(__dirname, '..', 'v31'),
        __dirname
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'index.html'))) return c;
    }
    return candidates[0];
}
const ROOT = resolveRoot();
const results = [];
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) { pass += 1; results.push('  ✅ ' + name); }
    else { fail += 1; results.push('  ❌ ' + name + (detail ? '  —— ' + detail : '')); }
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/* 剥离注释后的源码 —— 用于「某标识符是否仍被真实引用」类断言。
   本次清理会在原位置留下说明性注释（含被删标识符的名字），
   若直接对全文做 grep 会把注释也算成「残留」，造成假阳性。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释（避开 http:// 之类）
}

/* 我们自己的测试文件不应参与「全仓零命中」类扫描 */
function isTestFile(rel) {
    return /regression-test\.js$/.test(rel);
}

/* 递归收集包内所有文件（相对路径） */
function allFiles() {
    const out = [];
    (function walk(dir) {
        fs.readdirSync(dir).forEach(f => {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else out.push(path.relative(ROOT, p));
        });
    })(ROOT);
    return out;
}

/* 在整包范围内搜索某个模式，返回命中文件列表（默认跳过测试文件、剥离注释） */
function grepAll(re, exts, opts) {
    opts = opts || {};
    const hits = [];
    allFiles().forEach(rel => {
        if (!opts.keepTestFile && isTestFile(rel)) return;
        if (exts && !exts.some(e => rel.endsWith(e))) return;
        let text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        if (!opts.withComments) text = stripComments(text);
        if (re.test(text)) hits.push(rel);
    });
    return hits;
}

/* 统计某标识符在「真实代码」（非注释）中出现的次数 */
function codeCount(rel, name) {
    const stripped = stripComments(read(rel));
    return (stripped.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

/* ────────────────── 最小沙箱 ────────────────── */
function makeSandbox() {
    const store = new Map();
    const listeners = {};
    function makeEl(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(), children: [], style: {},
            classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
                contains(c) { return this._s.has(c); } },
            _attrs: {}, hidden: false, innerHTML: '', textContent: '', value: '',
            setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
            removeAttribute(k) { delete this._attrs[k]; }, hasAttribute(k) { return k in this._attrs; },
            appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, remove() {},
            addEventListener(t, fn) { (this._ev || (this._ev = {}))[t] = fn; },
            querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }, click() {}
        };
        return el;
    }
    const document = {
        createElement(tag) { return makeEl(tag); },
        getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html'),
        readyState: 'complete'
    };
    const localStorage = {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }
    };
    const window = {
        document, localStorage, innerWidth: 375, innerHeight: 667,
        addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
        removeEventListener() {}, setTimeout() { return 0; }, clearTimeout() {},
        Promise, Date, Math, JSON, Object, Array, String, Number, RegExp, Error, isFinite, console
    };
    window.window = window;
    return { window, document, localStorage, makeEl, listeners };
}

function runIn(sb, code, filename) {
    const ctx = vm.createContext(sb.window);
    vm.runInContext(code, ctx, { filename: filename || 'x.js' });
    return sb.window;
}

/* ═══════════════════════════════════════════════════════════════════════
   B7：线下壁纸死字段已移除
   ═══════════════════════════════════════════════════════════════════════ */
function testB7() {
    const store = read('js1/miya-appointment-store.js');
    const offline = read('js2/miya-offline-beautify.js');

    // 反向：三个字段名不应再出现在默认值与归一化的「真实代码」里（注释提及不计）
    ['wallpaperMode', 'wallpaperId', 'wallpaperUrl'].forEach(k => {
        const n1 = codeCount('js1/miya-appointment-store.js', k);
        const n2 = codeCount('js2/miya-offline-beautify.js', k);
        check('B7-a1[' + k + '] appointment-store 零代码引用', n1 === 0, '命中 ' + n1);
        check('B7-a2[' + k + '] offline-beautify 零代码引用', n2 === 0, '命中 ' + n2);
    });

    // 正向：normalizeBeautify 输出只剩 themeId + customCss
    const sb = makeSandbox();
    sb.window.miyaAppointmentStore = {
        getBeautify() { return { themeId: 'museum', customCss: '' }; }
    };
    let ok = true, err = '';
    try { runIn(sb, offline, 'offline.js'); } catch (e) { ok = false; err = e.message; }
    check('B7-b1 offline-beautify 模块可加载', ok, err);
    if (!ok) return;

    const api = sb.window.MiyaOfflineBeautify;
    const norm = api && api.normalizeBeautify;
    check('B7-b2 normalizeBeautify 已导出', typeof norm === 'function');
    if (typeof norm !== 'function') return;

    const out = norm({ themeId: 'korean', customCss: 'a{}', wallpaperMode: 'url', wallpaperId: 'x', wallpaperUrl: 'http://y' });
    check('B7-c1 输出不含 wallpaperMode', !('wallpaperMode' in out), JSON.stringify(Object.keys(out)));
    check('B7-c2 输出不含 wallpaperId', !('wallpaperId' in out));
    check('B7-c3 输出不含 wallpaperUrl', !('wallpaperUrl' in out));
    check('B7-c4 themeId / customCss 正常保留', out.themeId === 'korean' && out.customCss === 'a{}',
        JSON.stringify({ t: out.themeId, c: out.customCss }));
}

/* ═══════════════════════════════════════════════════════════════════════
   B8：mq-theme-atelier 空壳 class 已去除
   ═══════════════════════════════════════════════════════════════════════ */
function testB8() {
    // 反向：真实代码里不应再有 mq-theme-atelier（注释中说明性提及不计）
    const hits = grepAll(/mq-theme-atelier/);
    check('B8-a1 mq-theme-atelier 代码中零命中', hits.length === 0, hits.join(', '));

    // 正向：THEME_MAP.custom 映射为空串
    const src = read('js1/miya-chat-beautify.js');
    check('B8-a2 THEME_MAP.custom 映射为空串',
        /custom\s*:\s*''/.test(src), '未找到 custom: \'\'');

    // 正向：themeClassFor 对 custom 返回空、对未知 id 回落 gallery
    const sb = makeSandbox();
    const probe = src.replace("  function allThemeClasses() {",
        "  global.__probe = { themeClassFor: themeClassFor, allThemeClasses: allThemeClasses };\n  function allThemeClasses() {");
    check('B8-a3 探针注入成功', probe.includes('global.__probe'));
    let ok = true, err = '';
    try { runIn(sb, probe, 'chat-bf.js'); } catch (e) { ok = false; err = e.message; }
    check('B8-a4 模块可加载', ok, err);
    if (!ok) return;

    const p = sb.window.__probe;
    check('B8-b1 themeClassFor("custom") 返回空串', p.themeClassFor('custom') === '',
        JSON.stringify(p.themeClassFor('custom')));
    check('B8-b2 themeClassFor("gallery") 返回 porcelain', p.themeClassFor('gallery') === 'mq-theme-porcelain');
    check('B8-b3 themeClassFor("noir") 返回 noir', p.themeClassFor('noir') === 'mq-theme-noir');
    check('B8-b4 themeClassFor(未知 id) 回落 gallery', p.themeClassFor('不存在') === 'mq-theme-porcelain');

    // 正向：allThemeClasses 不含空串（否则 classList.remove('') 会抛错）
    const list = p.allThemeClasses();
    check('B8-b5 allThemeClasses 过滤掉空串', list.every(c => c && c.length), JSON.stringify(list));

    // 正向：存在空值安全的应用辅助函数
    check('B8-a5 存在 applyThemeClass 空值防护', /function applyThemeClass\(/.test(src));
    check('B8-a6 applyThemeClass 对空串不调用 add', /if\s*\(cls\)\s*el\.classList\.add\(cls\)/.test(src));
}

/* ═══════════════════════════════════════════════════════════════════════
   B9：僵尸主题 CSS 文件清理
   ───────────────────────────────────────────────────────────────────────
   重要更正（v31 复核实锤）：原报告的三步方案（删文件 + 删 18 处 class + 删兜底规则）
   会引入回归 —— 这批元素并非纯装饰：
     · `data-mine-action="settings"` 是「设置」的唯一入口，JS(miya-chat-app.js:1634) 真绑定
     · `data-qq-avatar-home` 是「返回主屏」的唯一入口，JS(:1531) 真绑定
     · `fg-greeting-name` / `fg-friends-count` 被 JS(:1332,:1339) 真实写入
   它们处于「功能活着、视觉隐藏」状态，靠 miya-chat-app-beautify.css 的兜底规则压住。
   因此正确做法是【只删两个从未加载的 CSS 文件】，保留 class 与兜底规则。
   ═══════════════════════════════════════════════════════════════════════ */
function testB9() {
    // 正向：两个僵尸 CSS 文件已删除（它们从未被 index.html / sw.js / JS 加载）
    check('B9-a1 fresh-green CSS 文件已删除', !exists('css/miya-chat-app-theme-fresh-green.css'));
    check('B9-a2 ins-white CSS 文件已删除', !exists('css/miya-chat-app-theme-ins-white.css'));

    // 反向：这两个文件确实从未被加载（删除才是安全的）
    const html = read('index.html');
    const sw = read('sw.js');
    check('B9-a3 index.html 从未引用过两个主题',
        !/fresh-green|ins-white/.test(html));
    check('B9-a4 sw.js 预缓存表从未引用过两个主题',
        !/fresh-green|ins-white/.test(sw));
    const dynHits = grepAll(/fresh-green|ins-white/, ['.js']);
    check('B9-a5 JS 未动态注入这两个主题', dynHits.length === 0, dynHits.join(', '));

    // 正向：兜底隐藏规则必须保留（否则裸元素会露出来）
    const bfCss = read('css/miya-chat-app-beautify.css');
    check('B9-a6 兜底隐藏规则保留（.ins-chrome,.fg-chrome{display:none}）',
        /\.ins-chrome\s*,?\s*\.fg-chrome\s*\{\s*display\s*:\s*none\s*!important/.test(bfCss));

    // 正向：18 处 class 必须保留（它们是兜底规则的挂钩）
    const fg = (html.match(/fg-chrome/g) || []).length;
    const ins = (html.match(/ins-chrome/g) || []).length;
    check('B9-a7 index.html 保留 fg-chrome class（挂钩兜底规则）', fg >= 9, '当前 ' + fg);
    check('B9-a8 index.html 保留 ins-chrome class（挂钩兜底规则）', ins >= 3, '当前 ' + ins);

    // 反向：关键功能入口仍在 DOM 中（删了就是打断功能）
    check('B9-a9 「设置」入口 data-mine-action="settings" 仍在',
        /data-mine-action="settings"/.test(html));
    check('B9-a10 「返回主屏」入口 data-qq-avatar-home 仍在',
        /data-qq-avatar-home/.test(html));

    // 正向：JS 侧确实在使用这些元素（印证「不能删元素」的结论）
    const chatApp = read('js1/miya-chat-app.js');
    check('B9-a11 JS 仍绑定 data-mine-action=settings',
        /data-mine-action="settings"/.test(chatApp));
    check('B9-a12 JS 仍绑定 data-qq-avatar-home',
        /data-qq-avatar-home/.test(chatApp));
    check('B9-a13 JS 仍写入 fg-greeting-name / fg-friends-count',
        /fg-greeting-name/.test(chatApp) && /fg-friends-count/.test(chatApp));
}

/* ═══════════════════════════════════════════════════════════════════════
   B13：跨标签页 storage 同步
   ═══════════════════════════════════════════════════════════════════════ */
function testB13() {
    // 正向：两个模块均补上了 storage 监听
    const theme = read('js2/miya-theme.js');
    const cab = read('js1/miya-chat-app-beautify.js');

    check('B13-a1 miya-theme.js 监听 storage 事件',
        /addEventListener\(\s*['"]storage['"]/.test(theme));
    check('B13-a2 miya-chat-app-beautify.js 监听 storage 事件',
        /addEventListener\(\s*['"]storage['"]/.test(cab));

    // 正向：监听器正确按自己的 key 过滤
    check('B13-a3 theme 监听器按 META_KEY 过滤',
        /ev\.key\s*!==\s*META_KEY/.test(theme));
    check('B13-a4 chat-app-beautify 监听器按 STORAGE_KEY 过滤',
        /ev\.key\s*!==\s*STORAGE_KEY/.test(cab));

    // 正向：空值防护（newValue == null 时直接返回）
    check('B13-a5 theme 监听器有 newValue 空值防护', /ev\.newValue\s*==\s*null/.test(theme));
    check('B13-a6 chat-app-beautify 监听器有 newValue 空值防护', /ev\.newValue\s*==\s*null/.test(cab));

    // 正向：theme 侧有内容比较，避免无谓重绘
    check('B13-a7 theme 监听器做内容比较去重',
        /JSON\.stringify\(current\)\s*===\s*JSON\.stringify\(incoming\)/.test(theme));

    // 正向：chat-app-beautify 复用带 score 比较的 hydrate（不会用旧覆盖新）
    check('B13-a8 chat-app-beautify 复用 hydrateAppBeautifyFromIdb',
        /addEventListener\(\s*['"]storage['"][\s\S]{0,200}hydrateAppBeautifyFromIdb\(\)/.test(cab));

    // 运行时：触发 storage 事件，确认监听器被注册且可执行不抛错
    const sb = makeSandbox();
    let ok = true, err = '';
    try { runIn(sb, cab, 'cab.js'); } catch (e) { ok = false; err = e.message; }
    check('B13-b1 chat-app-beautify 模块可加载', ok, err);
    if (!ok) return;

    const fns = sb.listeners['storage'] || [];
    check('B13-b2 storage 监听器已实际注册', fns.length >= 1, '数量=' + fns.length);
    if (!fns.length) return;

    let threw = null;
    try {
        fns.forEach(fn => {
            fn({ key: 'other-key', newValue: '1' });        // 非本模块 key，应忽略
            fn({ key: cab.match(/STORAGE_KEY\s*=\s*'([^']+)'/)[1], newValue: null }); // 空值，应忽略
            fn({ key: cab.match(/STORAGE_KEY\s*=\s*'([^']+)'/)[1], newValue: '{"themeId":"default-orange"}' });
        });
    } catch (e) { threw = e.message; }
    check('B13-b3 监听器对各类事件不抛异常', threw === null, threw || '');

    // 反向：旧版没有这段监听（即本断言能区分修复前后）
    const hasLegacyShape = /addEventListener\(\s*['"]storage['"][\s\S]{0,100}STORAGE_KEY[\s\S]{0,100}hydrateAppBeautifyFromIdb/.test(cab);
    check('B13-b4 监听器结构符合新增修复形态', hasLegacyShape);
}

/* ═══════════════════════════════════════════════════════════════════════
   B14：布局恒真死分支清理
   ═══════════════════════════════════════════════════════════════════════ */
function testB14() {
    const app = read('js1/miya-beautify-app.js');
    const theme = read('js2/miya-theme.js');
    const desk = read('js2/miya-desk-custom.js');

    // 反向：miya-beautify-app.js 真实代码里不再有 isCustomLayoutMode() 调用（注释说明不计）
    const calls = codeCount('js1/miya-beautify-app.js', 'isCustomLayoutMode()');
    check('B14-a1 miya-beautify-app.js 无 isCustomLayoutMode() 调用', calls === 0, '残留 ' + calls);

    // 反向：函数定义本身已删除
    check('B14-a2 isCustomLayoutMode 函数定义已删除',
        !/function\s+isCustomLayoutMode\s*\(/.test(app));

    // 反向：布局切换 handler 整段已删除
    check('B14-a3 布局切换 handler 已删除', !/layoutPick\.addEventListener/.test(app));
    check('B14-a4 不再查询 #miya-bf-layout-pick', !/\$\(\s*['"]miya-bf-layout-pick['"]\s*\)/.test(app));

    // 反向：miya-theme.js 真实代码里不再有恒真的 miyaGetDeskLayoutMode 判断（注释不计）
    const tCalls = codeCount('js2/miya-theme.js', 'miyaGetDeskLayoutMode');
    check('B14-a5 miya-theme.js 无 miyaGetDeskLayoutMode 判断', tCalls === 0, '残留 ' + tCalls);

    // 正向：后端确实恒为 custom（这是折叠的依据，必须仍然成立）
    check('B14-b1 后端 getLayoutMode 仍硬编码 custom',
        /function\s+getLayoutMode\s*\(\s*\)\s*\{[\s\S]{0,200}return\s+['"]custom['"]/.test(desk));
    check('B14-b2 后端 setLayoutMode 仍硬编码 custom',
        /function\s+setLayoutMode\s*\(\s*mode\s*\)\s*\{\s*var\s+next\s*=\s*['"]custom['"]/.test(desk));
    check('B14-b3 switchDeskLayout 仍忽略入参',
        /function\s+switchDeskLayout\s*\(\s*mode\s*\)\s*\{\s*setLayoutMode\(\s*['"]custom['"]\s*\)/.test(desk));

    // 正向：syncLayoutModeUi 已折叠为确定文案（无三元分支）
    check('B14-b4 syncLayoutModeUi 文案已折叠为确定值',
        /hint\.textContent\s*=\s*'自定义布局/.test(app));
    // 反向：真实代码里不再存在 `mode === 'custom' ? A : B` 这类恒真三元（注释提及不计）
    const appNoCmt = stripComments(app);
    check('B14-b5 不再存在 mode === "custom" ? A : B 三元',
        !/mode\s*===\s*['"]custom['"]\s*\?/.test(appNoCmt));

    // 运行时：模块可加载
    const sb = makeSandbox();
    let ok = true, err = '';
    try { runIn(sb, app, 'bf-app.js'); } catch (e) { ok = false; err = e.message; }
    check('B14-b6 miya-beautify-app.js 折叠后可正常加载', ok, err);

    // 运行时：theme 模块可加载
    const sb2 = makeSandbox();
    let ok2 = true, err2 = '';
    try { runIn(sb2, theme, 'theme.js'); } catch (e) { ok2 = false; err2 = e.message; }
    check('B14-b7 miya-theme.js 折叠后可正常加载', ok2, err2);

    // ── 桌面侧：miya-desk-custom.js 的恒真判据（v31 补漏，原只扫了两个文件）──
    // 该文件 getLayoutMode() 恒返回 'custom'，曾散落 16 处恒真/恒假判断。
    const deskCode = stripComments(desk);
    const eqTrue = (deskCode.match(/getLayoutMode\(\)\s*===\s*['"]custom['"]/g) || []).length;
    const neTrue = (deskCode.match(/getLayoutMode\(\)\s*!==\s*['"]custom['"]/g) || []).length;
    check('B14-c1 miya-desk-custom.js 无 === "custom" 恒真判断', eqTrue === 0, '残留 ' + eqTrue);
    check('B14-c2 miya-desk-custom.js 无 !== "custom" 恒假判断', neTrue === 0, '残留 ' + neTrue);

    // 反向：后端 getLayoutMode 仍然恒值（这是折叠的正当性依据）
    check('B14-c3 getLayoutMode 仍恒返回 custom（折叠依据仍成立）',
        /function\s+getLayoutMode\s*\(\s*\)\s*\{[\s\S]{0,300}return\s+['"]custom['"]/.test(desk));

    // 反向：桌面侧确实存在被恒值影响的旧形态（注释中应有折叠说明留痕）
    check('B14-c4 折叠处留有说明注释',
        /getLayoutMode\(\)[^\n]*恒/.test(desk));

    // 语言级验证：desk 折叠后语法/加载均正常
    const sb3 = makeSandbox();
    let ok3 = true, err3 = '';
    try { runIn(sb3, desk, 'desk.js'); } catch (e) { ok3 = false; err3 = e.message; }
    check('B14-c5 miya-desk-custom.js 折叠后可正常加载', ok3, err3);
}

/* ═══════════════════════════════════════════════════════════════════════
   TOOL：恒值判据静态检查器自检
   —— 确认 tools/check-constant-predicates.py 在当前代码上无发现
   ═══════════════════════════════════════════════════════════════════════ */
function testConstPredicateTool() {
    const tool = path.join(ROOT, 'tools', 'check-constant-predicates.py');
    check('TOOL-1 检查器脚本存在', fs.existsSync(tool));
    if (!fs.existsSync(tool)) return;

    const { execFileSync } = require('child_process');
    let out = '', code = 0;
    try {
        out = execFileSync('python3', [tool, ROOT], { encoding: 'utf8' });
    } catch (e) {
        code = e.status;
        out = (e.stdout || '') + (e.stderr || '');
    }
    check('TOOL-2 检查器退出码为 0（无恒真判据）', code === 0, '退出码=' + code);
    check('TOOL-3 检查器报告无发现',
        /未发现/.test(out), out.split('\n').slice(-6).join(' / '));
}

/* ═══════════════════════════════════════════════════════════════════════
   全量语法检查
   ═══════════════════════════════════════════════════════════════════════ */
function testSyntax() {
    const targets = allFiles().filter(f => /\.js$/.test(f) && !/regression-test\.js$/.test(f));
    let bad = [];
    targets.forEach(rel => {
        try { new vm.Script(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel }); }
        catch (e) { bad.push(rel + ': ' + e.message); }
    });
    check('SYN-1 全部 JS（' + targets.length + ' 个）语法通过', bad.length === 0, bad.join(' | '));
}

/* ═══════════════════════════════════════════════════════════════════════ */
console.log('运行目录: ' + ROOT);
console.log('');
try { testB7(); } catch (e) { check('testB7 执行', false, e.message); }
try { testB8(); } catch (e) { check('testB8 执行', false, e.message); }
try { testB9(); } catch (e) { check('testB9 执行', false, e.message); }
try { testB13(); } catch (e) { check('testB13 执行', false, e.message); }
try { testB14(); } catch (e) { check('testB14 执行', false, e.message); }
try { testConstPredicateTool(); } catch (e) { check('testConstPredicateTool 执行', false, e.message); }
try { testSyntax(); } catch (e) { check('testSyntax 执行', false, e.message); }

console.log(results.join('\n'));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
