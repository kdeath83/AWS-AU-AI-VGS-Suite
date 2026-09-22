/**
 * src/jev/types.ts
 * Wire types for the TypeSafe / Jev System One API, and the VGS control-testing
 * domain types built on top of it.
 *
 * Design note: Jev returns typed judgements with no natural-language rationale.
 * Every field below is either a number the code can threshold, or a value the
 * code itself supplied. Nothing is recovered by parsing generated prose, and no
 * assertion may ask the model to do arithmetic or date comparison — those stay
 * in code, because that is where they are reliable.
 *
 * A control is not one question. Each control is decomposed into atomic
 * *elements* (one testable condition each), asked as separate Noul questions in
 * the same request, and recombined by a rule the code owns. Asking "is this
 * control met?" as a single question bundles several conjuncts into one
 * judgement and returns an unhelpfully mid-range probability; asking each
 * conjunct separately returns a probability per conjunct, names the weak one,
 * and lets the combination rule change without a new inference call.
 */

// ── TypeSafe wire types ─────────────────────────────────────────────────────

export type QuestionType = 'noul' | 'choice' | 'score';

/** Yes/no judgement. Returns the probability that the answer is yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

/** One option from a fixed, versioned set. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

/** Position along ordered levels. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Control-testing domain types ────────────────────────────────────────────

export type Framework =
  | 'APRA CPS 234'
  | 'APRA CPS 230'
  | 'ASIC 26-092MR'
  | 'APRA AI Letter 2026';

export type Verdict = 'PASS' | 'FAIL' | 'ESCALATE' | 'INSUFFICIENT_EVIDENCE';

export type AssertionKind = 'evidence_supplied' | 'maturity' | 'element';

/** One atomic, testable condition that the control expectation decomposes into. */
export interface ControlElement {
  /** Short key, unique within the control. Used to build the assertion id. */
  key: string;
  /** A single requirement, testable on its own against the evidence. */
  requirement: string;
  /** The failure mode this element is looking for, stated as the false case. */
  absentWhen: string;
}

export interface AssertionSpec {
  /**
   * Stable id. Ids are never reordered and never reused: the question set is
   * part of the assertion library's version identity.
   */
  id: string;
  kind: AssertionKind;
  /** For `element` assertions, the element key this assertion tests. */
  elementKey?: string;
  question: Question;
}

export interface ControlSpec {
  controlId: string;
  framework: Framework;
  name: string;
  /**
   * The authoritative expectation. This lives here, in the assertion library —
   * never in the evidence. Evidence must not be able to supply or amend the rule
   * it is being judged against.
   */
  expectation: string;
  elements: ControlElement[];
  assertions: AssertionSpec[];
}

/** A single evidence pack, shaped as the audit-evidence-collector emits it. */
export interface EvidencePack {
  packName: string;
  institution: {
    name: string;
    size: string;
    assessmentWindow: { from: string; to: string };
    frameworksInScope: string[];
  };
  records: Array<Record<string, unknown>>;
}

/** How element probabilities combine into a control verdict. Code owns this. */
export type CombineRule = 'all' | 'mean';

export interface RoutingThresholds {
  /** Below this evidence probability the control cannot be judged at all. */
  evidenceFloor: number;
  /** At or above this control-met probability, with evidence, the control passes. */
  passAt: number;
  /** At or below this control-met probability, the control fails. */
  failAt: number;
  /** Below this answer confidence, escalate regardless of the probability. */
  confidenceFloor: number;
}

export interface ElementAssessment {
  id: string;
  key: string;
  requirement: string;
  probability: number;
}

/**
 * Deterministic recency check, computed in code from record timestamps.
 *
 * The model is never asked to compare dates: direct arithmetic and date
 * comparison were the only judgement class that failed in testing. Code does the
 * date maths on the timestamps and reports it alongside the judgements, so a
 * reviewer can see whether a "met" reading rests on evidence from inside the
 * assessment window or on something stale.
 */
export interface WindowCoverage {
  inWindow: number;
  outsideWindow: number;
  undated: number;
}

export interface ControlAssessment {
  controlId: string;
  name: string;
  framework: Framework;
  verdict: Verdict;
  evidenceSupplied: number;
  /** Combined element probability under the active rule. */
  controlMet: number;
  combineRule: CombineRule;
  elements: ElementAssessment[];
  windowCoverage: WindowCoverage;
  /** The element dragging the control down, when there is one. */
  weakestElementId: string;
  weakestElementProbability: number;
  maturity: number;
  maturityLabel: string;
  confidence: number;
  routingReason: string;
  assertionIds: string[];
}

export interface AssessmentReport {
  packName: string;
  model: string;
  requestId: string;
  assertionLibraryVersion: string;
  generatedAt: string;
  assertionCount: number;
  combineRule: CombineRule;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  serverMs: number;
  wallMs: number;
  thresholds: RoutingThresholds;
  summary: {
    pass: number;
    fail: number;
    escalate: number;
    insufficientEvidence: number;
    meanMaturity: number;
    /** Total elements across the library, and how many read below the pass mark. */
    elementCount: number;
    elementsBelowPass: number;
  };
  controls: ControlAssessment[];
}
