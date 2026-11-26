/* Beat intelligence validation runner.
   Runs Neural AI, PulseGrid and Beat This independently on real audio and
   computes metrics. It never fabricates values: missing reference data produces
   an explicit status. */

import { analyzeAudioBuffer } from './automix-engine.js';
import { analyzeWithPulseGrid, mergePulseGridAnalysis } from './pulsegrid-bridge.js';
import { analyzeBeatThisInWorker } from './beat-this-onnx.js';
import {
  downbeatMetrics, matchEvents, phaseMetrics, stabilityMetrics, summarizeSource, tempoMetrics,
} from './validation-metrics.js';

export const VALIDATION_VERSION = 'beat-intelligence-validation-1.0.0';
const STORAGE_KEY = 'rh_beat_validation_v1';

function adapter(buffer) {
  return {
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    duration: buffer.duration,
    getChannelData: (channel) => buffer.getChannelData(channel),
  };
}

function copySeconds(buffer, seconds) {
  const sampleRate = buffer.sampleRate;
  const length = Math.min(buffer.length, Math.max(1, Math.floor(seconds * sampleRate)));
  const ctx = new OfflineAudioContext(Math.min(2, buffer.numberOfChannels || 1), length, sampleRate);
  const out = ctx.createBuffer(Math.min(2, buffer.numberOfChannels || 1), length, sampleRate);
  for (let c = 0; c < out.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    out.copyToChannel(src.subarray(0, length), c);
  }
  return out;
}

function deriveGridBeats(analysis) {
  if (analysis?.grid?.beats?.length) return analysis.grid.beats;
  const bpm = analysis?.bpm;
  const offset = analysis?.grid?.gridOffset ?? 0;
  if (!bpm || !analysis?.duration) return [];
  const interval = 60 / bpm;
  const beats = [];
  for (let time = offset; time <= analysis.duration; time += interval) beats.push(Number(time.toFixed(4)));
  return beats;
}

export async function analyzeTrack(id, options = {}) {
  const seconds = options.seconds || 60;
  const started = performance.now();
  const response = await fetch('/api/stream/' + encodeURIComponent(id));
  if (!response.ok) throw new Error('stream HTTP ' + response.status);
  const bytes = await response.arrayBuffer();
  const decodeCtx = new OfflineAudioContext(2, 44100, 44100);
  const full = await decodeCtx.decodeAudioData(bytes.slice(0));
  const buffer = copySeconds(full, seconds);
  const results = { id, seconds: buffer.duration, sources: {}, metrics: {}, failures: [] };
  // Neural
  try {
    const t0 = performance.now();
    const neural = analyzeAudioBuffer(adapter(buffer), { id: String(id) });
    results.sources.neural = summarizeSource('neural', neural, { latencyMs: performance.now() - t0 });
    results.raw = results.raw || {};
    results.raw.neural = neural;
  } catch (error) {
    results.failures.push({ source: 'neural', error: String(error?.message || error) });
  }
  // PulseGrid
  try {
    const t0 = performance.now();
    const pulse = await analyzeWithPulseGrid(buffer);
    const neural = results.raw?.neural;
    const merged = neural && pulse ? mergePulseGridAnalysis(neural, pulse) : neural;
    results.sources.pulsegrid = summarizeSource('pulsegrid', pulse, { latencyMs: performance.now() - t0 });
    results.raw = results.raw || {};
    results.raw.pulsegrid = pulse;
    results.raw.mergedPulse = merged;
  } catch (error) {
    results.failures.push({ source: 'pulsegrid', error: String(error?.message || error) });
  }
  // Beat This
  try {
    const t0 = performance.now();
    const beat = await analyzeBeatThisInWorker(buffer, { trackId: String(id) });
    results.sources.beatThis = summarizeSource('beat-this', beat, { latencyMs: performance.now() - t0 });
    results.raw = results.raw || {};
    results.raw.beatThis = beat;
  } catch (error) {
    results.failures.push({ source: 'beat-this', error: String(error?.message || error) });
  }
  // Cross-source metrics (exploratory without independent reference)
  const neuralBeats = deriveGridBeats(results.raw?.neural);
  const beatBeats = results.raw?.beatThis?.beats || [];
  const pulse = results.raw?.pulsegrid;
  const pulseBeats = pulse && pulse.bpm
    ? Array.from({ length: Math.max(0, Math.floor((pulse.duration || buffer.duration) / (60 / pulse.bpm))) }, (_, index) => Number(((pulse.gridOffset || 0) + index * (60 / pulse.bpm)).toFixed(4)))
    : [];
  if (neuralBeats.length && beatBeats.length) results.metrics.beatThisVsNeural = matchEvents(neuralBeats, beatBeats, 0.07);
  if (pulseBeats.length && beatBeats.length) results.metrics.beatThisVsPulseGrid = matchEvents(pulseBeats, beatBeats, 0.07);
  if (neuralBeats.length && pulseBeats.length) results.metrics.pulseGridVsNeural = matchEvents(neuralBeats, pulseBeats, 0.07);
  if (results.raw?.neural?.grid?.downbeats?.length && results.raw?.beatThis?.downbeats?.length) {
    results.metrics.downbeatVsNeural = downbeatMetrics(results.raw.neural.grid.downbeats, results.raw.beatThis.downbeats, 0.07);
  }
  if (beatBeats.length) results.metrics.beatThisStability = stabilityMetrics(beatBeats);
  if (neuralBeats.length) results.metrics.neuralStability = stabilityMetrics(neuralBeats);
  if (results.raw?.beatThis?.beats?.length && results.raw?.neural?.bpm) {
    results.metrics.phase = phaseMetrics(beatBeats, neuralBeats, results.raw.neural.bpm);
  }
  results.totals = {
    bpm: {
      neural: results.raw?.neural?.bpm ?? null,
      pulsegrid: results.raw?.pulsegrid?.bpm ?? null,
      beatThis: results.raw?.beatThis?.bpm ?? null,
    },
    tempo: {
      beatThisVsNeural: tempoMetrics(results.raw?.neural?.bpm, results.raw?.beatThis?.bpm),
      pulseVsNeural: tempoMetrics(results.raw?.neural?.bpm, results.raw?.pulsegrid?.bpm),
      beatThisVsPulse: tempoMetrics(results.raw?.pulsegrid?.bpm, results.raw?.beatThis?.bpm),
    },
    latencyMs: performance.now() - started,
  };
  return results;
}

export async function runValidation(options = {}) {
  const ids = options.ids || [];
  const results = [];
  for (let i = 0; i < ids.length; i += 1) {
    try {
      const result = await analyzeTrack(ids[i], options);
      results.push(result);
    } catch (error) {
      results.push({ id: ids[i], failures: [{ source: 'pipeline', error: String(error?.message || error) }] });
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VALIDATION_VERSION, at: Date.now(), results })); } catch {}
  }
  return { version: VALIDATION_VERSION, at: Date.now(), results };
}

export function loadStoredValidation() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}
