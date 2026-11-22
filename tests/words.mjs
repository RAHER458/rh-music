/**
 * Тесты word-level синхронизации.
 *
 * Запуск:  node tests/words.mjs
 *
 * 1. Сборка слов из токенов, сверка строк, проверки времени.
 * 2. Маршрут /api/lyrics/:id/words с подменённым fetch (LiriQo, кеш, ошибки).
 * 3. Движок: подсветка только текущего слова, переходы, перемотка, пауза,
 *    смена трека, гонки запросов и откат к построчному режиму.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(here, '../web/lyrics.js'), 'utf8');

const {
  letters, textSimilarity, validateWords, groupWords, alignLines,
  buildFromLines, buildFromPlain, buildWordPayload, handleLyricsWords,
} = await import('../worker/src/words.js');

let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

console.log('RH—MUSIC · тесты word-level синхронизации\n');

/* ───────────────────────────── токены и слова ───────────────────────────── */

{
  check('letters: пунктуация и регистр не важны',
    letters('Привет, МИР!') === 'приветмир' && letters('I\'ve') === 'ive');

  const words = groupWords('Я знаю эту песню', [
    { text: 'Я', start: 1000, end: 1200 },
    { text: 'знаю', start: 1200, end: 1800 },
    { text: 'эту', start: 1800, end: 2000 },
    { text: 'песню', start: 2000, end: 2600 },
  ]);
  check('groupWords: обычная строка', words && words.length === 4 && words[1].text === 'знаю');
  check('groupWords: времена сохранены', words[0].t === 1000 && words[3].end === 2600);
  const syllables = groupWords('Привет', [
    { text: 'При', start: 1000, end: 1500 },
    { text: 'вет', start: 1500, end: 2000 },
  ]);
  check('groupWords: слоговые интервалы сохраняются',
    syllables && syllables[0].syllables && syllables[0].syllables.length === 2
    && syllables[0].syllables[1].t === 1500);

  const split = groupWords('I have enough', [
    { text: 'I', start: 0, end: 100 },
    { text: 'have', start: 100, end: 300 },
    { text: 'e', start: 300, end: 400 },
    { text: 'nough', start: 400, end: 700 },
  ]);
  check('groupWords: слоги склеиваются в слово', split && split[2].text === 'enough'
    && split[2].t === 300 && split[2].end === 700);

  check('groupWords: лишний токен — строка отбрасывается',
    groupWords('Я знаю', [{ text: 'Я', start: 0, end: 100 }, { text: 'знаю', start: 100, end: 200 }, { text: 'лишнее', start: 200, end: 300 }]) === null);
  check('groupWords: не хватает токена — строка отбрасывается',
    groupWords('Я знаю эту', [{ text: 'Я', start: 0, end: 100 }, { text: 'знаю', start: 100, end: 200 }]) === null);
  check('groupWords: другой текст — строка отбрасывается',
    groupWords('Я знаю', [{ text: 'Ты', start: 0, end: 100 }, { text: 'знаешь', start: 100, end: 200 }]) === null);
  check('groupWords: повторяющиеся слова сохраняются',
    (groupWords('да да', [{ text: 'да', start: 0, end: 100 }, { text: 'да', start: 100, end: 200 }]) || []).length === 2);

  const punct = groupWords('Марlboro, зарыдав!', [
    { text: 'Марlboro,', start: 0, end: 400 },
    { text: 'зарыдав!', start: 400, end: 900 },
  ]);
  check('groupWords: пунктуация остаётся в тексте слова', punct[0].text === 'Марlboro,' && punct[1].text === 'зарыдав!');
}

{
  check('validateWords: порядок и границы',
    validateWords([{ t: 1000, end: 1500 }, { t: 1600, end: 2000 }], 1000, 2500, 200000));
  check('validateWords: отрицательное время отклоняется',
    !validateWords([{ t: -1, end: 100 }], 0, 1000, 200000));
  check('validateWords: конец раньше начала отклоняется',
    !validateWords([{ t: 500, end: 400 }], 0, 1000, 200000));
  check('validateWords: слово далеко за пределами строки отклоняется',
    !validateWords([{ t: 9000, end: 9500 }], 1000, 2000, 200000));
  check('validateWords: пустой список отклоняется', !validateWords([], 0, 1000, 200000));
}

