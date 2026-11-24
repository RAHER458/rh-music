#!/usr/bin/env node
/**
 * Деплой Cloudflare Worker rh-music-api без wrangler.
 *
 * Переменные окружения:
 *   CLOUDFLARE_API_TOKEN   — токен Cloudflare (Workers Scripts:Edit, Account Settings:Read)
 *   CLOUDFLARE_ACCOUNT_ID  — id аккаунта
 *   ZVUK_TOKEN             — токен Zvuk (нужен только при первой установке секрета)
 *   PASSWORD_PEPPER        — HMAC-перец для паролей (задаётся один раз через
 *                            Cloudflare Secrets/API; при обновлении кода не стирается)
 *
 * Секрет не логируется и не пишется на диск.
 *
 * Запуск:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ZVUK_TOKEN=... \
 *     node scripts/deploy-worker.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT_NAME = process.env.WORKER_NAME || 'rh-music-api';
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || '164c51cd-2899-4daf-a669-a837f7a460b1';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !accountId) {
  console.error('Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

async function cf(path, init = {}) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok || payload.success === false) {
    const details = (payload.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cloudflare ${path} → HTTP ${response.status} ${details || ''}`);
  }
  return payload.result;
}

const srcDir = join(root, 'worker/src');
const modules = (await readdir(srcDir)).filter((name) => name.endsWith('.js')).sort();

// Публичные (не секретные) параметры OAuth. Передаются в Worker как plain_text.
// Google Identity Services работает без client secret — нужен только публичный Client ID.
// Список секретов оставлен пустым: провайдерских секретов у проекта нет.
const PUBLIC_VARS = ['SITE_URL', 'GOOGLE_CLIENT_ID'];
const SECRET_VARS = [];

const publicBindings = PUBLIC_VARS
  .filter((name) => process.env[name] && String(process.env[name]).trim())
  .map((name) => ({ type: 'plain_text', name, text: String(process.env[name]).trim() }));

// SC_CLIENT_ID передаётся как секрет: значение не логируется и не пишется на диск.
const secretBindings = process.env.SC_CLIENT_ID && String(process.env.SC_CLIENT_ID).trim()
  ? [{ type: 'secret_text', name: 'SC_CLIENT_ID', text: String(process.env.SC_CLIENT_ID).trim() }]
  : [];

const metadata = {
  main_module: 'index.js',
  compatibility_date: '2025-01-15',
  // Smart Placement уводит исходящие запросы Worker из «плохих» для
  // внешних API POP; без него SoundCloud отвечает 401 на egress Cloudflare.
  placement: { mode: 'smart' },
  bindings: [
    { type: 'plain_text', name: 'SERVICE_NAME', text: 'rh-music-api' },
    ...publicBindings,
    ...secretBindings,
    { type: 'd1', name: 'DB', id: D1_DATABASE_ID },
  ],
  // Секрет ZVUK_TOKEN не перезаписывается при обновлении кода.
  keep_bindings: ['secret_text', 'plain_text'],
  observability: { enabled: true },
};

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
for (const name of modules) {
  const source = await readFile(join(srcDir, name), 'utf8');
  form.append(name, new Blob([source], { type: 'application/javascript+module' }), name);
}
console.log('Модули:', modules.join(', '));

const deployed = await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`, {
  method: 'PUT',
  body: form,
});
console.log(`Worker загружен: ${SCRIPT_NAME}`);

// Публичный адрес *.workers.dev
try {
  await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/subdomain`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  console.log('workers.dev маршрут включён');
} catch (error) {
  console.warn('Не удалось включить workers.dev:', error.message);
}

// Секрет ZVUK_TOKEN — только если передан явно и ещё не задан.
if (process.env.ZVUK_TOKEN) {
  const secret = process.env.ZVUK_TOKEN.trim();
  let already = false;
  try {
    const existing = await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`);
    already = (existing || []).some((item) => item.name === 'ZVUK_TOKEN');
  } catch {
    already = true; // список секретов через API недоступен — не перезаписываем существующий
  }
  if (already && process.env.REPLACE_SECRET !== '1') {
    console.log('Секрет ZVUK_TOKEN уже существует — значение не изменялось.');
  } else {
    await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'ZVUK_TOKEN', text: secret, type: 'secret_text' }),
    });
    console.log('Секрет ZVUK_TOKEN сохранён (значение не выводится).');
  }
}

// OAuth-секреты: обновляем только при явной передаче и отсутствии значения.
if (publicBindings.length) console.log('Публичные параметры:', publicBindings.map((b) => b.name).join(', '));

for (const name of SECRET_VARS) {
  const value = process.env[name] ? String(process.env[name]).trim() : '';
  if (!value) continue;
  let exists = false;
  try {
    const list = await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`);
    exists = (list || []).some((item) => item.name === name);
  } catch {
    exists = true; // нет доступа к списку — не перезаписываем
  }
  if (exists && process.env.REPLACE_SECRET !== '1') {
    console.log(`Секрет ${name} уже существует — значение не изменялось.`);
    continue;
  }
  await cf(`/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`, {
    method: 'PUT',
    body: JSON.stringify({ name, type: 'secret_text', text: value }),
  });
  console.log(`Секрет ${name} сохранён (значение не выводится).`);
}

const subdomain = await cf(`/accounts/${accountId}/workers/subdomain`);
console.log(`Готово: https://${SCRIPT_NAME}.${subdomain.subdomain}.workers.dev`);
if (deployed && deployed.modified_on) {
  console.log(`modified_on: ${deployed.modified_on}`);
}