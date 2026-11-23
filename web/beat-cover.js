/* RH—MUSIC Beat Reactive Cover
   Анализ реального аудиопотока через MediaStreamSource + AnalyserNode.
   Не создаёт второй <audio>, не переподключает звук и не конфликтует с
   Smart Mix / Neural AI, которые уже переподключают звук к Web Audio. */
(() => {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

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

  let ctx = null;
  let source = null;
  let analyser = null;
  let freq = null;
  let raf = 0;
  let running = false;
  let amplitude = 0;
  let baseline = 0;
  let deviation = 0;
  let history = [];
  let lastBeat = 0;

  function capture() {
    if (typeof audio.captureStream === 'function') return audio.captureStream();
    if (typeof audio.mozCaptureStream === 'function') return audio.mozCaptureStream();
    return null;
  }

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
      ctx = null;
      source = null;
      analyser = null;
      return false;
    }
  }

  function bassEnergy() {
    analyser.getByteFrequencyData(freq);
    const nyquist = ctx.sampleRate / 2;
    const maxBin = Math.max(2, Math.floor((250 / nyquist) * freq.length));
    let sum = 0;
    for (let i = 0; i < maxBin; i += 1) sum += freq[i];
    return sum / maxBin / 255;
  }

  function detect(now) {
    const energy = bassEnergy();
    baseline = baseline ? baseline * 0.94 + energy * 0.06 : energy;
    const diff = energy - baseline;
    history.push(diff);
    if (history.length > 90) history.shift();
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + (b - mean) * (b - mean), 0) / history.length;
    deviation = Math.sqrt(variance);
    // Адаптивный порог: не зависит от абсолютной громкости трека.
    const threshold = Math.max(0.025, deviation * 1.35);
    if (diff > threshold && now - lastBeat > 150) {
      lastBeat = now;
      return Math.min(1, Math.max(0.2, diff / Math.max(0.06, baseline + deviation)));
    }
    return 0;
  }

  function reset() {
    amplitude = 0;
    for (const el of covers()) el.style.transform = '';
  }

  function frame() {
    raf = 0;
    if (!running || !analyser) return;
    const now = performance.now();
    const hit = detect(now);
    if (hit) amplitude = Math.max(amplitude, 0.018 + hit * 0.06);
    amplitude *= 0.9;
    if (amplitude < 0.0005) amplitude = 0;
    const scale = 1 + amplitude;
    for (const el of covers()) el.style.transform = `scale(${scale.toFixed(4)})`;
    if (!audio.paused && !audio.ended) raf = requestAnimationFrame(frame);
    else { running = false; reset(); }
  }

  function start() {
    if (reduceMotion && reduceMotion.matches) return;
    if (!ensureGraph()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
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
