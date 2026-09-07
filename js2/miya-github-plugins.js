/**
 * GitHub 插件安装（设置页）
 * 支持：仓库地址 / 直接 .js 文件地址（优先走 jsDelivr，规避 raw CORS）
 * 约定：仓库根目录 miya-plugin.json { "name", "main": "xxx.js", "version"? }
 * 或直接安装单个 .js
 */
(function (global) {
  'use strict';

  var KEY = 'miya-github-plugins-v1';
  var loaded = Object.create(null);

  function uid() {
    return 'ghp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function loadList() {
    try {
      var raw = localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveList(list) {
    localStorage.setItem(KEY, JSON.stringify(list || []));
  }

  function parseGithubUrl(input) {
    var url = String(input || '').trim().replace(/\/$/, '');
    if (!url) return null;

    // already raw or jsdelivr file
    if (/\.js(\?|$)/i.test(url) && /^https?:\/\//i.test(url)) {
      return { kind: 'script', scriptUrl: url, pageUrl: url, name: url.split('/').pop() };
    }

    // github.com/owner/repo[/tree|blob/branch/path]
    var m = url.match(
      /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:\/(?:tree|blob)\/([^\/\s]+)(?:\/(.*))?)?/i
    );
    if (!m) {
      // allow owner/repo short form
      var short = url.match(/^([^\/\s]+)\/([^\/\s]+)$/);
      if (!short) return null;
      m = [null, short[1], short[2], 'main', ''];
    }

    var owner = m[1];
    var repo = String(m[2]).replace(/\.git$/i, '');
    var branch = m[3] || 'main';
    var path = (m[4] || '').replace(/^\/+|\/+$/g, '');

    if (path && /\.js$/i.test(path)) {
      var scriptUrl =
        'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + branch + '/' + path;
      return {
        kind: 'script',
        owner: owner,
        repo: repo,
        branch: branch,
        path: path,
        scriptUrl: scriptUrl,
        pageUrl: 'https://github.com/' + owner + '/' + repo,
        name: path.split('/').pop()
      };
    }

    return {
      kind: 'repo',
      owner: owner,
      repo: repo,
      branch: branch,
      path: path,
      pageUrl: 'https://github.com/' + owner + '/' + repo,
      name: owner + '/' + repo
    };
  }

  function jsdelivr(owner, repo, branch, file) {
    return (
      'https://cdn.jsdelivr.net/gh/' +
      owner +
      '/' +
      repo +
      '@' +
      branch +
      '/' +
      String(file || '').replace(/^\//, '')
    );
  }

  function fetchText(url) {
    return fetch(url, { mode: 'cors', cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('http_' + res.status);
      return res.text();
    });
  }

  function resolveRepoPlugin(info) {
    var candidates = [];
    var basePath = info.path ? info.path + '/' : '';
    ['miya-plugin.json', 'plugin.json'].forEach(function (f) {
      candidates.push({ type: 'manifest', url: jsdelivr(info.owner, info.repo, info.branch, basePath + f) });
    });
    ['miya-plugin.js', 'plugin.js', 'index.js'].forEach(function (f) {
      candidates.push({ type: 'script', url: jsdelivr(info.owner, info.repo, info.branch, basePath + f) });
    });

    function tryNext(i) {
      if (i >= candidates.length) {
        return Promise.reject(new Error('未找到可安装的插件文件（需 miya-plugin.json 或 miya-plugin.js / plugin.js / index.js）'));
      }
      var c = candidates[i];
      return fetchText(c.url)
        .then(function (text) {
          if (c.type === 'manifest') {
            var meta = JSON.parse(text);
            var main = meta.main || meta.script || meta.entry || 'miya-plugin.js';
            var scriptUrl = jsdelivr(info.owner, info.repo, info.branch, basePath + main);
            return {
              name: meta.name || info.name,
              version: meta.version || '',
              scriptUrl: scriptUrl,
              meta: meta
            };
          }
          if (!text || text.length < 8) throw new Error('empty');
          return {
            name: info.name,
            version: '',
            scriptUrl: c.url,
            meta: null
          };
        })
        .catch(function () {
          return tryNext(i + 1);
        });
    }

    return tryNext(0);
  }

  function injectScript(scriptUrl, id) {
    return new Promise(function (resolve, reject) {
      if (loaded[scriptUrl]) {
        resolve(true);
        return;
      }
      var s = document.createElement('script');
      s.src = scriptUrl;
      s.async = true;
      s.dataset.miyaGhPlugin = id || '1';
      s.onload = function () {
        loaded[scriptUrl] = true;
        resolve(true);
      };
      s.onerror = function () {
        reject(new Error('脚本加载失败（检查地址或 CORS）'));
      };
      document.head.appendChild(s);
    });
  }

  function installFromUrl(input) {
    var info = parseGithubUrl(input);
    if (!info) return Promise.reject(new Error('请输入有效的 GitHub 仓库或 .js 地址'));

    var chain =
      info.kind === 'script'
        ? Promise.resolve({
            name: info.name,
            version: '',
            scriptUrl: info.scriptUrl,
            meta: null
          })
        : resolveRepoPlugin(info);

    return chain.then(function (resolved) {
      var list = loadList();
      // replace same scriptUrl
      list = list.filter(function (p) {
        return p.scriptUrl !== resolved.scriptUrl;
      });
      var row = {
        id: uid(),
        name: resolved.name || info.name,
        version: resolved.version || '',
        sourceUrl: String(input).trim(),
        pageUrl: info.pageUrl || '',
        scriptUrl: resolved.scriptUrl,
        enabled: true,
        installedAt: Date.now()
      };
      list.push(row);
      saveList(list);
      return injectScript(row.scriptUrl, row.id).then(function () {
        return row;
      });
    });
  }

  function removePlugin(id) {
    var list = loadList().filter(function (p) {
      return p.id !== id;
    });
    saveList(list);
    return list;
  }

  function setEnabled(id, enabled) {
    var list = loadList();
    list.forEach(function (p) {
      if (p.id === id) p.enabled = !!enabled;
    });
    saveList(list);
    return list;
  }

  function bootEnabled() {
    var list = loadList().filter(function (p) {
      return p.enabled && p.scriptUrl;
    });
    var chain = Promise.resolve();
    list.forEach(function (p) {
      chain = chain.then(function () {
        return injectScript(p.scriptUrl, p.id).catch(function () {
          /* ignore single fail */
        });
      });
    });
    return chain;
  }

  global.MiyaGithubPlugins = {
    KEY: KEY,
    list: loadList,
    installFromUrl: installFromUrl,
    removePlugin: removePlugin,
    setEnabled: setEnabled,
    bootEnabled: bootEnabled,
    parseGithubUrl: parseGithubUrl
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bootEnabled();
    });
  } else {
    bootEnabled();
  }
})(typeof window !== 'undefined' ? window : this);
