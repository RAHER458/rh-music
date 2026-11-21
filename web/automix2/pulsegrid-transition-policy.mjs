const LIVE_TAKEOVER_TYPES = new Set(["bass_swap"]);
const MIN_LIVE_TAKEOVER_BEATS = 16;

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function transitionDurationProfile({ plannedSec, plannedBeats, remainingOutgoingSec }) {
  const safePlannedSec = Math.max(0.25, numberOr(plannedSec, 0.25));
  const safePlannedBeats = Math.max(0, numberOr(plannedBeats, 0));
  const safeRemainingSec = Math.max(0, numberOr(remainingOutgoingSec, safePlannedSec));
  const effectiveSec = Math.max(0.25, Math.min(safePlannedSec, safeRemainingSec));
  const shortened = effectiveSec + 0.05 < safePlannedSec;
  const effectiveBeats = safePlannedBeats > 0
    ? safePlannedBeats * effectiveSec / safePlannedSec
    : 0;
  return {
    plannedSec: safePlannedSec,
    plannedBeats: safePlannedBeats,
    remainingOutgoingSec: safeRemainingSec,
    effectiveSec,
    effectiveBeats,
    shortened,
  };
}

export function allowsLiveTakeoverListeningConfirmation({ type, audit, profile }) {
  if (!LIVE_TAKEOVER_TYPES.has(String(type || ""))) return false;
  if (String(audit?.status || "") !== "fail" || !profile?.shortened) return false;
  if (Number(profile.effectiveBeats) + 0.01 < MIN_LIVE_TAKEOVER_BEATS) return false;
  const errors = Array.isArray(audit?.errors) ? audit.errors.filter(Boolean) : [];
  if (!errors.length) return false;
  return errors.every((error) => (
    /transition has only .* real A audio for a .* transition/i.test(String(error))
    && /Rendering would pad silence/i.test(String(error))
  ));
}

export function normalizeLiveTakeoverAudit({ type, audit, profile }) {
  if (!allowsLiveTakeoverListeningConfirmation({ type, audit, profile })) return audit;
  const plannedBeats = formatBeatAmount(profile.plannedBeats);
  const effectiveBeats = formatBeatAmount(profile.effectiveBeats);
  return {
    ...audit,
    status: "review",
    score: Math.max(60, numberOr(audit?.score, 0)),
    errors: [],
    warnings: [
      ...(Array.isArray(audit?.warnings) ? audit.warnings : []),
      `Live takeover shortens the ${plannedBeats}-beat plan to ${effectiveBeats} beats while B continues; listen for phrase and energy continuity.`,
    ],
    recommended_action: `Play the complete ${effectiveBeats}-beat live preview, then confirm this exact Cue 8 / Cue 5 pair only if the takeover sounds continuous.`,
    live_takeover: {
      planned_beats: Number(profile.plannedBeats.toFixed(2)),
      effective_beats: Number(profile.effectiveBeats.toFixed(2)),
      planned_sec: Number(profile.plannedSec.toFixed(3)),
      effective_sec: Number(profile.effectiveSec.toFixed(3)),
    },
  };
}

export function formatBeatAmount(value) {
  const beats = Math.max(0, numberOr(value, 0));
  return Math.abs(beats - Math.round(beats)) < 0.05
    ? String(Math.round(beats))
    : beats.toFixed(1);
}

export { MIN_LIVE_TAKEOVER_BEATS };
