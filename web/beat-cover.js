/* RH—MUSIC Beat Reactive Cover
   Живая обложка, реагирующая на реальные удары.

   Два безопасных пути:
   1. Если браузер умеет captureStream() — AnalysisNode в реальном времени.
   2. Иначе — OfflineAudioContext: трек декодируется и анализируется заранее,
      карта ударов строится по фактическому аудио и проигрывается по audio.currentTime.

   В обоих случаях НЕ вызывается createMediaElementSource(): Smart Mix и Neural AI
   уже используют его на том же <audio>, второй вызов сломал бы их.
   Звук не переподключается, громкость и воспроизведение не меняются. */
(() => {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function covers() {
    const list = [];
    const np = document.getElementById('npCover');
    if (np && np.parentElement) list.push(np.parentElement);
    const mini = document.getElementById('miniNowCover');
    if (mini) list.push(mini);
    const art = document.getElementById('npArt');
    if (art) list.push(art);
    return list;
  }

  for (const el of covers()) el.setAttribute('data-beat-cover', '');

  const pulseCache = new Map();
  let pulseMap = null;          // { values: Float32Array, hopSeconds }
  let loadedSrc = '';
  let loadingSrc = '';
  let raf = 0;
  let running = false;

  /* ── live path ───────────────────────────────────────────────── */

  let ctx = null;
  let source = null;
  let analyser = null;
  let freq = null;
  let history = [];
  let baseline = 0;
  let lastBeat = 0;
  let liveAmplitude = 0;

  function capture() {
    if (typeof audio.captureStream === 'function') return audio.captureStream();
    if (typeof audio.mozCaptureStream === 'function') return audio.mozCaptureStream();
    return null;
  }

  const liveSupported = typeof audio.captureStream === 'function' || typeof audio.mozCaptureStream === 'function';

  function ensureGraph() {
    if (ctx) return true;
    const stream = capture();
    if (!stream) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      ctx = new Ctx();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.62;
      source.connect(analyser);
      freq = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch {
      ctx = null; source = null; analyser = null;
      return false;
    }
  }

  function liveLevel(now) {
    analyser.getByteFrequencyData(freq);
    const nyquist = ctx.sampleRate / 2;
    const maxBin = Math.max(2, Math.floor((250 / nyquist) * freq.length));
    let sum = 0;
    for (let i = 0; i < maxBin; i += 1) sum += freq[i];
    const energy = sum / maxBin / 255;
    baseline = baseline ? baseline * 0.94 + energy * 0.06 : energy;
    const diff = energy - baseline;
    history.push(diff);
    if (history.length > 90) history.shift();
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + (b - mean) * (b - mean), 0) / history.length;
    const deviation = Math.sqrt(variance);
    const threshold = Math.max(0.025, deviation * 1.35);
    if (diff > threshold && now - lastBeat > 150) {
      lastBeat = now;
      return Math.min(1, Math.max(0.2, diff / Math.max(0.06, baseline + deviation)));
    }
    return 0;
  }

  /* ── offline path ────────────────────────────────────────────── */

  function analyzeBuffer(buffer) {
    const data = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const hopSeconds = 0.02;
    const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
    const frames = Math.max(1, Math.floor(data.length / hop));
    const energy = new Float32Array(frames);
    for (let f = 0; f < frames; f += 1) {
      let sum = 0;
      const from = f * hop;
      const to = Math.min(from + hop, data.length);
      for (let i = from; i < to; i += 1) sum += data[i] * data[i];
      energy[f] = Math.sqrt(sum / Math.max(1, to - from));
    }
    const impulses = new Float32Array(frames);
    const window = [];
    let base = 0;
    let last = -999;
    for (let f = 0; f < frames; f += 1) {
      const value = energy[f];
      base = base ? base * 0.96 + value * 0.04 : value;
      const diff = value - base;
      window.push(diff);
      if (window.length > 45) window.shift();
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((a, b) => a + (b - mean) * (b - mean), 0) / window.length;
      const deviation = Math.sqrt(variance);
      const threshold = Math.max(0.012, deviation * 1.4);
      if (diff > threshold && f - last >= 7) {
        impulses[f] = Math.min(1, Math.max(0.2, diff / Math.max(0.04, base + deviation)));
        last = f;
      }
    }
    const values = new Float32Array(frames);
    let level = 0;
    for (let f = 0; f < frames; f += 1) {
      level = Math.max(level * 0.88, impulses[f]);
      values[f] = level;
    }
    return { values, hopSeconds };
  }

  function isHlsSource(src) {
    return /\/api\/sc\/play\//i.test(src) || /\.m3u8(?:\?|$)/i.test(src);
  }

  async function fetchBytes(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('hls_http_' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** HLS fMP4: init + все сегменты склеиваются в обычный MP4 для decodeAudioData. */
  async function loadHlsAudio(src, depth = 0) {
    if (depth > 2) return null;
    const response = await fetch(src, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const text = await response.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    // Master playlist: берём первый вариант и разворачиваем его.
    if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'))) {
      const variant = lines.find((line) => !line.startsWith('#'));
      return variant ? loadHlsAudio(new URL(variant, src).href, depth + 1) : null;
    }

    const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
    const mapMatch = mapLine && mapLine.match(/URI="([^"]+)"/);
    const init = mapMatch ? new URL(mapMatch[1], src).href : null;
    const segments = lines
      .filter((line) => !line.startsWith('#'))
      .map((line) => new URL(line, src).href);
    if (!segments.length || segments.length > 240) return null;

    const parts = [];
    if (init) parts.push(await fetchBytes(init));
    // Сегментов немного (обычно 10–30); параллельная загрузка ускоряет старт.
    const loaded = await Promise.all(segments.map((url) => fetchBytes(url)));
    parts.push(...loaded);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    if (total > 24 * 1024 * 1024) return null;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { merged.set(part, offset); offset += part.length; }
    return merged.buffer;
  }

  async function loadPulseMap(src) {
    if (!src) return null;
    if (pulseCache.has(src)) return pulseCache.get(src);
    if (loadingSrc === src) return null;
    loadingSrc = src;
    try {
      let buffer;
      if (isHlsSource(src)) {
        buffer = await loadHlsAudio(src);
      } else {
        const response = await fetch(src, { credentials: 'same-origin' });
        if (!response.ok) return null;
        buffer = await response.arrayBuffer();
      }
      if (!buffer) return null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const tmp = new Ctx();
      const decoded = await tmp.decodeAudioData(buffer.slice(0));
      tmp.close?.();
      const map = analyzeBuffer(decoded);
      if (map.values.length) pulseCache.set(src, map);
      return map;
    } catch {
      return null;
    } finally {
      if (loadingSrc === src) loadingSrc = '';
    }
  }

  function currentSrc() {
    return audio.dataset.beatSrc || audio.currentSrc || audio.getAttribute('src') || '';
  }

  /* ── animation ───────────────────────────────────────────────── */

  function applyScale(scale) {
    const value = scale.toFixed(4);
    for (const el of covers()) el.style.transform = `scale(${value})`;
  }

  function reset() {
    for (const el of covers()) el.style.transform = '';
  }

  function frame() {
    raf = 0;
    if (!running) return;
    if (audio.paused || audio.ended) { running = false; reset(); return; }
    let scale = 1;
    if (liveSupported && analyser) {
      const hit = liveLevel(performance.now());
      if (hit) liveAmplitude = Math.max(liveAmplitude, 0.018 + hit * 0.06);
      liveAmplitude *= 0.9;
      scale = 1 + liveAmplitude;
    } else if (pulseMap && pulseMap.values.length) {
      const index = Math.min(pulseMap.values.length - 1, Math.max(0, Math.floor(audio.currentTime / pulseMap.hopSeconds)));
      scale = 1 + (pulseMap.values[index] || 0) * 0.055;
    }
    applyScale(scale);
    raf = requestAnimationFrame(frame);
  }

  async function prepareOffline() {
    if (liveSupported) return;
    const src = currentSrc();
    if (!src || src === loadedSrc) return;
    pulseMap = null;
    const map = await loadPulseMap(src);
    if (map && currentSrc() === src) {
      loadedSrc = src;
      pulseMap = map;
    }
  }

  function start() {
    if (reduceMotion && reduceMotion.matches) return;
    if (liveSupported) {
      if (!ensureGraph()) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } else {
      prepareOffline();
    }
    running = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    reset();
  }

  audio.addEventListener('play', start);
  audio.addEventListener('playing', start);
  audio.addEventListener('loadedmetadata', prepareOffline);
  audio.addEventListener('pause', stop);
  audio.addEventListener('ended', stop);
  audio.addEventListener('emptied', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!audio.paused) start();
  });
  if (reduceMotion && reduceMotion.addEventListener) {
    reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) stop(); });
  }
})();
