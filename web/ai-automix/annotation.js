import {
  addEvent, createAnnotation, normalizeAnnotation, removeNearest, tempoSegmentsFromBeats, validateAnnotation,
} from './reference-schema.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const canvas = $('wave');
const ctx2d = canvas.getContext('2d');
const DB_NAME = 'rh_reference_annotations';
const DB_VERSION = 1;

let state = {
  annotation: createAnnotation({ trackId: 'track_001', duration: 0 }),
  buffer: null,
  peaks: null,
  viewStart: 0,
  viewEnd: 1,
  loop: { a: null, b: null },
  playing: false,
  fileUrl: null,
  trackKey: null,
};

function setStatus(text) { $('status').textContent = text; }

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('annotations')) db.createObjectStore('annotations', { keyPath: 'track_id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveAnnotation(annotation = state.annotation) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('annotations', 'readwrite');
      tx.objectStore('annotations').put(annotation);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    localStorage.setItem('rh_reference_annotation_last', annotation.track_id);
    setStatus(`Сохранено: ${annotation.track_id} · beats ${annotation.beats.length} · downbeats ${annotation.downbeats.length}`);
  } catch (error) {
    // IndexedDB may be unavailable; localStorage fallback keeps the export path alive.
    try { localStorage.setItem('rh_reference_annotation_' + annotation.track_id, JSON.stringify(annotation)); setStatus('Сохранено в localStorage'); } catch { setStatus('Не удалось сохранить: ' + error.message); }
  }
}

async function loadAnnotation(trackId) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('annotations', 'readonly');
      const request = tx.objectStore('annotations').get(trackId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}

function computePeaks(buffer, count = 2400) {
  const channel = buffer.getChannelData(0);
  const peaks = new Float32Array(count);
  const bucket = Math.max(1, Math.floor(channel.length / count));
  for (let i = 0; i < count; i += 1) {
    let max = 0;
    const start = i * bucket;
    const end = Math.min(channel.length, start + bucket);
    for (let j = start; j < end; j += 1) max = Math.max(max, Math.abs(channel[j] || 0));
    peaks[i] = max;
  }
  return peaks;
}

function draw() {
  const width = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
  const height = canvas.height = 220 * (window.devicePixelRatio || 1);
  ctx2d.clearRect(0, 0, width, height);
  if (!state.peaks) {
    ctx2d.fillStyle = '#8b94ac';
    ctx2d.font = '14px system-ui';
    ctx2d.fillText('Загрузи аудиофайл', 20, height / 2);
    return;
  }
  const startTime = state.viewStart;
  const endTime = state.viewEnd;
  const span = Math.max(0.01, endTime - startTime);
  const indexFor = (time) => Math.floor(((time - startTime) / span) * state.peaks.length);
  const toX = (time) => ((time - startTime) / span) * width;
  // waveform
  ctx2d.fillStyle = 'rgba(108,140,255,.55)';
  const step = Math.max(1, Math.floor(state.peaks.length / width));
  for (let x = 0; x < width; x += 1) {
    const peak = state.peaks[Math.min(state.peaks.length - 1, Math.floor((x / width) * state.peaks.length))] || 0;
    const bar = Math.max(1, peak * height * 0.86);
    ctx2d.fillRect(x, (height - bar) / 2, Math.max(1, step), bar);
  }
  // beats
  for (const beat of state.annotation.beats) {
    if (beat < startTime || beat > endTime) continue;
    ctx2d.fillStyle = 'rgba(255,255,255,.75)';
    ctx2d.fillRect(toX(beat), 0, 1.5, height);
  }
  for (const downbeat of state.annotation.downbeats) {
    if (downbeat < startTime || downbeat > endTime) continue;
    ctx2d.fillStyle = '#a855f7';
    ctx2d.fillRect(toX(downbeat), 0, 2.5, height);
  }
  // loop region
  if (state.loop.a != null && state.loop.b != null) {
    const a = Math.min(state.loop.a, state.loop.b);
    const b = Math.max(state.loop.a, state.loop.b);
    ctx2d.fillStyle = 'rgba(124,255,203,.12)';
    ctx2d.fillRect(toX(a), 0, Math.max(1, toX(b) - toX(a)), height);
  }
  // playhead
  if (audio.duration) {
    const x = toX(audio.currentTime);
    ctx2d.fillStyle = '#fff';
    ctx2d.fillRect(x, 0, 1.5, height);
  }
}

