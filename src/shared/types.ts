/**
 * src/shared/types.ts
 * Shared TypeScript types and interfaces for the AWS AU AI VGS Suite.
 */

// ── Core Enums ──────────────────────────────────────────────────────────────

export enum Environment {
  DEV = 'dev',
  TEST = 'test',
  PROD = 'prod',
}

export type RiskClassification = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export enum ComplianceStatus {
  COMPLIANT = 'COMPLIANT',
  NON_COMPLIANT = 'NON_COMPLIANT',
  PENDING = 'PENDING',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export enum AgentStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ERROR = 'ERROR',
}

// ── Evidence Lake ───────────────────────────────────────────────────────────

export interface EvidenceRecord {
  evidenceId: string;
  sourceService: string;
  controlId: string;
  timestamp: string;
  accountId: string;
  region: string;
  resourceArn?: string;
  findingId?: string;
  severity: RiskClassification;
  description: string;
  rawPayload: Record<string, unknown>;
  metadata: {
    collectedBy: string;
    collectionVersion: string;
  };
}

// ── Model Monitoring ──────────────────────────────────────────────────────────

export interface ModelDriftEvent {
  endpointName: string;
  modelName: string;
  modelVersion: string;
  metricName: string;
  metricValue: number;
  threshold: number;
  violationType: 'DATA_DRIFT' | 'BIAS_DRIFT' | 'EXPLAINABILITY_DRIFT' | 'QUALITY_DRIFT';
  timestamp: string;
  accountId: string;
  region: string;
}

export interface BiasReport {
  reportId: string;
  jobName: string;
  endpointName: string;
  modelName: string;
  analysisType: 'PRE_TRAINING' | 'POST_TRAINING' | 'TRAINING';
  biasMetrics: Record<string, number>;
  explanationMetrics?: Record<string, unknown>;
  timestamp: string;
  s3OutputUri: string;
}

// ── Audit & Compliance ──────────────────────────────────────────────────────

export interface AuditControl {
  controlId: string;
  controlName: string;
  framework: string;
  status: ComplianceStatus;
  evidenceCount: number;
  lastAssessedAt?: string;
  assessorComments?: string;
}

export interface AuditEvidenceCollection {
  assessmentId: string;
  controlSetId: string;
  controlId: string;
  evidenceFolderId: string;
  evidenceCount: number;
  evidenceByService: Record<string, number>;
  collectedAt: string;
}

// ── Agent Registry ──────────────────────────────────────────────────────────

export interface RegistryRecord {
  recordId: string;
  recordType: 'AGENT' | 'MCP_SERVER' | 'TOOL';
  name: string;
  description: string;
  version: string;
  ownerTeam: string;
  status: AgentStatus;
  approvedBy?: string;
  approvedAt?: string;
  metadata: Record<string, unknown>;
  tags: Record<string, string>;
}

export interface AgentDefinition {
  agentId: string;
  agentName: string;
  agentType: 'SECURITY_SENTINEL' | 'GOVERNANCE_AUDITOR' | 'COMPLIANCE_SCANNER';
  runtimeConfig: {
    foundationModel: string;
    maxTokens: number;
    temperature: number;
  };
  instructionUri: string;
  mcpServerIds: string[];
  guardrailId?: string;
}

// ── Security / Shield ────────────────────────────────────────────────────────

export interface GuardDutyFinding {
  findingId: string;
  detectorId: string;
  accountId: string;
  region: string;
  type: string;
  severity: RiskClassification;
  title: string;
  description: string;
  resource: {
    resourceType: string;
    resourceArn?: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PromptInjectionAttempt {
  requestId: string;
  timestamp: string;
  sourceIp: string;
  userAgent: string;
  promptSnippet: string;
  attackType: 'DIRECT_INJECTION' | 'INDIRECT_INJECTION' | 'JAILBREAK' | 'DATA_EXFILTRATION';
  blocked: boolean;
  actionTaken: 'BLOCKED' | 'FLAGGED' | 'ALLOWED';
  guardrailId?: string;
}

// ── Governance / QuickSight ───────────────────────────────────────────────────

export interface DashboardMetric {
  metricId: string;
  metricName: string;
  value: number | string;
  trend: 'UP' | 'DOWN' | 'FLAT';
  changePercent?: number;
  timestamp: string;
  dimension: string;
}

export interface RiskPostureSummary {
  overallScore: number;
  categoryScores: Record<string, number>;
  topRisks: Array<{
    riskId: string;
    riskName: string;
    severity: RiskClassification;
    remediationStatus: string;
  }>;
  aiInventorySummary: {
    totalModels: number;
    compliantModels: number;
    modelsUnderReview: number;
  };
  assuranceStatus: {
    totalControls: number;
    compliantControls: number;
    nonCompliantControls: number;
    pendingControls: number;
  };
  generatedAt: string;
}

// ── Escalation ──────────────────────────────────────────────────────────────

export interface EscalationEvent {
  eventId: string;
  eventSource: string;
  eventType: string;
  riskClassification: RiskClassification;
  slaMinutes: number;
  assignedTeam?: string;
  incidentChannel?: string;
  description: string;
  affectedResources: string[];
  timestamp: string;
  metadata: Record<string, unknown>;
}

// ── Lambda Event Payloads ─────────────────────────────────────────────────────

export interface ModelDriftHandlerEvent {
  detail: ModelDriftEvent;
}

export interface BiasReportGeneratorEvent {
  endpointName: string;
  modelName: string;
  analysisType: 'PRE_TRAINING' | 'POST_TRAINING' | 'TRAINING';
  s3InputUri: string;
  featureNames: string[];
  targetLabel: string;
  fairnessThreshold?: number;
}

export interface AuditEvidenceCollectorEvent {
  assessmentId?: string;
  controlSetId?: string;
  services: Array<'CloudTrail' | 'Config' | 'SecurityHub' | 'GuardDuty' | 'Inspector'>;
  timeRangeHours: number;
  s3OutputPrefix?: string;
}

export interface RegistryCuratorEvent {
  action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'REVOKE';
  record: Partial<RegistryRecord>;
  requestedBy: string;
  reason?: string;
}

export interface AgentOrchestratorEvent {
  taskType: 'SECURITY_SCAN' | 'COMPLIANCE_CHECK' | 'INCIDENT_RESPONSE' | 'AUDIT_EVIDENCE';
  targetAgentIds: string[];
  inputData: Record<string, unknown>;
  priority: RiskClassification;
  correlationId: string;
  timeoutSeconds?: number;
}

export interface DashboardDataPrepEvent {
  dashboardId: string;
  datasetIds: string[];
  refreshType: 'FULL' | 'INCREMENTAL';
  sourceStacks: Array<'shared' | 'shield' | 'validate' | 'govern'>;
}

export interface NlSummaryGeneratorEvent {
  summaryType: 'RISK_POSTURE' | 'INCIDENT_REPORT' | 'COMPLIANCE_STATUS' | 'AI_INVENTORY';
  timeRange: { start: string; end: string };
  audience: 'BOARD' | 'EXECUTIVE' | 'OPERATIONS' | 'REGULATOR';
  outputFormat: 'MARKDOWN' | 'JSON' | 'HTML';
  maxLengthWords?: number;
}

export interface EscalationRouterEvent {
  detail: EscalationEvent;
}
