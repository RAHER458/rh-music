/* RH—MUSIC «Текст beta»
   Отдельный режим Now Playing: вместо обложки показывается одна текущая
   строка песни и следующая. Данные берутся из существующего RH_LYRICS,
   второй плеер и второй загрузчик текста не создаются. */
(() => {
  'use strict';

  const art = document.getElementById('npArt');
  if (!art) return;

  let active = false;
  let last = { key: '', text: '' };
  let textEl = null;
  let lineEl = null;
  let nextEl = null;
  let timer = 0;

  function ensureText() {
    if (textEl) return;
    textEl = document.createElement('div');
    textEl.className = 'np-lyrics-beta-text';
    lineEl = document.createElement('span');
    lineEl.className = 'np-lb-line';
    nextEl = document.createElement('span');
    nextEl.className = 'np-lb-next';
    textEl.appendChild(lineEl);
    textEl.appendChild(nextEl);
    art.appendChild(textEl);
  }

  function format(payload) {
    if (!payload) return { main: 'Текст недоступен', next: '' };
    if (payload.status === 'loading') return { main: 'Загрузка текста…', next: '' };
    if (payload.status === 'error') return { main: 'Текст недоступен', next: '' };
    if (payload.instrumental) return { main: 'Инструментальная композиция', next: '' };
    if (payload.syncLevel === 'none') return { main: 'Текст не найден', next: '' };
    if (payload.syncLevel === 'plain') {
      const lines = String(payload.plain || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return { main: lines[0] || 'Текст без синхронизации', next: lines[1] || '' };
    }
    return { main: payload.text || '…', next: payload.nextText || '' };
  }

  function render(payload) {
    if (!active) return;
    ensureText();
    const { main, next } = format(payload);
    const key = `${payload && payload.index}:${main}:${next}`;
    if (key === last.key) return;
    last = { key, text: main };
    const apply = () => {
      lineEl.textContent = main;
      nextEl.textContent = next;
      textEl.classList.remove('is-changing');
    };
    textEl.classList.add('is-changing');
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 140);
  }

  function current() {
    return window.RH_LYRICS && typeof window.RH_LYRICS.getLine === 'function'
      ? window.RH_LYRICS.getLine()
      : null;
  }

  function setActive(value) {
    active = !!value;
    art.classList.toggle('is-lyrics-beta', active);
    const button = document.getElementById('npLyricsBeta');
    if (button) {
      button.classList.toggle('is-on', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (active) {
      ensureText();
      render(current());
    }
  }

  if (window.RH_LYRICS && typeof window.RH_LYRICS.subscribe === 'function') {
    window.RH_LYRICS.subscribe((payload) => render(payload));
  }

  window.RH_LYRICS_BETA = {
    toggle() { setActive(!active); },
    enable() { setActive(true); },
    disable() { setActive(false); },
    isActive() { return active; },
    getState() { return { active, text: last.text }; },
  };
})();
