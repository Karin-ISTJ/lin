/**
 * Miya · Token 估算（单一来源）
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────
 * 改造前，项目里有**三处、两套口径**的 token 估算，其中同一套公式还被
 * 逐字复制了两份：
 *
 *   ① js1/miya-chat-engine.js      length / 1.6            → 上下文面板显示
 *   ② js2/miya-worldbook-st.js     cjk/1.8 + rest/4        → 世界书预算裁剪
 *   ③ js2/miya-memory-table-engine cjk/1.8 + rest/4        → 记忆表预算裁剪
 *
 * ②③ 完全相同，是复制粘贴的产物。① 与它们对同一段文本能差出 150%
 * （纯英文 100 字符：① 得 63，②③ 得 25）。
 *
 * 这会让用户看到**自相矛盾的数字**：同一个 prompt，面板显示 9000 tokens，
 * 而世界书按 11000 去卡预算。所以这里收敛成一份。
 *
 * ── 基准口径的选择 ─────────────────────────────────────────
 * 以 ②③ 的 cjk 公式为基准，理由：
 *   1. 它区分中英文，对中英混排明显更准（① 把所有字符一律按 1/1.6 计，
 *      英文会被高估 150%）；
 *   2. 世界书与记忆表都用它，改动面最小 —— 预算行为保持不变，
 *      只有面板显示数字会小幅下降；
 *   3. ① 的 /1.6 与项目内部另一处约定自相矛盾：chat-engine 在换算
 *      ST 的 contextLength 时写的是 `contextLength * 4`，
 *      即作者心中的系数是「1 token ≈ 4 字符」，与 cjk 公式的英文项一致。
 *      可见 /1.6 更像早期随手定的值。
 *
 * ── 精度说明（重要）────────────────────────────────────────
 * 这里仍是**粗估**，不是真分词。对 GPT 系大致可用，对 Claude / Gemini
 * 会有偏差 —— 各家分词器不同，且中文按字数切分与真实 BPE 差异不小。
 * 它的用途是「预算裁剪不要撑爆上下文」和「面板给个量级」，
 * 不用于精确计费。若要精确，应引入成熟 tokenizer（如 gpt-tokenizer，
 * MIT），但那个库压缩后体积不小，对本项目的纯静态 PWA 是实际成本，
 * 且对非 GPT 模型仍不准。当前取舍：保持粗估。
 * ────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  /* 非 CJK 部分每个字符折算多少 token（≈ 1 token / 4 字符） */
  var ASCII_PER_TOKEN = 4;
  /* CJK 部分每个汉字折算多少 token（≈ 1 token / 1.8 汉字） */
  var CJK_TOKENS = 1.8;
  /*
   * 纯字符数换算用的经验系数。
   * 注意：只知字符数、拿不到正文时（例如只知道注入字符数），
   * 无法区分中英文，只能用折中值。项目原有代码在此处用的是 4，
   * 这里保持一致，避免改变既有行为。
   */
  var CHARS_PER_TOKEN_BLIND = 4;

  var CJK_RE = /[\u3400-\u9fff]/g;

  /** 统计字符串里的 CJK 字符个数 */
  function countCjk(s) {
    var m = String(s || '').match(CJK_RE);
    return m ? m.length : 0;
  }

  /**
   * 由正文估算 token（中英分别折算）。
   * @param {string} text
   * @returns {number} 估算 token 数；空文本为 0
   */
  function fromText(text) {
    var s = String(text || '');
    if (!s) return 0;
    var cjk = countCjk(s);
    var rest = s.length - cjk;
    return Math.max(1, Math.ceil(cjk / CJK_TOKENS + rest / ASCII_PER_TOKEN));
  }

  /**
   * 仅有字符数、没有正文时的估算。
   *
   * ⚠️ 传入的必须是**数字**。不要把数字转成字符串再调 fromText ——
   * 那样会把数字当成英文文本，得到完全错误的结果。
   *
   * @param {number} charCount
   * @returns {number}
   */
  function fromCharCount(charCount) {
    var n = Number(charCount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(1, Math.ceil(n / CHARS_PER_TOKEN_BLIND));
  }

  /**
   * 估算一组聊天消息的总 token。
   * 每条消息额外计 4（role / 分隔等固定开销的经验值）。
   * @param {Array<{content?:string, role?:string}>} messages
   * @returns {number}
   */
  function fromMessages(messages) {
    if (!Array.isArray(messages)) return 0;
    var sum = 0;
    messages.forEach(function (m) {
      if (!m) return;
      sum += fromText(m.content);
      if (m.role) sum += 4;
    });
    return sum;
  }

  var api = {
    fromText: fromText,
    fromCharCount: fromCharCount,
    fromMessages: fromMessages,
    countCjk: countCjk,
    /* 暴露系数，便于将来按模型族调整或做对拍 */
    ASCII_PER_TOKEN: ASCII_PER_TOKEN,
    CJK_TOKENS: CJK_TOKENS,
    CHARS_PER_TOKEN_BLIND: CHARS_PER_TOKEN_BLIND
  };

  global.MiyaToken = api;
  /* 兼容 CommonJS 环境下的测试加载 */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
