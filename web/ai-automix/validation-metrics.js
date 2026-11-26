/* Validation metrics for beat intelligence. Pure functions, no UI, no mocks. */

export function matchEvents(reference, estimated, tolerance = 0.07) {
  const ref = [...(reference || [])].sort((a, b) => a - b);
  const est = [...(estimated || [])].sort((a, b) => a - b);
  const matchedRef = new Set();
  const matchedEst = new Set();
  const errors = [];
  for (let i = 0; i < est.length; i += 1) {
    let best = -1;
    let bestError = Infinity;
    for (let j = 0; j < ref.length; j += 1) {
      if (matchedRef.has(j)) continue;
      const error = Math.abs(est[i] - ref[j]);
      if (error <= tolerance && error < bestError) { best = j; bestError = error; }
    }
    if (best >= 0) { matchedRef.add(best); matchedEst.add(i); errors.push(bestError); }
  }
  const precision = est.length ? matchedEst.size / est.length : 0;
  const recall = ref.length ? matchedRef.size / ref.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const median = percentile(errors, 0.5);
  const p95 = percentile(errors, 0.95);
  return {
    reference: ref.length, estimated: est.length, matched: matchedEst.size,
    precision: round(precision, 4), recall: round(recall, 4), f1: round(f1, 4),
    medianErrorMs: round(median * 1000, 2), p95ErrorMs: round(p95 * 1000, 2),
    missing: ref.length - matchedRef.size, duplicates: Math.max(0, est.length - matchedEst.size),
    toleranceMs: Math.round(tolerance * 1000),
  };
}

export function tempoMetrics(referenceBpm, estimatedBpm, toleranceRatio = 0.02) {
  if (!referenceBpm || !estimatedBpm) return { status: 'unavailable' };
  const ratio = estimatedBpm / referenceBpm;
  const delta = Math.abs(ratio - 1);
  let classification = 'other';
  if (delta <= toleranceRatio) classification = 'exact';
  else if (Math.abs(ratio - 0.5) <= toleranceRatio) classification = 'half-time';
  else if (Math.abs(ratio - 2) <= toleranceRatio) classification = 'double-time';
  else classification = 'error';
  return {
    referenceBpm: round(referenceBpm, 2), estimatedBpm: round(estimatedBpm, 2),
    ratio: round(ratio, 4), deltaBpm: round(estimatedBpm - referenceBpm, 2),
    relativeError: round(delta, 4), classification,
  };
}

export function phaseMetrics(referenceBeats, estimatedBeats, bpm) {
  if (!referenceBeats?.length || !estimatedBeats?.length || !bpm) return { status: 'unavailable' };
  const interval = 60 / bpm;
  const errors = [];
  for (const beat of estimatedBeats) {
    let best = Infinity;
    for (const ref of referenceBeats) {
      const diff = Math.abs(beat - ref) % interval;
      best = Math.min(best, Math.min(diff, interval - diff));
    }
    if (Number.isFinite(best)) errors.push(best);
  }
  return {
    samples: errors.length,
    medianMs: round(percentile(errors, 0.5) * 1000, 2),
    meanMs: round(errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length) * 1000, 2),
    p95Ms: round(percentile(errors, 0.95) * 1000, 2),
  };
}

export function stabilityMetrics(beats) {
  if (!beats || beats.length < 4) return { status: 'unavailable' };
  const intervals = [];
  for (let i = 1; i < beats.length; i += 1) {
    const value = beats[i] - beats[i - 1];
    if (value > 0.15 && value < 3) intervals.push(value);
  }
  if (!intervals.length) return { status: 'unavailable' };
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  const std = Math.sqrt(variance);
  // least-squares drift in ms per minute (positive = intervals grow)
  const n = intervals.length;
  const xs = intervals.map((_, index) => index);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const numerator = intervals.reduce((sum, y, index) => sum + (xs[index] - meanX) * (y - mean), 0);
  const denominator = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0) || 1;
  const slope = numerator / denominator;
  return {
    intervals: n,
    meanInterval: round(mean, 4),
    stdMs: round(std * 1000, 2),
    stability: round(Math.max(0, 1 - std / Math.max(0.001, mean)), 4),
    driftMsPerMinute: round(slope * (60 / mean) * 1000, 2),
  };
}

export function downbeatMetrics(reference, estimated, tolerance = 0.07) {
  return matchEvents(reference, estimated, tolerance);
}

export function summarizeSource(name, result, timings = {}) {
  return {
    source: name,
    bpm: result?.bpm ?? result?.result?.bpm ?? null,
    confidence: result?.bpmConfidence ?? result?.confidence ?? result?.result?.bpmConfidence ?? null,
    beatCount: result?.beats?.length ?? result?.beatCount ?? null,
    downbeatCount: result?.downbeats?.length ?? result?.downbeatCount ?? null,
    latencyMs: timings.latencyMs ?? result?.latencyMs ?? null,
    error: result?.error ?? null,
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

function round(value, digits = 4) { return Number(Number(value).toFixed(digits)); }
