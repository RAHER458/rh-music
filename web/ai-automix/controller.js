/* RH-MUSIC · AI AutoMix controller.
   Wires the vendored RH-AI-DJ-ENGINE Core/AudioEngine to the existing RH-MUSIC
   player. No second user-facing player: the engine decks are technical channels. */
(function () {
  'use strict';

  const PHASES = ['OFF', 'LOADING', 'READY', 'ANALYZING', 'PREPARING', 'MIXING', 'ACTIVE', 'DEGRADED', 'ERROR'];
  const LOAD_STEPS = [
    'Initializing Neural Engine',
    'Loading Audio Processing',
    'Initializing Musical Intelligence',
    'Loading Session Intelligence',
    'Initializing Musical Memory',
    'Initializing AI Director',
    'Initializing Transition Engine',
    'Checking Audio Output',
    'Ready',
  ];

  const state = {
    phase: 'OFF',
    step: -1,
    error: null,
    host: null,
    lib: null,
    core: null,
    engine: null,
    ctx: null,
    deckA: null,
    deckB: null,
    activeTrack: null,
    activeIndex: -1,
    pending: null,
    cache: new Map(),
    timer: null,
    busy: false,
    diagnostics: [],
  };

  function emit() {
    const host = state.host;
    if (host && typeof host.onState === 'function') host.onState(getState());
  }

  function log(message) {
    state.diagnostics.push({ at: Date.now(), message });
    if (state.diagnostics.length > 80) state.diagnostics.shift();
    if (state.host && typeof state.host.log === 'function') state.host.log(message);
  }

  function setPhase(phase, step) {
    state.phase = phase;
    if (typeof step === 'number') state.step = step;
    emit();
  }

  function fail(message) {
    state.error = message;
    setPhase('ERROR');
    if (state.host && typeof state.host.onToast === 'function') state.host.onToast(message);
    log('ERROR: ' + message);
  }

  function adapter(buffer) {
    return {
      sampleRate: buffer.sampleRate,
      length: buffer.length,
      numberOfChannels: buffer.numberOfChannels,
      duration: buffer.duration,
      getChannelData: (channel) => buffer.getChannelData(channel),
    };
  }

  async function decode(track) {
    const cached = state.cache.get(String(track.id));
    if (cached) return cached;
    const url = state.host.streamUrl(track);
    const response = await fetch(url, { headers: { Accept: 'audio/mpeg' } });
    if (!response.ok) throw new Error('stream HTTP ' + response.status);
    const data = await response.arrayBuffer();
    if (data.byteLength < 1024) throw new Error('stream too short');
    const buffer = await state.ctx.decodeAudioData(data.slice(0));
    const analysis = state.lib.analyzeAudioBuffer(adapter(buffer), {
      id: String(track.id), title: track.title, artist: track.artist,
    });
    const context = state.core.analyzeTrack({
      id: String(track.id), title: track.title, artist: track.artist, analysis, source: 'rh-music stream',
    });
    const entry = { track, buffer, analysis, context };
    state.cache.set(String(track.id), entry);
    return entry;
  }

  async function ensureEngine() {
    if (state.engine) return;
    if (!state.lib) {
      setPhase('LOADING', 0);
      state.lib = await import('./automix-engine.js?v=1');
      setPhase('LOADING', 1);
      state.core = state.lib.createAutoMixCore({ sessionId: 'rh-music' });
      state.core.initialize();
      setPhase('LOADING', 2);
      state.core.setEnergyMode('Adaptive');
      setPhase('LOADING', 3);
      setPhase('LOADING', 4);
      setPhase('LOADING', 5);
      setPhase('LOADING', 6);
    }
    const elA = document.createElement('audio');
    const elB = document.createElement('audio');
    elA.preload = 'auto';
    elB.preload = 'auto';
    elA.crossOrigin = 'anonymous';
    elB.crossOrigin = 'anonymous';
    state.engine = new state.lib.AudioEngine({ A: elA, B: elB });
    await state.engine.start();
    state.ctx = state.engine.context;
    state.deckA = state.engine.deckA;
    state.deckB = state.engine.deckB;
    setPhase('LOADING', 7);
    if (!state.ctx || state.ctx.state !== 'running') throw new Error('AudioContext не запустился: ' + (state.ctx ? state.ctx.state : 'нет'));
    setPhase('LOADING', 8);
    setPhase('READY');
    log('Neural AI готов');
  }

  async function enable() {
    if (state.phase !== 'OFF' && state.phase !== 'ERROR') return;
    try { if (state.host && state.host.getAudio) state.host.getAudio().pause(); } catch (_) {}
    state.error = null;
    try {
      await ensureEngine();
      const current = state.host.getState().current;
      if (current) await onTrackStarted(current);
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
    }
  }

  function disable() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.engine) {
      try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
    }
    state.pending = null;
    state.activeTrack = null;
    state.activeIndex = -1;
    setPhase('OFF', -1);
    if (state.host && typeof state.host.onExit === 'function') state.host.onExit();
    log('AI AutoMix выключен');
  }

  function toggle() {
    if (state.phase === 'OFF' || state.phase === 'ERROR') enable();
    else disable();
  }

  async function onTrackStarted(track) {
    if (state.phase === 'OFF' || state.phase === 'ERROR' || !state.engine || !track) return;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.pending = null;
    if (state.activeTrack && String(state.activeTrack.id) === String(track.id) && state.phase !== 'READY') return;
    try {
      setPhase('ANALYZING');
      const entry = await decode(track);
      state.activeTrack = track;
      state.activeIndex = state.host.getState().index;
      state.deckA.loadBuffer(entry.buffer);
      state.deckA.setEQ(0, 0, 0);
      state.deckA.setFilter(0);
      state.deckA.setCrossfader(0.5);
      state.deckA.fadeTo(1, 0.02);
      await state.deckA.play(0, 1);
      setPhase('ACTIVE');
      log('Deck A: ' + track.title);
      await planNext();
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
    }
  }

  function queueCandidates() {
    const hostState = state.host.getState();
    const queue = Array.isArray(hostState.queue) ? hostState.queue : [];
    const out = [];
    for (let i = 0; i < queue.length; i += 1) {
      const track = queue[i];
      if (!track || !track.id) continue;
      if (state.activeTrack && String(track.id) === String(state.activeTrack.id)) continue;
      out.push({ track, index: i });
      if (out.length >= 3) break;
    }
    return out;
  }

  async function planNext() {
    if (state.busy || state.phase === 'OFF') return;
    const candidates = queueCandidates();
    if (!candidates.length) { setPhase('DEGRADED'); log('Очередь пуста: нет кандидата'); return; }
    state.busy = true;
    try {
      setPhase('PREPARING');
      const decoded = [];
      for (const candidate of candidates) {
        try { decoded.push({ ...candidate, entry: await decode(candidate.track) }); } catch (error) { log('Кандидат пропущен: ' + candidate.track.title + ' · ' + error.message); }
      }
      if (!decoded.length) { setPhase('DEGRADED'); return; }
      const history = { ids: [String(state.activeTrack.id)], artists: [state.activeTrack.artist] };
      const playback = { position: state.deckA.currentTime, duration: state.deckA.duration, activeDeck: 'A', paused: state.deckA.paused, remainingSec: Math.max(0, state.deckA.duration - state.deckA.currentTime) };
      const decision = state.core.decide(String(state.activeTrack.id), decoded.map((item) => ({
        id: String(item.track.id), title: item.track.title, artist: item.track.artist, index: item.index,
        analysis: item.entry.analysis, context: item.entry.context,
      })), history, playback, {});
      if (!decision.chosen || !decision.plan) { setPhase('DEGRADED'); log('AI не нашёл переход: ' + decision.reason); return; }
      state.pending = { track: decision.chosen, entry: decoded.find((item) => String(item.track.id) === String(decision.chosen.id)).entry, plan: decision.plan };
      state.deckB.loadBuffer(state.pending.entry.buffer);
      state.deckB.cancelAutomation();
      log('AI выбрал: ' + state.pending.track.title + ' · ' + decision.plan.strategy);
      setPhase('ACTIVE');
      scheduleWatch();
    } finally {
      state.busy = false;
    }
  }

  function scheduleWatch() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.phase === 'OFF' || state.phase === 'ERROR' || !state.pending) return;
      const active = state.deckA;
      if (!active || active.paused) return;
      if (active.currentTime >= state.pending.plan.startAt - 0.35) {
        clearInterval(state.timer); state.timer = null;
        void executeTransition();
      }
    }, 120);
  }

  async function executeTransition() {
    const pending = state.pending;
    if (!pending) return;
    state.pending = null;
    try {
      setPhase('MIXING');
      const engine = state.engine;
      const outDeck = state.deckA;
      const inDeck = state.deckB;
      const startAt = await engine.beginTransition(pending.plan, outDeck, inDeck);
      const tokenStart = startAt;
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!state.engine || state.phase === 'OFF') { clearInterval(timer); resolve(); return; }
          const elapsed = state.ctx.currentTime - tokenStart;
          if (elapsed >= pending.plan.durationSec) { clearInterval(timer); resolve(); }
        }, 80);
      });
      engine.completeTransition(outDeck, inDeck);
      state.deckA = inDeck;
      state.deckB = outDeck;
      state.activeTrack = pending.track;
      const hostState = state.host.getState();
      if (state.host && typeof state.host.onAdopt === 'function') state.host.onAdopt(state.cache.get(String(pending.track.id)).track, pending.plan.strategy);
      state.activeIndex = hostState.index;
      log('Переход завершён: ' + pending.track.title);
      setPhase('ACTIVE');
      await planNext();
    } catch (error) {
      fail(error && error.message ? error.message : String(error));
    }
  }

  function pause() {
    try { state.deckA && state.deckA.pause(); state.deckB && state.deckB.pause(); } catch (_) {}
  }

  function resume() {
    try {
      if (state.deckA && state.deckA.paused && state.deckA.currentTime < state.deckA.duration) state.deckA.play(state.deckA.currentTime, 1);
    } catch (_) {}
  }

  function getState() {
    return {
      phase: state.phase,
      step: state.step,
      steps: LOAD_STEPS,
      error: state.error,
      active: state.phase !== 'OFF' && state.phase !== 'ERROR',
      activeTrack: state.activeTrack,
      nextTrack: state.pending ? state.pending.track : null,
      strategy: state.pending ? state.pending.plan.strategy : null,
      deckA: state.deckA ? { time: state.deckA.currentTime, duration: state.deckA.duration, paused: state.deckA.paused } : null,
      deckB: state.deckB ? { time: state.deckB.currentTime, duration: state.deckB.duration, paused: state.deckB.paused } : null,
    };
  }

  function getDiagnostics() {
    return { state: getState(), log: state.diagnostics.slice(), core: state.core ? state.core.diagnostics() : null };
  }

  window.RH_AI_AUTOMIX = {
    init(host) { state.host = host; emit(); return getState(); },
    toggle,
    enable,
    disable,
    onTrackStarted,
    pause,
    resume,
    getState,
    getDiagnostics,
    isActive() { return state.phase !== 'OFF' && state.phase !== 'ERROR'; },
    _state: state,
  };
})();
