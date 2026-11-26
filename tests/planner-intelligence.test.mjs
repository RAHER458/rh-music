import assert from 'node:assert/strict';
import { planTransition, segmentCompatibility } from '../web/ai-automix/automix-engine.js';

function track(id, { bpm = 124, key = 'A minor', camelot = '8A', duration = 240, vocalAt = 0.55 } = {}) {
  const section = (start, end, kind, energy, vocal) => ({ start, end, kind, energy, confidence: 0.8 });
  const sections = [
    section(0, duration * 0.12, 'intro', 0.4, 0.05),
    section(duration * 0.12, duration * 0.35, 'verse', 0.6, 0.35),
    section(duration * 0.35, duration * 0.55, 'chorus', 0.85, 0.7),
    section(duration * 0.55, duration * 0.72, 'breakdown', 0.5, 0.1),
    section(duration * 0.72, duration * 0.9, 'drop', 0.95, 0.25),
    section(duration * 0.9, duration, 'outro', 0.4, 0.05),
  ];
  const timeline = sections.map((s) => ({
    ...s,
    bands: { low: s.kind === 'drop' ? 0.7 : 0.35, mid: 0.4, high: 0.3 },
    spectral: { centroid: 1800, flatness: 0.2 },
    transientDensity: 0.4,
    vocalLikelihood: s.kind === 'chorus' ? 0.8 : s.kind === 'breakdown' ? 0.08 : s.vocal ?? 0.2,
    key, camelot, keyConfidence: 0.6,
  }));
  const beats = []; for (let t = 0; t < duration; t += 60 / bpm) beats.push(Number(t.toFixed(3)));
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return {
    id, title: id, duration, bpm, bpmConfidence: 0.8, key, camelot, keyConfidence: 0.6,
    tempoStability: 0.9, tempoAlternatives: [bpm / 2, bpm, bpm * 2], phrases: downbeats.filter((_, i) => i % 4 === 0),
    sections, timeline,
    grid: { bpm, confidence: 0.8, beats, downbeats, phraseBars: 4, barBars: 4, gridOffset: 0 },
    cues: { intro: 0, mixIn: duration * 0.12, mixOut: duration * 0.55, outro: duration * 0.9 },
    intensity: 0.7, vocalRisk: 0.4, vocal: { risk: 0.4, regions: [{ start: duration * 0.35, end: duration * 0.55, type: 'vocal' }] },
    bands: { low: 0.4, mid: 0.4, high: 0.3 }, spectrum: { centroid: 1800, rolloff: 6000, flux: 0.1, flatness: 0.2 },
    drums: { kick: 0.6, snare: 0.4 }, warning: [], warnings: [],
  };
}

const a = track('A');
const b = track('B', { key: 'C major', camelot: '8B' });
const plan = planTransition(a, b, { position: 0, paused: false, duration: a.duration });
assert.ok(plan.startAt >= a.duration * 0.4 - 0.5, 'starts after 40%');
assert.ok(plan.startAt <= a.duration * 0.9, 'does not drift to the end');
assert.ok(plan.compatibility, 'segment compatibility present');
assert.ok(plan.eq && plan.effects, 'effect plan present');
assert.ok(plan.minProgressRatio >= 0.4, 'minimum progress guard');

const vocalClash = segmentCompatibility(a, b, a.duration * 0.4, b.duration * 0.4, 1, 'beat-blend');
const vocalSafe = segmentCompatibility(a, b, a.duration * 0.4, b.duration * 0.4, 1, 'vocal-safe');
assert.ok(vocalClash.vocalOverlap > 0.5, 'detects vocal overlap');
assert.ok(vocalClash.hardFailures.length > 0, 'hard-rejects vocal clash for beat-blend');
assert.equal(vocalSafe.hardFailures.length, 0, 'vocal-safe allows vocal overlap');

console.log('planner intelligence tests passed', {
  start: plan.startAt.toFixed(1), progress: (plan.startAt / a.duration * 100).toFixed(1) + '%',
  strategy: plan.strategy, compat: plan.compatibility.score, intensity: plan.mixIntensity,
});
