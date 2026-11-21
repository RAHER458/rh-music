"""Deterministic, dependency-free transition planner for AutoMix Beta 2.0."""
from __future__ import annotations
from models import TrackAnalysis, TransitionPlan

STRATEGIES = (
    "harmonic-layer", "beatmatched", "bass-swap", "vocal-aware",
    "energy-punch", "build-drop", "smooth-blend", "smart-cut", "no-transition",
)


def camelot_distance(a: str, b: str) -> int:
    def parse(v):
        v = (v or "").strip().upper()
        if len(v) < 2 or not v[:-1].isdigit():
            return None
        mode = v[-1]
        return (int(v[:-1]), mode) if mode in ("A", "B") else None
    x, y = parse(a), parse(b)
    if not x or not y:
        return 12
    diff = abs(x[0] - y[0]); ring = min(diff, 12 - diff)
    return ring + (0 if x[1] == y[1] else 1)


def _at(curve: list[float], analysis: TrackAnalysis, t: float) -> float:
    if not curve:
        return 0.0
    idx = min(len(curve) - 1, max(0, int(t / max(0.1, analysis.duration) * len(curve))))
    return curve[idx]


def _nearest(values: list[float], target: float) -> float | None:
    if not values:
        return None
    return min(values, key=lambda v: abs(v - target))


def _late_start(a: TrackAnalysis, duration: float) -> float:
    latest = max(0.0, a.duration - duration - 0.5)
    floor = max(a.duration * 0.72, a.duration - max(45.0, a.duration * 0.22))
    start = min(floor, latest)
    return _nearest(a.downbeats, start) or start


