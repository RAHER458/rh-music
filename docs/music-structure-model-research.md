# Music Structure Model Research

Date: 2026-11-27
Branch: `structure-ai-integration`
Base: `b6b54fd`

## Candidates

| Model / project | Repo / weights | Architecture | Input | Output | Browser | License | Verdict |
|---|---|---|---|---|---|---|---|
| All-In-One Music Structure Analyzer | `mir-aidj/all-in-one`; weights `taejunkim/allinone` | CNN/Transformer over 4-stem spectrograms | 4 separated stems, madmom log-filtered spectrogram | Functional segment boundaries + labels (intro/verse/chorus/breakdown/outro) | No prebuilt ONNX; requires PyTorch + madmom + Demucs | MIT (code and weights) | Suitable audio-structure model, but not viable in iPhone Safari in this form |
| Harmonix dataset | via All-In-One code | dataset, not a standalone model | n/a | n/a | n/a | dataset terms apply | Not a model |
| MSAF | `urinieto/msaf` | algorithmic segmentation (no neural weights) | audio features | boundaries, segment labels depending on algorithm | Python; no browser build | MIT | Useful algorithm reference, not the requested AI model |
| Laplacian segmentation | librosa examples | self-similarity/spectral clustering | audio features | boundaries | could be ported, but not an AI model | librosa ISC | Not selected |
| OKAI musiclang structure | HF `sandernotenbaert/okai-musiclang-structure-v002` | MLX autoregressive text generator | control tokens | bar/chord structure text | MLX/Apple Silicon; not audio boundaries; no ONNX | no explicit license in model card | Rejected: different task |
| Essentia | `essentia.upf.edu` | C++ DSP/ML | audio | various | WASM possible | AGPL/commercial | Rejected: license/scope for this stage |
| MERT / CLAP | Meta / LAION | audio embeddings | audio | embeddings | heavy, no boundary head | research weights terms | Rejected: not a structure segmenter |
| Beat This small0 ONNX | already integrated | beat/downbeat | audio | beats/downbeats | WASM works | MIT | Already integrated; does not solve structure |

## All-In-One details

- Code: MIT, `mir-aidj/all-in-one`.
- Weights: HF `taejunkim/allinone`, MIT, e.g. `harmonix-fold0-0vra4ys2.pth` ≈ 1.4 MB.
- Available checkpoints: `harmonix-fold0..7`, `all-fold*`, `raveform-fold3`.
- Preprocessing in the official pipeline:
  1. Demucs `htdemucs` separation into bass/drums/other/vocals;
  2. madmom `FramedSignalProcessor` + STFT + filtered spectrogram (12 bands, 30–17000 Hz) + log;
  3. stack 4 stems × frames × bins;
  4. model inference.
- Output: functional segment boundaries and labels, plus activations/embeddings if requested.
- The official inference code does not provide an ONNX export.
- A browser port would need a Demucs-equivalent source separation model in WASM plus a madmom-equivalent spectrogram. That is far beyond the current iPhone budget and would be a new research project, not an integration of an existing browser-ready model.

## Decision

No Music Structure model is integrated in this stage.

Reason: the only candidate that actually solves audio structure segmentation (All-In-One) depends on Demucs stem separation and a PyTorch/madmom pipeline, and has no validated ONNX/WebAssembly export. Integrating it by writing a fake browser approximation or by silently replacing it with algorithmic segmentation would violate the requirement not to simulate a model.

The existing Neural AI heuristic sections remain the only structure source; they are not All-In-One and must not be presented as such.

## Next possible steps (not started)

1. Export one All-In-One fold to ONNX and verify PyTorch↔ONNX equivalence.
2. Convert Demucs htdemucs to ONNX or find a small stem-separation alternative.
3. Measure ONNX Runtime Web memory/CPU on iPhone.
4. Only then decide whether structure inference is realistic in Safari.
