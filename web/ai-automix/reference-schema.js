/* Reference annotation schema and pure helpers. No audio, no UI. */

export const REFERENCE_SCHEMA_VERSION = '1.0';

export function createAnnotation(input = {}) {
  const now = new Date().toISOString();
  return {
    schema_version: REFERENCE_SCHEMA_VERSION,
    track_id: input.trackId || input.track_id || 'unknown',
    title: input.title || '',
    source: input.source || 'local',
    duration_seconds: Number(input.duration || input.duration_seconds) || 0,
    annotation_status: input.status || 'in_progress',
    annotator_id: input.annotatorId || input.annotator_id || 'annotator_1',
    bpm_estimate: input.bpmEstimate ?? input.bpm_estimate ?? null,
    beats: [...(input.beats || [])],
    downbeats: [...(input.downbeats || [])],
    tempo_segments: [...(input.tempoSegments || input.tempo_segments || [])],
    uncertain_regions: [...(input.uncertainRegions || input.uncertain_regions || [])],
    notes: input.notes || '',
    created_at: input.createdAt || input.created_at || now,
    updated_at: now,
  };
}

function round(value, digits = 4) { return Number(Number(value).toFixed(digits)); }

export function normalizeAnnotation(annotation) {
  const beats = [...new Set((annotation.beats || []).map((value) => round(Number(value))).filter(Number.isFinite))].sort((a, b) => a - b);
  const downbeats = [...new Set((annotation.downbeats || []).map((value) => round(Number(value))).filter(Number.isFinite))].sort((a, b) => a - b)
    // A downbeat must coincide with an annotated beat.
    .map((value) => beats.reduce((best, beat) => (Math.abs(beat - value) < Math.abs(best - value) ? beat : best), beats[0] ?? value))
    .filter((value, index, list) => list.indexOf(value) === index);
  return { ...annotation, beats, downbeats, updated_at: new Date().toISOString() };
}

export function addEvent(annotation, time, kind = 'beat') {
  const value = round(Number(time));
  if (!Number.isFinite(value) || value < 0) return annotation;
  if (kind === 'downbeat') return normalizeAnnotation({ ...annotation, downbeats: [...annotation.downbeats, value] });
  return normalizeAnnotation({ ...annotation, beats: [...annotation.beats, value] });
}

export function removeNearest(annotation, time, kind = 'beat') {
  const list = kind === 'downbeat' ? annotation.downbeats : annotation.beats;
  if (!list.length) return annotation;
  let bestIndex = 0;
  let best = Infinity;
  for (let i = 0; i < list.length; i += 1) {
    const distance = Math.abs(list[i] - time);
    if (distance < best) { best = distance; bestIndex = i; }
  }
  const next = [...list];
  next.splice(bestIndex, 1);
  return normalizeAnnotation(kind === 'downbeat' ? { ...annotation, downbeats: next } : { ...annotation, beats: next });
}

export function tempoSegmentsFromBeats(beats, tolerance = 0.08) {
  if (!beats || beats.length < 3) return [];
  const intervals = [];
  for (let i = 1; i < beats.length; i += 1) intervals.push(beats[i] - beats[i - 1]);
  const segments = [];
  let startIndex = 0;
  for (let i = 1; i <= intervals.length; i += 1) {
    const current = intervals[i];
    const previous = intervals[i - 1];
    const changed = i === intervals.length || Math.abs(current - previous) / Math.max(0.001, previous) > tolerance;
    if (changed) {
      const slice = intervals.slice(startIndex, i);
      const mean = slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
      if (mean > 0.2) {
        segments.push({
          start: round(beats[startIndex]),
          end: round(beats[Math.min(beats.length - 1, i)] ?? beats[beats.length - 1]),
          bpm: round(60 / mean, 2),
        });
      }
      startIndex = i;
    }
  }
  return segments;
}

export function validateAnnotation(annotation) {
  const errors = [];
  if (!annotation || typeof annotation !== 'object') errors.push('annotation must be an object');
  if (annotation?.schema_version !== REFERENCE_SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (!annotation?.track_id) errors.push('track_id missing');
  if (!Array.isArray(annotation?.beats)) errors.push('beats must be an array');
  if (!Array.isArray(annotation?.downbeats)) errors.push('downbeats must be an array');
  if (Number(annotation?.duration_seconds) < 0) errors.push('duration_seconds invalid');
  const beats = annotation?.beats || [];
  for (let i = 1; i < beats.length; i += 1) if (beats[i] < beats[i - 1]) errors.push('beats are not sorted');
  for (const downbeat of annotation?.downbeats || []) {
    if (!beats.some((beat) => Math.abs(beat - downbeat) < 0.001)) errors.push(`downbeat ${downbeat} has no matching beat`);
  }
  return { ok: errors.length === 0, errors };
}

export function mergeAnnotations(primary, secondary, tolerance = 0.07) {
  return {
    primary, secondary,
    matched: (primary.beats || []).filter((beat) => (secondary.beats || []).some((other) => Math.abs(other - beat) <= tolerance)).length,
    primaryCount: primary.beats?.length || 0,
    secondaryCount: secondary.beats?.length || 0,
  };
}
