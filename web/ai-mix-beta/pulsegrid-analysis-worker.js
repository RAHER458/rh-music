const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

self.onmessage = (event) => {
  const { id, samples, sampleRate, duration, peakCount = 1400 } = event.data;

  try {
    self.postMessage({ id, phase: "waveform" });
    const peaks = buildPeaks(samples, peakCount);
    self.postMessage({ id, phase: "rhythm" });
    const rhythm = detectRhythm(samples, sampleRate);
    self.postMessage({ id, phase: "key" });
    const key = detectKey(samples, sampleRate);
    const energy = detectEnergy(samples, sampleRate);

    self.postMessage(
      {
        id,
        phase: "complete",
        result: {
          duration,
          peaks,
          bpm: rhythm.bpm,
          gridOffset: rhythm.gridOffset,
          bpmConfidence: rhythm.confidence,
          key: key.label,
          camelot: key.camelot,
          keyRoot: key.root,
          keyMode: key.mode,
          keyConfidence: key.confidence,
          energy,
        },
      },
      [peaks.buffer],
    );
  } catch (error) {
    self.postMessage({ id, phase: "error", error: error?.message || String(error) });
  }
};

function buildPeaks(samples, count) {
  const peaks = new Float32Array(count);
  const bucket = Math.max(1, Math.floor(samples.length / count));
  let smoothed = 0;

  for (let i = 0; i < count; i += 1) {
    const start = i * bucket;
    const end = Math.min(samples.length, start + bucket);
    let max = 0;
    let sum = 0;
    let scanned = 0;
    const step = Math.max(1, Math.floor((end - start) / 96));

    for (let j = start; j < end; j += step) {
      const value = Math.abs(samples[j] || 0);
      max = Math.max(max, value);
      sum += value * value;
      scanned += 1;
    }

    const rms = Math.sqrt(sum / Math.max(1, scanned));
    const value = Math.min(1, max * 0.62 + rms * 1.28);
    smoothed = smoothed * 0.26 + value * 0.74;
    peaks[i] = Math.max(0.025, smoothed);
  }

  return peaks;
}

function detectRhythm(samples, sampleRate) {
  const analysisStart = Math.min(samples.length - 1, Math.floor(sampleRate * 4));
  const analysisEnd = Math.min(samples.length, analysisStart + Math.floor(sampleRate * 150));
  const targetRate = 200;
  const blockSize = Math.max(64, Math.round(sampleRate / targetRate));
  const envelopeLength = Math.max(1, Math.floor((analysisEnd - analysisStart) / blockSize));
  const envelope = new Float32Array(envelopeLength);

  for (let i = 0; i < envelopeLength; i += 1) {
    const start = analysisStart + i * blockSize;
    const end = Math.min(analysisEnd, start + blockSize);
    let sum = 0;
    for (let j = start; j < end; j += 1) {
      const sample = samples[j] || 0;
      sum += sample * sample;
    }
    envelope[i] = Math.sqrt(sum / Math.max(1, end - start));
  }

  const onset = new Float32Array(envelopeLength);
  let onsetMax = 0;
  for (let i = 4; i < envelopeLength; i += 1) {
    const baseline = (envelope[i - 1] + envelope[i - 2] + envelope[i - 3] + envelope[i - 4]) * 0.25;
    const value = Math.max(0, envelope[i] - baseline * 1.02);
    onset[i] = value;
    onsetMax = Math.max(onsetMax, value);
  }

  if (onsetMax > 0) {
    for (let i = 0; i < onset.length; i += 1) onset[i] /= onsetMax;
  }

  const envelopeRate = sampleRate / blockSize;
  const minLag = Math.floor((60 * envelopeRate) / 190);
  const maxLag = Math.ceil((60 * envelopeRate) / 58);
  let bestLag = Math.round((60 * envelopeRate) / 128);
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    let weight = 0;
    for (let i = lag; i < onset.length; i += 1) {
      const a = onset[i];
      const b = onset[i - lag];
      if (a > 0.025 || b > 0.025) {
        score += a * b;
        weight += Math.max(a, b);
      }
    }
    score /= Math.max(1, Math.sqrt(weight));

    const bpm = (60 * envelopeRate) / lag;
    if (bpm >= 68 && bpm <= 174) score *= 1.035;
    if (bpm >= 118 && bpm <= 155) score *= 1.02;

    scoreSum += Math.max(0, score);
    scoreCount += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let bpm = (60 * envelopeRate) / bestLag;
  if (bpm < 88 && bpm * 2 <= 190) bpm *= 2;
  if (bpm > 178 && bpm / 2 >= 72) bpm /= 2;
  bpm = Math.round(bpm * 10) / 10;

  const beatDuration = 60 / Math.max(1, bpm);
  const searchStart = Math.floor(envelopeRate * 0.35);
  const searchEnd = Math.min(onset.length, Math.floor(envelopeRate * Math.min(28, beatDuration * 48)));
  let anchorIndex = searchStart;
  let anchorScore = -Infinity;

  for (let i = searchStart; i < searchEnd; i += 1) {
    const local = onset[i];
    const periodic = onset[Math.min(onset.length - 1, i + bestLag)] || 0;
    const twoBeat = onset[Math.min(onset.length - 1, i + bestLag * 2)] || 0;
    const score = local * 1.7 + periodic * 0.8 + twoBeat * 0.45 - i * 0.00003;
    if (score > anchorScore) {
      anchorScore = score;
      anchorIndex = i;
    }
  }

  const gridOffset = analysisStart / sampleRate + anchorIndex / envelopeRate;
  const meanScore = scoreSum / Math.max(1, scoreCount);
  const confidence = clamp(bestScore / Math.max(0.001, meanScore * 4.4), 0.12, 0.99);

  return { bpm, gridOffset, confidence: Math.round(confidence * 100) / 100 };
}

