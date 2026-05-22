#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# scripts/setup.sh
# Prerequisite checks for the AWS AU AI VGS Suite deployment.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     AWS AU AI VGS Suite - Prerequisites Check                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

ERRORS=0

# ── AWS CLI ──────────────────────────────────────────────────────────────────
echo "Checking AWS CLI..."
if ! command -v aws &> /dev/null; then
    echo "  ❌ AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
    ((ERRORS++))
else
    AWS_VERSION=$(aws --version 2>&1 | head -1)
    echo "  ✅ AWS CLI: $AWS_VERSION"
fi

# ── AWS Credentials ──────────────────────────────────────────────────────────
echo "Checking AWS credentials..."
if ! aws sts get-caller-identity &> /dev/null; then
    echo "  ❌ AWS credentials not configured. Run: aws configure"
    ((ERRORS++))
else
    IDENTITY=$(aws sts get-caller-identity --output json 2>/dev/null)
    ACCOUNT_ID=$(echo "$IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
    echo "  ✅ Authenticated (Account: $ACCOUNT_ID)"
fi

# ── Node.js ─────────────────────────────────────────────────────────────────
echo "Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "  ❌ Node.js not found. Install: https://nodejs.org/"
    ((ERRORS++))
else
    NODE_VERSION=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_MAJOR" -lt 18 ]; then
        echo "  ❌ Node.js $NODE_VERSION is too old. Need >= 18.x"
        ((ERRORS++))
    else
        echo "  ✅ Node.js: $NODE_VERSION"
    fi
fi

# ── npm ──────────────────────────────────────────────────────────────────────
echo "Checking npm..."
if ! command -v npm &> /dev/null; then
    echo "  ❌ npm not found"
    ((ERRORS++))
else
    NPM_VERSION=$(npm --version)
    echo "  ✅ npm: $NPM_VERSION"
fi

# ── AWS CDK ─────────────────────────────────────────────────────────────────
echo "Checking AWS CDK..."
if ! command -v cdk &> /dev/null; then
    echo "  ⚠️  CDK CLI not found globally. Will use npx cdk."
else
    CDK_VERSION=$(cdk --version)
    echo "  ✅ CDK: $CDK_VERSION"
fi

# ── Git ──────────────────────────────────────────────────────────────────────
echo "Checking Git..."
if ! command -v git &> /dev/null; then
    echo "  ⚠️  Git not found (needed for CDK bootstrap)"
else
    echo "  ✅ Git: $(git --version)"
fi

# ── TypeScript ────────────────────────────────────────────────────────────
echo "Checking TypeScript..."
if ! command -v tsc &> /dev/null; then
    echo "  ⚠️  TypeScript compiler not found globally. Will use npx tsc."
else
    echo "  ✅ TypeScript: $(tsc --version)"
fi

# ── Region Validation ───────────────────────────────────────────────────────
echo "Checking default AWS region..."
AWS_REGION=$(aws configure get region 2>/dev/null || echo "")
if [ -z "$AWS_REGION" ]; then
    echo "  ⚠️  No default region set. Recommend: ap-southeast-2"
else
    echo "  ✅ Default region: $AWS_REGION"
    if [ "$AWS_REGION" != "ap-southeast-2" ]; then
        echo "  ⚠️  Not ap-southeast-2 (APRA region). Use -c apraregion=ap-southeast-2 on deploy."
    fi
fi

# ── CDK Bootstrap Check ─────────────────────────────────────────────────────
echo "Checking CDK bootstrap..."
if ! aws cloudformation describe-stacks --stack-name CDKToolkit &> /dev/null; then
    echo "  ⚠️  CDK bootstrap not found. Run: npx cdk bootstrap"
else
    echo "  ✅ CDK bootstrap present"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ERRORS" -eq 0 ]; then
    echo "✅ All prerequisites satisfied! Ready to deploy."
    echo ""
    echo "Next steps:"
    echo "  1. npm install"
    echo "  2. npx cdk bootstrap   (if not already done)"
    echo "  3. ./scripts/deploy.sh"
    exit 0
else
    echo "❌ Found $ERRORS prerequisite error(s). Please fix before deploying."
    exit 1
fi