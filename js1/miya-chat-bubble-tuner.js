/**
 * Miya 气泡参数调试器 · 参数 ⇄ CSS 文本的双向编译
 *
 * 定位：给「聊天设置 → 外观与背景 → 聊天样式」加一层可视化调参。
 * 拖滑块 → 实时预览 → 点「应用」把参数编译成 CSS 写进既有的自定义 CSS
 * 输入框，之后走原有链路（顶栏「保存」落库、预设库存读）。
 *
 * ── 三条硬约束（改动前务必先读）────────────────────────────
 *
 * ① 本模块**不做作用域互转**。编译产物一律以 `#qq-room` 为作用域，
 *    「作用到预览」交给 MiyaChatBeautify.hydrateCssPreview，
 *    它内部走 scopeCssForPreview 把 #qq-room 换成 #mq-bf-preview-room。
 *    预览与真实因此共用同一份文本、同一套 specificity 关系 —— 所见即所得。
 *    自建一套替换逻辑必然与 beautify 的实现漂移，不要这么做。
 *
 * ② 编译产物**不加 !important**。预览侧的默认气泡样式挂在
 *    `.mi-bf-preview-stage [data-mq-bf-css-preview]:not(.mq-has-custom-css)` 下，
 *    而 hydrateCssPreview 会给预览房间加上 .mq-has-custom-css，
 *    那批 :not() 规则整体失效，预览回落到 css/miya-chat.css 的裸
 *    `.qq-room__row--me .qq-room__bubble`。本模块输出的
 *    `#qq-room .qq-room__row--me .qq-room__bubble` 权重更高，稳赢。
 *    更关键的是：一旦加了 !important，用户手写的 CSS 就再也盖不住它，
 *    等于往输入框里塞了一段「霸占层」。
 *
 * ③ 编译产物的注释是固定的，且**不得包含 mq-wechat-skin 这个词** ——
 *    hydrateCssPreview 会用 `css.indexOf('mq-wechat-skin') >= 0` 来给预览房间
 *    toggle 'mq-foot-wechat' 类，注释里带上会误触发底栏皮肤。
 */
