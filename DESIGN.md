# AWS AU AI VGS Suite — Design Specification
## Proof of Concept: One-Click Deployment

**Repo name:** `AWS-AU-AI-VGS-Suite`  
**Target:** AWS CDK-based one-click deployment for Australian FSI  
**Core AWS Services:** Bedrock Advanced Prompt Optimization, Bedrock AgentCore, AWS Agent Registry, plus supporting infrastructure

---

## Architecture Overview

Three CDK stacks deploy as a single app. Each stack maps to one module:

```
AWS Organization (Hub Account)
├── SHIELD Stack         → Security services, GuardDuty, WAF, Config
├── VALIDATE Stack       → Model monitoring, AgentCore, Agent Registry, Audit Manager
├── GOVERN Stack         → QuickSight dashboards, EventBridge, Bedrock NLG
└── Shared Stack         → VPC, S3 Evidence Lake, KMS, IAM roles
```

---

## Module Specifications

### SHIELD Stack

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Prompt Injection Defense | Bedrock Guardrails | Topic restrictions, PII redaction |
| API Protection | WAFv2 + API Gateway | Rate limiting, anomaly detection |
| Threat Detection | GuardDuty | AI endpoint threat detection |
| Vulnerability Mgmt | Inspector + Systems Manager Patch Manager | Continuous scanning + patching |
| Config Compliance | AWS Config + Conformance Packs | Continuous compliance validation |
| Agent IAM | IAM + Secrets Manager | Non-human identity for AI agents |

**Bedrock Advanced Prompt Optimization integration:**
- Pre-built prompt templates for FSI use cases (claims triage, fraud detection)
- JSONL format with ground truth answers and evaluation metrics
- Lambda-based custom evaluation for structured output validation
- Stored in S3, triggered via EventBridge on model deployment

### VALIDATE Stack

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Model Monitoring | SageMaker Model Monitor | Drift, bias, performance detection |
| Explainability | SageMaker Clarify | SHAP-based explanations |
| Audit Evidence | Audit Manager | Automated APRA control evidence |
| Supply Chain | Neptune | AI dependency graph |
| Agent Runtime | Bedrock AgentCore Runtime | Host security/governance agents |
| Agent Identity | Bedrock AgentCore Identity | JWT-based agent authentication |
| Tool Discovery | Bedrock AgentCore Gateway | MCP server registration |
| AI Inventory | AWS Agent Registry | Centralized agent/tool catalog |

**Bedrock AgentCore integration:**
- Deploy a "Security Sentinel" agent that continuously monitors AI endpoints
- Deploy a "Governance Auditor" agent that validates compliance controls
- AgentCore Identity for secure credential management
- AgentCore Memory for long-term audit trail context
- AgentCore Observability for tracing agent decisions

**AWS Agent Registry integration:**
- Registry for all deployed agents, MCP servers, and tools
- Approval workflow for new agent/tool registration
- Semantic search for discovering the right tool/agent
- EventBridge notifications on registry changes

### GOVERN Stack

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Executive Dashboard | QuickSight | Board-ready risk posture views |
| NL Summaries | Bedrock (Claude) | Natural language board reports |
| Alerting | EventBridge + SNS | Escalation triggers |
| Evidence Lake | S3 + Lake Formation | Centralized audit evidence |

---

## Directory Structure

