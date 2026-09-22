/**
 * src/jev/control-assertions.ts
 * The APRA / ASIC control assertion library.
 *
 * This is the artefact that carries the regulatory meaning. For every control in
 * the suite it defines:
 *
 *   <control>__evidence_supplied   Noul   is there anything specific to judge?
 *   <control>__element_<key>       Noul   one atomic condition, tested alone
 *   <control>__maturity            Score  how mature is it, on five levels?
 *
 * The control's own verdict is NOT asked of the model. It is combined in code
 * from the element probabilities, so the composition rule ("all elements must
 * hold" vs "the average holds") is a code change, not a new prompt. Asking for a
 * whole control as one question bundles several conjuncts into a single judgement
 * and returns an unhelpfully mid-range number; the first version of this library
 * did exactly that and 13 of 23 controls landed in the escalate band on a strong
 * evidence pack. Splitting the conjuncts fixed it and produces the more useful
 * output: which element is weak.
 *
 * Four rules are encoded here, each measured rather than assumed:
 *
 * 1. The authoritative expectation lives in the assertion, never in the evidence.
 *    Evidence must not be able to supply or amend the rule it is judged against;
 *    a fabricated policy clause in an evidence pack otherwise suppresses a
 *    genuine failure finding by turning it into an escalation.
 * 2. Criteria use contrastive wording, naming the failure mode. This measurably
 *    resists self-serving attestations, which were the strongest false-pass
 *    pressure observed.
 * 3. No assertion asks for arithmetic, counting, or date comparison. Direct
 *    arithmetic was the only judgement class to fail in testing; those belong in
 *    code, on values the model has selected.
 * 4. Assertion ids and order are frozen and versioned. Adding an option to an
 *    option set, or an element to a control, changes the probabilities of the
 *    others — so a library change is a new version that requires re-baselining.
 */

import {
  APRA_AI_LETTER_2026,
  APRA_CPS_234_CONTROLS,
  CPS_230_CONTROLS,
  ASIC_26_092MR_CONTROLS,
} from '../../cdk/lib/constants';
import { AssertionSpec, ControlElement, ControlSpec, Framework, Question } from './types';

/** Bump on any change to instruction text, criteria, levels, elements, or ids. */
export const ASSERTION_LIBRARY_VERSION = '2.0.0';

/**
 * Five maturity levels, used for every control. Levels describe concrete
 * situations and stand on their own, so a Score can be read without the others.
 */
export const MATURITY_LEVELS: string[] = [
  'No evidence that the control is operated at all',
  'Ad hoc: activity happens but is undocumented, inconsistent, or unrepeatable',
  'Developing: some documented artefacts exist and material gaps remain',
  'Defined: documented, consistently applied, and periodically reviewed',
  'Managed: measured, tested for effectiveness, and independently assured',
];

function el(key: string, requirement: string, absentWhen: string): ControlElement {
  return { key, requirement, absentWhen };
}

/**
 * Each control decomposed into atomic, independently testable elements.
 * Requirements are single conditions — no "and we also need to see..." chains.
 */
