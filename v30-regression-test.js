/**
 * v30 回归测试：B10 / B11 / B12 + 聊天侧 B1 残留
 * 对「包内真实文件」运行，每个用例都做「修复版通过 / 回退版必挂」的双向验证。
 *
 * 运行：node run-v30.js <包目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'v30');
const results = [];
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) { pass += 1; results.push('  ✅ ' + name); }
    else { fail += 1; results.push('  ❌ ' + name + (detail ? '  —— ' + detail : '')); }
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* ────────────────── 最小沙箱 ────────────────── */
function makeSandbox() {
    const store = new Map();
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
        addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html')
    };
    const localStorage = {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }
    };
    const window = {
        document, localStorage, innerWidth: 375, innerHeight: 667,
        addEventListener() {}, removeEventListener() {}, setTimeout() { return 0; }, clearTimeout() {},
        Promise, Date, Math, JSON, Object, Array, String, Number, RegExp, Error, isFinite, console
    };
    window.window = window;
    return { window, document, localStorage, makeEl };
}

function runIn(sb, code, filename) {
    const ctx = vm.createContext(sb.window);
    vm.runInContext(code, ctx, { filename: filename || 'x.js' });
    return sb.window;
}

/* ═══════════════════════════════════════════════════════════════════════
   B10-a：装饰项数值钳制
   ═══════════════════════════════════════════════════════════════════════ */
function testDecoClamp() {
    const src = read('js1/miya-chat-app-beautify.js');
    const probe = src.replace('global.MiyaChatAppBeautify = {',
        'global.__p = { normalizeDecoItem: normalizeDecoItem, DECO_LIMITS: typeof DECO_LIMITS !== "undefined" ? DECO_LIMITS : null };\n  global.MiyaChatAppBeautify = {');
    if (!probe.includes('global.__p')) { check('B10-a1 探针注入', false, '锚点缺失'); return; }
    const sb = makeSandbox();
    try { runIn(sb, probe, 'probe.js'); }
    catch (e) { check('B10-a1 探针注入', false, e.message); return; }
    const p = sb.window.__p;
    check('B10-a1 normalizeDecoItem 可探针注入', !!(p && typeof p.normalizeDecoItem === 'function'));
    if (!p || typeof p.normalizeDecoItem !== 'function') return;
    const n = p.normalizeDecoItem;

    // 核心：Infinity / 超大 / 负值
    // 注意：非有限数（Infinity/-Infinity/NaN）走 fallback，而非钳到边界 ——
    // 因为「无穷」本身无意义，回落到安全默认比钉在 4000 更合理。
    check('B10-b1 Infinity 被兜住为默认值（旧版原样输出 Infinity）',
        n({ x: Infinity }, 0).x === 0, String(n({ x: Infinity }, 0).x));
    check('B10-b2 -Infinity 被兜住为默认值', n({ x: -Infinity }, 0).x === 0, String(n({ x: -Infinity }, 0).x));
    check('B10-b3 1e30 被钳制（旧版输出 1e+30 生成非法 CSS）',
        n({ x: 1e30 }, 0).x === 4000, String(n({ x: 1e30 }, 0).x));
    check('B10-b4 -99999 被钳制', n({ x: -99999 }, 0).x === -4000, String(n({ x: -99999 }, 0).x));
    check('B10-b5 负尺寸归零（旧版保留 -50）', n({ h: -50 }, 0).h === 0, String(n({ h: -50 }, 0).h));
    check('B10-b6 超大尺寸被钳制', n({ w: 1e9 }, 0).w === 4000, String(n({ w: 1e9 }, 0).w));
    check('B10-b7 z 超大被钳制', n({ z: 999999 }, 0).z === 999, String(n({ z: 999999 }, 0).z));
    check('B10-b8 z 负数归零', n({ z: -5 }, 0).z === 0, String(n({ z: -5 }, 0).z));

    // opacity NaN 是旧版实打实的漏网
    check('B10-b9 opacity=NaN 被兜住（旧版 Math.min/max 对 NaN 无效，结果仍是 NaN）',
        n({ opacity: NaN }, 0).opacity === 1, String(n({ opacity: NaN }, 0).opacity));
    check('B10-b10 opacity 超界钳制', n({ opacity: 5 }, 0).opacity === 1, String(n({ opacity: 5 }, 0).opacity));

    // w=0 语义：用户明说 0，不该被 `|| 80` 改写
    check('B10-b11 w=0 被尊重（旧版 `||80` 改写成 80）',
        n({ w: 0 }, 0).w === 0, String(n({ w: 0 }, 0).w));
    check('B10-b12 未提供 w 时回退默认 80', n({}, 0).w === 80, String(n({}, 0).w));

    // 字符串数值仍正常解析（不能误伤合法输入）
    check('B10-b13 合法字符串数值仍解析', n({ x: '120', w: '64' }, 0).x === 120 && n({ w: '64' }, 0).w === 64);
    check('B10-b14 非数字字符串回落默认', n({ x: 'abc' }, 0).x === 0, String(n({ x: 'abc' }, 0).x));

    // page 白名单不受影响（回归）
    check('B10-b15 合法 page 保留', n({ page: 'feed' }, 0).page === 'feed');
    check('B10-b16 非法 page 回落 all', n({ page: '黑客' }, 0).page === 'all');

    // 样式拼接不得出现非法值
    const vals = [n({ x: Infinity, y: 1e30, w: -1, h: NaN, z: Infinity, opacity: NaN }, 0)]
        .map(it => 'left:' + it.x + 'px;top:' + it.y + 'px;width:' + it.w + 'px;height:' + it.h + 'px;z-index:' + it.z + ';opacity:' + it.opacity);
    check('B10-b17 拼接后的 style 不含 Infinity/NaN/exponential',
        vals.every(s => !/Infinity|NaN|e\+/i.test(s)), vals[0]);
}

