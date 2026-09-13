/**
 * v33 回归测试：白屏 / 全屏点不动 缺陷修复
 *
 * 缺陷现象
 * --------
 * 开屏动画结束后进入纯白页面（只有状态栏和底部系统导航栏），
 * 屏幕任何位置都无法点击，桌面图标、程序坞全部不可见。
 *
 * 根因
 * ----
 * B14 重构把「固定布局」能力整体移除时，`js2/miya-theme.js` 的 miyaApplyTheme()
 * 里删掉了 `var isCustom = miyaGetDeskLayoutMode() === 'custom'` 这行声明，
 * 但下方两处 `if (!isCustom) { ... }` 判断被漏改。
 * 于是每次调用都抛 `ReferenceError: isCustom is not defined`。
 *
 * 调用链：app.js runPhoneBoot()
 *           → miyaHydrateTheme()
 *             → miyaApplyTheme()      ← 在这里抛错
 *               → .then(初始化自定义桌面)  ← 永远不执行
 * 结果 desk-custom-track 永远拿不到子节点 → 白屏 + 无命中目标。
 *
 * 副作用：bootcover 的兜底 setTimeout(1800ms) 会照常撤掉开屏遮罩，
 * 所以用户看到的是「开屏动画正常播完，然后一片纯白」，而不是卡在开屏。
 *
 * 用例设计
 * --------
 * D1  源码级：miyaApplyTheme 中不得再出现未声明的 isCustom
 * D2  行为级：装载真实 miya-theme.js，调用 miyaApplyTheme 不得抛错
 * D3  行为级：参数带入 wallpaper 时，旧主题壁纸分支必须已移除（恒假分支折叠）
 * D4  资源级：index.html 引用的每一条本地 css/js 都必须真实存在
 * D5  回归级：其余布局相关导出未被误删
 *
 * 运行：node v33-regression-test.js [包目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function resolveRoot() {
    if (process.argv[2]) return path.resolve(process.argv[2]);
    if (process.env.PKG_ROOT) return path.resolve(process.env.PKG_ROOT);
    const candidates = [path.join(__dirname, '..', 'v33'), __dirname];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'index.html'))) return c;
    }
    return candidates[0];
}
const ROOT = resolveRoot();

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✅ ' + name); }
    else { fail += 1; console.log('  ❌ ' + name + (detail ? '  —— ' + detail : '')); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

const THEME = 'js2/miya-theme.js';
const LOCKCSS = 'css/miya-lockscreen.css';

/* 把注释与字符串替换成空白，避免「注释里提到 isCustom」造成假阳性 */
function blankCommentsAndStrings(src) {
    let out = '', i = 0, n = src.length, state = null;
    while (i < n) {
        const c = src[i], nx = src[i + 1] || '';
        if (state === null) {
            if (c === '/' && nx === '/') { state = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && nx === '*') { state = 'block'; out += '  '; i += 2; continue; }
            if (c === "'") { state = 'sq'; out += ' '; i += 1; continue; }
            if (c === '"') { state = 'dq'; out += ' '; i += 1; continue; }
            if (c === '`') { state = 'tpl'; out += ' '; i += 1; continue; }
            out += c; i += 1; continue;
        }
        if (state === 'line') { if (c === '\n') { state = null; out += '\n'; } else out += ' '; i += 1; continue; }
        if (state === 'block') { if (c === '*' && nx === '/') { state = null; out += '  '; i += 2; continue; } out += (c === '\n' ? '\n' : ' '); i += 1; continue; }
        if (state === 'sq' || state === 'dq') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { state = null; out += ' '; i += 1; continue; }
            out += (c === '\n' ? '\n' : ' '); i += 1; continue;
        }
        if (state === 'tpl') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (c === '`') { state = null; out += ' '; i += 1; continue; }
            out += (c === '\n' ? '\n' : ' '); i += 1; continue;
        }
    }
    return out;
}

