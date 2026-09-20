/**
 * Miya 聊天 · 联系人设置（全屏 · 单页滚动）
 */
(function (global) {
  'use strict';

  var store = null;
  var pageEl = null;
  var state = { chatId: null, formDraft: null, wbSortOpen: false, zoneOpen: {}, subView: null, apiPresetPick: '', apiModelPick: '', apiModel2Pick: '', apiModelPickBase: null, apiModel2PickBase: null };
  var DEFAULT_ZONE_OPEN = { basic: false };
  var renderRaf = 0;
  var ctxUsageGen = 0;
  /* 「Token 来源分布」里已展开具体条目的来源 key，重绘后按此恢复展开态 */
  var ctxOpenSrcRows = Object.create(null);

  var LANG_OPTS = [
    { v: 'auto', label: '自动' },
    { v: 'Chinese', label: '中文（普通话）' },
    { v: 'Chinese,Yue', label: '中文（粤语）' },
    { v: 'English', label: 'English' },
    { v: 'Japanese', label: '日本語' },
    { v: 'Korean', label: '한국어' }
  ];

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    if (global.miyaChatApp && global.miyaChatApp.toast) global.miyaChatApp.toast(msg);
    else if (pageEl) {
      var el = pageEl.querySelector('.mi-toast');
      if (el) {
        el.textContent = msg;
        el.classList.add('is-show');
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.classList.remove('is-show'); }, 2400);
      }
    }
  }

  function dialog(opts) {
    if (global.miyaDialog) {
      if (opts.mode === 'confirm' && global.miyaDialog.confirm) return global.miyaDialog.confirm(opts);
      if (global.miyaDialog.prompt) return global.miyaDialog.prompt(opts);
    }
    return Promise.resolve(null);
  }

  function triggerFileInput(input) {
    if (!input) return;
    if (global.miyaTriggerFileInput) global.miyaTriggerFileInput(input);
    else input.click();
  }

  function ctx() {
    if (!store || !state.chatId) return null;
    var chat = store.findChat(state.chatId);
    if (!chat) return null;
    var contact = store.findContact(chat.contactId);
    var settings = store.getChatSettings(state.chatId);
    var profiles = store.getProfiles();
    var profile = profiles.find(function (p) {
      return p.id === (chat.profileId || (contact && contact.defaultProfileId));
    }) || store.getActiveProfile();
    return { chat: chat, contact: contact, settings: settings, profiles: profiles, profile: profile };
  }

  function sectionLabel(title, sub) {
    return '<div class="st-section-label">' + esc(title) + '</div>' +
      (sub ? '<p class="st-form-hint mi-set-section-hint">' + esc(sub) + '</p>' : '');
  }

  function isZoneOpen(id) {
    if (Object.prototype.hasOwnProperty.call(state.zoneOpen, id)) {
      return !!state.zoneOpen[id];
    }
    return !!DEFAULT_ZONE_OPEN[id];
  }

  function captureZoneOpenState(body) {
    if (!body) return;
    body.querySelectorAll('[data-mq-set-zone]').forEach(function (el) {
      var id = el.getAttribute('data-mq-set-zone');
      if (id) state.zoneOpen[id] = el.classList.contains('is-open');
    });
  }

  function toggleZone(panel) {
    if (!panel) return;
    var body = panel.querySelector('.mi-set-zone__body');
    var toggle = panel.querySelector('[data-mq-set-zone-toggle]');
    if (!body) return;
    var nextOpen = !panel.classList.contains('is-open');
    panel.classList.toggle('is-open', nextOpen);
    body.hidden = !nextOpen;
    var id = panel.getAttribute('data-mq-set-zone');
    if (id) state.zoneOpen[id] = nextOpen;
    if (toggle) toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  function renderZone(id, title, hint, content) {
    var open = isZoneOpen(id);
    return '<section class="mi-set-zone' + (open ? ' is-open' : '') + '" data-mq-set-zone="' + esc(id) + '">' +
      '<button type="button" class="mi-set-zone__head" data-mq-set-zone-toggle aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<div class="mi-set-zone__text">' +
          '<strong class="mi-set-zone__title">' + esc(title) + '</strong>' +
          (hint ? '<span class="mi-set-zone__hint">' + esc(hint) + '</span>' : '') +
        '</div>' +
        '<img class="mi-ico-img" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
      '</button>' +
      '<div class="mi-set-zone__body"' + (open ? '' : ' hidden') + '>' + content + '</div>' +
    '</section>';
  }

  /*
   * API 入口：与其它折叠栏同款外观，点击进入**页内子视图**。
   *
   * ── 为什么不能「就地展开成表单」──────────────────────────────
   *
   * 这个页面的 render() 是整页 innerHTML 重绘（见下方 render()）。
   * 如果把 API 表单直接展开在 zone 里，任何一次重绘（改开关、改输入
   * 触发的联动）都会把表单 DOM 整个换掉 —— 用户正在输入的内容会丢。
   * 要就地展开就得重写整套渲染为增量更新，代价远大于收益。
   *
   * 所以改成子视图：点进去把 body 换成该 API 的表单，返回回到列表。
   * 交互上「点进去改」这一点没变，只是从「切到另一个 App」
   * 改成「在当前页内翻一页」，对用户来说少了一次跳转。
   */
  function renderApiNavBar(id, title, hint, subKey) {
    return '<section class="mi-set-zone" data-mq-set-zone="' + esc(id) + '">' +
      '<button type="button" class="mi-set-zone__head" data-mq-set-sub="' + esc(subKey) + '">' +
        '<div class="mi-set-zone__text">' +
          '<strong class="mi-set-zone__title">' + esc(title) + '</strong>' +
          (hint ? '<span class="mi-set-zone__hint">' + esc(hint) + '</span>' : '') +
        '</div>' +
        '<img class="mi-ico-img" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
      '</button>' +
    '</section>';
  }

  /* 普通「点进去」栏：与 API 栏同款外观，但用于备份、存储这类子视图 */
  function renderSubNavBar(id, title, hint, subKey) {
    return renderApiNavBar(id, title, hint, subKey);
  }

  function subBlock(title, sub, inner) {
    return '<div class="mi-set-sub">' +
      (title ? '<div class="mi-set-sub__head">' +
        '<span class="mi-set-sub__title">' + esc(title) + '</span>' +
        (sub ? '<span class="mi-set-sub__hint">' + esc(sub) + '</span>' : '') +
      '</div>' : '') +
      inner +
    '</div>';
  }

  function formCard(inner, extraClass) {
    return '<div class="st-form-card ins-form-block' + (extraClass ? ' ' + extraClass : '') + '">' + inner + '</div>';
  }

  function toggleRow(id, label, sub, on) {
    return '<div class="st-toggle-in-form">' +
      '<div class="st-toggle-in-form__text">' +
        '<strong>' + esc(label) + '</strong>' +
        (sub ? '<span>' + esc(sub) + '</span>' : '') +
      '</div>' +
      '<button type="button" class="ins-toggle' + (on ? ' is-on' : '') + '" id="' + esc(id) + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '"></button>' +
    '</div>';
  }

  function emoGroupToggleRow(groupId, label, on, disabled) {
    return '<div class="st-toggle-in-form mi-emo-bind-row' + (disabled ? ' is-disabled' : '') + '">' +
      '<div class="st-toggle-in-form__text"><strong>' + esc(label) + '</strong></div>' +
      '<button type="button" class="ins-toggle' + (on ? ' is-on' : '') + (disabled ? ' is-disabled' : '') +
      '" data-mq-set-emo-grp="' + esc(groupId) + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '"' +
      (disabled ? ' aria-disabled="true" tabindex="-1"' : '') + '></button></div>';
  }

  function syncTranslateExtrasVisibility(root) {
    if (!root) return;
    var on = isToggleOn(root, '#mq-set-trans');
    var wrap = root.querySelector('[data-mq-set-trans-extra]');
    if (wrap) wrap.hidden = !on;
  }

  /**
   * 「让TA自己决定何时找你」（基础区）与「定时主动消息」（记忆与后台区）互斥。
   * 前者开启时，normalizeChatSettings 会把 activeEnabled 置回 false，
   * 因此在界面上同步给出可见反馈：禁用定时开关并显示原因，避免用户以为保存失败。
   */
  function syncLifeLikeAgainstTimedBackground(root) {
    if (!root) return;
    var lifeLikeOn = isToggleOn(root, '#mq-set-lifelike');
    var activeSw = root.querySelector('#mq-set-bg-active');
    var warn = root.querySelector('[data-mq-set-bg-lifelike-warn]');
    if (activeSw) {
      activeSw.classList.toggle('is-disabled', lifeLikeOn);
      activeSw.setAttribute('aria-disabled', lifeLikeOn ? 'true' : 'false');
      if (lifeLikeOn) {
        activeSw.classList.remove('is-on');
        activeSw.setAttribute('aria-checked', 'false');
      }
    }
    if (warn) warn.hidden = !lifeLikeOn;
  }

  function syncEmoBindGroupToggles(root) {
    if (!root) return;
    var useAll = isToggleOn(root, '#mq-set-emo-all');
    root.querySelectorAll('[data-mq-set-emo-grp]').forEach(function (sw) {
      sw.classList.toggle('is-disabled', useAll);
      sw.setAttribute('aria-disabled', useAll ? 'true' : 'false');
      if (useAll) {
        sw.classList.remove('is-on');
        sw.setAttribute('aria-checked', 'false');
      }
    });
    root.querySelectorAll('.mi-emo-bind-row').forEach(function (row) {
      row.classList.toggle('is-disabled', useAll);
    });
  }

  function collectContactRoleIds(contact) {
    var eng = global.miyaChatEngine;
    if (eng && typeof eng.collectContactRoleIds === 'function') {
      return eng.collectContactRoleIds(contact);
    }
    if (!contact) return [];
    return [contact.characterId, contact.chronicleId, contact.id]
      .map(function (x) { return String(x || '').trim(); })
      .filter(Boolean);
  }

  function listSortableWorldbookEntriesForContact(contact) {
    var eng = global.miyaChatEngine;
    if (eng && typeof eng.listSortableWorldbookEntriesForContact === 'function') {
      return eng.listSortableWorldbookEntriesForContact(contact);
    }
    return [];
  }

  function filterWorldbookEntryOrderForContact(contact, orderIds) {
    var eng = global.miyaChatEngine;
    if (eng && typeof eng.collectSortableWorldbookEntryIdsForContact === 'function') {
      var allowed = {};
      eng.collectSortableWorldbookEntryIdsForContact(contact).forEach(function (id) {
        allowed[id] = true;
      });
      return (Array.isArray(orderIds) ? orderIds : [])
        .map(function (x) { return String(x || '').trim(); })
        .filter(function (id) { return id && allowed[id]; });
    }
    return [];
  }

  function resolveWorldbookEntryOrder(contact, boundEntries) {
    var saved = filterWorldbookEntryOrderForContact(
      contact,
      contact && Array.isArray(contact.worldbookEntryOrder) ? contact.worldbookEntryOrder : []
    );
    var byId = {};
    (boundEntries || []).forEach(function (entry) {
      if (entry && entry.id) byId[String(entry.id)] = entry;
    });
    var ordered = [];
    var seen = {};
    saved.forEach(function (id) {
      id = String(id || '').trim();
      if (!id || seen[id] || !byId[id]) return;
      seen[id] = true;
      ordered.push(byId[id]);
    });
    (boundEntries || []).forEach(function (entry) {
      if (!entry || !entry.id || seen[entry.id]) return;
      ordered.push(entry);
    });
    return ordered;
  }

  function renderWorldbookSortListRows(rows) {
    return '<div class="mi-wb-sort-list" data-mq-set-wb-sort>' +
      (rows || []).map(function (entry, i) {
        return '<div class="mi-wb-sort-row" data-mq-set-wb-sort-id="' + esc(entry.id) + '">' +
          '<span class="mi-wb-sort-row__idx">' + esc(String(i + 1)) + '</span>' +
          '<strong class="mi-wb-sort-row__name">' + esc(entry.name || '未命名片段') + '</strong>' +
          '<div class="mi-wb-sort-row__btns">' +
            '<button type="button" class="mi-wb-sort-btn" data-mq-set-wb-sort-up aria-label="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
            '<button type="button" class="mi-wb-sort-btn" data-mq-set-wb-sort-down aria-label="下移"' + (i === rows.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function renderWorldbookSortSection(contact) {
    var rows = resolveWorldbookEntryOrder(contact, listSortableWorldbookEntriesForContact(contact));
    var open = !!state.wbSortOpen;
    return formCard(
      '<div class="mi-wb-sort-panel' + (open ? ' is-open' : '') + '" data-mq-set-wb-sort-panel>' +
        '<button type="button" class="mi-wb-sort-toggle" data-mq-set-wb-sort-toggle aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<strong class="mi-wb-sort-toggle__title">世界书排序</strong>' +
          '<span class="mi-wb-sort-toggle__meta">' + esc(formatNum(rows.length)) + '</span>' +
          '<img class="mi-ico-img" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
        '</button>' +
        '<div class="mi-wb-sort-body"' + (open ? '' : ' hidden') + ' data-mq-set-wb-sort-body>' +
          renderWorldbookSortListRows(rows) +
        '</div>' +
      '</div>'
    );
  }

  function toggleWorldbookSortPanel() {
    if (!pageEl) return;
    var panel = pageEl.querySelector('[data-mq-set-wb-sort-panel]');
    var body = pageEl.querySelector('[data-mq-set-wb-sort-body]');
    var toggle = pageEl.querySelector('[data-mq-set-wb-sort-toggle]');
    if (!panel || !body) return;
    var nextOpen = !panel.classList.contains('is-open');
    panel.classList.toggle('is-open', nextOpen);
    body.hidden = !nextOpen;
    state.wbSortOpen = nextOpen;
    if (toggle) toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  function readWorldbookEntryOrderFromRoot(root) {
    if (!root) return [];
    var list = root.querySelector('[data-mq-set-wb-sort]');
    if (!list) return [];
    var out = [];
    list.querySelectorAll('[data-mq-set-wb-sort-id]').forEach(function (row) {
      var id = String(row.getAttribute('data-mq-set-wb-sort-id') || '').trim();
      if (id) out.push(id);
    });
    return out;
  }

  function refreshWorldbookSortRowState(list) {
    if (!list) return;
    var rows = Array.prototype.slice.call(list.querySelectorAll('[data-mq-set-wb-sort-id]'));
    rows.forEach(function (row, i) {
      var idx = row.querySelector('.mi-wb-sort-row__idx');
      if (idx) idx.textContent = String(i + 1);
      var up = row.querySelector('[data-mq-set-wb-sort-up]');
      var down = row.querySelector('[data-mq-set-wb-sort-down]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === rows.length - 1;
    });
  }

  function moveWorldbookSortRow(list, entryId, dir) {
    if (!list || !entryId) return;
    var rows = Array.prototype.slice.call(list.querySelectorAll('[data-mq-set-wb-sort-id]'));
    var idx = -1;
    rows.forEach(function (row, i) {
      if (row.getAttribute('data-mq-set-wb-sort-id') === entryId) idx = i;
    });
    if (idx < 0) return;
    var target = dir < 0 ? idx - 1 : idx + 1;
    if (target < 0 || target >= rows.length) return;
    if (dir < 0) list.insertBefore(rows[idx], rows[target]);
    else list.insertBefore(rows[target], rows[idx]);
    refreshWorldbookSortRowState(list);
  }

  function renderLifeLikeSection(settings) {
    var bg = (settings && settings.backgroundMessage) || {};
    return formCard(
      toggleRow('mq-set-lifelike', '让TA自己决定何时找你', '替代定时主动消息，由角色自行判断何时联系你', !!bg.lifeLikeEnabled) +
      toggleRow('mq-set-anonymous', '允许TA伪装身份发匿名消息', 'TA可自行决定某次主动联系时隐藏真实身份；消息内容仍由TA现场生成', !!bg.anonymousDisguiseEnabled)
    );
  }

  function pad2(n) {
    n = Number(n) || 0;
    return (n < 10 ? '0' : '') + n;
  }

  function minToTimeStr(min) {
    var m = parseInt(min, 10);
    if (!Number.isFinite(m)) m = 0;
    m = Math.min(1439, Math.max(0, m));
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  function timeStrToMin(str) {
    var m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /**
   * 「记忆与后台」分区：原「我的」页齿轮（miya-st-panel-contact-chat）里的 7 项，
   * 现并入角色聊天设置，命名与群设置的 memory 分区对齐。
   * 说明：定时主动消息（activeEnabled）与「让TA自己决定何时找你」（lifeLikeEnabled）
   * 互斥——lifeLike 开启时 normalizeChatSettings 会把 activeEnabled 置回 false，
   * 因此这里同步展示状态提示，避免用户以为设置没生效。
   */
  function renderMemoryZoneSection(s) {
    var bg = (s && s.backgroundMessage) || {};
    var lifeLikeOn = !!bg.lifeLikeEnabled;
    return subBlock('记忆', '每次调用 API 读取本会话最近多少条', formCard(
      fieldBlock('上下文条数', '数值越大越慢，也越贵', '<input type="number" class="ins-text-input" data-mq-set-memory-count min="1" max="500" value="' + esc(s.memoryCount != null ? s.memoryCount : 80) + '">')
    )) +
    subBlock('自动总结', '达到条数后自动生成分镜，与「记忆」桌面 App 的每 N 轮提炼互不影响', formCard(
      fieldBlock('自动总结触发', '设为 0 关闭；只影响分镜/合卷，不影响角色记忆提炼', '<input type="number" class="ins-text-input" data-mq-set-summary-trigger min="0" max="500" value="' + esc(s.summaryTrigger != null ? s.summaryTrigger : 0) + '">') +
      fieldBlock('总结长度', '生成摘要时的目标字数区间', '<input type="text" class="ins-text-input" data-mq-set-summary-length value="' + esc(s.summaryLength || '100-300字') + '" placeholder="100-300字">')
    )) +
    subBlock('后台消息', '由定时规则触发的主动消息', formCard(
      (lifeLikeOn
        ? '<p class="st-form-hint mi-set-inline-warn" data-mq-set-bg-lifelike-warn>已开启「让TA自己决定何时找你」，下方的定时主动消息不会生效。要改回定时，请先在上方「基础 → 主动消息」里关掉它。</p>'
        : '<p class="st-form-hint mi-set-inline-warn" data-mq-set-bg-lifelike-warn hidden>已开启「让TA自己决定何时找你」，下方的定时主动消息不会生效。要改回定时，请先在上方「基础 → 主动消息」里关掉它。</p>') +
      toggleRow('mq-set-bg-active', '主动发消息', '距最后一条消息达到间隔即触发，不论谁发的', !!bg.activeEnabled) +
      fieldBlock('主动间隔（分钟）', '从会话最后一条消息起算', '<input type="number" class="ins-text-input" data-mq-set-bg-active-min min="5" max="1440" value="' + esc(bg.activeIntervalMin != null ? bg.activeIntervalMin : 30) + '">') +
      '<p class="st-form-hint">静默时间段内即使到达间隔也不会主动发消息（以本地时间为准）。</p>' +
      fieldBlock('静默时段', '', '<div class="mi-inline-nums">' +
        '<input type="time" class="ins-text-input" data-mq-set-bg-quiet-start step="60" value="' + esc(minToTimeStr(bg.quietStartMin != null ? bg.quietStartMin : 1380)) + '">' +
        '<span class="mi-inline-nums__sep">至</span>' +
        '<input type="time" class="ins-text-input" data-mq-set-bg-quiet-end step="60" value="' + esc(minToTimeStr(bg.quietEndMin != null ? bg.quietEndMin : 420)) + '">' +
      '</div>') +
      toggleRow('mq-set-bg-quiet-en', '启用静默', '该时段内不主动发消息', !!bg.quietEnabled)
    ));
  }

  /**
   * 读取「记忆与后台」分区里属于**配置**的字段。
   *
   * 这些值在 getChatSettings() 的最后一步由全局配置覆盖，
   * 所以它们不能只写 contact.chatSettings，而要走 applyContactOverride。
   * 这里刻意不从 live 的 backgroundMessage 取 base，只产出这几个字段本身，
   * 避免把会话级运行时字段（下次推送时间等）带进全局配置。
   */
  function readConfigScopedMemory(root, s) {
    var qStart = timeStrToMin((root.querySelector('[data-mq-set-bg-quiet-start]') || {}).value);
    var qEnd = timeStrToMin((root.querySelector('[data-mq-set-bg-quiet-end]') || {}).value);
    var prevBg = (s && s.backgroundMessage) || {};
    var lifeLikeOn = isToggleOn(root, '#mq-set-lifelike');
    var bgPatch = {
      activeEnabled: lifeLikeOn ? false : isToggleOn(root, '#mq-set-bg-active'),
      activeIntervalMin: parseInt((root.querySelector('[data-mq-set-bg-active-min]') || {}).value, 10) || 30,
      quietEnabled: isToggleOn(root, '#mq-set-bg-quiet-en'),
      quietStartMin: Number.isFinite(qStart) ? qStart : (prevBg.quietStartMin != null ? prevBg.quietStartMin : 1380),
      quietEndMin: Number.isFinite(qEnd) ? qEnd : (prevBg.quietEndMin != null ? prevBg.quietEndMin : 420)
    };
    /* 让全局配置里保留一份完整的记忆字段，避免同一联系人只改了一个字段时，
       其它字段回落到 miyaChatGlobalSettings 的默认值（而不是使用者上次设定的值）。 */
    var out = {
      memoryCount: parseInt((root.querySelector('[data-mq-set-memory-count]') || {}).value, 10),
      summaryTrigger: parseInt((root.querySelector('[data-mq-set-summary-trigger]') || {}).value, 10),
      summaryLength: String((root.querySelector('[data-mq-set-summary-length]') || {}).value || '').trim(),
      backgroundMessage: bgPatch
    };
    if (!Number.isFinite(out.memoryCount)) out.memoryCount = s && s.memoryCount != null ? s.memoryCount : 80;
    if (!Number.isFinite(out.summaryTrigger)) out.summaryTrigger = s && s.summaryTrigger != null ? s.summaryTrigger : 0;
    if (!out.summaryLength) out.summaryLength = (s && s.summaryLength) || '100-300字';
    return out;
  }

  function renderImageGenBlock(settings) {
    var igGlobal = global.MiyaImageGen && global.MiyaImageGen.isGlobalEnabled && global.MiyaImageGen.isGlobalEnabled();
    var ig = settings.imageGen || {};
    var refNote = global.MiyaImageGen && global.MiyaImageGen.REF_LEGAL_NOTE
      ? global.MiyaImageGen.REF_LEGAL_NOTE
      : '参考图仅针对支持图片输入的模型生效。严禁上传无版权、无授权的图片信息；严禁未经他人允许上传他人肖像信息。';
    if (!igGlobal) {
      return formCard('<p class="st-form-hint">全局生图接口未启用或未配置，此处设置暂不可用。</p>');
    }
    return formCard(
      toggleRow('mq-set-ig-en', '为此联系人开启生图', '聊天与朋友圈中的文字图将生成真实图片', !!ig.enabled) +
      fieldBlock('专属生图提示词', '可留空', '<textarea class="ins-text-input ins-text-input--area" data-mq-set-ig-prompt rows="3" placeholder="例如：日系插画、柔和色调、角色外貌特征…">' + esc(ig.customPrompt || '') + '</textarea>') +
      mediaPickBlock('外观参考图', 'data-mq-set-ig-ref-preview', 'data-mq-set-ig-ref-pick', 'data-mq-set-ig-ref-reset', refNote)
    );
  }

  function readLifeLikeBackground(prevBg, root) {
    prevBg = prevBg || {};
    var lifeLikeOn = isToggleOn(root, '#mq-set-lifelike');
    var anonymousOn = isToggleOn(root, '#mq-set-anonymous');
    var bg = Object.assign({}, prevBg, { lifeLikeEnabled: lifeLikeOn, anonymousDisguiseEnabled: anonymousOn });
    if (lifeLikeOn) {
      bg.activeEnabled = false;
      bg.offlineEnabled = false;
      if (!prevBg.lifeLikeEnabledAt) bg.lifeLikeEnabledAt = Date.now();
    } else if (prevBg.lifeLikeEnabled) {
      bg.lifeLikeNextPushAt = 0;
    }
    return bg;
  }

  function fieldBlock(label, sub, inner) {
    return '<label class="mi-set-field">' +
      '<span class="ins-field-label">' + esc(label) + '</span>' +
      (sub ? '<span class="st-form-hint mi-set-field__sub">' + esc(sub) + '</span>' : '') +
      '<div class="mi-set-field__box">' + inner + '</div>' +
    '</label>';
  }

  /* 链接导入已移除：图片只通过点按预览区本地上传，此处不再渲染链接输入行。 */
  function mediaPickBlock(label, previewData, pickData, resetData, sub) {
    return fieldBlock(label, sub || '',
      '<button type="button" class="mi-bg-pick" ' + pickData + '>' +
        '<div class="mi-bg-stage mi-bg-stage--sm" ' + previewData + '><span class="mi-bg-stage__placeholder">+</span></div>' +
      '</button>' +
      '<div class="mi-img-pick-tools">' +
        '<button type="button" class="st-foot-btn" ' + resetData + '>恢复默认</button>' +
      '</div>'
    );
  }

  function renderChatWallpaperLibrary(currentBf) {
    var picker = global.MiyaChatWallpaperPicker;
    if (!picker || !picker.renderLibrary) return '';
    return picker.renderLibrary(currentBf || {}, {
      libAttr: 'data-mq-set-wall-lib',
      manageAttr: 'data-mq-set-wall-manage'
    });
  }

  function escAttr(s) {
    return esc(s).replace(/[\r\n\u2028\u2029]/g, '');
  }

  /* 链接导入已移除：头像只通过点按预览区本地上传。 */
  function compactAvatarPickCol(label, previewData, pickData, resetData) {
    return '<div class="mi-ava-row-compact__col">' +
      '<span class="mi-ava-row-compact__label">' + esc(label) + '</span>' +
      '<button type="button" class="mi-bg-pick mi-bg-pick--compact" ' + pickData + '>' +
        '<div class="mi-bg-stage mi-bg-stage--ava" ' + previewData + '><span class="mi-bg-stage__placeholder">+</span></div>' +
      '</button>' +
      '<div class="mi-ava-row-compact__tools">' +
        '<button type="button" class="st-foot-btn st-foot-btn--xs" ' + resetData + '>默认</button>' +
      '</div>' +
    '</div>';
  }

  function profileIdForCtx(c) {
    if (!c) return '';
    return String(
      c.chat.profileId || c.contact.defaultProfileId || (c.profile && c.profile.id) || ''
    ).trim();
  }

  function invalidateDisplayAvatarCache(chatId) {
    var c = ctx();
    if (global.miyaChatApp && global.miyaChatApp.invalidateChatAvatarCache && c && c.contact) {
      global.miyaChatApp.invalidateChatAvatarCache(
        chatId,
        c.contact.id,
        profileIdForCtx(c)
      );
    }
  }

  function mergeDisplayAvatars(chatId, kind, patch) {
    var c = ctx();
    if (!c || !store) return Promise.resolve();
    if (kind === 'contact') {
      if (!c.contact || typeof store.mergeContactDisplayAvatar !== 'function') return Promise.resolve();
      return store.mergeContactDisplayAvatar(c.contact.id, patch).then(function (result) {
        invalidateDisplayAvatarCache(chatId);
        refreshOpenChatRoom();
        return result;
      });
    }
    var profileId = profileIdForCtx(c);
    if (!profileId || typeof store.mergeProfileDisplayAvatar !== 'function') return Promise.resolve();
    return store.mergeProfileDisplayAvatar(profileId, patch).then(function (result) {
      invalidateDisplayAvatarCache(chatId);
      refreshOpenChatRoom();
      return result;
    });
  }

  function resetDisplayAvatar(chatId, kind) {
    var c = ctx();
    if (!c || !store) return Promise.resolve();
    if (kind === 'contact') {
      if (!c.contact || typeof store.mergeContactDisplayAvatar !== 'function') return Promise.resolve();
      return store.mergeContactDisplayAvatar(c.contact.id, { reset: true }).then(function (result) {
        invalidateDisplayAvatarCache(chatId);
        refreshOpenChatRoom();
        return result;
      });
    }
    var profileId = profileIdForCtx(c);
    if (!profileId || typeof store.mergeProfileDisplayAvatar !== 'function') return Promise.resolve();
    return store.mergeProfileDisplayAvatar(profileId, { reset: true }).then(function (result) {
      invalidateDisplayAvatarCache(chatId);
      refreshOpenChatRoom();
      return result;
    });
  }

  function refreshOpenChatRoom() {
    if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId() === state.chatId) {
      global.miyaChatRoom.refresh({ forceAvatars: true });
    }
    if (global.miyaChatApp && global.miyaChatApp.refreshLists) {
      global.miyaChatApp.refreshLists({ force: true });
    }
    if (global.MiyaChatMoments && typeof global.MiyaChatMoments.refreshFeedUI === 'function') {
      global.MiyaChatMoments.refreshFeedUI();
    }
    if (global.miyaChatApp && typeof global.miyaChatApp.refreshProfileUI === 'function') {
      global.miyaChatApp.refreshProfileUI();
    }
  }

  function applyDisplayAvatarPreview(preview, url) {
    if (!preview) return;
    var ph = preview.querySelector('.mi-bg-stage__placeholder');
    if (url) {
      preview.style.backgroundImage = 'url("' + String(url).replace(/"/g, '') + '")';
      preview.classList.add('has-image');
      if (ph) ph.hidden = true;
    } else {
      preview.style.backgroundImage = '';
      preview.classList.remove('has-image');
      if (ph) ph.hidden = false;
    }
  }

  function hydrateDisplayAvatarPicker(root, kind, entity) {
    if (!root) return;
    var preview = root.querySelector('[data-mq-set-dava-' + kind + '-preview]');
    if (!preview) return;
    var da = (entity && entity.displayAvatar) || {};
    var url = String(da.url || '').trim();
    var blobId = da.blobId ? String(da.blobId) : '';
    applyDisplayAvatarPreview(preview, '');
    if (url) applyDisplayAvatarPreview(preview, url);
    else if (blobId) {
      store.getAvatarUrl(blobId).then(function (u) {
        if (u) applyDisplayAvatarPreview(preview, u);
      });
    }
  }

  function resolveHeroAvatarUrl(kind, c, da) {
    da = da || {};
    var url = kind === 'contact' ? da.contactUrl : da.profileUrl;
    var blobId = kind === 'contact' ? da.contactBlobId : da.profileBlobId;
    if (url) return Promise.resolve(url);
    if (blobId) return store.getAvatarUrl(blobId).catch(function () { return ''; });
    if (kind === 'contact' && c.contact) {
      if (c.contact.avatar) return Promise.resolve(c.contact.avatar);
      if (c.contact.avatarBlobId) return store.getAvatarUrl(c.contact.avatarBlobId).catch(function () { return ''; });
    }
    if (kind === 'profile' && c.profile) {
      if (c.profile.avatar) return Promise.resolve(c.profile.avatar);
      if (c.profile.avatarId) return store.getAvatarUrl(c.profile.avatarId).catch(function () { return ''; });
    }
    return Promise.resolve('');
  }

  function buildLangOptions(selected) {
    var want = String(selected || 'auto');
    return LANG_OPTS.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (o.v === want ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  var NARRATION_PERSON_OPTS = [
    { v: '1', label: '第一人称（我）' },
    { v: '2', label: '第二人称（你）' },
    { v: '3', label: '第三人称（他/她/名）' }
  ];

  function buildNarrationPersonOptions(selected, fallback) {
    var want = String(selected || fallback || '3').trim();
    if (['1', '2', '3'].indexOf(want) < 0) want = String(fallback || '3');
    return NARRATION_PERSON_OPTS.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (o.v === want ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  function formatNum(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function resolveMomentsAutoDisplay(ma) {
    ma = ma || {};
    var mode = String(ma.mode || 'off').trim().toLowerCase();
    if (mode !== 'rounds' && mode !== 'hours') mode = 'off';
    return {
      mode: mode,
      rounds: mode === 'rounds' ? (parseInt(ma.roundInterval, 10) || '') : '',
      hours: mode === 'hours' ? (parseInt(ma.hourInterval, 10) || '') : ''
    };
  }

  function syncMomentsAutoModeUI(root) {
    if (!root) return;
    var mode = String((root.querySelector('[data-mq-set-moments-mode]') || {}).value || 'off').trim();
    var roundsWrap = root.querySelector('[data-mq-set-moments-rounds-wrap]');
    var hoursWrap = root.querySelector('[data-mq-set-moments-hours-wrap]');
    if (roundsWrap) roundsWrap.hidden = mode !== 'rounds';
    if (hoursWrap) hoursWrap.hidden = mode !== 'hours';
  }

  function ensureMomentsAutoIntervalDefaults(root, mode, prevMa) {
    if (!root || !mode || mode === 'off') return;
    prevMa = prevMa || {};
    if (mode === 'rounds') {
      var roundsIn = root.querySelector('[data-mq-set-moments-rounds]');
      if (!roundsIn || String(roundsIn.value || '').trim()) return;
      var prevRounds = parseInt(prevMa.roundInterval, 10);
      roundsIn.value = String(Number.isFinite(prevRounds) && prevRounds > 0 ? prevRounds : 30);
      return;
    }
    if (mode === 'hours') {
      var hoursIn = root.querySelector('[data-mq-set-moments-hours]');
      if (!hoursIn || String(hoursIn.value || '').trim()) return;
      var prevHours = parseInt(prevMa.hourInterval, 10);
      hoursIn.value = String(Number.isFinite(prevHours) && prevHours > 0 ? prevHours : 24);
    }
  }

  function readMomentsAutoFromRoot(root, prevMa) {
    prevMa = prevMa || {};
    var maModeSel = String((root.querySelector('[data-mq-set-moments-mode]') || {}).value || 'off').trim();
    var maRounds = parseInt(String((root.querySelector('[data-mq-set-moments-rounds]') || {}).value || '').trim(), 10);
    var maHours = parseInt(String((root.querySelector('[data-mq-set-moments-hours]') || {}).value || '').trim(), 10);
    var momentsAuto = {
      mode: 'off',
      roundInterval: 0,
      hourInterval: 0,
      roundAnchorEnd: prevMa.roundAnchorEnd || 0,
      enabledAt: prevMa.enabledAt || 0,
      lastMomentsAutoAt: prevMa.lastMomentsAutoAt || 0,
      lastMomentsAutoAttemptAt: prevMa.lastMomentsAutoAttemptAt || 0,
      lastFailedAt: prevMa.lastFailedAt || 0
    };
    if (maModeSel === 'rounds') {
      if (!Number.isFinite(maRounds) || maRounds <= 0) {
        maRounds = parseInt(prevMa.roundInterval, 10);
      }
      if (!Number.isFinite(maRounds) || maRounds <= 0) maRounds = 30;
      momentsAuto.mode = 'rounds';
      momentsAuto.roundInterval = Math.min(500, maRounds);
    } else if (maModeSel === 'hours') {
      if (!Number.isFinite(maHours) || maHours <= 0) {
        maHours = parseInt(prevMa.hourInterval, 10);
      }
      if (!Number.isFinite(maHours) || maHours <= 0) maHours = 24;
      momentsAuto.mode = 'hours';
      momentsAuto.hourInterval = Math.min(720, maHours);
    }
    var intervalChanged =
      String(prevMa.mode || 'off') !== momentsAuto.mode ||
      (momentsAuto.mode === 'rounds' && parseInt(prevMa.roundInterval, 10) !== momentsAuto.roundInterval) ||
      (momentsAuto.mode === 'hours' && parseInt(prevMa.hourInterval, 10) !== momentsAuto.hourInterval);
    if (momentsAuto.mode === 'off') {
      momentsAuto.enabledAt = 0;
      momentsAuto.roundAnchorEnd = 0;
      momentsAuto.lastMomentsAutoAt = 0;
      momentsAuto.lastMomentsAutoAttemptAt = 0;
      momentsAuto.lastFailedAt = 0;
    } else if (!prevMa.enabledAt || String(prevMa.mode || 'off') === 'off') {
      momentsAuto.enabledAt = Date.now();
    }
    if (intervalChanged) momentsAuto.roundAnchorEnd = 0;
    return momentsAuto;
  }


  function buildContextUsageSettings(chatId) {
    if (!store || !store.getChatSettings) return null;
    var settings = store.getChatSettings(chatId);
    if (!pageEl || !state.chatId || String(state.chatId) !== String(chatId)) {
      return settings;
    }
    var root = pageEl.querySelector('[data-mq-set-body]');
    if (!root) return settings;
    var merged = Object.assign({}, settings);
    var hvMod = global.MiyaChatHeartVoiceTemplates;
    if (hvMod && typeof hvMod.readChatPresetFromRoot === 'function') {
      var hvFromDom = hvMod.readChatPresetFromRoot(root, settings.heartVoicePreset);
      merged.heartVoicePreset = hvFromDom || String(settings.heartVoicePreset || '').trim();
      if (merged.heartVoicePreset && typeof hvMod.findPreset === 'function' && typeof hvMod.buildSnapshotFromPreset === 'function') {
        var hvSnapRow = hvMod.findPreset(merged.heartVoicePreset);
        merged.heartVoicePresetSnapshot = hvSnapRow
          ? hvMod.buildSnapshotFromPreset(hvSnapRow)
          : settings.heartVoicePresetSnapshot || null;
      } else if (!merged.heartVoicePreset) {
        merged.heartVoicePresetSnapshot = null;
      }
    }
    return merged;
  }

  function forceSummaryBreakdownFromMessages(breakdown, messages, eng) {
    var chars = 0;
    var blockCount = 0;
    var preview = '';
    (messages || []).forEach(function (m) {
      if (!m || m.role !== 'system') return;
      var t = String(m.content || '');
      if (t.indexOf('【长期记忆·对话总结】') === 0 || t.indexOf('【本群·记忆总结】') === 0) {
        chars += t.length;
        blockCount += 1;
        if (!preview) preview = t.slice(0, 240);
      }
    });
    var tokens =
      eng && typeof eng.estimateTokensFromCharCount === 'function'
        ? eng.estimateTokensFromCharCount(chars)
        : Math.max(0, Math.ceil(chars / 1.6));
    if (breakdown && Array.isArray(breakdown.grouped)) {
      breakdown.grouped = breakdown.grouped.filter(function (g) {
        return g.key !== 'summary';
      });
      if (chars > 0) {
        breakdown.grouped.push({
          key: 'summary',
          label: '对话总结记忆',
          chars: chars,
          tokens: tokens,
          count: blockCount,
          items: [
            {
              key: 'summary',
              label: '对话总结记忆',
              chars: chars,
              tokens: tokens,
              preview: preview
            }
          ]
        });
        breakdown.grouped.sort(function (a, b) {
          return (b.chars || 0) - (a.chars || 0);
        });
      }
    }
    if (breakdown && Array.isArray(breakdown.sources)) {
      breakdown.sources = breakdown.sources.filter(function (s) {
        return s.key !== 'summary';
      });
      if (chars > 0) {
        breakdown.sources.push({
          key: 'summary',
          label: '对话总结记忆',
          chars: chars,
          tokens: tokens,
          preview: preview
        });
      }
    }
    return { chars: chars, tokens: tokens, blockCount: blockCount, preview: preview };
  }

  function collectContextUsage(chatId) {
    var eng = global.miyaChatEngine;
    if (!eng || typeof eng.buildApiMessages !== 'function') {
      return { error: 'engine_missing' };
    }
    var chatRow = store && store.findChat ? store.findChat(chatId) : null;
    /* 优先显示「刚生成那一次」的真实分布快照（引擎在生成完成时写入 chat.lastPromptBreakdown）。
       只有在还没有任何生成记录时，才回落到实时预估（下一条会发什么）。 */
    var snapshot = chatRow && chatRow.lastPromptBreakdown ? chatRow.lastPromptBreakdown : null;
    if (snapshot && Array.isArray(snapshot.grouped) && snapshot.grouped.length) {
      return collectContextUsageFromSnapshot(snapshot, chatRow, eng);
    }
    return collectContextUsageLive(chatId, chatRow, eng);
  }

  /** 由引擎写入的「本轮真实发送」快照构造面板数据 */
  function collectContextUsageFromSnapshot(snapshot, chatRow, eng) {
    var grouped = snapshot.grouped.map(function (g) {
      return {
        key: g.key,
        label: g.label || g.key,
        chars: Number(g.chars) || 0,
        tokens: Number(g.tokens) || 0,
        count: Number(g.count) || 0,
        subItems: Array.isArray(g.subItems) ? g.subItems : []
      };
    });
    var totalChars = Number(snapshot.promptChars) || 0;
    if (!totalChars) {
      grouped.forEach(function (g) { totalChars += g.chars || 0; });
    }
    var totalTokens = Number(snapshot.promptTokens) || 0;
    if (!totalTokens) {
      grouped.forEach(function (g) { totalTokens += g.tokens || 0; });
    }
    var wbRow = null;
    var i;
    for (i = 0; i < grouped.length; i++) {
      if (grouped[i].key === 'worldbook') { wbRow = grouped[i]; break; }
    }
    var usage = chatRow && chatRow.lastTokenUsage ? chatRow.lastTokenUsage : null;
    var activeThinking = chatRow && chatRow.activeThinking ? String(chatRow.activeThinking).trim() : '';
    var thinkingChars = activeThinking.length;
    var thinkingTokens =
      eng && typeof eng.estimateTokensFromText === 'function'
        ? eng.estimateTokensFromText(activeThinking)
        : Math.max(0, Math.ceil(thinkingChars / 1.6));
    var completionChars = usage
      ? Number(usage.completion_chars != null ? usage.completion_chars : usage.completion_tokens) || 0
      : 0;
    var completionTokens =
      eng && typeof eng.estimateTokensFromCharCount === 'function'
        ? eng.estimateTokensFromCharCount(completionChars)
        : Math.max(0, Math.ceil(completionChars / 1.6));
    return {
      fromSnapshot: true,
      snapshotAt: Number(snapshot.updatedAt) || 0,
      estimatedTokens: totalTokens,
      totalChars: totalChars,
      systemChars: 0,
      historyChars: 0,
      worldbookChars: wbRow ? wbRow.chars : 0,
      worldbookCount: Number(snapshot.worldbookMatched) || 0,
      /* 快照模式同样透出候选数：引擎写 lastPromptBreakdown 时已带上
         worldbookConsidered（ST 裁决前的候选总数）。没有它，回看「上次发送」
         时只有一个孤零零的命中数，分不清是没匹配上还是被裁掉了。 */
      worldbookConsidered: Number(snapshot.worldbookConsidered) || Number(snapshot.worldbookMatched) || 0,
      worldbookInSystem: snapshot.worldbookInSystem !== false,
      worldbookEmptyMatched: 0,
      /* 快照里也带上「被预算裁掉几条」，否则快照模式同样只会报一个孤零零的
         命中数，用户仍无法分辨「没匹配上」和「匹配了但被裁了」。 */
      worldbookDropped: Number(snapshot.worldbookDropped) || 0,
      entries: [],
      totalInStore:
        global.miyaWorldbookStore && typeof global.miyaWorldbookStore.listEntries === 'function'
          ? global.miyaWorldbookStore.listEntries().length
          : 0,
      roleIds: [],
      breakdown: { grouped: grouped, sources: [], promptChars: totalChars, promptTokens: totalTokens },
      summaryInject: null,
      lastTokenUsage: usage,
      activeThinking: activeThinking,
      thinkingChars: thinkingChars,
      thinkingTokens: thinkingTokens,
      completionChars: completionChars,
      completionTokens: completionTokens,
      messageCount: grouped.reduce(function (n, g) { return n + (g.count || 0); }, 0)
    };
  }

  function collectContextUsageLive(chatId, chatRow, eng) {
    var usageSettings = buildContextUsageSettings(chatId);
    var built = eng.buildApiMessages(chatId, '', {
      chatSettings: usageSettings || undefined
    });
    if (!built || built.error) {
      return { error: (built && built.error) || 'build_failed' };
    }
    var pm = built.promptMeta || {};
    var wb = built.worldbookMeta || {};
    var entries = Array.isArray(wb.matchedSummary) ? wb.matchedSummary : [];
    var wbStore = global.miyaWorldbookStore;
    var totalInStore = wbStore && typeof wbStore.listEntries === 'function'
      ? wbStore.listEntries().length
      : 0;
    var breakdown =
      typeof eng.buildPromptSourceBreakdown === 'function'
        ? eng.buildPromptSourceBreakdown(built.messages, wb)
        : null;
    /* 对话总结记忆：只认实际注入的 system 块，禁止分类误伤导致虚高 */
    var summaryMeasured = forceSummaryBreakdownFromMessages(breakdown, built.messages, eng);
    var lastUsage = chatRow && chatRow.lastTokenUsage ? chatRow.lastTokenUsage : null;
    var activeThinking = chatRow && chatRow.activeThinking ? String(chatRow.activeThinking).trim() : '';
    var thinkingChars = activeThinking.length;
    var thinkingTokens =
      eng && typeof eng.estimateTokensFromText === 'function'
        ? eng.estimateTokensFromText(activeThinking)
        : Math.max(0, Math.ceil(thinkingChars / 1.6));
    var completionChars = lastUsage
      ? Number(lastUsage.completion_chars != null ? lastUsage.completion_chars : lastUsage.completion_tokens) || 0
      : 0;
    var completionTokens =
      eng && typeof eng.estimateTokensFromCharCount === 'function'
        ? eng.estimateTokensFromCharCount(completionChars)
        : Math.max(0, Math.ceil(completionChars / 1.6));
    var summaryInject = null;
    var sumMod = global.MiyaChatSummary;
    if (sumMod && typeof sumMod.inspectSummaryInjection === 'function') {
      summaryInject = sumMod.inspectSummaryInjection(usageSettings);
    }
    if (summaryInject && summaryMeasured) {
      summaryInject.actualInjectedChars = summaryMeasured.chars;
      summaryInject.actualInjectedTokens = summaryMeasured.tokens;
      summaryInject.actualBlockCount = summaryMeasured.blockCount;
      summaryInject.actualPreview = summaryMeasured.preview;
    }
    return {
      fromSnapshot: false,
      snapshotAt: 0,
      estimatedTokens: pm.estimated_prompt_tokens || (breakdown && breakdown.promptTokens) || 0,
      totalChars: pm.total_prompt_chars || (breakdown && breakdown.promptChars) || 0,
      systemChars: pm.system_chars || 0,
      historyChars: pm.history_chars || 0,
      worldbookChars: pm.worldbook_chars || 0,
      worldbookCount: pm.worldbook_matched || entries.length || 0,
      worldbookInSystem: pm.worldbook_in_system !== false,
      worldbookEmptyMatched: pm.worldbook_empty_matched || 0,
      worldbookDropped: pm.worldbook_dropped || 0,
      worldbookConsidered: pm.worldbook_considered || 0,
      entries: entries,
      totalInStore: totalInStore,
      roleIds: Array.isArray(wb.roleIds) ? wb.roleIds : [],
      breakdown: breakdown,
      summaryInject: summaryInject,
      lastTokenUsage: lastUsage,
      activeThinking: activeThinking,
      thinkingChars: thinkingChars,
      thinkingTokens: thinkingTokens,
      completionChars: completionChars,
      completionTokens: completionTokens,
      messageCount: pm.message_count || 0
    };
  }

  function ensureContextUsageDeps() {
    if (global.miyaBootstrapKvStores) {
      return global.miyaBootstrapKvStores();
    }
    var chain = Promise.resolve();
    var wb = global.miyaWorldbookStore;
    var cs = global.miyaContactsStore;
    if (wb && typeof wb.whenReady === 'function') {
      chain = chain.then(function () { return wb.whenReady(); });
    }
    if (cs && typeof cs.whenReady === 'function') {
      chain = chain.then(function () { return cs.whenReady(); });
    }
    return chain;
  }

  function contextUsageErrorText(code) {
    if (code === 'engine_missing') return '对话引擎未就绪';
    if (code === 'chat_not_found') return '会话不存在';
    if (code === 'contact_not_found') return '联系人不存在';
    if (code === 'profile_missing') return '请先选择面具';
    return '无法计算上下文用量';
  }

  /* 来源分布行：左侧来源名 + 右侧数值，底部一条按占比伸缩的条形。
     totalChars 用于换算百分比；为 0 时条形退化为空，不会出现 NaN 宽度。 */
  /** 快照时间：今天只显示时分，跨天带日期 */
  function formatCtxTime(ts) {
    var t = Number(ts) || 0;
    if (t <= 0) return '';
    var d = new Date(t);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return '今天 ' + hm;
    }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function renderContextSourceRow(label, chars, tokens, sub, pct, subItems, rowKey) {
    var hasPct = typeof pct === 'number' && isFinite(pct) && pct > 0;
    var barPct = hasPct ? Math.max(pct, 1.2) : 0;   /* 极小占比也留一丝可见宽度 */
    var kids = Array.isArray(subItems) ? subItems : [];
    var hasKids = kids.length > 0;
    var kidsId = 'mi-ctx-src-kids-' + (ctxSrcKidSeq++);
    var keyAttr = rowKey ? esc(rowKey) : '';
    var isOpen = !!(rowKey && ctxOpenSrcRows[rowKey]);
    /* 子项占比按「父项字数」为分母：这样点开看到的是这一组内部的构成 */
    var kidTotal = kids.reduce(function (n, k) { return n + (Number(k.chars) || 0); }, 0);
    var kidRows = hasKids
      ? '<div class="mi-ctx-src-kids" id="' + kidsId + '"' + (isOpen ? '' : ' hidden') + '>' +
          kids.map(function (k) {
            var kPct = kidTotal > 0 ? (Number(k.chars) || 0) / kidTotal * 100 : 0;
            return '<div class="mi-ctx-src-kid">' +
              '<span class="mi-ctx-src-kid__bar"><i style="width:' + Math.max(kPct, 0.6).toFixed(2) + '%"></i></span>' +
              '<span class="mi-ctx-src-kid__name">' + esc(k.name || '未命名') +
                ((Number(k.count) || 1) > 1 ? '<em>×' + k.count + '</em>' : '') +
              '</span>' +
              '<span class="mi-ctx-src-kid__val">' + esc(formatNum(k.chars)) + ' 字' +
                '<i>' + kPct.toFixed(1) + '%</i>' +
              '</span>' +
            '</div>';
          }).join('') +
        '</div>'
      : '';
    var caret = hasKids
      ? '<button type="button" class="mi-ctx-src-row__caret" data-mq-set-ctx-kids="' + kidsId + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-label="展开具体条目">' +
          '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>'
      : '';
    return '<div class="mi-ctx-src-row' + (hasPct ? '' : ' mi-ctx-src-row--plain') +
        (hasKids ? ' mi-ctx-src-row--foldable' : '') + (isOpen ? ' is-open' : '') + '"' +
        (keyAttr ? ' data-mq-set-ctx-row="' + keyAttr + '"' : '') + '>' +
      '<div class="mi-ctx-src-row__top">' +
        '<span class="mi-ctx-src-row__label">' + esc(label) +
          (sub ? '<span class="mi-ctx-src-row__sub">' + esc(sub) + '</span>' : '') +
        '</span>' +
        '<span class="mi-ctx-src-row__val">' +
          (hasPct ? '<span class="mi-ctx-src-row__pct">' + pct.toFixed(1) + '%</span>' : '') +
          esc(formatNum(chars)) + ' 字' +
          '<span class="mi-ctx-src-row__tok">≈ ' + esc(formatNum(tokens)) + ' tok</span>' +
          caret +
        '</span>' +
      '</div>' +
      (hasPct
        ? '<div class="mi-ctx-src-row__bar"><i style="width:' + barPct.toFixed(2) + '%"></i></div>'
        : '') +
      kidRows +
    '</div>';
  }

  /* 子项折叠容器的 id 序号，保证同一面板内唯一 */
  var ctxSrcKidSeq = 1;

  function renderWorldbookEntryList(entries) {
    if (!entries || !entries.length) {
      return '<p class="mi-empty-hint mi-empty-hint--inline">当前无命中条目</p>';
    }
    return '<ul class="mi-ctx-wb__list">' +
      entries.map(function (e) {
        var tag = e.scope && e.scope !== 'global' ? ' · ' + e.scope : '';
        return '<li class="mi-ctx-wb__item">' +
          esc(e.name || '未命名') + tag +
          ' <span class="mi-ctx-wb__tag">' + esc(formatNum(e.charCount || 0)) + ' 字</span>' +
        '</li>';
      }).join('') +
    '</ul>';
  }

  function renderContextUsageDetailPop(snapshot, open) {
    var grouped = snapshot.breakdown && Array.isArray(snapshot.breakdown.grouped)
      ? snapshot.breakdown.grouped
      : [];
    var totalForPct = Number(snapshot.totalChars) || 0;
    var promptRows = grouped.map(function (g) {
      var sub = g.count > 1 ? '×' + g.count : '';
      if (g.key === 'summary' && snapshot.summaryInject) {
        var si = snapshot.summaryInject;
        var actualChars = si.actualInjectedChars != null ? si.actualInjectedChars : si.contentChars;
        sub =
          '实际注入 ' +
          formatNum(actualChars || 0) +
          ' 字 · 合卷 ' +
          (si.megaInjected || 0) +
          '（' +
          formatNum(si.megaChars || 0) +
          '字）· 分镜 ' +
          (si.shotInjected || 0) +
          (si.shotSkipped ? '（跳过已并入 ' + si.shotSkipped + '）' : '');
      }
      var pct = totalForPct > 0 ? (Number(g.chars) || 0) / totalForPct * 100 : 0;
      return renderContextSourceRow(g.label, g.chars, g.tokens, sub, pct, g.subItems, g.key);
    }).join('');

    var roundRows = '';
    var roundTotal = (Number(snapshot.completionChars) || 0) + (Number(snapshot.thinkingChars) || 0);
    if (snapshot.completionChars > 0) {
      roundRows += renderContextSourceRow(
        '上轮模型完整回复（API 返回原文）',
        snapshot.completionChars,
        snapshot.completionTokens,
        '含思维链/正文/心声标签',
        roundTotal > 0 ? snapshot.completionChars / roundTotal * 100 : 0
      );
    }
    if (snapshot.thinkingChars > 0) {
      roundRows += renderContextSourceRow(
        '思维链',
        snapshot.thinkingChars,
        snapshot.thinkingTokens,
        '',
        roundTotal > 0 ? snapshot.thinkingChars / roundTotal * 100 : 0
      );
    }
    if (!roundRows) {
      roundRows = '<p class="mi-empty-hint mi-empty-hint--inline">尚无上一轮回复记录，发送一条消息后更新</p>';
    }

    /* 世界书漏斗口径：库内 N → 候选 M（matcher 判定应当注入）→ 命中 K（实际注入）。
       差额三处来源必须逐项说破，否则对着一个孤零零的 K 只能瞎猜：
       ① 候选之前的差额 = scope 过滤 / 关键词未命中（条目根本没进候选池）；
       ② 预算裁剪（dropped，主链路默认不裁，显式配置才会出现）；
       ③ 概率掷骰 / 分组互斥（ST 装饰阶段，此前完全无提示 —— 又一个
          「悄悄丢东西不出声」的关卡，本次一并透出）。 */
    var wbMatchedN = Number(snapshot.worldbookCount) || 0;
    var wbConsideredN = Number(snapshot.worldbookConsidered) || wbMatchedN;
    var wbDroppedN = Number(snapshot.worldbookDropped) || 0;
    var wbStCutN = Math.max(0, wbConsideredN - wbMatchedN - wbDroppedN);
    var wbCutParts = [];
    if (wbDroppedN > 0) {
      wbCutParts.push('另有 ' + esc(formatNum(wbDroppedN)) + ' 条因预算被裁剪');
    }
    if (wbStCutN > 0) {
      wbCutParts.push('另有 ' + esc(formatNum(wbStCutN)) + ' 条经概率/分组未注入');
    }
    var wbNote = snapshot.worldbookInSystem === false
      ? '<p class="mi-ctx-inject mi-ctx-inject--warn">世界书文本可能未完全写入系统提示，请检查绑定与关键词。</p>'
      : (wbMatchedN > 0
        ? '<p class="mi-ctx-inject mi-ctx-inject--ok">世界书已注入系统提示 · 命中 ' +
          esc(formatNum(wbMatchedN)) + ' / 库内 ' + esc(formatNum(snapshot.totalInStore)) + ' 条' +
          (wbConsideredN > wbMatchedN || wbCutParts.length
            ? '（候选 ' + esc(formatNum(wbConsideredN)) + ' 条' +
              (wbCutParts.length ? '，' + wbCutParts.join('，') : '') + '）'
            : '') + '</p>'
        : '<p class="mi-ctx-inject">库内共 ' + esc(formatNum(snapshot.totalInStore)) + ' 条，当前上下文未命中世界书。</p>');

    return '<div class="mi-ctx-detail-pop' + (open ? ' is-open' : '') + '" data-mq-set-ctx-pop aria-hidden="' + (open ? 'false' : 'true') + '">' +
      '<div class="mi-ctx-detail-pop__sheet" role="region" aria-label="Token 来源明细">' +
        '<header class="mi-ctx-detail-pop__head">' +
          '<h3 class="mi-ctx-detail-pop__title">Token 来源明细</h3>' +
        '</header>' +
        '<div class="mi-ctx-detail-pop__body">' +
          '<section class="mi-ctx-detail__section">' +
            '<h4 class="mi-ctx-detail__heading">' + (snapshot.fromSnapshot
              ? '刚生成那次 · Prompt 注入' +
                (snapshot.snapshotAt ? '（' + esc(formatCtxTime(snapshot.snapshotAt)) + '）' : '')
              : '下次请求 · Prompt 注入（' + esc(formatNum(snapshot.messageCount || 0)) + ' 条 message）') + '</h4>' +
            '<p class="mi-ctx-detail__hint">' + (snapshot.fromSnapshot
              ? '这是上一条消息真实发往 API 时的上下文构成快照，按来源字符数从多到少排列，条形长度即占比。Token 为本地粗算（中文约 1.6 字/token，与 API 账单可能略有出入）。'
              : '以下为当前设置下，下一条消息将发往 API 的上下文构成（还没有生成记录，先给预估）。字符数按实际 request body 统计；Token 为本地粗算（中文约 1.6 字/token，与 API 账单可能略有出入）。') + '</p>' +
              (snapshot.summaryInject
              ? '<p class="mi-ctx-inject' +
                ((snapshot.summaryInject.actualInjectedChars || snapshot.summaryInject.contentChars || 0) > 5000
                  ? ' mi-ctx-inject--warn'
                  : snapshot.summaryInject.megaInjected > 0 && !snapshot.summaryInject.shotInjected
                    ? ' mi-ctx-inject--ok'
                    : '') +
                '">总结块实测：' +
                esc(formatNum(snapshot.summaryInject.actualInjectedChars != null
                  ? snapshot.summaryInject.actualInjectedChars
                  : snapshot.summaryInject.contentChars)) +
                ' 字 ≈ ' +
                esc(formatNum(snapshot.summaryInject.actualInjectedTokens != null
                  ? snapshot.summaryInject.actualInjectedTokens
                  : Math.ceil((snapshot.summaryInject.contentChars || 0) / 1.6))) +
                ' tok · 合卷 ' +
                esc(formatNum(snapshot.summaryInject.megaInjected)) +
                '（' +
                esc(formatNum(snapshot.summaryInject.megaChars || 0)) +
                '字）/ 分镜 ' +
                esc(formatNum(snapshot.summaryInject.shotInjected)) +
                '（跳过 ' +
                esc(formatNum(snapshot.summaryInject.shotSkipped)) +
                '）</p>'
              : '') +
            '<div class="mi-ctx-src-list">' + (promptRows || '<p class="mi-empty-hint mi-empty-hint--inline">无数据</p>') + '</div>' +
          '</section>' +
          '<section class="mi-ctx-detail__section">' +
            '<h4 class="mi-ctx-detail__heading">世界书命中条目</h4>' +
            wbNote +
            (snapshot.fromSnapshot
              ? '<p class="mi-empty-hint mi-empty-hint--inline">快照模式只记录命中数量（' +
                esc(formatNum(snapshot.worldbookCount)) + ' 条），条目清单请以世界书页为准</p>'
              : renderWorldbookEntryList(snapshot.entries)) +
          '</section>' +
          '<section class="mi-ctx-detail__section">' +
            '<h4 class="mi-ctx-detail__heading">上一轮 · 模型回复消耗</h4>' +
            '<div class="mi-ctx-src-list">' + roundRows + '</div>' +
          '</section>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderContextUsageBody(snapshot, detailOpen) {
    if (!snapshot || snapshot.error) {
      return '<p class="mi-empty-hint">' + esc(contextUsageErrorText(snapshot && snapshot.error)) + '</p>';
    }
    var open = !!detailOpen;
    var injectNote = snapshot.worldbookCount > 0
      ? '世界书命中 ' + formatNum(snapshot.worldbookCount) + ' 条'
      : '世界书未命中';
    var timeNote = snapshot.fromSnapshot && snapshot.snapshotAt
      ? ' · ' + formatCtxTime(snapshot.snapshotAt)
      : ' · 预估';
    return '<div class="mi-ctx-panel" data-mq-set-ctx-panel>' +
      '<button type="button" class="mi-ctx-stats mi-ctx-stats--clickable" data-mq-set-ctx-toggle aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<div class="mi-ctx-stat mi-ctx-stat--main">' +
          '<span class="mi-ctx-stat__label">' + (snapshot.fromSnapshot ? '上次发送' : 'Prompt 注入') + '</span>' +
          '<strong class="mi-ctx-stat__val">' + esc(formatNum(snapshot.totalChars)) + '<span class="mi-ctx-stat__unit"> 字</span></strong>' +
        '</div>' +
        '<p class="mi-ctx-stat__sub">≈ ' + esc(formatNum(snapshot.estimatedTokens)) + ' token · ' + esc(injectNote) + timeNote + '</p>' +
        '<p class="mi-ctx-stat__note">' + (open ? '再次点击收起明细' : '点击查看 Token 来源分区') + '</p>' +
      '</button>' +
      renderContextUsageDetailPop(snapshot, open) +
    '</div>';
  }

  function isContextUsageDetailOpen() {
    if (!pageEl) return false;
    var pop = pageEl.querySelector('[data-mq-set-ctx-pop]');
    return !!(pop && pop.classList.contains('is-open'));
  }

  function refreshContextUsagePanel() {
    if (!pageEl || !state.chatId) return;
    var box = pageEl.querySelector('[data-mq-set-ctx-usage]');
    if (!box) return;
    var detailOpen = isContextUsageDetailOpen();
    box.innerHTML = '<p class="mi-empty-hint">正在计算…</p>';
    var chatId = state.chatId;
    /* 依赖就绪后直接计算。原实现在此处引用了从未定义的 opMod（严格模式下抛
       ReferenceError），再被 catch 吞掉并显示「世界书加载失败，请刷新后重试」——
       这是本面板长期不可用的真正原因。依赖加载已由 ensureContextUsageDeps 覆盖。 */
    ensureContextUsageDeps().then(function () {
      if (!state.chatId || String(state.chatId) !== String(chatId)) return;
      var snap = collectContextUsage(chatId);
      box.innerHTML = renderContextUsageBody(snap, detailOpen);
    }).catch(function () {
      if (!pageEl || String(state.chatId) !== String(chatId)) return;
      box.innerHTML = '<p class="mi-empty-hint">上下文用量计算失败，请刷新后重试</p>';
    });
  }

  function scheduleContextUsageRefresh() {
    var gen = ++ctxUsageGen;
    var run = function () {
      if (gen !== ctxUsageGen) return;
      refreshContextUsagePanel();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 1600 });
    } else {
      setTimeout(run, 48);
    }
  }

  function toggleContextUsageDetail(forceClose) {
    if (!pageEl) return;
    var pop = pageEl.querySelector('[data-mq-set-ctx-pop]');
    var toggle = pageEl.querySelector('[data-mq-set-ctx-toggle]');
    if (!pop) return;
    var nextOpen = forceClose ? false : !pop.classList.contains('is-open');
    pop.classList.toggle('is-open', nextOpen);
    pop.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
    if (toggle) toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    var note = pageEl.querySelector('.mi-ctx-stat__note');
    if (note) {
      note.textContent = nextOpen ? '再次点击收起明细' : '点击查看 Token 来源分区';
    }
  }

  function countVisibleMessages(chatId) {
    if (!store || !chatId || !store.getRecentVisibleMessages) {
      return store && store.getMessages
        ? store.getMessages(chatId).length
        : 0;
    }
    return store.getRecentVisibleMessages(chatId, 1).total || 0;
  }

  function renderPage() {
    var c = ctx();
    if (!c || !c.contact) return '<div class="mi-empty-hint">会话不存在</div>';

    var s = c.settings;
    var contact = c.contact;
    var wa = s.weatherAwareness || {};
    var ta = s.timeAwareness || {};
    var name = contact.remarkName || contact.name || '未命名';
    var msgCount = countVisibleMessages(state.chatId);

    var maskOpts = c.profiles.map(function (p) {
      var sel = (c.chat.profileId || contact.defaultProfileId || '') === p.id;
      return '<option value="' + esc(p.id) + '"' + (sel ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');

    var roleWallet = store.getContactWallet ? store.getContactWallet(contact.id) : { balance: 0 };
    var roleBalFmt = global.MiyaChatWallet && global.MiyaChatWallet.formatDisplay
      ? global.MiyaChatWallet.formatDisplay(roleWallet.balance)
      : ('¥' + (Number(roleWallet.balance) || 0));
    var dynAv = s.dynamicAvatar || {};

    return '<div class="st-container mi-set-flow">' +
      '<div class="st-deco-ornament" style="top: 80px; right: -20px;">§</div>' +
      '<div class="st-deco-ornament" style="bottom: 280px; left: -40px; font-size: 100px;">¶</div>' +

      /*
       * API 两项各自独立成栏（与其它折叠栏同外观），仍排在最上方。
       * 点击进入页内子视图 —— 不再是跳去桌面设置 App（那个入口已删除）。
       *
       * 生图已从本页移除：它有自己的独立全屏页，桌面上的「生图」图标即入口，
       * 两边读写本来就是同一份配置，在这里再放一个二级入口只是重复。
       * 联系人级的生图开关仍在「朋友圈与生图」分区里，不受影响。
       */
      renderApiNavBar('api-chat', '对话 API', '对话模型服务端点与密钥', 'api-chat') +
      renderApiNavBar('api-voice', '语音合成', '语音合成服务端点与密钥', 'api-voice') +

      renderZone('basic', '基础', '身份、头像、通知与主动消息',
        subBlock('身份与显示', '', formCard(
          fieldBlock('用哪张面具', '和 Ta 聊天时你是谁', '<select class="ins-select" data-mq-set-mask>' + maskOpts + '</select>') +
          fieldBlock('备注名', '列表和顶栏显示的名字', '<input type="text" class="ins-text-input" data-mq-set-remark value="' + esc(contact.remarkName || '') + '" placeholder="' + esc(contact.name) + '">') +
          fieldBlock('关系', '会写进对话上下文', '<input type="text" class="ins-text-input" data-mq-set-rel value="' + esc(s.relationship || contact.relationship || '') + '" placeholder="朋友 / 恋人 / …">')
        )) +
        subBlock('聊天头像', '全局生效：单聊、群聊、通知；档案头像不受影响', formCard(
          '<div class="mi-ava-row-compact">' +
            compactAvatarPickCol('Ta',
              'data-mq-set-dava-contact-preview',
              'data-mq-set-dava-contact-pick',
              'data-mq-set-dava-contact-reset') +
            compactAvatarPickCol('我',
              'data-mq-set-dava-profile-preview',
              'data-mq-set-dava-profile-pick',
              'data-mq-set-dava-profile-reset') +
          '</div>' +
          toggleRow('mq-set-dava-char', 'Ta 可自主换头像', '喜欢你的照片时可换成聊天头像；Ta 知道自己当前头像内容', !!dynAv.charEnabled) +
          toggleRow('mq-set-dava-user', 'Ta 可给你换头像', '可换成你相册里已同步的照片，仅聊天窗口', !!dynAv.userEnabled)
        )) +
        subBlock('通知', '仅影响弹窗提醒', formCard(
          toggleRow(
            'mq-set-mute-notify',
            '消息免打扰',
            '开启后将不会收到该角色的消息弹窗通知，但不影响发消息与对话响应',
            !!s.muteNotifications
          )
        )) +
        subBlock('主动消息', '由角色自行判断何时联系你', renderLifeLikeSection(s))
      ) +

      /* 「记忆与后台」：原先散落在「我的」页齿轮面板（miya-st-panel-contact-chat）里的
         上下文条数 / 自动总结触发 / 定时主动消息 / 静默时段，现并入聊天设置，
         让「聊天设置」名副其实。命名与群设置的 memory 分区保持一致。 */
      renderZone('memory', '记忆与后台', '上下文、自动总结与定时主动消息',
        renderMemoryZoneSection(s)
      ) +

      /* 「模型高级」：时间感知 + Token 用量，与群设置的 model 分区命名对齐。
         原先这里只有一个只读的「Token 来源分布」，时间感知在单聊里根本改不了。 */
      renderZone('model', '模型高级', '时间感知与 Token 用量',
        subBlock('运转', '', formCard(
          toggleRow('mq-set-time-en', '时间感知', '让角色知道当前日期与时段，与「天气感知」相互独立', !!ta.enabled)
        )) +
        subBlock('Token 来源分布', '这次正文的上下文来自哪 · 谁占最多，按字符数从多到少排列', formCard(
          '<div class="mi-ctx-usage" data-mq-set-ctx-usage><p class="mi-empty-hint">正在计算…</p></div>'
        ))
      ) +

      renderZone('look', '外观与背景', '壁纸、CSS 主题与预设',
        subBlock('聊天背景', '', formCard(
          mediaPickBlock('聊天背景',
            'data-mq-set-bg-preview',
            'data-mq-set-bg-pick',
            'data-mq-set-bg-reset') +
          renderChatWallpaperLibrary(c.settings.chatBeautify || {})
        )) +
        subBlock('聊天样式', 'CSS 主题与预设', formCard(
          (global.MiyaChatBeautify ? global.MiyaChatBeautify.buildChatSettingsBeautifyHtml(s.chatBeautify) : '')
        , 'mi-set-bf-card'))
      ) +

      renderZone('dialogue', '对话表现', '回复条数、翻译、语音、旁白与心声模版',
        subBlock('回复与翻译', '', formCard(
          fieldBlock('消息渲染条数', '进入聊天时加载最近多少条，数值越大越慢', '<input type="number" class="ins-text-input" data-mq-set-render-limit min="20" max="500" value="' + esc(s.messageRenderLimit || 100) + '">') +
          fieldBlock('角色回复条数', '', '<div class="mi-inline-nums">' +
            '<input type="number" class="ins-text-input mi-input--xs" data-mq-set-bubble-min min="1" max="15" value="' + esc(s.roleReplyBubbleMin || 1) + '">' +
            '<span class="mi-inline-nums__sep">~</span>' +
            '<input type="number" class="ins-text-input mi-input--xs" data-mq-set-bubble-max min="1" max="15" value="' + esc(s.roleReplyBubbleMax || 5) + '">' +
          '</div>') +
          (function () {
            var transOn = !!s.autoTranslate;
            return toggleRow(
              'mq-set-trans',
              '自动翻译',
              '同一轮随 API 输出意译译文',
              transOn
            ) +
            '<div class="mi-trans-extra"' + (transOn ? '' : ' hidden') + ' data-mq-set-trans-extra">' +
            fieldBlock('译文语言', '支持普通话、粤语、繁体、吴语等', '<select class="ins-select" data-mq-set-trans-target>' +
              (global.MiyaChatTranslate && global.MiyaChatTranslate.buildTargetOptionsHtml
                ? global.MiyaChatTranslate.buildTargetOptionsHtml(s.translateTarget)
                : '<option value="zh-CN" selected>中文（普通话）</option>') +
            '</select>') +
            toggleRow('mq-set-moments-trans', '朋友圈翻译', '角色发朋友圈时附带意译译文', !!s.momentsTranslate) +
            '</div>';
          })() +
          toggleRow('mq-set-tts-en', '语音朗读', 'MiniMax TTS', !!String(s.minimaxVoiceId || '').trim()) +
          fieldBlock('音色 ID', '', '<input type="text" class="ins-text-input" data-mq-set-voice-id value="' + esc(s.minimaxVoiceId || '') + '">') +
          fieldBlock('语言', '', '<select class="ins-select" data-mq-set-lang>' + buildLangOptions(s.minimaxLanguageBoost) + '</select>')
        )) +
        subBlock('线上旁白', '与回复条数无关', formCard(
          toggleRow('mq-set-online-narration', '启用线上旁白', '角色回复中穿插旁白-…动作/神态描写，以居中灰字展示', !!s.onlineNarrationEnabled) +
          toggleRow('mq-set-online-narration-ctx', '旁白注入上下文', '角色旁白是否写入模型上下文；用户旁白始终注入', s.onlineNarrationInjectContext !== false) +
          fieldBlock('称呼角色人称', '旁白里如何称呼 char', '<select class="ins-select" data-mq-set-narration-char-person>' +
            buildNarrationPersonOptions(s.onlineNarrationCharPerson, '3') +
          '</select>') +
          fieldBlock('称呼用户人称', '旁白里如何称呼 user', '<select class="ins-select" data-mq-set-narration-user-person>' +
            buildNarrationPersonOptions(s.onlineNarrationUserPerson, '2') +
          '</select>')
        )) +
        subBlock('心声模版', '在「装扮与表情 → 自定义心声」里先保存预设，再在此选用', formCard(
          (global.MiyaChatHeartVoiceTemplates
            ? global.MiyaChatHeartVoiceTemplates.buildChatSettingsPickerHtml(s.heartVoicePreset)
            : '<p class="st-form-hint">心声模版模块未加载，请刷新页面</p>')
        ))
      ) +

      renderZone('sense', '感知与绑定', '天气、表情包与世界书',
        subBlock('天气', '虚拟地点映射现实天气', formCard(
          toggleRow('mq-set-weather-en', '天气感知', '按映射地点查询真实天气', !!wa.enabled) +
          fieldBlock('我的虚拟地点', '故事里的位置', '<input type="text" class="ins-text-input" data-mq-set-vplace-user value="' + esc(wa.placeUser || '') + '" placeholder="如：云城">') +
          fieldBlock('映射现实地点', '用来查天气', '<input type="text" class="ins-text-input" data-mq-set-rloc-user value="' + esc(wa.realLocUser || '') + '" placeholder="如：上海">') +
          fieldBlock('Ta 的虚拟地点', '故事里的位置', '<input type="text" class="ins-text-input" data-mq-set-vplace-role value="' + esc(wa.placeRole || '') + '" placeholder="如：旧都">') +
          fieldBlock('映射现实地点', '用来查天气', '<input type="text" class="ins-text-input" data-mq-set-rloc-role value="' + esc(wa.realLocRole || '') + '" placeholder="如：东京">') +
          (wa.weatherTextUser ? '<p class="mi-pill-note">我这边 · ' + esc(wa.weatherTextUser) + '</p>' : '') +
          (wa.weatherTextRole ? '<p class="mi-pill-note">Ta 那边 · ' + esc(wa.weatherTextRole) + '</p>' : '') +
          '<p class="st-form-hint">天气 App 与这里是两套数据。点「同步天气 App」会填入 App 里的位置并自动感知拉取天气；仍可手改后再点「感知」刷新。</p>' +
          '<div class="mi-btn-row">' +
            '<button type="button" class="st-action-btn" data-mq-set-weather-sync-app>同步天气 App</button>' +
            '<button type="button" class="st-action-btn st-action-btn--primary" data-mq-set-weather-sense>感知</button>' +
          '</div>'
        )) +
        subBlock('表情包', '绑定后该角色在对话中可发', formCard(
          '<p class="st-form-hint">打开「使用全部分组」，或关闭后在下方为角色指定可用分组</p>' +
          (function () {
            var bound = Array.isArray(contact.emojiGroupIds) ? contact.emojiGroupIds : [];
            var useAllEmo = !bound.length;
            var hasCustom = bound.length > 0;
            return toggleRow('mq-set-emo-all', '使用全部分组', '开启后该角色可使用所有表情分组', useAllEmo) +
              '<div class="mi-emo-bind-list" data-mq-set-emo-list>' +
              store.getEmojiGroups().map(function (g) {
                var on = hasCustom && bound.indexOf(g.id) >= 0;
                return emoGroupToggleRow(g.id, g.name, on, !hasCustom);
              }).join('') +
              '</div>';
          })()
        )) +
        subBlock('', '', renderWorldbookSortSection(contact))
      ) +

      renderZone('content', '朋友圈与生图', '自动发动态与文字配图',
        subBlock('朋友圈', '', formCard(
          fieldBlock(
            '自动发动态',
            '二选一：按对话轮数，或距上次发朋友圈的小时数',
            '<select class="ins-select" data-mq-set-moments-mode>' +
              (function () {
                var md = resolveMomentsAutoDisplay(s.momentsAuto);
                return '<option value="off"' + (md.mode === 'off' ? ' selected' : '') + '>关闭</option>' +
                  '<option value="rounds"' + (md.mode === 'rounds' ? ' selected' : '') + '>每 N 轮对话</option>' +
                  '<option value="hours"' + (md.mode === 'hours' ? ' selected' : '') + '>每 N 小时</option>';
              })() +
            '</select>' +
            '<div class="mi-moments-auto-fields">' +
              (function () {
                var md = resolveMomentsAutoDisplay(s.momentsAuto);
                return '<div class="mi-inline-nums" data-mq-set-moments-rounds-wrap' + (md.mode !== 'rounds' ? ' hidden' : '') + '>' +
                    '每 <input type="number" class="ins-text-input mi-input--xs" data-mq-set-moments-rounds min="1" max="500" placeholder="轮数" value="' + esc(md.rounds) + '"> 轮对话自动发一次' +
                  '</div>' +
                  '<div class="mi-inline-nums" data-mq-set-moments-hours-wrap' + (md.mode !== 'hours' ? ' hidden' : '') + '>' +
                    '每 <input type="number" class="ins-text-input mi-input--xs" data-mq-set-moments-hours min="1" max="720" placeholder="小时" value="' + esc(md.hours) + '"> 小时自动发一次' +
                  '</div>';
              })() +
            '</div>'
          )
        )) +
        subBlock('生图', (global.MiyaImageGen && global.MiyaImageGen.isGlobalEnabled && global.MiyaImageGen.isGlobalEnabled())
          ? '角色文字图将调用生图 API'
          : '请先在设置中启用生图 API', renderImageGenBlock(s))
      ) +

      renderZone('wallet', '钱包', '角色独立余额 · ' + esc(roleBalFmt),
        formCard(
          '<article class="mi-wcard mi-wcard--compact mi-wcard--static">' +
            '<span class="mi-wcard__grain" aria-hidden="true"></span>' +
            '<span class="mi-wcard__shine" aria-hidden="true"></span>' +
            '<span class="mi-wcard__chip" aria-hidden="true"></span>' +
            '<div class="mi-wcard__head">' +
              '<span class="mi-wcard__brand">KARIN WALLET</span>' +
            '</div>' +
            '<div class="mi-wcard__body">' +
              '<span class="mi-wcard__label">' + esc(name) + ' 的钱包</span>' +
              '<p class="mi-wcard__amount"><em>¥</em>' + esc(roleBalFmt.replace(/^¥/, '')) + '</p>' +
            '</div>' +
            '<div class="mi-wcard__foot">' +
              '<span class="mi-wcard__holder">' + esc(name) + '</span>' +
              '<span class="mi-wcard__badge">ROLE</span>' +
            '</div>' +
          '</article>' +
          '<div class="mi-wallet-note">' +
            '<span class="mi-wallet-note__icon" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="16" cy="14" r="1" fill="currentColor"/></svg>' +
            '</span>' +
            '<p>角色向你转账时从此扣款；你向角色转账且对方收款后入账此处。</p>' +
          '</div>' +
          '<div class="mi-btn-row">' +
            '<button type="button" class="st-action-btn" data-mq-set-contact-wallet-adjust>调整 Ta 的余额</button>' +
          '</div>'
        )
      ) +

      renderZone('data', '数据管理', '聊天记录、导入导出与删除',
        subBlock('聊天记录', '共 ' + msgCount + ' 条', formCard(
          '<div class="st-card mi-set-action-card">' +
            '<button type="button" class="st-card-row" data-mq-set-export>' +
              '<div class="st-card-row-left"><div><div class="st-card-label">导出 JSON</div></div></div>' +
              '<img class="mi-ico-img st-chevron" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
            '</button>' +
            '<button type="button" class="st-card-row" data-mq-set-import>' +
              '<div class="st-card-row-left"><div><div class="st-card-label">导入 JSON</div></div></div>' +
              '<img class="mi-ico-img st-chevron" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
            '</button>' +
            '<button type="button" class="st-card-row mi-set-action-row--warn" data-mq-set-clear>' +
              '<div class="st-card-row-left"><div><div class="st-card-label">清空全部消息</div></div></div>' +
              '<img class="mi-ico-img st-chevron" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
            '</button>' +
          '</div>' +
          '<input type="file" accept="application/json,.json" hidden data-mq-set-import-file>'
        )) +
        subBlock('移除联系人', '删除后无法恢复', formCard(
          '<p class="mi-danger-text">删除后联系人、会话、消息全部消失，无法恢复。</p>' +
          '<button type="button" class="st-action-btn st-action-btn--danger" data-mq-set-delete-contact>删除这个联系人</button>'
        , 'mi-set-danger-card'))
      ) +

      /*
       * ── 以下三个分区原属于「桌面设置 App」───────────────────────
       *
       * 桌面设置已被删除，这些是它原本承载、必须有个新家的功能。
       * 放在页面最下方而不是塞进上面任意一个 zone：
       * 它们的性质是「全局维护」而非「这个角色的聊天偏好」，
       * 混进对话表现或外观里会让人以为改的只影响当前角色。
       */
      renderSubNavBar('notify', '通知与提示音', '系统通知开关、测试与来消息提示音', 'notify') +
      renderSubNavBar('backup', '备份与恢复', '导出数据、完整导出与导入', 'backup') +
      renderSubNavBar('storage', '存储用量', '本机数据占用概览', 'storage') +

      /* 聊天默认值：未单独设置过的联系人统一用这里的配置。
         原先挂在桌面设置主页的 nav 上，主页一删它就没地方去了 ——
         必须在聊天设置里承接，否则这个功能整体丢失。 */
      renderSubNavBar('chat-defaults', '聊天默认值', '未单独设置过的联系人，统一使用这里的记忆与后台配置', 'chat-defaults') +

      /*
       * 页脚（Chat Preferences / Karin · 2026）已删除。
       * 与世界书列表页、设置页的页脚是同一套装饰语言：
       * Playfair Display 意大利体英文小字，无按钮无交互，只占末尾一行高度。
       */
    '</div>';
  }

  function ensurePage() {
    if (pageEl) return pageEl;
    var app = $('miya-chat-app');
    pageEl = document.createElement('div');
    pageEl.className = 'mi-set-page';
    pageEl.id = 'mq-set-page';
    pageEl.hidden = true;
    pageEl.setAttribute('aria-hidden', 'true');
    pageEl.innerHTML =
      '<div class="st-ambient-bg" aria-hidden="true"></div>' +
      '<header class="st-navbar mi-set-navbar">' +
        '<button type="button" class="st-navback" data-mq-set-back aria-label="返回">' +
          '<svg width="10" height="18" viewBox="0 0 10 18" fill="none" aria-hidden="true"><path d="M9 1L1 9l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '<span>返回</span>' +
        '</button>' +
        '<h1 class="st-navtitle">聊天设置</h1>' +
        '<button type="button" class="mi-set-navsave" data-mq-set-save>保存</button>' +
      '</header>' +
      '<div class="st-scroll mi-set-body" data-mq-set-body></div>' +
      '<div class="mi-toast"></div>';
    if (app) app.appendChild(pageEl);
    else document.body.appendChild(pageEl);
    bindPageEvents();
    return pageEl;
  }

  function isToggleOn(root, sel) {
    var el = root.querySelector(sel);
    return el ? el.classList.contains('is-on') : false;
  }

  function readWeatherFromRoot(root, baseWa) {
    return Object.assign({}, baseWa || {}, {
      enabled: isToggleOn(root, '#mq-set-weather-en'),
      placeUser: String((root.querySelector('[data-mq-set-vplace-user]') || {}).value || '').trim(),
      placeRole: String((root.querySelector('[data-mq-set-vplace-role]') || {}).value || '').trim(),
      realLocUser: String((root.querySelector('[data-mq-set-rloc-user]') || {}).value || '').trim(),
      realLocRole: String((root.querySelector('[data-mq-set-rloc-role]') || {}).value || '').trim(),
      settingsUiVersion: 2
    });
  }

  function runWeatherSense() {
    if (!pageEl || !state.chatId || !store) return;
    var root = pageEl.querySelector('[data-mq-set-body]');
    var c = ctx();
    if (!root || !c) return;
    var wa = readWeatherFromRoot(root, c.settings.weatherAwareness);
    if (!wa.enabled) {
      toast('请先开启天气感知');
      return;
    }
    var aw = global.MiyaChatAwareness;
    if (!aw || typeof aw.refreshWeatherForSettings !== 'function') {
      toast('感知模块未就绪');
      return;
    }
    toast('正在感知…');
    var settings = Object.assign({}, c.settings, { weatherAwareness: wa });
    aw.refreshWeatherForSettings(settings).then(function (refreshed) {
      if (refreshed && refreshed.weatherAwareness) {
        return store.saveChatSettings(state.chatId, { weatherAwareness: refreshed.weatherAwareness });
      }
      return store.saveChatSettings(state.chatId, { weatherAwareness: wa });
    }).then(function () {
      toast('天气已更新');
      render();
    }).catch(function () {
      toast('感知失败');
    });
  }

  function syncWeatherAppIntoForm() {
    if (!pageEl || !state.chatId || !store) return;
    var root = pageEl.querySelector('[data-mq-set-body]');
    var c = ctx();
    if (!root || !c || !c.contact) return;
    var br = global.miyaWeatherBridge;
    var wst = global.miyaWeatherStore;
    if (!br || !wst) {
      toast('天气模块未就绪');
      return;
    }
    var me = wst.getMyLocation();
    var roleCity = wst.findCityByContact(c.contact.id);
    if ((!me || !me.name) && !roleCity) {
      toast('天气 App 里还没有「我的位置」或该角色城市');
      return;
    }
    toast('正在同步并感知…');
    br.syncAppToChatWeatherAwareness(state.chatId, c.contact.id)
      .then(function (wa) {
        var next = Object.assign({}, wa || {}, { enabled: true, settingsUiVersion: 2 });
        var uPlace = root.querySelector('[data-mq-set-vplace-user]');
        var uReal = root.querySelector('[data-mq-set-rloc-user]');
        var rPlace = root.querySelector('[data-mq-set-vplace-role]');
        var rReal = root.querySelector('[data-mq-set-rloc-role]');
        if (uReal && next.realLocUser) uReal.value = next.realLocUser;
        if (uPlace && next.placeUser) uPlace.value = next.placeUser;
        if (rReal && next.realLocRole) rReal.value = next.realLocRole;
        if (rPlace && next.placeRole) rPlace.value = next.placeRole;

        var enToggle = root.querySelector('#mq-set-weather-en');
        if (enToggle) {
          enToggle.classList.add('is-on');
          enToggle.setAttribute('aria-checked', 'true');
        }

        var aw = global.MiyaChatAwareness;
        if (!aw || typeof aw.refreshWeatherForSettings !== 'function') {
          return store.saveChatSettings(state.chatId, { weatherAwareness: next }).then(function () {
            toast('已同步地点；感知模块未就绪，请稍后点「感知」');
            render();
          });
        }
        var settings = Object.assign({}, c.settings, { weatherAwareness: next });
        return aw.refreshWeatherForSettings(settings).then(function (refreshed) {
          var saved = (refreshed && refreshed.weatherAwareness) || next;
          return store.saveChatSettings(state.chatId, { weatherAwareness: saved }).then(function () {
            var parts = [];
            if (saved.realLocUser) parts.push('我→' + saved.realLocUser);
            if (saved.realLocRole) parts.push('Ta→' + saved.realLocRole);
            toast(parts.length ? '已同步并感知：' + parts.join('，') : '已同步并感知天气');
            render();
          });
        });
      })
      .catch(function (err) {
        toast((err && err.message) || '同步失败');
      });
  }

  function readForm(root) {
    var c = ctx();
    if (!c) return {};
    var s = c.settings;
    var chatBg = (c.chat.chatSettings && c.chat.chatSettings.backgroundMessage) || {};
    var wa = readWeatherFromRoot(root, s.weatherAwareness);
    var ttsOn = isToggleOn(root, '#mq-set-tts-en');
    var bfMod = global.MiyaChatBeautify;
    var chatBeautify = bfMod
      ? bfMod.readChatBeautifyFromRoot(root, s.chatBeautify)
      : Object.assign({}, s.chatBeautify || {});
    var hvMod = global.MiyaChatHeartVoiceTemplates;
    var heartVoicePreset = hvMod
      ? hvMod.readChatPresetFromRoot(root, s.heartVoicePreset)
      : String(s.heartVoicePreset || '').trim();
    var heartVoicePresetSnapshot = null;
    if (heartVoicePreset && hvMod) {
      if (typeof hvMod.findPreset === 'function') {
        var hvRow = hvMod.findPreset(heartVoicePreset);
        if (hvRow && typeof hvMod.buildSnapshotFromPreset === 'function') {
          heartVoicePresetSnapshot = hvMod.buildSnapshotFromPreset(hvRow);
        }
      }
      if (
        !heartVoicePresetSnapshot &&
        s.heartVoicePresetSnapshot &&
        String((s.heartVoicePresetSnapshot.name || s.heartVoicePreset) || '').trim() === heartVoicePreset &&
        typeof hvMod.buildSnapshotFromPreset === 'function'
      ) {
        heartVoicePresetSnapshot = hvMod.buildSnapshotFromPreset(s.heartVoicePresetSnapshot);
      }
    }
    var prevMa = s.momentsAuto || {};
    var momentsAuto = readMomentsAutoFromRoot(root, prevMa);
    /* 「模型高级」区的时间感知：只切 enabled，其余（mode / 双时区 / 强度）沿用既有归一化结果，
       避免把角色时区等由其它流程维护的字段覆盖掉。 */
    var awMod = global.MiyaChatAwareness;
    var taNext = awMod && typeof awMod.normalizeTimeAwareness === 'function'
      ? awMod.normalizeTimeAwareness(s.timeAwareness)
      : Object.assign({}, s.timeAwareness || {});
    taNext.enabled = isToggleOn(root, '#mq-set-time-en');
    /* 「记忆与后台」分区里的配置字段（走 perContact 覆盖，见 saveForm） */
    var memConfig = readConfigScopedMemory(root, s);
    var patch = {
      remarkName: (root.querySelector('[data-mq-set-remark]') || {}).value || '',
      relationship: (root.querySelector('[data-mq-set-rel]') || {}).value || '',
      weatherAwareness: wa,
      timeAwareness: taNext,
      replyBannerEnabled: s.replyBannerEnabled !== false,
      muteNotifications: isToggleOn(root, '#mq-set-mute-notify'),
      onlineNarrationEnabled: isToggleOn(root, '#mq-set-online-narration'),
      onlineNarrationInjectContext: isToggleOn(root, '#mq-set-online-narration-ctx'),
      onlineNarrationCharPerson: String((root.querySelector('[data-mq-set-narration-char-person]') || {}).value || '3').trim() || '3',
      onlineNarrationUserPerson: String((root.querySelector('[data-mq-set-narration-user-person]') || {}).value || '2').trim() || '2',
      autoTranslate: isToggleOn(root, '#mq-set-trans'),
      translateMode: 'semantic',
      translateTarget: String((root.querySelector('[data-mq-set-trans-target]') || {}).value || 'zh-CN').trim(),
      momentsTranslate: isToggleOn(root, '#mq-set-moments-trans'),
      roleReplyBubbleMin: parseInt((root.querySelector('[data-mq-set-bubble-min]') || {}).value, 10) || 1,
      roleReplyBubbleMax: parseInt((root.querySelector('[data-mq-set-bubble-max]') || {}).value, 10) || 5,
      messageRenderLimit: parseInt((root.querySelector('[data-mq-set-render-limit]') || {}).value, 10) || 100,
      minimaxVoiceId: String((root.querySelector('[data-mq-set-voice-id]') || {}).value || '').trim(),
      minimaxLanguageBoost: (root.querySelector('[data-mq-set-lang]') || {}).value || 'auto',
      chatBeautify: chatBeautify,
      heartVoicePreset: heartVoicePreset,
      heartVoicePresetSnapshot: heartVoicePresetSnapshot,
      momentsAuto: momentsAuto,
      backgroundMessage: readLifeLikeBackground(chatBg, root)
    };
    patch.dynamicAvatar = {
      charEnabled: isToggleOn(root, '#mq-set-dava-char'),
      userEnabled: isToggleOn(root, '#mq-set-dava-user')
    };
    if (global.MiyaImageGen && global.MiyaImageGen.isGlobalEnabled && global.MiyaImageGen.isGlobalEnabled()) {
      var prevIg = s.imageGen || {};
      patch.imageGen = {
        enabled: isToggleOn(root, '#mq-set-ig-en'),
        customPrompt: String((root.querySelector('[data-mq-set-ig-prompt]') || {}).value || '').trim(),
        refUrl: prevIg.refUrl || '',
        refBlobId: prevIg.refBlobId || null
      };
    }
    var useAllEmo = isToggleOn(root, '#mq-set-emo-all');
    var emoGroupIds = [];
    if (!useAllEmo) {
      root.querySelectorAll('[data-mq-set-emo-grp].is-on').forEach(function (sw) {
        var gid = sw.getAttribute('data-mq-set-emo-grp');
        if (gid) emoGroupIds.push(gid);
      });
    }
    return {
      settingsPatch: patch,
      memoryConfig: memConfig,
      profileId: (root.querySelector('[data-mq-set-mask]') || {}).value || '',
      emojiGroupIds: emoGroupIds,
      useAllEmo: useAllEmo,
      ttsEnabled: ttsOn,
      worldbookEntryOrder: filterWorldbookEntryOrderForContact(
        c.contact,
        readWorldbookEntryOrderFromRoot(root)
      )
    };
  }

  function captureFormDraft(root) {
    if (!root || !state.chatId) return;
    try {
      state.formDraft = readForm(root);
    } catch (e) {
      state.formDraft = null;
    }
  }

  function applyFormDraft(root) {
    var draft = state.formDraft;
    if (!root || !draft || !draft.settingsPatch) return;
    var p = draft.settingsPatch;

    function setVal(sel, v) {
      var el = root.querySelector(sel);
      if (el) el.value = v != null ? String(v) : '';
    }

    function setToggle(sel, on) {
      var el = root.querySelector(sel);
      if (!el) return;
      el.classList.toggle('is-on', !!on);
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    }

    setVal('[data-mq-set-remark]', p.remarkName);
    setVal('[data-mq-set-rel]', p.relationship);
    if (draft.profileId) setVal('[data-mq-set-mask]', draft.profileId);

    var wa = p.weatherAwareness || {};
    setToggle('#mq-set-weather-en', wa.enabled);
    setVal('[data-mq-set-vplace-user]', wa.placeUser);
    setVal('[data-mq-set-rloc-user]', wa.realLocUser);
    setVal('[data-mq-set-vplace-role]', wa.placeRole);
    setVal('[data-mq-set-rloc-role]', wa.realLocRole);

    var pTa = p.timeAwareness || {};
    setToggle('#mq-set-time-en', pTa.enabled);

    setToggle('#mq-set-mute-notify', p.muteNotifications);
    setToggle('#mq-set-lifelike', p.backgroundMessage && p.backgroundMessage.lifeLikeEnabled);
    setToggle('#mq-set-anonymous', p.backgroundMessage && p.backgroundMessage.anonymousDisguiseEnabled);
    /* 「记忆与后台」分区回填（草稿值优先，否则用生效值） */
    var mc = draft.memoryConfig || {};
    setVal('[data-mq-set-memory-count]', mc.memoryCount != null ? mc.memoryCount : 80);
    setVal('[data-mq-set-summary-trigger]', mc.summaryTrigger != null ? mc.summaryTrigger : 0);
    setVal('[data-mq-set-summary-length]', mc.summaryLength || '100-300字');
    var mcBg = mc.backgroundMessage || {};
    var pBg = p.backgroundMessage || {};
    var pLifeLike = !!pBg.lifeLikeEnabled;
    setToggle('#mq-set-bg-active', (pLifeLike || mcBg.activeEnabled === false) ? false : (mcBg.activeEnabled != null ? !!mcBg.activeEnabled : !!pBg.activeEnabled));
    setVal('[data-mq-set-bg-active-min]', mcBg.activeIntervalMin != null ? mcBg.activeIntervalMin : (pBg.activeIntervalMin != null ? pBg.activeIntervalMin : 30));
    setToggle('#mq-set-bg-quiet-en', mcBg.quietEnabled != null ? !!mcBg.quietEnabled : !!pBg.quietEnabled);
    setVal('[data-mq-set-bg-quiet-start]', minToTimeStr(mcBg.quietStartMin != null ? mcBg.quietStartMin : (pBg.quietStartMin != null ? pBg.quietStartMin : 1380)));
    setVal('[data-mq-set-bg-quiet-end]', minToTimeStr(mcBg.quietEndMin != null ? mcBg.quietEndMin : (pBg.quietEndMin != null ? pBg.quietEndMin : 420)));
    setVal('[data-mq-set-render-limit]', p.messageRenderLimit);
    setVal('[data-mq-set-bubble-min]', p.roleReplyBubbleMin);
    setVal('[data-mq-set-bubble-max]', p.roleReplyBubbleMax);
    setToggle('#mq-set-trans', p.autoTranslate);
    setVal('[data-mq-set-trans-target]', p.translateTarget);
    setToggle('#mq-set-moments-trans', p.momentsTranslate);
    setToggle('#mq-set-tts-en', draft.ttsEnabled != null ? draft.ttsEnabled : !!String(p.minimaxVoiceId || '').trim());
    setVal('[data-mq-set-voice-id]', p.minimaxVoiceId);
    setVal('[data-mq-set-lang]', p.minimaxLanguageBoost);

    if (p.dynamicAvatar) {
      setToggle('#mq-set-dava-char', p.dynamicAvatar.charEnabled);
      setToggle('#mq-set-dava-user', p.dynamicAvatar.userEnabled);
    }

    if (p.imageGen) {
      setToggle('#mq-set-ig-en', p.imageGen.enabled);
      setVal('[data-mq-set-ig-prompt]', p.imageGen.customPrompt);
    }

    var ma = p.momentsAuto || {};
    setVal('[data-mq-set-moments-mode]', ma.mode || 'off');
    if (ma.mode === 'rounds') setVal('[data-mq-set-moments-rounds]', ma.roundInterval);
    if (ma.mode === 'hours') setVal('[data-mq-set-moments-hours]', ma.hourInterval);

    setToggle('#mq-set-online-narration', p.onlineNarrationEnabled);
    setToggle('#mq-set-online-narration-ctx', p.onlineNarrationInjectContext);
    setVal('[data-mq-set-narration-char-person]', p.onlineNarrationCharPerson || '3');
    setVal('[data-mq-set-narration-user-person]', p.onlineNarrationUserPerson || '2');

    setToggle('#mq-set-emo-all', draft.useAllEmo !== false);
    if (draft.useAllEmo === false && Array.isArray(draft.emojiGroupIds)) {
      root.querySelectorAll('[data-mq-set-emo-grp]').forEach(function (sw) {
        var gid = sw.getAttribute('data-mq-set-emo-grp');
        var on = draft.emojiGroupIds.indexOf(gid) >= 0;
        sw.classList.toggle('is-on', on);
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }

    if (p.chatBeautify) {
      var cssTa = root.querySelector('[data-mq-bf-custom-css]');
      if (cssTa) cssTa.value = p.chatBeautify.customCss || '';
      var presetPick = root.querySelector('[data-mq-bf-preset-pick]');
      if (presetPick && p.chatBeautify.presetName != null) presetPick.value = p.chatBeautify.presetName;
    }


    if (p.heartVoicePreset != null) {
      var hvPick = root.querySelector('[data-mq-set-hv-tpl-preset]');
      if (hvPick) hvPick.value = p.heartVoicePreset;
    }

    syncTranslateExtrasVisibility(root);
    syncMomentsAutoModeUI(root);
    syncEmoBindGroupToggles(root);

    if (Array.isArray(draft.worldbookEntryOrder) && draft.worldbookEntryOrder.length) {
      var wbList = root.querySelector('[data-mq-set-wb-sort]');
      if (wbList) {
        draft.worldbookEntryOrder.forEach(function (id, targetIdx) {
          id = String(id || '').trim();
          if (!id) return;
          var rows = Array.prototype.slice.call(wbList.querySelectorAll('[data-mq-set-wb-sort-id]'));
          var row = rows.find(function (el) {
            return el.getAttribute('data-mq-set-wb-sort-id') === id;
          });
          if (!row) return;
          var currentIdx = rows.indexOf(row);
          if (currentIdx < 0 || currentIdx === targetIdx) return;
          var ref = rows[targetIdx] || null;
          if (ref && ref !== row) wbList.insertBefore(row, ref);
          else wbList.appendChild(row);
        });
        refreshWorldbookSortRowState(wbList);
      }
    }

    var bfMod = global.MiyaChatBeautify;
    var bfWrap = root.querySelector('.mi-bf-wrap');
    if (bfMod && bfWrap) bfMod.hydrateCssPreview(bfWrap);
  }

  /*
   * 温度滑块的数值标签同步。
   *
   * 这个联动原本随桌面设置 App 一起丢了 —— 拖滑块只有条动、数字不动。
   * 「载入预设」之后也要用一次：预设里的温度直接写进 input.value，
   * 不经过 input 事件，标签不会自己更新。
   */
  function syncTempLabel(rangeSel, labelSel) {
    if (!pageEl) return;
    var r = pageEl.querySelector(rangeSel);
    var l = pageEl.querySelector(labelSel);
    if (r && l) l.textContent = String(r.value);
  }

  function refreshWeatherAfterSaveInBackground(prevWa, nextWa) {
    var aw = global.MiyaChatAwareness;
    if (!aw || typeof aw.refreshWeatherIfStale !== 'function' || !store || !state.chatId) return;
    var shouldRefresh =
      nextWa &&
      nextWa.enabled &&
      typeof aw.shouldRefreshWeatherOnSave === 'function' &&
      aw.shouldRefreshWeatherOnSave(prevWa, nextWa);
    if (!shouldRefresh) return;
    var chatId = state.chatId;
    var fresh = store.getChatSettings(chatId);
    aw.refreshWeatherIfStale(fresh, { forceLocChange: true }).then(function (refreshed) {
      if (refreshed && refreshed.weatherAwareness) {
        return store.saveChatSettings(chatId, { weatherAwareness: refreshed.weatherAwareness });
      }
    }).catch(function () {});
  }

  function saveForm() {
    if (!store || !state.chatId || !pageEl) return Promise.resolve();
    /*
     * 顶栏「保存」在子视图内同样可见（ensurePage 的 header 是常驻的）。
     * 此时 [data-mq-set-body] 里只有子视图 DOM，readForm 会把缺失的根级
     * 控件读成空值 / 关闭 / 默认值并真实落库 —— 实测会清空备注与语音 ID、
     * 关掉免打扰 / 天气感知 / 时间感知 / 主动发消息、清空世界书排序。
     * 所以子视图内点顶栏保存一律转为保存当前子视图：
     *   · api-chat / api-voice → 走 saveSubViewForm，与子视图内「保存」按钮同链路
     *   · 其余子视图没有可存表单，提示即可，绝不触碰根级配置
     */
    if (state.subView) {
      if (state.subView === 'api-chat' || state.subView === 'api-voice') {
        saveSubViewForm(state.subView);
      } else {
        toast('本页无需保存');
      }
      return Promise.resolve();
    }
    var root = pageEl.querySelector('[data-mq-set-body]');
    var data = readForm(root);
    var c = ctx();
    if (!c) return Promise.resolve();

    var useAllEmo = isToggleOn(root, '#mq-set-emo-all');
    var emojiValid = useAllEmo || data.emojiGroupIds.length > 0;
    var prevWa = c.settings.weatherAwareness;
    var nextWa = data.settingsPatch.weatherAwareness;

    /*
     * 「记忆与后台」分区走的是另一条落库链路。
     * getChatSettings() 最后一步会用全局配置把 memoryCount / summaryTrigger /
     * summaryLength / backgroundMessage 整个覆盖掉，所以这几个字段不能只写
     * contact.chatSettings（实测：写得进去，读不出来）。
     * 这里把它们登记为该联系人的 perContact 覆盖，改完即生效，
     * 也不影响其它联系人仍在使用的全局默认值。
     * 注意：backgroundMessage 里的 lifeLike / anonymousDisguiseEnabled 属于会话级，
     * 仍由上面的 saveChatSettings 负责，不在这里重复写。
     */
    var gsMod = global.miyaChatGlobalSettings;
    var memConfig = data.memoryConfig;
    var hasMemChange = !!(memConfig && c.contact);

    var chain = Promise.resolve();
    if (data.profileId && data.profileId !== c.chat.profileId) {
      chain = chain.then(function () { return store.updateChat(state.chatId, { profileId: data.profileId }); });
      if (c.contact) {
        chain = chain.then(function () {
          return store.updateContact(c.contact.id, { defaultProfileId: data.profileId });
        });
      }
    }
    chain = chain.then(function () {
      return store.saveChatSettings(state.chatId, data.settingsPatch);
    });
    if (hasMemChange && gsMod && typeof gsMod.applyContactOverride === 'function') {
      chain = chain.then(function () {
        return gsMod.applyContactOverride(c.contact.id, memConfig);
      });
    }

    return chain.then(function () {
      var emojiChain = Promise.resolve();
      if (emojiValid && c.contact && typeof data.emojiGroupIds !== 'undefined') {
        emojiChain = store.setContactEmojiGroups(c.contact.id, data.emojiGroupIds);
      }
      return emojiChain;
    }).then(function () {
      if (c.contact && store.setContactWorldbookEntryOrder &&
          Array.isArray(data.worldbookEntryOrder) && data.worldbookEntryOrder.length) {
        /* length 守卫：空数组几乎必然来自「排序区根本不在 DOM 里」（子视图/
           未渲染完成），而不是用户真的清空了排序 —— 排序区只能上下移动，
           没有删除行的操作。applyFormDraft 侧早有同样的守卫，这里对齐。 */
        return store.setContactWorldbookEntryOrder(c.contact.id, data.worldbookEntryOrder);
      }
    }).then(function () {
      state.formDraft = null;
      toast(emojiValid
        ? '已保存'
        : '其它设置已保存；表情包请打开「使用全部分组」或至少开启一个分组');
      /* 先反馈，再轻量刷 UI；禁止整页房间 refresh（会重渲全部消息） */
      if (global.MiyaChatBeautify) global.MiyaChatBeautify.applyForChat(state.chatId);
      scheduleRender({ fromStore: true, skipContextUsage: true });
      if (global.miyaChatApp && global.miyaChatApp.refreshLists) {
        if (typeof global.miyaScheduleIdle === 'function') {
          global.miyaScheduleIdle(function () { global.miyaChatApp.refreshLists(); }, 700);
        } else {
          setTimeout(function () { global.miyaChatApp.refreshLists(); }, 0);
        }
      }
      if (
        c.contact &&
        data.settingsPatch &&
        data.settingsPatch.momentsAuto &&
        data.settingsPatch.momentsAuto.mode &&
        data.settingsPatch.momentsAuto.mode !== 'off' &&
        global.MiyaChatMoments &&
        typeof global.MiyaChatMoments.checkMomentsAutoForContact === 'function'
      ) {
        var momentsMod = global.MiyaChatMoments;
        var dueCheck = function () { momentsMod.checkMomentsAutoForContact(c.contact.id); };
        if (typeof momentsMod.whenReady === 'function') {
          momentsMod.whenReady().then(dueCheck).catch(dueCheck);
        } else if (typeof global.miyaScheduleIdle === 'function') {
          global.miyaScheduleIdle(dueCheck, 1200);
        } else {
          setTimeout(dueCheck, 0);
        }
      }
      if (
        data.settingsPatch &&
        data.settingsPatch.backgroundMessage &&
        data.settingsPatch.backgroundMessage.lifeLikeEnabled &&
        global.MiyaChatBackground &&
        typeof global.MiyaChatBackground.checkAll === 'function'
      ) {
        if (typeof global.miyaScheduleIdle === 'function') {
          global.miyaScheduleIdle(function () { global.MiyaChatBackground.checkAll(); }, 1400);
        } else {
          setTimeout(function () { global.MiyaChatBackground.checkAll(); }, 0);
        }
      }
      refreshWeatherAfterSaveInBackground(prevWa, nextWa);
    }).catch(function () { toast('保存失败'); });
  }

  function hydrateAvatars(root) {
    var c = ctx();
    if (!c || !root) return;
    var contact = c.contact && store.findContact ? store.findContact(c.contact.id) : c.contact;
    var profileId = profileIdForCtx(c);
    var profile =
      (store.getProfiles() || []).find(function (p) { return p.id === profileId; }) || c.profile;
    hydrateDisplayAvatarPicker(root, 'contact', contact);
    hydrateDisplayAvatarPicker(root, 'profile', profile);
    var bf = c.settings.chatBeautify || {};
    var bfMod = global.MiyaChatBeautify;
    var preview = root.querySelector('[data-mq-set-bg-preview]');
    if (preview && bfMod) {
      bfMod.resolveWallpaperUrl(bf).then(function (url) {
        if (url) {
          preview.style.backgroundImage = 'url("' + url.replace(/"/g, '') + '")';
          preview.classList.add('has-image');
          var ph = preview.querySelector('.mi-bg-stage__placeholder');
          if (ph) ph.hidden = true;
        }
      });
    }
    if (global.MiyaChatWallpaperPicker && global.MiyaChatWallpaperPicker.hydrateThumbs) {
      global.MiyaChatWallpaperPicker.hydrateThumbs(root);
    }
    var igPreview = root.querySelector('[data-mq-set-ig-ref-preview]');
    if (igPreview && c.settings.imageGen) {
      var ig = c.settings.imageGen;
      applyDisplayAvatarPreview(igPreview, '');
      if (ig.refUrl) applyDisplayAvatarPreview(igPreview, ig.refUrl);
      else if (ig.refBlobId) {
        store.getAvatarUrl(ig.refBlobId).then(function (url) {
          if (url) applyDisplayAvatarPreview(igPreview, url);
        });
      }
    }
  }

  /*
   * ── 页内子视图 ──────────────────────────────────────────────
   *
   * 有些内容是「独立的一页」而不适合折在 zone 里展开：
   *   · 三个 API 表单（对话 / 语音 / 生图）—— 字段多，且需要从别处
   *     拉取模型列表，展开在长列表里会让人找不到北；
   *   · 备份与恢复、存储用量 —— 各自是完整的功能页，有进度与刷新。
   *
   * 做法：点这类栏时不展开，而是把整个 body 换成子视图内容，
   * 顶栏标题改成子视图名，返回键先回列表（state.subView 置空再 render）。
   *
   * 为什么不复用被删除的桌面设置 App 的面板 DOM：那些面板的 id
   * （miya-st-panel-chat 等）被设置 App 的顶栏保存逻辑与生图模块
   * 按固定 id 引用着，搬过来会连带搬一堆耦合。这里按同样字段
   * 重新渲染一份，读写仍走同一套 miyaGetApiConfigCached /
   * miyaSetApiConfig，数据只有一份。
   */
  var SUB_VIEW_TITLES = {
    'api-chat': '对话 API',
    'api-voice': '语音合成',
    'backup': '备份与恢复',
    'storage': '存储用量',
    'notify': '通知与提示音',
    'chat-defaults': '聊天默认值'
  };

  /*
   * 子视图表单保存。
   *
   * 写入统一走 miyaSetApiConfig —— 那是全项目 25 处调用共用的
   * 配置写入口，内部负责「补磁盘底 + 落 KV + 更新缓存」。这里
   * 只把 DOM 上的值读出来，绝不自己写 localStorage，
   * 否则会绕过水合逻辑，出现「这次改了、下次打开又变回去」。
   */
  function saveSubViewForm(key) {
    if (!pageEl) return;
    function val(sel) {
      var el = pageEl.querySelector(sel);
      return el ? String(el.value || '').trim() : '';
    }
    function on(sel) {
      var el = pageEl.querySelector(sel);
      return !!(el && el.classList.contains('is-on'));
    }
    if (key === 'api-chat') {
      var temp = parseFloat(val('#mq-api-temp'));
      var temp2 = parseFloat(val('#mq-api2-temp'));
      var patch = {
        baseUrl: val('#mq-api-base'),
        apiKey: val('#mq-api-key'),
        model: val('#mq-api-model'),
        fallbackBaseUrl: val('#mq-api2-base'),
        fallbackApiKey: val('#mq-api2-key'),
        fallbackModel: val('#mq-api2-model'),
        fallbackEnabled: on('#mq-api-fallback')
      };
      if (Number.isFinite(temp)) patch.temperature = temp;
      /* 副线路温度：原版面板有这个字段，压缩重写时丢了 —— 补回 */
      if (Number.isFinite(temp2)) patch.fallbackTemperature = temp2;
      if (typeof global.miyaSetApiConfig === 'function') global.miyaSetApiConfig(patch);
      /* 草稿对齐刚落盘的值（基线同步 = 草稿继续有效且等于配置）：
         避免下一次重绘把旧草稿回填成「没保存的模型」 */
      state.apiModelPick = patch.model || '';
      state.apiModelPickBase = String(patch.model || '');
      state.apiModel2Pick = patch.fallbackModel || '';
      state.apiModel2PickBase = String(patch.fallbackModel || '');
      toast('对话 API 已保存');
      return;
    }
    if (key === 'api-voice') {
      var cfg = (global.miyaGetApiConfigCached && global.miyaGetApiConfigCached()) || {};
      var tts = Object.assign({}, cfg.minimaxTts || {}, {
        apiKey: val('#mq-voice-key'),
        groupId: val('#mq-voice-group'),
        model: val('#mq-voice-model'),
        prompt: val('#mq-voice-prompt')
      });
      var sp = parseFloat(val('#mq-voice-speed'));
      var vo = parseFloat(val('#mq-voice-vol'));
      var pi = parseInt(val('#mq-voice-pitch'), 10);
      if (Number.isFinite(sp)) tts.speed = sp;
      if (Number.isFinite(vo)) tts.volume = vo;
      if (Number.isFinite(pi)) tts.pitch = pi;
      if (typeof global.miyaSetApiConfig === 'function') global.miyaSetApiConfig({ minimaxTts: tts });
      toast('语音合成已保存');
      return;
    }
  }

  /* 发一条测试通知。与旧设置 App 里那段行为一致：
     先在预览样张里插一条，再真正走系统通知通道。 */
  function runNotifyTest() {
    if (!global.miyaGetNotificationApi || !global.miyaGetNotificationApi()) {
      toast('当前环境不支持通知');
      return;
    }
    function fire() {
      var iconEl = document.querySelector('link[rel="icon"]');
      global.miyaShowSystemNotification('miya小手机', {
        body: '这是一条测试通知。',
        tag: 'miya-notify-test-' + String(Date.now()),
        icon: iconEl ? iconEl.href : undefined,
        data: { kind: 'test' }
      }).then(function (n) {
        if (n) {
          if (!n._viaSw && n.onclick !== undefined) {
            n.onclick = function () {
              try { window.focus(); } catch (e) {}
              n.close();
            };
          }
          toast('测试通知已发送');
        } else {
          toast('发送失败，请确认已开启通知权限');
        }
      });
    }
    var perm = global.miyaGetNotificationPermission ? global.miyaGetNotificationPermission() : 'unsupported';
    if (perm === 'denied') { toast('通知权限被拒绝，请在浏览器设置中允许'); return; }
    if (perm === 'granted') { fire(); return; }
    global.miyaRequestNotificationPermission().then(function (next) {
      if (next === 'granted') {
        if (global.miyaSetSystemPrefs) global.miyaSetSystemPrefs({ notify: true });
        var sw = pageEl && pageEl.querySelector('#mq-notify-sw');
        if (sw) { sw.classList.add('is-on'); sw.setAttribute('aria-checked', 'true'); }
        fire();
      } else {
        toast(next === 'denied' ? '通知权限被拒绝' : '需要允许通知权限');
      }
    });
  }

  function renderSubView(key) {
    if (key === 'api-chat') return renderApiChatSub();
    if (key === 'api-voice') return renderApiVoiceSub();
    if (key === 'backup') return renderBackupSub();
    if (key === 'storage') return renderStorageSub();
    if (key === 'notify') return renderNotifySub();
    if (key === 'chat-defaults') return renderChatDefaultsSub();
    return '<div class="mi-empty-hint">该设置页不存在</div>';
  }

  /*
   * 子视图统一外壳。正文直接就是内容卡片，**不再自带返回键与标题**。
   *
   * ── 为什么去掉这一行 ──────────────────────────────────────────
   *
   * 顶栏（.st-navbar）本来就有「‹ 返回」和当前页标题，render() 在进子视图时
   * 会把标题改成子视图名（见 SUB_VIEW_TITLES）。原先这里又渲染了一遍
   * 「‹ 聊天设置」胶囊 + 20px 大字标题 —— 于是同一屏里出现两个返回键、
   * 两个标题，正文还被这行重复信息往下挤掉一截。
   *
   * 这行是「桌面设置 App 面板」搬进页内时留下的：那时面板是独立一页、
   * 没有外层顶栏，所以自己带了返回与标题；改成子视图后顶栏接管了这两件事，
   * 它就成了纯粹的重复。去掉后子视图与顶栏是同一套导航，也顺手消掉
   * 那个「点哪个返回」的歧义。
   *
   * hint 保留 —— 它是这一段设置的用途说明，顶栏放不下，仍有价值。
   */
  function subShell(title, hint, inner) {
    return '<div class="st-container mi-set-flow">' +
      (hint ? '<p class="mi-set-subview__hint mi-set-subview__hint--lead">' + esc(hint) + '</p>' : '') +
      inner +
    '</div>';
  }

  /*
   * 草稿的「基线校验」：草稿只在正式配置没有偏离记录基线时才有效。
   *
   * 为什么需要：草稿的使命是「用户切了模型但还没点保存」期间活过重绘；
   * 但如果正式配置在这之后被**外部**改动（导入备份 / 云同步 / 别的面板），
   * 旧草稿再压上去就会把面板锁死在旧选择上 —— 反向护栏被破坏。
   * 记录草稿那一刻的 cfg.model 作基线：配置仍等于基线 → 草稿继续有效；
   * 配置已偏离 → 草稿作废，面板跟随正式配置。
   * 保存成功 / 载入预设后会把基线重新对齐到已落盘的值，不影响正常流程。
   */
  function modelDraftPick(pick, base, curModel) {
    if (!pick) return '';
    return (base != null && base === String(curModel == null ? '' : curModel)) ? pick : '';
  }

  /*
   * ── 对话 API · 模型下拉的 options ────────────────────────────
   *
   * 与预设下拉同款「三层防御」的最内层：渲染时就**同步**带上
   * miyaApiModelCache 里该线路已有的模型列表（localStorage 同步读，
   * 不用等网络）。
   *
   * 为什么必须做：模型列表此前只活在 DOM 里 —— 点 ⟳ 拉回来填进
   * <select>，render() 一整块换 innerHTML 就没了，且没有任何机制
   * 把它长回来（applySubViewHydrate 只补预设下拉）。用户「拉列表 →
   * 切换模型 → 触发一次重绘（顶部保存 / 异步 scheduleRender）」之后，
   * 下拉只剩切换前的旧模型一个选项；再点保存，写回去的就是旧模型
   * —— 用户看到的就是「切换了模型，保存不住，又变回去了」。
   *
   * 保值规则（两条都为了堵「select 赋值静默失败」）：
   *   · selValue（草稿/当前选中）不在列表里 → 追加为 option；
   *   · curModel（正式配置里的模型）不在列表里 → 也追加。
   * 只要值在 options 里存在，selected 才挂得住；否则浏览器会把
   * select.value 悄悄置空，随后的保存就把模型清空写盘。
   */
  function modelSelectHtml(id, curModel, base, key, selValue) {
    var pick = selValue != null ? String(selValue).trim() : '';
    var current = String(curModel || '').trim();
    var ids = [];
    var cache = global.miyaApiModelCache;
    if (cache && cache.read) {
      var cached = cache.read(base, key);
      if (cached && cached.length) ids = cached.slice();
    }
    if (pick && ids.indexOf(pick) < 0) ids.push(pick);
    if (current && ids.indexOf(current) < 0) ids.push(current);
    if (!ids.length) {
      /* 没缓存也没配置：维持原版形态 —— 只有一个占位项 */
      return '<select class="ins-select" id="' + id + '">' +
        '<option value="">' + (current ? esc(current) : '选择模型') + '</option>' +
      '</select>';
    }
    ids.sort();
    var chosen = pick || current;
    return '<select class="ins-select" id="' + id + '">' +
      '<option value="">选择模型</option>' +
      ids.map(function (m) {
        return '<option value="' + esc(m) + '"' + (m === chosen ? ' selected' : '') + '>' + esc(m) + '</option>';
      }).join('') +
    '</select>';
  }

  function renderApiChatSub() {
    var cfg = (global.miyaGetApiConfigCached && global.miyaGetApiConfigCached()) || {};
    function num(v, d) { return v == null || v === '' ? d : v; }
    /*
     * 模型缓存按「表单里的线路」分桶（base + 密钥尾4位）。
     * 重绘时正式配置可能是**保存前**的旧值 —— 典型：用户在副线路里
     * 手填了网关和密钥、点了 ⟳ 拉到列表、还没点保存，一次重绘过来
     * cfg.fallbackBaseUrl 仍是空的，按配置找桶必然落空。
     * 而此刻**旧 DOM 还没被换掉**（renderSubView 的返回值还没写进
     * innerHTML），先把旧表单里的线路值抓出来当桶键；旧节点不存在
     * （首次渲染）才退回正式配置。
     */
    function prevVal(sel) {
      var el = pageEl ? pageEl.querySelector(sel) : null;
      return el ? String(el.value || '').trim() : null;
    }
    var prevBase = prevVal('#mq-api-base');
    var prevKey = prevVal('#mq-api-key');
    var prev2Base = prevVal('#mq-api2-base');
    var prev2Key = prevVal('#mq-api2-key');
    var mainBase = prevBase != null ? prevBase : (cfg.baseUrl || '');
    var mainKey = prevKey != null ? prevKey : (cfg.apiKey || '');
    var fbBase = prev2Base != null ? prev2Base : (cfg.fallbackBaseUrl || '');
    var fbKey = prev2Key != null ? prev2Key : (cfg.fallbackApiKey || '');
    /*
     * 结构与字段严格对齐「桌面设置 App → 对话」面板（迁移前的原版），
     * 分三段：接口预设 → 主线路 → 副线路。
     *
     * 合并进聊天设置时这三段被压缩重写，丢了四处东西：
     *   1. 整个「接口预设」区（下拉 + 命名 + 保存/删除）；
     *   2. 主线路、副线路的「拉取模型」⟳ 按钮的事件绑定；
     *   3. 副线路的温度滑块（原版主副线路各有一条）；
     *   4. 温度滑块与数字标签的实时联动。
     * 现按原版逐一补回，字段名沿用 mq-* 前缀以免与生图面板撞 id。
     */
    return subShell('对话 API', '对话模型服务端点与密钥。主线路失败时可自动切到副线路。',

      /* ── 接口预设（原版第一段）── */
      '<div class="st-form-card ins-form-block mi-set-subview__card">' +
        '<h4 class="st-form-section__title">接口预设</h4>' +
        '<label class="ins-field-label" for="mq-api-preset-pick">载入预设</label>' +
        '<div class="ins-inline-field">' +
          '<select class="ins-select" id="mq-api-preset-pick"><option value="">选择已存预设</option></select>' +
          '<button type="button" class="ins-icon-btn" id="mq-api-preset-delete" title="删除预设">×</button>' +
        '</div>' +
        '<label class="ins-field-label" for="mq-api-preset-name">预设名称</label>' +
        '<div class="ins-inline-field">' +
          '<input type="text" class="ins-text-input" id="mq-api-preset-name" placeholder="例如：备用线路" maxlength="64">' +
          '<button type="button" class="ins-icon-btn" id="mq-api-preset-save" title="保存预设">✓</button>' +
        '</div>' +
        '<p class="st-form-hint">保存主线路与副线路的全部字段；同名预设自动覆盖。选中下拉里的预设立即生效。</p>' +
        /*
         * 导出 / 导入。预设是用户一行行手打出来的线路配置，但此前只活在
         * 这台设备的浏览器存储里 —— 清一次站点数据就全没了。
         * 「导出全部预设」把整套线路（含密钥）落成一个 JSON 文件，
         * 「导入预设」在换设备 / 换浏览器时读回来，同名覆盖、新名追加。
         */
        '<div class="mi-btn-row mi-set-preset-actions">' +
          '<button type="button" class="st-action-btn" id="mq-api-preset-export">导出全部预设</button>' +
          '<button type="button" class="st-action-btn" id="mq-api-preset-import">导入预设</button>' +
        '</div>' +
        '<input type="file" class="ins-file" id="mq-api-preset-file" accept=".json,application/json" hidden>' +
        '<p class="st-form-hint">导出的文件包含密钥明文，请自行妥善保管，不要转发到公开场合。</p>' +
      '</div>' +

      /* ── 主线路（原版第二段）── */
      '<div class="st-form-card ins-form-block mi-set-subview__card">' +
        '<h4 class="st-form-section__title">主线路</h4>' +
        '<label class="ins-field-label" for="mq-api-base">网关地址</label>' +
        '<input type="text" class="ins-text-input" id="mq-api-base" placeholder="https://api.openai.com" autocomplete="off" spellcheck="false" value="' + esc(cfg.baseUrl || '') + '">' +
        '<label class="ins-field-label" for="mq-api-key">密钥</label>' +
        '<div class="ins-inline-field">' +
          '<input type="password" class="ins-text-input" id="mq-api-key" placeholder="sk-…" autocomplete="off" value="' + esc(cfg.apiKey || '') + '">' +
          '<button type="button" class="ins-icon-btn" id="mq-api-fetch" title="拉取模型">⟳</button>' +
        '</div>' +
        '<label class="ins-field-label" for="mq-api-model">模型</label>' +
        modelSelectHtml('mq-api-model', cfg.model, mainBase, mainKey,
          modelDraftPick(state.apiModelPick, state.apiModelPickBase, cfg.model)) +
        '<label class="ins-field-label">温度 <span id="mq-api-temp-lbl">' + esc(num(cfg.temperature, 1)) + '</span></label>' +
        '<input type="range" class="ins-range" id="mq-api-temp" min="0" max="2" step="0.1" value="' + esc(num(cfg.temperature, 1)) + '">' +
      '</div>' +

      /* ── 副线路（原版第三段）── */
      '<div class="st-form-card ins-form-block mi-set-subview__card">' +
        '<h4 class="st-form-section__title">副线路</h4>' +
        '<label class="ins-field-label" for="mq-api2-base">网关地址</label>' +
        '<input type="text" class="ins-text-input" id="mq-api2-base" placeholder="备用网关" autocomplete="off" spellcheck="false" value="' + esc(cfg.fallbackBaseUrl || '') + '">' +
        '<label class="ins-field-label" for="mq-api2-key">密钥</label>' +
        '<div class="ins-inline-field">' +
          '<input type="password" class="ins-text-input" id="mq-api2-key" placeholder="sk-…" autocomplete="off" value="' + esc(cfg.fallbackApiKey || '') + '">' +
          '<button type="button" class="ins-icon-btn" id="mq-api2-fetch" title="拉取模型">⟳</button>' +
        '</div>' +
        '<label class="ins-field-label" for="mq-api2-model">模型</label>' +
        modelSelectHtml('mq-api2-model', cfg.fallbackModel, fbBase, fbKey,
          modelDraftPick(state.apiModel2Pick, state.apiModel2PickBase, cfg.fallbackModel)) +
        '<label class="ins-field-label">温度 <span id="mq-api2-temp-lbl">' + esc(num(cfg.fallbackTemperature, 1)) + '</span></label>' +
        '<input type="range" class="ins-range" id="mq-api2-temp" min="0" max="2" step="0.1" value="' + esc(num(cfg.fallbackTemperature, 1)) + '">' +
        '<div class="st-toggle-in-form">' +
          '<strong>主线路失败时自动切换副线路</strong>' +
          '<button type="button" class="ins-toggle' + (cfg.fallbackEnabled ? ' is-on' : '') + '" id="mq-api-fallback" role="switch" aria-checked="' + (cfg.fallbackEnabled ? 'true' : 'false') + '"></button>' +
        '</div>' +
      '</div>' +

      '<div class="mi-btn-row mi-set-subview__actions">' +
        '<button type="button" class="st-action-btn st-action-btn--primary" data-mq-set-sub-save="api-chat">保存</button>' +
      '</div>'
    );
  }

  /* ── 对话 API · 接口预设 ──────────────────────────────────────
   *
   * 下拉渲染 + 载入 / 保存 / 删除三个动作。
   * 数据层是 js2/miya-api-config.js 的 global.miyaApiPresets
   * （load / upsert / remove / find / ensureReady），
   * 本模块只负责把它读出来画成下拉、把表单值写回去。
   */

  function presetPickEl() { return pageEl && pageEl.querySelector('#mq-api-preset-pick'); }

  function refreshApiPresetOptions(list) {
    var pick = presetPickEl();
    if (!pick) return;
    var names = (list || []).map(function (p) {
      return p && p.name ? String(p.name) : '';
    }).filter(Boolean);
    /*
     * 「当前选中哪一条」有两个来源，按可信度排序：
     *   1. 下拉此刻的 value —— 用户刚手动选的，最新；
     *   2. state.apiPresetPick —— 上一次的选中值，跨重绘留存。
     *
     * 为什么需要第 2 个：重绘会换出一个全新的 <select>，它的 value
     * 天然是空的。只认第 1 个的话，任何一次重绘都会把选中项抹成
     * 「选择已存预设」—— 用户就会觉得「我刚选的预设没了，还得重进」。
     */
    var current = pick.value || state.apiPresetPick || '';
    pick.innerHTML = '<option value="">选择已存预设</option>' +
      names.map(function (n) {
        return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
      }).join('');
    if (current && names.indexOf(current) >= 0) pick.value = current;
  }

  function hydrateApiPresets() {
    var mod = global.miyaApiPresets;
    var pick = presetPickEl();
    if (!mod || !pick) return;
    /* 先画缓存（如果有），避免每次进来都空一下再跳出来 */
    var cached = mod.getCached && mod.getCached();
    if (cached) refreshApiPresetOptions(cached);
    var ready = mod.ensureReady ? mod.ensureReady() : Promise.resolve([]);
    Promise.resolve(ready).then(function () {
      /* 期间用户可能已经返回列表，节点没了就安静退出 */
      if (!presetPickEl()) return;
      /*
       * ★ 必须重新读 getCached()，不能用 ensureReady() 的返回值。
       *
       * ensureReady() 历史上只保证「首轮加载完成」，它 resolve 的可能是
       * 首次加载时的空快照。直接拿它去画，会把刚保存出来的预设覆盖成空 ——
       * 表现就是「保存提示成功了，返回再进来预设没了」。
       * 数据层已改为 resolve 时重定向到当前缓存，但这里仍显式再取一次，
       * 双保险，也让意图清楚：要数据就读缓存。
       */
      var list = mod.getCached ? mod.getCached() : null;
      refreshApiPresetOptions(list || []);
    }).catch(function () {});
  }

  /*
   * ── 子视图的「延后填充」───────────────────────────────────────
   *
   * 为什么需要：render() 对子视图是整块换 innerHTML。而设置页有多处
   * 「先 scheduleRender() 排一次重绘，再往里补数据」的异步流程 ——
   * 典型是 open() 里 store.init() 落地后的那次重绘。
   *
   * 如果补数据是同步做的，它写得比下一次重绘早，会被整块换掉：
   * 节点还在（新渲染出来的那个），但里面是空的，而且**不会自己再长回来**。
   *
   * 踩过这个坑的地方（都是同一个病）：
   *   · api-chat        → 下拉框看似存着预设，进去却是空的
   *   · chat-defaults   → 面板整块空白，一个控件都没有
   *
   * 解法统一成：把填充排到下一帧，确保落在重绘之后。回调里重新校验
   * 子视图没被用户返回掉、目标节点确实还在，再做实际的填充。
   *
   * 注意必须是「下一帧」而不是「本帧末尾」：上面那次重绘本身也是
   * requestAnimationFrame 排的，同帧内同步执行会排在它前面，等于没修。
   */
  function scheduleSubViewHydrate() {
    var gen = state.subView;
    requestAnimationFrame(function () {
      /* 用户可能已经返回列表或切到别的子视图 */
      if (state.subView !== gen || !pageEl) return;
      applySubViewHydrate(gen);
    });
  }

  /*
   * 各子视图的实际填充动作。集中在一处，免得以后再有人漏掉某一个。
   * 每个分支都自带「节点还在不在」的检查 —— 重绘可能把节点换成新的，
   * 也可能因为状态变化根本没渲染出来。
   */
  function applySubViewHydrate(key) {
    if (key === 'api-chat') {
      if (presetPickEl()) hydrateApiPresets();
      /*
       * 模型下拉也要补：renderSubView 的静态骨架此刻只带着渲染瞬间
       * 读到的缓存列表，若渲染与 hydrate 之间缓存被更新（典型：点 ⟳
       * 的网络结果刚写完缓存，用户又触发了一次重绘），这里再同步读
       * 一次，保证下拉拿到的是最新的那份列表。幂等，节点不在就跳过。
       */
      hydrateChatModelOptions();
      return;
    }
    if (key === 'chat-defaults') {
      var host = pageEl.querySelector('[data-mq-set-defaults-host]');
      if (host && global.miyaChatSettingsPanel &&
          typeof global.miyaChatSettingsPanel.mountDefaultsInto === 'function') {
        global.miyaChatSettingsPanel.mountDefaultsInto(host);
      }
      return;
    }
    if (key === 'storage') {
      refreshStorageSub();
      return;
    }
    if (key === 'notify') {
      if (global.MiyaMsgSound && typeof global.MiyaMsgSound.onPanelOpen === 'function') {
        try { global.MiyaMsgSound.onPanelOpen(); } catch (e) {}
      }
      return;
    }
  }

  /* 从表单读一份完整快照（主 + 副线路） */
  function readApiFormSnapshot() {
    if (!pageEl) return null;
    function val(sel) {
      var el = pageEl.querySelector(sel);
      return el ? String(el.value || '').trim() : '';
    }
    function on(sel) {
      var el = pageEl.querySelector(sel);
      return !!(el && el.classList.contains('is-on'));
    }
    var temp = parseFloat(val('#mq-api-temp'));
    var temp2 = parseFloat(val('#mq-api2-temp'));
    return {
      baseUrl: val('#mq-api-base'),
      apiKey: val('#mq-api-key'),
      model: val('#mq-api-model'),
      temperature: Number.isFinite(temp) ? temp : 1,
      fallbackBaseUrl: val('#mq-api2-base'),
      fallbackApiKey: val('#mq-api2-key'),
      fallbackModel: val('#mq-api2-model'),
      fallbackTemperature: Number.isFinite(temp2) ? temp2 : 1,
      fallbackEnabled: on('#mq-api-fallback')
    };
  }

  /*
   * select 赋值：值在 options 里不存在时先追加一个 option 再赋值。
   *
   * 为什么不能直接 el.value = v：<select> 赋一个不存在的值会**静默失败**，
   * value 被浏览器置成 ''。预设刚载入时模型下拉通常只有一个旧模型的
   * option（用户还没点 ⟳ 拉列表），`set('#mq-api-model', p.model)` 失败后：
   *   · 表单上模型显示不对（预设明明带模型 B，下拉却是空的）；
   *   · 更糟的是用户随后点「保存」—— 表单快照读出 model='' 写进配置，
   *     把预设「选中即生效」刚写好的模型直接清空。
   * 这就是「切了预设/切换模型，一保存就没了」的另一半根源。
   */
  function setSelectValueKeepingOption(sel, v) {
    var el = pageEl.querySelector(sel);
    if (!el) return;
    var val = v == null ? '' : String(v);
    if (val) {
      var has = false;
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === val) { has = true; break; }
      }
      if (!has) {
        var opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        el.appendChild(opt);
      }
    }
    el.value = val;
  }

  /* 把一份预设写回表单。不改 state、不落盘 —— 用户随后点「保存」才生效，
     这样「载入」是一次可反悔的预览，符合预设的用法。 */
  function applyApiPresetToForm(p) {
    if (!pageEl || !p) return;
    function set(sel, v) {
      var el = pageEl.querySelector(sel);
      if (el) el.value = v == null ? '' : String(v);
    }
    set('#mq-api-base', p.baseUrl);
    set('#mq-api-key', p.apiKey);
    /* 模型是 <select>：option 不存在时赋值静默失败 → 先补 option（见上方说明） */
    setSelectValueKeepingOption('#mq-api-model', p.model);
    set('#mq-api2-base', p.fallbackBaseUrl);
    set('#mq-api2-key', p.fallbackApiKey);
    setSelectValueKeepingOption('#mq-api2-model', p.fallbackModel);
    var fb = pageEl.querySelector('#mq-api-fallback');
    if (fb) {
      fb.classList.toggle('is-on', !!p.fallbackEnabled);
      fb.setAttribute('aria-checked', p.fallbackEnabled ? 'true' : 'false');
    }
    if (p.temperature != null) {
      var t = pageEl.querySelector('#mq-api-temp');
      if (t) t.value = String(p.temperature);
      var lbl = pageEl.querySelector('#mq-api-temp-lbl');
      if (lbl) lbl.textContent = String(p.temperature);
    }
    if (p.fallbackTemperature != null) {
      var t2 = pageEl.querySelector('#mq-api2-temp');
      if (t2) t2.value = String(p.fallbackTemperature);
      var lbl2 = pageEl.querySelector('#mq-api2-temp-lbl');
      if (lbl2) lbl2.textContent = String(p.fallbackTemperature);
    }
  }

  /* 下拉选中即载入并**立即生效**（对齐桌面设置 App 的旧行为）
   *
   * ── 为什么改回「选中即生效」───────────────────────────────────
   *
   * 迁移到页内设置时，这里被改成「载入 = 预览，点保存才生效」。
   * 这个改动本意是给用户一次反悔机会，实际却造出了一个**只活在 DOM 里的
   * 中间态** —— 而 render() 对子视图是整块换 innerHTML，中间态必然被抹掉。
   * 用户看到的正是：「切换预设 → 点保存 → 变回切换之前的 URL 和 key」。
   *
   * 对照旧实现（js2/miya-settings-app.js 的 miya-st-preset-pick change）：
   *     setApiConfig(pr.config);      // ← 直接写正式配置，一步到位
   *     syncFormsFromConfig();
   * 旧版「好用的」根本原因不是它处理了什么边界，而是**它没有中间态**：
   * 选中就落地，之后重绘多少次都不影响结果。
   *
   * 所以这里回到同一套语义：载入 = 写配置 + 落盘 + 同步表单。
   * 既然正式配置当场就变了，之后无论怎么重绘，表单读到的都是新值，
   * 上一版为「保住未保存的中间态」而加的整套草稿机制也随之失去必要。
   *
   * 顺带解决另一个隐患：旧语义下用户切完预设忘记点保存，会静默不生效；
   * 现在切了就是切了，没有「以为生效其实没生效」的状态。
   */
  function loadApiPresetFromPick() {
    var mod = global.miyaApiPresets;
    var pick = presetPickEl();
    var name = pick ? String(pick.value || '').trim() : '';
    if (!mod || !name) return;
    mod.find(name).then(function (p) {
      if (!p) { toast('预设不存在'); return; }
      /* 写进正式配置并落盘 —— 这一步是「立即生效」的全部含义 */
      if (typeof global.miyaSetApiConfig === 'function') {
        global.miyaSetApiConfig(presetToConfigPatch(p));
      }
      applyApiPresetToForm(p);
      syncTempLabel('#mq-api-temp', '#mq-api-temp-lbl');
      syncTempLabel('#mq-api2-temp', '#mq-api2-temp-lbl');
      /* 选中项也记进 state：重绘后 <select> 是新的，靠它回填 */
      state.apiPresetPick = name;
      /* 模型草稿同步成预设里的值（基线一并对齐，配置此刻已等于预设值）
         —— 否则下一次重绘会用旧草稿把刚载入的模型选中态覆盖回旧模型 */
      state.apiModelPick = p.model != null ? String(p.model) : '';
      state.apiModelPickBase = state.apiModelPick;
      state.apiModel2Pick = p.fallbackModel != null ? String(p.fallbackModel) : '';
      state.apiModel2PickBase = state.apiModel2Pick;
      var nameEl = pageEl && pageEl.querySelector('#mq-api-preset-name');
      if (nameEl) nameEl.value = name;
      toast('已载入：' + name);
    }).catch(function () { toast('载入失败'); });
  }

  /*
   * 预设条目 → miyaSetApiConfig 的 patch。字段名与表单快照保持一致，
   * 这样「保存预设」写进去的形状和「载入预设」读出来的形状永远对称。
   */
  function presetToConfigPatch(p) {
    if (!p) return {};
    var out = {};
    if (p.baseUrl != null) out.baseUrl = String(p.baseUrl);
    if (p.apiKey != null) out.apiKey = String(p.apiKey);
    if (p.model != null) out.model = String(p.model);
    if (p.temperature != null) out.temperature = p.temperature;
    if (p.fallbackBaseUrl != null) out.fallbackBaseUrl = String(p.fallbackBaseUrl);
    if (p.fallbackApiKey != null) out.fallbackApiKey = String(p.fallbackApiKey);
    if (p.fallbackModel != null) out.fallbackModel = String(p.fallbackModel);
    if (p.fallbackTemperature != null) out.fallbackTemperature = p.fallbackTemperature;
    out.fallbackEnabled = !!p.fallbackEnabled;
    return out;
  }

  function saveApiPreset() {
    var mod = global.miyaApiPresets;
    if (!mod) { toast('预设模块未加载'); return; }
    var nameEl = pageEl && pageEl.querySelector('#mq-api-preset-name');
    var name = nameEl ? String(nameEl.value || '').trim() : '';
    if (!name) { toast('请输入预设名称'); return; }
    var snap = readApiFormSnapshot();
    if (!snap || (!snap.baseUrl && !snap.apiKey && !snap.model)) {
      toast('请先填写接口信息');
      return;
    }
    mod.upsert(name, snap).then(function (list) {
      refreshApiPresetOptions(list);
      state.apiPresetPick = name;
      var pick = presetPickEl();
      if (pick) pick.value = name;
      toast('预设已保存');
    }).catch(function () { toast('保存失败'); });
  }

  function deleteApiPreset() {
    var mod = global.miyaApiPresets;
    if (!mod) { toast('预设模块未加载'); return; }
    var pick = presetPickEl();
    var name = pick ? String(pick.value || '').trim() : '';
    if (!name) {
      var nameEl = pageEl && pageEl.querySelector('#mq-api-preset-name');
      name = nameEl ? String(nameEl.value || '').trim() : '';
    }
    if (!name) { toast('请先选择要删除的预设'); return; }
    mod.remove(name).then(function (list) {
      state.apiPresetPick = '';       /* 删掉的这条不该再被回填 */
      refreshApiPresetOptions(list);
      var p = presetPickEl();
      if (p) p.value = '';
      var n = pageEl && pageEl.querySelector('#mq-api-preset-name');
      if (n) n.value = '';
      toast('已删除：' + name);
    }).catch(function () { toast('删除失败'); });
  }

  /* ── 对话 API · 预设的导出 / 导入 ─────────────────────────────
   *
   * 数据层是 js2/miya-api-config.js 的 global.miyaApiPresetsExport
   * （exportAll / importFromFile），本模块只负责按钮、文件选择与提示。
   * 这样分工的理由与 upsert/remove 一致：数据层不该知道 DOM 长什么样。
   */

  function exportApiPresets() {
    var mod = global.miyaApiPresetsExport;
    if (!mod || typeof mod.exportAll !== 'function') { toast('预设模块未加载'); return; }
    mod.exportAll().then(function (r) {
      if (!r || !r.ok) {
        if (r && r.reason === 'empty') toast('还没有可导出的预设');
        else toast('导出失败');
        return;
      }
      toast('已导出 ' + r.count + ' 条预设');
    }).catch(function () { toast('导出失败'); });
  }

  function importApiPresets(file) {
    var mod = global.miyaApiPresetsExport;
    if (!mod || typeof mod.importFromFile !== 'function') { toast('预设模块未加载'); return; }
    mod.importFromFile(file).then(function (r) {
      if (!r || !r.ok) {
        var msg = {
          invalid_json: '文件不是有效的 JSON',
          invalid_format: '文件格式不对，应为预设导出文件',
          empty: '文件里没有可导入的预设',
          read_failed: '读取文件失败',
          save_failed: '写入失败，请检查存储空间'
        }[r && r.reason] || '导入失败';
        toast(msg);
        return;
      }
      /* 下拉要立刻反映导入结果，否则用户会以为没进来 */
      var list = global.miyaApiPresets && global.miyaApiPresets.getCached
        ? global.miyaApiPresets.getCached()
        : null;
      if (list) refreshApiPresetOptions(list);
      var parts = [];
      if (r.added) parts.push('新增 ' + r.added + ' 条');
      if (r.updated) parts.push('覆盖 ' + r.updated + ' 条');
      toast('已导入：' + (parts.length ? parts.join('，') : '无变化'));
    }).catch(function () { toast('导入失败'); });
  }

  /* ── 对话 API · 重绘后回填模型下拉 ────────────────────────────
   *
   * 供 applySubViewHydrate('api-chat') 调用：从 miyaApiModelCache
   * 同步读出该线路（baseUrl + 密钥尾4位 分桶）的列表，填进下拉。
   * 与渲染层（modelSelectHtml）同源同一份缓存，这里只负责把
   * 「渲染之后才落到缓存里的新列表」补上，属于幂等的第二层防御。
   *
   * 保值规则与 fetchChatModels.applyOptions 一致：当前选中值不在
   * 列表里就追加为 option，绝不退回空 —— select.value 一旦被置空，
   * 用户下一次点「保存」就会把模型清空写进配置。
   */
  function hydrateChatModelOptions() {
    if (!pageEl) return;
    var cache = global.miyaApiModelCache;
    if (!cache || typeof cache.read !== 'function') return;
    function fill(selId, baseId, keyId) {
      var selEl = pageEl.querySelector(selId);
      if (!selEl) return;
      var baseEl = pageEl.querySelector(baseId);
      var keyEl = pageEl.querySelector(keyId);
      var ids = cache.read(baseEl ? baseEl.value : '', keyEl ? keyEl.value : '');
      if (!ids || !ids.length) return;
      var current = String(selEl.value || '').trim();
      if (current && ids.indexOf(current) < 0) ids = ids.concat([current]);
      selEl.innerHTML = '<option value="">选择模型</option>' + ids.map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
      }).join('');
      if (current) selEl.value = current;
    }
    fill('#mq-api-model', '#mq-api-base', '#mq-api-key');
    fill('#mq-api2-model', '#mq-api2-base', '#mq-api2-key');
  }

  /* ── 对话 API · 拉取模型 ──────────────────────────────────────
   *
   * 与生图面板同款：GET {root}/models，Bearer 用密钥。
   * 取回来的 id 列表填进对应下拉，并把当前值保住。
   *
   * 结果同时写进 miyaApiModelCache（按 `baseUrl|密钥尾4位` 分桶），
   * 下次进来能先出缓存，不必再点一次 ⟳ —— 这正是那个缓存模块
   * 当初存在的理由，只是设置 App 删除后没人再调用它。
   *
   * which: 'main' | 'fallback'，分别对应主线路与副线路。
   */
  function fetchChatModels(which) {
    if (!pageEl) return;
    var isMain = which !== 'fallback';
    function val(sel) {
      var el = pageEl.querySelector(sel);
      return el ? String(el.value || '').trim() : '';
    }
    var base = val(isMain ? '#mq-api-base' : '#mq-api2-base');
    var key = val(isMain ? '#mq-api-key' : '#mq-api2-key');
    var selEl = pageEl.querySelector(isMain ? '#mq-api-model' : '#mq-api2-model');
    if (!selEl) return;

    if (typeof global.miyaOpenAiApiRoot !== 'function') {
      toast('API 模块未就绪');
      return;
    }
    var root = global.miyaOpenAiApiRoot(base);
    if (!root) { toast('请先填写网关地址'); return; }

    var btn = pageEl.querySelector(isMain ? '#mq-api-fetch' : '#mq-api2-fetch');
    if (btn) btn.disabled = true;

    function applyOptions(ids) {
      if (!ids || !ids.length) { toast('没有取到模型'); return; }
      var current = String(selEl.value || '').trim();
      /*
       * 当前值不在列表里也**追加为 option 保住**，而不是退回占位项。
       * 原先的 `: ''` 会把 select.value 悄悄置空 —— 用户拉一次列表，
       * 已选好的模型就没了；随后点「保存」，model 以空串写进配置，
       * 表现就是「模型保存不了 / 莫名被清空」。
       */
      if (current && ids.indexOf(current) < 0) ids = ids.concat([current]);
      selEl.innerHTML = '<option value="">选择模型</option>' + ids.map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
      }).join('');
      selEl.value = current;
      toast('已获取 ' + ids.length + ' 个模型');
    }

    /* 先出缓存 —— 点一下立刻有东西，网络结果回来再覆盖。
     *
     * ⚠️ 参数形状必须是 (base, key)：read/write 内部自己算分桶
     * （openAiCompatibleApiRoot(base) + '|' + 密钥尾4位）。
     * 原先这里写成 cache.read(cache.bucket(base, key)) /
     * cache.write(cache.bucket(base, key), ids) —— 把算好的桶串
     * 当 base 传进去，函数内部会再归一化一次（还会拼出
     * `…/v1|aaaa/v1` 这种废 key），write 那侧更直接：
     * 第二个参数（被当成 key）是 ids 数组，真正的 ids 参数是
     * undefined，`!ids` 一挡就 return —— **缓存从未写入过**。
     * 表现：点 ⟳ 当场有列表，任何一次重绘后列表必丢（渲染层
     * 读到的缓存永远是空的），模型下拉退化成只剩当前模型一个
     * 选项，用户切换的模型随之被抹回旧值 —— 「保存不了」。 */
    var cache = global.miyaApiModelCache;
    var cachedIds = null;
    if (cache && cache.read) {
      cachedIds = (cache.read(base, key) || null);
      if (cachedIds && cachedIds.length) applyOptions(cachedIds);
    }

    fetch(root + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var ids = Array.isArray(j && j.data) ? j.data.map(function (x) {
        return x && x.id ? String(x.id) : '';
      }).filter(Boolean).sort() : [];
      if (!ids.length) throw new Error('empty');
      if (cache && cache.write) cache.write(base, key, ids);
      applyOptions(ids);
    }).catch(function (err) {
      /* 有缓存就先别打扰用户 —— 屏幕上已经有可选模型了 */
      if (cachedIds && cachedIds.length) return;
      toast('获取失败：' + (err && err.message ? err.message : '网络错误'));
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  /*
   * MiniMax TTS 目前公开的语音模型清单。
   * TTS 没有标准的「拉模型列表」接口（/models 是对话 API 的），
   * 所以这里给内置清单而不是 ⟳ 拉取 —— 之前只渲染当前值一个 option，
   * 模型只能看不能换。若配置里存着清单外的值（旧模型 / 新发布的模型），
   * 按「当前值保值」原则追加 option，绝不静默清空。
   */
  var VOICE_MODEL_PRESETS = [
    'speech-01-hd', 'speech-01-turbo', 'speech-02-hd', 'speech-02-turbo'
  ];

  function voiceModelSelectOptions(curModel) {
    var ids = VOICE_MODEL_PRESETS.slice();
    var cur = String(curModel || '').trim();
    if (cur && ids.indexOf(cur) < 0) ids.push(cur);
    return '<option value="">选择模型</option>' + ids.map(function (id) {
      return '<option value="' + esc(id) + '"' + (id === cur ? ' selected' : '') + '>' + esc(id) + '</option>';
    }).join('');
  }

  function renderApiVoiceSub() {
    var cfg = (global.miyaGetApiConfigCached && global.miyaGetApiConfigCached()) || {};
    var tts = cfg.minimaxTts || {};
    function num(v, d) { return v == null || v === '' ? d : v; }
    return subShell('语音合成', 'MiniMax TTS。角色「语音朗读」开启后使用这里的配置。',
      '<div class="st-form-card ins-form-block mi-set-subview__card">' +
        '<label class="ins-field-label" for="mq-voice-key">MiniMax 密钥</label>' +
        '<input type="password" class="ins-text-input" id="mq-voice-key" placeholder="填入 API 密钥" autocomplete="off" value="' + esc(tts.apiKey || '') + '">' +
        '<label class="ins-field-label" for="mq-voice-group">群组 ID</label>' +
        '<input type="text" class="ins-text-input" id="mq-voice-group" placeholder="控制台群组 ID" autocomplete="off" value="' + esc(tts.groupId || '') + '">' +
        '<label class="ins-field-label" for="mq-voice-model">语音模型</label>' +
        '<select class="ins-select" id="mq-voice-model">' + voiceModelSelectOptions(tts.model) + '</select>' +
        '<label class="ins-field-label">语速 <span id="mq-voice-speed-lbl">' + esc(num(tts.speed, 1)) + '</span></label>' +
        '<input type="range" class="ins-range" id="mq-voice-speed" min="0.5" max="2" step="0.1" value="' + esc(num(tts.speed, 1)) + '">' +
        '<label class="ins-field-label">音量 <span id="mq-voice-vol-lbl">' + esc(num(tts.volume, 1)) + '</span></label>' +
        '<input type="range" class="ins-range" id="mq-voice-vol" min="0.1" max="2" step="0.1" value="' + esc(num(tts.volume, 1)) + '">' +
        '<label class="ins-field-label">音调 <span id="mq-voice-pitch-lbl">' + esc(num(tts.pitch, 0)) + '</span></label>' +
        '<input type="range" class="ins-range" id="mq-voice-pitch" min="-12" max="12" step="1" value="' + esc(num(tts.pitch, 0)) + '">' +
        '<label class="ins-field-label" for="mq-voice-prompt">语音专用提示词</label>' +
        '<textarea class="ins-text-input ins-text-input--area" id="mq-voice-prompt" rows="3" placeholder="合成前附加到台词前，留空则不附加">' + esc(tts.prompt || '') + '</textarea>' +
        '<p class="st-form-hint">音调调低更沉稳自然，调高更年轻清亮；改动后已合成的语音会自动重新生成</p>' +
      '</div>' +
      '<div class="mi-btn-row mi-set-subview__actions">' +
        '<button type="button" class="st-action-btn st-action-btn--primary" data-mq-set-sub-save="api-voice">保存</button>' +
      '</div>'
    );
  }

  /*
   * 聊天默认值：内容不在这里拼 HTML，而是给 miyaChatSettingsPanel
   * 一个容器让它自己渲染。原因：这块表单读写的字段（memoryCount /
   * summaryTrigger / backgroundMessage…）与 per-contact 覆盖层
   * 的规则都封装在那个模块里，在这里重写一份必然会出现两边不一致。
   */
  function renderChatDefaultsSub() {
    if (!global.miyaChatSettingsPanel || !global.miyaChatSettingsPanel.mountDefaultsInto) {
      return subShell('聊天默认值', '', '<p class="mi-empty-hint">设置模块未加载，请刷新页面</p>');
    }
    return subShell('聊天默认值', '未单独设置过的联系人，统一使用这里的记忆与后台配置。',
      '<div data-mq-set-defaults-host></div>'
    );
  }

  function renderBackupSub() {
    return subShell('备份与恢复', '导出会包含对话、设置与主题；完整导出额外带上聊天图片与提示音。',
      '<div class="st-card mi-set-action-card">' +
        '<button type="button" class="st-card-row" data-mq-set-backup-export>' +
          '<div class="st-card-row-left"><div>' +
            '<div class="st-card-label">导出数据</div>' +
            '<div class="st-card-desc">轻量 ZIP：对话、设置与主题</div>' +
          '</div></div>' +
          '<img class="mi-ico-img st-chevron" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
        '</button>' +
        '<button type="button" class="st-card-row" data-mq-set-backup-export-full>' +
          '<div class="st-card-row-left"><div>' +
            '<div class="st-card-label">完整导出</div>' +
            '<div class="st-card-desc">额外含聊天图片与提示音，体积较大</div>' +
          '</div></div>' +
          '<img class="mi-ico-img st-chevron" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
        '</button>' +
        '<button type="button" class="st-card-row" data-mq-set-backup-import>' +
          '<div class="st-card-row-left"><div>' +
            '<div class="st-card-label">导入数据</div>' +
            '<div class="st-card-desc">从 ZIP 或 JSON 备份恢复</div>' +
          '</div></div>' +
          '<img class="mi-ico-img st-chevron" src="img/icons/chevron-right.svg" alt="" width="18" height="18">' +
        '</button>' +
      '</div>' +
      '<input type="file" class="ins-file" data-mq-set-backup-file accept=".zip,.json,application/zip,application/json" multiple hidden>' +
      '<p class="st-form-hint">导入会覆盖同名数据，建议先导出一次留底。</p>'
    );
  }

  function renderStorageSub() {
    /*
     * 只做用量统计，**不提供清空全部数据**。
     * 原先那个一键 clear() 就摆在面板底部，离谱的地方在于：
     * 旁边写的是「用量统计」，用户的注意力在「看看占了多少」，
     * 结果底下是个全清按钮。已按需求删除该功能。
     */
    return subShell('存储用量', '本机数据按模块的占用概览。',
      '<div class="st-storage-head">' +
        '<p class="ins-vault-note" data-mq-set-storage-quota>正在扫描…</p>' +
        '<button type="button" class="st-foot-btn" data-mq-set-storage-refresh>重新扫描</button>' +
      '</div>' +
      '<div class="st-form-card">' +
        '<div class="ins-meter-list" data-mq-set-storage-groups><p class="mi-empty-hint">正在计算…</p></div>' +
      '</div>' +
      '<div class="ins-storage-images" data-mq-set-storage-images></div>' +
      '<div class="mi-btn-row" data-mq-set-storage-img-actions hidden>' +
        '<button type="button" class="st-action-btn" data-mq-set-storage-img-compress>一键压缩图片</button>' +
        '<button type="button" class="st-action-btn" data-mq-set-storage-img-clear>清空聊天图片</button>' +
      '</div>'
    );
  }

  /*
   * 通知与提示音子视图。
   *
   * ── 结构与来源 ────────────────────────────────────────────────
   *
   * 它对应桌面设置 App 里的两块内容，合并时被压扁成「两个裸卡片」，
   * 丢掉了原版的骨架：
   *
   *   1. 系统通知那一行原版是 .st-card-row + 图标 + label/desc，
   *      带 st-section-label 小标题分组，而不是一个光秃秃的 toggle；
   *   2. 原版有一整张「通知预览」feature card（st-deco-number 角标
   *      04 + st-notify-demo 两条模拟通知 + 带图标的测试按钮），
   *      这次合并没有搬过来，等于整块内容消失；
   *   3. 提示音面板原版用 st-form-section 包住「内置预设」「自定义预设」
   *      两段，列表本身是 st-form-card —— 压扁后 section 包装没了，
   *      标题与列表的层级关系就散了。
   *
   * 现按原版骨架重建。注意两条硬约束：
   *
   *   · id 一个都不能改。#miya-st-sw-msgsound / #miya-st-msgsound-presets
   *     / #miya-st-msgsound-custom-list / #miya-st-msgsound-upload 等是
   *     miya-msg-sound.js 用 getElementById 全局查找的，不是事件委托，
   *     改了会静默失效（点了没反应但不报错）。
   *   · #mq-notify-sw 与 [data-mq-notify-test] 是本文件事件委托的钩子，
   *     runNotifyTest() 里也会回写 #mq-notify-sw 的 is-on 状态。
   */
  function renderNotifySub() {
    var prefs = (global.miyaGetSystemPrefs && global.miyaGetSystemPrefs()) || {};
    var perm = global.miyaGetNotificationPermission ? global.miyaGetNotificationPermission() : 'unsupported';
    var permText = {
      granted: '已授权，通知可正常送达',
      denied: '已被拒绝，请在浏览器设置中允许',
      'default': '尚未询问，点「测试通知」时会请求权限',
      unsupported: '当前环境不支持系统通知'
    }[perm] || perm;

    return subShell('通知与提示音', '系统通知开关、测试与来消息提示音。',

      /* ── 系统通知（原版「系统」分组）── */
      '<div class="st-section-label">系统</div>' +
      '<div class="st-form-card ins-form-block mi-set-subview__card">' +
        '<div class="st-card-row st-card-row--static">' +
          '<div class="st-card-row-left">' +
            '<div class="st-card-icon st-card-icon--warm">' +
              '<img class="mi-ico-img" src="img/icons/message-chat-square.svg" alt="" width="18" height="18">' +
            '</div>' +
            '<div>' +
              '<div class="st-card-label">系统通知</div>' +
              '<div class="st-card-desc">推送提醒与角标更新</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="ins-toggle' + (prefs.notify ? ' is-on' : '') + '" id="mq-notify-sw" role="switch" aria-checked="' + (prefs.notify ? 'true' : 'false') + '"></button>' +
        '</div>' +
        '<p class="st-form-hint">当前权限：' + esc(permText) + '</p>' +
      '</div>' +

      /* ── 通知预览（原版 04 号 feature card）── */
      '<div class="st-feature-card">' +
        '<div class="st-deco-number">04</div>' +
        '<div class="st-feature-header">' +
          '<div>' +
            '<div class="st-feature-title">通知 <em>预览</em></div>' +
            '<div class="st-feature-subtitle">测试你的提醒配置</div>' +
          '</div>' +
        '</div>' +
        '<div class="st-notify-demo">' +
          '<div class="st-notify-item">' +
            '<div class="st-notify-avatar">' +
              '<img class="mi-ico-img" src="img/icons/user-02.svg" alt="" width="18" height="18">' +
            '</div>' +
            '<div class="st-notify-content">' +
              '<div class="st-notify-title">新消息</div>' +
              '<div class="st-notify-text">今晚有空吗？</div>' +
            '</div>' +
            '<div class="st-notify-time">刚刚</div>' +
          '</div>' +
          '<div class="st-notify-item">' +
            '<div class="st-notify-avatar">' +
              '<img class="mi-ico-img" src="img/icons/message-chat-square.svg" alt="" width="18" height="18">' +
            '</div>' +
            '<div class="st-notify-content">' +
              '<div class="st-notify-title">系统提醒</div>' +
              '<div class="st-notify-text">通知权限已就绪</div>' +
            '</div>' +
            '<div class="st-notify-time">2 分钟</div>' +
          '</div>' +
        '</div>' +
        '<div class="st-btn-row">' +
          '<button type="button" class="st-action-btn st-action-btn--primary" data-mq-notify-test>' +
            '<img class="mi-ico-img" src="img/icons/message-chat-square.svg" alt="" width="16" height="16">' +
            '测试通知' +
          '</button>' +
        '</div>' +
      '</div>' +

      /* ── 提示音（原版独立面板 miya-st-panel-msg-sound）── */
      '<div class="ins-form-block mi-set-subview__card" id="miya-st-panel-msg-sound">' +
        '<div class="st-form-card">' +
          '<div class="st-toggle-in-form">' +
            '<strong>启用提示音</strong>' +
            '<button type="button" class="ins-toggle" id="miya-st-sw-msgsound" role="switch" aria-checked="true"></button>' +
          '</div>' +
          '<p class="st-form-hint">收到新消息时播放（当前聊天界面内不响）。生图完成、线下场景写完后也会用同一个提示音提醒你。</p>' +
        '</div>' +
        '<section class="st-form-section">' +
          '<h4 class="st-form-section__title">内置预设</h4>' +
          '<div class="st-form-card st-msgsound-list" id="miya-st-msgsound-presets"></div>' +
        '</section>' +
        '<section class="st-form-section">' +
          '<h4 class="st-form-section__title">自定义预设</h4>' +
          '<div class="st-form-card ins-form-block">' +
            '<p class="st-form-hint">上传本地音频（最大 1MB），保存后可作为提示音</p>' +
            '<button type="button" class="st-action-btn st-action-btn--primary st-msgsound-upload-btn" id="miya-st-msgsound-upload">上传音频</button>' +
            '<input type="file" class="ins-file" id="miya-st-msgsound-file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac,.flac,.opus,.webm" hidden>' +
            '<div class="st-msgsound-list" id="miya-st-msgsound-custom-list"></div>' +
          '</div>' +
        '</section>' +
      '</div>'
    );
  }


  /* 打开子视图 */
  function openSubView(key) {
    if (!SUB_VIEW_TITLES[key]) return;
    state.subView = key;
    render({ skipContextUsage: true });
    /*
     * 这里必须同步先填一次。
     *
     * 为什么不等延后那次就够了：正常点击进入时，上面这行 render 之后
     * **不会再有任何重绘**（open() 的异步重绘只在冷启动那一次发生）。
     * 只安排延后填充、不做同步填充的话，用户会看到「点了没反应」，
     * 要等下一帧才出内容，白白闪一下。
     *
     * 同步这次负责把常规路径点亮，延后那次负责兜住「随后到来的重绘」。
     * 两次都是幂等的（整块重写 / 重读），重复执行没有副作用。
     */
    applySubViewHydrate(key);
    scheduleSubViewHydrate();
  }

  function closeSubView() {
    /*
     * ★ 这里**不能**清草稿 —— 这是修 bug 时最容易想当然的一步。
     *
     * 一开始我以为「返回 = 放弃未保存的编辑」，就顺手清了。但那样核心
     * 路径依然是坏的：
     *     载入线路B → 返回 → 再进来 → 点保存   → 还是写回线路A
     * 因为用户「返回再进来」看到的就是被弹回 A，他自然会以为切换丢了、
     * 再点一次保存 —— 结果把 A 又写了一遍。用户的报障原话正是
     * 「一点保存却没切换成功，变回来切换之前的 URL 和 key」。
     *
     * 所以正确的语义是：**载入预设 / 手改字段之后的表单内容，只要还没被
     * 保存，就应该跨重绘存活**，无论这次重绘是来自返回、切子视图还是
     * 后台的异步 open()。这与页面级 formDraft 的行为也一致 ——
     * formDraft 在子视图往返期间同样会回填（见 render 的非子视图分支）。
     *
     * 草稿何时清：
     *   · 点「保存」成功 → 正式配置已等于表单，草稿使命结束
     *   · 关掉整个设置页（close）→ 整体丢弃
     *   · 同会话切换 chatId（open）→ 丢弃，避免把 A 会话的线路带到 B 会话
     */
    state.subView = null;
    render({ skipContextUsage: true });
  }

  /* 原先这里有一个只服务 storage 的 scheduleStorageSubRefresh。
     现在三种「延后填充」（api-chat / chat-defaults / storage）统一走
     scheduleSubViewHydrate + applySubViewHydrate，单独这一个已无调用点，
     留着只会让人以为 storage 走的是另一套逻辑。 */

  /* 图片清理动作：点击时按需收集（不缓存 blob 引用），操作完成后刷新统计 */
  function storageImgActionsBusy(busy) {
    if (!pageEl) return;
    pageEl.querySelectorAll('[data-mq-set-storage-img-compress],[data-mq-set-storage-img-clear]').forEach(function (b) {
      b.disabled = !!busy;
    });
  }

  function withStorageImages(label, run) {
    var su = global.miyaStorageUsage;
    if (!su || typeof su.collectChatMediaImages !== 'function') return;
    storageImgActionsBusy(true);
    su.collectChatMediaImages().then(function (list) {
      /* 注意：collectChatMediaImages 返回的是 { items, totalBytes, count }，
         没有 length 字段 —— 用 list.count 判断，别写 list.length */
      if (!list || !list.count) { toast('没有可处理的聊天图片'); return null; }
      return run(su, list);
    }).catch(function () {
      toast(label + '失败');
    }).then(function () {
      storageImgActionsBusy(false);
      refreshStorageSub();
    });
  }

  function compressStorageImages() {
    withStorageImages('压缩', function (su, list) {
      toast('正在压缩 ' + list.count + ' 张图片…');
      return su.compressAllChatImages(list.items).then(function (res) {
        toast('已压缩 ' + ((res && res.ok) || 0) + ' 张，节省 ' + su.formatBytes((res && res.saved) || 0));
      });
    });
  }

  function clearStorageImages() {
    withStorageImages('清空', function (su, list) {
      return dialog({
        mode: 'confirm',
        title: '清空聊天图片',
        message: '将删除全部 ' + list.count + ' 张聊天图片（聊天记录本身不受影响），不可恢复。是否继续？',
        confirmText: '清空',
        cancelText: '取消'
      }).then(function (ok) {
        if (!ok) return null;
        return su.deleteAllChatImages(list.items).then(function (res) {
          toast('已删除 ' + ((res && res.ok) || 0) + ' 张图片');
        });
      });
    });
  }

  function refreshStorageSub() {
    if (!pageEl || state.subView !== 'storage') return;
    var su = global.miyaStorageUsage;
    if (!su) return;
    /*
     * collect(true) 是异步的，耗时期间任何一次重绘（后台上下文统计、
     * store 更新触发的 scheduleRender）都会把子视图 DOM 整个换掉。
     * 所以所有节点引用都在回调里**重新查询**，绝不使用进入函数时的
     * 旧引用 —— 旧引用会把扫描结果写进已成孤儿的节点，表现就是
     * 「点了重新扫描没反应」。图片分支同理（它还有第二层异步）。
     */
    su.collect(true).then(function (ctx) {
      if (!pageEl || state.subView !== 'storage') return;
      var groupsEl = pageEl.querySelector('[data-mq-set-storage-groups]');
      var quotaEl = pageEl.querySelector('[data-mq-set-storage-quota]');
      var imagesEl = pageEl.querySelector('[data-mq-set-storage-images]');
      if (!groupsEl) return;
      var rows = (su.CATALOG || []).map(function (c) {
        var b = (ctx.groupLs && ctx.groupLs[c.id]) || 0;
        var pct = ctx.stableTotal > 0 ? Math.round(b / ctx.stableTotal * 100) : 0;
        return '<div class="ins-meter-row">' +
          '<div class="ins-meter-label"><span>' + esc(c.title) + '</span><span>' + esc(su.formatBytes(b)) + '</span></div>' +
          '<div class="ins-meter-bar"><div class="ins-meter-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
      }).join('');
      groupsEl.innerHTML = rows || '<p class="mi-empty-hint">暂无数据</p>';
      if (quotaEl) {
        quotaEl.textContent = ctx.quota > 0
          ? '小手机本地数据合计 ' + su.formatBytes(ctx.stableTotal) + ' / ' + su.formatBytes(ctx.quota)
          : '小手机本地数据合计 ' + su.formatBytes(ctx.stableTotal);
      }
      if (!imagesEl || typeof su.collectChatMediaImages !== 'function') return;
      su.collectChatMediaImages().then(function (list) {
        if (!pageEl || state.subView !== 'storage') return;
        /* 第二层异步：同样重新查询（第一次查询后仍可能发生重绘） */
        var imagesEl2 = pageEl.querySelector('[data-mq-set-storage-images]');
        var actionsEl = pageEl.querySelector('[data-mq-set-storage-img-actions]');
        if (!imagesEl2) return;
        if (!list || !list.count) {
          imagesEl2.innerHTML = '<p class="mi-empty-hint">聊天里还没有本地图片</p>';
          if (actionsEl) actionsEl.hidden = true;
          return;
        }
        /* 只显示数量与占用；图片清单在点压缩/清空时按需重新收集，
           不在这里长期持有 blob 引用（几百张图会把内存吃满）。 */
        imagesEl2.innerHTML = '<p class="ins-field-label ins-field-label--section">聊天图片（' + list.count + ' 张，约 ' + esc(su.formatBytes(list.totalBytes)) + '）</p>' +
          '<p class="st-form-hint">压缩：转为 JPG（最长边 1280），聊天记录不受影响。清空：删除全部图片，不可恢复。</p>';
        if (actionsEl) actionsEl.hidden = false;
      }).catch(function () {
        if (state.subView !== 'storage' || !pageEl) return;
        var imagesEl2 = pageEl.querySelector('[data-mq-set-storage-images]');
        var el = pageEl.querySelector('[data-mq-set-storage-img-actions]');
        if (imagesEl2) imagesEl2.innerHTML = '';
        if (el) el.hidden = true;
      });
    }).catch(function () {
      if (!pageEl || state.subView !== 'storage') return;
      var groupsEl = pageEl.querySelector('[data-mq-set-storage-groups]');
      if (groupsEl) groupsEl.innerHTML = '<p class="mi-empty-hint">统计失败</p>';
    });
  }

  function render(opts) {
    opts = opts || {};
    if (!pageEl) return;
    var body = pageEl.querySelector('[data-mq-set-body]');
    if (!body) return;

    /* 子视图：整页换内容，不参与 zone 状态与草稿的采集 */
    if (state.subView) {
      var titleEl = pageEl.querySelector('.st-navtitle');
      if (titleEl) titleEl.textContent = SUB_VIEW_TITLES[state.subView] || '聊天设置';
      body.innerHTML = renderSubView(state.subView);
      body.scrollTop = 0;
      /*
       * ★ 重绘之后必须补一次 hydrate。
       *
       * renderSubView() 只吐出**静态骨架**：预设下拉此刻只有一条占位项
       * （<option value="">选择已存预设</option>），真正的选项要靠
       * hydrateApiPresets() 异步从缓存/磁盘读出来再填。
       *
       * 之前这里 `return` 得太干脆，没有补 hydrate —— 于是任何一次
       * 「子视图还开着时触发的重绘」都会把下拉打回空骨架，而且**不会
       * 再长回来**。最容易踩中的入口是**顶部导航栏那个「保存」**：
       *   saveForm() → scheduleRender({fromStore:true}) → render() → 到这里
       * 用户看到的就是「点保存，已存预设全没了」，可磁盘里数据完好，
       * 所以「重进（走 openSubView → scheduleSubViewHydrate）又正常」。
       *
       * 直接同步调 applySubViewHydrate 即可：它是幂等的，内部各自
       * 校验节点是否存在。此处不排 rAF —— 重绘刚在本帧同步完成，
       * 节点就是新的那一批，晚一帧反而多一次闪空。
       */
      applySubViewHydrate(state.subView);
      return;
    }
    var navTitle = pageEl.querySelector('.st-navtitle');
    if (navTitle) navTitle.textContent = '聊天设置';

    var prevScroll = body.scrollTop;
    captureZoneOpenState(body);
    var wbPanel = body.querySelector('[data-mq-set-wb-sort-panel]');
    if (wbPanel) state.wbSortOpen = wbPanel.classList.contains('is-open');
    if (!opts.fromStore && body.querySelector('[data-mq-set-remark]')) captureFormDraft(body);
    body.innerHTML = renderPage();
    hydrateAvatars(body);
    if (!opts.fromStore) applyFormDraft(body);
    syncEmoBindGroupToggles(body);
    syncMomentsAutoModeUI(body);
    syncLifeLikeAgainstTimedBackground(body);
    syncTranslateExtrasVisibility(body);
    body.scrollTop = prevScroll;
    if (!opts.skipContextUsage) scheduleContextUsageRefresh();
    var bfMod = global.MiyaChatBeautify;
    var bfWrap = body.querySelector('.mi-bf-wrap');
    if (bfMod && bfWrap && state.chatId) {
      bfMod.bindAtelierRoot(bfWrap, state.chatId, function () { render(); });
      bfMod.hydrateCssPreview(bfWrap);
    }
  }

  function scheduleRender(opts) {
    var gen = ++renderRaf;
    requestAnimationFrame(function () {
      if (gen !== renderRaf || !pageEl || !state.chatId) return;
      render(opts);
    });
  }

  function markWallpaperLibActive(wpId) {
    if (!pageEl) return;
    var id = wpId != null ? String(wpId) : '';
    pageEl.querySelectorAll('[data-mq-set-wall-lib]').forEach(function (btn) {
      var on = !!(id && btn.getAttribute('data-mq-set-wall-lib') === id);
      btn.classList.toggle('is-active', on);
      var check = btn.querySelector('.mi-wall-lib-cell__check');
      if (on && !check) {
        btn.insertAdjacentHTML('beforeend', '<span class="mi-wall-lib-cell__check" aria-hidden="true">✓</span>');
      } else if (!on && check) {
        check.remove();
      }
    });
  }

  function open(chatId) {
    store = global.miyaChatStore;
    if (!store || !chatId) return Promise.resolve();
    var chat = store.findChat(chatId);
    if (chat && chat.type === 'group' && global.miyaChatGroupSettings) {
      return global.miyaChatGroupSettings.open(chatId);
    }

    state.chatId = chatId;
    state.wbSortOpen = false;
    state.zoneOpen = {};
    /* 每次从聊天页进来都回到列表首页，不残留上次停在的 API 子页 ——
       否则用户点「聊天设置」会莫名其妙直接看到某个 API 表单。 */
    state.subView = null;
    /* 同理丢弃预设下拉记忆，重新从当前生效的线路出发 */
    state.apiPresetPick = '';
    state.apiModelPick = '';
    state.apiModelPickBase = null;
    state.apiModel2Pick = '';
    state.apiModel2PickBase = null;
    ensurePage();
    pageEl.hidden = false;
    pageEl.classList.add('is-open');
    pageEl.setAttribute('aria-hidden', 'false');
    var app = $('miya-chat-app');
    if (app) app.classList.add('mi-set-open');

    var body = pageEl.querySelector('[data-mq-set-body]');
    var scroll = body;
    if (scroll) scroll.scrollTop = 0;

    if (chat) {
      scheduleRender({ skipContextUsage: true, fromStore: true });
    } else if (body) {
      body.innerHTML = '<p class="mi-empty-hint">加载中…</p>';
    }

    var chain = Promise.resolve();
    if (global.MiyaChatBeautify && global.MiyaChatBeautify.whenPresetsReady) {
      chain = chain.then(function () { return global.MiyaChatBeautify.whenPresetsReady(); });
    }
    if (global.MiyaChatHeartVoiceTemplates && global.MiyaChatHeartVoiceTemplates.whenPresetsReady) {
      chain = chain.then(function () { return global.MiyaChatHeartVoiceTemplates.whenPresetsReady(); });
    }
    return chain.then(function () {
      return store.init();
    }).then(function () {
      if (String(state.chatId) !== String(chatId)) return;
      var loaded = store.findChat(chatId);
      if (!loaded || loaded.type === 'group') return;
      /*
       * 这次 render 是异步的（要等 store.init 的链）。而 render() 对子视图是
       * 「整块换 innerHTML」，会把已经填好的子视图内容一起冲掉 ——
       * 下拉框的选项、聊天默认值面板，都一样会没。
       *
       * 冷启动直跳某个子视图（`openSubViewForChat`，老兼容层与外部跳转走这条）
       * 时必然踩中：openSubView 同步填充 → store.init 落地再重绘 → 内容被擦掉，
       * 而且不会再长回来，用户看到的是一个空白面板。
       *
       * 修法见 scheduleSubViewHydrate：排在这次重绘之后再填一遍。
       * 不能在这里同步填 —— 上面那行 scheduleRender 只是排进了 rAF，
       * 同步填的会被它下一帧擦掉，等于白填。
       */
      scheduleRender({ fromStore: true });
      if (state.subView) scheduleSubViewHydrate();
    });
  }

  function close() {
    state.chatId = null;
    state.formDraft = null;
    state.subView = null;
    /* 关掉设置页就丢弃预设下拉的记忆 —— 下次进来从当前线路重新认，
       避免把上一个会话选中的预设名带到另一个会话上。 */
    state.apiPresetPick = '';
    state.apiModelPick = '';
    state.apiModelPickBase = null;
    state.apiModel2Pick = '';
    state.apiModel2PickBase = null;
    if (pageEl) {
      pageEl.classList.remove('is-open');
      pageEl.hidden = true;
      pageEl.setAttribute('aria-hidden', 'true');
    }
    var app = $('miya-chat-app');
    if (app) app.classList.remove('mi-set-open');
    if (global.miyaChatRoom && typeof global.miyaChatRoom.restoreCompose === 'function') {
      global.miyaChatRoom.restoreCompose();
    }
  }

  function bindPageEvents() {
    if (!pageEl || pageEl.dataset.bound) return;
    pageEl.dataset.bound = '1';

    pageEl.addEventListener('click', function (e) {
      /*
       * 返回键分两种：在子视图里先回列表，在列表里才关掉整个聊天设置。
       * 这个顺序不能反 —— 否则用户在「对话 API」里点返回会直接退出
       * 聊天设置，得重新从聊天页点进来才能改别的。
       */
      if (e.target.closest('[data-mq-set-back]')) {
        if (state.subView) closeSubView(); else close();
        return;
      }
      /* 子视图内的页内返回键已删除（顶栏的返回键接管），
         这里保留一行兼容处理：若旧缓存页面里还残留该节点，点了也能回去。 */
      if (e.target.closest('[data-mq-set-sub-back]')) { closeSubView(); return; }

      /* 子视图入口 */
      var subNav = e.target.closest('[data-mq-set-sub]');
      if (subNav) { openSubView(subNav.getAttribute('data-mq-set-sub')); return; }

      /* 子视图内的保存：把表单读出来写进统一配置层 */
      var subSave = e.target.closest('[data-mq-set-sub-save]');
      if (subSave) { saveSubViewForm(subSave.getAttribute('data-mq-set-sub-save')); return; }

      /* ── 对话 API · 接口预设与模型拉取 ──
         这两组控件是随设置 App 删除时一并丢失的：
         渲染出来了，但没有任何事件接住它们，点了毫无反应。 */
      if (e.target.closest('#mq-api-preset-save')) { saveApiPreset(); return; }
      if (e.target.closest('#mq-api-preset-delete')) { deleteApiPreset(); return; }
      if (e.target.closest('#mq-api-preset-export')) { exportApiPresets(); return; }
      if (e.target.closest('#mq-api-preset-import')) {
        /* triggerFileInput 会处理 .ins-file 的可见性与还原，
           并且在部分 WebView 里比裸 click() 更可靠 */
        triggerFileInput(pageEl.querySelector('#mq-api-preset-file'));
        return;
      }
      if (e.target.closest('#mq-api-fetch')) { fetchChatModels('main'); return; }
      if (e.target.closest('#mq-api2-fetch')) { fetchChatModels('fallback'); return; }

      if (e.target.closest('[data-mq-set-storage-refresh]')) { refreshStorageSub(); return; }
      if (e.target.closest('[data-mq-set-storage-img-compress]')) { compressStorageImages(); return; }
      if (e.target.closest('[data-mq-set-storage-img-clear]')) { clearStorageImages(); return; }

      var bkExport = e.target.closest('[data-mq-set-backup-export]');
      if (bkExport) {
        if (global.miyaBackup) global.miyaBackup.exportLight();
        return;
      }
      var bkExportFull = e.target.closest('[data-mq-set-backup-export-full]');
      if (bkExportFull) {
        if (global.miyaBackup) global.miyaBackup.exportFull();
        return;
      }
      var bkImport = e.target.closest('[data-mq-set-backup-import]');
      if (bkImport) {
        var bkFile = pageEl.querySelector('[data-mq-set-backup-file]');
        if (bkFile) bkFile.click();
        return;
      }
      var notifyTest = e.target.closest('[data-mq-notify-test]');
      if (notifyTest) { runNotifyTest(); return; }

      if (e.target.closest('[data-mq-set-save]')) { saveForm(); return; }
      if (e.target.closest('[data-mq-set-weather-sense]')) { runWeatherSense(); return; }
      if (e.target.closest('[data-mq-set-weather-sync-app]')) { syncWeatherAppIntoForm(); return; }

      var zoneToggle = e.target.closest('[data-mq-set-zone-toggle]');
      if (zoneToggle) {
        toggleZone(zoneToggle.closest('[data-mq-set-zone]'));
        return;
      }

      if (e.target.closest('[data-mq-set-wb-sort-toggle]')) {
        toggleWorldbookSortPanel();
        return;
      }

      var wbUp = e.target.closest('[data-mq-set-wb-sort-up]');
      if (wbUp && !wbUp.disabled) {
        var wbRowUp = wbUp.closest('[data-mq-set-wb-sort-id]');
        var wbListUp = pageEl.querySelector('[data-mq-set-wb-sort]');
        if (wbRowUp && wbListUp) {
          moveWorldbookSortRow(wbListUp, wbRowUp.getAttribute('data-mq-set-wb-sort-id'), -1);
        }
        return;
      }
      var wbDown = e.target.closest('[data-mq-set-wb-sort-down]');
      if (wbDown && !wbDown.disabled) {
        var wbRowDown = wbDown.closest('[data-mq-set-wb-sort-id]');
        var wbListDown = pageEl.querySelector('[data-mq-set-wb-sort]');
        if (wbRowDown && wbListDown) {
          moveWorldbookSortRow(wbListDown, wbRowDown.getAttribute('data-mq-set-wb-sort-id'), 1);
        }
        return;
      }

      if (e.target.closest('[data-mq-set-contact-wallet-adjust]')) {
        var cW = ctx();
        if (!cW || !cW.contact || !store.setContactWalletBalance) return;
        var curRoleBal = Number((store.getContactWallet(cW.contact.id) || {}).balance) || 0;
        dialog({
          mode: 'prompt',
          title: '调整角色余额',
          message: '设置「' + (cW.contact.remarkName || cW.contact.name || 'Ta') + '」的余额（当前 ¥' + curRoleBal + '）',
          placeholder: '例如：5000',
          defaultValue: String(curRoleBal)
        }).then(function (val) {
          if (val == null || val === '') return;
          var next = Number(String(val).trim());
          if (!Number.isFinite(next) || next < 0) {
            toast('请输入有效金额');
            return;
          }
          store.setContactWalletBalance(cW.contact.id, next).then(function () {
            toast('余额已更新');
            render();
          }).catch(function () { toast('更新失败'); });
        });
        return;
      }

      if (e.target.closest('.mi-toggle, .ins-toggle')) {
        var sw = e.target.closest('.mi-toggle, .ins-toggle');
        if (sw.classList.contains('is-disabled')) return;
        /*
         * 提示音开关（#miya-st-sw-msgsound）由 miya-msg-sound.js 自己绑了
         * 直接监听 + setEnabled/saveSettings。这里是页级委托，冒泡上来同样
         * 命中 .ins-toggle —— 于是同一次点击被处理两遍：
         * 前一次把状态写成 off，后一次又按「取反」翻回 on。
         * 表现为开关点不动、且状态与 localStorage 不一致（UI 显示开、实际存的关）。
         * 该 id 归 miya-msg-sound 所有，这里必须放行。
         */
        if (sw.id === 'miya-st-sw-msgsound') return;
        var on = !sw.classList.contains('is-on');
        sw.classList.toggle('is-on', on);
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        if (sw.id === 'mq-set-emo-all' || sw.hasAttribute('data-mq-set-emo-grp')) {
          var body = pageEl.querySelector('[data-mq-set-body]');
          syncEmoBindGroupToggles(body);
        }
        if (sw.id === 'mq-set-trans') {
          var transBody = pageEl.querySelector('[data-mq-set-body]');
          syncTranslateExtrasVisibility(transBody);
        }
        if (sw.id === 'mq-set-lifelike') {
          var memBody = pageEl.querySelector('[data-mq-set-body]');
          syncLifeLikeAgainstTimedBackground(memBody);
        }
        /* 通知开关：状态要落到系统偏好里，否则切走再回来会弹回去 */
        if (sw.id === 'mq-notify-sw') {
          if (on && global.miyaGetNotificationApi && global.miyaGetNotificationApi()) {
            global.miyaRequestNotificationPermission().then(function (perm) {
              var granted = perm === 'granted';
              if (global.miyaSetSystemPrefs) global.miyaSetSystemPrefs({ notify: granted });
              sw.classList.toggle('is-on', granted);
              sw.setAttribute('aria-checked', granted ? 'true' : 'false');
              toast(granted ? '通知已开启' : (perm === 'denied' ? '通知权限被拒绝' : '需要通知权限'));
            });
          } else {
            if (global.miyaSetSystemPrefs) global.miyaSetSystemPrefs({ notify: on });
          }
        }
        return;
      }

      if (e.target.closest('[data-mq-set-clear]')) {
        dialog({ mode: 'confirm', title: '清空消息', message: '确定清空全部聊天记录？', confirmText: '清空', cancelText: '取消' }).then(function (ok) {
          if (!ok || !state.chatId) return;
          store.clearChatMessages(state.chatId).then(function () {
            toast('已清空');
            if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId() === state.chatId) global.miyaChatRoom.refresh();
            render();
          });
        });
        return;
      }

      if (e.target.closest('[data-mq-set-export]')) {
        var msgs = store.getMessages(state.chatId).filter(function (m) { return m && !m.deleted; });
        var blob = new Blob([JSON.stringify(msgs, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.download = 'miya-chat-' + state.chatId + '.json';
        a.href = URL.createObjectURL(blob);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        toast('已导出 ' + msgs.length + ' 条');
        return;
      }

      if (e.target.closest('[data-mq-set-import]')) {
        var finp = pageEl.querySelector('[data-mq-set-import-file]');
        if (finp && global.miyaTriggerFileInput) global.miyaTriggerFileInput(finp);
        else if (finp) finp.click();
        return;
      }

      if (e.target.closest('[data-mq-set-delete-contact]')) {
        var c = ctx();
        if (!c || !c.contact) return;
        dialog({ mode: 'confirm', title: '删除联系人', message: '确定删除「' + (c.contact.name || '') + '」？', confirmText: '删除', cancelText: '取消' }).then(function (ok) {
          if (!ok) return;
          store.deleteContactAndData(c.contact.id).then(function () {
            toast('已删除');
            close();
            if (global.miyaChatRoom) global.miyaChatRoom.close();
            if (global.miyaChatApp && global.miyaChatApp.refreshLists) global.miyaChatApp.refreshLists();
          });
        });
        return;
      }

      function ensureBgFileInput() {
        var finp = pageEl.querySelector('[data-mq-set-bg-file]');
        if (finp) return finp;
        finp = document.createElement('input');
        finp.type = 'file';
        finp.accept = 'image/*';
        finp.hidden = true;
        finp.setAttribute('data-mq-set-bg-file', '');
        pageEl.appendChild(finp);
        finp.addEventListener('change', function (ev) {
          var file = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          if (!file || !state.chatId) return;
          store.storeChatMedia(file, 'wall').then(function (blobId) {
            return store.saveChatSettings(state.chatId, {
              chatBeautify: Object.assign({}, store.getChatSettings(state.chatId).chatBeautify, {
                wallpaperMode: 'idb', wallpaperId: blobId, wallpaperUrl: ''
              })
            });
          }).then(function () {
            toast('背景已更新');
            if (global.MiyaChatBeautify) global.MiyaChatBeautify.applyForChat(state.chatId);
            markWallpaperLibActive(null);
            scheduleRender({ fromStore: true, skipContextUsage: true });
          });
        });
        return finp;
      }

      if (e.target.closest('[data-mq-set-bg-pick]')) {
        triggerFileInput(ensureBgFileInput());
        return;
      }

      if (e.target.closest('[data-mq-set-wall-manage]')) {
        if (global.MiyaChatWallpaperPicker && global.MiyaChatWallpaperPicker.openManage) {
          global.MiyaChatWallpaperPicker.openManage();
        }
        return;
      }

      if (e.target.closest('[data-mq-set-wall-lib]')) {
        var libBtn = e.target.closest('[data-mq-set-wall-lib]');
        var wpId = libBtn.getAttribute('data-mq-set-wall-lib');
        var picker = global.MiyaChatWallpaperPicker;
        var wp = picker && picker.findWallpaper ? picker.findWallpaper(wpId) : null;
        if (!wp || !state.chatId || !picker || !picker.applyWallpaperToChat) return;
        markWallpaperLibActive(wpId);
        toast('背景已更新');
        picker.applyWallpaperToChat(state.chatId, wp).then(function () {
          if (global.MiyaChatBeautify) global.MiyaChatBeautify.applyForChat(state.chatId);
        }).catch(function () {
          toast('背景更新失败');
          scheduleRender({ fromStore: true, skipContextUsage: true });
        });
        return;
      }

      if (e.target.closest('[data-mq-set-bg-reset]')) {
        store.saveChatSettings(state.chatId, {
          background: '',
          chatBeautify: Object.assign({}, store.getChatSettings(state.chatId).chatBeautify, {
            wallpaperMode: 'none', wallpaperId: null, wallpaperUrl: ''
          })
        }).then(function () {
          toast('已恢复默认');
          if (global.MiyaChatBeautify) global.MiyaChatBeautify.applyForChat(state.chatId);
          markWallpaperLibActive(null);
          scheduleRender({ fromStore: true, skipContextUsage: true });
        });
        return;
      }

      /* 链接导入已移除：聊天背景只通过点按预览区本地上传。 */

      function ensureDisplayAvatarFileInput(kind) {
        var sel = '[data-mq-set-dava-' + kind + '-file]';
        var finp = pageEl.querySelector(sel);
        if (finp) return finp;
        finp = document.createElement('input');
        finp.type = 'file';
        finp.accept = 'image/*';
        finp.hidden = true;
        finp.setAttribute('data-mq-set-dava-' + kind + '-file', '');
        pageEl.appendChild(finp);
        finp.addEventListener('change', function (ev) {
          var file = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          if (!file || !state.chatId) return;
          store.storeChatMedia(file, 'avatar').then(function (blobId) {
            return mergeDisplayAvatars(state.chatId, kind, { url: '', blobId: blobId });
          }).then(function () {
            toast(kind === 'contact' ? 'Ta 的头像已更新' : '我的头像已更新');
            render();
            refreshOpenChatRoom();
          }).catch(function () { toast('上传失败'); });
        });
        return finp;
      }

      function handleDisplayAvatarPick(kind) {
        triggerFileInput(ensureDisplayAvatarFileInput(kind));
      }

      function handleDisplayAvatarReset(kind) {
        resetDisplayAvatar(state.chatId, kind).then(function () {
          toast('已恢复档案头像');
          render();
          refreshOpenChatRoom();
        });
      }

      /* 链接导入已移除：聊天头像只通过点按预览区本地上传。 */

      if (e.target.closest('[data-mq-set-dava-contact-pick]')) { handleDisplayAvatarPick('contact'); return; }
      if (e.target.closest('[data-mq-set-dava-profile-pick]')) { handleDisplayAvatarPick('profile'); return; }
      if (e.target.closest('[data-mq-set-dava-contact-reset]')) { handleDisplayAvatarReset('contact'); return; }
      if (e.target.closest('[data-mq-set-dava-profile-reset]')) { handleDisplayAvatarReset('profile'); return; }

      function patchImageGenRef(patch) {
        var cur = store.getChatSettings(state.chatId) || {};
        var ig = Object.assign({}, cur.imageGen || {}, patch);
        return store.saveChatSettings(state.chatId, { imageGen: ig });
      }

      function ensureIgRefFileInput() {
        var finp = pageEl.querySelector('[data-mq-set-ig-ref-file]');
        if (finp) return finp;
        finp = document.createElement('input');
        finp.type = 'file';
        finp.accept = 'image/*';
        finp.hidden = true;
        finp.setAttribute('data-mq-set-ig-ref-file', '');
        pageEl.appendChild(finp);
        finp.addEventListener('change', function (ev) {
          var file = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          if (!file || !state.chatId) return;
          store.storeChatMedia(file, 'imagegen-ref').then(function (blobId) {
            return patchImageGenRef({ refBlobId: blobId, refUrl: '' });
          }).then(function () {
            toast('参考图已更新');
            render();
          }).catch(function () { toast('上传失败'); });
        });
        return finp;
      }

      if (e.target.closest('[data-mq-set-ig-ref-pick]')) {
        triggerFileInput(ensureIgRefFileInput());
        return;
      }
      if (e.target.closest('[data-mq-set-ig-ref-reset]')) {
        patchImageGenRef({ refBlobId: null, refUrl: '' }).then(function () {
          toast('已清除参考图');
          render();
        });
        return;
      }
      /* 链接导入已移除：外观参考图只通过点按预览区本地上传。 */

      if (e.target.closest('[data-mq-set-ctx-toggle]')) {
        toggleContextUsageDetail(false);
        return;
      }

      /* 展开 / 收起某个来源的具体条目。默认收起，点箭头才看，
         这样面板不会因为条目多而变得很长。展开状态随后被 render 保留。 */
      var kidsBtn = e.target.closest('[data-mq-set-ctx-kids]');
      if (kidsBtn) {
        var kidsEl = pageEl.querySelector('#' + kidsBtn.getAttribute('data-mq-set-ctx-kids'));
        if (kidsEl) {
          var willOpen = kidsEl.hidden;
          kidsEl.hidden = !willOpen;
          kidsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          var rowEl = kidsBtn.closest('.mi-ctx-src-row');
          if (rowEl) rowEl.classList.toggle('is-open', willOpen);
          /* 记下展开的组，重绘后恢复（切换上下文设置会触发重算） */
          var rowKey = rowEl ? rowEl.getAttribute('data-mq-set-ctx-row') : '';
          if (rowKey) {
            if (willOpen) ctxOpenSrcRows[rowKey] = true;
            else delete ctxOpenSrcRows[rowKey];
          }
        }
        return;
      }
    });

    pageEl.addEventListener('change', function (e) {
      if (e.target.matches('[data-mq-set-moments-mode]')) {
        var root = pageEl.querySelector('[data-mq-set-body]');
        var c = ctx();
        syncMomentsAutoModeUI(root);
        ensureMomentsAutoIntervalDefaults(root, e.target.value, c && c.settings && c.settings.momentsAuto);
        return;
      }
      /*
       * 这里原来还有一支：
       *     if (e.target.matches('[data-mq-set-oprules-preset]') ||
       *         e.target.matches('[data-mq-set-thrules-preset]')) {
       *       scheduleContextUsageRefresh(); return;
       *     }
       * 那两个控件（操作规则预设 / 思维链规则预设）已经不存在了 ——
       * 全项目搜不到任何地方渲染它们，取而代之的是心声模版
       * （data-mq-set-hv-tpl-preset），由 js1/miya-chat-heartvoice-templates.js
       * 自己接管。监听器留着不会报错，但会让人以为还有这么一块 UI，
       * 排查时白绕一圈，所以删掉。
       */
      if (e.target.matches('[data-mq-set-import-file]')) {
        var file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var parsed = JSON.parse(reader.result);
            if (!Array.isArray(parsed)) throw new Error('invalid');
            store.importChatMessages(state.chatId, parsed).then(function (n) {
              toast('已导入 ' + n + ' 条');
              render({ fromStore: true });
              if (global.miyaChatRoom && global.miyaChatRoom.getOpenChatId() === state.chatId) global.miyaChatRoom.refresh();
            });
          } catch (err) { toast('JSON 无效'); }
        };
        reader.readAsText(file, 'utf-8');
      }

      /* 对话 API 预设：选中即载入，与生图预设的「选中即读」一致 */
      if (e.target.matches('#mq-api-preset-pick')) {
        /* 记下选中项，供重绘后回填（重绘会换出全新的 <select>，value 是空的） */
        state.apiPresetPick = String(e.target.value || '');
        loadApiPresetFromPick();
        return;
      }

      /*
       * 模型下拉：记进 state 草稿，供重绘后回填。
       *
       * 与 apiPresetPick 同一个病：重绘换出的新 <select> 只会按
       * 「正式配置 + 模型缓存」恢复 options，用户切了但还没保存的
       * 选中值若不记下来，一次顶部保存 / 异步重绘就回退到旧模型，
       * 再点「保存」写回去的就是旧模型 —— 「切换模型保存不了」。
       * 草稿在保存成功、载入预设时同步为已落盘的值，open()/close()
       * 时清空，不会把 A 会话的未保存编辑带进 B 会话。
       */
      if (e.target.matches('#mq-api-model')) {
        state.apiModelPick = String(e.target.value || '');
        state.apiModelPickBase = String((global.miyaGetApiConfigCached && global.miyaGetApiConfigCached()) ? (global.miyaGetApiConfigCached().model || '') : '');
        return;
      }
      if (e.target.matches('#mq-api2-model')) {
        state.apiModel2Pick = String(e.target.value || '');
        state.apiModel2PickBase = String((global.miyaGetApiConfigCached && global.miyaGetApiConfigCached()) ? (global.miyaGetApiConfigCached().fallbackModel || '') : '');
        return;
      }

      /* 预设导入：选完文件就立刻读，不留着等用户再点一次 */
      if (e.target.matches('#mq-api-preset-file')) {
        var pf = e.target.files && e.target.files[0];
        e.target.value = '';   /* 允许连续导入同一个文件 */
        if (!pf) return;
        importApiPresets(pf);
        return;
      }

      /* 备份导入：文件选择后交给 miyaBackup 引擎（原设置 App 的那套） */
      if (e.target.matches('[data-mq-set-backup-file]')) {
        var bfs = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
        e.target.value = '';
        if (!bfs.length) return;
        if (global.miyaBackup) global.miyaBackup.importFiles(bfs);
        return;
      }
    });

    /* 温度滑块的数值标签要实时跟手。
       原先这个联动也随设置 App 一起丢了 —— 拖滑块只有条动、数字不动。 */
    pageEl.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'mq-api-temp') {
        var lbl = pageEl.querySelector('#mq-api-temp-lbl');
        if (lbl) lbl.textContent = String(e.target.value);
        return;
      }
      if (e.target && e.target.id === 'mq-api2-temp') {
        var lb2 = pageEl.querySelector('#mq-api2-temp-lbl');
        if (lb2) lb2.textContent = String(e.target.value);
        return;
      }
      if (e.target && e.target.id === 'mq-voice-speed') {
        var sl = pageEl.querySelector('#mq-voice-speed-lbl');
        if (sl) sl.textContent = String(e.target.value);
        return;
      }
      if (e.target && e.target.id === 'mq-voice-vol') {
        var vl = pageEl.querySelector('#mq-voice-vol-lbl');
        if (vl) vl.textContent = String(e.target.value);
        return;
      }
      if (e.target && e.target.id === 'mq-voice-pitch') {
        var pl = pageEl.querySelector('#mq-voice-pitch-lbl');
        if (pl) pl.textContent = String(e.target.value);
        return;
      }
    });
  }

  function patchTokenUsageInSettings(chatId) {
    if (!pageEl || pageEl.hidden || !state.chatId) return;
    if (String(state.chatId) !== String(chatId || '')) return;
    refreshContextUsagePanel();
  }

  if (!global.miyaChatRoomExtras) global.miyaChatRoomExtras = {};
  global.miyaChatRoomExtras.patchTokenUsageInSettings = patchTokenUsageInSettings;

  /**
   * 打开某个会话的设置页，并直接进入指定子视图。
   *
   * 给谁用：桌面设置 App 删除后，`global.miyaSettingsApp.open(panelId)`
   * 那条老路径要能落到这里对应的子视图上（见 miya-settings-app.js 的兼容层）。
   * 万一还有别处按老面板名跳转，也不用改调用点。
   */
  function openSubViewForChat(chatId, subKey) {
    if (!SUB_VIEW_TITLES[subKey]) return false;
    open(chatId);
    openSubView(subKey);
    return true;
  }

  global.miyaChatContactSettings = {
    open: open,
    close: close,
    openSubViewForChat: openSubViewForChat,
    save: saveForm,
    refreshContextUsage: refreshContextUsagePanel
  };
})(window);
