/**
 * Интеграционные (исходники) тесты RH Smart Mix.
 *
 * Запуск:  node tests/smartmix-ui.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../web/index.html'), 'utf8');
const app = readFileSync(join(here, '../web/app.js'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
const mix = readFileSync(join(here, '../web/smartmix.js'), 'utf8');
const lyrics = readFileSync(join(here, '../web/lyrics.js'), 'utf8');

let passed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

console.log('RH—MUSIC · тесты интерфейса RH Smart Mix\n');

check('smartmix.js подключён после lyrics.js и до app.js',
  html.indexOf('src="lyrics.js"') < html.indexOf('src="smartmix.js"')
  && html.indexOf('src="smartmix.js"') < html.indexOf('src="app.js'));
check('в разметке по-прежнему один основной <audio>',
  (html.match(/<audio\b/g) || []).length === 1);
check('кнопка микса есть в десктопном плеере',
  /id="smartmixBtn"[^>]*data-action="smartmix-open"/.test(html));
check('чип микса есть на мобильном экране',
  /id="npSmartMix"[^>]*data-action="smartmix-open"/.test(html));

check('движок создаёт второй элемент только для перехода',
  /global\.document\.createElement\('audio'\)/.test(mix));
check('второй элемент не добавляется в HTML',
  !/id="mixAudio"/.test(html));
check('по умолчанию Smart Mix выключен',
  /const DEFAULTS = \{ enabled: false, bars: 8, preload: true \}/.test(mix));
check('есть пресеты 4/8/16 тактов',
  /\[4, 8, 16\]/.test(mix) && /\[4, 8, 16\]/.test(app));
check('настройка встроена в страницу настроек',
  /\$\{settings \? smartMixSettingsHTML\(\) : ''\}/.test(app));
check('есть карточка настроек и пресеты в UI',
  /smartmix-card/.test(app) && /smartmix-presets/.test(app));

check('приложение инициализирует движок',
  /function initSmartMix\(\)/.test(app) && /window\.RH_SMARTMIX\.init\(/.test(app));
check('смена трека сообщает движку',
  /window\.RH_SMARTMIX\.onTrack\(\)/.test(app));
check('timeupdate передаёт время планировщику',
  /window\.RH_SMARTMIX\.onTime\(smartMixState\(\)\)/.test(app));
check('Next/Prev/Seek/Pause отменяют переход',
  /RH_SMARTMIX\.cancel\('next'\)/.test(app)
  && /RH_SMARTMIX\.cancel\('prev'\)/.test(app)
  && /RH_SMARTMIX\.cancel\('seek'\)/.test(app)
  && /RH_SMARTMIX\.cancel\('pause'\)/.test(app));
check('изменение очереди и shuffle уведомляют движок',
  /function setQueue[\s\S]{0,220}RH_SMARTMIX\.onQueue\(\)/.test(app)
  && /function toggleShuffle[\s\S]{0,600}RH_SMARTMIX\.onQueue\(\)/.test(app));
check('финализация перехода передаёт трек приложению',
  /adoptTrack: adoptSmartMixTrack/.test(app) && /async function adoptSmartMixTrack/.test(app));
check('при смене трека текст переключается только при adopt',
  /async function adoptSmartMixTrack[\s\S]{0,900}RH_LYRICS\.setTrack\(track\)/.test(app));

check('анализ использует Range-префикс, а не полную загрузку',
  /bytes=0-\$\{PREFIX_BYTES - 1\}/.test(mix) && /PREFIX_BYTES = 512 \* 1024/.test(mix));
check('декодирование идёт через OfflineAudioContext',
  /OfflineAudioContext/.test(mix) && /decodeAudioData/.test(mix));
check('анализ кешируется с версией',
  /ANALYSIS_VERSION/.test(mix) && /rh_smartmix_cache_v1/.test(mix));
check('есть ограничение размера кеша', /MAX_CACHE = 160/.test(mix));
check('планировщик учитывает уверенность и downbeat',
  /MIN_CONFIDENCE/.test(mix) && /downbeatOffset/.test(mix));
check('темп корректируется умеренно',
  /MAX_RATE_DELTA = 0\.04/.test(mix) && /preservesPitch/.test(mix));

check('Web Audio: gain, low-shelf EQ и limiter',
  /createGain/.test(mix) && /type = 'lowshelf'/.test(mix) && /createDynamicsCompressor/.test(mix));
check('громкость смешивается equal-power кривыми',
  /Math\.cos\(t \* Math\.PI \/ 2\)/.test(mix) && /Math\.sin\(t \* Math\.PI \/ 2\)/.test(mix));
check('бас исходящего убирается, входящего вводится',
  /lowOut\.linearRampToValueAtTime\(-20/.test(mix) && /lowMix\.linearRampToValueAtTime\(0/.test(mix));
check('есть fallback без Web Audio',
  /Фолбэк без Web Audio/.test(mix) && /startVolume \* Math\.cos/.test(mix));
check('второй поток останавливается и освобождается',
  /removeAttribute\('src'\)/.test(mix) && /engine\.mix\.pause\(\)/.test(mix));
check('ошибка play не оставляет висящий переход',
  /mix play timeout/.test(mix) && /engine\.phase = 'idle'/.test(mix));

check('lyrics engine не знает о втором аудио',
  !/smartmix|mixAudio|RH_SMARTMIX/i.test(lyrics));

check('предзагрузка встроена в карточку Smart Mix',
  /data-action="smartmix-preload"/.test(app) && /data-smartmix-preload/.test(app));
check('настройки хранят preload', /preload: source\.preload !== false/.test(mix));
check('предзагрузка использует Range-поток и фактический buffered',
  /bufferAhead\(/.test(mix) && /element\.buffered/.test(mix) && /readyState >= 3/.test(mix));
check('готовность требует минимальный буфер, а не только play/preload',
  /ahead >= Math\.min\(preload\.target, 5\) && ahead >= 2\.5/.test(mix));
check('адаптивность учитывает saveData/2G/3G и отсутствие Network API',
  /connection\.saveData/.test(mix) && /effectiveType/.test(mix) && /name: 'balanced'/.test(mix));
check('предзагрузка не запускает второй трек заранее',
  /el\.volume = 0/.test(mix) && /el\.paused/.test(mix) === false);
check('переход использует подготовленный элемент',
  /prepared = matches && isPreloadReady\(plan\)/.test(mix) && /mix = preload\.element/.test(mix));
check('при неготовом буфере переход не стартует',
  /if \(engine\.settings\.preload && !prepared\)/.test(mix));
check('15-секундная очистка реализована',
  /\}, 15000\);/.test(mix) && /retirePreload/.test(mix) && /engine\.retired/.test(mix));
check('после перехода готовится следующий трек',
  /retirePreload\(retiredPreload\)/.test(mix) && /prepareNext\(state\)/.test(mix));
check('старая предзагрузка отменяется при смене очереди',
  /function onQueue[\s\S]{0,200}cancel\('queue'\)/.test(mix));

check('CSS для карточки и пресетов добавлен',
  /\.smartmix-card \{/.test(css) && /\.smartmix-presets \{/.test(css));
check('стили не меняют размеры плеера',
  !/\.smartmix-[^{]*\{[^}]*position: fixed/.test(css));

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}
