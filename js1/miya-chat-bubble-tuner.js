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
    return '<label class="mi-bt-color' + (optional ? ' mi-bt-color--opt' : '') + '">' +
      '<span class="mi-bt-color__name">' + esc(label) + '</span>' +
      (optional
        ? '<span class="mi-bt-color__hex" data-mq-bt-hex="' + key + '">默认</span>'
        : '') +
      '<input type="color" class="mi-bt-color__input" data-mq-bt="' + key + '"' +
        ' value="' + esc(DEFAULTS[key] || '#ffffff') + '"' +
        ' title="' + esc(label) + '">' +
    '</label>';
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
    H.push('<div class="mi-bt-grid">');
    COLOR_ITEMS.forEach(function (it) { H.push(colorHtml(it.key, it.label)); });
    H.push('</div>');
    H.push('<p class="mi-bt-note">描边色与聊天背景留空/白色即为「不额外指定」，沿用主题默认。</p>');
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
        /* 取色器不接受空串。空 = 不指定，用白色占位（用户不动它就不会被写进 CSS） */
        el.value = isHex(v) ? v : '#ffffff';
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
        /* 取色器返回小写 #rrggbb。约定：等于默认色的白/灰也照实写入，
           不做「等于默认就当空」的猜测 —— 那样用户真想要白色会写不进去。 */
        out[key] = String(el.value || '').toLowerCase();
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

  /* 刷新所有数值标签（label 里的 span） */
  function refreshLabels(panel) {
    if (!panel) return;
    panel.querySelectorAll('[data-mq-bt-val]').forEach(function (span) {
      var key = span.getAttribute('data-mq-bt-val');
      var el = panel.querySelector('[data-mq-bt="' + key + '"]');
      if (!el) return;
      var sp = SPEC[key] || { unit: '' };
      span.textContent = fmtNum(el.value) + sp.unit;
    });
    /* 可选色（描边/聊天背景）的 hex 读数：默认值是空串，
       用户没动过时显示「默认」，动过之后显示真实色值。 */
    panel.querySelectorAll('[data-mq-bt-hex]').forEach(function (span) {
      var key = span.getAttribute('data-mq-bt-hex');
      var el = panel.querySelector('[data-mq-bt="' + key + '"]');
      if (!el) return;
      var v = String(el.value || '').toLowerCase();
      var untouched = !DEFAULTS[key] && v === '#ffffff';
      span.textContent = untouched ? '默认' : v;
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
      return;
    }
  }

  /* 滑块拖动中只更新数值标签，松手（change）才刷预览 ——
     把 compileCss + 样式重算压在松手那一刻，拖动过程才不会卡。 */
  function onInput(root, e) {
    var panel = root.querySelector('[data-mq-bt-panel]');
    if (!panel) return;
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
    normalizeParams: normalizeParams,
    compileCss: compileCss,
    parseCss: parseCss,
    isGenerated: isGenerated,
    clampNum: clampNum,
    isHex: isHex,
    fmtNum: fmtNum,
    esc: esc,
    /* 面板 */
    buildPanelHtml: buildPanelHtml,
    applyParamsToPanel: applyParamsToPanel,
    readParams: readParams,
    bindTunerRoot: bindTunerRoot,
    syncFromCss: syncFromCss,
    syncFromTextarea: syncFromTextarea,
    watchTextarea: watchTextarea,
    setOpen: setOpen
  };
})(window);
