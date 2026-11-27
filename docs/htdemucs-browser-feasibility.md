# HTDemucs Browser Feasibility

## Status

Not verified. No ONNX export, no WASM run, no memory measurement.

## Facts

- Official All-In-One preprocessing requires HTDemucs separation into `bass`, `drums`, `other`, `vocals`.
- HTDemucs is a PyTorch model; the official package is not a browser component.
- All-In-One's structure input is a 4-stem stack; substituting the mix or EQ bands would be a different pipeline.
- A browser port would need a validated ONNX/WebAssembly stem separator in addition to the structure model.
- No measurements are claimed because none were made.

## Consequence

The full All-In-One pipeline is not currently feasible in the browser/iPhone path without a separate stem-separation research project.
