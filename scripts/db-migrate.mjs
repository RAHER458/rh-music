#!/usr/bin/env node
/**
 * Применение миграций D1 через Cloudflare API (без wrangler).
 *
 * Переменные окружения:
 *   CLOUDFLARE_API_TOKEN   — токен (D1:Edit)
 *   CLOUDFLARE_ACCOUNT_ID  — id аккаунта
 *   D1_DATABASE_ID         — id базы (по умолчанию берётся из wrangler.toml)
 *
 * Запуск:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/db-migrate.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const migrationsDir = join(root, 'worker/migrations');

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.D1_DATABASE_ID;

if (!token || !accountId || !databaseId) {
  console.error('Нужны CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID и D1_DATABASE_ID');
  process.exit(1);
}

async function query(sql) {
  const response = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 400) }; }
  if (!response.ok || payload.success === false) {
    const details = (payload.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`D1 → HTTP ${response.status} ${details || text.slice(0, 300)}`);
  }
  return payload.result;
}

function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
for (const file of files) {
  const sql = await readFile(join(migrationsDir, file), 'utf8');
  const statements = splitStatements(sql);
  console.log(`→ ${file}: ${statements.length} выражений`);
  for (const statement of statements) {
    await query(statement);
  }
  console.log(`✓ ${file} применена`);
}

const tables = await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
);
console.log('Таблицы:', (tables[0]?.results || []).map((r) => r.name).join(', '));