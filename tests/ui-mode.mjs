/**
 * Тесты разделения Desktop UI и Mobile UI.
 *
 * Запуск:  node tests/ui-mode.mjs
 *
 * 1. Определение среды (web/device.js) прогоняется в песочнице с подменёнными
 *    navigator/screen/matchMedia — проверяются телефоны, планшеты, десктопы с
 *    сенсорным экраном, ландшафт телефона и принудительный выбор среды.
 * 2. Изоляция интерфейсов: разметка, CSS и обработчики.
 * 3. Переключение среды не сбрасывает состояние плеера.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const device = readFileSync(join(here, '../web/device.js'), 'utf8');
const app = readFileSync(join(here, '../web/app.js'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
const html = readFileSync(join(here, '../web/index.html'), 'utf8');

let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

console.log('RH—MUSIC · тесты Desktop UI / Mobile UI\n');

/* ───────────────── среда определения ───────────────── */

function sandbox({ ua = '', uaDataMobile = null, coarse = false, noHover = false, fine = true, hover = true, touch = 0, screenW = 1920, screenH = 1080, search = '' } = {}) {
  const state = { dataset: {}, events: [] };
  const media = (query) => ({
    '(pointer: coarse)': coarse,
    '(hover: none)': noHover,
    '(pointer: fine)': fine,
    '(hover: hover)': hover,
  }[query] || false);

  const windowShim = {
    innerWidth: screenW,
    innerHeight: screenH,
    matchMedia: (q) => ({ matches: media(q), addEventListener() {}, addListener() {} }),
    addEventListener() {},
    RH_UI: null,
  };
  const documentShim = {
    documentElement: { dataset: state.dataset },
    dispatchEvent: (event) => { state.events.push(event && event.type); return true; },
  };
  const navigatorShim = { userAgent: ua, maxTouchPoints: touch, userAgentData: uaDataMobile == null ? undefined : { mobile: uaDataMobile } };
  const storage = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
  const locationShim = { search };

  const factory = new Function(
    'window', 'document', 'navigator', 'screen', 'sessionStorage', 'location', 'CustomEvent',
    device + '\n; return window.RH_UI;',
  );
  const api = factory(windowShim, documentShim, navigatorShim, { width: screenW, height: screenH }, storage, locationShim,
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } });
  return { api, state, windowShim, storage };
}

