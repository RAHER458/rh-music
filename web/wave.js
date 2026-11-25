/* RH—MUSIC · «Моя волна».
   Персональный поток на существующем плеере: настройки как в «Мой поток»
   Zvuk (настроение, популярность, жанры, язык), подгрузка без повторов. */
(() => {
  'use strict';
  const KEY = 'rh_wave_v1';
  const GENRES = [
    ['classic', 'Классика'], ['ambient', 'Эмбиент'], ['electronic', 'Электроника'],
    ['folk', 'Фолк'], ['hip_hop', 'Хип-хоп'], ['indie', 'Инди'],
    ['instrumental', 'Инструментал'], ['metal', 'Метал'], ['pop', 'Поп'],
    ['rock', 'Рок'], ['soundtrack', 'Саундтреки'],
  ];
  const LANGS = [['all', 'Все языки'], ['foreign', 'Зарубежное'], ['russian', 'Русское'], ['voiceless', 'Без слов']];
  const DEFAULTS = { genres: [], language: 'all', popularity: 1, mood: { energy: 0.5, fun: 0.5 } };

  let settings = { ...DEFAULTS, ...(read() || {}) };
  settings.mood = { ...DEFAULTS.mood, ...(settings.mood || {}) };
  let state = { active: false, loading: false, error: '', fetched: 0, exclude: [], page: 0, request: 0, skipArtists: readFeedback(), lastTrack: null, lastTime: 0 };
  let slot = null;
  let root = null;

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }
  function readFeedback() {
    try { const raw = JSON.parse(localStorage.getItem('rh_wave_feedback_v1') || '[]'); return Array.isArray(raw) ? raw.slice(-40) : []; } catch { return []; }
  }
  function saveFeedback() {
    try { localStorage.setItem('rh_wave_feedback_v1', JSON.stringify(state.skipArtists.slice(-40))); } catch { /* ignore */ }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pct(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

  function moodLabel() {
    const { energy, fun } = settings.mood;
    if (energy >= 0.66) return fun >= 0.5 ? 'Энергичное · весёлое' : 'Энергичное · грустное';
    if (energy <= 0.34) return fun >= 0.5 ? 'Спокойное · весёлое' : 'Спокойное · грустное';
    return 'Сбалансированное';
  }

  function cardHTML() {
    const genreChips = GENRES.map(([id, label]) => `<button class="wave-chip${settings.genres.includes(id) ? ' is-on' : ''}" type="button" data-wave-genre="${id}">${label}</button>`).join('');
    const lang = LANGS.map(([id, label]) => `<button class="wave-seg${settings.language === id ? ' is-on' : ''}" type="button" data-wave-lang="${id}">${label}</button>`).join('');
    const pop = [0, 1, 2].map((value) => `<button class="wave-dot${settings.popularity === value ? ' is-on' : ''}" type="button" data-wave-pop="${value}" aria-label="${value === 0 ? 'Реже популярное' : value === 2 ? 'Более популярное' : 'Средняя популярность'}"></button>`).join('');
    return `<section class="wave-card${state.active ? ' is-active' : ''}" id="waveCard">
      <div class="wave-head">
        <div><div class="wave-kicker">Персональный поток</div><h2 class="wave-title">Моя волна</h2><p class="wave-sub">${state.active ? 'Играет · ' + esc(moodLabel()) : 'Настройте поток под себя'}</p></div>
        <span class="wave-orb" aria-hidden="true"></span>
      </div>
      <div class="wave-body">
        <div class="wave-mood">
          <div class="wave-pad" id="wavePad" style="--wx:${pct(settings.mood.fun) * 100}%; --wy:${(1 - pct(settings.mood.energy)) * 100}%">
            <span class="wave-pad-label tl">ЭНЕРГИЧНОЕ</span><span class="wave-pad-label tr">ВЕСЕЛОЕ</span><span class="wave-pad-label bl">ГРУСТНОЕ</span><span class="wave-pad-label br">СПОКОЙНОЕ</span>
            <span class="wave-pad-thumb"></span>
          </div>
          <div class="wave-mood-text"><span>Настроение</span><b>${esc(moodLabel())}</b></div>
        </div>
        <div class="wave-controls">
          <div class="wave-row"><span class="wave-label">Популярность</span><div class="wave-dots">${pop}</div></div>
          <div class="wave-row wave-row-genres"><span class="wave-label">Жанры и Язык</span><div class="wave-chips">${genreChips}</div></div>
          <div class="wave-langs">${lang}</div>
          <div class="wave-actions">
            <button class="wave-start" type="button" data-wave-start>${state.loading ? 'Собираем волну…' : state.active ? 'Перезапустить волну' : 'Запустить волну'}</button>
            <button class="wave-reset" type="button" data-wave-reset>Сбросить</button>
          </div>
          ${state.error ? `<p class="wave-error">${esc(state.error)}</p>` : ''}
          ${state.active ? `<div class="wave-feedback"><button type="button" data-wave-like>Нравится</button><button type="button" data-wave-skip>Не сейчас</button></div>` : ''}
          <p class="wave-hint">${state.active ? 'Следующие треки подгружаются автоматически.' : 'Поток использует реальный каталог и играет в основном плеере.'}</p>
        </div>
      </div>
    </section>`;
  }

  function mount() {
    slot = document.getElementById('waveSlot');
    if (!slot) { root = null; return; }
    slot.innerHTML = cardHTML();
    root = document.getElementById('waveCard');
    bindPad();
  }

  function refresh() {
    if (!slot || !document.body.contains(slot)) mount();
    else { const html = cardHTML(); if (slot.innerHTML !== html) { slot.innerHTML = html; root = document.getElementById('waveCard'); bindPad(); } }
  }

  function bindPad() {
    const pad = document.getElementById('wavePad');
    if (!pad) return;
    let dragging = false;
    const update = (event) => {
      const rect = pad.getBoundingClientRect();
      const point = event.touches ? event.touches[0] : event;
      const x = pct((point.clientX - rect.left) / rect.width);
      const y = pct((point.clientY - rect.top) / rect.height);
      settings.mood = { energy: 1 - y, fun: x };
      save();
      pad.style.setProperty('--wx', x * 100 + '%');
      pad.style.setProperty('--wy', y * 100 + '%');
      const text = pad.parentElement && pad.parentElement.querySelector('.wave-mood-text b');
      if (text) text.textContent = moodLabel();
    };
    pad.addEventListener('pointerdown', (event) => { dragging = true; pad.setPointerCapture && pad.setPointerCapture(event.pointerId); update(event); });
    pad.addEventListener('pointermove', (event) => { if (dragging) update(event); });
    pad.addEventListener('pointerup', () => { dragging = false; });
    pad.addEventListener('pointercancel', () => { dragging = false; });
  }

  async function start() {
    if (state.loading) return;
    const bridge = window.RH_WAVE_BRIDGE;
    if (!bridge) { state.error = 'Плеер ещё не готов.'; refresh(); return; }
    state.loading = true; state.error = ''; state.active = true; state.exclude = []; state.page = 0;
    refresh();
    chrome('Собираем волну…', 'info');
    try {
      const data = await fetchBatch([]);
      if (!data.length) throw new Error('Не удалось собрать треки. Попробуйте другие настройки.');
      bridge.play(data, settings);
      state.fetched = data.length;
      chrome('Моя волна запущена', 'info');
    } catch (error) {
      state.active = false;
      state.error = error.message || 'Поток недоступен.';
    } finally {
      state.loading = false;
      refresh();
    }
  }

  async function fetchBatch(exclude) {
    const response = await fetch('/api/wave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        genres: settings.genres,
        language: settings.language,
        popularity: settings.popularity,
        mood: settings.mood,
        exclude: exclude.slice(-200),
        excludeArtists: state.skipArtists.slice(-40),
        page: state.page,
        limit: 20,
      }),
    });
    if (!response.ok) throw new Error('Поток временно недоступен.');
    const data = await response.json();
    if (!data || !data.ok) throw new Error((data && data.error && data.error.message) || 'Поток временно недоступен.');
    state.fetched += (data.items || []).length;
    return data.items || [];
  }

  async function more() {
    if (state.loading || !state.active) return;
    const bridge = window.RH_WAVE_BRIDGE;
    if (!bridge) return;
    const info = bridge.getState();
    if (!info || !info.queue || !info.queue.length) return;
    const nearEnd = info.queue.length - info.index <= 2;
    if (!nearEnd) return;
    state.loading = true;
    try {
      state.page += 1;
      const items = await fetchBatch([...state.exclude, ...info.queue.map((item) => String(item.id))]);
      if (items.length) bridge.append(items);
    } catch { /* следующий тик попробует снова */ }
    finally { state.loading = false; refresh(); }
  }

  function chrome(message, kind) {
    try { window.dispatchEvent(new CustomEvent('rh-toast', { detail: { message, kind } })); } catch { /* ignore */ }
  }

  document.addEventListener('click', (event) => {
    const genre = event.target.closest('[data-wave-genre]');
    if (genre) {
      const id = genre.dataset.waveGenre;
      settings.genres = settings.genres.includes(id) ? settings.genres.filter((x) => x !== id) : [...settings.genres, id];
      save(); refresh(); return;
    }
    const lang = event.target.closest('[data-wave-lang]');
    if (lang) { settings.language = lang.dataset.waveLang; save(); refresh(); return; }
    const pop = event.target.closest('[data-wave-pop]');
    if (pop) { settings.popularity = Number(pop.dataset.wavePop); save(); refresh(); return; }
    if (event.target.closest('[data-wave-like]')) { window.RH_WAVE_BRIDGE && window.RH_WAVE_BRIDGE.likeCurrent(); return; }
    if (event.target.closest('[data-wave-skip]')) {
      const info = window.RH_WAVE_BRIDGE && window.RH_WAVE_BRIDGE.getState();
      if (info && info.currentArtist) { state.skipArtists = [...new Set([...state.skipArtists, info.currentArtist])]; saveFeedback(); }
      window.RH_WAVE_BRIDGE && window.RH_WAVE_BRIDGE.next();
      return;
    }
    if (event.target.closest('[data-wave-start]')) { start(); return; }
    if (event.target.closest('[data-wave-reset]')) {
      settings = { ...DEFAULTS, mood: { ...DEFAULTS.mood } }; save(); state.active = false; state.error = ''; refresh(); return;
    }
  });

  setInterval(() => {
    if (!state.active) return;
    more();
    const bridge = window.RH_WAVE_BRIDGE;
    const info = bridge && bridge.getState();
    if (!info || !info.currentId) return;
    if (state.lastTrack && state.lastTrack !== info.currentId) {
      const ratio = state.lastDuration > 0 ? state.lastTime / state.lastDuration : 0;
      if (ratio > 0 && ratio < 0.25 && state.lastArtist) {
        state.skipArtists = [...new Set([...state.skipArtists, state.lastArtist])];
        saveFeedback();
      }
    }
    state.lastTrack = info.currentId;
    state.lastTime = info.currentTime || 0;
    state.lastDuration = info.duration || 0;
    state.lastArtist = info.currentArtist || '';
  }, 4000);
  window.RH_WAVE = { mount, refresh, start, settings, state };
})();
