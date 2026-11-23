/* RH—MUSIC «Текст» — основной режим Now Playing.
   Вместо обложки показывается текущая строка, а при наличии word-таймингов —
   слова с плавной заливкой, как в Apple Music. Использует существующий
   RH_LYRICS, второй плеер и второй загрузчик текста не создаются. */
(() => {
  'use strict';

  const art = document.getElementById('npArt');
  const audio = document.getElementById('audio');
  if (!art || !audio) return;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  let active = false;
  let lastKey = '';
  let payload = null;
  let textEl = null;
  let lineEl = null;
  let nextEl = null;
  let wordNodes = [];
  let raf = 0;
  let noticeEl = null;
  let noticeTimer = 0;
  let pendingEnable = false;
  let pendingTimer = 0;

  function isSynced(data) {
    return !!data && data.status === 'ready' && (data.syncLevel === 'line' || data.syncLevel === 'word');
  }

  function reasonFor(data) {
    if (!data || data.status === 'error') return 'Не удалось загрузить текст. Попробуйте позже.';
    if (data.instrumental) return 'Это инструментальная композиция — текста нет.';
    if (data.syncLevel === 'plain') return 'Для этой песни есть только обычный текст без синхронизации.';
    if (data.syncLevel === 'none') return 'Для этой песни текст не найден.';
    return 'Синхронизированный текст для этой песни недоступен.';
  }

  function showNotice(message) {
    if (!art) return;
    if (!noticeEl) {
      noticeEl = document.createElement('div');
      noticeEl.className = 'np-lyrics-notice';
      noticeEl.innerHTML = '<span class="np-ln-icon">♪</span><span class="np-ln-text"></span>';
      art.appendChild(noticeEl);
    }
    noticeEl.querySelector('.np-ln-text').textContent = message;
    noticeEl.classList.add('is-visible');
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => noticeEl.classList.remove('is-visible'), 3400);
    window.dispatchEvent(new CustomEvent('rh-toast', { detail: { message, kind: 'info' } }));
  }

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

  function format(data) {
    if (!data) return { main: 'Текст недоступен', next: '' };
    if (data.status === 'loading') return { main: 'Загрузка текста…', next: '' };
    if (data.status === 'error') return { main: 'Текст недоступен', next: '' };
    if (data.instrumental) return { main: 'Инструментальная композиция', next: '' };
    if (data.syncLevel === 'none') return { main: 'Текст не найден', next: '' };
    if (data.syncLevel === 'plain') {
      const lines = String(data.plain || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return { main: lines[0] || 'Текст без синхронизации', next: lines[1] || '' };
    }
    return { main: data.text || '…', next: data.nextText || '' };
  }

  function buildWords(data) {
    wordNodes = [];
    lineEl.textContent = '';
    if (!Array.isArray(data.words) || data.words.length < 2) {
      lineEl.textContent = data.main;
      return;
    }
    data.words.forEach((word) => {
      const span = document.createElement('span');
      span.className = 'np-lb-word';
      span.textContent = word.text;
      lineEl.appendChild(span);
      lineEl.appendChild(document.createTextNode(' '));
      wordNodes.push({ el: span, start: Number(word.t) || 0, end: Number(word.end) || Number(word.t) || 0 });
    });
  }

  function updateWords() {
    if (!wordNodes.length || !payload) return;
    const ms = (audio.currentTime || 0) * 1000 - (Number(payload.offsetMs) || 0);
    for (const item of wordNodes) {
      const span = item.el;
      if (ms >= item.end) {
        span.classList.add('is-done');
        span.classList.remove('is-current');
        span.style.setProperty('--p', '1');
      } else if (ms >= item.start) {
        const progress = Math.max(0, Math.min(1, (ms - item.start) / Math.max(1, item.end - item.start)));
        span.classList.remove('is-done');
        span.classList.add('is-current');
        span.style.setProperty('--p', progress.toFixed(3));
      } else {
        span.classList.remove('is-current', 'is-done');
        span.style.setProperty('--p', '0');
      }
    }
  }

  function tick() {
    raf = 0;
    if (!active || !audio || audio.paused) return;
    updateWords();
    raf = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (reduceMotion && reduceMotion.matches) return;
    if (!wordNodes.length) return;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function render(data) {
    if (!active) return;
    ensureText();
    const { main, next } = format(data);
    const key = `${data && data.index}:${main}:${data && data.words ? data.words.length : 0}:${next}`;
    if (key === lastKey) return;
    lastKey = key;
    payload = data || null;
    buildWords({ ...data, main });
    nextEl.textContent = next;
    // Плавное появление строки: blur/сдвиг/масштаб, как в Apple Music.
    lineEl.classList.remove('is-entering');
    void lineEl.offsetWidth;
    lineEl.classList.add('is-entering');
    updateWords();
    startLoop();
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
      lastKey = '';
      if (window.RH_LYRICS && typeof window.RH_LYRICS.ensure === 'function') window.RH_LYRICS.ensure();
      render(window.RH_LYRICS && window.RH_LYRICS.getLine ? window.RH_LYRICS.getLine() : null);
    } else {
      stopLoop();
      wordNodes = [];
    }
  }

  if (window.RH_LYRICS && typeof window.RH_LYRICS.subscribe === 'function') {
    window.RH_LYRICS.subscribe((data) => {
      if (pendingEnable && isSynced(data)) {
        pendingEnable = false;
        window.clearTimeout(pendingTimer);
        setActive(true);
        return;
      }
      if (active && data && data.status === 'ready' && !isSynced(data)) {
        setActive(false);
        showNotice(reasonFor(data));
        return;
      }
      render(data);
    });
  }
  audio.addEventListener('play', startLoop);
  audio.addEventListener('playing', startLoop);
  audio.addEventListener('pause', stopLoop);
  audio.addEventListener('ended', stopLoop);

  window.RH_LYRICS_BETA = {
    toggle() {
      if (active) { setActive(false); return; }
      const data = window.RH_LYRICS && window.RH_LYRICS.getLine ? window.RH_LYRICS.getLine() : null;
      if (data && data.status === 'loading') { setActive(true); return; }
      if (isSynced(data)) { setActive(true); return; }
      if (data && data.syncLevel === 'plain') {
        // Обычный текст: пробуем дотянуть слова из внешнего источника,
        // и только потом решаем, что синхронизации нет.
        pendingEnable = true;
        if (window.RH_LYRICS && typeof window.RH_LYRICS.ensure === 'function') window.RH_LYRICS.ensure();
        window.clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => {
          if (!pendingEnable) return;
          pendingEnable = false;
          const current = window.RH_LYRICS && window.RH_LYRICS.getLine ? window.RH_LYRICS.getLine() : null;
          if (!isSynced(current)) showNotice(reasonFor(current));
        }, 4200);
        return;
      }
      showNotice(reasonFor(data));
    },
    enable() { setActive(true); },
    disable() { setActive(false); },
    isActive() { return active; },
    getState() { return { active, key: lastKey, words: wordNodes.length }; },
  };
})();
