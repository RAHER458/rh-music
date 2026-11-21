"""Audio analysis for AutoMix Beta 2.0.

The browser sends a compact mono WAV preview (not the full stream). Analysis is
performed server-side with librosa; every field is computed from audio.
"""
from __future__ import annotations
import io
import math
import numpy as np
import librosa
import soundfile as sf
from models import Section, TrackAnalysis

SR = 22050
HOP = 512
CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def decode_preview(data: bytes) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SR:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=SR)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.99:
        audio = audio * (0.99 / peak)
    return audio.astype(np.float32), SR


def _sections(y: np.ndarray, sr: int, duration: float) -> list[Section]:
    block = max(4.0, duration / 16.0)
    out: list[Section] = []
    for i in range(16):
        start = i * block
        if start >= duration:
            break
        end = min(duration, start + block)
        seg = y[int(start * sr):int(end * sr)]
        energy = float(np.sqrt(np.mean(seg ** 2))) if seg.size else 0.0
        if i == 0:
            kind = "intro"
        elif i == 15 or end >= duration - 0.5:
            kind = "outro"
        elif energy > 0.16:
            kind = "drop" if i % 4 == 3 else "chorus"
        elif energy < 0.055:
            kind = "breakdown"
        else:
            kind = "verse"
        out.append(Section(kind, round(start, 3), round(end, 3), round(min(1.0, energy * 4), 3), 0.45))
    # normalize energies
    peak = max((s.energy for s in out), default=1.0) or 1.0
    for s in out:
        s.energy = round(s.energy / peak, 3)
    return out


def analyze_bytes(data: bytes, track_id: str) -> TrackAnalysis:
    y, sr = decode_preview(data)
    duration = float(len(y) / sr)
    if duration < 8:
        raise ValueError("preview too short")
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP, units="frames")
    bpm = float(np.asarray(tempo).ravel()[0]) if np.size(tempo) else 120.0
    bpm = max(60.0, min(190.0, bpm))
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP).tolist()
    downbeats = [round(t, 3) for i, t in enumerate(beat_times) if i % 4 == 0]
    chroma = librosa.feature.chroma_cqt(y=librosa.effects.harmonic(y), sr=sr, hop_length=HOP).mean(axis=1)
    chroma = chroma / (chroma.sum() + 1e-9)
    best = (0, "major", -2.0)
    for root in range(12):
        for mode, profile in (("major", KS_MAJOR), ("minor", KS_MINOR)):
            rolled = np.roll(profile, root)
            score = float(np.corrcoef(chroma, rolled / rolled.sum())[0, 1])
            if score > best[2]:
                best = (root, mode, score)
    root, mode, key_conf = best
    camelot = (CAMELOT_MAJOR if mode == "major" else CAMELOT_MINOR)[root]
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    energy_curve = [round(float(v / (rms.max() + 1e-9)), 3) for v in rms[::max(1, len(rms) // 128)]]
    bass = librosa.feature.rms(y=librosa.effects.preemphasis(y) * 0 + y, hop_length=HOP)[0]
    # simple bass band via STFT
    stft = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low = stft[freqs < 180].mean(axis=0) if np.any(freqs < 180) else np.zeros_like(bass)
    mid = stft[(freqs >= 300) & (freqs <= 3400)].mean(axis=0) if np.any((freqs >= 300) & (freqs <= 3400)) else np.zeros_like(bass)
    bass_curve = [round(float(v / (low.max() + 1e-9)), 3) for v in low[::max(1, len(low) // 128)]]
    vocal_curve = [round(float(v / (mid.max() + 1e-9)), 3) for v in mid[::max(1, len(mid) // 128)]]
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    confidence = float(max(0.05, min(0.98, 0.35 + 0.35 * min(1.0, len(beat_times) / max(1.0, duration / 0.5)) + 0.25 * max(0.0, key_conf))))
    return TrackAnalysis(
        track_id=track_id, duration=round(duration, 3), bpm=round(bpm, 2),
        bpm_confidence=round(min(0.98, max(0.1, len(beat_times) / max(1.0, duration / (60 / bpm)))), 3),
        beat_grid=[round(t, 3) for t in beat_times], downbeats=downbeats,
        key=f"{NOTES[root]} {'maj' if mode == 'major' else 'min'}", camelot=camelot,
        key_confidence=round(max(0.0, key_conf), 3), energy_curve=energy_curve,
        structure=_sections(y, sr, duration), vocal_activity=vocal_curve, bass_activity=bass_curve,
        integrated_lufs=round(20 * math.log10(max(1e-6, float(np.sqrt(np.mean(y ** 2))))), 2),
        true_peak_db=round(20 * math.log10(max(1e-6, peak)), 2),
        analysis_confidence=round(confidence, 3),
    )
