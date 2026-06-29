#!/usr/bin/env bash
#
# scripts/create-harnesses.sh
# Creates AgentCore Harness resources for the VGS Suite.
#
# Prerequisites:
#   - AWS CLI 2.34+ (with bedrock-agentcore-control support)
#   - boto3 >= 1.43.33 for SDK usage
#   - jq for JSON parsing
#   - CDK stack deployed (provides execution role ARN)
#
# Usage:
#   ./scripts/create-harnesses.sh --environment dev --region ap-southeast-2
#
set -euo pipefail

ENVIRONMENT="dev"
REGION="ap-southeast-2"
OPENCODE_GO_API_KEY="${OPENCODE_GO_API_KEY:-}"

usage() {
  echo "Usage: $0 --environment <env> --region <region> [--api-key <key>]"
  echo ""
  echo "Required:"
  echo "  --environment   Deployment environment (dev|test|prod)"
  echo "  --region        AWS region (e.g., ap-southeast-2)"
  echo ""
  echo "Optional:"
  echo "  --api-key       OpenCode Go API key for DeepSeek model access"
  echo "                  (defaults to \$OPENCODE_GO_API_KEY env var)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --api-key) OPENCODE_GO_API_KEY="$2"; shift 2 ;;
    *) usage ;;
  esac
done

PROJECT="aws-au-ai-vgs-suite"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AgentCore Harness Creator — VGS Suite"
echo "  Environment: ${ENVIRONMENT}"
echo "  Region:      ${REGION}"
echo "  Account:     ${ACCOUNT_ID}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: Store OpenCode Go API key in AgentCore Identity ──────────────────
echo ""
echo "[1/5] Registering OpenCode Go API key in AgentCore Identity..."

if [[ -z "${OPENCODE_GO_API_KEY}" ]]; then
  echo "  ⚠ No API key provided (--api-key or \$OPENCODE_GO_API_KEY)."
  echo "  DeepSeek models will NOT be available via LiteLLM."
  echo "  Claude-only mode — set the key later with:"
  echo "    aws bedrock-agentcore-control create-api-key-credential-provider \\"
  echo "      --name opencode-go-key --api-key \"<your-key>\""
  echo ""
  SKIP_IDENTITY=true
else
  IDENTITY_OUTPUT=$(aws bedrock-agentcore-control create-api-key-credential-provider \
    --name "opencode-go-key" \
    --api-key "${OPENCODE_GO_API_KEY}" \
    --description "OpenCode Go subscription key for DeepSeek model access" \
    --region "${REGION}" \
    --output json 2>&1) || {
      echo "  ℹ API key credential may already exist, skipping..."
    }
  echo "  ✓ OpenCode Go API key stored in AgentCore Identity"
  SKIP_IDENTITY=false
fi

IDENTITY_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:api-key-credential/opencode-go-key"

# ── Step 2: Create execution role (or use CDK-provided) ─────────────────────
echo ""
echo "[2/5] Configuring harness execution role..."

# Check if CDK already created the role
ROLE_NAME="${PROJECT}-harness-execution-${ENVIRONMENT}"
EXECUTION_ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" \
  --query 'Role.Arn' --output text 2>/dev/null || echo "")

if [[ -z "${EXECUTION_ROLE_ARN}" ]]; then
  echo "  ⚠ Harness execution role not found. Deploy the CDK stack first:"
  echo "    npx cdk deploy ValidateStack -c environment=${ENVIRONMENT}"
  echo "  The CDK creates the IAM role needed by harnesses."
  exit 1
fi

echo "  ✓ Using execution role: ${EXECUTION_ROLE_ARN}"

# ── Step 3: Create Security Sentinel Harness ─────────────────────────────────
echo ""
echo "[3/5] Creating Security Sentinel harness..."

SECURITY_HARNESS_NAME="${PROJECT}-security-sentinel-${ENVIRONMENT}"

SECURITY_TOOLS='[
  {"type": "agentcore_browser", "name": "browser"},
  {"type": "agentcore_code_interpreter", "name": "code_interpreter"},
  {"type": "remote_mcp", "name": "guardduty-inspector", "config": {"remoteMcp": {"url": "https://guardduty-inspector.mcp.aws"}}}
]'

SECURITY_SYSTEM_PROMPT='[{"text": "You are the Security Sentinel, an AI security monitoring agent for an Australian Financial Services Institution.\nYour responsibilities:\n1. Monitor AI endpoints for anomalous behavior, prompt injection attempts, and data exfiltration\n2. Read and analyze GuardDuty findings related to AI workloads\n3. Read and analyze Inspector vulnerability scan results\n4. Generate security incident reports with severity classification\n5. Escalate critical findings via EventBridge\n\nAlways comply with APRA CPS 234 security requirements. Be concise and direct."}]'

