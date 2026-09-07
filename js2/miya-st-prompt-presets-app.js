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
          '<span class="stp-row__meta">' + esc(e.role || 'system') + '</span>' +
        '</button>' +
        '<button type="button" class="stp-row__del" data-act="del" aria-label="删除" title="删除">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8v10m4-10v10m4-10v10M5 6h14M10 6V4h4v2m-8 0 1 14h10l1-14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        '</div>'
      );
    }).join('');
  }

  function openEditor(id) {
    var st = store();
    var pack = st && st.getActivePack ? st.getActivePack() : null;
    if (!pack && st && st.createPack) {
      pack = st.createPack('手动预设');
      renderPackSelect();
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

  function saveEditor() {
    var st = store();
    if (!st || !st.getActivePack()) { toast('当前没有可用的预设包'); return; }
    var name = String($('stp-edit-name').value || '').trim();
    var content = String($('stp-edit-content').value || '');
    if (!name) { toast('请填写条目名称'); $('stp-edit-name').focus(); return; }
    if (!content.trim() && !$('stp-edit-marker').checked) { toast('正文不能为空；若是空占位项请勾选「标记位」'); $('stp-edit-content').focus(); return; }
    var id = $('stp-editor').getAttribute('data-edit-id') || '';
    st.upsertEntry({
      id: id || undefined,
      name: name,
      content: content,
      role: $('stp-edit-role').value,
      identifier: String($('stp-edit-identifier').value || '').trim(),
      enabled: $('stp-edit-enabled').checked,
      system_prompt: $('stp-edit-system').checked,
      marker: $('stp-edit-marker').checked
    });
    closeEditor();
    renderList();
    toast(id ? '条目已更新' : '条目已新增');
  }

  function reorderByRows() {
    var list = $('stp-list');
    if (!list || !store()) return;
    var ids = Array.prototype.map.call(list.querySelectorAll('.stp-row[data-id]'), function (row) {
      return row.getAttribute('data-id');
    });
    store().reorderEntries(ids);
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
      if (didMove) { reorderByRows(); toast('顺序已保存'); }
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
          st.removeEntry(id);
          renderList();
          toast('已删除');
        }
      });
      list.addEventListener('change', function (e) {
        if (!e.target || e.target.getAttribute('data-act') !== 'toggle') return;
        var row = e.target.closest('.stp-row');
        if (!row) return;
        store().setEnabled(row.getAttribute('data-id'), e.target.checked);
        row.classList.toggle('is-off', !e.target.checked);
      });
    }

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

    var sel = $('stp-pack-select');
    if (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        store().setActivePack(sel.value);
        renderList();
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
        store().renamePack(pack.id, name);
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
        store().removePack(pack.id);
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
