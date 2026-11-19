/**
 * Тесты текстов песен.
 *
 * Запуск:  node tests/lyrics.mjs
 *
 * 1. Парсер LRC и нормализация строк (worker/src/lyrics.js).
 * 2. Подбор совпадения в LRCLIB (версии, длительность, исполнитель).
 * 3. Маршрут /api/lyrics/:id с подменённым fetch: порядок источников,
 *    cookie-редирект Zvuk, кеш, ошибки, отсутствие утечки токена.
 * 4. Движок синхронизации (web/lyrics.js) в песочнице: бинарный поиск,
 *    смена трека, устаревшие ответы, обычный текст, ошибка.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(here, '../web/lyrics.js'), 'utf8');

const {
  parseLrc, normalizeLines, normalizeTitle, pickLrclibMatch, handleLyrics,
} = await import('../worker/src/lyrics.js');

let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

console.log('RH—MUSIC · тесты текстов песен\n');

/* ───────────────────────────── парсер LRC ───────────────────────────── */

{
  const parsed = parseLrc([
    '[ti:Песня]',
    '[ar:Исполнитель]',
    '[offset:250]',
    '[00:12.50]Первая строка',
    '[00:15.00][00:20.00]Припев',
    '[00:17.250]Третья <00:17.25>строка <00:18.00>с словами',
    'мусор без метки',
    '[bad]',
    '[00:22]',
  ].join('\n'));

  check('LRC: метаданные прочитаны', parsed.meta.ti === 'Песня' && parsed.meta.ar === 'Исполнитель');
  check('LRC: offset прочитан', parsed.offsetMs === 250);
  check('LRC: строки отсортированы', parsed.lines.every((line, i, all) => i === 0 || all[i - 1].t <= line.t));
  check('LRC: несколько меток дают повторы', parsed.lines.filter((line) => line.text === 'Припев').length === 2);
  check('LRC: первая строка на месте', parsed.lines.find((line) => line.text === 'Первая строка').t === 12500);
  check('LRC: дробные доли миллисекунд', parsed.lines.find((line) => line.text.includes('Третья')).t === 17250);
  check('LRC: word-level сохранён', (parsed.lines.find((line) => line.text.includes('Третья')).words || []).length === 3);
  check('LRC: мусорные строки отброшены', parsed.lines.every((line) => line.text && line.t >= 0));
  check('LRC: пустая строка после очистки не появилась', !parsed.lines.some((line) => line.text === ''));
  check('LRC: пустой вход безопасен', parseLrc('').lines.length === 0 && parseLrc(null).lines.length === 0);
}

{
  const lines = normalizeLines([
    { t: 1000, text: '  Строка   с   пробелами  ' },
    { t: 1000, text: 'Строка с пробелами' },
    { t: 2000, text: '...' },
    { t: 3000, text: 'Нормальная строка' },
    { t: 1500, text: '' },
    { t: 4000, text: 'С точками…' },
  ]);
  check('normalize: пробелы схлопнуты', lines[0].text === 'Строка с пробелами');
  check('normalize: дубликаты по времени и тексту убраны', lines.length === 3);
  check('normalize: заглушка из точек отброшена', !lines.some((line) => line.text === '...'));
  check('normalize: строки отсортированы', lines.map((line) => line.t).join(',') === '1000,3000,4000');
  check('normalize: end проставлен по следующей строке', lines[0].end === 3000 && lines[2].end === undefined);
  check('normalize: слова из одной позиции отбрасываются',
    !('words' in normalizeLines([{ t: 0, text: 'а', words: [{ t: 0, text: 'а' }] }])[0]));
  check('normalize: несколько слов сохраняются',
    (normalizeLines([{ t: 0, text: 'а б', words: [{ t: 0, text: 'а' }, { t: 100, text: 'б' }] }])[0].words || []).length === 2);
}

check('normalizeTitle убирает регистр, скобки и пунктуацию',
  normalizeTitle('The Weeknd — Blinding Lights (Remastered 2020)') === 'the weeknd blinding lights');

/* ───────────────────────────── LRCLIB matching ───────────────────────────── */

