import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(join(here, '../web/beat-cover.js'), 'utf8');
const html = readFileSync(join(here, '../web/index.html'), 'utf8');
const css = readFileSync(join(here, '../web/styles.css'), 'utf8');
let passed = 0; const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };
console.log('RH—MUSIC · Beat Reactive Cover tests\n');

check('скрипт подключён к странице', /beat-cover\.js/.test(html));
check('не создаётся второй аудиоплеер', !/createElement\('audio'\)|new Audio\(/.test(js) && /getElementById\('audio'\)/.test(js));
check('не используется createMediaElementSource (нет конфликта со Smart Mix)', !/createMediaElementSource/.test(js));
check('анализ берётся из текущего аудиопотока', /captureStream/.test(js) && /createMediaStreamSource/.test(js));
check('используется AnalyserNode и низкие частоты', /createAnalyser/.test(js) && /250 \/ nyquist/.test(js));
check('адаптивный порог, а не фиксированная громкость', /deviation/.test(js) && /threshold/.test(js) && /baseline/.test(js));
check('есть защита от повторных ударов', /now - lastBeat > 150/.test(js));
check('RAF запускается только при воспроизведении', /audio\.addEventListener\('play', start\)/.test(js) && /audio\.addEventListener\('pause', stop\)/.test(js));
check('при паузе и конце трека масштаб сбрасывается', /function stop\(\)/.test(js) && /el\.style\.transform = ''/.test(js));
check('учитывается prefers-reduced-motion', /prefers-reduced-motion/.test(js) && /prefers-reduced-motion/.test(css));
check('обложки помечаются data-beat-cover', /setAttribute\('data-beat-cover'/.test(js) && css.includes('[data-beat-cover]'));
check('пульсация через transform scale', /scale\(\$\{scale/.test(js) || /scale\(/.test(js));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
