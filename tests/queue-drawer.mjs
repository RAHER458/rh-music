/**
 * Регрессионные тесты шторки очереди (#drawer) — элемента, который на мобильной
 * ширине показывается как плавающая карточка «Очередь · N треков».
 *
 * Запуск:  node tests/queue-drawer.mjs
 *
 * Проверяются оба контейнера очереди: правая панель #queuePanel (десктоп) и
 * шторка #drawer (телефон/планшет). Ключевое требование — по умолчанию не
 * отображается ни один из них, и ни один не открывается сам при воспроизведении,
 * паузе, смене трека, навигации или перерисовке очереди.
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

console.log('RH—MUSIC · тесты шторки очереди (#drawer)\n');

/* ───────────────── сколько вообще элементов очереди ───────────────── */

check('в разметке ровно два контейнера очереди: панель и шторка',
  (html.match(/id="queuePanel"/g) || []).length === 1
  && (html.match(/id="drawer"/g) || []).length === 1);
check('правая панель скрыта атрибутом hidden', /id="queuePanel"[^>]*hidden/.test(html));
check('шторка помечена aria-hidden', /id="drawer"[^>]*aria-hidden="true"/.test(html));
check('у шторки есть слайдер закрытия',
  /id="drawerGrab"/.test(html) && /bindDragToClose\(\$\('drawer'\), \$\('drawerGrab'\)/.test(app));

/* ───────────────── CSS: скрытое состояние структурное ───────────────── */

const drawerBase = (css.match(/\.drawer \{[\s\S]*?\n\}/) || [''])[0];
check('базовое правило шторки найдено', drawerBase.length > 0);
check('шторка скрыта через visibility, а не только transform',
  /visibility: hidden/.test(drawerBase) && /transform: translateY\(102%\)/.test(drawerBase));
check('скрытая шторка не перехватывает касания', /pointer-events: none/.test(drawerBase));
check('шторка показывается только классом is-open',
  /\.drawer\.is-open \{[^}]*visibility: visible/.test(css)
  && /\.drawer\.is-open \{[^}]*pointer-events: auto/.test(css));
check('ни одно другое правило не делает шторку видимой',
  (css.match(/\.drawer[^{]*\{[^}]*visibility: visible/g) || []).length === 1);

check('кнопки сайдбара и очереди по умолчанию скрыты (мобильная ширина)',
  /\.sidebar-toggle,\s*\n\s*\.queue-toggle \{ display: none; \}/.test(css)
  || /\.queue-toggle \{ display: none; \}/.test(css));
check('кнопки появляются только в десктопном медиазапросе',
  /@media \(min-width: 1024px\)[\s\S]*?\.sidebar-toggle \{ display: grid; \}[\s\S]*?\.queue-toggle \{ display: grid; \}/.test(css));

/* ───────────────── логика шторки на DOM-шиме ───────────────── */

const openSrc = (app.match(/function openDrawer\(open = true\) \{[\s\S]*?\n\}/) || [''])[0];
check('openDrawer найдена в исходнике', openSrc.length > 0);

function harness() {
  const state = { S: { drawerOpen: false, npOpen: false, sheetOpen: false, queue: [{ id: 'a' }, { id: 'b' }], current: { id: 'a' } }, classes: new Set(), attrs: {}, renderCalls: 0 };
  const el = {
    classList: {
      toggle(name, on) { if (on) state.classes.add(name); else state.classes.delete(name); },
      contains(name) { return state.classes.has(name); },
    },
    setAttribute(k, v) { state.attrs[k] = v; },
  };
  const fn = new Function('S', 'drawer', 'scrim', 'hideScrim', 'renderQueue', 'document', 'requestAnimationFrame',
    openSrc + '; return openDrawer;');
  const openDrawer = fn(
    state.S, el, { hidden: true, classList: { add() {} } },
    () => {}, () => { state.renderCalls++; },
    { body: { classList: { toggle() {} } } },
    (cb) => cb(),
  );
  return { state, openDrawer, classes: () => state.classes };
}

{
  const h = harness();
  check('шторка закрыта по умолчанию', !h.classes().has('is-open'));
  h.openDrawer(true);
  check('открытие ставит is-open и aria-hidden=false',
    h.classes().has('is-open') && h.state.attrs['aria-hidden'] === 'false');
  h.openDrawer(false);
  check('закрытие снимает is-open и возвращает aria-hidden=true',
    !h.classes().has('is-open') && h.state.attrs['aria-hidden'] === 'true');
  check('закрытие не очищает очередь и не сбрасывает трек',
    h.state.S.queue.length === 2 && h.state.S.current.id === 'a');
  check('закрытие не трогает audio', !/audio\.(play|pause|load|src)/.test(openSrc));
}

/* ───────────────── никто не открывает шторку сам ───────────────── */

const callers = app.split('\n')
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter((x) => /openDrawer\(/.test(x.line) && !/function openDrawer/.test(x.line));
check('все вызовы openDrawer(true) — только по действию пользователя',
  callers.filter((c) => !/openDrawer\(false\)/.test(c.line)).length === 1
  && callers.some((c) => c.line.includes('!S.drawerOpen')),
  JSON.stringify(callers));

for (const [name, re] of [
  ['запуск трека', /function playIndex\(index,[\s\S]*?\n\}/],
  ['обновление транспорта', /function updateTransport\(\) \{[\s\S]*?\n\}/],
  ['перерисовка очереди', /function renderQueue\(\) \{[\s\S]*?\n\}/],
  ['рендер списка очереди', /function renderQueuePanel\(\) \{[\s\S]*?\n\}/],
]) {
  const body = (app.match(re) || [''])[0];
  check(`${name} не открывает шторку`, !/openDrawer\(true\)|is-open'/.test(body));
}

check('шторка закрывается при переходе между разделами', /if \(S\.drawerOpen\) openDrawer\(false\);\s*\n\s*if \(path ===/.test(app.replace(/\n\s*\n/g, '\n')) || /if \(S\.drawerOpen\) openDrawer\(false\);/.test(app));
check('шторка закрывается при переходе на десктопную ширину',
  /if \(isDesktop\(\) && S\.drawerOpen\) openDrawer\(false\);/.test(app));
check('шторка закрывается жестом вниз', /bindDragToClose\(\$\('drawer'\), \$\('drawerGrab'\)/.test(app));
check('нет дублирующей прямой привязки крестика шторки',
  !/\$\('drawerClose'\)\.addEventListener/.test(app));

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}