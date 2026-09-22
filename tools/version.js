#!/usr/bin/env node
/**
 * tools/version.js —— 资源版本号与 Service Worker 版本的一致性工具
 * ════════════════════════════════════════════════════════════════════
 *
 * 解决什么问题
 * ────────────
 * 本项目的缓存失效依赖「手工改版本号」，而版本号散落在 4 个地方：
 *
 *   1. index.html 里 154 处 `?v=NNN`（每个资源一个独立版本号）
 *   2. index.html 的 <meta name="miya-sw-build" content="sw-NN">
 *   3. sw.js 的 var CACHE = 'miya-vNNN-...'
 *   4. sw.js 的 var BUILD = 'sw-NN'
 *
 * 漏改任何一处，用户就会「装了新版但实际跑旧代码」——
 * 而且不会有任何报错，症状是「明明是修好的问题又出现了」。
 * 这个失败模式本项目的 bug 报告里出现过。
 *
 * 命令
 * ────
 *   node tools/version.js bump           只递增「内容有变化」的文件版本号
 *   node tools/version.js bump --all     递增所有资源版本号
 *   node tools/version.js verify         校验一致性（CI / 提交前跑）
 *   node tools/version.js status         打印当前版本概览
 *
 * 「内容有变化」的判定
 * ───────────────────
 * 用 .version-lock.json 记录「上次 bump 时每个文件的哈希」。
 * 哈希与当前文件不符 → 认为改过 → 递增它的 ?v=。
 * 没有 git 也能用（本项目目前不是 git 仓库）。
 *
 * 为什么不做「所有文件共用一个版本号」
 * ──────────────────────────────────
 * 因为那会让任意一个文件改动都导致 154 个资源全部缓存失效，
 * 首屏会明显变慢。每个文件独立版本号是**正确**的设计，
 * 手工维护才是问题。这个工具的目的就是自动化它，而不是推翻它。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const SW = path.join(ROOT, 'sw.js');
const LOCK = path.join(ROOT, '.version-lock.json');

/**
 * 可选资源前缀 —— 这些资源**允许**在磁盘上不存在。
 *
 * 背景：index.html 里 `miya-auth/*`（登录包）只在实际部署版才上传，
 * 开源版没有这个目录。它是刻意设计，不是断链。
 * 如果不排除，verify 会一直报「引用了不存在的资源」，
 * 报警声一多，真正的问题就被淹没了。
 *
 * 新增此类「按部署形态可选」的资源，在这里加前缀。
 */
const OPTIONAL_PREFIXES = ['miya-auth/'];

function isOptional(rel) {
  return OPTIONAL_PREFIXES.some((p) => rel.startsWith(p));
}

/* 这些资源即使内容没变也要参与「记录」，但 bump 时按其自身哈希决定 */
const COLOR = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};
const c = (k, s) => (process.stdout.isTTY ? COLOR[k] + s + COLOR.reset : s);

