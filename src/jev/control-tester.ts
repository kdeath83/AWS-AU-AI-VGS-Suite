/**
 * src/jev/control-tester.ts
 * Evaluate an evidence pack against the whole assertion library in one Jev call,
 * then decide pass / fail / escalate in ordinary code.
 *
 * The division of labour is the point: the model supplies bounded judgements, the
 * code owns every threshold, weight, combination rule and branch. Changing a
 * threshold or switching from "all elements must hold" to "the average must hold"
 * is a one-line code change that does not touch the assertion library and does not
 * require a new inference call.
 */

import {
  ASSERTION_LIBRARY_VERSION,
  buildControlSpecs,
  buildQuestionMap,
  elementAssertionId,
} from './control-assertions';
import { JEV_MODEL, costOf, evaluate } from './jev-client';
import {
  AssessmentReport,
  CombineRule,
  ControlAssessment,
  ControlSpec,
  ElementAssessment,
  EvidencePack,
  NoulAnswer,
  RoutingThresholds,
  ScoreAnswer,
  SystemOneResponse,
  Verdict,
  WindowCoverage,
} from './types';

export const DEFAULT_THRESHOLDS: RoutingThresholds = {
  evidenceFloor: 0.5,
  passAt: 0.8,
  failAt: 0.2,
  confidenceFloor: 0.45,
};

/**
 * Default combination rule.
 *
 * `all` takes the minimum: a control is only as strong as its weakest element.
 * That is the conservative reading and the right default for a control framework,
 * because a control with four elements and one unmet element is not met. Switch
 * to `mean` where elements are genuinely compensating rather than conjunctive —
 * but note that switching changes verdicts without changing the evidence, so the
 * rule belongs in the report.
 */
export const DEFAULT_COMBINE_RULE: CombineRule = 'all';

const CONTROL_ID = 'controlId';

/**
 * Shape the pack into the state the assertions refer to.
 *
 * Every control id gets a key, including controls with no records at all, so that
 * "we supplied nothing" is an answerable judgement rather than a missing path.
 * Records whose controlId is not in the library are surfaced under `unattributed`
 * rather than dropped — silently discarding evidence is how a control test lies.
 */
export function buildState(pack: EvidencePack, specs: ControlSpec[]): unknown {
  const byControl: Record<string, Array<Record<string, unknown>>> = {};
  for (const spec of specs) byControl[spec.controlId] = [];

  const unattributed: Array<Record<string, unknown>> = [];
  for (const record of pack.records) {
    const controlId = String(record[CONTROL_ID] ?? '');
    if (Object.prototype.hasOwnProperty.call(byControl, controlId)) {
      byControl[controlId].push(record);
    } else {
      unattributed.push(record);
    }
  }

  return {
    assessment: {
      institution: pack.institution.name,
      size: pack.institution.size,
      assessmentWindow: pack.institution.assessmentWindow,
      frameworksInScope: pack.institution.frameworksInScope,
      note:
        'Judgements are about the artefacts supplied in evidence.byControl. The regulatory ' +
        'expectation being tested is defined in the assessment criteria, not in this state.',
    },
    evidence: { byControl, unattributed },
  };
}

function pct(value: number): string {
  return value.toFixed(2);
}

/**
 * Count a control's records by whether they fall inside the assessment window.
 *
 * Dates are compared in code, on values the collector already recorded. The model
 * is never asked "is this recent?" because date arithmetic was the one judgement
 * class that measurably failed.
 */
export function windowCoverage(pack: EvidencePack, controlId: string): WindowCoverage {
  const from = Date.parse(`${pack.institution.assessmentWindow.from}T00:00:00Z`);
  const to = Date.parse(`${pack.institution.assessmentWindow.to}T23:59:59Z`);

  const coverage: WindowCoverage = { inWindow: 0, outsideWindow: 0, undated: 0 };
  for (const record of pack.records) {
    if (String(record[CONTROL_ID] ?? '') !== controlId) continue;
    const raw = record.timestamp;
    const ts = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(ts)) coverage.undated += 1;
    else if (ts >= from && ts <= to) coverage.inWindow += 1;
    else coverage.outsideWindow += 1;
  }
  return coverage;
}

