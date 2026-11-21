# AI Mix Beta — independent experimental mixer

## Research

Candidates examined:

- **ujjwalredd/AI-DJ** (MIT): full-stack autonomous DJ, server/LLM driven. Rejected for this
  mode: not a browser two-deck Web Audio executor and would require a different runtime.
- **ysy-ym/pulsegrid** (MIT): local-first browser DJ with transition policy, cue planning and
  live takeover rules. The transition-duration/safe-window policy was used as a design
  reference; the controller is an independent implementation for RH-MUSIC.
- **CouraLabs/OpenMixing** (GPL-3.0): Python CLI/offline analysis/stems. Rejected: no
  real-time browser two-deck executor; GPL coupling would be inappropriate.
- **claregartz/dj-mixer** (no license file found): browser AudioBufferSourceNode decks,
  equal-power crossfade, EQ/filter. Architecture reference only; no code copied.

## Chosen approach

A separate browser engine was implemented in `web/ai-mix-beta/controller.js`:

- own BPM/onset analysis, downbeats, energy sections;
- own transition planner with a late-track policy (`max(duration*0.72, duration - tail)`);
- two AudioBufferSourceNode decks with independent gain/EQ/filter;
- equal-power crossfade, bass swap for close BPM, filter cut for large BPM gaps;
- tempo rate matching within ±6%;
- one next track from the existing RH-MUSIC queue, after `S.index`;
- preparation of only the next track;
- adoption through the existing RH-MUSIC UI/history path;
- separate global `RH_AI_MIX_BETA` and button, mutually exclusive with AI AutoMix.

## Not done

- no real listening/physical-device validation;
- no stem separation or vocal model;
- no server components, no paid APIs;
- no queue expansion beyond the user's queue.
