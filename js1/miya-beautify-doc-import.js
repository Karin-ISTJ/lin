/**
 * 美化 CSS · 从 docx / txt / css 快捷导入（线上聊天 / 线下 / 桌面歌词）
 */
(function (global) {
  'use strict';

  var FILE_ACCEPT = '.txt,.docx,.css,text/plain,text/css,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  function looksLikeCssBlock(text) {
    var s = String(text || '').trim();
    if (!s) return false;
    return /[{][\s\S]*?[}]/.test(s);
  }

  /** 该行是否是「标题样」的行：整行没有 { } ; ，且短到不像 CSS 声明 */
  function isTitleLikeLine(line) {
    var t = String(line || '').trim();
    if (!t) return true;
    if (t.length > 48) return false;
    if (/[{};]/.test(t)) return false;
    /* CSS 注释、@规则开头都不是标题 */
    if (t.indexOf('/*') === 0 || t.indexOf('//') === 0) return false;
    if (t.charAt(0) === '@') return false;
    /* 选择器列表行（可能换行到逗号结尾）也不是标题 */
    if (/^[.#@*:\[a-zA-Z][^{};]*[,>]\s*$/.test(t)) return false;
    /* 缩进过的行视为代码而非标题 —— 标题按惯例顶格写 */
    if (/^[ \t]/.test(String(line || '')) && /[.#@:\[a-zA-Z*]/.test(t)) return false;
    return true;
  }

  /** 文首是否存在连续的标题样行（含 markdown # 标题） */
  function hasTitleLine(text) {
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) { if (i > 0) return true; continue; }
      if (/^#{1,6}\s+/.test(lines[i].trim())) return true;
      /* 顶格的、不含代码特征的首行才可能是标题 */
      if (!/^[ \t]/.test(lines[i]) && isTitleLikeLine(lines[i])) return true;
      return false;
    }
    return false;
  }

  /** 去掉文首连续的标题样行（标题 + 其后的空行），保留之后的正文 */
  function stripTitleLine(text) {
    var lines = String(text || '').split(/\r?\n/);
    var i = 0;
    while (i < lines.length && /^#{1,6}\s+/.test(lines[i].trim())) i++;
    while (i < lines.length && !/^[ \t]/.test(lines[i]) && isTitleLikeLine(lines[i])) {
      i++;
      while (i < lines.length && !lines[i].trim()) i++;
    }
    return lines.slice(i).join('\n').trim();
  }

  /** 从混合文稿中提取 CSS 段落；纯 CSS 则原样返回 */
  function extractCssFromText(raw) {
    var s = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!s) return '';

    var fenced = s.match(/```(?:css)?\s*\r?\n([\s\S]*?)```/i);
    if (fenced && fenced[1].trim()) return fenced[1].trim();

    /* 标题行匹配。三类形态都要吃掉整行，避免标题残留进 CSS：
       ① 「自定义 CSS：.qq{...}」——标题与 CSS 同一行（冒号后直接接内容）
       ② 「自定义 CSS：」独占一行，CSS 在下一行
       ③ 「CSS」/「样式」等裸标题独占一行
       原实现用 `\r?\n` 硬性要求 CSS 必须换行才开始，于是 ①② 里
       标题整行都被当成 CSS 正文，被原样填进输入框。 */
    var HEAD_RE = '(?:^|\\n)[ \\t]*(?:#{1,3}[ \\t]*)?(?:(?:自定义|定制|注\\s*入|额外|我的)[ \\t]*)?(?:CSS|样式表|样式|皮肤|风格)[ \\t]*[：:]?[ \\t]*';

    /* ① 冒号后同一行就有 CSS 的写法，优先处理 */
    var inline = s.match(new RegExp(HEAD_RE + '(?=[^\\r\\n]*\\{)', 'i'));
    if (inline) {
      var rest = s.slice(inline.index + inline[0].length);
      var cut = rest.search(/\r?\n[ \t]*(?:#{1,3}[ \t]+|={3,}|-{3,}[ \t]*$|选择器参考|源码参考|类名参考)/m);
      var cand = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
      if (cand && looksLikeCssBlock(cand)) return cand;
    }

    /* ②③ 标题独占一行的常规写法：用不定长空白行替代原来对单个 \n 的硬要求 */
    var marked = s.match(new RegExp(HEAD_RE + '\\s*(?=\\r?\\n)([\\s\\S]*?)(?=\\n\\s*(?:#{1,3}\\s+|={3,}|-{3,}\\s*\\n|选择器参考|源码参考|源码 ·|类名参考|$))', 'i'));
    if (!marked) {
      marked = s.match(new RegExp(HEAD_RE + '[ \\t]*$([\\s\\S]*)', 'i'));
    }
    if (marked && marked[1].trim() && looksLikeCssBlock(marked[1])) return marked[1].trim();

    var parts = s.split(/\n\s*-{3,}\s*\n/);
    if (parts.length > 1) {
      for (var i = parts.length - 1; i >= 0; i--) {
        if (looksLikeCssBlock(parts[i])) return stripTitleLine(parts[i]);
      }
    }

    /* 兜底：整篇就没有任何标题，直接返回 */
    if (!hasTitleLine(s)) return s;

    /* 走到这里说明文首有标题行但没被上面的规则切干净（例如标题措辞不在白名单里）。
       再兜一次：去掉开头连续的标题样行，剩下的若仍是合法 CSS 块就返回，
       否则宁可原样返回，也不要静默塞进一段半截内容。 */
    var peeled = stripTitleLine(s);
    if (peeled !== s && looksLikeCssBlock(peeled)) return peeled;

    return s;
  }

  function extractTextFromFile(file) {
    if (!file) return Promise.reject(new Error('no_file'));
    if (!global.miyaWorldbookExtractFileText) {
      return Promise.reject(new Error('import_module_missing'));
    }
    return global.miyaWorldbookExtractFileText(file);
  }

  function isEditableCssTextarea(el) {
    if (!el || el.tagName !== 'TEXTAREA') return false;
    if (el.readOnly || el.hasAttribute('readonly')) return false;
    if (el.hasAttribute('data-mq-bf-src-readonly') || el.hasAttribute('data-xw-bf-src-readonly')) {
      return false;
    }
    return true;
  }

  /** 清空可编辑框并写入全文；不触碰只读参考区与预设下拉 */
  function fillCssTextarea(textarea, text) {
    if (!isEditableCssTextarea(textarea)) return false;
    textarea.value = String(text || '').replace(/^\uFEFF/, '').trim();
    try {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      var ev = document.createEvent('Event');
      ev.initEvent('input', true, true);
      textarea.dispatchEvent(ev);
    }
    return true;
  }

  function importFileToTextarea(file, textarea) {
    return extractTextFromFile(file).then(function (raw) {
      var t = String(raw || '').trim();
      if (!t) return Promise.reject(new Error('empty_text'));
      if (!fillCssTextarea(textarea, t)) return Promise.reject(new Error('no_target'));
      return t;
    });
  }

  function pickAndImport(textarea) {
    return new Promise(function (resolve, reject) {
      if (!isEditableCssTextarea(textarea)) {
        reject(new Error('no_target'));
        return;
      }
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = FILE_ACCEPT;
      inp.style.display = 'none';
      inp.addEventListener('change', function () {
        var file = inp.files && inp.files[0];
        inp.remove();
        if (!file) {
          reject(new Error('no_file'));
          return;
        }
        importFileToTextarea(file, textarea).then(resolve).catch(reject);
      });
      document.body.appendChild(inp);
      if (global.miyaTriggerFileInput) global.miyaTriggerFileInput(inp);
      else inp.click();
    });
  }

  function toastError(err, toastFn) {
    var code = err && err.message;
    var msg = '导入失败';
    if (code === 'unsupported_type') msg = '仅支持 .txt、.docx 与 .css';
    else if (code === 'empty_text') msg = '未能识别到文字内容';
    else if (code === 'jszip_missing') msg = '文档解析库未加载';
    else if (code === 'import_module_missing') msg = '文档解析模块未加载';
    else if (code === 'no_file') return;
    if (typeof toastFn === 'function') toastFn(msg);
  }

  global.miyaBeautifyDocImport = {
    ACCEPT: FILE_ACCEPT,
    extractCssFromText: extractCssFromText,
    importFileToTextarea: importFileToTextarea,
    pickAndImport: pickAndImport,
    toastError: toastError
  };
})(window);
