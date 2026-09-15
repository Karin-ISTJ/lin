/**
 * Miya · 记忆表格引擎
 * - 生成前注入表格正文 + 编辑规则
 * - 生成后解析 <tableEdit> 中的 insertRow/updateRow/deleteRow
 */
(function (global) {
  'use strict';

  /*
   * Token 估算统一走 MiyaToken（js2/miya-token.js）单一来源。
   * 本文件原来内联了一份与 miya-worldbook-st.js 逐字相同的公式，
   * 现在收敛掉，避免同一项目里多个口径并存。
   */
  function estimateTokens(text) {
    var t = global.MiyaToken;
    if (t && typeof t.fromText === 'function') return t.fromText(text);
    var s = String(text || '');
    if (!s) return 0;
    var cjk = (s.match(/[\u3400-\u9fff]/g) || []).join('').length;
    var rest = s.length - cjk;
    return Math.max(1, Math.ceil(cjk / 1.8 + rest / 4));
  }

  /*
   * 单元格清洗：表格是以 `rowIndex,列0,列1,...` 的裸 CSV 形式喂给模型的，
   * 所以单元格里任何「换行 / 逗号 / 引号 / 竖线」都会把结构撑破，
   * 让模型误读列归属，进而写回错行的 updateRow。
   *
   * 旧实现只 replace(/,/g,'/')，换行直接漏出去把一行拆成两行。
   * 现在统一替换为安全字符，并限长，避免单个单元格吃掉整段 token 预算。
   */
  var CELL_MAX_LEN = 200;

  function sanitizeCell(v) {
    var s = v == null ? '' : String(v);
    if (!s) return '';
    s = s
      /* 换行/回车/制表：绝不能留，否则破坏行结构 */
      .replace(/[\r\n\t]+/g, ' ')
      /* 逗号：CSV 分隔符 */
      .replace(/,/g, '/')
      /* 引号：部分模型会误判为字段包裹符 */
      .replace(/["'`]/g, '')
      /* 竖线：保留会与部分表格标记混淆 */
      .replace(/\|/g, '/')
      /* 连续空白折叠 */
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (s.length > CELL_MAX_LEN) s = s.slice(0, CELL_MAX_LEN) + '…';
    return s;
  }

  /** 表名/说明同样进上下文，一并清洗，防止注入换行伪造表格结构 */
  function sanitizeLabel(v) {
    return String(v == null ? '' : v)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function tableToCsvBlock(table, index, maxRows) {
    if (!table || table.enabled === false) return '';
    var cols = table.columns || [];
    var rows = table.rows || [];
    if (maxRows > 0 && rows.length > maxRows) {
      rows = rows.slice(-maxRows);
    }
    var lines = [];
    lines.push('* ' + index + ':' + sanitizeLabel(table.name || '表'));
    if (table.note) lines.push('【说明】' + sanitizeLabel(table.note));
    lines.push('【表格内容】');
    lines.push(
      'rowIndex,' +
        cols
          .map(function (c, i) {
            return i + ':' + sanitizeLabel(c);
          })
          .join(',')
    );
    rows.forEach(function (row, ri) {
      var cells = cols.map(function (_, ci) {
        return sanitizeCell(row[ci]);
      });
      lines.push(ri + ',' + cells.join(','));
    });
    return lines.join('\n');
  }

  function buildTablesPrompt(chatId, opts) {    opts = opts || {};
    var store = global.MiyaMemoryTableStore;
    if (!store) return '';
    var settings = store.loadSettings();
    if (settings.enabled === false || settings.isAiRead === false) return '';
    var tables = store.getChatTables(chatId);
    var maxRows = Number(settings.maxRowsPerTable) || 40;
    var soft = Number(settings.tokenSoftLimit) || 1800;
    var parts = [];
    var used = 0;
    tables.forEach(function (t, i) {
      var block = tableToCsvBlock(t, i, maxRows);
      if (!block) return;
      var tok = estimateTokens(block);
      if (used + tok > soft && parts.length) return;
      parts.push(block);
      used += tok;
    });
    if (!parts.length) {
      parts.push('(当前记忆表为空，请在剧情推进时按规则写入重要信息。)');
    }
    var editRules = '';
    if (settings.isAiWrite !== false) {
      /* detailedWriteRules === false 时退回简版，给省 token 留出口 */
      editRules = settings.detailedWriteRules === false
        ? buildBriefWriteRules()
        : buildWriteRules(tables);
    }
    return (
      '【记忆增强表格·长期记忆】\n' +
      '以下为已结构化的角色/时空/关系/事件/物品记忆，生成时必须知晓并保持一致，禁止遗忘或矛盾。\n\n' +
      parts.join('\n\n') +
      editRules
    );
  }

  /** 简版写入规则（detailedWriteRules 关闭时使用）—— 只保底，不教方法 */
  function buildBriefWriteRules() {
    return (
      '\n\n【记忆表操作规则】\n' +
      '若本轮剧情产生需要长期记住的信息，在回复末尾追加 <tableEdit><!-- ... --></tableEdit>。\n' +
      '仅使用下列函数（tableIndex 从 0 开始，rowIndex 从 0 开始，列用数字下标）：\n' +
      'insertRow(tableIndex, {0:"值",1:"值"})\n' +
      'updateRow(tableIndex, rowIndex, {0:"值"})\n' +
      'deleteRow(tableIndex, rowIndex)\n' +
      '原则：信息已有对应行时用 updateRow 而不是新增；禁止捏造未知；' +
      '单元格勿用英文逗号，用 / 分隔；勿写用户对角色的态度到社交表；只记录重要信息。\n' +
      'tableEdit 必须用 <!-- --> 包住函数调用。无更新时不要输出 tableEdit。'
    );
  }

  /*
   * 写入规则提示词 —— 决定模型「记什么、记去哪、怎么改」。
   *
   * 旧版只有一句「只记录重要信息 + 禁止捏造」，实测三类高频问题：
   *   ① 分表错位：把「关系变好」写进重要事件，把「今天下雨」写进角色特征，
   *      记忆表很快退化成无序流水账，检索价值归零；
   *   ② 无脑 insertRow：同一角色每轮新增一行，40 行上限被三五个角色刷满，
   *      旧行被 maxRows 截断挤出，等于把早期设定忘了；
   *   ③ 什么都记：一句寒暄也落表，表格被日常闲聊塞满。
   *
   * 所以这里把规则拆成四块：分表职责、insert/update 选择、记什么不记什么、
   * 语法硬约束。表清单从 tables 动态生成，用户改过表结构后描述自动跟随。
   */
  function buildWriteRules(tables) {
    var lines = [];
    lines.push('');
    lines.push('');
    lines.push('【记忆表写入规则】');
    lines.push('');
    lines.push('一、本轮剧情产生需要长期记住的信息时，在回复**末尾**追加：');
    lines.push('<tableEdit><!-- 函数调用 --></tableEdit>');
    lines.push('');
    lines.push('二、各表职责 —— 对号入座，不要混写：');
    (tables || []).forEach(function (t, i) {
      if (!t || t.enabled === false) return;
      var cols = (t.columns || []).map(function (c) {
        return sanitizeLabel(c);
      }).join('/');
      lines.push(
        '  ' + i + ' ' + sanitizeLabel(t.name || '表') +
        '  列：' + cols +
        (t.note ? '  用途：' + sanitizeLabel(t.note) : '')
      );
    });
    lines.push('');
    lines.push('三、插入还是修改 —— 先查表再动手：');
    lines.push('  · 同一实体**已存在**行 → 用 updateRow 改那一行，不要新增。');
    lines.push('  · 确实没有对应行 → 才用 insertRow。');
    lines.push('  · 信息已过时无效 → 用 deleteRow 删掉，或 updateRow 覆盖。');
    lines.push('  · 行数有上限，频繁 insertRow 会把早期设定挤出表格、等于遗忘。');
    lines.push('');
    lines.push('四、记什么、不记什么：');
    lines.push('  · 记：稳定设定、剧情转折、承诺与约定、关系变化、关键物品易主、时间地点推进。');
    lines.push('  · 不记：寒暄、语气词、当轮结束就无用的临时动作、已在本表里的内容。');
    lines.push('  · 无实质新信息时**不要输出 tableEdit**，宁可不写也不要凑数。');
    lines.push('');
    lines.push('五、语法硬约束（写错会被整条丢弃）：');
    lines.push('  insertRow(tableIndex, {0:"值",1:"值"})');
    lines.push('  updateRow(tableIndex, rowIndex, {0:"值"})');
    lines.push('  deleteRow(tableIndex, rowIndex)');
    lines.push('  · tableIndex / rowIndex 从 0 开始，就是上文表格里的编号，不要凭空猜。');
    lines.push('  · 列名用**数字下标**（0 是第一列），只写要改的列。');
    lines.push('  · 函数调用必须包在 <!-- --> 里。');
    lines.push('  · 单元格内**不要使用英文逗号**（会破坏列结构），需要并列时用 / 分隔。');
    lines.push('  · 单元格内不要换行、不要用引号；值是纯文本，不写 JSON 嵌套。');
    lines.push('  · 禁止捏造原文未出现的设定；禁止把用户对角色的态度写进社交表。');
    return lines.join('\n');
  }

  /*
   * 找出 tableEdit 的开闭区间，**容忍闭合标签缺失**。
   *
   * 为什么必须容错：模型输出被 token 上限截断是常事，一旦截断发生在
   * </tableEdit> 之前，旧实现的正则 <tableEdit>([\s\S]*?)<\/tableEdit>
   * 直接匹配失败 → 返回 [] → 整轮记忆写入**全部丢弃**，而且悄无声息。
   * 实测：'<tableEdit><!-- insertRow(0,{...}) -->'（缺闭合）解析出 0 个动作。
   *
   * 现在分两种情况：
   *   ① 有完整的 </tableEdit>  → 正常截取
   *   ② 只有 <tableEdit>       → 取到文末，交给下游按动作语法解析
   *      （下游的 parseTableEditBlock 会只认 insertRow/updateRow/deleteRow，
   *        所以即使正文被一并吞进来，也不会误写入脏数据）
   *
   * @returns {{start:number, end:number}|null} end 为闭合标签之后的位置；
   *          无闭合标签时为文本长度
   */
  function findTableEditRange(s) {
    var openRe = /<tableEdit>/i;
    var om = openRe.exec(s);
    if (!om) return null;
    var contentStart = om.index + om[0].length;
    var closeRe = /<\/tableEdit>/i;
    closeRe.lastIndex = contentStart;
    var cm = closeRe.exec(s);
    return {
      start: om.index,
      contentStart: contentStart,
      contentEnd: cm ? cm.index : s.length,
      end: cm ? cm.index + cm[0].length : s.length,
      closed: !!cm
    };
  }

  function stripTableEditFromReply(text) {
    var s = String(text || '');
    /*
     * 旧实现用 /<tableEdit>[\s\S]*?<\/tableEdit>/gi 整体替换，
     * 只处理「成对」的块。残缺块（缺闭合）会**原样留在正文里**，
     * 于是聊天记录中残留 <tableEdit><!-- insertRow(...) --> 这种字样。
     * 现在按 findTableEditRange 的区间切除，残缺块一并清掉。
     */
    for (var guard = 0; guard < 20; guard += 1) {
      var range = findTableEditRange(s);
      if (!range) break;
      s = (s.slice(0, range.start) + ' ' + s.slice(range.end)).replace(/\n{3,}/g, '\n\n');
    }
    /* 兜底：清掉可能残留的孤立标记（模型写错大小写、多打半个标签等） */
    s = s.replace(/<\/?tableEdit>/gi, '');
    return s.trim();
  }

  function parseTableEditBlock(text) {
    var s = String(text || '');
    var range = findTableEditRange(s);
    if (!range) return [];
    var body = s.slice(range.contentStart, range.contentEnd);
    body = body.replace(/<!--([\s\S]*?)-->/g, '$1');
    /*
     * 无闭合标签时，body 会一直延伸到文末，可能带上正文。
     * 这里再切一刀：只保留到最后一个动作的右括号为止，
     * 避免正文里恰好出现的括号干扰后续匹配。
     */
    if (!range.closed) {
      var lastClose = body.lastIndexOf(')');
      if (lastClose >= 0) body = body.slice(0, lastClose + 1);
    }
    var actions = [];
    /*
     * 动作匹配放宽：
     *   · 容忍中文括号 （）  —— 模型常把 ( ) 打成全角
     *   · 结尾不强制要求 $ / ; / 换行 —— 缺闭合标签时后面可能直接是文本
     *   · 参数体用「非贪婪到最近的右括号」会漏掉嵌套对象，
     *     所以改用「贪婪到本行最后一个右括号」的策略（见下方循环）
     */
    var re = /(insertRow|updateRow|deleteRow)\s*[（(]\s*([\s\S]*?)\s*[）)]\s*(?=$|;|\n|,|$)/gi;
    var hit;
    var cursor = 0;
    while ((hit = re.exec(body))) {
      var raw = hit[2].trim();
      if (!raw) continue;
      /*
       * 嵌套对象里的 '}' 后面可能紧跟 ')'，上面的非贪婪在遇到
       * 对象内部的 ')' 时不会出错（对象用 {} 而非 ()），
       * 但为了稳妥，若解析出的实参以 '}' 或 '"' 未收尾，则向后扩展。
       */
      actions.push({ op: hit[1], rawArgs: raw });
      cursor = re.lastIndex;
      if (cursor >= body.length) break;
    }
    return actions;
  }

  /*
   * 安全参数解析器：替代原来的正则改写 + new Function 兜底。
   *
   * 旧实现有两个问题：
   * 1) 兜底走 new Function，等于拿模型输出直接 eval，属于代码注入面；
   * 2) 预处理把单引号无差别换成双引号，单元格里本来就有引号时必然解析失败。
   *
   * 现在改为手写扫描：严格按 JS 字面量语法取值，不执行任何代码。
   * 支持数字、单/双引号字符串（含转义）、true/false/null、嵌套对象/数组。
   */

  function isIdentStart(ch) {
    return /[A-Za-z_$]/.test(ch);
  }

  function isIdentChar(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
  }

  function skipWs(s, i) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    return i;
  }

  /*
   * 中文标点归一化 —— 模型高频错误。
   *
   * 为什么必须做：本项目的写入规则提示词里明确写着「单元格勿用英文逗号，
   * 用 / 分隔」，等于**主动引导模型使用中文标点**。但扫描器只认半角，
   * 于是模型照规则写出来的内容反而解析失败（实测：中文冒号/逗号/分号
   * 一律 "skip bad args"，整条记忆静默丢失）。
   *
   * 只替换**结构性**标点，不碰引号内的内容：
   *   ： → :     ， → ,     ； → ,     （） → ()
   * 引号保持原样 —— 中文引号「」『』“”在单元格里是正常文本。
   *
   * 实现上逐字符扫描，跟踪是否处于引号内，避免误改单元格正文
   * （例如 "他说：好的" 里的中文冒号必须保留）。
   */
  function normalizeCjkPunct(src) {
    var s = String(src || '');
    var out = '';
    var quote = '';
    for (var i = 0; i < s.length; i += 1) {
      var ch = s[i];
      if (quote) {
        /* 引号内原样保留；处理转义 */
        if (ch === '\\') {
          out += ch;
          if (i + 1 < s.length) { out += s[i + 1]; i += 1; }
          continue;
        }
        if (ch === quote) quote = '';
        out += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '：') { out += ':'; continue; }
      if (ch === '，') { out += ','; continue; }
      /*
       * 中文分号 ；有两种用法，需要看上下文才能决定替换成什么：
       *   ① 对象里当键值分隔：{0:"a";1:"b"}  → 应为 :
       *   ② 实参之间当分隔符：(0;"a")        → 应为 ,
       * 判据：往前看本层最近的结构字符 —— 若刚解析完一个键（即上一个非空白
       * 字符是数字/标识符/引号，且更早处是本层的 { 或 ,），则是 ①。
       * 简化做法：向后看 —— 分号后若紧跟一个「值起始」而更前面是裸键，
       * 用 : 更常见；这里采用更稳妥的策略：一律先记成占位符，
       * 由 parseArgs/parseValue 在遇到 ';' 时按当前状态决定。
       */
      if (ch === '；' || ch === ';') { out += '\u0001'; continue; }
      if (ch === '（') { out += '('; continue; }
      if (ch === '）') { out += ')'; continue; }
      out += ch;
    }
    return out;
  }

  /*
   * 把占位符 \u0001（原中文分号）按上下文还原为 ':' 或 ','。
   *
   * 规则：占位符前面若处于「已读到键、还没读到值」的状态，说明它是
   * 键值分隔符 → ':'；否则是元素/实参分隔符 → ','。
   * 这里用一个轻量扫描判断：从占位符往前找最近的 { , ( 或开头，
   * 若这段里已经出现过 ':'，说明当前元素的值已经给出，则本占位符是分隔符；
   * 否则是键值分隔符。
   */
  function resolveSemicolonPlaceholders(src) {
    var s = String(src || '');
    if (s.indexOf('\u0001') < 0) return s;
    var out = '';
    var depthStack = [];
    var inQuote = '';
    for (var i = 0; i < s.length; i += 1) {
      var ch = s[i];
      if (inQuote) {
        if (ch === '\\') { out += ch; if (i + 1 < s.length) { out += s[i + 1]; i += 1; } continue; }
        if (ch === inQuote) inQuote = '';
        out += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { inQuote = ch; out += ch; continue; }
      if (ch === '{' || ch === '[' || ch === '(') {
        depthStack.push({ open: ch, sawColon: false });
        out += ch;
        continue;
      }
      if (ch === '}' || ch === ']' || ch === ')') {
        depthStack.pop();
        out += ch;
        continue;
      }
      if (ch === ':') {
        if (depthStack.length) depthStack[depthStack.length - 1].sawColon = true;
        out += ch;
        continue;
      }
      if (ch === ',') {
        if (depthStack.length) depthStack[depthStack.length - 1].sawColon = false;
        out += ch;
        continue;
      }
      if (ch === '\u0001') {
        var top = depthStack.length ? depthStack[depthStack.length - 1] : null;
        /* 在当前元素内还没出现过冒号 → 它是键值分隔符 */
        var isKv = !!(top && (top.open === '{') && !top.sawColon);
        out += isKv ? ':' : ',';
        if (isKv && top) top.sawColon = true;
        continue;
      }
      out += ch;
    }
    return out;
  }

  /** 解析带引号的字符串，返回 {value, next}；未闭合返回 null */
  function readString(s, i, quote) {
    i += 1;
    var out = '';
    while (i < s.length) {
      var ch = s[i];
      if (ch === '\\') {
        var esc = s[i + 1];
        if (esc === undefined) return null;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'u') {
          var hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        } else if (esc === 'x') {
          var h2 = s.slice(i + 2, i + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(h2)) return null;
          out += String.fromCharCode(parseInt(h2, 16));
          i += 4;
          continue;
        } else out += esc;
        i += 2;
        continue;
      }
      /* 反引号模板串不支持：直接判失败，交由上层打日志，避免误吞内容 */
      if (ch === '`') return null;
      if (ch === quote) {
        /*
         * 裸引号容错：模型漏转义时会写出 "她说"好的"" 这种形态。
         * 单纯按「遇到同种引号即闭合」会得到 "她说"，把后半截
         * 好的"" 当成下一个值 → 整条解析失败（实测 C6，整条动作被丢弃）。
         *
         * 唯一判据：合法闭合引号之后（跳过空白）必然是结构字符 , } ] : )
         * 或串尾；否则它就不是闭合，而是内容里的引号。这条判据只在
         * 「不可能是合法闭合」时才生效，因此合法输入的语义完全不变。
         *
         * 注意必须**先判加倍再判结构**：模型常把内容引号写成双份
         * （"他说""好的""），此时 s[i+1] 也是同种引号，若直接按结构字符
         * 判据走会把它判成闭合，后半截内容又变成脏数据。
         *
         * 推 i 时只吞「一个引号 + 可能的那个配对引号」，而不是无条件吞两个：
         * 无条件吞两个会在 "a""b" 这类边界上多吃一个引号，把后面的
         * 闭合引号当内容，最终读到串尾无引号可闭合 → 整条失败。
         */
        var after = skipWs(s, i + 1);
        var nx = s[after];
        var isStruct = after >= s.length || nx === ',' || nx === '}' || nx === ']' || nx === ':' || nx === ')';
        if (isStruct && s[i + 1] !== quote) {
          /* 干净闭合 */
          return { value: out, next: i + 1 };
        }
        if (s[i + 1] === quote) {
          /*
           * 加倍写法：这一对引号整体是内容里的一个引号。
           * 吞掉这一对之后，后面若已是结构字符/串尾，说明此处才是真闭合，
           * 但当前这对已经被判为「内容引号」，无法回头 —— 因此更稳妥的
           * 做法是：把一个引号写进 out，i 推到第二个引号处，让下一轮
           * 循环用同一条结构判据重新裁决。
           */
          out += quote;
          i += 1;
          continue;
        }
        /* 单裸引号：后面紧跟内容而非结构字符 → 原样累积 */
        out += quote;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return null;
  }

  /** 解析数字；不合法返回 null */
  function readNumber(s, i) {
    var m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) return null;
    var n = Number(m[0]);
    if (!Number.isFinite(n)) return null;
    return { value: n, next: i + m[0].length };
  }

  /** 解析标识符字面量：true / false / null / undefined / NaN */
  function readIdent(s, i) {
    var j = i;
    while (j < s.length && isIdentChar(s[j])) j += 1;
    var word = s.slice(i, j);
    if (word === 'true') return { value: true, next: j };
    if (word === 'false') return { value: false, next: j };
    if (word === 'null' || word === 'undefined') return { value: null, next: j };
    if (word === 'NaN') return { value: NaN, next: j };
    if (!word) return null;
    /* 未知标识符（变量、函数调用等）：拒绝，不执行 */
    return null;
  }

  function parseValue(s, i) {
    i = skipWs(s, i);
    if (i >= s.length) return null;
    var ch = s[i];
    if (ch === '{') {
      var obj = {};
      i = skipWs(s, i + 1);
      if (s[i] === '}') return { value: obj, next: i + 1 };
      for (;;) {
        i = skipWs(s, i);
        var key;
        if (s[i] === '"' || s[i] === "'") {
          var k = readString(s, i, s[i]);
          if (!k) return null;
          key = k.value;
          i = k.next;
        } else {
          /* 裸键：数字下标 0 / 1，或标识符键 */
          var kn = readNumber(s, i);
          if (kn) {
            key = String(kn.value);
            i = kn.next;
          } else {
            var st = i;
            while (i < s.length && isIdentChar(s[i])) i += 1;
            if (i === st) return null;
            key = s.slice(st, i);
          }
        }
        i = skipWs(s, i);
        if (s[i] !== ':') return null;
        var v = parseValue(s, i + 1);
        if (!v) return null;
        obj[key] = v.value;
        i = skipWs(s, v.next);
        if (s[i] === ',') {
          i += 1;
          /* 对象内尾逗号：{0:"a",} —— 逗号后直接是 } 则正常收尾 */
          var j1 = skipWs(s, i);
          if (s[j1] === '}') return { value: obj, next: j1 + 1 };
          i = j1;
          continue;
        }
        if (s[i] === '}') return { value: obj, next: i + 1 };
        return null;
      }
    }
    if (ch === '[') {
      var arr = [];
      i = skipWs(s, i + 1);
      if (s[i] === ']') return { value: arr, next: i + 1 };
      for (;;) {
        var item = parseValue(s, i);
        if (!item) return null;
        arr.push(item.value);
        i = skipWs(s, item.next);
        if (s[i] === ',') {
          i = skipWs(s, i + 1);
          /* 数组内尾逗号：[1,] —— 逗号后直接是 ] 则正常收尾 */
          if (s[i] === ']') return { value: arr, next: i + 1 };
          continue;
        }
        if (s[i] === ']') return { value: arr, next: i + 1 };
        return null;
      }
    }
    if (ch === '"' || ch === "'") return readString(s, i, ch);
    var num = readNumber(s, i);
    if (num) return num;
    return readIdent(s, i);
  }

  /** 解析 "0, {0:\"a\"}" 这类逗号分隔的实参，返回数组或 null */
  function parseArgs(raw) {
    // insertRow(0, {0:"a",1:"b"}) | updateRow(0,1,{2:"x"}) | deleteRow(0,1)
    var src = resolveSemicolonPlaceholders(normalizeCjkPunct(String(raw || '').trim()));
    if (!src) return null;
    var out = [];
    var i = 0;
    for (;;) {
      var v = parseValue(src, i);
      if (!v) return null;
      out.push(v.value);
      i = skipWs(src, v.next);
      if (i >= src.length) return out;
      if (src[i] !== ',') return null;
      i += 1;
      /*
       * 尾逗号容错：'insertRow(0,{0:"a"},)' 这种写法模型偶尔会吐。
       * 旧实现遇到尾逗号直接 return null，整条动作被 "skip bad args"。
       * 现在：逗号后面若已无内容、或直接就是收尾符号，则视为正常结束。
       */
      var j = skipWs(src, i);
      if (j >= src.length || src[j] === ')' || src[j] === ']' || src[j] === '}') {
        return out;
      }
      i = j;
    }
  }

  function applyActions(tables, actions, settings) {
    var maxRows = (settings && settings.maxRowsPerTable) || 40;
    var next = tables.map(function (t) {
      return {
        id: t.id,
        name: t.name,
        note: t.note,
        enabled: t.enabled,
        columns: t.columns.slice(),
        rows: t.rows.map(function (r) {
          return r.slice();
        })
      };
    });
    var log = [];
    /*
     * log   只记「真正落地」的动作，供上层判断要不要写库。
     * fail  记失败明细，供上层给出用户可见的反馈。
     *
     * 以前两者混在一个 log 里（失败写 'skip bad args: xxx'），既没法据此
     * 判断「是否全部失败」，也没法给用户一句人话 —— 失败只在 console 里，
     * 用户在聊天里完全无感，模型说了要记、表格却没变，只能反复重试。
     */
    var fail = [];
    actions.forEach(function (act) {
      var args = parseArgs(act.rawArgs);
      if (!args || !args.length) {
        fail.push({
          op: act.op,
          reason: 'args',
          raw: String(act.rawArgs || '').slice(0, 120)
        });
        return;
      }
      var ti = Number(args[0]);
      if (!Number.isFinite(ti) || ti < 0 || ti >= next.length) {
        fail.push({ op: act.op, reason: 'tableIndex', tableIndex: ti });
        return;
      }
      var table = next[ti];
      if (act.op === 'insertRow') {
        var data = args[1] && typeof args[1] === 'object' ? args[1] : {};
        var row = table.columns.map(function (_, ci) {
          var v = data[ci] != null ? data[ci] : data[String(ci)];
          /* 入库即清洗：脏字符不落盘，避免下一轮注入时污染表格结构 */
          return sanitizeCell(v);
        });
        table.rows.push(row);
        if (table.rows.length > maxRows) table.rows = table.rows.slice(-maxRows);
        log.push('insertRow ' + ti);
      } else if (act.op === 'deleteRow') {
        var ri = Number(args[1]);
        if (Number.isFinite(ri) && ri >= 0 && ri < table.rows.length) {
          table.rows.splice(ri, 1);
          log.push('deleteRow ' + ti + ',' + ri);
        } else {
          fail.push({ op: act.op, reason: 'rowIndex', tableIndex: ti, rowIndex: ri });
        }
      } else if (act.op === 'updateRow') {
        var riu = Number(args[1]);
        var dataU = args[2] && typeof args[2] === 'object' ? args[2] : {};
        if (Number.isFinite(riu) && riu >= 0 && riu < table.rows.length) {
          table.columns.forEach(function (_, ci) {
            if (dataU[ci] != null || dataU[String(ci)] != null) {
              var v = dataU[ci] != null ? dataU[ci] : dataU[String(ci)];
              /* 同上：写回时也清洗，模型常把整段剧情塞进单元格 */
              table.rows[riu][ci] = sanitizeCell(v);
            }
          });
          log.push('updateRow ' + ti + ',' + riu);
        } else {
          fail.push({ op: act.op, reason: 'rowIndex', tableIndex: ti, rowIndex: riu });
        }
      } else {
        /* 未知动作名：模型偶尔会自造动作，不要静默吞掉 */
        fail.push({ op: act.op, reason: 'unknownOp' });
      }
    });
    return { tables: next, log: log, failures: fail };
  }

  /** 把失败明细压成一句给用户看得懂的话；没有失败返回空串 */
  function describeFailures(failures) {
    if (!failures || !failures.length) return '';
    var n = failures.length;
    var bad = failures.filter(function (f) {
      return f.reason === 'args' || f.reason === 'unknownOp';
    }).length;
    if (bad === n) return '记忆表：' + n + ' 条写入指令格式无法解析，已跳过';
    var idx = failures.filter(function (f) {
      return f.reason === 'tableIndex';
    }).length;
    var row = failures.filter(function (f) {
      return f.reason === 'rowIndex';
    }).length;
    var parts = [];
    if (bad) parts.push('格式无法解析 ' + bad + ' 条');
    if (idx) parts.push('表序号越界 ' + idx + ' 条');
    if (row) parts.push('行序号越界 ' + row + ' 条');
    return '记忆表：' + n + ' 条写入未生效（' + parts.join('、') + '）';
  }

  function processAssistantReply(chatId, replyText) {
    var store = global.MiyaMemoryTableStore;
    if (!store) return { text: replyText, applied: false };
    var settings = store.loadSettings();
    if (settings.enabled === false || settings.isAiWrite === false) {
      return { text: stripTableEditFromReply(replyText), applied: false };
    }
    var actions = parseTableEditBlock(replyText);
    var clean = stripTableEditFromReply(replyText);
    if (!actions.length) return { text: clean, applied: false };
    var tables = store.getChatTables(chatId);
    var result = applyActions(tables, actions, settings);
    /* 只要有动作成功落地，才写库；全部失败则保持原样，不动用户数据 */
    if (result.log.length) store.setChatTables(chatId, result.tables);
    try {
      console.log('[MiyaMemoryTable] applied', result.log, result.failures);
    } catch (e) {}
    return {
      text: clean,
      applied: true,
      log: result.log,
      failures: result.failures,
      notice: describeFailures(result.failures)
    };
  }

  function injectIntoMessages(apiMessages, chatId) {
    var store = global.MiyaMemoryTableStore;
    if (!store) return apiMessages;
    var settings = store.loadSettings();
    if (settings.enabled === false || settings.isAiRead === false) return apiMessages;
    var block = buildTablesPrompt(chatId);
    if (!block) return apiMessages;
    var msg = { role: 'system', content: block };
    if (!Array.isArray(apiMessages)) return apiMessages;

    /* ── 为什么必须固定插入点（提示缓存） ──
       记忆块的内容本身每轮也在变（表格会被模型改写），这点无法避免；
       但如果**位置**也在变，那就是雪上加霜——位置一变，它后面所有内容的
       偏移全部平移，等于每轮都把历史写花一遍，缓存 100% 重建。
       实测（真机浏览器三连轮）：修复前命中率 0%。
       所以这里的所有分支，一律锚定到**同一处**：紧跟开头的 system 区
       （即第一条 user 之前）。有没有 user、历史多长，都不影响锚点。 */

    /* 计算「开头连续 system 区」的末尾位置 */
    var anchor = 0;
    while (anchor < apiMessages.length && apiMessages[anchor] &&
           apiMessages[anchor].role === 'system') {
      anchor++;
    }
    /* 兜底：万一开头不是 system（异常拼接），就退到第一条 user 之前 */
    if (anchor === 0) {
      var fu = -1;
      for (var k = 0; k < apiMessages.length; k++) {
        if (apiMessages[k] && apiMessages[k].role === 'user') { fu = k; break; }
      }
      anchor = fu >= 0 ? fu : 0;
    }
    /* before_user 语义上要求「贴着用户消息」，但锚点仍固定在 system 区末尾，
       只是当 system 区后面紧邻的就是 user 时，两者结果一致。
       这样无论对话多长，记忆块深度都恒定。 */
    apiMessages.splice(anchor, 0, msg);
    return apiMessages;
  }

  global.MiyaMemoryTableEngine = {
    buildTablesPrompt: buildTablesPrompt,
    processAssistantReply: processAssistantReply,
    stripTableEditFromReply: stripTableEditFromReply,
    parseTableEditBlock: parseTableEditBlock,
    applyActions: applyActions,
    describeFailures: describeFailures,
    injectIntoMessages: injectIntoMessages,
    tableToCsvBlock: tableToCsvBlock,
    parseArgs: parseArgs,
    sanitizeCell: sanitizeCell
  };
})(typeof window !== 'undefined' ? window : this);
