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
    activeWord: -1,
    seq: 0,
    controller: null,
    cache: new Map(),
    wordsState: 'idle', // idle | loading | ready | none | error
    wordsWanted: false,
    wordsController: null,
    wordCache: new Map(),
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

  /** Бинарный поиск последнего слова с t <= ms внутри строки. */
  function wordIndexAt(words, ms) {
    if (!Array.isArray(words) || !words.length) return -1;
    let low = 0;
    let high = words.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (words[mid].t <= ms) { found = mid; low = mid + 1; }
      else high = mid - 1;
    }
    if (found < 0) return -1;
    // Между словами бывают паузы: закончившееся слово не должно оставаться
    // подсвеченным до начала следующего. Небольшой допуск гасит дрожание
    // на стыке меток.
    const end = Number(words[found].end);
    if (Number.isFinite(end) && ms > end + 120) return -1;
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
            .map((word) => {
              const item = { t: Math.max(0, Number(word.t)), text: String(word.text).trim() };
              if (Number.isFinite(Number(word.end))) item.end = Math.max(item.t, Number(word.end));
              return item;
            })
            .sort((a, b) => a.t - b.t);
          for (let i = 0; i < words.length; i += 1) {
            if (!Number.isFinite(words[i].end)) {
              words[i].end = i + 1 < words.length ? words[i + 1].t : words[i].t + 1;
            }
          }
          if (words.length > 1) entry.words = words;
        }
        return entry;
      })
      : [];
    const hasWords = lines.some((line) => Array.isArray(line.words) && line.words.length);
    const resolved = level === 'word' && !hasWords ? 'line' : level;
    return {
      syncLevel: resolved === 'line' || resolved === 'word' ? (lines.length ? resolved : 'none') : resolved,
      offsetMs: Number(body.offsetMs) || 0,
      lines,
      plain: typeof body.plain === 'string' ? body.plain : null,
      source: body.source || null,
      sourceLabel: body.sourceLabel || '',
      attribution: body.attribution || '',
      wordSourceLabel: body.wordSourceLabel || '',
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

  function setMeta(view, badge) {
    if (view.badgeEl) {
      view.badgeEl.textContent = badge || '';
      view.badgeEl.hidden = !badge;
    }
    if (view.titleEl) {
      const track = state.track;
      view.titleEl.textContent = track ? track.title : 'Ничего не играет';
    }
  }

  function ensureAtmosphere(view) {
    if (!view || !view.scroll || !view.scroll.parentElement) return null;
    let el = view.scroll.parentElement.querySelector(':scope > .lyrics-atmosphere');
    if (!el) {
      el = createElement('div', 'lyrics-atmosphere');
      view.scroll.parentElement.insertBefore(el, view.scroll);
    }
    view.atmosphere = el;
    return el;
  }

  function updateAtmosphere(track) {
    for (const view of views) {
      const el = ensureAtmosphere(view);
      if (!el) continue;
      if (track && track.cover) {
        el.style.backgroundImage = `url("${String(track.cover).replace(/"/g, '')}")`;
        el.classList.add('has-art');
      } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-art');
      }
    }
  }

  function applyCinematic(index) {
    for (const view of views) {
      if (!view.nodes) continue;
      view.nodes.forEach((node, i) => {
        node.classList.toggle('is-prev', index >= 0 && i < index);
        node.classList.toggle('is-next', index >= 0 && i > index);
      });
      const host = view.scroll && view.scroll.parentElement;
      if (host) {
        host.classList.add('is-cinematic');
        host.classList.toggle('is-instrumental', index < 0);
      }
      if (view.atmosphere) view.atmosphere.classList.toggle('is-active', index >= 0);
    }
  }

  function renderView(view) {
    if (!view || !view.scroll) return;
    view.scroll.textContent = '';
    view.scroll.scrollTop = 0;
    view.nodes = [];
    view.activeNode = null;
    view.activeWordNode = null;
    view.activeIndex = -1;
    view.userScroll = false;
    if (view.returnEl) view.returnEl.hidden = true;
    const host = view.scroll.parentElement;
    if (host) host.classList.add('is-cinematic');
    ensureAtmosphere(view);

    if (state.status === 'loading') {
      view.scroll.appendChild(skeleton());
      setMeta(view, 'Загрузка');
      return;
    }

    if (state.status === 'error') {
      view.scroll.appendChild(messageBlock('Не удалось загрузить текст', 'Источник временно недоступен. Попробуйте ещё раз.', true));
      setMeta(view, 'Ошибка');
      return;
    }

    const data = state.data;
    if (state.status === 'ready' && data) {
      if (data.syncLevel === 'none') {
        view.scroll.appendChild(messageBlock('Текст не найден', 'Для этой композиции текста нет ни в одном из источников.', false));
        setMeta(view, '');
        return;
      }
      if (data.syncLevel === 'instrumental' || data.instrumental) {
        view.scroll.appendChild(messageBlock('Инструментальная композиция', 'Источник подтверждает, что вокального текста нет.', false));
        setMeta(view, 'Инструментал');
        return;
      }
      if (data.syncLevel === 'plain') {
        view.scroll.appendChild(createElement('div', 'lyrics-plain', data.plain || ''));
        setMeta(view, 'Без синхронизации');
        return;
      }

      const fragment = document.createDocumentFragment();
      data.lines.forEach((line, index) => {
        const hasWords = Array.isArray(line.words) && line.words.length > 0;
        const node = hasWords ? createElement('p', 'lyrics-line has-words') : createElement('p', 'lyrics-line', line.text);
        node.dataset.index = String(index);
        node.dataset.time = String(line.t);
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        if (hasWords) {
          // Слова разделяются текстовыми узлами: пунктуация и пробелы остаются
          // исходными, а подсветка не меняет геометрию строки.
          node._wordNodes = line.words.map((word, wordIndex) => {
            const span = createElement('span', 'lyrics-word', word.text);
            span.dataset.word = String(wordIndex);
            node.appendChild(span);
            if (wordIndex + 1 < line.words.length) node.appendChild(document.createTextNode(' '));
            return span;
          });
        }
        fragment.appendChild(node);
        view.nodes.push(node);
      });
      view.scroll.appendChild(fragment);
      updateAtmosphere(state.track);
      applyCinematic(-1);
      setMeta(view, '');
      return;
    }

    view.scroll.appendChild(messageBlock('Текст не выбран', 'Включите трек, чтобы увидеть текст.', false));
    setMeta(view, '');
  }

  function renderAll() {
    for (const view of views) renderView(view);
    state.active = -1;
    state.activeWord = -1;
    if (state.status === 'ready' && state.data && (state.data.syncLevel === 'line' || state.data.syncLevel === 'word')) {
      syncNow(true);
    }
  }

  /* ───────────────────────────── прокрутка ───────────────────────────── */

  function isMobileUI() {
    return document.documentElement && document.documentElement.dataset.ui === 'mobile';
  }

  function visible(view) {
    return !!view.scroll && view.scroll.clientHeight > 0 && view.scroll.offsetParent !== null;
  }

  function scrollToActive(view, behavior) {
    const node = view.nodes && view.nodes[state.active];
    if (!node) return;
    // offsetTop зависит от ближайшего позиционированного предка и на скрытых
    // панелях даёт скачок «в середину». Считаем позицию от фактического rect.
    const nodeRect = node.getBoundingClientRect();
    const hostRect = view.scroll.getBoundingClientRect();
    const nodeTop = (nodeRect.top - hostRect.top) + view.scroll.scrollTop;
    const top = nodeTop - view.scroll.clientHeight * 0.44 + nodeRect.height / 2;
    const target = Math.max(0, top);
    const mode = behavior === 'smooth' && !reducedMotion() && !isMobileUI() ? 'smooth' : 'auto';
    const before = view.scroll.scrollTop;
    view.programmatic = true;
    if (mode === 'auto') {
      view.scroll.scrollTop = target;
    } else {
      try {
        view.scroll.scrollTo({ top: target, behavior: mode });
      } catch {
        view.scroll.scrollTop = target;
      }
    }
    // В WebKit без поддержки плавного scrollTo позиция может не измениться —
    // тогда доводим её вручную, чтобы автопрокрутка и возврат работали всегда.
    window.setTimeout(() => {
      if (mode === 'smooth' && Math.abs(view.scroll.scrollTop - before) < 2
        && Math.abs(before - target) > 2) {
        view.scroll.scrollTop = target;
      }
      view.programmatic = false;
    }, mode === 'smooth' ? 340 : 60);
  }

  function setUserScroll(view, value) {
    if (!view) return;
    view.userScroll = !!value;
    if (view.returnEl) view.returnEl.hidden = !value;
  }

  function applyWord(index, wordIndex, ms) {
    state.activeWord = wordIndex;
    for (const view of views) {
      if (view.activeWordNode) view.activeWordNode.classList.remove('is-active');
      const lineNode = view.nodes && view.nodes[index];
      const nodes = lineNode && lineNode._wordNodes;
      const node = nodes && nodes[wordIndex] ? nodes[wordIndex] : null;
      view.activeWordNode = node;
      if (node) node.classList.add('is-active');
      const line = state.data && state.data.lines[index];
      if (line && Array.isArray(line.words)) {
        line.words.forEach((word, i) => {
          const target = nodes && nodes[i];
          if (!target) return;
          const at = Number.isFinite(ms) ? ms : 0;
          if (at >= word.end) {
            target.classList.add('is-done');
            target.classList.remove('is-active');
            target.style.setProperty('--p', '1');
          } else if (at >= word.t) {
            const progress = Math.max(0, Math.min(1, (at - word.t) / Math.max(1, word.end - word.t)));
            target.classList.remove('is-done');
            if (i !== wordIndex) target.classList.remove('is-active');
            target.style.setProperty('--p', progress.toFixed(3));
          } else {
            target.classList.remove('is-active', 'is-done');
            target.style.setProperty('--p', '0');
          }
        });
      }
    }
  }

  function wordIndexFor(index, ms) {
    const line = state.data && state.data.lines[index];
    if (!line || !Array.isArray(line.words) || !line.words.length) return -1;
    return wordIndexAt(line.words, ms);
  }

  function applyActive(index, forceScroll) {
    state.active = index;
    const ms = audio ? (audio.currentTime || 0) * 1000 - (Number(state.data && state.data.offsetMs) || 0) : 0;
    for (const view of views) {
      if (view.activeIndex === index && !forceScroll) continue;
      if (view.activeNode) view.activeNode.classList.remove('is-active');
      if (index < 0) view.scroll.scrollTop = 0;
      const node = view.nodes && view.nodes[index];
      view.activeNode = node || null;
      view.activeIndex = index;
      if (node) node.classList.add('is-active');
      if (node && !view.userScroll && visible(view)) {
        scrollToActive(view, forceScroll ? 'auto' : 'smooth');
      }
    }
    applyWord(index, wordIndexFor(index, ms), ms);
    applyCinematic(index);
  }

  function syncNow(forceScroll) {
    if (state.status !== 'ready' || !state.data || !audio) return;
    if (state.data.syncLevel !== 'line' && state.data.syncLevel !== 'word') return;
    const ms = (audio.currentTime || 0) * 1000 - (Number(state.data.offsetMs) || 0);
    const index = indexAt(state.data.lines, ms);
    if (index !== state.active || forceScroll) {
      applyActive(index, forceScroll);
      return;
    }
    const wordIndex = wordIndexFor(index, ms);
    applyWord(index, wordIndex, ms);
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

    if (state.wordsController) state.wordsController.abort();
    state.wordsState = 'idle';
    state.track = track;
    state.data = null;
    state.active = -1;
    state.activeWord = -1;
    state.error = null;
    state.status = 'loading';
    renderAll();
    updateAtmosphere(track);

    const cached = state.cache.get(id);
    if (cached && !force) {
      state.data = cached;
      state.status = 'ready';
      renderAll();
      maybeLoadWords();
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
      maybeLoadWords();
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
    if (state.wordsController) state.wordsController.abort();
    state.wordsState = 'idle';
    state.track = null;
    state.data = null;
    state.status = 'idle';
    state.active = -1;
    state.activeWord = -1;
    renderAll();
    updateAtmosphere(null);
  }

  /* ───────────────────────────── слова (word-level) ───────────────────────────── */

  function maybeLoadWords() {
    if (!state.wordsWanted) return;
    if (state.wordsState !== 'idle') return;
    if (!state.data || (state.data.syncLevel !== 'line' && state.data.syncLevel !== 'plain')) return;
    loadWords();
  }

  function applyWordData(data, body) {
    state.data = data;
    state.data.wordSourceLabel = body.wordSourceLabel || '';
    state.wordsState = 'ready';
    renderAll();
  }

  async function loadWords() {
    const track = state.track;
    if (!track || !track.id) return;
    const id = String(track.id);
    const cached = state.wordCache.get(id);
    if (cached === 'none') { state.wordsState = 'none'; return; }
    if (cached && cached.data) { applyWordData(cached.data, cached.body); return; }

    state.wordsState = 'loading';
    const seq = state.seq;
    if (state.wordsController) state.wordsController.abort();
    const controller = new AbortController();
    state.wordsController = controller;
    try {
      const response = await fetch(`${API}/api/lyrics/${encodeURIComponent(id)}/words`, {
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (seq !== state.seq || !state.track || String(state.track.id) !== id) return;
      if (!response.ok || !body || body.ok === false || body.syncLevel !== 'word' || !Array.isArray(body.lines)) {
        state.wordsState = 'none';
        state.wordCache.set(id, 'none');
        return;
      }
      const data = normalizeResponse({ ...state.data, syncLevel: 'word', lines: body.lines, plain: null, offsetMs: 0 });
      if (data.syncLevel !== 'word' || !data.lines.some((line) => line.words)) {
        state.wordsState = 'none';
        state.wordCache.set(id, 'none');
        return;
      }
      data.wordSourceLabel = body.wordSourceLabel || '';
      state.wordCache.set(id, { data, body });
      while (state.wordCache.size > CACHE_LIMIT) state.wordCache.delete(state.wordCache.keys().next().value);
      applyWordData(data, body);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (seq !== state.seq) return;
      state.wordsState = 'error';
    }
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
    // Ручной скролл возвращается к автослежению, когда пользователь сам
    // подвёл текущую строку к центру — отдельная кнопка для этого не нужна.
    view.scroll.addEventListener('scroll', () => {
      if (!view.userScroll || view.programmatic || state.active < 0) return;
      const node = view.nodes && view.nodes[state.active];
      if (!node) return;
      const host = view.scroll.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const nodeCenter = rect.top + rect.height / 2;
      const hostCenter = host.top + host.height / 2;
      if (Math.abs(nodeCenter - hostCenter) < host.height * 0.24) setUserScroll(view, false);
    }, { passive: true });
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
      // Клик по слову перематывает к слову, по остальной строке — к строке.
      const wordNode = event.target.closest('.lyrics-word');
      const word = wordNode && Array.isArray(line.words)
        ? line.words[Number(wordNode.dataset.word)]
        : null;
      const target = word && Number.isFinite(word.t) ? word.t : line.t;
      try {
        audio.currentTime = Math.max(0, (target + (Number(state.data.offsetMs) || 0)) / 1000);
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
    badgeEl: document.getElementById('lyricsBadgeDesktop'),
    titleEl: document.getElementById('lyricsTitleDesktop'),
    returnEl: document.getElementById('lyricsReturnDesktop'),
  });

  bindView({
    scroll: document.getElementById('lyricsScrollMobile'),
    badgeEl: document.getElementById('lyricsBadgeMobile'),
    titleEl: document.getElementById('lyricsTitleMobile'),
    returnEl: document.getElementById('lyricsReturnMobile'),
  });

  /* ───────────────────────────── публичный интерфейс ───────────────────────────── */

  window.RH_LYRICS = {
    setTrack(track) { return load(track, false); },
    ensure() {
      state.wordsWanted = true;
      if (state.status === 'idle' && state.track) {
        return load(state.track, false).then(() => { maybeLoadWords(); });
      }
      maybeLoadWords();
      return Promise.resolve();
    },
    retry() { if (state.track) return load(state.track, true); return Promise.resolve(); },
    /** Пересчитать подсветку и положение после открытия панели/слоя. */
    refresh() {
      for (const view of views) {
        if (view.returnEl) view.returnEl.hidden = !view.userScroll;
      }
      if (state.status === 'ready') {
        // Панель могла только что открыться: даём layout и затем ведём к строке.
        window.setTimeout(() => syncNow(true), 0);
      }
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
        activeWord: state.activeWord,
        wordsState: state.wordsState,
        syncLevel: state.data ? state.data.syncLevel : null,
        lines: state.data ? state.data.lines.length : 0,
      };
    },
    _indexAt: indexAt,
  };
})();