/* RH-MUSIC · AI Mix Beta — independent experimental two-deck mixer.
   Separate from RH-AI-DJ-ENGINE: own analysis, planner, AudioBuffer decks and
   equal-power/bass-swap executor. No second visible player. */
(function () {
  'use strict';

  const state = {
    phase: 'OFF', error: null, host: null, ctx: null, mixer: null,
    active: null, next: null, plan: null, timer: null, busy: false,
    cache: new Map(), log: [], owns: false, token: 0,
  };

  function emit() { if (state.host?.onState) state.host.onState(getState()); }
  function note(m) { state.log.push({ at: Date.now(), m }); if (state.log.length > 60) state.log.shift(); if (state.host?.log) state.host.log(m); }
  function phase(p) { state.phase = p; emit(); }
  function fail(m) { state.error = m; phase('ERROR'); if (state.host?.onToast) state.host.onToast(m); note('ERROR ' + m); }

  let pulsePolicy = null;
  let analysisWorker = null;
  let analysisSeq = 0;
  const analysisPending = new Map();

  function ensureAnalysisWorker() {
    if (analysisWorker) return analysisWorker;
    analysisWorker = new Worker('ai-mix-beta/pulsegrid-analysis-worker.js');
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

  class BetaMixer {
    constructor(ctx, pitchReady = false) {
      this.ctx = ctx; this.pitchReady = pitchReady; this.out = ctx.createGain(); this.out.gain.value = 1; this.out.connect(ctx.destination);
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

  async function decodeTrack(track) {
    const cached = state.cache.get(String(track.id)); if (cached) return cached;
    const url = state.host.streamUrl(track);
    const res = await fetch(url, { headers: { Accept: 'audio/mpeg' } });
    if (!res.ok) throw new Error('stream HTTP ' + res.status);
    const data = await res.arrayBuffer();
    const buffer = await state.ctx.decodeAudioData(data.slice(0));
    const cache = window.RH_AI_MIX_BETA_CACHE;
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
    const cand = candidates()[0]; if (!cand) { phase('DEGRADED'); note('queue empty'); return; }
    state.busy = true;
    try {
      phase('PREPARING');
      const entry = await decodeTrack(cand.track);
      const s = state.host.getState();
      const plan = planTransition(state.active.analysis, entry.analysis, s.currentTime);
      if (!plan || plan.durationSec <= 0) { phase('DEGRADED'); return; }
      state.next = { ...entry, index: cand.index };
      state.plan = plan;
      phase('READY');
      note('Beta plan: ' + plan.reason + ' @ ' + plan.startAt.toFixed(1) + 's');
      schedule();
    } catch (e) { phase('DEGRADED'); note('beta prepare failed: ' + e.message); }
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
      a.gain.gain.cancelScheduledValues(state.ctx.currentTime); b.gain.gain.cancelScheduledValues(state.ctx.currentTime);
      a.gain.gain.setValueAtTime(1, state.ctx.currentTime); b.gain.gain.setValueAtTime(0, state.ctx.currentTime);
      a.low.gain.cancelScheduledValues(state.ctx.currentTime); b.low.gain.cancelScheduledValues(state.ctx.currentTime);
      a.low.gain.setValueAtTime(0, state.ctx.currentTime); b.low.gain.setValueAtTime(0, state.ctx.currentTime);
      state.mixer.startDeck(a, state.active.buffer, host.currentTime, 1);
      state.mixer.startDeck(b, next.buffer, plan.inStart, plan.rateIn);
      const now = state.ctx.currentTime;
      a.gain.gain.cancelScheduledValues(now); b.gain.gain.cancelScheduledValues(now);
      a.gain.gain.setValueAtTime(1, now); b.gain.gain.setValueAtTime(0, now);
      const curve = 24, dur = plan.durationSec;
      const swap = now + dur * 0.5;
      for (let i = 1; i <= curve; i += 1) {
        const t = i / curve, at = now + dur * t;
        a.gain.gain.linearRampToValueAtTime(Math.cos(t * Math.PI / 2), at);
        b.gain.gain.linearRampToValueAtTime(Math.sin(t * Math.PI / 2), at);
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
      state.host.getAudio()?.pause();
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
      if (!pulsePolicy) pulsePolicy = await import('./ai-mix-beta/pulsegrid-transition-policy.mjs').catch(() => null);
      let pitchReady = false;
      if (state.ctx.audioWorklet) {
        try { await state.ctx.audioWorklet.addModule('ai-mix-beta/pulsegrid-pitch-processor.js'); pitchReady = true; }
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
    } catch (e) { phase('DEGRADED'); note('beta analysis failed: ' + e.message); }
  }

  function disable() {
    state.token += 1;
    const deck = state.mixer ? (state.mixer.active || state.mixer.a) : null;
    const pos = deck ? state.mixer.position(deck) : (state.active ? state.host.getState().currentTime : 0);
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.mixer) state.mixer.stop();
    if (state.ctx) { try { state.ctx.close(); } catch (_) {} }
    state.ctx = null; state.mixer = null; state.active = null; state.next = null; state.plan = null;
    state.owns = false; phase('OFF');
    if (state.host?.onExit) state.host.onExit({ position: pos });
  }

  function getState() {
    const deck = state.mixer ? (state.mixer.active || state.mixer.a) : null;
    const pos = deck ? state.mixer.position(deck) : null;
    const duration = deck && deck.buffer ? deck.buffer.duration : null;
    return {
      phase: state.phase, active: state.phase !== 'OFF' && state.phase !== 'ERROR', ownsPlayback: state.owns,
      activeTrack: state.active?.track || null, nextTrack: state.next?.track || null,
      plan: state.plan, position: pos, duration, paused: state.ctx ? state.ctx.state !== 'running' : true, error: state.error,
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

  window.RH_AI_MIX_BETA = {
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
      if (window.RH_AI_MIX_BETA_CACHE) window.RH_AI_MIX_BETA_CACHE.stats().then((cache) => { base.cache = cache; });
      return base;
    },
    _internal: { analyzeTrackBuffer, planTransition },
  };
})();