/* ───────────────────────────── выравнивание ───────────────────────────── */

{
  const canonical = [
    { t: 1000, text: 'Первая строка' },
    { t: 2000, text: 'Вторая строка' },
    { t: 3000, text: 'Припев' },
    { t: 5000, text: 'Первая строка' },
  ];
  const candidate = [
    { start: 1050, text: 'Первая строка' },
    { start: 2050, text: 'Вторая строка' },
    { start: 3050, text: 'Припев' },
    { start: 5050, text: 'Первая строка' },
  ];
  const pairs = alignLines(canonical, candidate);
  check('alignLines: все строки сопоставлены по порядку', pairs.length === 4
    && pairs[0][1] === 0 && pairs[3][1] === 3);
  check('alignLines: повтор привязан к своему времени, а не к первому',
    pairs.find(([ci]) => ci === 3)[1] === 3);
}

{
  const pairs = alignLines(
    [{ t: 1000, text: 'Я знаю эту песню' }],
    [{ start: 1000, text: 'I know this song' }],
  );
  check('alignLines: перевод не сопоставляется', pairs.length === 0);
}

{
  const pairs = alignLines(
    [{ t: 1000, text: 'Песен ещё ненаписанных, сколько?' }, { t: 2000, text: 'Скажи, кукушка, пропой' }],
    [{ start: 1000, text: 'Песен ещё не написанных' }, { start: 1600, text: 'Сколько, скажи, кукушка' }, { start: 2100, text: 'Пропой' }],
  );
  check('alignLines: разное разбиение строк не сопоставляется вслепую', pairs.length === 0);
}

/* ───────────────────────────── сборка word-строк ───────────────────────────── */

function baseLines() {
  return {
    syncLevel: 'line',
    offsetMs: 0,
    lines: Array.from({ length: 6 }, (_, i) => ({
      t: 1000 + i * 1000,
      end: 2000 + i * 1000,
      text: 'Строка номер ' + (i + 1),
    })),
  };
}

function candidateLines() {
  return {
    syncLevel: 'word',
    provider: 'apple_music_liriqo',
    timed: Array.from({ length: 6 }, (_, i) => ({
      start: 950 + i * 1000,
      end: 1950 + i * 1000,
      text: 'Строка номер ' + (i + 1),
      words: [
        { text: 'Строка', start: 950 + i * 1000, end: 1300 + i * 1000 },
        { text: 'номер', start: 1300 + i * 1000, end: 1600 + i * 1000 },
        { text: String(i + 1), start: 1600 + i * 1000, end: 1900 + i * 1000 },
      ],
    })),
  };
}

{
  const built = buildFromLines(baseLines(), candidateLines(), 60000);
  check('buildFromLines: слова собраны для всех строк', built && built.lines.filter((line) => line.words).length === 6);
  check('buildFromLines: строка начинается со слова', built.lines[0].t === 950);
  check('buildFromLines: покрытие полное', built.wordCoverage === 1 && built.lineCoverage === 1);
  check('buildFromLines: нет искусственного деления — времена из источника',
    built.lines[0].words[1].t === 1300 && built.lines[0].words[1].end === 1600);
}

{
  const shifted = baseLines();
  shifted.offsetMs = 500;
  const built = buildFromLines(shifted, candidateLines(), 60000);
  check('buildFromLines: offset базы учтён при сверке', built && built.lines[0].words.length === 3);
}

{
  const bad = candidateLines();
  bad.timed[0].words[1].end = bad.timed[0].words[1].start - 10;
  const built = buildFromLines(baseLines(), bad, 60000);
  check('buildFromLines: битые метки отбрасываются, строка не подсвечивается',
    !built || !built.lines[0].words);
}

{
  const noWords = candidateLines();
  noWords.timed.forEach((line) => { delete line.words; });
  check('buildFromLines: без words — откат', buildFromLines(baseLines(), noWords, 60000) === null);
}

