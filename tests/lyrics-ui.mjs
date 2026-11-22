/**
 * Тесты интерфейса текстов песен (Desktop UI и Mobile UI).
 *
 * Запуск:  node tests/lyrics-ui.mjs
 *
 * Проверяется реальный исходник: разметка, изоляция сред, стили и точки
 * подключения к существующему плееру. Поведение движка — в tests/lyrics.mjs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../web/index.html'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
const app = readFileSync(join(here, '../web/app.js'), 'utf8');
const engine = readFileSync(join(here, '../web/lyrics.js'), 'utf8');

let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

console.log('RH—MUSIC · тесты интерфейса текстов песен\n');

/* ───────────────────────────── разметка ───────────────────────────── */

check('скрипт движка подключён после device.js и до app.js',
  html.indexOf('src="device.js"') < html.indexOf('src="lyrics.js"')
  && html.indexOf('src="lyrics.js"') < html.indexOf('src="app.js'));
check('в приложении по-прежнему один аудиоэлемент',
  (html.match(/<audio\b/g) || []).length === 1);
check('вкладки панели находятся внутри существующей панели очереди',
  /id="queuePanel"[\s\S]*id="qpTabQueue"[\s\S]*id="qpTabLyrics"[\s\S]*id="qpList"/.test(html));
check('очередь не заменена текстом: список очереди на месте',
  /id="qpList"/.test(html) && /id="qpCount"/.test(html));
check('панель текста помечена hidden по умолчанию', /id="lyricsPane" hidden/.test(html));
check('кнопка текста есть в правой группе плеера',
  /class="player-right" data-ui-only="desktop"[\s\S]*id="playerLyrics"/.test(html));
check('кнопка текста на телефоне — в экране текущего трека',
  /class="np-extras"[\s\S]*id="npLyrics"/.test(html));
check('мобильный слой текста помечен только для Mobile UI',
  /id="lyricsSheet"[^>]*data-ui-only="mobile"/.test(html));

const desktopMarkup = html.slice(html.indexOf('id="queuePanel"'), html.indexOf('</aside>', html.indexOf('id="queuePanel"')));
check('desktop: вкладки и текст живут в панели, а не вместо неё',
  desktopMarkup.includes('qpTabLyrics') && desktopMarkup.includes('lyricsPane') && desktopMarkup.includes('qpList'));
check('desktop: кнопка возврата к строке есть', /id="lyricsReturnDesktop"/.test(html));
check('mobile: у слоя есть закрытие и возврат к строке',
  /id="lyricsCloseMobile"/.test(html) && /id="lyricsReturnMobile"/.test(html));
check('mobile: слой не перекрывает разметку очереди (отдельная секция)',
  html.indexOf('id="lyricsSheet"') < html.indexOf('id="drawer"'));

/* ───────────────────────────── CSS ───────────────────────────── */