function read(p) {
  return fs.readFileSync(p, 'utf8');
}
function write(p, s) {
  fs.writeFileSync(p, s);
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * 对文件内容做哈希 —— 必须按**字节**读，不能按 utf8 文本读。
 *
 * 曾经踩的坑：这里用了 `readFileSync(p, 'utf8')`，而建立基线的脚本
 * 用的是 `readFileSync(p)`（Buffer）。对 .js/.css 文本文件两者相同，
 * 但对 .png 这类二进制文件，utf8 解码会把非法字节替换成 U+FFFD，
 * 于是**同一个文件的哈希值不同**。
 *
 * 症状：每次 verify 都报 `img/miya-icon.png 内容已变`，
 * 但文件根本没动过 —— 而且 bump 之后依然报（因为新的哈希又不同）。
 * 这类「工具自己撒谎」的 bug 最消耗信任，所以在这里写死为二进制读。
 */
function hashFile(abs) {
  return sha1(fs.readFileSync(abs)); // ← 不传 encoding，拿 Buffer
}

/**
 * 从 index.html 中提取所有「相对资源路径 → 版本号」对。
 *
 * 匹配形态（本项目实际写法，一行一个资源）：
 *   href="css/miya-chat.css?v=62"
 *   src="js1/miya-chat-room.js?v=111"
 *   content="img/miya-icon.png?v=52"
 *
 * 刻意不匹配 `miya-sw-build` 那类 meta（它由 separate 逻辑处理），
 * 也不匹配 http(s) 外链（不该给外部资源加版本号）。
 */
function extractEntries(html) {
  const entries = new Map(); // relPath -> { version, index }
  const re = /(["'])((?!https?:|\/\/|data:)[^"'\s?]+)\?v=(\d+)\1/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rel = m[2];
    // miya-sw-build 等 meta 不是资源，跳过
    if (rel.startsWith('#')) continue;
    entries.set(rel, { version: parseInt(m[3], 10), raw: m[0] });
  }
  return entries;
}

function loadLock() {
  if (!fs.existsSync(LOCK)) return { files: {}, sw: null };
  try {
    const j = JSON.parse(read(LOCK));
    if (!j || typeof j !== 'object') return { files: {}, sw: null };
    if (!j.files) j.files = {};
    return j;
  } catch (e) {
    console.warn(c('yellow', '⚠ .version-lock.json 解析失败，按首次运行处理'));
    return { files: {}, sw: null };
  }
}

function saveLock(obj) {
  write(LOCK, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * 建立「当前磁盘上各资源的内容哈希」。
 * 找不到的文件（比如路径写错）会返回 null，交给调用方报警。
 */
function hashResources(relPaths) {
  const out = {};
  for (const rel of relPaths) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      out[rel] = null;
      continue;
    }
    out[rel] = hashFile(abs);
  }
  return out;
}

/* ─────────────────────────── bump ─────────────────────────── */

function cmdBump(argv) {
  const all = argv.includes('--all');
  const html = read(INDEX);
  const entries = extractEntries(html);
  const lock = loadLock();

  const rels = [...entries.keys()];
  const hashes = hashResources(rels);

  const changed = [];
  const missing = [];
  const newVersionOf = new Map();

  for (const rel of rels) {
    const h = hashes[rel];
    if (h === null) {
      if (!isOptional(rel)) missing.push(rel);
      continue;
    }
    const prev = lock.files[rel];
    const didChange = all || !prev || prev.hash !== h;
    if (didChange) {
      newVersionOf.set(rel, entries.get(rel).version + 1);
      changed.push(rel);
    } else {
      newVersionOf.set(rel, entries.get(rel).version);
    }
  }

  if (missing.length) {
    console.log(
      c('yellow', '⚠ 以下资源在 index.html 里被引用，但磁盘上找不到（版本号未动）：')
    );
    missing.forEach((r) => console.log('    ' + c('gray', r)));
  }

  if (!changed.length) {
    console.log(c('green', '✓ 没有资源内容变化，版本号未变'));
  } else {
    // 逐条替换（同路径只改它的那一处 ?v=）
    let out = html;
    for (const rel of changed) {
      const oldVer = entries.get(rel).version;
      const newVer = newVersionOf.get(rel);
      // 只替换「该路径 + 它的旧版本号」这一种组合，避免误伤同版本号的其它资源
      const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '((?!https?:|//|data:)' + escaped + '\\?v=)' + oldVer,
        'g'
      );
      const before = out;
      out = out.replace(re, '$1' + newVer);
      if (out === before) {
        console.log(c('yellow', `⚠ ${rel}: 版本号替换未命中（$v=${oldVer}）`));
      }
    }
    write(INDEX, out);
    console.log(
      c('green', `✓ 已递增 ${changed.length} 个资源的版本号：`)
    );
    changed.forEach((r) =>
      console.log(
        '    ' +
          c('cyan', r) +
          '  ' +
          c('gray', `${entries.get(r).version} → ${newVersionOf.get(r)}`)
      )
    );
  }

  /* ── Service Worker 版本 ──
     SW 自身的 CACHE/BUILD 是否需要动，取决于**有没有任何资源变化**。
     有变化就必须动，否则旧 SW 会继续吐旧缓存。 */
  const swChanged = changed.length > 0;
  if (swChanged) {
    const swRes = bumpServiceWorker();
    if (swRes) {
      console.log(
        c('green', `✓ Service Worker: CACHE ${swRes.oldCache} → ${swRes.newCache}, ` +
          `BUILD ${swRes.oldBuild} → ${swRes.newBuild}`)
      );
    }
  } else {
    console.log(c('gray', '· Service Worker 未变（无资源改动）'));
  }

  /* ── 写回 lock ── */
  const newFiles = {};
  for (const rel of rels) {
    if (hashes[rel] === null) {
      // 文件不存在就不记录，等它出现
      continue;
    }
    newFiles[rel] = { hash: hashes[rel], version: newVersionOf.get(rel) };
  }
  lock.files = newFiles;
  const swNow = readServiceWorkerVersion();
  if (swNow) lock.sw = swNow;
  saveLock(lock);

  console.log(c('gray', '· 已更新 .version-lock.json'));
  return 0;
}

function readServiceWorkerVersion() {
  const sw = read(SW);
  const mc = sw.match(/var\s+CACHE\s*=\s*'([^']+)'/);
  const mb = sw.match(/var\s+BUILD\s*=\s*'([^']+)'/);
  return {
    cache: mc ? mc[1] : null,
    build: mb ? mb[1] : null,
  };
}

