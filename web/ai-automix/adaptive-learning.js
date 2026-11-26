/* RH-AI-DJ-ENGINE · Adaptive Learning Engine.
   A real, conservative online learner over transition outcomes.

   Algorithm: contextual bandit + similarity-weighted ranking + progress-bucket
   statistics. It does not train a neural network and does not claim to. It
   keeps per-strategy and per-context statistics, scores executed transitions
   from objective audio/plan data plus optional user feedback, and exposes a
   bounded advisory used by the existing Transition Planner. */

const VERSION = 'adaptive-1.0.0';
const STORAGE_KEY = 'rh_ai_dj_learning_v1';
const MIN_OBSERVATIONS = 3;
const SHRINK = 3;
const MAX_HISTORY = 400;
const MAX_ROLLBACK = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

function safeParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function progressBin(progress) {
  if (progress == null || !Number.isFinite(progress)) return 'unknown';
  const p = clamp(progress, 0, 1);
  if (p < 0.25) return 'lt25';
  if (p < 0.4) return '25-40';
  if (p < 0.6) return '40-60';
  if (p < 0.8) return '60-80';
  return 'gt80';
}

function bpmBand(a, b) {
  const ratio = !a || !b ? 1 : b / a;
  const delta = Math.abs(Math.log2(ratio));
  if (delta < 0.03) return 'tight';
  if (delta < 0.08) return 'close';
  return 'wide';
}

function camelotRelation(a, b) {
  const parse = (value) => {
    const m = /^(\d{1,2})([AB])$/.exec(String(value || '').trim().toUpperCase());
    return m ? { n: Number(m[1]), mode: m[2] } : null;
  };
  const ka = parse(a); const kb = parse(b);
  if (!ka || !kb) return 'unknown';
  const diff = Math.abs(ka.n - kb.n);
  const wheel = Math.min(diff, 12 - diff);
  if (ka.n === kb.n && ka.mode === kb.mode) return 'same';
  if (ka.n === kb.n) return 'relative';
  if (wheel === 1) return ka.mode === kb.mode ? 'adjacent' : 'parallel';
  if (wheel === 2) return 'near';
  return 'clash';
}

function contextKey(features) {
  return [
    features.bpmBand, features.camelot, features.energyBand,
    features.vocalBand, features.outSection, features.inSection,
  ].join('|');
}

function qualityFromOutcome(outcome) {
  const plan = outcome.plan || {};
  const metrics = outcome.metrics || {};
  const features = outcome.features || {};
  const progress = Number.isFinite(features.progress) ? features.progress : null;
  // Timing: phrase and structural fit dominate; progress only guards extremes.
  let timing = 0.5;
  if (progress != null) {
    if (progress < 0.25) timing -= 0.3;
    else if (progress > 0.88) timing -= 0.22;
    else if (progress >= 0.3 && progress <= 0.8) timing += 0.16;
  }
  if (outcome.phraseAligned) timing += 0.14;
  if (outcome.barAligned) timing += 0.06;
  if (features.outSection && features.inSection && features.outSection !== 'unknown' && features.inSection !== 'unknown') timing += 0.08;
  timing = clamp(timing, 0, 1);
  // Beatmatching
  let beat = 0.55;
  const rateDelta = Math.max(Math.abs(Number(plan.rateIn ?? 1) - 1), Math.abs(Number(plan.rateOut ?? 1) - 1));
  beat -= clamp(rateDelta * 4, 0, 0.3);
  if (features.bpmBand === 'tight') beat += 0.25;
  else if (features.bpmBand === 'close') beat += 0.12;
  else beat -= 0.12;
  if (metrics.clipping) beat -= 0.2;
  beat = clamp(beat, 0, 1);
  // Harmonic
  let harmonic = 0.5;
  if (features.camelot === 'same') harmonic = 1;
  else if (features.camelot === 'relative') harmonic = 0.92;
  else if (features.camelot === 'adjacent' || features.camelot === 'parallel') harmonic = 0.84;
  else if (features.camelot === 'near') harmonic = 0.7;
  else if (features.camelot === 'clash') harmonic = 0.28;
  const keyConf = clamp(Math.min(Number(features.keyConfA ?? 0), Number(features.keyConfB ?? 0)) * 1.15, 0, 1);
  harmonic *= 0.65 + keyConf * 0.35;
  // Energy
  const energyDelta = Number.isFinite(features.energyDelta) ? features.energyDelta : 0.25;
  const energy = clamp(1 - energyDelta * 1.35, 0, 1);
  // Audio
  const peak = Number(metrics.peak) || 0;
  let audio = 0.7;
  if (peak > 0.98) audio -= 0.3;
  else if (peak > 0.9) audio -= 0.15;
  if (metrics.clipping) audio -= 0.25;
  audio -= clamp(Number(features.vocalCollision) || 0, 0, 1) * 0.18;
  audio -= clamp(Number(features.bassConflict) || 0, 0, 1) * 0.12;
  audio = clamp(audio, 0, 1);
  const quality = clamp(timing * 0.34 + beat * 0.22 + harmonic * 0.16 + energy * 0.14 + audio * 0.14, 0, 1);
  return { quality: round(quality, 4), timing: round(timing, 4), beat: round(beat, 4), harmonic: round(harmonic, 4), energy: round(energy, 4), audio: round(audio, 4) };
}

