/**
 * tests/setup.ts
 * Jest setup file for the AWS AU AI VGS Suite.
 */

// Mock console methods to reduce noise during tests
// but still log errors
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('ERROR') || args[0].includes('Failed') || args[0].includes('error'))
  ) {
    originalConsoleError(...args);
  }
};

/**
 * Placeholder configuration for unit tests.
 *
 * Lambda modules call getEnvVar() at import time, which throws when a variable is
 * missing — so merely importing a handler in a test fails the suite before a single
 * assertion runs. These are inert placeholders, not real resource identifiers; set the
 * variable in the environment to override one.
 */
const TEST_ENV_DEFAULTS: Record<string, string> = {
  AWS_REGION: 'ap-southeast-2',
  AGENT_REGISTRY_TABLE: 'aws-au-ai-vgs-suite-agent-registry-test',
  BEDROCK_MODEL_ID: 'anthropic.claude-sonnet-4-6',
  DASHBOARD_DATASET_PREFIX: 'aws-au-ai-vgs-suite-dashboard',
  ESCALATION_TOPIC_ARN: 'arn:aws:sns:ap-southeast-2:123456789012:aws-au-ai-vgs-suite-escalation-test',
  EVENT_BUS_NAME: 'aws-au-ai-vgs-suite-events-test',
  EVIDENCE_BUCKET: 'aws-au-ai-vgs-suite-evidence-test',
  GOVERNANCE_HARNESS_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:harness/governance-test',
  GUARDRAIL_ID: 'guardrail-test',
  KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/00000000-0000-0000-0000-000000000000',
  SAGEMAKER_ROLE_ARN: 'arn:aws:iam::123456789012:role/aws-au-ai-vgs-suite-sagemaker-test',
  SECURITY_HARNESS_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:harness/security-test',
};

for (const [name, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (process.env[name] === undefined) {
    process.env[name] = value;
  }
}