(function (global) {
  'use strict';

  /* 编译产物首行的固定标记。两处用途：
     ① 让用户一眼看出这段 CSS 是调试器生成的；
     ② 「应用」时判断是否要弹覆盖确认 —— 同源迭代直接静默覆盖。 */
  var GEN_MARK = '/* ===== Miya 气泡调试器 · 由面板生成 ===== */';

  /* ── 参数模型 ──────────────────────────────────────────────
     字段名取短驼峰，因为要直接写进 data-mq-bt="字段名" 属性，
     短名让 HTML 更小、grep 更容易。顺序即面板里的呈现顺序。 */
  var DEFAULTS = {
    /* 颜色组 */
    meBg: '#efefef',        /* 我方气泡背景 */
    meFg: '#262626',        /* 我方文字色 */
    themBg: '#f4f4f4',      /* 对方气泡背景 */
    themFg: '#262626',      /* 对方文字色 */
    borderColor: '',        /* 描边色，空 = 用 rgba(0,0,0,0.06) 与 base 同源 */
    chatBg: '',             /* 聊天背景色，空 = 不输出该段 */

    /* 形状组 */
    radius: 14,             /* 圆角 px */
    borderW: 1,             /* 描边粗细 px，0 = border:none */
    padX: 12,               /* 内边距左右 */
    padY: 8,                /* 内边距上下 */
    maxW: 72,               /* 行最大宽度 % */
    lineH: 1.48,            /* 行高 */

    /* 角标组 */
    badgeUrl: '',           /* 图案地址，空 = 不输出角标段 */
    badgeSize: 18,
    badgeTop: -4,
    badgeLeft: -4,
    badgeMirror: false      /* 是否水平镜像 */
  };

  /* 各字段的取值范围与步长。面板渲染与反解夹取共用这一份，避免两处不同步。 */
  var SPEC = {
    radius:    { min: 0,   max: 28,  step: 1,    unit: 'px' },
    borderW:   { min: 0,   max: 4,   step: 0.5,  unit: 'px' },
    padX:      { min: 2,   max: 32,  step: 1,    unit: 'px' },
    padY:      { min: 2,   max: 32,  step: 1,    unit: 'px' },
    maxW:      { min: 40,  max: 100, step: 1,    unit: '%'  },
    lineH:     { min: 1,   max: 2.4, step: 0.02, unit: ''   },
    badgeSize: { min: 8,   max: 40,  step: 1,    unit: 'px' },
    badgeTop:  { min: -20, max: 20,  step: 1,    unit: 'px' },
    badgeLeft: { min: -20, max: 20,  step: 1,    unit: 'px' }
  };

  var COLOR_ITEMS = [
    { key: 'meBg',        label: '我方背景' },
    { key: 'meFg',        label: '我方文字' },
    { key: 'themBg',      label: '对方背景' },
    { key: 'themFg',      label: '对方文字' },
    { key: 'borderColor', label: '描边颜色' },
    { key: 'chatBg',      label: '聊天背景' }
  ];

  var SLIDER_ITEMS = [
    { key: 'radius',    label: '圆角' },
    { key: 'borderW',   label: '描边粗细' },
    { key: 'padX',      label: '内边距·左右' },
    { key: 'padY',      label: '内边距·上下' },
    { key: 'maxW',      label: '气泡最大宽度' },
    { key: 'lineH',     label: '行高' }
  ];

  var BADGE_SLIDERS = [
    { key: 'badgeSize', label: '图案尺寸' },
    { key: 'badgeTop',  label: '上偏移' },
    { key: 'badgeLeft', label: '左偏移' }
  ];

  /* 反解统计用的总项数：颜色 6 + 形状 6 + 角标 5（含 URL 与镜像 2 个非滑块项） */
  var TOTAL_ITEMS = COLOR_ITEMS.length + SLIDER_ITEMS.length + BADGE_SLIDERS.length + 2;

  /* ── 内置色盘 ──────────────────────────────────────────────
   *
   * 色值来源：用户提供的色卡图（948×1265 JPEG），逐块取**中心 6px 方形区域
   * 的逐通道中位数**。取中心是刻意的 —— 色块边缘带一层内阴影，取边缘会把
   * 阴影混进来；取中位数而非均值，则单个噪点不会带偏结果。色块内部是纯平
   * 色（横切验证过，同一个值连续跨 70+ 像素），所以 JPEG 压缩对结果无影响。
   *
   * 每组按「浅 → 深」排好，shades[0] 最浅、shades[shades.length-1] 最深。
   * 一键套用时按位置分配：最浅做聊天背景、次浅做对方气泡、最深做我方气泡 ——
   * 这样双方气泡都能从背景上跳出来。文字色不写死，由 pickFg 按对比度算。
   *
   * 命名说明：「草木」「暖沙」两组在原图里没有名称标签（标题行被裁切），
   * 这两个名字是后起的，仅作展示用。
   */
  var PALETTES = [
    { id: 'sakura',   name: '早樱',     tag: '#f6a9bd',
      shades: ['#f7dbc5', '#f0bcc8', '#f5bfcc', '#efb9d3', '#f8b0be', '#f6a9bd', '#f3a9a8', '#e692a9'] },
    { id: 'skyblue',  name: '水天色',   tag: '#1d78ad',
      shades: ['#d5ecf2', '#c4fffd', '#96c8e1', '#88c8d2', '#6a97b4', '#29a6c4', '#1d78ad', '#1675b5'] },
    { id: 'snow',     name: '眠雪',     tag: '#8595a2',
      shades: ['#d5dedd', '#d6dde5', '#d6d5da', '#c5cdd8', '#acb5b4', '#8595a2', '#74818a', '#9fabbb'] },
    { id: 'honey',    name: '蜂蜜蛋糕', tag: '#fcbb19',
      shades: ['#fffec6', '#fef2dc', '#fee4a7', '#ffd366', '#f8ca2c', '#fcbb19', '#e1b167', '#dca838'] },
    { id: 'herb',     name: '草木',     tag: '#748b79',
      shades: ['#d3eada', '#cfe7cf', '#c7e9ce', '#addfd3', '#6f8b7c', '#748b79', '#70878d', '#526b68'] },
    { id: 'sand',     name: '暖沙',     tag: '#b2a696',
      shades: ['#ffffff', '#f7f2ef', '#efe5db', '#e5ddd2', '#f0e3da', '#eed4c3', '#dbd1c8', '#b2a696'] }
  ];

  /* 内嵌取色盘的常用色（黑白灰 + 六个纯色），排在内置色盘之前。
     原生 <input type=color> 的默认色板就是这批，保留下来便于手调中性色。 */
  var BASIC_COLORS = [
    '#000000', '#444444', '#888888', '#bbbbbb', '#e6e6e6', '#ffffff',
    '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'
  ];

  /* ── 小工具 ─────────────────────────────────────────────── */

  function fmtNum(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    /* 去掉浮点尾巴：1.4800000000000002 → 1.48 */
    return String(Math.round(n * 1000) / 1000);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 颜色字段的合法性：只认 #rgb / #rrggbb。
     面板外的输入（手改 CSS）可能带 rgb()/var()，那些不给回填到取色器。 */
  function isHex(v) {
    return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());
  }

  /* ── 颜色计算 ─────────────────────────────────────────────
     全部走 sRGB 相对亮度（WCAG 定义），不做 gamma 之外的近似 ——
     这套算法的目的只有一个：决定配深字还是浅字，以及挑代表色。 */

  function hexToRgb(h) {
    var s = String(h || '').trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    function p(n) {
      var v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return v.length === 1 ? '0' + v : v;
    }
    return '#' + p(r) + p(g) + p(b);
  }

  /* WCAG 相对亮度。人眼对绿最敏感、蓝最迟钝，系数即由此而来。 */
  function luminance(h) {
    var c = hexToRgb(h);
    if (!c) return 1;
    function ch(v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /* 给一个背景色挑可读的文字色。
     候选不止纯黑纯白 —— 用背景自身压暗/提亮出的「同色系深/浅」往往更柔和，
     跟整体色调更协调。三个候选里选对比度最高的。 */
  function pickFg(bg) {
    var c = hexToRgb(bg);
    if (!c) return '#262626';
    var cands = [
      rgbToHex(c.r * 0.22, c.g * 0.22, c.b * 0.22),   /* 同色系压暗 */
      '#ffffff',
      '#1f1f1f'
    ];
    var best = cands[0], bestRatio = -1;
    cands.forEach(function (cc) {
      var r = contrast(bg, cc);
      if (r > bestRatio) { bestRatio = r; best = cc; }
    });
    return best;
  }

  /* 挑「代表色」：一组里饱和度最高的那个，用于色盘胶囊上的小圆点。
     饱和度用 max-min（HSV 口径），比 HSL 的 S 更直观。 */
  function mostVivid(shades) {
    var best = shades[0], bestSat = -1;
    (shades || []).forEach(function (h) {
      var c = hexToRgb(h);
      if (!c) return;
      var mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
      var sat = mx === 0 ? 0 : (mx - mn) / mx;
      /* 亮度太低的不用（近黑没有色相可言），太高的也排除 */
      var lum = luminance(h);
      var score = sat * (lum > 0.08 && lum < 0.92 ? 1 : 0.35);
      if (score > bestSat) { bestSat = score; best = h; }
    });
    return best;
  }

  /* 一套色盘 → 六个颜色参数。
     位置的选法：shades 已按浅→深排序，但「最深」往往是近黑/酒红那类，
     拿来做气泡会显脏。所以取「亮度落在甜区、且饱和度高」的那个做我方气泡。 */
  function paletteToParams(pal) {
    var sh = (pal && pal.shades) || [];
    if (!sh.length) return null;

    var sorted = sh.slice().sort(function (a, b) { return luminance(a) - luminance(b); });
    var lightest = sorted[0];
    var darkest = sorted[sorted.length - 1];

    /* 我方气泡：在「不太亮也不太暗」的区间里挑最鲜艳的 */
    var mid = sh.filter(function (h) {
      var l = luminance(h);
      return l > 0.12 && l < 0.72;
    });
    if (!mid.length) mid = sh;
    var meBg = mostVivid(mid);
    var meLum = luminance(meBg);

    /* 对方气泡：取亮度明显高于我方的候选里较鲜艳的，气泡层次才拉得开。
       没有更亮的就退回最浅那个。 */
    var lighter = sh.filter(function (h) {
      var l = luminance(h);
      return l > meLum + 0.06 && l < 0.93;
    });
    var themBg = lighter.length ? mostVivid(lighter) : lightest;
    var themLum = luminance(themBg);

    /* 聊天背景：要当底衬，必须比**两个气泡都亮**，且跟较浅那个气泡留出
       可感知的差距（对比 ≥ 1.08，约等于 8% 亮度差）。
       只挑「比气泡亮」的候选，一个都没有时才退回白色 ——
       绝不能像早期实现那样取最深的色当背景，那会让深色气泡糊在深底上。 */
    var brighter = sh.filter(function (h) {
      return luminance(h) > themLum + 0.02;
    });
    var chatBg = '';
    var minLum = Math.max(meLum, themLum);
    brighter.forEach(function (h) {
      if (luminance(h) <= minLum) return;
      if (contrast(h, themBg) < 1.08) return;
      /* 满足条件的里取最浅的：留给气泡最大的对比余量 */
      if (!chatBg || luminance(h) > luminance(chatBg)) chatBg = h;
    });
    if (!chatBg) chatBg = '#ffffff';

    /* 描边：我方气泡压暗一点，让它有轮廓但不抢戏 */
    var mc = hexToRgb(meBg);
    var borderColor = rgbToHex(mc.r * 0.82, mc.g * 0.82, mc.b * 0.82);

    return {
      meBg: meBg,
      meFg: pickFg(meBg),
      themBg: themBg,
      themFg: pickFg(themBg),
      borderColor: borderColor,
      chatBg: chatBg
    };
  }

  /* 夹取到 SPEC 范围；非数字则退回默认值 */
  function clampNum(key, v, fallback) {
    var n = parseFloat(v);
    if (!isFinite(n)) return fallback;
    var sp = SPEC[key];
    if (!sp) return n;
    if (n < sp.min) n = sp.min;
    if (n > sp.max) n = sp.max;
    /* 按 step 对齐，避免出现 1.4999999 这种值 */
    n = Math.round(n / sp.step) * sp.step;
    return Math.round(n * 1000) / 1000;
  }

  /* 把任意输入规整成一份完整、合法的参数对象。
     用途：读面板、反解、外部传入都先过这里，保证 compileCss 拿到的东西干净。 */
  function normalizeParams(raw) {
    var out = {};
    var r = raw && typeof raw === 'object' ? raw : {};

    COLOR_ITEMS.forEach(function (it) {
      var v = String(r[it.key] == null ? '' : r[it.key]).trim();
      if (v === '') out[it.key] = '';            /* 空串是有意义的：表示「不输出」 */
      else if (isHex(v)) out[it.key] = v.toLowerCase();
      else out[it.key] = DEFAULTS[it.key];       /* 非法值退回默认，不留脏数据 */
    });

    SLIDER_ITEMS.concat(BADGE_SLIDERS).forEach(function (it) {
      out[it.key] = clampNum(it.key, r[it.key], DEFAULTS[it.key]);
    });

    out.badgeUrl = String(r.badgeUrl == null ? '' : r.badgeUrl).trim();
    out.badgeMirror = !!r.badgeMirror;

    return out;
  }

  /* ── 编译：参数 → CSS ───────────────────────────────────── */

  /* 角标段。用 ::after 而非 ::before：
     injectBeautifyGuardCss 已给两个伪元素都强制 pointer-events:none，安全性等价；
     选 ::after 是因为它是「尾随」语义，与真实 DOM 里时间/译文附加在气泡之后一致。 */
  function compileBadge(p) {
    /* 最简清洗，防止引号/反斜杠破坏 CSS 语法。
       这里不做 URL 白名单 —— 与快捷导入的宽松态度保持一致。 */
    var url = String(p.badgeUrl).replace(/["\\]/g, '');
    var s = fmtNum(p.badgeSize);
    var t = fmtNum(p.badgeTop);
    var l = fmtNum(p.badgeLeft);
    var L = [];

    /* 宿主必须显式 position:relative + overflow:visible：
       · base 气泡没有 position，不设的话 absolute 会一路上溯到
         .qq-room__scroll（它带 position:relative），角标会跑到错误位置；
       · overflow:visible 是防止负偏移的角标被气泡自身裁掉 ——
         这是角标类样式最常见的翻车点。 */
    L.push('#qq-room .qq-room__row .qq-room__bubble {');
    L.push('  position: relative;');
    L.push('  overflow: visible;');
    L.push('}');
    L.push('');
    L.push('#qq-room .qq-room__row .qq-room__bubble::after {');
    L.push('  content: "";');
    L.push('  position: absolute;');
    L.push('  top: ' + t + 'px;');
    L.push('  left: ' + l + 'px;');
    L.push('  width: ' + s + 'px;');
    L.push('  height: ' + s + 'px;');
    L.push('  background: url("' + url + '") center/contain no-repeat;');
    L.push('  pointer-events: none;');
    if (p.badgeMirror) L.push('  transform: scaleX(-1);');
    L.push('}');

    return L.join('\n');
  }

  /**
   * 参数 → CSS 文本。
   * 作用域固定 #qq-room（见文件头约束①）。
   */
  function compileCss(rawParams) {
    var p = normalizeParams(rawParams);
    var L = [];

    L.push(GEN_MARK);
    L.push('');

    /* ① 聊天背景（可选）。
       用 background-color 而非 background 简写 —— 简写会连带清掉
       .qq-room__scroll 上可能存在的背景图（壁纸层是独立节点不受影响，
       但 scroll 自身可能被其他皮肤设过图）。 */
    if (p.chatBg) {
      L.push('/* 聊天背景 */');
      L.push('#qq-room .qq-room__main,');
      L.push('#qq-room .qq-room__scroll {');
      L.push('  background-color: ' + p.chatBg + ';');
      L.push('}');
      L.push('');
    }

    /* ② 气泡基础尺寸。一条规则打两边，颜色与圆角在下面各自覆写。 */
    var borderDecl = Number(p.borderW) > 0
      ? fmtNum(p.borderW) + 'px solid ' + (p.borderColor || 'rgba(0, 0, 0, 0.06)')
      : 'none';   /* 用 none 而非 border-width:0，避免残留 border-style 影响圆角观感 */
    L.push('/* 气泡尺寸 */');
    L.push('#qq-room .qq-room__row .qq-room__bubble {');
    L.push('  padding: ' + fmtNum(p.padY) + 'px ' + fmtNum(p.padX) + 'px;');
    L.push('  line-height: ' + fmtNum(p.lineH) + ';');
    L.push('  border: ' + borderDecl + ';');
    L.push('}');
    L.push('');

    /* ③ 行最大宽度。
       作用在 row 上而不是 bubble —— 因为 .qq-room__bubble-stack 是 flex:1
       撑满行余宽的，只有限制 row 才能真正限制气泡宽度。
       这里不写 display：row 的 flex 布局由 base CSS 提供，
       重复声明会与 .qq-room__row--card 这类修饰类打架。 */
    L.push('/* 气泡最大宽度 */');
    L.push('#qq-room .qq-room__row {');
    L.push('  max-width: ' + fmtNum(p.maxW) + '%;');
    L.push('}');
    L.push('');

    /* ④⑤ 双方颜色与圆角。
       「呼吸角」收在靠头像那一角：对方收左下、我方收右下。
       Math.min(4, radius) 而非硬编码 4px —— 半径调到 0 时四角齐平，
       不出现「0 圆角却有个 4px 小角」的怪象；半径 ≥4 时恒为 4px，
       保留与 base 一致的不对称语言。 */
    var r = Number(p.radius);
    var tail = Math.min(4, r);

    L.push('/* 对方气泡 */');
    L.push('#qq-room .qq-room__row--them .qq-room__bubble {');
    L.push('  background: ' + p.themBg + ';');
    L.push('  color: ' + p.themFg + ';');
    L.push('  border-radius: ' + fmtNum(r) + 'px ' + fmtNum(r) + 'px ' + fmtNum(r) + 'px ' + fmtNum(tail) + 'px;');
    L.push('}');
    L.push('');

    L.push('/* 我方气泡 */');
    L.push('#qq-room .qq-room__row--me .qq-room__bubble {');
    L.push('  background: ' + p.meBg + ';');
    L.push('  color: ' + p.meFg + ';');
    L.push('  border-radius: ' + fmtNum(r) + 'px ' + fmtNum(r) + 'px ' + fmtNum(tail) + 'px ' + fmtNum(r) + 'px;');
    L.push('}');

    /* ⑥ 角标（可选） */
    if (p.badgeUrl) {
      L.push('');
      L.push('/* 角标图案 */');
      L.push(compileBadge(p));
    }

    L.push('');
    return L.join('\n');
  }

  /* ── 反解：CSS → 参数 ───────────────────────────────────── */

  /* 把一个声明体（`{...}` 里的内容）拆成 prop → value 表 */
  function declMap(body) {
    var out = {};
    String(body || '').split(';').forEach(function (piece) {
      var i = piece.indexOf(':');
      if (i < 0) return;
      var k = piece.slice(0, i).trim().toLowerCase();
      var v = piece.slice(i + 1).trim().replace(/!important\s*$/i, '').trim();
      if (k) out[k] = v;
    });
    return out;
  }

  /* 按选择器抓出第一个 `{...}` 的声明体。
     只做「扁平、单层、无嵌套」的匹配 —— 这是本模块自己生成的格式。
     用户手写的复杂 CSS（嵌套、多选择器组合）抓不到就返回 null，
     由调用方走「保持原值」的降级路径。 */
  function grabBlock(css, selectorRegex) {
    var re = new RegExp(selectorRegex.source + '\\s*\\{([^{}]*)\\}', 'i');
    var m = String(css || '').match(re);
    return m ? declMap(m[1]) : null;
  }

  var SEL = {
    base:  /#qq-room\s+\.qq-room__row\s+\.qq-room__bubble(?![\w-])/,
    me:    /#qq-room\s+\.qq-room__row--me\s+\.qq-room__bubble(?![\w-])/,
    them:  /#qq-room\s+\.qq-room__row--them\s+\.qq-room__bubble(?![\w-])/,
    row:   /#qq-room\s+\.qq-room__row(?![\w-])/,
    badge: /#qq-room\s+\.qq-room__row\s+\.qq-room__bubble::after/
  };

  /* 从 padding 简写取值。认 `Y X` 与 `Y X Y X` 两种；其它写法（单项、
     三项、带 calc 等）解不出就返回 null，让调用方保留原值。 */
  function readPadding(v) {
    var parts = String(v || '').trim().split(/\s+/);
    if (parts.length === 2) return { y: parts[0], x: parts[1] };
    if (parts.length === 4 && parts[0] === parts[2] && parts[1] === parts[3]) {
      return { y: parts[0], x: parts[1] };
    }
    return null;
  }

  function pxToNum(v) {
    var m = String(v || '').match(/^(-?[\d.]+)px$/);
    return m ? m[1] : null;
  }

  /**
   * CSS 文本 → 参数（尽力而为）。
   *
   * 返回 { params, matched, total }：
   *   params  —— 能识别出来的字段集合（识别不到的字段**不在其中**），
   *              调用方应以「保留当前值」的方式合并，而不是整表重置。
   *   matched —— 识别到的字段数，用于给用户如实反馈。
   *
   * 为什么识别不到时保留原值而不是回默认：
   *   用户在输入框里读进了一份手写的复杂皮肤，如果这里整表重置成默认，
   *   预览会突变成素气泡；此时若他再点「应用」，刚读进来的皮肤就被
   *   默认参数整段覆盖 —— 属于静默的数据丢失。保留原值是最小惊讶，
   *   配合提示让用户明确知道「滑块没跟上」，他才有正确的下一步。
   */
  function parseCss(css) {
    var s = String(css || '');
    var found = {};
    var matched = 0;

    function take(key, val) {
      if (val == null || val === '') return;
      found[key] = val;
      matched++;
    }

    /* 聊天背景 */
    var bgBlock = grabBlock(s, /#qq-room\s+\.qq-room__main[\s\S]*?(?=#qq-room\s+\.qq-room__scroll)?/);
    if (!bgBlock) bgBlock = grabBlock(s, /#qq-room\s+\.qq-room__main/);
    if (bgBlock && isHex(bgBlock['background-color'])) {
      take('chatBg', bgBlock['background-color'].toLowerCase());
    }

    /* 气泡尺寸 */
    var base = grabBlock(s, SEL.base);
    if (base) {
      var pad = readPadding(base.padding);
      if (pad) {
        var py = pxToNum(pad.y), px = pxToNum(pad.x);
        if (py != null) take('padY', py);
        if (px != null) take('padX', px);
      }
      var lh = parseFloat(base['line-height']);
      if (isFinite(lh)) take('lineH', lh);
      if (base.border) {
        if (/^none$/i.test(base.border.trim())) {
          take('borderW', 0);
        } else {
          /* border 是简写（`2px solid #c89ab0`），所以只能取开头的数字，
             不能整体匹配 —— 整体匹配只对单值的 border-width 成立。 */
          var bw = String(base.border).match(/^(-?[\d.]+)px/);
          if (bw) take('borderW', bw[1]);
          /* 描边色：从 `1px solid #abc` 里抠颜色 */
          var bc = String(base.border).match(/(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s*$/);
          if (bc) take('borderColor', bc[1].toLowerCase());
        }
      }
    }

    /* 行最大宽度 */
    var row = grabBlock(s, SEL.row);
    if (row) {
      var mw = String(row['max-width'] || '').match(/^([\d.]+)%$/);
      if (mw) take('maxW', mw[1]);
    }

    /* 双方颜色与圆角 */
    var them = grabBlock(s, SEL.them);
    if (them) {
      if (isHex(them.background)) take('themBg', them.background.toLowerCase());
      if (isHex(them.color)) take('themFg', them.color.toLowerCase());
      var tr = String(them['border-radius'] || '').match(/^([\d.]+)px/);
      if (tr) take('radius', tr[1]);
    }
    var me = grabBlock(s, SEL.me);
    if (me) {
      if (isHex(me.background)) take('meBg', me.background.toLowerCase());
      if (isHex(me.color)) take('meFg', me.color.toLowerCase());
    }

    /* 角标 */
    var badge = grabBlock(s, SEL.badge);
    if (badge) {
      var url = String(badge.background || '').match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
      if (url) take('badgeUrl', url[1].trim());
      var bs = pxToNum(badge.width);
      if (bs != null) take('badgeSize', bs);
      var bt = pxToNum(badge.top);
      if (bt != null) take('badgeTop', bt);
      var bl = pxToNum(badge.left);
      if (bl != null) take('badgeLeft', bl);
      if (/scaleX\(\s*-1\s*\)/i.test(String(badge.transform || ''))) take('badgeMirror', true);
    }

    return { params: found, matched: matched, total: TOTAL_ITEMS };
  }

  /* 这份 CSS 是不是本调试器生成的（用于「应用」时决定要不要弹覆盖确认）。
     认首行标记即可 —— 用户若把标记删了，就走确认流程，宁可多问一次。 */
  function isGenerated(css) {
    return String(css || '').indexOf(GEN_MARK) >= 0;
  }

  /* ══════════════════════════════════════════════════════════
     面板渲染
     ══════════════════════════════════════════════════════════ */

  /* 折叠态。放在 IIFE 闭包里而不是 DOM 上 ——
     renderPage 是整页 innerHTML 重绘，DOM 上的任何状态都会被冲掉；
     闭包变量能跨重绘存活（刷新页面才重置，与项目里 state.wbSortOpen
     这类手写状态的寿命一致）。 */
  var openState = false;

  function sliderHtml(key, label) {
    var sp = SPEC[key];
    return '<div class="mi-bt-slide">' +
      '<label class="ins-field-label" for="mq-bt-' + key + '">' + esc(label) +
        ' <span class="mi-bt-slide__val" data-mq-bt-val="' + key + '">' +
          fmtNum(DEFAULTS[key]) + esc(sp.unit) +
        '</span>' +
      '</label>' +
      '<input type="range" class="ins-range" id="mq-bt-' + key + '"' +
        ' data-mq-bt="' + key + '"' +
        ' min="' + sp.min + '" max="' + sp.max + '" step="' + sp.step + '"' +
        ' value="' + fmtNum(DEFAULTS[key]) + '">' +
    '</div>';
  }

  function colorHtml(key, label) {
    /* 描边色与聊天背景的「空」是有语义的（不额外指定），但取色器没法显示空。
       这两项多给一个 hex 读数，用户能看出当前到底是不是「未指定」。 */
    var optional = (key === 'borderColor' || key === 'chatBg');
    return '<div class="mi-bt-color' + (optional ? ' mi-bt-color--opt' : '') + '">' +
      '<button type="button" class="mi-bt-color__swatch" data-mq-bt-pick="' + key + '"' +
        ' aria-label="' + esc(label) + '" aria-expanded="false"' +
        ' style="--mq-bt-c:' + esc(DEFAULTS[key] || '#ffffff') + '">' +
        '<span class="mi-bt-color__chip" data-mq-bt-chip="' + key + '"></span>' +
      '</button>' +
      '<span class="mi-bt-color__name">' + esc(label) + '</span>' +
      (optional
        ? '<span class="mi-bt-color__hex" data-mq-bt-hex="' + key + '">默认</span>'
        : '') +
      /* 保留一个隐藏的原生 input：readParams / applyParamsToPanel / syncFromCss
         全都在它身上读写，留着它们就不用改；同时它也是「自定义」路径的入口。 */
      '<input type="color" class="mi-bt-color__input" data-mq-bt="' + key + '"' +
        ' value="' + esc(DEFAULTS[key] || '#ffffff') + '"' +
        ' title="' + esc(label) + '" tabindex="-1" aria-hidden="true">' +
    '</div>';
  }

  /* 内嵌色盘面板。点某个颜色项时展开在它下面，**不弹系统对话框** ——
     原生 input[type=color] 在手机上是个全屏弹窗，把预览整个盖住，
     根本没法「边看边调」。这里是整个改动的起因。 */
  function pickerHtml(key) {
    var H = [];
    H.push('<div class="mi-bt-picker" data-mq-bt-picker="' + key + '" hidden>');

    /* 内置色盘：横向可滚的胶囊行，点一下整套换色 */
    H.push('<div class="mi-bt-picker__label">色盘</div>');
    H.push('<div class="mi-bt-palettes">');
    PALETTES.forEach(function (p) {
      H.push('<button type="button" class="mi-bt-pal" data-mq-bt-pal="' + p.id + '"' +
        ' title="' + esc(p.name) + '">');
      H.push('<span class="mi-bt-pal__dots">');
      /* 只画 4 个代表色，够辨识即可，多了在小屏上糊成一团 */
      [0, Math.floor(p.shades.length / 3), Math.floor(p.shades.length * 2 / 3), p.shades.length - 1]
        .forEach(function (i) {
          H.push('<i style="background:' + esc(p.shades[i]) + '"></i>');
        });
      H.push('</span>');
      H.push('<span class="mi-bt-pal__name">' + esc(p.name) + '</span>');
      H.push('</button>');
    });
    H.push('</div>');

    /* 取色区：内置色盘的散色 + 常用中性/纯色 */
    H.push('<div class="mi-bt-picker__label">取色</div>');
    H.push('<div class="mi-bt-swatches">');
    var seen = {};
    PALETTES.forEach(function (p) {
      p.shades.forEach(function (s) {
        if (seen[s]) return;
        seen[s] = 1;
        H.push('<button type="button" class="mi-bt-sw" data-mq-bt-swatch="' + esc(s) + '"' +
          ' style="background:' + esc(s) + '" title="' + esc(s) + '"></button>');
      });
    });
    BASIC_COLORS.forEach(function (s) {
      if (seen[s]) return;
      seen[s] = 1;
      H.push('<button type="button" class="mi-bt-sw mi-bt-sw--basic" data-mq-bt-swatch="' + esc(s) + '"' +
        ' style="background:' + esc(s) + '" title="' + esc(s) + '"></button>');
    });
    H.push('</div>');

    /* 自定义：默认收起，展开才有原生取色器 + 手填 hex。
       保留它是刻意的 —— 色盘是加速入口，不是唯一出路。 */
    H.push('<div class="mi-bt-custom">');
    H.push('<button type="button" class="mi-bt-custom__toggle" data-mq-bt-custom-toggle' +
      ' aria-expanded="false">自定义</button>');
    H.push('<div class="mi-bt-custom__body" data-mq-bt-custom-body hidden>');
    H.push('<label class="mi-bt-custom__row">');
    H.push('<span>取色器</span>');
    H.push('<input type="color" class="mi-bt-custom__color" data-mq-bt-custom-color="' + key + '"' +
      ' value="' + esc((COLOR_DEFAULTS()[key]) || '#ffffff') + '">');
    H.push('</label>');
    H.push('<label class="mi-bt-custom__row">');
    H.push('<span>色值</span>');
    H.push('<input type="text" class="ins-text-input mi-bt-custom__hex" data-mq-bt-custom-hex="' + key + '"' +
      ' placeholder="#rrggbb" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off">');
    H.push('</label>');
    H.push('<p class="mi-bt-custom__note">填 <code>#rrggbb</code> 或 <code>#rgb</code>，回车生效。</p>');
    H.push('</div>');
    H.push('</div>');

    H.push('<div class="mi-bt-picker__foot">');
    H.push('<button type="button" class="mi-pill mi-pill--ghost mi-bt-picker__clear" data-mq-bt-clear="' + key + '">恢复默认</button>');
    H.push('<button type="button" class="mi-pill mi-bt-picker__done" data-mq-bt-picker-done>收起</button>');
    H.push('</div>');

    H.push('</div>');
    return H.join('');
  }

  /* 取色器里的「默认」——用于恢复默认按钮。抽成函数是为了让 colorHtml 与
     pickerHtml 共用同一份，避免两处写死的默认色值漂移。 */
  function COLOR_DEFAULTS() {
    return DEFAULTS;
  }

  /**
   * 面板 HTML。customCss 用于首帧就反解出正确的滑块值 ——
   * 否则会先渲染一帧默认值再被 syncFromCss 修正，用户能看见闪烁。
   */
  function buildPanelHtml(customCss) {
    var seed = parseCss(customCss);
    /* 首帧渲染：能解出来的用解出来的，解不出来的用默认值 */
    var initial = Object.assign({}, DEFAULTS, seed.params);
    var matched = seed.matched;

    var H = [];
    H.push('<div class="mi-bt-panel' + (openState ? ' is-open' : '') + '" data-mq-bt-panel>');

    /* 标题行：照抄项目既有的 .mi-wb-sort-toggle 折叠范式 */
    var meta = matched > 0
      ? '已识别 ' + matched + '/' + TOTAL_ITEMS + ' 项'
      : '拖滑块实时调参';
    H.push('<button type="button" class="mi-bt-toggle" data-mq-bt-toggle' +
      ' aria-expanded="' + (openState ? 'true' : 'false') + '">');
    H.push('<img class="mi-bt-toggle__ico" src="img/icons/chevron-right.svg" alt="" width="14" height="14" aria-hidden="true">');
    H.push('<span class="mi-bt-toggle__title">气泡参数调试</span>');
    H.push('<span class="mi-bt-toggle__meta" data-mq-bt-meta>' + esc(meta) + '</span>');
    H.push('</button>');

    H.push('<div class="mi-bt-body" data-mq-bt-body' + (openState ? '' : ' hidden') + '>');

    /* 颜色组 */
    H.push('<div class="mi-bt-group">');
    H.push('<span class="mi-bt-group__label">颜色</span>');

    /* 一键套整组：横向排列的色盘胶囊。放最上面是因为它是最常用入口 ——
       多数人想要的只是「整体换个色」，而不是逐个调六个参数。 */
    H.push('<div class="mi-bt-presets">');
    PALETTES.forEach(function (p) {
      H.push('<button type="button" class="mi-bt-preset" data-mq-bt-preset="' + p.id + '"' +
        ' title="套用「' + esc(p.name) + '」色盘">');
      H.push('<span class="mi-bt-preset__bar" aria-hidden="true">');
      [0, Math.floor(p.shades.length / 3), Math.floor(p.shades.length * 2 / 3), p.shades.length - 1]
        .forEach(function (i) {
          H.push('<i style="background:' + esc(p.shades[i]) + '"></i>');
        });
      H.push('</span>');
      H.push('<span class="mi-bt-preset__name">' + esc(p.name) + '</span>');
      H.push('</button>');
    });
    H.push('</div>');

    H.push('<div class="mi-bt-grid">');
    COLOR_ITEMS.forEach(function (it) { H.push(colorHtml(it.key, it.label)); });
    H.push('</div>');
    /* 取色面板全部预渲染 + hidden，点开时才显示。预渲染而不是按需插入：
       插入会改变面板高度导致页面跳动，预渲染只切换 hidden，位置稳定。 */
    COLOR_ITEMS.forEach(function (it) { H.push(pickerHtml(it.key)); });
    H.push('<p class="mi-bt-note">点色块就地取色，预览实时变化；描边色与聊天背景可留空，即沿用主题默认。</p>');
    H.push('</div>');

    /* 形状组 */
    H.push('<div class="mi-bt-group">');
    H.push('<span class="mi-bt-group__label">形状</span>');
    SLIDER_ITEMS.forEach(function (it) { H.push(sliderHtml(it.key, it.label)); });
    H.push('</div>');

    /* 角标组 */
    H.push('<div class="mi-bt-group">');
    H.push('<span class="mi-bt-group__label">角标图案</span>');
    H.push('<div class="mi-bt-slide">');
    H.push('<label class="ins-field-label" for="mq-bt-badgeUrl">图案地址</label>');
    H.push('<input type="text" class="ins-text-input" id="mq-bt-badgeUrl" data-mq-bt="badgeUrl"' +
      ' placeholder="留空则不显示角标" value="' + esc(initial.badgeUrl) + '">');
    H.push('</div>');
    BADGE_SLIDERS.forEach(function (it) { H.push(sliderHtml(it.key, it.label)); });
    H.push('<div class="ins-toggle-line">');
    H.push('<strong>水平镜像</strong>');
    H.push('<button type="button" class="ins-toggle' + (initial.badgeMirror ? ' is-on' : '') + '"' +
      ' data-mq-bt-toggle-flag="badgeMirror" role="switch"' +
      ' aria-checked="' + (initial.badgeMirror ? 'true' : 'false') + '"></button>');
    H.push('</div>');
    H.push('</div>');

    /* 操作行 */
    H.push('<div class="mi-btn-row mi-bt-actions">');
    H.push('<button type="button" class="mi-pill mi-pill--dark" data-mq-bt-apply>应用到编辑区</button>');
    H.push('<button type="button" class="mi-pill" data-mq-bt-parse>从 CSS 回填</button>');
    H.push('<button type="button" class="mi-pill mi-pill--ghost" data-mq-bt-reset>重置</button>');
    H.push('</div>');

    H.push('<p class="mi-bt-hint" data-mq-bt-hint>调完点「应用到编辑区」→ 再点右上角「保存」才对本聊天生效。</p>');
    H.push('</div>');
    H.push('</div>');

    /* 首帧就要把滑块摆到 initial 上。buildPanelHtml 里写死的是 DEFAULTS，
       这里用一段内联脚本纠正 —— 比在 bind 阶段再刷一次更早，不会有闪烁。 */
    H.push('<script>(function(){var s=document.currentScript;' +
      'var p=s&&s.previousElementSibling;if(!p)return;' +
      'var v=' + JSON.stringify(initial) + ';' +
      'try{window.MiyaBubbleTuner.applyParamsToPanel(p,v);}catch(e){}' +
      '})();<\/script>');

    return H.join('');
  }

  /* ══════════════════════════════════════════════════════════
     面板读写
     ══════════════════════════════════════════════════════════ */

  /* 把参数写进面板控件（滑块/颜色/开关/数值标签） */
  function applyParamsToPanel(panel, params) {
    if (!panel) return;
    var p = normalizeParams(params);
    panel.querySelectorAll('[data-mq-bt]').forEach(function (el) {
      var key = el.getAttribute('data-mq-bt');
      if (!(key in p)) return;
      var v = p[key];
      if (el.type === 'color') {
        /* 取色器不接受空串。空 = 不指定，用白色占位（用户不动它就不会被写进 CSS）。
           同时按「是否为空」维护 touched 标记，readParams 靠它区分
           「没动过的白色占位」与「用户真的选了白色」。 */
        el.value = isHex(v) ? v : '#ffffff';
        if (!isHex(v)) el.removeAttribute('data-mq-bt-touched');
        else el.dataset.mqBtTouched = '1';
      } else if (el.type === 'range') {
        el.value = fmtNum(v);
      } else {
        el.value = v;
      }
    });
    var flag = panel.querySelector('[data-mq-bt-toggle-flag="badgeMirror"]');
    if (flag) {
      flag.classList.toggle('is-on', !!p.badgeMirror);
      flag.setAttribute('aria-checked', p.badgeMirror ? 'true' : 'false');
    }
    refreshLabels(panel);
  }

  /* 从面板读出参数 */
  function readParams(panel) {
    var out = Object.assign({}, DEFAULTS);
    if (!panel) return out;
    panel.querySelectorAll('[data-mq-bt]').forEach(function (el) {
      var key = el.getAttribute('data-mq-bt');
      if (!(key in DEFAULTS)) return;
      if (el.type === 'color') {
        var v = String(el.value || '').toLowerCase();
        /* 可选色（描边 / 聊天背景）的默认值是空串，语义是「不额外指定」。
           但 <input type=color> 装不下空串，未动过时它显示的是白色占位 ——
           直接读就会把「没动过」误读成「用户选了白色」，编译出一段
           border-color:#ffffff / background-color:#ffffff，
           把主题原本的淡描边和背景色盖掉。用户什么都没碰却改变了外观。
           判据：值是白色 且 该项确实没被主动设置过（看 dataset 标记）。 */
        if (DEFAULTS[key] === '' && v === '#ffffff' && el.dataset.mqBtTouched !== '1') {
          out[key] = '';
        } else {
          out[key] = v;
        }
      } else if (el.type === 'range') {
        out[key] = parseFloat(el.value);
      } else {
        out[key] = String(el.value || '');
      }
    });
    var flag = panel.querySelector('[data-mq-bt-toggle-flag="badgeMirror"]');
    if (flag) out.badgeMirror = flag.classList.contains('is-on');
    return normalizeParams(out);
  }

  /* 刷新所有数值标签（label 里的 span）+ 色块预览 + hex 读数。
     三处都从隐藏的原生 input 取值，保证单一数据源。 */
  function refreshLabels(panel) {
    if (!panel) return;
    panel.querySelectorAll('[data-mq-bt-val]').forEach(function (span) {
      var key = span.getAttribute('data-mq-bt-val');
      var el = panel.querySelector('[data-mq-bt="' + key + '"]');
      if (!el) return;
      var sp = SPEC[key] || { unit: '' };
      span.textContent = fmtNum(el.value) + sp.unit;
    });

    /* 色块 + hex 读数。空串是有语义的「不指定」：色块显示白色占位，
       可选色旁边写「默认」，用户能一眼看出自己到底动没动过。 */
    COLOR_ITEMS.forEach(function (it) {
      var key = it.key;
      var el = panel.querySelector('[data-mq-bt="' + key + '"]');
      if (!el) return;
      var v = String(el.value || '').toLowerCase();
      var untouched = !DEFAULTS[key] && v === '#ffffff';
      var show = untouched ? '#ffffff' : v;

      var pick = panel.querySelector('[data-mq-bt-pick="' + key + '"]');
      if (pick) pick.style.setProperty('--mq-bt-c', show);

      var hexEl = panel.querySelector('[data-mq-bt-hex="' + key + '"]');
      if (hexEl) hexEl.textContent = untouched ? '默认' : v.toUpperCase();
    });
  }

  /* 更新标题行的 meta 文案 */
  function setMeta(panel, text) {
    var el = panel && panel.querySelector('[data-mq-bt-meta]');
    if (el) el.textContent = text;
  }

  /* 更新底部提示。warn=true 时用警示色 */
  function setHint(panel, text, warn) {
    var el = panel && panel.querySelector('[data-mq-bt-hint]');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-warn', !!warn);
  }

  /* 折叠开合。状态写进模块级 openState，跨整页重绘存活。 */
  function setOpen(panel, on) {
    openState = !!on;
    if (!panel) return;
    panel.classList.toggle('is-open', openState);
    var body = panel.querySelector('[data-mq-bt-body]');
    if (body) body.hidden = !openState;
    var btn = panel.querySelector('[data-mq-bt-toggle]');
    if (btn) btn.setAttribute('aria-expanded', openState ? 'true' : 'false');
  }

  /* ══════════════════════════════════════════════════════════
     与外部协作
     ══════════════════════════════════════════════════════════ */

  function beatify() { return global.MiyaChatBeautify; }

  function toast(msg) {
    var b = beatify();
    if (b && b.toast) b.toast(msg);
  }

  /* 写 textarea + 刷预览。与「读取预设」「快捷导入」同款收尾 ——
     只改编辑区，落库交给顶栏「保存」。 */
  function writeCss(root, css) {
    var ta = root && root.querySelector('[data-mq-bf-custom-css]');
    if (!ta) return false;
    ta.value = css;
    var b = beatify();
    if (b && b.hydrateCssPreview) b.hydrateCssPreview(root);
    return true;
  }

  /**
   * 从一段 CSS 反解并回填滑块。
   *
   * 降级策略：识别不到任何项时**完全不动滑块**，只给提示。
   * 理由 —— 用户读进来一份手写的复杂皮肤，如果这里把滑块重置成默认，
   * 预览会突变成素气泡；此时他若再点「应用」，刚读进来的皮肤就被
   * 默认参数整段覆盖，属于静默的数据丢失。保持原值是「最小惊讶」。
   */
  function syncFromCss(root, css) {
    var panel = (root || document).querySelector('[data-mq-bt-panel]');
    if (!panel) return;
    var text = String(css || '').trim();

    /* 编辑区是空的：没有可比对的东西，不报「未同步」——那是误报，
       用户只是还没开始调。此时保持默认参数即可。 */
    if (!text) {
      setMeta(panel, '拖滑块实时调参');
      setHint(panel, '调完点「应用到编辑区」→ 再点右上角「保存」才对本聊天生效。');
      return;
    }

    var res = parseCss(text);

    if (res.matched === 0) {
      setMeta(panel, '未同步');
      setHint(panel, '编辑区已有其他 CSS，滑块未同步。点「应用到编辑区」会用滑块参数覆盖整段 CSS。', true);
      return;
    }

    /* 解出来的合并到当前滑块值上；解不出来的保持原样 */
    var cur = readParams(panel);
    applyParamsToPanel(panel, Object.assign({}, cur, res.params));

    setMeta(panel, '已识别 ' + res.matched + '/' + res.total + ' 项');
    if (res.matched < res.total) {
      setHint(panel, '已识别 ' + res.matched + '/' + res.total +
        ' 项，其余保持原值（可能被手写 CSS 覆盖或用了简写）。');
    } else {
      setHint(panel, '参数已与编辑区 CSS 同步。改完点「应用到编辑区」→ 再点右上角「保存」。');
    }
  }

  /* 从 textarea 当前内容反解回填。整页重绘后用它把滑块摆回去。 */
  function syncFromTextarea(root) {
    var ta = root && root.querySelector('[data-mq-bf-custom-css]');
    if (!ta) return;
    syncFromCss(root, ta.value);
  }

  /**
   * 监听用户在编辑区里手写 / 粘贴 CSS。
   *
   * 不监听会怎样：用户把别处抄来的皮肤粘进编辑区，滑块纹丝不动、
   * meta 还写着「拖滑块实时调参」，看着像同步的 —— 一旦他去点
   * 「应用到编辑区」，那份手写皮肤就被滑块参数整段覆盖。这里必须给反馈。
   *
   * 节流 300ms：逐字敲击时每次都跑 parseCss 属于白烧 CPU，
   * 而且中途的半截 CSS 会闪出一串「未同步」，像报错。
   *
   * 注意方向：这是 textarea → 滑块的**单向**同步。滑块 → textarea 由
   * livePreview 负责，两边不会互相触发（writeCss 只赋值不派发事件）。
   */
  function watchTextarea(root) {
    var ta = root && root.querySelector('[data-mq-bf-custom-css]');
    if (!ta || ta.dataset.mqBtWatched) return;
    ta.dataset.mqBtWatched = '1';
    var timer = null;
    ta.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { syncFromCss(root, ta.value); }, 300);
    });
  }

  /* 应用：参数 → CSS → 写进编辑区 */
  function apply(panel, root) {
    var params = readParams(panel);
    var css = compileCss(params);
    var ta = root && root.querySelector('[data-mq-bf-custom-css]');
    if (!ta) {
      toast('未找到编辑区');
      return;
    }

    var existing = String(ta.value || '').trim();
    var willOverwrite = existing && !isGenerated(existing);

    function doWrite() {
      writeCss(root, css);
      setMeta(panel, '已应用');
      setHint(panel, '已写入编辑区。点右上角「保存」才对当前聊天生效。');
      toast('已应用到编辑区，记得保存');
    }

    if (!willOverwrite) {
      doWrite();
      return;
    }

    /* 编辑区里有非调试器生成的 CSS，整段覆盖是破坏性的，先确认 */
    var confirmFn = global.miyaDialog && global.miyaDialog.confirm
      ? global.miyaDialog.confirm.bind(global.miyaDialog)
      : function (o) { return Promise.resolve(confirm(o.message || '确定？')); };
    confirmFn({
      title: '覆盖编辑区 CSS',
      message: '编辑区已有其他 CSS，将被调试器参数整段覆盖，原内容不可恢复。继续？',
      confirmText: '覆盖',
      cancelText: '取消'
    }).then(function (ok) {
      if (ok) doWrite();
    }).catch(function () {});
  }

  /* ══════════════════════════════════════════════════════════
     事件绑定
     ══════════════════════════════════════════════════════════ */

  function onClick(root, e) {
    var panel = root.querySelector('[data-mq-bt-panel]');
    if (!panel) return;

    if (e.target.closest('[data-mq-bt-toggle]')) {
      setOpen(panel, !panel.classList.contains('is-open'));
      return;
    }
    if (e.target.closest('[data-mq-bt-toggle-flag]')) {
      var btn = e.target.closest('[data-mq-bt-toggle-flag]');
      var on = !btn.classList.contains('is-on');
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      setMeta(panel, '待应用');
      return;
    }
    if (e.target.closest('[data-mq-bt-apply]')) {
      apply(panel, root);
      return;
    }
    if (e.target.closest('[data-mq-bt-parse]')) {
      syncFromTextarea(root);
      toast('已尝试从 CSS 回填参数');
      return;
    }
    if (e.target.closest('[data-mq-bt-reset]')) {
      applyParamsToPanel(panel, DEFAULTS);
      setMeta(panel, '已重置');
      setHint(panel, '已重置为默认参数。点「应用到编辑区」写入。');
      closeAllPickers(panel);
      return;
    }

    /* ── 一键套整组色盘 ── */
    var palBtn = e.target.closest('[data-mq-bt-preset]');
    if (palBtn) {
      var pal = findPalette(palBtn.getAttribute('data-mq-bt-preset'));
      if (!pal) return;
      var col = paletteToParams(pal);
      if (!col) return;
      /* 只覆盖 6 个颜色，形状与角标保持用户当前设置 ——
         套色盘不该顺手改掉人家调好的圆角。 */
      var cur = readParams(panel);
      applyParamsToPanel(panel, Object.assign({}, cur, col));
      refreshPreviewOnly(panel, root);
      setMeta(panel, '色盘「' + pal.name + '」');
      setHint(panel, '已套用「' + pal.name + '」色盘（仅颜色）。点「应用到编辑区」→ 再点右上角「保存」生效。');
      closeAllPickers(panel);
      return;
    }

    /* ── 打开 / 关闭某个颜色的取色面板 ── */
    var pickBtn = e.target.closest('[data-mq-bt-pick]');
    if (pickBtn) {
      var pk = pickBtn.getAttribute('data-mq-bt-pick');
      togglePicker(panel, pk);
      return;
    }
    if (e.target.closest('[data-mq-bt-picker-done]')) {
      closeAllPickers(panel);
      return;
    }

    /* ── 取色：内置色盘里的散色 ── */
    var sw = e.target.closest('[data-mq-bt-swatch]');
    if (sw) {
      var swKey = pickerKeyOf(sw);
      if (!swKey) return;
      setColorValue(panel, swKey, sw.getAttribute('data-mq-bt-swatch'));
      refreshPreviewOnly(panel, root);
      setMeta(panel, '待应用');
      setHint(panel, '颜色已改，预览实时更新。点「应用到编辑区」→ 再点右上角「保存」生效。');
      return;
    }

    /* ── 展开 / 收起「自定义」区 ── */
    var ct = e.target.closest('[data-mq-bt-custom-toggle]');
    if (ct) {
      var body = ct.parentNode.querySelector('[data-mq-bt-custom-body]');
      if (body) {
        var nowOpen = body.hasAttribute('hidden');
        if (nowOpen) body.removeAttribute('hidden');
        else body.setAttribute('hidden', '');
        ct.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      }
      return;
    }

    /* ── 恢复该项默认色 ── */
    var clr = e.target.closest('[data-mq-bt-clear]');
    if (clr) {
      var clrKey = clr.getAttribute('data-mq-bt-clear');
      setColorValue(panel, clrKey, DEFAULTS[clrKey] || '');
      refreshPreviewOnly(panel, root);
      setMeta(panel, '待应用');
      setHint(panel, '已恢复该项默认色。');
      return;
    }
  }

  function findPalette(id) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) return PALETTES[i];
    }
    return null;
  }

  /* 从当前点击的元素往上找到它所属的取色面板，取出对应的颜色字段名 */
  function pickerKeyOf(el) {
    var box = el.closest('[data-mq-bt-picker]');
    return box ? box.getAttribute('data-mq-bt-picker') : '';
  }

  function closeAllPickers(panel) {
    panel.querySelectorAll('[data-mq-bt-picker]').forEach(function (p) {
      p.setAttribute('hidden', '');
    });
    panel.querySelectorAll('[data-mq-bt-pick]').forEach(function (b) {
      b.classList.remove('is-open');
      b.setAttribute('aria-expanded', 'false');
    });
  }

  /* 同一时刻只开一个取色面板：手机上开两个会互相挤，而且用户也没那个需求 */
  function togglePicker(panel, key) {
    var box = panel.querySelector('[data-mq-bt-picker="' + key + '"]');
    var btn = panel.querySelector('[data-mq-bt-pick="' + key + '"]');
    var wasOpen = box && !box.hasAttribute('hidden');
    closeAllPickers(panel);
    if (!box || wasOpen) return;
    box.removeAttribute('hidden');
    if (btn) {
      btn.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
    }
    /* 打开时把「自定义」的色值与 hex 输入框对齐到当前值 */
    var cur = readParams(panel)[key];
    var hexInput = box.querySelector('[data-mq-bt-custom-hex]');
    var colorInput = box.querySelector('[data-mq-bt-custom-color]');
    var hasVal = isHex(cur);
    if (hexInput) hexInput.value = hasVal ? cur : '';
    if (colorInput) colorInput.value = hasVal ? cur : '#ffffff';
  }

  /* 写入某个颜色字段。同步三处：隐藏的原生 input（数据源）、
     色块预览、以及可选的 hex 读数。空串有语义，必须原样保留。 */
  function setColorValue(panel, key, value) {
    var v = String(value || '').trim();
    if (v !== '' && !isHex(v)) return false;

    var native = panel.querySelector('[data-mq-bt][data-mq-bt="' + key + '"]');
    if (native) {
      native.value = v === '' ? '#ffffff' : v;
      /* 标记「用户主动设过」。空串 = 显式恢复默认，所以清掉标记；
         有值 = 真的选了颜色，打上标记，readParams 才会认这个白色。 */
      if (v === '') native.removeAttribute('data-mq-bt-touched');
      else native.dataset.mqBtTouched = '1';
    }

    var pick = panel.querySelector('[data-mq-bt-pick="' + key + '"]');
    if (pick) pick.style.setProperty('--mq-bt-c', v === '' ? '#ffffff' : v);

    var hexEl = panel.querySelector('[data-mq-bt-hex="' + key + '"]');
    if (hexEl) hexEl.textContent = v === '' ? '默认' : v.toUpperCase();

    var box = panel.querySelector('[data-mq-bt-picker="' + key + '"]');
    if (box) {
      var hi = box.querySelector('[data-mq-bt-custom-hex]');
      var ci = box.querySelector('[data-mq-bt-custom-color]');
      if (hi) hi.value = v;
      if (ci) ci.value = v === '' ? '#ffffff' : v;
    }
    return true;
  }

  /* 滑块拖动中只更新数值标签，松手（change）才刷预览 ——
     把 compileCss + 样式重算压在松手那一刻，拖动过程才不会卡。 */
  function onInput(root, e) {
    var panel = root.querySelector('[data-mq-bt-panel]');
    if (!panel) return;

    /* 取色面板里的「自定义」区：原生取色器拖动时就实时刷预览。
       这是唯一「拖动中也要刷」的地方 —— 颜色拖动的代价远小于滑块
       （不涉及布局重排），而且用户就是要看着预览挑色。 */
    var custColor = e.target.closest('[data-mq-bt-custom-color]');
    if (custColor) {
      var ck = custColor.getAttribute('data-mq-bt-custom-color');
      setColorValue(panel, ck, custColor.value);
      refreshPreviewOnly(panel, root);
      setMeta(panel, '待应用');
      setHint(panel, '取色中，预览实时更新（编辑区未改动）。');
      return;
    }

    /* 手填 hex：只在凑够完整色值时才动，避免输入过程中的半截值乱跳 */
    var custHex = e.target.closest('[data-mq-bt-custom-hex]');
    if (custHex) {
      var hk = custHex.getAttribute('data-mq-bt-custom-hex');
      var hv = String(custHex.value || '').trim();
      if (isHex(hv)) {
        setColorValue(panel, hk, hv);
        refreshPreviewOnly(panel, root);
        setMeta(panel, '待应用');
        setHint(panel, '色值已生效，预览实时更新（编辑区未改动）。');
      }
      return;
    }

    var el = e.target.closest('[data-mq-bt]');
    if (!el) return;
    if (el.type === 'range') {
      refreshLabels(panel);
      setMeta(panel, '待应用');
      return;
    }
    if (el.type === 'color') {
      setMeta(panel, '待应用');
      return;
    }
    if (el.tagName === 'INPUT') {
      setMeta(panel, '待应用');
    }
  }

  function onChange(root, e) {
    var panel = root.querySelector('[data-mq-bt-panel]');
    if (!panel) return;

    /* 自定义区松手：预览已经实时刷过了，这里只给个收尾提示 */
    var custColor = e.target.closest('[data-mq-bt-custom-color]');
    if (custColor) {
      setHint(panel, '颜色已定。点「应用到编辑区」→ 再点右上角「保存」生效。');
      return;
    }
    var custHex = e.target.closest('[data-mq-bt-custom-hex]');
    if (custHex) return;

    var el = e.target.closest('[data-mq-bt]');
    if (!el) return;
    if (el.type === 'range' || el.type === 'color') {
      refreshLabels(panel);
      /* 实时预览：滑块松手即把参数编译进编辑区并刷新预览。
         这样「拖滑块看效果」不需要每次都去点按钮，
         但落库仍然只由顶栏「保存」触发。 */
      livePreview(panel, root);
    }
  }

  /* 松手预览。若编辑区已有非生成物 CSS，不自动覆盖 ——
     那种情况必须走「应用到编辑区」的显式确认，避免手写内容被悄悄冲掉。 */
  function livePreview(panel, root) {
    var ta = root && root.querySelector('[data-mq-bf-custom-css]');
    if (!ta) return;
    var existing = String(ta.value || '').trim();
    if (existing && !isGenerated(existing)) {
      setHint(panel, '编辑区已有其他 CSS，实时预览已暂停。点「应用到编辑区」确认覆盖后再调。', true);
      return;
    }
    writeCss(root, compileCss(readParams(panel)));
    setHint(panel, '预览已更新（尚未保存）。点右上角「保存」才对当前聊天生效。');
  }

  /* ══════════════════════════════════════════════════════════
     只刷预览、不写编辑区
     ══════════════════════════════════════════════════════════

     这是「边看边调」的关键。取色、套色盘这类操作过程性很强 ——
     用户会连点好几个色块，每个都写一次编辑区的话：
       ① 下面那个 CSS 文本框会疯狂抖动，行数在变、滚动位置在跳；
       ② 编辑区原本的手写内容会被反复覆盖，撤销都救不回来。
     所以调色阶段只把 CSS 打到**预览房间**上，编辑区一个字都不动，
     等用户点「应用到编辑区」才落笔。

     实现上绕开 beautify 的 hydrateCssPreview（那个是「编辑区 → 预览」方向的），
     直接往预览的 <style> 里写。作用域仍按 scopeCssForPreview 的规则来，
     优先复用 beautify 导出的同名方法，没有才退回本地替换 ——
     这样预览与真实的作用域关系不会漂移。 */
  function previewOnly(root, css) {
    var b = beatify();
    var scoped = css;
    if (b && typeof b.scopeCssForPreview === 'function') {
      try { scoped = b.scopeCssForPreview(css); } catch (e) { /* 退回本地替换 */ }
    }
    if (scoped === css) {
      /* 本地兜底：与 beautify 的 scopeCssForPreview 保持同样的规则 */
      scoped = css.replace(/#qq-room-([\w-]+)/g, '#mq-bf-preview-$1')
                   .replace(/#qq-room\b/g, '#mq-bf-preview-room');
    }
    /* 复用 beautify 的预览样式元素（id 是它定义的常量值）。
       自己另建一个 style 会出现两份预览样式叠加，后写的未必赢。 */
    var el = document.getElementById('mq-beautify-preview-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'mq-beautify-preview-style';
      document.body.appendChild(el);
    }
    el.textContent = scoped;

    /* 关键一步：给预览房间加上 .mq-has-custom-css。
     *
     * 为什么不加就不生效 —— 预览侧有一批默认样式挂在这个选择器下：
     *   #mq-bf-preview-room:not(.mq-has-custom-css) .qq-room__row--me .qq-room__bubble
     * 它的权重是 (2,2,1)，而我们编译产物是
     *   #mq-bf-preview-room .qq-room__row--me .qq-room__bubble   → (1,2,1)
     * 权重比人家低，加 !important 又违反本模块的硬约束②，
     * 于是我方气泡的底色会被默认样式稳稳压住 —— 现象就是「对方气泡变了色、
     * 我方气泡纹丝不动」。
     *
     * 正解与 hydrateCssPreview 一致：把这个类加上，那批 :not() 规则整体失效，
     * 预览回落到 miya-chat.css 的裸 .qq-room__bubble，我们的规则就赢了。
     * 注意这个类由 beautify 管，正常路径下它会自己加/删；我们这里只在
     * 「编辑区还没写、但预览要显示调色结果」的空档期接管一下。 */
    var room = (root || document).querySelector('[data-mq-bf-css-preview]');
    if (room) room.classList.add('mq-has-custom-css');
    return true;
  }

  /* 面板当前参数 → 只刷预览 */
  function refreshPreviewOnly(panel, root) {
    var css = compileCss(readParams(panel));
    previewOnly(root, css);
    return css;
  }

  /**
   * 绑定。由 MiyaChatBeautify.bindAtelierRoot 调用。
   *
   * 幂等守卫用 panel.dataset.mqBtBound —— 与 beautify 的 root.dataset.mqBfBound
   * 各自独立，互不影响。重绘后 DOM 是新的，dataset 标记随之丢失，
   * 于是会重新绑定并调 syncFromTextarea 把滑块摆回编辑区对应的值。
   */
  function bindTunerRoot(root) {
    if (!root) return;
    var panel = root.querySelector('[data-mq-bt-panel]');
    if (!panel) return;

    if (panel.dataset.mqBtBound) {
      /* 已绑定（同一次渲染内重复调用）：只对齐滑块与折叠态，不重复挂监听 */
      setOpen(panel, openState);
      watchTextarea(root);
      syncFromTextarea(root);
      return;
    }
    panel.dataset.mqBtBound = '1';

    /* 监听挂在 panel 上而不是 root —— 缩小范围，也避开 beautify 挂在 root 上的
       那套 data-mq-bf-* 委托。两边属性前缀不同，即便同一事件冒泡到各自 handler，
       也互不匹配。 */
    panel.addEventListener('click', function (e) { onClick(root, e); });
    panel.addEventListener('input', function (e) { onInput(root, e); });
    panel.addEventListener('change', function (e) { onChange(root, e); });

    /* 编辑区在 panel 之外，得单独挂 */
    watchTextarea(root);

    syncFromTextarea(root);
  }

  global.MiyaBubbleTuner = {
    GEN_MARK: GEN_MARK,
    DEFAULTS: DEFAULTS,
    SPEC: SPEC,
    COLOR_ITEMS: COLOR_ITEMS,
    SLIDER_ITEMS: SLIDER_ITEMS,
    BADGE_SLIDERS: BADGE_SLIDERS,
    TOTAL_ITEMS: TOTAL_ITEMS,
    PALETTES: PALETTES,
    BASIC_COLORS: BASIC_COLORS,
    normalizeParams: normalizeParams,
    compileCss: compileCss,
    parseCss: parseCss,
    isGenerated: isGenerated,
    clampNum: clampNum,
    isHex: isHex,
    fmtNum: fmtNum,
    esc: esc,
    /* 颜色计算 */
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    luminance: luminance,
    contrast: contrast,
    pickFg: pickFg,
    mostVivid: mostVivid,
    paletteToParams: paletteToParams,
    /* 面板 */
    buildPanelHtml: buildPanelHtml,
    applyParamsToPanel: applyParamsToPanel,
    readParams: readParams,
    setColorValue: setColorValue,
    closeAllPickers: closeAllPickers,
    togglePicker: togglePicker,
    refreshPreviewOnly: refreshPreviewOnly,
    previewOnly: previewOnly,
    bindTunerRoot: bindTunerRoot,
    syncFromCss: syncFromCss,
    syncFromTextarea: syncFromTextarea,
    watchTextarea: watchTextarea,
    setOpen: setOpen
  };
})(window);
