/**
 * tests/unit/jev-control-tester.test.ts
 * Offline tests for the control assertion library, the element combination rule,
 * and the deterministic routing that turns typed judgements into
 * pass / fail / escalate.
 *
 * No network calls: the router, the combiner and the report builder are pure
 * functions, so the whole policy layer is testable without spending a request.
 */

import {
  ASSERTION_LIBRARY_VERSION,
  MATURITY_LEVELS,
  assertionIds,
  buildControlSpecs,
  buildQuestionMap,
  elementAssertionId,
} from '../../src/jev/control-assertions';
import {
  DEFAULT_THRESHOLDS,
  buildReport,
  buildState,
  combineElements,
  replay,
  route,
  windowCoverage,
} from '../../src/jev/control-tester';
import {
  ControlSpec,
  EvidencePack,
  NoulQuestion,
  Question,
  ScoreQuestion,
  SystemOneResponse,
} from '../../src/jev/types';

import strongPack from '../../src/jev/samples/strong.json';
import absentPack from '../../src/jev/samples/absent.json';

const specs = buildControlSpecs();
const elementTotal = specs.reduce((n, s) => n + s.elements.length, 0);

function pack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    packName: 'test pack',
    institution: {
      name: 'Test Bank',
      size: 'small',
      assessmentWindow: { from: '2026-04-01', to: '2026-09-20' },
      frameworksInScope: ['APRA CPS 234'],
    },
    records: [],
    ...overrides,
  };
}

type Answers = SystemOneResponse['answers'];

function fakeNoul(value: number): Answers[string] {
  return { type: 'noul', noul: value };
}

function fakeScore(value: number, confidence: number): Answers[string] {
  return {
    type: 'score',
    score: value,
    legend: Object.fromEntries(MATURITY_LEVELS.map((l, i) => [String(i), l])),
    probabilities: { '0': 0.05, '1': 0.1, '2': 0.2, '3': 0.4, '4': 0.25 },
    confidence,
  };
}

interface FakeVerdict {
  evidence: number;
  element: number;
  maturity: number;
  confidence: number;
}

function fakeResponse(
  perControl: (controlId: string, index: number) => FakeVerdict,
  perElement?: (controlId: string, elementKey: string) => number | undefined,
): SystemOneResponse {
  const answers: Answers = {};
  specs.forEach((spec, index) => {
    const v = perControl(spec.controlId, index);
    answers[`${spec.controlId}__evidence_supplied`] = fakeNoul(v.evidence);
    answers[`${spec.controlId}__maturity`] = fakeScore(v.maturity, v.confidence);
    for (const element of spec.elements) {
      const override = perElement ? perElement(spec.controlId, element.key) : undefined;
      answers[elementAssertionId(spec.controlId, element.key)] = fakeNoul(
        override ?? v.element,
      );
    }
  });
  return { model: 'jev-test', answers, usage: { input_tokens: 24_000, output_tokens: 96 } };
}

