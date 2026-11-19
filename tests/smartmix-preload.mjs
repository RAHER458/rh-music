/**
 * Тесты предзагрузки следующего трека RH Smart Mix.
 *
 * Запуск:  node tests/smartmix-preload.mjs
 *
 * FakeAudio здесь имеет buffered/readyState и события progress, чтобы
 * проверить жизненный цикл предзагрузки без реального аудиовыхода.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../web/smartmix.js'), 'utf8');

let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

console.log('RH—MUSIC · тесты предзагрузки RH Smart Mix\n');

class Param {
  constructor(value) { this.value = value; }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
class Node { connect(node) { return node; } }
class FakeContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new Node(); }
  createMediaElementSource() { return new Node(); }
  createBiquadFilter() { const n = new Node(); n.type = ''; n.frequency = { value: 0 }; n.gain = new Param(0); return n; }
  createGain() { const n = new Node(); n.gain = new Param(1); return n; }
  createDynamicsCompressor() {
    const n = new Node();
    n.threshold = { value: 0 }; n.knee = { value: 0 }; n.ratio = { value: 0 };
    n.attack = { value: 0 }; n.release = { value: 0 };
    return n;
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
class FakeAudio {
  constructor() {
    this.paused = true;
    this.currentTime = 0;
    this.duration = 200;
    this.volume = 1;
    this.src = '';
    this.preload = '';
    this.readyState = 0;
    this.networkState = 0;
    this.error = null;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.listeners = new Map();
    this.style = {};
    this.loadCount = 0;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this }); }
  load() {
    this.loadCount += 1;
    this.readyState = 1;
    this.dispatch('loadedmetadata');
  }
  play() { this.paused = false; this.dispatch('playing'); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatch('pause'); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  setAttribute() {}
  setBuffer(start, end) {
    this.buffered = { length: 1, start: () => start, end: () => end };
    this.readyState = 4;
    this.dispatch('progress');
    this.dispatch('canplay');
    this.dispatch('canplaythrough');
  }
}

const storageData = {
  rh_smartmix_v1: JSON.stringify({ enabled: true, bars: 8, preload: true }),
  rh_smartmix_cache_v1: JSON.stringify({
    a: { v: 1, analysis: { bpm: 120, confidence: 0.8, period: 0.5, offset: 0, downbeatOffset: 1, downbeatConfidence: 0.7 } },
    b: { v: 1, analysis: { bpm: 122, confidence: 0.8, period: 60 / 122, offset: 0, downbeatOffset: 2, downbeatConfidence: 0.7 } },
    c: { v: 1, analysis: { bpm: 124, confidence: 0.8, period: 60 / 124, offset: 0, downbeatOffset: 0.5, downbeatConfidence: 0.7 } },
  }),
};
const storage = {
  getItem: (key) => (key in storageData ? storageData[key] : null),
  setItem: (key, value) => { storageData[key] = String(value); },
  removeItem: (key) => { delete storageData[key]; },
};

const elements = [];
const documentShim = {
  createElement: (tag) => { const el = new FakeAudio(); el.tagName = tag; elements.push(el); return el; },
  body: { appendChild() {} },
};

const timers = [];
let timerId = 0;
function setT(fn, ms) { timerId += 1; timers.push({ id: timerId, fn, ms }); return timerId; }
function clearT(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
function flush(rounds = 40) { return (async () => { for (let i = 0; i < rounds; i += 1) await Promise.resolve(); })(); }
function runTimersAtLeast(ms) {
  const ready = timers.filter((t) => t.ms >= ms).sort((a, b) => b.ms - a.ms);
  for (const timer of ready) {
    const i = timers.indexOf(timer);
    if (i >= 0) timers.splice(i, 1);
    timer.fn();
  }
}

const windowShim = {
  localStorage: storage,
  document: documentShim,
  AudioContext: FakeContext,
  setTimeout: setT,
  clearTimeout: clearT,
  setInterval: () => 0,
  clearInterval: () => {},
};
const api = new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  source + '\n; return window.RH_SMARTMIX;')(windowShim, documentShim, storage, setT, clearT, () => 0, () => {});

const primary = new FakeAudio();
primary.paused = false;
const state = {
  current: { id: 'a', title: 'A', duration: 200 },
  index: 0,
  queue: [{ id: 'a', title: 'A', duration: 200 }, { id: 'b', title: 'B', duration: 200 }, { id: 'c', title: 'C', duration: 200 }],
  repeat: 'off',
  paused: false,
  currentTime: 20,
  duration: 200,
  volume: 0.8,
  muted: false,
};
let adopted = null;
api.init({
  getState: () => ({ ...state }),
  getAudio: () => primary,
  streamUrl: (track) => `/api/stream/${track.id}?quality=mid`,
  adoptTrack: async (index, position) => {
    adopted = { index, position };
    state.index = index;
    state.current = state.queue[index];
    state.currentTime = position;
    return true;
  },
  toast: () => {},
  onChange: () => {},
});

await flush();
const mixEl = elements[0];
check('предзагрузка: элемент создан', !!mixEl && elements.length === 1);
check('предзагрузка: загружается следующий трек', mixEl.src.includes('/b?'));
check('предзагрузка: элемент не играет', mixEl.paused === true);
check('предзагрузка: состояние loading', api.getState().preload && api.getState().preload.state === 'loading');

mixEl.setBuffer(0, 12);
await flush(10);
const readyState = api.getState().preload;
check('готовность: буфер 12 секунд делает трек готовым', readyState && readyState.ready === true, JSON.stringify(readyState));
check('готовность: учтён запрошенный порог', readyState && readyState.ahead >= 10);

mixEl.setBuffer(0, 1.2);
await flush(10);
check('готовность: недостаточный буфер снимает готовность', api.getState().preload && api.getState().preload.ready === false);

mixEl.setBuffer(0, 14);
await flush(10);
state.currentTime = 190;
api.onTime();
await flush(20);
runTimersAtLeast(0);
await flush(40);
check('переход: использует подготовленный поток без повторного load', mixEl.loadCount === 1, String(mixEl.loadCount));
check('переход: передан следующий трек', adopted && adopted.index === 1);

runTimersAtLeast(200);
await flush(40);
check('очистка: после перехода предзагрузка переключена на C', api.getState().preload && api.getState().preload.trackId === 'c');

runTimersAtLeast(15000);
await flush(20);
check('очистка 15 секунд: старые записи retired удалены', api.getState().retired === 0);

api.cancel('pause');
check('отмена: предзагрузка очищена', api.getState().preload === null);
check('отмена: элемент остановлен', mixEl.paused === true);

/* ─────────────────────────── отмена при смене очереди ─────────────────────────── */
{
  state.currentTime = 20;
  await api.onTrack();
  await flush(20);
  const before = api.getState().preload;
  state.queue = [{ id: 'a', title: 'A', duration: 200 }, { id: 'd', title: 'D', duration: 200 }];
  state.index = 0;
  state.current = state.queue[0];
  api.onQueue();
  await flush(40);
  const after = api.getState().preload;
  check('очередь: старая предзагрузка отменена', before && before.trackId === 'c' && after && after.trackId === 'd', JSON.stringify({ before, after }));
}

