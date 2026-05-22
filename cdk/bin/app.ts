#!/usr/bin/env node
/**
 * cdk/bin/app.ts
 * CDK application entry point for the AWS AU AI VGS Suite.
 * Orchestrates the four stacks: Shared, SHIELD, VALIDATE, GOVERN.
 */
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NIST80053R5Checks, HIPAASecurityChecks } from 'cdk-nag';
import { SharedStack } from '../lib/shared-stack';
import { ShieldStack } from '../lib/shield-stack';
import { ValidateStack } from '../lib/validate-stack';
import { GovernStack } from '../lib/govern-stack';
import { PROJECT_NAME, DEFAULT_REGION } from '../lib/constants';

const app = new cdk.App();

// ── Context Resolution ──────────────────────────────────────────────────────

const environment = app.node.tryGetContext('environment') as string || 'dev';
const apraregion = app.node.tryGetContext('apraregion') as string || DEFAULT_REGION;
const enableCdkNag = app.node.tryGetContext('enableCdkNag') as boolean ?? true;

const stackProps: cdk.StackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: apraregion,
  },
  tags: {
    Project: PROJECT_NAME,
    Environment: environment,
    ComplianceFramework: 'APRA-CPS-234',
    ManagedBy: 'CDK',
  },
};

// ── Shared Stack (Foundation) ───────────────────────────────────────────────

const sharedStack = new SharedStack(app, `${PROJECT_NAME}-SharedStack`, {
  ...stackProps,
  environment,
  apraregion,
});

// ── SHIELD Stack ────────────────────────────────────────────────────────────

const shieldStack = new ShieldStack(app, `${PROJECT_NAME}-ShieldStack`, {
  ...stackProps,
  environment,
  vpc: sharedStack.vpc,
  evidenceBucket: sharedStack.evidenceBucket,
  kmsKey: sharedStack.kmsKey,
  eventBus: sharedStack.eventBus,
  baseRole: sharedStack.baseRole,
});

// ── VALIDATE Stack ──────────────────────────────────────────────────────────

const validateStack = new ValidateStack(app, `${PROJECT_NAME}-ValidateStack`, {
  ...stackProps,
  environment,
  vpc: sharedStack.vpc,
  evidenceBucket: sharedStack.evidenceBucket,
  kmsKey: sharedStack.kmsKey,
  eventBus: sharedStack.eventBus,
  baseRole: sharedStack.baseRole,
});

// ── GOVERN Stack ────────────────────────────────────────────────────────────

const governStack = new GovernStack(app, `${PROJECT_NAME}-GovernStack`, {
  ...stackProps,
  environment,
  vpc: sharedStack.vpc,
  evidenceBucket: sharedStack.evidenceBucket,
  kmsKey: sharedStack.kmsKey,
  eventBus: sharedStack.eventBus,
  baseRole: sharedStack.baseRole,
});

// ── Cross-Stack Dependencies ────────────────────────────────────────────────

shieldStack.addDependency(sharedStack);
validateStack.addDependency(sharedStack);
governStack.addDependency(sharedStack);

// ── CDK Nag Security Checks ─────────────────────────────────────────────────

if (enableCdkNag) {
  // Apply to all stacks
  const stacks = [sharedStack, shieldStack, validateStack, governStack];
  stacks.forEach((stack) => {
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    cdk.Aspects.of(stack).add(new NIST80053R5Checks());
    cdk.Aspects.of(stack).add(new HIPAASecurityChecks());
  });
}

// ── Synth ───────────────────────────────────────────────────────────────────

app.synth();
