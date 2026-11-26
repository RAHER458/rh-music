import assert from 'node:assert/strict';
import { mergeBeatThis } from '../web/ai-automix/beat-this-consensus.js';

const neural = { bpm: 124, bpmConfidence: 0.4, tempoAlternatives: [62, 124, 248], warnings: [] };
const beatThis = {
  bpm: 125, bpmConfidence: 0.98, beatCount: 100, downbeatCount: 25, latencyMs: 5000,
  modelVersion: 'test', beats: [], downbeats: [],
};
for (let i = 0; i < 120; i += 1) {
  beatThis.beats.push(Number((i * 0.48).toFixed(4)));
  if (i % 4 === 0) beatThis.downbeats.push(Number((i * 0.48).toFixed(4)));
}
const merged = mergeBeatThis(neural, beatThis);
assert.equal(merged.provenance.beatThis.bpm, 'consensus');
assert.ok(merged.bpm > 124 && merged.bpm < 125);
assert.ok(merged.beatThis.interval > 0.45 && merged.beatThis.interval < 0.51);
assert.ok(merged.grid && merged.grid.source === 'beat-this-consensus');

const clashing = mergeBeatThis({ ...neural, bpm: 100, bpmConfidence: 0.2 }, { ...beatThis, bpm: 150, bpmConfidence: 0.3 });
assert.ok(clashing.tempoAlternatives.includes(150));
assert.ok(clashing.warnings.some((warning) => /disagree/i.test(warning)));
console.log('beat-this consensus tests passed', { bpm: merged.bpm, confidence: merged.bpmConfidence, phase: merged.beatThis.phaseError });
