/**
 * miya-image-gen.js — 生图 API（OpenAI 兼容 / NovelAI）、预设、聊天与朋友圈集成
 */
(function (global) {
  'use strict';

  var PRESETS_KEY = 'miya-image-gen-presets-v1';
  var MAX_PRESETS = 24;

  /*
   * ── 尺寸预设 ──────────────────────────────────────────────────
   *
   * ⚠️ label 必须写**真实比例**。这里踩过一次坑，记录一下免得重蹈覆辙。
   *
   * 832x1216 常被当成「3:4」，但它实际是 13:19 ≈ 0.684 ——
   * 3:4 是 0.75，它比 3:4 更窄，严格说更接近 2:3（0.667）。
   * NovelAI 官方只把它称作 portrait（竖版），从没声称是 3:4。
   *
   * 那为什么现在列表里有 832x1216 又标「3:4」？——因为**这是错的**，
   * 本次已改正为 13:19，并把真正的 3:4 用 768x1024 补进来。
   *
   * 真 3:4 在「64 倍数、64–1600」约束下是**有解**的：
   * 768x1024 / 960x1280 / 1152x1536 都精确等于 0.75。
   * 同理真 4:3 用 1024x768 / 1280x960 即可。
   *
   * 各组顺序：竖版 → 正方形 → 横版。
   */

  /*
   * ── 尺寸方言（dialect）────────────────────────────────────────
   *
   * 关键认知：**决定尺寸约束的是你连的那个端点，不是 model 字段里的字符串。**
   *
   * 之前这里按模型名分类（看见 dall-e-3 就套 OpenAI 白名单、看见
   * gpt-image 就放行任意尺寸），这个做法有个致命前提：model 字段
   * 真的是 OpenAI 的模型名。
   *
   * 但**中转站把这个前提打破了** —— 中转站把 NovelAI 包成 OpenAI 形状时，
   * model 里填的是 `nai-diffusion-4-5-full` 这种 NovelAI 模型名。
   * 它一个都不匹配 `dall-e-*` / `gpt-image-*`，于是全部落到兜底的
   * 「认不出就放行」，校验等于空转；就算匹配上了，拿 OpenAI 的
   * 约束去卡 NovelAI 的模型也是错的。
   *
   * 所以改成**显式声明方言**：用户自己说清连的是什么，我们照对应规则办。
   * 这比猜准得多 —— 用户点两下就知道自己填的是哪个站。
   *
   *   generic   通用：宽高 64 倍数、64–1600。覆盖 NovelAI / SD
   *             系中转站，也是现在的默认（中转站是主流用法）
   *   dalle3    DALL·E 3：只认 1024x1024 / 1024x1792 / 1792x1024
   *   dalle2    DALL·E 2：只认 256/512/1024 正方形
   *   gptimage  GPT-Image：标准三档 + 任意 %16==0
   *   custom    自定义：完全不校验，原样发（给特殊中转站留后门）
   */
  var SIZE_DIALECTS = {
    GENERIC: 'generic',
    DALLE3: 'dalle3',
    DALLE2: 'dalle2',
    GPTIMAGE: 'gptimage',
    CUSTOM: 'custom'
  };

  /*
   * 各方言的可选尺寸。generic 直接复用 NovelAI 那套 ——
   * 因为它们约束完全相同（都是 64 倍数、64–1600），
   * NovelAI 尺寸集里已经含真 3:4（768x1024）和真 4:3（1024x768）。
   *
   * ⚠️ 2026-09 修正：generic 的候选集**收窄到比例白名单**。
   *
   * 原先这里放的是 NovelAI 全集，含 832x1216（13:19 ≈ 0.684）这类
   * **只有 NovelAI 自己认**的冷门比例。用户选中它 → 原样发给中转站
   * → 撞 aspect_ratio 白名单 → 400。下拉里能选到一个注定失败的值，
   * 是把 bug 摆在用户面前让他踩。
   *
   * 现在只保留三方（OpenAI / SD / NAI 中转站）交集里都会认的比例。
   * NovelAI 直连仍走它自己的全集（见 NOVELAI_SIZES），因为直连时
   * 832x1216 恰恰是官方标准档，收窄了反而错。
   */
  var GENERIC_SIZES = [
    /* 竖版：由窄到宽 */
    { v: '1024x1792', label: '9:16 竖版' },
    { v: '1024x1536', label: '2:3 竖版' },
    { v: '1024x1024', label: '1:1 正方形' },
    /* 横版：由窄到宽 */
    { v: '1536x1024', label: '3:2 横版' },
    { v: '1792x1024', label: '16:9 横版' }
  ];

  /*
   * NovelAI **直连**的尺寸全集。
   *
   * 与 GENERIC_SIZES 分开是有意的：直连 image.novelai.net 时，
   * 832x1216 是官方标准竖版档，必须留着；而走中转站时它是 400 的
   * 元凶。同一串数字在两个端点上的合法性不同 —— 这正是本文开头
   * 「决定尺寸约束的是端点，不是模型名」那句话的具体后果。
   */
  var NOVELAI_SIZES = [
    { v: '832x1216', label: '13:19 竖版（NovelAI 标准）' },
    { v: '1024x1536', label: '2:3 竖版' },
    { v: '768x1024', label: '3:4 竖版' },
    { v: '960x1280', label: '3:4 竖版（大）' },
    { v: '1024x1024', label: '1:1 正方形' },
    { v: '1472x1472', label: '1:1 正方形（高清）' },
    { v: '1024x768', label: '4:3 横版' },
    { v: '1280x960', label: '4:3 横版（大）' },
    { v: '1216x832', label: '19:13 横版（NovelAI 标准）' },
    { v: '1536x1024', label: '3:2 横版' }
  ];

  var DALLE3_SIZES = [
    { v: '1024x1792', label: '9:16 竖版' },
    { v: '1024x1024', label: '1:1 正方形' },
    { v: '1792x1024', label: '16:9 横版' }
  ];

  var DALLE2_SIZES = [
    { v: '1024x1024', label: '1:1 正方形' },
    { v: '512x512', label: '1:1 正方形（小）' },
    { v: '256x256', label: '1:1 正方形（极小）' }
  ];

  var GPTIMAGE_SIZES = [
    { v: '1024x1536', label: '2:3 竖版' },
    { v: '1024x1024', label: '1:1 正方形' },
    { v: '1536x1024', label: '3:2 横版' }
  ];

  function sizeDialectList(dialect) {
    var d = dialect || SIZE_DIALECTS.GENERIC;
    if (d === SIZE_DIALECTS.DALLE3) return DALLE3_SIZES;
    if (d === SIZE_DIALECTS.DALLE2) return DALLE2_SIZES;
    if (d === SIZE_DIALECTS.GPTIMAGE) return GPTIMAGE_SIZES;
    if (d === SIZE_DIALECTS.CUSTOM) return GENERIC_SIZES;
    return GENERIC_SIZES;
  }

  function normalizeSizeDialect(v) {
    var s = trim(v).toLowerCase();
    if (s === 'dalle3') return SIZE_DIALECTS.DALLE3;
    if (s === 'dalle2') return SIZE_DIALECTS.DALLE2;
    if (s === 'gptimage') return SIZE_DIALECTS.GPTIMAGE;
    if (s === 'custom') return SIZE_DIALECTS.CUSTOM;
    return SIZE_DIALECTS.GENERIC;
  }

  /*
   * 按方言校验并（在需要时）纠正尺寸。
   *
   * 返回 {size, changed, reason}：
   *   size    最终要发出去的尺寸
   *   changed 是否被改过（UI 可以据此提示用户）
   *   reason  改动的理由，用于拼提示文案
   *
   * 纠正策略按方言区分，因为「救回来」和「不要乱动」的取舍不同：
   *   generic / custom —— 用户可能填了非法数值，就近映射到合法尺寸，
   *                       因为这些站的规则明确（64 倍数 + 比例白名单），救得回来
   *   dalle2/3/gptimage —— **不纠正**。它们的尺寸是硬白名单，
   *                       猜错模型去替换，很可能改成另一个同样被拒的值，
   *                       不如原样发出去让服务端明确报错
   *
   * ⚠️ generic 是**双约束**：64 倍数 **和** 比例白名单。
   *
   * 曾经这里只用 normalizeNovelAiSize（单约束：64 倍数），
   * 结果 832x1216（13:19）这种「数值合法、比例冷门」的值被原样放行，
   * 撞中转站的 aspect_ratio 白名单吃 400。数值合法 ≠ 比例合法。
   */
  function resolveSizeForDialect(sizeStr, dialect) {
    var d = normalizeSizeDialect(dialect);
    var raw = trim(sizeStr);

    if (d === SIZE_DIALECTS.GENERIC) {
      return normalizeGenericSize(raw);
    }

    if (d === SIZE_DIALECTS.CUSTOM) {
      /* 自定义方言：不校验、不纠正，原样发 —— 这是给特殊站点留的后门 */
      return { size: raw || '1024x1024', changed: false, reason: '' };
    }

    /* 三个 OpenAI 方言：只校验，不纠正 */
    var legal = isOpenAiSizeLegal(raw, d);
    return {
      size: raw || '1024x1024',
      changed: false,
      reason: legal ? '' : '该尺寸不被所选方言接受，可能被服务端拒绝'
    };
  }

  /*
   * 兼容旧签名（按模型名判断）。
   *
   * ⚠️ 保留它只是为了不让外部调用炸掉，**不要在新代码里用** ——
   * 按模型名猜方言在接入中转站后是不可靠的（见 SIZE_DIALECTS 的说明）。
   * 新代码请用 resolveSizeForDialect(size, dialect)。
   */
  function isOpenAiSizeLegal(v, modelOrDialect) {
    var d = normalizeSizeDialect(modelOrDialect);
    var s = trim(v).toLowerCase();
    if (!s) return false;

    if (d === SIZE_DIALECTS.DALLE2) {
      return ['256x256', '512x512', '1024x1024'].indexOf(s) >= 0;
    }
    if (d === SIZE_DIALECTS.DALLE3) {
      return ['1024x1024', '1024x1792', '1792x1024'].indexOf(s) >= 0;
    }
    if (d === SIZE_DIALECTS.GPTIMAGE) {
      if (['1024x1024', '1024x1536', '1536x1024'].indexOf(s) >= 0) return true;
      var pg = parseSizeInput(s);
      return !!(pg && pg.w && pg.h && pg.w % 16 === 0 && pg.h % 16 === 0);
    }
    /* generic / custom：一律放行，具体约束在 resolveSizeForDialect 里处理 */
    return true;
  }

  var NOVELAI_MODELS = [
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-full',
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-3',
    'nai-diffusion-furry-3'
  ];

  var NOVELAI_SAMPLERS = [
    'k_euler_ancestral',
    'k_euler',
    'k_dpmpp_2m',
    'k_dpmpp_sde',
    'k_lms',
    'ddim_v3'
  ];

  /*
   * ── 比例 → 尺寸 对照表 ────────────────────────────────────────
   *
   * 用途：把「用户想要的比例」翻译成「该后端真正能出这个比例的那组像素」。
   *
   * 关键认知：比例和像素不是一回事，但**真比例是能精确命中的**。
   * 只要宽高都取 3 和 4 的公倍数（且是 64 的倍数），就能得到精确的 3:4：
   *   768x1024 / 960x1280 / 1152x1536 三个都精确等于 0.75。
   *
   * 别被 832x1216 误导 —— 它常被当成 3:4，实际是 13:19 ≈ 0.684，
   * 比 3:4 窄。表里 3:4 映射到 768x1024，那才是真 3:4。
   *
   * 适用于所有「64 倍数」约束的端点 —— NovelAI 直连、以及把 NovelAI/SD
   * 包成 OpenAI 形状的**中转站**（generic 方言）。
   *
   * 对 DALL·E 那几个硬白名单方言**不用这套**：它们的可选尺寸是固定的
   * 三两个值，悄悄替换会让用户以为自己选对了，不如让它报错。
   */
  var NOVELAI_SIZE_ALIASES = [
    { ratio: 3 / 4, v: '768x1024' },
    { ratio: 2 / 3, v: '1024x1536' },
    { ratio: 4 / 3, v: '1024x768' },
    { ratio: 3 / 2, v: '1536x1024' },
    { ratio: 1, v: '1024x1024' },
    { ratio: 9 / 16, v: '832x1216' },
    { ratio: 16 / 9, v: '1216x832' }
  ];

  /*
   * ── 中转站的比例白名单（generic 方言专用）──────────────────────
   *
   * ⚠️ 这一段是被真实 400 打出来的，不是推演：
   *
   *   POST https://api.rua.chat/v1/images/generations
   *   尺寸选了下拉里的「13:19 竖版（NovelAI 标准）」= 832x1216
   *   → HTTP 400
   *     {"error":{"message":"aspect_ratio 不受支持…",
   *               "type":"invalid_request_error"}}
   *
   * 关键认知：**中转站校验的是「比例」，不是「64 倍数」。**
   *
   * 旧的 normalizeNovelAiSize 只认 NovelAI 那一条规则（宽高各为 64 的
   * 倍数、64–1600），832x1216 完美通过 —— 于是被原样发出去，撞上
   * 中转站的比例白名单，400。数值合法 ≠ 比例合法，这是两件事。
   *
   * 832x1216 ≈ 0.684（13:19），这是个**只有 NovelAI 自己爱用**的冷门比例；
   * 主流白名单里根本没有这一档，所以它必然被判非法。
   *
   * 所以 generic 方言要**双约束**：先过 64 倍数，再过比例白名单。
   * 比例不在白名单里就吸附到最近的合法档 —— 用户表达的是「我要张竖图」，
   * 而不是「我要精确的 0.684」，就近吸附符合意图；硬顶着发出去只会 400。
   *
   * 白名单取的是 OpenAI / SD / NAI 三方**交集里最保守的一组**，
   * 覆盖 DALL·E 3、GPT-Image、SD 系、NAI 系中转站都会认的比例。
   */
  var GENERIC_RATIO_WHITELIST = [
    { ratio: 1, v: '1024x1024', label: '1:1 正方形' },
    { ratio: 2 / 3, v: '1024x1536', label: '2:3 竖版' },
    { ratio: 3 / 2, v: '1536x1024', label: '3:2 横版' },
    { ratio: 9 / 16, v: '1024x1792', label: '9:16 竖版' },
    { ratio: 16 / 9, v: '1792x1024', label: '16:9 横版' }
  ];

  /*
   * 比例吸附：把任意比例映射到白名单里最近的一档。
   *
   * 用**比例空间的相对差**而不是绝对差来比较 —— 因为 3:2 (1.5) 与
   * 16:9 (1.778) 的绝对差是 0.278，而 2:3 (0.667) 与 9:16 (0.563) 的
   * 绝对差只有 0.104，用绝对差会把竖版判断得比横版「更不准」，
   * 这是几何量的量纲问题。相对差能抵消掉这个不对称。
   *
   * 返回 { v, ratio, diff }，diff 是相对差，供调用方决定要不要提示用户。
   */
  function nearestGenericRatio(ratio) {
    var best = null;
    var bestDiff = Infinity;
    GENERIC_RATIO_WHITELIST.forEach(function (row) {
      var diff = Math.abs(row.ratio - ratio) / row.ratio;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = row;
      }
    });
    return best ? { v: best.v, ratio: best.ratio, label: best.label, diff: bestDiff } : null;
  }

  /*
   * generic 方言的尺寸解析：**先验 64 倍数，再验比例白名单**。
   *
   * 两步都不能省：
   *   · 只验 64 倍数  → 832x1216 这类冷门比例漏过去，撞 aspect_ratio 400（就是这次的 bug）
   *   · 只验比例白名单 → 数值本身可能不合法（如 500x750），被别家站点拒
   */
  function normalizeGenericSize(v) {
    var raw = trim(v);
    var p = parseSizeInput(raw);
    if (!p) return { size: '1024x1024', changed: raw !== '1024x1024', reason: '' };

    if (p.w && p.h) {
      var ok = function (n) { return n >= 64 && n <= 1600 && n % 64 === 0; };
      if (ok(p.w) && ok(p.h)) {
        /* 数值合法 → 再过比例白名单 */
        var hit = nearestGenericRatio(p.w / p.h);
        if (hit && hit.diff <= 0.02) {
          /* 已经是白名单内的比例（相对差 2% 内视为同一档），原样放行 */
          return { size: p.w + 'x' + p.h, changed: false, reason: '' };
        }
        if (hit) {
          /*
           * 比例冷门，但能吸附到白名单档位 —— 换掉。
           *
           * 阈值给得很宽（0.35）：这里的目标是「保证能出图」，
           * 而不是「精确还原用户的冷门比例」。因为比例白名单是站点
           * 硬约束，没有谈判空间：不发合法比例就是 400。
           */
          if (hit.diff <= 0.35) {
            return {
              size: hit.v,
              changed: true,
              reason: raw + ' 的比例（' + (p.w / p.h).toFixed(3) + '）不在中转站的比例白名单内，已就近调整为 ' + hit.label + '（' + hit.v + '）'
            };
          }
        }
      }
      p = { ratio: p.w / p.h };
    }

    if (p.ratio) {
      var hit2 = nearestGenericRatio(p.ratio);
      if (hit2) {
        return {
          size: hit2.v,
          changed: hit2.v !== raw,
          reason: hit2.v !== raw ? '已按比例映射到 ' + hit2.label + '（' + hit2.v + '）' : ''
        };
      }
    }
    return { size: '1024x1024', changed: raw !== '1024x1024', reason: '' };
  }

  /*
   * 把 "3:4" 或 "832x1216" 之类的输入统一解析成 {w,h}。
   * 解析不出来返回 null，由调用方决定怎么兜底。
   */
  function parseSizeInput(v) {
    var s = trim(v);
    if (!s) return null;
    var mx = s.match(/^(\d{2,5})\s*[x*×]\s*(\d{2,5})$/i);
    if (mx) {
      return { w: parseInt(mx[1], 10), h: parseInt(mx[2], 10) };
    }
    var mr = s.match(/^(\d{1,4})\s*[:：]\s*(\d{1,4})$/);
    if (mr) {
      return { ratio: parseInt(mr[1], 10) / parseInt(mr[2], 10) };
    }
    return null;
  }

  /*
   * 校验并纠正 NovelAI 尺寸。
   *
   * NovelAI 的硬约束：宽高都必须是 64 的倍数，且在 64–1600 之间。
   * 违反约束的请求会被服务端直接拒绝，所以这里先兜一层，
   * 尽量把一个「能表达意图但数值非法」的尺寸救回来。
   */
  function normalizeNovelAiSize(v) {
    var p = parseSizeInput(v);
    if (!p) return '1024x1024';
    if (p.w && p.h) {
      var ok = function (n) { return n >= 64 && n <= 1600 && n % 64 === 0; };
      if (ok(p.w) && ok(p.h)) return p.w + 'x' + p.h;
      /* 数值非法就按它想表达的比例去对照表里找替身 */
      p = { ratio: p.w / p.h };
    }
    if (p.ratio) {
      var best = null;
      var bestDiff = Infinity;
      NOVELAI_SIZE_ALIASES.forEach(function (row) {
        var diff = Math.abs(row.ratio - p.ratio);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = row.v;
        }
      });
      /* 偏差超过 8% 就不硬凑了 —— 那已经不是「同一个比例」，
         随便塞一个反而会误导用户以为是自己选的那个比例 */
      if (best && bestDiff <= 0.08) return best;
    }
    return '1024x1024';
  }

  /*
   * ⚠️ 这里**曾经**还有一个「按模型名判断」的 isOpenAiSizeLegal（第二份同名定义）。
   *
   * 它是个隐蔽的坑：JS 函数声明会提升，同名函数后者覆盖前者 ——
   * 结果是下面那份显式方言版被这份旧版悄悄顶掉，dialect 被当成模型名去
   * 匹配 /^dall-e-/，永远匹配不上，一律 return true，**校验完全空转**。
   * 已删除。若将来要加校验规则，请改上面 dialect 版那一个。
   */

  var REF_LEGAL_NOTE =
    '参考图仅针对支持图片输入的模型生效。严禁上传无版权、无授权的图片信息；严禁未经他人允许上传他人肖像信息。';

  /*
   * ── 垫图（图生图）的两种「程度」───────────────────────────────
   *
   * 用户要的是「两种都给，界面上可切」。这里先把两档的**语义**定死，
   * 因为两档在两条协议上的实现路径完全不同：
   *
   *   style（参考风格）
   *     只借垫图的画风/配色/氛围，画面内容仍由文字描述决定。
   *     提示词上要靠引导语（STYLE_PROMPT_HINT）来约束；
   *     强度不宜高，否则内容会被垫图带跑。
   *
   *   redraw（照着重画）
   *     让输出贴近垫图的构图与主体，文字描述只做局部修饰。
   *     需要较高强度，提示词上也要改成「保持构图」的说法。
   *
   * ⚠️ 两档只在**支持强度的协议（NovelAI）**上有数值差异。
   * OpenAI 兼容那条走 /images/edits，协议里根本没有强度字段 ——
   * 那就只能靠提示词引导来区分两档，这是协议的硬限制，不是实现偷懒。
   */
  var REF_MODE_STYLE = 'style';
  var REF_MODE_REDRAW = 'redraw';

  /* 两档各自的强度与提示词引导语。缺省档 = style。 */
  var REF_MODE_PRESETS = {
    style: {
      strength: 0.45,
      hint: 'reference image is for art style, color palette and mood reference only, do not copy its composition'
    },
    redraw: {
      strength: 0.75,
      hint: 'closely follow the composition, pose and subject layout of the reference image'
    }
  };

  function normalizeRefMode(v) {
    return trim(v) === REF_MODE_REDRAW ? REF_MODE_REDRAW : REF_MODE_STYLE;
  }

  function refModePreset(mode) {
    return REF_MODE_PRESETS[normalizeRefMode(mode)] || REF_MODE_PRESETS[REF_MODE_STYLE];
  }

  /*
   * 把垫图引导语拼到提示词尾部。
   *
   * 只在**确实带垫图**时调用 —— 没有垫图却加一句「参考这张图」，
   * 纯文生图的模型会去编一张不存在的参考图，画面反而更差。
   */
  function appendRefHint(prompt, mode) {
    var hint = refModePreset(mode).hint;
    var base = trim(prompt);
    if (!hint) return base;
    return base ? base + ', ' + hint : hint;
  }

  var presetsCache = null;
  var presetsReady = null;
  var inFlight = Object.create(null);
  /*
   * 「尺寸已被自动调整」的提示只弹一次。
   * 批量生图时每次请求都弹一遍会变成刷屏，反而盖住真正的错误。
   */
  var sizeChangeNotified = false;

  function trim(s) {
    return String(s == null ? '' : s).trim();
  }

  function toast(msg) {
    if (typeof global.miyaToast === 'function') {
      global.miyaToast(msg);
      return;
    }
    if (global.miyaChatApp && global.miyaChatApp.toast) {
      global.miyaChatApp.toast(msg);
      return;
    }
    var div = document.createElement('div');
    div.className = 'ins-toast';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 2400);
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function defaultImageGenConfig() {
    return {
      enabled: false,
      provider: 'openai',
      positivePrompt: '',
      negativePrompt: '',
      size: '1024x1024',
      openai: {
        baseUrl: '',
        apiKey: '',
        model: '',
        /*
         * 尺寸方言。
         *
         * 默认 generic（通用）而不是 dalle3 —— 因为**中转站是现在的主流用法**，
         * 而 generic 的规则（64 倍数、64–1600）恰好覆盖 NovelAI/SD 系中转站。
         * 直连 OpenAI 官方的人自己知道自己的模型，会主动去改；
         * 而中转站用户如果默认被套上 dall-e-3 的三尺寸白名单，
         * 会直接选不到自己要的比例，且完全不知道为什么。
         */
        sizeDialect: 'generic'
      },
      novelai: {
        baseUrl: 'https://image.novelai.net',
        apiKey: '',
        model: 'nai-diffusion-4-5-full',
        sampler: 'k_euler_ancestral',
        steps: 28,
        scale: 5,
        sm: false,
        smDyn: false,
        /*
         * ── 以下两项为解决「直连 NovelAI 失败」而加 ──────────────
         *
         * proxyUrl：部分网络/浏览器下直连 image.novelai.net 会被 CORS
         *   拦成 "Failed to fetch"。填一个反向代理地址即可绕过，
         *   请求会打到 `{proxyUrl}/ai/generate-image`。
         *   留空 = 直连（默认行为，与改动前一致）。
         *
         * translateCjk：是否启用中文→Danbooru 标签翻译。
         *   默认**开启** —— 因为角色卡里的外貌描述基本都是中文，
         *   不翻译的话 NovelAI 基本看不懂。关了它就回到改动前的行为。
         */
        proxyUrl: '',
        translateCjk: true,
        seed: -1
      }
    };
  }

  function normalizeImageGenConfig(raw) {
    var d = defaultImageGenConfig();
    if (!raw || typeof raw !== 'object') return d;
    var out = Object.assign({}, d, raw);
    out.provider = out.provider === 'novelai' ? 'novelai' : 'openai';
    out.enabled = !!out.enabled;
    out.positivePrompt = trim(out.positivePrompt).slice(0, 4000);
    out.negativePrompt = trim(out.negativePrompt).slice(0, 4000);
    var sz = trim(out.size);
    out.size = sz || d.size;
    var oa = raw.openai && typeof raw.openai === 'object' ? raw.openai : {};
    out.openai = {
      baseUrl: trim(oa.baseUrl),
      apiKey: trim(oa.apiKey),
      model: trim(oa.model),
      sizeDialect: normalizeSizeDialect(oa.sizeDialect)
    };
    var na = raw.novelai && typeof raw.novelai === 'object' ? raw.novelai : {};
    var steps = parseInt(na.steps, 10);
    var scale = parseFloat(na.scale);
    var seedRaw = parseInt(na.seed, 10);
    out.novelai = {
      baseUrl: trim(na.baseUrl) || d.novelai.baseUrl,
      apiKey: trim(na.apiKey),
      model: trim(na.model) || d.novelai.model,
      sampler: trim(na.sampler) || d.novelai.sampler,
      steps: Number.isFinite(steps) ? Math.min(50, Math.max(1, steps)) : d.novelai.steps,
      scale: Number.isFinite(scale) ? Math.min(10, Math.max(0, scale)) : d.novelai.scale,
      sm: !!na.sm,
      smDyn: !!(na.smDyn != null ? na.smDyn : na.sm_dyn),
      proxyUrl: trim(na.proxyUrl).replace(/\/+$/, ''),
      /*
       * translateCjk 默认 true。
       *
       * 这里不能用 `!!na.translateCjk` —— 老配置里这个字段不存在，
       * 会得到 false，把新功能默认关掉。必须显式判断「是否 === false」：
       * 只有用户主动关掉才关，字段缺失一律视为开启。
       */
      translateCjk: na.translateCjk !== false,
      seed: Number.isFinite(seedRaw) ? seedRaw : d.novelai.seed
    };
    return out;
  }

  function normalizeContactImageGen(raw) {
    if (!raw || typeof raw !== 'object') {
      return { enabled: false, customPrompt: '', refUrl: '', refBlobId: null };
    }
    return {
      enabled: !!raw.enabled,
      customPrompt: trim(raw.customPrompt).slice(0, 4000),
      refUrl: trim(raw.refUrl),
      refBlobId: raw.refBlobId ? String(raw.refBlobId) : null
    };
  }

  function getApiConfig() {
    return typeof global.miyaGetApiConfigCached === 'function' ? global.miyaGetApiConfigCached() : {};
  }

  function getImageGenConfig() {
    var cfg = getApiConfig();
    return normalizeImageGenConfig(cfg.imageGen);
  }

  function saveImageGenConfig(patch) {
    var cur = getImageGenConfig();
    var next = normalizeImageGenConfig(Object.assign({}, cur, patch || {}));
    if (patch && patch.openai) next.openai = Object.assign({}, cur.openai, patch.openai);
    if (patch && patch.novelai) next.novelai = Object.assign({}, cur.novelai, patch.novelai);
    if (typeof global.miyaSetApiConfig === 'function') {
      global.miyaSetApiConfig({ imageGen: next });
    }
    return next;
  }

  function isGlobalEnabled() {
    var cfg = getImageGenConfig();
    if (!cfg.enabled) return false;
    if (cfg.provider === 'novelai') {
      return !!(cfg.novelai.apiKey && cfg.novelai.model);
    }
    return !!(cfg.openai.baseUrl && cfg.openai.apiKey && cfg.openai.model);
  }

  function getStore() {
    return global.miyaChatStore || null;
  }

  function findChatByContactId(contactId) {
    var st = getStore();
    if (!st || typeof st.findChatByContact !== 'function') return null;
    return st.findChatByContact(String(contactId || '').trim()) || null;
  }

  function getContactImageGenSettings(contactId) {
    var cid = String(contactId || '').trim();
    if (!cid) return normalizeContactImageGen(null);
    var st = getStore();
    if (!st) return normalizeContactImageGen(null);
    var chat = findChatByContactId(cid);
    if (!chat) return normalizeContactImageGen(null);
    var settings = st.getChatSettings(chat.id) || {};
    return normalizeContactImageGen(settings.imageGen);
  }

  function isContactEnabled(contactId) {
    if (!isGlobalEnabled()) return false;
    return !!getContactImageGenSettings(contactId).enabled;
  }

  function parseSize(sizeStr) {
    var s = trim(sizeStr);
    var m = s.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!m) return { width: 1024, height: 1024 };
    return { width: parseInt(m[1], 10) || 1024, height: parseInt(m[2], 10) || 1024 };
  }

  function openAiCompatibleApiRoot(base) {
    var t = trim(base).replace(/\/+$/, '');
    if (!t) return '';
    try {
      var u = new URL(t);
      var path = (u.pathname || '/').replace(/\/+$/, '');
      var segs = path.split('/').filter(Boolean);
      if (segs.length && segs[segs.length - 1].toLowerCase() === 'v1') return u.origin + path;
      if (!path || path === '/') return u.origin + '/v1';
      return u.origin + path + '/v1';
    } catch (e) {
      return t.toLowerCase().endsWith('/v1') ? t : t + '/v1';
    }
  }

  /*
   * ── 端点解析 ──────────────────────────────────────────────────
   *
   * 支持三种情况：
   *   1. 配了 proxyUrl → `{proxyUrl}/ai/generate-image`（绕 CORS）
   *   2. baseUrl 已经带完整路径 → 原样用
   *   3. 只给了域名 → 拼 /ai/generate-image
   *
   * proxyUrl 优先级最高：用户填它就是为了绕开直连问题，
   * 此时忽略 baseUrl 才符合直觉。
   */
  function novelAiEndpoint(base, proxyUrl) {
    var proxy = trim(proxyUrl).replace(/\/+$/, '');
    if (proxy) {
      if (/\/ai\/generate-image$/i.test(proxy)) return proxy;
      return proxy + '/ai/generate-image';
    }
    var t = trim(base).replace(/\/+$/, '');
    if (!t) t = 'https://image.novelai.net';
    if (/\/ai\/generate-image$/i.test(t)) return t;
    return t + '/ai/generate-image';
  }

  /* 模型是否属于 V4 系列（决定用哪套参数模板） */
  function isNovelAiV4(model) {
    return /^nai-diffusion-4/i.test(trim(model));
  }

  /*
   * ── 中文提示词翻译 ────────────────────────────────────────────
   *
   * 依赖 js2/miya-image-gen-dict.js。那个模块可能还没加载
   * （脚本顺序、懒加载等原因），所以这里做存在性判断：
   * 翻译器不可用就原样返回，绝不因为缺个可选模块而让生图失败。
   */
  function translatePromptIfNeeded(prompt, enabled) {
    var src = trim(prompt);
    if (!enabled || !src) return src;
    var dict = global.MiyaImageGenDict;
    if (!dict || typeof dict.translate !== 'function') return src;
    try {
      return dict.translate(src);
    } catch (e) {
      /* 翻译出错不该阻断生图 —— 退回原文，宁可用中文也别不出图 */
      return src;
    }
  }

  function extractPersonaAppearance(contact) {
    if (!contact) return '';
    var persona = trim(contact.persona || contact.description || '');
    if (!persona) {
      var parts = [contact.background, contact.personality, contact.appearance, contact.other]
        .map(trim)
        .filter(Boolean);
      persona = parts.join('；');
    }
    if (!persona) return '';
    var slice = persona.slice(0, 600);
    return slice.replace(/\s+/g, ' ').trim();
  }

  function resolveContactGenderKey(contact) {
    if (!contact) return '';
    var g = trim(contact.gender).toLowerCase();
    if (!g) return '';
    if (/^(男|男性|男生|男人|boy|male|m)$/i.test(g) || /男/.test(g)) return 'male';
    if (/^(女|女性|女生|女人|girl|female|f)$/i.test(g) || /女/.test(g)) return 'female';
    return '';
  }

  function buildGenderPromptTags(contact) {
    var key = resolveContactGenderKey(contact);
    if (key === 'male') {
      return {
        positive: '1boy, male, man',
        negative: '1girl, female, woman, feminine, breasts'
      };
    }
    if (key === 'female') {
      return {
        positive: '1girl, female, woman',
        negative: '1boy, male, man, masculine, beard'
      };
    }
    return { positive: '', negative: '' };
  }

  /*
   * 把多个提示词片段拼成标签串，并**按标签去重**。
   *
   * ── 为什么需要去重 ────────────────────────────────────────────
   *
   * 三个来源会自然地写出重复标签：
   *   · 用户在设置里填的固定正向词：masterpiece, best quality
   *   · 本函数尾部硬编码的画质兜底词：masterpiece, best quality, ...
   *   · 角色卡里的外貌描述，有时也会写画质词
   *
   * 重复标签在 NovelAI 里等于**隐式加权** —— 出现两次就会被强调两遍，
   * 可能把画面带偏（比如过度锐化、风格失真）。而且白占 token。
   *
   * 去重规则：
   *   · 按逗号切分，逐段 trim 后归一化比较（忽略大小写与多余空格）
   *   · 保留**首次出现**的位置和原文，保持提示词顺序稳定
   *   · 多词标签整体比较（`best quality` 是一个单位，不会被拆成
   *     `best` 和 `quality` 分别去重）
   */
  function dedupeTags(parts) {
    var seen = Object.create(null);
    var out = [];
    var joined = (parts || []).filter(Boolean).join(', ');
    var items = joined.split(',');
    for (var i = 0; i < items.length; i++) {
      var tag = trim(items[i]);
      if (!tag) continue;
      var key = tag.toLowerCase().replace(/\s+/g, ' ');
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(tag);
    }
    return out.join(', ');
  }

  function buildPromptBundle(contactId, sceneDesc) {
    var cfg = getImageGenConfig();
    var contact = null;
    var st = getStore();
    if (st && contactId) contact = st.findContact(contactId);
    var cImg = getContactImageGenSettings(contactId);
    var genderTags = buildGenderPromptTags(contact);
    var posParts = [];
    if (cfg.positivePrompt) posParts.push(cfg.positivePrompt);
    if (genderTags.positive) posParts.push(genderTags.positive);
    if (cImg.customPrompt) {
      posParts.push(cImg.customPrompt);
    } else {
      var personaHint = extractPersonaAppearance(contact);
      if (personaHint) posParts.push(personaHint);
    }
    var scene = trim(sceneDesc);
    if (scene) posParts.push(scene);
    posParts.push('masterpiece, best quality, highly detailed, coherent composition, natural lighting');
    var negParts = [];
    if (cfg.negativePrompt) negParts.push(cfg.negativePrompt);
    if (genderTags.negative) negParts.push(genderTags.negative);
    negParts.push('lowres, bad anatomy, bad hands, blurry, watermark, text, logo, cropped, worst quality');
    return {
      positive: dedupeTags(posParts),
      negative: dedupeTags(negParts)
    };
  }

  function dataUrlToBase64(dataUrl) {
    var s = String(dataUrl || '');
    var i = s.indexOf(',');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /*
   * ── dataUrl → Blob（multipart 垫图必需）──────────────────────
   *
   * /images/edits **只收 multipart 文件上传**，文件字段必须是一个真的
   * Blob/File（带 MIME、带 filename），扔 base64 字符串进去服务端不认。
   *
   * 所以这里要能把垫图的 dataUrl 还原成二进制。js2/miya-storage.js 里
   * 有个同名的 dataUrlToBlob，但它没挂到全局，本文件拿不到 —— 与其去
   * 改另一个模块的导出面（牵动备份/序列化那条链路），不如就地实现，
   * 二十行、零依赖、出问题也只影响本文件。
   */
  function dataUrlMime(dataUrl) {
    var m = String(dataUrl || '').match(/^data:([^;,]+)/i);
    return m ? m[1] : 'image/png';
  }

  function dataUrlToBlob(dataUrl) {
    var s = String(dataUrl || '');
    var comma = s.indexOf(',');
    if (comma < 0) return null;
    var b64 = s.slice(comma + 1);
    try {
      var bin = atob(b64);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: dataUrlMime(s) });
    } catch (e) {
      return null;
    }
  }

  /* 按 MIME 猜个扩展名 —— 有的网关会拿 filename 后缀判断类型。 */
  function extFromMime(mime) {
    var m = String(mime || '').toLowerCase();
    if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'jpg';
    if (m.indexOf('webp') >= 0) return 'webp';
    return 'png';
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      if (!blob) return reject(new Error('no_blob'));
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('read_failed')); };
      fr.readAsDataURL(blob);
    });
  }

  function resolveReferenceDataUrl(contactId) {
    var cImg = getContactImageGenSettings(contactId);
    if (cImg.refUrl) return Promise.resolve(cImg.refUrl);
    if (!cImg.refBlobId) return Promise.resolve('');
    var st = getStore();
    if (!st || typeof st.getAvatarUrl !== 'function') return Promise.resolve('');
    return st.getAvatarUrl(cImg.refBlobId).catch(function () { return ''; });
  }

  function fetchOpenAiModels(base, key) {
    var root = openAiCompatibleApiRoot(base);
    if (!root) return Promise.reject(new Error('empty_base'));
    return fetch(root + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + trim(key) }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!Array.isArray(j.data)) return [];
      return j.data.map(function (x) { return x && x.id ? String(x.id) : ''; }).filter(Boolean).sort();
    });
  }

  function extractFirstImageBlobFromZip(arrayBuffer) {
    if (!global.JSZip) return Promise.reject(new Error('jszip_missing'));
    return global.JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var names = Object.keys(zip.files || {}).filter(function (n) {
        var f = zip.files[n];
        return f && !f.dir && /\.(png|jpg|jpeg|webp)$/i.test(n);
      });
      if (!names.length) throw new Error('zip_empty');
      return zip.files[names[0]].async('blob');
    });
  }

  function generateOpenAi(opts) {
    var cfg = getImageGenConfig();
    var root = openAiCompatibleApiRoot(cfg.openai.baseUrl);
    if (!root || !cfg.openai.apiKey || !cfg.openai.model) {
      return Promise.reject(new Error('openai_not_configured'));
    }
    /*
     * 尺寸按用户声明的**方言**处理。
     *
     * 这一步是给中转站兜底的：中转站把 NovelAI 包成 OpenAI 形状，
     * 尺寸约束继承的是 NovelAI 那套（64 倍数、64–1600），
     * 而不是 OpenAI 的三尺寸白名单。generic 方言就干这个 ——
     * 用户填了 742x990 这类非法值会就近映射到合法尺寸，
     * 而不是原样发出去撞一个 400。
     */
    var sizeResolved = resolveSizeForDialect(
      trim(opts.size || cfg.size),
      cfg.openai.sizeDialect
    );
    var size = sizeResolved.size || '1024x1024';
    /*
     * 尺寸被纠正过就明确告诉用户，避免「所见非所用」。
     *
     * 这条提示是通用化时顺手补上的：generic 方言现在会做比例吸附，
     * 用户选了 832x1216 实际发的是 1024x1536 —— 不提示的话，
     * 用户会以为「我选的尺寸没生效」，反过来报一个假 bug。
     * 只提示一次（本次会话内），不刷屏。
     */
    if (sizeResolved.changed && sizeResolved.reason && !sizeChangeNotified) {
      sizeChangeNotified = true;
      toast(sizeResolved.reason);
    }
    var payload = {
      model: cfg.openai.model,
      prompt: trim(opts.prompt),
      n: 1,
      size: size,
      response_format: 'b64_json'
    };
    if (trim(opts.negative)) payload.negative_prompt = trim(opts.negative);

    function callGenerations() {
      return fetch(root + '/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.openai.apiKey
        },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.text().then(function (t) {
          if (!r.ok) throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 160) : ''));
          var j;
          try { j = JSON.parse(t); } catch (e) { throw new Error('invalid_json'); }
          var item = j.data && j.data[0];
          if (!item) throw new Error('empty_image');
          if (item.b64_json) {
            var bin = atob(item.b64_json);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new Blob([u8], { type: 'image/png' });
          }
          if (item.url) {
            return fetch(item.url).then(function (imgR) {
              if (!imgR.ok) throw new Error('url_fetch_failed');
              return imgR.blob();
            });
          }
          throw new Error('no_image_data');
        });
      });
    }

    if (opts.referenceDataUrl) {
      /*
       * ── 垫图必须走 multipart，这是协议要求，不是口味问题 ──────────
       *
       * 原先这里发的是 `Content-Type: application/json` + `image: <base64>`。
       * 但 /images/edits **官方只收 multipart/form-data**：
       *   Azure 官方文档原话「The Image Edit API takes multipart/form
       *   data, not JSON data.」，示例是 -F "image[]=@beach.png"；
       *   OpenAI 开发者社区对同类报错的答复也是同一句
       *   「explicitly requires multipart form data with the image
       *   provided as an actual file upload」。
       *
       * 后果是：只要带垫图就 400，然后静默回退纯文生图 —— 用户看到
       * 一张图，跟垫图毫无关系，只会以为「垫图功能坏了」。实际上
       * OpenAI 这条路径上的垫图**一次都没成功过**。
       *
       * 现在的策略是「multipart 优先，JSON 兜底」：
       *
       *   1. 先按官方形状发 multipart（单张图用单数 `image` 文件字段）；
       *   2. 若返回形状类错误（4xx），再按 JSON 发一次 ——官方 JSON 形状
       *      的字段名是 `images`（数组），给那些改写过 edits 的中转站
       *      另附 image / image_url 两种土写法；
       *   3. 两次都拿不到图，才 markFellBack() 回退纯文生图并告知用户。
       *
       * 之所以不「JSON 优先」，是因为官方路径是绝大多数情况，把它放
       * 第一位能让正常用户少一次必然失败的往返。
       */
      var refBlob = dataUrlToBlob(opts.referenceDataUrl);

      function editError(msg) {
        var e = new Error(msg);
        e.miyaEditShapeError = true;
        return e;
      }

      /* 把一次 fetch 响应解析成 Blob；拿不到图就抛（带形状标记）。 */
      function parseEditResponse(r, tag) {
        return r.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (e) { j = null; }
          if (!r.ok) {
            throw editError(tag + '_http_' + r.status + (t ? ': ' + t.slice(0, 160) : ''));
          }
          var item = j && j.data && j.data[0];
          if (item && item.b64_json) {
            var bin = atob(item.b64_json);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new Blob([u8], { type: 'image/png' });
          }
          if (item && item.url) {
            return fetch(item.url).then(function (imgR) {
              if (!imgR.ok) throw editError(tag + '_url_fetch_failed');
              return imgR.blob();
            });
          }
          throw editError(tag + '_no_image_data');
        });
      }

      /* 路径一：官方 multipart 形状。 */
      function callEditsMultipart() {
        /*
         * 垫图二进制都解不出来（dataUrl 损坏）就直接放弃这条路径，
         * 交给 JSON 兜底试一把。
         */
        if (!refBlob) return Promise.reject(editError('ref_decode_failed'));
        var fd = new FormData();
        var mime = refBlob.type || 'image/png';
        var fname = 'reference.' + extFromMime(mime);
        /*
         * ⚠️ 只发**一个** image 字段名，且用单数 `image`。
         *
         * 踩过的坑，记下来免得后人再试：一开始想「image[] 和 image 都塞上，
         * 多出来的服务端会忽略」—— 这个假设是错的。OpenAI 对重复字段名是
         * **严格报错**，实测结论是 "repeated image is rejected with
         * duplicate_parameter"（langchain4j 那个 PR 里跑了真机验证）。
         * 两个都塞的结果是 multipart 必然 400，每次都白白多走一次 JSON 兜底。
         *
         * 单张图用单数 `image`（langchain4j 的实测口径：single-image uses
         * field name `image`；多张才用 repeated `image[]`）。我们只传一张，
         * 所以单数就对了。
         */
        fd.append('image', refBlob, fname);
        fd.append('model', cfg.openai.model);
        fd.append('prompt', trim(opts.prompt));
        fd.append('n', '1');
        fd.append('size', size);
        /*
         * response_format 只对 dall-e-2 有意义，GPT-Image 系列会**拒绝**
         * 这个字段。我们无法在这里可靠地判断模型代际，就没必要冒这个险 ——
         * GPT-Image 本来就总是返回 base64，少发这个字段不影响我们取图。
         * （parseEditResponse 同时认 b64_json 和 url，两种返回都能吃下。）
         */
        /* ⚠️ 不要手动设 Content-Type：boundary 由浏览器生成。 */
        return fetch(root + '/images/edits', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.openai.apiKey },
          body: fd
        }).then(function (r) { return parseEditResponse(r, 'multipart'); });
      }

      /* 路径二：JSON 兜底（给只认 JSON 的中转站留后路）。 */
      function callEditsJson() {
        /*
         * ⚠️ JSON 形状的字段名是 **images（数组）**，不是 image；
         * 而且数组元素是**对象**，不是裸字符串。官方示例逐字如下：
         *
         *   "images": [ { "image_url": "https://example.com/source-image.png" } ]
         *
         * 这两个坑我都踩过一次，记在这里：
         *   · 形状：edits 的主路径是 multipart，JSON 只是备选 —— 旧实现
         *     把它当主路径发，就已经偏了；
         *   · 字段名：旧实现发 `image: <base64>`，那是 multipart 那边的
         *     名字，官方明确说 "Do not use the multipart field name image"；
         *   · 元素类型：elements 是 {image_url|file_id} 对象，扔裸字符串
         *     同样不被接受。
         *
         * 三条全错，所以旧实现在这条路径上从没成功过。
         *
         * 后面额外带上 image / image_url 两个土写法，是给中转站留的 ——
         * JSON 多几个未知键通常会被忽略，风险远小于 multipart 那边
         * （multipart 的重复字段名是硬报错，见上面 callEditsMultipart）。
         */
        var refDataUrl = String(opts.referenceDataUrl || '');
        var editPayload = {
          model: cfg.openai.model,
          prompt: trim(opts.prompt),
          n: 1,
          size: size,
          /* 官方 JSON 形状：对象数组，元素用 image_url 引用 */
          images: [{ image_url: refDataUrl }],
          image: dataUrlToBase64(refDataUrl),
          image_url: refDataUrl
        };
        return fetch(root + '/images/edits', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + cfg.openai.apiKey
          },
          body: JSON.stringify(editPayload)
        }).then(function (r) { return parseEditResponse(r, 'json'); });
      }

      /*
       * ── 兜底的兜底：JSON 那条只在「形状被拒」时才试 ──────────────
       *
       * 如果 multipart 是**网络层**就挂了（断网、跨域被拦、超时），
       * 换成 JSON 大概率也是同样的网络错误 —— 白白多发一次请求，
       * 还让用户多等一个超时。只有服务端明确回了错误（拿到了 HTTP
       * 响应，说明网络是通的，只是请求形状它不认），才值得换姿势再试。
       */
      return callEditsMultipart()
        .catch(function (err) {
          if (err && err.miyaEditShapeError) return callEditsJson();
          throw err;
        })
        .catch(function () { return markFellBack(callGenerations()); });
    }
    return callGenerations();
  }

  /*
   * 给回退出来的 Blob 盖个章，供 UI 判断要不要提示用户。失败不影响主流程。
   *
   * 做法是在 Blob 上挂属性而不是改返回类型 —— 返回类型是 Blob，调用方有
   * 聊天、朋友圈、测试生图、自由生图四处，改类型会牵连一大片。Blob 是对象，
   * 挂个额外属性不影响它照常当 Blob 用。
   */
  function markFellBack(promise) {
    return Promise.resolve(promise).then(function (blob) {
      try { if (blob && typeof blob === 'object') blob.miyaRefFellBack = true; } catch (e) {}
      return blob;
    });
  }

  /*
   * ── NovelAI V4 / V3 参数模板 ──────────────────────────────────
   *
   * 两代模型的参数结构**不兼容**，混用会直接被服务端拒掉（HTTP 500）。
   * 关键差异：
   *
   *   V4（nai-diffusion-4-*）
   *     · params_version = 3
   *     · ucPreset = 3（新版负面预设）
   *     · noise_schedule = 'karras'
   *     · 需要 v4_prompt / v4_negative_prompt 结构（V4 用它做正负向描述）
   *     · **SMEA 不支持** —— 传了会被忽略，个别情况还会触发 500，
   *       所以这里强制关掉，并给出 console 提示
   *
   *   V3 及更早（nai-diffusion-3 / furry-3 / 2 / 1）
   *     · params_version = 1
   *     · ucPreset = 0
   *     · noise_schedule = 'native'
   *     · 无 v4_prompt 系列字段
   *     · SMEA 正常生效，跟随用户设置
   *
   * 两套模板都把 `add_original_image` / `cfg_rescale` / `legacy` 等
   * 固定值写死，避免用户误配导致出图异常。
   */
  function buildNovelAiParameters(na, dim, prompt, negative, seed) {
    var v4 = isNovelAiV4(na.model);
    var params = {
      width: dim.width,
      height: dim.height,
      scale: na.scale,
      sampler: na.sampler,
      steps: na.steps,
      n_samples: 1,
      seed: seed,
      negative_prompt: trim(negative) || '',
      qualityToggle: true,
      add_original_image: true,
      cfg_rescale: 0,
      controlnet_strength: 1,
      legacy: false,
      dynamic_thresholding: false,
      /*
       * skip_cfg_above_sigma = null 是 NovelAI 的默认值。
       * V4 下服务端会按模型内置值处理；V3 下同样接受 null。
       * 显式写出来是因为部分代理/网关会对缺失字段报错。
       */
      skip_cfg_above_sigma: null
    };

    if (v4) {
      if (na.sm || na.smDyn) {
        console.warn('[MiyaImageGen] NovelAI V4 模型不支持 SMEA，已自动关闭（模型：' + na.model + '）');
      }
      params.params_version = 3;
      params.ucPreset = 3;
      params.noise_schedule = 'karras';
      /* V4 下 SMEA 相关字段一律为 false，见上方说明 */
      params.sm = false;
      params.sm_dyn = false;
      /*
       * V4 的双通道提示词结构。
       *
       * base_caption 才是真正生效的正向描述；
       * char_captions 用于多角色分别描述（这里单角色，留空）。
       * 负向同理。不传这两个字段的话，V4 会退化成只读 input，
       * 负向词完全失效。
       */
      params.v4_prompt = {
        caption: { base_caption: prompt, char_captions: [] },
        use_coords: false,
        use_order: true
      };
      params.v4_negative_prompt = {
        caption: { base_caption: trim(negative) || '', char_captions: [] },
        use_coords: false,
        use_order: true
      };
      /* V4 的多角色与参考图扩展字段，单角色场景留空数组即可 */
      params.characterPrompts = [];
      params.negativeCharacterPrompts = [];
      params.use_coords = false;
      params.prefer_brownian = true;
      params.deliberate_euler_ancestral_bug = false;
    } else {
      params.params_version = 1;
      params.ucPreset = 0;
      params.noise_schedule = 'native';
      params.sm = !!na.sm;
      params.sm_dyn = !!na.smDyn;
      params.legacy_v3_extend = false;
    }

    return params;
  }

  /*
   * 退避等待。
   *
   * 单独抽出来是为了让重试逻辑读起来清楚，
   * 也方便将来换成带抖动的退避策略。
   */
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /*
   * 把 HTTP 状态码翻译成人能看懂的提示。
   *
   * 之前只有一个「HTTP 4xx: 原始报文」，用户看不懂也不知道怎么办。
   * 这几个码是 NovelAI 最常见且**各有明确处置方式**的：
   *   401 → 去设置里改 Key
   *   402 → 去续费 / 等 Anlas 恢复
   *   429 → 等一会儿再试（下面会自动重试）
   *   500 → 参数不兼容，换模型或换分辨率
   */
  function describeNovelAiHttpError(status, bodyText, model) {
    var detail = trim(bodyText).slice(0, 150);
    var v4 = isNovelAiV4(model);
    switch (status) {
      case 401:
        return new Error('NovelAI API Key 无效或已过期，请到设置里重新填写');
      case 402:
        return new Error('NovelAI 订阅已过期或 Anlas 点数不足，请检查账户状态');
      case 429:
        return new Error('请求过于频繁，请稍后再试');
      case 500:
        return new Error(
          'NovelAI 服务器内部错误 (500, ' + (v4 ? 'V4' : 'V3') + ' 模型)。' +
            '可能是该模型与当前参数不兼容，建议切换模型或调整分辨率。' +
            (detail ? ' 详情：' + detail : '')
        );
      default:
        return new Error('NovelAI API 错误 (HTTP ' + status + ')' + (detail ? '：' + detail : ''));
    }
  }

  /*
   * 发起一次生成请求，带自动重试。
   *
   * 重试策略：
   *   · 429（限流）→ 重试，退避 3s / 6s / 9s 递增（3000 × attempt）
   *   · 网络错误（TypeError: Failed to fetch 等）→ 重试，
   *     退避 2s / 4s / 6s 递增（2000 × attempt），**与 429 不是同一套步长**
   *   · 401 / 402 / 500 → **不重试**。这些是配置或参数问题，
   *     重试一百次结果一样，只会让用户多等
   *   · 最多 3 次
   *
   * 返回 Response；全部失败则抛最后一次的错误。
   */
  function requestNovelAiWithRetry(url, apiKey, body, opts) {
    opts = opts || {};
    var maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 3;
    var useProxy = !!opts.useProxy;
    var lastErr = null;
    var attempt = 0;

    function once() {
      attempt += 1;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        body: JSON.stringify(body)
      })
        .then(function (r) {
          if (r.ok) return r;
          /*
           * 限流：可重试。其它 4xx/5xx 直接抛出，不浪费时间。
           */
          if (r.status === 429 && attempt < maxAttempts) {
            var wait = 3000 * attempt;
            console.warn(
              '[MiyaImageGen] NovelAI 限流 (429)，' + wait + 'ms 后重试（第 ' + attempt + '/' + maxAttempts + ' 次）'
            );
            return sleep(wait).then(once);
          }
          return r.text().then(function (t) {
            throw describeNovelAiHttpError(r.status, t, body.model);
          });
        })
        .catch(function (err) {
          lastErr = err;
          /*
           * 已经是我们自己包装过的 HTTP 错误 → 不再重试。
           * 只有网络层错误（TypeError: Failed to fetch 等）才值得重试。
           */
          var isHttpError = /^NovelAI /.test(String(err && err.message || ''));
          if (isHttpError || attempt >= maxAttempts) throw err;

          var wait = 2000 * attempt;
          console.warn(
            '[MiyaImageGen] NovelAI 网络错误（第 ' + attempt + '/' + maxAttempts + ' 次）：' +
              (err && err.message) + '，' + wait + 'ms 后重试'
          );
          return sleep(wait).then(once);
        });
    }

    return once().catch(function (err) {
      /*
       * 网络错误且没配代理 → 补一句可操作的提示。
       *
       * "Failed to fetch" 对普通用户毫无信息量，但它几乎总是 CORS 问题，
       * 而解法就是填个代理地址。这里直接把话说明白。
       */
      var msg = String((lastErr && lastErr.message) || (err && err.message) || '');
      if (!useProxy && /failed to fetch|network|load failed/i.test(msg)) {
        throw new Error(
          '网络错误：无法连接 NovelAI（' + msg + '）。' +
            '若持续出现，请在生图设置里填写「反向代理地址」绕过 CORS 限制。'
        );
      }
      throw lastErr || err;
    });
  }

  /*
   * ── 生成主流程 ────────────────────────────────────────────────
   *
   * 改动前后行为差异一览：
   *
   *   [新增] 中文提示词自动翻译成 Danbooru 标签（可用 translateCjk 关掉）
   *   [新增] proxyUrl 走反向代理
   *   [新增] V4/V3 参数模板分流，V4 补上 v4_prompt 结构
   *   [新增] 429 / 网络错误自动重试
   *   [新增] 401/402/500 给可操作的错误提示
   *   [变更] seed 可配（-1 = 随机）
   *
   * ⚠️ 提示词**不在这里拼接**。
   *
   * buildPromptBundle 已经把正向词（cfg.positivePrompt）、性别标签、
   * 角色设定、场景描述、画质词全部拼好了，负向词同理。
   * 这里再拼一次 cfg.positivePrompt 会导致「masterpiece」重复三遍 ——
   * 既浪费 token，还可能因为权重叠加把画面带偏。
   *
   * 本函数对提示词的唯一职责是：**翻译中文**。
   */
  function generateNovelAi(opts) {
    var cfg = getImageGenConfig();
    var na = cfg.novelai;
    if (!na.apiKey || !na.model) return Promise.reject(new Error('novelai_not_configured'));
    /*
     * 尺寸先过一道 NovelAI 的合法性纠正：
     * 宽高必须是 64 的倍数、且在 64–1600 内，否则服务端直接拒绝。
     * 用户若填了「看着像 3:4 但数值非法」的尺寸（如 768x1024），
     * 这里会就近映射到 832x1216，而不是原样发出去撞报错。
     */
    var dim = parseSize(normalizeNovelAiSize(opts.size || cfg.size));

    /*
     * 中文翻译。
     *
     * opts.prompt 是 buildPromptBundle 拼好的完整正向串，
     * 里面的中文部分（角色外貌描述、场景描述）需要转成 Danbooru 标签；
     * 已经是英文的标签会被翻译器原样放过（它的「不足 2 个汉字就返回原串」
     * 规则保证了这一点）。
     */
    var finalPrompt = translatePromptIfNeeded(opts.prompt, na.translateCjk);
    var finalNegative = trim(opts.negative);

    /*
     * seed：-1 表示随机，与 NovelAI 官方约定一致。
     * 落到具体数值时用 32 位无符号范围，避免超出服务端接受的范围。
     */
    var seed =
      na.seed === -1 || !Number.isFinite(na.seed)
        ? Math.floor(Math.random() * 4294967295)
        : na.seed;

    var params = buildNovelAiParameters(na, dim, finalPrompt, finalNegative, seed);
    var body = {
      input: finalPrompt,
      model: na.model,
      action: 'generate',
      parameters: params
    };

    if (opts.referenceDataUrl) {
      body.parameters.reference_image_multiple = [dataUrlToBase64(opts.referenceDataUrl)];
      /*
       * 强度改成可传参，但**缺省必须与改动前逐字节一致（0.6）**。
       *
       * 这条路上跑着两个功能：
       *   · 角色的「外观参考图」（老功能，从来不传 referenceStrength）
       *   · 自由生图的垫图（新功能，按 style/redraw 两档传值）
       * 老功能不传参时落到 0.6，行为与从前一模一样；
       * 新功能才用得上自定义强度。
       */
      var refStrength = parseFloat(opts.referenceStrength);
      body.parameters.reference_strength_multiple = [
        Number.isFinite(refStrength) ? Math.min(1, Math.max(0, refStrength)) : 0.6
      ];
      /*
       * V4 需要平行的 information_extracted 数组。留空数组即可 ——
       * 传具体数值反而会因为长度不匹配被拒。
       */
      if (isNovelAiV4(na.model)) {
        body.parameters.reference_information_extracted_multiple = [];
      }
      body.parameters.add_original_image = true;
    }

    var url = novelAiEndpoint(na.baseUrl, na.proxyUrl);

    return requestNovelAiWithRetry(url, na.apiKey, body, {
      useProxy: !!na.proxyUrl,
      maxAttempts: 3
    }).then(function (r) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('json') >= 0) {
        return r.json().then(function (j) {
          if (j && j.image) {
            var bin = atob(j.image);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new Blob([u8], { type: 'image/png' });
          }
          throw new Error('invalid_novelai_json');
        });
      }
      return r.arrayBuffer().then(function (buf) {
        if (ct.indexOf('zip') >= 0 || ct.indexOf('octet-stream') >= 0) {
          return extractFirstImageBlobFromZip(buf);
        }
        return new Blob([buf], { type: 'image/png' });
      });
    });
  }

  function ensureApiConfigReady() {
    if (typeof global.miyaEnsureApiConfigHydrated === 'function') {
      return global.miyaEnsureApiConfigHydrated();
    }
    return Promise.resolve();
  }

  /*
   * ── 把 raw HTTP 错误翻译成「用户能据此行动」的话 ────────────────
   *
   * 改动起因：用户报告「nai 模型报 400，gptimage2.5 正常」，
   * 而界面上只显示一句被截断的
   *
   *   生图 API 返回错误：HTTP 400: {"error":{"message":"aspect_ratio 不受支…
   *
   * 三个问题叠在一起，让这条错误完全没法用：
   *
   *   1. **截断点选错了**。原来截 120 字符，恰好把 message 的后半句
   *      「支持的比例：[…]」切掉 —— 而那正是唯一有用的信息。
   *      这次排查为此多花了整整一轮往返。
   *
   *   2. **不区分责任方**。400（我配错了）/ 429（站点限流）/
   *      500 503（站点自己挂了）在界面上长得一模一样，用户根本
   *      不知道该改配置还是该换个模型等一会儿。用户这次的截图
   *      里 2 条 503 + 5 条 429 + 3 条 500，全是站点的锅，
   *      但界面只会显示「生图 API 返回错误」。
   *
   *   3. **不说下一步做什么**。错误信息必须给出动作 —— 换模型、
   *      等一会儿、还是去改尺寸。
   *
   * ⚠️ 关于截断长度的取舍：这里放宽到 300 字符，并把 message 字段
   * **优先单独抽出来**。因为中转站的错误体是结构化 JSON，
   * 关键信息都在 message 里；按整串截断会被前面的
   * {"error":{"message": 这段样板文字白吃掉一大截预算。
   */
  function extractApiErrorDetail(text) {
    var t = trim(text);
    if (!t) return '';
    try {
      var j = JSON.parse(t);
      var msg = j && j.error && (j.error.message || j.error.msg);
      if (!msg && j && typeof j.message === 'string') msg = j.message;
      if (msg) {
        var extra = j && j.error && j.error.param ? '（参数：' + j.error.param + '）' : '';
        return trim(msg) + extra;
      }
    } catch (e) {}
    /* 不是 JSON（HTML 错误页 / 纯文本网关提示）→ 原样返回，交给下面截断 */
    return t;
  }

  function formatImageGenHttpError(code) {
    var m = String(code).match(/^HTTP\s+(\d{3})\s*(?::\s*([\s\S]*))?$/);
    if (!m) return null;
    var status = parseInt(m[1], 10);
    var detail = extractApiErrorDetail(m[2] || '');
    var shown = detail ? '：' + detail.slice(0, 300) : '';

    if (status === 400) {
      /*
       * 400 里最常见的是比例不合法。识别出关键词就直说解法，
       * 不要让用户去猜「aspect_ratio 不受支持」是什么意思。
       */
      if (/aspect_ratio|aspect ratio|不支持的?尺寸|size .*not supported|invalid size/i.test(detail)) {
        return '生图失败：该尺寸的比例不被当前接口接受。' +
          '请到生图设置里换一个「图片尺寸」（推荐 1:1 正方形 或 2:3 竖版），' +
          '或改用 gpt-image 系列模型。' + shown;
      }
      return '生图失败：接口认为请求参数不合法。请检查模型名、尺寸是否被该站支持。' + shown;
    }
    if (status === 401 || status === 403) {
      return '生图失败：密钥无效或无权访问该模型，请到生图设置里重新填写密钥。' + shown;
    }
    if (status === 402) {
      return '生图失败：账户余额 / 点数不足，请检查站点账户状态。' + shown;
    }
    if (status === 404) {
      return '生图失败：该站点没有这个接口或模型。' +
        '请确认网关地址是否要带 /v1，以及模型名是否在该站的可用列表里。' + shown;
    }
    if (status === 429) {
      return '生图失败：请求过于频繁（429 限流），站点账号池可能已耗尽。' +
        '请稍后再试，或换用 gpt-image 系列模型。' + shown;
    }
    if (status >= 500) {
      /*
       * 5xx 一律是**站点的锅**，要把这句话说清楚。
       * 用户这次的截图正是 503/500 扎堆 —— 他需要知道这跟自己
       * 的配置无关，等着或者换模型就行，反复重试和改配置都是白费。
       */
      return '生图失败：站点服务器异常（HTTP ' + status + '），' +
        '这是服务端问题、与你的配置无关。建议换用 gpt-image 系列模型，或稍后再试。' + shown;
    }
    return '生图 API 返回错误：HTTP ' + status + shown;
  }

  function formatImageGenError(err) {
    var code = err && err.message ? String(err.message) : '';
    if (code === 'image_gen_disabled' || code === 'openai_not_configured' || code === 'novelai_not_configured') {
      return '生图配置未加载或已失效，请到设置里重新保存生图配置后再试';
    }
    if (code === 'contact_disabled') return '该联系人未开启生图';
    if (code === 'empty_prompt') return '图片描述为空，无法生图';
    if (code === 'invalid_novelai_json') return 'NovelAI 返回的数据格式异常，请稍后重试';
    /*
     * 新的 NovelAI 错误本身就是**可读的中文句子**
     * （如「NovelAI API Key 无效或已过期，请到设置里重新填写」），
     * 直接透传即可，不要再套一层「生图失败：」把它埋掉。
     */
    if (/^NovelAI |^网络错误：/.test(code)) return code;
    var httpMsg = formatImageGenHttpError(code);
    if (httpMsg) return httpMsg;
    if (code) return '生图失败：' + code.slice(0, 300);
    return '生图失败，请检查配置与网络';
  }

  function generateImageForScene(contactId, sceneDesc, overrides) {
    overrides = overrides && typeof overrides === 'object' ? overrides : {};
    return ensureApiConfigReady().then(function () {
      if (!isGlobalEnabled()) return Promise.reject(new Error('image_gen_disabled'));
      if (contactId && !overrides.skipContactCheck && !isContactEnabled(contactId)) {
        return Promise.reject(new Error('contact_disabled'));
      }
      var cfg = getImageGenConfig();
      var bundle = buildPromptBundle(contactId, sceneDesc);
      if (!trim(bundle.positive)) return Promise.reject(new Error('empty_prompt'));
      var refPromise = overrides.referenceDataUrl != null
        ? Promise.resolve(overrides.referenceDataUrl)
        : resolveReferenceDataUrl(contactId);
      return refPromise.then(function (refUrl) {
        /*
         * 垫图引导语在这里拼，而不是在调用方拼 ——
         * 调用方（自由生图）传的是用户输入的原话，不该让它去操心
         * 「提示词体系里该怎么表达垫图」；这里是唯一知道提示词全貌的地方。
         */
        var positive = refUrl ? appendRefHint(bundle.positive, overrides.referenceMode) : bundle.positive;
        var req = {
          prompt: positive,
          negative: bundle.negative,
          size: overrides.size || cfg.size,
          referenceDataUrl: refUrl || ''
        };
        /* 强度只在调用方明确要时透传；不传时下游各自落到与从前一致的缺省值 */
        if (overrides.referenceStrength != null) req.referenceStrength = overrides.referenceStrength;
        if (cfg.provider === 'novelai') return generateNovelAi(req);
        return generateOpenAi(req);
      });
    });
  }

  function storeImageBlob(blob) {
    var st = getStore();
    if (!st || typeof st.storeMediaBlob !== 'function') return Promise.reject(new Error('store_missing'));
    return st.storeMediaBlob(blob, 'chat').then(function (blobId) {
      /*
       * ── 生图成功的提示音，在这里收口 ─────────────────────────────
       *
       * 为什么选这里：storeImageBlob 是**聊天生图**与**朋友圈配图**
       * 两条成功路径的公共出口（失败路径走不到这儿），
       * 挂在这里就等于一次性覆盖两处，不用在 5 个 .then(blob) 里各抄一遍
       * —— 抄多了一定会漏，漏的那个场景就会「有时候没声」。
       *
       * 注意时机：必须在**真正入库成功之后**再响。
       * 如果放在 generateImageForScene 的 resolve 里，那么
       * 「图下来了但存不进 IndexedDB」这种情况下照样会响 ——
       * 用户听到声响、抬头一看界面上是失败提示，那声提示音就成了噪音。
       */
      maybePlayImageGenDone();
      return blobId;
    });
  }

  /*
   * 播生图成功的提示音。
   *
   * 走 MiyaMsgSound.playForImageGenDone() 而不是 play()：
   * 这个音是「你等的图好了」的反馈，受总开关控制，
   * 但**不该**被「聊天室正开着就不响」那条新消息抑制规则挡掉 ——
   * 生成时用户本来就盯着屏幕等，正需要这一声。
   *
   * 整个调用包在 try 里：提示音是锦上添花，
   * 音频 API 在部分浏览器/隐私模式下会直接抛错，绝不能因此把出图搞失败。
   */
  function maybePlayImageGenDone() {
    try {
      if (global.MiyaMsgSound && typeof global.MiyaMsgSound.playForImageGenDone === 'function') {
        global.MiyaMsgSound.playForImageGenDone();
      }
    } catch (e) {}
  }

  function markChatMessagePending(chatId, msgId) {
    var st = getStore();
    if (!st) return Promise.resolve();
    return st.updateMessage(chatId, msgId, { imageGenPending: true, imageGenFailed: false }).then(function () {
      if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId &&
        global.miyaChatRoom.getOpenChatId() === chatId &&
        typeof global.miyaChatRoom.patchMessageBubble === 'function') {
        global.miyaChatRoom.patchMessageBubble(msgId);
      }
    });
  }

  function finalizeChatMessage(chatId, msgId, blobId, caption) {
    var st = getStore();
    if (!st) return Promise.resolve();
    return st.updateMessage(chatId, msgId, {
      type: 'image',
      imageKind: 'photo',
      imageDataKey: blobId,
      imageGenPending: false,
      imageGenFailed: false
    }).then(function () {
      if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId &&
        global.miyaChatRoom.getOpenChatId() === chatId &&
        typeof global.miyaChatRoom.patchMessageBubble === 'function') {
        global.miyaChatRoom.patchMessageBubble(msgId);
      }
    });
  }

  function markChatMessageFailed(chatId, msgId) {
    var st = getStore();
    if (!st) return Promise.resolve();
    return st.updateMessage(chatId, msgId, { imageGenPending: false, imageGenFailed: true }).then(function () {
      if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId &&
        global.miyaChatRoom.getOpenChatId() === chatId &&
        typeof global.miyaChatRoom.patchMessageBubble === 'function') {
        global.miyaChatRoom.patchMessageBubble(msgId);
      }
    });
  }

  function extractSceneFromChatMessage(msg) {
    if (!msg || msg.type !== 'image') return '';
    if (msg.imageKind === 'text' || (!msg.imageDataKey && trim(msg.content))) {
      return trim(msg.content).replace(/^图片[-－—]\s*/, '');
    }
    return '';
  }

  function canGenerateChatMessage(chatId, msg) {
    if (!msg || msg.role !== 'assistant') return false;
    if (msg.imageDataKey || msg.imageGenFailed) return false;
    var scene = extractSceneFromChatMessage(msg);
    if (!scene) return false;
    var st = getStore();
    if (!st) return false;
    var chat = st.findChat(chatId);
    if (!chat || chat.type === 'group') return false;
    return isContactEnabled(chat.contactId);
  }

  function shouldAutoGenerateChatMessage(chatId, msg) {
    if (!msg || msg.imageDataKey) return false;
    if (msg.imageGenPending) return true;
    if (msg.imageGenFailed) return false;
    return canGenerateChatMessage(chatId, msg);
  }

  function abortChatMessageGeneration(chatId, msgId) {
    return markChatMessageFailed(chatId, msgId).then(function () {
      return false;
    });
  }

  function processChatMessage(chatId, msg) {
    if (!msg || msg.role !== 'assistant') return Promise.resolve(false);
    if (msg.imageDataKey) return Promise.resolve(false);
    var st = getStore();
    if (!st) return Promise.resolve(false);
    var live = typeof st.findMessage === 'function' ? st.findMessage(chatId, msg.id) : msg;
    msg = live || msg;
    if (msg.imageDataKey) return Promise.resolve(false);
    if (!canGenerateChatMessage(chatId, msg) && !msg.imageGenPending) return Promise.resolve(false);
    var scene = extractSceneFromChatMessage(msg);
    if (!scene) {
      if (msg.imageGenPending) return abortChatMessageGeneration(chatId, msg.id);
      return Promise.resolve(false);
    }
    var chat = st.findChat(chatId);
    if (!chat || chat.type === 'group') {
      if (msg.imageGenPending) return abortChatMessageGeneration(chatId, msg.id);
      return Promise.resolve(false);
    }
    var key = chatId + ':' + msg.id;
    if (inFlight[key]) return inFlight[key];
    var pendingStep = msg.imageGenPending ? Promise.resolve() : markChatMessagePending(chatId, msg.id);
    inFlight[key] = pendingStep
      .then(function () {
        return generateImageForScene(chat.contactId, scene);
      })
      .then(function (blob) {
        return storeImageBlob(blob).then(function (blobId) {
          if (!blobId) throw new Error('store_failed');
          return finalizeChatMessage(chatId, msg.id, blobId, scene);
        });
      })
      .then(function () {
        delete inFlight[key];
        return true;
      })
      .catch(function (err) {
        return markChatMessageFailed(chatId, msg.id).then(function () {
          delete inFlight[key];
          toast(formatImageGenError(err));
          return false;
        });
      });
    return inFlight[key];
  }

  function retryChatMessage(chatId, msgId) {
    var st = getStore();
    if (!st || !chatId || !msgId) return Promise.resolve(false);
    var msg = typeof st.findMessage === 'function' ? st.findMessage(chatId, msgId) : null;
    if (!msg || msg.imageDataKey) return Promise.resolve(false);
    var key = chatId + ':' + msgId;
    delete inFlight[key];
    return st.updateMessage(chatId, msgId, { imageGenFailed: false, imageGenPending: false })
      .then(function (next) {
        return processChatMessage(chatId, next || msg);
      });
  }

  function processAssistantMessages(chatId, msgs) {
    if (!isGlobalEnabled()) return Promise.resolve();
    var list = Array.isArray(msgs) ? msgs : [];
    var eligible = list.filter(function (m) {
      return canGenerateChatMessage(chatId, m);
    });
    if (!eligible.length) return Promise.resolve();
    return Promise.all(eligible.map(function (m) {
      return markChatMessagePending(chatId, m.id);
    })).then(function () {
      var chain = Promise.resolve();
      eligible.forEach(function (m) {
        chain = chain.then(function () {
          return processChatMessage(chatId, m);
        });
      });
      return chain;
    });
  }

  function resumeChatImageGeneration(chatId) {
    if (!isGlobalEnabled()) return Promise.resolve();
    var st = getStore();
    if (!st || typeof st.getMessages !== 'function') return Promise.resolve();
    var chat = st.findChat(chatId);
    if (!chat || chat.type === 'group') return Promise.resolve();
    var msgs = st.getMessages(chatId) || [];
    var pending = [];
    var stuckPending = [];
    msgs.forEach(function (m) {
      if (!m || m.role !== 'assistant' || m.imageDataKey) return;
      if (m.imageGenFailed) return;
      if (m.imageGenPending) {
        stuckPending.push(m);
        return;
      }
      if (canGenerateChatMessage(chatId, m)) pending.push(m);
    });
    if (!pending.length && !stuckPending.length) return Promise.resolve();
    var chain = Promise.resolve();
    pending.forEach(function (m) {
      chain = chain.then(function () {
        return markChatMessagePending(chatId, m.id).then(function () {
          return processChatMessage(chatId, m);
        });
      });
    });
    stuckPending.forEach(function (m) {
      chain = chain.then(function () {
        delete inFlight[chatId + ':' + m.id];
        return processChatMessage(chatId, m);
      });
    });
    return chain;
  }

  function updateMomentPostMedia(postId, mutator) {
    if (!global.MiyaChatMoments || typeof global.MiyaChatMoments.mutatePostMedia !== 'function') {
      return Promise.reject(new Error('moments_missing'));
    }
    return global.MiyaChatMoments.mutatePostMedia(postId, mutator);
  }

  function refreshMomentFeed(postId) {
    if (global.MiyaChatMoments && typeof global.MiyaChatMoments.refreshFeedUI === 'function') {
      global.MiyaChatMoments.refreshFeedUI({ postId: postId, mediaChanged: true });
    }
  }

  function momentMediaKey(postId, idx) {
    return 'mom:' + postId + ':' + idx;
  }

  function markMomentMediaPending(postId, idx) {
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx].imageGenPending = true;
      p.media[idx].imageGenFailed = false;
    }).then(function () {
      refreshMomentFeed(postId);
    });
  }

  function markMomentMediaFailed(postId, idx) {
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx].imageGenPending = false;
      p.media[idx].imageGenFailed = true;
    }).then(function () {
      refreshMomentFeed(postId);
    });
  }

  function finalizeMomentMedia(postId, idx, blobId, blob, desc) {
    var summary = trim(desc);
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx] = {
        kind: 'real-image',
        imageKey: blobId,
        mime: blob.type || 'image/png',
        sourceDesc: summary,
        visionSummary: summary
      };
    }).then(function () {
      refreshMomentFeed(postId);
    });
  }

  function shouldProcessMomentMediaItem(m) {
    return !!(m && m.kind === 'text-image' && trim(m.textImageDesc) && !m.imageGenFailed);
  }

  function processMomentMediaItem(postId, contactId, idx, desc) {
    var key = momentMediaKey(postId, idx);
    if (inFlight[key]) return inFlight[key];
    inFlight[key] = markMomentMediaPending(postId, idx)
      .then(function () {
        return generateImageForScene(contactId, desc);
      })
      .then(function (blob) {
        return storeImageBlob(blob).then(function (blobId) {
          if (!blobId) throw new Error('store_failed');
          return finalizeMomentMedia(postId, idx, blobId, blob, desc);
        });
      })
      .catch(function (err) {
        toast(formatImageGenError(err));
        return markMomentMediaFailed(postId, idx).then(function () { return false; });
      })
      .then(function (result) {
        delete inFlight[key];
        return result !== false;
      });
    return inFlight[key];
  }

  function processMomentTextImages(postId, contactId) {
    if (!isContactEnabled(contactId)) return Promise.resolve(false);
    var postKey = 'mom:' + postId;
    if (inFlight[postKey]) return inFlight[postKey];
    inFlight[postKey] = updateMomentPostMedia(postId, function () {})
      .then(function (post) {
        if (!post || !Array.isArray(post.media)) return false;
        var tasks = [];
        post.media.forEach(function (m, idx) {
          if (!shouldProcessMomentMediaItem(m)) return;
          tasks.push(processMomentMediaItem(postId, contactId, idx, trim(m.textImageDesc)));
        });
        if (!tasks.length) return false;
        return Promise.all(tasks).then(function () { return true; });
      })
      .catch(function () {
        return false;
      })
      .then(function (result) {
        delete inFlight[postKey];
        return result;
      });
    return inFlight[postKey];
  }

  function retryMomentMediaItem(postId, mediaIdx) {
    var idx = parseInt(mediaIdx, 10);
    if (!postId || !Number.isFinite(idx) || idx < 0) return Promise.resolve(false);
    var post = global.MiyaChatMoments && typeof global.MiyaChatMoments.findPost === 'function'
      ? global.MiyaChatMoments.findPost(postId)
      : null;
    if (!post || post.authorType !== 'role') return Promise.resolve(false);
    var contactId = String(post.authorId || '').trim();
    if (!contactId || !isContactEnabled(contactId)) return Promise.resolve(false);
    var m = post.media && post.media[idx];
    if (!m || m.kind !== 'text-image' || !trim(m.textImageDesc)) return Promise.resolve(false);
    var desc = trim(m.textImageDesc);
    delete inFlight[momentMediaKey(postId, idx)];
    return updateMomentPostMedia(postId, function (p) {
      if (!p.media || !p.media[idx]) return;
      p.media[idx].imageGenFailed = false;
      p.media[idx].imageGenPending = false;
    }).then(function () {
      return processMomentMediaItem(postId, contactId, idx, desc);
    });
  }

  function resumeMomentsImageGeneration() {
    if (!isGlobalEnabled()) return Promise.resolve();
    if (!global.MiyaChatMoments || typeof global.MiyaChatMoments.whenReady !== 'function') {
      return Promise.resolve();
    }
    return global.MiyaChatMoments.whenReady().then(function () {
      var posts = typeof global.MiyaChatMoments.getPosts === 'function'
        ? global.MiyaChatMoments.getPosts()
        : [];
      var chain = Promise.resolve();
      posts.forEach(function (post) {
        if (!post || post.authorType !== 'role') return;
        var contactId = String(post.authorId || '').trim();
        if (!contactId || !isContactEnabled(contactId)) return;
        if (!Array.isArray(post.media)) return;
        var needs = post.media.some(function (m) { return shouldProcessMomentMediaItem(m); });
        if (!needs) return;
        chain = chain.then(function () {
          return processMomentTextImages(post.id, contactId);
        });
      });
      return chain;
    });
  }

  function runTestGeneration(previewEl, btnEl) {
    if (!previewEl) return Promise.resolve();
    var cfg = getImageGenConfig();
    var testPrompt = trim(cfg.positivePrompt) || 'a serene landscape, soft morning light, cinematic';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '生成中…';
    }
    previewEl.innerHTML = '<div class="miya-ig-test miya-ig-test--busy"><span class="miya-ig-test__spin"></span><p>生成中…</p></div>';
    return generateImageForScene('', testPrompt, { skipContactCheck: true, referenceDataUrl: '' })
      .then(function (blob) {
        /* 这两条路径不经过 storeImageBlob（用完即弃、不入库），所以单独响一次 */
        maybePlayImageGenDone();
        return blobToDataUrl(blob).then(function (url) {
          previewEl.innerHTML = '<div class="miya-ig-test miya-ig-test--done"><img src="' + esc(url) + '" alt="测试生图"></div>';
        });
      })
      .catch(function (err) {
        previewEl.innerHTML = '<div class="miya-ig-test miya-ig-test--err"><p>' + esc(formatImageGenError(err)) + '</p></div>';
      })
      .then(function () {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.textContent = '测试生图';
        }
      });
  }

  /* 自由生图：不绑定联系人，直接按用户输入的画面描述出图。
     复用 generateImageForScene('', prompt, { skipContactCheck: true })，
     提示词仍会带上全局正向/反向提示词与画质标签。

     垫图（图生图）也挂在这里 —— 见下方 freeGenState.ref* 三个字段。 */
  var freeGenState = {
    blob: null,
    prompt: '',
    busy: false,
    /* 垫图：原图 blob（用于预览与重新编码）、它的 dataURL（发请求用）、档位 */
    refBlob: null,
    refDataUrl: '',
    refMode: REF_MODE_STYLE,
    /* 上一次生成是否走了回退（未真正用上垫图），供 UI 提示 */
    lastFellBack: false
  };

  function renderFreePreview(html) {
    var el = document.getElementById('miya-st-ig-free-preview');
    if (el) el.innerHTML = html;
  }

  function renderFreeIdle() {
    renderFreePreview('<div class="miya-ig-test miya-ig-test--idle"><p>输入描述后点击「生成图片」</p></div>');
  }

  function getFreePrompt() {
    var el = document.getElementById('miya-st-ig-free-prompt');
    return el ? trim(el.value) : '';
  }

  function getFreeSize() {
    var el = document.getElementById('miya-st-ig-free-size');
    var v = el ? trim(el.value) : '';
    return v || getImageGenConfig().size;
  }

  function setFreeBusy(busy) {
    freeGenState.busy = !!busy;
    var run = document.getElementById('miya-st-ig-free-run');
    if (run) {
      run.disabled = !!busy;
      run.textContent = busy ? '生成中…' : '生成图片';
    }
    var save = document.getElementById('miya-st-ig-free-save');
    if (save) save.disabled = !!busy;
  }

  /*
   * ── 垫图（图生图）────────────────────────────────────────────
   *
   * 生命周期按用户定的规则：**保留到手动清空**。
   * 也就是生成完一张之后垫图不自动丢 —— 想同一个底图连着出好几张变体
   * 是常见用法，每次都要重新选一遍会很烦。要换就走「清空垫图」。
   *
   * 垫图存在内存里（freeGenState），不落盘：它是「这次要用的素材」，
   * 刷新后失效是合理的（跟结果图一样处理），免得在下一次打开设置时，
   * 莫名其妙挂着一张上次会话的底图并且真的参与出图。
   */
  var FREE_REF_MAX_EDGE = 1024;
  var FREE_REF_QUALITY = 0.85;

  function renderFreeRefPreview() {
    var el = document.getElementById('miya-st-ig-free-ref-preview');
    if (!el) return;
    if (!freeGenState.refBlob) {
      el.innerHTML = '<div class="miya-ig-ref__empty"><p>未选择垫图（当前为纯文字生图）</p></div>';
      return;
    }
    var url = '';
    try { url = URL.createObjectURL(freeGenState.refBlob); } catch (e) {}
    /* 旧 objectURL 要顺手回收，否则连续换图会一直攒着不放 */
    if (el._miyaRefUrl) {
      try { URL.revokeObjectURL(el._miyaRefUrl); } catch (e0) {}
    }
    el._miyaRefUrl = url;
    el.innerHTML = '<div class="miya-ig-ref__thumb"><img src="' + esc(url) + '" alt="垫图预览">' +
      '<span class="miya-ig-ref__badge">垫图</span></div>';
  }

  function renderFreeRefModeUI() {
    var mode = normalizeRefMode(freeGenState.refMode);
    var nodes = document.querySelectorAll('[data-ig-free-ref-mode]');
    for (var i = 0; i < nodes.length; i++) {
      var on = normalizeRefMode(nodes[i].getAttribute('data-ig-free-ref-mode')) === mode;
      nodes[i].classList.toggle('is-on', on);
      nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var clearBtn = document.getElementById('miya-st-ig-free-ref-clear');
    if (clearBtn) clearBtn.disabled = !freeGenState.refBlob;
    var wrap = document.getElementById('miya-st-ig-free-ref-mode-wrap');
    if (wrap) wrap.classList.toggle('is-disabled', !freeGenState.refBlob);
  }

  /**
   * 把一张图设为垫图。
   *
   * 先压缩再存：垫图要整个 base64 进请求体，原图动辄几 MB，
   * 直接发出去既慢又容易撞上网关的体积限制 —— 而垫图这个用途
   * 1024 长边已经完全够用（模型侧拿到后还要自己缩到它的训练分辨率）。
   */
  function setFreeRefFromBlob(blob) {
    if (!blob) return Promise.resolve(false);
    var img = global.MiyaChatImage;
    var compress = img && typeof img.compressImageFileToBlob === 'function'
      ? img.compressImageFileToBlob(blob, { maxEdge: FREE_REF_MAX_EDGE, quality: FREE_REF_QUALITY })
      : Promise.resolve(blob);
    return compress.catch(function () {
      /* 压缩失败不阻断：拿原图也能用，总比「选了半天没反应」强 */
      return blob;
    }).then(function (out) {
      var use = out || blob;
      return blobToDataUrl(use).then(function (dataUrl) {
        freeGenState.refBlob = use;
        freeGenState.refDataUrl = dataUrl || '';
        renderFreeRefPreview();
        renderFreeRefModeUI();
        toast('已设为垫图，将按「' + (normalizeRefMode(freeGenState.refMode) === REF_MODE_REDRAW ? '照着重画' : '参考风格') + '」生成');
        return true;
      });
    }).catch(function () {
      toast('垫图读取失败，请换一张试试');
      return false;
    });
  }

  function clearFreeRef(silent) {
    freeGenState.refBlob = null;
    freeGenState.refDataUrl = '';
    renderFreeRefPreview();
    renderFreeRefModeUI();
    if (!silent) toast('已清空垫图');
  }

  function setFreeRefMode(mode) {
    freeGenState.refMode = normalizeRefMode(mode);
    renderFreeRefModeUI();
  }

  function getFreeRefMode() {
    return normalizeRefMode(freeGenState.refMode);
  }

  function hasFreeRef() {
    return !!(freeGenState.refDataUrl && freeGenState.refBlob);
  }

  /* 懒建隐藏 file input —— 与角色「外观参考图」同款做法，不往 HTML 里塞一次性控件 */
  function ensureFreeRefFileInput() {
    var el = document.getElementById('miya-st-ig-free-ref-file');
    if (el) return el;
    el = document.createElement('input');
    el.type = 'file';
    el.accept = 'image/*';
    el.id = 'miya-st-ig-free-ref-file';
    el.style.display = 'none';
    document.body.appendChild(el);
    el.addEventListener('change', function () {
      var f = el.files && el.files[0];
      el.value = '';
      if (!f) return;
      setFreeRefFromBlob(f);
    });
    return el;
  }

  function pickFreeRefFile() {
    ensureFreeRefFileInput().click();
  }

  /*
   * 从 App 内相册挑一张当垫图。
   *
   * 注意取的是 photo.blobId（主图）而不是 thumbBlobId ——
   * 缩略图只有 320 长边，拿去当垫图会明显糊；
   * 选图器内部渲染用缩略图只是为了列表轻快。
   */
  function openFreeRefAlbumPicker() {
    var picker = global.MiyaChatAlbumPicker;
    if (!picker || typeof picker.open !== 'function') {
      toast('相册选图暂不可用，请改用「本地上传」');
      return;
    }
    picker.open(function (photo) {
      var st = getStore();
      if (!st || typeof st.getAvatarUrl !== 'function' || !photo || !photo.blobId) {
        toast('读取照片失败，请换一张试试');
        return;
      }
      st.getAvatarUrl(photo.blobId).then(function (url) {
        if (!url) throw new Error('no_url');
        /* 从 objectURL 取回真正的 Blob，再走统一的压缩/入库路径 */
        return fetch(url).then(function (r) { return r.blob(); });
      }).then(function (blob) {
        return setFreeRefFromBlob(blob);
      }).catch(function () {
        toast('读取照片失败，请换一张试试');
      });
    });
  }

  function runFreeGeneration() {
    if (freeGenState.busy) return Promise.resolve(false);
    var el = document.getElementById('miya-st-ig-free-preview');
    if (!el) return Promise.resolve(false);
    var prompt = getFreePrompt();
    if (!prompt) {
      toast('请先输入画面描述');
      return Promise.resolve(false);
    }
    setFreeBusy(true);
    freeGenState.blob = null;
    freeGenState.lastFellBack = false;
    var useRef = hasFreeRef();
    var refMode = getFreeRefMode();
    renderFreePreview('<div class="miya-ig-test miya-ig-test--busy"><span class="miya-ig-test__spin"></span><p>' +
      (useRef ? '正在按垫图生成…' : '生成中…') + '</p></div>');
    return generateImageForScene('', prompt, {
      skipContactCheck: true,
      referenceDataUrl: useRef ? freeGenState.refDataUrl : '',
      /*
       * 有垫图才传强度，没有就**完全不传** ——
       * 传了会走到 NovelAI 的参考图分支，无中生有一张不存在的参考图。
       */
      referenceStrength: useRef ? refModePreset(refMode).strength : undefined,
      referenceMode: refMode,
      size: getFreeSize()
    })
      .then(function (blob) {
        /* 自由生图的图不入库（只存在内存里等用户下载），单独响一次 */
        maybePlayImageGenDone();
        /* 引导语只影响发出去的提示词，不改用户看到/下载的那段原文 */
        return blobToDataUrl(blob).then(function (url) {
          freeGenState.blob = blob;
          freeGenState.prompt = prompt;
          freeGenState.lastFellBack = !!blob.miyaRefFellBack;
          var refNote = '';
          if (useRef && freeGenState.lastFellBack) {
            /*
             * 用户定的规则：模型不支持垫图时**自动回退 + 明确告知**。
             * 但不能说成「失败」—— 图是出来了的，只是没用上垫图。
             *
             * 文案里补一句「模型是否支持图片输入」，是因为我们现在已经
             * 把官方要求的两种请求形状（multipart / JSON）都试过了，
             * 都拿不到图，剩下的可能性就只剩模型/网关本身不做图生图。
             * 这样用户知道该去查哪儿，而不是反复重试。
             */
            refNote = '<p class="miya-ig-free-refwarn">当前模型未走垫图，已按纯文生图生成' +
              '<br><span class="miya-ig-free-refwarn-sub">请确认该模型支持图片输入，或换用支持图生图的模型</span></p>';
          } else if (useRef) {
            refNote = '<p class="miya-ig-free-refok">已按垫图（' +
              (refMode === REF_MODE_REDRAW ? '照着重画' : '参考风格') + '）生成</p>';
          }
          renderFreePreview('<div class="miya-ig-test miya-ig-test--done">' +
            '<img src="' + esc(url) + '" alt="自由生图">' +
            '<p class="miya-ig-free-caption">' + esc(prompt) + '</p>' +
            refNote +
            /*
             * 给移动端留一句「长按可存」的提示。
             * 桌面端下载按钮直接可用，这句显示出来也无害；
             * 但在 iOS 上它往往是唯一真正能存进照片的办法
             * （Safari 对 <a download> 支持残缺，分享面板是主路径，
             *  而分享面板被取消时用户还能靠长按兜底）。
             */
            '<p class="miya-ig-free-hint">点击「保存到本地」下载，手机端也可长按图片保存</p>' +
          '</div>');
          /* 垫图按用户要求保留，这里只同步一下按钮可用态 */
          renderFreeRefModeUI();
          return true;
        });
      })
      .catch(function (err) {
        renderFreePreview('<div class="miya-ig-test miya-ig-test--err"><p>' + esc(formatImageGenError(err)) + '</p></div>');
        return false;
      })
      .then(function (ok) {
        setFreeBusy(false);
        return ok;
      });
  }

  /*
   * ── 自由生图结果的去向：下载到本地 ──────────────────────────────
   *
   * 用户报的：「生图功能生成出来的图片不能保存到本地啊？
   *            只能在聊天功能的我的相册找到」。
   *
   * 原先这里只有 saveFreeGenerationToAlbum() —— 它把 blob 交给
   * MiyaChatAlbum.addPhotos() 塞进 App 内的相册，仅此一条路。
   * 相册是「App 内素材库」，供后续在聊天里当素材引用；
   * 可用户要的往往是「把这张图拿到手机/电脑上去」—— 这两件事不一样，
   * 而当时**根本没有**第二条路，所以图怎么都出不了 App。
   *
   * 现在改成直接下载到设备，复用已有的 miyaDownloadBlobAsync ——
   * 它内部已经处理好了几个平台坑，不该在这里重造一遍：
   *   · iOS 上优先走 navigator.share（Safari 对 <a download> 支持残缺，
   *     直接 click 常常毫无反应，只有分享面板能真正存进照片）
   *   · 大文件（≥24MB）避开 new File 的内存拷贝
   *   · 兜底还有 Service Worker 拉流那条路
   */
  function downloadFreeGeneration() {
    if (!freeGenState.blob) {
      toast('请先生成一张图片');
      return Promise.resolve(false);
    }
    var blob = freeGenState.blob;
    /*
     * 文件名带上画面描述的前几个字，比一律 free-gen-<时间戳>.png 好认 ——
     * 连着生成好几张时，下载目录里能一眼看出哪张是什么。
     */
    var name = buildFreeGenFileName(freeGenState.prompt, blob);
    var dl = global.miyaDownloadBlobAsync;
    if (typeof dl !== 'function') {
      /* 兜底：miya-storage.js 没加载时自己拼一个 <a download>，聊胜于无 */
      try {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          try { document.body.removeChild(a); } catch (e0) {}
          URL.revokeObjectURL(url);
        }, 2000);
        toast('已保存到下载目录');
        return Promise.resolve(true);
      } catch (e) {
        toast('保存失败，可长按图片另存');
        return Promise.resolve(false);
      }
    }
    return dl(blob, name).then(function (ok) {
      /*
       * ok=false 有两种含义，提示语要分开，不能混成一句：
       *   · 用户在系统分享面板上点了取消 —— 说明「我不要了」，
       *     不该说成失败；
       *   · 分享不可用或出错 —— 这时要告诉他还能怎么补救。
       */
      if (ok) toast('已保存，可在系统面板里选「保存到相册」');
      else toast('没保存成功，可在系统面板里选「保存到相册」再试');
      return !!ok;
    }).catch(function () {
      toast('保存失败，可长按图片另存');
      return Promise.resolve(false);
    });
  }

  /**
   * 由画面描述推一个可读的文件名。
   *
   * 只取描述开头的若干字符，并且把文件系统不友好的字符换掉 ——
   * 描述里常有「，」「。」「/」这类标点和换行，
   * 原样丢进 <a download> 有些浏览器会直接拒收整个文件名。
   */
  function buildFreeGenFileName(prompt, blob) {
    var ext = '.png';
    var type = String((blob && blob.type) || '');
    if (/jpe?g/i.test(type)) ext = '.jpg';
    else if (/webp/i.test(type)) ext = '.webp';
    var slug = String(prompt || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      /*
       * 截断到 12 个字符。
       *
       * 曾经取 24 —— 但中文描述一个字就是一个字符，24 个字加上时间戳
       * 会让文件名接近 50 字符，在下载列表里被截断、也难扫读。
       * 12 个字足够认出「这张画的是什么」，又不至于喧宾夺主。
       */
      .slice(0, 12)
      .trim();
    /* 截断可能在标点处留下尾缀，去掉结尾的逗号/顿号一类字符 */
    slug = slug.replace(/[，,。.、；;：:！!？?\-—\s]+$/, '').trim();
    if (!slug) slug = 'miya-free-gen';
    return slug + '-' + Date.now() + ext;
  }

  /* 老名字保留为别名：外部（含测试与其它模块）可能仍在引用它 */
  function saveFreeGenerationToAlbum() {
    return downloadFreeGeneration();
  }

  function syncFreeSizeOptions(provider, keepValue, dialect) {
    var sel = document.getElementById('miya-st-ig-free-size');
    if (!sel) return;
    fillSizeSelect(sel, provider, keepValue, dialect);
  }

  function resetFreeGenPreview() {
    freeGenState.blob = null;
    freeGenState.prompt = '';
    freeGenState.lastFellBack = false;
    /*
     * 垫图也一起清 —— 它的生命周期规则是「保留到手动清空」，
     * 指的是**同一次会话里**连续生成不丢；而进设置面板是一个新会话，
     * 上一轮的底图不该悄悄继续生效（用户看不见它，只会觉得出图不对）。
     */
    clearFreeRef(true);
    renderFreeRefModeUI();
    renderFreeIdle();
  }

  async function loadPresetsArr() {
    var raw = [];
    if (typeof global.miyaReadLsJsonKey === 'function') {
      var v = await global.miyaReadLsJsonKey(PRESETS_KEY, []);
      raw = Array.isArray(v) ? v : [];
    } else {
      try {
        var stored = localStorage.getItem(PRESETS_KEY);
        raw = stored ? JSON.parse(stored) : [];
      } catch (e) {
        raw = [];
      }
    }
    return raw.map(normalizePresetRow).filter(Boolean);
  }

  async function savePresetsArr(arr) {
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return !!(await global.miyaWriteLsJsonKey(PRESETS_KEY, arr));
    }
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      return false;
    }
  }

  function commitPresetsCache(list) {
    presetsCache = Array.isArray(list) ? list.slice() : [];
    renderPresetOptions(presetsCache);
    return presetsCache;
  }

  function ensurePresetsReady() {
    if (presetsCache != null) {
      renderPresetOptions(presetsCache);
      return Promise.resolve(presetsCache);
    }
    if (presetsReady) return presetsReady;
    presetsReady = loadPresetsArr().then(function (list) {
      return commitPresetsCache(list);
    }).catch(function () {
      return commitPresetsCache([]);
    });
    return presetsReady;
  }

  function normalizePresetRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = trim(raw.name);
    if (!name) return null;
    return {
      name: name,
      config: normalizeImageGenConfig(raw.config),
      savedAt: raw.savedAt || Date.now()
    };
  }

  function findPresetByName(list, name) {
    var label = trim(name);
    if (!label) return null;
    return (list || []).filter(function (x) { return x && x.name === label; })[0] || null;
  }

  function renderPresetOptions(list) {
    var pick = document.getElementById('miya-st-ig-preset-pick');
    if (!pick) return;
    var names = (list || []).map(function (p) { return p && p.name ? String(p.name) : ''; }).filter(Boolean);
    var namesKey = names.join('\0');
    if (pick.dataset.presetNames === namesKey) return;
    var current = pick.value;
    pick.innerHTML = '<option value="">选择已存预设</option>';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      pick.appendChild(opt);
    });
    if (current && names.indexOf(current) >= 0) pick.value = current;
    pick.dataset.presetNames = namesKey;
  }

  function syncPresetNameInput(name) {
    var nameInput = document.getElementById('miya-st-ig-preset-name');
    if (nameInput && name != null) nameInput.value = String(name);
  }

  function applyImageGenPreset(preset) {
    if (!preset || !preset.config) return false;
    saveImageGenConfig(preset.config);
    syncSettingsFormFromConfig();
    syncPresetNameInput(preset.name);
    return true;
  }

  function loadPresetByName(name) {
    var pickName = trim(name);
    if (!pickName) {
      toast('请先选择或输入预设名称');
      return Promise.resolve(false);
    }
    return ensurePresetsReady().then(function (list) {
      var pr = findPresetByName(list, pickName);
      if (!pr) {
        toast('未找到该预设');
        return false;
      }
      applyImageGenPreset(pr);
      var pick = document.getElementById('miya-st-ig-preset-pick');
      if (pick) pick.value = pickName;
      if (global.miyaSettingsApp && typeof global.miyaSettingsApp.markIgPresetActive === 'function') {
        global.miyaSettingsApp.markIgPresetActive(pickName);
      }
      toast('已读取「' + pickName + '」');
      return true;
    });
  }

  function savePresetByName(name) {
    var label = trim(name);
    if (!label) {
      toast('请输入预设名称');
      return Promise.resolve(false);
    }
    var snap = readSettingsForm();
    return ensurePresetsReady().then(function (list) {
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      if (next.length >= MAX_PRESETS && !findPresetByName(list, label)) {
        toast('预设最多 ' + MAX_PRESETS + ' 个');
        return false;
      }
      var row = normalizePresetRow({ name: label, config: snap, savedAt: Date.now() });
      if (!row) return false;
      next.push(row);
      return savePresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitPresetsCache(result);
      var pick = document.getElementById('miya-st-ig-preset-pick');
      if (pick) pick.value = label;
      syncPresetNameInput(label);
      toast('预设已保存');
      return true;
    }).catch(function () {
      toast('预设保存失败');
      return false;
    });
  }

  function deletePresetByName(name) {
    var label = trim(name);
    if (!label) {
      toast('请先选择要删除的预设');
      return Promise.resolve(false);
    }
    return ensurePresetsReady().then(function (list) {
      if (!findPresetByName(list, label)) {
        toast('预设不存在');
        return false;
      }
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      return savePresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitPresetsCache(result);
      var pick = document.getElementById('miya-st-ig-preset-pick');
      if (pick && pick.value === label) pick.value = '';
      toast('预设已删除');
      return true;
    }).catch(function () {
      toast('预设删除失败');
      return false;
    });
  }

  /* ─── OpenAI 兼容接口预设（独立存储，只存网关/密钥/模型） ───
     与上面的「生图预设」互不影响：那个存整套生图配置，这个只存接口三元组，
     方便在多个中转/供应商之间快速切换，交互对齐「对话 API」面板。 */
  var OA_PRESETS_KEY = 'miya-image-gen-oa-presets-v1';
  var MAX_OA_PRESETS = 24;
  var oaPresetsCache = null;
  var oaPresetsReady = null;

  async function loadOaPresetsArr() {
    if (typeof global.miyaReadLsJsonKey === 'function') {
      var v = await global.miyaReadLsJsonKey(OA_PRESETS_KEY, []);
      return Array.isArray(v) ? v : [];
    }
    try {
      var raw = JSON.parse(localStorage.getItem(OA_PRESETS_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  async function saveOaPresetsArr(arr) {
    if (typeof global.miyaWriteLsJsonKey === 'function') {
      return !!(await global.miyaWriteLsJsonKey(OA_PRESETS_KEY, arr));
    }
    try {
      localStorage.setItem(OA_PRESETS_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      return false;
    }
  }

  function readOaForm() {
    function val(id) {
      var el = document.getElementById(id);
      return el ? trim(el.value) : '';
    }
    return {
      baseUrl: val('miya-st-ig-oa-base'),
      apiKey: val('miya-st-ig-oa-key'),
      model: val('miya-st-ig-oa-model')
    };
  }

  function commitOaPresetsCache(list) {
    oaPresetsCache = Array.isArray(list) ? list.slice() : [];
    renderOaPresetOptions(oaPresetsCache);
    return oaPresetsCache;
  }

  function ensureOaPresetsReady() {
    if (oaPresetsCache != null) {
      renderOaPresetOptions(oaPresetsCache);
      return Promise.resolve(oaPresetsCache);
    }
    if (oaPresetsReady) return oaPresetsReady;
    oaPresetsReady = loadOaPresetsArr().then(function (list) {
      return commitOaPresetsCache(list);
    }).catch(function () {
      return commitOaPresetsCache([]);
    });
    return oaPresetsReady;
  }

  function renderOaPresetOptions(list) {
    var pick = document.getElementById('miya-st-ig-oa-preset-pick');
    if (!pick) return;
    var names = (list || []).map(function (p) { return p && p.name ? String(p.name) : ''; }).filter(Boolean);
    var namesKey = names.join('\0');
    if (pick.dataset.presetNames === namesKey) return;
    var current = pick.value;
    pick.innerHTML = '<option value="">选择已存预设</option>';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      pick.appendChild(opt);
    });
    if (current && names.indexOf(current) >= 0) pick.value = current;
    pick.dataset.presetNames = namesKey;
  }

  function findOaPresetByName(list, name) {
    var label = trim(name);
    if (!label) return null;
    return (list || []).filter(function (x) { return x && x.name === label; })[0] || null;
  }

  function saveOaPreset() {
    var nameEl = document.getElementById('miya-st-ig-oa-preset-name');
    var label = nameEl ? trim(nameEl.value) : '';
    if (!label) {
      toast('请输入预设名称');
      return Promise.resolve(false);
    }
    var snap = readOaForm();
    if (!snap.baseUrl && !snap.apiKey && !snap.model) {
      toast('请先填写接口信息');
      return Promise.resolve(false);
    }
    /* 注意：exists 必须在两个 then 都能访问到的外层作用域声明。
       之前它写在第一个 then 的回调里，第二个 then 里引用会抛 ReferenceError，
       被下面的 catch 捕获后统一报「保存失败」——数据其实已写入，
       表现为「提示失败但列表里确实多了这条预设」。 */
    var existedBefore = false;
    return ensureOaPresetsReady().then(function (list) {
      existedBefore = !!findOaPresetByName(list, label);
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      if (!existedBefore && next.length >= MAX_OA_PRESETS) {
        toast('接口预设最多 ' + MAX_OA_PRESETS + ' 个');
        return false;
      }
      next.push({ name: label, openai: snap, savedAt: Date.now() });
      return saveOaPresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitOaPresetsCache(result);
      var pick = document.getElementById('miya-st-ig-oa-preset-pick');
      if (pick) pick.value = label;
      toast(existedBefore ? '接口预设已覆盖' : '接口预设已保存');
      return true;
    }).catch(function () {
      toast('接口预设保存失败');
      return false;
    });
  }

  function applyOaPresetRow(row) {
    if (!row || !row.openai) return;
    var oa = row.openai;
    function set(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v == null ? '' : String(v);
    }
    set('miya-st-ig-oa-base', oa.baseUrl);
    set('miya-st-ig-oa-key', oa.apiKey);
    // 模型可能不在当前下拉里（预设存的是文本），补一项再选中，避免静默回退
    var modelSel = document.getElementById('miya-st-ig-oa-model');
    var model = trim(oa.model);
    if (modelSel && model) {
      var has = Array.prototype.some.call(modelSel.options, function (o) { return o.value === model; });
      if (!has) {
        var opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        modelSel.appendChild(opt);
      }
      modelSel.value = model;
    }
    var nameEl = document.getElementById('miya-st-ig-oa-preset-name');
    if (nameEl) nameEl.value = row.name || '';
  }

  function loadOaPreset() {
    var pick = document.getElementById('miya-st-ig-oa-preset-pick');
    var label = pick ? trim(pick.value) : '';
    if (!label) {
      toast('请先选择要载入的预设');
      return Promise.resolve(false);
    }
    return ensureOaPresetsReady().then(function (list) {
      var row = findOaPresetByName(list, label);
      if (!row) {
        toast('预设不存在');
        return false;
      }
      applyOaPresetRow(row);
      toast('已载入「' + label + '」');
      return true;
    }).catch(function () {
      toast('预设载入失败');
      return false;
    });
  }

  function deleteOaPreset() {
    var pick = document.getElementById('miya-st-ig-oa-preset-pick');
    var label = pick ? trim(pick.value) : '';
    if (!label) {
      toast('请先选择要删除的预设');
      return Promise.resolve(false);
    }
    return ensureOaPresetsReady().then(function (list) {
      if (!findOaPresetByName(list, label)) {
        toast('预设不存在');
        return false;
      }
      var next = (list || []).filter(function (x) { return x && x.name !== label; });
      return saveOaPresetsArr(next).then(function (ok) {
        if (!ok) throw new Error('save_failed');
        return next;
      });
    }).then(function (result) {
      if (!result) return false;
      commitOaPresetsCache(result);
      var pick2 = document.getElementById('miya-st-ig-oa-preset-pick');
      if (pick2 && pick2.value === label) pick2.value = '';
      toast('接口预设已删除');
      return true;
    }).catch(function () {
      toast('接口预设删除失败');
      return false;
    });
  }

  function readSettingsForm() {
    function val(id) {
      var el = document.getElementById(id);
      return el ? trim(el.value) : '';
    }
    function toggleOn(id) {
      var el = document.getElementById(id);
      return el ? el.classList.contains('is-on') : false;
    }
    var providerEl = document.querySelector('input[name="miya-st-ig-provider"]:checked');
    var provider = providerEl && providerEl.value === 'novelai' ? 'novelai' : 'openai';
    var steps = parseInt(val('miya-st-ig-na-steps'), 10);
    var scale = parseFloat(val('miya-st-ig-na-scale'));
    return {
      enabled: toggleOn('miya-st-ig-enabled'),
      provider: provider,
      positivePrompt: val('miya-st-ig-pos'),
      negativePrompt: val('miya-st-ig-neg'),
      size: val('miya-st-ig-size') || '1024x1024',
      openai: {
        baseUrl: val('miya-st-ig-oa-base'),
        apiKey: val('miya-st-ig-oa-key'),
        model: val('miya-st-ig-oa-model'),
        sizeDialect: normalizeSizeDialect(val('miya-st-ig-oa-dialect'))
      },
      novelai: {
        baseUrl: val('miya-st-ig-na-base') || 'https://image.novelai.net',
        apiKey: val('miya-st-ig-na-key'),
        model: val('miya-st-ig-na-model'),
        sampler: val('miya-st-ig-na-sampler'),
        steps: Number.isFinite(steps) ? steps : 28,
        scale: Number.isFinite(scale) ? scale : 5,
        sm: toggleOn('miya-st-ig-na-sm'),
        smDyn: toggleOn('miya-st-ig-na-smdyn'),
        proxyUrl: val('miya-st-ig-na-proxy'),
        /*
         * 这个开关的 DOM 默认是 aria-checked="true"（面板 HTML 里写死），
         * 所以直接读 class 即可。但若元素缺失（旧缓存页面），
         * 按「开启」处理 —— 与服务端 normalizeImageGenConfig 的默认值一致。
         */
        translateCjk: document.getElementById('miya-st-ig-na-cjk')
          ? toggleOn('miya-st-ig-na-cjk')
          : true
      }
    };
  }

  function fillModelSelect(sel, ids, keepValue) {
    if (!sel) return;
    var cur = trim(keepValue != null ? keepValue : sel.value);
    var list = (ids || []).map(function (id) { return trim(id); }).filter(Boolean);
    var idsKey = list.join('\0');
    if (sel.dataset.modelIds === idsKey && (!cur || sel.value === cur)) return;
    sel.innerHTML = '<option value="">选择模型</option>';
    list.forEach(function (id) {
      var op = document.createElement('option');
      op.value = id;
      op.textContent = id;
      sel.appendChild(op);
    });
    if (cur && list.indexOf(cur) >= 0) sel.value = cur;
    else if (cur) {
      var o = document.createElement('option');
      o.value = cur;
      o.textContent = cur;
      sel.appendChild(o);
      sel.value = cur;
      idsKey = idsKey + (idsKey ? '\0' : '') + cur;
    }
    sel.dataset.modelIds = idsKey;
  }

  function fillSizeSelect(sel, provider, keepValue, dialect) {
    if (!sel) return;
    var cur = trim(keepValue || sel.value) || '1024x1024';
    sel.innerHTML = '';
    /*
     * NovelAI 走自己那套（约束与 generic 相同，就是 GENERIC_SIZES）；
     * OpenAI 兼容端按用户声明的**方言**取表 —— 因为决定尺寸约束的是
     * 端点而不是模型名（中转站的模型名是 NovelAI 的）。
     */
    var sizes = provider === 'novelai' ? NOVELAI_SIZES : sizeDialectList(dialect);
    sizes.forEach(function (item) {
      var op = document.createElement('option');
      op.value = item.v;
      op.textContent = item.label || item.v;
      sel.appendChild(op);
    });
    /* 已存尺寸不在当前供应商的预设列表里（例如换过接口、或手填过自定义尺寸）时，
       不能悄悄回退到第一项——那会让下拉框显示的尺寸和实际请求用的尺寸对不上。
       改为把该尺寸补成一项并选中，保证「所见即所用」。 */
    if (!sizes.some(function (x) { return x.v === cur; })) {
      var custom = document.createElement('option');
      custom.value = cur;
      custom.textContent = cur + '（自定义）';
      sel.appendChild(custom);
    }
    sel.value = cur;
  }

  /*
   * 从 UI 里读当前选中的尺寸方言。
   * 读不到（面板没渲染 / 老版本 HTML）就回退 generic ——
   * 那是覆盖面最广的一档，回退到它最不容易出错。
   */
  function currentDialectFromUi() {
    var sel = document.getElementById('miya-st-ig-oa-dialect');
    if (!sel) return SIZE_DIALECTS.GENERIC;
    return normalizeSizeDialect(sel.value);
  }

  function syncProviderPanels(provider) {
    var oa = document.getElementById('miya-st-ig-openai-block');
    var na = document.getElementById('miya-st-ig-novelai-block');
    if (oa) oa.hidden = provider !== 'openai';
    if (na) na.hidden = provider !== 'novelai';
    var dialect = currentDialectFromUi();
    fillSizeSelect(document.getElementById('miya-st-ig-size'), provider, null, dialect);
    syncFreeSizeOptions(provider, null, dialect);
    var contactsBlock = document.getElementById('miya-st-ig-contacts-block');
    if (contactsBlock) contactsBlock.hidden = !isFormEnabled();
  }

  function syncSettingsFormFromConfig() {
    var cfg = getImageGenConfig();
    function setVal(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v == null ? '' : String(v);
    }
    function setToggle(id, on) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('is-on', !!on);
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    setToggle('miya-st-ig-enabled', cfg.enabled);
    var providerRadio = document.querySelector('input[name="miya-st-ig-provider"][value="' + cfg.provider + '"]');
    if (providerRadio) providerRadio.checked = true;
    setVal('miya-st-ig-pos', cfg.positivePrompt);
    setVal('miya-st-ig-neg', cfg.negativePrompt);
    setVal('miya-st-ig-oa-base', cfg.openai.baseUrl);
    setVal('miya-st-ig-oa-key', cfg.openai.apiKey);
    fillModelSelect(document.getElementById('miya-st-ig-oa-model'), cfg.openai.model ? [cfg.openai.model] : [], cfg.openai.model);
    setVal('miya-st-ig-na-base', cfg.novelai.baseUrl);
    setVal('miya-st-ig-na-key', cfg.novelai.apiKey);
    setVal('miya-st-ig-na-steps', cfg.novelai.steps);
    setVal('miya-st-ig-na-scale', cfg.novelai.scale);
    setToggle('miya-st-ig-na-sm', cfg.novelai.sm);
    setToggle('miya-st-ig-na-smdyn', cfg.novelai.smDyn);
    setVal('miya-st-ig-na-proxy', cfg.novelai.proxyUrl);
    setToggle('miya-st-ig-na-cjk', cfg.novelai.translateCjk !== false);
    fillModelSelect(document.getElementById('miya-st-ig-na-model'), NOVELAI_MODELS, cfg.novelai.model);
    var samplerSel = document.getElementById('miya-st-ig-na-sampler');
    if (samplerSel && !samplerSel.options.length) {
      NOVELAI_SAMPLERS.forEach(function (s) {
        var op = document.createElement('option');
        op.value = s;
        op.textContent = s;
        samplerSel.appendChild(op);
      });
    }
    if (samplerSel) samplerSel.value = cfg.novelai.sampler || NOVELAI_SAMPLERS[0];
    /* 先把方言回填到 UI，再刷尺寸表 —— 顺序不能反，
       否则尺寸表会按旧方言渲染，用户看到的选项和实际生效的对不上 */
    var dialectSel = document.getElementById('miya-st-ig-oa-dialect');
    if (dialectSel) dialectSel.value = cfg.openai.sizeDialect || SIZE_DIALECTS.GENERIC;
    var dialect = cfg.openai.sizeDialect || SIZE_DIALECTS.GENERIC;
    fillSizeSelect(document.getElementById('miya-st-ig-size'), cfg.provider, cfg.size, dialect);
    syncFreeSizeOptions(cfg.provider, cfg.size, dialect);
    syncProviderPanels(cfg.provider);
    syncContactsBlockVisibility();
    renderContactToggleList();
  }

  function isFormEnabled() {
    var el = document.getElementById('miya-st-ig-enabled');
    return el ? el.classList.contains('is-on') : false;
  }

  function syncContactsBlockVisibility() {
    var block = document.getElementById('miya-st-ig-contacts-block');
    if (block) block.hidden = !isFormEnabled();
  }

  function renderContactToggleList() {
    var box = document.getElementById('miya-st-ig-contacts-list');
    if (!box) return;
    syncContactsBlockVisibility();
    if (!isFormEnabled()) {
      box.innerHTML = '<p class="st-form-hint">请先启用生图接口</p>';
      return;
    }
    var st = getStore();
    if (!st || typeof st.getContacts !== 'function') {
      box.innerHTML = '<p class="st-form-hint">联系人未就绪</p>';
      return;
    }
    var contacts = st.getContacts().filter(function (c) { return c && !c.deleted; });
    if (!contacts.length) {
      box.innerHTML = '<p class="st-form-hint">暂无联系人</p>';
      return;
    }
    box.innerHTML = contacts.map(function (c) {
      var ig = getContactImageGenSettings(c.id);
      var name = esc(c.remarkName || c.name || c.id);
      return '<div class="st-toggle-in-form miya-ig-contact-row" data-ig-contact-id="' + esc(c.id) + '">' +
        '<div class="st-toggle-in-form__text"><strong>' + name + '</strong></div>' +
        '<button type="button" class="ins-toggle' + (ig.enabled ? ' is-on' : '') +
        '" data-ig-contact-toggle role="switch" aria-checked="' + (ig.enabled ? 'true' : 'false') + '"></button>' +
      '</div>';
    }).join('');
  }

  function saveContactImageGenEnabled(contactId, enabled) {
    var st = getStore();
    if (!st) return Promise.resolve();
    var chat = findChatByContactId(contactId);
    if (!chat) return Promise.resolve();
    var cur = getContactImageGenSettings(contactId);
    return st.saveChatSettings(chat.id, {
      imageGen: Object.assign({}, cur, { enabled: !!enabled })
    });
  }

  function bindSettingsPanelEvents() {
    if (bindSettingsPanelEvents._done) return;
    bindSettingsPanelEvents._done = true;
    var root = document.getElementById('miya-st-panel-imagegen');
    if (!root) return;

    root.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('#miya-st-ig-enabled')) {
        var btn = t.closest('#miya-st-ig-enabled');
        var on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        syncContactsBlockVisibility();
        renderContactToggleList();
        return;
      }
      if (t.closest('#miya-st-ig-na-sm')) {
        var sm = t.closest('#miya-st-ig-na-sm');
        var smOn = !sm.classList.contains('is-on');
        sm.classList.toggle('is-on', smOn);
        sm.setAttribute('aria-checked', smOn ? 'true' : 'false');
        return;
      }
      if (t.closest('#miya-st-ig-na-smdyn')) {
        var sd = t.closest('#miya-st-ig-na-smdyn');
        var sdOn = !sd.classList.contains('is-on');
        sd.classList.toggle('is-on', sdOn);
        sd.setAttribute('aria-checked', sdOn ? 'true' : 'false');
        return;
      }
      if (t.closest('#miya-st-ig-na-cjk')) {
        var cj = t.closest('#miya-st-ig-na-cjk');
        var cjOn = !cj.classList.contains('is-on');
        cj.classList.toggle('is-on', cjOn);
        cj.setAttribute('aria-checked', cjOn ? 'true' : 'false');
        return;
      }
      if (t.closest('[data-ig-contact-toggle]')) {
        var sw = t.closest('[data-ig-contact-toggle]');
        var row = sw.closest('[data-ig-contact-id]');
        if (!row) return;
        var cid = row.getAttribute('data-ig-contact-id');
        var on2 = !sw.classList.contains('is-on');
        sw.classList.toggle('is-on', on2);
        sw.setAttribute('aria-checked', on2 ? 'true' : 'false');
        saveContactImageGenEnabled(cid, on2).then(function () {
          toast(on2 ? '已为此联系人开启生图' : '已关闭此联系人生图');
        });
        return;
      }
      if (t.closest('#miya-st-ig-oa-fetch')) {
        var b = trim((document.getElementById('miya-st-ig-oa-base') || {}).value);
        var k = trim((document.getElementById('miya-st-ig-oa-key') || {}).value);
        if (!b || !k) { toast('请填写 OpenAI 网关与密钥'); return; }
        fetchOpenAiModels(b, k).then(function (ids) {
          fillModelSelect(document.getElementById('miya-st-ig-oa-model'), ids,
            (document.getElementById('miya-st-ig-oa-model') || {}).value);
          toast('已载入 ' + ids.length + ' 个模型');
        }).catch(function () { toast('拉取模型失败'); });
        return;
      }
      if (t.closest('#miya-st-ig-save')) {
        var next = readSettingsForm();
        saveImageGenConfig(next);
        syncProviderPanels(next.provider);
        renderContactToggleList();
        toast('生图配置已保存');
        return;
      }
      if (t.closest('#miya-st-ig-preset-save')) {
        var saveName = trim((document.getElementById('miya-st-ig-preset-name') || {}).value);
        savePresetByName(saveName);
        return;
      }
      if (t.closest('#miya-st-ig-preset-load')) {
        var loadPick = document.getElementById('miya-st-ig-preset-pick');
        var loadName = trim((loadPick && loadPick.value) || (document.getElementById('miya-st-ig-preset-name') || {}).value);
        loadPresetByName(loadName);
        return;
      }
      if (t.closest('#miya-st-ig-preset-delete')) {
        var delPick = document.getElementById('miya-st-ig-preset-pick');
        var delName = trim((delPick && delPick.value) || (document.getElementById('miya-st-ig-preset-name') || {}).value);
        if (!delName) {
          toast('请先选择要删除的预设');
          return;
        }
        var confirmFn = global.miyaDialog && global.miyaDialog.confirm
          ? global.miyaDialog.confirm.bind(global.miyaDialog)
          : function (o) { return Promise.resolve(confirm(o.message || '确定？')); };
        confirmFn({
          title: '删除预设',
          message: '确定删除「' + delName + '」？',
          confirmText: '删除',
          cancelText: '取消'
        }).then(function (ok) {
          if (!ok) return;
          return deletePresetByName(delName);
        });
        return;
      }
      if (t.closest('#miya-st-ig-test')) {
        runTestGeneration(
          document.getElementById('miya-st-ig-test-preview'),
          document.getElementById('miya-st-ig-test')
        );
        return;
      }
      if (t.closest('#miya-st-ig-free-run')) {
        runFreeGeneration();
        return;
      }
      if (t.closest('#miya-st-ig-free-save')) {
        downloadFreeGeneration();
        return;
      }
      /* ── 垫图相关 ── */
      if (t.closest('#miya-st-ig-free-ref-upload')) {
        pickFreeRefFile();
        return;
      }
      if (t.closest('#miya-st-ig-free-ref-album')) {
        openFreeRefAlbumPicker();
        return;
      }
      if (t.closest('#miya-st-ig-free-ref-clear')) {
        if (!hasFreeRef()) { toast('当前没有垫图'); return; }
        clearFreeRef();
        return;
      }
      if (t.closest('[data-ig-free-ref-mode]')) {
        setFreeRefMode(t.closest('[data-ig-free-ref-mode]').getAttribute('data-ig-free-ref-mode'));
        return;
      }
      if (t.closest('#miya-st-ig-oa-preset-save')) {
        saveOaPreset();
        return;
      }
      if (t.closest('#miya-st-ig-oa-preset-delete')) {
        deleteOaPreset();
        return;
      }
      if (t.closest('#miya-st-ig-oa-preset-pick')) {
        loadOaPreset();
        return;
      }
    });

    root.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'miya-st-ig-provider') {
        syncProviderPanels(e.target.value === 'novelai' ? 'novelai' : 'openai');
      }
      /*
       * 切换尺寸方言要**立刻重刷尺寸下拉**。
       *
       * 不刷的话，用户切到 dall-e-3 之后，下拉里还留着 3:4 / 4:3
       * 这些它并不接受的选项 —— 选了下单必被服务端拒。
       * 让选项跟着方言走，用户就不会选到一个注定失败的值。
       */
      if (e.target && e.target.id === 'miya-st-ig-oa-dialect') {
        var providerEl = document.querySelector('input[name="miya-st-ig-provider"]:checked');
        var prov = providerEl ? providerEl.value : 'openai';
        syncProviderPanels(prov === 'novelai' ? 'novelai' : 'openai');
      }
      if (e.target && e.target.id === 'miya-st-ig-preset-pick') {
        var pickName = trim(e.target.value);
        syncPresetNameInput(pickName);
        if (!pickName) return;
        loadPresetByName(pickName);
      }
    });
  }

  function onSettingsPanelOpen() {
    bindSettingsPanelEvents();
    ensurePresetsReady();
    ensureOaPresetsReady();
    syncSettingsFormFromConfig();
    /* 上次会话残留的结果图没有对应的内存 blob（刷新后必然拿不到），
       留着会让人以为「点了保存却没反应」，所以每次进面板都清回待输入状态。 */
    resetFreeGenPreview();
    setFreeBusy(false);
  }

  /*
   * ── 与翻译器的双向挂载 ────────────────────────────────────────
   *
   * miya-image-gen-dict.js 里有一段「若 MiyaImageGen 已存在就把
   * translate 挂上去」的逻辑。但脚本加载顺序是 dict 在**前**、
   * 本模块在**后**，所以那段判断必然落空 —— 挂载点得在这里补。
   *
   * 两处都写是有意为之：谁先加载都能正确挂上，不依赖加载顺序。
   */
  function attachDictBridge() {
    var dict = global.MiyaImageGenDict;
    if (dict && typeof dict.translate === 'function') {
      global.MiyaImageGen.translatePrompt = dict.translate;
      global.MiyaImageGen.dictStats = dict.stats;
    }
  }

  global.MiyaImageGen = {
    PRESETS_KEY: PRESETS_KEY,
    REF_LEGAL_NOTE: REF_LEGAL_NOTE,
    NOVELAI_MODELS: NOVELAI_MODELS,
    /* 尺寸预设与校验：设置面板与测试都要用，导出来免得两边各写一份 */
    SIZE_DIALECTS: SIZE_DIALECTS,
    sizeDialectList: sizeDialectList,
    normalizeSizeDialect: normalizeSizeDialect,
    resolveSizeForDialect: resolveSizeForDialect,
    GENERIC_SIZES: GENERIC_SIZES,
    NOVELAI_SIZES: NOVELAI_SIZES,
    GENERIC_RATIO_WHITELIST: GENERIC_RATIO_WHITELIST,
    nearestGenericRatio: nearestGenericRatio,
    normalizeGenericSize: normalizeGenericSize,
    extractApiErrorDetail: extractApiErrorDetail,
    formatImageGenError: formatImageGenError,
    DALLE3_SIZES: DALLE3_SIZES,
    DALLE2_SIZES: DALLE2_SIZES,
    GPTIMAGE_SIZES: GPTIMAGE_SIZES,
    parseSizeInput: parseSizeInput,
    normalizeNovelAiSize: normalizeNovelAiSize,
    isOpenAiSizeLegal: isOpenAiSizeLegal,
    defaultImageGenConfig: defaultImageGenConfig,
    normalizeImageGenConfig: normalizeImageGenConfig,
    normalizeContactImageGen: normalizeContactImageGen,
    getImageGenConfig: getImageGenConfig,
    saveImageGenConfig: saveImageGenConfig,
    isGlobalEnabled: isGlobalEnabled,
    isContactEnabled: isContactEnabled,
    getContactImageGenSettings: getContactImageGenSettings,
    buildPromptBundle: buildPromptBundle,
    generateImageForScene: generateImageForScene,
    fetchOpenAiModels: fetchOpenAiModels,
    processChatMessage: processChatMessage,
    processAssistantMessages: processAssistantMessages,
    resumeChatImageGeneration: resumeChatImageGeneration,
    retryChatMessage: retryChatMessage,
    shouldAutoGenerateChatMessage: shouldAutoGenerateChatMessage,
    processMomentTextImages: processMomentTextImages,
    retryMomentMediaItem: retryMomentMediaItem,
    resumeMomentsImageGeneration: resumeMomentsImageGeneration,
    resolveReferenceDataUrl: resolveReferenceDataUrl,
    runTestGeneration: runTestGeneration,
    runFreeGeneration: runFreeGeneration,
    downloadFreeGeneration: downloadFreeGeneration,
    saveFreeGenerationToAlbum: saveFreeGenerationToAlbum,
    resetFreeGenPreview: resetFreeGenPreview,
    /* 垫图（图生图）对外接口 */
    REF_MODES: { style: REF_MODE_STYLE, redraw: REF_MODE_REDRAW },
    REF_MODE_PRESETS: REF_MODE_PRESETS,
    normalizeRefMode: normalizeRefMode,
    refModePreset: refModePreset,
    appendRefHint: appendRefHint,
    setFreeRefFromBlob: setFreeRefFromBlob,
    clearFreeRef: clearFreeRef,
    setFreeRefMode: setFreeRefMode,
    getFreeRefMode: getFreeRefMode,
    hasFreeRef: hasFreeRef,
    pickFreeRefFile: pickFreeRefFile,
    openFreeRefAlbumPicker: openFreeRefAlbumPicker,
    saveOaPreset: saveOaPreset,
    loadOaPreset: loadOaPreset,
    deleteOaPreset: deleteOaPreset,
    onSettingsPanelOpen: onSettingsPanelOpen,
    syncSettingsFormFromConfig: syncSettingsFormFromConfig,
    ensurePresetsReady: ensurePresetsReady,
    loadPresetByName: loadPresetByName,
    savePresetByName: savePresetByName,
    deletePresetByName: deletePresetByName,
    invalidatePresetsCache: function () {
      presetsCache = null;
      presetsReady = null;
    },
    /*
     * 测试专用后门：把一张现成的图直接摆成「刚刚生成完」的状态。
     *
     * 为什么需要它：真实生图请求的返回格式因服务商而异
     * （b64_json / url / 各种中转站的变体），要写一套稳定的 mock 成本很高，
     * 而这里真正要验证的是**保存链路**，不是生图链路 ——
     * 把生图那一段换成一根桩，测试才盯得住该盯的东西。
     */
    __testSetFreeBlob: function (blob, prompt) {
      freeGenState.blob = blob || null;
      freeGenState.prompt = String(prompt || '');
      return !!freeGenState.blob;
    },
    /* 垫图相关的只读/写入后门，供自动化测试断言状态 */
    __testFreeGenState: function () {
      return {
        hasRef: hasFreeRef(),
        refMode: getFreeRefMode(),
        refDataUrlLen: String(freeGenState.refDataUrl || '').length,
        refBlobSize: freeGenState.refBlob ? freeGenState.refBlob.size : 0,
        lastFellBack: !!freeGenState.lastFellBack,
        busy: !!freeGenState.busy
      };
    },
    __testFreeRefDataUrl: function () { return String(freeGenState.refDataUrl || ''); }
  };

  /* 导出完成后立刻补上翻译器桥接，见 attachDictBridge 的说明 */
  attachDictBridge();
})(typeof window !== 'undefined' ? window : globalThis);
