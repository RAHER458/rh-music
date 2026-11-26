/* PulseGrid ↔ RH-AI-DJ-ENGINE bridge.
   Runs the existing PulseGrid analysis worker and merges its rhythm/key/energy
   result into the Neural AI analysis. No duplicated analyzer is introduced:
   PulseGrid remains the source of its own values, Neural AI remains the
   planner/executor, and both sets of cues are offered to the planner. */

const WORKER_URL = '/ai-mix-beta/pulsegrid-analysis-worker.js';
let worker = null;
let seq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(WORKER_URL);
    worker.onmessage = (event) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      if (event.data.phase === 'error') {
        pending.delete(event.data.id);
        job.reject(new Error(event.data.error || 'PulseGrid worker error'));
        return;
      }
      if (event.data.phase === 'complete') {
        pending.delete(event.data.id);
        job.resolve(event.data.result);
      }
    };
    worker.onerror = (event) => {
      for (const [id, job] of pending) {
        pending.delete(id);
        job.reject(new Error(event.message || 'PulseGrid worker error'));
      }
    };
  } catch {
    worker = null;
  }
  return worker;
}

function monoCopy(buffer) {
  const length = Math.min(buffer.length, Math.floor(buffer.sampleRate * 600));
  const out = new Float32Array(length);
  const channels = Math.min(2, buffer.numberOfChannels || 1);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

export function analyzeWithPulseGrid(buffer) {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const samples = monoCopy(buffer);
  const id = `pg-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, samples, sampleRate: buffer.sampleRate, duration: buffer.duration, peakCount: 1400 }, [samples.buffer]);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function energyAt(result, time) {
  const peaks = result?.peaks;
  if (!peaks || !peaks.length || !result.duration) return null;
  const index = Math.max(0, Math.min(peaks.length - 1, Math.round((time / result.duration) * (peaks.length - 1))));
  return Number(peaks[index]) || 0;
}

function localMean(result, time, radiusSec = 6) {
  const peaks = result?.peaks;
  if (!peaks || !peaks.length || !result.duration) return null;
  const half = Math.max(1, Math.round((radiusSec / result.duration) * peaks.length));
  const center = Math.max(0, Math.min(peaks.length - 1, Math.round((time / result.duration) * (peaks.length - 1))));
  let sum = 0; let count = 0;
  for (let i = Math.max(0, center - half); i <= Math.min(peaks.length - 1, center + half); i += 1) { sum += peaks[i]; count += 1; }
  return count ? sum / count : null;
}

function buildPulseGridCues(result, bpm) {
  const duration = Number(result?.duration) || 0;
  const beat = 60 / Math.max(60, Number(bpm) || 120);
  const bar = beat * 4;
  const candidates = [];
  const peaks = result?.peaks || [];
  if (!duration || !peaks.length) return { mixOut: null, mixIn: null, candidates: [] };
  // Musically useful exit: a local energy fall after a sustained high-energy region,
  // searched in the middle 25–92% of the track instead of only the outro.
  for (let time = duration * 0.25; time <= duration * 0.92; time += bar) {
    const before = localMean(result, time - bar * 2, bar * 2);
    const after = localMean(result, time, bar * 2);
    if (before == null || after == null) continue;
    const drop = before - after;
    if (before > 0.5 && drop > 0.08) candidates.push({ at: time, kind: 'energy-fall', weight: Math.min(0.3, drop) });
  }
  // Entry B: first sustained rise after the intro.
  let mixIn = null;
  for (let time = duration * 0.08; time <= duration * 0.55; time += bar) {
    const before = localMean(result, time - bar * 2, bar * 2);
    const after = localMean(result, time, bar * 2);
    if (before == null || after == null) continue;
    if (after > 0.52 && after - before > 0.06) { mixIn = time; break; }
  }
  const late = candidates.filter((candidate) => candidate.at >= duration * 0.45);
  const mixOut = late.length ? late[Math.min(late.length - 1, Math.max(0, Math.round(late.length * 0.55)))].at : null;
  return { mixOut, mixIn, candidates: candidates.map((candidate) => ({ at: Number(candidate.at.toFixed(2)), kind: candidate.kind, weight: Number(candidate.weight.toFixed(3)) })) };
}

function mergePick(neural, pulse) {
  const neuralConf = Number(neural?.bpmConfidence) || 0;
  const pulseConf = Number(pulse?.bpmConfidence) || 0;
  const neuralBpm = Number(neural?.bpm) || 0;
  const pulseBpm = Number(pulse?.bpm) || 0;
  if (!pulseBpm) return { bpm: neuralBpm, source: 'neural', confidence: neuralConf };
  if (!neuralBpm) return { bpm: pulseBpm, source: 'pulsegrid', confidence: pulseConf };
  const diff = Math.abs(pulseBpm - neuralBpm) / Math.max(1, neuralBpm);
  if (diff < 0.02) return { bpm: (neuralBpm + pulseBpm) / 2, source: 'consensus', confidence: Math.max(neuralConf, pulseConf) };
  if (pulseConf > neuralConf + 0.12) return { bpm: pulseBpm, source: 'pulsegrid', confidence: pulseConf };
  return { bpm: neuralBpm, source: 'neural', confidence: neuralConf };
}

export function mergePulseGridAnalysis(neural, pulse) {
  if (!neural || !pulse) return neural;
  const bpmPick = mergePick(neural, pulse);
  const cues = buildPulseGridCues(pulse, bpmPick.bpm);
  const neuralKeyConf = Number(neural.keyConfidence) || 0;
  const pulseKeyConf = Number(pulse.keyConfidence) || 0;
  const usePulseKey = !!pulse.camelot && (pulseKeyConf > neuralKeyConf + 0.08 || neuralKeyConf < 0.1);
  const merged = { ...neural };
  merged.bpm = Number(bpmPick.bpm.toFixed(2)) || neural.bpm;
  merged.bpmConfidence = Number(Math.max(neural.bpmConfidence || 0, bpmPick.confidence || 0).toFixed(3));
  if (usePulseKey) {
    merged.key = pulse.key || merged.key;
    merged.camelot = pulse.camelot || merged.camelot;
    merged.keyConfidence = Number(Math.max(neuralKeyConf, pulseKeyConf).toFixed(3));
  }
  merged.pulsegrid = {
    bpm: pulse.bpm,
    bpmConfidence: pulse.bpmConfidence,
    gridOffset: pulse.gridOffset,
    key: pulse.key,
    camelot: pulse.camelot,
    keyConfidence: pulse.keyConfidence,
    energy: pulse.energy,
    mixOut: cues.mixOut,
    mixIn: cues.mixIn,
    candidates: cues.candidates,
    peaks: pulse.peaks,
    source: 'pulsegrid',
  };
  merged.provenance = {
    ...(neural.provenance || {}),
    pulsegrid: { bpm: bpmPick.source, key: usePulseKey ? 'pulsegrid' : 'neural' },
  };
  merged.warnings = [...(neural.warnings || [])];
  if (bpmPick.source === 'pulsegrid') merged.warnings.push('BPM взят из PulseGrid: Neural AI confidence ниже.');
  if (usePulseKey && neuralKeyConf < 0.1) merged.warnings.push('Тональность/Camelot подтверждены PulseGrid.');
  return merged;
}

export function pulseGridTransitionCandidates(analysis) {
  const pg = analysis?.pulsegrid;
  const out = [];
  if (pg?.mixOut != null) out.push(pg.mixOut);
  for (const candidate of pg?.candidates || []) if (candidate.kind === 'energy-fall') out.push(candidate.at);
  return [...new Set(out.filter((value) => Number.isFinite(value)))];
}
