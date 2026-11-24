/* RH-MUSIC · AI AutoMix controller.
   Wires the vendored RH-AI-DJ-ENGINE Core/AudioEngine to the existing RH-MUSIC
   player. No second user-facing player: the engine decks are technical channels. */
(function () {
  'use strict';

  const CONTROLLER_BASE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
    || (typeof location !== 'undefined' ? location.href : 'https://rh-music.pages.dev/');
  const MODULE_BASE = new URL('.', CONTROLLER_BASE);

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
    policy: null,
    transitionSeq: 0,
    deckA: null,
    deckB: null,
    activeTrack: null,
    activeIndex: -1,
    pending: null,
    activePlan: null,
    currentEntry: null,
    ownsPlayback: false,
    trackToken: 0,
    planEpoch: 0,
    cache: new Map(),
    timer: null,
    busy: false,
    preparing: false,
    paused: false,
    diagnostics: [],
    fallbackPool: [],
    fallbackActive: false,
    playedIds: new Set(),
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
    const previous = state.phase;
    state.phase = phase;
    if (typeof step === 'number') state.step = step;
    emit();
    // DEGRADED — не рабочее состояние AutoMix: выключаем режим, чтобы
    // пользователь мог запустить его заново одной кнопкой.
    if (phase === 'DEGRADED' && previous !== 'DEGRADED' && previous !== 'OFF') {
      window.setTimeout(() => {
        if (state.phase === 'DEGRADED') disable();
      }, 0);
    }
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
    // Каталог отдаёт MP3, SoundCloud — HLS. Хост сам решает, как получить
    // единый ArrayBuffer: для HLS склеивает init + fMP4-сегменты.
    let data;
    if (state.host && typeof state.host.fetchAudioBytes === 'function') {
      data = await state.host.fetchAudioBytes(track, url);
    } else {
      const response = await fetch(url, { headers: { Accept: 'audio/mpeg' } });
      if (!response.ok) throw new Error('stream HTTP ' + response.status);
      data = await response.arrayBuffer();
    }
    if (!data || data.byteLength < 1024) throw new Error('stream too short');
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
      state.lib = await withTimeout(import('./automix-engine.js?v=6'), 15_000, 'engine module');
      try {
        state.policy = await import(new URL('transition-policy.js?v=2', MODULE_BASE).href);
      } catch {
        state.policy = null; // политика не критична: движок продолжает работать
      }
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

  function teardownEngine() {
    if (state.engine) {
      try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
    }
    try { if (state.ctx && typeof state.ctx.close === 'function') state.ctx.close(); } catch (_) {}
    state.engine = null;
    state.ctx = null;
    state.deckA = null;
    state.deckB = null;
  }

  function resetDeck(deck) {
    if (!deck) return;
    try {
      deck.cancelAutomation();
      deck.setRate(1);
      deck.setEQ(0, 0, 0);
      deck.setFilter(0);
      deck.setEcho(0);
      deck.setReverb(0);
      deck.fadeTo(0, 0.01);
    } catch { /* дек мог быть уже остановлен */ }
  }

  function resetDecks() {
    resetDeck(state.deckA);
    resetDeck(state.deckB);
  }

  /** Отмена перехода с возвратом управления стандартному плееру. */
  function cancelTransition(reason = 'cancelled', position = null) {
    state.transitionSeq += 1;
    state.planEpoch += 1;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.pending = null;
    state.activePlan = null;
    resetDecks();
    try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
    const wasOwned = state.ownsPlayback;
    state.ownsPlayback = false;
    state.busy = false;
    state.preparing = false;
    if (state.phase === 'MIXING') setPhase('ACTIVE');
    if (wasOwned && state.host && typeof state.host.onExit === 'function') {
      const pos = position == null
        ? (state.deckA ? state.deckA.currentTime : 0)
        : Math.max(0, Number(position) || 0);
      state.host.onExit({ position: pos });
      // После возврата в стандартный плеер продолжаем планировать следующий
      // переход, иначе AutoMix остаётся включённым, но больше не микширует.
      setTimeout(() => {
        if (state.phase !== 'OFF' && state.phase !== 'ERROR' && state.currentEntry) void planNext();
      }, 400);
    }
    log('Переход отменён: ' + reason);
  }

  async function enable() {
    if (state.phase !== 'OFF' && state.phase !== 'ERROR') return;
    const epoch = state.planEpoch;
    state.error = null;
    try {
      await ensureEngine();
      if (epoch !== state.planEpoch || state.phase === 'OFF') return;
      const current = state.host.getState().current;
      if (current) await onTrackStarted(current);
    } catch (error) {
      if (epoch !== state.planEpoch || state.phase === 'OFF') return;
      fail(error && error.message ? error.message : String(error));
    }
  }

  function disable() {
    state.planEpoch += 1;
    const position = state.deckA ? state.deckA.currentTime : 0;
    const owned = state.ownsPlayback;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    resetDecks();
    teardownEngine();
    state.pending = null;
    state.activePlan = null;
    state.currentEntry = null;
    state.activeTrack = null;
    state.activeIndex = -1;
    state.ownsPlayback = false;
    state.busy = false;
    state.preparing = false;
    setPhase('OFF', -1);
    if (owned && state.host && typeof state.host.onExit === 'function') state.host.onExit({ position });
    log('AI AutoMix выключен');
  }

  function releaseToStandard(restart = true) {
    if (!state.ownsPlayback) return;
    state.planEpoch += 1;
    state.transitionSeq += 1;
    const position = state.deckA ? state.deckA.currentTime : 0;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.pending = null;
    state.activePlan = null;
    state.ownsPlayback = false;
    resetDecks();
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
    state.planEpoch += 1;
    state.activeTrack = track;
    state.paused = false;
    state.fallbackActive = false;
    state.activeIndex = state.host.getState().index;
    state.ownsPlayback = false;
    const token = ++state.trackToken;
    setPhase('ANALYZING');
    log('Фоновый анализ: ' + track.title);
    try {
      const entry = await decode(track);
      if (token !== state.trackToken || !state.activeTrack || String(state.activeTrack.id) !== String(track.id)) return;
      state.currentEntry = entry;
      setPhase('ACTIVE');
      await planNext();
    } catch (error) {
      if (state.phase === 'OFF') return;
      setPhase('DEGRADED');
      log('Анализ не удался, обычное воспроизведение продолжается: ' + (error && error.message ? error.message : String(error)));
    }
  }

  function trimCache(keepIds) {
    const keep = new Set(keepIds.map(String));
    for (const key of [...state.cache.keys()]) if (!keep.has(String(key))) state.cache.delete(key);
  }

  function queueCandidates() {
    if (state.fallbackActive) return [];
    const hostState = state.host.getState();
    const queue = Array.isArray(hostState.queue) ? hostState.queue : [];
    if (!queue.length) return [];
    const activeIndex = Number.isInteger(hostState.index) && hostState.index >= 0 ? hostState.index : 0;
    const out = [];
    for (let offset = 1; offset <= queue.length; offset += 1) {
      const index = (activeIndex + offset) % queue.length;
      const track = queue[index];
      if (!track || !track.id) continue;
      if (state.activeTrack && String(track.id) === String(state.activeTrack.id)) continue;
      out.push({ track, index });
      if (out.length >= 3) break;
    }
    return out;
  }

  async function fallbackCandidates() {
    if (!state.host || typeof state.host.getFallbackTracks !== 'function') return [];
    if (!state.fallbackPool.length) {
      try {
        const list = await state.host.getFallbackTracks();
        state.fallbackPool = (Array.isArray(list) ? list : [])
          .filter((track) => track && track.id)
          .filter((track) => !state.playedIds.has(String(track.id)))
          .filter((track) => !state.activeTrack || String(track.id) !== String(state.activeTrack.id));
        log('AI автономный источник: ' + state.fallbackPool.length + ' треков');
      } catch (error) {
        log('Автономный источник недоступен: ' + (error && error.message ? error.message : String(error)));
        return [];
      }
    }
    const out = [];
    while (out.length < 3 && state.fallbackPool.length) {
      const track = state.fallbackPool.shift();
      if (!track || !track.id || state.playedIds.has(String(track.id))) continue;
      out.push({ track, index: -1, fallback: true });
    }
    return out;
  }

  async function planNext() {
    if (state.busy || state.phase === 'OFF') return;
    let candidates = queueCandidates();
    if (!candidates.length) candidates = await fallbackCandidates();
    if (!candidates.length) { setPhase('DEGRADED'); log('Нет кандидата: очередь пуста и автономный источник недоступен'); return; }
    const candidate = candidates[0];
    const token = state.trackToken;
    const epoch = state.planEpoch;
    state.busy = true;
    state.preparing = true;
    try {
      if (!state.currentEntry) setPhase('PREPARING'); else emit();
      const entry = await decode(candidate.track);
      if (token !== state.trackToken || epoch !== state.planEpoch || !state.activeTrack) return;
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
      if (epoch !== state.planEpoch) return;
      if (!decision.chosen || !decision.plan) { setPhase('DEGRADED'); log('AI не нашёл переход: ' + decision.reason); return; }
      let plan = decision.plan;
      if (state.policy) {
        const assessment = state.policy.assessPlan(plan, {
          bpmA: state.currentEntry.analysis && state.currentEntry.analysis.bpm,
          bpmB: entry.analysis && entry.analysis.bpm,
        });
        if (!assessment.safe) {
          try {
            const safe = state.lib.planTransition(state.currentEntry.analysis, entry.analysis, playback, state.policy.safePlanOptions());
            if (safe) {
              plan = { ...safe, confidenceFallback: true, reasons: [...(safe.reasons || []), ...assessment.reasons] };
              log('Confidence fallback: ' + assessment.reasons.join('; '));
            }
          } catch (error) {
            log('Confidence fallback не удался, оставляю исходный план: ' + (error && error.message ? error.message : String(error)));
          }
        }
        const normalized = state.policy.clampPlanRates(plan, state.policy.MAX_RATE_DELTA);
        plan = normalized.plan;
        if (normalized.clamped) log('Tempo shift ограничен безопасным диапазоном');
      }
      state.pending = { track: candidate.track, entry, analysis: entry.analysis, plan, fallback: !!candidate.fallback };
      state.deckB.loadBuffer(entry.buffer);
      state.deckB.cancelAutomation();
      log('AI выбрал: ' + decision.chosen.title + ' · ' + decision.plan.strategy);
      state.preparing = false;
      setPhase('ACTIVE');
      scheduleWatch();
    } catch (error) {
      if (state.phase === 'OFF') return;
      setPhase('DEGRADED');
      log('Подготовка следующего трека не удалась; текущий трек продолжает играть: ' + (error && error.message ? error.message : String(error)));
    } finally {
      state.busy = false;
      state.preparing = false;
      emit();
    }
  }

  function scheduleWatch() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.phase === 'OFF' || state.phase === 'ERROR' || !state.pending) return;
      const host = state.host.getState();
      if (host.paused) return;
      if (host.currentTime > state.pending.plan.startAt + 2) {
        clearInterval(state.timer); state.timer = null;
        state.pending = null;
        log('Окно перехода упущено; план будет пересчитан');
        void planNext();
        return;
      }
      if (host.currentTime >= state.pending.plan.startAt - 0.15) {
        clearInterval(state.timer); state.timer = null;
        void takeOverAndMix();
      }
    }, 120);
  }

  async function takeOverAndMix() {
    if (!state.pending) return;
    const host = state.host.getState();
    const position = host.currentTime;
    try {
      if (!state.ownsPlayback) {
        if (!state.currentEntry) return;
        state.deckA.loadBuffer(state.currentEntry.buffer);
      // Align the incoming downbeat with the outgoing downbeat at takeover.
      // The outgoing deck starts at the live position, not exactly at plan.startAt;
      // without this offset the two kicks are up to ~200 ms apart.
      const plan = state.pending && state.pending.plan;
      if (plan) {
        const phaseLead = Math.max(0, Number(plan.startAt) - Number(position));
        if (phaseLead > 0.01) {
          plan.inStart = Math.max(0, Number(plan.inStart) - phaseLead);
          plan.reasons = [...(plan.reasons || []), `phase lead ${phaseLead.toFixed(3)}s compensated`];
        }
      }
      state.deckA.setEQ(0, 0, 0);
        state.deckA.setFilter(0);
        state.deckA.setCrossfader(0.5);
        state.deckA.fadeTo(1, 0.01);
        await state.deckA.play(position, 1);
        if (state.deckA.paused) throw new Error('Deck A не запустился');
        await new Promise((resolve) => setTimeout(resolve, 180));
        let peak = 0;
        try {
          const samples = state.engine.getMasterSamples();
          for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
        } catch (_) { peak = 0; }
        if (peak < 0.001) throw new Error('Deck A не дал аудиосигнала');
        state.ownsPlayback = true;
        const audio = state.host.getAudio ? state.host.getAudio() : null;
        if (audio) audio.pause();
      }
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

  function waitForTransition(tokenStart, durationSec, seq) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let pausedMs = 0;
      let last = started;
      const timer = setInterval(() => {
        if (seq !== state.transitionSeq || state.phase === 'OFF' || !state.engine) {
          clearInterval(timer);
          resolve();
          return;
        }
        const now = Date.now();
        if (state.paused) pausedMs += now - last;
        last = now;
        const wallLimit = (Number(durationSec) + 10) * 1000 + pausedMs;
        if (now - started > wallLimit) {
          clearInterval(timer);
          reject(new Error('transition timeout'));
          return;
        }
        if (!state.paused && state.ctx && (state.ctx.currentTime - tokenStart) >= Number(durationSec)) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Math.floor((now - started) / 100) % 2 === 0) emit();
      }, 80);
    });
  }

  async function executeTransition() {
    const pending = state.pending;
    if (!pending) return;
    state.pending = null;
    state.activePlan = pending;
    const seq = ++state.transitionSeq;
    try {
      setPhase('MIXING');
      const engine = state.engine;
      const outDeck = state.deckA;
      const inDeck = state.deckB;
      const startAt = await engine.beginTransition(pending.plan, outDeck, inDeck);
      await waitForTransition(startAt, pending.plan.durationSec, seq);
      if (seq !== state.transitionSeq || state.phase === 'OFF') return;
      engine.completeTransition(outDeck, inDeck);
      state.activePlan = null;
      state.deckA = inDeck;
      state.deckB = outDeck;
      state.activeTrack = pending.track;
      state.currentEntry = pending.entry;
      trimCache([String(pending.track.id)]);
      const hostState = state.host.getState();
      state.playedIds.add(String(pending.track.id));
      state.fallbackActive = !!pending.fallback;
      if (state.host && typeof state.host.onAdopt === 'function') state.host.onAdopt(pending.track, pending.plan.strategy);
      state.activeIndex = state.host.getState().index;
      log('Переход завершён: ' + pending.track.title);
      setPhase('ACTIVE');
      await planNext();
    } catch (error) {
      state.transitionSeq += 1;
      resetDecks();
      if (state.ownsPlayback) {
        const position = state.deckA ? state.deckA.currentTime : 0;
        state.ownsPlayback = false;
        try { state.deckA && state.deckA.stop(); state.deckB && state.deckB.stop(); } catch (_) {}
        if (state.host && typeof state.host.onExit === 'function') state.host.onExit({ position });
      }
      fail(error && error.message ? error.message : String(error));
    }
  }

  function invalidatePlan() {
    if (state.phase === 'MIXING') {
      cancelTransition('invalidate');
      return;
    }
    // Перемотка внутри трека не должна сдвигать уже рассчитанный переход:
    // если план относится к текущему треку и его точка ещё впереди, оставляем
    // его как есть, чтобы маркер перехода не «плавал» по шкале.
    const hostState = state.host && typeof state.host.getState === 'function' ? state.host.getState() : null;
    const pending = state.pending;
    const activeId = state.activeTrack ? String(state.activeTrack.id) : '';
    if (pending && pending.plan && hostState && Number.isFinite(Number(hostState.currentTime))
        && Number(hostState.currentTime) < Number(pending.plan.startAt) - 1.5
        && hostState.current && activeId && String(hostState.current.id) === activeId) {
      emit();
      return;
    }
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.planEpoch += 1;
    state.pending = null;
    state.activePlan = null;
    if (state.phase !== 'OFF' && state.phase !== 'ERROR') {
      setPhase(state.ownsPlayback ? 'ACTIVE' : 'ANALYZING');
      setTimeout(() => { if (state.phase !== 'OFF') void planNext(); }, 350);
    }
  }

  function seek(position) {
    if (state.phase === 'MIXING') {
      const target = Math.max(0, Number(position) || 0);
      cancelTransition('seek', target);
      return true;
    }
    if (!state.ownsPlayback || !state.deckA) return false;
    state.planEpoch += 1;
    const target = Math.max(0, Math.min(Number(position) || 0, state.deckA.duration - 0.05));
    state.deckA.seek(target);
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.pending = null;
    setTimeout(() => { if (state.phase !== 'OFF') void planNext(); }, 350);
    return true;
  }

  function pause() {
    state.paused = true;
    try { state.deckA && state.deckA.pause(); state.deckB && state.deckB.pause(); } catch (_) {}
    try { if (state.ctx && typeof state.ctx.suspend === 'function') state.ctx.suspend(); } catch (_) {}
    emit();
  }

  function resume() {
    state.paused = false;
    try { if (state.ctx && typeof state.ctx.resume === 'function') state.ctx.resume(); } catch (_) {}
    try {
      if (state.deckA && state.deckA.paused && state.deckA.currentTime < state.deckA.duration) state.deckA.play(state.deckA.currentTime, 1);
      if (state.phase === 'MIXING' && state.deckB && state.deckB.paused) state.deckB.play(state.deckB.currentTime, state.deckB.bufferRate || 1);
    } catch (_) {}
    emit();
  }

  function getState() {
    return {
      phase: state.phase,
      step: state.step,
      steps: LOAD_STEPS,
      error: state.error,
      active: state.phase !== 'OFF' && state.phase !== 'ERROR',
      preparing: !!state.preparing,
      paused: !!state.paused,
      ownsPlayback: state.ownsPlayback,
      currentReady: !!state.currentEntry,
      activeTrack: state.activeTrack,
      nextTrack: state.pending ? state.pending.track : null,
      strategy: state.pending ? state.pending.plan.strategy : null,
      mix: (() => {
        const plan = state.activePlan || state.pending;
        if (!plan) return null;
        const progress = state.activePlan && state.deckA ? Math.max(0, Math.min(1, (state.deckA.currentTime - plan.plan.startAt) / Math.max(0.1, plan.plan.durationSec))) : 0;
        return { startAt: plan.plan.startAt, durationSec: plan.plan.durationSec, endAt: plan.plan.startAt + plan.plan.durationSec, strategy: plan.plan.strategy, progress, incoming: plan.track ? { title: plan.track.title, artist: plan.track.artist } : null };
      })(),
      deckA: state.deckA ? { time: state.deckA.currentTime, duration: state.deckA.duration, paused: state.deckA.paused } : null,
      deckB: state.deckB ? { time: state.deckB.currentTime, duration: state.deckB.duration, paused: state.deckB.paused } : null,
      meter: state.engine && typeof state.engine.metrics === 'function' ? state.engine.metrics() : null,
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
    seek,
    invalidatePlan,
    getState,
    getDiagnostics,
    isActive() { return state.phase !== 'OFF' && state.phase !== 'ERROR'; },
    ownsPlayback() { return state.ownsPlayback; },
    releaseToStandard,
    cancelTransition,
    _state: state,
    _internal: { queueCandidates, fallbackCandidates },
  };
})();
