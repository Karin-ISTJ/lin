/*
 * 备份导入导出引擎。
 *
 * ── 为什么从设置 App 里搬出来 ──────────────────────────────────
 *
 * 这段代码原本长在 `miya-settings-app.js` —— 一个叫「设置 App」的文件。
 * 它做的其实是**数据层**的事：把 localStorage + 若干 IndexedDB
 * blob 库打包成一个 zip，以及反向还原。整个过程不碰任何设置界面。
 *
 * 随着「桌面设置」这个入口被删除，这段引擎必须独立存活：
 * 它现在由聊天设置的「备份与恢复」分区调用。
 *
 * ── 三段式结构（与旧实现一致）────────────────────────────────
 *
 *   轻量导出   只带 miya-theme-media（主题素材），体积小、日常用
 *   完整导出   额外带上聊天图片与提示音（可能几百 MB）
 *   导入       自动识别 JSON 单文件 或 ZIP 包，逐项还原
 *
 * ── 进度 UI 的归属 ──────────────────────────────────────────
 *
 * 导出可能耗时十几秒，必须有进度反馈，否则用户会以为卡死。
 * 进度浮层（.st-backup-progress）由本模块自己创建并挂在 body 上，
 * 放在 backup 模块里比放在设置 App 里更合适 ——
 * 导出进度和「设置界面」本身没有关系。
 */
