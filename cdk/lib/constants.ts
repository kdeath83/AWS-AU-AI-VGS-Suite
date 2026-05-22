/**
 * cdk/lib/constants.ts
 * APRA/ASIC control mappings and regulatory constants for the AWS AU AI VGS Suite.
 * Maps regulatory expectations to specific AWS services and controls.
 */

export const PROJECT_NAME = 'aws-au-ai-vgs-suite';
export const DEFAULT_REGION = 'ap-southeast-2';

// APRA CPS 234 Control Mappings → AWS Config Rules + Audit Manager
export const APRA_CPS_234_CONTROLS = {
  // Information Security Management
  CPS234_1: {
    name: 'Information Security Policy',
    description: 'APRA expects an information security policy framework',
    awsServices: ['AWS Config', 'Audit Manager', 'IAM'],
    configRules: ['iam-password-policy', 'iam-policy-no-statements-with-admin-access'],
    auditFramework: 'APRA_CPS_234',
  },
  // Information Asset Classification
  CPS234_2: {
    name: 'Information Asset Classification',
    description: 'Classification of information assets including AI models and data',
    awsServices: ['Macie', 'S3', 'KMS', 'Tagging'],
    configRules: ['s3-bucket-public-read-prohibited', 's3-bucket-ssl-requests-only', 's3-bucket-logging-enabled'],
    auditFramework: 'APRA_CPS_234',
  },
  // Information Security Risk Assessment
  CPS234_3: {
    name: 'Risk Assessment',
    description: 'Regular assessment of information security risks including AI-specific risks',
    awsServices: ['GuardDuty', 'Inspector', 'Security Hub', 'Risk Manager'],
    configRules: ['guardduty-enabled-centralized', 'inspector-ec2-scan-enabled'],
    auditFramework: 'APRA_CPS_234',
  },
  // Implementation of Controls
  CPS234_4: {
    name: 'Control Implementation',
    description: 'Implementation of controls proportional to risk',
    awsServices: ['Config', 'Systems Manager', 'Patch Manager', 'CloudTrail'],
    configRules: ['cloud-trail-enabled', 'ec2-managedinstance-patch-compliance-status-check'],
    auditFramework: 'APRA_CPS_234',
  },
  // Incident Management
  CPS234_5: {
    name: 'Incident Management',
    description: 'Detection and response to information security incidents',
    awsServices: ['Security Hub', 'EventBridge', 'SNS', 'Lambda'],
    configRules: ['security-hub-enabled'],
    auditFramework: 'APRA_CPS_234',
  },
  // Testing Control Effectiveness
  CPS234_6: {
    name: 'Testing',
    description: 'Regular testing of control effectiveness',
    awsServices: ['Audit Manager', 'Config', 'CloudWatch'],
    configRules: ['config-enabled'],
    auditFramework: 'APRA_CPS_234',
  },
  // Internal Audit
  CPS234_7: {
    name: 'Internal Audit',
    description: 'Independent review of control effectiveness',
    awsServices: ['Audit Manager', 'CloudTrail', 'S3'],
    configRules: ['cloud-trail-cloud-watch-logs-enabled'],
    auditFramework: 'APRA_CPS_234',
  },
  // APRA Notification
  CPS234_8: {
    name: 'APRA Notification',
    description: 'Notify APRA of material information security incidents',
    awsServices: ['EventBridge', 'Lambda', 'SNS'],
    configRules: [],
    auditFramework: 'APRA_CPS_234',
  },
  // Third Party Risk
  CPS234_9: {
    name: 'Third Party Risk',
    description: 'Manage information security risks relating to third parties including AI vendors',
    awsServices: ['Neptune', 'Config', 'IAM'],
    configRules: ['iam-user-no-policies-check'],
    auditFramework: 'APRA_CPS_234',
  },
} as const;

// CPS 230 Control Mappings → Resilience Hub + Fallback Processes
export const CPS_230_CONTROLS = {
  CPS230_1: {
    name: 'Operational Risk Management',
    description: 'Maintain an operational risk management framework',
    awsServices: ['Resilience Hub', 'Systems Manager', 'CloudWatch'],
    resilienceHub: true,
  },
  CPS230_2: {
    name: 'Business Continuity',
    description: 'Business continuity planning and testing',
    awsServices: ['Resilience Hub', 'Backup', 'Route 53'],
    resilienceHub: true,
  },
  CPS230_3: {
    name: 'Service Provider Management',
    description: 'Manage service provider disruptions',
    awsServices: ['Neptune', 'Config', 'CloudTrail'],
    resilienceHub: false,
  },
} as const;

// ASIC 26-092MR Expectations → Specific Controls
export const ASIC_26_092MR_CONTROLS = {
  // Governance and Accountability
  ASIC_1: {
    name: 'AI Governance',
    description: 'Clear accountability for AI systems',
    awsServices: ['IAM', 'Audit Manager', 'Config'],
  },
  // Transparency and Explainability
  ASIC_2: {
    name: 'Explainability',
    description: 'AI decisions must be explainable',
    awsServices: ['SageMaker Clarify', 'Bedrock', 'CloudWatch Logs'],
  },
  // Fairness and Bias Testing
  ASIC_3: {
    name: 'Bias Testing',
    description: 'Regular testing for unfair bias',
    awsServices: ['SageMaker Clarify', 'SageMaker Model Monitor'],
  },
  // Data Quality
  ASIC_4: {
    name: 'Data Quality',
    description: 'Data used for AI must be fit for purpose',
    awsServices: ['Glue DataBrew', 'SageMaker Model Monitor', 'S3'],
  },
  // Consumer Protection
  ASIC_5: {
    name: 'Consumer Protection',
    description: 'AI must not cause consumer harm',
    awsServices: ['Bedrock Guardrails', 'WAF', 'CloudWatch Alarms'],
  },
} as const;

// APRA AI Letter (May 2026) Expectations → AWS Services
export const APRA_AI_LETTER_2026 = {
  // Model Risk Management
  AI_1: {
    expectation: 'Robust model risk management framework',
    awsServices: ['SageMaker Model Monitor', 'SageMaker Clarify', 'Bedrock Guardrails'],
  },
  // Data Governance
  AI_2: {
    expectation: 'Strong data governance for AI training data',
    awsServices: ['Glue', 'Macie', 'KMS', 'S3'],
  },
  // Third Party AI
  AI_3: {
    expectation: 'Oversight of third-party AI models',
    awsServices: ['Neptune', 'Audit Manager', 'Config'],
  },
  // AI-Specific Cyber Security
  AI_4: {
    expectation: 'AI-specific cyber security controls',
    awsServices: ['WAF', 'GuardDuty', 'Bedrock Guardrails', 'Inspector'],
  },
  // Human Oversight
  AI_5: {
    expectation: 'Meaningful human oversight of AI decisions',
    awsServices: ['Bedrock AgentCore', 'EventBridge', 'QuickSight'],
  },
  // Monitoring and Reporting
  AI_6: {
    expectation: 'Continuous monitoring and board reporting',
    awsServices: ['CloudWatch', 'QuickSight', 'Bedrock', 'EventBridge'],
  },
} as const;

// Tagging standards
export const REQUIRED_TAGS = {
  Project: PROJECT_NAME,
  Environment: '${environment}',
  ComplianceFramework: 'APRA-CPS-234',
  DataClassification: 'Sensitive',
  ManagedBy: 'CDK',
} as const;
