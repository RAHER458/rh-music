/* ==========================================================================
   RH Smart Mix — музыкальные переходы между треками.

   Архитектура:
   • анализ: короткий префикс потока (Range) декодируется OfflineAudioContext,
     по энергии онсетов определяются BPM, фаза бита, downbeat и уверенность;
   • планировщик: выбирает downbeat/фразу ближе к концу текущего трека,
     длину в тактах, точку входа следующего и умеренную коррекцию темпа;
   • воспроизведение: второй <audio> только на время перехода, Web Audio
     (gain + low-shelf EQ + limiter) для музыкального смешивания; при
     отсутствии AudioContext — аккуратный equal-power фолбэк без EQ.

   По умолчанию выключено. При любой ошибке плеер продолжает обычную работу.
   ========================================================================== */
(function (global) {
  'use strict';

  const SETTINGS_KEY = 'rh_smartmix_v1';
  const CACHE_KEY = 'rh_smartmix_cache_v1';
  const ANALYSIS_VERSION = 1;
  const PREFIX_BYTES = 512 * 1024;
  const MIN_CONFIDENCE = 0.42;
  const GOOD_CONFIDENCE = 0.55;
  const MAX_RATE_DELTA = 0.04;
  const MAX_CACHE = 160;

  const DEFAULTS = { enabled: false, bars: 8, preload: true };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /* ───────────────────────────── настройки ───────────────────────────── */

  function sanitizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const bars = [4, 8, 16].includes(Number(source.bars)) ? Number(source.bars) : DEFAULTS.bars;
    return { enabled: source.enabled === true, bars, preload: source.preload !== false };
  }

  function loadSettings() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(SETTINGS_KEY);
      return sanitizeSettings(raw ? JSON.parse(raw) : DEFAULTS);
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(settings) {
    try {
      global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* приватный режим */ }
  }

  /* ───────────────────────────── анализ ───────────────────────────── */

  /**
   * Лёгкий детектор темпа по онсетам.
   * @param {Float32Array} samples моно-сигнал
   * @param {number} sampleRate
   * @returns {{bpm:number, offset:number, confidence:number, period:number,
   *            downbeatOffset:number, downbeatConfidence:number, energy:number}}
   */
  function detectTempo(samples, sampleRate) {
    const hop = 512;
    const frame = 1024;
    const length = Math.max(0, Math.floor((samples.length - frame) / hop));
    if (length < 80) return null;

    const energy = new Float32Array(length);
    let total = 0;
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      const offset = i * hop;
      for (let j = 0; j < frame; j += 4) {
        const value = samples[offset + j] || 0;
        sum += value * value;
      }
      energy[i] = Math.sqrt(sum / (frame / 4));
      total += energy[i];
    }
    const mean = total / length || 1;
    const onset = new Float32Array(length);
    let onsetSum = 0;
    for (let i = 1; i < length; i += 1) {
      const value = Math.max(0, energy[i] - energy[i - 1]);
      onset[i] = Math.max(0, value / mean - 0.02);
      onsetSum += onset[i];
    }
    if (onsetSum <= 0) return null;
    for (let i = 0; i < length; i += 1) onset[i] /= onsetSum;

    const minLag = Math.max(2, Math.floor((60 / 180) * sampleRate / hop));
    const maxLag = Math.min(length - 2, Math.ceil((60 / 70) * sampleRate / hop));
    const scores = new Float32Array(maxLag + 1);
    let bestLag = 0;
    let bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let sum = 0;
      for (let i = 0; i + lag < length; i += 1) sum += onset[i] * onset[i + lag];
      scores[lag] = sum / Math.max(1, length - lag);
      if (scores[lag] > bestScore) { bestScore = scores[lag]; bestLag = lag; }
    }
    if (!bestLag || bestScore <= 0) return null;

    let lag = bestLag;
    if (lag > minLag && lag < maxLag) {
      const left = scores[lag - 1];
      const right = scores[lag + 1];
      const denom = left - 2 * scores[lag] + right;
      if (denom !== 0) {
        const delta = 0.5 * (left - right) / denom;
        if (Math.abs(delta) < 0.5) lag += delta;
      }
    }

    let bpm = 60 / (lag * hop / sampleRate);
    // Half-time/double-time: приводим к рабочему диапазону один раз.
    if (bpm < 80) bpm *= 2;
    if (bpm > 170) bpm /= 2;
    if (bpm < 70 || bpm > 180) return null;

    // Насколько пик автокорреляции выделяется над средним уровнем.
    let scoreSum = 0;
    let scoreCount = 0;
    for (let l = minLag; l <= maxLag; l += 1) { scoreSum += scores[l]; scoreCount += 1; }
    const scoreMean = scoreSum / Math.max(1, scoreCount);
    const prominence = bestScore / Math.max(1e-9, scoreMean);
    const confidence = clamp((prominence - 1.25) / 1.6, 0, 1);
    const period = 60 / bpm;

    // Фаза: сдвиг сетки, при котором сумма онсетов максимальна.
    const periodFrames = period * sampleRate / hop;
    let phase = 0;
    let phaseScore = -1;
    for (let shift = 0; shift < Math.max(2, Math.round(periodFrames)); shift += 1) {
      let sum = 0;
      for (let pos = shift; pos < length; pos += periodFrames) sum += onset[Math.floor(pos)] || 0;
      if (sum > phaseScore) { phaseScore = sum; phase = shift; }
    }
    const offset = (phase * hop) / sampleRate;

    // Downbeat: из четырёх долей выбираем ту, где в среднем сильнее низ.
    const low = new Float32Array(length);
    const alpha = 1 - Math.exp(-2 * Math.PI * 150 / sampleRate);
    let lowState = 0;
    for (let i = 0; i < length; i += 1) {
      const start = i * hop;
      let sum = 0;
      for (let j = 0; j < hop; j += 2) {
        lowState += alpha * ((samples[start + j] || 0) - lowState);
        sum += lowState * lowState;
      }
      low[i] = sum;
    }
    let downbeatPhase = 0;
    let bestPhase = -1;
    for (let p = 0; p < 4; p += 1) {
      let sum = 0;
      let count = 0;
      for (let pos = phase + p * periodFrames; pos < length; pos += periodFrames * 4) {
        sum += low[Math.floor(pos)] || 0;
        count += 1;
      }
      const avg = count ? sum / count : 0;
      if (avg > bestPhase) { bestPhase = avg; downbeatPhase = p; }
    }
    let downbeatOffset = offset + downbeatPhase * period;
    downbeatOffset %= period * 4;

    return {
      bpm: Math.round(bpm * 10) / 10,
      offset,
      confidence,
      period,
      downbeatOffset,
      downbeatConfidence: clamp(bestPhase / (mean + 1e-6) / 8, 0, 1),
      energy: clamp(mean / 0.25, 0, 1),
    };
  }

  function analyzeAudioBuffer(buffer) {
    if (!buffer || !buffer.length) return null;
    const channels = Math.min(2, buffer.numberOfChannels);
    const maxSamples = Math.min(buffer.length, Math.floor(buffer.sampleRate * 40));
    const mono = new Float32Array(maxSamples);
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < maxSamples; i += 1) mono[i] += data[i] / channels;
    }
    return detectTempo(mono, buffer.sampleRate);
  }

  function barsToSeconds(bars, bpm) {
    if (!Number.isFinite(bpm) || bpm <= 0) return 0;
    return (Number(bars) * 4 * 60) / bpm;
  }

  /* ───────────────────────────── планирование ───────────────────────────── */

  function planTransition(current, next, options = {}) {
    const bars = [4, 8, 16].includes(Number(options.bars)) ? Number(options.bars) : 8;
    const now = Number(options.now) || 0;
    const duration = Number(current && current.duration) || 0;
    if (!next || duration < 12) return null;

    const cur = current.analysis;
    const nxt = next.analysis;
    const reliable = cur && nxt
      && cur.confidence >= MIN_CONFIDENCE
      && nxt.confidence >= MIN_CONFIDENCE
      && cur.bpm >= 60 && nxt.bpm >= 60;

    let length = 6;
    let mode = 'fallback';
    let rate = 1;
    let startAt = Math.max(0, duration - length - 0.2);
    let incomingStart = 0;
    let phrase = false;
    let anchored = false;

    if (reliable) {
      mode = 'beat';
      length = clamp(barsToSeconds(bars, cur.bpm), 6, 42);
      const period = cur.period;
      const beatFrames = period;
      const downbeat = cur.downbeatOffset;
      const target = duration - length - 0.15;
      let best = null;
      let bestDistance = Infinity;
      // Ищем downbeat, по возможности на границе 8-тактовой фразы.
      for (let k = 0; k < 200; k += 1) {
        const time = downbeat + k * beatFrames * 4;
        if (time > target + 0.5) break;
        if (time < target - beatFrames * 8) continue;
        const distance = Math.abs(target - time);
        const onPhrase = k % 8 === 0;
        const score = distance - (onPhrase ? beatFrames * 2 : 0);
        if (score < bestDistance) { bestDistance = score; best = { time, onPhrase }; }
      }
      if (best && best.time >= now + 0.4 && duration - best.time >= length * 0.75) {
        startAt = best.time;
        phrase = best.onPhrase;
        anchored = true;
      } else {
        startAt = Math.max(now + 0.2, target);
      }

      incomingStart = Number(nxt.downbeatOffset) || 0;
      if (incomingStart > 30) incomingStart = 0;

      const ratio = cur.bpm / nxt.bpm;
      if (cur.confidence >= GOOD_CONFIDENCE && nxt.confidence >= GOOD_CONFIDENCE
        && ratio >= 1 - MAX_RATE_DELTA && ratio <= 1 + MAX_RATE_DELTA) {
        rate = ratio;
      }
    }

    // Если музыкальный якорь не найден или переход не помещается до конца,
    // не растягиваем его искусственно: короткий безопасный fallback.
    if (mode === 'beat' && (!anchored || startAt + length > duration - 0.2)) {
      const available = duration - startAt - 0.2;
      if (anchored && available >= 6) {
        length = available;
      } else {
        mode = 'fallback';
        length = 6;
        startAt = duration - length - 0.2;
        incomingStart = 0;
        rate = 1;
        phrase = false;
      }
    }

    if (!Number.isFinite(startAt) || startAt < now - 0.5) return null;
    if (startAt >= duration - 0.5) return null;
    return {
      mode,
      bars,
      duration: length,
      startAt,
      endAt: startAt + length,
      incomingStart,
      rate,
      phrase,
      currentBpm: cur ? cur.bpm : null,
      nextBpm: nxt ? nxt.bpm : null,
      confidence: cur && nxt ? Math.min(cur.confidence, nxt.confidence) : 0,
    };
  }

  /* ───────────────────────────── кеш анализа ───────────────────────────── */

  function loadCache() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCache(cache) {
    try {
      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHE) {
        keys.slice(0, keys.length - MAX_CACHE).forEach((key) => { delete cache[key]; });
      }
      global.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* ignore */ }
  }

  function cachedAnalysis(id) {
    const entry = loadCache()[id];
    if (!entry || entry.v !== ANALYSIS_VERSION) return null;
    return entry.analysis || null;
  }

  function storeAnalysis(id, analysis) {
    const cache = loadCache();
    cache[id] = { v: ANALYSIS_VERSION, analysis, at: Date.now() };
    saveCache(cache);
  }

  /* ───────────────────────────── движок ───────────────────────────── */

  let decodeContext = null;

  const engine = {
    settings: loadSettings(),
    host: null,
    supported: null,
    graph: null,
    mix: null,
    mixSource: null,
    mixGain: null,
    mixLow: null,
    outGain: null,
    outLow: null,
    phase: 'idle',
    plan: null,
    timer: null,
    analyserTimer: null,
    currentTrack: null,
    analyses: new Map(),
    pending: new Map(),
    generation: 0,
    analysisController: null,
    failedTrack: null,
    preload: null,
    preloadGen: 0,
    retired: [],
    mixBound: false,
  };

  const internal = {
    detectTempo,
    analyzeAudioBuffer,
    planTransition,
    barsToSeconds,
    sanitizeSettings,
    clamp,
  };
  void internal;

  function emit() {
    if (engine.host && typeof engine.host.onChange === 'function') {
      engine.host.onChange({ settings: engine.settings, supported: engine.supported, phase: engine.phase });
    }
  }

  function ensureGraph() {
    if (engine.graph) {
      const ctx = engine.graph.ctx;
      if (ctx.state === 'running') return Promise.resolve(true);
      return Promise.race([
        ctx.resume().then(() => ctx.state === 'running'),
        new Promise((resolve) => setTimeout(() => resolve(false), 1200)),
      ]).catch(() => false);
    }
    if (engine.supported === false) return Promise.resolve(false);
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx || !engine.host || !engine.host.getAudio) {
      engine.supported = false;
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let ctx;
      try {
        ctx = new Ctx();
      } catch {
        engine.supported = false;
        resolve(false);
        return;
      }
      const finish = (ok) => {
        if (!ok) {
          engine.supported = false;
          try { ctx.close(); } catch { /* ignore */ }
          emit();
          resolve(false);
          return;
        }
        try {
          const audio = engine.host.getAudio();
          const source = ctx.createMediaElementSource(audio);
          const outLow = ctx.createBiquadFilter();
          outLow.type = 'lowshelf';
          outLow.frequency.value = 180;
          outLow.gain.value = 0;
          const outGain = ctx.createGain();
          outGain.gain.value = 1;
          const master = ctx.createGain();
          master.gain.value = 1;
          const limiter = ctx.createDynamicsCompressor();
          limiter.threshold.value = -3;
          limiter.knee.value = 0;
          limiter.ratio.value = 12;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.25;
          source.connect(outLow);
          outLow.connect(outGain);
          outGain.connect(master);
          master.connect(limiter);
          limiter.connect(ctx.destination);
          engine.graph = { ctx, source, outLow, outGain, master, limiter };
          engine.outGain = outGain;
          engine.outLow = outLow;
          engine.supported = true;
          try {
            const volumeState = engine.host.getState();
            audio.volume = 1;
            master.gain.value = volumeState.muted ? 0 : volumeState.volume;
          } catch { /* ignore */ }
          emit();
          ctx.onstatechange = () => {
            if (ctx.state === 'running') return;
            if (ctx.state === 'suspended' && !engine.host.getState().paused) {
              ctx.resume().catch(() => {});
            }
          };
          resolve(true);
        } catch {
          engine.supported = false;
          try { ctx.close(); } catch { /* ignore */ }
          resolve(false);
        }
      };
      const resume = () => {
        if (ctx.state === 'running') { finish(true); return; }
        Promise.race([
          ctx.resume(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('resume timeout')), 1200)),
        ]).then(() => finish(ctx.state === 'running')).catch(() => finish(false));
      };
      // AudioContext может стартовать только из пользовательского жеста.
      resume();
    });
  }

  function ensureMixElement() {
    if (engine.mix) return engine.mix;
    const el = global.document.createElement('audio');
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
    global.document.body.appendChild(el);
    engine.mix = el;
    bindMixElement(el);
    return el;
  }

  /* ───────────────────────── предзагрузка следующего трека ───────────────────────── */

  function networkProfile() {
    const nav = global.navigator || {};
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (connection && connection.saveData) return { name: 'saver', target: 4, retries: 0 };
    const type = connection && connection.effectiveType;
    if (type === 'slow-2g' || type === '2g') return { name: 'slow', target: 4, retries: 1 };
    if (type === '3g') return { name: 'medium', target: 6, retries: 1 };
    if (connection && Number(connection.downlink) && Number(connection.downlink) < 0.7) {
      return { name: 'slow', target: 4, retries: 1 };
    }
    if (connection && Number(connection.rtt) > 700) return { name: 'slow', target: 4, retries: 1 };
    if (nav.deviceMemory && Number(nav.deviceMemory) <= 2) return { name: 'medium', target: 6, retries: 1 };
    if (!connection) return { name: 'balanced', target: 7, retries: 1 };
    return { name: 'fast', target: 10, retries: 2 };
  }

  /** Сколько секунд аудио реально доступно начиная с позиции from. */
  function bufferAhead(element, from) {
    if (!element || !element.buffered) return 0;
    const start = Math.max(0, Number(from) || 0);
    let best = 0;
    for (let i = 0; i < element.buffered.length; i += 1) {
      const rangeStart = Number(element.buffered.start(i));
      const rangeEnd = Number(element.buffered.end(i));
      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) continue;
      if (rangeEnd <= start + 0.1 || rangeStart > start + 0.35) continue;
      best = Math.max(best, rangeEnd - start);
    }
    return best;
  }

  function checkPreload() {
    const preload = engine.preload;
    if (!preload) return;
    const el = preload.element;
    if (el.error) {
      if (preload.state !== 'failed' && preload.retries < preload.maxRetries && Date.now() - preload.startedAt < 25000) {
        preload.retries += 1;
        preload.state = 'retrying';
        preload.retryTimer = setTimeout(() => {
          if (engine.preload !== preload) return;
          try { el.load(); } catch { /* ignore */ }
        }, 1500);
        emit();
      } else if (preload.state !== 'failed') {
        preload.state = 'failed';
        preload.ready = false;
        preload.error = el.error ? el.error.code : 'error';
        emit();
      }
      return;
    }
    if (preload.srcUrl && el.currentSrc && el.currentSrc !== preload.srcUrl) return;
    const ahead = bufferAhead(el, preload.from);
    preload.ahead = ahead;
    const enough = Math.min(preload.target, 5);
    if (el.readyState >= 3 && ahead >= enough && ahead >= 2.5) {
      if (!preload.ready) {
        preload.ready = true;
        preload.state = 'ready';
        try { el.preload = 'metadata'; } catch { /* ignore */ }
        emit();
      }
    } else if (preload.ready && ahead < 1.5) {
      preload.ready = false;
      preload.state = 'loading';
      emit();
    }
    if (ahead > 45 && !preload.capped) {
      preload.capped = true;
      try { el.preload = 'metadata'; } catch { /* ignore */ }
    }
  }

  function updatePreloadStart(preload) {
    if (!preload || engine.preload !== preload) return;
    const analysis = engine.analyses.get(String(preload.trackId));
    const from = analysis && Number.isFinite(analysis.downbeatOffset) ? analysis.downbeatOffset : 0;
    if (Math.abs(from - preload.from) > 0.05) {
      preload.from = from;
      if (preload.element.readyState >= 1) {
        try { preload.element.preload = 'auto'; } catch { /* ignore */ }
        try { preload.element.currentTime = from; } catch { /* ignore */ }
      }
    }
    checkPreload();
  }

  function bindMixElement(element) {
    if (engine.mixBound) return;
    engine.mixBound = true;
    const onChange = () => {
      const preload = engine.preload;
      if (!preload || preload.element !== element) return;
      if (preload.srcUrl && element.currentSrc && element.currentSrc !== preload.srcUrl) return;
      if (element.readyState >= 1 && Math.abs(element.currentTime - preload.from) > 0.4) {
        try { element.currentTime = preload.from; } catch { /* ignore */ }
      }
      checkPreload();
    };
    ['loadedmetadata', 'progress', 'canplay', 'canplaythrough', 'seeked', 'suspend'].forEach((type) => {
      element.addEventListener(type, onChange);
    });
    element.addEventListener('stalled', () => {
      const preload = engine.preload;
      if (preload && preload.element === element) preload.stalled = true;
    });
    element.addEventListener('error', checkPreload);
  }

  function cancelPreload(reason, keepSource) {
    const preload = engine.preload;
    engine.preload = null;
    if (!preload) return;
    if (preload.retryTimer) { clearTimeout(preload.retryTimer); preload.retryTimer = null; }
    if (preload.element) {
      try { preload.element.pause(); } catch { /* ignore */ }
      if (!keepSource) {
        try { preload.element.removeAttribute('src'); preload.element.load(); } catch { /* ignore */ }
      }
    }
    emit();
  }

  function retirePreload(preload) {
    if (!preload) return;
    preload.retiredAt = Date.now();
    engine.retired.push(preload);
    while (engine.retired.length > 6) {
      const old = engine.retired.shift();
      if (old && old.retryTimer) clearTimeout(old.retryTimer);
    }
    preload.cleanupTimer = setTimeout(() => {
      const index = engine.retired.indexOf(preload);
      if (index >= 0) engine.retired.splice(index, 1);
      if (preload.retryTimer) clearTimeout(preload.retryTimer);
      const el = preload.element;
      if (el && engine.preload && engine.preload.element === el) return;
      if (el && engine.mix === el) {
        try { el.pause(); } catch { /* ignore */ }
        try { el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
      }
      preload.element = null;
      emit();
    }, 15000);
  }

  function prepareNext(state) {
    if (!engine.settings.enabled || !engine.settings.preload) {
      cancelPreload('off');
      return;
    }
    if (engine.phase !== 'idle') return;
    if (!state || !state.current || state.paused) {
      cancelPreload('paused');
      return;
    }
    const next = nextTrackFor(state);
    if (!next) { cancelPreload('none'); return; }
    const current = engine.preload;
    if (current && String(current.trackId) === String(next.track.id) && current.index === next.index) {
      updatePreloadStart(current);
      return;
    }
    const el = ensureMixElement();
    bindMixElement(el);
    cancelPreload('replace', true);
    const profile = networkProfile();
    const preload = {
      element: el,
      trackId: String(next.track.id),
      index: next.index,
      track: next.track,
      srcUrl: '',
      generation: ++engine.preloadGen,
      target: profile.target,
      profile: profile.name,
      maxRetries: profile.retries,
      retries: 0,
      from: 0,
      ahead: 0,
      ready: false,
      state: 'loading',
      startedAt: Date.now(),
      error: null,
    };
    engine.preload = preload;
    try { el.pause(); } catch { /* ignore */ }
    el.preload = 'auto';
    el.volume = 0;
    el.muted = false;
    el.playbackRate = 1;
    try { el.preservesPitch = true; } catch { /* ignore */ }
    el.src = engine.host.streamUrl(next.track);
    preload.srcUrl = el.src || el.currentSrc || '';
    el.load();
    const analysis = engine.analyses.get(String(next.track.id));
    if (analysis && Number.isFinite(analysis.downbeatOffset)) preload.from = analysis.downbeatOffset;
    checkPreload();
    emit();
  }

  function isPreloadReady(plan) {
    const preload = engine.preload;
    if (!preload || !plan || !plan.nextTrack) return false;
    if (String(preload.trackId) !== String(plan.nextTrack.id) || preload.index !== plan.nextIndex) return false;
    const el = preload.element;
    if (!el || el.error || el.readyState < 3) return false;
    const ahead = bufferAhead(el, plan.incomingStart || 0);
    preload.ahead = ahead;
    return ahead >= Math.min(preload.target, 5) && ahead >= 2.5;
  }

  function connectMixSource() {
    const ctx = engine.graph && engine.graph.ctx;
    const mix = engine.mix;
    if (!ctx || !mix || engine.mixSource) return true;
    try {
      const source = ctx.createMediaElementSource(mix);
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 180;
      low.gain.value = -22;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(low);
      low.connect(gain);
      gain.connect(engine.graph.master);
      engine.mixSource = source;
      engine.mixLow = low;
      engine.mixGain = gain;
      return true;
    } catch {
      return false;
    }
  }

  function scheduleCurves(duration) {
    const ctx = engine.graph.ctx;
    const now = ctx.currentTime;
    const points = 48;
    const out = engine.outGain.gain;
    const mix = engine.mixGain.gain;
    out.cancelScheduledValues(now);
    mix.cancelScheduledValues(now);
    out.setValueAtTime(1, now);
    mix.setValueAtTime(0.0001, now);
    for (let i = 1; i <= points; i += 1) {
      const t = i / points;
      const time = now + t * duration;
      out.linearRampToValueAtTime(Math.cos(t * Math.PI / 2), time);
      mix.linearRampToValueAtTime(Math.sin(t * Math.PI / 2), time);
    }
    const lowOut = engine.outLow.gain;
    const lowMix = engine.mixLow.gain;
    lowOut.cancelScheduledValues(now);
    lowMix.cancelScheduledValues(now);
    lowOut.setValueAtTime(0, now);
    lowOut.linearRampToValueAtTime(-20, now + duration * 0.55);
    lowMix.setValueAtTime(-22, now);
    lowMix.linearRampToValueAtTime(-22, now + duration * 0.45);
    lowMix.linearRampToValueAtTime(0, now + duration * 0.8);
  }

  function cleanupMix(pause) {
    if (engine.timer) { clearTimeout(engine.timer); engine.timer = null; }
    if (engine.analyserTimer) { clearInterval(engine.analyserTimer); engine.analyserTimer = null; }
    if (engine.mix) {
      try { if (pause !== false) engine.mix.pause(); } catch { /* ignore */ }
      try { engine.mix.removeAttribute('src'); engine.mix.load(); } catch { /* ignore */ }
    }
    if (engine.mixGain && engine.graph) {
      try {
        const now = engine.graph.ctx.currentTime;
        engine.mixGain.gain.cancelScheduledValues(now);
        engine.mixGain.gain.setValueAtTime(0, now);
      } catch { /* ignore */ }
    }
  }

  function cancel(reason) {
    if (engine.phase === 'handoff') return;
    if (engine.phase === 'idle') {
      if (engine.timer) { clearTimeout(engine.timer); engine.timer = null; }
      engine.plan = null;
      if (engine.preload) cancelPreload(reason || 'cancel');
      return;
    }
    engine.phase = 'idle';
    cancelPreload(reason || 'cancel');
    engine.plan = null;
    cleanupMix(true);
    if (engine.graph) {
      try {
        const now = engine.graph.ctx.currentTime;
        engine.outGain.gain.cancelScheduledValues(now);
        engine.outGain.gain.setValueAtTime(1, now);
        engine.outLow.gain.cancelScheduledValues(now);
        engine.outLow.gain.setValueAtTime(0, now);
      } catch { /* ignore */ }
    }
    if (engine.host && engine.host.getAudio) {
      try {
        if (engine.graph) engine.host.getAudio().volume = 1;
        else engine.host.getAudio().volume = engine.host.getState().volume;
      } catch { /* ignore */ }
    }
    emit();
    if (reason && engine.host && engine.host.toast && engine.phase !== 'idle') {
      engine.host.toast('Переход отменён', 'info');
    }
  }

  function failStart(plan) {
    engine.plan = null;
    engine.phase = 'idle';
    cancelPreload('failed');
    if (plan && plan.currentId) engine.failedTrack = plan.currentId;
    emit();
  }

  async function start(plan) {
    if (engine.phase !== 'idle' || !engine.plan) return;
    const state = engine.host.getState();
    if (!state || !state.current || String(state.current.id) !== String(engine.plan.currentId)) {
      engine.plan = null;
      return;
    }
    const preload = engine.preload;
    const matches = preload
      && String(preload.trackId) === String(plan.nextTrack.id)
      && preload.index === plan.nextIndex;
    const prepared = matches && isPreloadReady(plan);
    if (engine.settings.preload && !prepared) {
      // Буфера недостаточно — не начинаем переход, остаётся обычная смена.
      failStart(plan);
      return;
    }
    engine.phase = 'starting';
    let mix;
    if (prepared) {
      mix = preload.element;
    } else {
      mix = ensureMixElement();
      mix.src = engine.host.streamUrl(plan.nextTrack);
      mix.volume = state.muted ? 0 : state.volume;
      mix.playbackRate = plan.rate || 1;
      try { mix.preservesPitch = true; } catch { /* ignore */ }
      try { mix.webkitPreservesPitch = true; } catch { /* ignore */ }
      const ready = await new Promise((resolve) => {
        const done = () => { mix.removeEventListener('loadedmetadata', done); resolve(true); };
        mix.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(() => { mix.removeEventListener('loadedmetadata', done); resolve(false); }, 2500);
        mix.load();
      });
      if (engine.phase !== 'starting') return;
      if (!ready) { failStart(plan); return; }
      try {
        const limit = Number.isFinite(mix.duration) && mix.duration > 2 ? mix.duration - 1 : Infinity;
        mix.currentTime = Math.min(Math.max(0, plan.incomingStart || 0), limit);
      } catch { /* ignore */ }
    }

    mix.volume = state.muted ? 0 : state.volume;
    mix.playbackRate = plan.rate || 1;
    try { mix.preservesPitch = true; } catch { /* ignore */ }
    try { mix.webkitPreservesPitch = true; } catch { /* ignore */ }
    if (prepared) {
      try {
        if (Math.abs(mix.currentTime - (plan.incomingStart || 0)) > 0.15) {
          mix.currentTime = Math.max(0, plan.incomingStart || 0);
        }
      } catch { /* ignore */ }
      if (!isPreloadReady(plan)) { failStart(plan); return; }
    }

    const graphOk = await ensureGraph();
    if (engine.phase !== 'starting') return;
    if (graphOk) mix.volume = 1;
    if (graphOk && !connectMixSource()) {
      cleanupMix(true);
      failStart(plan);
      return;
    }
    try {
      await Promise.race([
        mix.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('mix play timeout')), 1800)),
      ]);
    } catch {
      cleanupMix(true);
      failStart(plan);
      return;
    }
    if (engine.phase !== 'starting') { cleanupMix(true); return; }
    engine.phase = 'running';
    if (graphOk) {
      scheduleCurves(plan.duration);
    } else {
      // Фолбэк без Web Audio: equal-power по громкости элементов.
      const steps = 40;
      const startVolume = state.muted ? 0 : state.volume;
      const audio = engine.host.getAudio();
      audio.volume = startVolume;
      mix.volume = 0;
      let step = 0;
      engine.analyserTimer = setInterval(() => {
        step += 1;
        const t = Math.min(1, step / steps);
        audio.volume = Math.max(0, startVolume * Math.cos(t * Math.PI / 2));
        mix.volume = Math.max(0, startVolume * Math.sin(t * Math.PI / 2));
        if (t >= 1) { clearInterval(engine.analyserTimer); engine.analyserTimer = null; }
      }, Math.max(50, (plan.duration * 1000) / steps));
    }
    emit();
    engine.timer = setTimeout(() => finalize(), Math.max(1000, plan.duration * 1000));
  }

  async function finalize() {
    if (engine.phase !== 'running' || !engine.plan) return;
    engine.phase = 'handoff';
    const plan = engine.plan;
    const pos = engine.mix ? engine.mix.currentTime : 0;
    let adopted = false;
    try {
      adopted = await engine.host.adoptTrack(plan.nextIndex, pos);
    } catch {
      adopted = false;
    }
    if (!adopted) {
      cleanupMix(true);
      engine.phase = 'idle';
      engine.plan = null;
      cancelPreload('failed');
      if (plan && plan.currentId) engine.failedTrack = plan.currentId;
      emit();
      if (engine.host.toast) engine.host.toast('Не удалось завершить переход', 'info');
      return;
    }
    const retiredPreload = engine.preload;
    engine.preload = null;
    retirePreload(retiredPreload);
    if (engine.graph && engine.mixGain) {
      try {
        const ctx = engine.graph.ctx;
        const now = ctx.currentTime;
        engine.mixGain.gain.cancelScheduledValues(now);
        engine.outGain.gain.cancelScheduledValues(now);
        engine.outGain.gain.setValueAtTime(0, now);
        engine.outGain.gain.linearRampToValueAtTime(1, now + 0.18);
        engine.mixGain.gain.setValueAtTime(1, now);
        engine.mixGain.gain.linearRampToValueAtTime(0, now + 0.18);
      } catch { /* ignore */ }
    } else {
      try {
        const audio = engine.host.getAudio();
        const state = engine.host.getState();
        audio.volume = state.muted ? 0 : state.volume;
        if (engine.mix) engine.mix.volume = 0;
      } catch { /* ignore */ }
    }
    setTimeout(() => {
      cleanupMix(true);
      engine.phase = 'idle';
      engine.plan = null;
      if (engine.graph) {
        try {
          const now = engine.graph.ctx.currentTime;
          engine.outGain.gain.setValueAtTime(1, now);
          engine.outLow.gain.setValueAtTime(0, now);
        } catch { /* ignore */ }
      }
      emit();
      if (engine.settings.enabled) {
        const state = engine.host.getState();
        if (state && state.current) onTrack(state);
      }
    }, 240);
  }

  function nextTrackFor(state) {
    if (!state || !state.queue || !state.queue.length) return null;
    if (state.repeat === 'one') return null;
    let index = state.index + 1;
    if (index >= state.queue.length) {
      if (state.repeat === 'all') index = 0; else return null;
    }
    if (index === state.index) return null;
    return { index, track: state.queue[index] };
  }

  async function analyze(track, signal) {
    if (!track || !track.id) return null;
    const id = String(track.id);
    const cached = cachedAnalysis(id);
    if (cached) { engine.analyses.set(id, cached); return cached; }
    if (engine.pending.has(id)) return engine.pending.get(id);
    const promise = (async () => {
      try {
        const url = engine.host.streamUrl(track);
        const response = await fetch(url, { headers: { Range: `bytes=0-${PREFIX_BYTES - 1}` }, signal });
        if (!response.ok && response.status !== 206) return null;
        let buffer;
        if (response.body && response.body.getReader) {
          const reader = response.body.getReader();
          const chunks = [];
          let total = 0;
          while (total < PREFIX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
            if (total >= PREFIX_BYTES) { reader.cancel().catch(() => {}); break; }
          }
          const merged = new Uint8Array(Math.min(total, PREFIX_BYTES));
          let offset = 0;
          for (const chunk of chunks) {
            const take = Math.min(chunk.byteLength, merged.length - offset);
            merged.set(chunk.subarray(0, take), offset);
            offset += take;
            if (offset >= merged.length) break;
          }
          buffer = merged.buffer;
        } else {
          const raw = await response.arrayBuffer();
          buffer = raw.slice(0, PREFIX_BYTES);
        }
        const Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
        if (!Ctx) return null;
        if (!decodeContext) decodeContext = new Ctx(2, 1, 44100);
        const decoded = await decodeContext.decodeAudioData(buffer);
        const analysis = analyzeAudioBuffer(decoded);
        if (analysis) {
          engine.analyses.set(id, analysis);
          storeAnalysis(id, analysis);
        }
        return analysis;
      } catch {
        return null;
      } finally {
        engine.pending.delete(id);
      }
    })();
    engine.pending.set(id, promise);
    return promise;
  }

  function schedulePlan() {
    if (!engine.settings.enabled || engine.phase !== 'idle' || !engine.host) return;
    const state = engine.host.getState();
    if (!state || !state.current || state.paused) return;
    if (engine.failedTrack && String(engine.failedTrack) === String(state.current.id)) return;
    if (!Number.isFinite(state.currentTime) || !Number.isFinite(state.duration) || state.duration < 15) return;
    if (engine.currentTrack && String(engine.currentTrack.id) !== String(state.current.id)) {
      engine.plan = null;
      return;
    }
    if (engine.plan) {
      if (engine.plan.currentId !== String(state.current.id)
        || engine.plan.endAt > state.duration + 1) {
        engine.plan = null;
      }
    }
    const next = nextTrackFor(state);
    if (!next) return;
    const curAnalysis = engine.analyses.get(String(state.current.id));
    const nextAnalysis = engine.analyses.get(String(next.track.id));
    const nearEnd = state.duration - state.currentTime < 10;
    if ((!curAnalysis || !nextAnalysis) && !nearEnd) return;
    if (engine.plan && engine.plan.nextIndex === next.index
      && engine.plan.currentId === String(state.current.id)) return;
    const plan = planTransition(
      { duration: state.duration, analysis: curAnalysis },
      { analysis: nextAnalysis },
      { bars: engine.settings.bars, now: state.currentTime },
    );
    if (!plan) return;
    plan.nextIndex = next.index;
    plan.nextTrack = next.track;
    plan.currentId = String(state.current.id);
    engine.plan = plan;
    if (state.currentTime >= plan.startAt - 0.15) {
      start(plan);
    } else {
      if (engine.timer) clearTimeout(engine.timer);
      const delay = Math.max(0, (plan.startAt - state.currentTime) * 1000);
      const planId = plan.currentId;
      engine.timer = setTimeout(() => {
        if (engine.phase !== 'idle' || !engine.plan) return;
        const nowState = engine.host.getState();
        if (!nowState || !nowState.current || String(nowState.current.id) !== planId) return;
        start(engine.plan);
      }, delay);
    }
  }

  function onTime(state) {
    if (!engine.settings.enabled) return;
    if (engine.phase === 'running' || engine.phase === 'handoff') return;
    if (!state || !state.current) return;
    if (engine.currentTrack && String(engine.currentTrack.id) !== String(state.current.id)) {
      onTrack(state);
      return;
    }
    if (engine.phase === 'idle' && engine.plan && state.currentTime >= engine.plan.startAt - 0.15) {
      start(engine.plan);
      return;
    }
    if (engine.phase === 'idle') prepareNext(state);
    if (engine.phase === 'idle') schedulePlan();
    if (!engine.plan && state.duration && state.currentTime > state.duration - 7) {
      const next = nextTrackFor(state);
      if (next && !engine.pending.size) schedulePlan();
    }
  }

  async function onTrack(state) {
    engine.generation += 1;
    const generation = engine.generation;
    cancel('track');
    engine.failedTrack = null;
    if (engine.analysisController) engine.analysisController.abort();
    engine.analysisController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    engine.currentTrack = state && state.current ? state.current : null;
    engine.plan = null;
    if (!engine.settings.enabled) return;
    emit();
    if (!state || !state.current) return;
    // Предзагрузка не ждёт анализа: буфер начинается сразу, а когда BPM
    // будет готов, позиция входа уточняется на downbeat.
    prepareNext(state);
    const signal = engine.analysisController ? engine.analysisController.signal : undefined;
    await analyze(state.current, signal);
    if (generation !== engine.generation) return;
    const next = nextTrackFor(state);
    if (next) await analyze(next.track, signal);
    if (generation !== engine.generation) return;
    if (state.current) {
      prepareNext(state);
      schedulePlan();
    }
  }

  function onQueue() {
    if (engine.phase !== 'idle') cancel('queue');
    engine.plan = null;
    if (!engine.settings.enabled) return;
    const state = engine.host && engine.host.getState();
    if (state) {
      const next = nextTrackFor(state);
      if (next) {
        analyze(next.track).then(() => {
          prepareNext(state);
          schedulePlan();
        });
      }
    }
  }

  function setSettings(patch) {
    engine.settings = sanitizeSettings({ ...engine.settings, ...patch });
    saveSettings(engine.settings);
    if (!engine.settings.enabled) cancel('disabled');
    else ensureGraph();
    if (!engine.settings.enabled || !engine.settings.preload) cancelPreload('settings');
    else if (engine.host && engine.host.getState) prepareNext(engine.host.getState());
    emit();
    return engine.settings;
  }

  function init(host) {
    engine.host = host;
    engine.supported = null;
    if (engine.host && engine.host.getState) {
      const state = engine.host.getState();
      if (state && state.current) onTrack(state);
    }
    emit();
  }

  const api = {
    init,
    onTrack: () => {
      const state = engine.host && engine.host.getState();
      return state ? onTrack(state) : Promise.resolve();
    },
    onQueue,
    onTime: (state) => onTime(state || (engine.host && engine.host.getState())),
    warm: () => {
      if (!engine.settings.enabled) return Promise.resolve(false);
      if (engine.settings.preload && engine.host && engine.host.getState) {
        prepareNext(engine.host.getState());
      }
      return ensureGraph();
    },
    cancel,
    getSettings: () => ({ ...engine.settings }),
    setVolume: (volume) => {
      const value = clamp(Number(volume) || 0, 0, 1);
      if (engine.graph) {
        try {
          engine.graph.master.gain.value = value;
          engine.host.getAudio().volume = 1;
        } catch { /* ignore */ }
        return;
      }
      if (!engine.mix) return;
      try { engine.mix.volume = value; } catch { /* ignore */ }
    },
    setSettings,
    getState: () => ({
      settings: { ...engine.settings },
      supported: engine.supported,
      phase: engine.phase,
      preload: engine.preload ? {
        trackId: engine.preload.trackId,
        state: engine.preload.state,
        ready: engine.preload.ready,
        ahead: Math.round(engine.preload.ahead * 10) / 10,
        target: engine.preload.target,
        profile: engine.preload.profile,
        retries: engine.preload.retries,
      } : null,
      retired: engine.retired.length,
      plan: engine.plan ? {
        mode: engine.plan.mode,
        startAt: engine.plan.startAt,
        bars: engine.plan.bars,
        bpm: engine.plan.currentBpm,
        nextBpm: engine.plan.nextBpm,
        rate: engine.plan.rate,
        duration: engine.plan.duration,
      } : null,
    }),
    isPlaying: () => engine.phase === 'running' || engine.phase === 'handoff',
    _internal: {
      detectTempo, analyzeAudioBuffer, planTransition, barsToSeconds,
      sanitizeSettings, clamp, bufferAhead, networkProfile,
    },
  };

  global.RH_SMARTMIX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