(function (global) {
  'use strict';

  var BACKUP_VERSION = 4;
  var LS_PLACEHOLDER_JSON = '{"__storedInIdb":true}';
  var LS_SPILL_BYTES = global.miyaLsSpillBytes || 49152;

  var BACKUP_IDB_STORES_BASE = [
    { file: 'idb/miya-theme-media_blobs.json', db: 'miya-theme-media', store: 'blobs', label: '主题素材', blob: true }
  ];

  var BACKUP_IDB_STORES_HEAVY = [
    { file: 'idb/miya-chat-media_blobs.json', db: 'miya-chat-media', store: 'blobs', label: '聊天图片', blob: true },
    { file: 'idb/miya-msg-sound-v1_blobs.json', db: 'miya-msg-sound-v1', store: 'blobs', label: '提示音', blob: true }
  ];

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    if (typeof global.miyaToast === 'function') return global.miyaToast(msg);
  }

  /* 与 miya-settings-app.js 里同名函数行为一致：有 miyaDialog 就用它，
     否则退到原生 confirm/alert。搬迁时保留这个回退，桌面壳里
     miyaDialog 可能尚未加载。 */
  function dialog(opts) {
    if (global.miyaDialog) {
      if (opts.mode === 'confirm') return global.miyaDialog.confirm(opts);
      if (opts.mode === 'prompt') return global.miyaDialog.prompt(opts);
      return global.miyaDialog.alert(opts);
    }
    if (opts.mode === 'confirm') return Promise.resolve(confirm((opts.title || '') + '\n' + (opts.message || '')));
    return Promise.resolve(alert((opts.title || '') + '\n' + (opts.message || '')));
  }

  /* 外部数据被整体替换后，通知各 store 丢掉缓存。
     不清会让界面继续显示刚被覆盖掉的旧数据。 */
  function invalidateAllCaches() {
    if (typeof global.miyaInvalidateApiConfigCache === 'function') global.miyaInvalidateApiConfigCache();
    if (global.miyaWorldbookStore && global.miyaWorldbookStore.invalidateCache) global.miyaWorldbookStore.invalidateCache();
    if (global.miyaContactsStore && global.miyaContactsStore.invalidateCache) global.miyaContactsStore.invalidateCache();
    if (global.miyaChatStore && global.miyaChatStore.invalidateCache) global.miyaChatStore.invalidateCache();
    if (global.miyaChatGlobalSettings && global.miyaChatGlobalSettings.invalidateCache) global.miyaChatGlobalSettings.invalidateCache();
    if (global.miyaDiaryStore && global.miyaDiaryStore.invalidateCache) global.miyaDiaryStore.invalidateCache();
    if (global.miyaWeatherStore && global.miyaWeatherStore.invalidateCache) global.miyaWeatherStore.invalidateCache();
    if (global.miyaCoupleStore && global.miyaCoupleStore.invalidateCache) global.miyaCoupleStore.invalidateCache();
    if (global.miyaCoupleWhisperStore && global.miyaCoupleWhisperStore.invalidateCache) global.miyaCoupleWhisperStore.invalidateCache();
    if (global.miyaItineraryStore && global.miyaItineraryStore.invalidateCache) global.miyaItineraryStore.invalidateCache();
    if (global.MiyaAppointmentStore && global.MiyaAppointmentStore.invalidateCache) global.MiyaAppointmentStore.invalidateCache();
    if (global.MiyaChatAlbum && global.MiyaChatAlbum.invalidateCache) global.MiyaChatAlbum.invalidateCache();
    if (global.MiyaMsgSound && typeof global.MiyaMsgSound.invalidateCache === 'function') global.MiyaMsgSound.invalidateCache();
    if (global.miyaApiPresets && global.miyaApiPresets.invalidate) global.miyaApiPresets.invalidate();
  }

  function exportYield(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms == null ? 0 : ms); });
  }

  var backupProgressUi = null;

  function ensureBackupProgress() {
    if (backupProgressUi) return backupProgressUi;
    /*
     * 旧实现把浮层挂进 #miya-settings-app，并且在它不存在时直接 return null
     * （末尾有 `if (!app) return null;`）。桌面设置 App 删掉之后，
     * 那个判断会让进度条**永远不显示** —— 而导出大包要跑十几秒，
     * 用户会以为点了没反应。
     *
     * 现在改为直接挂 body：进度浮层本来就与「设置界面」无关，
     * 它是导出这个动作自己的反馈。CSS 用的是 position:fixed，挂哪都一样。
     */
    var root = document.createElement('div');
    root.className = 'st-backup-progress';
    root.id = 'miya-st-backup-progress';
    root.hidden = true;
    root.innerHTML =
      '<div class="st-backup-progress__veil"></div>' +
      '<div class="st-backup-progress__panel">' +
        '<p class="st-backup-progress__title" id="miya-st-backup-progress-title">正在导出</p>' +
        '<p class="st-backup-progress__status" id="miya-st-backup-progress-status">准备中…</p>' +
        '<div class="st-backup-progress__bar"><div class="st-backup-progress__fill" id="miya-st-backup-progress-fill"></div></div>' +
        '<p class="st-backup-progress__pct" id="miya-st-backup-progress-pct">0%</p>' +
      '</div>';
    document.body.appendChild(root);
    backupProgressUi = {
      root: root,
      title: root.querySelector('#miya-st-backup-progress-title'),
      status: root.querySelector('#miya-st-backup-progress-status'),
      fill: root.querySelector('#miya-st-backup-progress-fill'),
      pct: root.querySelector('#miya-st-backup-progress-pct')
    };
    return backupProgressUi;
  }

  function setBackupProgress(pct, status, title) {
    var panel = ensureBackupProgress();
    if (!panel) return;
    panel.root.hidden = false;
    panel.root.classList.add('is-show');
    var p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (panel.fill) panel.fill.style.width = p + '%';
    if (panel.pct) panel.pct.textContent = p + '%';
    if (status && panel.status) panel.status.textContent = status;
    if (title && panel.title) panel.title.textContent = title;
  }

  function hideBackupProgress() {
    if (!backupProgressUi) return;
    backupProgressUi.root.classList.remove('is-show');
    backupProgressUi.root.hidden = true;
    if (backupProgressUi.fill) backupProgressUi.fill.style.width = '0%';
    if (backupProgressUi.pct) backupProgressUi.pct.textContent = '0%';
  }

  function collectLocalStorageForBackup() {
    var ls = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        var raw = localStorage.getItem(k);
        if (global.miyaLsIsIdbPlaceholder && global.miyaLsIsIdbPlaceholder(raw)) continue;
        ls[k] = raw;
      }
    } catch (e) {}
    return ls;
  }

  function getBackupIdbSpecs(includeHeavyMedia) {
    var specs = BACKUP_IDB_STORES_BASE.slice();
    if (includeHeavyMedia) specs = specs.concat(BACKUP_IDB_STORES_HEAVY);
    return specs;
  }

  async function exportIdbSpecToBuilder(builder, spec, rangeStart, rangeSize, onRangeProgress) {
    if (spec.blob && global.miyaExportIdbBlobStoreToZipBuilder) {
      var mediaDir = 'media/' + spec.db;
      var index = await global.miyaExportIdbBlobStoreToZipBuilder(
        builder,
        spec.db,
        spec.store,
        mediaDir,
        function (done, total) {
          var sub = total > 0 ? done / total : 0;
          var pct = rangeStart + sub * rangeSize * 0.9;
          var detail = total > 0 ? ' (' + done + '/' + total + ')' : '';
          onRangeProgress(pct, '正在导出' + spec.label + '…' + detail);
        }
      );
      var indexJson = global.miyaSafeJsonStringify ? global.miyaSafeJsonStringify(index) : JSON.stringify(index || {});
      if (indexJson == null) indexJson = '{}';
      var indexBlob = new Blob([indexJson], { type: 'application/json' });
      index = null;
      indexJson = null;
      await builder.addFile(spec.file, indexBlob);
      indexBlob = null;
      onRangeProgress(rangeStart + rangeSize, '已导出' + spec.label);
      await exportYield(30);
      return;
    }
    var jsonBlob = await global.miyaExportIdbStoreToJsonBlob(
      spec.db,
      spec.store,
      null,
      function (done, total) {
        var sub = total > 0 ? done / total : 0;
        var pct = rangeStart + sub * rangeSize;
        var detail = total > 0 ? ' (' + done + '/' + total + ')' : '';
        onRangeProgress(pct, '正在导出' + spec.label + '…' + detail);
      }
    );
    await builder.addFile(spec.file, jsonBlob);
    jsonBlob = null;
    await exportYield(30);
  }

  function makeZipMediaResolver(zipLike) {
    return function (mediaPath) {
      var entry = zipLike.file(String(mediaPath || ''));
      if (!entry) return Promise.resolve(null);
      try {
        var ret = entry.async('blob');
        if (ret && typeof ret.then === 'function') {
          return ret.then(function (b) { return b || null; }).catch(function () { return null; });
        }
        return Promise.resolve(ret || null);
      } catch (e) {
        return Promise.resolve(null);
      }
    };
  }

  async function importIdbJsonFile(data, spec, resolveMedia, onProgress, opts) {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return;
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    opts = opts || {};
    if (spec.blob) {
      if (global.miyaImportNamedDbBlobsSequential) {
        await global.miyaImportNamedDbBlobsSequential(
          spec.db,
          spec.store,
          data,
          resolveMedia,
          function (done, total) {
            var detail = total > 0 ? ' (' + done + '/' + total + ')' : '';
            var sub = total > 0 ? done / total : 1;
            onProgress('正在恢复' + spec.label + '…' + detail, sub);
          },
          { append: !!opts.append }
        );
      } else if (spec.file === 'idb/miya-theme-media_blobs.json' && global.miyaImportThemeMediaDb) {
        await global.miyaImportThemeMediaDb(data);
      } else if (spec.file === 'idb/miya-chat-media_blobs.json' && global.miyaImportChatMediaDb) {
        await global.miyaImportChatMediaDb(data);
      } else if (global.miyaImportNamedDbBlobs) {
        await global.miyaImportNamedDbBlobs(spec.db, spec.store, data);
      }
      return;
    }
    if (global.miyaKvReplaceNamedDbKv) {
      await global.miyaKvReplaceNamedDbKv(spec.db, spec.store, data);
    }
  }

  async function downloadBackupBlob(blob, fname) {
    var mb = blob && blob.size ? (blob.size / (1024 * 1024)).toFixed(1) : '';
    setBackupProgress(96, mb
      ? ('正在下载单个 ZIP（约 ' + mb + ' MB）…')
      : '正在触发下载…');
    var ok = false;
    if (global.miyaDownloadBlobAsync) {
      ok = await global.miyaDownloadBlobAsync(blob, fname);
    } else if (global.miyaDownloadBlob) {
      ok = global.miyaDownloadBlob(blob, fname);
    }
    return !!ok;
  }

  function backupStamp(iso) {
    return String(iso || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
  }

  function finishBackupImport() {
    invalidateAllCaches();
    if (global.MiyaImageGen && global.MiyaImageGen.invalidatePresetsCache) {
      global.MiyaImageGen.invalidatePresetsCache();
    }
    if (global.miyaContactsRelationshipStore && typeof global.miyaContactsRelationshipStore.invalidateCache === 'function') {
      global.miyaContactsRelationshipStore.invalidateCache();
    }
    if (typeof global.miyaHydrateTheme === 'function') {
      global.miyaHydrateTheme().catch(function () {});
    }
  }

  /**
   * 单个 ZIP 导出：OPFS 落盘（Safari 走 Worker sync handle），最终仍是一个文件。
   * 禁止为完整导出回退内存打包——那会在最后一步把几百 MB 塞进 RAM 闪退。
   */
  async function runExportBackup(opts) {
    opts = opts || {};
    var includeHeavyMedia = !!opts.includeHeavyMedia;
    if (typeof global.miyaZipCreateStoreWriter !== 'function' &&
        typeof global.miyaZipCreateStoreBuilder !== 'function') {
      toast('压缩组件未加载，请刷新页面后重试');
      return;
    }
    var title = includeHeavyMedia ? '完整导出' : '轻量导出';
    setBackupProgress(0, '准备导出…', title);
    var writer = null;
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        try { await navigator.storage.persist(); } catch (ePersist) {}
      }

      var exportedAt = new Date().toISOString();
      var stamp = backupStamp(exportedAt);
      var suffix = includeHeavyMedia ? 'full' : 'lite';
      var fname = 'miya-backup-' + suffix + '-' + stamp + '.zip';
      var idbSpecs = getBackupIdbSpecs(includeHeavyMedia);
      var idbRange = 78;
      var idbEach = idbSpecs.length ? idbRange / idbSpecs.length : idbRange;

      setBackupProgress(1, '正在打开磁盘写入…');
      if (typeof global.miyaZipCreateStoreWriter === 'function') {
        writer = await global.miyaZipCreateStoreWriter({
          fileName: fname,
          requireOpfs: !!includeHeavyMedia
        });
      } else {
        writer = global.miyaZipCreateStoreBuilder();
      }
      if (includeHeavyMedia && writer.backend === 'memory') {
        throw new Error('当前浏览器无法落盘写大文件，请用 Safari 打开本站后重试完整导出');
      }
      var backendHint = writer.backend && writer.backend.indexOf('opfs') === 0
        ? '（已落盘，可导出数百 MB）'
        : '';

      setBackupProgress(2, '正在收集本地设置…' + backendHint);
      var ls = collectLocalStorageForBackup();
      var lsBlob = new Blob([JSON.stringify(ls)], { type: 'application/json' });
      ls = null;
      await writer.addFile('localStorage.json', lsBlob);
      lsBlob = null;
      await exportYield(20);

      setBackupProgress(5, '正在导出扩展数据…');
      var kvBlob;
      if (global.miyaKvIdbExportToJsonBlob) {
        kvBlob = await global.miyaKvIdbExportToJsonBlob(function (done, total) {
          var sub = total > 0 ? done / total : 0;
          setBackupProgress(5 + sub * 4, '正在导出扩展数据…' + (total ? ' (' + done + '/' + total + ')' : ''));
        });
      } else {
        var kv = await global.miyaKvIdbExportAllEntries().catch(function () { return {}; });
        var kvJson = global.miyaSafeJsonStringify ? global.miyaSafeJsonStringify(kv) : JSON.stringify(kv);
        if (kvJson == null) throw new Error('stringify_failed');
        kvBlob = new Blob([kvJson], { type: 'application/json' });
        kv = null;
        kvJson = null;
      }
      await writer.addFile('indexedDB_kv.json', kvBlob);
      kvBlob = null;
      await exportYield(20);

      for (var i = 0; i < idbSpecs.length; i++) {
        await exportIdbSpecToBuilder(
          writer,
          idbSpecs[i],
          10 + i * idbEach,
          idbEach,
          function (pct, status) { setBackupProgress(pct, status); }
        );
        await exportYield(30);
      }

      var manifest = {
        v: BACKUP_VERSION,
        app: 'miya-mini-phone',
        format: 'zip',
        mediaLayout: 'bin',
        zipMethod: 'store',
        zipBackend: writer.backend || 'memory',
        exportedAt: exportedAt,
        includeHeavyMedia: includeHeavyMedia,
        files: ['manifest.json', 'localStorage.json', 'indexedDB_kv.json'].concat(
          idbSpecs.map(function (s) { return s.file; })
        )
      };
      await writer.addFile('manifest.json', new Blob([JSON.stringify(manifest)], { type: 'application/json' }));

      setBackupProgress(92, '正在封包…');
      await exportYield(40);
      var blob = await writer.finish();
      await exportYield(40);

      var mb = blob && blob.size ? (blob.size / (1024 * 1024)).toFixed(1) : '?';
      setBackupProgress(96, '正在保存单个 ZIP（约 ' + mb + ' MB）…');
      var ok = await downloadBackupBlob(blob, fname);
      await exportYield(Math.min(120000, Math.max(8000, Math.floor((blob && blob.size ? blob.size : 0) / (512 * 1024)))));
      blob = null;
      if (writer && typeof writer.cleanup === 'function') {
        await writer.cleanup().catch(function () {});
      }
      writer = null;
      hideBackupProgress();
      if (!ok) {
        toast('未保存成功：请允许下载，或到 Safari 下载列表里查看');
        return;
      }
      toast(includeHeavyMedia ? '完整 ZIP 已开始下载（单个文件）' : '轻量 ZIP 已导出');
    } catch (e) {
      if (writer && typeof writer.cleanup === 'function') {
        try { await writer.cleanup(); } catch (e0) {}
      }
      writer = null;
      hideBackupProgress();
      var msg = e && e.message ? String(e.message) : '';
      toast(msg && msg !== 'stringify_failed'
        ? ('导出失败：' + msg)
        : '导出失败：请用 Safari 打开后重试');
    }
  }

  function exportBackup() {
    runExportBackup({ includeHeavyMedia: false });
  }

  function exportBackupFull() {
    runExportBackup({ includeHeavyMedia: true });
  }

  function parseBackupJsonText(text) {
    try {
      return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
    } catch (e) {
      return null;
    }
  }

  function applyBackupLocalStorage(ls) {
    /* 恢复备份时最怕「看起来成功了，其实大部分 key 没写进去」——
       用户在别的机器上恢复完，发现数据只回来一半，还以为是备份文件损坏。
       这里把失败数收集起来，交给调用方提示。

       ── 快照 + **双向**回填 ──
       clear 与逐项写入之间不是原子操作，一旦中途配额不足 / 页面被杀，
       旧数据已清、新数据只到一半。所以先拍快照，失败时回填。

       回填必须是双向的，只补「旧有、新包没有」的 key 是不够的：
         a) 本地独有的旧 key（新包没带）      → 回填旧值   ✔ 原实现已覆盖
         b) 新包要写、但**写失败**的 key      → 恢复旧值   ✘ 原实现漏了
           这类 key 在 clear() 之后彻底消失，而导入前它可能好好的
           （备份包缺字段、或该版本还没这个 key）。
       两者都要救，才叫「尽力恢复现场」。

       另外记录 snapshotFailed / clearFailed —— 快照失败（隐私模式、
       配额已满）意味着**根本没有回滚能力**，这种「裸奔导入」必须让
       调用方知道，不能再静默吞掉。 */
    var failed = 0;
    var snapshot = {};
    var snapshotFailed = false;
    try {
      for (var s = 0; s < localStorage.length; s++) {
        var sk = localStorage.key(s);
        if (!sk) continue;
        snapshot[sk] = localStorage.getItem(sk);
      }
    } catch (eSnap) {
      snapshotFailed = true;
    }
    /*
     * miyaSafeLsSet 在 localStorage 配额不足时会把值**溢出到 IDB**，
     * 这些 key 已经不在 localStorage 里了，却仍是用户的数据。
     * 只遍历 localStorage 的快照会漏掉它们，回填时被当成「本来就没有」。
     * 用 miyaKvKeyNeedsAsyncHydrate 把这类 key 一并纳入快照。
     */
    var spillKeys = [];
    try {
      var allKeys = Object.keys(snapshot);
      if (typeof global.miyaKvKeyNeedsAsyncHydrate === 'function') {
        /* 已知会走 KV 的 key 前缀（与 storage-usage 的 CATALOG 同源） */
        var KNOWN_KV = [
          'miya-appointment-v1', 'miya-chat-store-v1', 'miya-contacts-v1',
          'miya-worldbook-v1', 'miya-api-config', 'miya-chat-global-settings-v1',
          'miya-memory-tables-v1', 'miya-memory-table-settings-v1',
          'miya-backup-v1'
        ];
        KNOWN_KV.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(snapshot, k)) return;
          try {
            if (global.miyaKvKeyNeedsAsyncHydrate(k)) {
              var mem = global.__miyaKvMem && global.__miyaKvMem[k];
              if (mem != null) {
                snapshot[k] = typeof mem === 'string' ? mem : JSON.stringify(mem);
                spillKeys.push(k);
              }
            }
          } catch (eSpill) {}
        });
      }
    } catch (eKV) {}

    var clearFailed = false;
    try { localStorage.clear(); } catch (e0) { clearFailed = true; }
    Object.keys(ls || {}).forEach(function (k) {
      var v = ls[k] == null ? '' : String(ls[k]);
      var ok;
      if (typeof global.miyaSafeLsSet === 'function') {
        ok = global.miyaSafeLsSet(k, v);
      } else {
        try { localStorage.setItem(k, v); ok = true; } catch (e1) { ok = false; }
      }
      if (!ok) failed += 1;
    });
    var rolledBack = 0;
    var rollbackFailed = 0;
    if (failed > 0) {
      /*
       * 回填必须**绕过 miyaSafeLsSet**，直接写 localStorage。
       *
       * 理由：miyaSafeLsSet 失败的两个原因（配额满、隐私模式）恰恰也是
       * 回填失败的原因 —— 用同一个函数去救它自己造成的现场，是一个死循环：
       *   写入失败 → 回填 → 又失败 → 数据永久丢失。
       * 实测就踩到了这个坑：强制让 key B 写入失败后，回填走同一个桩，
       * B 依然填不回去，最终被清成 null。
       *
       * 直写 localStorage 是最底层的一手：绕开配额预检与溢出逻辑，
       * 由浏览器自己裁决。旧数据一般比新数据小，直写的成功率明显更高。
       */
      Object.keys(snapshot).forEach(function (k) {
        var incoming = Object.prototype.hasOwnProperty.call(ls, k) && ls[k] != null;
        /* 已写成功的新 key 别拿旧值盖掉；写失败的才需要救 */
        if (incoming) {
          var cur = null;
          try { cur = localStorage.getItem(k); } catch (eCur) {}
          if (cur != null && cur === String(ls[k])) return;
        }
        var ok = false;
        try { localStorage.setItem(k, snapshot[k]); ok = true; } catch (e2) { ok = false; }
        if (ok) rolledBack += 1;
        else rollbackFailed += 1;
      });
    }
    return {
      total: Object.keys(ls || {}).length,
      failed: failed,
      rolledBack: rolledBack,
      rollbackFailed: rollbackFailed,
      snapshotFailed: snapshotFailed,
      clearFailed: clearFailed,
      spillKeys: spillKeys.length
    };
  }

  async function restoreBackupPayload(raw, onProgress) {
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    var ls = raw.localStorage || raw.ls;
    if (!ls || typeof ls !== 'object') throw new Error('invalid_localStorage');

    onProgress(8, '正在导入扩展数据…');
    var kv = raw.indexedDB_kv || raw.indexedDbKv || {};
    await global.miyaKvIdbReplaceAllEntries(kv);

    var idbSpecs = getBackupIdbSpecs(true);
    var legacyMap = {
      'idb/miya-theme-media_blobs.json': raw.indexedDB_miya_theme_media,
      'idb/miya-chat-media_blobs.json': raw.indexedDB_miya_chat_media,
      'idb/miya-msg-sound-v1_blobs.json': raw.indexedDB_miya_msg_sound
    };
    var idbRange = 72;
    var idbEach = idbSpecs.length ? idbRange / idbSpecs.length : idbRange;

    for (var i = 0; i < idbSpecs.length; i++) {
      var spec = idbSpecs[i];
      var data = legacyMap[spec.file];
      if (!data) continue;
      onProgress(12 + i * idbEach, '正在恢复' + spec.label + '…');
      await importIdbJsonFile(data, spec, null, function (status) {
        onProgress(12 + i * idbEach, status);
      });
      await exportYield();
    }

    onProgress(88, '正在写入本地设置…');
    var lsResult = applyBackupLocalStorage(ls);
    finishBackupImport();
    if (lsResult && lsResult.failed > 0) {
      toast('本地设置写入失败 ' + lsResult.failed + '/' + lsResult.total +
        ' 项（可能空间不足），已尝试回填 ' + (lsResult.rolledBack || 0) + ' 项');
    }
    if (lsResult && (lsResult.snapshotFailed || lsResult.clearFailed)) {
      toast('警告：导入前快照/清空未成功，本次导入无回滚保护');
    }
    onProgress(100, '导入完成');
  }

  function findSpecByMediaPart(manifest) {
    var all = BACKUP_IDB_STORES_BASE.concat(BACKUP_IDB_STORES_HEAVY);
    if (manifest && manifest.mediaFile) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].file === manifest.mediaFile) return all[i];
      }
    }
    if (manifest && manifest.mediaDb) {
      for (var j = 0; j < all.length; j++) {
        if (all[j].db === manifest.mediaDb) return all[j];
      }
    }
    return null;
  }

  async function openBackupZip(file) {
    /* 优先低内存 STORE 读取；旧 DEFLATE 包再回退 JSZip */
    if (typeof global.miyaZipOpenFromBlob === 'function') {
      try {
        var storeZip = await global.miyaZipOpenFromBlob(file);
        if (storeZip && !storeZip.needsJszip) return storeZip;
      } catch (eStore) {}
    }
    if (!global.JSZip) throw new Error('jszip_missing');
    return global.JSZip.loadAsync(file);
  }

  async function importOneBackupZip(file) {
    var zip = await openBackupZip(file);
    var manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw new Error('missing_manifest');
    var manifest = parseBackupJsonText(await manifestEntry.async('string'));
    if (!manifest || manifest.app !== 'miya-mini-phone') throw new Error('invalid_manifest');

    var part = String(manifest.part || '');
    var isMediaPart = part.indexOf('media:') === 0;
    var resolveMedia = makeZipMediaResolver(zip);

    if (isMediaPart) {
      var mediaSpec = findSpecByMediaPart(manifest);
      if (!mediaSpec) throw new Error('unknown_media_part');
      var mediaEntry = zip.file(mediaSpec.file);
      if (!mediaEntry) throw new Error('missing_media_index');
      setBackupProgress(20, '正在恢复' + (mediaSpec.label || mediaSpec.db) + '…');
      var mediaData = parseBackupJsonText(await mediaEntry.async('string'));
      var append = !!(manifest.mediaChunkAppend || (manifest.mediaChunk > 0));
      await importIdbJsonFile(mediaData, mediaSpec, resolveMedia, function (status) {
        setBackupProgress(40, status);
      }, { append: append });
      return { manifest: manifest, kind: 'media' };
    }

    var lsEntry = zip.file('localStorage.json');
    if (!lsEntry) throw new Error('missing_localStorage');
    var ls = parseBackupJsonText(await lsEntry.async('string'));
    if (!ls || typeof ls !== 'object') throw new Error('invalid_localStorage');

    setBackupProgress(3, '正在读取扩展数据…');
    var kvEntry = zip.file('indexedDB_kv.json');
    var kv = {};
    if (kvEntry) {
      var kvText = await kvEntry.async('string');
      setBackupProgress(5, '正在解析扩展数据…');
      kv = parseBackupJsonText(kvText) || {};
      kvText = null;
    }
    setBackupProgress(6, '正在写入扩展数据…');
    await global.miyaKvIdbReplaceAllEntries(kv && typeof kv === 'object' ? kv : {}, function (done, total) {
      var sub = total > 0 ? done / total : 1;
      setBackupProgress(6 + sub * 6, '正在写入扩展数据…' + (total ? ' (' + done + '/' + total + ')' : ''));
    });
    kv = null;

    var idbSpecs = getBackupIdbSpecs(!!manifest.includeHeavyMedia);
    if (!manifest.includeHeavyMedia) {
      idbSpecs = BACKUP_IDB_STORES_BASE.slice();
    }
    var idbRange = 72;
    var idbEach = idbSpecs.length ? idbRange / idbSpecs.length : idbRange;
    for (var i = 0; i < idbSpecs.length; i++) {
      var spec = idbSpecs[i];
      var entry = zip.file(spec.file);
      if (!entry) continue;
      var rangeStart = 14 + i * idbEach;
      setBackupProgress(rangeStart, '正在读取' + spec.label + '索引…');
      var dataText = await entry.async('string');
      var data = parseBackupJsonText(dataText);
      dataText = null;
      var keyCount = data && typeof data === 'object' ? Object.keys(data).length : 0;
      setBackupProgress(rangeStart, '正在恢复' + spec.label + '…' + (keyCount ? ' (0/' + keyCount + ')' : ''));
      await importIdbJsonFile(data, spec, resolveMedia, function (status, sub) {
        var pct = rangeStart + (typeof sub === 'number' ? sub : 0) * idbEach * 0.95;
        setBackupProgress(pct, status);
      });
      data = null;
      await exportYield();
    }

    setBackupProgress(88, '正在写入本地设置…');
    var lsResultFull = applyBackupLocalStorage(ls);
    finishBackupImport();
    /*
     * ZIP 是主推的导入方式，但它的失败提示之前一直是缺的 ——
     * 只把 lsFailed 塞进返回值，调用方 importBackupZipFiles 不读它，
     * 于是「本地设置写了一半」这件事用户永远看不到（JSON 路径有 toast）。
     * 这里补齐，并把「无法回滚」的严重情况单独说清楚。
     */
    if (lsResultFull && lsResultFull.failed > 0) {
      toast('本地设置写入失败 ' + lsResultFull.failed + '/' + lsResultFull.total +
        ' 项（可能空间不足），已尝试回填 ' + (lsResultFull.rolledBack || 0) + ' 项');
    }
    if (lsResultFull && (lsResultFull.snapshotFailed || lsResultFull.clearFailed)) {
      toast('警告：导入前快照/清空未成功，本次导入无回滚保护');
    }
    return { manifest: manifest, kind: 'full', lsFailed: (lsResultFull && lsResultFull.failed) || 0 };
  }

  async function importBackupZipFiles(files) {
    var list = Array.prototype.slice.call(files || []).filter(Boolean);
    if (!list.length) return;
    if (!global.JSZip && typeof global.miyaZipOpenFromBlob !== 'function') {
      toast('压缩库未加载，请刷新页面后重试');
      return;
    }

    var ok = await dialog({
      mode: 'confirm',
      title: '导入数据包',
      message: list.length > 1
        ? ('将导入 ' + list.length + ' 个备份文件并覆盖当前数据，是否继续？')
        : '将覆盖当前全部本地数据，是否继续？',
      confirmText: '继续导入',
      cancelText: '取消'
    });
    if (!ok) return;

    setBackupProgress(0, '正在读取 ZIP…', '导入数据');
    try {
      if (list.length === 1) {
        await importOneBackupZip(list[0]);
      } else {
        /* 兼容此前误导出的多分卷：按 partIndex 顺序合并导入 */
        var prepared = [];
        for (var fi = 0; fi < list.length; fi++) {
          setBackupProgress((fi / list.length) * 8, '解析文件 ' + (fi + 1) + '/' + list.length + '…');
          var z = await openBackupZip(list[fi]);
          var me = z.file('manifest.json');
          var man = me ? parseBackupJsonText(await me.async('string')) : null;
          if (!man || man.app !== 'miya-mini-phone') throw new Error('invalid_manifest');
          prepared.push({
            file: list[fi],
            manifest: man,
            partIndex: man.partIndex || (String(man.part || '').indexOf('media:') === 0 ? 99 : 1)
          });
          z = null;
          await exportYield();
        }
        prepared.sort(function (a, b) {
          var pa = a.partIndex || 0;
          var pb = b.partIndex || 0;
          if (pa !== pb) return pa - pb;
          return (a.manifest.mediaChunk || 0) - (b.manifest.mediaChunk || 0);
        });
        for (var pi = 0; pi < prepared.length; pi++) {
          setBackupProgress(8 + (pi / prepared.length) * 88, '导入 ' + (pi + 1) + '/' + prepared.length + '…');
          await importOneBackupZip(prepared[pi].file);
          await exportYield(40);
        }
      }

      hideBackupProgress();
      toast('ZIP 数据包已导入');
      dialog({
        mode: 'confirm',
        title: '导入完成',
        message: '建议刷新页面以加载全部模块。',
        confirmText: '刷新',
        cancelText: '稍后'
      }).then(function (reload) { if (reload) location.reload(); });
    } catch (e) {
      hideBackupProgress();
      toast('导入失败：' + (e && e.message ? e.message : '未知'));
    }
  }

  async function importBackupZip(file) {
    if (!file) return;
    return importBackupZipFiles([file]);
  }

  function importBackupJson(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var raw = parseBackupJsonText(reader.result);
      if (!raw) {
        toast('无效的数据包文件');
        return;
      }
      var ls = raw.localStorage || raw.ls;
      if (!ls || typeof ls !== 'object') {
        toast('数据包格式无效');
        return;
      }
      dialog({
        mode: 'confirm',
        title: '导入数据包',
        message: '将覆盖当前全部本地数据，是否继续？',
        confirmText: '继续导入',
        cancelText: '取消'
      }).then(function (ok) {
        if (!ok) return;
        setBackupProgress(0, '正在导入 JSON…', '导入数据');
        restoreBackupPayload(raw, function (pct, status) {
          setBackupProgress(pct, status);
        }).then(function () {
          hideBackupProgress();
          toast('数据包已导入');
          dialog({
            mode: 'confirm',
            title: '导入完成',
            message: '建议刷新页面以加载全部模块。',
            confirmText: '刷新',
            cancelText: '稍后'
          }).then(function (reload) { if (reload) location.reload(); });
        }).catch(function (err) {
          hideBackupProgress();
          toast('导入失败：' + (err && err.message ? err.message : '未知'));
        });
      });
    };
    reader.readAsText(file, 'utf-8');
  }

  function importBackup(fileOrFiles) {
    var files = null;
    if (fileOrFiles && fileOrFiles.length != null && typeof fileOrFiles !== 'string') {
      files = Array.prototype.slice.call(fileOrFiles);
    } else if (fileOrFiles) {
      files = [fileOrFiles];
    }
    if (!files || !files.length) return;

    var zips = [];
    var jsons = [];
    files.forEach(function (f) {
      var name = String(f.name || '').toLowerCase();
      var type = String(f.type || '').toLowerCase();
      if (name.slice(-4) === '.zip' || type.indexOf('zip') >= 0) zips.push(f);
      else jsons.push(f);
    });

    if (zips.length) {
      /* ZIP 优先；JSON 是全量覆盖包，和 ZIP 混选没有可定义的合并语义，
         但不能静默丢 —— 告知用户被忽略了，让他自己再导一次。 */
      if (jsons.length) {
        toast('已选择 ' + zips.length + ' 个 ZIP + ' + jsons.length + ' 个 JSON，将只导入 ZIP；JSON 请单独再导');
      }
      importBackupZipFiles(zips);
      return;
    }
    if (jsons.length) {
      /* JSON 包是全量覆盖语义，多选互相覆盖没有意义；
         之前这里静默只取第一个，用户根本不知道其余的被丢了。 */
      if (jsons.length > 1) {
        toast('JSON 数据包一次只能导入一个，已选用第一个，其余 ' + (jsons.length - 1) + ' 个被忽略');
      }
      importBackupJson(jsons[0]);
    }
  }
  /* ── 对外接口 ────────────────────────────────────────────────
   * 旧调用点是 miya-settings-app.js 里的 data-st-nav="export"
   * / "export-full" / "import" 三行，现在由聊天设置的备份分区调用。 */

  global.miyaBackup = {
    VERSION: BACKUP_VERSION,
    exportLight: function () { return exportBackup(); },
    exportFull: function () { return exportBackupFull(); },
    importFiles: function (fileOrFiles) { return importBackup(fileOrFiles); },
    invalidateAllCaches: invalidateAllCaches
  };
})(typeof window !== 'undefined' ? window : globalThis);
