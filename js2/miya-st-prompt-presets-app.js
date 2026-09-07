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
      box.innerHTML =
        '<div class="stp-empty">当前预设包没有条目。<br/>点「导入」添加一套，可多套切换。</div>';
      return;
    }
    box.innerHTML = entries
      .map(function (e) {
        return (
          '<div class="stp-row' +
          (e.enabled ? '' : ' is-off') +
          '" data-id="' +
          esc(e.id) +
          '">' +
          '<label class="stp-switch" title="启用">' +
          '<input type="checkbox" data-act="toggle" ' +
          (e.enabled ? 'checked' : '') +
          ' />' +
          '<span></span></label>' +
          '<div class="stp-row__name" title="' +
          esc(e.identifier || e.name) +
          '">' +
          esc(e.name) +
          '</div>' +
          '<button type="button" class="stp-row__del" data-act="del" aria-label="删除">删</button>' +
          '</div>'
        );
      })
      .join('');
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
      list.addEventListener('click', function (e) {
        var row = e.target.closest('.stp-row');
        if (!row) return;
        var id = row.getAttribute('data-id');
        var actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        var act = actEl.getAttribute('data-act');
        var st = store();
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
