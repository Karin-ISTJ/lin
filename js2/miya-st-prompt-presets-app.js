/**
 * ST preset manager — compact rows, multi-pack switch.
 */
(function (global) {
  'use strict';

  function store() {
    return global.miyaStPromptPresetsStore || null;
  }
  function $(id) {
    return document.getElementById(id);
  }
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var toastTimer = 0;
  function toast(msg) {
    var el = $('stp-toast');
    if (!el) return;
    el.textContent = String(msg || '');
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-show');
    }, 2200);
  }

  function root() {
    return $('miya-st-presets-app');
  }

  function renderPackSelect() {
    var st = store();
    var sel = $('stp-pack-select');
    if (!st || !sel) return;
    var packs = st.listPacks();
    var active = st.getActivePack();
    var activeId = active ? active.id : '';
    if (!packs.length) {
      sel.innerHTML = '<option value="">暂无预设包</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = packs
      .map(function (p) {
        return (
          '<option value="' +
          esc(p.id) +
          '"' +
          (p.id === activeId ? ' selected' : '') +
          '>' +
          esc(p.name) +
          '（' +
          (p.entries ? p.entries.length : 0) +
          '）</option>'
        );
      })
      .join('');
  }

  function renderList() {
    var st = store();
    var box = $('stp-list');
    if (!box || !st) return;
    renderPackSelect();
    var entries = st.listEntries();
    if (!entries.length) {
      box.innerHTML = '<div class="stp-empty">当前预设包没有条目。<br/>点「＋新增条目」手动创建，或点「导入」添加一套。</div>';
      return;
    }
    box.innerHTML = entries.map(function (e) {
      return (
        '<div class="stp-row' + (e.enabled ? '' : ' is-off') + '" data-id="' + esc(e.id) + '" draggable="true">' +
        '<button type="button" class="stp-row__drag" data-act="drag" aria-label="拖动排序" title="拖动排序">⋮⋮</button>' +
        '<label class="stp-switch" title="启用"><input type="checkbox" data-act="toggle" ' + (e.enabled ? 'checked' : '') + ' /><span></span></label>' +
        '<button type="button" class="stp-row__edit" data-act="edit" title="编辑条目">' +
          '<span class="stp-row__name" title="' + esc(e.identifier || e.name) + '">' + esc(e.name) + '</span>' +
          '<span class="stp-row__meta">' + esc(e.role || 'system') + ' · ' + (Number(e.injection_position) === 1 ? 'In-chat' : 'Relative') + '</span>' +
        '</button>' +
        '<button type="button" class="stp-row__del" data-act="del" aria-label="删除" title="删除">' +
          '<img src="img/icons/trash-01.svg" alt="" width="16" height="16">' +
        '</button>' +
        '</div>'
      );
    }).join('');
  }

  function getGeneration() {
    var st = store();
    if (st && typeof st.getActiveGeneration === 'function') return st.getActiveGeneration();
    return { contextLength: 2000000, maxTokens: 50000, n: 1, stream: true, temperature: 1, frequencyPenalty: 0, presencePenalty: 0, topP: 0.95 };
  }

  function saveGenerationFromUi() {
    var st = store();
    if (!st || typeof st.setActiveGeneration !== 'function') return;
    function n(id, fallback) { var v = Number($(id) && $(id).value); return Number.isFinite(v) ? v : fallback; }
    st.setActiveGeneration({
      contextLength: Math.max(0, n('stp-gen-context', 2000000)),
      maxTokens: Math.max(1, n('stp-gen-max', 50000)),
      n: Math.max(1, Math.min(8, Math.floor(n('stp-gen-n', 1)))),
      stream: !!($('stp-gen-stream') && $('stp-gen-stream').checked),
      temperature: Math.max(0, Math.min(2, n('stp-gen-temperature', 1))),
      frequencyPenalty: Math.max(-2, Math.min(2, n('stp-gen-frequency', 0))),
      presencePenalty: Math.max(-2, Math.min(2, n('stp-gen-presence', 0))),
      topP: Math.max(0, Math.min(1, n('stp-gen-topp', 0.95)))
    });
    toast('生成参数已保存');
  }

  function renderGeneration() {
    var g = getGeneration();
    var map = {
      'stp-gen-context': g.contextLength, 'stp-gen-max': g.maxTokens, 'stp-gen-n': g.n,
      'stp-gen-temperature': g.temperature, 'stp-gen-frequency': g.frequencyPenalty,
      'stp-gen-presence': g.presencePenalty, 'stp-gen-topp': g.topP
    };
    Object.keys(map).forEach(function (id) { if ($(id)) $(id).value = String(map[id]); });
    if ($('stp-gen-stream')) $('stp-gen-stream').checked = g.stream !== false;
    var summary = $('stp-gen-summary');
    /* 流式开关在请求层被硬编码为 false，这里不再宣称「流式」，避免误导。 */
    if (summary) summary.textContent = '温度 ' + g.temperature + ' · Top P ' + g.topP + ' · 非流式';
  }

  function openEditor(id) {
    var st = store();
    var pack = st && st.getActivePack ? st.getActivePack() : null;
    if (!pack && st && st.createPack) {
      pack = st.createPack('手动预设');
      if (pack) renderPackSelect();
    }
    if (!pack) { toast('当前没有可用的预设包'); return; }
    var e = id ? st.getEntry(id) : null;
    $('stp-editor').hidden = false;
    $('stp-editor').setAttribute('aria-hidden', 'false');
    $('stp-editor').setAttribute('data-edit-id', e ? e.id : '');
    $('stp-editor-title').textContent = e ? '编辑条目' : '新增条目';
    $('stp-edit-name').value = e ? e.name : '';
    $('stp-edit-content').value = e ? e.content : '';
    $('stp-edit-role').value = e ? e.role : 'system';
    $('stp-edit-position').value = e ? (Number(e.injection_position) === 1 || e.position === 'in_chat' ? 'in_chat' : 'relative') : 'relative';
    $('stp-edit-trigger').value = e && Array.isArray(e.injection_trigger) && e.injection_trigger.length ? e.injection_trigger[0] : 'normal';
    var depthEl = $('stp-edit-depth');
    var orderEl = $('stp-edit-injection-order');
    function syncInChatFields() {
      var inChat = $('stp-edit-position') && $('stp-edit-position').value === 'in_chat';
      var grid = document.querySelector('.stp-inchat-grid');
      if (grid) grid.classList.toggle('is-disabled', !inChat);
      if (depthEl) depthEl.disabled = !inChat;
      if (orderEl) orderEl.disabled = !inChat;
    }
    if (depthEl) depthEl.value = e && e.injection_depth != null ? String(e.injection_depth) : '0';
    if (orderEl) orderEl.value = e && e.injection_order != null ? String(e.injection_order) : '100';
    syncInChatFields();
    var posEl = $('stp-edit-position');
    if (posEl && !posEl._stpPosBound) {
      posEl._stpPosBound = true;
      posEl.addEventListener('change', syncInChatFields);
    }
    $('stp-edit-identifier').value = e ? e.identifier : '';
    $('stp-edit-enabled').checked = e ? e.enabled !== false : true;
    $('stp-edit-system').checked = e ? e.system_prompt !== false : true;
    $('stp-edit-marker').checked = e ? !!e.marker : false;
    requestAnimationFrame(function () { $('stp-editor').classList.add('is-open'); });
    setTimeout(function () { $('stp-edit-name').focus(); }, 40);
  }

  function closeEditor() {
    var el = $('stp-editor');
    if (!el) return;
    el.classList.remove('is-open');
    setTimeout(function () {
      if (!el.classList.contains('is-open')) {
        el.hidden = true;
        el.setAttribute('aria-hidden', 'true');
        el.removeAttribute('data-edit-id');
      }
    }, 220);
  }

  /*
   * 保存编辑器内容。
   *
   * S1 修复：injection_trigger 在 ST 里是「数组」（正常/续写/代写/切换回复/
   * 重新生成/静默，可多选），但这里只有一个单值下拉。若直接提交
   * [下拉值]，一个原本带多值的条目被编辑一次就会退化成单值 —— 导出回 ST 后
   * 续写/重新生成时规则不再注入。所以：
   *   - 新增条目：用下拉值（单元素数组），行为不变；
   *   - 编辑条目且用户没动过下拉：原样保留原来的数组；
   *   - 编辑条目且用户改过下拉：以用户选择为准。
   *
   * S4 修复：store 的写操作失败（localStorage 配额满）时不再静默 ——
   * 保持编辑器打开并明确提示，避免「点了保存没反应」。
   */
  function saveEditor() {
    var st = store();
    if (!st || !st.getActivePack()) { toast('当前没有可用的预设包'); return; }
    var name = String($('stp-edit-name').value || '').trim();
    var content = String($('stp-edit-content').value || '');
    if (!name) { toast('请填写条目名称'); $('stp-edit-name').focus(); return; }
    if (!content.trim() && !$('stp-edit-marker').checked) { toast('正文不能为空；若是空占位项请勾选「标记位」'); $('stp-edit-content').focus(); return; }
    var id = $('stp-editor').getAttribute('data-edit-id') || '';

    /* S1：确定本次要写入的 injection_trigger */
    var prev = id ? st.getEntry(id) : null;
    var triggerEl = $('stp-edit-trigger');
    var pickedTrigger = triggerEl ? String(triggerEl.value || '') : '';
    var trigger;
    if (prev && Array.isArray(prev.injection_trigger) && prev.injection_trigger.length &&
        pickedTrigger && prev.injection_trigger[0] === pickedTrigger) {
      /* 用户没有改动下拉（仍等于原数组首值）→ 保留原数组 */
      trigger = prev.injection_trigger.slice();
    } else {
      trigger = pickedTrigger ? [pickedTrigger] : (prev && Array.isArray(prev.injection_trigger) ? prev.injection_trigger.slice() : []);
    }

    var saved = st.upsertEntry({
      id: id || undefined,
      name: name,
      content: content,
      role: $('stp-edit-role').value,
      position: $('stp-edit-position').value === 'in_chat' ? 'back' : 'front',
      injection_position: $('stp-edit-position').value === 'in_chat' ? 1 : 0,
      injection_depth: Math.max(0, Number($('stp-edit-depth') ? $('stp-edit-depth').value : 0) || 0),
      injection_order: Number($('stp-edit-injection-order') ? $('stp-edit-injection-order').value : 100) || 100,
      identifier: String($('stp-edit-identifier').value || '').trim(),
      enabled: $('stp-edit-enabled').checked,
      system_prompt: $('stp-edit-system').checked,
      injection_trigger: trigger,
      forbid_overrides: !!$('stp-edit-forbid').checked,
      marker: $('stp-edit-marker').checked
    });

    /* S4：写入失败时保持编辑器打开，别让用户以为存上了 */
    if (saved === false || saved === null) {
      toast('存储空间不足，本次修改未保存；请先删掉一些预设或条目');
      return;
    }

    closeEditor();
    renderList();
    toast(id ? '条目已更新' : '条目已新增');
  }

  function reorderByRows() {
    var list = $('stp-list');
    if (!list || !store()) return true;
    var ids = Array.prototype.map.call(list.querySelectorAll('.stp-row[data-id]'), function (row) {
      return row.getAttribute('data-id');
    });
    var res = store().reorderEntries(ids);
    if (res === false || res === null) {
      toast('存储空间不足，顺序未保存');
      return false;
    }
    return true;
  }

  function bindDrag(list) {
    if (!list || list._stpDragBound) return;
    list._stpDragBound = true;
    var dragging = null;
    var ghost = null;
    var pointerId = null;
    var moved = false;
    var holdTimer = 0;

    function clear() {
      clearTimeout(holdTimer);
      if (dragging) dragging.classList.remove('is-dragging');
      Array.prototype.forEach.call(list.querySelectorAll('.stp-row.is-drop-target'), function (r) { r.classList.remove('is-drop-target'); });
      dragging = null; ghost = null; pointerId = null; moved = false;
      document.body.classList.remove('stp-is-dragging');
    }
    list.addEventListener('pointerdown', function (e) {
      var handle = e.target.closest('[data-act="drag"]');
      if (!handle) return;
      var row = handle.closest('.stp-row');
      if (!row) return;
      pointerId = e.pointerId;
      dragging = row;
      moved = false;
      try { handle.setPointerCapture(pointerId); } catch (_) {}
      holdTimer = setTimeout(function () {
        if (!dragging) return;
        dragging.classList.add('is-dragging');
        document.body.classList.add('stp-is-dragging');
      }, 60);
      e.preventDefault();
    });
    list.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pointerId) return;
      moved = true;
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var row = target && target.closest ? target.closest('.stp-row') : null;
      if (!row || row === dragging || !list.contains(row)) return;
      var rect = row.getBoundingClientRect();
      var before = e.clientY < rect.top + rect.height / 2;
      list.insertBefore(dragging, before ? row : row.nextSibling);
      Array.prototype.forEach.call(list.querySelectorAll('.stp-row'), function (r) { r.classList.remove('is-drop-target'); });
      dragging.classList.add('is-drop-target');
      e.preventDefault();
    });
    list.addEventListener('pointerup', function (e) {
      if (!dragging || e.pointerId !== pointerId) return;
      var didMove = moved;
      clear();
      if (didMove) { if (reorderByRows()) toast('顺序已保存'); }
      e.preventDefault();
    });
    list.addEventListener('pointercancel', clear);
  }

  function importFile(file) {
    if (!file) return;
    var defaultName = String(file.name || '').replace(/\.json$/i, '') || '导入预设';
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(String(reader.result || ''));
        var name = window.prompt('为这套预设起个名字（方便以后切换）', defaultName);
        if (name === null) return;
        var result = store().importFromStJson(obj, name || defaultName);
        renderList();
        toast('已导入「' + result.pack.name + '」· ' + result.added + ' 条');
      } catch (err) {
        toast(err.message || '导入失败');
      }
    };
    reader.onerror = function () {
      toast('读取文件失败');
    };
    reader.readAsText(file, 'utf-8');
  }

  /*
   * 导出当前预设为 SillyTavern 兼容 JSON 文件。
   * 走 Blob + a[download]，文件名用预设名；失败时退回剪贴板提示用户手动保存。
   */
  function exportActivePack() {
    var pack = null;
    try {
      pack = store().getActivePack();
    } catch (e) {}
    if (!pack) { toast('没有可导出的预设'); return; }

    var json;
    try {
      json = JSON.stringify(store().exportToStJson(pack.id), null, 2);
    } catch (e) {
      toast((e && e.message) || '导出失败');
      return;
    }

    var safeName = String(pack.name || '预设').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '预设';
    var fileName = safeName + '.json';
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已导出「' + pack.name + '」');
    } catch (e2) {
      /* 部分 WebView 不支持下载属性，退回剪贴板 */
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(function () {
          toast('当前环境不支持直接下载，已复制预设 JSON');
        }).catch(function () { toast('导出失败'); });
      } else {
        toast('导出失败');
      }
    }
  }

  function bind() {
    var app = root();
    if (!app || app._stpBound) return;
    app._stpBound = true;

    var back = $('stp-back');
    if (back) back.addEventListener('click', close);

    var list = $('stp-list');
    if (list) {
      bindDrag(list);
      list.addEventListener('click', function (e) {
        var row = e.target.closest('.stp-row');
        if (!row) return;
        var id = row.getAttribute('data-id');
        var actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        var act = actEl.getAttribute('data-act');
        var st = store();
        if (act === 'edit') {
          openEditor(id);
          return;
        }
        if (act === 'del') {
          if (!confirm('删除该条目？')) return;
          var delRes = st.removeEntry(id);
          renderList();
          toast(delRes === false || delRes === null ? '存储空间不足，删除未保存' : '已删除');
        }
      });
      list.addEventListener('change', function (e) {
        if (!e.target || e.target.getAttribute('data-act') !== 'toggle') return;
        var row = e.target.closest('.stp-row');
        if (!row) return;
        var toggleRes = store().setEnabled(row.getAttribute('data-id'), e.target.checked);
        if (toggleRes === false || toggleRes === null) {
          /* 写入失败时把勾选框视觉状态回滚，避免显示与实际不符 */
          e.target.checked = !e.target.checked;
          toast('存储空间不足，启用状态未保存');
          return;
        }
        row.classList.toggle('is-off', !e.target.checked);
      });
    }

    var genSave = $('stp-gen-save');
    if (genSave) genSave.addEventListener('click', saveGenerationFromUi);
    var genToggle = $('stp-gen-toggle');
    if (genToggle) {
      var genPanel = $('stp-gen-panel');
      var genGrid = $('stp-gen-grid');
      /* 生成参数默认收起；用 hidden + class 双保险，避免旧 CSS 缓存导致手机端大面板一直展开。 */
      if (genPanel) genPanel.classList.add('is-collapsed');
      if (genGrid) genGrid.hidden = true;
      genToggle.setAttribute('aria-expanded', 'false');
      genToggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var panel = $('stp-gen-panel');
        var grid = $('stp-gen-grid');
        if (!panel) return;
        var collapsed = !panel.classList.contains('is-collapsed');
        panel.classList.toggle('is-collapsed', collapsed);
        if (grid) grid.hidden = collapsed;
        genToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    }
    /* 「复制上次线下 Prompt」按钮与其监听已移除，原位置改为「导出预设」。 */

    var addBtn = $('stp-add');
    if (addBtn) addBtn.addEventListener('click', function () { openEditor(''); });
    var editorSave = $('stp-editor-save');
    if (editorSave) editorSave.addEventListener('click', saveEditor);
    Array.prototype.forEach.call(document.querySelectorAll('[data-stp-editor-close]'), function (el) {
      el.addEventListener('click', closeEditor);
    });

    var fileInput = $('stp-file');
    var importBtn = $('stp-import');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', function () {
        fileInput.value = '';
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) importFile(fileInput.files[0]);
      });
    }

    var exportBtn = $('stp-export');
    if (exportBtn) exportBtn.addEventListener('click', exportActivePack);

    var sel = $('stp-pack-select');
    if (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        var prevId = (store().getActivePack() || {}).id;
        if (store().setActivePack(sel.value) === null) {
          toast('存储空间不足，切换未保存');
          if (prevId) sel.value = prevId;
          return;
        }
        renderList();
        renderGeneration();
        toast('已切换预设');
      });
    }

    var renameBtn = $('stp-pack-rename');
    if (renameBtn) {
      renameBtn.addEventListener('click', function () {
        var pack = store().getActivePack();
        if (!pack) {
          toast('没有可重命名的预设');
          return;
        }
        var name = window.prompt('预设名称', pack.name);
        if (name === null) return;
        if (store().renamePack(pack.id, name) === null) {
          toast('存储空间不足，重命名未保存');
          return;
        }
        renderList();
        toast('已重命名');
      });
    }

    var delPackBtn = $('stp-pack-delete');
    if (delPackBtn) {
      delPackBtn.addEventListener('click', function () {
        var pack = store().getActivePack();
        if (!pack) {
          toast('没有可删除的预设');
          return;
        }
        if (!confirm('删除整套预设「' + pack.name + '」？')) return;
        if (store().removePack(pack.id) === null) {
          toast('存储空间不足，删除未保存');
          return;
        }
        renderList();
        toast('预设包已删除');
      });
    }
  }

  function open() {
    var app = root();
    if (!app) return;
    bind();
    renderList();
    renderGeneration();
    app.hidden = false;
    app.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function () {
      app.classList.add('is-open');
    });
    if (window.miyaArmOpenClickGuard) window.miyaArmOpenClickGuard(app);
  }

  function close() {
    var app = root();
    if (!app) return;
    app.classList.remove('is-open');
    setTimeout(function () {
      if (!app.classList.contains('is-open')) {
        app.hidden = true;
        app.setAttribute('aria-hidden', 'true');
      }
    }, 300);
  }

  global.miyaStPromptPresetsApp = { open: open, close: close, refresh: renderList };
})(typeof window !== 'undefined' ? window : this);
