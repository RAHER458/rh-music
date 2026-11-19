/**
 * Тесты видимости мини-плеера RH—MUSIC.
 *
 * Запуск:  node tests/player.mjs
 *
 * Проверяется реальный исходник web/app.js: из него извлекается функция-гейт
 * shouldShowPlayer и утверждения о проводке (кто и когда её вызывает).
 * Поведение в браузере (появление/скрытие, восстановление после перезагрузки)
 * проверяется отдельно на живом сайте программными DOM-метриками.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../web/app.js'), 'utf8');

let passed = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

/* ────────────── реальная функция-гейт из web/app.js ────────────── */

const gateMatch = source.match(/function shouldShowPlayer\(state = S\) \{[\s\S]*?\n\}/);
const trackMatch = source.match(/function hasSelectedTrack\(state = S\) \{[\s\S]*?\n\}/);
check('shouldShowPlayer найдена в исходнике', !!gateMatch);
check('hasSelectedTrack найдена в исходнике', !!trackMatch);
const shouldShowPlayer = new Function(
  'const S = {};' + (trackMatch ? trackMatch[0] : '') + (gateMatch ? gateMatch[0] : '') +
  '; return shouldShowPlayer;',
)();

console.log('RH—MUSIC · тесты мини-плеера\n');

/* Таблица состояний из задачи. */
const cases = [
  ['первый вход на сайт (нет состояния трека)', { current: null }, false],
  ['гость на главной', { current: null, queue: [], index: -1 }, false],
  ['экран авторизации', { current: null, route: 'login' }, false],
  ['экран регистрации', { current: null, route: 'register' }, false],
  ['поиск без выбора трека', { current: null, route: 'search' }, false],
  ['библиотека без выбора трека', { current: null, route: 'library' }, false],
  ['пустой объект трека', { current: {} }, false],
  ['трек без id', { current: { title: 'Старое название' } }, false],
  ['трек с пустым id', { current: { id: '', title: 'Старое название' } }, false],
  ['выбран трек (выбор)', { current: { id: '101', title: 'Believer' } }, true],
  ['трек играет', { current: { id: '101', title: 'Believer' }, playing: true }, true],
  ['пауза выбранного трека', { current: { id: '101', title: 'Believer' }, playing: false }, true],
  ['следующий трек', { current: { id: '202', title: 'Thunder' } }, true],
  ['восстановленный трек после перезагрузки', { current: { id: '303', title: 'Лесник' }, restorePosition: 42 }, true],
  ['трек скрыт пользователем вручную (играет)', { current: { id: '101', title: 'Believer' }, playing: true, playerHidden: true }, false],
  ['трек скрыт пользователем вручную (пауза)', { current: { id: '101', title: 'Believer' }, playing: false, playerHidden: true }, false],
  ['скрытый плеер возвращён пользователем', { current: { id: '101', title: 'Believer' }, playerHidden: false }, true],
];

for (const [name, state, expected] of cases) {
  let actual = null;
  try { actual = shouldShowPlayer(state); } catch (error) { actual = 'throw: ' + error.message; }
  check('состояние «' + name + '» → ' + (expected ? 'показан' : 'скрыт'), actual === expected, String(actual));
}

/* Валидация восстановленного состояния: битые данные не должны показывать плеер. */
const restoreMatch = source.match(/function restorePlayerState\(\) \{[\s\S]*?\n\}/);
check('restorePlayerState найдена', !!restoreMatch);
const restoreSrc = restoreMatch ? restoreMatch[0] : '';
check('restorePlayerState требует id трека', /!saved\.track\.id/.test(restoreSrc));
check('restorePlayerState требует название', /!saved\.track\.title/.test(restoreSrc));
check('restorePlayerState чистит битое состояние', /clearPlayerState\(\)/.test(restoreSrc));

/* Проводка: гейт вызывается из реальных точек жизненного цикла. */
const transportMatch = source.match(/function updateTransport\(\) \{[\s\S]*?\n\}/);
check('updateTransport пересчитывает видимость плеера',
  !!transportMatch && /syncPlayerVisibility\(\)/.test(transportMatch[0]));

const layoutMatch = source.match(/function syncLayoutHeight\(\) \{[\s\S]*?\n\}/);
check('syncLayoutHeight освобождает место, когда плеер скрыт',
  !!layoutMatch && /hidden \? 0/.test(layoutMatch[0]) && /--player-h/.test(layoutMatch[0]));

const playMatch = source.match(/function playIndex\([\s\S]*?\n\}/);
check('playIndex сохраняет выбранный трек', !!playMatch && /savePlayerState\(0\)/.test(playMatch[0]));

const bootMatch = source.match(/\(async function boot\(\) \{[\s\S]*?\n\}\)\(\);/);
check('boot восстанавливает сохранённый трек', !!bootMatch && /restorePlayerState\(\)/.test(bootMatch[0]));

check('пауза сохраняет позицию', /addEventListener\('pause', \(\) => \{ if \(!smartMixAdopting\) savePlayerState\(\); \}\)/.test(source));
check('уход со страницы сохраняет позицию', /pagehide', \(\) => \{ flushPlayback\(true\); savePlayerState\(\); \}/.test(source));
check('hidePlayer не останавливает и не сбрасывает воспроизведение',
  (() => {
    const m = source.match(/function hidePlayer\(notify = true\) \{[\s\S]*?\n\}/);
    if (!m) return false;
    const body = m[0];
    return !/audio\.(pause|play|load|removeAttribute)/.test(body)
      && !/S\.current\s*=/.test(body)
      && !/S\.queue\s*=/.test(body)
      && !/S\.index\s*=/.test(body)
      && /S\.playerHidden = true/.test(body);
  })());

check('показ плеера не запускает воспроизведение',
  (() => {
    const m = source.match(/function showPlayer\(\) \{[\s\S]*?\n\}/);
    return !!m && !/audio\.play|audio\.load|audio\.src/.test(m[0]);
  })());

check('выбор трека возвращает скрытый плеер', /S\.playerHidden = false;\s*\n\s*\n?\s*S\.retried/.test(source) || /S\.playerHidden = false/.test(source));
check('компактный плеер обновляется вместе с видимостью', /function syncPlayerVisibility\(\) \{[\s\S]*?updateCompactPlayer\(\)/.test(source));
check('удаление аккаунта очищает состояние плеера', /clearPlayerState\(\);\s*\n\s*updateTransport\(\);/.test(source));

/* Восстановленная позиция не должна затираться пустым <audio> до старта. */
const saveMatch = source.match(/function savePlayerState\(position\) \{[\s\S]*?\n\}/);
check('скрытие не стирает сохранённый трек', (() => {
  const m = source.match(/function savePlayerState\(position\) \{[\s\S]*?\n\}/);
  return !!m && /if \(!hasSelectedTrack\(\)\) \{ localStorage\.removeItem/.test(m[0])
    && !/if \(!shouldShowPlayer\(\)\)/.test(m[0]);
})());

check('savePlayerState сохраняет восстановленную позицию',
  !!saveMatch && /S\.restorePosition > 0 && !audio\.currentSrc/.test(saveMatch[0]));
check('restorePlayerState сбрасывает таймер автосохранения',
  /S\.lastStateSave = Date\.now\(\);/.test(restoreSrc));

/* Скрытый плеер не должен занимать место: CSS не резервирует высоту при [hidden]. */
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
check('у плеера нет жёсткой display-вьюхи, перебивающей [hidden]',
  !/\.player\s*\{[^}]*display\s*:\s*(flex|block|grid)/.test(css));
check('высота плеера берётся из переменной --player-h', /--player-h/.test(css));

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}