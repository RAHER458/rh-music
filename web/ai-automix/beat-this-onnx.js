/* Beat This! small0 — real ONNX Runtime Web (WASM) integration.
   Model: nilsbc/beat-this-onnx beat_this_small0.onnx + logmel.onnx
   SHA-256:
     beat_this_small0.onnx 53fda6e96afae7f44d898fa5f020272eda967a92839306bf7a3d0898fb8a0d9a
     logmel.onnx           f5afa499f5a42b05ea89a214561170cd4b76f92d67d3227f7c9833e8d79bbb43
   Runtime: onnxruntime-web 1.22.0, WASM CPU, single-threaded for iOS Safari. */

const MODEL_VERSION = 'beat-this-small0-onnx-1.0.0';
const MODEL_BASE = new URL('models/', import.meta.url);
const ORT_BASE = new URL('ort/', import.meta.url);
const CACHE_NAME = 'rh-beat-this-models-v1';
const MAX_FRAMES = 1500;
const FRAME_RATE = 50;

let ortPromise = null;
let logmelSession = null;
let beatSession = null;

function memoryCache() {
  if (!globalThis.__rhBeatThisCache) globalThis.__rhBeatThisCache = new Map();
  return globalThis.__rhBeatThisCache;
}

async function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(new URL('ort.wasm.min.js', ORT_BASE).href);
      const env = ort.env || ort.default?.env;
      if (env) {
        env.wasm.wasmPaths = ORT_BASE.href;
        env.wasm.numThreads = 1;
        env.wasm.simd = true;
        env.logLevel = 'error';
      }
      return ort;
    })();
  }
  return ortPromise;
}

async function fetchModelBuffer(url) {
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('model fetch ' + response.status + ' ' + url);
  if (cache) await cache.put(url, response.clone());
  return response.arrayBuffer();
}

