import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  return { sampleRate: SR, length, numberOfChannels: 1, duration: seconds, getChannelData: () => samples };
}
const a = API._internal.analyzeBuffer(clickTrack(120), { id: 'a', title: 'A', artist: 'A', duration: 60 });
const b = API._internal.analyzeBuffer(clickTrack(124), { id: 'b', title: 'B', artist: 'B', duration: 60 });
check('BPM analysis is plausible', Math.abs(a.bpm - 120) < 4, String(a.bpm));
check('downbeats detected', a.downbeats.length > 5);
const plan = API._internal.planTransition(a, b, 5);
check('transition starts late', plan.startAt >= 60 * 0.7, String(plan.startAt));
check('transition fits', plan.startAt + plan.durationSec <= 60);
check('transition has real duration', plan.durationSec >= 2);
check('transition has tempo rate', plan.rateIn > 0.9 && plan.rateIn < 1.1);
check('strategy is real', ['beta-bass-swap', 'beta-filter-cut'].includes(plan.strategy));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
