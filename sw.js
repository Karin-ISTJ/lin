var CACHE = 'miya-v263-karin';
/*
 * 版本哨兵：SW 侧的构建号。
 * index.html 里有同值的 <meta name="miya-sw-build" content="sw-3">，
 * app.js 会在收到 SW 广播时比对两者：SW 比页面新 → 自动刷新一次页面。
 * 只增不减：每次改动 sw.js / 任何需要立刻生效的资源策略时 bump 尾号。
 */
var BUILD = 'sw-20';
var FILES = ['./', './index.html', './css/style.css', './css/miya-apps.css', './css/miya-chat.css', './js1/app.js', './manifest.json', './img/miya-icon.png', './img/miya-icon-192.png', './img/miya-icon-512.png'];
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
    /* cache:'no-cache' —— 每次向服务器协商验证。
       防的是 HTTP 层旧响应：?v= 不变时浏览器 HTTP 缓存在自身新鲜期内
       仍可能返回旧文件，SW 会把这份旧内容当"网络成功"吞进缓存。
       协商后 200 = 真新内容（put 覆盖同 key），304 = 与服务器一致。 */
    return fetch(request, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(cacheKeyRequest(request), copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      /* 离线/网络失败：按归一 key 精确匹配。
       这份副本 = 最后一次在线成功获取的版本 —— 不再按路径
       翻任意 ?v= 的旧副本（旧机制正是"修复过几天又复发"的通道）。 */
      return caches.open(CACHE).then(function (c) {
        return c.match(cacheKeyRequest(request)).then(function (hit) {
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
      openUrl += (openUrl.indexOf('#') >= 0 ? '&' : '#') + 'miya-open-weather-care=' + encodeURIComponent(careId);
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