/* ── D1 源码级 ─────────────────────────────────────────────────────── */
console.log('\n【D1】miyaApplyTheme 不再引用未声明的 isCustom');
{
    const raw = read(THEME);
    const src = blankCommentsAndStrings(raw);
    // 先确认函数确实存在（global.xxx = function 或 window.xxx = function）
    check('D1-a miyaApplyTheme 已定义',
        /(?:global|window|globalThis)\.miyaApplyTheme\s*=\s*function/.test(raw));
    // 去掉注释/字符串后不得再出现裸标识符 isCustom
    const hits = [...src.matchAll(/(?<![\w$.])isCustom(?![\w$])/g)];
    check('D1-b 去除注释与字符串后无 isCustom 残留', hits.length === 0,
        hits.length ? `仍有 ${hits.length} 处：${hits.slice(0, 3).map(m => 'offset ' + m.index).join(', ')}` : '');
    // 反向确认：声明也没了（不是"补了个 var"而是"删了用法"）
    check('D1-c 未通过补 var isCustom 来掩盖', !/(?:var|let|const)\s+isCustom\b/.test(src));
}

/* ── D2/D3 行为级：装载真实源码 ────────────────────────────────────── */
function makeThemeSandbox() {
    const noop = () => {};
    const fakeEl = {
        style: Object.assign({}, {
            setProperty: noop, removeProperty: noop, getPropertyValue: () => '',
        }),
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        hasAttribute: () => false,
        appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop,
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: noop, removeEventListener: noop,
        innerHTML: '', textContent: '', hidden: false, dataset: {}, children: [],
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
        getContext: () => null, focus: noop, blur: noop, click: noop,
    };
    // style 需要能像对象一样读写 CSS 自定义属性
    fakeEl.style = new Proxy({ setProperty: noop, removeProperty: noop, getPropertyValue: () => '' }, {
        get(t, k) { return k in t ? t[k] : ''; },
        set(t, k, v) { t[k] = v; return true; },
    });
    const doc = {
        readyState: 'complete',
        documentElement: fakeEl,
        body: fakeEl,
        head: fakeEl,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => fakeEl,
        addEventListener: noop, removeEventListener: noop,
        createTextNode: () => ({}),
        documentElement2: null,
    };
    const sb = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
        document: doc,
        navigator: { userAgent: 'node' },
        location: { href: 'http://localhost/', search: '', hash: '' },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
        requestAnimationFrame: (fn) => fn(), cancelAnimationFrame: noop,
        Image: function () { return Object.assign({}, fakeEl); },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
        Blob: function () {}, FileReader: function () {},
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
        addEventListener: noop, removeEventListener: noop,
        CustomEvent: function () {}, MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
        indexedDB: null,
    };
    sb.window = sb; sb.global = sb; sb.self = sb;
    return sb;
}

console.log('\n【D2】miyaApplyTheme 真实调用不抛 ReferenceError');
{
    const sb = makeThemeSandbox();
    vm.createContext(sb);
    let loadErr = null;
    try {
        new vm.Script(read(THEME), { filename: THEME }).runInContext(sb);
    } catch (e) { loadErr = e; }
    check('D2-a miya-theme.js 可在沙箱中装载', !loadErr, loadErr && loadErr.message);

    if (!loadErr) {
        check('D2-b miyaApplyTheme 已导出', typeof sb.miyaApplyTheme === 'function');
        let callErr = null, result = null;
        try {
            result = sb.miyaApplyTheme({
                wallpaper: null, icons: {}, polaroids: {}, memoAvas: {},
                profileBg: null, playerBg: null, playerCover: null, weekcalBg: null,
                p2Tiles: {}, p2Widgets: {}, p3Tiles: {}, p3Widgets: {}, p4Tiles: {}, p4Widgets: {},
            });
        } catch (e) { callErr = e; }
        check('D2-c 调用不抛异常', !callErr, callErr && (callErr.name + ': ' + callErr.message));
        check('D2-d 返回 Promise（then 链可继续）',
            result && typeof result.then === 'function',
            result === null ? '返回 null/undefined' : typeof result);

        // 关键：错误绝不能是 isCustom 相关的 ReferenceError
        const isIsCustomBug = callErr && /isCustom is not defined/.test(String(callErr.message));
        check('D2-e 未复现 isCustom ReferenceError', !isIsCustomBug);
    } else {
        check('D2-b~e 跳过（装载失败）', false);
    }
}