function updatePlayhead() {
  const wrap = document.querySelector('.wave-wrap');
  if (wrap && audio.duration) {
    const left = ((audio.currentTime - state.viewStart) / Math.max(0.01, state.viewEnd - state.viewStart)) * wrap.clientWidth;
    $('playhead').style.left = Math.max(0, Math.min(wrap.clientWidth, left)) + 'px';
    $('playhead').hidden = left < 0 || left > wrap.clientWidth;
  }
  draw();
  if (state.playing) requestAnimationFrame(updatePlayhead);
}

function refreshStatus() {
  const validation = validateAnnotation(state.annotation);
  setStatus(`${state.annotation.track_id} · beats ${state.annotation.beats.length} · downbeats ${state.annotation.downbeats.length} · ${validation.ok ? 'валидно' : 'ошибки: ' + validation.errors.slice(0, 2).join(', ')}`);
}

function commit(annotation) {
  state.annotation = normalizeAnnotation(annotation);
  draw();
  refreshStatus();
  saveAnnotation();
}

async function loadAudio(file) {
  const url = URL.createObjectURL(file);
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = url;
  audio.src = url;
  await new Promise((resolve) => { audio.addEventListener('loadedmetadata', resolve, { once: true }); setTimeout(resolve, 4000); });
  const trackId = $('trackId').value.trim() || file.name.replace(/\.[^.]+$/, '');
  $('trackId').value = trackId;
  const arrayBuffer = await file.arrayBuffer();
  const decodeCtx = new AudioContext();
  const buffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  await decodeCtx.close();
  state.buffer = buffer;
  state.peaks = computePeaks(buffer);
  state.viewStart = 0;
  state.viewEnd = buffer.duration;
  const saved = await loadAnnotation(trackId);
  state.annotation = saved ? normalizeAnnotation(saved) : createAnnotation({ trackId, title: file.name, duration: buffer.duration, annotatorId: $('annotator').value.trim() || 'annotator_1' });
  state.annotation.duration_seconds = Number(buffer.duration.toFixed(3));
  draw();
  refreshStatus();
}

function currentTime() { return audio.currentTime || 0; }

function step(delta) {
  audio.currentTime = Math.max(0, Math.min(audio.duration || 0, currentTime() + delta));
  updatePlayhead();
}

function addBeat(kind) {
  if (!state.buffer) return;
  commit(addEvent(state.annotation, currentTime(), kind));
}

function nearestList(kind) { return kind === 'downbeat' ? state.annotation.downbeats : state.annotation.beats; }

function goto(direction) {
  const list = state.annotation.beats;
  if (!list.length) return;
  const sorted = [...list].sort((a, b) => a - b);
  const time = currentTime();
  const next = direction > 0 ? sorted.find((value) => value > time + 0.01) : [...sorted].reverse().find((value) => value < time - 0.01);
  if (next != null) { audio.currentTime = next; updatePlayhead(); }
}

