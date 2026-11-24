/* RH—MUSIC · transition policy.
   Чистые правила качества/безопасности перехода. Не управляют аудио:
   контроллер использует их перед тем, как принять план движка. */

export const MAX_RATE_DELTA = 0.02;

export function clampPlanRates(plan, limit = MAX_RATE_DELTA) {
  if (!plan || typeof plan !== 'object') return { plan, clamped: false };
  const safe = Math.max(0.02, Math.min(0.12, Number(limit) || MAX_RATE_DELTA));
  const clean = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1 - safe, Math.min(1 + safe, n));
  };
  const rateIn = clean(plan.rateIn);
  const rateOut = clean(plan.rateOut);
  const clamped = Math.abs(rateIn - Number(plan.rateIn || 1)) > 1e-6
    || Math.abs(rateOut - Number(plan.rateOut || 1)) > 1e-6;
  return { plan: { ...plan, rateIn, rateOut }, clamped };
}

/**
 * Оценка плана без прослушивания: только структурные признаки.
 * safe=false означает, что контроллеру стоит взять консервативный fade.
 */
export function assessPlan(plan, analysis = {}) {
  if (!plan || typeof plan !== 'object') {
    return { safe: false, score: 0, uncertainty: 'unknown', rateDelta: 0, reasons: ['План перехода отсутствует'] };
  }
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  const strategy = String(plan.strategy || '');
  const score = Number.isFinite(Number(plan.score)) ? Number(plan.score) : 0;
  const uncertainty = plan.window && plan.window.uncertainty ? String(plan.window.uncertainty) : 'unknown';
  const rateDelta = Math.max(
    Math.abs(Number(plan.rateIn || 1) - 1),
    Math.abs(Number(plan.rateOut || 1) - 1),
  );
  const bpmA = Number(analysis.bpmA ?? plan.bpmA);
  const bpmB = Number(analysis.bpmB ?? plan.bpmB);
  const bpmGap = Number.isFinite(bpmA) && Number.isFinite(bpmB) && bpmA > 0 && bpmB > 0
    ? Math.abs(Math.log2(bpmB / bpmA))
    : 0;
  const beatLike = /blend|beat|bass-swap|percussion|harmonic|loop-assisted|tempo-ramp|breakdown|build-up/.test(strategy);
  const noGrid = warnings.some((text) => /beatgrid|Beatgrid|beatmatch/i.test(String(text)));
  const reasons = [];
  if (uncertainty === 'high' && beatLike) reasons.push('высокая неопределённость структурного окна');
  if (noGrid && beatLike) reasons.push('нет надёжного beatgrid для beat-перехода');
  if (score > 0 && score < 0.3) reasons.push(`низкая оценка плана ${score.toFixed(2)}`);
  if (rateDelta > MAX_RATE_DELTA + 1e-6) reasons.push(`слишком большой tempo shift ${(rateDelta * 100).toFixed(1)}%`);
  if (beatLike && bpmGap > 0.028) reasons.push(`BPM gap ${(bpmGap * 100).toFixed(1)}% без pitch-lock`);
  return {
    safe: reasons.length === 0,
    score,
    uncertainty,
    rateDelta,
    bpmGap,
    beatLike,
    reasons,
    warnings: warnings.slice(0, 6),
  };
}

/** Консервативный план: overlap без рискованного beatmatch. */
export function safePlanOptions() {
  return { forceStrategy: 'ambient-fade', maxRateDelta: 0.02 };
}

export function describeAssessment(assessment) {
  if (!assessment) return '';
  if (assessment.safe) return `safe · ${assessment.uncertainty}`;
  return `fallback · ${assessment.reasons.join('; ')}`;
}