const ELEMENTS: Record<string, ControlElement[]> = {
  CPS234_1: [
    el('approved', 'an information security policy framework is approved by the board or a delegated committee',
      'only a draft, or a document with no approval record'),
    el('owned', 'the framework names an accountable owner',
      'ownership is unassigned or only implied'),
    el('reviewed', 'the framework is reviewed on a defined review cycle',
      'no review cycle is defined, or the only evidence of review predates the assessment window'),
    el('communicated', 'the framework is communicated to the staff it applies to',
      'publication is claimed but no distribution is evidenced'),
  ],
  CPS234_2: [
    el('scheme', 'information assets are classified under a documented classification scheme',
      'classification is asserted without a scheme or applied consistently'),
    el('ai_covered', 'AI models, training data and prompts are included in the classification scheme',
      'the scheme covers conventional data only, or AI assets are unclassified'),
    el('handling', 'handling requirements follow the assigned classification in practice',
      'classification exists on paper but handling is uniform regardless of class'),
  ],
  CPS234_3: [
    el('cyclical', 'information security risks are assessed on a defined cycle',
      'no assessment cycle is defined, or the last assessment is outside the window'),
    el('ai_specific', 'AI-specific risks are included in the assessment',
      'the assessment covers conventional security risk only'),
    el('drives_treatment', 'assessment results drive documented treatment decisions',
      'risks are recorded but no treatment decision or owner is recorded'),
  ],
  CPS234_4: [
    el('proportionate', 'controls are implemented in proportion to the assessed risk',
      'the same control set is applied regardless of risk rating'),
    el('evidenced', 'control implementation is evidenced by configuration or operation records rather than assertion alone',
      'implementation is only stated in policy or asserted in a submission'),
    el('exceptions', 'control exceptions are documented and approved',
      'exceptions exist without approval or are not documented'),
  ],
  CPS234_5: [
    el('detected', 'incidents are detected and recorded through a defined process',
      'incidents are handled informally with no retained record'),
    el('escalated', 'incidents are escalated to a responsible function within the defined timeframe',
      'escalation is ad hoc or the timeframe is exceeded without explanation'),
    el('resolved', 'incidents are resolved with a retained record of root cause and remediation',
      'closing the incident is recorded but the cause and remedy are not'),
  ],
  CPS234_6: [
    el('cyclical', 'control effectiveness testing is performed on a defined cycle',
      'testing is ad hoc or has not occurred in the period'),
    el('coverage', 'testing covers the controls in scope for the period',
      'only a subset of in-scope controls is tested'),
    el('feedback', 'testing results feed back into the control environment, with remediation tracked',
      'results are produced but no remediation is tracked'),
  ],
  CPS234_7: [
    el('independent', 'internal audit independently reviews the control environment',
      'the review is performed by the function being reviewed'),
    el('tracked', 'audit findings are tracked to closure',
      'findings are raised but remain open without a tracked plan'),
    el('retained', 'audit workpapers are retained',
      'findings are reported but supporting workpapers are not retained'),
  ],
  CPS234_8: [
    el('assessed', 'incidents are assessed against the materiality and notification threshold',
      'incidents are notified or not notified without a recorded assessment'),
    el('recorded', 'the notification decision itself is recorded with its rationale',
      'the decision exists only in memory or correspondence'),
    el('notified', 'where notification is required, APRA is notified through the defined pathway',
      'the pathway is documented but never exercised or tested'),
  ],
  CPS234_9: [
    el('identified', 'information security risks arising from third parties are identified and assessed',
      'third-party risk is acknowledged but not assessed'),
    el('ai_providers', 'AI model and infrastructure providers are included in third-party risk assessment',
      'AI providers are excluded from the third-party risk process'),
    el('monitored', 'third-party information security risk is monitored on an ongoing basis',
      'assessment is one-off at onboarding with no ongoing monitoring'),
  ],
  CPS230_1: [
    el('framework', 'an operational risk management framework covers critical operations',
      'the framework exists but excludes the operations that depend on AI'),
    el('identified', 'AI-dependent operations are identified as critical operations',
      'AI dependency is not reflected in the critical operations register'),
    el('monitored', 'operational risk indicators for those operations are monitored',
      'indicators are defined but not reported on a cycle'),
  ],
  CPS230_2: [
    el('documented', 'business continuity arrangements for critical operations are documented',
      'arrangements are informal or cover only conventional infrastructure'),
    el('tested', 'continuity arrangements are tested',
      'plans exist but have never been tested'),
    el('outcomes', 'test outcomes are recorded and remediation is tracked',
      'tests occur with no recorded outcome or follow-up'),
  ],
  CPS230_3: [
    el('registered', 'service provider arrangements are registered',
      'providers are known to the business but not on a register'),
    el('assessed', 'material service providers are risk assessed',
      'assessment is limited to procurement due diligence'),
    el('disruption', 'service provider disruption is monitored and managed',
      'disruption is handled reactively with no monitoring'),
  ],
  ASIC_1: [
    el('owner_named', 'each AI system has a named accountable owner',
      'accountability is assigned to a team rather than a person, or not at all'),
    el('duties_defined', 'the responsibilities of the accountable owner are defined',
      'accountability is asserted without defined duties'),
    el('evidenced', 'accountability is evidenced in assignment records rather than only stated in policy',
      'the only support is a policy statement that owners exist'),
  ],
  ASIC_2: [
    el('reviewer', 'AI-supported decisions can be explained to a reviewer',
      'the model cannot produce a reviewer-usable explanation'),
    el('operated', 'explanation capability is evidenced in operation for live decisions',
      'explainability was demonstrated once at build time'),
    el('consumer', 'an explanation is available to an affected person on request',
      'no consumer-facing explanation process exists'),
  ],
  ASIC_3: [
    el('cyclical', 'AI systems are tested for unfair bias on a defined cycle',
      'bias testing was done at delivery only'),
    el('recorded', 'bias test results are recorded with the metrics used',
      'testing is claimed without retained metrics'),
    el('acted', 'results outside tolerance trigger documented action',
      'out-of-tolerance results are observed but not acted on'),
  ],
  ASIC_4: [
    el('assessed', 'data used to train or operate AI is assessed as fit for purpose',
      'data quality is assumed rather than assessed'),
    el('monitored', 'data quality is monitored on an ongoing basis',
      'assessment is one-off at onboarding'),
    el('excluded', 'datasets failing quality gates are excluded from use or remediated',
      'failing datasets are used with no recorded decision'),
  ],
  ASIC_5: [
    el('prevent', 'controls exist to prevent AI systems causing consumer harm',
      'harm prevention relies on manual vigilance with no implemented control'),
    el('detect', 'harm events are detected and recorded',
      'harm is handled through complaints only, with no detection of its own'),
    el('remediate', 'harm is remediated with a retained record of what was done',
      'remediation occurs without a retained record'),
  ],
  AI_1: [
    el('approved', 'models are approved through a defined process before production use',
      'models proceed to production without approval'),
    el('validated', 'models are independently validated in proportion to risk',
      'validation is performed by the model builder only, or not at all'),
    el('monitored', 'models are monitored in production for drift and performance',
      'monitoring is configured but not reviewed, or absent'),
    el('retired', 'model retirement is planned and recorded',
      'models are decommissioned without a recorded plan'),
  ],
  AI_2: [
    el('defined', 'data governance for AI training and input data is defined',
      'data governance covers conventional data only'),
    el('provenance', 'data provenance and lineage are recorded',
      'provenance is reconstructable only by asking the team'),
    el('protected', 'sensitive data used by AI is classified and protected',
      'sensitive data is used by AI without classification'),
  ],
  AI_3: [
    el('diligence', 'third-party AI models and services are subject to due diligence before use',
      'providers are adopted on the strength of their own documentation'),
    el('pinned', 'third-party model versions are pinned and changes are controlled',
      'models update silently at the provider’s discretion'),
    el('oversight', 'ongoing oversight of third-party AI is performed',
      'oversight ends at onboarding'),
  ],
  AI_4: [
    el('detection', 'AI-specific threats are covered by detection controls',
      'only conventional infrastructure threats are detected'),
    el('adversarial', 'adversarial input such as prompt injection is defended against at the AI boundary',
      'input is passed to the model uninspected'),
    el('vuln_mgmt', 'AI inference infrastructure is included in vulnerability management',
      'AI infrastructure is excluded from scanning'),
  ],
  AI_5: [
    el('designed', 'a human oversight step is designed into the AI decisions that require it',
      'oversight is stated as a principle with no design in the decision path'),
    el('operated', 'the oversight step is actually operated, with reviews occurring',
      'the gate exists but reviews are auto-approved'),
    el('overrides', 'overrides and their rationale are recorded',
      'overrides occur without a record'),
  ],
  AI_6: [
    el('monitored', 'AI risk is monitored continuously',
      'monitoring is periodic or manual'),
    el('reported', 'AI risk is reported to the board on a defined cycle',
      'reporting is ad hoc or absent'),
    el('evidenced', 'the reporting is evidenced by delivered artefacts rather than a stated intention',
      'only a commitment to report exists'),
  ],
};