/* ─────────────────────────── адаптивные цели ─────────────────────────── */
{
  const { networkProfile, bufferAhead } = api._internal;
  const oldNavigator = windowShim.navigator;
  windowShim.navigator = { connection: { effectiveType: '2g' } };
  check('адаптивность: 2G — минимальный буфер', networkProfile().target === 4);
  windowShim.navigator = { connection: { effectiveType: '3g' } };
  check('адаптивность: 3G — средний буфер', networkProfile().target === 6);
  windowShim.navigator = { connection: { saveData: true } };
  check('адаптивность: saveData — минимальный буфер', networkProfile().target === 4 && networkProfile().retries === 0);
  windowShim.navigator = {};
  check('адаптивность: без Network API — безопасный средний буфер', networkProfile().target === 7);
  windowShim.navigator = oldNavigator;

  const fake = {
    buffered: { length: 2, start: (i) => [0, 20][i], end: (i) => [10, 30][i] },
  };
  check('буфер: считает доступное аудио от позиции', bufferAhead(fake, 2) === 8);
  check('буфер: разрыв перед позицией не считается', bufferAhead(fake, 12) === 0);
  check('буфер: учитывает второй диапазон', bufferAhead(fake, 21) === 9);
  check('буфер: пустой элемент', bufferAhead(null, 0) === 0);
}

/* ─────────────────────────── 20 циклов подготовки/отмены ─────────────────────────── */
{
  for (let i = 0; i < 20; i += 1) {
    state.currentTime = 20;
    state.index = 0;
    state.current = state.queue[0];
    await api.onTrack();
    await flush(6);
    api.cancel('rapid');
    await flush(2);
  }
  check('20 циклов: подготовительный элемент не размножается', elements.length === 1, String(elements.length));
  check('20 циклов: нет накопления retired', api.getState().retired === 0);
  check('20 циклов: предзагрузка очищена', api.getState().preload === null);
}

/* ─────────────────────────── выключение предзагрузки ─────────────────────────── */
{
  api.setSettings({ preload: false });
  check('настройка: выключение предзагрузки очищает состояние', api.getState().preload === null);
  check('настройка: preload=false сохраняется', api.getSettings().preload === false);
  api.setSettings({ preload: true });
}

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