aws bedrock-agentcore-control create-harness \
  --harness-name "${SECURITY_HARNESS_NAME}" \
  --execution-role-arn "${EXECUTION_ROLE_ARN}" \
  --system-prompt "${SECURITY_SYSTEM_PROMPT}" \
  --tools "${SECURITY_TOOLS}" \
  --region "${REGION}" \
  --output json > /tmp/harness-security.json 2>&1 || {
    echo "  ℹ Harness may already exist. Checking..."
    aws bedrock-agentcore-control get-harness \
      --harness-name "${SECURITY_HARNESS_NAME}" \
      --region "${REGION}" \
      --output json > /tmp/harness-security.json
  }

SECURITY_HARNESS_ARN=$(jq -r '.harnessArn' /tmp/harness-security.json)
echo "  ✓ Security Sentinel: ${SECURITY_HARNESS_ARN}"

# ── Step 4: Create Governance Auditor Harness ────────────────────────────────
echo ""
echo "[4/5] Creating Governance Auditor harness..."

GOVERNANCE_HARNESS_NAME="${PROJECT}-governance-auditor-${ENVIRONMENT}"

GOVERNANCE_TOOLS='[
  {"type": "agentcore_browser", "name": "browser"},
  {"type": "agentcore_code_interpreter", "name": "code_interpreter"},
  {"type": "remote_mcp", "name": "audit-manager", "config": {"remoteMcp": {"url": "https://audit-manager.mcp.aws"}}},
  {"type": "remote_mcp", "name": "config-compliance", "config": {"remoteMcp": {"url": "https://config-compliance.mcp.aws"}}}
]'

GOVERNANCE_SYSTEM_PROMPT='[{"text": "You are the Governance Auditor, a compliance validation agent for an Australian Financial Services Institution.\nYour responsibilities:\n1. Validate compliance controls against APRA CPS 234 and CPS 230 frameworks\n2. Read Audit Manager assessment results and evidence\n3. Read AWS Config compliance rules and evaluations\n4. Identify compliance gaps and recommend remediation\n5. Generate board-ready compliance summaries\n\nAlways provide evidence-based conclusions. Be concise and direct."}]'

aws bedrock-agentcore-control create-harness \
  --harness-name "${GOVERNANCE_HARNESS_NAME}" \
  --execution-role-arn "${EXECUTION_ROLE_ARN}" \
  --system-prompt "${GOVERNANCE_SYSTEM_PROMPT}" \
  --tools "${GOVERNANCE_TOOLS}" \
  --region "${REGION}" \
  --output json > /tmp/harness-governance.json 2>&1 || {
    echo "  ℹ Harness may already exist. Checking..."
    aws bedrock-agentcore-control get-harness \
      --harness-name "${GOVERNANCE_HARNESS_NAME}" \
      --region "${REGION}" \
      --output json > /tmp/harness-governance.json
  }

GOVERNANCE_HARNESS_ARN=$(jq -r '.harnessArn' /tmp/harness-governance.json)
echo "  ✓ Governance Auditor: ${GOVERNANCE_HARNESS_ARN}"

# ── Step 5: Summary ─────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Harness Creation Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Security Sentinel:   ${SECURITY_HARNESS_ARN}"
echo "  Governance Auditor:  ${GOVERNANCE_HARNESS_ARN}"
echo "  Execution Role:      ${EXECUTION_ROLE_ARN}"
echo "  Identity API Key:    ${IDENTITY_ARN}"
echo ""
echo "  Model routing (configured in orchestrator):"
echo "    CRITICAL         → Claude Opus 4.5"
echo "    HIGH (security)  → Claude Sonnet 4.5"
echo "    HIGH (compliance) → DeepSeek V4 Pro"
echo "    MEDIUM/LOW       → DeepSeek V4 Flash"
echo ""
echo "  To update the orchestrator with these ARNs:"
echo "    npx cdk deploy ValidateStack -c environment=${ENVIRONMENT} -c apraregion=${REGION}"
echo ""
echo "  To test:"
echo "    aws bedrock-agentcore-control invoke-harness \\"
echo "      --harness-arn ${SECURITY_HARNESS_ARN} \\"
echo "      --runtime-session-id test-session-1 \\"
echo "      --model '{\"bedrockModelConfig\":{\"modelId\":\"us.anthropic.claude-sonnet-4-5-20250514-v1:0\"}}' \\"
echo "      --messages '[{\"role\":\"user\",\"content\":[{\"text\":\"List active GuardDuty findings.\"}]}]' \\"
echo "      --region ${REGION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
