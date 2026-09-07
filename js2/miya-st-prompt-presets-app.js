/**
 * ST preset manager — compact rows, multi-pack switch, drag reorder.
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

  function requireStore() {
    var st = store();
    if (!st) {
      toast('预设模块未加载，请刷新页面');
      return null;
    }
    return st;
  }

  function renderPackSelect() {
    var st = store();
    var sel = $('stp-pack-select');
    if (!sel) return;
    if (!st) {
      sel.innerHTML = '<option value="">模块未就绪</option>';
      sel.disabled = true;
      return;
    }
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
    if (!box) return;
    renderPackSelect();
    if (!st) {
      box.innerHTML = '<div class="stp-empty">预设模块未加载，请刷新后重试。</div>';
      return;
    }
    var entries = st.listEntries();
    if (!entries.length) {
      box.innerHTML =
        '<div class="stp-empty">当前预设包没有条目。<br/>点「导入」添加一套，可多套切换；长按左侧 ≡ 可拖动排序。</div>';
      return;
    }
    box.innerHTML = entries
      .map(function (e) {
        return (
          '<div class="stp-row' +
          (e.enabled ? '' : ' is-off') +
          '" data-id="' +
          esc(e.id) +
          '" draggable="false">' +
          '<button type="button" class="stp-row__handle" data-act="drag" aria-label="拖动排序" title="拖动排序">≡</button>' +
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

  function collectOrderIds() {
    var box = $('stp-list');
    if (!box) return [];
    return Array.prototype.map.call(box.querySelectorAll('.stp-row[data-id]'), function (row) {
      return row.getAttribute('data-id');
    });
  }

  function persistOrder() {
    var st = store();
    if (!st || typeof st.reorderEntries !== 'function') return;
    st.reorderEntries(collectOrderIds());
  }

  /* ── 拖拽排序（指针事件，兼容手机） ── */
  var drag = {
    active: false,
    id: '',
    row: null,
    startY: 0,
    ghost: null
  };

  function clearDrag() {
    if (drag.row) drag.row.classList.remove('is-dragging');
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag.active = false;
    drag.id = '';
    drag.row = null;
    drag.ghost = null;
  }

  function onDragStart(e, row) {
    var st = store();
    if (!st) return;
    var id = row.getAttribute('data-id');
    if (!id) return;
    drag.active = true;
    drag.id = id;
    drag.row = row;
    drag.startY = e.clientY;
    row.classList.add('is-dragging');
    var ghost = row.cloneNode(true);
    ghost.classList.add('stp-row--ghost');
    ghost.style.width = row.offsetWidth + 'px';
    ghost.style.left = row.getBoundingClientRect().left + 'px';
    ghost.style.top = row.getBoundingClientRect().top + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    try {
      e.pointerId != null && row.setPointerCapture && row.setPointerCapture(e.pointerId);
    } catch (err) {}
  }

  function onDragMove(e) {
    if (!drag.active || !drag.row) return;
    if (drag.ghost) {
      drag.ghost.style.top = e.clientY - 20 + 'px';
    }
    var box = $('stp-list');
    if (!box) return;
    var rows = Array.prototype.slice.call(box.querySelectorAll('.stp-row'));
    var y = e.clientY;
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] === drag.row) continue;
      var r = rows[i].getBoundingClientRect();
      var mid = r.top + r.height / 2;
      if (y < mid) {
        target = rows[i];
        break;
      }
    }
    if (target) {
      box.insertBefore(drag.row, target);
    } else if (rows.length) {
      box.appendChild(drag.row);
    }
  }

  function onDragEnd() {
    if (!drag.active) return;
    clearDrag();
    persistOrder();
  }

  function importFile(file) {
    if (!file) return;
    var st = requireStore();
    if (!st) return;
    var defaultName = String(file.name || '').replace(/\.json$/i, '') || '导入预设';
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(String(reader.result || ''));
        var name = window.prompt('为这套预设起个名字（方便以后切换）', defaultName);
        if (name === null) return;
        var result = st.importFromStJson(obj, name || defaultName);
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
        var actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        var act = actEl.getAttribute('data-act');
        if (act === 'drag') return;
        var st = requireStore();
        if (!st) return;
        var id = row.getAttribute('data-id');
        if (act === 'del') {
          if (!confirm('删除该条目？')) return;
          st.removeEntry(id);
          renderList();
          toast('已删除');
        }
      });
      list.addEventListener('change', function (e) {
        if (!e.target || e.target.getAttribute('data-act') !== 'toggle') return;
        var st = requireStore();
        if (!st) return;
        var row = e.target.closest('.stp-row');
        if (!row) return;
        st.setEnabled(row.getAttribute('data-id'), e.target.checked);
        row.classList.toggle('is-off', !e.target.checked);
      });

      list.addEventListener('pointerdown', function (e) {
        var handle = e.target.closest('[data-act="drag"]');
        if (!handle) return;
        var row = handle.closest('.stp-row');
        if (!row) return;
        e.preventDefault();
        onDragStart(e, row);
      });
      list.addEventListener('pointermove', function (e) {
        if (drag.active) {
          e.preventDefault();
          onDragMove(e);
        }
      });
      list.addEventListener('pointerup', onDragEnd);
      list.addEventListener('pointercancel', onDragEnd);
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
        var st = requireStore();
        if (!st || !sel.value) return;
        st.setActivePack(sel.value);
        renderList();
        toast('已切换预设');
      });
    }

    var renameBtn = $('stp-pack-rename');
    if (renameBtn) {
      renameBtn.addEventListener('click', function () {
        var st = requireStore();
        if (!st) return;
        var pack = st.getActivePack();
        if (!pack) {
          toast('没有可重命名的预设');
          return;
        }
        var name = window.prompt('预设名称', pack.name);
        if (name === null) return;
        st.renamePack(pack.id, name);
        renderList();
        toast('已重命名');
      });
    }

    var delPackBtn = $('stp-pack-delete');
    if (delPackBtn) {
      delPackBtn.addEventListener('click', function () {
        var st = requireStore();
        if (!st) return;
        var pack = st.getActivePack();
        if (!pack) {
          toast('没有可删除的预设');
          return;
        }
        if (!confirm('删除整套预设「' + pack.name + '」？')) return;
        st.removePack(pack.id);
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
    clearDrag();
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
