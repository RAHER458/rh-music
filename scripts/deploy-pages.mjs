#!/usr/bin/env node
/**
 * Публикация статического фронтенда RH—MUSIC на Cloudflare Pages
 * через Direct Upload API (без wrangler).
 *
 * Порядок, как у wrangler:
 *   1. upload-token (JWT)
 *   2. POST /pages/assets/upload   — сами файлы (base64)
 *   3. POST /pages/assets/upsert-hashes
 *   4. POST /pages/projects/{name}/deployments — манифест + branch
 *
 * Переменные окружения:
 *   CLOUDFLARE_API_TOKEN   — токен Cloudflare (Pages:Edit)
 *   CLOUDFLARE_ACCOUNT_ID  — id аккаунта
 *   PAGES_PROJECT          — имя проекта (по умолчанию rh-music)
 *   PAGES_BRANCH           — ветка (по умолчанию main)
 *
 * Запуск:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy-pages.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const webDir = join(root, 'web');

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const projectName = process.env.PAGES_PROJECT || 'rh-music';
const branch = process.env.PAGES_BRANCH || 'main';

if (!token || !accountId) {
  console.error('Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

async function cf(path, init = {}, authToken = token) {
  const response = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${authToken}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 600) };
  }
  if (!response.ok || payload.success === false) {
    const details = (payload.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cloudflare ${path} → HTTP ${response.status} ${details || text.slice(0, 300)}`);
  }
  return payload.result;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function buildMultipart(parts) {
  const boundary = '----RHMusic' + randomBytes(12).toString('hex');
  const chunks = [];
  for (const part of parts) {
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename ? `; filename="${part.filename}"` : '') + '\r\n' +
      (part.type ? `Content-Type: ${part.type}\r\n` : '') +
      '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// 1. Проект
let project = null;
try {
  project = await cf(`/accounts/${accountId}/pages/projects/${projectName}`);
  console.log(`Проект найден: ${project.name}`);
} catch (error) {
  if (!/HTTP 404/.test(error.message)) throw error;
  project = await cf(`/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, production_branch: branch }),
  });
  console.log(`Проект создан: ${project.name}`);
}

// 2. Файлы
const files = [];
for (const full of await walk(webDir)) {
  const info = await stat(full);
  if (!info.isFile()) continue;
  const contents = await readFile(full);
  const rel = relative(webDir, full).split(sep).join('/');
  const ext = rel.includes('.') ? '.' + rel.split('.').pop() : '';
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 32);
  files.push({
    path: '/' + rel,
    hash,
    contents,
    type: MIME[ext] || 'application/octet-stream',
    size: info.size,
  });
}

// 3. JWT для загрузки ассетов
const { jwt } = await cf(`/accounts/${accountId}/pages/projects/${projectName}/upload-token`);
if (!jwt) throw new Error('Не удалось получить upload-token');

// 4. Загрузка файлов
const payload = files.map((file) => ({
  key: file.hash,
  value: file.contents.toString('base64'),
  metadata: { contentType: file.type },
  base64: true,
}));

await cf('/pages/assets/upload', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}, jwt);
console.log(`Файлы загружены: ${files.length}`);

// 5. Фиксация хешей
try {
  await cf('/pages/assets/upsert-hashes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: files.map((file) => file.hash) }),
  }, jwt);
} catch (error) {
  console.warn('upsert-hashes:', error.message);
}

// 6. Деплой
const manifest = {};
for (const file of files) manifest[file.path] = file.hash;

const commitHash = createHash('sha1')
  .update(files.map((file) => file.hash).sort().join(':'))
  .digest('hex');

const { body, contentType } = buildMultipart([
  { name: 'manifest', data: JSON.stringify(manifest), type: 'application/json' },
  { name: 'branch', data: branch },
  { name: 'commit_hash', data: commitHash },
  { name: 'commit_message', data: 'RH—MUSIC deploy' },
  { name: 'commit_dirty', data: 'false' },
]);

const deployment = await cf(
  `/accounts/${accountId}/pages/projects/${projectName}/deployments`,
  { method: 'POST', headers: { 'Content-Type': contentType }, body },
);

console.log(`Деплой создан: ${deployment.id}`);
console.log(`Статус: ${deployment.latest_stage ? deployment.latest_stage.status : 'unknown'}`);
console.log(`URL: ${deployment.url}`);
console.log(`Production: https://${projectName}.pages.dev`);