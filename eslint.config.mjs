/**
 * ESLint 配置 —— 专治「跑起来才崩」的未定义引用
 *
 * ── 为什么要有它 ──
 *
 * 这个项目历史上出过一批**纯 ReferenceError** 的故障，全都属于
 * 「打开某个页面/点到某个按钮才崩」，静态检查一眼就能抓出来：
 *
 *   · `trim is not defined`        —— 一个潜伏很久的笔误
 *   · `invalidateApiPresetsCache()` —— 全文件未定义
 *   · `storageContextCache` 等      —— 引用从未声明的变量
 *
 * 这类问题不需要跑测试，`no-undef` 就够了。所以本配置的**唯一目标**
 * 就是：把「引用了不存在的标识符」全部揪出来，其余规则一律不开 ——
 * 免得一堆风格告警把真问题淹了。
 *
 * ── 为什么 globals 要写这么长 ──
 *
 * 这些**不是**代码问题，是浏览器/Node 的内置全局。不登记就会误报，
 * 而误报一多，人就不看告警了 —— 那这个工具就废了。
 * 所以「宁可错放，不可错杀」：确认是标准的就登记进来。
 *
 * ── 用法 ──
 *
 *   npx eslint js1 js2          # 查全部自研代码
 *   npx eslint js1/xxx.js       # 查单个文件
 *   npm run lint                # 同上（见 package.json）
 *
 * 第三方库（jszip 等）已在下方 ignores 排除，不要往里加自己的代码。
 */

/** 浏览器 + 少量 Node 的内置全局。只登记**确认标准**的，不猜。 */
const BROWSER_GLOBALS = {
    // ── 全局对象 / 命名空间 ──
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    location: 'readonly',
    history: 'readonly',
    screen: 'readonly',
    console: 'readonly',
    self: 'readonly',
    globalThis: 'readonly',
    top: 'readonly',
    parent: 'readonly',
    frames: 'readonly',
    performance: 'readonly',
    crypto: 'readonly',
    caches: 'readonly',
    indexedDB: 'readonly',
    localStorage: 'readonly',
    sessionStorage: 'readonly',
    module: 'readonly', // CJS 检测残留，Node 侧写法

    // ── 定时器 ──
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    requestIdleCallback: 'readonly',
    cancelIdleCallback: 'readonly',
    queueMicrotask: 'readonly',

    // ── 交互 ──
    alert: 'readonly',
    confirm: 'readonly',
    prompt: 'readonly',

    // ── IIFE 包装约定 ──
    //
    // 全项目统一 `(function (global) { ... })(window)` 写法，
    // 形参名就叫 global。有些文件内部又直接引用了它，
    // 属于既定约定，登记为只读。
    global: 'readonly',

    // ── 网络 / 数据 ──
    fetch: 'readonly',
    XMLHttpRequest: 'readonly',
    WebSocket: 'readonly',
    FormData: 'readonly',
    Headers: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    atob: 'readonly',
    btoa: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    DecompressionStream: 'readonly',
    CompressionStream: 'readonly',
    structuredClone: 'readonly',

    // ── 二进制 / 文件 ──
    Blob: 'readonly',
    File: 'readonly',
    FileReader: 'readonly',
    ArrayBuffer: 'readonly',
    SharedArrayBuffer: 'readonly',
    Uint8Array: 'readonly',
    Uint16Array: 'readonly',
    Uint32Array: 'readonly',
    Int8Array: 'readonly',
    Int16Array: 'readonly',
    Int32Array: 'readonly',
    Float32Array: 'readonly',
    Float64Array: 'readonly',
    DataView: 'readonly',
    createImageBitmap: 'readonly',

    // ── 媒体 ──
    Audio: 'readonly',
    AudioContext: 'readonly',
    webkitAudioContext: 'readonly',
    MediaRecorder: 'readonly',
    Image: 'readonly',
    ImageBitmap: 'readonly',
    FontFace: 'readonly',
    Worker: 'readonly',

    // ── DOM / 解析 ──
    DOMParser: 'readonly',
    XMLSerializer: 'readonly',
    Node: 'readonly',
    Element: 'readonly',
    HTMLElement: 'readonly',
    HTMLCanvasElement: 'readonly',
    HTMLInputElement: 'readonly',
    Event: 'readonly',
    CustomEvent: 'readonly',
    MouseEvent: 'readonly',
    KeyboardEvent: 'readonly',
    MutationObserver: 'readonly',
    IntersectionObserver: 'readonly',
    ResizeObserver: 'readonly',
    IDBKeyRange: 'readonly',

    // ── 样式 / 布局 ──
    getComputedStyle: 'readonly',
    matchMedia: 'readonly',
    CSS: 'readonly',

    // ── 通知 ──
    Notification: 'readonly',

    // ── 视口尺寸（裸引用写法）──
    innerWidth: 'readonly',
    innerHeight: 'readonly',
    scrollX: 'readonly',
    scrollY: 'readonly',
    devicePixelRatio: 'readonly',

    // ── 遗留 jQuery（项目仍在用）──
    jQuery: 'readonly',
    $: 'readonly',

    // ── 本项目自研全局：必须显式登记 ──
    //
    // ⚠️ 这里**故意留空**。
    //
    // 本项目跨模块调用统一走 `global.MiyaXxx` / `window.MiyaXxx` 运行时查找，
    // 不依赖裸变量。所以任何**裸引用**的自研全局（如直接写 `MiyaMemoryTableApp`）
    // 都属于「要么漏了 global. 前缀、要么拼错了」——正是我们想抓的东西，
    // 不应该登记进来把它掩盖掉。
    //
    // 若确有个别模块必须裸引用，单独在下方 overrides 里按文件登记。
};