/** Fuller, assertion-grade expectations keyed by control id. */
const EXPECTATIONS: Record<string, string> = {
  CPS234_1:
    'an approved information security policy framework exists, is owned, communicated, and reviewed on a defined cycle',
  CPS234_2:
    'information assets — including AI models, training data and prompts — are classified, and handling requirements follow the classification',
  CPS234_3:
    'information security risks, including AI-specific risks, are assessed regularly and the assessment drives treatment decisions',
  CPS234_4:
    'controls are implemented in proportion to risk, and the implementation is evidenced rather than asserted',
  CPS234_5:
    'security incidents are detected, recorded, escalated and resolved through a defined process with a retained record',
  CPS234_6:
    'the effectiveness of controls is tested on a regular cycle and the results feed back into the control environment',
  CPS234_7:
    'internal audit independently reviews the control environment, and findings are tracked to closure',
  CPS234_8:
    'material incidents are assessed against the notification threshold and APRA is notified where required',
  CPS234_9:
    'information security risks arising from third parties, including AI providers, are managed and monitored',
  CPS230_1:
    'an operational risk management framework covers critical operations, including AI-dependent operations',
  CPS230_2: 'business continuity arrangements for critical operations are documented and tested',
  CPS230_3: 'service provider arrangements are registered, risk assessed, and monitored for disruption',
  ASIC_1: 'accountability for each AI system is assigned to a named owner with defined responsibilities',
  ASIC_2: 'AI-supported decisions can be explained to the affected person and to a reviewer',
  ASIC_3: 'AI systems are tested for unfair bias on a defined cycle, and results are acted on',
  ASIC_4: 'data used to train or operate AI systems is assessed as fit for purpose',
  ASIC_5: 'controls exist to prevent AI systems causing consumer harm, and harm is remediated when it occurs',
  AI_1: 'a model risk management framework covers model approval, validation, monitoring and retirement',
  AI_2: 'data governance for AI training and input data is defined and operated',
  AI_3: 'third-party AI models and services are subject to due diligence and ongoing oversight',
  AI_4: 'AI-specific cyber security controls are implemented, including adversarial and injection defence',
  AI_5: 'meaningful human oversight of AI decisions is designed in and evidenced',
  AI_6: 'AI risk is monitored continuously and reported to the board on a defined cycle',
};

