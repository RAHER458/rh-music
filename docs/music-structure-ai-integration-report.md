# Music Structure AI Integration Report

Branch: `structure-ai-integration`
Base checkpoint: `b6b54fd`
Preview: `https://rh-music-reference-preview.pages.dev`
Production: `main d296067` — untouched

## 1. Research

See `docs/music-structure-model-research.md`.

## 2. Selected model

None integrated.

## 3. Reasons for selection / rejection

All-In-One is the only candidate that performs real audio-to-structure segmentation. It was rejected for this stage because:

- no published, validated ONNX export;
- official inference requires Demucs htdemucs separation before the structure model;
- requires madmom-style spectrogram processing;
- the full pipeline is not compatible with iPhone Safari at the current size and runtime budget;
- creating a browser approximation and calling it All-In-One would be a fake model.

## 4. Rejected alternatives

- MSAF / Laplacian segmentation: algorithmic, not a neural structure analyzer.
- OKAI musiclang structure: generates symbolic bar/chord structure from control tokens, not audio boundaries.
- Essentia: license and scope.
- MERT / CLAP: embeddings, no structure boundary head.

## 5. License

All-In-One code and weights are MIT. This does not remove the technical blocker.

## 6. Model source

`mir-aidj/all-in-one` and HF `taejunkim/allinone` (harmonix-fold checkpoints).

## 7. Model size

Single fold ≈ 1.4 MB. The blocker is not the fold size; it is the Demucs + madmom preprocessing pipeline.

## 8. Runtime

No runtime was added. Existing ONNX Runtime Web remains used only by Beat This.

## 9. Preprocessing

Documented but not implemented:
`audio → htdemucs stems → madmom 12-band log spectrogram → 4-stem stack → model`.

## 10. Architecture

Not implemented.

## 11. Worker

Not implemented.

## 12. Schema

Not added for a non-existent model. A schema without real outputs would be dead code.

## 13. Structure Timeline

Not created by a new model. Existing Neural heuristic sections remain available in diagnostics but are not All-In-One.

## 14. Visualization

Not added, because there is no real model output to visualize.

## 15. Corpus

The 30-track validation corpus remains.

## 16. Results

No structure model results.

## 17. Metrics

No structure metrics; no ground truth and no model output.

## 18. Performance

Not measured for a model that was not integrated.

## 19. iPhone testing

Not performed. No device and no model.

## 20. Limitations

- No Structure AI source in RH Neural AI.
- Existing section labels are heuristic and must not be confused with All-In-One.
- iPhone feasibility of All-In-One remains unproven.

## 21. Errors

None at runtime: no model code was added.

## 22. Regression

Existing tests still pass:

```text
reference-schema.test.mjs
beat-this-consensus.test.mjs
planner-intelligence.test.mjs
```

## 23. Commit

This branch contains documentation only; the commit is recorded after pushing.

## 24. Preview URL

`https://rh-music-reference-preview.pages.dev`

## 25. Instructions for testing

No Structure AI feature exists yet to test. Next required work is an ONNX export of All-In-One plus a browser-viable stem separation step.

## Safety

Production, Worker, D1, OAuth, main player, Transition Planner, Beat This, PulseGrid and consensus were not modified.
