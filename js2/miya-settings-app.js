(function (global) {
  'use strict';

  var API_CONFIG_KEY = 'miya-api-config';
  var API_PRESETS_KEY = 'miya-api-presets';
  var IMAGE_GEN_PRESETS_KEY = 'miya-image-gen-presets-v1';
  var SYSTEM_PREFS_KEY = 'miya-system-prefs-v1';
  var MSG_SOUND_SETTINGS_KEY = 'miya-msg-sound-v1';
  var GLOBAL_BREAK_KEY = 'miya-global-break-prompt';
  var THEME_META_KEY = 'miya-theme-meta';
  var THEME_PRESETS_KEY = 'miya-theme-presets';
  var BACKUP_VERSION = 4;
  var LS_PLACEHOLDER_JSON = '{"__storedInIdb":true}';
  var LS_SPILL_BYTES = global.miyaLsSpillBytes || 49152;

  var WORLDBOOK_KEY = 'miya-worldbook-v1';
  var CONTACTS_KEY = 'miya-contacts-v1';
  var CONTACTS_REL_KEY = 'miya-contacts-relationships';
  var CHAT_META_KEY = 'miya-chat-meta';
  var CHAT_GLOBAL_SETTINGS_KEY = 'miya-chat-global-settings-v1';
  var CHAT_MOMENTS_KEY = 'miya-moments-v1';
  var CHAT_BEAUTIFY_KEY = 'miya-chat-beautify-presets-v1';
  var CHAT_APP_BEAUTIFY_KEY = 'miya-chat-app-beautify-v1';
  var CHAT_APP_BEAUTIFY_PRESETS_KEY = 'miya-chat-app-beautify-presets-v1';
  var CHAT_META_BACKUP_KEY = 'miya-chat-meta:backup';
  var CHAT_OPERATION_RULES_KEY = 'miya-chat-operation-rules-presets-v1';
  var CHAT_THINKING_RULES_KEY = 'miya-chat-thinking-rules-presets-v1';
  var CHAT_UI_THEME_KEY = 'miya-chat-ui-theme';
  var CHAT_TIMESTAMPS_KEY = 'miya-chat-show-timestamps-v1';
  var DIARY_KEY = 'miya-diary-v1';
  var APPOINTMENT_KEY = 'miya-appointment-v1';
  var APPOINTMENT_BACKUP_KEY = 'miya-appointment-v1-backup';
  var OFFLINE_BEAUTIFY_PRESETS_KEY = 'miya-offline-beautify-presets-v1';
  var ITINERARY_KEY = 'miya-itinerary-v1';
  var WEATHER_KEY = 'miya-weather-v1';
  var COUPLE_KEY = 'miya-couple-v1';
  var COUPLE_WHISPER_KEY = 'miya-couple-whisper-v1';
  var ALBUM_KEY = 'miya-album-v1';
  var LOCK_KEY = 'miya-lock-meta';
  var DESK_LAYOUT_KEY = 'miya-desk-layout-mode';
  var DESK_CUSTOM_KEY = 'miya-desk-custom-v1';
  var DESK_CUSTOM_PRESETS_KEY = 'miya-desk-custom-presets-v1';
  var DESK_WIDGET_PRESETS_KEY = 'miya-desk-custom-widget-presets-v1';
  var DESK_WIDGET_DRAFT_KEY = 'miya-desk-custom-widget-draft-v1';

  var STORAGE_CATALOG = [
    {
      id: 'theme',
      title: '外观与桌面',
      lsKeys: [
        THEME_META_KEY,
        THEME_PRESETS_KEY,
        LOCK_KEY,
        DESK_LAYOUT_KEY,
        DESK_CUSTOM_KEY,
        DESK_CUSTOM_PRESETS_KEY,
        DESK_WIDGET_PRESETS_KEY,
        DESK_WIDGET_DRAFT_KEY
      ],
      widgetKvKeys: [THEME_META_KEY, THEME_PRESETS_KEY, DESK_LAYOUT_KEY, DESK_CUSTOM_KEY, DESK_CUSTOM_PRESETS_KEY, DESK_WIDGET_PRESETS_KEY],
      themeMediaIdb: true
    },
    {
      id: 'api',
      title: '系统与接口',
      lsKeys: [API_CONFIG_KEY, API_PRESETS_KEY, IMAGE_GEN_PRESETS_KEY, GLOBAL_BREAK_KEY, SYSTEM_PREFS_KEY, MSG_SOUND_SETTINGS_KEY],
      widgetKvKeys: [API_CONFIG_KEY, API_PRESETS_KEY, IMAGE_GEN_PRESETS_KEY],
      msgSoundIdb: true
    },
    { id: 'worldbook', title: '典籍片段', lsKeys: [WORLDBOOK_KEY], widgetKvKeys: [WORLDBOOK_KEY] },
    { id: 'contacts', title: '联系人档案', lsKeys: [CONTACTS_KEY, CONTACTS_REL_KEY], widgetKvKeys: [CONTACTS_KEY, CONTACTS_REL_KEY] },
    {
      id: 'chat',
      title: '聊天与会话',
      lsKeys: [CHAT_META_KEY, CHAT_META_BACKUP_KEY, CHAT_GLOBAL_SETTINGS_KEY, CHAT_MOMENTS_KEY, CHAT_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_PRESETS_KEY, CHAT_OPERATION_RULES_KEY, CHAT_THINKING_RULES_KEY, CHAT_UI_THEME_KEY, CHAT_TIMESTAMPS_KEY, ALBUM_KEY],
      widgetKvKeys: [CHAT_META_KEY, CHAT_META_BACKUP_KEY, CHAT_GLOBAL_SETTINGS_KEY, CHAT_MOMENTS_KEY, CHAT_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_KEY, CHAT_APP_BEAUTIFY_PRESETS_KEY, CHAT_OPERATION_RULES_KEY, CHAT_THINKING_RULES_KEY, CHAT_TIMESTAMPS_KEY, ALBUM_KEY],
      chatMediaIdb: true
    },
    { id: 'diary', title: '日记', lsKeys: [DIARY_KEY], widgetKvKeys: [DIARY_KEY] },
    {
      id: 'offline',
      title: '线下剧情',
      lsKeys: [APPOINTMENT_KEY, APPOINTMENT_BACKUP_KEY, OFFLINE_BEAUTIFY_PRESETS_KEY],
      widgetKvKeys: [APPOINTMENT_KEY, APPOINTMENT_BACKUP_KEY, OFFLINE_BEAUTIFY_PRESETS_KEY]
    },
    { id: 'itinerary', title: '行程轨迹', lsKeys: [ITINERARY_KEY], widgetKvKeys: [ITINERARY_KEY] },
    { id: 'weather', title: '天气', lsKeys: [WEATHER_KEY], widgetKvKeys: [WEATHER_KEY] },
    { id: 'couple', title: '情侣空间', lsKeys: [COUPLE_KEY, COUPLE_WHISPER_KEY], widgetKvKeys: [COUPLE_KEY, COUPLE_WHISPER_KEY] }
  ];

  var BACKUP_IDB_STORES_BASE = [
    { file: 'idb/miya-theme-media_blobs.json', db: 'miya-theme-media', store: 'blobs', label: '主题素材', blob: true }
  ];

  var BACKUP_IDB_STORES_HEAVY = [
    { file: 'idb/miya-chat-media_blobs.json', db: 'miya-chat-media', store: 'blobs', label: '聊天图片', blob: true },
    { file: 'idb/miya-msg-sound-v1_blobs.json', db: 'miya-msg-sound-v1', store: 'blobs', label: '提示音', blob: true }
  ];

  var mainListScrollPos = 0;
  var panelClosing = false;
  // 从聊天页的联系人设置进入对话 API 时，API 页返回应回到联系人设置，而不是设置主页。
  var returnToChatContactSettings = false;
  // 从桌面图标直达某个子页时，该子页的返回应整体关闭设置层回到桌面。
  // 记录“本次打开是由桌面直达的目标面板 id”，翻页后自动失效。
  var pendingCloseOnPanelBack = null;
  /* 配置缓存、接口预设缓存、系统偏好这些状态已搬到 js2/miya-api-config.js；
     本文件只保留 UI 相关的临时状态。 */
  var storageSummaryTimer = null;
  var storageContextCache = null;
  var storageContextPromise = null;
  var storageSummaryHydrated = false;

  function $(id) { return document.getElementById(id); }

  /* ── 已迁移到公共模块的薄代理 ──────────────────────────────
   *
   * toast / API 配置读写 / 通知通道 / 接口预设，现在都住在
   * js2/miya-toast.js 与 js2/miya-api-config.js 里 ——
   * 那三个全局函数（miyaGetApiConfigCached 等）被 25 处外部调用依赖，
   * 必须比本文件更早、且不依赖本文件存在。
   *
   * 本文件里剩下的这些同名包装只是让内部调用点少改几行，
   * 真正的状态与逻辑都在那两个模块，这里不再保留第二份缓存。
   */
  function toast(msg) {
    if (typeof global.miyaToast === 'function') return global.miyaToast(msg);
  }

  function hydrateApiConfigFromIdb() {
    if (typeof global.miyaEnsureApiConfigHydrated === 'function') return global.miyaEnsureApiConfigHydrated();
    return Promise.resolve();
  }

  function loadSystemPrefs() {
    if (typeof global.miyaLoadSystemPrefs === 'function') global.miyaLoadSystemPrefs();
  }

  /* ── 以下整段已删除 ────────────────────────────────────────
   *
   * 「系统偏好写入 / 通知通道 / 接口预设数组读写 /
   *  URL 归一 / 模型缓存 / 模型下拉填充 / API 表单读写 /
   *  MINIMAX 表单 / 表单同步 / 各面板 render* 」
   *
   * 这些都是桌面设置 App 的 UI 支撑代码：读表单、填下拉、画面板。
   * 它们依赖的 DOM（#miya-st-panel-chat 等）已随设置 App 一起删除。
   * 对应能力已分别迁入：
   *   js2/miya-api-config.js       系统偏好 · 通知通道 · 预设 · 模型缓存 · URL 归一
   *   js1/miya-chat-contact-settings.js  各子视图的表单渲染
   *
   * 【已移除】原「存储用量代理」及其引擎 js2/miya-storage-usage.js
   * 按需求整体删除，不再有承接方。
   */

  function ensureApiPresetsReady() {
    if (!global.miyaApiPresets) return Promise.resolve([]);
    var cached = global.miyaApiPresets.getCached();
    if (cached) return Promise.resolve(cached);
    return global.miyaApiPresets.ensureReady().catch(function () { return []; });
  }

  /* 原「对话 API 面板预热 / showPanel / 顶栏保存键同步 / 主列表切换 /
     存储面板渲染」等一整段 UI 驱动逻辑已随桌面设置 App 删除。
     它们全部依赖 #miya-settings-app 的 DOM，留着只会是死代码。 */

  /* 备份/恢复（exportBackup · importBackup · 进度条 · IDB 清单 · 媒体打包）
     整段已迁到 js2/miya-backup.js，导出为 global.miyaBackup。
     这里原本那份是重复实现，删掉以免两套逻辑漂移。 */

  global.miyaSettingsApp = {
    open: function (panelId) {
      var map = {
        'miya-st-panel-chat': 'api-chat',
        'miya-st-panel-voice': 'api-voice',
        /* 生图已从聊天设置移除：它有独立全屏页（桌面「生图」图标进入），
           这里不再映射到任何子视图。旧代码若仍以该 id 调用，会落到下面的
           废弃告警分支，不会静默什么都没发生。 */
        'miya-st-panel-chat-defaults': 'chat-defaults',
        'miya-st-panel-msg-sound': 'notify'
        /* 【已移除】'miya-st-panel-storage': 'storage'
           存储用量功能整体删除，该 id 不再映射 —— 与 imagegen 同理，
           落到废弃告警分支而不是静默失败，便于外部调用方尽早发现。 */
      };
      var sub = map[panelId];
      if (sub && global.miyaChatContactSettings) {
        var st = global.miyaChatStore;
        var chat = st && st.getChats ? st.getChats()[0] : null;
        if (chat) {
          var mod = global.miyaChatContactSettings;
          if (typeof mod.openSubViewForChat === 'function') {
            mod.openSubViewForChat(chat.id, sub);
            return;
          }
        }
      }
      if (window.console && console.warn) {
        console.warn('[miya] miyaSettingsApp.open 已废弃：桌面设置 App 已删除，请改用 miyaChatContactSettings。panelId=' + panelId);
      }
    },
    close: function () {
      /* 设置 App 不存在了，但改由「联系人聊天设置」承载时，
         有些老代码用 close() 表示「把上面这层关掉」。
         转发给聊天设置，语义一致。 */
      if (global.miyaChatContactSettings && typeof global.miyaChatContactSettings.close === 'function') {
        global.miyaChatContactSettings.close();
      }
    },
    toast: function (msg) {
      if (typeof global.miyaToast === 'function') return global.miyaToast(msg);
    }
  };
})(window);
