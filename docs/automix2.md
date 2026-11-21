# Auto Mix Beta 2.0

- Separate mode from Neural AutoMix and the disabled PulseGrid Beta.
- Python backend: Railway `https://automix2-api-production.up.railway.app`.
- Analysis uses a compact mono WAV preview, not the full stream.
- Backend returns BPM, beat grid, downbeats, key/Camelot, energy, structure,
  vocal/bass curves, loudness and confidence.
- Transition planner returns a late-window plan with confidence, EQ/gain/filter
  and bass-swap data.
- Browser falls back to the local PulseGrid worker/planner if Railway is asleep
  or unavailable.
- Two AudioBufferSourceNode decks with PulseGrid pitch-lock, equal-power
  crossfade, headroom and limiter.
- Button `Auto Mix Beta 2.0` in the RH-MUSIC player/Now Playing.
- Mutual exclusion with AI AutoMix.

Limitations: real-device audio and listening are not verified; the browser
controller remains an RH adapter around PulseGrid DSP, not a full PulseGrid
application import.
