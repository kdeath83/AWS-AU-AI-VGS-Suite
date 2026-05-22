/**
 * src/lambda/secure/guardduty-finder-aggregator/index.ts
 * Aggregates GuardDuty findings and stores evidence in S3.
 * Memory: 512MB | Timeout: 60s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { logInfo, logError, logWarn, withRetry, stripUndefined } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { GuardDutyFinding, EvidenceRecord } from '../../../shared/types';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');

function normalizeSeverity(gdSeverity: number): GuardDutyFinding['severity'] {
  if (gdSeverity >= 7) return 'CRITICAL';
  if (gdSeverity >= 5) return 'HIGH';
  if (gdSeverity >= 3) return 'MEDIUM';
  return 'LOW';
}

function convertToEvidenceRecord(finding: GuardDutyFinding): EvidenceRecord {
  return {
    evidenceId: finding.findingId,
    sourceService: 'GuardDuty',
    controlId: 'CPS234-3', // Risk Assessment
    timestamp: finding.createdAt,
    accountId: finding.accountId,
    region: finding.region,
    resourceArn: finding.resource.resourceArn,
    findingId: finding.findingId,
    severity: finding.severity,
    description: finding.description,
    rawPayload: finding as unknown as Record<string, unknown>,
    metadata: {
      collectedBy: 'guardduty-finder-aggregator',
      collectionVersion: '1.0.0',
    },
  };
}

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const findingDetail = messageBody.detail as GuardDutyFinding;

  logInfo('Processing GuardDuty finding', {
    requestId,
    findingId: findingDetail.findingId,
    severity: findingDetail.severity,
    type: findingDetail.type,
  });

  // Validate required fields
  if (!findingDetail.findingId || !findingDetail.type) {
    logWarn('Skipping invalid GuardDuty finding', { requestId, recordBody: record.body.substring(0, 500) });
    return;
  }

  // Normalize severity
  const normalizedSeverity = normalizeSeverity(Number(findingDetail.severity));

  const finding: GuardDutyFinding = {
    ...findingDetail,
    severity: normalizedSeverity,
  };

  // Convert to evidence record
  const evidenceRecord = convertToEvidenceRecord(finding);

  // Store in S3 evidence lake
  const evidenceKey = `guardduty/${finding.accountId}/${finding.region}/${finding.findingId}/${Date.now()}.json`;

  await withRetry(
    async () => {
      await s3Client.send(new PutObjectCommand({
        Bucket: evidenceBucket,
        Key: evidenceKey,
        Body: JSON.stringify(evidenceRecord),
        ContentType: 'application/json',
        Metadata: stripUndefined({
          'finding-id': finding.findingId,
          'finding-type': finding.type,
          severity: normalizedSeverity,
        }),
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, findingId: finding.findingId },
  );

  logInfo('GuardDuty finding stored as evidence', {
    requestId,
    findingId: finding.findingId,
    evidenceKey,
    bucket: evidenceBucket,
  });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const requestId = context.awsRequestId;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  logInfo('GuardDuty aggregator invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error) {
      logError('Failed to process GuardDuty record', error, { requestId, messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logInfo('GuardDuty aggregator completed', {
    requestId,
    processed: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
}
