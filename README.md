# AWS AU AI VGS Suite

> **Validate, Govern, Secure** — An AI Risk and Security Platform for Australian Financial Services Institutions.

[![AWS CDK](https://img.shields.io/badge/AWS-CDK%20v2-blue)](https://docs.aws.amazon.com/cdk/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT--0-green)](LICENSE)

---

## Overview

The **AWS AU AI VGS Suite** is a production-ready proof-of-concept that provides a comprehensive, one-click-deployable AI risk and security platform tailored for Australian Financial Services Institutions (AFSI) operating under **APRA CPS 234**, **APRA CPS 230**, and **ASIC 26-092MR** regulatory expectations.

**🖥 [Live Demo: Multi-Model Weighted Router](https://kdeath83.github.io/AWS-AU-AI-VGS-Suite/demo/multi-model-router.html)** — Drag any Bedrock model into any priority tier. Adjust weights live. Run 10K simulations. Watch the distribution converge.

📄 **[Multi-Model Consistency Guide](docs/multi-model-consistency-banking.md)** — How to use Opus 4.8 + GPT-5.5 for critical banking operations without fine-tuning.

🖥 **[Live Demo: Continuous Control Testing](https://kdeath83.github.io/AWS-AU-AI-VGS-Suite/demo/jev-control-testing.html)** — All 23 CPS 234 / CPS 230 / ASIC / APRA AI controls judged against four evidence packs in one API call. Move the pass mark and watch verdicts change at zero additional cost.

📄 **[Continuous Control Testing with Jev](docs/jev-control-testing.md)** — How typed judgements turn control testing from a quarterly sample into an every-event check, at about $0.0012 per assessment.

### Continuous control testing (`src/jev/`)

Most controls are bounded judgement questions — *is the evidence sufficient, was the approval
appropriate, does this activity comply*. The suite already collects the evidence; this module
judges it. 23 controls are decomposed into **71 atomic elements** plus an evidence-sufficiency and
a maturity judgement per control, sent as **117 typed assertions in a single request**. Jev
evaluates them in parallel and returns probabilities; deterministic code routes each control to
PASS, FAIL, ESCALATE or INSUFFICIENT_EVIDENCE and names the element that dragged it down.

| Evidence pack | PASS | FAIL | ESCALATE | No evidence | Cost | Server |
|---|---|---|---|---|---|---|
| Strong (60 artefacts) | 6 | 2 | 15 | 0 | $0.001233 | 305 ms |
| Weak (9 records, mostly stale) | 0 | 1 | 0 | 22 | $0.000716 | 261 ms |
| Absent (nothing supplied) | 0 | 0 | 0 | 23 | $0.000638 | 157 ms |
| Self-serving (attestations, no artefacts) | 0 | 0 | 1 | 21 | $0.000764 | 174 ms |

The absent pack separates cleanly from the weak pack, which a five-point Likert survey cannot
express. Management attestations moved maturity but produced **zero passes** — a claim about
evidence is not evidence.

```bash
npm run jev:build
export TYPESAFE_API_KEY=...
npm run jev:strong                          # or weak / absent / self-serving
npm run jev:assertions                      # print the library: 23 controls, 71 elements
node dist/jev/src/jev/cli.js --replay reports/strong.json --pass-at 0.65   # re-policy, $0
npx jest tests/unit/jev-control-tester.test.ts
```

The suite is organized into four CDK stacks that map to the three VGS modules plus a shared foundation:

| Stack | Module | Purpose |
|---|---|---|
| **VALIDATE** | Compliance | Model Monitor, Clarify, Audit Manager, Neptune, AgentCore, Registry |
| **GOVERN** | Governance | QuickSight, NL Summaries, Prompt Optimization, Escalation |
| **SECURE** | Security | Guardrails, WAF, GuardDuty, Inspector, Config, Secrets Manager |
| **Shared** | Foundation | VPC, S3 Evidence Lake, KMS, IAM, CloudTrail, EventBridge |
---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AWS AU AI VGS Suite                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │   SHARED    │  │   SECURE    │  │  VALIDATE   │  │   GOVERN    │      │
│  │  (Foundation)│  │  (Security) │  │ (Compliance)│  │ (Executive) │      │
│  ├─────────────┤  ├─────────────┤  ├─────────────┤  ├─────────────┤      │
│  │ • VPC       │  │ • Guardrails│  │ • Model Mon │  │ • QuickSight│      │
│  │ • S3 Lake   │  │ • WAFv2     │  │ • Clarify   │  │ • NL Gen    │      │
│  │ • KMS       │  │ • API GW    │  │ • Audit Mgr │  │ • Escalation│      │
│  │ • IAM Base  │  │ • GuardDuty │  │ • Neptune   │  │ • Prompt Opt│      │
│  │ • CloudTrail│  │ • Inspector │  │ • AgentCore │  │             │      │
│  │ • EventBus  │  │ • Patch Mgr │  │ • Registry  │  │             │      │
│  │             │  │ • Config    │  │ • Lambdas   │  │ • Lambdas   │      │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘      │
│         ▲                ▲                ▲                ▲              │
│         └────────────────┴────────────────┴────────────────┘              │
│                           EventBridge Custom Bus                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- **AWS CLI** v2+ with credentials configured
- **Node.js** 18+ and npm
- **AWS CDK** CLI (or use `npx cdk`)
- **Git**

### One-Click Deployment

[![Launch Stack](https://cdn.rawgit.com/build-cloudformation-resources/cloudformation-launch-stack-button-svg/main/launch-stack.svg)](https://console.aws.amazon.com/cloudformation/home?region=ap-southeast-2#/stacks/create/review?templateURL=https://raw.githubusercontent.com/kdeath83/AWS-AU-AI-VGS-Suite/main/cloudformation/bootstrap.yaml&stackName=aws-vgs-suite-bootstrap&param_Environment=dev)

Click the button above to launch a CloudFormation stack that creates a CodeBuild project. The project clones this repo and runs `cdk deploy --all` — full deployment in one click. Requires AdministratorAccess (the stack creates IAM roles for CDK).

Or deploy manually from the CLI:

```bash
# Clone the repository
git clone https://github.com/kdeath83/AWS-AU-AI-VGS-Suite.git
cd AWS-AU-AI-VGS-Suite

# Run setup checks
./scripts/setup.sh

# Install dependencies and deploy all stacks
npm install
npx cdk bootstrap
npx cdk deploy --all

# Create AgentCore Harnesses with model load balancing
./scripts/create-harnesses.sh --environment dev --region ap-southeast-2

# Or use the deploy script with options
./scripts/deploy.sh --environment prod --region ap-southeast-2
```

### Context Variables

| Variable | Default | Description |
|---|---|---|
| `environment` | `dev` | Deployment environment |
| `apraregion` | `ap-southeast-2` | Primary AWS region for APRA compliance |
| `enableCdkNag` | `true` | Enable CDK Nag security checks |

```bash
npx cdk deploy --all -c environment=prod -c apraregion=ap-southeast-2
```

---

## Regulatory Mapping

### APRA CPS 234 → AWS Services

| CPS 234 Control | AWS Service | Config Rule |
|---|---|---|
| **1 — Information Security Policy** | IAM, Audit Manager | `iam-password-policy` |
| **2 — Information Asset Classification** | S3, KMS, Macie | `s3-bucket-public-read-prohibited` |
| **3 — Risk Assessment** | GuardDuty, Inspector | `guardduty-enabled-centralized` |
| **4 — Control Implementation** | Config, Systems Manager | `ec2-managedinstance-patch-compliance-status-check` |
| **5 — Incident Management** | Security Hub, EventBridge | `security-hub-enabled` |
| **6 — Testing** | Audit Manager, CloudWatch | `config-enabled` |
| **7 — Internal Audit** | CloudTrail, S3 | `cloud-trail-cloud-watch-logs-enabled` |
| **8 — APRA Notification** | EventBridge, Lambda, SNS | — |
| **9 — Third Party Risk** | Neptune, Config, IAM | `iam-user-no-policies-check` |

### CPS 230 → Resilience & Continuity

| CPS 230 Control | AWS Service |
|---|---|
| **1 — Operational Risk** | Resilience Hub, Systems Manager |
| **2 — Business Continuity** | Resilience Hub, Backup, Route 53 |
| **3 — Service Provider Mgmt** | Neptune, Config, CloudTrail |

### ASIC 26-092MR → AI-Specific Controls

| ASIC Expectation | AWS Service |
|---|---|
| **Governance & Accountability** | IAM, Audit Manager, Config |
| **Transparency & Explainability** | SageMaker Clarify, Bedrock |
| **Fairness & Bias Testing** | SageMaker Clarify, Model Monitor |
| **Data Quality** | Glue DataBrew, Model Monitor |
| **Consumer Protection** | Bedrock Guardrails, WAF |

### APRA AI Letter (May 2026)

| Expectation | AWS Service |
|---|---|
| Model Risk Management | SageMaker Model Monitor, Clarify, Guardrails |
| Data Governance | Glue, Macie, KMS, S3 |
| Third Party AI | Neptune, Audit Manager, Config |
| AI-Specific Cyber Security | WAF, GuardDuty, Guardrails, Inspector |
| Human Oversight | Bedrock AgentCore, EventBridge, QuickSight |
| Monitoring & Reporting | CloudWatch, QuickSight, Bedrock, EventBridge |

---

## Directory Structure

```
AWS-AU-AI-VGS-Suite/
├── README.md
├── cdk.json                          # CDK context variables
├── package.json                      # Dependencies
├── tsconfig.json                     # TypeScript config
├── jest.config.js                    # Jest test config
├── .gitignore
├── cdk/
│   ├── bin/app.ts                    # CDK app entry
│   ├── lib/
│   │   ├── constants.ts              # APRA/ASIC control mappings
│   │   ├── shared-stack.ts           # VPC, S3, KMS, IAM, CloudTrail
│   │   ├── secure-stack.ts           # Guardrails, WAF, GuardDuty, Config
│   │   ├── validate-stack.ts         # Model Monitor, Clarify, Neptune, AgentCore
│   │   └── govern-stack.ts           # QuickSight, NL Summaries, Escalation
│   └── test/cdk.test.ts              # CDK snapshot tests
├── src/
│   ├── lambda/
│   │   ├── secure/                   # Prompt injection, GuardDuty, Patch
│   │   ├── validate/                 # Drift handler, Bias reports, Evidence, Registry, Orchestrator
│   │   └── govern/                   # Dashboard prep, NL summaries, Escalation, Prompt eval
│   ├── prompts/                      # Bedrock prompt optimization JSONL templates
│   │   ├── claims-triage/
│   │   └── fraud-detection/
│   ├── agents/                       # Bedrock AgentCore definitions
│   │   ├── security-sentinel/
│   │   └── governance-auditor/
│   └── shared/                       # Types, utils, config for all lambdas
│       ├── types.ts
│       ├── utils.ts
│       └── config.ts
├── tests/
│   ├── unit/                         # Lambda unit tests
│   └── integration/                  # Integration tests for deployed resources
└── scripts/
    ├── setup.sh                      # Prerequisite checks
    ├── deploy.sh                     # One-click deployment
    └── destroy.sh                    # Cleanup
```

---

## Security

### Security Requirements (Mandatory)

1. **No hardcoded credentials** — All secrets via Secrets Manager or SSM Parameter Store
2. **Least privilege IAM** — Every role scoped to minimum permissions with resource-level conditions
3. **Encryption at rest** — KMS for all data stores
4. **Encryption in transit** — TLS 1.3 for all APIs
5. **VPC isolation** — All compute in private subnets with VPC endpoints
6. **CloudTrail logging** — All API calls logged to S3 with KMS encryption
7. **Config rules** — Real-time compliance validation with APRA CPS 234 conformance pack
8. **No data egress** — All processing in customer account via VPC endpoints

### WAF Rules

The WAF WebACL includes:
- **Rate limiting**: 2000 requests per IP
- **OWASP Top 10**: AWS Managed Common Rule Set
- **Known Bad Inputs**: AWS Managed Known Bad Inputs Rule Set
- **Prompt Injection Detection**: Custom regex patterns for injection, jailbreak, and data exfiltration
- **Data Exfiltration Detection**: Patterns for API keys, bearer tokens, database dumps

### CDK Nag

All stacks include:
- `AwsSolutionsChecks` — AWS Well-Architected checks
- `NIST80053R5Checks` — NIST 800-53 Rev 5
- `HIPAASecurityChecks` — HIPAA security requirements
- Custom APRA CPS 234 rules (defined in conformance pack)

`cdk synth` completes with no findings. Every check either passes, is fixed in the stacks, or is
accepted with a written reason in [`cdk/lib/nag-suppressions.ts`](cdk/lib/nag-suppressions.ts).
That file is a decision log rather than a mute list: it names what was remediated, so an accepted
finding can be told apart from an oversight. What is deferred, and why, is set out below.

---

## Deliberate Simplifications

This is a reference implementation, not a hardened landing zone. The departures below are known
and intentional. They are written down rather than left to be discovered on review — knowing what
was deferred, and being able to say why, is part of the point of the exercise.

| Simplification | Why it is accepted here | What a production deployment would do |
|---|---|---|
| **One shared execution role** for all thirteen functions across the four stacks (`baseRole`, created in `SharedStack`) | Keeps the IAM model small enough to read next to the control mapping. Thirteen per-function roles add noise that hides the architecture this repo exists to show. | A role per function, or per stack at minimum, with permissions assembled per workload. |
| **No authorizer on the API** — the single method is an unauthenticated health check | The API exists to demonstrate the WAF and prompt-injection path, not to serve tenants. | Cognito user pool or IAM authorizer on every method. |
| **No WAF logging destination** | WAF logging needs a log group named `aws-waf-logs-*` plus a resource policy; the ACL's activity is already on CloudWatch metrics. | Full request logging to a dedicated log group. |
| **No S3 server access logging** | The audit trail is the CloudTrail organisation trail. It covers management events, **not** individual object reads — closing that gap needs a dedicated log-target bucket. | Server access logging to a log-target bucket, or S3 data events on the trail. |
| **No cross-region replication** | Single-region by design. The evidence lake is versioned with a 7-year lifecycle, and CloudTrail validates its own log-file digests. | Replication to a second region with its own key and versioning. |
| **No per-function reserved concurrency** | Back-pressure comes from the queues — visibility timeouts, batch sizes, bounded receive counts. Reserving a fixed number per function throttles the pollers instead. | Reserved concurrency sized per workload, managed at the account level. |
| **No Lambda-level dead-letter destinations** | SQS-invoked functions fail into the source queue's DLQ, which is the correct destination for that invocation type. | The same, plus destinations on any asynchronous invocations. |
| **No secret rotation schedule** | The secret holds a third-party model credential; rotation needs a Lambda implementing that provider's own rotation API. | A rotation Lambda per provider, or a secret the suite controls. |
| **API stage caching disabled** | It bills per hour per cache size, for an endpoint that returns a health status. | Caching enabled and encrypted wherever responses are cacheable and expensive. |
| **No AWS Backup plan on the registry table** | The table has point-in-time recovery covering the last 35 days, and its contents are reproducible from the registry's own source events. | The table registered in an AWS Backup plan with a vault. |

Everything else the nag packs raise is **fixed in the stacks**: TLS enforcement on all queues and
buckets, bucket versioning, KMS-encrypted VPC flow logs, encrypted notification topics, a
dead-letter queue on the medium-risk queue, alarm actions wired to a real topic, current Lambda
runtimes, Neptune auto minor version upgrade, a customer managed key on the SageMaker endpoint
config, and public-IP auto-assignment off the NAT-only subnets.

---

## Performance

| Metric | Target | Implementation |
|---|---|---|
| Model drift detection | < 15 min | SQS + Lambda triggered by Model Monitor |
| Prompt injection blocking | < 100 ms | WAFv2 regex rules + Lambda detector |
| Agent response time | < 5 seconds | Bedrock AgentCore Runtime with circuit breaker |
| Dashboard refresh | Real-time / 5 min | EventBridge scheduled Lambda + SPICE |
| Evidence collection | Async, non-blocking | SQS decoupling with DLQs |

---

## Lambda Functions

| Function | Stack | Memory | Timeout | Trigger |
|---|---|---|---|---|
| `prompt-injection-detector` | secure | 256MB | 10s | API Gateway |
| `guardduty-finder-aggregator` | secure | 512MB | 60s | SQS (GuardDuty) |
| `patch-compliance-checker` | secure | 256MB | 60s | EventBridge (scheduled) |
| `model-drift-handler` | VALIDATE | 512MB | 120s | SQS (Model Monitor) |
| `bias-report-generator` | VALIDATE | 1024MB | 600s | SQS (Clarify) |
| `audit-evidence-collector` | VALIDATE | 1024MB | 300s | SQS + EventBridge (6h) |
| `registry-curator` | VALIDATE | 256MB | 60s | DynamoDB Stream |
| `agent-orchestrator` | VALIDATE | 512MB | 300s | SQS |
| `dashboard-data-prep` | GOVERN | 1024MB | 300s | EventBridge (5min) |
| `nl-summary-generator` | GOVERN | 512MB | 120s | SQS |
| `escalation-router` | GOVERN | 256MB | 60s | EventBridge |
| `prompt-evaluation` | GOVERN | 512MB | 120s | Bedrock Prompt Optimization |

---

## Testing

### Unit Tests

```bash
npm test
```

Tests cover:
- Shared utilities (`utils.ts`): retry logic, circuit breaker, validation, idempotency
- Lambda handlers: prompt injection detector, escalation router

### CDK Snapshot Tests

```bash
npx cdk synth
npm test -- cdk.test
```

Validates stack synthesis and resource creation for all four stacks.

### Integration Tests

Run after deployment:

```bash
AWS_REGION=ap-southeast-2 ENVIRONMENT=dev npm test -- integration.test
```

Validates:
- VPC, S3, KMS, EventBridge resources exist
- GuardDuty detector enabled
- WAF WebACL configured
- API Gateway deployed
- Lambda functions present
- Neptune cluster running
- DynamoDB table accessible
- SQS queues created
- CloudTrail logging active

---

## Agent Definitions

### Security Sentinel

- **Purpose**: Monitors AI endpoints, reads GuardDuty/Inspector findings
- **Deployment**: AgentCore Harness (config-based, not code)
- **Critical Model**: Claude Fable 5
- **Standard Model**: Claude Opus 4.8
- **Fallback Model**: GPT-5.5
- **Budget Model**: DeepSeek V4 Pro (via OpenCode Go)
- **Tools**: GuardDuty findings, Inspector vulnerability scans, security posture summary
- **Guardrails**: Financial advice block, data exfiltration block, PII redaction

### Governance Auditor

- **Purpose**: Validates compliance controls, reads Audit Manager/Config
- **Deployment**: AgentCore Harness (config-based, not code)
- **Critical Model**: Claude Opus 4.8
- **Standard Model**: GPT-5.5 (cost-optimized)
- **Fallback Model**: Claude Sonnet 4.6
- **Budget Model**: DeepSeek V4 Flash
- **Tools**: Audit Manager assessments, Config rule evaluations, compliance scoring
- **Guardrails**: Regulatory evasion block, PII anonymization

### Model Load Balancing

Two routing modes — **weighted distribution** for high-priority tiers and **failover chains** for budget tiers:

**Weighted routing** (CRITICAL & HIGH) — each invocation independently rolls a weighted die:

| Tier | Split | How it works |
|------|-------|--------------|
| **CRITICAL** | 80% Opus 4.8 / 20% GPT-5.5 | Both providers actively serve traffic. Non-selected model becomes fallback. |
| **HIGH (security)** | 70% Opus 4.8 / 30% GPT-5.5 | Opus leads on security scans and incident response. |
| **HIGH (compliance)** | 60% GPT-5.5 / 40% Opus 4.8 | GPT-5.5 leads on compliance checks and audit evidence. |

**Failover routing** (MEDIUM & LOW) — deterministic primary with ordered fallback chain:

| Priority | Security Tasks | Compliance Tasks |
|----------|---------------|-----------------|
| **MEDIUM** | Sonnet 4.6 → DeepSeek Pro → GPT-5.5 | DeepSeek Pro → Sonnet 4.6 → DeepSeek Flash |
| **LOW** | DeepSeek Flash → DeepSeek Pro → Sonnet 4.6 | DeepSeek Flash → DeepSeek Pro → Sonnet 4.6 |

**Model lineup (June 2026) — 20 models across 10 providers on AWS Bedrock:**
- **Anthropic**: Claude Fable 5, Opus 4.8, Opus 4.7, Sonnet 4.6, Haiku 4.5
- **OpenAI**: GPT-5.5, GPT-5.4
- **Amazon**: Nova Premier, Nova Pro, Nova Lite
- **Meta**: Llama 4 Maverick, Llama 4 Scout, Llama 3.3 70B
- **Mistral**: Mistral Large 3, Mistral Small 4
- **DeepSeek**: V4 Pro, V4 Flash (via OpenCode Go)
- **Qwen**: Qwen3 235B
- **Z.AI**: GLM 5.1
- **Moonshot**: Kimi K2.6

Adjust weights in `src/shared/model-router.ts` — no infrastructure deploy needed. See the **[live demo](https://kdeath83.github.io/AWS-AU-AI-VGS-Suite/demo/multi-model-router.html)** to experiment with different weight distributions.

For guidance on using multiple models for consistent outcomes in critical banking operations (customer deposits, etc.), see **[docs/multi-model-consistency-banking.md](docs/multi-model-consistency-banking.md)**.

---

## Prompt Optimization

### FSI Use Case Templates

- **Claims Triage**: Classifies insurance claims by priority, identifies required documentation, estimates processing time
- **Fraud Detection**: Analyzes transaction patterns, determines fraud risk level, recommends actions

Each template includes:
- JSONL sample files with prompt/completion pairs
- Ground truth answers for evaluation
- Custom Lambda evaluation function (Python) for structured output scoring

---

## Cleanup

```bash
# Destroy all stacks (retains evidence buckets by default)
./scripts/destroy.sh --environment dev --region ap-southeast-2

# Destroy including evidence (DANGER)
./scripts/destroy.sh --environment dev --region ap-southeast-2 --delete-evidence
```

---

## License

MIT-0 (AWS Open Source License)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Support

For issues or questions, please open a GitHub issue or contact the maintainers.

---

*Built with AWS CDK v2, TypeScript, and ❤️ for Australian FSIs.*
