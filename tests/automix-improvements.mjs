/**
 * RH—MUSIC · transition policy / lifecycle regression tests.
 * Не запускает аудио: проверяет чистые правила и wiring контроллера.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assessPlan, clampPlanRates, safePlanOptions, MAX_RATE_DELTA } from '../web/ai-automix/transition-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const controller = readFileSync(join(here, '../web/ai-automix/controller.js'), 'utf8');
const engine = readFileSync(join(here, '../web/ai-automix/automix-engine.js'), 'utf8');
let passed = 0;
const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };
console.log('RH—MUSIC · automix improvement tests\n');

/* policy */
const risky = assessPlan({
  strategy: 'beat-blend', score: 0.42,
  rateIn: 1.03, rateOut: 1,
  window: { uncertainty: 'high' },
  warnings: ['Нет надёжного beatgrid: beatmatching недоступен'],
}, { bpmA: 120, bpmB: 124 });
check('confidence: рискованный beat-план уходит в fallback', !risky.safe && risky.reasons.length >= 2);
const safe = assessPlan({ strategy: 'ambient-fade', score: 0.5, rateIn: 1.01, rateOut: 1, window: { uncertainty: 'low' }, warnings: [] });
check('confidence: безопасный fade остаётся', safe.safe && safe.uncertainty === 'low');
const low = assessPlan({ strategy: 'ambient-fade', score: 0.1, window: { uncertainty: 'unknown' }, warnings: [] });
check('confidence: очень низкая оценка — fallback', !low.safe);
const bpmGap = assessPlan({ strategy: 'bass-swap', score: 0.7, rateIn: 1, rateOut: 1, window: { uncertainty: 'medium' }, warnings: [] }, { bpmA: 120, bpmB: 128 });
check('confidence: BPM gap без pitch-lock — fallback', !bpmGap.safe && bpmGap.bpmGap > 0.028);
const loopWarning = assessPlan({ strategy: 'loop-assisted', score: 0.7, rateIn: 1, rateOut: 1, window: { uncertainty: 'medium' }, warnings: ['Loop-assisted требует надёжного beatgrid; при отсутствии будет безопасный fallback'] }, { bpmA: 124.5, bpmB: 124.6 });
check('confidence: предупреждение loop-assisted не считается отсутствием beatgrid', loopWarning.safe);
const highGrid = assessPlan({ strategy: 'beat-blend', score: 0.62, rateIn: 1.002, rateOut: 1, window: { uncertainty: 'high', evidence: ['beatgrid', 'section'] }, warnings: [] }, { bpmA: 124.5, bpmB: 124.6 });
check('confidence: height uncertainty с реальным beatgrid не уводит в fade', highGrid.safe && highGrid.gridUsed);

const clamped = clampPlanRates({ rateIn: 1.12, rateOut: 0.88 });
check('rate: ограничение 2% (нет pitch-lock)', Math.abs(clamped.plan.rateIn - 1.02) < 1e-9 && Math.abs(clamped.plan.rateOut - 0.98) < 1e-9 && clamped.clamped);
check('rate: MAX_RATE_DELTA = 0.02', MAX_RATE_DELTA === 0.02);
check('safe fallback strategy — ambient-fade', safePlanOptions().forceStrategy === 'ambient-fade');

/* engine/controller wiring */
check('engine не тянет питч выше 2%', /Math\.abs\(n - 1\) <= 0\.02/.test(engine));
check('controller загружает transition-policy', /transition-policy\.js/.test(controller) && /state\.policy/.test(controller));
check('controller оценивает план до принятия', /assessPlan\(plan,/.test(controller) && /confidenceFallback/.test(controller));
check('controller ограничивает rate политикой', /clampPlanRates/.test(controller));
check('есть отмена перехода', /function cancelTransition/.test(controller) && /cancelTransition\('seek'/.test(controller));
check('есть сброс деков', /function resetDecks/.test(controller) && /resetDeck\(deck\)/.test(controller));
check('pause не завершает переход по wall-clock', /waitForTransition/.test(controller) && /pausedMs/.test(controller));
check('seek во время микса отменяет переход', /state\.phase === 'MIXING'[\s\S]{0,160}cancelTransition\('seek'/.test(controller));
check('invalidate во время микса отменяет переход', /state\.phase === 'MIXING'[\s\S]{0,120}cancelTransition\('invalidate'/.test(controller));
check('ошибка перехода сбрасывает деки', /state\.transitionSeq \+= 1;\s*\n\s*resetDecks\(\)/.test(controller));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
