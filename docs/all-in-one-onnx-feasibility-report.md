# All-In-One ONNX Feasibility Report

## Verdict

**INCOMPLETE / NO-GO** for a browser/iPhone pipeline in the tested environment.

## Model source

```text
Repository: mir-aidj/all-in-one
Commit:     18e78903c0365147a2c5d4e5e57ebf88cb7d800e
Weights:    taejunkim/allinone (HF)
Checkpoint: harmonix-fold0-0vra4ys2.pth (MIT)
HF commit:  379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19
```

## Attempts

1. Cloned the official repository.
2. Installed `onnx`, `onnxruntime`, `omegaconf`, `hydra-core`, `huggingface_hub`, `einops`, `torchaudio`, `librosa`, `soundfile`, `natten`.
3. Removed the package `__init__` side effect that imports madmom, so the model module could be imported.
4. Tried NATTEN versions:
   - latest (`0.21.7`) → imported, but API no longer exposes `natten1dav`/`natten1dqkrpb`/`natten2dav`/`natten2dqkrpb`;
   - `natten==0.14.6` → source build failed on Python 3.13;
   - `natten==0.17.5` → source build failed on Python 3.13.
5. Stopped before export.

No ONNX file was produced. No PyTorch-vs-ONNX comparison is claimed.

## Why no architecture rewrite

Replacing NATTEN attention with custom attention, or approximating it, would change the model. The experiment explicitly forbids treating a rewritten model as the original All-In-One.

## HTDemucs

The official pipeline calls `htdemucs` for four stems before the structure model. It is PyTorch, large, and was not exported to ONNX in this experiment. Its browser/iPhone feasibility remains unproven. No stem replacement with EQ/FFT was attempted.

## madmom preprocessing

The official code imports `madmom.audio.signal`, `madmom.audio.stft`, and `madmom.audio.spectrogram`. madmom is not available in the Kaggle Python 3.13 image and no compatible install was completed. The exact 12-band log spectrogram was therefore not reproduced.

## Full pipeline

Not run. Structure model inference was not reached.

## Browser / iPhone

No browser prototype was created because there was no working model artifact. iPhone Safari was not tested. This is not an iPhone result.

## Benchmark

No timings are reported for a pipeline that did not run. Model download was not completed in this run.

## Next required steps

1. Reproduce the official PyTorch pipeline in a Python 3.10/3.11 environment with compatible NATTEN, madmom and Demucs.
2. Record the official outputs on real audio.
3. Export one fold with dynamic time axis; compare logits and boundary positions.
4. Only then evaluate HTDemucs ONNX/WASM and browser memory.
