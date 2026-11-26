# RH Neural AI — Beat Intelligence Validation Report

## 1. Executive summary

The validation framework and corpus were added to the `preview-neural-ai` branch. Beat This! small0 ONNX runs in the browser through ONNX Runtime Web / WASM at 22050 Hz mono and produces beat/downbeat timestamps. Neural AI and PulseGrid are also real sources.

This is an **exploratory validation**, not a complete benchmark:

- no independent beat/downbeat annotations were available for the corpus;
- the 30-track full run did not complete in the agent environment because the Zvuk stream endpoint needed 154–210 seconds to download a single track and the browser tab could not stay active long enough;
- PyTorch vs ONNX was not re-run: torch/torchaudio are not installed in the agent environment.
- iPhone Safari was not available to the agent.

No subjective quality claim is made.

## 2. Test corpus

`docs/validation-corpus.json` contains 30 real Zvuk tracks assembled across House, Deep House, Tech House, Progressive House, Trance, Drum & Bass, Techno, Hip-Hop, Pop, Rock and Funk/Disco queries.

```text
tracks: 30
source: Zvuk via RH-MUSIC API
duration range: 103–420 s
reference annotations: none
```

The corpus is explicitly marked exploratory because it has no independent reference.

## 3. Reference annotation methodology

Not available in this environment. The built-in `validation.html` allows loading reference annotations from JSON or TSV (beats/downbeats/BPM) and will compute real metrics once provided. Without them the framework computes cross-source metrics only and labels them as consistency checks, not ground-truth accuracy.

## 4. Model sources

```text
ONNX export: nilsbc/beat-this-onnx
Original:    CPJKU/beat_this small0 (MIT code)
Files:
  beat_this_small0.onnx
  logmel.onnx
```

Export toolchain recorded by the exporter:

```text
beat-this 1.1.0, torch 2.15.0, onnx 1.23.2, onnxruntime 1.31.1
Exporter claim: ONNX matches PyTorch within ~2e-5 max abs difference.
```

SHA-256 verified locally:

```text
53fda6e96afae7f44d898fa5f020272eda967a92839306bf7a3d0898fb8a0d9a  beat_this_small0.onnx
f5afa499f5a42b05ea89a214561170cd4b76f92d67d3227f7c9833e8d79bbb43  logmel.onnx
```

## 5. Raw results

### Synthetic 1-second run

```text
logmel frames: 51
latency: 2163 ms (includes cold model load)
outputs: beat_logits, downbeat_logits
beat/downbeat counts: 0 (silence)
```

### Real track — 20-second segment

```text
BPM:             125.00
BPM confidence:  0.98
beats:           42
downbeats:       11
beat interval:   0.48 s
latency:         5478 ms in Web Worker
```

### Other analyzers on the same material

```text
Neural AI:  123.62 BPM, confidence 0.396
PulseGrid:  124.10 BPM, confidence 0.99
Beat This:  125.00 BPM, confidence 0.98
```

## 6. Tempo accuracy

Against independent reference: not measured.

Cross-source (exploratory):

```text
Beat This vs Neural: 125.00 / 123.62 = +1.12% → exact class (≤2%)
PulseGrid vs Neural: 124.10 / 123.62 = +0.39% → exact class
Beat This vs Pulse:  125.00 / 124.10 = +0.73% → exact class
```

Half-time/double-time cases were unit-tested in `tempoMetrics` but no corpus track with verified ground truth was available.

## 7. Beat tracking accuracy

Reference-based precision/recall/F@70 ms: **not measured** (no ground truth).

Cross-source consistency:

- fast, single-threaded WASM analysis on a 20 s segment produced a stable 0.48 s interval;
- beat interval standard deviation and drift are computed by `stabilityMetrics` in the framework and shown in the validation table when a run completes.

## 8. Downbeat accuracy

Reference-based accuracy: **not measured**.

