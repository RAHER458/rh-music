/**
 * Тесты правой панели очереди RH—MUSIC.
 *
 * Запуск:  node tests/queue-panel.mjs
 *
 * Проверяется реальный код из web/app.js: функции openQueuePanel/closeQueuePanel/
 * toggleQueue извлекаются из исходника и исполняются на минимальном DOM-шиме,
 * а также проверяется, что панель не может открыться сама по себе
 * (в путях воспроизведения, паузы, смены трека и навигации нет её вызовов).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
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

console.log('RH—MUSIC · тесты панели очереди\n');

/* ───────────────────────────── разметка ───────────────────────────── */

check('панель есть в разметке', /id="queuePanel"/.test(html));
check('панель скрыта атрибутом hidden в разметке', /id="queuePanel"[^>]*hidden/.test(html));
check('крестик помечен data-action="queue-close"', /id="queueClose"[^>]*data-action="queue-close"/.test(html));
check('кнопка в шапке помечена data-action="queue-toggle"', /id="queueToggle"[^>]*data-action="queue-toggle"/.test(html));
check('кнопка в плеере помечена data-action="queue-toggle"', /id="playerQueue"[^>]*data-action="queue-toggle"/.test(html));

/* ───────────────────────────── CSS ───────────────────────────── */

check('по умолчанию панель полностью скрыта',
  /\.queue-panel \{[\s\S]{0,200}display: none/.test(css));
check('показ панели возможен только через body.queue-open',
  /body\.queue-open \.queue-panel \{ display: flex; \}/.test(css));
check('атрибут hidden тоже скрывает панель',
  /\.queue-panel\[hidden\] \{ display: none !important; \}/.test(css));
check('десктопная колонка включается классом',
  /body\.queue-open \.app \{ grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\) var\(--queue-w\)/.test(css));
check('в десктопном правиле панели больше нет display: flex',
  !/\.queue-panel \{[^}]*display: flex/.test(css.split('@media (min-width: 1024px)')[1] || ''));

/* ───────────────────────────── логика ───────────────────────────── */

const grab = (re) => {
  const m = app.match(re);
  return m ? m[0] : null;
};
const openSrc = grab(/function openQueuePanel\(open = true\) \{[\s\S]*?\n\}/);
const closeSrc = grab(/function closeQueuePanel\(\) \{[\s\S]*?\n\}/);
const toggleSrc = grab(/function toggleQueue\(force\) \{[\s\S]*?\n\}/);
check('openQueuePanel найдена', !!openSrc);
check('closeQueuePanel найдена', !!closeSrc);
check('toggleQueue найдена', !!toggleSrc);

function makeHarness({ desktop = true } = {}) {
  const state = {
    S: { queueOpen: false, drawerOpen: false, queue: [{ id: 'a' }, { id: 'b' }], current: { id: 'a' } },
    renderCalls: 0,
    layoutCalls: 0,
    drawerOpens: [],
    hidden: true,
    attrs: {},
    classes: new Set(),
  };
  const panel = {
    get hidden() { return state.hidden; },
    set hidden(value) { state.hidden = !!value; },
  };
  const toggleBtn = {
    setAttribute: (key, value) => { state.attrs[key] = value; },
    getAttribute: (key) => state.attrs[key],
  };
  const elements = { queuePanel: panel, queueToggle: toggleBtn };
  const documentShim = {
    body: {
      classList: {
        toggle(name, on) { if (on) state.classes.add(name); else state.classes.delete(name); },
        contains(name) { return state.classes.has(name); },
      },
    },
  };
  const fn = new Function(
    '$', 'document', 'S', 'renderQueuePanel', 'syncLayoutHeight', 'isDesktop', 'openDrawer',
    'setQueueTab', 'setLyricsPressed',
    openSrc + '\n' + closeSrc + '\n' + toggleSrc +
    '\n; return { openQueuePanel, closeQueuePanel, toggleQueue };',
  );
  const api = fn(
    (id) => elements[id] || null,
    documentShim,
    state.S,
    () => { state.renderCalls++; },
    () => { state.layoutCalls++; },
    () => desktop,
    (open = true) => { state.S.drawerOpen = open; state.drawerOpens.push(open); },
    () => {},
    () => {},
  );
  return { state, api };
}

{
  const h = makeHarness();
  check('до нажатий панель скрыта', h.state.hidden === true && !h.state.classes.has('queue-open'));

  h.api.openQueuePanel();
  check('открытие снимает hidden и ставит queue-open', h.state.hidden === false && h.state.classes.has('queue-open'));
  check('открытие выставляет aria-pressed=true', h.state.attrs['aria-pressed'] === 'true');
  check('открытие перерисовывает содержимое', h.state.renderCalls === 1);

  h.api.closeQueuePanel();
  check('закрытие возвращает hidden и снимает queue-open', h.state.hidden === true && !h.state.classes.has('queue-open'));
  check('закрытие не очищает очередь и не сбрасывает трек',
    h.state.S.queue.length === 2 && h.state.S.current.id === 'a');
  check('повторное закрытие безопасно', (() => { h.api.closeQueuePanel(); return h.state.hidden === true; })());

  h.api.toggleQueue();
  check('кнопка-переключатель открывает панель', h.state.hidden === false);
  h.api.toggleQueue();
  check('повторное нажатие закрывает панель', h.state.hidden === true);
  check('после закрытия очередь сохранилась', h.state.S.queue.length === 2);
}

{
  // Мобильная ширина: та же кнопка управляет шторкой, панель принудительно закрыта.
  const h = makeHarness({ desktop: false });
  h.api.openQueuePanel(true);          // панель была открыта
  h.api.toggleQueue();
  check('на телефоне переключатель открывает шторку', h.state.S.drawerOpen === true);
  check('на телефоне панель при этом закрыта', h.state.hidden === true && !h.state.classes.has('queue-open'));
}

/* ───────────────────── панель не открывается сама ───────────────────── */

const openCalls = app.split('\n')
  .filter((line) => /openQueuePanel\(/.test(line) && !/function openQueuePanel/.test(line))
  .map((line) => line.trim());
const openers = openCalls.filter((line) => !line.includes('openQueuePanel(false)'));
check('открыть панель могут только кнопка очереди и кнопка текста',
  openers.length === 2
  && openers.some((line) => line.includes('openQueuePanel(open)'))
  && openers.some((line) => line.includes('openQueuePanel(true)')),
  JSON.stringify(openCalls));
check('все остальные вызовы — только закрытие',
  openCalls.filter((line) => line.includes('openQueuePanel(false)')).length === 3,
  JSON.stringify(openCalls));

const replayPath = grab(/function playIndex\(index,[\s\S]*?\n\}/) || '';
check('запуск трека не трогает панель',
  !/openQueuePanel|queue-open|queuePanel/.test(replayPath));
const transportPath = grab(/function updateTransport\(\) \{[\s\S]*?\n\}/) || '';
check('обновление транспорта (play/pause/смена трека) не трогает панель',
  !/openQueuePanel|queue-open|queuePanel/.test(transportPath));
const queuePath = grab(/function renderQueue\(\) \{[\s\S]*?\n\}/) || '';
check('перерисовка очереди не меняет видимость панели',
  !/openQueuePanel|queue-open/.test(queuePath));
const renderPanelPath = grab(/function renderQueuePanel\(\) \{[\s\S]*?\n\}/) || '';
check('рендер списка очереди не меняет видимость панели',
  !/openQueuePanel|queue-open/.test(renderPanelPath)
  && !/queuePanel[^A-Za-z]*\.hidden|\.hidden\s*=\s*!?\(?S\.queueOpen/.test(renderPanelPath));

check('крестик обрабатывается делегированно', /action === 'queue-close'/.test(app));
check('кнопки панели обрабатываются делегированно', /action === 'queue-toggle'/.test(app));
check('Escape закрывает панель', /else if \(S\.queueOpen\) closeQueuePanel\(\);/.test(app));
check('клик вне панели закрывает её', /closeQueuePanel\(\);\s*\n\}\);/.test(app) && /composedPath/.test(app));
check('клик по строке очереди не закрывает панель (путь события)',
  /path\.indexOf\(panel\) !== -1 \|\| panel\.contains\(event\.target\)/.test(app));
check('при сужении окна до мобильного панель закрывается',
  /if \(!isDesktop\(\) && S\.queueOpen\) closeQueuePanel\(\);/.test(app));

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}