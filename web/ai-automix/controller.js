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
    currentEntry: null,
    ownsPlayback: false,
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

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout')), ms)),
    ]);
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
    return withTimeout(decodeUncached(track), 30_000, 'audio preparation');
  }

  async function decodeUncached(track) {
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
      state.lib = await withTimeout(import('./automix-engine.js?v=1'), 15_000, 'engine module');
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
    const position = state.deckA ? state.deckA.currentTime : 0;
    const owned = state.ownsPlayback;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.engine) {
      try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
    }
    state.pending = null;
    state.currentEntry = null;
    state.activeTrack = null;
    state.activeIndex = -1;
    state.ownsPlayback = false;
    setPhase('OFF', -1);
    if (owned && state.host && typeof state.host.onExit === 'function') state.host.onExit({ position });
    log('AI AutoMix выключен');
  }

  function releaseToStandard(restart = true) {
    if (!state.ownsPlayback) return;
    const position = state.deckA ? state.deckA.currentTime : 0;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.pending = null;
    state.ownsPlayback = false;
    try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
    if (restart && state.host && typeof state.host.onExit === 'function') state.host.onExit({ position });
    state.activeTrack = null;
    state.currentEntry = null;
    log('AI AutoMix: управление возвращено стандартному плееру');
  }

  function toggle() {
    if (state.phase === 'OFF' || state.phase === 'ERROR') enable();
    else disable();
  }

  async function onTrackStarted(track) {
    if (state.phase === 'OFF' || state.phase === 'ERROR' || !state.engine || !track) return;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.pending = null;
    state.currentEntry = null;
    state.activeTrack = track;
    state.activeIndex = state.host.getState().index;
    state.ownsPlayback = false;
    setPhase('ANALYZING');
    log('Фоновый анализ: ' + track.title);
    try {
      const entry = await decode(track);
      if (!state.activeTrack || String(state.activeTrack.id) !== String(track.id)) return;
      state.currentEntry = entry;
      setPhase('ACTIVE');
      await planNext();
    } catch (error) {
      setPhase('DEGRADED');
      log('Анализ не удался, обычное воспроизведение продолжается: ' + (error && error.message ? error.message : String(error)));
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
    const candidate = candidates[0];
    state.busy = true;
    try {
      setPhase('PREPARING');
      const entry = await decode(candidate.track);
      if (!state.activeTrack) return;
      const history = { ids: [String(state.activeTrack.id)], artists: [state.activeTrack.artist] };
      const hostState = state.host.getState();
      const playback = {
        position: hostState.currentTime,
        duration: hostState.duration,
        activeDeck: 'A',
        paused: hostState.paused,
        remainingSec: Math.max(0, hostState.duration - hostState.currentTime),
      };
      const decision = state.core.decide(String(state.activeTrack.id), [{
        id: String(candidate.track.id), title: candidate.track.title, artist: candidate.track.artist,
        index: candidate.index, analysis: entry.analysis, context: entry.context,
      }], history, playback, {});
      if (!decision.chosen || !decision.plan) { setPhase('DEGRADED'); log('AI не нашёл переход: ' + decision.reason); return; }
      state.pending = { track: decision.chosen, entry, plan: decision.plan };
      state.deckB.loadBuffer(entry.buffer);
      state.deckB.cancelAutomation();
      log('AI выбрал: ' + decision.chosen.title + ' · ' + decision.plan.strategy);
      setPhase('ACTIVE');
      scheduleWatch();
    } catch (error) {
      setPhase('DEGRADED');
      log('Подготовка следующего трека не удалась; текущий трек продолжает играть: ' + (error && error.message ? error.message : String(error)));
    } finally {
      state.busy = false;
    }
  }

  function scheduleWatch() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.phase === 'OFF' || state.phase === 'ERROR' || !state.pending) return;
      const host = state.host.getState();
      if (host.paused) return;
      if (host.currentTime >= state.pending.plan.startAt - 0.35) {
        clearInterval(state.timer); state.timer = null;
        void takeOverAndMix();
      }
    }, 120);
  }

  async function takeOverAndMix() {
    if (!state.pending || !state.currentEntry) return;
    const host = state.host.getState();
    const position = host.currentTime;
    try {
      state.deckA.loadBuffer(state.currentEntry.buffer);
      state.deckA.setEQ(0, 0, 0);
      state.deckA.setFilter(0);
      state.deckA.setCrossfader(0.5);
      state.deckA.fadeTo(1, 0.01);
      await state.deckA.play(position, 1);
      if (state.deckA.paused) throw new Error('Deck A не запустился');
      const audio = state.host.getAudio ? state.host.getAudio() : null;
      if (audio) audio.pause();
      state.ownsPlayback = true;
      await executeTransition();
    } catch (error) {
      if (state.ownsPlayback) {
        state.ownsPlayback = false;
        try { const audio = state.host.getAudio ? state.host.getAudio() : null; if (audio) audio.play(); } catch (_) {}
      }
      setPhase('DEGRADED');
      log('Переход отложен, стандартный плеер продолжает играть: ' + (error && error.message ? error.message : String(error)));
    }
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
      await withTimeout(new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!state.engine || state.phase === 'OFF') { clearInterval(timer); resolve(); return; }
          const elapsed = state.ctx.currentTime - tokenStart;
          if (elapsed >= pending.plan.durationSec) { clearInterval(timer); resolve(); }
        }, 80);
      }), (pending.plan.durationSec + 10) * 1000, 'transition');
      if (state.phase === 'OFF') return;
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
      if (state.ownsPlayback) {
        const position = state.deckA ? state.deckA.currentTime : 0;
        state.ownsPlayback = false;
        try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
        if (state.host && typeof state.host.onExit === 'function') state.host.onExit({ position });
      }
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
      ownsPlayback: state.ownsPlayback,
      currentReady: !!state.currentEntry,
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
    ownsPlayback() { return state.ownsPlayback; },
    releaseToStandard,
    _state: state,
  };
})();
