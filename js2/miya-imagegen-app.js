/*
 * 生图设置 —— 独立全屏应用。
 *
 * ── 为什么要独立成一个 App ─────────────────────────────────────
 *
 * 生图原本是「桌面设置 App」里的一个子面板。桌面设置被删除后，
 * 面板本身不能跟着消失，因为桌面上的「生图」图标需要它 ——
 * 点进去就是这套设置 + 自由生图。
 *
 * 于是把它提成独立 App，由桌面图标直接打开。
 *
 * 注：聊天设置里那一栏「生图 API」已移除，改成只保留桌面这一个
 * 入口。原因是两边读写本就是同一份配置，二级入口纯属重复；
 * 联系人级的生图开关仍在「朋友圈与生图」分区里，不受影响。
 * 桌面设置 App 已删除，这里读写的配置不会再有任何竞争者。
 *
 * ── 一个必须守住的约束 ────────────────────────────────────────
 *
 * `js2/miya-image-gen.js:2874` 是这样找面板的：
 *
 *     var root = document.getElementById('miya-st-panel-imagegen');
 *
 * 固定的 ID 查找，不是事件委托。也就是说**面板的 id 与内部所有
 * 元素 id 一个都不能改**，否则生图模块的绑定会静默失效
 * （不报错，只是所有按钮都点不动 —— 这类问题最难查）。
 *
 * 所以这里只搬 DOM 结构，不改任何 id。按钮的事件绑定仍然由
 * MiyaImageGen.bindSettingsPanelEvents 负责，本文件只做
 * 「开/关这个页面」和「通知生图模块刷新表单」两件事。
 */
