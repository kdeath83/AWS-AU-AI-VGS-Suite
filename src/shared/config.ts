/**
 * src/shared/config.ts
 * Runtime configuration and environment helpers for Lambda handlers.
 */

export function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function getEnvVarAsNumber(name: string, defaultValue?: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Required environment variable ${name} is not set`);
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} is not a valid number: ${value}`);
  }
  return parsed;
}

export function getEnvVarAsBoolean(name: string, defaultValue?: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.toLowerCase() === 'true' || value === '1';
}

// Common environment variable names used across the suite
export const ENV_VARS = {
  LOG_LEVEL: 'LOG_LEVEL',
  EVIDENCE_BUCKET: 'EVIDENCE_BUCKET',
  EVIDENCE_BUCKET_PREFIX: 'EVIDENCE_BUCKET_PREFIX',
  KMS_KEY_ARN: 'KMS_KEY_ARN',
  REGION: 'AWS_REGION',
  ACCOUNT_ID: 'ACCOUNT_ID',
  EVENT_BUS_NAME: 'EVENT_BUS_NAME',
  SAGEMAKER_ROLE_ARN: 'SAGEMAKER_ROLE_ARN',
  NEPTUNE_ENDPOINT: 'NEPTUNE_ENDPOINT',
  BEDROCK_MODEL_ID: 'BEDROCK_MODEL_ID',
  GUARDRAIL_ID: 'GUARDRAIL_ID',
  AUDIT_ASSESSMENT_ARN: 'AUDIT_ASSESSMENT_ARN',
  SECURITY_HUB_ARN: 'SECURITY_HUB_ARN',
  GUARDDUTY_DETECTOR_ID: 'GUARDDUTY_DETECTOR_ID',
  INSPECTOR_RESOURCE_GROUP_ARN: 'INSPECTOR_RESOURCE_GROUP_ARN',
  AGENT_REGISTRY_TABLE: 'AGENT_REGISTRY_TABLE',
  QUICKSIGHT_DATASET_ARN: 'QUICKSIGHT_DATASET_ARN',
  DASHBOARD_DATASET_PREFIX: 'DASHBOARD_DATASET_PREFIX',
  ESCALATION_TOPIC_ARN: 'ESCALATION_TOPIC_ARN',
  SQS_QUEUE_URL: 'SQS_QUEUE_URL',
  DLQ_URL: 'DLQ_URL',
} as const;