/* ── D3 折叠完整性 ────────────────────────────────────────────────── */
console.log('\n【D3】恒假分支已折叠，但布局相关能力未被误删');
{
    const src = blankCommentsAndStrings(read(THEME));
    check('D3-a 已移除 !isCustom 旧主题壁纸分支', !/!\s*isCustom/.test(src));
    // 被折叠的分支原本调用的两个函数体应保留（注释声明「函数体保留」）
    const raw = read(THEME);
    check('D3-b applyWallToPhone 定义仍保留', /function\s+applyWallToPhone\s*\(/.test(raw));
    // 主链路导出不得被误删
    for (const fn of ['miyaApplyTheme', 'miyaHydrateTheme', 'miyaGetTheme', 'miyaSetTheme']) {
        check(`D3-c ${fn} 仍导出`, raw.includes('global.' + fn + ' ='));
    }
}

/* ── D4 资源完整性：引用即存在 ────────────────────────────────────── */
console.log('\n【D4】index.html 引用的本地资源全部存在');
{
    const html = read('index.html');
    const refs = new Set();
    for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
        const u = m[1];
        if (/^(https?:|data:|blob:|#|mailto:)/.test(u)) continue;
        refs.add(u.split('?')[0].replace(/^\.\//, ''));
    }
    /* miya-auth/* 是「登录包」：index.html 注释明写
       「仅部署版上传 miya-auth/ 时生效；开源版无此文件夹则跳过登录」，
       开源版缺失属预期，不计入缺失。 */
    const OPTIONAL = /^miya-auth\//;
    const missing = [...refs].filter(p => p && !OPTIONAL.test(p) && !exists(p));
    check('D4-a 无缺失的本地 css/js/img 引用', missing.length === 0,
        missing.length ? '缺失 ' + missing.length + ' 个：' + missing.slice(0, 8).join(', ') : '');
    // 锁屏样式表必须存在（v32 包中曾整体缺失）
    check('D4-b css/miya-lockscreen.css 存在', exists(LOCKCSS));
    if (exists(LOCKCSS)) {
        const lockCss = read(LOCKCSS);
        // JS 依赖的状态类必须在样式表里有对应规则
        for (const [cls, why] of [
            ['.miya-lockscreen', '根层定位'],
            ['.is-show', '放行态'],
            ['.is-clock', '时钟阶段'],
            ['.is-passcode', '密码阶段'],
            ['.is-shake', '错误抖动'],
            ['.is-dragging', '上滑手势'],
            ['.has-wallpaper', '自定义壁纸'],
            ['miya-lock-active', '全局锁定标记'],
        ]) {
            check(`D4-c 锁屏样式含 ${cls}（${why}）`, lockCss.includes(cls));
        }
        // 未放行必须彻底退出命中测试
        check('D4-d 未放行时 display:none（不吃触摸）',
            /\.miya-lockscreen:not\(\.is-show\)[\s\S]{0,120}display:\s*none/.test(lockCss));
        check('D4-e [hidden] 时隐藏',
            /\.miya-lockscreen\[hidden\][\s\S]{0,80}display:\s*none/.test(lockCss));
    }
}

/* ── D5 启动链路健壮性 ────────────────────────────────────────────── */
console.log('\n【D5】启动链路兜底');
{
    const app = read('js1/app.js');
    check('D5-a finishPhoneBoot 有兜底定时器', /setTimeout\(finishPhoneBoot,\s*\d+\)/.test(app));
    check('D5-b miyaHydrateTheme 失败时仍会 releaseCoverNow（catch 分支）',
        /miyaHydrateTheme\(\)[\s\S]{0,400}?\.catch\([\s\S]{0,300}?releaseCoverNow\(\)/.test(app));
    check('D5-c 桌面挂载轮询 releaseWhenDeskMounted 仍在',
        /function\s+releaseWhenDeskMounted/.test(app));
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
