# Continuous control testing with typed judgements

**Module:** `src/jev/` · **Status:** working prototype, run against the live TypeSafe/Jev API
**Frameworks:** APRA CPS 234, APRA CPS 230, ASIC 26-092MR, APRA AI Letter (May 2026)
**Demo:** [`docs/demo/jev-control-testing.html`](demo/jev-control-testing.html)

---

## The wedge

The suite already collects the right evidence. `audit-evidence-collector` pulls CloudTrail,
Config and Security Hub into `EvidenceRecord`s and lands them in the evidence lake. What it does
not do is *judge* them. Today every CloudTrail event is stamped `controlId: 'CPS234-7'` — a
constant — and every Security Hub finding `'CPS234-5'`. Control attribution is a hardcoded label,
and nothing anywhere evaluates an artefact against the control it was collected for.

That last step is normally where an AI feature gets expensive. Asking a large language model to
reason through 23 controls and reach 23 conclusions is 23 sequential calls, tens of thousands of
tokens, seconds of latency, and prose that code then has to parse back into a verdict.

Jev changes the economics of that specific step. It evaluates a shared state against many typed
questions in one call, in parallel, and returns numbers. 117 assertions across 23 controls in this
module cost **$0.0012 and return in 305 ms** server-side. Control testing stops being a sampling
exercise.

## What actually happens

```
evidence pack (EvidenceRecord[])
        │
        ├─► state     { assessment: {...}, evidence: { byControl: { CPS234_1: [...], ... } } }
        │
        ├─► 117 typed assertions, one request, evaluated in parallel
        │     <control>__evidence_supplied   Noul   is there anything specific to judge?
        │     <control>__element_<key>       Noul   one atomic condition, tested alone
        │     <control>__maturity            Score  five levels, probability-weighted
        │
        └─► deterministic routing in code
              evidence < 0.50                    → INSUFFICIENT_EVIDENCE
              confidence < 0.45                  → ESCALATE
              combine(elements) ≥ 0.80           → PASS
              combine(elements) ≤ 0.20           → FAIL
              otherwise                          → ESCALATE
```

Three properties of the API do the work, and each was verified against the live service rather
than taken from the documentation:

1. **Questions in one request are independent.** They share the state, run in parallel, and never
   see each other's answers. Adding a control costs tokens, not latency — 117 assertions returned
   in 305 ms, and the earlier probe campaign found 500 assertions in 264 ms.
2. **Answers are constrained to the option set we supplied.** There is no prose to parse and no
   way for the model to answer outside the scale.
3. **Probing a question we might not need is nearly free.** So the library asks everything, and
   code decides what matters. That is the "speculative fan-out" pattern, and it is what makes an
   evidence-sufficiency question affordable for every control.

## Results, measured on this code

Four synthetic evidence packs against the same 23 controls and the same assertion library. One API
request each. Institution: a mid-tier ADI, synthetic, assessment window 2026-04-01 → 2026-09-20.

| Evidence pack | Records | PASS | FAIL | ESCALATE | No evidence | Mean maturity | Cost | Server |
|---|---|---|---|---|---|---|---|---|
| **Strong** — 24 kinds of documented artefact | 60 | 6 | 2 | 15 | 0 | 3.02 / 4 | $0.001233 | 305 ms |
| **Weak** — sparse, mostly stale policy | 9 | 0 | 1 | 0 | 22 | 0.31 / 4 | $0.000716 | 261 ms |
| **Absent** — nothing supplied | 0 | 0 | 0 | 0 | 23 | 0.00 / 4 | $0.000638 | 157 ms |
| **Self-serving** — weak + management attestations | 14 | 0 | 1 | 1 | 21 | 0.57 / 4 | $0.000764 | 174 ms |

### It separates "we have no evidence" from "the evidence shows a gap"

This is the capability the existing Likert-based lens survey cannot express. A self-assessor
picking one of five options has no way to say *"we supplied nothing"* — the scale forces a
position. The absent pack returns 23 of 23 controls at `INSUFFICIENT_EVIDENCE` with mean maturity
0.00, while the weak pack returns 22 of 23 at the same verdict but a materially different maturity
profile. Those are different conversations with the auditee, and they arrive already separated.

### It names the missing element, not just the failed control

Every non-passing control comes back with the specific element that dragged it down:

