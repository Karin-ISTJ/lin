/**
 * Independent ST prompt-preset manager UI.
 * Import / list / enable / edit / delete — does not affect chat requests yet.
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
    }, 2400);
  }

  function root() {
    return $('miya-st-presets-app');
  }

  function renderList() {
    var st = store();
    var box = $('stp-list');
    if (!box || !st) return;
    var entries = st.listEntries();
    if (!entries.length) {
      box.innerHTML =
        '<div class="stp-empty">暂无条目。请导入 Default.json 或点击「新建」。</div>';
      return;
    }
    box.innerHTML = entries
      .map(function (e) {
        var badge = e.marker ? '<span class="stp-badge">marker</span>' : '';
        var idBadge = e.identifier
          ? '<span class="stp-badge stp-badge--id">' + esc(e.identifier) + '</span>'
          : '';
        var preview = String(e.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
        if (!preview && e.marker) preview = '（占位标记，无正文）';
        return (
          '<article class="stp-card' +
          (e.enabled ? '' : ' is-off') +
          '" data-id="' +
          esc(e.id) +
          '">' +
          '<div class="stp-card__top">' +
          '<label class="stp-switch" title="启用">' +
          '<input type="checkbox" data-act="toggle" ' +
          (e.enabled ? 'checked' : '') +
          ' />' +
          '<span></span></label>' +
          '<div class="stp-card__title">' +
          esc(e.name) +
          badge +
          idBadge +
          '</div>' +
          '<div class="stp-card__actions">' +
          '<button type="button" class="stp-mini" data-act="edit">编辑</button>' +
          '<button type="button" class="stp-mini stp-mini--danger" data-act="del">删除</button>' +
          '</div></div>' +
          '<p class="stp-card__preview">' +
          esc(preview || '（空内容）') +
          '</p>' +
          '<div class="stp-card__meta">role: ' +
          esc(e.role) +
          (e.enabled ? ' · 已启用' : ' · 已关闭') +
          '</div></article>'
        );
      })
      .join('');
  }

  function openEditor(entry) {
    var panel = $('stp-editor');
    if (!panel) return;
    panel.hidden = false;
    $('stp-ed-id').value = entry && entry.id ? entry.id : '';
    $('stp-ed-name').value = entry && entry.name ? entry.name : '';
    $('stp-ed-role').value = entry && entry.role ? entry.role : 'system';
    $('stp-ed-identifier').value = entry && entry.identifier ? entry.identifier : '';
    $('stp-ed-content').value = entry && entry.content ? entry.content : '';
    $('stp-ed-enabled').checked = !entry || entry.enabled !== false;
    $('stp-ed-title').textContent = entry && entry.id ? '编辑条目' : '新建条目';
  }

  function closeEditor() {
    var panel = $('stp-editor');
    if (panel) panel.hidden = true;
  }

  function saveEditor() {
    var st = store();
    if (!st) return;
    var id = $('stp-ed-id').value.trim();
    var name = $('stp-ed-name').value.trim() || '未命名条目';
    st.upsertEntry({
      id: id || undefined,
      name: name,
      role: $('stp-ed-role').value || 'system',
      identifier: $('stp-ed-identifier').value.trim(),
      content: $('stp-ed-content').value,
      enabled: $('stp-ed-enabled').checked,
      marker: false
    });
    closeEditor();
    renderList();
    toast('已保存');
  }

  function onListClick(e) {
    var card = e.target.closest('.stp-card');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    var act = actEl.getAttribute('data-act');
    var st = store();
    if (!st) return;

    if (act === 'toggle') {
      st.setEnabled(id, actEl.checked);
      renderList();
      return;
    }
    if (act === 'edit') {
      openEditor(st.getEntry(id));
      return;
    }
    if (act === 'del') {
      if (!confirm('确定删除该条目？')) return;
      st.removeEntry(id);
      renderList();
      toast('已删除');
    }
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(String(reader.result || ''));
        var st = store();
        var result = st.importFromStJson(obj);
        renderList();
        toast('已导入 ' + result.added + ' 条（共 ' + result.total + ' 条）');
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
    if (back) {
      back.addEventListener('click', function () {
        close();
      });
    }

    var list = $('stp-list');
    if (list) list.addEventListener('click', onListClick);
    // toggle change
    if (list) {
      list.addEventListener('change', function (e) {
        if (e.target && e.target.getAttribute('data-act') === 'toggle') {
          onListClick(e);
        }
      });
    }

    var importBtn = $('stp-import');
    var fileInput = $('stp-file');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', function () {
        fileInput.value = '';
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) importFile(fileInput.files[0]);
      });
    }

    var addBtn = $('stp-add');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openEditor(null);
      });
    }

    var clearBtn = $('stp-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (!confirm('清空全部条目？不可恢复。')) return;
        store().clearAll();
        renderList();
        toast('已清空');
      });
    }

    var edCancel = $('stp-ed-cancel');
    var edSave = $('stp-ed-save');
    if (edCancel) edCancel.addEventListener('click', closeEditor);
    if (edSave) edSave.addEventListener('click', saveEditor);
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
    closeEditor();
    app.classList.remove('is-open');
    setTimeout(function () {
      if (!app.classList.contains('is-open')) {
        app.hidden = true;
        app.setAttribute('aria-hidden', 'true');
      }
    }, 320);
  }

  global.miyaStPromptPresetsApp = {
    open: open,
    close: close,
    refresh: renderList
  };
})(typeof window !== 'undefined' ? window : this);
