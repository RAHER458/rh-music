/* RH—MUSIC «Текст» — основной режим Now Playing.
   Три строки: предыдущая (сверху, с блюром), текущая (в центре, поётся)
   и следующая (снизу, с блюром). При смене строки текущая плавно уходит
   вверх и размывается, следующая поднимается в центр, а снизу появляется
   новая строка. Использует существующий RH_LYRICS; второй плеер не создаётся. */
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
  let prevEl = null;
  let currEl = null;
  let nextEl = null;
  let wordNodes = [];
  let raf = 0;
  let noticeEl = null;
  let noticeTimer = 0;
  let pendingEnable = false;
  let pendingTimer = 0;
  let lastIndex = null;
  let lastMain = '';
  let lastNext = '';
  let lastPrev = '';

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
    return {
      prev: data.prevText || '',
      main: data.text || '...',
      next: data.nextText || '',
    };
  }

  function ensureText() {
    if (textEl) return;
    textEl = document.createElement('div');
    textEl.className = 'np-lyrics-beta-text';
    art.appendChild(textEl);
  }

  function makeLine(className, text) {
    const el = document.createElement('span');
    el.className = `np-lb-line ${className}`;
    el.textContent = text || '';
    textEl.appendChild(el);
    return el;
  }

  function setPlain(el, text) {
    if (!el) return;
    el.textContent = text || '';
  }

  function setWords(el, data) {
    wordNodes = [];
    if (!el) return;
    el.textContent = '';
    const words = data && Array.isArray(data.words) ? data.words : null;
    if (!words || words.length < 2) {
      el.textContent = data && data.text ? data.text : '';
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

  function clearLines() {
    if (!textEl) return;
    for (const el of textEl.querySelectorAll('.np-lb-line')) el.remove();
    prevEl = null;
    currEl = null;
    nextEl = null;
    wordNodes = [];
  }

  function rebuild(data) {
    ensureText();
    clearLines();
    const { prev, main, next } = format(data);
    prevEl = makeLine('is-prev', prev);
    currEl = makeLine('is-current', main);
    nextEl = makeLine('is-next', next);
    setWords(currEl, data);
    lastIndex = data && Number.isFinite(Number(data.index)) ? Number(data.index) : null;
    lastMain = main;
    lastNext = next;
    lastPrev = prev;
  }

  function animateRole(el, className) {
    if (!el) return;
    el.classList.remove('is-prev', 'is-current', 'is-next', 'is-entering-up', 'is-entering-down', 'is-leaving-up', 'is-leaving-down');
    void el.offsetWidth;
    el.classList.add(className);
  }

  function dropLater(el, ms = 420) {
    if (!el) return;
    window.setTimeout(() => el.remove(), ms);
  }

  function advance(payloadData, direction) {
    ensureText();
    const { prev, main, next } = format(payloadData);
    if (direction > 0) {
      // Текущая уходит наверх в блюр, следующая поднимается в центр.
      if (prevEl) {
        animateRole(prevEl, 'is-leaving-up');
        dropLater(prevEl);
      }
      const oldCurr = currEl;
      const oldNext = nextEl;
      prevEl = oldCurr;
      currEl = oldNext;
      nextEl = null;
      if (prevEl) {
        prevEl.classList.remove(...prevEl.classList);
        prevEl.className = 'np-lb-line is-prev';
        setPlain(prevEl, lastMain);
      }
      if (currEl) {
        currEl.classList.remove(...currEl.classList);
        currEl.className = 'np-lb-line is-current';
        setWords(currEl, payloadData);
      }
      nextEl = makeLine('is-next is-entering-down', next);
      void nextEl.offsetWidth;
      nextEl.classList.remove('is-entering-down');
    } else {
      // Обратный переход: текущая уходит вниз, предыдущая поднимается в центр.
      if (nextEl) {
        animateRole(nextEl, 'is-leaving-down');
        dropLater(nextEl);
      }
      const oldCurr = currEl;
      const oldPrev = prevEl;
      nextEl = oldCurr;
      currEl = oldPrev;
      prevEl = null;
      if (nextEl) {
        nextEl.classList.remove(...nextEl.classList);
        nextEl.className = 'np-lb-line is-next';
        setPlain(nextEl, lastMain);
      }
      if (currEl) {
        currEl.classList.remove(...currEl.classList);
        currEl.className = 'np-lb-line is-current';
        setWords(currEl, payloadData);
      }
      prevEl = makeLine('is-prev is-entering-up', prev);
      void prevEl.offsetWidth;
      prevEl.classList.remove('is-entering-up');
    }
    lastIndex = Number(payloadData.index);
    lastMain = main;
    lastNext = next;
    lastPrev = prev;
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

  function render(data) {
    if (!active) return;
    ensureText();
    const { prev, main, next } = format(data);
    const key = `${data && data.index}:${prev}:${main}:${next}:${data && data.words ? data.words.length : 0}`;
    if (key === lastKey) return;
    lastKey = key;
    payload = data || null;

    const index = data && Number.isFinite(Number(data.index)) ? Number(data.index) : null;
    if (!currEl || index == null || lastIndex == null) { rebuild(data); startLoop(); return; }
    if (index === lastIndex) {
      // Слова могли догрузиться для той же строки.
      setWords(currEl, data);
      if (next !== lastNext && nextEl) setPlain(nextEl, next);
      if (prev !== lastPrev && prevEl) setPlain(prevEl, prev);
      lastNext = next;
      lastPrev = prev;
      updateWords();
      startLoop();
      return;
    }
    const direction = index - lastIndex;
    if (Math.abs(direction) === 1) { advance(data, direction); return; }
    rebuild(data);
    startLoop();
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
      clearLines();
      lastKey = '';
      lastIndex = null;
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