check('CSS синтаксически сбалансирован', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length);
check('desktop: вкладка текста скрывает только элементы очереди, не панель',
  /html\[data-ui="desktop"\] \.queue-panel\.is-lyrics \.queue-panel-art/.test(css)
  && /html\[data-ui="desktop"\] \.queue-panel\.is-lyrics \.queue-panel-list \{ display: none; \}/.test(css)
  && !/html\[data-ui="desktop"\] \.queue-panel\.is-lyrics \{ display: none/.test(css));
check('desktop: текстовая панель занимает высоту панели',
  /html\[data-ui="desktop"\] \.lyrics-pane \{[\s\S]{0,120}flex: 1;[\s\S]{0,60}min-height: 0;/.test(css));
check('desktop: прокручивается только список строк',
  /html\[data-ui="desktop"\] \.lyrics-scroll \{ flex: 1; min-height: 0;/.test(css));
check('mobile: слой использует 100dvh',
  /html\[data-ui="mobile"\] \.lyrics-sheet-inner \{[\s\S]{0,160}height: 100dvh;/.test(css));
check('mobile: учтён safe-area',
  /html\[data-ui="mobile"\] \.lyrics-scroll \{ flex: 1; min-height: 0; padding: 6px 18px calc\(var\(--safe-bottom\) \+ 92px\)/.test(css)
  && /padding-top: calc\(var\(--safe-top\) \+ 4px\)/.test(css));
check('mobile: нет горизонтального переполнения — длинные строки переносятся',
  /\.lyrics-plain \{[\s\S]{0,120}overflow-wrap: anywhere/.test(css));
check('mobile: слой выше экрана текущего трека',
  /html\[data-ui="mobile"\] \.lyrics-sheet \{[\s\S]{0,80}z-index: 92;/.test(css));
check('анимации отключаются при prefers-reduced-motion',
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.lyrics-skeleton-row \{ animation: none; \}/.test(css));
check('текст не наследует глобальные переопределения панели',
  !/^\.queue-panel \{/m.test(css.slice(css.indexOf('Текст песни (Lyrics Sync)'))));
check('новые стили не трогают плеер и сайдбар напрямую',
  !/^\.player \{/m.test(css.slice(css.indexOf('Текст песни (Lyrics Sync)'))));
check('мобильный слой не показывается на десктопе',
  !/html\[data-ui="desktop"\] \.lyrics-sheet/.test(css));
// Регрессия: класс body.np-open совпадал с кнопкой .np-open и делал body
// flex-контейнером, растягивая страницу по ширине при открытом экране трека.
check('класс np-open не превращает body в flex-контейнер',
  /button\.np-open \{ display: flex/.test(css) && !/\n\.np-open \{ display: flex/.test(css));

/* ───────────────────────────── app.js: точки подключения ───────────────────────────── */

check('смена трека в playIndex обновляет текст',
  /updateNowPlayingMeta\(track\);\s*\n\s*if \(window\.RH_LYRICS\) window\.RH_LYRICS\.setTrack\(track\);/.test(app));
check('восстановление трека обновляет текст',
  /updateNowPlayingMeta\(S\.current\);\s*\n\s*if \(window\.RH_LYRICS\) window\.RH_LYRICS\.setTrack\(S\.current\);/.test(app));
check('выход из аккаунта очищает текст',
  /S\.current = null;[\s\S]{0,220}RH_LYRICS\) window\.RH_LYRICS\.setTrack\(null\)/.test(app));
check('есть единая точка переключения текста', /function toggleLyrics\(\)/.test(app));
check('есть открытие мобильного слоя', /function openLyricsSheet\(open = true\)/.test(app));
check('есть переключение вкладки панели', /function setQueueTab\(tab = 'queue'\)/.test(app));
check('панель остаётся открытой при клике на кнопку текста',
  /\[data-action="lyrics-toggle"\], #npQueue/.test(app));
check('Escape закрывает текстовый слой',
  /if \(S\.lyricsOpen\) openLyricsSheet\(false\);/.test(app));
check('горячая клавиша L открывает текст',
  /event\.key === 'l' \|\| event\.key === 'L'/.test(app) && /toggleLyrics\(\);/.test(app));
check('кнопка очереди всегда показывает очередь',
  /if \(open\) S\.queueTab = 'queue';/.test(app));
check('смена среды закрывает мобильный слой',
  /if \(isDesktop\(\) && S\.lyricsOpen\) openLyricsSheet\(false\);/.test(app));
check('смена среды не трогает аудио и трек',
  !/lyrics[\s\S]{0,80}audio\.(play|pause|load|src)/i.test(app.slice(app.indexOf("document.addEventListener('rh:ui-change'"), app.indexOf("document.addEventListener('rh:ui-change'") + 900)));
check('свайп вниз закрывает слой только по шапке',
  /lyrics-sheet-head[\s\S]{0,60}pointerdown/.test(app) || /head\.addEventListener\('pointerdown'/.test(app));
check('свайп не конфликтует со скроллом (порог и только шапка)',
  /if \(dy > 90\) openLyricsSheet\(false\);/.test(app));

/* ───────────────────────────── lyrics.js: движок ───────────────────────────── */

check('движок использует существующий <audio id="audio">',
  /getElementById\('audio'\)/.test(engine));
check('движок не создаёт второй плеер', !/new Audio\(|createElement\('audio'\)/.test(engine));
check('движок не меняет источник аудио', !/audio\.src\s*=/.test(engine));
check('буквенный RAF запускается только во время воспроизведения',
  /function startLetterLoop\(\)/.test(engine)
  && /audio\.addEventListener\('playing', \(\) => \{ onTime\(\); startLetterLoop\(\); \}\)/.test(engine)
  && /audio\.addEventListener\('pause', \(\) => \{ stopLetterLoop\(\)/.test(engine)
  && /audio\.addEventListener\('ended', \(\) => stopLetterLoop\(\)\)/.test(engine)
  && /document\.hidden\) \{\s*stopLetterLoop\(\)/.test(engine)
  && !/setInterval/.test(engine));
check('движок строит посимвольные тайминги и span-ы',
  /function letterTimingsForWord/.test(engine)
  && /createElement\('span', 'lyrics-letter'/.test(engine)
  && /_letterNodes/.test(engine));
check('движок пересчитывает буквы при перемотке',
  /audio\.addEventListener\('seeked', \(\) => \{ syncNow\(true\); applyLetters\(state\.active/.test(engine));
check('движок использует бинарный поиск', /function indexAt\(lines, ms\)/.test(engine) && />> 1/.test(engine));
check('движок реагирует на timeupdate и seeked',
  /addEventListener\('timeupdate'/.test(engine) && /addEventListener\('seeked'/.test(engine));
check('движок реагирует на play/playing и метаданные',
  /addEventListener\('playing'/.test(engine) && /addEventListener\('loadedmetadata'/.test(engine));
check('движок отменяет устаревшие запросы',
  /AbortController/.test(engine) && /controller\.abort\(\)/.test(engine) && /seq !== state\.seq/.test(engine));
check('движок не показывает текст прошлого трека: состояние loading очищает контейнер',
  /state\.status = 'loading';\s*\n\s*renderAll\(\);/.test(engine) && /view\.scroll\.textContent = ''/.test(engine));
check('движок различает plain / instrumental / none',
  /'plain'/.test(engine) && /instrumental/.test(engine) && /'none'/.test(engine));
check('движок уважает prefers-reduced-motion',
  /prefers-reduced-motion/.test(engine) && /reducedMotion\(\)/.test(engine));
check('движок не прокручивает при ручном чтении',
  /userScroll/.test(engine) && /setUserScroll\(view, true\)/.test(engine));
check('есть кнопка возврата к текущей строке',
  /view\.returnEl\.addEventListener\('click'/.test(engine));

/* ─────────────────────── атрибуция провайдеров ─────────────────────── */

check('в lyrics-разметке нет элементов источника',
  !/lyricsSource|lyrics-source/.test(html));
check('движок не выводит название источника и не собирает «· слова …»',
  !/sourceEl/.test(engine) && !/ · слова /.test(engine) && !/\.title = .*attribution/.test(engine));
check('CSS больше не содержит элемент источника',
  !/\.lyrics-source/.test(css));
check('в веб-интерфейсе нет названий внешних провайдеров текстов',
  !/Apple Music|LiriQo|NetEase|KuGou|QQ Music|Kuwo|Migu|PetitLyrics/i.test(html + css + app + engine));

/* ───────────────────────────── word-level ───────────────────────────── */

check('движок запрашивает слова отдельным маршрутом',
  /\/api\/lyrics\/\$\{encodeURIComponent\(id\)\}\/words/.test(engine));
check('слова загружаются лениво — при открытии текста',
  /state\.wordsWanted = true/.test(engine) && /ensure\(\)/.test(engine));
check('word-ответ сливается с текстом без замены источника',
  /syncLevel: 'word', lines: body\.lines, plain: null, offsetMs: 0/.test(engine));
check('каждое слово — отдельный span',
  /createElement\('span', 'lyrics-word'/.test(engine));
check('активное слово ровно одно: прежнее снимается',
  /view\.activeWordNode\.classList\.remove\('is-active'\)/.test(engine));
check('слова ищутся бинарным поиском',
  /function wordIndexAt\(words, ms\)/.test(engine) && /words\[mid\]\.t <= ms/.test(engine));
check('при смене трека word-запрос отменяется',
  /state\.wordsController\.abort\(\)/.test(engine));
check('устаревший word-ответ игнорируется',
  /seq !== state\.seq/.test(engine) && /String\(state\.track\.id\) !== id/.test(engine));
check('при отсутствии слов остаётся построчный режим',
  /syncLevel !== 'word'/.test(engine) && /state\.wordsState = 'none'/.test(engine));
check('клик по слову перематывает к слову',
  /event\.target\.closest\('\.lyrics-word'\)/.test(engine));

check('CSS: активное слово выделено градиентом сайта',
  /\.lyrics-word\.is-active \{[\s\S]{0,160}linear-gradient\(135deg, rgba\(108, 140, 255/.test(css));
check('CSS: в word-режиме строка не заливается фоном',
  /\.lyrics-line\.has-words\.is-active \{[\s\S]{0,80}background: none;/.test(css));
check('CSS: отступы слова не меняют геометрию строки',
  /\.lyrics-word \{[\s\S]{0,80}padding: 1px 4px;[\s\S]{0,40}margin: -1px -4px;/.test(css));
check('CSS: анимация слова отключается при reduced-motion',
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,80}\.lyrics-word \{ transition: none; \}/.test(css));
check('CSS: word-стили не меняют размеры панели и плеера',
  !/\.lyrics-word[^{]*\{[^}]*position: fixed/.test(css));

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
