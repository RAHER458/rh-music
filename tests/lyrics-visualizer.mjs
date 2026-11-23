import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const engine = readFileSync(join(here, '../web/lyrics.js'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
let passed = 0; const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };
console.log('RH—MUSIC · Lyrics Visualizer tests\n');

check('вкладка «Текст» получает кинематографический режим', /is-cinematic/.test(engine) && css.includes('.lyrics-pane.is-cinematic'));
check('динамический фон из обложки', /lyrics-atmosphere/.test(engine) && /lyrics-atmosphere/.test(css) && /backdrop|blur\(64px\)/.test(css));
check('активная строка — визуальный центр', /\.lyrics-pane\.is-cinematic \.lyrics-line\.is-active/.test(css));
check('прошлые и будущие строки приглушены и размыты', /\.is-prev/.test(css) && /\.is-next/.test(css) && css.includes('filter: blur(2px)'));
check('пословная прогрессивная заливка через --p', /setProperty\('--p'/.test(engine) && /var\(--p, 0\)/.test(css));
check('прошлые слова остаются подсвеченными', /is-done/.test(engine) && css.includes('.lyrics-word.is-done'));
check('активное слово увеличивается и светится', /\.lyrics-word\.is-active/.test(css) && css.includes('drop-shadow'));
check('паузы и инструментал отмечаются', /is-instrumental/.test(engine) && css.includes('content: "♪"'));
check('синхронизация идёт от audio.currentTime', /audio\.currentTime/.test(engine));
check('не создаётся второй аудиоплеер', !/new Audio\(|createElement\('audio'\)/.test(engine));
check('reduced motion отключает переходы', /prefers-reduced-motion: reduce/.test(css) && /is-cinematic \.lyrics-word/.test(css));
check('обычный plain-текст не выдаётся за синхронизированный', /syncLevel === 'plain'/.test(engine) && /Без синхронизации/.test(engine));


check('текст всегда начинается с начала списка', /view\.scroll\.scrollTop = 0;/.test(engine));
check('позиция строки считается по rect, а не offsetTop', /getBoundingClientRect\(\)/.test(engine) && /nodeRect\.top - hostRect\.top/.test(engine));
check('при отсутствии активной строки прокрутка возвращается к началу', /if \(index < 0\) view\.scroll\.scrollTop = 0;/.test(engine));
check('открытие панели вызывает syncNow после layout', /window\.setTimeout\(\(\) => syncNow\(true\), 0\)/.test(engine));


check('ручной скролл отключает автослежение только при движении пальца', /addEventListener\('touchmove', manual/.test(engine) && !/addEventListener\('touchstart', manual/.test(engine));
check('нет неожиданного возврата к середине при обычной прокрутке', !/view\.scroll\.addEventListener\('scroll', \(\) => \{/.test(engine));
check('кнопка «Текст» на десктопе открывает вкладку текста', /if \(isDesktop\(\)\) toggleLyrics\(\);/.test(readFileSync(join(here, '../web/app.js'), 'utf8')));
check('на десктопе текст крупнее и панель шире', css.includes('queue-panel.is-lyrics') && css.includes('font-size: 18.5px'));


check('на мобильном текст прокручивается прямым scrollTop, без сбоев smooth', /function isMobileUI\(\)/.test(engine) && /!isMobileUI\(\) \? 'smooth' : 'auto'/.test(engine));


check('CSS не навязывает smooth для lyrics-scroll (ломает scrollTop в WebKit)', !/\.lyrics-scroll[^{]*\{[^}]*scroll-behavior:\s*smooth/.test(css));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