Beat This produced 11 downbeats in the 20 s segment (roughly every 4 beats), which is internally consistent with the beat count. Neural/PulseGrid downbeat agreement was not computed because the run did not complete.

## 9. Phase error

Direct consensus unit test (synthetic, independent of audio):

```text
phase error: 0.000 s
```

Real cross-source phase error: not measured. The framework computes median/mean/p95 in milliseconds.

## 10. Grid stability

Synthetic and direct output checks passed. Real corpus stability metrics were not produced because the corpus run stalled on stream download.

## 11. Tempo change results

Not measured. The current Beat This integration processes fixed windows (1500 frames, hop 750) and does not perform variable-tempo tracking. This is a documented limitation, not simulated success.

## 12. Consensus results

Unit tests in `tests/beat-this-consensus.test.mjs` passed:

```text
BPM 124 + Beat This 125 → consensus 124.71, confidence 0.98
conflicting BPM (100 vs 150) → alternatives preserved, disagreement warning added
```

BPM is not blindly averaged. Beat This grid replaces the Neural grid only when `downbeats >= 4` and interval stability `> 0.45`; otherwise the Neural grid is preserved and the warning is recorded.

## 13. Failure cases

Observed environment failures:

- Zvuk stream download: 154609 ms for a 393 s track, 210162 ms for a 103 s track.
- The 8-track 60 s corpus run did not produce a result within the time the automated browser could remain active; it was aborted by reload.
- PulseGrid worker path from the validation page was fixed to an absolute path `/ai-mix-beta/pulsegrid-analysis-worker.js`.

No model-level failure was observed: Beat This ran, returned valid outputs, and was cached per track/model version.

## 14. Full track results

Full-track Beat This inference was not completed in the agent environment. The 20 s real segment is the longest verified run so far.

## 15. Performance

```text
cold model load + 1 s inference: 2163 ms
20 s analysis in worker:        5478 ms
model assets:                    ~15 MB
ORT WASM asset:                  ~11 MB
threads:                         1 (iOS-safe)
UI blocking:                     none observed (worker)
```

Cold start and inference are reported separately. Peak memory and full-track timing were not measured. iPhone Safari performance was not measured on a device.

## 16. iOS Safari status

Not measured on a real device. The implementation avoids WebGPU, uses single-threaded WASM, and runs in a Web Worker. A minimal iPhone check list is:

1. Open `https://rh-music-neural-preview.pages.dev`.
2. Open the diagnostics panel and start AutoMix.
3. Confirm the panel shows Beat This BPM/beats/downbeats without freezing playback.
4. Check tab switch/background/foreground behavior and memory pressure.
5. Run `validation.html` on one short track and export the JSON.

## 17. Planner A/B comparison

Not executed. Transition strategy was intentionally not changed automatically. The framework exists to compare planner A (without Beat This grid) and planner B (with Beat This grid) on the same corpus, but it requires a completed validation run with reference data.

## 18. Blind evaluation

Not performed. No musical quality claim is made.

## 19. Limitations

- No independent ground-truth annotations.
- No PyTorch vs ONNX re-verification in this environment.
- No completed 30-track corpus metrics.
- No iPhone Safari measurements.
- Fixed-window analysis, no variable-tempo tracking.
- Stream download latency from the catalog is the current bottleneck for large validation runs.

## 20. Recommendations

1. Provide independent reference annotations (at least 10–20 tracks) to compute real F-measure, downbeat accuracy and phase error.
2. Run `validation.html` on a real iPhone with a stable network and export JSON.
3. Cache corpus audio locally before running the full 30-track comparison.
4. Only after reference-based results exist, compare planner A/B and consider changing transition strategy.

## 21. Next stage readiness

Beat This ONNX is integrated, works in WASM, is cached, and participates in consensus without deleting PulseGrid or fallback. The validation framework is present and reproducible. Reference-based benchmarking and iPhone measurements are the next required step before any production decision.