{
  const iphone = sandbox({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 393, screenH: 852 });
  check('iPhone → Mobile UI', iphone.api.kind === 'mobile' && iphone.api.device === 'phone', JSON.stringify(iphone.api.reasons));
  check('атрибут html[data-ui=mobile] выставлен', iphone.state.dataset.ui === 'mobile');

  const iphoneLandscape = sandbox({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 844, screenH: 390 });
  check('iPhone в ландшафте (844 px) остаётся в Mobile UI', iphoneLandscape.api.kind === 'mobile');

  const iphoneMax = sandbox({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 932, screenH: 430 });
  check('широкий iPhone (932 px) остаётся в Mobile UI', iphoneMax.api.kind === 'mobile');

  const ipad = sandbox({ ua: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 1024, screenH: 768 });
  check('iPad → Mobile UI (не Desktop по ширине)', ipad.api.kind === 'mobile' && ipad.api.device === 'tablet');

  const ipadMasquerade = sandbox({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 1180, screenH: 820 });
  check('iPad под MacIntel → Mobile UI', ipadMasquerade.api.kind === 'mobile' && ipadMasquerade.api.device === 'tablet');

  const androidTablet = sandbox({ ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 1280, screenH: 800 });
  check('Android-планшет → Mobile UI', androidTablet.api.kind === 'mobile' && androidTablet.api.device === 'tablet');

  const androidPhone = sandbox({ ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 412, screenH: 915 });
  check('Android-телефон → Mobile UI', androidPhone.api.kind === 'mobile' && androidPhone.api.device === 'phone');

  const uaDataPhone = sandbox({ ua: 'Mozilla/5.0 (Linux; Android 14)', uaDataMobile: true, coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 412, screenH: 915 });
  check('userAgentData.mobile → Mobile UI', uaDataPhone.api.kind === 'mobile');

  const desktop = sandbox({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36', fine: true, hover: true, touch: 0, screenW: 1920, screenH: 1080 });
  check('обычный десктоп → Desktop UI', desktop.api.kind === 'desktop');

  const desktopTouchOs = sandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', coarse: true, noHover: true, fine: false, hover: false, touch: 10, screenW: 1920, screenH: 1080 });
  check('ПК с тачскрином без мыши остаётся Desktop UI', desktopTouchOs.api.kind === 'desktop', JSON.stringify(desktopTouchOs.api.reasons));

  const desktopTouchOsSmall = sandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', coarse: true, noHover: true, fine: false, hover: false, touch: 10, screenW: 800, screenH: 600 });
  check('маленький экран на Windows с касанием — мобильная среда', desktopTouchOsSmall.api.kind === 'mobile');

  const touchPc = sandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', fine: true, hover: true, touch: 10, screenW: 1920, screenH: 1080 });
  check('ПК с сенсорным экраном → Desktop UI', touchPc.api.kind === 'desktop', JSON.stringify(touchPc.api.reasons));

  const narrowDesktop = sandbox({ ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', fine: true, hover: true, touch: 0, screenW: 800, screenH: 600 });
  check('узкое окно на ПК остаётся Desktop UI', narrowDesktop.api.kind === 'desktop');

  const forcedMobile = sandbox({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120', fine: true, hover: true, screenW: 1920, search: '?ui=mobile' });
  check('?ui=mobile принудительно включает Mobile UI', forcedMobile.api.kind === 'mobile');

  const forcedDesktop = sandbox({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', coarse: true, noHover: true, fine: false, hover: false, touch: 5, search: '?ui=desktop' });
  check('?ui=desktop принудительно включает Desktop UI', forcedDesktop.api.kind === 'desktop');

  // Залипание: телефон не становится десктопом при изменении окружения.
  const sticky = sandbox({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', coarse: true, noHover: true, fine: false, hover: false, touch: 5, screenW: 393 });
  sticky.windowShim.innerWidth = 1440;
  const again = sticky.api.set();
  check('среда не переключается на десктопную из-за ширины', again.kind === 'mobile', JSON.stringify(again.reasons));

  check('событие rh:ui-change отправляется при смене среды',
    sticky.api.set('desktop').kind === 'desktop' && sticky.state.events.includes('rh:ui-change'));
}

/* ───────────────── разметка: изоляция сред ───────────────── */

check('device.js подключается до app.js',
  html.indexOf('src="device.js"') !== -1 && html.indexOf('src="device.js"') < html.indexOf('src="app.js'));
check('сайдбар помечен как десктопный', /<aside class="sidebar"[^>]*data-ui-only="desktop"/.test(html));
check('таббар помечен как мобильный', /<nav class="tabbar"[^>]*data-ui-only="mobile"/.test(html));
check('десктопная верхняя панель помечена', /class="topbar-nav" data-ui-only="desktop"/.test(html) && /id="pageTitle"[^>]*data-ui-only="desktop"/.test(html));
check('переключатели панелей помечены как десктопные',
  /id="sidebarToggle"[^>]*data-ui-only="desktop"/.test(html) && /id="queueToggle"[^>]*data-ui-only="desktop"/.test(html));
check('правая панель очереди помечена как десктопная', /id="queuePanel"[^>]*data-ui-only="desktop"/.test(html));
check('десктопные элементы плеера помечены',
  /id="playerLike"[^>]*data-ui-only="desktop"/.test(html) && /class="player-right" data-ui-only="desktop"/.test(html));
check('элементы размечены по средам (10: 8 десктопных + 2 мобильных)',
  (html.match(/data-ui-only="desktop"/g) || []).length === 8
  && (html.match(/data-ui-only="mobile"/g) || []).length === 2);
check('слой текста на телефоне помечен как мобильный',
  /id="lyricsSheet"[^>]*data-ui-only="mobile"/.test(html));

/* ───────────────── CSS: изоляция и оболочки ───────────────── */

check('элементы чужой среды скрыты жёстко',
  /html\[data-ui="desktop"\] \[data-ui-only="mobile"\],\s*\nhtml\[data-ui="mobile"\] \[data-ui-only="desktop"\] \{ display: none !important; \}/.test(css));
// Прежняя десктопная раскладка живёт в медиазапросах (как до разделения сред)
// и НЕ дублируется scoped-правилами, чтобы вид не менялся.
const desktopMedia = css.slice(css.indexOf('@media (min-width: 1024px)'));
check('Desktop UI: сайдбар из прежней медиараскладки', /\.sidebar \{[\s\S]{0,120}display: flex/.test(desktopMedia));
check('Desktop UI: таббар скрыт прежним медиаправилом', /\.tabbar \{ display: none; \}/.test(desktopMedia));
check('прежняя десктопная сетка приложения не переопределена', /\.app \{ display: grid; grid-template-columns: 252px minmax\(0, 1fr\)/.test(desktopMedia));
check('десктопные правила не дублируются scoped-селекторами',
  !/html\[data-ui="desktop"\] \.sidebar \{/.test(css)
  && !/html\[data-ui="desktop"\] \.player-row \{/.test(css)
  && !/html\[data-ui="desktop"\] \.grid-cards \{/.test(css)
  && !/html\[data-ui="desktop"\] \.page \{/.test(css));
// Scoped-правила допустимы только для НОВЫХ компонентов (вкладки и текст):
// существующая раскладка по-прежнему задаётся медиазапросами.
const scopedSelectors = [...css.matchAll(/html\[data-ui="desktop"\]\s+([^,{]+)/g)]
  .map((m) => m[1].trim());
check('scoped-правила для десктопа описывают только новые компоненты текста',
  scopedSelectors.length >= 2
  && scopedSelectors.every((sel) => /^(\[data-ui-only="mobile"\]|\.tabbar$|\.lyrics-|\.qp-tab|\.queue-panel-tabs|\.queue-panel\.is-lyrics)/.test(sel)),
  scopedSelectors.join(' | '));
check('Mobile UI скрывает сайдбар', /html\[data-ui="mobile"\] \.sidebar \{ display: none; \}/.test(css));
check('Mobile UI показывает таббар', /html\[data-ui="mobile"\] \.tabbar \{ display: grid; \}/.test(css));
check('Mobile UI не показывает десктопные контролы плеера',
  /html\[data-ui="mobile"\] \.player-desktop-controls,\s*\nhtml\[data-ui="mobile"\] \.player-time \{ display: none; \}/.test(css));
check('Desktop UI: плеер в три зоны из прежней раскладки',
  /\.player-row \{[\s\S]{0,240}grid-template-columns: minmax\(0, 1fr\) minmax\(300px, 1.1fr\) minmax\(0, 1fr\)/.test(desktopMedia));
check('Mobile UI переводит плеер в компактный режим',
  /html\[data-ui="mobile"\] \.player-row \{ display: flex/.test(css));
check('сетка карточек различается между средами',
  /grid-template-columns: repeat\(auto-fill, minmax\(190px, 1fr\)\)/.test(desktopMedia)
  && /html\[data-ui="mobile"\] \.grid-cards \{ grid-template-columns: repeat\(auto-fill, minmax\(140px/.test(css));
check('Mobile UI сбрасывает ширину контента и отступы',
  /html\[data-ui="mobile"\] \.page \{ max-width: none;/.test(css));
check('Mobile UI возвращает мобильную строку трека',
  /html\[data-ui="mobile"\] \.track \{ grid-template-columns: 46px minmax\(0, 1fr\) auto/.test(css));

/* ───────────────── JS ───────────────── */

check('isDesktop читает интерфейсную среду, а не ширину окна',
  /window\.RH_UI && typeof window\.RH_UI\.isDesktop === 'function'/.test(app)
  && !/function isDesktop\(\) \{\s*\n\s*return !!\(window\.matchMedia/.test(app));
check('есть обработчик смены среды', /document\.addEventListener\('rh:ui-change'/.test(app));
check('при отсутствии device.js десктоп определяется по прежнему признаку ширины',
  /device\.js не загрузился/.test(app) && /matchMedia\('\(min-width: 1024px\)'\)\.matches/.test(app));

const handler = (app.match(/document\.addEventListener\('rh:ui-change',[\s\S]*?\n\}\);/) || [''])[0];
check('смена среды не трогает аудио, трек и очередь',
  handler.length > 0
  && !/audio\.(play|pause|load|src|currentTime)/.test(handler)
  && !/S\.current\s*=/.test(handler)
  && !/S\.queue\s*=/.test(handler)
  && !/localStorage\.removeItem/.test(handler));
check('смена среды перерисовывает раздел и транспорт',
  /updateTransport\(\)/.test(handler) && /renderQueue\(\)/.test(handler) && /route\(\)/.test(handler));
check('смена среды закрывает оверлей чужой среды',
  /if \(S\.drawerOpen\) openDrawer\(false\)/.test(handler) && /closeQueuePanel\(\)/.test(handler));

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}