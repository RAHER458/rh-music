/* Consensus between Neural AI, PulseGrid and Beat This.
   Does not blindly average BPM. Keeps alternative hypotheses when sources
   disagree and lowers confidence. Beat/downbeat timestamps from Beat This can
   refine the grid only when its confidence and phase evidence are strong. */

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round(value, digits = 4) { return Number(Number(value).toFixed(digits)); }

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function intervalStats(beats) {
  const intervals = [];
  for (let i = 1; i < beats.length; i += 1) {
    const value = beats[i] - beats[i - 1];
    if (value > 0.2 && value < 2) intervals.push(value);
  }
  if (!intervals.length) return { interval: 0, stability: 0 };
  const center = median(intervals);
  const deviation = Math.sqrt(intervals.reduce((sum, value) => sum + (value - center) ** 2, 0) / intervals.length);
  return { interval: center, stability: clamp(1 - deviation / Math.max(0.001, center), 0, 1) };
}

function phaseError(gridOffset, beats, interval) {
  if (!beats?.length || !interval) return null;
  let best = Infinity;
  for (const beat of beats) {
    const phase = ((beat % interval) + interval) % interval;
    const target = ((gridOffset % interval) + interval) % interval;
    const diff = Math.abs(phase - target);
    best = Math.min(best, Math.min(diff, interval - diff));
  }
  return Number.isFinite(best) ? best : null;
}

export function mergeBeatThis(analysis, beatThis) {
  if (!analysis || !beatThis || !beatThis.beats?.length) return analysis;
  const neuralBpm = Number(analysis.bpm) || 0;
  const neuralConf = Number(analysis.bpmConfidence) || 0;
  const btBpm = Number(beatThis.bpm) || 0;
  const btConf = Number(beatThis.bpmConfidence) || 0;
  const stats = intervalStats(beatThis.beats);
  const ratio = neuralBpm && btBpm ? btBpm / neuralBpm : 1;
  const delta = Math.abs(ratio - 1);
  const alternatives = new Set(analysis.tempoAlternatives || []);
  alternatives.add(Number(btBpm.toFixed(2)));
  const merged = { ...analysis };
  let bpmSource = 'neural';
  let confidence = neuralConf;
  if (!neuralBpm && btBpm) {
    merged.bpm = btBpm;
    bpmSource = 'beat-this';
    confidence = btConf;
  } else if (btBpm && delta < 0.02) {
    const total = neuralConf + btConf || 1;
    merged.bpm = Number(((neuralBpm * neuralConf + btBpm * btConf) / total).toFixed(2));
    bpmSource = 'consensus';
    confidence = Math.max(neuralConf, btConf);
  } else if (btBpm && btConf > neuralConf + 0.15) {
    // Keep Neural BPM as alternative; do not silently replace it.
    merged.bpm = Number(btBpm.toFixed(2));
    bpmSource = 'beat-this';
    confidence = btConf * 0.9;
    alternatives.add(Number(neuralBpm.toFixed(2)));
  } else {
    confidence = Math.min(neuralConf, btConf) * 0.8;
  }
  merged.bpmConfidence = round(confidence, 3);
  merged.tempoAlternatives = [...alternatives].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const beatInterval = stats.interval || (merged.bpm ? 60 / merged.bpm : 0);
  const offset = beatThis.downbeats?.[0] ?? beatThis.beats[0] ?? 0;
  const phase = phaseError(offset, beatThis.beats, beatInterval);
  const gridFromBeatThis = beatThis.downbeats?.length >= 4 && stats.stability > 0.45;
  if (gridFromBeatThis) {
    merged.grid = {
      bpm: Number((merged.bpm || btBpm).toFixed(2)),
      confidence: round(Math.max(neuralConf, btConf) * stats.stability, 3),
      beats: beatThis.beats.slice(),
      downbeats: beatThis.downbeats.slice(),
      barBars: 4,
      phraseBars: 4,
      gridOffset: Number(offset.toFixed(4)),
      source: 'beat-this-consensus',
    };
    merged.phrases = (beatThis.downbeats || []).filter((_, index) => index % 4 === 0);
  }
  merged.beatThis = {
    bpm: btBpm,
    bpmConfidence: btConf,
    beatCount: beatThis.beatCount,
    downbeatCount: beatThis.downbeatCount,
    latencyMs: beatThis.latencyMs,
    modelVersion: beatThis.modelVersion,
    interval: round(beatInterval, 4),
    stability: round(stats.stability, 3),
    phaseError: phase == null ? null : round(phase, 4),
    appliedToGrid: gridFromBeatThis,
    source: 'beat-this-small0-onnx',
  };
  merged.provenance = {
    ...(merged.provenance || {}),
    beatThis: { bpm: bpmSource, grid: gridFromBeatThis ? 'beat-this' : 'preserved-neural', phaseError: phase == null ? null : round(phase, 4) },
  };
  merged.warnings = [...(merged.warnings || [])];
  if (delta >= 0.05) merged.warnings.push(`BPM sources disagree: Neural ${neuralBpm}, Beat This ${btBpm}; confidence lowered.`);
  if (phase != null && phase > 0.08) merged.warnings.push(`Beat phase error ${phase.toFixed(3)}s; grid not replaced blindly.`);
  return merged;
}

export function beatThisSummary(analysis) {
  const bt = analysis?.beatThis;
  if (!bt) return null;
  return { ...bt };
}
