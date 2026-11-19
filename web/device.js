/**
 * RH—MUSIC · определение интерфейсной среды (Desktop UI / Mobile UI).
 *
 * Ни ширина окна, ни User-Agent по отдельности не являются достаточным
 * признаком: iPhone в ландшафте шире 800 px, планшет в портрете — 1024 px,
 * а десктоп с сенсорным экраном имеет maxTouchPoints > 0. Поэтому решение
 * принимается по совокупности признаков:
 *
 *   • navigator.userAgentData.mobile (Chromium);
 *   • User-Agent (iPhone/iPod, Android + Mobile, Windows Phone, …);
 *   • планшетные признаки (iPad, Android без «Mobile», MacIntel + касания);
 *   • тип указателя и hover: (pointer: coarse) + (hover: none);
 *   • navigator.maxTouchPoints;
 *   • размер экрана/окна как вспомогательный признак.
 *
 * Телефон и планшет всегда получают Mobile UI, в том числе в ландшафте.
 * Класс среды «залипает» на время сессии: поворот устройства и изменение
 * размеров окна не переключают интерфейс. Принудительно выбрать среду можно
 * параметром ?ui=desktop|mobile или через window.RH_UI.set().
 *
 * Скрипт только выставляет html[data-ui] и сообщает об изменении событием
 * rh:ui-change — вся бизнес-логика (плеер, очередь, авторизация) остаётся общей.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const STICKY_KEY = 'rh_ui_mode_v1';

  function readForced() {
    try {
      const param = (new URLSearchParams(location.search).get('ui') || '').toLowerCase();
      if (param === 'desktop' || param === 'mobile') return param;
      const stored = sessionStorage.getItem(STICKY_KEY);
      if (stored === 'desktop' || stored === 'mobile') return stored;
    } catch { /* приватный режим */ }
    return null;
  }

  function uaSignals(ua) {
    const text = String(ua || '');
    const phone = /iPhone|iPod|Android[^;]*; ?Mobile|Windows Phone|IEMobile|BlackBerry|Opera Mini|webOS|Palm/i.test(text);
    const ipad = /iPad/i.test(text);
    const androidTablet = /Android/i.test(text) && !/Mobile/i.test(text);
    const macTouch = /Macintosh|Mac OS X/i.test(text);
    return { phone, ipad, androidTablet, macTouch };
  }

  function media(query) {
    try { return window.matchMedia ? window.matchMedia(query).matches : false; } catch { return false; }
  }

  function detect() {
    const reasons = [];
    const uaData = navigator.userAgentData || null;
    const ua = navigator.userAgent || '';
    const sig = uaSignals(ua);
    const touchPoints = Number(navigator.maxTouchPoints || 0);
    const coarse = media('(pointer: coarse)');
    const noHover = media('(hover: none)');
    const fine = media('(pointer: fine)');
    const hover = media('(hover: hover)');
    const shortest = Math.min(
      Number(screen.width || window.innerWidth || 0),
      Number(screen.height || window.innerHeight || 0),
    );

    // 1. Явные признаки телефона — самый сильный сигнал.
    if (uaData && uaData.mobile === true) reasons.push('userAgentData.mobile');
    if (sig.phone) reasons.push('ua:phone');
    if (reasons.length) return { kind: 'mobile', device: 'phone', reasons };

    // 2. Планшет: iPad (в т.ч. маскирующийся под Mac), Android без Mobile.
    if (sig.ipad) reasons.push('ua:ipad');
    if (sig.androidTablet) reasons.push('ua:android-tablet');
    if (sig.macTouch && touchPoints > 1 && coarse) reasons.push('macintel+touch');
    if (reasons.length) return { kind: 'mobile', device: 'tablet', reasons };

    // 3. Сенсорный указатель без hover. Но на настольной ОС (Windows/macOS/Linux)
    //    с сенсорным экраном это по-прежнему компьютер: ноутбуки-трансформеры и
    //    моноблоки с тачскрином не должны получать мобильный интерфейс.
    const desktopOs = /Windows NT|Macintosh|Mac OS X|X11|CrOS|Linux x86_64|Linux i686/i.test(ua);
    if (coarse && noHover && touchPoints > 0) {
      if (desktopOs && shortest > 820) {
        reasons.push('coarse-touch-on-desktop-os');
      } else {
        reasons.push('coarse+no-hover+touch');
        return { kind: 'mobile', device: shortest <= 820 ? 'phone' : 'tablet', reasons };
      }
    }

    // 4. Десктоп: точный указатель и hover даже при наличии касаний
    //    (ноутбуки и ПК с сенсорным экраном остаются десктопом).
    if (fine && hover) {
      reasons.push('fine+hover');
      return { kind: 'desktop', device: 'desktop', reasons };
    }

    // 5. Ничего не совпало: решаем по доступному признаку касаний.
    if (touchPoints > 0 && coarse) {
      if (desktopOs && shortest > 820) {
        reasons.push('fallback:desktop-os-touch');
        return { kind: 'desktop', device: 'desktop', reasons };
      }
      reasons.push('fallback:touch');
      return { kind: 'mobile', device: 'tablet', reasons };
    }
    reasons.push('fallback:desktop');
    return { kind: 'desktop', device: 'desktop', reasons };
  }

  let current = null;

  function apply(mode) {
    let decision;
    if (mode === 'desktop' || mode === 'mobile') {
      decision = { kind: mode, device: mode, reasons: ['forced'], forced: true };
    } else {
      const stored = readForced();
      decision = stored
        ? { kind: stored, device: stored, reasons: ['stored/param'], forced: true }
        : detect();
    }

    // Класс среды залипает: телефон/планшет не превращаются в десктоп
    // из-за поворота или широкого окна.
    if (!decision.forced && current && current.kind === 'mobile' && decision.kind === 'desktop') {
      decision = { ...current, reasons: [...(current.reasons || []), 'sticky'] };
    }

    const changed = !current || current.kind !== decision.kind || current.device !== decision.device;
    current = decision;

    root.dataset.ui = decision.kind;                 // 'desktop' | 'mobile'
    root.dataset.uiDevice = decision.device;         // 'phone' | 'tablet' | 'desktop'
    if (decision.kind === 'mobile') root.dataset.uiMobile = '1';
    else delete root.dataset.uiMobile;

    // Запоминаем только явный выбор (?ui= или RH_UI.set): автоматическое
    // определение не должно «залипать» между визитами и мешать тестам.
    try {
      if (decision.forced) sessionStorage.setItem(STICKY_KEY, decision.kind);
      else sessionStorage.removeItem(STICKY_KEY);
    } catch { /* ignore */ }

    if (changed) {
      document.dispatchEvent(new CustomEvent('rh:ui-change', { detail: { ...decision } }));
    }
    return decision;
  }

  let resizeTimer = null;
  function onEnvironmentChange() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => apply(), 150);
  }

  apply();

  window.addEventListener('orientationchange', onEnvironmentChange);
  window.addEventListener('resize', onEnvironmentChange);
  ['(pointer: coarse)', '(hover: none)', '(pointer: fine)', '(hover: hover)'].forEach((query) => {
    try {
      const mq = window.matchMedia(query);
      if (mq.addEventListener) mq.addEventListener('change', onEnvironmentChange);
      else if (mq.addListener) mq.addListener(onEnvironmentChange);
    } catch { /* ignore */ }
  });

  window.RH_UI = {
    get kind() { return current ? current.kind : 'desktop'; },
    get device() { return current ? current.device : 'desktop'; },
    get reasons() { return current ? current.reasons.slice() : []; },
    /** Принудительно выбрать среду (используется тестами и переключателем в интерфейсе). */
    set(mode) { return apply(mode); },
    /** Сбросить принудительный выбор и определить среду заново. */
    reset() { try { sessionStorage.removeItem(STICKY_KEY); } catch { /* ignore */ } return apply(); },
    isDesktop() { return this.kind === 'desktop'; },
    isMobile() { return this.kind === 'mobile'; },
  };
})();