{
  const plainBase = { syncLevel: 'plain', plain: 'Строка номер 1\nСтрока номер 2\nСтрока номер 3\nСтрока номер 4\nСтрока номер 5\nСтрока номер 6' };
  const built = buildFromPlain(plainBase, candidateLines(), 60000);
  check('buildFromPlain: обычный текст превращается в word-строки', built && built.lines.length === 6);
  check('buildFromPlain: времена взяты из кандидата', built.lines[0].words[0].t === 950);

  const wrong = { ...candidateLines(), timed: candidateLines().timed.map((line) => ({ ...line, text: 'Another line here' })) };
  check('buildFromPlain: чужой текст отклоняется', buildFromPlain(plainBase, wrong, 60000) === null);
}

{
  const payload = buildWordPayload(baseLines(), { duration: 60 }, {
    metadata: { duration: 60 },
    tracks: [
      { provider: 'lrclib', syncLevel: 'line', timed: [] },
      candidateLines(),
    ],
  });
  check('buildWordPayload: строковые кандидаты игнорируются', payload && payload.provider === 'apple_music_liriqo');
  check('buildWordPayload: провайдер подписан', payload.providerLabel === 'Apple Music');
}

{
  const payload = buildWordPayload(baseLines(), { duration: 60 }, {
    metadata: { duration: 90 },
    tracks: [candidateLines()],
  });
  check('buildWordPayload: другая длительность отклоняется', payload === null);
}

/* ───────────────────────────── маршрут ───────────────────────────── */

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

let originalFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    return handler(url, init, init.headers || {});
  };
}
function restoreFetch() { globalThis.fetch = originalFetch; }

function trackMeta(id) {
  return jsonResponse({ data: { getTracks: [{
    id,
    title: 'Строка номер',
    duration: 60,
    lyrics: true,
    artists: [{ title: 'Тест' }],
    release: { title: 'Альбом' },
  }] } });
}

const lrc = Array.from({ length: 6 }, (_, i) => `[00:0${i + 1}.00]Строка номер ${i + 1}`).join('\n');

async function callWords(id) {
  const request = new Request(`https://words.test/api/lyrics/${id}/words`);
  const response = await handleLyricsWords(request, { ZVUK_TOKEN: 'fixture-token' }, id);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return trackMeta('W1');
    if (url.includes('/api/tiny/lyrics')) return jsonResponse({ result: { lyrics: '[offset:0]\n' + lrc, type: 'subtitle' } });
    if (url.includes('liriqo')) return jsonResponse({ metadata: { duration: 60 }, tracks: [candidateLines()] });
    throw new Error('unexpected ' + url);
  });

  const first = await callWords('W1');
  check('маршрут: word-ответ собран', first.status === 200 && first.body.syncLevel === 'word');
  check('маршрут: слова присутствуют', first.body.lines.filter((line) => line.words).length === 6);
  check('маршрут: провайдер и атрибуция указаны',
    first.body.wordSource === 'apple_music_liriqo'
    && /LiriQo/.test(first.body.attribution)
    && /Apple Music/.test(first.body.attribution));
  check('маршрут: токен не утёк', !JSON.stringify(first.body).includes('fixture-token'));
  check('маршрут: заголовок кеша', first.headers.get('x-lyrics-words') === 'miss');

  const second = await callWords('W1');
  check('маршрут: повтор из кеша', second.body.cached === true && second.headers.get('x-lyrics-words') === 'hit');
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return trackMeta('W2');
    if (url.includes('/api/tiny/lyrics')) return jsonResponse({ result: { lyrics: '[00:01.00]Совсем другой текст\n[00:02.00]И ещё строка', type: 'subtitle' } });
    if (url.includes('liriqo')) return jsonResponse({ metadata: { duration: 60 }, tracks: [candidateLines()] });
    throw new Error('unexpected ' + url);
  });
  const result = await callWords('W2');
  check('маршрут: чужой текст не даёт word-режим', result.body.syncLevel === 'none' && result.body.reason === 'no_word_data');
}