{
  const meta = { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 };
  const items = [
    { trackName: 'Blinding Lights', artistName: 'The Weeknd', duration: 203, syncedLyrics: '[00:01.00]a' },
    { trackName: 'Blinding Lights (Live)', artistName: 'The Weeknd', duration: 200, syncedLyrics: '[00:01.00]b' },
    { trackName: 'Blinding Lights', artistName: 'Some Cover Band', duration: 200, syncedLyrics: '[00:01.00]c' },
    { trackName: 'Blinding Lights', artistName: 'The Weeknd', duration: 260, syncedLyrics: '[00:01.00]d' },
  ];
  const match = pickLrclibMatch(items, meta);
  check('LRCLIB: выбирается точное совпадение по версии', match && match.duration === 203);
  check('LRCLIB: remix/live не подменяют оригинал',
    pickLrclibMatch(items.slice(1), meta) === null);
  check('LRCLIB: другой исполнитель не принимается',
    pickLrclibMatch([items[2]], meta) === null);
  check('LRCLIB: другая длительность не принимается',
    pickLrclibMatch([items[3]], meta) === null);
  check('LRCLIB: пустой список безопасен', pickLrclibMatch([], meta) === null && pickLrclibMatch(null, meta) === null);
}

/* ───────────────────────────── backend route ───────────────────────────── */

const tinyCalls = [];
const graphCalls = [];
let routes = [];
let originalFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = init.headers || {};
    return handler(url, init, headers);
  };
}

function restoreFetch() { globalThis.fetch = originalFetch; }

function trackReply({ id, title = 'Тест', artist = 'Артист', album = 'Альбом', duration = 200, lyrics = true }) {
  return {
    status: 200,
    json: { data: { getTracks: [{ id, title, duration, lyrics, artists: [{ title: artist }], release: { title: album } }] } },
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function callRoute(id) {
  const request = new Request(`https://rh-music.test/api/lyrics/${id}`);
  const response = await handleLyrics(request, { ZVUK_TOKEN: 'fixture-token-value' }, id);
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '101' }).json);
    if (url.includes('/api/tiny/lyrics')) {
      tinyCalls.push(url);
      return jsonResponse({ result: { lyrics: '[offset:500]\n[00:01.00]Первая\n[00:02.50]Вторая\n[00:05.00]Третья', type: 'subtitle', translation: null } });
    }
    throw new Error('unexpected ' + url);
  });

  const first = await callRoute('101');
  check('маршрут: Zvuk — основной источник', first.status === 200 && first.body.source === 'zvuk');
  check('маршрут: синхронизированный текст размечен', first.body.syncLevel === 'line' && first.body.lines.length === 3);
  check('маршрут: offset перенесён в ответ', first.body.offsetMs === 500);
  check('маршрут: end рассчитан', first.body.lines[0].end === 2500);
  check('маршрут: обычного текста нет в synced-ответе', first.body.plain === null);
  check('маршрут: токен не утёк в ответ', !JSON.stringify(first.body).includes('fixture-token-value'));
  check('маршрут: ответ кешируется на клиенте не дольше 5 минут',
    /max-age=300/.test(first.headers.get('cache-control')));

  const before = tinyCalls.length;
  const second = await callRoute('101');
  check('маршрут: повторный запрос берётся из кеша', second.body.cached === true);
  check('маршрут: кеш не ходит в источник повторно', tinyCalls.length === before);
  check('маршрут: кеш помечен заголовком', second.headers.get('x-lyrics-cache') === 'hit');
}

{
  let tiny = 0;
  stubFetch(async (url, init, headers) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '102', lyrics: true }).json);
    if (url.includes('/api/tiny/lyrics')) {
      tiny += 1;
      // Первый заход — антибот-редирект с cookie, второй — уже с cookie.
      if (tiny === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: url, 'set-cookie': 'spid=abc; Path=/; Secure; Domain=zvuk.com' },
        });
      }
      check('маршрут: cookie перенесена при редиректе', /spid=abc/.test(String(headers.Cookie || headers.cookie || '')));
      return jsonResponse({ result: { lyrics: '[00:01.00]Есть', type: 'subtitle' } });
    }
    throw new Error('unexpected ' + url);
  });
  const result = await callRoute('102');
  check('маршрут: cookie-редирект Zvuk обработан', result.status === 200 && result.body.lines.length === 1);
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '103', lyrics: true }).json);
    if (url.includes('/api/tiny/lyrics')) return jsonResponse({ result: { lyrics: 'Просто текст\nВторая строка', type: 'lyrics' } });
    throw new Error('unexpected ' + url);
  });
  const result = await callRoute('103');
  check('маршрут: обычный текст отдаётся отдельно', result.body.syncLevel === 'plain' && result.body.lines.length === 0);
  check('маршрут: plain не выдаётся за синхронизацию', result.body.plain.includes('Просто текст') && result.body.offsetMs === 0);
}

