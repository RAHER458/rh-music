/**
 * Тесты RH Smart Mix: анализ темпа, планировщик переходов и настройки.
 *
 * Запуск:  node tests/smartmix.mjs
 *
 * Реальное звучание и Web Audio в Node не проверяются — для этого нужен
 * браузер с аудиовыходом; тесты проверяют детерминированные алгоритмы.
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

const store = {};
const storage = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: (key) => { delete store[key]; },
};
const windowShim = {
  localStorage: storage,
  document: { createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }) },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
const api = new Function(
  'window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  source + '\n; return window.RH_SMARTMIX;',
)(windowShim, windowShim.document, storage, setTimeout, clearTimeout, setInterval, clearInterval);

const {
  detectTempo, analyzeAudioBuffer, planTransition, barsToSeconds, sanitizeSettings,
} = api._internal;

console.log('RH—MUSIC · тесты RH Smart Mix\n');

/* ───────────────────────────── синтетика ───────────────────────────── */

const SR = 44100;

function clickTrack(bpm, seconds = 20, noise = 0.02) {
  const length = Math.floor(SR * seconds);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = (Math.random() * 2 - 1) * noise;
  const period = 60 / bpm;
  for (let time = 0; time < seconds - 0.2; time += period) {
    const start = Math.floor(time * SR);
    const count = Math.floor(0.12 * SR);
    for (let j = 0; j < count; j += 1) {
      const env = Math.exp(-j / (0.025 * SR));
      samples[start + j] += Math.sin((2 * Math.PI * 60 * j) / SR) * env * 0.8;
      samples[start + j] += (Math.random() * 2 - 1) * env * 0.15;
    }
  }
  return samples;
}

{
  const result = detectTempo(clickTrack(120), SR);
  check('BPM: 120 определяется', result && Math.abs(result.bpm - 120) < 2, result && String(result.bpm));
  check('BPM: есть фаза и период', result && result.offset >= 0 && result.period > 0.4 && result.period < 0.6);
  check('BPM: высокая уверенность на кликах', result && result.confidence > 0.5, result && String(result.confidence));
  check('BPM: downbeat определён', result && Number.isFinite(result.downbeatOffset));
}

{
  for (const bpm of [90, 100, 128, 140]) {
    const result = detectTempo(clickTrack(bpm), SR);
    const ok = result && (Math.abs(result.bpm - bpm) < 3
      || Math.abs(result.bpm - bpm * 2) < 3
      || Math.abs(result.bpm - bpm / 2) < 3);
    check(`BPM: ${bpm} (или half/double)`, ok, result && String(result.bpm));
  }
}

{
  const noise = new Float32Array(SR * 12).map(() => Math.random() * 0.5 - 0.25);
  const result = detectTempo(noise, SR);
  check('BPM: шум не даёт уверенного темпа', !result || result.confidence < 0.35, result && String(result.confidence));
  check('BPM: тишина не анализируется', detectTempo(new Float32Array(SR * 12), SR) === null);
  check('BPM: слишком короткий фрагмент не анализируется', detectTempo(new Float32Array(100), SR) === null);
}

{
  const samples = clickTrack(120);
  const fakeBuffer = {
    numberOfChannels: 2,
    length: samples.length,
    sampleRate: SR,
    duration: samples.length / SR,
    getChannelData: () => samples,
  };
  const result = analyzeAudioBuffer(fakeBuffer);
  check('analyzeAudioBuffer: буфер превращается в анализ', result && Math.abs(result.bpm - 120) < 3);
  check('analyzeAudioBuffer: пустой буфер безопасен', analyzeAudioBuffer(null) === null);
}

/* ───────────────────────────── планировщик ───────────────────────────── */

function current(bpm = 120, confidence = 0.8, duration = 200) {
  return {
    duration,
    analysis: {
      bpm,
      confidence,
      period: 60 / bpm,
      offset: 0,
      downbeatOffset: 1,
      downbeatConfidence: 0.7,
    },
  };
}
function next(bpm = 124, confidence = 0.8) {
  return {
    analysis: {
      bpm,
      confidence,
      period: 60 / bpm,
      offset: 0,
      downbeatOffset: 2,
      downbeatConfidence: 0.7,
    },
  };
}