$('file').addEventListener('change', (event) => { const file = event.target.files[0]; if (file) loadAudio(file).catch((error) => setStatus('Ошибка аудио: ' + error.message)); });
$('play').addEventListener('click', async () => {
  if (!state.buffer) return;
  if (audio.paused) { try { await audio.play(); state.playing = true; $('play').textContent = '❚❚ Pause'; requestAnimationFrame(updatePlayhead); } catch (error) { setStatus('Play error: ' + error.message); } }
  else { audio.pause(); state.playing = false; $('play').textContent = '▶ Play'; }
});
$('back1').addEventListener('click', () => step(-1));
$('fwd1').addEventListener('click', () => step(1));
$('back5').addEventListener('click', () => step(-5));
$('fwd5').addEventListener('click', () => step(5));
$('prev').addEventListener('click', () => goto(-1));
$('next').addEventListener('click', () => goto(1));
$('tapBeat').addEventListener('click', () => addBeat('beat'));
$('tapDown').addEventListener('click', () => addBeat('downbeat'));
$('undo').addEventListener('click', () => {
  const beats = [...state.annotation.beats]; const downbeats = [...state.annotation.downbeats];
  const lastBeat = beats.length ? beats[beats.length - 1] : -1;
  const lastDown = downbeats.length ? downbeats[downbeats.length - 1] : -1;
  if (lastDown > lastBeat) commit({ ...state.annotation, downbeats: downbeats.slice(0, -1) });
  else if (lastBeat >= 0) commit({ ...state.annotation, beats: beats.slice(0, -1) });
});
$('delete').addEventListener('click', () => commit(removeNearest(state.annotation, currentTime(), nearestList('downbeat').length && Math.abs(nearestList('downbeat').slice(-1)[0] - currentTime()) < 0.2 ? 'downbeat' : 'beat')));
$('zoomIn').addEventListener('click', () => { const center = (state.viewStart + state.viewEnd) / 2; const span = Math.max(2, (state.viewEnd - state.viewStart) * 0.6); state.viewStart = Math.max(0, center - span / 2); state.viewEnd = Math.min(audio.duration || span, state.viewStart + span); draw(); });
$('zoomOut').addEventListener('click', () => { const center = (state.viewStart + state.viewEnd) / 2; const span = Math.min(audio.duration || 1e9, (state.viewEnd - state.viewStart) * 1.7); state.viewStart = Math.max(0, center - span / 2); state.viewEnd = Math.min(audio.duration || span, state.viewStart + span); draw(); });
$('panLeft').addEventListener('click', () => { const span = state.viewEnd - state.viewStart; state.viewStart = Math.max(0, state.viewStart - span * 0.25); state.viewEnd = state.viewStart + span; draw(); });
$('panRight').addEventListener('click', () => { const span = state.viewEnd - state.viewStart; state.viewEnd = Math.min(audio.duration || state.viewEnd, state.viewEnd + span * 0.25); state.viewStart = state.viewEnd - span; draw(); });
$('loopA').addEventListener('click', () => { state.loop.a = currentTime(); draw(); });
$('loopB').addEventListener('click', () => { state.loop.b = currentTime(); draw(); });
$('loopClear').addEventListener('click', () => { state.loop = { a: null, b: null }; draw(); });
$('save').addEventListener('click', () => saveAnnotation());
$('export').addEventListener('click', () => {
  state.annotation.tempo_segments = tempoSegmentsFromBeats(state.annotation.beats);
  const blob = new Blob([JSON.stringify(state.annotation, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `${state.annotation.track_id}.reference.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
$('import').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const validation = validateAnnotation(parsed);
    if (!validation.ok) { setStatus('Импорт: ' + validation.errors.join(', ')); return; }
    state.annotation = normalizeAnnotation(parsed);
    $('trackId').value = state.annotation.track_id;
    draw(); refreshStatus(); saveAnnotation();
  } catch (error) { setStatus('Импорт не удался: ' + error.message); }
});
$('clear').addEventListener('click', () => commit(createAnnotation({ trackId: $('trackId').value.trim() || 'track_001', duration: audio.duration || 0, annotatorId: $('annotator').value.trim() || 'annotator_1' })));
$('trackId').addEventListener('change', async () => { const saved = await loadAnnotation($('trackId').value.trim()); if (saved) { state.annotation = normalizeAnnotation(saved); draw(); refreshStatus(); } });

canvas.addEventListener('click', (event) => {
  if (!audio.duration) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  audio.currentTime = state.viewStart + ratio * (state.viewEnd - state.viewStart);
  updatePlayhead();
});
canvas.addEventListener('pointerdown', (event) => {
  if (!event.shiftKey || !audio.duration) return;
  const rect = canvas.getBoundingClientRect();
  state.loop.a = state.viewStart + ((event.clientX - rect.left) / rect.width) * (state.viewEnd - state.viewStart);
});
canvas.addEventListener('pointerup', (event) => {
  if (state.loop.a == null || !audio.duration) return;
  if (event.shiftKey) {
    const rect = canvas.getBoundingClientRect();
    state.loop.b = state.viewStart + ((event.clientX - rect.left) / rect.width) * (state.viewEnd - state.viewStart);
    draw();
  }
});

audio.addEventListener('timeupdate', () => {
  if (state.loop.a != null && state.loop.b != null) {
    const a = Math.min(state.loop.a, state.loop.b); const b = Math.max(state.loop.a, state.loop.b);
    if (audio.currentTime >= b - 0.02) audio.currentTime = a;
  }
  updatePlayhead();
});
audio.addEventListener('ended', () => { state.playing = false; $('play').textContent = '▶ Play'; });

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT') return;
  if (event.code === 'Space') { event.preventDefault(); $('play').click(); }
  if (event.key === 'b' || event.key === 'B') addBeat('beat');
  if (event.key === 'd' || event.key === 'D') addBeat('downbeat');
  if (event.key === 'z' || event.key === 'Z') $('undo').click();
  if (event.key === 'Delete' || event.key === 'Backspace') $('delete').click();
  if (event.key === 'ArrowLeft') step(event.shiftKey ? -5 : -1);
  if (event.key === 'ArrowRight') step(event.shiftKey ? 5 : 1);
});

window.__RH_ANNOTATION = {
  get state() { return state.annotation; },
  set annotation(value) { commit(value); },
  save: () => saveAnnotation(),
  load: loadAnnotation,
};
refreshStatus();
