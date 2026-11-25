/* RH—MUSIC · Mobile Settings Center
   Изолированный экспериментальный слой. Не меняет backend/API/D1/OAuth.
   Все настройки хранятся локально и применяются к presentation-слою. */
(() => {
  'use strict';

  const KEY = 'rh_settings_v1';
  const VERSION = '2026.11-settings-lab';
  const STORE = (() => {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  })();

  const DEFAULTS = {
    resumePlayback: true,
    openHomeOnLaunch: true,
    theme: 'dark',
    accent: 'default',
    dynamicCover: true,
    coverGlow: true,
    reduceMotion: false,
    cardSize: 'standard',
    swipeCover: true,
    swipeMini: true,
    automix: false,
    smartmix: true,
    mediaSession: true,
    saveHistory: true,
    personalization: true,
  };

  const state = { ...DEFAULTS, ...STORE };

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  function get(key) { return state[key]; }

  function set(key, value) {
    state[key] = value;
    persist();
    apply();
    return value;
  }

  function apply() {
    const root = document.documentElement;
    root.dataset.theme = state.theme === 'amoled' ? 'amoled' : 'dark';
    root.dataset.accent = state.accent || 'default';
    root.dataset.reduceMotion = state.reduceMotion ? '1' : '0';
    root.dataset.coverGlow = state.coverGlow ? '1' : '0';
    root.dataset.dynamicCover = state.dynamicCover ? '1' : '0';
    root.dataset.cardSize = state.cardSize || 'standard';
    root.dataset.mediaSession = state.mediaSession ? '1' : '0';
    document.body.classList.toggle('settings-reduced-motion', !!state.reduceMotion);
    document.body.classList.toggle('settings-no-glow', !state.coverGlow);
    if ('mediaSession' in navigator && !state.mediaSession) navigator.mediaSession.metadata = null;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M14.7 4.3a1 1 0 0 1 0 1.4L8.4 12l6.3 6.3a1 1 0 1 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z"/></svg>',
    general: '<svg viewBox="0 0 24 24"><path d="M12 3.2a1 1 0 0 1 .95.68l.7 2.1a7 7 0 0 1 1.9.8l2.1-.7a1 1 0 0 1 1.16.47l1 1.7a1 1 0 0 1-.25 1.28l-1.7 1.35a7 7 0 0 1 0 2.1l1.7 1.35a1 1 0 0 1 .25 1.28l-1 1.7a1 1 0 0 1-1.16.47l-2.1-.7a7 7 0 0 1-1.9.8l-.7 2.1a1 1 0 0 1-.95.68h-2a1 1 0 0 1-.95-.68l-.7-2.1a7 7 0 0 1-1.9-.8l-2.1.7a1 1 0 0 1-1.16-.47l-1-1.7a1 1 0 0 1 .25-1.28l1.7-1.35a7 7 0 0 1 0-2.1L5.4 8.7a1 1 0 0 1-.25-1.28l1-1.7A1 1 0 0 1 7.3 5.25l2.1.7a7 7 0 0 1 1.9-.8l.7-2.1A1 1 0 0 1 12 3.2Zm0 5.3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/></svg>',
    appearance: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 2.5 2.5 0 0 0 0-5 1.5 1.5 0 0 1 0-3h2.2A4.8 4.8 0 0 0 19 8.2 5.2 5.2 0 0 0 13.8 3H12Zm-4.2 6a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm4.4-1.4a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"/></svg>',
    player: '<svg viewBox="0 0 24 24"><path d="M8 5.2c0-1 1.1-1.6 2-1.1l9.4 6.3a1.3 1.3 0 0 1 0 2.2L10 19c-.9.5-2-.1-2-1.1V5.2Z"/></svg>',
    ai: '<svg viewBox="0 0 24 24"><path d="M12 2.6a1 1 0 0 1 .95.68l1.9 5.6 5.6 1.9a1 1 0 0 1 0 1.9l-5.6 1.9-1.9 5.6a1 1 0 0 1-1.9 0l-1.9-5.6-5.6-1.9a1 1 0 0 1 0-1.9l5.6-1.9 1.9-5.6A1 1 0 0 1 12 2.6Z"/></svg>',
    storage: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4V6Zm2 2v8h12V8H6Zm1.5 1.5h9v2h-9v-2Z"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-5-1.4-1.4V10a5.6 5.6 0 0 0-4.1-5.4V4a1.5 1.5 0 0 0-3 0v.6A5.6 5.6 0 0 0 6.4 10v5.6L5 17v1h14v-1Z"/></svg>',
    privacy: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm0 5a3 3 0 0 1 3 3v1h1v5H8v-5h1v-1a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v1h2v-1a1 1 0 0 0-1-1Z"/></svg>',
    account: '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2-7 4.5V21h14v-2.5C19 16 16 14 12 14Z"/></svg>',
    about: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a1.3 1.3 0 1 1 0 2.6A1.3 1.3 0 0 1 12 6Zm1.5 12h-3v-1.2h.9V11h-.9V9.8h3v7.8h.9V18Z"/></svg>',
  };

  const SECTIONS = [
    { id: 'general', title: 'Общие', icon: ICON.general, sub: 'Запуск, восстановление, язык' },
    { id: 'appearance', title: 'Внешний вид', icon: ICON.appearance, sub: 'Тема, акцент, карточки' },
    { id: 'player', title: 'Плеер', icon: ICON.player, sub: 'Жесты, таймер, вибрация' },
    { id: 'ai', title: 'RH AI', icon: ICON.ai, sub: 'AutoMix и Smart Mix' },
    { id: 'storage', title: 'Хранилище и кеш', icon: ICON.storage, sub: 'Данные приложения' },
    { id: 'notifications', title: 'Уведомления', icon: ICON.bell, sub: 'Экран блокировки и медиа' },
    { id: 'privacy', title: 'Конфиденциальность', icon: ICON.privacy, sub: 'История и персонализация' },
    { id: 'account', title: 'Аккаунт', icon: ICON.account, sub: 'Профиль и выход' },
    { id: 'about', title: 'О RH—MUSIC', icon: ICON.about, sub: 'Версия и информация' },
  ];

  function row({ title, sub = '', control = '', action = '', danger = false, disabled = false }) {
    return `<div class="st-row${danger ? ' is-danger' : ''}${disabled ? ' is-disabled' : ''}"${action ? ` data-st-action="${esc(action)}"` : ''}>
      <span class="st-row-text"><span class="st-row-title">${esc(title)}</span>${sub ? `<span class="st-row-sub">${esc(sub)}</span>` : ''}</span>
      <span class="st-row-control">${control}</span>
    </div>`;
  }

  function toggle(key) {
    return `<span class="st-switch${get(key) ? ' is-on' : ''}" data-st-toggle="${esc(key)}" role="switch" aria-checked="${get(key) ? 'true' : 'false'}"></span>`;
  }

  function toggleSetting(key, active) {
    return `<span class="st-switch${active ? ' is-on' : ''}" data-st-toggle="${esc(key)}" role="switch" aria-checked="${active ? 'true' : 'false'}"></span>`;
  }

  function choice(key, options) {
    return `<span class="st-choice">${options.map(([value, label]) =>
      `<button class="st-choice-item${String(get(key)) === String(value) ? ' is-active' : ''}" type="button" data-st-choice="${esc(key)}" data-st-value="${esc(value)}">${esc(label)}</button>`).join('')}</span>`;
  }

  function valueText(value) {
    return `<span class="st-value">${esc(value)}</span>`;
  }

  function generalScreen() {
    return group('Запуск', [
      row({ title: 'Открывать Главную', sub: 'При запуске приложения', control: toggle('openHomeOnLaunch') }),
      row({ title: 'Восстанавливать трек', sub: 'Продолжать с последней позиции', control: toggle('resumePlayback') }),
      row({ title: 'Язык', sub: 'Система пока поддерживает только русский', control: valueText('Русский'), disabled: true }),
    ]) + group('Сброс', [
      row({ title: 'Сбросить настройки', sub: 'Вернуть значения по умолчанию', action: 'reset-settings', danger: true }),
    ]);
  }

  function appearanceScreen() {
    return group('Тема', [
      row({ title: 'Тёмная', control: choice('theme', [['dark', 'Dark'], ['amoled', 'AMOLED']]) }),
      row({ title: 'Карточки', control: choice('cardSize', [['compact', 'S'], ['standard', 'M'], ['large', 'L']]) }),
    ]) + group('Акцент', [
      row({ title: 'Цвет RH', control: choice('accent', [['default', 'Default'], ['blue', 'Blue'], ['violet', 'Violet'], ['cyan', 'Cyan']]) }),
    ]) + group('Эффекты', [
      row({ title: 'Цвет от обложки', sub: 'Подсвечивать фон трека', control: toggle('dynamicCover') }),
      row({ title: 'Свечение', sub: 'Ambient-подсветка', control: toggle('coverGlow') }),
      row({ title: 'Уменьшить движение', sub: 'Меньше анимаций', control: toggle('reduceMotion') }),
    ]);
  }

  function playerScreen() {
    return group('Управление', [
      row({ title: 'Свайп по обложке', sub: 'Влево/вправо — предыдущий/следующий трек', control: toggle('swipeCover') }),
      row({ title: 'Свайп по мини-плееру', sub: 'Влево/вправо — предыдущий/следующий трек', control: toggle('swipeMini') }),
    ]);
  }

  function aiScreen() {
    const ai = window.RH_AI_AUTOMIX;
    const aiState = ai && ai.getState ? ai.getState() : { phase: 'OFF', active: false };
    const smart = window.RH_SMARTMIX;
    const smartEnabled = smart && smart.getSettings ? !!smart.getSettings().enabled : false;
    return group('RH AI AutoMix', [
      row({ title: 'AutoMix RH AI', sub: aiState.active ? ('Статус: ' + aiState.phase) : 'Автоматические переходы', control: toggleSetting('automix', aiState.active) }),
      row({ title: 'Статус', control: valueText(aiState.phase || 'OFF'), disabled: true }),
    ]) + group('RH Smart Mix', [
      row({ title: 'Smart Mix', sub: 'Плавные переходы по биту', control: toggleSetting('smartmix', smartEnabled) }),
      row({ title: 'Длина перехода', sub: 'Доступно в текущем движке Smart Mix', control: valueText(smart && smart.getSettings ? (smart.getSettings().bars + ' такта') : '8 такта'), disabled: true }),
    ]);
  }

  function storageScreen() {
    return group('Данные', [
      row({ title: 'Очистить поисковые запросы', action: 'clear-searches', danger: true }),
      row({ title: 'Сбросить сохранённый трек', action: 'clear-player', danger: true }),
      row({ title: 'Очистить кеш обложек', action: 'clear-cache', danger: true }),
      row({ title: 'Использование хранилища', sub: 'Оценка браузера', control: valueText(storageLabel()), disabled: true }),
    ]) + group('Полный сброс', [
      row({ title: 'Удалить локальные данные RH—MUSIC', sub: 'Настройки, поиск, позиция плеера', action: 'clear-all', danger: true }),
    ]);
  }

  function notificationsScreen() {
    const media = 'mediaSession' in navigator;
    return group('Экран блокировки', [
      row({ title: 'Медиа-уведомление', sub: media ? 'Название, обложка и управление' : 'Не поддерживается браузером', control: media ? toggle('mediaSession') : valueText('Нет'), disabled: !media }),
    ]);
  }

  function privacyScreen() {
    return group('История', [
      row({ title: 'Сохранять историю', sub: 'Влияет на рекомендации', control: toggle('saveHistory') }),
      row({ title: 'Персонализация', sub: 'Использовать историю для подборок', control: toggle('personalization') }),
    ]) + group('Данные', [
      row({ title: 'История хранится на сервере', sub: 'Очистка истории пока недоступна через клиент', control: valueText('—'), disabled: true }),
    ]);
  }

  function accountScreen() {
    const account = document.getElementById('sideAccount') || document.getElementById('accountBtn');
    const label = account ? String(account.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const guest = !label || /гость|вход|войти/i.test(label);
    const name = guest ? 'Гость' : label.slice(0, 40);
    return group('Профиль', [
      row({ title: name, sub: guest ? 'Войдите, чтобы синхронизировать данные' : 'Активная сессия', control: valueText(guest ? '—' : 'Активен'), action: 'open-account' }),
    ]) + group('Сессия', [
      row({ title: 'Выйти из аккаунта', action: 'logout', danger: true }),
    ]);
  }

  function aboutScreen() {
    return group('RH—MUSIC', [
      row({ title: 'Версия интерфейса', control: valueText(VERSION), disabled: true }),
      row({ title: 'Production', sub: 'https://rh-music.pages.dev', control: valueText('Открыть'), action: 'open-production' }),
    ]);
  }

  function group(title, rows) {
    return `<section class="st-group"><h2 class="st-group-title">${esc(title)}</h2><div class="st-card">${rows.join('')}</div></section>`;
  }

  function storageLabel() {
    try {
      let bytes = 0;
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        bytes += (key ? key.length : 0) + String(localStorage.getItem(key) || '').length;
      }
      return (bytes / 1024).toFixed(1) + ' КБ localStorage';
    } catch { return '—'; }
  }

  function toast(message) {
    try {
      window.dispatchEvent(new CustomEvent('rh-toast', { detail: { message, kind: 'info' } }));
    } catch { /* ignore */ }
  }

  function renderMain() {
    return `<div class="st-screen">
      <div class="st-head">
        <button class="st-back" type="button" data-st-action="back">${ICON.back}</button>
        <div><h1 class="st-title">Настройки</h1><p class="st-sub">RH—MUSIC · мобильный профиль</p></div>
      </div>
      <div class="st-list">
        ${SECTIONS.map((section) => `<button class="st-nav-row" type="button" data-st-open="${esc(section.id)}">
          <span class="st-nav-icon">${section.icon}</span>
          <span class="st-nav-text"><span class="st-nav-title">${esc(section.title)}</span><span class="st-nav-sub">${esc(section.sub)}</span></span>
          <span class="st-chevron">›</span>
        </button>`).join('')}
      </div>
    </div>`;
  }

  function renderSection(id) {
    const builders = {
      general: generalScreen,
      appearance: appearanceScreen,
      player: playerScreen,
      ai: aiScreen,
      storage: storageScreen,
      notifications: notificationsScreen,
      privacy: privacyScreen,
      account: accountScreen,
      about: aboutScreen,
    };
    const section = SECTIONS.find((item) => item.id === id);
    if (!section || !builders[id]) return renderMain();
    return `<div class="st-screen">
      <div class="st-head">
        <button class="st-back" type="button" data-st-action="back">${ICON.back}</button>
        <div><h1 class="st-title">${esc(section.title)}</h1><p class="st-sub">${esc(section.sub)}</p></div>
      </div>
      ${builders[id]()}
    </div>`;
  }

  function render(path) {
    const page = document.getElementById('main');
    if (!page) return;
    const match = String(path || '').match(/^\/settings\/([a-z-]+)$/);
    page.innerHTML = match ? renderSection(match[1]) : renderMain();
    window.scrollTo(0, 0);
  }

  function refresh() {
    const hash = (location.hash || '').replace(/^#/, '') || '/settings';
    if (hash.startsWith('/settings')) render(hash);
  }

  function handleAction(action) {
    if (action === 'back') { location.hash = '#/settings'; return; }
    if (action === 'reset-settings') {
      Object.assign(state, DEFAULTS);
      persist(); apply();
      toast('Настройки сброшены');
      refresh();
      return;
    }
    if (action === 'clear-searches') {
      localStorage.removeItem('rh_searches_v1');
      toast('Поисковые запросы очищены');
      refresh();
      return;
    }
    if (action === 'clear-player') {
      localStorage.removeItem('rh_player_v1');
      toast('Сохранённый трек сброшен');
      refresh();
      return;
    }
    if (action === 'clear-cache') {
      if (window.caches && caches.keys) {
        caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {});
      }
      toast('Кеш обложек очищен');
      return;
    }
    if (action === 'clear-all') {
      ['rh_searches_v1', 'rh_player_v1', 'rh_layout_v1', 'rh_volume_v1', KEY].forEach((key) => {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
      });
      Object.assign(state, DEFAULTS);
      persist(); apply();
      toast('Локальные данные очищены');
      refresh();
      return;
    }
    if (action === 'open-account') { location.hash = '#/account'; return; }
    if (action === 'logout') {
      const button = document.getElementById('sideLogout');
      if (button) button.click();
      else toast('Выход доступен на странице аккаунта');
      return;
    }
    if (action === 'open-production') { window.open('https://rh-music.pages.dev', '_blank', 'noopener'); }
  }

  function handleToggle(key) {
    if (key === 'automix') {
      if (window.RH_AI_AUTOMIX) window.RH_AI_AUTOMIX.toggle();
      set(key, window.RH_AI_AUTOMIX ? window.RH_AI_AUTOMIX.getState().active : false);
      setTimeout(refresh, 350);
      return;
    }
    if (key === 'smartmix') {
      if (window.RH_SMARTMIX && window.RH_SMARTMIX.setSettings) {
        window.RH_SMARTMIX.setSettings({ enabled: !(window.RH_SMARTMIX.getSettings().enabled) });
        set(key, !!window.RH_SMARTMIX.getSettings().enabled);
      }
      refresh();
      return;
    }
    set(key, !get(key));
    refresh();
  }

  document.addEventListener('click', (event) => {
    const open = event.target.closest('[data-st-open]');
    if (open) { location.hash = '#/settings/' + open.dataset.stOpen; return; }
    const action = event.target.closest('[data-st-action]');
    if (action) { handleAction(action.dataset.stAction); return; }
    const toggleEl = event.target.closest('[data-st-toggle]');
    if (toggleEl) { handleToggle(toggleEl.dataset.stToggle); return; }
    const choiceBtn = event.target.closest('[data-st-choice]');
    if (choiceBtn) {
      const key = choiceBtn.dataset.stChoice;
      let value = choiceBtn.dataset.stValue;
      set(key, value);
      refresh();
    }
  });

  // Кнопка шестерёнки в верхней панели.
  document.addEventListener('click', (event) => {
    if (event.target.closest && event.target.closest('#settingsBtn')) location.hash = '#/settings';
  });

  // Свайпы по обложке Now Playing и мини-плееру.
  function bindSwipe(el, settingKey, onNext, onPrev) {
    if (!el) return;
    let startX = 0; let active = false;
    el.addEventListener('touchstart', (event) => {
      if (!get(settingKey) || !event.touches || event.touches.length !== 1) return;
      startX = event.touches[0].clientX; active = true;
    }, { passive: true });
    el.addEventListener('touchend', (event) => {
      if (!active) return;
      active = false;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      if (Math.abs(dx) < 45) return;
      if (dx < 0) onNext(); else onPrev();
    }, { passive: true });
  }
  const npArt = document.getElementById('npArt');
  const playerBar = document.getElementById('player');
  const nextBtn = () => { const b = document.getElementById('next'); if (b) b.click(); };
  const prevBtn = () => { const b = document.getElementById('prev'); if (b) b.click(); };
  bindSwipe(npArt, 'swipeCover', nextBtn, prevBtn);
  bindSwipe(playerBar, 'swipeMini', nextBtn, prevBtn);

  window.RH_SETTINGS = {
    VERSION,
    get,
    set,
    apply,
    render,
    refresh,
    state,
  };

  apply();
})();
