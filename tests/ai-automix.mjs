/**
 * AI AutoMix integration smoke tests.
 * Verifies the vendored engine ESM build and the RH-MUSIC wiring.
 * Does NOT verify real audio output.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

const html = readFileSync(join(here, '../web/index.html'), 'utf8');
const app = readFileSync(join(here, '../web/app.js'), 'utf8');
const controller = readFileSync(join(here, '../web/ai-automix/controller.js'), 'utf8');

console.log('RH—MUSIC · тесты AI AutoMix\n');

check('one AI AutoMix button in player', (html.match(/id="aiAutomixBtn"/g) || []).length === 1);
check('AI AutoMix chip in now playing', html.includes('id="npAiAutomix"'));
check('controller script loaded before app.js', html.indexOf('ai-automix/controller.js') > -1 && html.indexOf('ai-automix/controller.js') < html.indexOf('app.js'));
check('controller exposes global API', controller.includes('window.RH_AI_AUTOMIX'));
check('controller has real phases', ['LOADING','READY','ANALYZING','PREPARING','MIXING','ACTIVE','DEGRADED','ERROR'].every((phase) => controller.includes(`'${phase}'`)));
check('app routes AI toggle action', app.includes("action === 'ai-automix-toggle'"));
check('app routes track start to AI', app.includes('RH_AI_AUTOMIX.onTrackStarted(track)'));
check('app routes play/pause to AI', app.includes('RH_AI_AUTOMIX.pause()') && app.includes('RH_AI_AUTOMIX.resume()'));
check('app adopts AI track for history/UI', app.includes('function adoptAiTrack') && app.includes("startPlaybackSession(track, 'automix')"));
check('RH Smart Mix bridge remains', app.includes('window.RH_SMARTMIX.init'));
check('normal play is not gated by AI startup', !app.includes('await window.RH_AI_AUTOMIX.onTrackStarted'));
check('playIndex releases AI engine before manual start', app.includes('releaseToStandard(false)'));
check('AI enable does not pause standard audio', !controller.includes("getAudio().pause(); } catch (_) {} }\n    state.error"));
check('AI background analysis does not play Deck A', !/onTrackStarted[\s\S]{0,1200}deckA\.play/.test(controller));
check('only one next candidate is prepared', controller.includes('const candidate = candidates[0]'));
check('preparation has timeout', controller.includes('audio preparation') && controller.includes('30_000'));
check('transition has timeout', controller.includes("'transition'"));
check('AI takes over from host position', controller.includes('host.currentTime') && controller.includes('takeOverAndMix'));
check('AI can release playback to standard player', controller.includes('releaseToStandard') && app.includes('ownsPlayback()'));
check('AI pause uses player state, not paused standard element', app.includes('if (S.playing) {\n      window.RH_AI_AUTOMIX.pause();'));
check('seek is routed to AI when it owns output', controller.includes('function seek(position)') && app.includes('RH_AI_AUTOMIX.seek(target)'));
check('stale preparation is rejected by track token', controller.includes('trackToken') && controller.includes('token !== state.trackToken'));
check('takeover verifies real signal before muting standard audio', controller.includes('Deck A не дал аудиосигнала') && controller.includes('getMasterSamples'));
check('transition failure restores standard audio', controller.includes('transition') && controller.includes('onExit({ position })'));
check('Smart Mix setting is restored after AI', app.includes('aiSavedSmartMix'));
check('buffer cache is bounded after transition', controller.includes('trimCache'));
check('controller stores full RH-MUSIC track after transition', controller.includes('track: candidate.track'));
check('controller reports real mix start/duration/progress', controller.includes('startAt: plan.plan.startAt') && controller.includes('durationSec: plan.plan.durationSec') && controller.includes('progress'));
check('timeline uses TransitionPlan values, not animation', app.includes('function applyAiMixTimeline') && app.includes('mix.startAt') && app.includes('mix.durationSec') && app.includes('mix.progress'));
check('timeline writes CSS seek-band variables', app.includes("'--mix-start'") && app.includes("'--mix-width'") && app.includes("'--mix-progress'"));
check('timeline clears canceled plan', app.includes("el.style.setProperty('--mix-opacity', mix ? '1' : '0')"));
check('MIXING shows both tracks', app.includes('MIXING · ') && app.includes('→ '));
check('completeTransition adopts full track into RH-MUSIC state', app.includes('function adoptAiTrack') && app.includes('S.current = track') && app.includes('S.index = index'));
check('transition view is in Now Playing', html.includes('id="aiMixStatus"'));
check('adoption refreshes mini player', app.includes('adoptAiTrack') && /adoptAiTrack[\s\S]{0,900}renderCompactTrack/.test(app));
check('adoption refreshes transport controls', /adoptAiTrack[\s\S]{0,1200}updateTransport/.test(app));
check('adoption sets playback state', /adoptAiTrack[\s\S]{0,500}S\.playing = true/.test(app));
check('adoption avoids duplicate automix history session', app.includes('sameSession') && app.includes("source === 'automix'"));
check('adoption resets seekbar to incoming track', app.includes("$('npDur').textContent = fmt(track.duration)") && app.includes('syncSeek(0'));
check('adoption can still run if queue index is missing', app.includes('S.current = track;') && !app.includes('if (index >= 0) { S.index = index; S.current = track; }'));

const lib = await import('../web/ai-automix/automix-engine.js');
check('engine ESM exports AutoMixCore', typeof lib.AutoMixCore === 'function');
check('engine ESM exports AudioEngine', typeof lib.AudioEngine === 'function');
check('engine ESM exports analyzer', typeof lib.analyzeAudioBuffer === 'function');

const SR = 22050;
function clickTrack(bpm, seconds = 12) {
  const length = Math.floor(SR * seconds);
  const samples = new Float32Array(length);
  const period = 60 / bpm;
  for (let time = 0; time < seconds - 0.2; time += period) {
    const start = Math.floor(time * SR);
    for (let j = 0; j < Math.floor(0.08 * SR); j += 1) {
      const env = Math.exp(-j / (0.02 * SR));
      samples[start + j] += Math.sin((2 * Math.PI * 60 * j) / SR) * env * 0.9;
    }
  }
  return { sampleRate: SR, length, numberOfChannels: 1, duration: seconds, getChannelData: () => samples };
}
const core = lib.createAutoMixCore({ sessionId: 'rh-music-test' });
core.initialize();
const active = core.analyzeTrack({ id: 'a', title: 'A', artist: 'A', analysis: lib.analyzeAudioBuffer(clickTrack(120), { id: 'a' }) });
const candidateAnalysis = lib.analyzeAudioBuffer(clickTrack(124), { id: 'b' });
const candidate = { id: 'b', title: 'B', artist: 'B', index: 1, analysis: candidateAnalysis, context: core.analyzeTrack({ id: 'b', title: 'B', artist: 'B', analysis: candidateAnalysis }) };
const decision = core.decide('a', [candidate], { ids: [], artists: [] }, { position: 4, duration: 12, activeDeck: 'A', paused: false, remainingSec: 8 });
check('AutoMixCore analyzes active track', !!active);
check('AutoMixCore chooses a candidate', !!decision.chosen);
check('AutoMixCore plans a real strategy', !!decision.plan && typeof decision.plan.strategy === 'string');
const strategies = lib.strategyCandidates(lib.analyzeAudioBuffer(clickTrack(120), { id: 'a' }), candidateAnalysis);
check('AutoMixCore keeps 25 strategies', strategies.length === 25);
core.recordOutcome({ outgoingId: 'a', incomingId: 'b', strategy: decision.plan.strategy, planScore: decision.plan.score, qualityScore: 0.8, success: true, energy: 0.5 });
check('AutoMixCore records memory', core.diagnostics().memory.count === 1);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