{
  stubFetch(async (url) => {
    if (url.includes('/graphql')) return trackMeta('W3');
    if (url.includes('/api/tiny/lyrics')) return jsonResponse({ result: { lyrics: '[00:01.00]Один', type: 'lyrics' } });
    if (url.includes('liriqo')) return jsonResponse({ detail: 'down' }, 503);
    throw new Error('unexpected ' + url);
  });
  let status = 0;
  try {
    const result = await callWords('W3');
    status = result.status;
  } catch (error) {
    status = error.status || 0;
  }
  check('маршрут: сбой LiriQo — 502, без ложного none', status === 502);
}

/* ───────────────────────────── движок ───────────────────────────── */

function makeElement(tag = 'div') {
  const classes = new Set();
  const attrs = {};
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: { props: {}, setProperty(n, v) { this.props[n] = String(v); }, getPropertyValue(n) { return this.props[n] || ''; } },
    hidden: false,
    offsetTop: 0,
    offsetHeight: 22,
    clientHeight: 400,
    scrollTop: 0,
    offsetParent: {},
    children: [],
    attrs,
    listeners,
    focus() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '.lyrics-line') return el.children.filter((c) => c.classList.contains('lyrics-line'));
      if (selector === '.lyrics-line.is-active') return el.children.filter((c) => c.classList.contains('lyrics-line') && c.classList.contains('is-active'));
      if (selector === '.lyrics-word') return el.children.flatMap((c) => c._wordNodes || []);
      if (selector === '.lyrics-word.is-active') return el.children.flatMap((c) => c._wordNodes || []).filter((w) => w.classList.contains('is-active'));
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
      if (child && child.nodeType === 3) { el.children.push(child); return child; }
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
    get textContent() { return el._text || ''; },
    set textContent(value) {
      el._text = String(value == null ? '' : value);
      if (!value) el.children.length = 0;
    },
  };
  return el;
}

function makeSandbox() {
  const audio = makeElement('audio');
  audio.currentTime = 0;
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
  const documentShim = {
    hidden: false,
    getElementById: (id) => registry[id] || null,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createDocumentFragment: () => { const fragment = makeElement('fragment'); fragment.isFragment = true; return fragment; },
    addEventListener() {},
  };
  const windowShim = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    RH_LYRICS: null,
  };
  const factory = new Function('window', 'document', 'fetch', 'AbortController', 'setTimeout',
    engineSource + '\n; return window.RH_LYRICS;');
  const api = factory(windowShim, documentShim, (...args) => globalThis.fetch(...args), AbortController, setTimeout);
  return { api, audio, registry };
}

const baseData = {
  ok: true,
  syncLevel: 'line',
  source: 'zvuk',
  sourceLabel: 'Zvuk',
  offsetMs: 0,
  lines: [
    { t: 1000, text: 'Я знаю эту песню' },
    { t: 3000, text: 'И следующую строку' },
  ],
};
const wordsData = {
  ok: true,
  syncLevel: 'word',
  source: 'zvuk',
  sourceLabel: 'Zvuk',
  wordSourceLabel: 'Apple Music',
  lines: [
    { t: 1000, end: 2600, text: 'Я знаю эту песню', words: [
      { t: 1000, end: 1200, text: 'Я' },
      { t: 1200, end: 1700, text: 'знаю' },
      { t: 1700, end: 2000, text: 'эту' },
      { t: 2000, end: 2600, text: 'песню' },
    ] },
    { t: 3000, end: 4000, text: 'И следующую строку', words: [
      { t: 3000, end: 3200, text: 'И' },
      { t: 3200, end: 3600, text: 'следующую' },
      { t: 3600, end: 4000, text: 'строку' },
    ] },
  ],
};

