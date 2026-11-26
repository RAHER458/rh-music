# Beat This! small0 ONNX — Preview report

## Model source

- ONNX export: `nilsbc/beat-this-onnx`
- Original weights: `CPJKU/beat_this` `small0` checkpoint (MIT)
- Files used:
  - `beat_this_small0.onnx`
  - `logmel.onnx`
- Export toolchain recorded by the exporter: `beat-this 1.1.0`, `torch 2.15.0`, `onnx 1.23.2`, `onnxruntime 1.31.1`
- Export claim: ONNX Runtime output matches PyTorch within max abs difference about `2e-5`.
- Training data note from the exporter: training data includes copyrighted/limited CC material; weights distributed as research artifacts.

## SHA-256

```text
53fda6e96afae7f44d898fa5f020272eda967a92839306bf7a3d0898fb8a0d9a  beat_this_small0.onnx
f5afa499f5a42b05ea89a214561170cd4b76f92d67d3227f7c9833e8d79bbb43  logmel.onnx
```

Local verification of the downloaded files matched both hashes.

## Runtime

```text
onnxruntime-web 1.22.0
execution provider: wasm
threads: 1 (iOS Safari safety)
runtime assets: web/ai-automix/ort/
models: web/ai-automix/models/
inference: Web Worker (beat-this-worker.js)
```

Serving notes:

- `.mjs` rename to `.js` was required because Cloudflare Direct Upload served `.mjs` as `application/octet-stream`;
- CSP in the Preview worker needed `'wasm-unsafe-eval'`; the change is Preview-only.

## Preprocessing

```text
audio -> mono -> resample 22050 Hz -> logmel.onnx -> 128-band log-mel at 50 fps
-> windows of 1500 frames, hop 750 -> beat_this_small0.onnx -> beat_logits/downbeat_logits
-> sigmoid if values are outside [0,1] -> peak picking (min gap) -> timestamps
```

No custom FFT or mel filterbank is used; `logmel.onnx` is the exported front-end.

## Verified locally

```text
input names:  logmel.onnx: audio
              beat_this_small0.onnx: mel
output names: beat_logits, downbeat_logits
```

Synthetic 1s call: model loaded, logmel frames 51, latency ~2.2s including cold load.

Real track, 20s segment of a Zvuk stream:

```text
BPM:            125.0
BPM confidence: 0.98
beats:          42
downbeats:      11
beat interval:  0.48s
latency:        5478ms in Web Worker
```

Comparison with other sources on the same material:

```text
Neural AI:  123.62 BPM
PulseGrid:  124.10 BPM
Beat This:  125.00 BPM  -> consensus keeps alternatives, does not blindly average
```

## Not verified

- PyTorch vs ONNX logits were not compared in this environment: PyTorch/torchaudio are not installed. The exporter's own `2e-5` claim is recorded but not independently reproduced here.
- Beat This was not run on full-length tracks end-to-end in this session; 20s real segment only.
- iPhone Safari cold/warm load, memory and long-track stability were not measured on a device. The implementation is WASM single-threaded and worker-based, but real device numbers are still required.

## Integration status

- Beat This runs as an independent source in Preview.
- Consensus merges it with Neural AI and PulseGrid, preserving alternative BPM hypotheses and lowering confidence on disagreement.
- The existing PulseGrid and Neural fallback remain.
- Transition strategy is intentionally not changed automatically; this requires the old-vs-new comparison on the same track set.