function detectKey(samples, sampleRate) {
  const chroma = new Float64Array(12);
  const windowSize = 4096;
  const available = Math.max(0, samples.length - windowSize);
  const start = Math.min(available, Math.floor(sampleRate * 8));
  const end = Math.min(available, Math.floor(sampleRate * 120));
  const windows = 18;
  const step = Math.max(windowSize, Math.floor((end - start) / Math.max(1, windows - 1)));
  let usedWindows = 0;

  for (let offset = start; offset <= end && usedWindows < windows; offset += step) {
    const rms = windowRms(samples, offset, windowSize);
    if (rms < 0.006) continue;

    for (let midi = 36; midi <= 83; midi += 1) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const power = goertzelPower(samples, offset, windowSize, sampleRate, frequency);
      const octaveWeight = midi < 48 ? 0.72 : midi > 72 ? 0.76 : 1;
      chroma[midi % 12] += Math.log1p(power * 1600) * octaveWeight;
    }
    usedWindows += 1;
  }

  const chromaSum = chroma.reduce((sum, value) => sum + value, 0);
  if (!chromaSum) {
    return { label: "UNKNOWN", camelot: "—", root: 0, mode: "major", confidence: 0 };
  }

  for (let i = 0; i < chroma.length; i += 1) chroma[i] /= chromaSum;

  let best = { score: -Infinity, root: 0, mode: "major" };
  let secondScore = -Infinity;

  for (let root = 0; root < 12; root += 1) {
    const majorScore = profileScore(chroma, MAJOR_PROFILE, root);
    const minorScore = profileScore(chroma, MINOR_PROFILE, root);

    for (const candidate of [
      { score: majorScore, root, mode: "major" },
      { score: minorScore, root, mode: "minor" },
    ]) {
      if (candidate.score > best.score) {
        secondScore = best.score;
        best = candidate;
      } else if (candidate.score > secondScore) {
        secondScore = candidate.score;
      }
    }
  }

  const label = `${NOTE_NAMES[best.root]} ${best.mode === "major" ? "MAJ" : "MIN"}`;
  const camelot = best.mode === "major" ? CAMELOT_MAJOR[best.root] : CAMELOT_MINOR[best.root];
  const confidence = clamp(0.35 + (best.score - secondScore) * 5.5, 0.18, 0.96);

  return {
    label,
    camelot,
    root: best.root,
    mode: best.mode,
    confidence: Math.round(confidence * 100) / 100,
  };
}

function windowRms(samples, offset, length) {
  let sum = 0;
  const stride = 4;
  let count = 0;
  for (let i = 0; i < length; i += stride) {
    const value = samples[offset + i] || 0;
    sum += value * value;
    count += 1;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function goertzelPower(samples, offset, length, sampleRate, frequency) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < length; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    s0 = (samples[offset + i] || 0) * window + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  return Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (length * length);
}

function profileScore(chroma, profile, root) {
  let profileSum = 0;
  for (const value of profile) profileSum += value;

  let dot = 0;
  for (let i = 0; i < 12; i += 1) {
    dot += chroma[(i + root) % 12] * (profile[i] / profileSum);
  }
  return dot;
}

function detectEnergy(samples, sampleRate) {
  const stride = Math.max(1, Math.floor(sampleRate / 4000));
  let sum = 0;
  let peak = 0;
  let count = 0;

  for (let i = 0; i < samples.length; i += stride) {
    const value = Math.abs(samples[i] || 0);
    sum += value * value;
    peak = Math.max(peak, value);
    count += 1;
  }

  const rms = Math.sqrt(sum / Math.max(1, count));
  const normalized = clamp((rms * 5.2 + peak * 0.32) * 5, 1, 10);
  return Math.round(normalized * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