def plan_transition(a: TrackAnalysis, b: TrackAnalysis, position: float = 0.0) -> TransitionPlan:
    bpm_gap = abs(b.bpm - a.bpm) / max(1.0, a.bpm)
    key_dist = camelot_distance(a.camelot, b.camelot)
    out_energy = _at(a.energy_curve, a, max(0.0, a.duration - 8.0))
    in_energy = _at(b.energy_curve, b, min(b.duration, 8.0))
    energy_delta = out_energy - in_energy
    vocal_a = _at(a.vocal_activity, a, max(0.0, a.duration - 12.0))
    vocal_b = _at(b.vocal_activity, b, min(b.duration, 12.0))
    bass_a = _at(a.bass_activity, a, max(0.0, a.duration - 12.0))
    bass_b = _at(b.bass_activity, b, min(b.duration, 12.0))
    reasons: list[str] = []
    fallback: str | None = None
    # phrase length in beats, varied by musical compatibility
    beats = 16
    if bpm_gap <= 0.04 and key_dist <= 1 and vocal_a < 0.5 and vocal_b < 0.5:
        beats = 32
    if bpm_gap > 0.06 or key_dist > 2 or vocal_a > 0.5 or vocal_b > 0.5 or abs(energy_delta) > 0.25:
        beats = 8
    duration = min(32.0, max(2.0, beats * 60.0 / max(60.0, a.bpm)))
    if bpm_gap > 0.08:
        beats = 4
        duration = min(8.0, max(2.0, beats * 60.0 / max(60.0, a.bpm)))
    # outgoing: prefer last outro section, otherwise late-tail downbeat
    outro_start = None
    for seg in getattr(a, 'structure', []) or []:
        kind = seg.get('kind') if isinstance(seg, dict) else getattr(seg, 'kind', '')
        start = seg.get('start') if isinstance(seg, dict) else getattr(seg, 'start', 0.0)
        if kind == 'outro' and start > a.duration * 0.5:
            outro_start = start
    target_start = outro_start if outro_start is not None else max(a.duration * 0.72, a.duration - max(45.0, a.duration * 0.22))
    candidate = _nearest(a.downbeats, target_start)
    start = candidate if candidate is not None else target_start
    current = max(0.0, min(float(position), a.duration))
    if start < current + 0.5:
        start = _nearest(a.downbeats, min(max(current + 0.3, a.duration * 0.5), max(0.0, a.duration - 0.6))) or max(current + 0.3, a.duration * 0.5)
        reasons.append('position is already inside the planned window; re-anchored')
    if start > a.duration - duration - 0.2:
        duration = max(2.0, a.duration - start - 0.2)
    if a.duration - current < 6.0:
        duration = max(2.0, a.duration - start - 0.2)
        beats = max(2, int(duration * max(60.0, a.bpm) / 60.0))
        reasons.append('less than 6s remain; short handoff')
    # incoming: first downbeat of intro, but skip a long ambient intro when possible
    intro_end = None
    for seg in getattr(b, 'structure', []) or []:
        kind = seg.get('kind') if isinstance(seg, dict) else getattr(seg, 'kind', '')
        end = seg.get('end') if isinstance(seg, dict) else getattr(seg, 'end', 0.0)
        if kind == 'intro':
            intro_end = end
    incoming_target = 0.0
    if intro_end is not None and intro_end > 25.0:
        for seg in getattr(b, 'structure', []) or []:
            kind = seg.get('kind') if isinstance(seg, dict) else getattr(seg, 'kind', '')
            start = seg.get('start') if isinstance(seg, dict) else getattr(seg, 'start', 0.0)
            if kind in ('drop', 'chorus', 'verse') and start >= intro_end:
                incoming_target = start
                reasons.append('skipped long intro to a musical section')
                break
    incoming_start = _nearest(b.downbeats, incoming_target if incoming_target else min(4.0, b.duration * 0.05)) or 0.0
    if bpm_gap > 0.08:
        strategy = 'smart-cut'; fallback = 'smart-cut'
        reasons.append(f'BPM gap {bpm_gap*100:.1f}% too large for beatmatch')
    elif key_dist > 2:
        strategy = 'smooth-blend'; reasons.append(f'key distance {key_dist}')
    elif vocal_a > 0.5 and vocal_b > 0.5:
        strategy = 'vocal-aware'; reasons.append('vocal collision risk')
    elif bass_a > 0.55 and bass_b > 0.55:
        strategy = 'bass-swap'; reasons.append('both tracks bass-active at entry')
    elif in_energy - out_energy > 0.25:
        strategy = 'energy-punch'; reasons.append('incoming energy punch')
    elif out_energy - in_energy > 0.25:
        strategy = 'harmonic-layer'; reasons.append('energy descent; long blend')
    elif bpm_gap <= 0.04 and key_dist <= 1:
        strategy = 'beatmatched'; reasons.append('compatible tempo/key/energy')
    else:
        strategy = 'smooth-blend'; reasons.append('partially compatible; conservative blend')
    if start < a.duration * 0.55:
        strategy = 'smooth-blend'; fallback = 'smart-cut'
        reasons.append('no safe late window; conservative blend')
    confidence = max(0.05, min(1.0, 0.45 + (0.2 if key_dist <= 1 else -0.1) + (0.2 if bpm_gap < 0.04 else -0.1) + 0.3 * a.analysis_confidence))
    if a.analysis_confidence < 0.3 or b.analysis_confidence < 0.3:
        confidence = min(confidence, min(a.analysis_confidence, b.analysis_confidence))
    if confidence < 0.35:
        strategy = 'no-transition' if a.analysis_confidence < 0.2 else 'smooth-blend'
        fallback = 'no-transition' if strategy == 'no-transition' else 'smart-cut'
        reasons.append('low confidence')
    rate_in = max(0.94, min(1.06, a.bpm / max(60.0, b.bpm)))
    eq = [
        {"deck": "out", "band": "low", "at": 0.0, "value": 0.0},
        {"deck": "out", "band": "low", "at": 0.5, "value": -24.0},
        {"deck": "in", "band": "low", "at": 0.0, "value": -24.0},
        {"deck": "in", "band": "low", "at": 0.5, "value": 0.0},
    ]
    gain = [
        {"deck": "out", "at": 0.0, "value": 1.0},
        {"deck": "out", "at": 1.0, "value": 0.0},
        {"deck": "in", "at": 0.0, "value": 0.0},
        {"deck": "in", "at": 1.0, "value": 1.0},
    ]
    filter_plan = [{"deck": "out", "at": 0.0, "value": 0.0}, {"deck": "out", "at": 1.0, "value": -1.0 if strategy == "smart-cut" else 0.0}]
    return TransitionPlan(
        outgoing=a.track_id, incoming=b.track_id,
        outgoing_start=round(start, 3), incoming_start=round(incoming_start, 3),
        transition_start=round(start, 3), duration=round(duration, 3),
        outgoing_phase=0.0, incoming_phase=0.0,
        target_bpm=a.bpm, outgoing_rate=1.0, incoming_rate=round(rate_in, 4),
        strategy=strategy, crossfade="equal-power",
        eq=eq, gain=gain, filter=filter_plan,
        bass_swap=0.5, vocal_duck={"threshold": 0.5, "depth": -5.0} if strategy == "vocal-aware" else None,
        confidence=round(confidence, 3), reasons=reasons, fallback=fallback,
    )