function frameworkFor(controlId: string): Framework {
  if (controlId.startsWith('CPS234')) return 'APRA CPS 234';
  if (controlId.startsWith('CPS230')) return 'APRA CPS 230';
  if (controlId.startsWith('ASIC')) return 'ASIC 26-092MR';
  return 'APRA AI Letter 2026';
}

/** Name and baseline description for a control id, from the CDK constants. */
function metaFor(controlId: string): { name: string; description: string } {
  const cps234 = (APRA_CPS_234_CONTROLS as Record<string, { name: string; description: string }>)[
    controlId
  ];
  if (cps234) return { name: cps234.name, description: cps234.description };

  const cps230 = (CPS_230_CONTROLS as Record<string, { name: string; description: string }>)[
    controlId
  ];
  if (cps230) return { name: cps230.name, description: cps230.description };

  const asic = (ASIC_26_092MR_CONTROLS as Record<string, { name: string; description: string }>)[
    controlId
  ];
  if (asic) return { name: asic.name, description: asic.description };

  const ai = (APRA_AI_LETTER_2026 as Record<string, { expectation: string }>)[controlId];
  if (ai) {
    return { name: `AI expectation ${controlId.replace('AI_', '')}`, description: ai.expectation };
  }

  return { name: controlId, description: controlId };
}

function evidencePath(controlId: string): string {
  return `evidence.byControl.${controlId}`;
}