{
  const { api, audio, registry } = makeSandbox();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/words')) return jsonResponse(wordsData);
    return jsonResponse(baseData);
  };
  await api.setTrack({ id: 'K1', title: 'Karaoke' });
  await api.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const scroll = registry.lyricsScrollDesktop;
  const lineNodes = scroll.children.filter((c) => c.classList.contains('lyrics-line'));
  const visible = [scroll.textContent, registry.lyricsBadgeDesktop.textContent,
    registry.lyricsTitleDesktop.textContent, registry.lyricsSourceDesktop.textContent].join(' ');
  check('UI: названия провайдеров не выводятся в Desktop',
    !/Zvuk|LRCLIB|LiriQo|Apple|NetEase|KuGou|QQ|Kuwo|Migu|PetitLyrics|слова/i.test(visible), visible);
  check('UI: элемент источника остаётся пустым',
    registry.lyricsSourceDesktop.textContent === '' && registry.lyricsSourceMobile.textContent === '');
  check('движок: word-строки отрисованы словами', scroll.children.filter((c) => c.classList.contains('has-words')).length === 2);
  check('движок: у строки есть span-слова', (lineNodes[0]._wordNodes || []).length === 4);

  audio.currentTime = 1.3;
  audio.dispatch('timeupdate');
  check('движок: активно слово по времени', api.getState().activeWord === 1
    && lineNodes[0]._wordNodes[1].classList.contains('is-active'));
  check('движок: предыдущее слово не подсвечено',
    !lineNodes[0]._wordNodes[0].classList.contains('is-active'));

  audio.currentTime = 2.2;
  audio.dispatch('timeupdate');
  check('движок: подсветка перешла к следующему слову',
    api.getState().activeWord === 3
    && lineNodes[0]._wordNodes[3].classList.contains('is-active')
    && !lineNodes[0]._wordNodes[1].classList.contains('is-active'));

  audio.currentTime = 2.8;
  audio.dispatch('timeupdate');
  check('движок: в вокальной паузе слово не подсвечено',
    api.getState().activeWord === -1 && scroll.querySelectorAll('.lyrics-word.is-active').length === 0);

  audio.currentTime = 3.3;
  audio.dispatch('timeupdate');
  check('движок: переход на следующую строку',
    api.getState().active === 1 && api.getState().activeWord === 1
    && lineNodes[1]._wordNodes[1].classList.contains('is-active'));
  check('движок: в кадре ровно одно активное слово',
    scroll.querySelectorAll('.lyrics-word.is-active').length === 1);

  audio.currentTime = 1.1;
  audio.dispatch('seeked');
  check('движок: перемотка назад возвращает слово',
    api.getState().active === 0 && api.getState().activeWord === 0);

  audio.currentTime = 1.5;
  audio.dispatch('pause');
  check('движок: пауза не сбрасывает текущее слово', api.getState().activeWord === 0);
}

{
  const { api, registry } = makeSandbox();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/words')) return jsonResponse({ ok: true, syncLevel: 'none', reason: 'no_word_data' });
    return jsonResponse(baseData);
  };
  await api.setTrack({ id: 'K2', title: 'Line' });
  await api.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('движок: нет word-данных — остаётся построчный режим',
    api.getState().syncLevel === 'line'
    && registry.lyricsScrollDesktop.children.every((c) => !c.classList.contains('has-words')));
  const fallbackVisible = [registry.lyricsScrollDesktop.textContent,
    registry.lyricsBadgeDesktop.textContent, registry.lyricsTitleDesktop.textContent].join(' ');
  check('UI: в fallback-режиме источник не подписывается',
    !/Zvuk|LRCLIB|LiriQo|Apple|NetEase|KuGou|PetitLyrics/i.test(fallbackVisible), fallbackVisible);
}

{
  const { api } = makeSandbox();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/words')) return new Response('{}', { status: 502 });
    return jsonResponse(baseData);
  };
  await api.setTrack({ id: 'K3', title: 'Error' });
  await api.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('движок: ошибка word-запроса не ломает текст', api.getState().syncLevel === 'line');
}

{
  const { api } = makeSandbox();
  let resolveWords;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/K4/words')) return new Promise((resolve) => { resolveWords = resolve; });
    if (String(url).includes('/words')) return jsonResponse({ ok: true, syncLevel: 'none' });
    return jsonResponse(baseData);
  };
  await api.setTrack({ id: 'K4', title: 'Old' });
  await api.ensure();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await api.setTrack({ id: 'K5', title: 'New' });
  resolveWords(jsonResponse({ ...wordsData, trackId: 'K4' }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  check('движок: устаревший word-ответ не подменяет новый трек',
    api.getState().trackId === 'K5' && api.getState().syncLevel === 'line',
    JSON.stringify(api.getState()));
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
