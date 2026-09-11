(function (global) {
  'use strict';

  var store = global.miyaWorldbookStore;
  var DEFAULT_GROUP_ID = store.DEFAULT_GROUP_ID;
  var filterScope = 'all';
  var filterGroupId = 'all';
  var searchQuery = '';
  var editingId = null;
  var collapsedGroups = {};

  function $(id) { return document.getElementById(id); }

  function ensureContactsReady() {
    var cs = global.miyaContactsStore;
    if (cs && typeof cs.whenReady === 'function') return cs.whenReady();
    return Promise.resolve();
  }

  function esc(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'mw-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2400);
  }

  function dialog(opts) {
    if (!global.miyaDialog) {
      if (opts.mode === 'confirm') return Promise.resolve(confirm((opts.title || '') + '\n' + (opts.message || '')));
      if (opts.mode === 'prompt') return Promise.resolve(prompt(opts.message || opts.title || '') || null);
      return Promise.resolve(alert((opts.title || '') + '\n' + (opts.message || '')));
    }
    if (opts.mode === 'confirm') return global.miyaDialog.confirm(opts);
    if (opts.mode === 'prompt') return global.miyaDialog.prompt(opts);
    return global.miyaDialog.alert(opts);
  }

  function scopeLabel(scope) {
    return scope === 'local' ? '局部' : '全局';
  }

  function globalReachLabel(reach) {
    var labels = store.GLOBAL_REACH_LABELS || {};
    return labels[reach] || '线上线下';
  }

  function depthLabel(depth) {
    var labels = store.DEPTH_LABELS || { front: '前', middle: '中', back: '后' };
    var d = store.normalizeDepth ? store.normalizeDepth(depth) : (depth || 'middle');
    return labels[d] || '中';
  }

  function syncGlobalReachUi(scope) {
    var wrap = $('miya-wb-global-reach-wrap');
    if (!wrap) return;
    wrap.hidden = false;
    var label = $('miya-wb-reach-label');
    if (label) {
      label.textContent = scope === 'local' ? '局部生效范围' : '全局生效范围';
    }
  }

  function setActiveGlobalReach(reach) {
    var app = $('miya-worldbook-app');
    if (!app) return;
    var value = reach || 'online_offline';
    app.querySelectorAll('[data-wb-global-reach]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-wb-global-reach') === value);
    });
  }

  function setActiveDepth(depth) {
    /* 历史上这里会去点亮 [data-wb-depth] 按钮，但表单里并不存在这组按钮
       （深度由「位置」下拉统一决定），属于死代码。保留空实现仅为兼容旧调用。 */
  }

  function collectDepth() {
    /* 深度由「位置」下拉经 positionToDepth 推导，不再单独采集。 */
    return 'middle';
  }

  function collectGlobalReach() {
    var app = $('miya-worldbook-app');
    if (!app) return 'online_offline';
    var active = app.querySelector('[data-wb-global-reach].is-active');
    return active ? active.getAttribute('data-wb-global-reach') || 'online_offline' : 'online_offline';
  }

  function keywordPreview(entry) {
    var scope = entry.scope === 'local' ? 'local' : 'global';
    var kws = Array.isArray(entry.keywords) ? entry.keywords : [];
    var kwPart = !kws.length
      ? '无关键词·随时命中'
      : '关键词：' + kws.slice(0, 4).join(' · ') + (kws.length > 4 ? ' …' : '');
    var reach = entry.globalReach || (scope === 'local' ? 'all' : 'online_offline');
    return '生效：' + globalReachLabel(reach) + ' · ' + kwPart;
  }

  function filteredEntries() {
    var rows = store.listEntries();
    var q = searchQuery.trim().toLowerCase();
    return rows.filter(function (entry) {
      if (filterScope !== 'all' && entry.scope !== filterScope) return false;
      /* 不再按分卷横向筛选，全部在手风琴中展示 */
      if (!q) return true;
      var g = store.getGroup(entry.groupId);
      var blob = [
        entry.name,
        entry.content,
        (entry.keywords || []).join(' '),
        (entry.boundRoleIds || []).join(' '),
        g && g.name
      ].join(' ').toLowerCase();
      return blob.indexOf(q) >= 0;
    });
  }

  function renderGroupChips() {
    /* 已取消顶部横向分卷滑条，改用手风琴列表 + 「+ 新建世界书」按钮，避免左右滑与下方折叠重复 */
  }

  function roleMonogram(name) {
    return Array.from(String(name || '').trim() || '?')[0] || '?';
  }

  function renderRolePicker(selectedIds) {
    var picked = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
    var set = new Set(picked);
    var rows = store.resolveAvailableRoles ? store.resolveAvailableRoles() : [];
    if (!rows.length) {
      return '<p class="ins-wb-role-empty">请先在「联系人」建档；不选任何角色则为全局生效。</p>';
    }
    return (
      '<div class="ins-wb-role-grid">' +
      rows.map(function (row) {
        var on = set.has(String(row.roleId));
        var portrait = row.avatar
          ? '<span class="ins-wb-role-portrait"><img src="' + esc(row.avatar) + '" alt=""></span>'
          : '<span class="ins-wb-role-portrait ins-wb-role-portrait--mono">' + esc(roleMonogram(row.roleName)) + '</span>';
        var tag = row.source === 'contacts' ? '<span class="ins-wb-role-tag">档案</span>' : '';
        return (
          '<button type="button" class="ins-wb-role-card' + (on ? ' is-selected' : '') +
          '" data-role-id="' + esc(row.roleId) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
          '<span class="ins-wb-role-mark" aria-hidden="true"></span>' +
          portrait +
          '<span class="ins-wb-role-card-body">' +
          '<span class="ins-wb-role-card-name">' + esc(row.roleName || row.roleId) + '</span>' +
          tag +
          '</span></button>'
        );
      }).join('') +
      '</div>'
    );
  }

  function collectRoleIds() {
    var root = $('miya-wb-roles-wrap');
    if (!root) return [];
    var set = new Set();
    root.querySelectorAll('.ins-wb-role-card.is-selected').forEach(function (el) {
      var v = String(el.getAttribute('data-role-id') || '').trim();
      if (v) set.add(v);
    });
    return Array.from(set);
  }

  function roleHintLabel(entry) {
    var roles = Array.isArray(entry.boundRoleIds) ? entry.boundRoleIds : [];
    var scope = entry.scope === 'local' ? 'local' : 'global';
    var reach = globalReachLabel(entry.globalReach || (scope === 'local' ? 'all' : 'online_offline'));
    if (scope !== 'local') return reach;
    if (!roles.length) return reach + ' · 未绑定角色';
    var available = store.resolveAvailableRoles ? store.resolveAvailableRoles() : [];
    var map = {};
    available.forEach(function (r) { map[r.roleId] = r.roleName; });
    var names = roles.map(function (id) { return map[id] || id; }).slice(0, 2);
    var suffix = roles.length > 2 ? ' 等' + roles.length + '人' : '';
    return reach + ' · ' + names.join(' · ') + suffix;
  }

  function renderEntryCard(entry, index) {
    var on = entry.enabled !== false;
    var scope = entry.scope === 'local' ? 'local' : 'global';
    var depth = store.normalizeDepth ? store.normalizeDepth(entry.depth) : (entry.depth || 'middle');
    var roleHint = roleHintLabel(entry);
    var idx = typeof index === 'number' ? String(index + 1).padStart(2, '0') : '';
    return (
      '<article class="ins-wb-card' + (on ? '' : ' is-off') + '" data-wb-id="' + esc(entry.id) + '">' +
      (idx ? '<span class="ins-wb-card__idx" aria-hidden="true">' + idx + '</span>' : '') +
      '<div class="ins-wb-card-head">' +
      '<div class="ins-wb-card-tags">' +
      '<span class="ins-wb-scope ins-wb-scope--' + scope + '">' + scopeLabel(scope) + '</span>' +
      '<span class="ins-wb-depth ins-wb-depth--' + depth + '">' + depthLabel(depth) + '</span>' +
      '</div>' +
      '<button type="button" class="ins-toggle' + (on ? ' is-on' : '') + '" data-wb-toggle="' + esc(entry.id) + '" role="switch" aria-checked="' + on + '"></button>' +
      '</div>' +
      '<h3 class="ins-wb-card-title">' + esc(entry.name) + '</h3>' +
      '<p class="ins-wb-card-keys">' + esc(keywordPreview(entry)) + '</p>' +
      '<footer class="ins-wb-card-foot">' +
      '<span>' + esc(roleHint) + '</span>' +
      '<button type="button" class="ins-wb-link mi-ico-btn" data-wb-edit="' + esc(entry.id) + '" title="编辑" aria-label="编辑"><img src="img/icons/edit-03.svg" alt="" width="15" height="15"></button>' +
      '</footer>' +
      '</article>'
    );
  }

  function renderList() {
    var list = $('miya-wb-list');
    var empty = $('miya-wb-empty');
    var count = $('miya-wb-count');
    if (!list) return;

    /* 列表始终按「世界书」手风琴展示：点标题展开/收起，无需左右滑分卷条 */
    renderGroupChips();
    var rows = filteredEntries();
    if (count) count.textContent = String(rows.length);

    if (!rows.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    var groups = store.listGroups();
    var byGroup = {};
    groups.forEach(function (g) { byGroup[g.id] = []; });
    rows.forEach(function (entry) {
      var gid = byGroup[entry.groupId] ? entry.groupId : DEFAULT_GROUP_ID;
      if (!byGroup[gid]) byGroup[gid] = [];
      byGroup[gid].push(entry);
    });

    /* 新导入的书默认折叠 */
    groups.forEach(function (g) {
      if (collapsedGroups[g.id] === undefined && !g.fixed) {
        collapsedGroups[g.id] = true;
      }
    });

    var html = '';
    groups.forEach(function (g) {
      var items = byGroup[g.id] || [];
      if (!items.length) return;
      var collapsed = !!collapsedGroups[g.id];
      var actions = g.fixed ? '' : (
        '<span class="ins-wb-group-head-ops">' +
        '<button type="button" class="ins-wb-group-op mi-ico-btn" data-wb-group-edit="' + esc(g.id) + '" title="重命名" aria-label="重命名"><img src="img/icons/edit-03.svg" alt="" width="16" height="16"></button>' +
        '<button type="button" class="ins-wb-group-op ins-wb-group-op--del mi-ico-btn mi-ico-btn--danger" data-wb-group-del="' + esc(g.id) + '" title="删除世界书" aria-label="删除世界书"><img src="img/icons/trash-01.svg" alt="" width="16" height="16"></button>' +
        '</span>'
      );
      html += '<section class="ins-wb-book' + (collapsed ? ' is-collapsed' : ' is-open') + '" data-wb-book="' + esc(g.id) + '">' +
        '<div class="ins-wb-book-head">' +
        '<button type="button" class="ins-wb-book-toggle" data-wb-collapse="' + esc(g.id) + '" aria-expanded="' + !collapsed + '">' +
        '<span class="ins-wb-book-arrow">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="ins-wb-book-title">' + esc(g.name) + '</span>' +
        '<span class="ins-wb-book-count">' + items.length + ' 条</span>' +
        '</button>' + actions + '</div>';
      if (!collapsed) {
        html += '<div class="ins-wb-book-body">' + items.map(function (e, i) { return renderEntryCard(e, i); }).join('') + '</div>';
      }
      html += '</section>';
    });
    list.innerHTML = html || rows.map(function (e, i) { return renderEntryCard(e, i); }).join('');
  }

  function fillGroupSelect(selectedId) {
    var sel = $('miya-wb-field-group');
    if (!sel) return;
    var groups = store.listGroups();
    sel.innerHTML = groups.map(function (g) {
      var picked = String(g.id) === String(selectedId || DEFAULT_GROUP_ID) ? ' selected' : '';
      return '<option value="' + esc(g.id) + '"' + picked + '>' + esc(g.name) + '</option>';
    }).join('');
  }

  function syncFilterUi() {
    var root = $('miya-worldbook-app');
    if (!root) return;
    root.querySelectorAll('[data-wb-filter]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-wb-filter') === filterScope);
    });
  }

  function fillEditor(entry) {
    var isNew = !entry;
    var data = entry || {
      scope: filterScope === 'local' ? 'local' : 'global',
      globalReach: 'online_offline',
      depth: 'middle',
      groupId: filterGroupId !== 'all' ? filterGroupId : DEFAULT_GROUP_ID,
      keywords: [],
      boundRoleIds: [],
      enabled: true,
      content: '',
      name: ''
    };
    editingId = isNew ? null : data.id;
    $('miya-wb-editor-title').textContent = isNew ? '新建片段' : '编辑片段';
    $('miya-wb-field-name').value = data.name || '';
    var primary = (data.key && data.key.length) ? data.key : (data.keywords || []);
    $('miya-wb-field-keys').value = primary.join('，');
    var secEl = $('miya-wb-field-keys-sec');
    if (secEl) secEl.value = (data.keysecondary || []).join('，');
    function setChk(id, v) { var el = $(id); if (el) el.checked = !!v; }
    function setNum(id, v, d) { var el = $(id); if (el) el.value = v != null && v !== '' ? v : d; }
    var statusEl = $('miya-wb-field-status');
    if (statusEl) {
      if (data.enabled === false) statusEl.value = 'disabled';
      else if (data.constant) statusEl.value = 'constant';
      else statusEl.value = 'normal';
    }
    setChk('miya-wb-field-selective', data.selective);
    setNum('miya-wb-field-selective-logic', data.selectiveLogic, 0);
    setNum('miya-wb-field-order', data.order, 100);
    var pos = Number(data.position);
    if (!Number.isFinite(pos)) {
      if (data.depth === 'front') pos = 0;
      else if (data.depth === 'back') pos = 4;
      else pos = 1;
    }
    if (pos !== 0 && pos !== 4) pos = 1;
    setNum('miya-wb-field-position', pos, 1);
    setNum('miya-wb-field-inj-depth', data.injection_depth, 4);
    setNum('miya-wb-field-scan-depth', data.scanDepth, '');
    setNum('miya-wb-field-prob', data.probability, 100);
    setChk('miya-wb-field-use-prob', data.useProbability);
    setChk('miya-wb-field-ignore-budget', data.ignoreBudget);
    var gEl = $('miya-wb-field-st-group');
    if (gEl) gEl.value = data.group || '';
    setNum('miya-wb-field-group-weight', data.groupWeight, 100);
    setChk('miya-wb-field-group-override', data.groupOverride);
    $('miya-wb-field-body').value = data.content || '';
    var rolesHost = $('miya-wb-roles-host');
    if (rolesHost) rolesHost.innerHTML = '<p class="ins-wb-role-empty">正在读取联系人档案…</p>';
    fillGroupSelect(data.groupId || DEFAULT_GROUP_ID);
    var scope = data.scope === 'local' ? 'local' : 'global';
    $('miya-worldbook-app').querySelectorAll('[data-wb-scope]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-wb-scope') === scope);
    });
    syncGlobalReachUi(scope);
    setActiveGlobalReach(data.globalReach || (scope === 'local' ? 'all' : 'online_offline'));
    var rolesWrap = $('miya-wb-roles-wrap');
    if (rolesWrap) rolesWrap.hidden = scope !== 'local';
    syncDepthFieldVisibility();
    var app = $('miya-worldbook-app');
    if (app) {
      app.classList.add('has-editor');
      var editor = $('miya-wb-editor');
      if (editor) editor.setAttribute('aria-hidden', 'false');
    }
    ensureContactsReady().then(function () {
      if (rolesHost) rolesHost.innerHTML = renderRolePicker(data.boundRoleIds || []);
    });
  }

  function syncDepthFieldVisibility() {
    var posEl = $('miya-wb-field-position');
    var wrap = $('miya-wb-depth-field');
    if (!wrap || !posEl) return;
    wrap.style.opacity = String(posEl.value) === '4' ? '1' : '0.45';
  }

  function readEditorPayload() {
    var scopeBtn = $('miya-worldbook-app').querySelector('[data-wb-scope].is-active');
    var scope = scopeBtn ? scopeBtn.getAttribute('data-wb-scope') : 'global';
    var roles = scope === 'local' ? collectRoleIds() : [];
    var matcher = global.miyaWorldbookMatcher;
    var keysRaw = $('miya-wb-field-keys').value || '';
    var keywords = matcher && typeof matcher.splitKeywordString === 'function'
      ? matcher.splitKeywordString(keysRaw)
      : keysRaw.split(/[,，、;；]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var secRaw = ($('miya-wb-field-keys-sec') && $('miya-wb-field-keys-sec').value) || '';
    var keysecondary = matcher && typeof matcher.splitKeywordString === 'function'
      ? matcher.splitKeywordString(secRaw)
      : secRaw.split(/[,，、;；]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    function numVal(id, d) {
      var el = $(id);
      if (!el || el.value === '' || el.value == null) return d;
      var n = Number(el.value);
      return Number.isFinite(n) ? n : d;
    }
    function chk(id) {
      var el = $(id);
      return !!(el && el.checked);
    }
    var scanEl = $('miya-wb-field-scan-depth');
    var scanDepth = scanEl && scanEl.value !== '' ? Number(scanEl.value) : null;
    var status = ($('miya-wb-field-status') && $('miya-wb-field-status').value) || 'normal';
    var position = numVal('miya-wb-field-position', 1);
    var depth = position === 0 ? 'front' : position === 4 ? 'back' : 'middle';
    var stApi = global.miyaWorldbookST;
    if (stApi && typeof stApi.positionToDepth === 'function') {
      depth = stApi.positionToDepth(position);
    }
    return {
      id: editingId || undefined,
      name: ($('miya-wb-field-name').value || '').trim(),
      keywords: keywords,
      key: keywords,
      keysecondary: keysecondary,
      content: $('miya-wb-field-body').value || '',
      scope: scope,
      globalReach: collectGlobalReach(),
      depth: depth,
      groupId: ($('miya-wb-field-group') && $('miya-wb-field-group').value) || DEFAULT_GROUP_ID,
      boundRoleIds: scope === 'local' ? roles : [],
      enabled: status !== 'disabled',
      constant: status === 'constant',
      selective: chk('miya-wb-field-selective') || keysecondary.length > 0,
      selectiveLogic: numVal('miya-wb-field-selective-logic', 0),
      order: numVal('miya-wb-field-order', 100),
      position: position,
      injection_depth: numVal('miya-wb-field-inj-depth', 4),
      scanDepth: Number.isFinite(scanDepth) ? scanDepth : null,
      probability: numVal('miya-wb-field-prob', 100),
      useProbability: chk('miya-wb-field-use-prob'),
      ignoreBudget: chk('miya-wb-field-ignore-budget'),
      group: ($('miya-wb-field-st-group') && $('miya-wb-field-st-group').value) || '',
      groupWeight: numVal('miya-wb-field-group-weight', 100),
      groupOverride: chk('miya-wb-field-group-override')
    };
  }

  function closeEditor() {
    editingId = null;
    var app = $('miya-worldbook-app');
    if (app) app.classList.remove('has-editor');
    var editor = $('miya-wb-editor');
    if (editor) editor.setAttribute('aria-hidden', 'true');
  }

  function saveEditor() {
    var payload = readEditorPayload();
    if (!payload.name) { toast('请填写片段标题'); return; }
    if (payload.scope === 'local' && !payload.boundRoleIds.length) {
      toast('局部片段需绑定至少一位联系人');
      return;
    }
    store.upsertEntry(payload).then(function () {
      closeEditor();
      renderList();
      toast('已保存');
    }).catch(function () { toast('保存失败'); });
  }

  function deleteEditing() {
    if (!editingId) { closeEditor(); return; }
    dialog({
      mode: 'confirm',
      title: '删除片段',
      message: '删除后无法恢复，确定继续？',
      confirmText: '删除'
    }).then(function (ok) {
      if (!ok) return;
      store.removeEntry(editingId).then(function () {
        closeEditor();
        renderList();
        toast('已删除');
      });
    });
  }

  function promptNewGroup() {
    dialog({
      mode: 'prompt',
      title: '新建世界书',
      message: '输入世界书名称',
      placeholder: '例如：凡人修仙传',
      defaultValue: ''
    }).then(function (name) {
      name = String(name || '').trim();
      if (!name) return;
      store.upsertGroup({ name: name, sort: Date.now() }).then(function (g) {
        filterGroupId = g.id;
        collapsedGroups[g.id] = false; /* 新建后自动展开 */
        renderList();
        toast('世界书已创建');
      });
    });
  }

  function promptRenameGroup(groupId) {
    var g = store.getGroup(groupId);
    if (!g || g.fixed) return;
    dialog({
      mode: 'prompt',
      title: '重命名分卷',
      message: '新的分卷名称',
      defaultValue: g.name
    }).then(function (name) {
      name = String(name || '').trim();
      if (!name) return;
      store.upsertGroup({ id: g.id, name: name, sort: g.sort }).then(renderList);
    });
  }

  function promptDeleteGroup(groupId) {
    var g = store.getGroup(groupId);
    if (!g || g.fixed) return;
    var cnt = store.listEntries().filter(function (e) { return e.groupId === g.id; }).length;
    dialog({
      mode: 'confirm',
      title: '删除分卷',
      message: '分卷「' + g.name + '」下的 ' + cnt + ' 条片段将移入「未分组」。继续？',
      confirmText: '删除'
    }).then(function (ok) {
      if (!ok) return;
      store.removeGroup(g.id).then(function () {
        if (filterGroupId === g.id) filterGroupId = 'all';
        renderList();
        toast('分卷已删除');
      });
    });
  }

  function importDocToBody(file) {
    var fn = global.miyaWorldbookExtractFileText;
    if (!fn) { toast('导入模块未加载'); return; }
    fn(file).then(function (text) {
      var body = $('miya-wb-field-body');
      if (!body) return;
      var t = String(text || '').trim();
      if (!t) { toast('未能识别到文字内容'); return; }
      body.value = t;
      if (!($('miya-wb-field-name').value || '').trim()) {
        var base = String(file.name || '').replace(/\.[^.]+$/, '').trim();
        if (base) $('miya-wb-field-name').value = base.slice(0, 64);
      }
      toast('已填入正文');
    }).catch(function (err) {
      var code = err && err.message;
      if (code === 'unsupported_type') toast('仅支持 .txt 与 .docx');
      else if (code === 'jszip_missing') toast('文档解析库未加载');
      else toast('读取文件失败');
    });
  }

  function bindEvents() {
    var app = $('miya-worldbook-app');
    if (!app || app.getAttribute('data-wb-bound')) return;
    app.setAttribute('data-wb-bound', '1');

    var wbBack = $('miya-wb-header-back') || $('miya-wb-back');
    if (wbBack) wbBack.addEventListener('click', closeWorldbookApp);
    $('miya-wb-add').addEventListener('click', function () { fillEditor(null); });
    $('miya-wb-editor-back').addEventListener('click', closeEditor);
    $('miya-wb-save').addEventListener('click', saveEditor);
    $('miya-wb-delete').addEventListener('click', deleteEditing);

    $('miya-wb-search').addEventListener('input', function () {
      searchQuery = $('miya-wb-search').value || '';
      renderList();
    });

    app.querySelectorAll('[data-wb-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        filterScope = btn.getAttribute('data-wb-filter') || 'all';
        syncFilterUi();
        renderList();
      });
    });

    app.querySelectorAll('[data-wb-scope]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        app.querySelectorAll('[data-wb-scope]').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        var scope = btn.getAttribute('data-wb-scope') || 'global';
        var rolesWrap = $('miya-wb-roles-wrap');
        if (rolesWrap) rolesWrap.hidden = scope !== 'local';
        syncGlobalReachUi(scope);
      });
    });

    app.querySelectorAll('[data-wb-global-reach]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        app.querySelectorAll('[data-wb-global-reach]').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
      });
    });

    $('miya-wb-doc-import').addEventListener('click', function () {
      $('miya-wb-doc-file').click();
    });
    var posSel = $('miya-wb-field-position');
    if (posSel) posSel.addEventListener('change', syncDepthFieldVisibility);


    var stImportBtn = $('miya-wb-st-import');
    var stImportFile = $('miya-wb-st-import-file');
    var stExportBtn = $('miya-wb-st-export');
    if (stImportBtn && stImportFile) {
      stImportBtn.addEventListener('click', function () { stImportFile.click(); });
      stImportFile.addEventListener('change', function () {
        var f = stImportFile.files && stImportFile.files[0];
        stImportFile.value = '';
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var data = JSON.parse(String(reader.result || ''));
            var doReplace = confirm('导入 ST 世界书 JSON\n\n确定 = 清空现有词条后导入（替换）\n取消 = 与现有词条合并');
            var store = global.miyaWorldbookStore;
            if (!store || typeof store.importStJson !== 'function') {
              alert('ST 导入模块未就绪');
              return;
            }
            store.importStJson(data, { replace: doReplace }).then(function (res) {
              var n = res && res.count != null ? res.count : 0;
              var book = (res && res.groupName) ? res.groupName : '导入世界书';
              if (res && res.groupId) {
                collapsedGroups[res.groupId] = false;
                filterGroupId = 'all';
              }
              alert('已导入世界书「' + book + '」共 ' + n + ' 条\n可在列表中展开 / 收起切换');
              if (typeof renderList === 'function') renderList();
              else if (typeof refresh === 'function') refresh();
            }).catch(function (err) {
              alert((err && err.message) || '导入失败');
            });
          } catch (e) {
            alert('JSON 无效：' + (e && e.message ? e.message : e));
          }
        };
        reader.readAsText(f);
      });
    }
    if (stExportBtn) {
      stExportBtn.addEventListener('click', function () {
        var store = global.miyaWorldbookStore;
        if (!store || typeof store.exportStJson !== 'function') {
          alert('ST 导出模块未就绪');
          return;
        }
        var data = store.exportStJson({ name: 'Miya Worldbook' });
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'miya-worldbook-st.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      });
    }
    var dbgBtn = $('miya-wb-st-debug');
    var dbgPanel = $('miya-wb-st-debug-panel');
    var dbgRun = $('miya-wb-st-debug-run');
    if (dbgBtn && dbgPanel) {
      dbgBtn.addEventListener('click', function () {
        dbgPanel.hidden = !dbgPanel.hidden;
      });
    }
    if (dbgRun) {
      dbgRun.addEventListener('click', function () {
        var st = global.miyaWorldbookST;
        var store = global.miyaWorldbookStore;
        var out = $('miya-wb-st-debug-out');
        if (!st || !store) {
          if (out) out.textContent = '模块未就绪';
          return;
        }
        var text = ($('miya-wb-st-debug-text') && $('miya-wb-st-debug-text').value) || '';
        var budget = Number(($('miya-wb-st-debug-budget') && $('miya-wb-st-debug-budget').value) || 2048);
        var pipe = st.runPipeline(store.listEntries(), {
          contextText: text,
          tokenBudget: budget,
          dryRun: true,
          chatId: '__debug__'
        });
        var lines = [];
        lines.push('scanLen=' + (pipe.scanText || '').length + ' usedTokens=' + pipe.usedTokens + ' budget=' + pipe.budgetTokens);
        lines.push('selected=' + (pipe.selected || []).length + ' dropped=' + (pipe.dropped || []).length);
        lines.push('--- selected ---');
        (pipe.selected || []).forEach(function (e) {
          lines.push(
            '• [' + (e.constant ? 'C' : 'K') + '] order=' + e.order +
            ' pos=' + e.position +
            (e.group ? ' group=' + e.group + '(' + e.groupWeight + ')' : '') +
            ' ' + (e.name || e.id)
          );
        });
        if (pipe.dropped && pipe.dropped.length) {
          lines.push('--- dropped (budget) ---');
          pipe.dropped.forEach(function (d) {
            lines.push('• ' + (d.name || d.id) + ' tokens≈' + d.tokens);
          });
        }
        if (out) out.textContent = lines.join('\n');
      });
    }

    $('miya-wb-doc-file').addEventListener('change', function () {
      var f = $('miya-wb-doc-file').files && $('miya-wb-doc-file').files[0];
      $('miya-wb-doc-file').value = '';
      if (f) importDocToBody(f);
    });

    app.addEventListener('click', function (e) {
      var roleCard = e.target.closest('.ins-wb-role-card');
      if (roleCard) {
        roleCard.classList.toggle('is-selected');
        roleCard.setAttribute('aria-pressed', roleCard.classList.contains('is-selected') ? 'true' : 'false');
        return;
      }
      var groupAdd = e.target.closest('[data-wb-group-add]');
      if (groupAdd) {
        promptNewGroup();
        return;
      }
      var groupChip = e.target.closest('[data-wb-group]');
      if (groupChip && groupChip.hasAttribute('data-wb-group')) {
        filterGroupId = groupChip.getAttribute('data-wb-group') || 'all';
        renderList();
        return;
      }
      var collapseBtn = e.target.closest('[data-wb-collapse]');
      if (collapseBtn) {
        var gid = collapseBtn.getAttribute('data-wb-collapse');
        collapsedGroups[gid] = !collapsedGroups[gid];
        renderList();
        return;
      }
      var editGroupBtn = e.target.closest('[data-wb-group-edit]');
      if (editGroupBtn) {
        e.stopPropagation();
        promptRenameGroup(editGroupBtn.getAttribute('data-wb-group-edit'));
        return;
      }
      var delGroupBtn = e.target.closest('[data-wb-group-del]');
      if (delGroupBtn) {
        e.stopPropagation();
        promptDeleteGroup(delGroupBtn.getAttribute('data-wb-group-del'));
        return;
      }
      var editBtn = e.target.closest('[data-wb-edit]');
      if (editBtn) {
        var ent = store.getEntry(editBtn.getAttribute('data-wb-edit'));
        if (ent) fillEditor(ent);
        return;
      }
      var toggleBtn = e.target.closest('[data-wb-toggle]');
      if (toggleBtn) {
        e.stopPropagation();
        var id = toggleBtn.getAttribute('data-wb-toggle');
        var ent2 = store.getEntry(id);
        if (!ent2) return;
        store.toggleEntryEnabled(id, ent2.enabled === false).then(renderList);
        return;
      }
      var card = e.target.closest('.ins-wb-card');
      if (card && !e.target.closest('button')) {
        var ent3 = store.getEntry(card.getAttribute('data-wb-id'));
        if (ent3) fillEditor(ent3);
      }
    });
  }

  function openWorldbookApp() {
    var app = $('miya-worldbook-app');
    if (!app || !store) return;
    Promise.all([store.whenReady(), ensureContactsReady()]).then(function () {
      filterScope = 'all';
      filterGroupId = 'all';
      searchQuery = '';
      if ($('miya-wb-search')) $('miya-wb-search').value = '';
      syncFilterUi();
      closeEditor();
      app.removeAttribute('hidden');
      app.classList.add('is-open');
      app.setAttribute('aria-hidden', 'false');
      document.body.classList.add('miya-app-open');
      if (global.miyaArmOpenClickGuard) global.miyaArmOpenClickGuard(app);
      requestAnimationFrame(function () { renderList(); });
    }).catch(function () {
      toast('典籍加载失败');
    });
  }

  function closeWorldbookApp() {
    var app = $('miya-worldbook-app');
    if (!app) return;
    closeEditor();
    app.classList.remove('is-open', 'has-editor');
    app.setAttribute('hidden', '');
    app.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.miya-beautify-app.is-open') &&
        !document.querySelector('.miya-settings-app.is-open') &&
        !document.querySelector('.miya-contacts-app.is-open') &&
        !document.querySelector('.miya-music-app.is-open') &&
        !document.querySelector('.miya-chat-app.is-open') &&
        !document.querySelector('.miya-memory-app.is-open')) {
      document.body.classList.remove('miya-app-open');
    }
  }

  bindEvents();
  global.miyaWorldbookApp = { open: openWorldbookApp, close: closeWorldbookApp, toast: toast };
})(window);