async function createSession(ort, url) {
  const buffer = await fetchModelBuffer(url);
  return ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

async function ensureModels() {
  const ort = await loadOrt();
  if (!logmelSession) logmelSession = await createSession(ort, new URL('logmel.onnx', MODEL_BASE).href);
  if (!beatSession) beatSession = await createSession(ort, new URL('beat_this_small0.onnx', MODEL_BASE).href);
  return ort;
}

function inputShape(metadata, defaultShape) {
  const dims = metadata?.dims;
  if (!dims || !dims.length) return defaultShape;
  const dynamic = dims.map((dim) => (typeof dim === 'number' && dim > 0 ? dim : null));
  return dynamic;
}

function audioTensor(ort, samples, metadata) {
  const dims = metadata?.dims || [];
  const shape = dims.length >= 3 ? [1, 1, samples.length] : dims.length === 2 ? [1, samples.length] : [samples.length];
  return new ort.Tensor('float32', samples, shape);
}

function toProbability(value) {
  if (value >= 0 && value <= 1) return value;
  return 1 / (1 + Math.exp(-value));
}

function flattenOutput(tensor) {
  const data = tensor.data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = toProbability(Number(data[i]));
  return out;
}

function pickPeaks(probabilities, { threshold = 0.5, minGapFrames = 8 } = {}) {
  const peaks = [];
  for (let i = 1; i < probabilities.length - 1; i += 1) {
    const value = probabilities[i];
    if (value < threshold) continue;
    if (value < probabilities[i - 1] || value < probabilities[i + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last != null && i - last < minGapFrames) {
      if (value > probabilities[last]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function logmelToModelLayout(array, shape, timeLength) {
  // logmel output is expected as [1,128,T] or [1,T,128]; normalise to [1,128,T].
  const dims = shape || [];
  const total = array.length;
  if (dims.length === 3) {
    const [, d1, d2] = dims;
    if (d1 === 128) return { data: array, channels: 128, frames: Math.min(d2, timeLength) };
    if (d2 === 128) {
      const frames = d1;
      const out = new Float32Array(total);
      for (let t = 0; t < frames; t += 1) for (let c = 0; c < 128; c += 1) out[c * frames + t] = array[t * 128 + c];
      return { data: out, channels: 128, frames };
    }
  }
  const frames = Math.max(1, Math.floor(total / 128));
  return { data: array, channels: 128, frames: Math.min(frames, timeLength) };
}

async function runLogmel(ort, samples) {
  const inputName = logmelSession.inputNames[0];
  const meta = logmelSession.inputMetadata?.[inputName];
  const tensor = audioTensor(ort, samples, meta);
  const results = await logmelSession.run({ [inputName]: tensor });
  const outputName = logmelSession.outputNames[0];
  const output = results[outputName];
  const layout = logmelToModelLayout(output.data, output.dims, 999999);
  return { data: layout.data, channels: layout.channels, frames: layout.frames, dims: output.dims };
}

async function runBeatWindow(ort, melData, channels, frames) {
  const inputName = beatSession.inputNames[0];
  const meta = beatSession.inputMetadata?.[inputName];
  const targetFrames = MAX_FRAMES;
  const buffer = new Float32Array(channels * targetFrames);
  const copyFrames = Math.min(frames, targetFrames);
  for (let c = 0; c < channels; c += 1) {
    for (let t = 0; t < copyFrames; t += 1) buffer[c * targetFrames + t] = melData[c * frames + t] || 0;
  }
  const dims = meta?.dims || [1, channels, targetFrames];
  const shape = dims.length === 3 ? [1, dims[1] && dims[1] > 0 ? dims[1] : channels, targetFrames] : [1, channels, targetFrames];
  const tensor = new ort.Tensor('float32', buffer, shape);
  const results = await beatSession.run({ [inputName]: tensor });
  const beatName = beatSession.outputNames.find((name) => /beat/i.test(name) && !/down/i.test(name)) || beatSession.outputNames[0];
  const downName = beatSession.outputNames.find((name) => /down/i.test(name)) || beatSession.outputNames[1] || beatName;
  return {
    beat: flattenOutput(results[beatName]),
    downbeat: flattenOutput(results[downName]),
    outputs: beatSession.outputNames,
  };
}

export async function analyzeBeatThis(buffer, options = {}) {
  const started = Date.now();
  const cacheKey = `${options.trackId || 'unknown'}::${MODEL_VERSION}`;
  const cached = memoryCache().get(cacheKey);
  if (cached) return { ...cached, cached: true };
  const ort = await ensureModels();
  // Mono 22050 Hz input for logmel.onnx.
  const sampleRate = buffer.sampleRate;
  const targetRate = 22050;
  const channels = Math.min(2, buffer.numberOfChannels || 1);
  const ratio = sampleRate / targetRate;
  const length = Math.max(1, Math.floor(buffer.length / ratio));
  const samples = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      const source = i * ratio;
      const i0 = Math.floor(source);
      const i1 = Math.min(data.length - 1, i0 + 1);
      const frac = source - i0;
      samples[i] += (data[i0] * (1 - frac) + data[i1] * frac) / channels;
    }
  }
  const logmel = await runLogmel(ort, samples);
  const beatFrames = [];
  const downFrames = [];
  const hop = Math.floor(MAX_FRAMES / 2);
  for (let start = 0; start < logmel.frames; start += hop) {
    const count = Math.min(MAX_FRAMES, logmel.frames - start);
    const windowData = new Float32Array(logmel.channels * count);
    for (let c = 0; c < logmel.channels; c += 1) {
      for (let t = 0; t < count; t += 1) windowData[c * count + t] = logmel.data[c * logmel.frames + start + t] || 0;
    }
    const result = await runBeatWindow(ort, windowData, logmel.channels, count);
    const beatPeaks = pickPeaks(result.beat, { threshold: 0.5, minGapFrames: 8 });
    const downPeaks = pickPeaks(result.downbeat, { threshold: 0.5, minGapFrames: 16 });
    for (const frame of beatPeaks) beatFrames.push(start + frame);
    for (const frame of downPeaks) downFrames.push(start + frame);
  }
  const unique = (frames) => {
    const sorted = [...new Set(frames)].sort((a, b) => a - b);
    const out = [];
    for (const frame of sorted) {
      if (!out.length || frame - out[out.length - 1] >= 4) out.push(frame);
    }
    return out;
  };
  const beats = unique(beatFrames).map((frame) => Number((frame / FRAME_RATE).toFixed(4)));
  const downbeats = unique(downFrames).map((frame) => Number((frame / FRAME_RATE).toFixed(4)));
  const intervals = beats.slice(1).map((time, index) => time - beats[index]).filter((value) => value > 0.2 && value < 2);
  const beatInterval = median(intervals);
  const bpm = beatInterval ? 60 / beatInterval : null;
  const spread = intervals.length > 1 ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - beatInterval) ** 2, 0) / intervals.length) : 0;
  const confidence = bpm ? Math.max(0.1, Math.min(0.99, 1 - spread / Math.max(0.001, beatInterval))) : 0;
  const result = {
    source: 'beat-this-small0-onnx',
    modelVersion: MODEL_VERSION,
    mode: 'wasm-cpu',
    bpm: bpm ? Number(bpm.toFixed(2)) : null,
    bpmConfidence: Number(confidence.toFixed(3)),
    beatInterval: Number(beatInterval.toFixed(4)),
    beats,
    downbeats,
    beatCount: beats.length,
    downbeatCount: downbeats.length,
    logmelFrames: logmel.frames,
    latencyMs: Date.now() - started,
    outputs: beatSession.outputNames,
    inputNames: { logmel: logmelSession.inputNames, beat: beatSession.inputNames },
    cached: false,
  };
  memoryCache().set(cacheKey, result);
  try { localStorage.setItem('rh_beat_this_' + cacheKey, JSON.stringify({ beats, downbeats, bpm, bpmConfidence, modelVersion: MODEL_VERSION, at: Date.now() })); } catch {}
  return result;
}

export async function beatThisAvailable() {
  try { await ensureModels(); return true; } catch { return false; }
}

export function beatThisModelInfo() {
  return { MODEL_VERSION, MAX_FRAMES, FRAME_RATE, source: 'nilsbc/beat-this-onnx' };
}
