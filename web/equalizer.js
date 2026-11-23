/* RH—MUSIC Equalizer
   Настраиваемый эквалайзер поверх существующего <audio>. Второй плеер не создаётся.
   Если Web Audio уже занят другим графом (Smart Mix/AI), включается честное
   состояние «недоступно», без имитации. */
(() => {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;
  const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const PRESETS = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    pop: [-1, 0, 1, 2, 3, 2, 0, -1, -1, -2],
    rock: [3, 2, 1, 0, -1, -1, 0, 2, 3, 3],
    jazz: [3, 2, 1, 1, -1, -1, 0, 1, 2, 3],
    classical: [2, 1, 0, 0, 0, 0, -1, -1, 1, 2],
    electronic: [4, 3, 1, 0, -1, 0, 1, 2, 3, 4],
    hiphop: [5, 4, 2, 1, -1, -1, 0, 1, 2, 3],
    vocal: [-3, -2, 0, 2, 4, 4, 2, 1, 0, -1],
  };

  const saved = (() => {
    try {
      const value = JSON.parse(localStorage.getItem('rh_eq_v1') || 'null');
      if (value && Array.isArray(value.gains) && value.gains.length === BANDS.length) return value;
    } catch { /* ignore */ }
    return { enabled: false, preset: 'flat', gains: PRESETS.flat.slice() };
  })();

  const state = {
    enabled: !!saved.enabled,
    preset: saved.preset || 'flat',
    gains: saved.gains.slice(),
    supported: null,
    ctx: null,
    source: null,
    filters: [],
    master: null,
  };

  function persist() {
    try {
      localStorage.setItem('rh_eq_v1', JSON.stringify({ enabled: state.enabled, preset: state.preset, gains: state.gains }));
    } catch { /* ignore */ }
  }

  function buildGraph() {
    if (state.ctx) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { state.supported = false; return false; }
    try {
      const ctx = new Ctx();
      const source = ctx.createMediaElementSource(audio);
      const filters = BANDS.map((frequency, index) => {
        const filter = ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = frequency;
        filter.Q.value = 1;
        filter.gain.value = state.enabled ? state.gains[index] : 0;
        return filter;
      });
      const master = ctx.createGain();
      master.gain.value = 1;
      source.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i += 1) filters[i].connect(filters[i + 1]);
      filters[filters.length - 1].connect(master);
      master.connect(ctx.destination);
      state.ctx = ctx;
      state.source = source;
      state.filters = filters;
      state.master = master;
      state.supported = true;
      return true;
    } catch {
      state.supported = false;
      return false;
    }
  }

  function applyGains() {
    if (!state.filters.length) return;
    state.filters.forEach((filter, index) => {
      filter.gain.value = state.enabled ? Number(state.gains[index]) || 0 : 0;
    });
  }

  function enable() {
    if (!buildGraph()) return false;
    state.enabled = true;
    applyGains();
    persist();
    const resume = () => {
      if (state.ctx.state === 'running') { applyGains(); return Promise.resolve(true); }
      return state.ctx.resume().then(() => { applyGains(); return state.ctx.state === 'running'; }).catch(() => false);
    };
    return resume();
  }

  function disable() {
    state.enabled = false;
    applyGains();
    persist();
    return true;
  }

  audio.addEventListener('play', () => {
    if (state.enabled && !state.ctx) enable();
    else if (state.ctx && state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
  });

  window.RH_EQUALIZER = {
    bands: BANDS.slice(),
    presets: Object.keys(PRESETS),
    init() {
      // Не строим граф до жеста пользователя: AudioContext в suspended
      // состоянии глушит звук. Если эквалайзер был включён ранее, он
      // подключится при первом воспроизведении.
      return state.supported;
    },
    enable,
    disable,
    toggle() { return state.enabled ? disable() : enable(); },
    isEnabled() { return state.enabled; },
    isSupported() { return state.supported; },
    setBand(index, gain) {
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= BANDS.length) return;
      state.gains[i] = Math.max(-12, Math.min(12, Number(gain) || 0));
      state.preset = 'custom';
      applyGains();
      persist();
    },
    setPreset(name) {
      if (!PRESETS[name]) return;
      state.preset = name;
      state.gains = PRESETS[name].slice();
      applyGains();
      persist();
    },
    reset() { this.setPreset('flat'); },
    getState() {
      return { enabled: state.enabled, preset: state.preset, gains: state.gains.slice(), supported: state.supported };
    },
  };
})();