/** Combine element probabilities. Pure, and deliberately trivial to change. */
export function combineElements(probabilities: number[], rule: CombineRule): number {
  if (probabilities.length === 0) return 0;
  if (rule === 'mean') {
    return probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length;
  }
  return Math.min(...probabilities);
}

/**
 * Deterministic routing. Pure function, no model involved, unit-tested against
 * the boundary cases in tests/unit/jev-control-tester.test.ts.
 */
export function route(
  evidenceSupplied: number,
  controlMet: number,
  confidence: number,
  thresholds: RoutingThresholds = DEFAULT_THRESHOLDS,
): { verdict: Verdict; reason: string } {
  if (evidenceSupplied < thresholds.evidenceFloor) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      reason: `evidence ${pct(evidenceSupplied)} below floor ${thresholds.evidenceFloor} — cannot judge`,
    };
  }
  if (confidence < thresholds.confidenceFloor) {
    return {
      verdict: 'ESCALATE',
      reason: `answer confidence ${pct(confidence)} below floor ${thresholds.confidenceFloor}`,
    };
  }
  if (controlMet >= thresholds.passAt) {
    return {
      verdict: 'PASS',
      reason: `all elements at or above combined ${pct(controlMet)} against pass threshold ${thresholds.passAt}`,
    };
  }
  if (controlMet <= thresholds.failAt) {
    return {
      verdict: 'FAIL',
      reason: `combined ${pct(controlMet)} at or below fail threshold ${thresholds.failAt}`,
    };
  }
  return {
    verdict: 'ESCALATE',
    reason: `combined ${pct(controlMet)} sits between fail (${thresholds.failAt}) and pass (${thresholds.passAt})`,
  };
}

function maturityLabel(score: number, legend: Record<string, string>): string {
  const index = Math.max(0, Math.min(4, Math.round(score)));
  return legend[String(index)] ?? `level ${index}`;
}

function asNoul(answer: unknown, id: string): NoulAnswer {
  const a = answer as NoulAnswer | undefined;
  if (!a || a.type !== 'noul' || typeof a.noul !== 'number') {
    throw new Error(`Expected a noul answer for assertion ${id}`);
  }
  return a;
}

function asScore(answer: unknown, id: string): ScoreAnswer {
  const a = answer as ScoreAnswer | undefined;
  if (!a || a.type !== 'score' || typeof a.score !== 'number') {
    throw new Error(`Expected a score answer for assertion ${id}`);
  }
  return a;
}

export interface BuildReportOptions {
  thresholds?: RoutingThresholds;
  combineRule?: CombineRule;
}

