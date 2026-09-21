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
    if (typeof global.miyaToast === 'function') global.miyaToast(msg);
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
    /* 桌面设置 App 已删除，不再有「先关它再开」的问题，直接进聊天设置。 */
    if (global.miyaChatApp && typeof global.miyaChatApp.open === 'function') {
      try { global.miyaChatApp.open(); } catch (e) {}
    }
    try { mod.open(chat.id); } catch (e) {}
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

      /*
       * 角色状态栏（Status Bar）
       *
       * 说明为什么是「粘贴一整段 HTML」而不是可视化编辑器：
       * 这批用户（从 SillyTavern 迁过来的）本来就在用正则替换手写 HTML 卡片，
       * 模板库里存着一堆现成的。给他们一个 textarea 直接粘贴，迁移成本为零；
       * 做成拖拽式编辑器反而要他们重学一遍。
       *
       * 模板里写 {{字段名}} 就是占位符；{{字段列表}} 会把「没显式写到的字段」
       * 自动按行渲染出来，适合懒得一个个摆位置的写法。
       */
      '<div class="miya-ct-card">' +
        '<p class="miya-ct-card__kicker">角色状态栏</p>' +
        '<p class="miya-ct-row__hint" style="margin:0 0 10px;">' +
          '角色每轮回复末尾可以用一对标签输出状态字段，这里配置把它渲染成什么样子。' +
          '模板里用 <code>{{字段名}}</code> 取值，用 <code>{{字段列表}}</code> 自动排其余字段。' +
        '</p>' +
        toggleRow('miya-ct-def-sb-enabled', '启用状态栏', '关掉后正文里的状态块会被直接移除，不显示卡片') +
        fieldRow('标题', '<input type="text" class="miya-ct-input" id="miya-ct-def-sb-label" placeholder="状态栏" value="状态栏">') +
        '<div class="miya-ct-row" style="flex-direction:column;align-items:stretch;">' +
          '<span class="miya-ct-row__label" style="margin-bottom:6px;">HTML 模板</span>' +
          '<textarea class="miya-ct-input miya-ct-input--area miya-ct-textarea" id="miya-ct-def-sb-template" ' +
            'rows="10" spellcheck="false" ' +
            'placeholder="留空则使用内置默认卡片"></textarea>' +
        '</div>' +
        '<p class="miya-ct-row__hint" id="miya-ct-def-sb-fields" style="margin:6px 0 10px;">' +
          '正在读取模板字段…</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button type="button" class="miya-ct-btn miya-ct-btn--primary" id="miya-ct-def-sb-save">保存状态栏</button>' +
          '<button type="button" class="miya-ct-btn" id="miya-ct-def-sb-reset">恢复内置默认模板</button>' +
        '</div>' +
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
      fillStatusBarForm(bg);
    });
  }

  /*
   * ── 角色状态栏：表单填充 ──
   *
   * 与后台消息同住在 backgroundMessage 下（statusBar 子键），
   * 这样「全局默认 → 联系人覆盖」那套机制不用改一行就能复用。
   */
  function fillStatusBarForm(bg) {
    var sb = global.MiyaChatStatusBar;
    if (!sb) return;
    var cfg = (bg && bg.statusBar && typeof bg.statusBar === 'object') ? bg.statusBar : {};
    setToggle('miya-ct-def-sb-enabled', cfg.enabled !== false);
    setVal('miya-ct-def-sb-label', cfg.label || sb.DEFAULT_LABEL || '状态栏');
    var ta = $('miya-ct-def-sb-template');
    if (ta) ta.value = String(cfg.template || '');
    updateStatusBarFieldHint();
  }

  /** 实时把模板里出现的 {{字段}} 列出来，让用户知道自己写得对不对 */
  function updateStatusBarFieldHint() {
    var box = $('miya-ct-def-sb-fields');
    if (!box) return;
    var sb = global.MiyaChatStatusBar;
    var ta = $('miya-ct-def-sb-template');
    if (!sb || !ta) return;
    var tpl = String(ta.value || '').trim();
    if (!tpl) {
      box.innerHTML =
        '未填模板，将使用<strong>内置默认卡片</strong>（标题 + 五行情报）。';
      return;
    }
    var fields = typeof sb.extractTemplateFields === 'function' ? sb.extractTemplateFields(tpl) : [];
    var parts = [];
    if (fields.length) {
      parts.push('识别到 <strong>' + fields.length + '</strong> 个字段：' +
        esc(fields.join('、')));
    }
    if (typeof sb.usesFieldList === 'function' && sb.usesFieldList(tpl)) {
      parts.push('含 <code>{{字段列表}}</code>：未显式引用的字段会自动按行渲染');
    }
    if (!parts.length) {
      parts.push('模板里没有 <code>{{字段}}</code> 占位符，渲染出来会是固定内容。' +
        '请在需要填值的地方写上 <code>{{字段名}}</code>。');
    }
    box.innerHTML = parts.join('；') + '。';
  }

  function bindStatusBarForm() {
    var ta = $('miya-ct-def-sb-template');
    if (ta && !ta.dataset.sbBound) {
      ta.dataset.sbBound = '1';
      ta.addEventListener('input', updateStatusBarFieldHint);
    }
    var save = $('miya-ct-def-sb-save');
    if (save && !save.dataset.sbBound) {
      save.dataset.sbBound = '1';
      save.addEventListener('click', function () {
        var sb = global.MiyaChatStatusBar;
        if (!sb) return;
        var patch = {
          enabled: !!($('miya-ct-def-sb-enabled') &&
            $('miya-ct-def-sb-enabled').classList.contains('is-on')),
          label: readVal('miya-ct-def-sb-label') || '状态栏',
          template: ta ? String(ta.value || '') : ''
        };
        /* chatId 传空 → 写全局默认，与这个页面上的其它「默认值」语义一致 */
        Promise.resolve(sb.saveConfig(null, '', patch)).then(function () {
          updateStatusBarFieldHint();
          toast('状态栏设置已保存');
        });
      });
    }
    var reset = $('miya-ct-def-sb-reset');
    if (reset && !reset.dataset.sbBound) {
      reset.dataset.sbBound = '1';
      reset.addEventListener('click', function () {
        var sb = global.MiyaChatStatusBar;
        if (!sb) return;
        /*
         * 「恢复内置默认」= 把存储里的模板清空，而不是把内置模板的字符串抄进去。
         *
         * 两者看起来一样，差别在后面：清空之后 resolveConfig 每次渲染时
         * 都重新取内置默认（usingDefaultTemplate=true），以后内置卡片改了、
         * 加了字段，老用户自动跟上；抄一份进存储就永久冻结在「某个历史版本」，
         * 也再没法从界面上区分「用户自己写的」和「当初的默认」。
         *
         * 但输入框里仍然把内置默认**展示**出来 —— 用户点「恢复默认」是想看看
         * 默认长什么样、好在它基础上改，给个空框会让人以为点坏了。
         * 展示 ≠ 落库：只要用户不点保存，存储里依然是空的。
         */
        if (ta) ta.value = String(sb.DEFAULT_TEMPLATE || '');
        Promise.resolve(sb.saveConfig(null, '', { template: '' })).then(function () {
          updateStatusBarFieldHint();
          toast('已恢复内置默认模板');
        });
      });
    }
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

  /**
   * 把「聊天默认值」面板挂进调用方给的容器里。
   *
   * 原先这个面板只能渲染进桌面设置 App 的 #miya-st-panel-chat-defaults。
   * 桌面设置删除后，它需要在聊天设置的子视图里有个新家 ——
   * 但那边用的是 render() 整页重绘，不能沿用 dataset.bound 那种
   * 「绑一次就忘了」的做法（重绘后旧节点连事件一起被丢掉）。
   *
   * 所以这里每次都用全新的 DOM 重建并重新绑事件，调用方可以放心地
   * 反复调它。容器由调用方给，本模块不再假设任何固定宿主 id。
   */
  function mountDefaultsInto(container) {
    if (!container) return false;
    container.innerHTML = renderDefaultsHtml();
    var panel = container.querySelector('.mi-set-defaults') || container;
    bindTogglesIn(panel);
    /* 内部按钮用委托绑在容器上：容器每次是新节点，重复绑不会有残留 */
    container.addEventListener('click', function (e) {
      if (e.target.closest('#miya-ct-def-save')) { saveDefaultsForm(); return; }
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
      }
    });
    fillDefaultsForm();
    renderOverrideList();
    bindStatusBarForm();
    return true;
  }

  global.miyaChatSettingsPanel = {
    onPanelOpen: onPanelOpen,
    mountDefaultsInto: mountDefaultsInto,
    saveFromTopbar: saveFromTopbar
  };
})(window);
