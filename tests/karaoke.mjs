import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../web/lyrics.js'), 'utf8');
let passed = 0; const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };

function extract(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}', 'm');
  const found = src.match(re);
  if (!found) throw new Error('not found: ' + name);
  return found[0];
}

const codePoints = (value) => Array.from(String(value == null ? '' : value));
const deps = ['isVowel', 'letterWeight', 'weightedLetterTimings'].map(extract).join('\n');
const letterTimingsForWord = new Function('codePoints', deps + '\n' + extract('letterTimingsForWord') + '\nreturn letterTimingsForWord;')(codePoints);
const letterTimingsForLine = new Function('codePoints', deps + '\n' + extract('letterTimingsForLine') + '\nreturn letterTimingsForLine;')(codePoints);
const letterProgress = new Function(extract('letterProgress') + '\nreturn letterProgress;')();
const modeLabel = new Function(extract('modeLabel') + '\nreturn modeLabel;')();

console.log('RH—MUSIC · karaoke letter tests\n');

check('в движке есть посимвольные тайминги слов', /letterTimingsForWord/.test(src));
check('в движке есть span-ы lyrics-letter', /createElement\('span', 'lyrics-letter'/.test(src));
check('CSS-переменная --p управляет заливкой буквы', /--p, 0%/.test(readFileSync(join(here, '../web/styles.css'), 'utf8')));

const word = { t: 1000, end: 2000, text: 'Привет' };
const letters = letterTimingsForWord(word, word.end, 0, [word]);
check('длинное слово разбито на все буквы', letters.length === 6 && letters.map((l) => l.ch).join('') === 'Привет');
check('первая буква начинается со времени слова', letters[0].start === 1000);
check('последняя буква заканчивается временем слова', letters[5].end === 2000);
check('тайминги букв монотонны', letters.every((l, i) => i === 0 || l.start >= letters[i - 1].start));
check('тайминги покрывают слово без дыр', letters.every((l, i) => i === 0 || Math.abs(l.start - letters[i - 1].end) < 1e-6));

const lat = letterTimingsForWord({ t: 0, end: 500, text: "I've" }, 500, 0, [{ t: 0, end: 500, text: "I've" }]);
check('латиница и апостроф сохраняются', lat.map((l) => l.ch).join('') === "I've" && lat.length === 4);

const line = letterTimingsForLine({ t: 0, text: 'Привет, мир!' }, 2000);
check('строка без word-меток тоже разбивается на буквы', line.length === 12 && line[line.length - 1].end === 2000);

const stretched = letterTimingsForWord({ t: 0, end: 1000, text: 'ма' }, 1000, 0, [{ t: 0, end: 1000, text: 'ма' }]);
check('гласная получает больше времени, чем согласная', (stretched[1].end - stretched[1].start) > (stretched[0].end - stretched[0].start));
const withPause = letterTimingsForWord({ t: 0, end: 400, text: 'да' }, 400, 0, [{ t: 0, end: 400, text: 'да' }]);
check('буквы не выходят за пределы слова', withPause[0].start >= 0 && withPause[withPause.length - 1].end <= 400);

check('прогресс буквы 0 в начале', letterProgress({ start: 1000, end: 2000 }, 1000) === 0);
check('прогресс буквы 0.5 в середине', letterProgress({ start: 1000, end: 2000 }, 1500) === 0.5);
check('прогресс буквы 1 в конце', letterProgress({ start: 1000, end: 2000 }, 2000) === 1);
check('прогресс не уходит за границы', letterProgress({ start: 1000, end: 2000 }, 5000) === 1 && letterProgress({ start: 1000, end: 2000 }, 0) === 0);
check('при перемотке буквы считаются от audio.currentTime', /applyLetters\(state\.active, \(audio\.currentTime \|\| 0\) \* 1000, true\)/.test(src));
check('RAF останавливается на паузе и ended', /audio\.addEventListener\('pause', \(\) => \{ stopLetterLoop\(\)/.test(src) && /audio\.addEventListener\('ended', \(\) => stopLetterLoop\(\)\)/.test(src));


check('калибровка применяется через effectiveOffset один раз',
  /function effectiveOffset\(\)/.test(src)
  && /effectiveOffset\(\)/.test(src)
  && !/letterTimingsForWord\([^)]*offset\)/.test(src));
check('modeLabel: Smart при слоговых метках', modeLabel({ syncLevel: 'word', lines: [{ words: [{ syllables: [{ t: 0, end: 1 }, { t: 1, end: 2 }] }] }] }) === 'Smart');
check('modeLabel: Word при словах без слогов', modeLabel({ syncLevel: 'word', lines: [{ words: [{ t: 0, end: 1, text: 'x' }] }] }) === 'Word');
check('modeLabel: Line при построчных метках', modeLabel({ syncLevel: 'line', lines: [] }) === 'Line');
check('режим синхронизации различает Smart, Word и Line',
  /function modeLabel\(data\)/.test(src)
  && /hasSyllables \? 'Smart' : 'Word'/.test(src)
  && /data\.syncLevel === 'line' \? 'Line'/.test(src));
check('слоговые метки слов переносятся в word-поток', /word\.syllables/.test(readFileSync(join(here, '../worker/src/words.js'), 'utf8')));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
