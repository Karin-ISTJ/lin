var CACHE = 'miya-v126-karin';
var FILES = ['./', './index.html', './css/style.css', './css/miya-apps.css', './css/miya-chat.css', './js1/app.js', './manifest.json', './img/miya-icon.png', './img/miya-icon-192.png', './img/miya-icon-512.png'];
/* html/css/js/json + PWA icons: always prefer network so home-screen name/icon update */
var STATIC_LIVE = /\.(?:html|css|js|webmanifest|json)$|\/$|miya-icon(?:-\d+)?\.png/;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
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
    return caches.open(CACHE).then(function (c) {
      return c.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (res) {
          if (res.ok) c.put(request, res.clone());
          return res;
        });
      });
    });
  }

  function networkFirst(request) {
    return fetch(request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(request, copy); });
      return res;
    }).catch(function () {
      return caches.match(request).then(function (r) {
        return r || new Response('', { status: 503, statusText: 'Offline' });
      });
    });
  }

  if (STATIC_LIVE.test(path)) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  e.respondWith(cacheFirst(e.request).catch(function () {
    return caches.match(e.request).then(function (r) {
      return r || new Response('', { status: 503, statusText: 'Offline' });
    });
  }));
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
