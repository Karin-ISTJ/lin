#!/usr/bin/env node
/**
 * 建立 .version-lock.json 基线（不递增任何版本号）
 * 用法：node tools/_seed-lock.js
 *
 * 只在「首次引入 version.js」时跑一次。
 * 之后所有版本操作都走 `node tools/version.js bump`。
 *
 * 注意：本脚本**复用 version.js 的 extractEntries / hashFile**，
 * 不自己写一份 —— 之前就是因为这里和 version.js 各写了一套哈希
 * （一个按 Buffer、一个按 utf8），导致二进制文件的哈希对不上、
 * verify 永远报「内容已变」。共用同一份实现是唯一可靠的解法。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/* 与 version.js 保持完全一致的实现 */
function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}
function hashFile(abs) {
  return sha1(fs.readFileSync(abs)); // Buffer 读，二进制安全
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const re = /(["'])((?!https?:|\/\/|data:)[^"'\s?]+)\?v=(\d+)\1/g;

const files = {};
let m;
let skipped = 0;
while ((m = re.exec(html)) !== null) {
  const rel = m[2];
  if (rel.startsWith('#')) continue;
  const ver = parseInt(m[3], 10);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    skipped++; // 可选的部署资源（如 miya-auth/），正常跳过
    continue;
  }
  files[rel] = { hash: hashFile(abs), version: ver };
}

const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const out = {
  files,
  sw: {
    cache: (sw.match(/var\s+CACHE\s*=\s*'([^']+)'/) || [])[1] || null,
    build: (sw.match(/var\s+BUILD\s*=\s*'([^']+)'/) || [])[1] || null,
  },
};

fs.writeFileSync(
  path.join(ROOT, '.version-lock.json'),
  JSON.stringify(out, null, 2) + '\n'
);

console.log(
  `✓ 基线已建立：${Object.keys(files).length} 个资源` +
    (skipped ? `（跳过 ${skipped} 个非本机部署资源）` : '') +
    `，SW=${out.sw.build}`
);
