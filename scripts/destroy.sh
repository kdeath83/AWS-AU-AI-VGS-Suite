#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# scripts/destroy.sh
# Clean up all AWS AU AI VGS Suite resources.
# WARNING: This will delete resources. Evidence buckets are retained by default.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ENVIRONMENT="dev"
APRAREGION="ap-southeast-2"
RETAIN_EVIDENCE="true"

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
        --delete-evidence)
            RETAIN_EVIDENCE="false"
            shift
            ;;
        --help|-h)
            echo "Usage: ./scripts/destroy.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --environment, -e    Environment name [default: dev]"
            echo "  --region, -r         AWS region [default: ap-southeast-2]"
            echo "  --delete-evidence    Also delete evidence S3 buckets (DANGER)"
            echo "  --help, -h           Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     AWS AU AI VGS Suite - Resource Destruction               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "⚠️  WARNING: This will destroy all CDK-managed resources!"
echo "Environment:  $ENVIRONMENT"
echo "Region:       $APRAREGION"
echo "Evidence:     $([ "$RETAIN_EVIDENCE" = "true" ] && echo 'RETAINED' || echo 'DELETED')"
echo ""

read -p "Are you sure? Type 'destroy' to confirm: " CONFIRM
if [ "$CONFIRM" != "destroy" ]; then
    echo "❌ Aborted."
    exit 1
fi

cd "$PROJECT_DIR"

# Empty evidence buckets if deleting them
if [ "$RETAIN_EVIDENCE" == "false" ]; then
    echo "🗑️  Emptying evidence buckets..."
    BUCKET_NAME=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, \`aws-au-ai-vgs-suite-evidence-$ENVIRONMENT-\`)].Name | [0]" --output text)
    if [ "$BUCKET_NAME" != "None" ] && [ -n "$BUCKET_NAME" ]; then
        aws s3 rm "s3://$BUCKET_NAME" --recursive || true
    fi
fi

# Destroy in reverse order (dependent stacks first)
echo "🔥 Destroying stacks..."
npx cdk destroy --all \
    --context environment="$ENVIRONMENT" \
    --context apraregion="$APRAREGION" \
    --force

echo ""
echo "✅ Destruction complete."
if [ "$RETAIN_EVIDENCE" = "true" ]; then
    echo "📦 Evidence S3 buckets were retained. Delete manually if needed."
fi