/* ═══════════════════════════════════════════════════════════════════════
   B10-b：图片 URL 白名单
   ═══════════════════════════════════════════════════════════════════════ */
function testUrlWhitelist() {
    const src = read('js1/miya-chat-store.js');
    const probe = src.replace('var store = {',
        'global.__sanitize = sanitizeImageUrl;\n    var store = {');
    if (!probe.includes('global.__sanitize')) { check('B10-c1 探针注入', false, '锚点缺失'); return; }
    const sb = makeSandbox();
    try { runIn(sb, probe, 'store_probe.js'); }
    catch (e) { check('B10-c1 探针注入', false, e.message); return; }
    const f = sb.window.__sanitize;
    check('B10-c1 sanitizeImageUrl 可探针注入', typeof f === 'function');
    if (typeof f !== 'function') return;

    // 合法：必须全部放行（零误伤是硬要求）
    check('B10-c2 https 放行', f('https://a.com/b.jpg') !== '');
    check('B10-c3 http 放行', f('http://a.com/b.jpg') !== '');
    check('B10-c4 blob 放行（IDB 壁纸依赖它）', f('blob:https://x.com/abc-123') !== '');
    check('B10-c5 data base64 png 放行', f('data:image/png;base64,iVBORw0KGgo=') !== '');
    check('B10-c6 data base64 jpeg 放行', f('data:image/jpeg;base64,/9j/4AAQ') !== '');
    check('B10-c7 站内相对路径放行', f('img/bg.jpg') !== '');

    // 危险：必须全部拒绝
    check('B10-c8 javascript: 被拒', f('javascript:alert(1)') === '');
    check('B10-c9 data:image/svg+xml 被拒（可内联脚本）', f('data:image/svg+xml,<svg onload=alert(1)>') === '');
    check('B10-c10 data:text/html 被拒', f('data:text/html,<script>x</script>') === '');
    check('B10-c11 file: 被拒', f('file:///etc/passwd') === '');
    check('B10-c12 控制字符被拒', f('https://a.com/b\u0000.jpg') === '');
    check('B10-c13 超长 URL 被拒', f('https://a.com/' + 'x'.repeat(3000)) === '');
    check('B10-c14 空串返回空', f('') === '');
    check('B10-c15 非 base64 的 data:image 被拒', f('data:image/png,notbase64') === '');

    // 接线检查：壁纸字段确实走了校验
    check('B10-c16 normalizeChatBeautify 的 wallpaperUrl 走 sanitizeImageUrl',
        /wallpaperUrl:\s*sanitizeImageUrl\(raw\.wallpaperUrl\)/.test(src));
    check('B10-c17 store 对外导出 sanitizeImageUrl', /sanitizeImageUrl:\s*sanitizeImageUrl/.test(src));

    // 装饰图 URL 也接上（走 store）
    const appSrc = read('js1/miya-chat-app-beautify.js');
    check('B10-c18 装饰图 URL 走 safeDecoUrl', /url:\s*safeDecoUrl\(raw\.url\)/.test(appSrc));
    check('B10-c19 safeDecoUrl 优先复用 store 的白名单', /st\.sanitizeImageUrl/.test(appSrc));
}

