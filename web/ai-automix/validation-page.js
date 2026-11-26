import { runValidation, loadStoredValidation, VALIDATION_VERSION } from './validation-runner.js';

const $ = (id) => document.getElementById(id);
let running = false;

function setStatus(text) { $('status').textContent = text; }

async function loadCorpus() {
  const response = await fetch('validation-corpus.json');
  if (!response.ok) throw new Error('corpus HTTP ' + response.status);
  return response.json();
}

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);
}

function render(results) {
  const summary = $('summary');
  const bpmAgreement = results.map((entry) => {
    const neural = entry.totals?.bpm?.neural;
    const beat = entry.totals?.bpm?.beatThis;
    if (!neural || !beat) return null;
    return Math.abs(beat / neural - 1) <= 0.02;
  }).filter((value) => value != null);
  const failures = results.flatMap((entry) => entry.failures || []);
  const latencies = results.map((entry) => entry.totals?.latencyMs).filter(Number.isFinite);
  summary.innerHTML = [
    `tracks ${results.length}`,
    `BPM agree ≤2% ${bpmAgreement.filter(Boolean).length}/${bpmAgreement.length}`,
    `failures ${failures.length}`,
    `avg latency ${latencies.length ? fmt(latencies.reduce((a, b) => a + b, 0) / latencies.length, 0) + ' ms' : '—'}`,
  ].map((text) => `<span>${text}</span>`).join('');
  const rows = results.map((entry) => {
    const t = entry.totals?.tempo || {};
    const source = entry.sources || {};
    const f = entry.metrics?.beatThisVsNeural;
    return `<tr>
      <td>${entry.id}</td>
      <td>${fmt(entry.totals?.bpm?.neural)}</td>
      <td>${fmt(entry.totals?.bpm?.pulsegrid)}</td>
      <td>${fmt(entry.totals?.bpm?.beatThis)}</td>
      <td class="${t.beatThisVsNeural?.classification === 'exact' ? 'good' : 'bad'}">${t.beatThisVsNeural?.classification || '—'}</td>
      <td>${f ? `${f.f1} (P ${f.precision} / R ${f.recall})` : '—'}</td>
      <td>${entry.metrics?.phase ? `${fmt(entry.metrics.phase.medianMs)} / ${fmt(entry.metrics.phase.p95Ms)} ms` : '—'}</td>
      <td>${entry.metrics?.beatThisStability ? `${fmt(entry.metrics.beatThisStability.stability, 3)} · drift ${fmt(entry.metrics.beatThisStability.driftMsPerMinute)}ms/min` : '—'}</td>
      <td>${source.beatThis?.latencyMs ? fmt(source.beatThis.latencyMs, 0) + ' ms' : '—'}</td>
      <td>${(entry.failures || []).map((failure) => failure.source).join(', ') || '—'}</td>
    </tr>`;
  }).join('');
  $('table').innerHTML = `<table><thead><tr><th>ID</th><th>Neural BPM</th><th>PulseGrid BPM</th><th>Beat This BPM</th><th>Tempo</th><th>Beat F@70ms</th><th>Phase med/p95</th><th>Stability</th><th>BT latency</th><th>Failures</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function run(seconds, limit) {
  if (running) return;
  running = true;
  try {
    const corpus = await loadCorpus();
    const ids = corpus.tracks.slice(0, limit || corpus.tracks.length).map((track) => track.id);
    setStatus(`Запуск: ${ids.length} треков, ${seconds}s каждый…`);
    const started = Date.now();
    const result = await runValidation({ ids, seconds });
    setStatus(`Готово за ${((Date.now() - started) / 1000).toFixed(1)}s · ${result.results.length} треков · ${VALIDATION_VERSION}`);
    render(result.results);
    window.__RH_VALIDATION_RESULT = result;
  } catch (error) {
    setStatus('Ошибка: ' + (error?.message || error));
  } finally {
    running = false;
  }
}

$('run60').addEventListener('click', () => run(60));
$('runFull').addEventListener('click', () => run(240, 5));
$('export').addEventListener('click', () => {
  const data = window.__RH_VALIDATION_RESULT || loadStoredValidation();
  if (!data) return setStatus('Нет результатов для экспорта.');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'beat-intelligence-validation.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
$('clear').addEventListener('click', () => { try { localStorage.removeItem('rh_beat_validation_v1'); } catch {} window.__RH_VALIDATION_RESULT = null; render([]); setStatus('Очищено.'); });
const stored = loadStoredValidation();
if (stored?.results?.length) { render(stored.results); setStatus(`Загружены сохранённые результаты: ${stored.results.length} треков.`); }

window.RH_VALIDATION_RUN = run;