export default [
    // ════════════════════════════════════════════════════════════════
    // 1. 全局忽略：第三方库、产物、依赖
    // ════════════════════════════════════════════════════════════════
    {
        ignores: [
            'node_modules/**',
            '**/*.min.js',
            'js1/jszip.min.js',
            'js1/app.js', // 构建产物
            '.testruns/**',
            'test/**', // 测试脚本是 Python，若有 JS 也先不查
        ],
    },

    // ════════════════════════════════════════════════════════════════
    // 2. 自研代码：只开 no-undef
    // ════════════════════════════════════════════════════════════════
    {
        files: ['js1/**/*.js', 'js2/**/*.js', 'tools/**/*.js', 'sw.js'],
        languageOptions: {
            ecmaVersion: 2022,
            // 全部是 IIFE 包装的传统脚本，不是 ESM
            sourceType: 'script',
            globals: BROWSER_GLOBALS,
        },
        rules: {
            // ★ 本配置存在的唯一理由
            'no-undef': 'error',

            // 重复声明：**关掉**。
            //
            // 实测存量 19 处，逐条看过，全部是「同一函数内多个互斥分支各自声明
            // 同名 var」（如 miya-chat-group.js 的 members/sid/c/name 分属不同
            // 返回分支）。这是本项目既定风格，行为完全无害。
            //
            // 留 warn 的唯一后果是：每次 lint 都刷 19 行黄字，
            // 久而久之没人看 —— 那 1 条真 error 就被淹了。
            // 宁可不要这条规则，也要保住信噪比。
            'no-redeclare': 'off',
        },
    },

    // ════════════════════════════════════════════════════════════════
    // 3. Service Worker（sw.js）：环境与页面不同，单独给 globals
    // ════════════════════════════════════════════════════════════════
    {
        files: ['sw.js'],
        languageOptions: {
            globals: {
                self: 'readonly',
                caches: 'readonly',
                clients: 'readonly',
                skipWaiting: 'readonly',
                importScripts: 'readonly',
                registration: 'readonly',
            },
        },
    },

    // ════════════════════════════════════════════════════════════════
    // 4. Node 侧工具（tools/*.js）：补 Node globals
    // ════════════════════════════════════════════════════════════════
    {
        files: ['tools/**/*.js'],
        languageOptions: {
            globals: {
                require: 'readonly',
                module: 'writable',
                exports: 'writable',
                __dirname: 'readonly',
                __filename: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                console: 'readonly',
                global: 'readonly',
                // Node 的 crypto 与浏览器同名，这里显式声明后，
                // `const { crypto } = require('crypto')` 才不算重复声明
                crypto: 'writable',
            },
        },
        rules: {
            // tools 里局部遮蔽内置全局是正常写法，关掉避免噪音
            'no-redeclare': 'off',
        },
    },
];