/* ═══════════════════════════════════════════════════════════════════════
   B1 残留：聊天侧 themeId 劫持
   ═══════════════════════════════════════════════════════════════════════ */
function testChatB1Residual() {
    const storeSrc = read('js1/miya-chat-store.js');
    const bfSrc = read('js1/miya-chat-beautify.js');

    const stripComments = s => s.split('\n').filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');

    // 三处劫持点必须全部消失
    check('B1R-a1 store.normalizeChatBeautify 不再用 customCss 决定 themeId',
        !/themeId:\s*raw\.customCss\s*\?/.test(stripComments(storeSrc)));
    check('B1R-a2 chat-beautify.normalizeBeautify 不再用 customCss 决定 themeId',
        !/themeId:\s*raw\.customCss\s*\?/.test(stripComments(bfSrc)));
    check('B1R-a3 chat-beautify.applyToRoomEl 不再用 customCss 决定主题类',
        !/themeClassFor\(bf\.customCss\s*\?/.test(stripComments(bfSrc)));

    // 行为级：store 的 normalizeChatBeautify
    const storeProbe = storeSrc.replace('var store = {',
        'global.__p = { normalizeChatBeautify: normalizeChatBeautify, CHAT_THEME_IDS: CHAT_THEME_IDS };\n    var store = {');
    const sb = makeSandbox();
    sb.window.localStorage = sb.localStorage;
    try { runIn(sb, storeProbe, 'store_p.js'); }
    catch (e) { check('B1R-b1 store 探针注入', false, e.message); return; }
    const p = sb.window.__p;
    check('B1R-b1 store 探针注入', !!(p && typeof p.normalizeChatBeautify === 'function'));
    if (!p || typeof p.normalizeChatBeautify !== 'function') return;

    const cb = p.normalizeChatBeautify;
    const r1 = cb({ themeId: 'gallery', customCss: '.x{color:red}' });
    check('B1R-b2 gallery + 残留CSS → 主题仍是 gallery（旧版被劫持为 custom）',
        r1 && r1.themeId === 'gallery', JSON.stringify(r1 && r1.themeId));
    check('B1R-b3 CSS 本身保留不丢', r1 && r1.customCss === '.x{color:red}');

    const r2 = cb({ themeId: 'noir', customCss: '.x{}' });
    check('B1R-b4 noir + 残留CSS → 主题仍是 noir',
        r2 && r2.themeId === 'noir', JSON.stringify(r2 && r2.themeId));

    const r3 = cb({ themeId: 'ins', customCss: '' });
    check('B1R-b5 ins 无CSS 正常保留', r3 && r3.themeId === 'ins');

    const r4 = cb({ themeId: '非法', customCss: '' });
    check('B1R-b6 非法主题仍回落默认', r4 && p.CHAT_THEME_IDS.indexOf(r4.themeId) >= 0, JSON.stringify(r4 && r4.themeId));

    // 行为级：chat-beautify.normalizeBeautify
    const bfProbe = bfSrc.replace('global.MiyaChatBeautify = {',
        'global.__q = { normalizeBeautify: normalizeBeautify };\n  global.MiyaChatBeautify = {');
    const sb2 = makeSandbox();
    try { runIn(sb2, bfProbe, 'bf_p.js'); }
    catch (e) { check('B1R-c1 beautify 探针注入', false, e.message); return; }
    const q = sb2.window.__q;
    check('B1R-c1 beautify 探针注入', !!(q && typeof q.normalizeBeautify === 'function'));
    if (!q || typeof q.normalizeBeautify !== 'function') return;
    const nb = q.normalizeBeautify;
    const c1 = nb({ themeId: 'blossom', customCss: '.y{}' });
    check('B1R-c2 blossom + 残留CSS → 主题仍是 blossom',
        c1 && c1.themeId === 'blossom', JSON.stringify(c1 && c1.themeId));
    const c2 = nb({ themeId: 'custom', customCss: '' });
    check('B1R-c3 custom 无CSS 不再被降级', c2 && c2.themeId === 'custom', JSON.stringify(c2 && c2.themeId));
}

/* ═══════════════════════════════════════════════════════════════════════
   B11/B12：savedAt 有限性
   ═══════════════════════════════════════════════════════════════════════ */
function testSavedAt() {
    const targets = [
        { rel: 'js1/miya-chat-beautify.js', anchor: 'global.MiyaChatBeautify = {', varName: '__r1' },
        { rel: 'js1/miya-chat-app-beautify.js', anchor: 'global.MiyaChatAppBeautify = {', varName: '__r2' },
        { rel: 'js2/miya-offline-beautify.js', anchor: 'global.MiyaOfflineBeautify = {', varName: '__r3' }
    ];
    targets.forEach(t => {
        const src = read(t.rel);
        let probe;
        if (t.rel.includes('offline')) {
            probe = src.replace(t.anchor, 'global.' + t.varName + ' = { normalizePresetRow: typeof normalizePresetRow === "function" ? normalizePresetRow : null };\n  ' + t.anchor);
        } else {
            probe = src.replace(t.anchor, 'global.' + t.varName + ' = { normalizePresetRow: typeof normalizePresetRow === "function" ? normalizePresetRow : null };\n  ' + t.anchor);
        }
        if (!probe.includes('global.' + t.varName)) {
            check('B11-a[' + t.rel + '] 探针注入', false, '锚点缺失');
            return;
        }
        const sb = makeSandbox();
        try { runIn(sb, probe, 'sa.js'); }
        catch (e) { check('B11-a[' + t.rel + '] 探针注入', false, e.message); return; }
        const f = sb.window[t.varName] && sb.window[t.varName].normalizePresetRow;
        check('B11-a[' + t.rel + '] normalizePresetRow 可探针注入', typeof f === 'function');
        if (typeof f !== 'function') return;

        const okRow = f({ name: 'A', savedAt: 111 });
        check('B11-b[' + t.rel + '] 合法 savedAt 保留', okRow && okRow.savedAt === 111, JSON.stringify(okRow && okRow.savedAt));

        const infRow = f({ name: 'A', savedAt: Infinity });
        check('B11-c[' + t.rel + '] savedAt=Infinity 被兜住（旧版原样保留 Infinity）',
            infRow && isFinite(infRow.savedAt), JSON.stringify(infRow && infRow.savedAt));

        const nanRow = f({ name: 'A', savedAt: 'abc' });
        check('B11-d[' + t.rel + '] savedAt=NaN 回落当前时间',
            nanRow && isFinite(nanRow.savedAt) && nanRow.savedAt > 0, JSON.stringify(nanRow && nanRow.savedAt));
    });
}

/* ═══════════════════════════════════════════════════════════════════════ */
console.log('运行目录: ' + ROOT);
console.log('');
try { testDecoClamp(); } catch (e) { check('testDecoClamp 执行', false, e.message); }
try { testUrlWhitelist(); } catch (e) { check('testUrlWhitelist 执行', false, e.message); }
try { testChatB1Residual(); } catch (e) { check('testChatB1Residual 执行', false, e.message); }
try { testSavedAt(); } catch (e) { check('testSavedAt 执行', false, e.message); }

console.log(results.join('\n'));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
