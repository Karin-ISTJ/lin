/**
 * Miya 扩展示例 —— 复制后发布到 GitHub，在设置 → GitHub 插件 里安装。
 * 也可本地用控制台：先加载本文件，再观察生成日志。
 */
(function () {
  'use strict';
  if (!window.MiyaPlugins || typeof window.MiyaPlugins.register !== 'function') {
    console.warn('[example-plugin] MiyaPlugins 未就绪');
    return;
  }

  window.MiyaPlugins.register({
    id: 'miya-example-logger',
    name: '示例·生成日志',
    version: '1.0.0',
    description: '在控制台打印生成前后上下文，演示扩展钩子',
    onLoad: function (api) {
      api.toast('示例插件已加载');
      var n = Number(api.getSettings().runCount || 0);
      api.setSettings({ runCount: n + 1 });
    },
    hooks: {
      beforeGenerate: function (ctx) {
        console.log('[example-plugin] beforeGenerate', ctx.scope, ctx.chatId, 'msgs=', (ctx.messages || []).length);
        // 示例：可在此修改 ctx.messages 后 return ctx
        return ctx;
      },
      afterGenerate: function (ctx) {
        console.log('[example-plugin] afterGenerate', ctx.scope, ctx.chatId);
      },
      onRoomOpen: function (ctx) {
        console.log('[example-plugin] room open', ctx.chatId);
      }
    }
  });
})();
