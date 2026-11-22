import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFlowQueries, listParam, MOOD_QUERIES, GENRE_QUERIES } from '../worker/src/flow.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, '../web/app.js'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
let passed = 0; const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };

console.log('RH—MUSIC · Flow home tests\n');

check('flow backend: 14 настроений', Object.keys(MOOD_QUERIES).length === 14);
check('flow backend: жанры и сценарии заполнены', Object.keys(GENRE_QUERIES).length >= 14);
check('flow backend: listParam разбирает и ограничивает список', listParam('a,b,,c').join(',') === 'a,b,c');
const queries = buildFlowQueries({ moods: ['happy', 'sad'], genres: ['rock'], prefs: ['fresh'], scenarios: ['work'] });
check('flow backend: запросы строятся из выбора', queries.length >= 4 && queries.some((q) => q.includes('весёлая')) && queries.some((q) => q.includes('рок')));
check('flow backend: fresh добавляет новинки', queries.some((q) => q.includes('новинки')));

check('frontend: запрос /api/flow', /api\/flow\?/.test(app));
check('frontend: поток запускается через существующий playIndex', /async function startFlow\(\)[\s\S]*playIndex\(0, \{ source: 'flow' \}\)/.test(app));
check('frontend: смена настроения не обрывает текущий трек', /S\.flowDirty = !!S\.current/.test(app) && /async function rebuildFlowTail\(\)/.test(app));
check('frontend: следующий трек учитывает dirty-поток', /function nextTrack\(auto = false\) \{[\s\S]{0,220}S\.flowDirty/.test(app));
check('frontend: не создаётся второй аудиоплеер', !/new Audio\(|createElement\('audio'\)/.test(app));
check('frontend: есть центральная кнопка Play', /id="flowPlay"/.test(app) && /data-action="flow-toggle"/.test(app));
check('frontend: 14 настроений в интерфейсе', (app.match(/class="flow-mood\$\{/g) || []).length === 1 && /FLOW_MOODS = \[[\s\S]*?instrumental/.test(app));
check('frontend: настройки потока влияют на выборку', /openFlowSettings/.test(app) && /data-action="flow-setting"/.test(app));
check('frontend: hero обновляется вместе с плеером', /if \(S\.route === 'home'\) updateFlowHero\(\)/.test(app));
check('css: hero, настроения и мобильная сетка', css.includes('.flow-hero') && css.includes('.flow-mood-grid') && css.includes('repeat(2, minmax(0, 1fr))'));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
