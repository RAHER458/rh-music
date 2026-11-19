/**
 * Тесты жизненного цикла handoff: очистка mix только после стабильного
 * основного источника, fallback и отмена.
 *
 * Запуск:  node tests/smartmix-handoff-engine.mjs
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

console.log('RH—MUSIC · тесты lifecycle handoff\n');

class Param {
  constructor(value) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  cancelScheduledValues() { this.events.push(['cancel']); }
}
class Node {
  constructor() { this.connected = []; }
  connect(node) { this.connected.push(node); return node; }
}
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
    this.currentSrc = '';
    this.readyState = 0;
    this.error = null;
    this.buffered = { length: 1, start: () => 0, end: () => 30 };
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
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  dispatch(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this }); }
  load() {
    this.loadCount += 1;
    this.currentSrc = this.src;
    this.readyState = 4;
    this.dispatch('loadedmetadata');
    this.dispatch('canplay');
  }
  play() { this.paused = false; this.dispatch('playing'); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatch('pause'); }
  removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } }
  setAttribute() {}
}

const timers = [];
let timerId = 0;
function setT(fn, ms) { timerId += 1; timers.push({ id: timerId, fn, ms }); return timerId; }
function clearT(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
function flush(rounds = 30) { return (async () => { for (let i = 0; i < rounds; i += 1) await Promise.resolve(); })(); }
function runTimersMin(ms) {
  const ready = timers.filter((t) => t.ms >= ms).sort((a, b) => a.ms - b.ms);
  for (const timer of ready) {
    const i = timers.indexOf(timer);
    if (i >= 0) timers.splice(i, 1);
    timer.fn();
  }
}
async function settleUntil(maxMs = 2000, rounds = 40) {
  for (let round = 0; round < rounds; round += 1) {
    const ready = timers.filter((t) => t.ms <= maxMs).sort((a, b) => a.ms - b.ms);
    if (!ready.length) {
      await flush(5);
      if (!timers.some((t) => t.ms <= maxMs)) return;
      continue;
    }
    for (const timer of ready) {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
      timer.fn();
      await flush(8);
    }
  }
}

const store = {
  rh_smartmix_v1: JSON.stringify({ enabled: true, bars: 8, preload: false }),
  rh_smartmix_cache_v1: JSON.stringify({
    a: { v: 1, analysis: { bpm: 120, confidence: 0.8, period: 0.5, offset: 0, downbeatOffset: 1, downbeatConfidence: 0.7 } },
    b: { v: 1, analysis: { bpm: 122, confidence: 0.8, period: 60 / 122, offset: 0, downbeatOffset: 2, downbeatConfidence: 0.7 } },
    c: { v: 1, analysis: { bpm: 124, confidence: 0.8, period: 60 / 124, offset: 0, downbeatOffset: 2, downbeatConfidence: 0.7 } },
  }),
};
const storage = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: (key) => { delete store[key]; },
};
const mixElements = [];
const documentShim = {
  createElement: () => { const el = new FakeAudio(); mixElements.push(el); return el; },
  body: { appendChild() {} },
};
const windowShim = {
  localStorage: storage,
  document: documentShim,
  AudioContext: FakeContext,
  setTimeout: setT,
  clearTimeout: clearT,
  setInterval: () => 0,
  clearInterval: () => {},
};
const api = new Function(
  'window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  source + '\n; return window.RH_SMARTMIX;',
)(windowShim, documentShim, storage, setT, clearT, () => 0, () => {});

const primary = new FakeAudio();
const state = {
  current: { id: 'a', title: 'A', duration: 200 },
  index: 0,
  queue: [{ id: 'a', title: 'A', duration: 200 }, { id: 'b', title: 'B', duration: 200 }, { id: 'c', title: 'C', duration: 200 }],
  repeat: 'off',
  paused: false,
  currentTime: 170,
  duration: 200,
  volume: 0.8,
  muted: false,
};
let adoptCalls = 0;
let behavior = null;
const host = {
  getState: () => ({ ...state }),
  getAudio: () => primary,
  streamUrl: (track) => `/api/stream/${track.id}?quality=mid`,
  adoptTrack: async (index, position, options) => {
    adoptCalls += 1;
    if (behavior) return behavior(index, position, options);
    return { ok: true, position };
  },
  toast: () => {},
  onChange: () => {},
};
api.init(host);

async function startTransition() {
  state.currentTime = 170;
  state.current = state.queue[0];
  state.index = 0;
  await api.onTrack();
  await flush(80);
  runTimersMin(0);
  await flush(80);
}

function stablePrimary(position) {
  primary.paused = false;
  primary.currentTime = position || 0;
  setT(() => {
    primary.currentTime += 0.4;
    primary.dispatch('timeupdate');
  }, 260);
}

{
  behavior = () => ({ ok: false, reason: 'progress_timeout', retryable: false });
  await startTransition();
  check('старт: переход запущен', api.getState().phase === 'running', api.getState().phase);
  runTimersMin(5000);
  await flush(60);
  await settleUntil(2000);
  check('fallback: неудачный adopt не выключает mix', mixElements[0].paused === false);
  check('fallback: источник mix сохранён', mixElements[0].src.includes('/b?'));
  check('fallback: фаза fallback', api.getState().phase === 'fallback', api.getState().phase);
  api.cancel('pause');
  check('fallback: отмена очищает mix', mixElements[0].paused === true && mockSrcEmpty(mixElements[0]));
  check('fallback: отмена возвращает idle', api.getState().phase === 'idle');
}

{
  timers.length = 0;
  adoptCalls = 0;
  behavior = (index, position, options) => {
    if (adoptCalls === 1) return { ok: false, reason: 'buffer_timeout', retryable: true };
    stablePrimary(position);
    state.index = index;
    state.current = state.queue[index];
    return { ok: true, position };
  };
  await startTransition();
  runTimersMin(5000);
  await flush(60);
  await settleUntil(2000);
  check('retry: выполнена повторная попытка', adoptCalls === 2, String(adoptCalls));
  check('retry: успешный handoff очистил mix', mixElements[0].paused === true && mockSrcEmpty(mixElements[0]), JSON.stringify({ paused: mixElements[0].paused, src: mixElements[0].src }));
  check('retry: движок вернулся в idle', api.getState().phase === 'idle', api.getState().phase);
}

{
  timers.length = 0;
  adoptCalls = 0;
  behavior = () => new Promise(() => {});
  await startTransition();
  runTimersMin(5000);
  await flush(60);
  check('отмена в handoff: фаза handoff', api.getState().phase === 'handoff', api.getState().phase);
  api.cancel('next');
  check('отмена в handoff: движок idle', api.getState().phase === 'idle');
  check('отмена в handoff: mix остановлен', mixElements[0].paused === true && mockSrcEmpty(mixElements[0]));
}

{
  timers.length = 0;
  adoptCalls = 0;
  behavior = () => ({ ok: true, position: 0 });
  await startTransition();
  // Основной элемент не играет: adopt формально успешен, но post-fade
  // подтверждение обязано вернуть mix и не очищать его по таймеру.
  runTimersMin(5000);
  await flush(60);
  await settleUntil(2000);
  check('post-fade stall: mix не очищен', mixElements[0].paused === false);
  check('post-fade stall: фаза fallback', api.getState().phase === 'fallback', api.getState().phase);
}

{
  timers.length = 0;
  adoptCalls = 0;
  behavior = (index, position) => {
    stablePrimary(position);
    state.index = index;
    state.current = state.queue[index];
    return { ok: true, position };
  };
  for (let i = 0; i < 20; i += 1) {
    api.cancel('reset');
    timers.length = 0;
    state.current = state.queue[0];
    state.index = 0;
    state.queue = [
      { id: 'a', title: 'A', duration: 200 },
      { id: 'b', title: 'B', duration: 200 },
    ];
    await startTransition();
    runTimersMin(5000);
    await flush(40);
    await settleUntil(2000);
  }
  check('20 переходов: handoff выполнен 20 раз', adoptCalls === 20, String(adoptCalls));
  check('20 переходов: временный элемент не размножается', mixElements.length === 1, String(mixElements.length));
  check('20 переходов: движок возвращается в idle', api.getState().phase === 'idle', api.getState().phase);
}

function mockSrcEmpty(element) { return !element.src || element.src === ''; }

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
