var CACHE = 'miya-v311-karin';
/*
 * 版本哨兵：SW 侧的构建号。
 * index.html 里有同值的 <meta name="miya-sw-build" content="sw-3">，
 * app.js 会在收到 SW 广播时比对两者：SW 比页面新 → 自动刷新一次页面。
 * 只增不减：每次改动 sw.js / 任何需要立刻生效的资源策略时 bump 尾号。
 */
var BUILD = 'sw-82';
/* SWR 竞速超时：超过此时长未获网络响应就用缓存顶上（后台继续拉新版）。
   本地/快服务器 304 协商远低于此值（行为同旧 networkFirst）；
   慢服务器 200 个协商请求不再各等一个完整 RTT —— 首屏从分钟级回秒级。 */
var NETWORK_TIMEOUT_MS = 400;
var FILES = ['./', './index.html', './css/style.css', './css/miya-apps.css', './css/miya-chat.css', './css/miya-offline.css', './css/miya-offline-themes.css', './css/miya-offline-card.css', './css/miya-offline-plot.css', './js1/app.js', './js1/miya-appointment-app.js', './js1/miya-appointment-engine.js', './js1/miya-appointment-store.js', './js2/miya-offline-plot.js', './manifest.json', './img/miya-icon.png', './img/miya-icon-192.png', './img/miya-icon-512.png'];
/* BGM（farm-bgm-1.mp3, 1.9M）已从预缓存摘除：农场 BGM 走运行时 cacheFirst
   （首次在线播放时拉取一次即永久缓存），不再拖慢 SW install/activate。 */
/* html/css/js/json + PWA icons: always prefer network so home-screen name/icon update */
var STATIC_LIVE = /\.(?:html|css|js|webmanifest|json)$|\/$|miya-icon(?:-\d+)?\.png/;

/*
 * ─────────────────────────────────────────────────────────────────────
 * 缓存 key 归一化 —— 「改完几天又复发」的根治点
 *
 * 背景（症状）：修好的 bug 过一两天又出现。代码在磁盘上是新的、
 * 沙箱里测试全绿，但用户浏览器某些时刻跑的仍是旧版脚本。
 *
 * 旧机制的两条"旧代码复活"通道：
 *   ① networkFirst 回退按「路径」找缓存里**任意 ?v=** 的副本
 *     （原 matchIgnoringVersion，注释自己写着"宁可先用一份稍旧的实现"——
 *      对显示类代码可接受，对逻辑修复就是旧 bug 复活）；
 *   ② cache.put 的 key 是「含 ?v= 的完整 URL」，且 SW fetch 可能命中
 *     浏览器 HTTP 缓存里的旧响应 → 旧内容被当"网络成功"吞进缓存。
 *     一旦发布时漏 bump ?v=（历史上实锤过），旧副本永不过期。
 *
 * 新机制：所有 put / match 一律走「去查询串、目录路径补 index.html」
 * 的归一 key。效果：
 *   · 每个资源路径在缓存里**永远只有一份副本**，且等于
 *     **最后一次在线成功获取的版本** —— "任意旧版本回退"结构性消失；
 *   · ?v= 参数从此只是绕过 HTTP 缓存的加速手段，不再是正确性依赖
 *     （漏 bump 也不会喂旧代码：no-cache 协商后成功响应覆盖同 key）；
 *   · 导航请求 '/'、'/?source=pwa'（PWA 启动 URL）与 '/index.html'
 *     归一为同一 key，三处入口共享同一份最新副本。
 * ─────────────────────────────────────────────────────────────────────
 */
function normalizeCacheUrl(url) {
  var u;
  try { u = new URL(url); } catch (e) { return String(url || ''); }
  u.search = '';
  var p = u.pathname || '/';
  if (p.charAt(p.length - 1) === '/') u.pathname = p + 'index.html';
  return u.toString();
}

function cacheKeyRequest(request) {
  return new Request(normalizeCacheUrl(request.url));
}