{
  const calls = [];
  stubFetch(async (url, init, headers) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '104', lyrics: false, title: 'Wish You Were Here', artist: 'Pink Floyd', duration: 334 }).json);
    if (url.includes('lrclib.net/api/get')) {
      calls.push('get');
      check('LRCLIB: передан осмысленный User-Agent', /RH-MUSIC/.test(String(headers['User-Agent'] || headers['user-agent'])));
      return jsonResponse({ trackName: 'Wish You Were Here', artistName: 'Pink Floyd', duration: 334, syncedLyrics: '[00:10.00]Строка' });
    }
    throw new Error('unexpected ' + url);
  });
  const result = await callRoute('104');
  check('маршрут: при отсутствии текста в Zvuk используется LRCLIB',
    result.body.source === 'lrclib' && result.body.syncLevel === 'line' && calls.length === 1);
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '105', lyrics: false, title: 'Experience', artist: 'Ludovico Einaudi', duration: 315 }).json);
    if (url.includes('lrclib.net/api/get')) return jsonResponse({ trackName: 'Experience', artistName: 'Ludovico Einaudi', duration: 315, instrumental: true });
    throw new Error('unexpected ' + url);
  });
  const result = await callRoute('105');
  check('маршрут: инструментал определяется', result.body.syncLevel === 'instrumental' && result.body.instrumental === true);
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '106', lyrics: false }).json);
    if (url.includes('lrclib.net/api/get')) return jsonResponse({ detail: 'Not Found' }, 404);
    if (url.includes('lrclib.net/api/search')) return jsonResponse([]);
    throw new Error('unexpected ' + url);
  });
  const result = await callRoute('106');
  check('маршрут: отсутствие текста — это none, не ошибка', result.status === 200 && result.body.syncLevel === 'none');
  check('маршрут: негативный кеш короче (сутки)',
    /max-age=86400/.test(result.headers.get('cache-control')) === false); // клиентский заголовок всегда 300
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '107', lyrics: true }).json);
    if (url.includes('/api/tiny/lyrics')) return jsonResponse({ detail: 'rate limit' }, 429, { 'retry-after': '30' });
    if (url.includes('lrclib.net/api/get')) return jsonResponse({ detail: 'down' }, 503);
    throw new Error('unexpected ' + url);
  });
  const result = await callRoute('107');
  check('маршрут: общий сбой источников — 502', result.status === 502 && result.body.ok === false);
  check('маршрут: ошибка не маскируется под отсутствие текста', result.body.error.code === 'LYRICS_UNAVAILABLE');

  // Ошибка не должна закешироваться: следующий запрос снова идёт в источники.
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse(trackReply({ id: '107', lyrics: true }).json);
    if (url.includes('/api/tiny/lyrics')) return jsonResponse({ result: { lyrics: '[00:01.00]Восстановилось', type: 'subtitle' } });
    throw new Error('unexpected ' + url);
  });
  const retry = await callRoute('107');
  check('маршрут: ошибка не закрепилась в кеше', retry.status === 200 && retry.body.lines.length === 1);
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return jsonResponse({ data: { getTracks: [] } });
    throw new Error('unexpected ' + url);
  });
  const request = new Request('https://rh-music.test/api/lyrics/999');
  let status = 0;
  try {
    const response = await handleLyrics(request, { ZVUK_TOKEN: 'fixture-token-value' }, '999');
    status = response.status;
  } catch (error) {
    status = error.status || 0;
  }
  check('маршрут: неизвестный трек — 404', status === 404);
}

restoreFetch();

/* ───────────────────────────── движок: песочница ───────────────────────────── */

