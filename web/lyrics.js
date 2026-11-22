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
    letterRaf: 0,
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

  /** Разбивает строку на code points: кириллица/латиница/эмодзи — по одному. */
  function codePoints(value) {
    return Array.from(String(value == null ? '' : value));
  }

  /** Конец строки: явный end, следующая строка или запас 4 с. */
  function lineEndOf(lines, index) {
    const line = lines[index];
    if (Number.isFinite(line.end)) return Math.max(line.t, line.end);
    const next = lines[index + 1];
    return next && next.t > line.t ? next.t : line.t + 4000;
  }

  /**
   * Создаёт посимвольные тайминги для слова.
   * Метки слов настоящие; внутри слова время распределяется равномерно —
   * это интерполяция, а не выдуманные пословные метки.
   */
  function letterTimingsForWord(word, wordEnd, wordIndex, words, offset) {
    const chars = codePoints(word.text);
    const end = Number.isFinite(wordEnd)
      ? Math.max(word.t, wordEnd)
      : (wordIndex + 1 < words.length ? words[wordIndex + 1].t : word.t + 1000);
    const base = word.t + (Number(offset) || 0);
    const span = Math.max(1, end - word.t);
    return chars.map((ch, ci) => ({
      ch,
      start: base + (span * ci) / chars.length,
      end: base + (span * (ci + 1)) / chars.length,
    }));
  }

  /** Прогресс буквы 0..1 по фактическому времени аудио. */
  function letterProgress(item, ms) {
    return Math.max(0, Math.min(1, (ms - item.start) / Math.max(1, item.end - item.start)));
  }

  /** Интерполяция букв по строке, если есть только построчные метки. */
  function letterTimingsForLine(line, end, offset) {
    const chars = codePoints(line.text);
    const base = line.t + (Number(offset) || 0);
    const span = Math.max(1, end - line.t);
    return chars.map((ch, ci) => ({
      ch,
      start: base + (span * ci) / chars.length,
      end: base + (span * (ci + 1)) / chars.length,
    }));
  }

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

  function renderView(view) {
    if (!view || !view.scroll) return;
    view.scroll.textContent = '';
    view.nodes = [];
    view.activeNode = null;
    view.activeWordNode = null;
    view.activeIndex = -1;
    view.userScroll = false;
    if (view.returnEl) view.returnEl.hidden = true;

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
        const node = hasWords ? createElement('p', 'lyrics-line has-words') : createElement('p', 'lyrics-line');
        node.dataset.index = String(index);
        node.dataset.time = String(line.t);
        node.dataset.letterSource = hasWords ? 'word' : 'line';
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node._letterNodes = [];
        const offset = Number(data.offsetMs) || 0;
        const lineEnd = lineEndOf(data.lines, index) + offset;
        if (hasWords) {
          // Каждое слово — span, внутри него буквы — отдельные span.
          // Пробелы остаются текстовыми узлами, пунктуация — внутри слова.
          node._wordNodes = line.words.map((word, wordIndex) => {
            const span = createElement('span', 'lyrics-word');
            span.dataset.word = String(wordIndex);
            const timings = letterTimingsForWord(word, word.end, wordIndex, line.words, offset);
            timings.forEach((item, letterIndex) => {
              const letter = createElement('span', 'lyrics-letter', item.ch);
              letter.dataset.letter = String(letterIndex);
              node._letterNodes.push({ el: letter, start: item.start, end: item.end });
              span.appendChild(letter);
            });
            node.appendChild(span);
            if (wordIndex + 1 < line.words.length) node.appendChild(document.createTextNode(' '));
            return span;
          });
        } else {
          const timings = letterTimingsForLine(line, lineEnd, offset);
          timings.forEach((item, letterIndex) => {
            const letter = createElement('span', 'lyrics-letter', item.ch);
            letter.dataset.letter = String(letterIndex);
            node._letterNodes.push({ el: letter, start: item.start, end: item.end });
            node.appendChild(letter);
          });
        }
        if (node._letterNodes.length) node.classList.add('has-letters');
        fragment.appendChild(node);
        view.nodes.push(node);
      });
      view.scroll.appendChild(fragment);
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

  function visible(view) {
    return !!view.scroll && view.scroll.clientHeight > 0 && view.scroll.offsetParent !== null;
  }

  function scrollToActive(view, behavior) {
    const node = view.nodes && view.nodes[state.active];
    if (!node) return;
    const top = node.offsetTop - view.scroll.clientHeight * 0.44 + node.offsetHeight / 2;
    const target = Math.max(0, top);
    const mode = behavior === 'smooth' && reducedMotion() ? 'auto' : behavior;
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

  function applyWord(index, wordIndex) {
    state.activeWord = wordIndex;
    for (const view of views) {
      if (view.activeWordNode) view.activeWordNode.classList.remove('is-active');
      const lineNode = view.nodes && view.nodes[index];
      const nodes = lineNode && lineNode._wordNodes;
      const node = nodes && nodes[wordIndex] ? nodes[wordIndex] : null;
      view.activeWordNode = node;
      if (node) node.classList.add('is-active');
    }
  }


  /** Полный пересчёт букв активной строки: используется при перемотке. */
  function resetLetters(view, index, ms) {
    const node = view.nodes && view.nodes[index];
    const letters = node && node._letterNodes;
    if (!letters || !letters.length) {
      view._letterLine = index;
      view._letterCursor = 0;
      return;
    }
    let cursor = 0;
    for (let i = 0; i < letters.length; i += 1) {
      const item = letters[i];
      const el = item.el;
      if (ms >= item.end) {
        el.classList.add('is-done');
        el.classList.remove('is-current');
        el.style.setProperty('--p', '100%');
        cursor = i + 1;
      } else if (ms >= item.start) {
        const progress = letterProgress(item, ms);
        el.classList.remove('is-done');
        el.classList.add('is-current');
        el.style.setProperty('--p', `${(progress * 100).toFixed(1)}%`);
        cursor = i;
      } else {
        el.classList.remove('is-done', 'is-current');
        el.style.setProperty('--p', '0%');
      }
    }
    view._letterLine = index;
    view._letterCursor = cursor;
    view._letterMs = ms;
  }

  /** Обновляет только активную букву и уже исполненные; не трогает всю панель. */
  function applyLetters(index, ms, force) {
    for (const view of views) {
      const node = view.nodes && view.nodes[index];
      const letters = node && node._letterNodes;
      if (!letters || !letters.length) continue;
      const backwards = Number.isFinite(view._letterMs) && ms < view._letterMs - 120;
      if (force || backwards || view._letterLine !== index) {
        resetLetters(view, index, ms);
        continue;
      }
      let cursor = view._letterCursor || 0;
      while (cursor < letters.length && ms >= letters[cursor].end) {
        const done = letters[cursor];
        done.el.classList.add('is-done');
        done.el.classList.remove('is-current');
        done.el.style.setProperty('--p', '100%');
        cursor += 1;
      }
      if (cursor < letters.length && ms >= letters[cursor].start) {
        const item = letters[cursor];
        const progress = letterProgress(item, ms);
        item.el.classList.remove('is-done');
        item.el.classList.add('is-current');
        item.el.style.setProperty('--p', `${(progress * 100).toFixed(1)}%`);
      }
      view._letterCursor = cursor;
      view._letterLine = index;
      view._letterMs = ms;
    }
  }

  function stopLetterLoop() {
    if (state.letterRaf) {
      cancelAnimationFrame(state.letterRaf);
      state.letterRaf = 0;
    }
  }

  function startLetterLoop() {
    if (reducedMotion() || state.letterRaf || !audio) return;
    const step = () => {
      state.letterRaf = 0;
      if (!audio || audio.paused || audio.ended || document.hidden) return;
      syncNow(false);
      state.letterRaf = requestAnimationFrame(step);
    };
    state.letterRaf = requestAnimationFrame(step);
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
      const node = view.nodes && view.nodes[index];
      view.activeNode = node || null;
      view.activeIndex = index;
      view._letterLine = -1;
      view._letterCursor = 0;
      if (node) node.classList.add('is-active');
      if (node && !view.userScroll && visible(view)) {
        scrollToActive(view, forceScroll ? 'auto' : 'smooth');
      }
    }
    applyWord(index, wordIndexFor(index, ms));
    applyLetters(index, ms, true);
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
    if (wordIndex !== state.activeWord) applyWord(index, wordIndex);
    applyLetters(index, ms, false);
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

    stopLetterLoop();
    if (state.wordsController) state.wordsController.abort();
    state.wordsState = 'idle';
    state.track = track;
    state.data = null;
    state.active = -1;
    state.activeWord = -1;
    state.error = null;
    state.status = 'loading';
    renderAll();

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
    stopLetterLoop();
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
    audio.addEventListener('seeked', () => { syncNow(true); applyLetters(state.active, (audio.currentTime || 0) * 1000, true); });
    audio.addEventListener('playing', () => { onTime(); startLetterLoop(); });
    audio.addEventListener('pause', () => { stopLetterLoop(); applyLetters(state.active, (audio.currentTime || 0) * 1000, true); });
    audio.addEventListener('ended', () => stopLetterLoop());
    audio.addEventListener('loadedmetadata', () => { syncNow(true); startLetterLoop(); });
    // 'emptied' намеренно не слушаем: смена src внутри playIndex сама вызывает
    // setTrack, и очистка по emptied отменила бы загрузку нового текста.
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLetterLoop();
    } else {
      syncNow(false);
      if (audio && !audio.paused) startLetterLoop();
    }
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
        activeWord: state.activeWord,
        wordsState: state.wordsState,
        syncLevel: state.data ? state.data.syncLevel : null,
        lines: state.data ? state.data.lines.length : 0,
      };
    },
    _indexAt: indexAt,
  };
})();