```
FAIL      CPS234_1  met=0.14  owned           @0.14  the framework names an accountable owner
FAIL      CPS234_3  met=0.20  drives_treatment@0.20  assessment results drive documented treatment decisions
ESCALATE  CPS234_8  met=0.26  notified        @0.26  where notification is required, APRA is notified through the defined pathway
ESCALATE  ASIC_2    met=0.30  consumer        @0.30  an explanation is available to an affected person on request
ESCALATE  ASIC_3    met=0.22  acted           @0.22  results outside tolerance trigger documented action
ESCALATE  AI_5      met=0.49  overrides       @0.49  overrides and their rationale are recorded
```

The strong pack's two genuine failures are instructive: it evidences a published, distributed,
reviewed information security policy, and it still cannot name the accountable owner. The control
is not met, and the report says why. That is the difference between a control score and a finding.

### Attestations cannot buy a pass

The self-serving pack is the weak pack plus fabricated attestations — a CRO confirming full
compliance, a chief audit executive confirming no weaknesses, an external auditor's assurance,
and a policy addendum asserting that the current approval arrangement is permitted.

They moved **maturity** substantially (CPS234_6: 0.00 → 2.24; CPS234_7: 0.00 → 2.81) because the
model correctly reads a signed attestation as a document. They moved `control_met` almost not at
all (worst case 0.02 → 0.09). **Zero controls passed.** The evidence gate held: 21 of 23 controls
still reported `INSUFFICIENT_EVIDENCE`, because a claim about evidence is not evidence.

CPS234_6 moved from `INSUFFICIENT_EVIDENCE` to `ESCALATE`, which is the honest behaviour: an
attestation is itself something for a person to look at, so it enters the review queue rather than
being believed or discarded. Contrastive criteria — the false case states *"only an assurance that
the expectation is met"* — are doing real work here and should be treated as a control, not as
prompt style.

## Policy is a code change, not a re-run

Verdicts depend on two things the code owns: the thresholds, and the rule that combines element
probabilities into a control verdict. Both can be changed against a saved report with no inference
call at all:

```
$ node dist/jev/src/jev/cli.js --replay reports/strong.json --pass-at 0.65
Verdicts moved: 3 of 23
  CPS234_9  0.72 → PASS      AI_1  0.72 → PASS      AI_3  0.76 → PASS
before pass 6/fail 2/escalate 15  →  after pass 9/fail 2/escalate 12
Additional cost: $0.000000 (probabilities reused)
```

The two genuine failures do not move, because they sit at 0.14 and 0.20. The knob that moved is
analyst workload, and it trades directly against risk appetite. `--combine mean` is the other
lever: `all` takes the minimum, so a control is only as strong as its weakest element, which is
the right default for conjunctive control language. Where elements are genuinely compensating,
`mean` can carry a control that `all` rejects — on identical evidence, with identical cost.

## Design rules this prototype encodes

Each of these came from measurement, and each is enforced by a test in
`tests/unit/jev-control-tester.test.ts` (42 tests, no network required).

1. **The regulatory expectation lives in the assertion, never in the evidence.** The authoritative
   text of each control and its elements is in `control-assertions.ts`. A test asserts that neither
   the expectation nor any element requirement appears anywhere in the state sent to the model.
   Without that separation, an evidence pack containing a plausible-looking rule can change the
   rule it is being judged against — which is how a fabricated policy clause suppressed a genuine
   failure finding in testing, turning a confident FAIL into an escalation.
2. **Decompose before you ask.** Asking "is this control met?" as one question bundles four
   conjuncts into one judgement and returns an unhelpful mid-range number. The first version of
   this library did that and 13 of 23 controls on the strong pack landed in the escalate band.
   Atomic elements fixed it, produced a more actionable report, and cost no extra round trip
   because questions in a request are evaluated in parallel. A test rejects any element
   requirement carrying a second finite clause.
3. **Arithmetic, counting and date comparison stay in code.** Every timestamp comparison in this
   module is a `Date.parse` in `windowCoverage()`. The model is never asked whether something is
   recent — direct arithmetic was the only judgement class that failed, once on a 4.5% margin.
4. **Version the option set and the assertion library.** Assertion ids, element keys, instruction
   text and level definitions are frozen and carry `ASSERTION_LIBRARY_VERSION`. Measurements on
   this service showed that adding a single option that is never selected moved the log-odds
   between two existing options by +0.75 and flipped the top answer in 4 of 10 trials. A library
   change is a new version and requires re-baselining.
