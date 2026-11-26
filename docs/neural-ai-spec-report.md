# RH Neural AI — Preview Technical Report

## Target architecture (implemented vs research)

| Layer | Status | Implementation |
|---|---|---|
| A. Audio Perception | implemented | Web Audio graph: two decks, MediaElementSource, EQ, filters, gain, crossfader, echo, reverb |
| B. Music Information Retrieval | implemented | `analyzeAudioBuffer`: BPM, beat grid, downbeats, phrases, sections, energy, spectrum, vocal, drums |
| C. Neural Music Understanding | not integrated | MERT/CLAP/YAMNet research only; no browser model weights loaded |
| D. Musical Structure Intelligence | implemented (heuristic) | novelty-based sections + per-segment timeline in `buildSegmentTimeline` |
| E. Track Compatibility | implemented | `segmentCompatibility`: harmonic, energy, spectral, bass overlap, vocal overlap, hard constraints |
| F. Transition Decision | implemented | strategy scoring + candidate windows |
| G. Session Intelligence | existing | `SessionIntelligence`, energy direction, no playlist reordering |
| H. Transition Planning | implemented | start/duration/end/entry, phrase/bar, rates, EQ/filter/gain/effects |
| I. Audio Execution | implemented | `AudioEngine.beginTransition` schedules real AudioParam curves |
| J. Adaptive Quality Control | implemented (basic) | live peak/clipping detection, −1.5 dB deck correction |
| K. Musical Memory | existing session memory | outcome recording available; automatic learning removed |

## PulseGrid integration

`pulsegrid-bridge.js` runs the existing PulseGrid worker and merges:

- BPM consensus with confidence;
- key/Camelot chosen by confidence;
- energy peaks and energy-fall candidates.

Real test (One Kiss):

```text
Neural BPM 123.62 conf 0.396
PulseGrid BPM 124.10 conf 0.99
merged 123.86
Neural key A minor 8A conf 0.065
PulseGrid C MAJ 8B conf 0.36
merged C MAJ 8B conf 0.36
PulseGrid cues: 8 energy-fall candidates, mixOut 146.7s
```

## Model evaluation (research only)

| Model | License | Browser feasibility | Decision |
|---|---|---|---|
| Beat This! | check upstream (MIT code, model weights separate) | small0 ONNX possible, needs conversion + WASM test | research, not loaded |
| MERT | MIT code; weights/dataset terms must be checked | too heavy for iPhone WASM in this iteration | research |
| Demucs | MIT code; weights terms checked separately | offline only; not per-transition | research |
| CLAP | check upstream license | heavy; optional context only | research |
| YAMNet | Apache-2.0 | existing pipeline can run WASM | keep as extra perception |
| Essentia | AGPL/commercial options; check before product use | C++/WASM possible | not integrated pending license review |

## Honest limitations

- No neural embeddings are loaded in the browser in this Preview.
- Structure detection is heuristic, not a trained structure model.
- Segments are computed from spectral/rhythm/energy novelty, not from a neural model.
- iPhone audio was not audibly verified in the agent environment.
- Live quality control currently handles peak/clipping only.
- 100-transition blind evaluation was not possible; automated planner tests and real-track analysis were run instead.
- Production RH-MUSIC was not modified.