function makeElement(tag = 'div') {
  const classes = new Set();
  const attrs = {};
  const listeners = new Map();
  let children = [];
  let text = '';
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    hidden: false,
    offsetTop: 0,
    offsetHeight: 22,
    clientHeight: 400,
    scrollTop: 0,
    offsetParent: {},
    children,
    attrs,
    listeners,
    focus() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '.lyrics-line') return el.children.filter((child) => child.classList.contains('lyrics-line'));
      if (selector === '.lyrics-line.is-active') {
        return el.children.filter((child) => child.classList.contains('lyrics-line') && child.classList.contains('is-active'));
      }
      return [];
    },
    setAttribute(name, value) { attrs[name] = value; },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type) { for (const fn of listeners.get(type) || []) fn({ type, target: el }); },
    appendChild(child) {
      if (child && child.isFragment) {
        for (const inner of child.children) el.appendChild(inner);
        return child;
      }
      el.children.push(child);
      if (child && child.tagName === 'P') child.offsetTop = (el.children.length - 1) * 30;
      return child;
    },
    append(...nodes) { for (const node of nodes) el.appendChild(node); },
    scrollTo(options) { el.scrollTop = options && Number(options.top) || 0; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: el.clientHeight, width: 0, height: el.clientHeight }; },
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
    },
    get textContent() { return text; },
    set textContent(value) {
      text = String(value == null ? '' : value);
      if (!value) { el.children.length = 0; }
    },
  };
  return el;
}

function makeEngineSandbox() {
  const audio = makeElement('audio');
  audio.currentTime = 0;
  audio.paused = true;
  audio.src = '';

  const registry = {
    audio,
    lyricsScrollDesktop: makeElement('div'),
    lyricsSourceDesktop: makeElement('span'),
    lyricsBadgeDesktop: makeElement('span'),
    lyricsTitleDesktop: makeElement('span'),
    lyricsReturnDesktop: makeElement('button'),
    lyricsScrollMobile: makeElement('div'),
    lyricsSourceMobile: makeElement('span'),
    lyricsBadgeMobile: makeElement('span'),
    lyricsTitleMobile: makeElement('span'),
    lyricsReturnMobile: makeElement('button'),
  };
  registry.lyricsReturnDesktop.hidden = true;
  registry.lyricsReturnMobile.hidden = true;

  const documentShim = {
    hidden: false,
    getElementById: (id) => registry[id] || null,
    createElement: (tag) => makeElement(tag),
    createDocumentFragment: () => { const fragment = makeElement('fragment'); fragment.isFragment = true; return fragment; },
    addEventListener() {},
  };
  const windowShim = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    RH_LYRICS: null,
  };
  const factory = new Function(
    'window', 'document', 'fetch', 'AbortController', 'setTimeout',
    engineSource + '\n; return window.RH_LYRICS;',
  );
  const api = factory(windowShim, documentShim, (...args) => globalThis.fetch(...args), AbortController, setTimeout);
  return { api, audio, registry, documentShim };
}

const trackA = { id: 'A1', title: 'Трек A' };
const trackB = { id: 'B2', title: 'Трек B' };

function linesPayload(trackId, lines, extra = {}) {
  return jsonResponse({ ok: true, trackId, syncLevel: 'line', source: 'zvuk', sourceLabel: 'Zvuk', offsetMs: 0, lines, ...extra });
}