/** Assemble the report from the raw answers. Exported for offline testing. */
export function buildReport(
  pack: EvidencePack,
  specs: ControlSpec[],
  response: SystemOneResponse,
  meta: { serverMs: number; wallMs: number; requestId?: string },
  options: BuildReportOptions = {},
): AssessmentReport {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const combineRule = options.combineRule ?? DEFAULT_COMBINE_RULE;
  const answers = response.answers;

  let elementCount = 0;
  let elementsBelowPass = 0;

  const controls: ControlAssessment[] = specs.map((spec) => {
    const evidence = asNoul(answers[`${spec.controlId}__evidence_supplied`], spec.controlId);
    const maturity = asScore(answers[`${spec.controlId}__maturity`], spec.controlId);

    const elements: ElementAssessment[] = spec.elements.map((element) => {
      const id = elementAssertionId(spec.controlId, element.key);
      const answer = asNoul(answers[id], id);
      return { id, key: element.key, requirement: element.requirement, probability: answer.noul };
    });

    elementCount += elements.length;
    elementsBelowPass += elements.filter((e) => e.probability < thresholds.passAt).length;

    const controlMet = combineElements(
      elements.map((e) => e.probability),
      combineRule,
    );

    const weakest = elements.reduce<ElementAssessment | undefined>(
      (min, e) => (min === undefined || e.probability < min.probability ? e : min),
      undefined,
    );

    const routed = route(evidence.noul, controlMet, maturity.confidence, thresholds);
    const reason =
      weakest && routed.verdict !== 'PASS'
        ? `${routed.reason}; weakest element ${weakest.key} at ${pct(weakest.probability)}`
        : routed.reason;

    return {
      controlId: spec.controlId,
      name: spec.name,
      framework: spec.framework,
      verdict: routed.verdict,
      evidenceSupplied: evidence.noul,
      controlMet,
      combineRule,
      elements,
      windowCoverage: windowCoverage(pack, spec.controlId),
      weakestElementId: weakest?.id ?? '',
      weakestElementProbability: weakest?.probability ?? 0,
      maturity: maturity.score,
      maturityLabel: maturityLabel(maturity.score, maturity.legend),
      confidence: maturity.confidence,
      routingReason: reason,
      assertionIds: spec.assertions.map((a) => a.id),
    };
  });

  const count = (verdict: Verdict): number =>
    controls.filter((c) => c.verdict === verdict).length;
  const meanMaturity =
    controls.reduce((sum, c) => sum + c.maturity, 0) / (controls.length || 1);

  return {
    packName: pack.packName,
    model: response.model ?? JEV_MODEL,
    requestId: meta.requestId ?? '',
    assertionLibraryVersion: ASSERTION_LIBRARY_VERSION,
    generatedAt: new Date().toISOString(),
    assertionCount: specs.reduce((sum, s) => sum + s.assertions.length, 0),
    combineRule,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    costUsd: costOf(response.usage.input_tokens),
    serverMs: meta.serverMs,
    wallMs: meta.wallMs,
    thresholds,
    summary: {
      pass: count('PASS'),
      fail: count('FAIL'),
      escalate: count('ESCALATE'),
      insufficientEvidence: count('INSUFFICIENT_EVIDENCE'),
      meanMaturity: Number(meanMaturity.toFixed(3)),
      elementCount,
      elementsBelowPass,
    },
    controls,
  };
}

export interface AssessOptions extends BuildReportOptions {
  specs?: ControlSpec[];
}

/**
 * Run one continuous control test: pack in, typed verdicts out.
 *
 * Exactly one request is sent. Every control and element is evaluated in parallel
 * against the same state, so adding a control does not add a round trip.
 */
export async function assess(
  pack: EvidencePack,
  options: AssessOptions = {},
): Promise<AssessmentReport> {
  const specs = options.specs ?? buildControlSpecs();
  const state = buildState(pack, specs);
  const questions = buildQuestionMap(specs);

  const result = await evaluate(state, questions);

  return buildReport(
    pack,
    specs,
    result.response,
    { serverMs: result.serverMs, wallMs: result.wallMs, requestId: result.requestId },
    options,
  );
}

/**
 * Re-route a saved report under different thresholds or a different combination
 * rule. No inference call: the probabilities are already paid for, so policy
 * changes are free and instant. This is the practical payoff of getting typed
 * probabilities back instead of prose.
 */
export function replay(
  report: AssessmentReport,
  options: BuildReportOptions = {},
): AssessmentReport {
  const thresholds = options.thresholds ?? report.thresholds;
  const combineRule = options.combineRule ?? report.combineRule;

  const controls: ControlAssessment[] = report.controls.map((control) => {
    const controlMet = combineElements(
      control.elements.map((e) => e.probability),
      combineRule,
    );
    const routed = route(control.evidenceSupplied, controlMet, control.confidence, thresholds);
    const weakest = control.elements.reduce<ElementAssessment | undefined>(
      (min, e) => (min === undefined || e.probability < min.probability ? e : min),
      undefined,
    );
    return {
      ...control,
      controlMet,
      combineRule,
      verdict: routed.verdict,
      routingReason:
        weakest && routed.verdict !== 'PASS'
          ? `${routed.reason}; weakest element ${weakest.key} at ${weakest.probability.toFixed(2)}`
          : routed.reason,
    };
  });

  const count = (verdict: Verdict): number => controls.filter((c) => c.verdict === verdict).length;

  return {
    ...report,
    thresholds,
    combineRule,
    controls,
    summary: {
      ...report.summary,
      pass: count('PASS'),
      fail: count('FAIL'),
      escalate: count('ESCALATE'),
      insufficientEvidence: count('INSUFFICIENT_EVIDENCE'),
      elementsBelowPass: controls
        .flatMap((c) => c.elements)
        .filter((e) => e.probability < thresholds.passAt).length,
    },
  };
}
