(function (global) {
  'use strict';

  /* 单模式（小手机）。原三模式系统（模拟器 / 大世界）已移除，
     本文件保留为「启动器」职责：给 .phone 挂上模式基础类并激活它。
     保留该文件是为了不破坏既有加载顺序与外部对 window.miyaModeSwitch 的调用。 */

  var PHONE_LAYER_SELECTOR = '.phone.miya-mode-layer';

  function wrapPhoneLayer() {
    var phone = document.querySelector('.phone');
    if (!phone) return null;
    if (!phone.classList.contains('miya-mode-layer')) phone.classList.add('miya-mode-layer');
    if (!phone.id) phone.id = 'miya-phone-layer';
    return phone;
  }

  function applyBodyClass() {
    document.body.classList.remove('miya-mode-sim', 'miya-mode-world');
    document.body.classList.add('miya-mode-phone');
  }

  function activatePhoneLayer() {
    var layer = document.querySelector(PHONE_LAYER_SELECTOR);
    if (!layer) return;
    layer.classList.remove('is-leaving');
    layer.classList.add('is-active');
  }

  function init() {
    wrapPhoneLayer();
    applyBodyClass();
    activatePhoneLayer();
  }

  global.miyaModeSwitch = {
    init: init,
    /* 兼容旧调用点：已无其它模式，切到自己即无操作 */
    setMode: function (modeId) {
      if (!modeId || modeId === 'phone' || modeId === '小手机') {
        activatePhoneLayer();
      }
      return Promise.resolve();
    },
    getMode: function () { return 'phone'; }
  };
})(window);
