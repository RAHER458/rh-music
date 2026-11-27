import assert from 'node:assert/strict';
import { addEvent, createAnnotation, mergeAnnotations, normalizeAnnotation, removeNearest, tempoSegmentsFromBeats, validateAnnotation } from '../web/ai-automix/reference-schema.js';

let annotation = createAnnotation({ trackId: 'track_001', duration: 120 });
annotation = addEvent(annotation, 0.5, 'beat');
annotation = addEvent(annotation, 0.98, 'beat');
annotation = addEvent(annotation, 1.46, 'beat');
annotation = addEvent(annotation, 0.5, 'downbeat');
assert.deepEqual(annotation.beats, [0.5, 0.98, 1.46]);
assert.deepEqual(annotation.downbeats, [0.5]);
assert.equal(validateAnnotation(annotation).ok, true);

annotation = removeNearest(annotation, 0.98, 'beat');
assert.deepEqual(annotation.beats, [0.5, 1.46]);
assert.equal(validateAnnotation(annotation).ok, true);

const unsorted = normalizeAnnotation({ ...annotation, beats: [2, 1, 3], downbeats: [2.05] });
assert.deepEqual(unsorted.beats, [1, 2, 3]);
assert.deepEqual(unsorted.downbeats, [2]);

let segmentAnnotation = createAnnotation({ trackId: 'tempo', duration: 20 });
for (let i = 0; i < 20; i += 1) segmentAnnotation = addEvent(segmentAnnotation, i * 0.5, 'beat');
const segments = tempoSegmentsFromBeats(segmentAnnotation.beats);
assert.ok(segments.length >= 1);
assert.ok(segments[0].bpm > 119 && segments[0].bpm < 121);

const merged = mergeAnnotations({ beats: [1, 2, 3] }, { beats: [1.02, 2.05, 3.1] });
assert.equal(merged.matched, 2);
console.log('reference schema tests passed', { beats: annotation.beats.length, segments: segments.length, matched: merged.matched });


import { beatMetricsAtTolerances, evaluateAgainstReference } from '../web/ai-automix/validation-metrics.js';
const reference = { bpm_estimate: 120, beats: [0, 0.5, 1, 1.5, 2, 2.5], downbeats: [0, 2] };
const source = { bpm: 120, beats: [0.02, 0.53, 1.01, 1.48, 2.03, 2.49], downbeats: [0.02, 2.03] };
const evaluated = evaluateAgainstReference(reference, source);
if (evaluated.beat.t70.f1 < 0.99) throw new Error('expected perfect-ish F1');
if (evaluated.tempo.classification !== 'exact') throw new Error('expected exact tempo');
if (!beatMetricsAtTolerances(reference.beats, source.beats).t100) throw new Error('tolerance metrics missing');
console.log('reference metrics test passed', { f1: evaluated.beat.t70.f1, phaseMedian: evaluated.phase.medianMs });
