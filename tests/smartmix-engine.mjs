/**
 * Тесты движка RH Smart Mix на фейковом Web Audio и фейковых элементах.
 *
 * Запуск:  node tests/smartmix-engine.mjs
 *
 * Проверяются сценарии, которые нельзя проверить в Node на реальном звуке:
 * запуск перехода, сведение, финализация, отмена, пауза, смена очереди.
 * Это НЕ проверка реального звучания.
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

console.log('RH—MUSIC · тесты движка RH Smart Mix\n');

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
  createBiquadFilter() {
    const node = new Node();
    node.type = '';
    node.frequency = { value: 0 };
    node.gain = new Param(0);
    return node;
  }
  createGain() { const node = new Node(); node.gain = new Param(1); return node; }
  createDynamicsCompressor() {
    const node = new Node();
    node.threshold = { value: 0 };
    node.knee = { value: 0 };
    node.ratio = { value: 0 };
    node.attack = { value: 0 };
    node.release = { value: 0 };
    return node;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
class FakeAudio {
  constructor() {
    this.paused = true;
    this.currentTime = 0;
    this.duration = 200;
    this.volume = 1;
    this.src = '';
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.listeners = new Map();
    this.style = {};
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
  load() { this.dispatch('loadedmetadata'); }
  play() { this.paused = false; this.dispatch('playing'); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatch('pause'); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  setAttribute() {}
}

const store = {
  rh_smartmix_v1: JSON.stringify({ enabled: true, bars: 8, preload: false }),
  rh_smartmix_cache_v1: JSON.stringify({
    a: { v: 1, analysis: { bpm: 120, confidence: 0.8, period: 0.5, offset: 0, downbeatOffset: 1, downbeatConfidence: 0.7 } },
    b: { v: 1, analysis: { bpm: 122, confidence: 0.8, period: 60 / 122, offset: 0, downbeatOffset: 2, downbeatConfidence: 0.7 } },
  }),
};
const storage = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: (key) => { delete store[key]; },
};

const mixElements = [];
const documentShim = {
  createElement: (tag) => {
    const el = new FakeAudio();
    el.tagName = tag;
    mixElements.push(el);
    return el;
  },
  body: { appendChild() {} },
};

const timers = [];
let timerId = 0;
function fakeSetTimeout(fn, ms) {
  timerId += 1;
  timers.push({ id: timerId, fn, ms });
  return timerId;
}
function fakeClearTimeout(id) {
  const index = timers.findIndex((timer) => timer.id === id);
  if (index >= 0) timers.splice(index, 1);
}
function runTimers(minMs = 0) {
  const ready = timers.filter((timer) => timer.ms >= minMs).sort((a, b) => b.ms - a.ms);
  for (const timer of ready) {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
    timer.fn();
  }
}
async function flush(times = 30) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const windowShim = {
  localStorage: storage,
  document: documentShim,
  AudioContext: FakeContext,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
};

const api = new Function(
  'window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  source + '\n; return window.RH_SMARTMIX;',
)(windowShim, documentShim, storage, fakeSetTimeout, fakeClearTimeout, () => 0, () => {});

const primary = new FakeAudio();
const state = {
  current: { id: 'a', title: 'A', duration: 200 },
  index: 0,
  queue: [{ id: 'a', title: 'A', duration: 200 }, { id: 'b', title: 'B', duration: 200 }],
  repeat: 'off',
  paused: false,
  currentTime: 170,
  duration: 200,
  volume: 0.8,
  muted: false,
};
let adopted = null;
let toastText = '';

api.init({
  getState: () => ({ ...state }),
  getAudio: () => primary,
  streamUrl: (track) => `/api/stream/${track.id}?quality=mid`,
  adoptTrack: async (index, position) => { adopted = { index, position }; return true; },
  toast: (text) => { toastText = text; },
  onChange: () => {},
});

await api.warm();
await flush();

{
  await api.onTrack();
  await flush(80);
  runTimers(0);
  await flush(80);
  const engineState = api.getState();
  check('движок: переход запущен', engineState.phase === 'running', engineState.phase);
  check('движок: план построен по BPM', engineState.plan && engineState.plan.mode === 'beat');
  check('движок: входящий трек — следующий в очереди', engineState.plan && state.index === 0);
  check('движок: создан второй поток только для перехода', mixElements.length === 1);
  check('движок: второй поток получил следующий трек', mixElements[0].src.includes('/b?'));
  check('движок: громкость/темп входящего заданы', mixElements[0].volume === 1 && mixElements[0].playbackRate > 0.9);
  check('движок: основной поток не переключён до финала', state.current.id === 'a' && primary.src === '');

  runTimers(1000);
  await flush(80);
  check('движок: финализация передала следующий трек приложению', adopted && adopted.index === 1);
  check('движок: переход не завис после финала', api.getState().phase !== 'running');

  runTimers(0);
  await flush(80);
  check('движок: второй поток остановлен после перехода', mixElements[0].paused === true);
  check('движок: второй поток освобождён', mixElements[0].src === '');
}

{
  state.currentTime = 170;
  state.current.id = 'a';
  state.index = 0;
  await api.onTrack();
  await flush(80);
  runTimers(0);
  await flush(80);
  check('движок: повторный переход после финала', api.getState().phase === 'running');
  api.cancel('seek');
  check('движок: отмена возвращает idle', api.getState().phase === 'idle');
  check('движок: отмена останавливает входящий', mixElements.at(-1).paused === true);
  check('движок: отмена не меняет текущий трек', state.current.id === 'a');
}

{
  state.currentTime = 170;
  await api.onTrack();
  await flush(80);
  runTimers(0);
  await flush(80);
  check('движок: переход запущен перед сменой очереди', api.getState().phase === 'running');
  state.queue = [{ id: 'a', title: 'A', duration: 200 }, { id: 'c', title: 'C', duration: 200 }];
  api.onQueue();
  check('движок: изменение очереди отменяет переход', api.getState().phase === 'idle');
}

{
  state.queue = [{ id: 'a', title: 'A', duration: 200 }];
  state.currentTime = 170;
  await api.onTrack();
  await flush(60);
  check('движок: без следующего трека переход не начинается', api.getState().phase === 'idle');
}

{
  state.repeat = 'one';
  state.queue = [{ id: 'a', title: 'A', duration: 200 }, { id: 'b', title: 'B', duration: 200 }];
  state.currentTime = 170;
  await api.onTrack();
  await flush(60);
  check('движок: repeat one не запускает переход', api.getState().phase === 'idle');
}


/* ─────────────── fallback без Web Audio (элементное сведение) ─────────────── */

