(function (global) {
  'use strict';

  var store = global.miyaContactsStore;
  var relStore = global.miyaContactsRelationshipStore;
  var filterGroupId = 'all';
  var editingId = null;
  var draftAvatar = null;
  var keyboardInsetBound = false;
  var focusScrollTimer = null;
  var lastFocusedField = null;
  var gridRenderGen = 0;
  var GRID_CHUNK = 32;
  var GRID_CHUNK_LOW_END = 16;

  function resolveGridChunk() {
    return (document.documentElement && document.documentElement.classList.contains('is-low-end'))
      ? GRID_CHUNK_LOW_END
      : GRID_CHUNK;
  }
  var pendingImportTags = null;
  var pendingWorldbookImport = null;
  /* 打开应用后短时间内忽略点击，避免桌面图标的 touch 穿透到「建档/导入」 */
  var openGuardUntil = 0;

  function $(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    var div = document.createElement('div');
    div.className = 'mn-toast';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 2400);
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

  function monogram(name) {
    return Array.from(String(name || '').trim() || '?')[0] || '?';
  }

  function editorScrollEl() {
    return $('miya-ct-editor-scroll');
  }

  function syncKeyboardInset() {
    var app = $('miya-contacts-app');
    if (!app || !app.classList.contains('has-editor')) return;
    var vv = window.visualViewport;
    var inset = 0;
    if (vv) {
      inset = Math.max(0, Math.round(window.innerHeight - vv.height - (vv.offsetTop || 0)));
    }
    var open = inset > 40;
    app.classList.toggle('mn--keyboard', open);
    if (open && vv) {
      app.style.setProperty('--mn-kb-top', Math.round(vv.offsetTop || 0) + 'px');
      app.style.setProperty('--mn-kb-height', Math.round(vv.height) + 'px');
      if (vv.offsetTop > 0) window.scrollTo(0, 0);
    } else {
      app.style.removeProperty('--mn-kb-top');
      app.style.removeProperty('--mn-kb-height');
    }
    if (open && lastFocusedField) ensureFieldVisible(lastFocusedField);
  }

  function ensureFieldVisible(field) {
    var sc = editorScrollEl();
    if (!sc || !field || !field.getBoundingClientRect) return;
    var vv = window.visualViewport;
    var viewTop = vv ? vv.offsetTop : 0;
    var foot = sc.parentElement && sc.parentElement.querySelector('.mn-editor-foot');
    var footRect = foot ? foot.getBoundingClientRect() : null;
    var limitBottom = footRect ? footRect.top : (vv ? vv.offsetTop + vv.height : window.innerHeight);
    var rect = field.getBoundingClientRect();
    var margin = 20;
    if (rect.bottom > limitBottom - margin) {
      sc.scrollTop += rect.bottom - limitBottom + margin;
    }
    if (rect.top < viewTop + margin) {
      sc.scrollTop -= viewTop + margin - rect.top;
    }
  }

  function scheduleFieldScroll(field) {
    if (!field) return;
    lastFocusedField = field;
    clearTimeout(focusScrollTimer);
    focusScrollTimer = setTimeout(function () {
      syncKeyboardInset();
      requestAnimationFrame(function () {
        ensureFieldVisible(field);
        requestAnimationFrame(function () {
          ensureFieldVisible(field);
        });
      });
    }, 280);
  }

  function clearKeyboardState() {
    var app = $('miya-contacts-app');
    if (app) {
      app.classList.remove('mn--keyboard');
      app.style.removeProperty('--mn-kb-top');
      app.style.removeProperty('--mn-kb-height');
    }
    lastFocusedField = null;
    clearTimeout(focusScrollTimer);
    focusScrollTimer = null;
  }

  function bindKeyboardInset() {
    if (keyboardInsetBound) return;
    keyboardInsetBound = true;
    var vv = window.visualViewport;
    function onViewportChange() {
      syncKeyboardInset();
    }
    if (vv) {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    window.addEventListener('resize', onViewportChange);
  }

  function filteredCharacters() {
    return store.listCharacters(filterGroupId);
  }

  function renderVolumes() {
    /* 分卷标签栏已随清爽蓝版式移除；保留空实现以兼容调用点 */
  }

  /* ── 记忆统计：档案角色 → 聊天会话的记忆沉淀 ──
   *
   * 清爽蓝名册把「已立忆」的角色置顶为横幅签，需要知道每个角色的
   * 记忆存量。链路：档案角色 →(characterId / chronicleId)→ 聊天联系人
   * → 私聊会话 → 会话设置里的 summaryList（分镜）/ megaSummaryList
   * （合卷）/ charMemoryList（角色记忆片段）。
   * 这些全是同步 API，依赖 miyaChatStore 已 init（openContactsApp 里等待）。
   * 任一环节缺失都安静返回零值 —— 名册不能因为聊天数据没就绪就不渲染。
   */
  function memoryStatsFor(row) {
    var out = { rounds: 0, fragments: 0, has: false };
    try {
      var st = global.miyaChatStore;
      if (!st || !st.findContactByArchiveCharacter) return out;
      var contact = st.findContactByArchiveCharacter(row);
      if (!contact) return out;
      var chat = st.findChatByContact ? st.findChatByContact(contact.id) : null;
      if (!chat) return out;
      var s = st.getChatSettings ? st.getChatSettings(chat.id) : null;
      if (!s) return out;
      out.rounds = (s.summaryList || []).length + (s.megaSummaryList || []).length;
      out.fragments = (s.charMemoryList || []).length;
      out.has = out.rounds > 0 || out.fragments > 0;
    } catch (e) { /* 兜底：读不到记忆数据就按未立忆渲染 */ }
    return out;
  }

  /* 99 以内的数字转中文（横幅签用「八」「一」标注存忆量） */
  function toCnNum(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n > 99) return String(n);
    var d = '零一二三四五六七八九';
    if (n < 10) return d[n];
    var t = Math.floor(n / 10);
    var u = n % 10;
    return (t > 1 ? d[t] : '') + '十' + (u ? d[u] : '');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var CHEV_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
  var PLUS_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  /*
   * 横幅签：已立忆角色的置顶大卡。
   * 左侧蓝竖条 + 字脸/头像（右上蓝点）+「已立忆」标签 + 名字 + 存忆量。
   */
  function bannerHtml(c, stats) {
    var face = c.avatar
      ? '<img src="' + esc(c.avatar) + '" alt="" loading="lazy" decoding="async"><i class="mn-b-dot"></i>'
      : esc(monogram(c.name)) + '<i class="mn-b-dot"></i>';
    return (
      '<button type="button" class="mn-banner" data-ct-id="' + esc(c.id) + '"' +
      ' aria-label="' + esc(c.name) + '，已立忆">' +
      '<span class="mn-b-face" aria-hidden="true">' + face + '</span>' +
      '<span class="mn-b-main">' +
      '<span class="mn-b-tag"><i></i>已立忆</span>' +
      '<span class="mn-b-name">' + esc(c.name) + '</span>' +
      '<span class="mn-b-sub">存忆 <b>' + esc(toCnNum(stats.rounds)) + '</b> 轮 · 纪念片段 <b>' +
      esc(toCnNum(stats.fragments)) + '</b> 段</span>' +
      '</span>' +
      '<span class="mn-b-go" aria-hidden="true">' + CHEV_SVG + '</span>' +
      '</button>'
    );
  }

  /*
   * 双列名签：未立忆角色。编号沿用全册序号（横幅签占号但不出号），
   * 右上字章位置有头像时显示头像。
   */
  function tagCardHtml(c, no) {
    var stamp = c.avatar
      ? '<img src="' + esc(c.avatar) + '" alt="" loading="lazy" decoding="async">'
      : esc(monogram(c.name));
    return (
      '<button type="button" class="mn-tag" data-ct-id="' + esc(c.id) + '">' +
      '<span class="mn-tc-top">' +
      '<span class="mn-tc-no">NO.' + pad2(no) + '</span>' +
      '<span class="mn-tc-stamp" aria-hidden="true">' + stamp + '</span>' +
      '</span>' +
      '<span class="mn-tc-name">' + esc(c.name) + '</span>' +
      '<span class="mn-tc-sub">名签待录</span>' +
      '<span class="mn-tc-foot">' +
      '<span class="mn-tc-state">未立忆</span>' +
      '<span class="mn-tc-arrow" aria-hidden="true">' + CHEV_SVG + '</span>' +
      '</span>' +
      '</button>'
    );
  }

  /* 空白签：名册末尾的快捷建档入口 */
  function blankCardHtml() {
    return (
      '<button type="button" class="mn-tag mn-tag--blank" data-ct-new="1" aria-label="新建档案">' +
      '<span class="mn-blank-plus" aria-hidden="true">' + PLUS_SVG + '</span>' +
      '<span class="mn-blank-t">新建名签</span>' +
      '<span class="mn-blank-s">BLANK</span>' +
      '</button>'
    );
  }

  function defaultGroupName() {
    var g = store.getGroup(store.DEFAULT_GROUP_ID);
    return (g && g.name) || '未归档';
  }

  function renderVolumeFooter() {
    var foot = $('miya-ct-vol-foot');
    if (!foot) return;
    if (filterGroupId === 'all') {
      foot.hidden = true;
      foot.innerHTML = '';
      return;
    }
    var g = store.getGroup(filterGroupId);
    if (!g || g.fixed) {
      foot.hidden = true;
      foot.innerHTML = '';
      return;
    }
    foot.hidden = false;
    foot.innerHTML =
      '<button type="button" class="mn-vol-del" data-ct-group-del="' + esc(g.id) + '">' +
      '删除本卷 · ' + esc(g.name) +
      '</button>';
  }

  function renderGrid() {
    var grid = $('miya-ct-grid');
    if (!grid) return;
    var rows = filteredCharacters();
    var gen = ++gridRenderGen;

    /* 版头统计：录入位数 / 已立忆位数 / 记忆轮数合计 */
    var stats = rows.map(memoryStatsFor);
    var remembered = 0;
    var rounds = 0;
    stats.forEach(function (s) {
      if (s.has) remembered++;
      rounds += s.rounds;
    });
    var metaEl = $('miya-ct-meta');
    if (metaEl) {
      metaEl.innerHTML =
        '录入 <b>' + rows.length + '</b> 位 · 已立忆 <b>' + remembered + '</b> 位 · 计 <b>' + rounds + '</b> 轮';
    }

    function finishGrid() {
      renderVolumeFooter();
    }

    if (!rows.length) {
      grid.innerHTML =
        '<div class="mn-empty">' +
        '<strong>名册空白</strong>' +
        '<span>点「建档」创建角色<br>或「导入」酒馆卡（PNG / JSON）<br>编辑时可从 docx/txt 填入人设 · 与世界书典籍联动</span>' +
        '</div>' +
        '<div class="mn-book-gap"></div>' +
        '<div class="mn-tags">' + blankCardHtml() + '</div>';
      finishGrid();
      return;
    }

    /* 已立忆 → 置顶横幅签；未立忆 → 双列名签（末尾追加空白签） */
    var bannersHtml = '';
    var cardItems = [];
    rows.forEach(function (c, i) {
      if (stats[i].has) bannersHtml += bannerHtml(c, stats[i]);
      else cardItems.push(tagCardHtml(c, i + 1));
    });
    cardItems.push(blankCardHtml());

    grid.innerHTML =
      (bannersHtml
        ? '<div class="mn-banners">' + bannersHtml + '</div><div class="mn-book-gap"></div>'
        : '') +
      '<div class="mn-tags" id="miya-ct-tags"></div>';
    var tags = $('miya-ct-tags');

    /* 名签量大时按帧分块插入，避免一次性 innerHTML 卡顿 */
    var chunk = resolveGridChunk();
    if (cardItems.length <= chunk) {
      tags.innerHTML = cardItems.join('');
      finishGrid();
      return;
    }
    var idx = 0;
    (function appendChunk() {
      if (gen !== gridRenderGen) return;
      var slice = cardItems.slice(idx, idx + chunk);
      tags.insertAdjacentHTML('beforeend', slice.join(''));
      idx += chunk;
      if (idx < cardItems.length) requestAnimationFrame(appendChunk);
      else finishGrid();
    })();
  }

  function renderList() {
    renderVolumes();
    renderGrid();
  }

  function fillGroupSelect(selectedId) {
    var sel = $('miya-ct-field-group');
    if (!sel) return;
    var groups = store.listGroups();
    sel.innerHTML = groups.map(function (g) {
      var picked = String(g.id) === String(selectedId || store.DEFAULT_GROUP_ID) ? ' selected' : '';
      return '<option value="' + esc(g.id) + '"' + picked + '>' + esc(g.name) + '</option>';
    }).join('') + '<option value="__new__">＋ 新建卷</option>';
  }

  function renderRelationMatrix(characterId) {
    var wrap = $('miya-ct-relations');
    if (!wrap || !relStore) return;
    var self = store.findCharacter(characterId);
    if (!self) { wrap.innerHTML = ''; return; }
    var peers = store.listCharacters(self.groupId).filter(function (c) {
      return c.id !== self.id;
    });
    if (!peers.length) {
      wrap.innerHTML = '<p class="mn-wb-link">同卷暂无其他角色</p>';
      return;
    }
    wrap.innerHTML = '<div class="mn-matrix">' + peers.map(function (p) {
      var rel = relStore.getRelation(self.id, p.id, self.groupId);
      return (
        '<div class="mn-matrix-row">' +
        '<span class="mn-matrix-name">' + esc(p.name) + '</span>' +
        '<input type="text" class="mn-input" data-ct-rel="' + esc(p.id) + '" value="' + esc(rel) + '" placeholder="关系描述">' +
        '</div>'
      );
    }).join('') + '</div>';
  }

  /**
   * 渲染「开场白」编辑区。
   *
   * 每一条是一个可编辑 textarea + 删除按钮。第 1 条带「首条消息」角标，
   * 因为它是默认展示项（用户约定：greetings[0] = 首条消息）。
   *
   * 空串是合法值：用户会故意留一条空的再把它编辑成首条消息，所以这里
   * 不因为内容为空就跳过渲染。
   */
  function renderGreetingEditors(list) {
    var wrap = $('miya-ct-greetings');
    if (!wrap) return;
    var items = Array.isArray(list) ? list : [];
    if (!items.length) items = [''];

    wrap.innerHTML = items.map(function (text, idx) {
      var isFirst = idx === 0;
      return '<div class="mn-greeting" data-greeting-idx="' + idx + '">' +
        '<div class="mn-greeting-head">' +
          '<span class="mn-greeting-tag' + (isFirst ? ' is-first' : '') + '">' +
            (isFirst ? '首条消息' : '备选 ' + idx) +
          '</span>' +
          '<button type="button" class="mn-greeting-del" data-greeting-del="' + idx + '"' +
            (items.length <= 1 ? ' hidden' : '') + ' aria-label="删除这条开场白">×</button>' +
        '</div>' +
        '<textarea class="mn-textarea mn-greeting-text" data-greeting-text rows="3" spellcheck="false"' +
          ' placeholder="' + (isFirst ? '角色在对话里说的第一句话…' : '另一套开场…') + '">' +
          esc(text) + '</textarea>' +
      '</div>';
    }).join('');
  }

  /* 读取编辑区里所有开场白（原样保留空串，交给 store 决定怎么存） */
  function readGreetingsFromEditor() {
    var wrap = $('miya-ct-greetings');
    if (!wrap) return [];
    var boxes = wrap.querySelectorAll('[data-greeting-text]');
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
      out.push(String(boxes[i].value == null ? '' : boxes[i].value).trim());
    }
    return out;
  }

  function addGreetingEditor() {
    var cur = readGreetingsFromEditor();
    cur.push('');
    renderGreetingEditors(cur);
    var wrap = $('miya-ct-greetings');
    var boxes = wrap ? wrap.querySelectorAll('[data-greeting-text]') : null;
    if (boxes && boxes.length) {
      var last = boxes[boxes.length - 1];
      if (last.focus) last.focus();
    }
  }

  function removeGreetingEditor(idx) {
    var cur = readGreetingsFromEditor();
    cur.splice(idx, 1);
    if (!cur.length) cur = [''];
    renderGreetingEditors(cur);
  }

  function fillEditor(entry) {
    var isNew = !entry;
    var data = entry || {
      groupId: filterGroupId !== 'all' ? filterGroupId : store.DEFAULT_GROUP_ID,
      name: '',
      age: '',
      gender: '',
      birthday: '',
      persona: '',
      greetings: [],
      avatar: ''
    };
    editingId = isNew ? null : data.id;
    draftAvatar = data.avatar || null;

    $('miya-ct-editor-title').textContent = isNew ? '新建档案' : '编辑 · ' + (data.name || '');
    $('miya-ct-field-name').value = data.name || '';
    $('miya-ct-field-age').value = data.age || '';
    $('miya-ct-field-gender').value = data.gender || '';
    $('miya-ct-field-birthday').value = data.birthday || '';
    $('miya-ct-field-persona').value = data.persona || '';
    renderGreetingEditors(data.greetings || []);
    fillGroupSelect(data.groupId || store.DEFAULT_GROUP_ID);

    var img = $('miya-ct-portrait-img');
    var mono = $('miya-ct-portrait-mono');
    if (draftAvatar) {
      if (img) { img.src = draftAvatar; img.hidden = false; }
      if (mono) mono.hidden = true;
    } else {
      if (img) img.hidden = true;
      if (mono) { mono.textContent = monogram(data.name); mono.hidden = false; }
    }

    var wbCount = isNew ? 0 : store.countWorldbookBindings(data.id);
    var wbEl = $('miya-ct-wb-count');
    if (wbEl) wbEl.textContent = String(wbCount);

    if (!isNew) renderRelationMatrix(data.id);
    else if ($('miya-ct-relations')) $('miya-ct-relations').innerHTML = '<p class="mn-wb-link">保存后可编辑同卷人际脉络</p>';

    var app = $('miya-contacts-app');
    if (app) app.classList.add('has-editor');
    var scroll = editorScrollEl();
    if (scroll) scroll.scrollTop = 0;
    syncKeyboardInset();
  }

  function readEditorPayload() {
    var groupSel = $('miya-ct-field-group');
    var groupVal = groupSel ? groupSel.value : store.DEFAULT_GROUP_ID;
    var payload = {
      id: editingId || undefined,
      name: ($('miya-ct-field-name').value || '').trim(),
      age: ($('miya-ct-field-age').value || '').trim(),
      gender: ($('miya-ct-field-gender').value || '').trim(),
      birthday: ($('miya-ct-field-birthday').value || '').trim(),
      persona: ($('miya-ct-field-persona').value || '').trim(),
      greetings: readGreetingsFromEditor(),
      avatar: draftAvatar || ''
    };
    /*
     * 编辑器只承载上面这些可见字段，但 normalizeCharacter / upsertCharacter 是
     * 「全量覆盖」写入。若不把未在表单里出现的字段带上，它们会被重置：
     *   - characterId：会被 normalizeCharacter 兜底成 id，导致酒馆卡导入角色的
     *     characterId 关联（世界书绑定、聊天侧匹配）全部漂移
     *   - tags：会被重置成空数组，导入时记录的标签全部丢失
     * 因此编辑既有档案时，先从原档案取回这些字段作为基底。
     */
    if (editingId) {
      var prev = null;
      try {
        prev = store.findCharacter ? store.findCharacter(editingId) : null;
      } catch (e) {
        prev = null;
      }
      if (prev) {
        if (prev.characterId) payload.characterId = prev.characterId;
        if (Array.isArray(prev.tags)) payload.tags = prev.tags.slice();
      }
    }
    if (groupVal === '__new__') {
      payload.newGroupName = ($('miya-ct-field-new-group') && $('miya-ct-field-new-group').value || '').trim();
      if (!payload.newGroupName) payload.groupId = store.DEFAULT_GROUP_ID;
    } else {
      payload.groupId = groupVal;
    }
    /* 本次导入带来的新标签优先于旧标签 */
    if (pendingImportTags && pendingImportTags.length) payload.tags = pendingImportTags.slice();
    return payload;
  }

  function applyPendingWorldbook(characterRow) {
    if (!pendingWorldbookImport || !pendingWorldbookImport.doImport || !pendingWorldbookImport.book) {
      return Promise.resolve(null);
    }
    var fn = global.miyaTavernCardImport && global.miyaTavernCardImport.applyWorldbookForCharacter;
    if (!fn) return Promise.resolve(null);
    return fn(characterRow, pendingWorldbookImport.book);
  }

  function saveRelations(characterId) {
    if (!relStore || !characterId) return Promise.resolve();
    var self = store.findCharacter(characterId);
    if (!self) return Promise.resolve();
    var inputs = document.querySelectorAll('[data-ct-rel]');
    var chain = Promise.resolve();
    inputs.forEach(function (input) {
      var peerId = input.getAttribute('data-ct-rel');
      var val = (input.value || '').trim();
      chain = chain.then(function () {
        return relStore.setRelation(self.id, peerId, val, self.groupId);
      });
    });
    return chain;
  }

  function clearPendingImport() {
    pendingImportTags = null;
    pendingWorldbookImport = null;
  }

  function closeEditor() {
    editingId = null;
    draftAvatar = null;
    clearPendingImport();
    clearKeyboardState();
    var app = $('miya-contacts-app');
    if (app) app.classList.remove('has-editor');
  }

  function saveEditor() {
    var payload = readEditorPayload();
    if (!payload.name) { toast('请填写姓名'); return; }
    store.upsertCharacter(payload).then(function (result) {
      if (result && result.error) { toast(result.error); return; }
      return saveRelations(result.id).then(function () {
        return applyPendingWorldbook(result);
      }).then(function (wbResult) {
        var sync = global.miyaChatContactsSync;
        var afterSync = sync && sync.syncOne
          ? sync.syncOne(result.id)
          : Promise.resolve();
        return afterSync.then(function () {
          closeEditor();
          renderList();
          if (wbResult && wbResult.count) {
            toast('档案已入卷 · 世界书 ' + wbResult.count + ' 条');
          } else {
            toast('档案已入卷');
          }
        });
      });
    }).catch(function () { toast('保存失败'); });
  }

  function deleteEditing() {
    if (!editingId) { closeEditor(); return; }
    dialog({
      mode: 'confirm',
      title: '撕毁档案',
      message: '删除后世界书绑定需自行调整，确定继续？',
      confirmText: '删除'
    }).then(function (ok) {
      if (!ok) return;
      store.removeCharacter(editingId).then(function () {
        var sync = global.miyaChatContactsSync;
        var after = sync && sync.syncAll
          ? sync.syncAll({ prune: true })
          : Promise.resolve();
        return after.then(function () {
          closeEditor();
          renderList();
          toast('已删除');
        });
      });
    });
  }

  function importCardFile(file) {
    var fn = global.miyaTavernCardImport && global.miyaTavernCardImport.parseFile;
    if (!fn) { toast('酒馆卡解析模块未加载'); return; }
    fn(file).then(function (parsed) {
      if (!parsed || !parsed.character) { toast('未能解析角色卡'); return; }
      var ch = parsed.character;
      if (!String(ch.name || '').trim() && !String(ch.persona || '').trim()) {
        toast('角色卡内容为空');
        return;
      }
      clearPendingImport();
      pendingImportTags = ch.tags && ch.tags.length ? ch.tags.slice() : null;
      pendingWorldbookImport = parsed.worldbook ? { book: parsed.worldbook, doImport: false } : null;

      function openImportedEditor() {
        fillEditor({
          groupId: filterGroupId !== 'all' ? filterGroupId : store.DEFAULT_GROUP_ID,
          name: ch.name || String(file.name || '').replace(/\.[^.]+$/, '').slice(0, 32),
          age: ch.age || '',
          gender: ch.gender || '',
          birthday: ch.birthday || '',
          persona: ch.persona || '',
          greetings: ch.greetings || [],
          avatar: ch.avatar || ''
        });
        toast('已解析角色卡，确认后可封存');
      }

      if (pendingWorldbookImport) {
        var wb = pendingWorldbookImport.book;
        var entryCount = (wb.entries || []).length;
        var bookLabel = wb.name || '角色世界书';
        dialog({
          mode: 'confirm',
          title: '导入世界书',
          message: '检测到角色卡附带 ' + entryCount + ' 条世界书（' + bookLabel + '）。是否一并导入为世界书分类，并局部绑定给该角色？',
          confirmText: '导入',
          cancelText: '跳过'
        }).then(function (ok) {
          pendingWorldbookImport.doImport = !!ok;
          openImportedEditor();
        });
      } else {
        openImportedEditor();
      }
    }).catch(function (err) {
      var code = err && err.message;
      if (code === 'png_no_chara') toast('PNG 中未找到酒馆卡数据');
      else if (code === 'not_character_card') toast('不是有效的酒馆角色卡');
      else if (code === 'invalid_json' || code === 'empty_json') toast('JSON 格式无效');
      else toast('读取角色卡失败');
    });
  }

  function importDocToPersona(file) {
    var fn = global.miyaWorldbookExtractFileText;
    if (!fn) { toast('文档解析模块未加载'); return; }
    fn(file).then(function (text) {
      var field = $('miya-ct-field-persona');
      if (!field) return;
      var t = String(text || '').trim();
      if (!t) { toast('未能识别到文字内容'); return; }
      field.value = t;
      if (!($('miya-ct-field-name').value || '').trim()) {
        var base = String(file.name || '').replace(/\.[^.]+$/, '').trim();
        if (base) $('miya-ct-field-name').value = base.slice(0, 32);
      }
      toast('已填入人设与背景');
    }).catch(function (err) {
      var code = err && err.message;
      if (code === 'unsupported_type') toast('仅支持 .txt 与 .docx');
      else if (code === 'jszip_missing') toast('文档解析库未加载');
      else toast('读取文件失败');
    });
  }

  function promptNewGroup() {
    dialog({
      mode: 'prompt',
      title: '新建卷',
      message: '输入卷名（分组名）',
      placeholder: '例如：主线角色',
      defaultValue: ''
    }).then(function (name) {
      name = String(name || '').trim();
      if (!name) return;
      store.upsertGroup({ name: name, sort: Date.now() }).then(function (g) {
        filterGroupId = g.id;
        renderList();
        toast('新卷已创建');
      });
    });
  }

  function promptDeleteGroup(groupId) {
    var g = store.getGroup(groupId);
    if (!g || g.fixed) return;
    var cnt = store.listCharacters(g.id).length;
    var archiveName = defaultGroupName();
    dialog({
      mode: 'confirm',
      title: '删除卷',
      message: '删除「' + g.name + '」后，该卷内' +
        (cnt ? ' ' + cnt + ' 位' : '所有') + '角色将归入「' + archiveName + '」。继续？',
      confirmText: '删除',
      cancelText: '取消'
    }).then(function (ok) {
      if (!ok) return;
      store.removeGroup(g.id).then(function () {
        var sync = global.miyaChatContactsSync;
        var after = sync && sync.syncAll
          ? sync.syncAll({ force: true })
          : Promise.resolve();
        return after.then(function () {
          if (filterGroupId === g.id) filterGroupId = 'all';
          renderList();
          toast('卷已删除');
        });
      });
    });
  }

  function bindEvents() {
    var root = $('miya-contacts-app');
    if (!root || root.__bound) return;
    root.__bound = true;
    bindKeyboardInset();

    root.addEventListener('focusin', function (e) {
      if (!root.classList.contains('has-editor')) return;
      var field = e.target;
      if (!field || !field.matches) return;
      if (!field.matches('.mn-editor input, .mn-editor textarea, .mn-editor select')) return;
      scheduleFieldScroll(field);
    });

    root.addEventListener('focusout', function (e) {
      if (!root.classList.contains('has-editor')) return;
      var field = e.target;
      if (!field || !field.matches) return;
      if (!field.matches('.mn-editor input, .mn-editor textarea, .mn-editor select')) return;
      setTimeout(function () {
        var active = document.activeElement;
        if (active && root.contains(active) && active.matches('.mn-editor input, .mn-editor textarea, .mn-editor select')) return;
        lastFocusedField = null;
        syncKeyboardInset();
      }, 120);
    });

    $('miya-ct-back').addEventListener('click', closeContactsApp);
    $('miya-ct-refresh').addEventListener('click', function () {
      if (Date.now() < openGuardUntil) return;
      renderList();
    });
    $('miya-ct-add').addEventListener('click', function () {
      if (Date.now() < openGuardUntil) return;
      clearPendingImport();
      fillEditor(null);
    });
    $('miya-ct-card-import').addEventListener('click', function () {
      if (Date.now() < openGuardUntil) return;
      // 酒馆卡导入不再要求激活码，直接打开文件选择器。
      $('miya-ct-card-file').click();
    });
    $('miya-ct-doc-import').addEventListener('click', function () { $('miya-ct-doc-file').click(); });
    $('miya-ct-editor-back').addEventListener('click', closeEditor);
    $('miya-ct-save').addEventListener('click', saveEditor);
    $('miya-ct-delete').addEventListener('click', deleteEditing);

    $('miya-ct-portrait').addEventListener('click', function () {
      $('miya-ct-avatar-file').click();
    });

    $('miya-ct-avatar-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        draftAvatar = reader.result;
        var img = $('miya-ct-portrait-img');
        var mono = $('miya-ct-portrait-mono');
        if (img) { img.src = draftAvatar; img.hidden = false; }
        if (mono) mono.hidden = true;
      };
      reader.readAsDataURL(f);
    });

    $('miya-ct-avatar-reset').addEventListener('click', function () {
      draftAvatar = null;
      var img = $('miya-ct-portrait-img');
      var mono = $('miya-ct-portrait-mono');
      var name = ($('miya-ct-field-name') || {}).value || '';
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (mono) { mono.textContent = monogram(name); mono.hidden = false; }
    });

    /* 链接导入已移除：头像只通过点按头像区选择本地图片。 */

    $('miya-ct-doc-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) importDocToPersona(f);
    });

    $('miya-ct-card-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) importCardFile(f);
    });

    $('miya-ct-field-group').addEventListener('change', function () {
      var wrap = $('miya-ct-new-group-wrap');
      if (wrap) wrap.hidden = this.value !== '__new__';
    });

    /* 开场白：添加 / 删除走事件代理，因为条目是动态渲染的 */
    var greetingAdd = $('miya-ct-greeting-add');
    if (greetingAdd) greetingAdd.addEventListener('click', function () { addGreetingEditor(); });

    var greetingWrap = $('miya-ct-greetings');
    if (greetingWrap) {
      greetingWrap.addEventListener('click', function (e) {
        var del = e.target.closest ? e.target.closest('[data-greeting-del]') : null;
        if (!del) return;
        var idx = parseInt(del.getAttribute('data-greeting-del'), 10);
        if (!isNaN(idx)) removeGreetingEditor(idx);
      });
    }

    $('miya-ct-wb-jump').addEventListener('click', function () {
      if (global.miyaWorldbookApp && global.miyaWorldbookApp.open) {
        closeContactsApp();
        global.miyaWorldbookApp.open();
      }
    });

    root.addEventListener('click', function (e) {
      var groupBtn = e.target.closest('[data-ct-group]');
      if (groupBtn) {
        filterGroupId = groupBtn.getAttribute('data-ct-group') || 'all';
        renderList();
        return;
      }
      if (e.target.closest('[data-ct-group-add]')) {
        promptNewGroup();
        return;
      }
      /* 空白签：名册末尾的快捷建档入口 */
      if (e.target.closest('[data-ct-new]')) {
        if (Date.now() < openGuardUntil) return;
        clearPendingImport();
        fillEditor(null);
        return;
      }
      var delGroupBtn = e.target.closest('[data-ct-group-del]');
      if (delGroupBtn) {
        promptDeleteGroup(delGroupBtn.getAttribute('data-ct-group-del'));
        return;
      }
      var panel = e.target.closest('[data-ct-id]');
      if (panel) {
        if (Date.now() < openGuardUntil) return;
        var row = store.findCharacter(panel.getAttribute('data-ct-id'));
        if (row) { clearPendingImport(); fillEditor(row); }
      }
    });
  }

  function openContactsApp() {
    var app = $('miya-contacts-app');
    if (!app || !store) return;
    openGuardUntil = Date.now() + 450;
    Promise.all([
      store.whenReady(),
      relStore ? relStore.whenReady() : Promise.resolve(),
      /* 名册要读每个角色的记忆沉淀（已立忆/存忆轮数），等聊天库就绪；
         失败也不阻塞 —— memoryStatsFor 自带零值兜底 */
      global.miyaChatStore && global.miyaChatStore.init
        ? Promise.resolve(global.miyaChatStore.init()).catch(function () {})
        : Promise.resolve()
    ]).then(function () {
      bindEvents();
      closeEditor();
      app.classList.remove('has-editor');
      app.classList.add('is-open');
      app.setAttribute('aria-hidden', 'false');
      document.body.classList.add('miya-app-open');
      requestAnimationFrame(function () { renderList(); });
    });
  }

  function closeContactsApp() {
    var app = $('miya-contacts-app');
    if (!app) return;
    closeEditor();
    app.classList.remove('is-open');
    app.setAttribute('aria-hidden', 'true');
    if (global.miyaChatApp && global.miyaChatApp.invalidateStore) {
      global.miyaChatApp.invalidateStore();
    }
    if (!document.querySelector('.miya-beautify-app.is-open, .mi-set-page.is-open, .miya-worldbook-app.is-open, .miya-chat-app.is-open')) {
      document.body.classList.remove('miya-app-open');
    }
  }

  global.miyaContactsApp = {
    open: openContactsApp,
    close: closeContactsApp,
    toast: toast
  };
})(window);