/**
 * 递增 sw.js 的 CACHE 与 BUILD，且必须让两者**同步前进**。
 *
 * CACHE 形如 'miya-v288-karin'  → v288 → v289
 * BUILD 形如 'sw-45'            → 45   → 46
 *
 * 同时同步 index.html 里的 <meta name="miya-sw-build" content="sw-NN">。
 * 这块 meta 是「页面版本哨兵」：app.js 拿它和 SW 广播的 BUILD 比较，
 * 不等就触发一次 reload。漏改 → 哨兵误判 → 要么不刷新、要么刷新风暴。
 */
function bumpServiceWorker() {
  let sw = read(SW);
  const oldCache = (sw.match(/var\s+CACHE\s*=\s*'([^']+)'/) || [])[1];
  const oldBuild = (sw.match(/var\s+BUILD\s*=\s*'([^']+)'/) || [])[1];
  if (!oldCache || !oldBuild) {
    console.log(c('red', '✗ sw.js 里找不到 CACHE 或 BUILD，跳过 SW 版本递增'));
    return null;
  }

  const newCache = oldCache.replace(/v(\d+)/, (_, n) => 'v' + (parseInt(n, 10) + 1));
  const newBuild = oldBuild.replace(/(\d+)\s*$/, (_, n) => String(parseInt(n, 10) + 1));
  if (newCache === oldCache || newBuild === oldBuild) {
    console.log(c('red', '✗ CACHE/BUILD 格式不符合预期，无法递增'));
    return null;
  }

  sw = sw.replace(oldCache, newCache).replace(oldBuild, newBuild);
  write(SW, sw);

  // 同步 index.html 的哨兵 meta
  let html = read(INDEX);
  const before = html;
  html = html.replace(
    /(<meta\s+name=["']miya-sw-build["']\s+content=["'])[^"']+(["'])/i,
    '$1' + newBuild + '$2'
  );
  if (html === before) {
    console.log(c('yellow', '⚠ index.html 里未找到 miya-sw-build meta，请检查'));
  } else {
    write(INDEX, html);
  }

  return { oldCache, newCache, oldBuild, newBuild };
}

/* ─────────────────────────── verify ─────────────────────────── */

function cmdVerify() {
  const html = read(INDEX);
  const entries = extractEntries(html);
  const problems = [];

  /* 1) 引用的资源必须真实存在（可选部署资源除外） */
  for (const rel of entries.keys()) {
    if (isOptional(rel)) continue;
    if (!fs.existsSync(path.join(ROOT, rel))) {
      problems.push(`index.html 引用了不存在的资源：${rel}`);
    }
  }

  /* 2) lock 与磁盘哈希必须一致 —— 不一致说明「改了文件但忘了 bump」 */
  const lock = loadLock();
  const rels = [...entries.keys()];
  const hashes = hashResources(rels);
  const stale = [];
  for (const rel of rels) {
    if (hashes[rel] === null) continue; // 已在 1) 报过
    const rec = lock.files[rel];
    if (!rec) {
      stale.push(`${rel}（lock 中无记录）`);
      continue;
    }
    if (rec.hash !== hashes[rel]) {
      stale.push(rel);
    }
    if (rec.version !== entries.get(rel).version) {
      problems.push(
        `${rel}: lock 记的是 v${rec.version}，index.html 写的是 v${entries.get(rel).version}`
      );
    }
  }
  if (stale.length) {
    problems.push(
      `以下 ${stale.length} 个文件内容已变，但版本号没 bump：\n      ` +
        stale.slice(0, 15).join('\n      ') +
        (stale.length > 15 ? `\n      …以及另外 ${stale.length - 15} 个` : '')
    );
  }

  /* 3) SW 与 index.html 哨兵必须一致 */
  const sv = readServiceWorkerVersion();
  const metaBuild = (html.match(
    /<meta\s+name=["']miya-sw-build["']\s+content=["']([^"']+)["']/i
  ) || [])[1];
  if (!sv.build) {
    problems.push('sw.js 里找不到 BUILD');
  }
  if (!metaBuild) {
    problems.push('index.html 里找不到 miya-sw-build meta');
  }
  if (sv.build && metaBuild && sv.build !== metaBuild) {
    problems.push(
      `版本哨兵不一致：sw.js BUILD=${sv.build}，index.html meta=${metaBuild}`
    );
  }

  /* 4) CACHE 里的 vNNN 与 BUILD 的 NN 应当同源递增（做软提醒） */
  if (sv.cache && sv.build) {
    const cv = (sv.cache.match(/v(\d+)/) || [])[1];
    const bv = (sv.build.match(/(\d+)\s*$/) || [])[1];
    if (cv && bv && Math.abs(parseInt(cv, 10) - parseInt(bv, 10)) > 300) {
      // 两者基准不同（v288 vs sw-45），只提示不同步，不判错
      console.log(
        c('gray', `· SW 版本：CACHE=${sv.cache}（序列 ${cv}）, BUILD=${sv.build}（序列 ${bv}）`)
      );
    }
  }

  if (problems.length === 0) {
    console.log(c('green', '✓ 版本一致性校验通过'));
    console.log(
      c('gray', `· 受管资源 ${entries.size} 个，SW BUILD=${metaBuild}，CACHE=${sv.cache}`)
    );
    return 0;
  }

  console.log(c('red', '✗ 版本一致性校验失败：'));
  problems.forEach((p, i) => console.log(c('red', `  ${i + 1}. `) + p));
  console.log('');
  console.log(c('yellow', '  修法：node tools/version.js bump'));
  return 1;
}

/* ─────────────────────────── status ─────────────────────────── */

function cmdStatus() {
  const html = read(INDEX);
  const entries = extractEntries(html);
  const lock = loadLock();
  const rels = [...entries.keys()];
  const hashes = hashResources(rels);

  let changed = 0;
  let total = 0;
  for (const rel of rels) {
    if (hashes[rel] === null) continue;
    total++;
    const rec = lock.files[rel];
    if (!rec || rec.hash !== hashes[rel]) changed++;
  }

  const sv = readServiceWorkerVersion();
  const metaBuild = (html.match(
    /<meta\s+name=["']miya-sw-build["']\s+content=["']([^"']+)["']/i
  ) || [])[1];

  console.log(c('bold', '资源版本概览'));
  console.log('  受管资源      ' + c('cyan', String(total)));
  console.log('  内容已变未 bump ' + (changed ? c('yellow', String(changed)) : c('green', '0')));
  console.log('  SW CACHE      ' + c('cyan', sv.cache || '?'));
  console.log('  SW BUILD      ' + c('cyan', sv.build || '?'));
  console.log('  meta 哨兵      ' + c('cyan', metaBuild || '?'));
  if (sv.build && metaBuild && sv.build !== metaBuild) {
    console.log(c('red', '  ⚠ 哨兵与 SW BUILD 不一致'));
  }

  if (changed) {
    console.log('');
    console.log(c('gray', '  内容已变（下次 bump 会递增）：'));
    let shown = 0;
    for (const rel of rels) {
      if (hashes[rel] === null) continue;
      const rec = lock.files[rel];
      if (!rec || rec.hash !== hashes[rel]) {
        console.log('    ' + c('gray', rel));
        if (++shown >= 20) {
          console.log('    ' + c('gray', '…'));
          break;
        }
      }
    }
  }
  return 0;
}

/* ─────────────────────────── 入口 ─────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';

  if (!fs.existsSync(INDEX)) {
    console.error(c('red', `✗ 找不到 index.html（${INDEX}）`));
    process.exit(2);
  }
  if (!fs.existsSync(SW)) {
    console.error(c('red', `✗ 找不到 sw.js（${SW}）`));
    process.exit(2);
  }

  switch (cmd) {
    case 'bump':
      process.exit(cmdBump(argv));
    case 'verify':
      process.exit(cmdVerify());
    case 'status':
      process.exit(cmdStatus());
    default:
      console.log('用法：');
      console.log('  node tools/version.js bump [--all]');
      console.log('  node tools/version.js verify');
      console.log('  node tools/version.js status');
      process.exit(2);
  }
}

main();