{
  const { api, audio, registry } = makeEngineSandbox();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return linesPayload('A1', [{ t: 1000, text: 'Раз' }, { t: 2000, text: 'Два' }, { t: 3000, text: 'Три' }]);
  };

  await api.setTrack(trackA);
  check('движок: текст загружен', api.getState().status === 'ready' && api.getState().lines === 3);
  const rendered = registry.lyricsScrollDesktop.children.filter((child) => child.classList.contains('lyrics-line'));
  check('движок: строки отрисованы в контейнере', rendered.length === 3 && rendered[0].textContent === 'Раз');

  audio.currentTime = 2.5;
  audio.dispatch('timeupdate');
  check('движок: текущая строка найдена по времени', api.getState().active === 1);
  check('движок: активная строка подсвечена', rendered[1].classList.contains('is-active')
    && !rendered[0].classList.contains('is-active'));

  audio.currentTime = 0.5;
  audio.dispatch('timeupdate');
  check('движок: до первой строки подсветки нет', api.getState().active === -1);

  registry.lyricsScrollDesktop.clientHeight = 100;
  audio.currentTime = 10;
  audio.dispatch('seeked');
  check('движок: перемотка вперёд пересчитывает строку', api.getState().active === 2);
  check('движок: контейнер прокручен к активной строке', registry.lyricsScrollDesktop.scrollTop > 0);

  audio.currentTime = 2.2;
  audio.dispatch('seeked');
  check('движок: перемотка назад пересчитывает строку', api.getState().active === 1);

  audio.paused = true;
  audio.dispatch('pause');
  check('движок: пауза не сбрасывает строку', api.getState().active === 1);

  await api.setTrack(trackA);
  check('движок: повторный setTrack не дублирует запрос', calls.length === 1);

  check('движок: бинарный поиск на границах',
    api._indexAt([{ t: 0 }, { t: 1000 }, { t: 2000 }], 0) === 0
    && api._indexAt([{ t: 0 }, { t: 1000 }, { t: 2000 }], 999) === 0
    && api._indexAt([{ t: 0 }, { t: 1000 }, { t: 2000 }], 1000) === 1
    && api._indexAt([{ t: 0 }], -1) === -1
    && api._indexAt([], 100) === -1);
}

{
  const { api, audio } = makeEngineSandbox();
  let resolveFirst;
  let resolveSecond;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/A1')) return new Promise((resolve) => { resolveFirst = resolve; });
    return new Promise((resolve) => { resolveSecond = resolve; });
  };
  const first = api.setTrack(trackA);
  const second = api.setTrack(trackB);
  await Promise.resolve();
  resolveSecond(linesPayload('B2', [{ t: 500, text: 'Б' }]));
  await second;
  resolveFirst(linesPayload('A1', [{ t: 100, text: 'А' }]));
  await first;
  audio.currentTime = 1;
  audio.dispatch('timeupdate');
  const state = api.getState();
  check('движок: устаревший ответ не заменяет текущий трек', state.trackId === 'B2' && state.lines === 1);
  check('движок: подсветка считается по данным нового трека', state.active === 0);
}

{
  const { api, registry } = makeEngineSandbox();
  const responses = [
    jsonResponse({ ok: true, trackId: 'P1', syncLevel: 'plain', source: 'zvuk', sourceLabel: 'Zvuk', plain: 'Только текст\nБез времени' }),
    jsonResponse({ ok: true, trackId: 'N1', syncLevel: 'none', source: 'none' }),
    new Response(JSON.stringify({ ok: false }), { status: 502, headers: { 'Content-Type': 'application/json' } }),
  ];
  globalThis.fetch = async () => responses.shift();

  await api.setTrack({ id: 'P1', title: 'Plain' });
  check('движок: обычный текст распознан', api.getState().syncLevel === 'plain');
  check('движок: для plain нет ложных строк', api.getState().lines === 0);
  check('движок: plain показан отдельным блоком',
    registry.lyricsScrollDesktop.children.some((child) => child.classList.contains('lyrics-plain') && child.textContent.includes('Только текст')));

  await api.setTrack({ id: 'N1', title: 'None' });
  check('движок: отсутствие текста — состояние none', api.getState().syncLevel === 'none');
  check('движок: для none показано сообщение',
    registry.lyricsScrollDesktop.children.some((child) => child.classList.contains('lyrics-empty')));

  await api.setTrack({ id: 'E1', title: 'Error' });
  check('движок: сбой источника — состояние error', api.getState().status === 'error');
}

{
  const { api, audio } = makeEngineSandbox();
  globalThis.fetch = async () => jsonResponse({
    ok: true, trackId: 'O1', syncLevel: 'line', offsetMs: 500,
    lines: [{ t: 1000, text: 'Строка' }],
  });
  await api.setTrack({ id: 'O1', title: 'Offset' });
  audio.currentTime = 1.4;
  audio.dispatch('timeupdate');
  const before = api.getState().active;
  audio.currentTime = 1.6;
  audio.dispatch('timeupdate');
  check('движок: offset сдвигает момент подсветки', before === -1 && api.getState().active === 0);
}

restoreFetch();

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}