{
  const timers2 = [];
  let timerId2 = 0;
  const set2 = (fn, ms) => { timerId2 += 1; timers2.push({ id: timerId2, fn, ms }); return timerId2; };
  const clear2 = (id) => { const i = timers2.findIndex((t) => t.id === id); if (i >= 0) timers2.splice(i, 1); };
  const run2 = () => { for (const timer of [...timers2]) { const i = timers2.indexOf(timer); if (i >= 0) timers2.splice(i, 1); timer.fn(); } };
  const window2 = {
    localStorage: storage,
    document: documentShim,
    AudioContext: undefined,
    setTimeout: set2,
    clearTimeout: clear2,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const api2 = new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    source + '\n; return window.RH_SMARTMIX;')(window2, documentShim, storage, set2, clear2, () => 0, () => {});
  const primary2 = new FakeAudio();
  primary2.paused = false;
  const state2 = {
    current: { id: 'a', title: 'A', duration: 200 },
    index: 0,
    queue: [{ id: 'a', title: 'A', duration: 200 }, { id: 'b', title: 'B', duration: 200 }],
    repeat: 'off', paused: false, currentTime: 170, duration: 200, volume: 0.8, muted: false,
  };
  api2.init({
    getState: () => ({ ...state2 }),
    getAudio: () => primary2,
    streamUrl: (track) => `/api/stream/${track.id}?quality=mid`,
    adoptTrack: async () => true,
    toast: () => {},
    onChange: () => {},
  });
  check('fallback: без AudioContext движок не включает Web Audio', (await api2.warm()) === false);
  await api2.onTrack();
  await flush(60);
  run2();
  await flush(80);
  check('fallback: переход запускается без Web Audio', api2.getState().phase === 'running', api2.getState().phase);
  check('fallback: основной звук не выключен', primary2.volume > 0 && primary2.paused === false);
  api2.cancel('pause');
  check('fallback: отмена возвращает громкость и idle', api2.getState().phase === 'idle' && primary2.volume === 0.8);
}

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