self.addEventListener('install', function (e) {
  /* addAll 的 key 是原始 URL（'./' 与 './index.html' 会成为两个不同 key），
     改为逐个 fetch 后 put 到归一 key；单个失败不阻塞 install ——
     基础资源随后由 networkFirst 的成功路径自动补齐。 */
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FILES.map(function (f) {
      return fetch(f, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) {
          return c.put(new Request(normalizeCacheUrl(new URL(f, self.location.href).toString())), res);
        }
      }).catch(function () { /* 见上：单个失败不阻塞 */ });
    }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) {
        return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () {
        /* 清掉当前 CACHE 里带查询串的旧格式 key（上一版 SW 的带参 put 残留）。
           归一 key 机制下它们永远不会再被命中，只会占体积。 */
        return caches.open(CACHE).then(function (c) {
          return c.keys().then(function (reqs) {
            var stale = [];
            for (var i = 0; i < reqs.length; i++) {
              var u;
              try { u = new URL(reqs[i].url); } catch (e2) { continue; }
              if (u.search) stale.push(reqs[i]);
            }
            return Promise.all(stale.map(function (r) { return c.delete(r); }));
          });
        });
      })
      .then(function () { return self.clients.claim(); })
      .then(function () {
        /* 版本哨兵广播：新 SW 接管后立刻把构建号推给所有窗口。
           页面侧（app.js）与 <meta name="miya-sw-build"> 比对：
           SW 更新 → 自动刷新一次（sessionStorage 防循环）。
           这兜住"磁盘已是新版、当前页面还捧着旧副本"的窗口期。 */
        return self.clients.matchAll({ includeUncontrolled: true }).then(function (list) {
          for (var j = 0; j < list.length; j++) {
            try { list[j].postMessage({ type: 'miya-sw-build', build: BUILD, cache: CACHE }); } catch (e3) {}
          }
        });
      })
  );
});