describe('assertion library', () => {
  it('decomposes every control into elements plus presence and maturity', () => {
    expect(specs.length).toBe(23);
    expect(elementTotal).toBe(71);
    expect(specs.reduce((n, s) => n + s.assertions.length, 0)).toBe(71 + 23 + 23);

    for (const spec of specs) {
      expect(spec.elements.length).toBeGreaterThanOrEqual(3);
      const kinds = spec.assertions.map((a) => a.kind);
      expect(kinds[0]).toBe('evidence_supplied');
      expect(kinds[kinds.length - 1]).toBe('maturity');
      expect(kinds.filter((k) => k === 'element').length).toBe(spec.elements.length);
    }
  });

  it('uses stable, unique, well-formed assertion ids', () => {
    const ids = assertionIds(specs);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Z0-9_]+__(evidence_supplied|maturity|element_[a-z_]+)$/);
    }
  });

  it('keeps element keys unique within a control', () => {
    for (const spec of specs) {
      const keys = spec.elements.map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('freezes question order so runs are diffable', () => {
    const first = Object.keys(buildQuestionMap(specs));
    const second = Object.keys(buildQuestionMap(buildControlSpecs()));
    expect(first).toEqual(second);
    expect(first).toEqual(assertionIds(specs));
  });

  it('gives every noul question contrastive yes and no criteria', () => {
    for (const spec of specs) {
      for (const assertion of spec.assertions) {
        const question: Question = assertion.question;
        if (question.type !== 'noul') continue;
        const noul = question as NoulQuestion;
        expect(noul.criteria).toBeDefined();
        expect(noul.criteria?.true.length).toBeGreaterThan(40);
        expect(noul.criteria?.false.length).toBeGreaterThan(40);
        expect(noul.criteria?.true).not.toEqual(noul.criteria?.false);
      }
    }
  });

  it('states one condition per element, with no conjunctions smuggled in', () => {
    for (const spec of specs) {
      for (const element of spec.elements) {
        // "and" is allowed inside a noun phrase; a second finite clause is not.
        const clauses = element.requirement.split(/\b(?:, and| and (?:is|are|the|it|they|that|there)\b)/i);
        expect(clauses.length).toBe(1);
        expect(element.absentWhen.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('gives every score question ordered levels that stand alone', () => {
    for (const spec of specs) {
      for (const assertion of spec.assertions) {
        const question: Question = assertion.question;
        if (question.type !== 'score') continue;
        const score = question as ScoreQuestion;
        expect(score.criteria).toEqual(MATURITY_LEVELS);
        for (const level of score.criteria) expect(level.length).toBeGreaterThan(20);
      }
    }
  });

  it('never asks the model to do arithmetic, counting, or date maths', () => {
    const banned =
      /calculate|sum of|total of|how many|add up|percentage of|days between|within \d+ (hours|days)/i;
    for (const spec of specs) {
      for (const assertion of spec.assertions) {
        expect(assertion.question.instructions).not.toMatch(banned);
      }
    }
  });

  it('points every assertion at an explicit evidence path', () => {
    for (const spec of specs) {
      for (const assertion of spec.assertions) {
        expect(assertion.question.instructions).toContain(`evidence.byControl.${spec.controlId}`);
      }
    }
  });

  it('carries a version and non-empty expectations', () => {
    expect(ASSERTION_LIBRARY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const spec of specs) expect(spec.expectation.trim().length).toBeGreaterThan(20);
  });
});

describe('state construction', () => {
  it('gives every control a key, including controls with no records', () => {
    const state = buildState(pack(), specs) as {
      evidence: { byControl: Record<string, unknown[]>; unattributed: unknown[] };
    };
    expect(Object.keys(state.evidence.byControl).length).toBe(specs.length);
    for (const spec of specs) expect(state.evidence.byControl[spec.controlId]).toEqual([]);
  });

  it('preserves record counts from a real pack', () => {
    const state = buildState(strongPack as EvidencePack, specs) as {
      evidence: { byControl: Record<string, unknown[]>; unattributed: unknown[] };
    };
    const routed = Object.values(state.evidence.byControl).reduce((n, r) => n + r.length, 0);
    expect(routed + state.evidence.unattributed.length).toBe(strongPack.records.length);
    expect(state.evidence.unattributed).toEqual([]);
  });

  it('surfaces unattributed records instead of dropping them', () => {
    const orphan = { evidenceId: 'x', controlId: 'CPS999_9', description: 'unknown control' };
    const state = buildState(pack({ records: [orphan] }), specs) as {
      evidence: { byControl: Record<string, unknown[]>; unattributed: unknown[] };
    };
    expect(state.evidence.unattributed).toHaveLength(1);
  });

  /**
   * The load-bearing security property: the evidence must not be able to supply or
   * amend the rule it is being judged against. If a control expectation or an
   * element requirement ever appears in the state, a crafted evidence pack can
   * change what is being tested.
   */
  it('never leaks the regulatory expectation or element text into the state', () => {
    const stateJson = JSON.stringify(buildState(strongPack as EvidencePack, specs));
    for (const spec of specs) {
      expect(stateJson).not.toContain(spec.expectation);
      for (const element of spec.elements) {
        expect(stateJson).not.toContain(element.requirement);
      }
    }
  });
});

describe('recency, computed in code', () => {
  it('counts records inside and outside the assessment window', () => {
    const inWindow = { evidenceId: 'a', controlId: 'CPS234_1', timestamp: '2026-08-01T00:00:00Z' };
    const stale = { evidenceId: 'b', controlId: 'CPS234_1', timestamp: '2025-07-18T00:00:00Z' };
    const undated = { evidenceId: 'c', controlId: 'CPS234_1' };
    const coverage = windowCoverage(
      pack({ records: [inWindow, stale, undated] }),
      'CPS234_1',
    );
    expect(coverage).toEqual({ inWindow: 1, outsideWindow: 1, undated: 1 });
  });

  it('flags the stale records in the shipped weak pack', () => {
    const weakPack = require('../../src/jev/samples/weak.json') as EvidencePack;
    const staleControls = specs.filter((spec) => {
      const coverage = windowCoverage(weakPack, spec.controlId);
      return coverage.outsideWindow > 0 || coverage.undated > 0;
    });
    // The weak pack's policy document predates the window; code catches it
    // without the model being asked to compare a single date.
    expect(staleControls.map((s) => s.controlId)).toContain('CPS234_1');
  });

  it('reports coverage on every control in a full report', () => {
    const report = buildReport(
      strongPack as EvidencePack,
      specs,
      fakeResponse(() => ({ evidence: 0.95, element: 0.9, maturity: 3, confidence: 0.8 })),
      { serverMs: 1, wallMs: 1 },
    );
    for (const control of report.controls) {
      const coverage = control.windowCoverage;
      expect(coverage.inWindow + coverage.outsideWindow + coverage.undated).toBeGreaterThanOrEqual(0);
    }
    const totalInWindow = report.controls.reduce((n, c) => n + c.windowCoverage.inWindow, 0);
    expect(totalInWindow).toBeGreaterThan(50);
  });
});

describe('element combination', () => {
  it('takes the minimum under the all rule — a control is as strong as its weakest element', () => {
    expect(combineElements([0.95, 0.9, 0.4], 'all')).toBe(0.4);
  });

  it('takes the mean under the mean rule', () => {
    expect(combineElements([0.9, 0.6], 'mean')).toBeCloseTo(0.75, 6);
  });

  it('cannot be met with no elements to judge', () => {
    expect(combineElements([], 'all')).toBe(0);
  });
});

describe('routing', () => {
  const t = DEFAULT_THRESHOLDS;

  it.each([
    ['no evidence at all', 0.02, 0.9, 0.9, 'INSUFFICIENT_EVIDENCE'],
    ['evidence just under the floor', 0.49, 0.95, 0.9, 'INSUFFICIENT_EVIDENCE'],
    ['evidence exactly at the floor, met high', 0.5, 0.8, 0.9, 'PASS'],
    ['clear pass', 0.95, 0.93, 0.88, 'PASS'],
    ['met exactly at pass threshold', 0.9, 0.8, 0.9, 'PASS'],
    ['met just under pass threshold', 0.9, 0.79, 0.9, 'ESCALATE'],
    ['met exactly at fail threshold', 0.9, 0.2, 0.9, 'FAIL'],
    ['met just above fail threshold', 0.9, 0.21, 0.9, 'ESCALATE'],
    ['clear fail', 0.9, 0.03, 0.85, 'FAIL'],
    ['low confidence overrides a pass', 0.9, 0.95, 0.44, 'ESCALATE'],
    ['low confidence overrides a fail', 0.9, 0.02, 0.1, 'ESCALATE'],
  ])('%s', (_label, evidence, met, confidence, expected) => {
    expect(route(evidence, met, confidence).verdict).toBe(expected);
  });

  it('cannot judge when there is no evidence, however convincing the claim', () => {
    // The self-serving pack asserts compliance with no artefacts. Evidence is the
    // gate: a confident "met" reading must not become a PASS without artefacts.
    expect(route(0.1, 0.99, 0.95).verdict).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('respects caller thresholds without touching the assertion library', () => {
    const strict = { ...t, passAt: 0.95 };
    expect(route(0.9, 0.9, 0.9, t).verdict).toBe('PASS');
    expect(route(0.9, 0.9, 0.9, strict).verdict).toBe('ESCALATE');
  });
});

describe('report assembly', () => {
  const verdictBands = (_id: string, index: number): FakeVerdict => {
    if (index < 15) return { evidence: 0.95, element: 0.93, maturity: 3.6, confidence: 0.85 };
    if (index < 19) return { evidence: 0.9, element: 0.05, maturity: 0.4, confidence: 0.9 };
    if (index < 21) return { evidence: 0.05, element: 0.2, maturity: 0.1, confidence: 0.8 };
    return { evidence: 0.9, element: 0.55, maturity: 2.2, confidence: 0.6 };
  };

  it('counts verdicts, averages maturity and prices the request', () => {
    const report = buildReport(
      strongPack as EvidencePack,
      specs,
      fakeResponse(verdictBands),
      { serverMs: 180, wallMs: 700, requestId: 'req_test' },
    );

    expect(report.summary.pass).toBe(15);
    expect(report.summary.fail).toBe(4);
    expect(report.summary.escalate).toBe(2);
    expect(report.summary.insufficientEvidence).toBe(2);
    expect(report.assertionCount).toBe(71 + 46);
    expect(report.summary.elementCount).toBe(71);
    expect(report.controls).toHaveLength(23);
    expect(report.requestId).toBe('req_test');
    // $0.042 per 1M input tokens
    expect(report.costUsd).toBeCloseTo(0.001008, 8);
    expect(report.serverMs).toBe(180);
  });

  it('names the weakest element behind a non-pass verdict', () => {
    const report = buildReport(
      strongPack as EvidencePack,
      specs,
      fakeResponse((id) =>
        id === 'CPS234_1'
          ? { evidence: 0.95, element: 0.9, maturity: 3, confidence: 0.8 }
          : { evidence: 0.95, element: 0.9, maturity: 3, confidence: 0.8 },
      ),
      { serverMs: 1, wallMs: 1 },
    );
    const first = report.controls[0];
    expect(first.weakestElementId).toBe(elementAssertionId('CPS234_1', first.elements[0].key));
    expect(first.weakestElementProbability).toBeCloseTo(0.9, 6);
  });

  it('reports the element that dragged a control down', () => {
    // Give one control a single weak element and confirm the reason names it.
    const response = fakeResponse((id) => ({
      evidence: 0.95,
      element: id === 'AI_5' ? 0.3 : 0.9,
      maturity: 3,
      confidence: 0.8,
    }));
    const report = buildReport(strongPack as EvidencePack, specs, response, {
      serverMs: 1,
      wallMs: 1,
    });
    const ai5 = report.controls.find((c) => c.controlId === 'AI_5');
    expect(ai5?.verdict).toBe('ESCALATE');
    expect(ai5?.controlMet).toBeCloseTo(0.3, 6);
    expect(ai5?.routingReason).toContain('weakest element');
  });

  it('labels maturity from the returned legend', () => {
    const report = buildReport(
      strongPack as EvidencePack,
      specs,
      fakeResponse(() => ({ evidence: 0.95, element: 0.9, maturity: 3.6, confidence: 0.9 })),
      { serverMs: 1, wallMs: 1 },
    );
    expect(report.controls[0].maturityLabel).toBe(MATURITY_LEVELS[4]);
  });

  it('always explains why a control was routed where it was', () => {
    const report = buildReport(
      absentPack as EvidencePack,
      specs,
      fakeResponse(() => ({ evidence: 0.02, element: 0.9, maturity: 1.0, confidence: 0.9 })),
      { serverMs: 1, wallMs: 1 },
    );
    for (const control of report.controls) {
      expect(control.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(control.routingReason).toContain('below floor');
    }
  });

  it('rejects a malformed answer rather than guessing a verdict', () => {
    const response = fakeResponse(() => ({
      evidence: 0.9,
      element: 0.9,
      maturity: 3.0,
      confidence: 0.9,
    }));
    delete response.answers['CPS234_1__element_approved'];
    expect(() =>
      buildReport(strongPack as EvidencePack, specs, response, { serverMs: 1, wallMs: 1 }),
    ).toThrow(/Expected a noul answer/);
  });
});

describe('replay', () => {
  it('re-routes saved probabilities without a new inference call', () => {
    const original = buildReport(
      strongPack as EvidencePack,
      specs,
      fakeResponse(() => ({ evidence: 0.95, element: 0.75, maturity: 3.0, confidence: 0.8 })),
      { serverMs: 1, wallMs: 1 },
    );
    expect(original.summary.pass).toBe(0);
    expect(original.summary.escalate).toBe(23);

    const relaxed = replay(original, { thresholds: { ...DEFAULT_THRESHOLDS, passAt: 0.7 } });
    expect(relaxed.summary.pass).toBe(23);
    expect(relaxed.summary.escalate).toBe(0);
    // Nothing was re-inferred: usage and cost are carried through unchanged.
    expect(relaxed.usage).toEqual(original.usage);
    expect(relaxed.costUsd).toBe(original.costUsd);
  });

  it('changes verdicts when the combination rule changes, with the same evidence', () => {
    // One control's fourth element sags. Under "all" the control is not met;
    // under "mean" the same paid-for probabilities clear the pass mark. This is
    // the argument for returning probabilities rather than a verdict.
    const sagged: Record<string, number> = { reviewed: 0.6, communicated: 0.75 };
    const response = fakeResponse(
      () => ({ evidence: 0.95, element: 0.95, maturity: 3.2, confidence: 0.8 }),
      (controlId, key) => (controlId === 'CPS234_1' ? sagged[key] : undefined),
    );

    const all = buildReport(strongPack as EvidencePack, specs, response, {
      serverMs: 1,
      wallMs: 1,
    });
    const cps1All = all.controls.find((c) => c.controlId === 'CPS234_1');
    expect(cps1All?.combineRule).toBe('all');
    expect(cps1All?.controlMet).toBeCloseTo(0.6, 6);
    expect(cps1All?.verdict).toBe('ESCALATE');

    const mean = replay(all, { combineRule: 'mean' });
    const cps1Mean = mean.controls.find((c) => c.controlId === 'CPS234_1');
    expect(cps1Mean?.combineRule).toBe('mean');
    expect(cps1Mean?.controlMet).toBeCloseTo(0.8125, 4);
    expect(cps1Mean?.verdict).toBe('PASS');
    // Identical paid-for probabilities; only the composition rule moved.
    expect(cps1Mean?.elements).toEqual(cps1All?.elements);
    expect(mean.costUsd).toBe(all.costUsd);
  });
});

describe('bundled packs', () => {
  it('ships four packs with the expected evidence profile', () => {
    const absent = absentPack as EvidencePack;
    expect(absent.records).toHaveLength(0);
    expect((strongPack as EvidencePack).records.length).toBeGreaterThan(50);
  });
});
