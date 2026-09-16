/**
 * Miya 聊天 · 相册选图器
 *
 * 一个轻量的浮层：把「我的相册」里的照片以九宫格列出来，点一张就回调。
 *
 * 为什么单独写一个模块 —— 项目里没有现成的通用相册选图器。
 * 现有的两个都不可复用：
 *   · 相册页面本身（js1/miya-chat-album.js）是整屏视图，走的是它自己那套
 *     导航状态机（getNav/setNav/renderTop/popFn），把它塞进设置面板等于
 *     把两个状态机焊在一起；
 *   · 壁纸库选择器（js1/miya-chat-wallpaper-picker.js）是内联展开面板，
 *     而且数据源是 getChatWallpapers()，跟相册照片不是一回事。
 *
 * 所以这里只做一件最小的事：读相册数据 → 渲染网格 → 把 blobId 换成
 * objectURL 填进缩略图 → 点击回调。
 *
 * 缩略图用的是 thumbBlobId（320 长边）；老照片没有这个字段时回落主图
 * （与相册页面同款回落逻辑，见 miya-chat-album.js 的 albumThumbId）。
 * 但**回调交出去的是主图 blobId** —— 缩略图太小，拿它当垫图会糊。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getStore() {
    return global.miyaChatStore || null;
  }

  function trim(s) {
    return String(s == null ? '' : s).trim();
  }

  /* 缩略图优先，没有就回落主图 */
  function thumbIdOf(ph) {
    return String(ph.thumbBlobId || ph.blobId || '');
  }

  function listPhotos() {
    var album = global.MiyaChatAlbum;
    if (!album || typeof album.getAlbum !== 'function') return [];
    var st = getStore();
    var profile = st && st.getActiveProfile ? st.getActiveProfile() : null;
    var pid = profile && profile.id ? String(profile.id) : '';
    if (!pid) return [];
    var row = album.getAlbum(pid);
    return (row && Array.isArray(row.photos)) ? row.photos : [];
  }

  function ensureRoot() {
    var root = document.getElementById('miya-album-picker');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'miya-album-picker';
    root.className = 'miya-album-picker';
    root.hidden = true;
    root.innerHTML =
      '<div class="miya-album-picker__mask" data-mi-ap-close></div>' +
      '<div class="miya-album-picker__sheet" role="dialog" aria-modal="true" aria-label="从相册选择">' +
        '<div class="miya-album-picker__head">' +
          '<strong class="miya-album-picker__title">从相册选择</strong>' +
          '<button type="button" class="miya-album-picker__close" data-mi-ap-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="miya-album-picker__body" data-mi-ap-body></div>' +
      '</div>';
    document.body.appendChild(root);

    /*
     * 事件委托绑在**根节点**上，而不是每次打开重新绑 ——
     * 委托绑在根上就不会因为反复渲染内层 body 而重复挂监听器，
     * 这也是项目里相册/设置面板一致的写法。
     */
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-mi-ap-close]')) {
        close();
        return;
      }
      var cell = e.target.closest('[data-mi-ap-pick]');
      if (!cell) return;
      var id = cell.getAttribute('data-mi-ap-pick');
      var cb = pickerState.onPick;
      var photos = pickerState.photos || [];
      var photo = photos.find(function (p) { return String(p.id) === String(id); }) || null;
      close();
      if (typeof cb === 'function' && photo) cb(photo);
    });
    return root;
  }

  var pickerState = { onPick: null, photos: [], token: 0, generation: 0, openGen: 0 };

  function renderBody(bodyEl, photos) {
    if (!photos.length) {
      bodyEl.innerHTML = '<p class="miya-album-picker__empty">相册里还没有照片。<br>先去「我的相册」上传几张，再回来选作垫图。</p>';
      return;
    }
    bodyEl.innerHTML = '<div class="miya-album-picker__grid">' + photos.map(function (ph) {
      return '<button type="button" class="miya-album-picker__cell" data-mi-ap-pick="' + esc(ph.id) + '"' +
        ' data-mi-ap-thumb="' + esc(thumbIdOf(ph)) + '" aria-label="选择这张照片"></button>';
    }).join('') + '</div>';
  }

  /**
   * 把 blobId 换成 objectURL 填进每个格子的背景图。
   *
   * getAvatarUrl 名字听着像只给头像用，实际它就是通用的
   * blobId → objectURL 访问器（内部即 getBlobUrl）。相册照片同样走它。
   * 用 token 防止竞态：连开两次时，先返回的那批不该盖住后开的界面。
   */
  function hydrateThumbs(bodyEl, token) {
    var st = getStore();
    if (!st || typeof st.getAvatarUrl !== 'function') return;
    bodyEl.querySelectorAll('[data-mi-ap-thumb]').forEach(function (cell) {
      var bid = cell.getAttribute('data-mi-ap-thumb');
      if (!bid) return;
      st.getAvatarUrl(bid).then(function (url) {
        if (!url || token !== pickerState.token) return;
        cell.style.backgroundImage = 'url("' + String(url).replace(/"/g, '') + '")';
      }).catch(function () {});
    });
  }

  function open(onPick) {
    var root = ensureRoot();
    var album = global.MiyaChatAlbum;
    pickerState.onPick = onPick;
    pickerState.token += 1;
    /*
     * 记下这一轮打开属于第几代。
     *
     * 为什么需要它 —— close() 里挂着一个 260ms 后才执行的 finish()，
     * 用来在过渡结束后把浮层 hidden。如果用户「关掉、马上又点开」，
     * 那个还没执行的 finish() 会在新的一轮打开之后才跑，把刚显示的
     * 浮层又藏起来 —— 现象就是「点了没反应，得再点一次」。
     * 实测确实能复现（关掉后立刻 open，浮层 visible=false）。
     *
     * 所以每次 open/close 都推进 generation，finish() 执行时对不上号
     * 就直接放弃。
     */
    var gen = ++pickerState.generation;
    pickerState.openGen = gen;
    var bodyEl = root.querySelector('[data-mi-ap-body]');

    root.hidden = false;
    /* 下一帧再加 is-open，让 CSS 过渡真的跑起来（同一帧加类浏览器不会过渡） */
    requestAnimationFrame(function () { root.classList.add('is-open'); });

    function paint() {
      var photos = listPhotos();
      pickerState.photos = photos;
      renderBody(bodyEl, photos);
      hydrateThumbs(bodyEl, pickerState.token);
    }

    /*
     * 相册数据是异步就绪的（whenReady 之后才有内容），
     * 直接同步读可能读到空相册 —— 先等它就绪，再画。
     */
    if (album && typeof album.whenReady === 'function') {
      album.whenReady().then(paint).catch(paint);
    } else {
      paint();
    }
  }

  function close() {
    var root = document.getElementById('miya-album-picker');
    pickerState.onPick = null;
    pickerState.token += 1;
    if (!root) return;
    var gen = ++pickerState.generation;
    root.classList.remove('is-open');
    /*
     * 等过渡结束再 hidden。
     * 但**不能只靠 transitionend** —— 它可能因为元素被隐藏而根本不触发，
     * 那样浮层就永远关不掉了。所以配一个定时兜底。
     *
     * 两个来源都必须在执行前核对代际：只要期间又 open() 过，
     * 这次隐藏就作废（否则会把新打开的浮层一起藏掉）。
     */
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      if (gen !== pickerState.generation) return;
      root.hidden = true;
    }
    root.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 260);
  }

  function isOpen() {
    var root = document.getElementById('miya-album-picker');
    return !!(root && !root.hidden && root.classList.contains('is-open'));
  }

  global.MiyaChatAlbumPicker = {
    open: open,
    close: close,
    isOpen: isOpen,
    listPhotos: listPhotos,
    /* 测试后门：直接读当前渲染出来的格子数 */
    __cellCount: function () {
      var root = document.getElementById('miya-album-picker');
      return root ? root.querySelectorAll('[data-mi-ap-pick]').length : 0;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
