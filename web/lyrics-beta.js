/* RH—MUSIC «Текст» — основной режим Now Playing.
   Три строки: предыдущая (сверху, приглушённая), текущая (в центре, поётся)
   и следующая (снизу, приглушённая). Смена строки — мягкий подъём с лёгким
   блюром и прозрачностью. Использует существующий RH_LYRICS; второго плеера нет. */
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
  let slotPrev = null;
  let slotCurr = null;
  let slotNext = null;
  let linePrev = null;
  let lineCurr = null;
  let lineNext = null;
  let wordNodes = [];
  let raf = 0;
  let noticeEl = null;
  let noticeTimer = 0;
  let pendingEnable = false;
  let pendingTimer = 0;
  let lastIndex = null;

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

  function updateButton(data) {
    const button = document.getElementById('npLyricsBeta');
    if (!button) return;
    const synced = isSynced(data);
    const loading = !!data && data.status === 'loading';
    const blocked = !synced && !loading;
    button.classList.toggle('is-disabled', blocked);
    button.classList.toggle('is-on', active);
    button.disabled = blocked;
    button.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (blocked) button.title = reasonFor(data);
    else button.removeAttribute('title');
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

  function format(data) {
    if (!data) return { prev: '', main: 'Текст недоступен', next: '' };
    if (data.status === 'loading') return { prev: '', main: 'Загрузка текста...', next: '' };
    if (data.status === 'error') return { prev: '', main: 'Текст недоступен', next: '' };
    if (data.instrumental) return { prev: '', main: 'Инструментальная композиция', next: '' };
    if (data.syncLevel === 'none') return { prev: '', main: 'Текст не найден', next: '' };
    if (data.syncLevel === 'plain') {
      const lines = String(data.plain || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return { prev: lines[0] || '', main: lines[1] || lines[0] || 'Текст без синхронизации', next: lines[2] || '' };
    }
    return { prev: data.prevText || '', main: data.text || '...', next: data.nextText || '' };
  }

  function ensureText() {
    if (textEl) return;
    textEl = document.createElement('div');
    textEl.className = 'np-lyrics-beta-text';

    const makeSlot = (name) => {
      const slot = document.createElement('span');
      slot.className = `np-lb-slot np-lb-slot-${name}`;
      const line = document.createElement('span');
      line.className = 'np-lb-line';
      slot.appendChild(line);
      textEl.appendChild(slot);
      return { slot, line };
    };

    const prev = makeSlot('prev');
    const curr = makeSlot('current');
    const next = makeSlot('next');
    slotPrev = prev.slot; linePrev = prev.line;
    slotCurr = curr.slot; lineCurr = curr.line;
    slotNext = next.slot; lineNext = next.line;
    art.appendChild(textEl);
  }

  function setWords(el, data, fallback = '') {
    wordNodes = [];
    if (!el) return;
    el.textContent = '';
    const words = data && Array.isArray(data.words) ? data.words : null;
    if (!words || words.length < 2) {
      el.textContent = data && data.text ? data.text : fallback;
      return;
    }
    words.forEach((word) => {
      const span = document.createElement('span');
      span.className = 'np-lb-word';
      span.textContent = word.text;
      el.appendChild(span);
      el.appendChild(document.createTextNode(' '));
      wordNodes.push({ el: span, start: Number(word.t) || 0, end: Number(word.end) || Number(word.t) || 0 });
    });
  }

  function shift() {
    if (reduceMotion && reduceMotion.matches) return;
    for (const slot of [slotPrev, slotCurr, slotNext]) {
      if (!slot) continue;
      slot.classList.remove('is-shift');
      void slot.offsetWidth;
      slot.classList.add('is-shift');
    }
  }

  function render(data) {
    if (!active) return;
    ensureText();
    const { prev, main, next } = format(data);
    const key = `${data && data.index}:${prev}:${main}:${next}:${data && data.words ? data.words.length : 0}`;
    if (key === lastKey) return;
    const sameLine = data && Number.isFinite(Number(data.index)) && Number(data.index) === lastIndex
      && (data.text || '') === (payload && payload.text);
    lastKey = key;
    payload = data || null;
    lastIndex = data && Number.isFinite(Number(data.index)) ? Number(data.index) : null;

    linePrev.textContent = prev;
    lineNext.textContent = next;
    setWords(lineCurr, data, main);
    if (!sameLine) shift();
    updateWords();
    startLoop();
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

  function setActive(value) {
    active = !!value;
    art.classList.toggle('is-lyrics-beta', active);
    const button = document.getElementById('npLyricsBeta');
    if (button) button.setAttribute('aria-pressed', String(active));
    updateButton(window.RH_LYRICS && window.RH_LYRICS.getLine ? window.RH_LYRICS.getLine() : null);
    if (active) {
      ensureText();
      lastKey = '';
      lastIndex = null;
      if (window.RH_LYRICS && typeof window.RH_LYRICS.ensure === 'function') window.RH_LYRICS.ensure();
      render(window.RH_LYRICS && window.RH_LYRICS.getLine ? window.RH_LYRICS.getLine() : null);
    } else {
      stopLoop();
      wordNodes = [];
      if (lineCurr) lineCurr.textContent = '';
      if (linePrev) linePrev.textContent = '';
      if (lineNext) lineNext.textContent = '';
    }
  }

  if (window.RH_LYRICS && typeof window.RH_LYRICS.subscribe === 'function') {
    window.RH_LYRICS.subscribe((data) => {
      updateButton(data);
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
    getState() { return { active, key: lastKey, words: wordNodes.length, index: lastIndex }; },
  };
})();
