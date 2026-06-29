#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# scripts/deploy.sh
# One-click deployment for the AWS AU AI VGS Suite.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Default values
ENVIRONMENT="dev"
APRAREGION="ap-southeast-2"
SKIP_NAG=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment|-e)
            ENVIRONMENT="$2"
            shift 2
            ;;
        --region|-r)
            APRAREGION="$2"
            shift 2
            ;;
        --skip-nag)
            SKIP_NAG="true"
            shift
            ;;
        --help|-h)
            echo "Usage: ./scripts/deploy.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --environment, -e    Environment name (dev|test|prod) [default: dev]"
            echo "  --region, -r         AWS region [default: ap-southeast-2]"
            echo "  --skip-nag           Skip CDK Nag security checks"
            echo "  --help, -h           Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     AWS AU AI VGS Suite - One-Click Deployment               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Environment:  $ENVIRONMENT"
echo "Region:       $APRAREGION"
echo "CDK Nag:      $([ -n "$SKIP_NAG" ] && echo 'SKIPPED' || echo 'ENABLED')"
echo ""

cd "$PROJECT_DIR"

# ── Install dependencies ────────────────────────────────────────────────────
echo "📦 Installing dependencies..."
npm install

# ── Run setup checks ────────────────────────────────────────────────────────
echo "🔍 Running prerequisite checks..."
if ! bash "$SCRIPT_DIR/setup.sh"; then
    echo "❌ Prerequisites not satisfied. Exiting."
    exit 1
fi

# ── Build TypeScript ────────────────────────────────────────────────────────
echo "🔨 Building TypeScript..."
npm run build

# ── CDK Bootstrap (if needed) ───────────────────────────────────────────────
echo "☁️  Ensuring CDK bootstrap..."
npx cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$APRAREGION"

# ── CDK Synth ───────────────────────────────────────────────────────────────
echo "🧪 Running CDK synth..."
if [ -n "$SKIP_NAG" ]; then
    npx cdk synth --context environment="$ENVIRONMENT" --context apraregion="$APRAREGION" --context enableCdkNag=false
else
    npx cdk synth --context environment="$ENVIRONMENT" --context apraregion="$APRAREGION"
fi

# ── Deploy all stacks ───────────────────────────────────────────────────────
echo "🚀 Deploying all stacks..."
echo "   Order: SharedStack → SecureStack → ValidateStack → GovernStack"
echo ""

if [ -n "$SKIP_NAG" ]; then
    npx cdk deploy --all \
        --context environment="$ENVIRONMENT" \
        --context apraregion="$APRAREGION" \
        --context enableCdkNag=false \
        --require-approval never
else
    npx cdk deploy --all \
        --context environment="$ENVIRONMENT" \
        --context apraregion="$APRAREGION" \
        --require-approval never
fi

echo ""
echo "✅ Infrastructure deployment complete!"
echo ""

# ── Create AgentCore Harnesses ────────────────────────────────────────────────
echo "🤖 Creating AgentCore Harnesses with model load balancing..."
echo "   (This requires the OpenCode Go API key for DeepSeek access)"
echo ""
if bash "$SCRIPT_DIR/create-harnesses.sh" \
    --environment "$ENVIRONMENT" \
    --region "$APRAREGION" \
    --api-key "${OPENCODE_GO_API_KEY:-}"; then
    echo ""
    echo "✅ Harnesses created!"
else
    echo ""
    echo "⚠️  Harness creation skipped or failed. Run manually:"
    echo "   ./scripts/create-harnesses.sh --environment $ENVIRONMENT --region $APRAREGION"
fi

echo ""
echo "Stack outputs:"
npx cdk list --context environment="$ENVIRONMENT" --context apraregion="$APRAREGION"
echo ""
echo "To destroy: ./scripts/destroy.sh --environment $ENVIRONMENT --region $APRAREGION"