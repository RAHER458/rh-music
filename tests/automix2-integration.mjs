import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../web/automix2/controller.js'), 'utf8');

class Param {
  constructor(v = 1) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class Node { connect(n) { return n; } disconnect() {} }
class Gain extends Node { constructor() { super(); this.gain = new Param(1); } }
class Filter extends Node { constructor() { super(); this.frequency = new Param(22000); this.Q = new Param(0.7); this.gain = new Param(0); this.type = ''; } }
class Comp extends Node { constructor() { super(); this.threshold = new Param(-3); this.knee = new Param(0); this.ratio = new Param(12); this.attack = new Param(0.003); this.release = new Param(0.18); } }
class Source extends Node {
  constructor() { super(); this.buffer = null; this.playbackRate = new Param(1); this.loop = false; this.loopStart = 0; this.loopEnd = 0; this.onended = null; }
  start() {} stop() { if (this.onended) this.onended(); }
}
class FakeBuffer {
  constructor(duration = 20, sr = 44100) { this.duration = duration; this.sampleRate = sr; this.numberOfChannels = 2; this.length = Math.floor(duration * sr); }
  getChannelData() { return new Float32Array(Math.min(this.length, 400000)); }
}
class Ctx {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100; this.destination = new Node(); }
  createGain() { return new Gain(); }
  createBiquadFilter() { return new Filter(); }
  createDynamicsCompressor() { return new Comp(); }
  createBufferSource() { return new Source(); }
  createDelay() { const n = new Node(); n.delayTime = new Param(0.25); return n; }
  decodeAudioData() { return Promise.resolve(new FakeBuffer()); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
}
const win = { AudioContext: Ctx, webkitAudioContext: Ctx, location: { search: '' }, setInterval, clearInterval, setTimeout, clearTimeout, fetch, FormData, Blob, console, URL, indexedDB: undefined };
new Function('window', 'document', source)(win, { createElement: () => ({}) });
const API = win.RH_AUTOMIX2;
if (process.env.AUTOMIX2_LIVE !== '1') { console.log('skip: set AUTOMIX2_LIVE=1 to run the live Railway integration test'); process.exit(0); }
console.log('API', !!API);

function wavBuffer(seconds = 60) {
  const sr = 8000, n = sr * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin((i / sr) * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  return buf;
}
const wav = wavBuffer(60);
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const wavUrl = 'http://127.0.0.1:' + server.address().port + '/t.wav';
const tracks = [
  { id: 't1', title: 'Track One', artist: 'A', duration: 60 },
  { id: 't2', title: 'Track Two', artist: 'B', duration: 60 },
  { id: 't3', title: 'Track Three', artist: 'C', duration: 60 },
];
const S = { queue: tracks, index: 0, current: tracks[0] };
const ctx = new Ctx();
let adopted = null; const adoptedTitles=[];
const host = {
  getState: () => ({ current: S.current, index: S.index, queue: S.queue, currentTime: ctx.currentTime, duration: S.current.duration, paused: false, volume: 1, muted: false }),
  streamUrl: () => wavUrl,
  getAudio: () => ({ pause() {}, play() { return Promise.resolve(); } }),
  onState: () => {}, onToast: (m) => console.log('toast', m), onAdopt: (t) => { adopted = t; S.current = t; S.index = S.queue.findIndex((x) => x.id === t.id); adoptedTitles.push(t.title); console.log('ADOPT', t.title); ctx.currentTime = 0; },
  onExit: () => {}, log: () => {},
};
win.RH_AUTOMIX2.init(host);
await win.RH_AUTOMIX2.enable().catch((e) => console.log('enable error', e.message));
console.log('phase after enable', win.RH_AUTOMIX2.getState().phase);
for (let i = 0; i < 900; i += 1) {
  ctx.currentTime += 0.2;
  await new Promise((r) => setTimeout(r, 50));
  if (adoptedTitles.length >= 2) break;
  if (i % 20 === 0) console.log(i, win.RH_AUTOMIX2.getState().phase, win.RH_AUTOMIX2.getState().plan?.startAt);
}
win.RH_AUTOMIX2.releaseToStandard(false);
const released = !win.RH_AUTOMIX2.ownsPlayback();
const st = win.RH_AUTOMIX2.getState();
console.log('FINAL', JSON.stringify({ released, adopted: adoptedTitles, phase: st.phase, error: st.error, plan: st.plan, diag: win.RH_AUTOMIX2.getDiagnostics().log.slice(-8) }, null, 1));
server.close(); const ok = adoptedTitles.length >= 2 && adoptedTitles[0] === 'Track Two' && adoptedTitles[1] === 'Track Three' && released && !st.error;
console.log('RESULT', ok ? 'PASS' : 'FAIL');
server.close(); process.exit(ok ? 0 : 1);
