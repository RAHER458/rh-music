/* RH-MUSIC · AI Mix Beta — independent experimental two-deck mixer.
   Separate from RH-AI-DJ-ENGINE: own analysis, planner, AudioBuffer decks and
   equal-power/bass-swap executor. No second visible player. */
(function () {
  'use strict';

  const API_BASE = 'https://automix2-api-production.up.railway.app';

  const state = {
    phase: 'OFF', error: null, host: null, ctx: null, mixer: null,
    active: null, next: null, plan: null, timer: null, busy: false,
    cache: new Map(), log: [], owns: false, token: 0,
  };

  function emit() { if (state.host?.onState) state.host.onState(getState()); }
  function note(m) { state.log.push({ at: Date.now(), m }); if (state.log.length > 60) state.log.shift(); if (state.host?.log) state.host.log(m); }
  function phase(p) { state.phase = p; emit(); }
  function fail(m) { state.error = m; phase('ERROR'); if (state.host?.onToast) state.host.onToast(m); note('ERROR ' + m); }
  function degrade(m) {
    state.error = m;
    phase('DEGRADED');
    note('DEGRADED: ' + m);
    if (state.host?.log) state.host.log('Auto Mix Beta 2.0 degraded: ' + m);
  }
  function retryLater() {
    if (state.retryTimer) return;
    state.retryTimer = setInterval(() => {
      if (state.phase === 'OFF' || state.phase === 'ERROR') { clearInterval(state.retryTimer); state.retryTimer = null; return; }
      if (!state.busy && !state.plan && state.active) void planNext();
    }, 5000);
  }

  let pulsePolicy = null;
  let analysisWorker = null;
  let analysisSeq = 0;
  const analysisPending = new Map();

  function ensureAnalysisWorker() {
    if (analysisWorker) return analysisWorker;
    analysisWorker = new Worker('automix2/pulsegrid-analysis-worker.js');
    analysisWorker.onmessage = (event) => {
      const job = analysisPending.get(event.data.id);
      if (!job) return;
      if (event.data.phase === 'complete') { analysisPending.delete(event.data.id); job.resolve(event.data.result); }
      else if (event.data.phase === 'error') { analysisPending.delete(event.data.id); job.reject(new Error(event.data.error || 'PulseGrid analysis failed')); }
    };
    analysisWorker.onerror = (event) => {
      for (const [id, job] of analysisPending) { job.reject(new Error(event.message || 'PulseGrid analysis worker error')); analysisPending.delete(id); }
    };
    return analysisWorker;
  }

  function encodePreviewWav(buffer, maxSeconds = 600) {
    const sourceRate = buffer.sampleRate;
    const targetRate = 8000;
    const seconds = Math.min(maxSeconds, buffer.duration);
    const targetLength = Math.max(1, Math.floor(seconds * targetRate));
    const channels = Math.min(2, buffer.numberOfChannels);
    const mono = new Float32Array(targetLength);
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < targetLength; i += 1) mono[i] += data[Math.min(data.length - 1, Math.floor((i / targetRate) * sourceRate))] / channels;
    }
    const bytes = new Uint8Array(44 + targetLength * 2);
    const view = new DataView(bytes.buffer);
    const writeString = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    writeString(0, 'RIFF'); view.setUint32(4, 36 + targetLength * 2, true); writeString(8, 'WAVE');
    writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeString(36, 'data'); view.setUint32(40, targetLength * 2, true);
    for (let i = 0; i < targetLength; i += 1) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i])) * 32767, true);
    return new Blob([bytes], { type: 'audio/wav' });
  }

  async function analyzeRemote(buffer, track) {
    const form = new FormData();
    form.append('track_id', String(track.id));
    form.append('audio', encodePreviewWav(buffer), 'preview.wav');
    const response = await fetch(API_BASE + '/api/v1/analyze', { method: 'POST', body: form });
    if (!response.ok) throw new Error('automix2 analyze HTTP ' + response.status);
    let job = await response.json();
    const deadline = Date.now() + 35_000;
    while (job.status !== 'complete' && job.status !== 'error') {
      if (Date.now() > deadline) throw new Error('automix2 analysis timeout');
      await new Promise((resolve) => setTimeout(resolve, 600));
      const poll = await fetch(API_BASE + '/api/v1/analyze/' + encodeURIComponent(job.job_id));
      if (!poll.ok) throw new Error('automix2 job HTTP ' + poll.status);
      job = await poll.json();
    }
    if (job.status !== 'complete' || !job.analysis) throw new Error(job.error || 'automix2 analysis failed');
    const a = job.analysis;
    const peaks = new Float32Array(1400);
    const curve = a.energy_curve || [];
    for (let i = 0; i < peaks.length; i += 1) peaks[i] = curve[Math.floor(i / peaks.length * Math.max(1, curve.length))] || 0;
    return {
      id: String(track.id), bpm: a.bpm, beatSec: 60 / Math.max(1, a.bpm), offset: (a.beat_grid && a.beat_grid[0]) || 0,
      downbeats: a.downbeats || [], duration: a.duration,
      sections: (a.structure || []).map((seg) => ({ start: seg.start, end: seg.end, energy: seg.energy })),
      peaks, energy: a.integrated_lufs, mixOut: Math.max(a.duration * 0.72, a.duration - Math.max(32, a.duration * 0.18)),
      camelot: a.camelot, key: a.key, analysis: 'automix2-railway', confidence: a.analysis_confidence, rawAnalysis: a,
    };
  }

  function analyzeWithPulseGrid(buffer, track) {
    const worker = ensureAnalysisWorker();
    const channels = Math.min(2, buffer.numberOfChannels);
    const samples = new Float32Array(buffer.length);
    for (let c = 0; c < channels; c += 1) { const data = buffer.getChannelData(c); for (let i = 0; i < data.length; i += 1) samples[i] += data[i] / channels; }
    const id = ++analysisSeq;
    return new Promise((resolve, reject) => {
      analysisPending.set(id, { resolve, reject });
      worker.postMessage({ id, samples, sampleRate: buffer.sampleRate, duration: track.duration }, [samples.buffer]);
    });
  }

  async function analyzeTrackBuffer(buffer, track) {
    try {
      const remote = await analyzeRemote(buffer, track);
      note('Railway analysis: ' + track.title + ' · ' + remote.bpm + ' BPM');
      return remote;
    } catch (error) {
      note('Railway analysis fallback: ' + error.message);
    }
    const result = await analyzeWithPulseGrid(buffer, track);
    const bpm = Number(result.bpm) || 120;
    const beatSec = 60 / Math.max(1, bpm);
    const offset = Number(result.gridOffset) || 0;
    const downbeats = [];
    for (let t = offset; t < track.duration - 0.2; t += beatSec * 4) downbeats.push(Number(t.toFixed(3)));
    const peaks = result.peaks || new Float32Array(0);
    const sections = [];
    const buckets = 12;
    for (let i = 0; i < buckets; i += 1) {
      const from = Math.floor((i / buckets) * peaks.length), to = Math.floor(((i + 1) / buckets) * peaks.length);
      let sum = 0; for (let j = from; j < to; j += 1) sum += peaks[j] || 0;
      sections.push({ start: (i / buckets) * track.duration, end: ((i + 1) / buckets) * track.duration, energy: Number((sum / Math.max(1, to - from)).toFixed(3)) });
    }
    const mixOut = Math.max(track.duration * 0.72, track.duration - Math.max(32, track.duration * 0.18));
    return { id: String(track.id), bpm: Number(bpm.toFixed(2)), beatSec, offset, downbeats, duration: track.duration, sections, peaks, energy: result.energy, mixOut, camelot: result.camelot, key: result.key, analysis: 'pulsegrid' };
  }

  function nearestDownbeat(analysis, time) {
    let best = analysis.downbeats[0] ?? 0;
    for (const t of analysis.downbeats) if (Math.abs(t - time) < Math.abs(best - time)) best = t;
    return best;
  }

  function camelotDistance(a, b) {
    const parse = (v) => { const m = /^(\d{1,2})([AB])$/i.exec(String(v || '')); return m ? { n: Number(m[1]), mode: m[2].toUpperCase() } : null; };
    const x = parse(a), y = parse(b); if (!x || !y) return null;
    const diff = Math.abs(x.n - y.n); const circle = Math.min(diff, 12 - diff);
    return circle + (x.mode === y.mode ? 0 : 1);
  }

  async function planTransitionRemote(out, incoming) {
    try {
      const response = await fetch(API_BASE + '/api/v1/transition/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outgoing: out.rawAnalysis || { track_id: out.id, duration: out.duration, bpm: out.bpm, bpm_confidence: out.confidence || 0.5, beat_grid: [], downbeats: out.downbeats, key: out.key || '', camelot: out.camelot || '', key_confidence: 0.5, energy_curve: [], structure: [], vocal_activity: [], bass_activity: [], integrated_lufs: out.energy || 0, true_peak_db: 0, analysis_confidence: out.confidence || 0.5 },
          incoming: incoming.rawAnalysis || { track_id: incoming.id, duration: incoming.duration, bpm: incoming.bpm, bpm_confidence: incoming.confidence || 0.5, beat_grid: [], downbeats: incoming.downbeats, key: incoming.key || '', camelot: incoming.camelot || '', key_confidence: 0.5, energy_curve: [], structure: [], vocal_activity: [], bass_activity: [], integrated_lufs: incoming.energy || 0, true_peak_db: 0, analysis_confidence: incoming.confidence || 0.5 },
        }),
      });
      if (!response.ok) throw new Error('plan HTTP ' + response.status);
      const p = await response.json();
      if (p && p.strategy === 'no-transition') return { noTransition: true, reason: (p.reasons || []).join('; ') };
      if (!p || !p.strategy) return null;
      return { strategy: p.strategy, startAt: p.transition_start, durationSec: p.duration, endAt: p.transition_start + p.duration, inStart: p.incoming_start, rateIn: p.incoming_rate || 1, bpmGap: 0, overlapBeats: Math.round(p.duration * 2), keyDistance: null, energyDelta: 0, confidence: p.confidence, reason: 'Railway: ' + (p.reasons || []).join('; ') };
    } catch (error) { note('Railway plan fallback: ' + error.message); return null; }
  }

  function planTransition(out, incoming, position) {
    const bpmGap = Math.abs(incoming.bpm - out.bpm) / Math.max(1, out.bpm);
    const start = Math.max(position + 0.2, nearestDownbeat(out, Math.max(out.mixOut, out.duration * 0.72)));
    const remaining = Math.max(0, out.duration - start);
    const keyDist = camelotDistance(out.camelot, incoming.camelot);
    const outEnergy = out.sections.length ? out.sections.slice(-3).reduce((s, x) => s + x.energy, 0) / Math.min(3, out.sections.length) : 0.5;
    const inEnergy = incoming.sections.length ? incoming.sections.slice(0, 3).reduce((s, x) => s + x.energy, 0) / Math.min(3, incoming.sections.length) : 0.5;
    const energyDelta = outEnergy - inEnergy;
    let beats = 32, strategy = 'beta-bass-swap';
    if (bpmGap > 0.08) { beats = 8; strategy = 'beta-filter-cut'; }
    else if (keyDist != null && keyDist > 2) { beats = 16; strategy = 'beta-filter-cut'; }
    else if (energyDelta > 0.22) { beats = 32; strategy = 'beta-long-blend'; }
    else if (bpmGap > 0.04) { beats = 24; strategy = 'beta-bass-swap'; }
    const plannedSec = Math.min(remaining - 0.2, Math.max(2, beats * 60 / Math.max(60, out.bpm)));
    const profile = pulsePolicy ? pulsePolicy.transitionDurationProfile({ plannedSec, plannedBeats: beats, remainingOutgoingSec: remaining }) : null;
    const durationSec = profile ? profile.effectiveSec : plannedSec;
    const inStart = Math.max(0, nearestDownbeat(incoming, Math.max(incoming.duration * 0.08, incoming.duration * 0.04)));
    return {
      strategy, startAt: Number(start.toFixed(3)), durationSec: Number(durationSec.toFixed(3)),
      endAt: Number((start + durationSec).toFixed(3)), inStart: Number(inStart.toFixed(3)),
      rateIn: Math.max(0.94, Math.min(1.06, out.bpm / Math.max(60, incoming.bpm))),
      bpmGap, overlapBeats: beats, keyDistance: keyDist, energyDelta: Number(energyDelta.toFixed(3)),
      reason: `${out.bpm}→${incoming.bpm} BPM · key ${out.camelot || '—'}→${incoming.camelot || '—'} (${keyDist == null ? 'unknown' : keyDist}) · energy Δ${energyDelta.toFixed(2)} · ${beats} beats · ${strategy}`,
    };
  }

  function crossfadeCurve(steps = 24) {
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      points.push({ t, out: Math.cos(t * Math.PI / 2), in: Math.sin(t * Math.PI / 2) });
    }
    return points;
  }

  class BetaMixer {
    constructor(ctx, pitchReady = false) {
      this.ctx = ctx; this.pitchReady = pitchReady; this.out = ctx.createGain(); this.out.gain.value = 0.70;
      const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.18;
      this.out.connect(limiter); limiter.connect(ctx.destination);
      this.a = this.makeDeck(); this.b = this.makeDeck(); this.active = null;
    }
    makeDeck() {
      const gain = this.ctx.createGain(); gain.gain.value = 1;
      const low = this.ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 180;
      const mid = this.ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1100;
      const high = this.ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 6500;
      const filter = this.ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 22000;
      let pitch = null;
      if (this.pitchReady) {
        try {
          pitch = new AudioWorkletNode(this.ctx, 'pulsegrid-pitch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          pitch.connect(gain);
        } catch (_) { pitch = null; }
      }
      gain.connect(low).connect(mid).connect(high).connect(filter).connect(this.out);
      return { gain, low, mid, high, filter, pitch, source: null, anchor: 0, startedAt: 0, rate: 1, buffer: null };
    }
    startDeck(deck, buffer, offset, rate) {
      this.stopDeck(deck);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer; source.playbackRate.value = rate || 1;
      source.connect(deck.pitch || deck.gain);
      if (deck.pitch) { try { deck.pitch.parameters.get('pitchRatio').setTargetAtTime(1 / (rate || 1), this.ctx.currentTime, 0.015); } catch (_) {} }
      source.start(0, Math.max(0, Math.min(offset, buffer.duration - 0.02)));
      deck.source = source; deck.anchor = offset; deck.startedAt = this.ctx.currentTime; deck.rate = rate || 1; deck.buffer = buffer;
    }
    stopDeck(deck) { if (deck.source) { try { deck.source.stop(); deck.source.disconnect(); } catch (_) {} } deck.source = null; }
    position(deck) { if (!deck.source) return deck.anchor; return Math.min(deck.buffer.duration, deck.anchor + (this.ctx.currentTime - deck.startedAt) * deck.rate); }
    pause() { this.ctx.suspend?.(); }
    resume() { this.ctx.resume?.(); }
    stop() { this.stopDeck(this.a); this.stopDeck(this.b); }
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout')), ms))]);
  }

  async function decodeTrack(track) {
    const cached = state.cache.get(String(track.id)); if (cached) return cached;
    const url = state.host.streamUrl(track);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 20_000);
    let res, data;
    try {
      res = await fetch(url, { headers: { Accept: 'audio/mpeg' }, signal: controller.signal });
      if (!res.ok) throw new Error('stream HTTP ' + res.status);
      data = await res.arrayBuffer();
    } finally { clearTimeout(abortTimer); }
    if (!data || data.byteLength < 1024) throw new Error('stream too short');
    const buffer = await withTimeout(state.ctx.decodeAudioData(data.slice(0)), 25_000, 'decode');
    const cache = window.RH_AUTOMIX2_CACHE;
    const cacheKey = 'pg1:' + String(track.id) + ':' + String(track.duration || 0);
    let analysis = cache ? await cache.get(cacheKey) : null;
    if (analysis) {
      note('cache hit: ' + track.title);
    } else {
      analysis = await analyzeTrackBuffer(buffer, track);
      if (cache) { await cache.put(cacheKey, { analysis, trackId: String(track.id), version: 1 }); cache.prune(); }
    }
    const entry = { track, buffer, analysis };
    state.cache.set(String(track.id), entry);
    while (state.cache.size > 2) state.cache.delete(state.cache.keys().next().value);
    return entry;
  }

  function candidates() {
    const s = state.host.getState(); const q = Array.isArray(s.queue) ? s.queue : [];
    if (!q.length) return [];
    const idx = Number.isInteger(s.index) && s.index >= 0 ? s.index : 0;
    const out = [];
    for (let off = 1; off <= q.length; off += 1) {
      const i = (idx + off) % q.length; const t = q[i];
      if (!t || !t.id) continue;
      if (state.active && String(state.active.track.id) === String(t.id)) continue;
      out.push({ track: t, index: i }); if (out.length >= 3) break;
    }
    return out;
  }

  async function planNext() {
    if (state.busy || state.phase === 'OFF') return;
    const cand = candidates()[0];
    if (!cand) { state.error = null; state.plan = null; phase('READY'); note('Ожидание следующего трека в очереди'); retryLater(); return; }
    state.busy = true;
    try {
      phase('PREPARING');
      const entry = await decodeTrack(cand.track);
      const s = state.host.getState();
      const remote = await planTransitionRemote(state.active.analysis, entry.analysis);
      if (remote && remote.noTransition) { state.pending = null; state.plan = null; state.error = 'Planner: no transition — ' + (remote.reason || 'incompatible pair'); phase('READY'); note(state.error); retryLater(); return; }
      const plan = remote || planTransition(state.active.analysis, entry.analysis, s.currentTime);
      if (!plan || plan.durationSec <= 0) { degrade('planner returned an invalid transition'); return; }
      state.next = { ...entry, index: cand.index };
      state.plan = plan;
      phase('READY');
      note('Beta plan: ' + plan.reason + ' @ ' + plan.startAt.toFixed(1) + 's');
      schedule();
    } catch (e) { degrade('prepare failed: ' + (e.message || String(e))); }
    finally { state.busy = false; }
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (!state.plan || !state.next || state.phase === 'OFF' || state.phase === 'MIXING') return;
      const s = state.host.getState(); if (s.paused) return;
      if (s.currentTime > state.plan.startAt + 2) { state.plan = null; note('beta missed window'); void planNext(); return; }
      if (s.currentTime >= state.plan.startAt - 0.2) { clearInterval(state.timer); state.timer = null; void execute(); }
    }, 120);
  }

  async function execute() {
    const next = state.next, plan = state.plan; if (!next || !plan) return;
    try {
      phase('MIXING');
      const host = state.host.getState();
      state.mixer = state.mixer || new BetaMixer(state.ctx);
      const a = state.mixer.a, b = state.mixer.b;
      const startPosition = host.currentTime;
      const audio = state.host.getAudio ? state.host.getAudio() : null;
      if (audio) audio.pause();
      if (state.mixer.active) { state.mixer.stopDeck(state.mixer.active); state.mixer.active = null; }
      const phaseLead = Math.max(0, plan.startAt - startPosition);
      const incomingOffset = Math.max(0, plan.inStart - phaseLead);
      const now = state.ctx.currentTime;
      for (const deck of [a, b]) {
        deck.gain.gain.cancelScheduledValues(now); deck.low.gain.cancelScheduledValues(now);
        deck.low.gain.setValueAtTime(0, now);
        if (deck.filter && deck.filter.frequency) { deck.filter.frequency.cancelScheduledValues(now); deck.filter.frequency.setValueAtTime(22000, now); }
      }
      a.gain.gain.setValueAtTime(1, now); b.gain.gain.setValueAtTime(0, now);
      state.mixer.startDeck(a, state.active.buffer, startPosition, 1);
      state.mixer.startDeck(b, next.buffer, incomingOffset, plan.rateIn);
      const curve = crossfadeCurve(24), dur = plan.durationSec;
      const swap = now + dur * 0.5;
      for (const point of curve.slice(1)) {
        const at = now + dur * point.t;
        a.gain.gain.linearRampToValueAtTime(point.out, at);
        b.gain.gain.linearRampToValueAtTime(point.in, at);
      }
      if (plan.strategy === 'beta-bass-swap' || plan.strategy === 'beta-long-blend') {
        a.low.gain.setValueAtTime(0, now); b.low.gain.setValueAtTime(-24, now);
        a.low.gain.linearRampToValueAtTime(-24, swap);
        b.low.gain.linearRampToValueAtTime(0, swap);
      }
      if (plan.strategy === 'beta-filter-cut') {
        a.filter.frequency.setValueAtTime(22000, now);
        a.filter.frequency.exponentialRampToValueAtTime(350, now + dur);
      } else if (plan.strategy === 'beta-long-blend') {
        a.filter.frequency.setValueAtTime(22000, now);
        a.filter.frequency.linearRampToValueAtTime(9000, now + dur);
      }
      state.owns = true;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, (now + dur - state.ctx.currentTime) * 1000)));
      state.mixer.stopDeck(a);
      state.mixer.active = b;
      state.active = next;
      state.next = null; state.plan = null;
      phase('ACTIVE');
      state.host.onAdopt(next.track, 'AI Mix Beta');
      note('beta transition complete: ' + next.track.title);
      await planNext();
    } catch (e) {
      state.owns = false;
      try { state.host.getAudio()?.play(); } catch (_) {}
      fail('beta transition: ' + e.message);
    }
  }

  async function enable() {
    if (state.phase !== 'OFF' && state.phase !== 'ERROR') return;
    if (window.RH_AI_AUTOMIX?.isActive?.()) throw new Error('Сначала выключите AI AutoMix');
    try {
      phase('ANALYZING');
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.ctx = new Ctx({ latencyHint: 'interactive' });
      if (state.ctx.state === 'suspended') await state.ctx.resume();
      if (!pulsePolicy) pulsePolicy = await import('./automix2/pulsegrid-transition-policy.mjs').catch(() => null);
      let pitchReady = false;
      if (state.ctx.audioWorklet) {
        try { await state.ctx.audioWorklet.addModule('automix2/pulsegrid-pitch-processor.js'); pitchReady = true; }
        catch (_) { pitchReady = false; }
      }
      state.mixer = new BetaMixer(state.ctx, pitchReady);
      const cur = state.host.getState().current;
      if (cur) await onTrackStarted(cur);
      else phase('READY');
    } catch (e) { fail(e.message); }
  }

  async function onTrackStarted(track) {
    if (state.phase === 'OFF' || state.phase === 'ERROR' || !track) return;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.plan = null; state.next = null; state.owns = false;
    const token = ++state.token;
    try {
      phase('ANALYZING');
      const entry = await decodeTrack(track);
      if (token !== state.token) return;
      state.active = entry;
      phase('READY');
      await planNext();
    } catch (e) { degrade('analysis failed: ' + (e.message || String(e))); }
  }

  function disable() {
    state.token += 1;
    const deck = state.mixer ? (state.mixer.active || state.mixer.a) : null;
    const pos = deck ? state.mixer.position(deck) : (state.active ? state.host.getState().currentTime : 0);
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.mixer) state.mixer.stop();
    if (state.ctx) { try { state.ctx.close(); } catch (_) {} }
    state.ctx = null; state.mixer = null; state.active = null; state.next = null; state.plan = null;
    state.owns = false;
    if (state.retryTimer) { clearInterval(state.retryTimer); state.retryTimer = null; }
    phase('OFF');
    if (state.host?.onExit) state.host.onExit({ position: pos });
  }

  function getState() {
    const deck = state.mixer ? (state.mixer.active || state.mixer.a) : null;
    const pos = deck ? state.mixer.position(deck) : null;
    const duration = deck && deck.buffer ? deck.buffer.duration : null;
    return {
      phase: state.phase, active: state.phase !== 'OFF' && state.phase !== 'ERROR', ownsPlayback: state.owns,
      activeTrack: state.active?.track || null, nextTrack: state.next?.track || null,
      plan: state.plan, position: pos, duration, paused: state.ctx ? state.ctx.state !== 'running' : true, error: state.error, reason: state.error,
    };
  }

  function seek(position) {
    if (!state.owns || !state.mixer) return false;
    const deck = state.mixer.active || state.mixer.a;
    if (!deck || !deck.buffer) return false;
    state.mixer.startDeck(deck, deck.buffer, Math.max(0, Math.min(position, deck.buffer.duration - 0.05)), deck.rate || 1);
    state.plan = null; state.next = null;
    setTimeout(() => { if (state.phase !== 'OFF') void planNext(); }, 350);
    return true;
  }

  window.RH_AUTOMIX2 = {
    init(host) { state.host = host; emit(); },
    toggle() { if (state.phase === 'OFF' || state.phase === 'ERROR') void enable(); else disable(); },
    enable, disable, onTrackStarted, getState,
    isActive() { return state.phase !== 'OFF' && state.phase !== 'ERROR'; },
    ownsPlayback() { return state.owns; },
    pause() { state.mixer?.pause(); }, resume() { state.mixer?.resume(); },
    seek,
    getVisualization() {
      const activeDeck = state.mixer ? (state.mixer.active || state.mixer.a) : null;
      const outPeaks = state.active && state.active.analysis ? state.active.analysis.peaks : null;
      const inPeaks = state.next && state.next.analysis ? state.next.analysis.peaks : null;
      return {
        outPeaks, inPeaks,
        outPosition: activeDeck ? state.mixer.position(activeDeck) : 0,
        inPosition: state.mixer && state.mixer.b ? state.mixer.position(state.mixer.b) : 0,
        plan: state.plan,
        phase: state.phase,
      };
    },
    getDiagnostics() {
      const base = { state: getState(), log: state.log.slice() };
      if (window.RH_AUTOMIX2_CACHE) window.RH_AUTOMIX2_CACHE.stats().then((cache) => { base.cache = cache; });
      return base;
    },
    _internal: { analyzeTrackBuffer, planTransition, crossfadeCurve },
  };
})();