```
AWS-AU-AI-VGS-Suite/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── .gitignore
├── cdk.json
├── package.json                    # CDK dependencies
├── tsconfig.json
├── cdk/
│   ├── bin/
│   │   └── app.ts                  # CDK app entry point
│   ├── lib/
│   │   ├── shared-stack.ts         # VPC, S3, KMS, base IAM
│   │   ├── shield-stack.ts         # SHIELD module
│   │   ├── validate-stack.ts       # VALIDATE module
│   │   ├── govern-stack.ts         # GOVERN module
│   │   ├── bedrock-prompt-optimization.ts  # Prompt optimization construct
│   │   ├── agentcore-integration.ts      # AgentCore constructs
│   │   ├── agent-registry.ts             # Agent Registry constructs
│   │   └── constants.ts            # APRA/ASIC control mappings
│   └── test/
│       └── cdk.test.ts
├── src/
│   ├── lambda/                     # Lambda functions
│   │   ├── shield/
│   │   │   ├── prompt-injection-detector/
│   │   │   ├── guardduty-finder-aggregator/
│   │   │   └── patch-compliance-checker/
│   │   ├── validate/
│   │   │   ├── model-drift-handler/
│   │   │   ├── bias-report-generator/
│   │   │   ├── audit-evidence-collector/
│   │   │   ├── registry-curator/
│   │   │   └── agent-orchestrator/
│   │   └── govern/
│   │       ├── dashboard-data-prep/
│   │       ├── nl-summary-generator/
│   │       └── escalation-router/
│   ├── prompts/                    # Bedrock prompt optimization configs
│   │   ├── claims-triage/
│   │   │   ├── template.txt
│   │   │   ├── samples.jsonl
│   │   │   └── evaluation-lambda.py
│   │   ├── fraud-detection/
│   │   └── loan-processing/
│   ├── agents/                     # Bedrock AgentCore agent definitions
│   │   ├── security-sentinel/
│   │   │   ├── agent.yaml
│   │   │   ├── instructions.md
│   │   │   └── mcp-servers/
│   │   │       └── guardduty-inspector.yaml
│   │   ├── governance-auditor/
│   │   │   ├── agent.yaml
│   │   │   ├── instructions.md
│   │   │   └── mcp-servers/
│   │   │       └── audit-manager.yaml
│   │   └── compliance-scanner/
│   └── shared/
│       ├── config.ts
│       ├── types.ts
│       └── utils.ts
├── docs/
│   ├── architecture.md
│   ├── deployment.md
│   ├── security-review.md
│   └── regulatory-mapping.md
├── tests/
│   ├── unit/
│   └── integration/
└── scripts/
    ├── deploy.sh                   # One-click deployment
    ├── destroy.sh
    └── setup.sh                    # Prerequisites check
```

---

## Security Requirements

1. **No hardcoded credentials** — All secrets via Secrets Manager or Parameter Store
2. **Least privilege IAM** — Every role scoped to minimum permissions
3. **Encryption at rest** — KMS for all data stores
4. **Encryption in transit** — TLS 1.3 for all APIs
5. **VPC isolation** — All compute in private subnets
6. **CloudTrail logging** — All API calls logged
7. **Config rules** — Real-time compliance validation
8. **No data egress** — All processing in customer account

---

## Performance Requirements

1. **Model drift detection:** < 15 minutes from event to alert
2. **Prompt injection blocking:** < 100ms latency overhead
3. **Agent response time:** < 5 seconds for governance queries
4. **Dashboard refresh:** Real-time for critical metrics, 5 min for standard
5. **Evidence collection:** Automated, async, no blocking on API calls

---

## Code Review Checklist

### Security
- [ ] No secrets in code or config files
- [ ] IAM policies use least privilege with conditions
- [ ] Input validation on all Lambda handlers
- [ ] XSS/SQLi prevention on API Gateway
- [ ] WAF rules cover OWASP Top 10 + AI-specific threats

### Logic
- [ ] Error handling with retry and dead letter queues
- [ ] Idempotent operations for all state changes
- [ ] Circuit breakers for external API calls
- [ ] Graceful degradation when services unavailable

### Performance
- [ ] Lambda memory/timeout tuned per function
- [ ] SQS for async decoupling
- [ ] Neptune query optimization for graph traversals
- [ ] QuickSight SPICE for dashboard performance

---

## Deployment Flow

```bash
# One-click deployment
./scripts/setup.sh          # Check prerequisites
./scripts/deploy.sh         # Deploy all stacks

# Or step by step
npm install
npx cdk bootstrap
npx cdk deploy SharedStack
npx cdk deploy ShieldStack
npx cdk deploy ValidateStack
npx cdk deploy GovernStack
```

---

## GitHub Repo Setup

- **Repo:** `AWS-AU-AI-VGS-Suite`
- **License:** MIT-0 (AWS open source license)
- **Topics:** aws, bedrock, agentcore, australian-fsi, apra, asic, ai-governance, cdk
- **README:** Architecture, deployment instructions, regulatory mapping
- **Actions:** CI/CD with CDK synth, lint, security scan (bandit, cdk-nag)

---

*Design version: 1.0*
*Date: 2026-05-22*