{
  const plan = planTransition(current(120), next(124), { bars: 8, now: 100 });
  check('план: музыкальный режим при уверенном анализе', plan && plan.mode === 'beat');
  check('план: длина 8 тактов при 120 BPM', plan && Math.abs(plan.duration - 16) < 0.2);
  check('план: умеренная коррекция темпа', plan && Math.abs(plan.rate - 120 / 124) < 0.001);
  check('план: вход следующего по downbeat', plan && plan.incomingStart === 2);
  check('план: старт раньше конца', plan && plan.startAt < plan.endAt && plan.endAt <= 200);
}

{
  const plan = planTransition(current(120), next(128), { bars: 4, now: 100 });
  check('план: 4 такта — 8 секунд', plan && Math.abs(plan.duration - 8) < 0.2);
  check('план: несовместимый BPM не тянется', plan && plan.rate === 1);
}

{
  const far = planTransition(current(120), next(128), { bars: 16, now: 20 });
  check('план: 16 тактов — 32 секунды', far && Math.abs(far.duration - 32) < 0.3);
  check('план: старт не раньше текущего времени', far && far.startAt > 20);
}

{
  const fallback = planTransition(current(120, 0.2), next(124), { bars: 8, now: 100 });
  check('план: низкая уверенность — fallback', fallback && fallback.mode === 'fallback');
  check('план: fallback не выдумывает BPM', fallback && fallback.rate === 1 && fallback.currentBpm === 120);
  check('план: fallback короткий и безопасный', fallback && fallback.duration === 6);
}

{
  const noAnalysis = planTransition({ duration: 200, analysis: null }, next(), { bars: 8, now: 100 });
  check('план: без анализа — fallback', noAnalysis && noAnalysis.mode === 'fallback');
  check('план: без анализа нет темпа', noAnalysis && noAnalysis.currentBpm === null);
}

{
  const short = planTransition(current(80, 0.8, 30), next(95), { bars: 8, now: 16 });
  check('план: длинный переход не выходит за конец трека',
    short && short.startAt + short.duration <= 30.01, short && String(short.startAt + short.duration));
  check('план: для короткого остатка выбран fallback', short && short.mode === 'fallback');

  check('план: короткий трек не переводится', planTransition(current(120, 0.8, 10), next(), { bars: 8, now: 0 }) === null);
  const late = planTransition(current(120, 0.8, 200), next(), { bars: 8, now: 199.9 });
  check('план: слишком поздний старт отклоняется', late === null);
  check('план: barsToSeconds 120 BPM', barsToSeconds(8, 120) === 16 && barsToSeconds(4, 120) === 8);
  check('план: barsToSeconds без BPM', barsToSeconds(8, 0) === 0);
}

/* ───────────────────────────── настройки ───────────────────────────── */

{
  check('настройки: по умолчанию выключено', sanitizeSettings(null).enabled === false);
  check('настройки: по умолчанию 8 тактов', sanitizeSettings({}).bars === 8);
  check('настройки: предзагрузка по умолчанию включена', sanitizeSettings({}).preload === true);
  check('настройки: предзагрузку можно выключить', sanitizeSettings({ preload: false }).preload === false);
  check('настройки: допустимые пресеты', [4, 8, 16].every((bars) => sanitizeSettings({ bars }).bars === bars));
  check('настройки: недопустимый пресет сбрасывается', sanitizeSettings({ bars: 7 }).bars === 8);
  check('настройки: включение сохраняется', sanitizeSettings({ enabled: true }).enabled === true);
}

{
  check('движок: настройки читаются из localStorage', api.getSettings().enabled === false);
  const changed = api.setSettings({ enabled: true, bars: 4 });
  check('движок: setSettings применяет пресет', changed.enabled === true && changed.bars === 4);
  check('движок: настройки сохраняются', JSON.parse(store.rh_smartmix_v1).bars === 4);
  api.setSettings({ enabled: false });
}

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