/* 页面主动询问构建号（防广播早于本页注册监听而错过） */
self.addEventListener('message', function (event) {
  var d = event && event.data;
  if (d && d.type === 'miya-get-build' && event.source) {
    try { event.source.postMessage({ type: 'miya-sw-build', build: BUILD, cache: CACHE }); } catch (e) {}
  }
  /* 预刷新握手（修「网页老是自动刷新」）：
     旧哨兵发现 SW 比页面新就直接 reload，但慢网下页面 HTML 本来就是
     缓存旧版顶上的 —— 刷新后拿到的还是旧 HTML（meta 依旧落后），
     而那次 reload 还会掐断后台正在写缓存的网络请求，于是缓存永远
     更新不了，每个新会话首开都要白刷一次。
     现在改成：页面先发 miya-prepare-reload，由 SW 把最新 index.html
     拉下来（SW 内 fetch 不经过本 fetch handler，是直连网络）、
     【等 put 落盘后】回执页面 —— 页面只有确认缓存里已是更新的文档
     才刷新，刷新必到位；拉不到（离线/慢网）就安静等下次导航的
     后台 revalidate，一个会话都不骚扰。 */
  if (d && d.type === 'miya-prepare-reload' && event.source) {
    var src = event.source;
    var htmlUrl, htmlKey;
    try {
      htmlUrl = new URL('./index.html', self.location.href).toString();
      htmlKey = normalizeCacheUrl(htmlUrl);
    } catch (eU) { htmlUrl = ''; }
    if (!htmlUrl) {
      try { src.postMessage({ type: 'miya-reload-ready', meta: 0 }); } catch (eU2) {}
      return;
    }
    fetch(htmlUrl, { cache: 'no-cache' })
      .then(function (res) {
        if (!res || !res.ok) return 0;
        return res.text().then(function (t) {
          var m = /name=["']miya-sw-build["'][^>]*content=["']sw-?(\d+)/i.exec(t);
          if (!m) return 0;
          /* put 必须等完成：页面收到回执马上 reload，慢半拍缓存里还是旧的 */
          return caches.open(CACHE).then(function (c) {
            return c.put(
              new Request(htmlKey),
              new Response(t, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
            ).then(function () { return Number(m[1]); });
          });
        });
      })
      .then(function (metaNum) {
        try { src.postMessage({ type: 'miya-reload-ready', meta: metaNum || 0 }); } catch (eR) {}
      })
      .catch(function () {
        try { src.postMessage({ type: 'miya-reload-ready', meta: 0 }); } catch (eC) {}
      });
  }
});

/** 从 OPFS 流式响应大 ZIP，避免主线程把整包读进内存再分享 */
function respondOpfsDownload(requestUrl) {
  var url = new URL(requestUrl);
  var name = decodeURIComponent((url.pathname.split('/miya-opfs-dl/')[1] || '').replace(/\/$/, ''));
  if (!name) {
    return Promise.resolve(new Response('missing file', { status: 400 }));
  }
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    return Promise.resolve(new Response('opfs unavailable', { status: 500 }));
  }
  return navigator.storage.getDirectory().then(function (root) {
    return root.getDirectoryHandle('miya-backup-tmp').then(function (dir) {
      return dir.getFileHandle(name).then(function (fh) {
        return fh.getFile().then(function (file) {
          var headers = {
            'Content-Type': 'application/zip',
            'Content-Length': String(file.size),
            'Content-Disposition': 'attachment; filename="' + name.replace(/"/g, '') + '"',
            'Cache-Control': 'no-store'
          };
          var body = typeof file.stream === 'function' ? file.stream() : file;
          return new Response(body, { status: 200, headers: headers });
        });
      });
    });
  }).catch(function (err) {
    return new Response(String(err && err.message ? err.message : 'opfs read failed'), { status: 404 });
  });
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url;
  try {
    url = new URL(e.request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  var path = url.pathname;

  if (path.indexOf('/miya-opfs-dl/') >= 0) {
    e.respondWith(respondOpfsDownload(e.request.url));
    return;
  }

  function cacheFirst(request) {
    var key = cacheKeyRequest(request);
    return caches.open(CACHE).then(function (c) {
      return c.match(key).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (res) {
          if (res.ok) c.put(key, res.clone());
          return res;
        });
      });
    });
  }

  function networkFirst(request) {
    /* SWR（stale-while-revalidate）策略：
       ① 网络请求带 cache:'no-cache' 协商验证（防 HTTP 层旧响应吞缓存）；
       ② 400ms 内网络回来 → 直接用网络响应（服务器支持 304 时协商极快，
          保持"永远最新"）；
       ③ 400ms 超时 → 立即用缓存顶上（慢服务器不再让 200 个请求各等一个
          完整 RTT），网络在后台继续，成功后 put 覆盖归一 key——
          下次打开就是新版。旧副本最多存活"一个刷新窗口"，可自愈。
       ④ 无缓存且超时 → 继续等网络（首访没有缓存可顶）；
       ⑤ 网络失败 → 归一 key 精确匹配兜底，仍无则 503。 */
    var keyReq = cacheKeyRequest(request);
    var network = fetch(request, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(keyReq, copy); }).catch(function () {});
      }
      return res;
    });
    var race = new Promise(function (resolve) {
      setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT_MS);
    });
    return Promise.race([network.catch(function () { return null; }), race])
      .then(function (res) {
        if (res) return res;
        return caches.open(CACHE).then(function (c) {
          return c.match(keyReq).then(function (hit) {
            return hit || network;
          });
        });
      })
      .catch(function () {
        return caches.open(CACHE).then(function (c) {
          return c.match(keyReq).then(function (hit) {
            return hit || new Response('', { status: 503, statusText: 'Offline' });
          });
        });
      });
  }

  if (STATIC_LIVE.test(path)) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  e.respondWith(cacheFirst(e.request));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  /* 目标 URL 只拼一次，供「没有可用窗口」时新开使用 */
  function buildOpenUrl() {
    var openUrl = data.url || './';
    if (data.kind === 'weather_care' && data.careId) {
      openUrl += (openUrl.indexOf('#') >= 0 ? '&' : '#') + 'miya-open-weather-care=' + encodeURIComponent(data.careId);
    } else if (data.chatId) {
      openUrl += (openUrl.indexOf('#') >= 0 ? '&' : '#') + 'miya-open-chat=' + encodeURIComponent(data.chatId);
    }
    return openUrl;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      /* 优先挑「地址干净、不带 miya-open-chat 残留」的窗口。
         背景：某些壳浏览器（如 Via）后台窗口被冻结后仍留在 clients 列表里，
         而且它对 history.replaceState 支持不完整，上次的 #miya-open-chat=xxx
         会一直黏在地址上。若直接 focus 这种窗口，用户会看到
         「一点就跳进上次那个角色」——且关掉浏览器再开依旧复现。
         所以把带残留 hash 的窗口排到最后，宁可新开一个干净窗口。 */
      var clean = [], dirty = [];
      for (var i = 0; i < list.length; i++) {
        var u = '';
        try { u = list[i].url || ''; } catch (e) {}
        if (u.indexOf('miya-open-chat') >= 0 || u.indexOf('miya-open-weather-care') >= 0) dirty.push(list[i]);
        else clean.push(list[i]);
      }
      var ordered = clean.concat(dirty);
      for (var j = 0; j < ordered.length; j++) {
        var client = ordered[j];
        client.postMessage({
          type: 'miya-notify-click',
          chatId: data.chatId || '',
          kind: data.kind || '',
          careId: data.careId || '',
          contactId: data.contactId || ''
        });
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(buildOpenUrl());
      }
    })
  );
});
