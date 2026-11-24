import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');
const worker = read('worker/src/index.js');
const sc = read('worker/src/soundcloud.js');
const app = read('web/app.js');
const headers = read('web/_headers');
const index = read('web/index.html');
let passed = 0; const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };
console.log('RH—MUSIC · SoundCloud integration tests\n');

check('поиск каталога объединяется с SoundCloud', /soundCloudSearchPage/.test(worker) && /mergeTrackLists\(page\.items, soundCloud\.items\)/.test(worker));
check('курсор поиска объединяет обе страницы', /combineSearchCursor/.test(worker) && /encodeSearchCursor|decodeSearchCursor/.test(sc));
check('Client ID живёт только в секрете Worker', /SC_CLIENT_ID/.test(sc) && !/SC_CLIENT_ID/.test(app) && !/KKzJxm/.test(app) && !/KKzJxm/.test(index));
check('SoundCloud проксируется через свои маршруты', worker.includes('handleSoundCloudPlay') && worker.includes('handleSoundCloudTrack') && worker.includes('handleSoundCloudStream'));
check('snipped и encrypted транскодинги отбрасываются', /item\.snipped/.test(sc) && /encrypted/i.test(sc));
check('HLS отдаётся как m3u8 того же origin', /application\/vnd\.apple\.mpegurl/.test(sc) && /streamUrl\(track\)/.test(app) && /api\/sc\/play\//.test(app));
check('для SoundCloud подключается hls.js на не-Safari', /Hls\.isSupported/.test(app) && /vendor\/hls\.min\.js/.test(index) && existsSync(join(here, '../web/vendor/hls.min.js')));
check('AutoMix блокируется для SoundCloud', /isSoundCloudTrack\(S\.current\)/.test(app) && /el\.disabled = blocked/.test(app) && /if \(isSoundCloudTrack\(S\.current\)\) return;/.test(app));
check('Smart Mix и текст не работают с SoundCloud', app.includes("smartMixAdoptFailure('unsupported_source'") && app.includes('isSoundCloudTrack(track) ? null : track'));
check('в CSP разрешены обложки и HLS-домены SoundCloud', /\*\.sndcdn\.com/.test(headers) && /\*\.soundcloud\.cloud/.test(headers) && /media-src[^;]*soundcloud\.cloud/.test(headers));
const row = app.slice(app.indexOf('function trackRow'), app.indexOf('function trackList'));
check('в карточке трека нет упоминания источника', !/soundcloud|zvuk/i.test(row));
check('Zvuk-треки получили source=zvuk для общей модели', /source: 'zvuk'/.test(read('worker/src/zvuk.js')));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
