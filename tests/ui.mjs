/**
 * Тесты мобильного интерфейса RH—MUSIC: навигация, bottom sheets, жесты.
 *
 * Запуск:  node tests/ui.mjs
 *
 * Проверяется реальный исходник (web/app.js, web/styles.css, web/index.html):
 * чистая функция свайпа извлекается и тестируется как код, остальное —
 * структурные утверждения о проводке. Поведение в браузере (цвета вкладок,
 * закрытие панелей, скрытие плеера) проверяется отдельно на живом сайте.
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

console.log('RH—MUSIC · тесты навигации, панелей и жестов\n');

/* ───────────────────────────── свайп: чистая функция ───────────────────────────── */

const swipeMatch = app.match(/function swipeCloses\(dy, velocity, distance = 90, speed = 0\.5\) \{[\s\S]*?\n\}/);
check('swipeCloses найдена в исходнике', !!swipeMatch);
const swipeCloses = new Function(swipeMatch[0] + '; return swipeCloses;')();

const swipeCases = [
  ['нет движения', 0, 0, false],
  ['отрицательное смещение', -40, 0, false],
  ['недостаточная дистанция без скорости', 40, 0.05, false],
  ['достаточная дистанция', 90, 0, true],
  ['дистанция больше порога', 140, 0, true],
  ['быстрый короткий свайп', 40, 0.9, true],
  ['медленный короткий свайп', 20, 0.1, false],
  ['очень быстрый, но слишком короткий', 10, 3, false],
  ['NaN не ломает жест', NaN, 0, false],
];
for (const [name, dy, v, expected] of swipeCases) {
  check('свайп: ' + name, swipeCloses(dy, v) === expected, String(swipeCloses(dy, v)));
}
check('свайп: настраиваемый порог', swipeCloses(60, 0, 50, 0.5) === true);
check('свайп: строгий порог отклоняет', swipeCloses(60, 0, 80, 0.5) === false);

/* ───────────────────────────── навигация ───────────────────────────── */

check('в CSS нет несуществующего paint server url(#none)', !/url\(#none\)/.test(css));
check('активная иконка вкладки наследует цвет текста',
  /\.tab\.is-active svg \{[^}]*fill:\s*currentColor/.test(css));
check('активная вкладка использует акцент дизайн-системы',
  /\.tab\.is-active \{[^}]*color:\s*var\(--blue\)/.test(css));
check('неактивные вкладки остаются приглушёнными',
  /\.tab \{[^}]*color:\s*var\(--muted-2\)/.test(css));
check('иконки вкладок красятся через currentColor',
  /\.tab svg \{[^}]*fill:\s*currentColor/.test(css));
check('в разметке ровно пять вкладок',
  (html.match(/class="tab" data-nav=/g) || []).length === 5);
check('вкладка рекомендаций присутствует в таббаре', /data-nav="for-you"/.test(html));
check('setNav выставляет aria-current', /setAttribute\('aria-current', 'page'\)/.test(app));
check('setNav снимает aria-current у неактивных', /removeAttribute\('aria-current'\)/.test(app));

/* ───────────────────────────── bottom sheets ───────────────────────────── */

check('sheetOpen добавляет ручку свайпа', /data-sheet-grab/.test(app) && /class="sheet-grab"/.test(app));
check('sheetOpen добавляет кнопку закрытия', /data-sheet-close/.test(app) && /class="sheet-close"/.test(app));
check('кнопка закрытия обрабатывается в общем обработчике', /\[data-sheet-close\]/.test(app));
check('sheetClose снимает класс открытия', /sheet\.classList\.remove\('is-open'\)/.test(app));
check('sheetClose сбрасывает transform панели', /sheetPanel\.style\.transform = ''/.test(app));
check('sheetClose снимает scroll lock', /classList\.toggle\('is-locked', S\.drawerOpen \|\| S\.npOpen\)/.test(app));
check('контейнер панели не перехватывает клики по фону',
  /\.sheet \{[^}]*pointer-events:\s*none/.test(css));
check('сама панель клики принимает', /\.sheet-panel \{[^}]*pointer-events:\s*auto/.test(css));
check('скрим закрывает панель по нажатию', /scrim\.addEventListener\('click',[\s\S]{0,120}if \(S\.sheetOpen\) sheetClose\(\)/.test(app));
check('Escape обрабатывается до проверки полей ввода',
  app.indexOf("if (event.key === 'Escape')") < app.indexOf("if (tag === 'input' || tag === 'textarea') return;"));
check('жест панели слушает pointercancel', /sheetPanel\.addEventListener\('pointercancel'/.test(app));
check('жест панели освобождает pointer capture', /sheetPanel\.releasePointerCapture/.test(app));
check('ручка панели отключает прокрутку страницы', /\.sheet-grab \{[^}]*touch-action:\s*none/.test(css));
check('атрибут hidden всегда скрывает элемент', /\[hidden\] \{ display: none !important; \}/.test(css));

/* ───────────────────────────── мини-плеер ───────────────────────────── */

check('в плеере есть кнопка скрытия', /id="playerHide"/.test(html));
check('в шапке есть кнопка возврата плеера', /id="playerRestore"/.test(html));
check('кнопка скрытия вызывает hidePlayer', /\$\('playerHide'\)\.addEventListener\('click', \(\) => hidePlayer\(\)\)/.test(app));
check('кнопка возврата вызывает showPlayer', /\$\('playerRestore'\)\.addEventListener\('click', \(\) => showPlayer\(\)\)/.test(app));
check('скрытый плеер не участвует в hit testing',
  /player\.hidden = !visible/.test(app) && /\[hidden\] \{ display: none !important; \}/.test(css));
check('жест плеера игнорирует кнопки и слайдер',
  /closest\('input, \.seek, \.player-hide, \.player-desktop-controls, \.play-mobile'\)/.test(app));
check('после свайпа клик по кнопке подавляется', /suppressPlayerClick/.test(app));
check('плеер отключает прокрутку страницы под собой', /\.player \{ touch-action: none; \}/.test(css));
check('восстановление не вызывает play()', (() => {
  const m = app.match(/function showPlayer\(\) \{[\s\S]*?\n\}/);
  return !!m && !/audio\.play/.test(m[0]);
})());
check('скрытие не трогает аудио и очередь', (() => {
  const m = app.match(/function hidePlayer\(notify = true\) \{[\s\S]*?\n\}/);
  return !!m && !/audio\.(play|pause|load|src)/.test(m[0]) && !/S\.current\s*=/.test(m[0]) && !/S\.queue\s*=/.test(m[0]);
})());

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}