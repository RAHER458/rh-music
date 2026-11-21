from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Section:
    kind: str
    start: float
    end: float
    energy: float
    confidence: float


@dataclass
class TrackAnalysis:
    track_id: str
    duration: float
    bpm: float
    bpm_confidence: float
    beat_grid: list[float]
    downbeats: list[float]
    key: str
    camelot: str
    key_confidence: float
    energy_curve: list[float]
    structure: list[Section]
    vocal_activity: list[float]
    bass_activity: list[float]
    integrated_lufs: float | None
    true_peak_db: float | None
    analysis_confidence: float
    version: str = "automix2-1"
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["structure"] = [asdict(s) for s in self.structure]
        return data


@dataclass
class TransitionPlan:
    outgoing: str
    incoming: str
    outgoing_start: float
    incoming_start: float
    transition_start: float
    duration: float
    outgoing_phase: float
    incoming_phase: float
    target_bpm: float
    outgoing_rate: float
    incoming_rate: float
    strategy: str
    crossfade: str
    eq: list[dict[str, Any]]
    gain: list[dict[str, Any]]
    filter: list[dict[str, Any]]
    bass_swap: float
    vocal_duck: dict[str, Any] | None
    confidence: float
    reasons: list[str]
    fallback: str | None = None
    version: str = "automix2-plan-1"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
