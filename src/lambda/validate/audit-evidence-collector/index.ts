/**
 * src/lambda/validate/audit-evidence-collector/index.ts
 * Collects evidence from CloudTrail, Config, and Security Hub.
 * Memory: 1024MB | Timeout: 300s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { ConfigServiceClient, GetComplianceDetailsByConfigRuleCommand } from '@aws-sdk/client-config-service';
import { SecurityHubClient, GetFindingsCommand } from '@aws-sdk/client-securityhub';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry, chunkArray } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { AuditEvidenceCollectorEvent, EvidenceRecord, ComplianceStatus } from '../../../shared/types';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const cloudTrailClient = new CloudTrailClient({ region: process.env.AWS_REGION });
const configClient = new ConfigServiceClient({ region: process.env.AWS_REGION });
const securityHubClient = new SecurityHubClient({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');
const eventBusName = getEnvVar('EVENT_BUS_NAME');

async function collectCloudTrailEvidence(hours: number, requestId: string): Promise<EvidenceRecord[]> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

  const command = new LookupEventsCommand({
    StartTime: startTime,
    EndTime: endTime,
    MaxResults: 50,
  });

  const response = await withRetry(
    async () => cloudTrailClient.send(command),
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, service: 'CloudTrail' },
  );

  const records: EvidenceRecord[] = [];
  for (const event of response.Events || []) {
    records.push({
      evidenceId: `ct-${event.EventId || Date.now()}-${Date.now()}`,
      sourceService: 'CloudTrail',
      controlId: 'CPS234-7', // Internal Audit
      timestamp: event.EventTime?.toISOString() || new Date().toISOString(),
      accountId: process.env.ACCOUNT_ID || 'unknown',
      region: process.env.AWS_REGION || 'unknown',
      resourceArn: event.Resources?.[0]?.ResourceName || undefined,
      severity: 'LOW',
      description: `CloudTrail event: ${event.EventName}`,
      rawPayload: event as unknown as Record<string, unknown>,
      metadata: {
        collectedBy: 'audit-evidence-collector',
        collectionVersion: '1.0.0',
      },
    });
  }

  return records;
}

async function collectConfigEvidence(requestId: string): Promise<EvidenceRecord[]> {
  const command = new GetComplianceDetailsByConfigRuleCommand({
    ConfigRuleName: 'apra-cps234-iam-password-policy',
    Limit: 50,
  });

  const response = await withRetry(
    async () => configClient.send(command),
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, service: 'Config' },
  );

  const records: EvidenceRecord[] = [];
  for (const result of response.EvaluationResults || []) {
    const compliance = result.ComplianceType === 'COMPLIANT' ? 'COMPLIANT' : 'NON_COMPLIANT';
    records.push({
      evidenceId: `cfg-${result.EvaluationResultIdentifier?.EvaluationResultQualifier?.ResourceId || Date.now()}`,
      sourceService: 'Config',
      controlId: 'CPS234-1', // Information Security Policy
      timestamp: result.ResultRecordedTime?.toISOString() || new Date().toISOString(),
      accountId: process.env.ACCOUNT_ID || 'unknown',
      region: process.env.AWS_REGION || 'unknown',
      resourceArn: result.EvaluationResultIdentifier?.EvaluationResultQualifier?.ResourceId,
      severity: compliance === 'COMPLIANT' ? 'LOW' : 'HIGH',
      description: `Config evaluation: ${result.EvaluationResultIdentifier?.EvaluationResultQualifier?.ConfigRuleName}`,
      rawPayload: result as unknown as Record<string, unknown>,
      metadata: {
        collectedBy: 'audit-evidence-collector',
        collectionVersion: '1.0.0',
      },
    });
  }

  return records;
}

async function collectSecurityHubEvidence(requestId: string): Promise<EvidenceRecord[]> {
  const command = new GetFindingsCommand({
    MaxResults: 50,
    SortCriteria: [{ Field: 'CreatedAt', SortOrder: 'DESC' }],
  });

  const response = await withRetry(
    async () => securityHubClient.send(command),
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, service: 'SecurityHub' },
  );

  const records: EvidenceRecord[] = [];
  for (const finding of response.Findings || []) {
    records.push({
      evidenceId: `sh-${finding.Id || Date.now()}`,
      sourceService: 'SecurityHub',
      controlId: 'CPS234-5', // Incident Management
      timestamp: finding.CreatedAt || new Date().toISOString(),
      accountId: finding.AwsAccountId || process.env.ACCOUNT_ID || 'unknown',
      region: finding.Region || process.env.AWS_REGION || 'unknown',
      resourceArn: finding.Resources?.[0]?.Id,
      severity: (finding.Severity?.Label as any) || 'LOW',
      description: finding.Description || 'SecurityHub finding',
      rawPayload: finding as unknown as Record<string, unknown>,
      metadata: {
        collectedBy: 'audit-evidence-collector',
        collectionVersion: '1.0.0',
      },
    });
  }

  return records;
}

async function storeEvidenceBatch(records: EvidenceRecord[], requestId: string): Promise<void> {
  const chunks = chunkArray(records, 10);

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map((record) =>
        withRetry(
          async () => {
            const key = `audit-evidence/${record.sourceService}/${record.controlId}/${record.evidenceId}.json`;
            await s3Client.send(new PutObjectCommand({
              Bucket: evidenceBucket,
              Key: key,
              Body: JSON.stringify(record),
              ContentType: 'application/json',
            }));
          },
          { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
          { requestId, evidenceId: record.evidenceId },
        ),
      ),
    );
  }
}

async function emitCollectionSummary(totalCollected: number, requestId: string): Promise<void> {
  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.compliance',
            DetailType: 'AuditEvidenceCollectionComplete',
            Detail: JSON.stringify({
              totalCollected,
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId },
  );
}

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const eventPayload = messageBody as AuditEvidenceCollectorEvent;

  logInfo('Processing audit evidence collection', {
    requestId,
    services: eventPayload.services,
    timeRangeHours: eventPayload.timeRangeHours,
  });

  const allRecords: EvidenceRecord[] = [];

  for (const service of eventPayload.services || []) {
    try {
      let serviceRecords: EvidenceRecord[] = [];
      switch (service) {
        case 'CloudTrail':
          serviceRecords = await collectCloudTrailEvidence(eventPayload.timeRangeHours || 24, requestId);
          break;
        case 'Config':
          serviceRecords = await collectConfigEvidence(requestId);
          break;
        case 'SecurityHub':
          serviceRecords = await collectSecurityHubEvidence(requestId);
          break;
        default:
          logWarn('Unknown evidence source service', { requestId, service });
      }
      allRecords.push(...serviceRecords);
      logInfo(`Collected ${serviceRecords.length} records from ${service}`, { requestId, service });
    } catch (serviceError) {
      logError(`Failed to collect evidence from ${service}`, serviceError, { requestId, service });
      // Continue with other services (graceful degradation)
    }
  }

  // Store all evidence
  await storeEvidenceBatch(allRecords, requestId);

  // Emit summary event
  await emitCollectionSummary(allRecords.length, requestId);

  logInfo('Audit evidence collection completed', { requestId, totalCollected: allRecords.length });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const requestId = context.awsRequestId;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  logInfo('Audit evidence collector invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error) {
      logError('Failed to process audit evidence record', error, { requestId, messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logInfo('Audit evidence collector completed', {
    requestId,
    processed: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
}
