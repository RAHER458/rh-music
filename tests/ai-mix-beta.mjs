import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0; const failures = [];
function check(name, condition, extra = '') { if (condition) { passed++; return; } failures.push(name + (extra ? ' — ' + extra : '')); console.error('  ✗', name, extra); }
const source = readFileSync(join(here, '../web/ai-mix-beta/controller.js'), 'utf8');
const html = readFileSync(join(here, '../web/index.html'), 'utf8');
const app = readFileSync(join(here, '../web/app.js'), 'utf8');

const win = {};
new Function('window', 'document', source)(win, { createElement: () => ({}) });
const API = win.RH_AI_MIX_BETA;

console.log('RH—MUSIC · AI Mix Beta tests\n');
check('separate global controller', !!API);
check('one beta button', (html.match(/id="aiMixBetaBtn"/g) || []).length === 1);
check('beta chip exists', html.includes('id="npAiMixBeta"'));
check('beta script is isolated dir', html.includes('ai-mix-beta/controller.js'));
check('beta buttons are mutually exclusive with AI AutoMix', app.includes('Сначала выключите AI Mix Beta') && app.includes('Сначала выключите AI AutoMix'));
check('beta uses queue after current index', source.includes('(idx + off) % q.length'));
check('beta prepares one next track', source.includes('const cand = candidates()[0]'));
check('beta has real buffers and two decks', source.includes('createBufferSource') && source.includes('makeDeck()'));
check('beta has equal-power crossfade', source.includes('Math.cos(t * Math.PI / 2)') && source.includes('Math.sin(t * Math.PI / 2)'));
check('beta has bass swap', source.includes("strategy === 'beta-bass-swap'") && source.includes('low.gain'));
check('beta has beat analysis/downbeats', source.includes('downbeats') && source.includes('bpm'));
check('beta schedules at late track region', source.includes('duration * 0.72') && source.includes('mixOut'));

const SR = 22050;
function clickTrack(bpm, seconds = 60) {
  const length = Math.floor(SR * seconds); const samples = new Float32Array(length);
  for (let t = 0; t < seconds - 0.2; t += 60 / bpm) {
    const start = Math.floor(t * SR);
    for (let j = 0; j < Math.floor(0.06 * SR); j += 1) {
      const e = Math.exp(-j / (0.015 * SR));
      samples[start + j] += Math.sin(2 * Math.PI * 60 * j / SR) * e;
    }
  }
  return samples;
}
function pulseGridAnalyze(samples, duration) {
  const messages = [];
  const context = { self: { onmessage: null, postMessage: (m) => messages.push(m) }, Math, Float32Array, Float64Array, console };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(here, '../web/ai-mix-beta/pulsegrid-analysis-worker.js'), 'utf8'), context);
  context.self.onmessage({ data: { id: 1, samples, sampleRate: SR, duration } });
  const complete = messages.find((m) => m.phase === 'complete');
  if (!complete) throw new Error('PulseGrid worker did not complete');
  return complete.result;
}
const analysisResult = pulseGridAnalyze(clickTrack(120), 60);
check('PulseGrid worker detects BPM', Math.abs(analysisResult.bpm - 120) < 5, String(analysisResult.bpm));
check('PulseGrid worker returns beat grid', Number.isFinite(analysisResult.gridOffset) && analysisResult.gridOffset >= 0);
check('PulseGrid worker returns key/energy', typeof analysisResult.camelot === 'string' && Number.isFinite(analysisResult.energy));
const beatSec = 60 / analysisResult.bpm;
const downbeats = []; for (let t = analysisResult.gridOffset; t < 59.5; t += beatSec * 4) downbeats.push(t);
const a = { bpm: analysisResult.bpm, beatSec, downbeats, duration: 60, mixOut: 43.2, sections: [] };
const b = { bpm: 124, beatSec: 60 / 124, downbeats, duration: 60, mixOut: 43.2, sections: [] };
const plan = API._internal.planTransition(a, b, 5);
check('transition starts late', plan.startAt >= 60 * 0.7, String(plan.startAt));
check('transition fits', plan.startAt + plan.durationSec <= 60);
check('transition has real duration', plan.durationSec >= 2);
check('transition has tempo rate', plan.rateIn > 0.9 && plan.rateIn < 1.1);
check('strategy is real', ['beta-bass-swap', 'beta-filter-cut'].includes(plan.strategy));
check('PulseGrid worker and policy are vendored', source.includes('pulsegrid-analysis-worker') && source.includes('pulsegrid-transition-policy') && source.includes('pulsegrid-pitch-processor'));
const cacheSource = readFileSync(join(here, '../web/ai-mix-beta/cache.js'), 'utf8');
check('IndexedDB analysis cache is bounded', cacheSource.includes('indexedDB') && cacheSource.includes('MAX_ENTRIES = 80'));
check('beta uses persistent analysis cache', source.includes('RH_AI_MIX_BETA_CACHE') && source.includes('cacheKey'));
check('beta strategy uses key/energy', source.includes('camelotDistance') && source.includes('energyDelta') && source.includes('beta-long-blend'));
check('beta has seamless filter-cut automation', source.includes("strategy === 'beta-filter-cut'") && source.includes('exponentialRampToValueAtTime'));
check('beta timeline CSS band exists', readFileSync(join(here, '../web/styles.css'), 'utf8').includes('--beta-mix-start'));
check('beta timeline clears and displays incoming', app.includes('applyBetaTimeline') && app.includes('BETA MIXING ·'));
check('beta status element exists', html.includes('id="betaMixStatus"'));
check('beta dual waveform canvases exist', html.includes('betaWaveOut') && html.includes('betaWaveIn'));
check('beta visualization draws real peaks/positions', app.includes('drawBetaWave') && app.includes('getVisualization') && app.includes('outPeaks'));
check('beta visualization timer follows deck position', app.includes('__rhBetaVizTimer') && app.includes('syncSeek(info.position'));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
