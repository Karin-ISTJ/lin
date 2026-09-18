/**
 * 设置 · 聊天设置入口（指路页）
 *
 * 变更说明（信息架构收敛）：
 * 本面板原先承载「全局 / 按联系人」两套记忆与后台表单，与角色聊天页的
 * 「聊天设置」功能重叠、命名也撞车，导致同一项设置有两个入口、两处语义。
 * 现已把上下文条数 / 自动总结触发 / 总结长度 / 定时主动消息 / 静默时段
 * 全部并入角色聊天页的聊天设置（「记忆与后台」分区）。
 *
 * 本页因此改为单纯的指路页：说明设置去了哪里，并提供各联系人的快捷入口，
 * 点一下直接跳到该联系人的聊天设置。全局默认值仍由 miyaChatGlobalSettings
 * 持有，只是不再在本页编辑。
 */
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function esc(t) {
    return String(t || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    if (global.miyaSettingsApp && global.miyaSettingsApp.toast) {
      global.miyaSettingsApp.toast(msg);
    }
  }

  function renderPanelHtml() {
    return '<div class="miya-ct-chat-panel">' +
      '<p class="miya-ct-intro">聊天相关的设置已统一到「角色聊天页 → 右上角 ··· → 聊天设置」里，本页不再重复提供同样的表单。</p>' +

      '<div class="miya-ct-card miya-ct-card--accent">' +
        '<p class="miya-ct-card__kicker">去哪儿改</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 12px;">' +
          '打开任意角色聊天，点右上角的 <strong>···</strong>，里面的「记忆与后台」分区负责上下文条数、自动总结与定时主动消息。' +
        '</p>' +
        '<p class="miya-ct-row__hint" style="margin:0;">' +
          '上下文条数与自动总结的<strong>全局默认值</strong>依然生效：单个联系人没单独改过时，会用全局值。' +
          '要为某人单独设置，就在他的聊天设置里改，改完即成为该联系人的独立值。' +
        '</p>' +
      '</div>' +

      '<div class="miya-ct-card">' +
        '<p class="miya-ct-card__kicker">快捷进入</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 10px;">选中一个联系人，直接跳到他的聊天设置。</p>' +
        '<select class="miya-ct-input miya-ct-input--select" id="miya-ct-chat-pick-contact">' +
          '<option value="">选择联系人</option>' +
        '</select>' +
        '<button type="button" class="miya-ct-btn miya-ct-btn--primary" id="miya-ct-chat-goto" disabled>打开聊天设置</button>' +
      '</div>' +

      '<div class="miya-ct-card">' +
        '<p class="miya-ct-card__kicker">其它入口</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 8px;">' +
          '<strong>对话 / 语音 / 生图 API</strong>：角色聊天设置的「对话 API」「语音合成」「生图 API」三栏，或桌面「设置」。' +
        '</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 8px;">' +
          '<strong>角色记忆提炼</strong>（每 N 轮自动提炼）：桌面「记忆」。它与聊天设置里的「自动总结触发」是两套独立机制。' +
        '</p>' +
        '<p class="miya-ct-row__hint" style="margin:0;">' +
          '<strong>记忆表格</strong>：角色聊天页底部 <strong>+</strong> → 记忆表。' +
        '</p>' +
      '</div>' +
    '</div>';
  }

  /** 联系人下拉：等 store 就绪后填充 */
  function hydrateContactPicker() {
    var pick = $('miya-ct-chat-pick-contact');
    if (!pick) return;
    var chain = Promise.resolve();
    if (global.miyaContactsStore && global.miyaContactsStore.whenReady) {
      chain = chain.then(function () { return global.miyaContactsStore.whenReady(); });
    }
    if (global.miyaChatStore && global.miyaChatStore.init) {
      chain = chain.then(function () { return global.miyaChatStore.init(); });
    }
    if (global.miyaChatContactsSync && global.miyaChatContactsSync.syncAll) {
      chain = chain.then(function () {
        return global.miyaChatContactsSync.syncAll({ prune: false });
      });
    }
    chain.then(function () {
      if (!global.miyaChatStore || !pick) return;
      var contacts = global.miyaChatStore.getContacts('all');
      pick.innerHTML = '<option value="">选择联系人</option>' +
        contacts.map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.remarkName || c.name) + '</option>';
        }).join('');
    }).catch(function () {});
  }

  /** 把 contactId 解析成 chatId 并打开聊天设置；解析不到时给出明确反馈 */
  function openContactSettings(contactId) {
    var st = global.miyaChatStore;
    var mod = global.miyaChatContactSettings;
    if (!st || !mod || typeof mod.open !== 'function') return;
    var chat = st.findChatByContact ? st.findChatByContact(contactId) : null;
    if (!chat) {
      toast('这个联系人还没有会话，先和他聊一句再来');
      return;
    }
    /* 先关掉设置 App，再打开聊天设置，避免两层全屏页叠在一起。
       设置 App 关闭动效约 220ms，等它退场后再打开更干净。 */
    var openIt = function () {
      if (global.miyaChatApp && typeof global.miyaChatApp.open === 'function') {
        try { global.miyaChatApp.open(); } catch (e) {}
      }
      try { mod.open(chat.id); } catch (e) {}
    };
    if (global.miyaSettingsApp && typeof global.miyaSettingsApp.close === 'function') {
      global.miyaSettingsApp.close();
      setTimeout(openIt, 240);
    } else {
      openIt();
    }
  }

  function bindPanel() {
    var panel = $('miya-st-panel-contact-chat');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = '1';
    panel.innerHTML = renderPanelHtml();

    var pick = $('miya-ct-chat-pick-contact');
    var goto = $('miya-ct-chat-goto');

    if (pick) {
      pick.addEventListener('change', function () {
        if (goto) goto.disabled = !this.value;
      });
    }
    if (goto) {
      goto.addEventListener('click', function () {
        var cid = pick ? String(pick.value || '').trim() : '';
        if (!cid) { toast('请先选择联系人'); return; }
        openContactSettings(cid);
      });
    }
  }

  /* ── 聊天默认值面板（桌面设置 → 聊天 → 聊天默认值） ──────────────────
     这些字段曾经可以在「我的」页齿轮里改，收敛后合并到了各联系人的聊天设置。
     但「全局默认」这个概念仍然存在：没单独设置过的联系人会用它。
     所以这里保留一个编辑入口，位置从聊天相关的「我的」页挪到全局的桌面设置里。 */

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

  function toggleRow(id, label, hint) {
    return '<div class="miya-ct-row">' +
      '<div class="miya-ct-row__text">' +
        '<strong>' + esc(label) + '</strong>' +
        (hint ? '<span class="miya-ct-row__hint">' + esc(hint) + '</span>' : '') +
      '</div>' +
      '<button type="button" class="ins-toggle" id="' + id + '" role="switch" aria-checked="false"></button>' +
    '</div>';
  }

  function fieldRow(label, inputHtml) {
    return '<div class="miya-ct-field">' +
      '<label class="miya-ct-field__label">' + esc(label) + '</label>' +
      inputHtml +
    '</div>';
  }

  function isToggleOn(id) {
    var el = $(id);
    return el ? el.classList.contains('is-on') : false;
  }

  function setToggle(id, v) {
    var el = $(id);
    if (!el) return;
    el.classList.toggle('is-on', !!v);
    el.setAttribute('aria-checked', v ? 'true' : 'false');
  }

  function setVal(id, v) {
    var el = $(id);
    if (el) el.value = v != null ? v : '';
  }

  function readNum(id, fallback) {
    var el = $(id);
    var n = parseInt(el && el.value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function readVal(id) {
    var el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function renderDefaultsHtml() {
    return '<div class="miya-ct-chat-panel">' +
      '<p class="miya-ct-intro">这些是<strong>全局默认值</strong>。' +
        '没有在聊天设置里单独改过的联系人，会用这里的配置；一旦某人在自己的聊天设置里改过，就以他的为准。</p>' +

      '<div class="miya-ct-card">' +
        '<p class="miya-ct-card__kicker">记忆</p>' +
        fieldRow('上下文条数', '<input type="number" class="miya-ct-input" id="miya-ct-def-memory-count" min="1" max="500" value="80">') +
        fieldRow('自动总结触发', '<input type="number" class="miya-ct-input" id="miya-ct-def-summary-trigger" min="0" max="500" value="0">') +
        fieldRow('总结长度', '<input type="text" class="miya-ct-input" id="miya-ct-def-summary-length" value="100-300字" placeholder="100-300字">') +
      '</div>' +

      '<div class="miya-ct-card">' +
        '<p class="miya-ct-card__kicker">后台消息</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 10px;">定时主动消息默认行为。「让TA自己决定何时找你」属于每个联系人的个人设定，请到各人的聊天设置里开。</p>' +
        toggleRow('miya-ct-def-bg-active', '主动发消息', '距最后一条消息达到间隔即触发，不论谁发的') +
        fieldRow('主动间隔（分钟）', '<input type="number" class="miya-ct-input" id="miya-ct-def-bg-active-min" min="5" max="1440" value="30">') +
        fieldRow('静默时段', '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<input type="time" class="miya-ct-input" id="miya-ct-def-bg-quiet-start" step="60" style="width:112px;">' +
          '<span style="font-size:12px;color:var(--mc-ink-dim,#888);">至</span>' +
          '<input type="time" class="miya-ct-input" id="miya-ct-def-bg-quiet-end" step="60" style="width:112px;">' +
        '</div>') +
        toggleRow('miya-ct-def-bg-quiet-en', '启用静默', '该时段内角色不会主动发消息') +
      '</div>' +

      '<button type="button" class="miya-ct-btn miya-ct-btn--primary" id="miya-ct-def-save">保存默认值</button>' +

      '<div class="miya-ct-card">' +
        '<p class="miya-ct-card__kicker">按联系人</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 10px;">下面这些联系人已脱离全局默认、使用自己的配置。让某人回到全局默认，点「恢复」。</p>' +
        '<div id="miya-ct-def-overrides"><p class="miya-ct-row__hint" style="margin:0;">正在读取…</p></div>' +
      '</div>' +
    '</div>';
  }

  function bindTogglesIn(root) {
    if (!root) return;
    root.querySelectorAll('.ins-toggle').forEach(function (btn) {
      if (btn.dataset.defToggleBound) return;
      btn.dataset.defToggleBound = '1';
      btn.addEventListener('click', function () {
        var on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    });
  }

  function fillDefaultsForm() {
    var mod = global.miyaChatGlobalSettings;
    if (!mod) return;
    mod.whenReady().then(function () {
      var g = (mod.getState() || {}).global || {};
      var bg = g.backgroundMessage || {};
      setVal('miya-ct-def-memory-count', g.memoryCount != null ? g.memoryCount : 80);
      setVal('miya-ct-def-summary-trigger', g.summaryTrigger != null ? g.summaryTrigger : 0);
      setVal('miya-ct-def-summary-length', g.summaryLength || '100-300字');
      setToggle('miya-ct-def-bg-active', bg.activeEnabled);
      setVal('miya-ct-def-bg-active-min', bg.activeIntervalMin != null ? bg.activeIntervalMin : 30);
      setToggle('miya-ct-def-bg-quiet-en', bg.quietEnabled);
      setVal('miya-ct-def-bg-quiet-start', minToTimeStr(bg.quietStartMin != null ? bg.quietStartMin : 1380));
      setVal('miya-ct-def-bg-quiet-end', minToTimeStr(bg.quietEndMin != null ? bg.quietEndMin : 420));
    });
  }

  function renderOverrideList() {
    var box = $('miya-ct-def-overrides');
    if (!box) return;
    var mod = global.miyaChatGlobalSettings;
    var st = global.miyaChatStore;
    if (!mod || !st) return;
    Promise.all([mod.whenReady(), st.init()]).then(function () {
      var per = (mod.getState() || {}).perContact || {};
      var ids = Object.keys(per).filter(function (cid) {
        var row = per[cid];
        return row && row.useGlobal === false;
      });
      if (!ids.length) {
        box.innerHTML = '<p class="miya-ct-row__hint" style="margin:0;">暂无。所有联系人都使用上面的全局默认值。</p>';
        return;
      }
      box.innerHTML = ids.map(function (cid) {
        var c = st.findContact(cid);
        var nm = c ? (c.remarkName || c.name) : cid;
        return '<div class="miya-ct-row" data-def-override="' + esc(cid) + '">' +
          '<div class="miya-ct-row__text"><strong>' + esc(nm) + '</strong>' +
            '<span class="miya-ct-row__hint">使用自己的记忆与后台配置</span></div>' +
          '<button type="button" class="miya-ct-btn miya-ct-btn--sm" data-def-reset="' + esc(cid) + '">恢复</button>' +
        '</div>';
      }).join('');
    }).catch(function () {});
  }

  function saveDefaultsForm() {
    var mod = global.miyaChatGlobalSettings;
    if (!mod) return Promise.resolve(false);
    var qStart = timeStrToMin(readVal('miya-ct-def-bg-quiet-start'));
    var qEnd = timeStrToMin(readVal('miya-ct-def-bg-quiet-end'));
    var patch = {
      memoryCount: readNum('miya-ct-def-memory-count', 80),
      summaryTrigger: readNum('miya-ct-def-summary-trigger', 0),
      summaryLength: readVal('miya-ct-def-summary-length') || '100-300字',
      backgroundMessage: {
        activeEnabled: isToggleOn('miya-ct-def-bg-active'),
        activeIntervalMin: readNum('miya-ct-def-bg-active-min', 30),
        quietEnabled: isToggleOn('miya-ct-def-bg-quiet-en'),
        quietStartMin: Number.isFinite(qStart) ? qStart : 1380,
        quietEndMin: Number.isFinite(qEnd) ? qEnd : 420
      }
    };
    return mod.saveGlobal(patch).then(function () {
      toast('默认值已保存');
      fillDefaultsForm();
      return true;
    }).catch(function () { toast('保存失败'); return false; });
  }

  function bindDefaultsPanel() {
    var panel = $('miya-st-panel-chat-defaults');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = '1';
    panel.innerHTML = renderDefaultsHtml();
    bindTogglesIn(panel);

    panel.addEventListener('click', function (e) {
      var saveBtn = e.target.closest('#miya-ct-def-save');
      if (saveBtn) { saveDefaultsForm(); return; }
      var resetBtn = e.target.closest('[data-def-reset]');
      if (resetBtn) {
        var cid = resetBtn.getAttribute('data-def-reset');
        var mod = global.miyaChatGlobalSettings;
        if (cid && mod && typeof mod.resetContactOverride === 'function') {
          mod.resetContactOverride(cid).then(function () {
            toast('已恢复为全局默认');
            renderOverrideList();
          });
        }
        return;
      }
    });
  }

  function onDefaultsPanelOpen() {
    bindDefaultsPanel();
    fillDefaultsForm();
    renderOverrideList();
  }

  /**
   * 顶栏保存按钮的入口：本页已无可保存内容。
   * 保留该导出是因为 settings App 里对 TOPBAR_SAVE_PANELS 里的面板会统一调用它，
   * 直接解析为已完成，避免出现「点了没反应」的错觉。
   */
  function saveFromTopbar() {
    return Promise.resolve(true);
  }

  function onPanelOpen() {
    bindPanel();
    hydrateContactPicker();
  }

  global.miyaChatSettingsPanel = {
    onPanelOpen: onPanelOpen,
    onDefaultsPanelOpen: onDefaultsPanelOpen,
    saveFromTopbar: saveFromTopbar
  };
})(window);