function feedbackAdjustment(feedback) {
  const map = {
    excellent: 0.25, good: 0.1, normal: 0, bad: -0.3,
    early: -0.35, late: -0.25, sync: -0.3, wrong_music: -0.25,
  };
  return Object.prototype.hasOwnProperty.call(map, feedback) ? map[feedback] : 0;
}

export function createAdaptiveLearning(options = {}) {
  const storageKey = options.storageKey || STORAGE_KEY;
  const eventTarget = options.eventTarget || null;
  let state = safeParse((() => { try { return localStorage.getItem(storageKey); } catch { return null; } })(), {
    version: VERSION,
    modelVersion: 1,
    updatedAt: 0,
    history: [],
    strategy: {},
    contexts: {},
    timing: { early: 0, late: 0, good: 0, progressSum: 0, samples: 0 },
    feedback: { excellent: 0, good: 0, normal: 0, bad: 0, early: 0, late: 0, sync: 0, wrong_music: 0 },
    snapshots: [],
    rollbacks: 0,
  });

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* storage may be unavailable */ }
    if (eventTarget && typeof eventTarget.dispatchEvent === 'function') {
      try { eventTarget.dispatchEvent(new CustomEvent('rh-ai-learning', { detail: summary() })); } catch {}
    }
  }

  function featuresFor(analysisA, analysisB, plan, playback = {}) {
    const a = analysisA || {};
    const b = analysisB || {};
    const outSection = plan?.outSection ?? null;
    const inSection = plan?.inSection ?? null;
    const energyA = Number.isFinite(a.intensity) ? a.intensity : 0.5;
    const energyB = Number.isFinite(b.intensity) ? b.intensity : 0.5;
    const progress = playback.duration > 0 && Number.isFinite(plan?.startAt) ? plan.startAt / playback.duration : null;
    return {
      bpmBand: bpmBand(a.bpm, b.bpm),
      camelot: camelotRelation(a.camelot, b.camelot),
      keyConfA: a.keyConfidence ?? 0,
      keyConfB: b.keyConfidence ?? 0,
      energyBand: Math.abs(energyA - energyB) < 0.15 ? 'even' : Math.abs(energyA - energyB) < 0.3 ? 'moderate' : 'wide',
      energyDelta: Math.abs(energyA - energyB),
      vocalBand: Math.max(a.vocalRisk ?? 0, b.vocalRisk ?? 0) > 0.5 ? 'vocal' : 'instrumental',
      vocalCollision: Math.min(a.vocal?.regions?.length ? (a.vocalRisk ?? 0) : 0, b.vocal?.regions?.length ? (b.vocalRisk ?? 0) : 0),
      bassConflict: Math.min(a.bands?.low ?? 0.3, b.bands?.low ?? 0.3),
      outSection: outSection || 'unknown',
      inSection: inSection || 'unknown',
      progress,
      startAt: plan?.startAt ?? null,
      durationSec: plan?.durationSec ?? null,
      durationBeats: plan?.durationBeats ?? null,
      bpmA: a.bpm ?? null,
      bpmB: b.bpm ?? null,
      camelotA: a.camelot ?? null,
      camelotB: b.camelot ?? null,
      keyA: a.key ?? null,
      keyB: b.key ?? null,
      strategy: plan?.strategy ?? 'unknown',
    };
  }

  function observe(input) {
    if (!input || !input.plan) return null;
    const features = input.features || featuresFor(input.analysisA, input.analysisB, input.plan, input.playback || {});
    const metrics = input.metrics || {};
    const evaluation = qualityFromOutcome({ plan: input.plan, features, metrics });
    const userAdjustment = feedbackAdjustment(input.userFeedback || input.feedback);
    const adjusted = clamp(evaluation.quality + userAdjustment, 0, 1);
    const record = {
      id: input.id || `t-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      at: Date.now(),
      strategy: features.strategy,
      features,
      plan: {
        startAt: input.plan.startAt, durationSec: input.plan.durationSec,
        durationBeats: input.plan.durationBeats, rateIn: input.plan.rateIn,
        rateOut: input.plan.rateOut, bpmTarget: input.plan.bpmTarget,
      },
      metrics: { peak: metrics.peak ?? null, rms: metrics.rms ?? null, clipping: !!metrics.clipping },
      auto: evaluation,
      userFeedback: input.userFeedback || null,
      quality: round(adjusted, 4),
      success: adjusted >= 0.55,
    };
    state.history.push(record);
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    // global strategy bandit
    const arm = state.strategy[features.strategy] || { count: 0, sum: 0, mean: 0, early: 0, late: 0 };
    arm.count += 1; arm.sum += record.quality; arm.mean = arm.sum / arm.count;
    if (record.features.progress != null && record.features.progress < 0.25) arm.early += 1;
    if (record.features.progress != null && record.features.progress > 0.88) arm.late += 1;
    state.strategy[features.strategy] = arm;
    // context statistics
    const key = contextKey(features);
    const context = state.contexts[key] || { count: 0, sum: 0, mean: 0, strategies: {} };
    context.count += 1; context.sum += record.quality; context.mean = context.sum / context.count;
    const cArm = context.strategies[features.strategy] || { count: 0, mean: 0 };
    cArm.count += 1;
    cArm.mean = ((cArm.mean * (cArm.count - 1)) + record.quality) / cArm.count;
    context.strategies[features.strategy] = cArm;
    state.contexts[key] = context;
    // timing statistics
    if (features.progress != null) {
      state.timing.samples += 1;
      state.timing.progressSum += clamp(features.progress, 0, 1);
      if (features.progress < 0.25) state.timing.early += 1;
      else if (features.progress > 0.88) state.timing.late += 1;
      else state.timing.good += 1;
    }
    if (input.userFeedback && state.feedback[input.userFeedback] != null) state.feedback[input.userFeedback] += 1;
    // snapshots for rollback
    if (state.history.length % 5 === 0) {
      state.snapshots.push({ at: Date.now(), quality: round(mean(state.history.slice(-10).map((h) => h.quality)), 4), state: JSON.parse(JSON.stringify({ strategy: state.strategy, contexts: state.contexts, timing: state.timing })) });
      if (state.snapshots.length > MAX_ROLLBACK) state.snapshots.shift();
      // regression guard: last 5 vs previous 5
      const recent = state.history.slice(-5).map((h) => h.quality);
      const previous = state.history.slice(-10, -5).map((h) => h.quality);
      if (recent.length === 5 && previous.length === 5 && mean(recent) < mean(previous) - 0.18) {
        const snapshot = state.snapshots[state.snapshots.length - 1];
        if (snapshot) {
          state.strategy = snapshot.state.strategy;
          state.contexts = snapshot.state.contexts;
          state.timing = snapshot.state.timing;
          state.rollbacks += 1;
        }
      }
    }
    state.updatedAt = Date.now();
    persist();
    return record;
  }

  function feedback(idOrFeedback, feedbackType) {
    const id = feedbackType ? idOrFeedback : null;
    const type = feedbackType || idOrFeedback;
    if (state.feedback[type] != null) state.feedback[type] += 1;
    if (type === 'early') { state.timing.early += 1; state.timing.samples += 1; }
    if (type === 'late') { state.timing.late += 1; state.timing.samples += 1; }
    const record = id ? state.history.find((entry) => entry.id === id) : state.history[state.history.length - 1];
    if (record) {
      record.userFeedback = type;
      record.quality = round(clamp(record.auto.quality + feedbackAdjustment(type), 0, 1), 4);
      record.success = record.quality >= 0.55;
      const arm = state.strategy[record.strategy];
      if (arm && arm.count > 0) { arm.sum += record.quality - record.auto.quality; arm.mean = arm.sum / arm.count; }
      const key = contextKey(record.features);
      const context = state.contexts[key];
      if (context) {
        context.sum += record.quality - record.auto.quality;
        context.mean = context.sum / context.count;
      }
    }
    state.updatedAt = Date.now();
    persist();
    return record;
  }

  function advise(input = {}) {
    const a = input.analysisA || {};
    const b = input.analysisB || {};
    const features = featuresFor(a, b, input.plan, input.playback || {});
    const key = contextKey(features);
    const context = state.contexts[key] || null;
    const strategyScores = {};
    for (const [strategy, arm] of Object.entries(state.strategy)) {
      const prior = 0.55;
      const weight = arm.count / (arm.count + SHRINK);
      strategyScores[strategy] = round(prior * (1 - weight) + arm.mean * weight, 4);
    }
    if (context && context.count >= MIN_OBSERVATIONS) {
      for (const [strategy, cArm] of Object.entries(context.strategies)) {
        const base = strategyScores[strategy] ?? 0.55;
        const weight = cArm.count / (cArm.count + SHRINK);
        strategyScores[strategy] = round(base * (1 - weight * 0.5) + cArm.mean * weight * 0.5, 4);
      }
    }
    const earlyRate = state.timing.samples ? state.timing.early / state.timing.samples : 0;
    const lateRate = state.timing.samples ? state.timing.late / state.timing.samples : 0;
    const timingConfidence = clamp(state.timing.samples / 10, 0, 1);
    const suggestedMinProgress = round(clamp(0.25 + earlyRate * 0.12 * timingConfidence - lateRate * 0.05 * timingConfidence, 0.2, 0.42), 3);
    let recommended = null; let best = -1;
    for (const [strategy, score] of Object.entries(strategyScores)) if (score > best) { best = score; recommended = strategy; }
    const confidence = clamp(state.history.length / 20, 0, 1);
    return {
      strategyScores,
      recommended,
      confidence,
      samples: state.history.length,
      contextKey: key,
      contextSamples: context ? context.count : 0,
      suggestedMinProgress,
      minProgressRatio: input.plan ? undefined : suggestedMinProgress,
      note: `adaptive ${VERSION} · опыт ${state.history.length} переходов · early ${(earlyRate * 100).toFixed(0)}% · late ${(lateRate * 100).toFixed(0)}%`,
    };
  }

  function summary() {
    const history = state.history;
    const recent = history.slice(-20);
    const strategyPerformance = {};
    for (const [name, arm] of Object.entries(state.strategy)) strategyPerformance[name] = { count: arm.count, mean: round(arm.mean, 4), early: arm.early, late: arm.late };
    return {
      version: VERSION,
      modelVersion: state.modelVersion,
      updatedAt: state.updatedAt,
      transitions: history.length,
      successful: history.filter((entry) => entry.success).length,
      failed: history.filter((entry) => !entry.success).length,
      averageQuality: history.length ? round(mean(history.map((entry) => entry.quality)), 4) : null,
      recentQuality: recent.length ? round(mean(recent.map((entry) => entry.quality)), 4) : null,
      timingQuality: history.length ? round(mean(history.map((entry) => entry.auto.timing)), 4) : null,
      beatQuality: history.length ? round(mean(history.map((entry) => entry.auto.beat)), 4) : null,
      harmonicQuality: history.length ? round(mean(history.map((entry) => entry.auto.harmonic)), 4) : null,
      energyQuality: history.length ? round(mean(history.map((entry) => entry.auto.energy)), 4) : null,
      audioQuality: history.length ? round(mean(history.map((entry) => entry.auto.audio)), 4) : null,
      earlyErrors: history.filter((entry) => entry.features.progress != null && entry.features.progress < 0.25).length,
      lateErrors: history.filter((entry) => entry.features.progress != null && entry.features.progress > 0.88).length,
      userFeedback: { ...state.feedback },
      learningConfidence: clamp(history.length / 20, 0, 1),
      rollbacks: state.rollbacks,
      last: history.length ? history[history.length - 1] : null,
      strategyPerformance,
      contexts: Object.keys(state.contexts).length,
      timing: { ...state.timing },
    };
  }

  function exportData() { return JSON.stringify({ ...state, exportedAt: Date.now() }, null, 2); }
  function reset() { state = safeParse(null, { version: VERSION, modelVersion: state.modelVersion + 1, updatedAt: 0, history: [], strategy: {}, contexts: {}, timing: { early: 0, late: 0, good: 0, progressSum: 0, samples: 0 }, feedback: { excellent: 0, good: 0, normal: 0, bad: 0, early: 0, late: 0, sync: 0, wrong_music: 0 }, snapshots: [], rollbacks: 0 }); persist(); return summary(); }
  function rollback() { const snapshot = state.snapshots.pop(); if (!snapshot) return false; state.strategy = snapshot.state.strategy; state.contexts = snapshot.state.contexts; state.timing = snapshot.state.timing; state.rollbacks += 1; persist(); return true; }

  return { advise, observe, feedback, summary, exportData, reset, rollback, _state: state, VERSION };
}
