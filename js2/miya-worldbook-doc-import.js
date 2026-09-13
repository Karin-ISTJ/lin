/**
 * Miya · 文档导入引擎
 * ------------------------------------------------------------------
 * 对外只暴露一个函数：
 *   global.miyaWorldbookExtractFileText(file, opts) -> Promise<string>
 *
 * 支持格式：
 *   .txt / .md / .json / .csv / .log / .yaml / .css  —— 纯文本直读（剥 BOM、统一换行）
 *   .docx                                            —— JSZip 解包 word/document.xml 提取正文
 *
 * 约定：失败时 reject(new Error(code))，code 为下列之一，调用方据此给出本地化提示：
 *   no_file            未拿到文件
 *   unsupported_type   扩展名不支持
 *   jszip_missing      需要 JSZip 但未加载（仅 docx 路径）
 *   read_failed        读盘失败 / 压缩包损坏 / 文档结构异常
 *
 * 说明：本模块为 W3 修复产物。原文件在 v15 中为 0 字节，导致世界书、小剧场、
 * 联系人、聊天美化、离线美化共 5 处「快捷导入」全部不可用。
 */
(function (global) {
  'use strict';

  /** 纯文本类扩展名：不走解包，直接读字符串 */
  var PLAIN_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml', 'css'];
  /** 需要 JSZip 解包的扩展名 */
  var ZIP_EXTS = ['docx'];
  /** MIME 兜底：name 为空时靠 type 判断 */
  var PLAIN_MIMES = /^text\//i;
  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  function fail(code) {
    var err = new Error(code);
    err.code = code;
    return err;
  }

  /** 取小写扩展名（不含点）；无扩展名返回空串 */
  function extOf(name) {
    var n = String(name || '');
    var i = n.lastIndexOf('.');
    if (i < 0 || i === n.length - 1) return '';
    return n.slice(i + 1).toLowerCase();
  }

  /**
   * 按扩展名 / MIME 判定处理方式。
   * @returns {'plain'|'zip'|''} 空串表示不支持
   */
  function classify(file) {
    var ext = extOf(file && file.name);
    if (PLAIN_EXTS.indexOf(ext) >= 0) return 'plain';
    if (ZIP_EXTS.indexOf(ext) >= 0) return 'zip';
    if (!ext) {
      // 无扩展名时退化为 MIME 判断
      var mime = String((file && file.type) || '');
      if (DOCX_MIME === mime) return 'zip';
      if (PLAIN_MIMES.test(mime)) return 'plain';
    }
    return '';
  }

  /** 去 BOM + 统一换行为 \n，避免 Windows 稿件的 \r 混入正文 */
  function tidy(text) {
    return String(text == null ? '' : text)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
  }

  /** 读成字符串（优先 FileReader，回退 Blob.text） */
  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'function') {
        try {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(fail('read_failed')); };
          fr.readAsText(file, 'utf-8');
          return;
        } catch (e) { /* 落到回退路径 */ }
      }
      if (file && typeof file.text === 'function') {
        file.text().then(resolve).catch(function () { reject(fail('read_failed')); });
        return;
      }
      reject(fail('read_failed'));
    });
  }

  /** 读成 ArrayBuffer（给 JSZip 用） */
  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'function') {
        try {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(fail('read_failed')); };
          fr.readAsArrayBuffer(file);
          return;
        } catch (e) { /* 落到回退路径 */ }
      }
      if (file && typeof file.arrayBuffer === 'function') {
        file.arrayBuffer().then(resolve).catch(function () { reject(fail('read_failed')); });
        return;
      }
      reject(fail('read_failed'));
    });
  }

  /* ---------------- WordprocessingML 解析 ---------------- */

  var ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

  /** 还原 XML 实体（含数字实体），避免正文残留 &amp; 之类 */
  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return m; }
      })
      .replace(/&#(\d+);/g, function (m, dec) {
        try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return m; }
      })
      .replace(/&(amp|lt|gt|quot|apos);/g, function (m) { return ENTITIES[m]; });
  }

  /** 抽取单个段落内的文本，处理 tab / br / cr */
  function extractParaText(inner) {
    var buf = [];
    var re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;
    var m;
    while ((m = re.exec(inner)) !== null) {
      if (m[1] !== undefined) buf.push(decodeEntities(m[1]));
      else if (/^<w:tab/.test(m[0])) buf.push('\t');
      else buf.push('\n');   // br / cr -> 换行，不另起段落
    }
    return buf.join('');
  }

  /**
   * 从 document.xml 抽取纯文本。
   *   <w:p>     段落边界 -> 换行
   *   <w:t>     文本片段 -> 原文
   *   <w:tab/>  制表符   <w:br/> <w:cr/>  软换行
   * 跳过 <w:instrText>（域代码）与 <w:del>（修订删除内容），这两者不属于正文。
   */
  function parseDocumentXml(xml) {
    var s = String(xml || '');
    s = s.replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '');
    s = s.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '');

    var out = [];
    /* 注意分支顺序与排他：自闭合 <w:p/> 必须放在前面，且开闭分支要排除以 "/" 结尾的标签。
       否则 <w:p\b[^>]*> 会先把 <w:p/> 吞掉，再把后续内容当成自己的子节点，
       导致 Word 里的空行（自闭合空段落）被静默吃掉。 */
    var paraRe = /<w:p\b[^>]*\/>|<w:p\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/w:p>/g;
    var m;
    var matched = false;
    while ((m = paraRe.exec(s)) !== null) {
      matched = true;
      if (m[1] === undefined) { out.push(''); continue; }  // 自闭合空段落 -> 空行
      out.push(extractParaText(m[1]));
    }

    if (!matched) return tidy(extractParaText(s)).trim();  // 非标准文档，退化为全文抽文本

    var text = out.join('\n').replace(/\n{3,}/g, '\n\n');  // 连续空行压缩
    return tidy(text).replace(/^\n+/, '').replace(/\n+$/, '');
  }

  /** 解包 docx：优先 word/document.xml，兼容大小写/路径差异 */
  function docxToText(file) {
    var JSZip = global.JSZip;
    if (typeof JSZip !== 'function') return Promise.reject(fail('jszip_missing'));
    return readAsArrayBuffer(file).then(function (buf) {
      return JSZip.loadAsync(buf);
    }).then(function (zip) {
      var target = zip.file('word/document.xml');
      if (!target) {
        var found = null;
        zip.forEach(function (path, entry) {
          if (!found && /(^|\/)document\.xml$/i.test(path)) found = entry;
        });
        target = found;
      }
      if (!target) return Promise.reject(fail('read_failed'));
      return target.async('string');
    }).then(function (xml) {
      return parseDocumentXml(xml);
    }).catch(function (err) {
      if (err && err.code) return Promise.reject(err);  // 已带 code 的直接透传
      return Promise.reject(fail('read_failed'));
    });
  }

  /* ---------------- 对外入口 ---------------- */

  /**
   * @param {File} file     用户选择的文件
   * @param {Object} [opts] 预留：{ maxChars } 截断上限
   * @returns {Promise<string>}
   */
  function miyaWorldbookExtractFileText(file, opts) {
    opts = opts || {};
    if (!file) return Promise.reject(fail('no_file'));

    var kind = classify(file);
    if (!kind) return Promise.reject(fail('unsupported_type'));

    var p = kind === 'zip' ? docxToText(file) : readAsText(file).then(tidy);

    var maxChars = Number(opts.maxChars);
    if (isFinite(maxChars) && maxChars > 0) {
      p = p.then(function (text) {
        var t = String(text || '');
        return t.length > maxChars ? t.slice(0, maxChars) : t;
      });
    }
    return p;
  }

  global.miyaWorldbookExtractFileText = miyaWorldbookExtractFileText;
  /* 注：原 global.miyaWorldbookDocImport 聚合导出（version/extract/PLAIN_EXTS/ZIP_EXTS）
     无任何外部引用，v36 批次 4 移除。真正的对外接口是上面的
     global.miyaWorldbookExtractFileText，被 miya-contacts-app.js、
     miya-worldbook-app.js、miya-beautify-doc-import.js 三处调用。 */
})(typeof window !== 'undefined' ? window : this);