5. **Confidence is a second axis, not a score.** A confident wrong answer is worse than an
   uncertain right one. Routing treats low confidence as a reason to escalate regardless of the
   probability direction.
6. **Evidence that cannot be attributed is surfaced, not dropped.** Records whose `controlId` is
   not in the library land in `evidence.unattributed` and are counted. Silently discarding
   evidence is how a control test lies.

## What this does not do

Worth being explicit, because the temptation to over-claim here is strong.

- **It cannot read what it cannot read.** Scans, screenshots, PDFs without a text layer, and
  non-English artefacts need conversion first. Text only.
- **It does not explain itself.** There is no rationale field. The report shows which assertion
  answered what and with what probability; the reasoning is not available. The finding text comes
  from element descriptions *we* wrote, not from the model.
- **It is a snap-judgement classifier, not a reasoner.** Anything needing multi-step derivation
  belongs in code. This is a feature for control testing — a control assertion *should* be a
  bounded question — but it rules out "review this evidence and tell me what you think".
- **`control_met` is an evidence-coverage judgement, not a control-existence judgement.** A control
  can be genuinely operating and still read low here because the pack did not evidence it. That is
  the intended reading and it needs to be said out loud to every auditee.
- **Thresholds and scores here are not yet calibrated against a label set.** The four packs are
  synthetic and were authored with known intended outcomes, which is enough to demonstrate
  discrimination and not enough to claim agreement with a human assessor. That requires 50–100
  hand-labelled packs.
- **The service is early access, single-region (US), with dynamic rate limits.** Server time is
  150–305 ms in these runs but wall-clock carries roughly 550 ms of RTT from Australia, which
  matters for anything inline and does not matter for a control test.

## Running it

```bash
npm install
npm run jev:build
export TYPESAFE_API_KEY=...            # never logged, never echoed

npm run jev:assertions                 # print the library: 23 controls, 71 elements
npm run jev:strong                     # full evidence pack
npm run jev:weak                       # sparse evidence
npm run jev:absent                     # no evidence supplied
npm run jev:self-serving               # attestations instead of artefacts

node dist/jev/src/jev/cli.js --pack strong --out reports/strong.json
node dist/jev/src/jev/cli.js --replay reports/strong.json --pass-at 0.65
node dist/jev/src/jev/cli.js --pack strong --combine mean
node dist/jev/src/jev/cli.js --pack weak --json | jq '.controls[] | select(.verdict=="FAIL")'

npx jest tests/unit/jev-control-tester.test.ts     # 42 tests, offline
```

`tsconfig.jev.json` builds this module and the control constants it imports. It is deliberately
separate from the repo-wide build, which currently fails on pre-existing type drift in the CDK
stacks.

## Where it plugs into the suite

`src/lambda/validate/audit-evidence-collector/index.ts` currently stamps a constant `controlId` per
source service. The natural wiring, in order:

1. **Attribute evidence properly.** Replace the hardcoded `controlId` with a Jev Choice question
   over the control library, asked per record batched into the same request. Control attribution
   becomes a judgement instead of a label.
2. **Add `jev-control-tester` as a Lambda** behind the existing EventBridge evidence events, writing
   the typed report to the evidence lake next to the evidence it judged, so every verdict is
   traceable to the exact artefacts and the library version that produced it.
3. **Feed `INSUFFICIENT_EVIDENCE` and `ESCALATE` into the existing escalation path** rather than
   inventing a new one. The `escalation-router` already exists.
4. **Gate on confidence, not just verdict**, when deciding what reaches a human.

## Cost model

| | |
|---|---|
| Published rate | $0.042 per 1M input tokens, output not billed |
| This library | 117 assertions, ~29k input tokens on the strong pack |
| Per full assessment | **$0.0012** |
| Per element | **$0.000017** |
| Four packs, all runs in this document | $0.0034 |
| Measured ceiling | ~450 structured or 2,000 compact assertions per request; 3,000 returns `400 max_tokens_exceeded` |

At $0.0012 per assessment, running all 23 controls every time an evidence event lands — rather
than quarterly — costs about a dollar per thousand assessments. That is the actual claim.