/**
 * Presence judgement. Deliberately contrastive: the false case names the exact
 * failure modes seen in real evidence packs, so a pack that contains only
 * management assurances cannot read as evidence.
 */
function evidenceSuppliedAssertion(controlId: string, name: string): AssertionSpec {
  return {
    id: `${controlId}__evidence_supplied`,
    kind: 'evidence_supplied',
    question: {
      type: 'noul',
      instructions:
        `Does \`${evidencePath(controlId)}\` contain at least one specific, dated artefact ` +
        `that a reviewer could examine and that speaks directly to "${name}"?`,
      criteria: {
        true:
          'At least one specific, dated artefact within the assessment window that addresses this ' +
          'expectation directly — a configuration record, a completed assessment, a ticket with a ' +
          'resolution, or a signed document.',
        false:
          'Only a general statement that the control is handled, only a policy document with no ' +
          'evidence of operation, artefacts dated outside the assessment window, or nothing at all.',
      },
    },
  };
}

/** One atomic condition per element. The judgement is narrow on purpose. */
function elementAssertion(controlId: string, name: string, element: ControlElement): AssertionSpec {
  return {
    id: `${controlId}__element_${element.key}`,
    kind: 'element',
    elementKey: element.key,
    question: {
      type: 'noul',
      instructions:
        `Do the artefacts in \`${evidencePath(controlId)}\` demonstrate that ${element.requirement}, ` +
        `in the context of "${name}"?`,
      criteria: {
        true:
          'The artefacts demonstrate this specific requirement is met: they are current, they fall ' +
          'within the assessment window, and they show the activity actually occurred.',
        false: `The artefacts do not demonstrate this. Treat it as not met where ${element.absentWhen}.`,
      },
    },
  };
}

function maturityAssertion(controlId: string, name: string): AssertionSpec {
  return {
    id: `${controlId}__maturity`,
    kind: 'maturity',
    question: {
      type: 'score',
      instructions:
        `According to \`${evidencePath(controlId)}\`, how mature is the operation of ` +
        `"${name}"? Judge the evidence of operation, not the intent expressed in policy.`,
      criteria: MATURITY_LEVELS,
    },
  };
}

/**
 * Build the assertion library in canonical order.
 *
 * Order is fixed (framework, then control id as declared, then element as
 * declared) so requests are byte-reproducible and reports are diffable between
 * runs. Question order measurably does not move answers beyond the run-to-run
 * noise floor, but a frozen order makes review tractable.
 */
export function buildControlSpecs(): ControlSpec[] {
  const ids: string[] = [
    ...Object.keys(APRA_CPS_234_CONTROLS),
    ...Object.keys(CPS_230_CONTROLS),
    ...Object.keys(ASIC_26_092MR_CONTROLS),
    ...Object.keys(APRA_AI_LETTER_2026),
  ];

  return ids.map((controlId) => {
    const meta = metaFor(controlId);
    const expectation = EXPECTATIONS[controlId] ?? meta.description;
    const elements = ELEMENTS[controlId] ?? [];

    return {
      controlId,
      framework: frameworkFor(controlId),
      name: meta.name,
      expectation,
      elements,
      assertions: [
        evidenceSuppliedAssertion(controlId, meta.name),
        ...elements.map((element) => elementAssertion(controlId, meta.name, element)),
        maturityAssertion(controlId, meta.name),
      ],
    };
  });
}

/** Flatten the library into the wire question map, in canonical order. */
export function buildQuestionMap(specs: ControlSpec[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const spec of specs) {
    for (const assertion of spec.assertions) {
      questions[assertion.id] = assertion.question;
    }
  }
  return questions;
}

/** Assertion ids in canonical order — used by tests to detect silent drift. */
export function assertionIds(specs: ControlSpec[]): string[] {
  return specs.flatMap((spec) => spec.assertions.map((a) => a.id));
}

/** Element assertion id for a control and element key. */
export function elementAssertionId(controlId: string, elementKey: string): string {
  return `${controlId}__element_${elementKey}`;
}
