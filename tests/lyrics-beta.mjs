import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const beta = readFileSync(join(here, '../web/lyrics-beta.js'), 'utf8');
const lyrics = readFileSync(join(here, '../web/lyrics.js'), 'utf8');
const html = readFileSync(join(here, '../web/index.html'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
const app = readFileSync(join(here, '../web/app.js'), 'utf8');
let passed = 0; const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };
console.log('RH—MUSIC · Lyrics beta tests\n');

check('основная кнопка «Текст» есть в Now Playing', /id="npLyricsBeta"/.test(html) && /lyrics-beta-toggle/.test(html) && />Текст</.test(html));
check('скрипт beta подключён', /lyrics-beta\.js/.test(html));
check('действие переключает режим', /lyrics-beta-toggle/.test(app) && /RH_LYRICS_BETA\.toggle\(\)/.test(app));
check('beta использует существующий RH_LYRICS', /RH_LYRICS\.subscribe/.test(beta) && /RH_LYRICS\.getLine/.test(beta));
check('в lyrics.js есть подписка на смену строки', /subscribe\(listener\)/.test(lyrics) && /emitLine\(\)/.test(lyrics));
check('показываются три строки: предыдущая, текущая, следующая', /makeLine\('is-prev'/.test(beta) && /makeLine\('is-current'/.test(beta) && /makeLine\('is-next'/.test(beta) && css.includes('.np-lb-line.is-prev') && css.includes('.np-lb-line.is-current') && css.includes('.np-lb-line.is-next'));
check('в beta-режиме обложка скрывается', /is-lyrics-beta/.test(css) && /np-cover-layer/.test(css));
check('поддерживаются plain, loading, error, instrumental', /syncLevel === 'plain'/.test(beta) && /loading/.test(beta) && /instrumental/.test(beta) && /Текст недоступен/.test(beta));
check('не создаётся второй аудиоплеер', !/new Audio\(|createElement\('audio'\)/.test(beta));
check('не дублируется загрузка текста', !/\/api\/lyrics/.test(beta));


check('слова плавно заливаются через --p', /setProperty\('--p'/.test(beta) && css.includes('.np-lb-word') && css.includes('var(--p, 0)'));
check('текущая строка уходит вверх и блюрится, следующая встаёт в центр', /is-leaving-up/.test(beta) && /is-entering-down/.test(beta) && /translateY\(-168%\)/.test(css) && /translateY\(62%\)/.test(css) && /advance\(data, direction\)/.test(beta));
check('есть плавный обратный переход', /is-leaving-down/.test(beta) && /is-entering-up/.test(beta));
check('в lyrics.js есть предыдущая строка', /prevText/.test(lyrics) && /data\.lines\[index - 1\]/.test(lyrics));
check('RAF работает только при воспроизведении', /requestAnimationFrame\(tick\)/.test(beta) && /audio\.paused/.test(beta) && /audio\.addEventListener\('pause', stopLoop\)/.test(beta));
check('reduced motion отключает анимацию', /prefers-reduced-motion: reduce/.test(css) && /\.np-lb-line \{ transition: none/.test(css));


check('режим не включается без синхронизированного текста', /function isSynced/.test(beta) && /if \(isSynced\(data\)\) \{ setActive\(true\); return; \}/.test(beta) && /showNotice\(reasonFor\(data\)\);/.test(beta));
check('при plain/none режим выключается и показывается предупреждение', /if \(active && data && data.status === 'ready' && !isSynced\(data\)\)/.test(beta) && /showNotice\(reasonFor\(data\)\)/.test(beta));
check('предупреждение красиво анимировано', css.includes('.np-lyrics-notice') && css.includes('.np-lyrics-notice.is-visible'));
check('предупреждение также уходит в общий toast', /rh-toast/.test(beta) && /rh-toast/.test(app));


check('кнопка блокируется без синхронизированного текста', /function updateButton/.test(beta) && /button\.disabled = blocked/.test(beta) && /is-disabled/.test(beta));
check('кнопка разблокируется, когда текст синхронизирован', /const synced = isSynced\(data\)/.test(beta) && /const blocked = !synced && !loading/.test(beta));
check('заблокированная кнопка выглядит неактивной', css.includes('.np-extra.is-disabled') && css.includes('cursor: not-allowed'));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
