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


def plan_transition(a: TrackAnalysis, b: TrackAnalysis) -> TransitionPlan:
    bpm_gap = abs(b.bpm - a.bpm) / max(1.0, a.bpm)
    key_dist = camelot_distance(a.camelot, b.camelot)
    duration = min(32.0, max(4.0, a.duration * 0.12))
    if bpm_gap > 0.08:
        duration = min(duration, 8.0)
    start = _late_start(a, duration)
    if start > a.duration - duration - 0.2:
        duration = max(2.0, a.duration - start - 0.2)
    incoming_start = _nearest(b.downbeats, max(0.0, b.duration * 0.08)) or 0.0
    out_energy = _at(a.energy_curve, a, start)
    in_energy = _at(b.energy_curve, b, incoming_start)
    vocal_a = _at(a.vocal_activity, a, start)
    vocal_b = _at(b.vocal_activity, b, incoming_start)
    bass_a = _at(a.bass_activity, a, start)
    bass_b = _at(b.bass_activity, b, incoming_start)
    reasons: list[str] = []
    fallback: str | None = None
    if bpm_gap > 0.08:
        strategy = "smart-cut"
        fallback = "smart-cut"
        reasons.append(f"BPM gap {bpm_gap*100:.1f}% too large for beatmatch")
    elif key_dist > 2:
        strategy = "smooth-blend"
        reasons.append(f"key distance {key_dist}")
    elif bass_a > 0.55 and bass_b > 0.55:
        strategy = "bass-swap"
        reasons.append("both tracks bass-active at entry")
    elif vocal_a > 0.5 and vocal_b > 0.5:
        strategy = "vocal-aware"
        reasons.append("vocal collision risk")
    elif in_energy - out_energy > 0.2:
        strategy = "energy-punch"
        reasons.append("incoming energy punch")
    elif out_energy - in_energy > 0.2:
        strategy = "harmonic-layer"
        reasons.append("energy descent; long blend")
    else:
        strategy = "beatmatched"
        reasons.append("compatible tempo/key/energy")
    if start < a.duration * 0.6:
        strategy = "smooth-blend"
        fallback = "smart-cut"
        reasons.append("no safe late window; conservative blend")
    confidence = max(0.05, min(1.0, 0.45 + (0.2 if key_dist <= 1 else -0.1) + (0.2 if bpm_gap < 0.04 else -0.1) + 0.3 * a.analysis_confidence))
    if a.analysis_confidence < 0.3 or b.analysis_confidence < 0.3:
        confidence = min(confidence, min(a.analysis_confidence, b.analysis_confidence))
    if confidence < 0.35:
        strategy = "no-transition" if a.analysis_confidence < 0.2 else "smooth-blend"
        fallback = "no-transition" if strategy == "no-transition" else "smart-cut"
        reasons.append("low confidence")
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
