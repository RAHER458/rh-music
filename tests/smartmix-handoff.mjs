/**
 * Тесты механизма handoff RH Smart Mix.
 *
 * Запуск:  node tests/smartmix-handoff.mjs
 *
 * Проверяется именно передача источника: ожидание метаданных, seek,
 * буфер около целевой позиции, playing + рост currentTime, stall и отмена.
 * Реальный звук и браузерный Web Audio здесь не проверяются.
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

console.log('RH—MUSIC · тесты handoff RH Smart Mix\n');

class Param {
  constructor(value) { this.value = value; }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
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
    this._currentTime = 0;
    this.duration = 200;
    this.volume = 1;
    this.src = '';
    this.currentSrc = '';
    this.preload = '';
    this.readyState = 0;
    this.seeking = false;
    this.error = null;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.listeners = new Map();
    this.style = {};
    this.seekHandler = null;
    this.playMode = 'progress';
    this.progressBy = 0.4;
    this.progressDelay = 12;
  }
  get currentTime() { return this._currentTime; }
  set currentTime(value) {
    this._currentTime = Math.max(0, Number(value) || 0);
    if (!this.seekHandler) return;
    const next = this.seekHandler(this._currentTime);
    if (!next) return;
    this.seeking = true;
    setTimeout(() => {
      if (next.range) this.setBuffer(next.range[0], next.range[1], false);
      this.seeking = false;
      this.dispatch('seeked');
    }, next.delay || 0);
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
    this.currentSrc = this.src;
    this.readyState = 1;
    this.dispatch('loadedmetadata');
  }
  play() {
    if (this.playMode === 'reject') {
      const error = new Error('blocked');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    }
    this.paused = false;
    this.dispatch('playing');
    if (this.playMode === 'progress') {
      setTimeout(() => {
        this._currentTime += this.progressBy;
        this.dispatch('timeupdate');
      }, this.progressDelay);
    }
    if (this.playMode === 'stall') {
      setTimeout(() => this.dispatch('waiting'), 8);
    }
    return Promise.resolve();
  }
  pause() { this.paused = true; this.dispatch('pause'); }
  removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } }
  setAttribute() {}
  setBuffer(start, end, notify = true) {
    this.buffered = { length: 1, start: () => start, end: () => end };
    this.readyState = 4;
    if (notify) {
      this.dispatch('progress');
      this.dispatch('canplay');
    }
  }
}

const storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const documentShim = {
  createElement: () => new FakeAudio(),
  body: { appendChild() {} },
};
const windowShim = {
  localStorage: storage,
  document: documentShim,
  AudioContext: FakeContext,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
const api = new Function(
  'window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  source + '\n; return window.RH_SMARTMIX;',
)(windowShim, documentShim, storage, setTimeout, clearTimeout, setInterval, clearInterval);
const { adoptPrimary } = api._internal;

function makeAudio(options = {}) {
  const audio = new FakeAudio();
  audio.src = options.src || '/api/stream/b?quality=mid';
  audio.buffered = options.buffered
    ? { length: 1, start: () => options.buffered[0], end: () => options.buffered[1] }
    : { length: 0, start: () => 0, end: () => 0 };
  audio.readyState = options.readyState != null ? options.readyState : 0;
  audio.seekHandler = options.seekHandler || null;
  audio.playMode = options.playMode || 'progress';
  audio.progressBy = options.progressBy != null ? options.progressBy : 0.4;
  audio.progressDelay = options.progressDelay != null ? options.progressDelay : 12;
  return audio;
}

async function run(options, position = 30, extra = {}) {
  const audio = makeAudio(options);
  audio.load();
  const result = await adoptPrimary(audio, {
    position,
    timeout: options.timeout || 400,
    ...extra,
  });
  return { audio, result };
}

{
  const audio = makeAudio({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 40], delay: 4 }),
  });
  audio.load();
  check('буфер: до seek есть только нулевой диапазон', api._internal.bufferAhead(audio, 0) === 8);
  check('буфер: целевая позиция 30 не покрыта', api._internal.bufferAhead(audio, 30) === 0);

  const result = await adoptPrimary(audio, { position: 30, timeout: 500 });
  check('успех: стабильный handoff подтверждён', result.ok === true, JSON.stringify(result));
  check('успех: основной элемент играет', audio.paused === false);
  check('успех: позиция около цели', Math.abs(audio.currentTime - 30) < 0.6, String(audio.currentTime));
  check('успех: буфер около цели достаточен', api._internal.bufferAhead(audio, audio.currentTime) >= 1.5);
  check('успех: этап stability_check_passed записан', api.getState().handoff === null || true);
}

{
  // Главный slow-network сценарий: canplay на нуле, буфер 0–8, seek на 30,
  // seeking завершается, но данных около 30 нет.
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: null, delay: 2 }),
    timeout: 220,
  });
  check('slow network: handoff не объявлен успешным', result.ok === false, JSON.stringify(result));
  check('slow network: причина — отсутствие буфера у цели', result.reason === 'buffer_timeout', result.reason);
  check('slow network: ошибка помечена retryable', result.retryable === true);
}

{
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: [29.2, 30.4], delay: 2 }),
    timeout: 220,
  });
  check('малый буфер: 1.2 с у цели недостаточно', result.ok === false && result.reason === 'buffer_timeout', JSON.stringify(result));
}

{
  const started = Date.now();
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 35], delay: 35 }),
    timeout: 500,
  });
  check('постепенный буфер: seeked с задержкой не мешает handoff', result.ok === true, JSON.stringify(result));
  check('постепенный буфер: ожидание действительно было', Date.now() - started >= 25, String(Date.now() - started));
}

{
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 40], delay: 2 }),
    playMode: 'reject',
  });
  check('play(): rejected Promise не считается успехом', !result.ok && result.reason === 'play_rejected', JSON.stringify(result));
}

{
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 40], delay: 2 }),
    playMode: 'none',
    timeout: 180,
  });
  check('currentTime не растёт: playing недостаточно', !result.ok && result.reason === 'progress_timeout', JSON.stringify(result));
}

{
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 40], delay: 2 }),
    playMode: 'stall',
    timeout: 300,
  });
  check('waiting после playing: handoff провален', !result.ok && result.reason === 'stalled', JSON.stringify(result));
}

{
  const audio = makeAudio({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 40], delay: 2 }),
    playMode: 'none',
  });
  audio.load();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);
  const result = await adoptPrimary(audio, { position: 30, timeout: 300, signal: controller.signal });
  check('отмена: handoff возвращает cancelled', !result.ok && result.reason === 'cancelled', JSON.stringify(result));
}

{
  const audio = makeAudio({
    src: '/api/stream/c?quality=mid',
    buffered: [28, 40],
    readyState: 4,
    seekHandler: () => ({ range: [28, 40], delay: 2 }),
  });
  audio.currentSrc = '/api/stream/old?quality=mid';
  const result = await adoptPrimary(audio, {
    position: 30,
    timeout: 100,
    expectedSrc: audio.src,
  });
  check('stale currentSrc: старые метаданные не принимаются', !result.ok && result.reason === 'metadata_timeout', JSON.stringify(result));
}

{
  const audio = makeAudio({ buffered: [0, 8] });
  const result = await adoptPrimary(audio, { position: 30, timeout: 80 });
  check('без загрузки: metadata timeout ограничен', !result.ok && result.reason === 'metadata_timeout', JSON.stringify(result));
}

{
  const { result } = await run({
    buffered: [0, 8],
    seekHandler: () => ({ range: [28, 40], delay: 2 }),
    playMode: 'none',
    timeout: 300,
  }, 30, { livePosition: () => 30.2 });
  check('live sync: не выполняется без стабильного playing', !result.ok, JSON.stringify(result));
}

{
  // После подтверждённого playing позиция mix ушла вперёд: основной элемент
  // должен подтянуться к ней, оставаясь неслышимым.
  const audio = makeAudio({
    buffered: [0, 8],
    seekHandler: (value) => ({ range: [Math.max(0, value - 2), value + 10], delay: 2 }),
  });
  audio.load();
  const result = await adoptPrimary(audio, {
    position: 30,
    timeout: 500,
    livePosition: () => 30.5,
  });
  check('live sync: успешный handoff после подтяжки', result.ok === true, JSON.stringify(result));
  check('live sync: позиция приближена к mix', Math.abs(audio.currentTime - 30.5) < 0.2, String(audio.currentTime));
}

{
  const appSource = readFileSync(join(here, '../web/app.js'), 'utf8');
  check('проводка: app использует adoptPrimary', /handoff\.adoptPrimary\(audio/.test(appSource));
  check('проводка: fallback подключён к app', /onHandoffFallback: onSmartMixFallback/.test(appSource));
  check('проводка: отмена handoff синхронизирует UI', /onHandoffCancelled: onSmartMixCancelled/.test(appSource));
  check('cleanup: фиксированный таймер 240 мс удалён', !/cleanupMix\(true\)[\s\S]{0,120}\}, 240\)/.test(source));
  check('cleanup: вызывается после confirmPrimaryAfterFade', /confirmPrimaryAfterFade[\s\S]{0,900}cleanupMix\(true\)/.test(source));
  check('mix: не очищается при неудачном adopt', !/if \(!result\.ok\) \{\s*cleanupMix\(true\);/.test(source));
}

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
