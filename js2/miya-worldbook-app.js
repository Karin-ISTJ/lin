(function (global) {
  'use strict';

  var store = global.miyaWorldbookStore;
  /* 注意：这里**不再**引入 store.DEFAULT_GROUP_ID。
     未分组是 store 的内部实现细节，UI 层不应该知道它的 id，
     也不应该自己判断「它该不该显示」——那些都通过 store 的分组视图接口完成：
       listVisibleGroups() / listRealGroups() / visibleGroupId() / peekDefaultGroupId()
     这样以后调整兜底容器的策略时，只需要改 store 一处。 */
  var filterScope = 'all';
  var filterGroupId = 'all';
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
    return rows.filter(function (entry) {
      if (filterScope !== 'all' && entry.scope !== filterScope) return false;
      /* 不再按分卷横向筛选，全部在手风琴中展示 */
      return true;
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
        var isOrphan = row.source === 'orphan';
        var portrait = row.avatar
          ? '<span class="ins-wb-role-portrait"><img src="' + esc(row.avatar) + '" alt=""></span>'
          : '<span class="ins-wb-role-portrait ins-wb-role-portrait--mono">' + esc(roleMonogram(row.roleName)) + '</span>';
        /* 标签：档案 / 已失效。
           「已失效」= 该绑定指向的联系人已被删除，只剩一个孤立 ID。
           以前这类卡会把裸 ID 当名字显示（ct_mtxj2rfh_a1ek7s），用户
           既看不懂也无法判断该不该取消。现在给出人话标签 + 小字 ID。 */
        var tag = isOrphan
          ? '<span class="ins-wb-role-tag ins-wb-role-tag--orphan">已失效</span>'
          : (row.source === 'contacts' ? '<span class="ins-wb-role-tag">档案</span>' : '');
        var hint = isOrphan && row.roleNameHint
          ? '<span class="ins-wb-role-card-hint" title="' + esc(row.roleNameHint) + '">' +
            esc(row.roleNameHint) + '</span>'
          : '';
        return (
          '<button type="button" class="ins-wb-role-card' + (on ? ' is-selected' : '') +
          (isOrphan ? ' is-orphan' : '') +
          '" data-role-id="' + esc(row.roleId) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
          '<span class="ins-wb-role-mark" aria-hidden="true"></span>' +
          portrait +
          '<span class="ins-wb-role-card-body">' +
          '<span class="ins-wb-role-card-name">' + esc(row.roleName || row.roleId) + '</span>' +
          tag +
          hint +
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

  /* 打开编辑器时该词条**原本**绑定的角色 ID。
     用途：区分「用户这次主动勾上的脏 ID」与「本来就绑着的脏 ID」。
     后者不能拦 —— 它已存在于数据里，拦掉等于用户一保存就静默丢绑定。 */
  var editingBoundRoleIds = [];

  function collectRoleIdsSafe() {
    var picked = collectRoleIds();
    var allowed = {};
    (editingBoundRoleIds || []).forEach(function (id) { allowed[String(id)] = true; });
    var rows = store.resolveAvailableRoles ? store.resolveAvailableRoles() : [];
    var orphanSet = {};
    rows.forEach(function (r) {
      if (r && r.source === 'orphan') orphanSet[String(r.roleId)] = true;
    });
    /* 不新增「失效绑定」：orphan 卡只在**原本就绑着**时才允许保留。
       这样用户在面板上误点一张已失效的卡，不会被写进词条；
       而历史遗留的绑定仍能被看见、也仍能被取消（取消后不再放行）。 */
    return picked.filter(function (id) {
      if (!orphanSet[id]) return true;
      return !!allowed[id];
    });
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

    /* 该显示哪些分组，完全交给 store 决定（未分组的可见性规则封装在里面） */
    var groups = store.listVisibleGroups();
    /* 条目按归属分组归类。归属分组不存在或被隐藏时，由 store.visibleGroupId()
       统一规整到当前可见的分组，UI 不自己判断兜底。 */
    var byGroup = {};
    groups.forEach(function (g) { byGroup[g.id] = []; });
    rows.forEach(function (entry) {
      var gid = store.visibleGroupId(entry.groupId, groups);
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
      /* 分组总开关（未分组是兜底容器，不提供开关） */
      var groupOff = !g.fixed && g.enabled === false;
      var toggleOp = g.fixed ? '' : (
        '<button type="button" class="ins-wb-group-op ins-wb-group-op--power' + (groupOff ? ' is-off' : '') + ' mi-ico-btn" ' +
        'data-wb-group-toggle="' + esc(g.id) + '" ' +
        'title="' + (groupOff ? '整组已关闭，点击启用' : '整组启用中，点击关闭') + '" ' +
        'aria-label="' + (groupOff ? '启用整组' : '关闭整组') + '" aria-pressed="' + (groupOff ? 'false' : 'true') + '">' +
        (groupOff ? '○' : '●') + '</button>'
      );
      var actions = g.fixed ? '' : (
        '<span class="ins-wb-group-head-ops">' + toggleOp +
        '<button type="button" class="ins-wb-group-op mi-ico-btn" data-wb-group-edit="' + esc(g.id) + '" title="重命名" aria-label="重命名"><img src="img/icons/edit-03.svg" alt="" width="16" height="16"></button>' +
        '<button type="button" class="ins-wb-group-op ins-wb-group-op--del mi-ico-btn mi-ico-btn--danger" data-wb-group-del="' + esc(g.id) + '" title="删除世界书" aria-label="删除世界书"><img src="img/icons/trash-01.svg" alt="" width="16" height="16"></button>' +
        '</span>'
      );
      html += '<section class="ins-wb-book' + (collapsed ? ' is-collapsed' : ' is-open') + (groupOff ? ' is-group-off' : '') + '" data-wb-book="' + esc(g.id) + '">' +
        '<div class="ins-wb-book-head">' +
        '<button type="button" class="ins-wb-book-toggle" data-wb-collapse="' + esc(g.id) + '" aria-expanded="' + !collapsed + '">' +
        '<span class="ins-wb-book-arrow">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="ins-wb-book-title">' + esc(g.name) + '</span>' +
        (groupOff ? '<span class="ins-wb-book-badge">已关闭</span>' : '') +
        '<span class="ins-wb-book-count">' + items.length + ' 条</span>' +
        '</button>' + actions + '</div>';
      if (!collapsed) {
        html += '<div class="ins-wb-book-body">' + items.map(function (e, i) { return renderEntryCard(e, i); }).join('') + '</div>';
      }
      html += '</section>';
    });

    /* 说明：不再需要「孤儿条目」兜底分支。
       store.visibleGroupId() 已保证每一条都会归入某个**可见**分组，
       不存在归类后却无处显示的情况。若某条目所属分组被隐藏（未分组无内容时），
       它会自动落到最后一个可见分组下，数据始终可见。 */

    list.innerHTML = html || rows.map(function (e, i) { return renderEntryCard(e, i); }).join('');
  }

  function fillGroupSelect(selectedId) {
    var sel = $('miya-wb-field-group');
    if (!sel) return;
    /* 下拉里只列「该显示的分组」，未分组不再是一个可选项——
       它只负责异常兜底，用户没有理由主动往里面存词条。 */
    var groups = store.listVisibleGroups();
    if (!groups.length) groups = store.listGroups();

    /* 【必须补进来】词条当前所属的分组若已关闭（或未分组被隐藏），
       它不会出现在 listVisibleGroups 里。此时下拉会回落到别的分组，
       readEditorPayload 读到的 groupId 就与词条真实归属不一致 ——
       用户什么都没改、点一下保存，词条就被**静默搬到另一个世界书**。
       所以这里把「当前归属」强行补进选项并选中，保证「打开→保存」
       这条路径不改变任何数据。 */
    var wantId = selectedId != null && selectedId !== '' ? String(selectedId) : '';
    var hasWant = wantId && groups.some(function (g) { return String(g.id) === wantId; });
    if (wantId && !hasWant) {
      var cur = store.getGroup ? store.getGroup(wantId) : null;
      if (cur) {
        groups = groups.concat([{
          id: cur.id,
          name: String(cur.name || '未命名世界书') +
            (cur.enabled === false ? '（已关闭）' : ''),
          enabled: cur.enabled
        }]);
      }
    }

    /* 默认选中「第一个真实分组」，未分组不作为默认。
       未分组只会在「正在编辑一条兜底条目」时被显式传入而选中。 */
    if (!wantId) {
      var fallbackId = store.peekDefaultGroupId();
      if (!fallbackId) fallbackId = groups[0] && groups[0].id;
      wantId = String(fallbackId || '');
    }
    sel.innerHTML = groups.map(function (g) {
      var picked = String(g.id) === wantId ? ' selected' : '';
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

  /** 同步取「默认归属分组」id；由 store 决定（绝不返回未分组） */
  function firstRealGroupId() {
    return store.peekDefaultGroupId();
  }

  function fillEditor(entry) {
    var isNew = !entry;
    /* 新建条目的默认归属：当前筛选中的真实分组 → store 给的默认分组。
       以前无条件用未分组，导致每建一条都默认落进未分组，用户每次都得手动改。 */
    var defaultGid = null;
    if (filterGroupId !== 'all') {
      var cur = store.getGroup(filterGroupId);
      if (cur && store.isGroupVisible(cur)) defaultGid = filterGroupId;
    }
    if (!defaultGid) defaultGid = firstRealGroupId();
    var data = entry || {
      scope: filterScope === 'local' ? 'local' : 'global',
      globalReach: 'online_offline',
      depth: 'middle',
      groupId: defaultGid || '',
      keywords: [],
      boundRoleIds: [],
      enabled: true,
      /* ⚠️ 新建片段默认「常驻」。
         这里必须显式写 constant:true —— 缺省会让下面 statusEl 的判定
         落进 else 分支显示「关键词触发」，而用户新建时通常不会填关键词，
         于是 matchEntry 一路走到 stKeywordMatch()，被以 no_keywords 拒绝，
         词条**永远不注入且毫无提示**。
         与 index.html 中状态下拉的第一项（常驻）保持一致。 */
      constant: true,
      content: '',
      name: ''
    };
    editingId = isNew ? null : data.id;
    /* 记录「打开这一刻」的绑定快照。
       为什么需要它：resolveAvailableRoles 会把词条绑过的、但联系人档案里
       查不到的 ID 作为「已失效」卡片列出来（见 miya-worldbook-store）。
       如果保存时无脑把这些卡片一起收走，用户光是打开看一下再保存，
       就会把历史遗留绑定静默写回去；反过来，如果一律拦掉，
       用户就没法保住、更没法取消这些绑定。
       所以判据只能是「本来就有」：开编辑器时快照，保存时放行快照内的、
       拦掉这次新勾上的。新建条目走 data.boundRoleIds=[] 的空快照。 */
    editingBoundRoleIds = Array.isArray(data.boundRoleIds)
      ? data.boundRoleIds.map(function (v) { return String(v).trim(); }).filter(Boolean)
      : [];
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
    /*
     * 匹配方式与递归控制。
     *
     * 这四个字段引擎早就支持、导入导出也一直带，但之前没有编辑入口 ——
     * 用户只能靠改 JSON 去动它们，等于「有能力但够不着」。
     * 注意一律用 !! 归一化：这些字段可能是 undefined（老数据没存过），
     * 直接赋给 checked 会得到 undefined → 控件状态不确定。
     */
    setChk('miya-wb-field-case-sensitive', data.caseSensitive);
    setChk('miya-wb-field-whole-words', data.matchWholeWords);
    setChk('miya-wb-field-exclude-recursion', data.excludeRecursion);
    setChk('miya-wb-field-prevent-recursion', data.preventRecursion);
    $('miya-wb-field-body').value = data.content || '';
    var rolesHost = $('miya-wb-roles-host');
    if (rolesHost) rolesHost.innerHTML = '<p class="ins-wb-role-empty">正在读取联系人档案…</p>';
    fillGroupSelect(data.groupId || '');
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

    /* 诊断面板：每次打开编辑器都重置。
       关键——必须在这条新建词条/另一条词条之间清掉上一次的结论，
       否则会拿上一条的结果误导用户。 */
    var diagWrap = $('miya-wb-diag');
    if (diagWrap) diagWrap.open = false;
    resetDiag();
    fillDiagRoles(data.boundRoleIds || []);
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
    var roles = scope === 'local' ? collectRoleIdsSafe() : [];
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
    /*
     * depth 只作为**非 @深度**条目的分桶依据（front / middle）。
     *
     * position=4（@深度）不在这里换算成 'back' —— 那样会把「插进聊天记录」
     * 降级成「追加到末尾」，与用户选的位置不符。分桶由 partitionByDepth
     * 直接看 position 判定，这条路径不参与。
     *
     * ⚠️ 这里曾写成 position===4 ? 'back'，配合当时 normalizeStFields 里
     * 「position=4 时优先取 raw.depth」的优先级，产生两个后果：
     *   1) @深度 条目被静默降级为追加末尾；
     *   2) raw.depth 是字符串 'back'，clampInt 后兜底成 4，
     *      把用户在「深度」框里填的数字整个覆盖掉（填什么都是 4）。
     * 现在两边都已修正：分桶看 position，injection_depth 以用户输入优先。
     */
    var depth = position === 0 ? 'front' : 'middle';
    var stApi = global.miyaWorldbookST;
    if (stApi && typeof stApi.positionToDepth === 'function' && position !== 4) {
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
      /* 分组兜底：优先用下拉框当前值；为空时落到 store 给的默认分组。
         两者都拿不到时传空串，交由 store 的 normalizer 统一兜底，
         UI 不再直接引用未分组的 id。 */
      groupId: ($('miya-wb-field-group') && $('miya-wb-field-group').value) || firstRealGroupId() || '',
      boundRoleIds: scope === 'local' ? roles : [],
      enabled: status !== 'disabled',
      constant: status === 'constant',
      /* W4：selective 只由勾选框决定。
         原先写的是 chk(...) || keysecondary.length > 0 —— 只要填了次关键词就强行打开
         selective，导致用户没勾选却生效，勾选框与真实状态不一致。
         次关键词是否参与，交给勾选框控制；填了但没勾即为「暂不使用」。 */
      selective: chk('miya-wb-field-selective'),
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
      groupOverride: chk('miya-wb-field-group-override'),
      caseSensitive: chk('miya-wb-field-case-sensitive'),
      matchWholeWords: chk('miya-wb-field-whole-words'),
      excludeRecursion: chk('miya-wb-field-exclude-recursion'),
      preventRecursion: chk('miya-wb-field-prevent-recursion')
    };
  }

  function closeEditor() {
    editingId = null;
    /* 与 openEditor 的快照对称清空：残留的上一条绑定快照会让
       collectRoleIdsSafe() 在下一轮误放行 orphan ID。 */
    editingBoundRoleIds = [];
    var app = $('miya-worldbook-app');
    if (app) app.classList.remove('has-editor');
    var editor = $('miya-wb-editor');
    if (editor) editor.setAttribute('aria-hidden', 'true');
    resetDiag();
  }

  /* ------------------------------------------------------------------
   * 激活诊断
   *
   * 输入源刻意复用 readEditorPayload() —— 保证「诊断用的词条」与
   * 「保存后会写入的词条」是同一份数据。若另建一套读取逻辑，两者迟早漂移，
   * 诊断就会开始骗人。
   *
   * 判定交给 matcher.diagnoseEntries（纯只读，不掷概率）。
   * ------------------------------------------------------------------ */

  /** 把词条判定结果翻译成用户能看懂的分层结论 */
  function buildDiagSteps(entry, cfg, verdict) {
    var steps = [];
    var reach = verdict.reach;
    function push(state, key, text) {
      steps.push({ state: state, key: key, text: text });
    }

    /* 1) 条目开关 */
    if (entry.enabled === false) {
      push('fail', '条目开关', '已关闭 —— 后续判定不再执行');
      return steps;
    }
    push('pass', '条目开关', '已开启');

    /* 2) 分组开关 */
    if (verdict.reason === 'group_disabled') {
      push('fail', '世界书分组', '所属世界书被整组关闭 —— 条目自身仍是开启的');
      return steps;
    }
    push('pass', '世界书分组', '所属世界书已启用');

    /* 3) 范围 / 场景 / 角色 */
    var scopeTxt = entry.scope === 'local' ? '局部（需绑定联系人）' : '全局（对所有联系人）';
    if (entry.scope === 'local' && verdict.reason === 'scope_local_role_mismatch') {
      push('fail', '生效范围', scopeTxt + ' —— 绑定的联系人与模拟对象不一致');
      return steps;
    }
    /* 局部但一个联系人都没绑：引擎按「不限制角色」处理，会对所有人注入。
       这与「局部」这个名字给用户的预期正相反，必须显式警告 ——
       正常路径下编辑器会拦住它（保存时校验），但**导入的词条可能绕过**。 */
    var unboundLocal = entry.scope === 'local' && !(entry.boundRoleIds || []).length;
    if (unboundLocal) {
      push('warn', '生效范围', '局部词条但未绑定任何联系人 —— 引擎会当作「不限制角色」，' +
        '对**所有**联系人注入，与「局部」的预期相反。建议绑定联系人后保存');
    } else if (entry.scope === 'local') {
      push('pass', '生效范围', scopeTxt + '，绑定 ' + (entry.boundRoleIds || []).length + ' 位联系人');
    } else {
      push('pass', '生效范围', scopeTxt);
    }

    if (verdict.reason === 'reach_mismatch') {
      push('fail', '生效场景', '词条限定「' + reachName(reach) + '」，模拟场景是「' +
        reachName(cfg.promptContext) + '」');
      return steps;
    }
    /* 「线上和线下」这类包含关系要说清为什么相符，
       否则用户会以为「仅线上」是个约束。 */
    var reachTxt = '词条限定「' + reachName(reach) + '」';
    if (cfg.promptContext) {
      reachTxt += '，当前模拟「' + reachName(cfg.promptContext) + '」';
      reachTxt += (String(reach) === 'online_offline')
        ? ' —— 线上线下都覆盖，相符'
        : ' —— 相符';
    }
    push('pass', '生效场景', reachTxt);

    /* 4) 常驻 / 关键词 */
    if (entry.constant) {
      push('pass', '触发方式', '常驻 —— 无需关键词，直接注入');
      return steps;
    }
    if (verdict.reason === 'no_keywords') {
      push('fail', '关键词', '非常驻，且没有配置任何关键词 —— 永远不会被触发');
      return steps;
    }
    if (verdict.reason === 'keyword_miss') {
      push('fail', '关键词', verdict.detail);
      return steps;
    }
    if (verdict.reason === 'probability') {
      push('pass', '关键词', '已命中');
      push('warn', '触发概率', '设置了 ' + entry.probability +
        '% 概率 —— 每次生成独立掷骰，可能命中也可能不命中');
      return steps;
    }
    push('pass', '关键词', verdict.detail || '已命中');

    /* 5) 概率（命中后再看） */
    if (entry.useProbability && entry.probability < 100) {
      push('warn', '触发概率', '设置了 ' + entry.probability + '% 概率，命中后仍会掷骰');
    } else {
      push('pass', '触发概率', '100% —— 命中即注入');
    }
    return steps;
  }

  function reachName(v) {
    var s = String(v || '').trim();
    if (s === 'all') return '全软件';
    if (s === 'online') return '仅线上';
    if (s === 'offline') return '仅线下';
    if (s === 'online_offline') return '线上和线下';
    return s || '未限定';
  }

  /** 填充「模拟联系人」下拉（每个 local 词条都可能绑不同的人） */
  function fillDiagRoles(selectedIds) {
    var sel = $('miya-wb-diag-role');
    if (!sel) return;
    var store = global.miyaWorldbookStore;
    var rows = store && typeof store.resolveAvailableRoles === 'function'
      ? store.resolveAvailableRoles()
      : [];
    var picked = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
    /* 优先选中词条已绑定的联系人，其次第一个 */
    var want = picked.length ? picked[0] : (rows[0] && rows[0].roleId) || '';
    if (!rows.length) {
      sel.innerHTML = '<option value="">（暂无联系人）</option>';
      return;
    }
    sel.innerHTML = rows.map(function (r) {
      var id = String(r.roleId || '');
      return '<option value="' + esc(id) + '"' + (id === want ? ' selected' : '') + '>' +
        esc(r.roleName || id) + '</option>';
    }).join('');
  }

  function resetDiag() {
    var out = $('miya-wb-diag-out');
    if (out) {
      out.hidden = true;
      out.innerHTML = '';
    }
  }

  function runDiag() {
    var matcher = global.miyaWorldbookMatcher;
    var out = $('miya-wb-diag-out');
    if (!out) return;
    if (!matcher || typeof matcher.diagnoseEntries !== 'function') {
      out.hidden = false;
      out.innerHTML = '<p class="miya-wb-diag__detail">诊断模块未就绪（matcher 未加载）。</p>';
      return;
    }

    /* 用编辑器当前内容当作被诊断的词条 —— 与保存后的数据同源 */
    var entry = readEditorPayload();
    var cfg = {
      contextText: ($('miya-wb-diag-ctx') && $('miya-wb-diag-ctx').value) || '',
      promptContext: ($('miya-wb-diag-scene') && $('miya-wb-diag-scene').value) || 'online',
      roleIds: (function () {
        var r = ($('miya-wb-diag-role') && $('miya-wb-diag-role').value) || '';
        return r ? [r] : [];
      })()
    };

    var res = matcher.diagnoseEntries([entry], cfg);
    var verdict = res.rows[0] || {};
    var steps = buildDiagSteps(entry, cfg, verdict);

    var cls = verdict.injected
      ? (verdict.reason === 'probability' ? 'is-warn' : 'is-ok')
      : 'is-block';
    var headline = verdict.injected
      ? (verdict.reason === 'probability' ? '有条件注入' : '会注入')
      : '不会注入';

    var html = '<div class="miya-wb-diag__verdict ' + cls + '">' +
      '<strong>' + esc(headline) + '</strong>' +
      '<span>· ' + esc(verdict.reasonLabel || '') + '</span>' +
      '</div>';

    html += '<ul class="miya-wb-diag__steps">' + steps.map(function (s) {
      var mark = s.state === 'pass' ? '✓' : s.state === 'warn' ? '!' : s.state === 'fail' ? '✕' : '·';
      var cls2 = s.state === 'pass' ? 'is-pass' : s.state === 'fail' ? 'is-fail' : s.state === 'skip' ? 'is-skip' : '';
      return '<li class="miya-wb-diag__step ' + cls2 + '">' +
        '<span class="miya-wb-diag__mark">' + mark + '</span>' +
        '<span><span class="miya-wb-diag__k">' + esc(s.key) + '</span>' + esc(s.text) + '</span>' +
        '</li>';
    }).join('') + '</ul>';

    if (!entry.name) {
      html += '<p class="miya-wb-diag__meta">提示：尚未填写标题，保存前请补上。</p>';
    }
    if (!cfg.contextText) {
      html += '<p class="miya-wb-diag__meta">未填模拟上下文 —— 关键词类词条在空白文本上必然不命中，' +
        '请粘贴几条最近的消息再试。</p>';
    }
    html += '<p class="miya-wb-diag__meta">诊断只读：不掷概率、不改设置、不影响实际注入。' +
      '显示的是关键词层面的判定结果。</p>';

    out.innerHTML = html;
    out.hidden = false;
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
    /*
     * 弹窗文案必须把「条目会一起没」讲明白。
     *
     * 这个操作不可撤销 —— 条目直接从数组摘掉，没有回收站。
     * 而「删分卷」三个字本身有歧义：有人以为是解散分组（内容留下），
     * 有人以为是连内容一起删。所以这里不但要说明，还要把**条数**摆出来，
     * 让用户有个具体的量感，才有机会在按删除前反悔。
     */
    var message = cnt > 0
      ? '分卷「' + g.name + '」及其中的 ' + cnt + ' 条片段将一并删除。\n\n此操作不可撤销，删除后无法恢复。'
      : '分卷「' + g.name + '」将被删除（该分卷下没有片段）。';
    dialog({
      mode: 'confirm',
      title: cnt > 0 ? '删除分卷及其内容' : '删除分卷',
      message: message,
      confirmText: '删除'
    }).then(function (ok) {
      if (!ok) return;
      store.removeGroup(g.id).then(function (res) {
        if (filterGroupId === g.id) filterGroupId = 'all';
        renderList();
        /*
         * 提示里带上实际删掉的条数 —— 让「删了 13 条」这件事有回执，
         * 而不是只看到「分卷已删除」，心里没底到底删干净没有。
         */
        var n = res && typeof res.removedEntries === 'number' ? res.removedEntries : 0;
        toast(n > 0 ? '分卷及 ' + n + ' 条片段已删除' : '分卷已删除');
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
        /* 预算取值：留空 = 不裁剪（与主链路「未配置即不裁剪」同一语义）。
           ⚠️ 这里以前兜底 2048 —— 主链路已修成「未配置不裁剪」，但调试台
           仍按 2048 裁剪，用户在调试台看到「只命中两条」，与真实注入对不上，
           会误判成「修复无效」。调试台是观察主链路的仪表，仪表必须跟主链路
           同口径：留空 → tokenBudget: null（runPipeline 内部退化为 Infinity），
           显式填了正数才生效。 */
        var rawBudget = ($('miya-wb-st-debug-budget') && $('miya-wb-st-debug-budget').value) || '';
        var budgetNum = Number(rawBudget);
        var budget = rawBudget.trim() !== '' && Number.isFinite(budgetNum) && budgetNum > 0
          ? budgetNum
          : null;
        var pipe = st.runPipeline(store.listEntries(), {
          contextText: text,
          tokenBudget: budget,
          dryRun: true,
          chatId: '__debug__'
        });
        var lines = [];
        lines.push('scanLen=' + (pipe.scanText || '').length + ' usedTokens=' + pipe.usedTokens +
          ' budget=' + (pipe.budgetTokens == null ? '∞（不裁剪）' : pipe.budgetTokens));
        lines.push('selected=' + (pipe.selected || []).length + ' dropped=' + (pipe.dropped || []).length);

        /* 分桶概览：把 position=4 的落点挑明。
           以前这里不显示 inChat，用户看不出「深度注入」词条到底插到哪，
           容易被误当成按「后」注入。 */
        var bk = (pipe.buckets || {});
        var inChatRows = bk.inChat || [];
        lines.push('buckets: front=' + ((bk.front || []).length) +
                   ' middle=' + ((bk.middle || []).length) +
                   ' back=' + ((bk.back || []).length) +
                   ' inChat=' + inChatRows.length);

        lines.push('--- selected ---');
        (pipe.selected || []).forEach(function (e) {
          var pos = Number(e.position);
          /* position=4 的条目额外标出「插到倒数第 N 条之前」 */
          var tail = '';
          if (pos === 4) {
            var dep = Number(e.injection_depth);
            if (!Number.isFinite(dep) || dep < 0) dep = 0;
            tail = '  ⇢ 深度注入：插到倒数第 ' + dep + ' 条之前';
          }
          lines.push(
            '• [' + (e.constant ? 'C' : 'K') + '] order=' + e.order +
            ' pos=' + e.position +
            (e.group ? ' group=' + e.group + '(' + e.groupWeight + ')' : '') +
            ' ' + (e.name || e.id) + tail
          );
        });

        if (inChatRows.length) {
          lines.push('--- inChat（深度注入，按 depth 降序插入）---');
          inChatRows.slice().sort(function (a, b) {
            var da = Number(a.injection_depth);
            var db = Number(b.injection_depth);
            if (!Number.isFinite(da)) da = 0;
            if (!Number.isFinite(db)) db = 0;
            if (db !== da) return db - da;
            return (Number(a.order) || 100) - (Number(b.order) || 100);
          }).forEach(function (e) {
            var dep = Number(e.injection_depth);
            if (!Number.isFinite(dep) || dep < 0) dep = 0;
            lines.push('• depth=' + dep + ' order=' + e.order + ' ' + (e.name || e.id));
          });
        }

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

    /* 激活诊断：顶栏入口 + 运行按钮 + 展开时自动填一次联系人 */
    var diagJump = $('miya-wb-diag-jump');
    if (diagJump) {
      diagJump.addEventListener('click', function () {
        var wrap = $('miya-wb-diag');
        if (!wrap) return;
        wrap.open = true;
        /* 与保存口径一致：用 collectRoleIdsSafe()。
           若这里用原始 DOM 选择，诊断台会拿「一个保存时根本不会写入的角色」
           去跑匹配，给出的结论与真实结果对不上 —— 面板骗人比面板不说话更糟。 */
        fillDiagRoles(collectRoleIdsSafe());
        /* 必须先展开再滚动 —— 折叠状态下 offsetTop 不准 */
        var sc = document.querySelector('.ins-wb-editor-scroll');
        if (sc) {
          var top = wrap.offsetTop - 16;
          if (typeof sc.scrollTo === 'function') sc.scrollTo({ top: top, behavior: 'smooth' });
          else sc.scrollTop = top;
        }
        wrap.classList.add('is-flash');
        setTimeout(function () { wrap.classList.remove('is-flash'); }, 1200);
      });
    }
    var diagRun = $('miya-wb-diag-run');
    if (diagRun) diagRun.addEventListener('click', runDiag);
    var diagWrap = $('miya-wb-diag');
    if (diagWrap) {
      diagWrap.addEventListener('toggle', function () {
        if (!diagWrap.open) return;
        var roles = collectRoleIdsSafe();
        fillDiagRoles(roles);
      });
    }

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
      /*
       * 分组总开关必须放在 collapse 之前判断：
       * 按钮虽在分组头里，但不该触发折叠。
       */
      var groupToggleBtn = e.target.closest('[data-wb-group-toggle]');
      if (groupToggleBtn) {
        e.stopPropagation();
        e.preventDefault();
        var tgGid = groupToggleBtn.getAttribute('data-wb-group-toggle');
        var tgOn = store.isGroupEnabled ? store.isGroupEnabled(tgGid) : true;
        if (typeof store.toggleGroupEnabled === 'function') {
          store.toggleGroupEnabled(tgGid, !tgOn).then(renderList);
        }
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
        !document.querySelector('.mi-set-page.is-open') &&
        !document.querySelector('.miya-contacts-app.is-open') &&
        !document.querySelector('.miya-chat-app.is-open') &&
        !document.querySelector('.miya-memory-app.is-open')) {
      document.body.classList.remove('miya-app-open');
    }
  }

  bindEvents();
  global.miyaWorldbookApp = { open: openWorldbookApp, close: closeWorldbookApp, toast: toast };
})(window);