(function (global) {
  'use strict';

  var pageEl = null;
  var escBound = false;

  function $(id) { return document.getElementById(id); }

  function ensurePage() {
    if (pageEl) return pageEl;
    pageEl = document.createElement('div');
    pageEl.className = 'miya-igapp';
    pageEl.id = 'miya-igapp';
    pageEl.hidden = true;
    pageEl.setAttribute('aria-hidden', 'true');
    pageEl.innerHTML =
      '<div class="st-ambient-bg" aria-hidden="true"></div>' +
      '<header class="st-navbar miya-igapp__navbar">' +
        '<button type="button" class="st-navback" data-miya-igapp-back aria-label="返回">' +
          '<svg width="10" height="18" viewBox="0 0 10 18" fill="none" aria-hidden="true">' +
            '<path d="M9 1L1 9l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>' +
          '<span>返回</span>' +
        '</button>' +
        '<h1 class="st-navtitle">生图设置</h1>' +
        '<span class="miya-igapp__spacer" aria-hidden="true"></span>' +
      '</header>' +
      '<div class="st-scroll miya-igapp__scroll">' +
        '<div class="st-form">' +
        "<div class=\"miya-igapp-body\" id=\"miya-st-panel-imagegen\" data-panel-title=\"生图\">\n        <div class=\"st-form\">\n          <section class=\"st-form-section\">\n            <h4 class=\"st-form-section__title\">接口启用<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <div class=\"st-toggle-in-form\">\n                <strong>启用生图接口<\/strong>\n                <button type=\"button\" class=\"ins-toggle\" id=\"miya-st-ig-enabled\" role=\"switch\" aria-checked=\"false\"><\/button>\n              <\/div>\n              <p class=\"st-form-hint\">启用后可为联系人单独开启；角色文字图将调用生图 API 生成真实图片<\/p>\n              <fieldset class=\"miya-ig-provider-pick\">\n                <legend class=\"ins-field-label\">选择接口<\/legend>\n                <label class=\"miya-ig-provider-opt\"><input type=\"radio\" name=\"miya-st-ig-provider\" value=\"openai\" checked> OpenAI 兼容（第三方生图 API）<\/label>\n                <label class=\"miya-ig-provider-opt\"><input type=\"radio\" name=\"miya-st-ig-provider\" value=\"novelai\"> NovelAI<\/label>\n              <\/fieldset>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\" id=\"miya-st-ig-novelai-block\" hidden>\n            <h4 class=\"st-form-section__title\">NovelAI<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-base\">API 地址<\/label>\n              <input type=\"text\" class=\"ins-text-input\" id=\"miya-st-ig-na-base\" placeholder=\"https://image.novelai.net\" autocomplete=\"off\" spellcheck=\"false\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-key\">Persistent Token<\/label>\n              <input type=\"password\" class=\"ins-text-input\" id=\"miya-st-ig-na-key\" placeholder=\"pst-…\" autocomplete=\"off\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-model\">模型<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-na-model\"><option value=\"\">选择模型<\/option><\/select>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-sampler\">采样器<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-na-sampler\"><\/select>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-steps\">步数<\/label>\n              <input type=\"number\" class=\"ins-text-input\" id=\"miya-st-ig-na-steps\" min=\"1\" max=\"50\" value=\"28\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-scale\">CFG Scale<\/label>\n              <input type=\"number\" class=\"ins-text-input\" id=\"miya-st-ig-na-scale\" min=\"0\" max=\"10\" step=\"0.5\" value=\"5\">\n              <div class=\"st-toggle-in-form\">\n                <strong>SMEA<\/strong>\n                <button type=\"button\" class=\"ins-toggle\" id=\"miya-st-ig-na-sm\" role=\"switch\" aria-checked=\"false\"><\/button>\n              <\/div>\n              <div class=\"st-toggle-in-form\">\n                <strong>SMEA Dyn<\/strong>\n                <button type=\"button\" class=\"ins-toggle\" id=\"miya-st-ig-na-smdyn\" role=\"switch\" aria-checked=\"false\"><\/button>\n              <\/div>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-na-proxy\">反向代理地址（可选）<\/label>\n              <input type=\"text\" class=\"ins-text-input\" id=\"miya-st-ig-na-proxy\" placeholder=\"https://your-proxy.example.com\" autocomplete=\"off\" spellcheck=\"false\">\n              <p class=\"ins-field-hint\">直连出现 Failed to fetch / 网络错误时填这里绕过 CORS。留空则直连 image.novelai.net<\/p>\n              <div class=\"st-toggle-in-form\">\n                <strong>中文提示词自动翻译<\/strong>\n                <button type=\"button\" class=\"ins-toggle\" id=\"miya-st-ig-na-cjk\" role=\"switch\" aria-checked=\"true\"><\/button>\n              <\/div>\n              <p class=\"ins-field-hint\">开启后，中文外貌描述会自动转成 Danbooru 英文标签（NovelAI 对该格式识别更好）。关闭则原样提交。<\/p>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\">\n            <h4 class=\"st-form-section__title\">提示词与尺寸<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-pos\">正向提示词（全局画风底料）<\/label>\n              <textarea class=\"ins-text-input ins-text-input--area\" id=\"miya-st-ig-pos\" rows=\"3\" placeholder=\"每张图都会拼上的固定词，如：anime style, masterpiece, best quality…\"><\/textarea>\n              <p class=\"st-form-hint\">这里不是“本次画什么”——每次要画的内容填在「自由生图 → 画面描述」（联系人生图则取自聊天内容），两张图拼完才是发给接口的完整正向提示词<\/p>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-neg\">反向提示词（全局避免项）<\/label>\n              <textarea class=\"ins-text-input ins-text-input--area\" id=\"miya-st-ig-neg\" rows=\"2\" placeholder=\"每张图都会拼上的固定避免词，如：lowres, watermark…\"><\/textarea>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-size\">图片尺寸<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-size\"><\/select>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\">\n            <h4 class=\"st-form-section__title\">提示词预设<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-preset-pick\">选择提示词预设<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-preset-pick\"><option value=\"\">选择已存提示词预设<\/option><\/select>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-preset-name\">预设名称<\/label>\n              <input type=\"text\" class=\"ins-text-input\" id=\"miya-st-ig-preset-name\" placeholder=\"例如：赛博少女·夜景\" maxlength=\"64\">\n              <div class=\"miya-ig-preset-actions\">\n                <button type=\"button\" class=\"st-action-btn st-action-btn--primary\" id=\"miya-st-ig-preset-save\">保存预设<\/button>\n                <button type=\"button\" class=\"st-action-btn\" id=\"miya-st-ig-preset-load\">读取预设<\/button>\n                <button type=\"button\" class=\"st-action-btn\" id=\"miya-st-ig-preset-delete\">删除预设<\/button>\n              <\/div>\n              <p class=\"st-form-hint\">同名预设将自动覆盖；只保存正向与反向提示词，不影响接口、尺寸等其它配置<\/p>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\">\n            <h4 class=\"st-form-section__title\">测试<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <div class=\"miya-ig-test-wrap\" id=\"miya-st-ig-test-preview\"><\/div>\n              <button type=\"button\" class=\"st-action-btn st-action-btn--primary\" id=\"miya-st-ig-test\">测试生图<\/button>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\">\n            <h4 class=\"st-form-section__title\">自由生图<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <p class=\"st-form-hint\">直接描述你想要的画面，无需绑定联系人即可出图<\/p>\n\n              <!-- ── 垫图（图生图）────────────────────────────────\n                   放在画面描述之前：先定「有没有底图」，再定「要画什么」，\n                   顺序上更符合实际操作的心智。\n                   没有垫图时不占视觉重量（只有一行标题和两个按钮）。 -->\n              <div class=\"miya-ig-ref\" id=\"miya-st-ig-free-ref\">\n                <div class=\"miya-ig-ref__head\">\n                  <span class=\"miya-ig-ref__label\">垫图（图生图）<\/span>\n                  <span class=\"miya-ig-ref__tip\">可选择要参考的图片，也可直接纯文字生图<\/span>\n                <\/div>\n                <div class=\"miya-ig-ref__preview\" id=\"miya-st-ig-free-ref-preview\">\n                  <div class=\"miya-ig-ref__empty\"><p>未选择垫图（当前为纯文字生图）<\/p><\/div>\n                <\/div>\n                <div class=\"miya-ig-ref__actions\">\n                  <button type=\"button\" class=\"st-action-btn st-action-btn--xs\" id=\"miya-st-ig-free-ref-upload\">本地上传<\/button>\n                  <button type=\"button\" class=\"st-action-btn st-action-btn--xs\" id=\"miya-st-ig-free-ref-album\">我的相册<\/button>\n                  <button type=\"button\" class=\"st-action-btn st-action-btn--xs\" id=\"miya-st-ig-free-ref-clear\" disabled>清空垫图<\/button>\n                <\/div>\n                <div class=\"miya-ig-ref__modes\" id=\"miya-st-ig-free-ref-mode-wrap\">\n                  <span class=\"miya-ig-ref__modes-label\">垫图程度<\/span>\n                  <div class=\"miya-ig-seg\" role=\"group\" aria-label=\"垫图程度\">\n                    <button type=\"button\" class=\"miya-ig-seg__item is-on\" data-ig-free-ref-mode=\"style\" aria-pressed=\"true\">参考风格<\/button>\n                    <button type=\"button\" class=\"miya-ig-seg__item\" data-ig-free-ref-mode=\"redraw\" aria-pressed=\"false\">照着重画<\/button>\n                  <\/div>\n                  <p class=\"miya-ig-ref__modes-hint\">「参考风格」只借画风配色；「照着重画」更贴近原图构图。选中小图后这两档才生效。<\/p>\n                <\/div>\n                <p class=\"st-form-hint miya-ig-ref__legal\">参考图仅针对支持图片输入的模型生效。严禁上传无版权、无授权的图片信息；严禁未经他人允许上传他人肖像信息。<\/p>\n              <\/div>\n\n              <div class=\"st-toggle-in-form\">\n                <strong>包含预置提示词<\/strong>\n                <button type=\"button\" class=\"ins-toggle is-on\" id=\"miya-st-ig-free-nopreset\" role=\"switch\" aria-checked=\"true\"><\/button>\n              <\/div>\n              <p class=\"st-form-hint\">开启时把生图设置里的全局正向/反向提示词（以及提示词预设载入的内容）拼进请求；关掉后只按你输入的描述出图 —— 输入「小麦」就是纯麦田，不会被之前存的画风词带偏。联系人生图不受此开关影响。<\/p>\n\n              <label class=\"ins-field-label\" for=\"miya-st-ig-free-prompt\">画面描述<\/label>\n              <textarea class=\"ins-text-input ins-text-input--area\" id=\"miya-st-ig-free-prompt\" rows=\"3\" placeholder=\"例如：黄昏的海边，一位少女提着裙摆奔跑，逆光，电影感\"><\/textarea>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-free-size\">图片尺寸<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-free-size\"><\/select>\n              <div class=\"miya-ig-free-actions\">\n                <button type=\"button\" class=\"st-action-btn st-action-btn--primary\" id=\"miya-st-ig-free-run\">生成图片<\/button>\n                <button type=\"button\" class=\"st-action-btn\" id=\"miya-st-ig-free-save\">保存到相册<\/button>\n              <\/div>\n              <div class=\"miya-ig-test-wrap miya-ig-free-wrap\" id=\"miya-st-ig-free-preview\">\n                <div class=\"miya-ig-test miya-ig-test--idle\"><p>输入描述后点击「生成图片」<\/p><\/div>\n              <\/div>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\" id=\"miya-st-ig-openai-block\">\n            <h4 class=\"st-form-section__title\">OpenAI 兼容<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-oa-base\">网关地址<\/label>\n              <input type=\"text\" class=\"ins-text-input\" id=\"miya-st-ig-oa-base\" placeholder=\"https://api.openai.com\" autocomplete=\"off\" spellcheck=\"false\">\n              <label class=\"ins-field-label\" for=\"miya-st-ig-oa-key\">密钥<\/label>\n              <div class=\"ins-inline-field\">\n                <input type=\"password\" class=\"ins-text-input\" id=\"miya-st-ig-oa-key\" placeholder=\"sk-…\" autocomplete=\"off\">\n                <button type=\"button\" class=\"ins-icon-btn\" id=\"miya-st-ig-oa-fetch\" title=\"拉取模型\">⟳<\/button>\n              <\/div>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-oa-model\">模型<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-oa-model\"><option value=\"\">选择模型<\/option><\/select>\n              <!-- 尺寸方言：决定「这个端点接受哪些宽高」。\n                   中转站把 NovelAI 包成 OpenAI 形状时，model 里填的是\n                   nai-diffusion-* 之类的名字，靠模型名猜不出约束，\n                   所以让用户直接声明连的是什么端点。 -->\n              <label class=\"ins-field-label\" for=\"miya-st-ig-oa-dialect\">尺寸方言<\/label>\n              <select class=\"ins-select\" id=\"miya-st-ig-oa-dialect\">\n                <option value=\"generic\">通用（64 倍数）· 推荐，适配中转站 / NovelAI / SD<\/option>\n                <option value=\"gptimage\">GPT-Image（含 2:3 / 3:2）<\/option>\n                <option value=\"dalle3\">DALL·E 3（仅 3 种尺寸）<\/option>\n                <option value=\"dalle2\">DALL·E 2（仅正方形）<\/option>\n                <option value=\"custom\">自定义（不校验，原样发送）<\/option>\n              <\/select>\n              <p class=\"st-form-hint\">走中转站请保持「通用」—— 这样 3:4、4:3 等比例才可选<\/p>\n              <!-- 接口预设：与「对话 API」面板同款（下拉载入 + ✓ 保存 + × 删除） -->\n              <label class=\"ins-field-label\" for=\"miya-st-ig-oa-preset-pick\">载入预设<\/label>\n              <div class=\"ins-inline-field\">\n                <select class=\"ins-select\" id=\"miya-st-ig-oa-preset-pick\"><option value=\"\">选择已存预设<\/option><\/select>\n                <button type=\"button\" class=\"ins-icon-btn\" id=\"miya-st-ig-oa-preset-delete\" title=\"删除预设\">×<\/button>\n              <\/div>\n              <label class=\"ins-field-label\" for=\"miya-st-ig-oa-preset-name\">预设名称<\/label>\n              <div class=\"ins-inline-field\">\n                <input type=\"text\" class=\"ins-text-input\" id=\"miya-st-ig-oa-preset-name\" placeholder=\"例如：中转·gpt-image-1\" maxlength=\"64\">\n                <button type=\"button\" class=\"ins-icon-btn\" id=\"miya-st-ig-oa-preset-save\" title=\"保存预设\">✓<\/button>\n              <\/div>\n              <p class=\"st-form-hint\">仅保存 OpenAI 兼容接口的网关、密钥与模型<\/p>\n            <\/div>\n          <\/section>\n\n          <section class=\"st-form-section\" id=\"miya-st-ig-contacts-block\" hidden>\n            <h4 class=\"st-form-section__title\">联系人生图<\/h4>\n            <div class=\"st-form-card ins-form-block\">\n              <p class=\"st-form-hint\">为各联系人单独开启后，其聊天与朋友圈文字图将调用生图 API<\/p>\n              <div id=\"miya-st-ig-contacts-list\"><\/div>\n            <\/div>\n          <\/section>\n          <!-- 生图的保存逻辑由 miya-image-gen.js 通过面板事件委托实现，\n               这里保留一个不可见触发器，供顶栏「保存」按钮转发点击使用。 -->\n          <button type=\"button\" id=\"miya-st-ig-save\" hidden aria-hidden=\"true\" tabindex=\"-1\"><\/button>\n        <\/div>\n      <\/div>";
    document.body.appendChild(pageEl);
    bindEvents();
    return pageEl;
  }

  function bindEvents() {
    if (escBound || !pageEl) return;
    escBound = true;
    pageEl.addEventListener('click', function (e) {
      if (e.target.closest('[data-miya-igapp-back]')) close();
    });
  }

  function open() {
    ensurePage();
    pageEl.hidden = false;
    pageEl.classList.add('is-open');
    pageEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('miya-app-open');
    /*
     * 交给生图模块自己刷新表单与绑事件 ——
     * 它内部会调 syncSettingsFormFromConfig()（把配置填进表单）、
     * ensurePresetsReady()（拉预设下拉）等。
     * 同时它会 bindSettingsPanelEvents()，那个函数有 _done 守卫，
     * 重复调用是安全的。
     */
    if (global.MiyaImageGen && typeof global.MiyaImageGen.onSettingsPanelOpen === 'function') {
      try { global.MiyaImageGen.onSettingsPanelOpen(); } catch (e) {}
    }
    return true;
  }

  function close() {
    if (!pageEl) return;
    pageEl.classList.remove('is-open');
    pageEl.hidden = true;
    pageEl.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.miya-beautify-app.is-open') &&
        !document.querySelector('.miya-worldbook-app.is-open') &&
        !document.querySelector('.miya-contacts-app.is-open')) {
      document.body.classList.remove('miya-app-open');
    }
  }

  function isOpen() {
    return !!(pageEl && pageEl.classList.contains('is-open'));
  }

  global.MiyaImageGenApp = {
    open: open,
    close: close,
    isOpen: isOpen
  };
})(typeof window !== 'undefined' ? window : globalThis);
