/* ==========================================================================
   RH—MUSIC · синхронизированные тексты — движок
   Работает поверх существующего <audio id="audio">: второй плеер не создаётся,
   источник аудио и Range-запросы не затрагиваются.

   Данные приходят с /api/lyrics/:id уже нормализованными:
     { syncLevel: 'line'|'plain'|'instrumental'|'none', offsetMs, lines:[{t,text,end?}], plain }
   Движок только ищет текущую строку бинарным поиском по времени аудио,
   подсвечивает её и аккуратно прокручивает контейнер.
   ========================================================================== */
(function () {
  'use strict';

  const API = '';
  const audio = document.getElementById('audio');
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const CACHE_LIMIT = 24;

  const state = {
    track: null,
    data: null,
    status: 'idle', // idle | loading | ready | error
    error: null,
    active: -1,
    seq: 0,
    controller: null,
    cache: new Map(),
  };

  const views = [];

  /* ───────────────────────────── утилиты ───────────────────────────── */

  function reducedMotion() {
    return !!(motionQuery && motionQuery.matches);
  }

  /** Бинарный поиск последней строки с t <= ms. -1, если время раньше первой. */
  function indexAt(lines, ms) {
    if (!Array.isArray(lines) || !lines.length) return -1;
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].t <= ms) { found = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return found;
  }

  function trimCache() {
    while (state.cache.size > CACHE_LIMIT) {
      state.cache.delete(state.cache.keys().next().value);
    }
  }

  function normalizeResponse(body) {
    const level = ['line', 'word', 'plain', 'instrumental', 'none'].includes(body.syncLevel)
      ? body.syncLevel
      : 'none';
    const lines = Array.isArray(body.lines) ? body.lines
      .filter((line) => line && Number.isFinite(Number(line.t)) && typeof line.text === 'string' && line.text.trim())
      .map((line) => {
        const entry = { t: Math.max(0, Number(line.t)), text: String(line.text).trim() };
        if (Number.isFinite(Number(line.end))) entry.end = Number(line.end);
        if (Array.isArray(line.words)) {
          const words = line.words
            .filter((word) => word && Number.isFinite(Number(word.t)) && typeof word.text === 'string' && word.text.trim())
            .map((word) => ({ t: Math.max(0, Number(word.t)), text: String(word.text).trim() }));
          if (words.length > 1) entry.words = words;
        }
        return entry;
      })
      .sort((a, b) => a.t - b.t)
      : [];
    return {
      syncLevel: level === 'line' || level === 'word' ? (lines.length ? level : 'none') : level,
      offsetMs: Number(body.offsetMs) || 0,
      lines,
      plain: typeof body.plain === 'string' ? body.plain : null,
      source: body.source || null,
      sourceLabel: body.sourceLabel || '',
      attribution: body.attribution || '',
      instrumental: body.instrumental === true || level === 'instrumental',
    };
  }

  /* ───────────────────────────── представления ───────────────────────────── */

  function createElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function messageBlock(title, note, withRetry) {
    const box = createElement('div', 'lyrics-empty');
    box.appendChild(createElement('p', 'lyrics-empty-title', title));
    if (note) box.appendChild(createElement('p', 'lyrics-empty-note', note));
    if (withRetry) {
      const button = createElement('button', 'btn btn-ghost btn-sm', 'Повторить');
      button.type = 'button';
      button.dataset.lyricsRetry = '1';
      box.appendChild(button);
    }
    return box;
  }

  function skeleton() {
    const box = createElement('div', 'lyrics-skeleton');
    for (const width of ['92%', '78%', '86%', '64%', '90%', '72%']) {
      const row = createElement('span', 'lyrics-skeleton-row');
      row.style.width = width;
      box.appendChild(row);
    }
    return box;
  }

  function setMeta(view, badge, source) {
    if (view.badgeEl) {
      view.badgeEl.textContent = badge || '';
      view.badgeEl.hidden = !badge;
    }
    if (view.sourceEl) {
      view.sourceEl.textContent = source || '';
      view.sourceEl.hidden = !source;
    }
    if (view.titleEl) {
      const track = state.track;
      view.titleEl.textContent = track ? track.title : 'Ничего не играет';
    }
  }

  function renderView(view) {
    if (!view || !view.scroll) return;
    view.scroll.textContent = '';
    view.nodes = [];
    view.activeNode = null;
    view.activeIndex = -1;
    view.userScroll = false;
    if (view.returnEl) view.returnEl.hidden = true;

    if (state.status === 'loading') {
      view.scroll.appendChild(skeleton());
      setMeta(view, 'Загрузка', '');
      return;
    }

    if (state.status === 'error') {
      view.scroll.appendChild(messageBlock('Не удалось загрузить текст', 'Источник временно недоступен. Попробуйте ещё раз.', true));
      setMeta(view, 'Ошибка', '');
      return;
    }

    const data = state.data;
    if (state.status === 'ready' && data) {
      if (data.syncLevel === 'none') {
        view.scroll.appendChild(messageBlock('Текст не найден', 'Для этой композиции текста нет ни в одном из источников.', false));
        setMeta(view, '', '');
        return;
      }
      if (data.syncLevel === 'instrumental' || data.instrumental) {
        view.scroll.appendChild(messageBlock('Инструментальная композиция', 'Источник подтверждает, что вокального текста нет.', false));
        setMeta(view, 'Инструментал', data.sourceLabel);
        return;
      }
      if (data.syncLevel === 'plain') {
        view.scroll.appendChild(createElement('div', 'lyrics-plain', data.plain || ''));
        setMeta(view, 'Без синхронизации', data.sourceLabel);
        return;
      }

      const fragment = document.createDocumentFragment();
      data.lines.forEach((line, index) => {
        const node = createElement('p', 'lyrics-line', line.text);
        node.dataset.index = String(index);
        node.dataset.time = String(line.t);
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        fragment.appendChild(node);
        view.nodes.push(node);
      });
      view.scroll.appendChild(fragment);
      setMeta(view, '', data.sourceLabel);
      return;
    }

    view.scroll.appendChild(messageBlock('Текст не выбран', 'Включите трек, чтобы увидеть текст.', false));
    setMeta(view, '', '');
  }

  function renderAll() {
    for (const view of views) renderView(view);
    if (state.status === 'ready' && state.data && (state.data.syncLevel === 'line' || state.data.syncLevel === 'word')) {
      state.active = -1;
      syncNow(true);
    }
  }

  /* ───────────────────────────── прокрутка ───────────────────────────── */

  function visible(view) {
    return !!view.scroll && view.scroll.clientHeight > 0 && view.scroll.offsetParent !== null;
  }

  function scrollToActive(view, behavior) {
    const node = view.nodes && view.nodes[state.active];
    if (!node) return;
    const top = node.offsetTop - view.scroll.clientHeight * 0.44 + node.offsetHeight / 2;
    const target = Math.max(0, top);
    const mode = behavior === 'smooth' && reducedMotion() ? 'auto' : behavior;
    view.programmatic = true;
    try {
      view.scroll.scrollTo({ top: target, behavior: mode });
    } catch {
      view.scroll.scrollTop = target;
    }
    window.setTimeout(() => { view.programmatic = false; }, mode === 'smooth' ? 700 : 60);
  }

  function setUserScroll(view, value) {
    if (!view) return;
    view.userScroll = !!value;
    if (view.returnEl) view.returnEl.hidden = !value;
  }

  function applyActive(index, forceScroll) {
    state.active = index;
    for (const view of views) {
      if (view.activeIndex === index && !forceScroll) continue;
      if (view.activeNode) view.activeNode.classList.remove('is-active');
      const node = view.nodes && view.nodes[index];
      view.activeNode = node || null;
      view.activeIndex = index;
      if (node) node.classList.add('is-active');
      if (node && !view.userScroll && visible(view)) {
        scrollToActive(view, forceScroll ? 'auto' : 'smooth');
      }
    }
  }

  function syncNow(forceScroll) {
    if (state.status !== 'ready' || !state.data || !audio) return;
    if (state.data.syncLevel !== 'line' && state.data.syncLevel !== 'word') return;
    const ms = (audio.currentTime || 0) * 1000 - (Number(state.data.offsetMs) || 0);
    const index = indexAt(state.data.lines, ms);
    if (index !== state.active) applyActive(index, false);
    else if (forceScroll) applyActive(index, true);
  }

  /* ───────────────────────────── загрузка ───────────────────────────── */

  async function load(track, force) {
    if (!track || !track.id) { clear(); return; }
    const id = String(track.id);
    if (!force && state.track && String(state.track.id) === id
      && (state.status === 'ready' || state.status === 'loading')) return;

    state.seq += 1;
    const seq = state.seq;
    if (state.controller) state.controller.abort();

    state.track = track;
    state.data = null;
    state.active = -1;
    state.error = null;
    state.status = 'loading';
    renderAll();

    const cached = state.cache.get(id);
    if (cached && !force) {
      state.data = cached;
      state.status = 'ready';
      renderAll();
      return;
    }

    const controller = new AbortController();
    state.controller = controller;
    try {
      const response = await fetch(`${API}/api/lyrics/${encodeURIComponent(id)}`, {
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (seq !== state.seq) return;
      if (!body || body.ok === false) {
        state.status = 'error';
        state.error = (body && body.error && body.error.code) || `HTTP ${response.status}`;
        renderAll();
        return;
      }
      const data = normalizeResponse(body);
      state.cache.set(id, data);
      trimCache();
      state.data = data;
      state.status = 'ready';
      renderAll();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (seq !== state.seq) return;
      state.status = 'error';
      state.error = 'NETWORK';
      renderAll();
    }
  }

  function clear() {
    state.seq += 1;
    if (state.controller) state.controller.abort();
    state.track = null;
    state.data = null;
    state.status = 'idle';
    state.active = -1;
    renderAll();
  }

  /* ───────────────────────────── события ───────────────────────────── */

  function onTime() { syncNow(false); }

  if (audio) {
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', () => syncNow(true));
    audio.addEventListener('playing', onTime);
    audio.addEventListener('loadedmetadata', () => syncNow(true));
    // 'emptied' намеренно не слушаем: смена src внутри playIndex сама вызывает
    // setTrack, и очистка по emptied отменила бы загрузку нового текста.
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNow(false);
  });

  /* ───────────────────────────── представления: регистрация ───────────────────────────── */

  function bindView(view) {
    if (!view || !view.scroll) return;
    views.push(view);

    const manual = () => {
      if (state.status !== 'ready') return;
      if (!state.data || (state.data.syncLevel !== 'line' && state.data.syncLevel !== 'word')) return;
      setUserScroll(view, true);
    };
    view.scroll.addEventListener('wheel', manual, { passive: true });
    view.scroll.addEventListener('touchstart', manual, { passive: true });
    view.scroll.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) manual();
    });

    view.scroll.addEventListener('click', (event) => {
      const retry = event.target.closest('[data-lyrics-retry]');
      if (retry) {
        if (state.track) load(state.track, true);
        return;
      }
      const node = event.target.closest('.lyrics-line');
      if (!node || !audio) return;
      const index = Number(node.dataset.index);
      const line = state.data && state.data.lines[index];
      if (!line) return;
      // Переход по строке: перематываем существующий плеер, ничего не дублируя.
      try {
        audio.currentTime = Math.max(0, (line.t + (Number(state.data.offsetMs) || 0)) / 1000);
      } catch { /* ignore */ }
      setUserScroll(view, false);
      applyActive(index, true);
      syncNow(false);
    });

    view.scroll.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const node = event.target.closest('.lyrics-line');
      if (!node) return;
      event.preventDefault();
      node.click();
    });

    if (view.returnEl) {
      view.returnEl.addEventListener('click', () => {
        setUserScroll(view, false);
        scrollToActive(view, 'smooth');
      });
    }
  }

  bindView({
    scroll: document.getElementById('lyricsScrollDesktop'),
    sourceEl: document.getElementById('lyricsSourceDesktop'),
    badgeEl: document.getElementById('lyricsBadgeDesktop'),
    titleEl: document.getElementById('lyricsTitleDesktop'),
    returnEl: document.getElementById('lyricsReturnDesktop'),
  });

  bindView({
    scroll: document.getElementById('lyricsScrollMobile'),
    sourceEl: document.getElementById('lyricsSourceMobile'),
    badgeEl: document.getElementById('lyricsBadgeMobile'),
    titleEl: document.getElementById('lyricsTitleMobile'),
    returnEl: document.getElementById('lyricsReturnMobile'),
  });

  /* ───────────────────────────── публичный интерфейс ───────────────────────────── */

  window.RH_LYRICS = {
    setTrack(track) { return load(track, false); },
    ensure() {
      if (state.status === 'idle' && state.track) return load(state.track, false);
      return Promise.resolve();
    },
    retry() { if (state.track) return load(state.track, true); return Promise.resolve(); },
    /** Пересчитать подсветку и положение после открытия панели/слоя. */
    refresh() {
      for (const view of views) {
        if (view.returnEl) view.returnEl.hidden = !view.userScroll;
      }
      if (state.status === 'ready') syncNow(true);
    },
    scrollToActive() {
      for (const view of views) {
        if (!visible(view)) continue;
        setUserScroll(view, false);
        scrollToActive(view, 'smooth');
      }
    },
    getState() {
      return {
        trackId: state.track ? String(state.track.id) : null,
        status: state.status,
        active: state.active,
        syncLevel: state.data ? state.data.syncLevel : null,
        lines: state.data ? state.data.lines.length : 0,
      };
    },
    _indexAt: indexAt,
  };
})();