/**
 * src/lambda/validate/model-drift-handler/index.ts
 * Processes Model Monitor drift alerts and triggers fallback actions.
 * Memory: 512MB | Timeout: 120s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { logInfo, logError, logWarn, withRetry, generateIdempotencyKey } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { ModelDriftEvent, EvidenceRecord, RiskClassification } from '../../../shared/types';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');
const eventBusName = getEnvVar('EVENT_BUS_NAME');
const registryTable = getEnvVar('AGENT_REGISTRY_TABLE');

function classifyDriftSeverity(metricName: string, metricValue: number, threshold: number): RiskClassification {
  const ratio = metricValue / threshold;
  if (ratio >= 3) return 'CRITICAL';
  if (ratio >= 2) return 'HIGH';
  if (ratio >= 1.5) return 'MEDIUM';
  return 'LOW';
}

async function storeDriftEvidence(drift: ModelDriftEvent, requestId: string): Promise<void> {
  const severity = classifyDriftSeverity(drift.metricName, drift.metricValue, drift.threshold);

  const evidenceRecord: EvidenceRecord = {
    evidenceId: `drift-${drift.endpointName}-${Date.now()}`,
    sourceService: 'SageMakerModelMonitor',
    controlId: 'CPS234-6', // Testing
    timestamp: drift.timestamp,
    accountId: drift.accountId,
    region: drift.region,
    resourceArn: `arn:aws:sagemaker:${drift.region}:${drift.accountId}:endpoint/${drift.endpointName}`,
    severity,
    description: `${drift.violationType} detected on ${drift.endpointName}: ${drift.metricName}=${drift.metricValue} (threshold=${drift.threshold})`,
    rawPayload: drift as unknown as Record<string, unknown>,
    metadata: {
      collectedBy: 'model-drift-handler',
      collectionVersion: '1.0.0',
    },
  };

  const evidenceKey = `model-drift/${drift.endpointName}/${drift.violationType}/${Date.now()}.json`;

  await withRetry(
    async () => {
      await s3Client.send(new PutObjectCommand({
        Bucket: evidenceBucket,
        Key: evidenceKey,
        Body: JSON.stringify(evidenceRecord),
        ContentType: 'application/json',
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, endpointName: drift.endpointName },
  );
}

async function updateRegistryFallbackStatus(drift: ModelDriftEvent, requestId: string): Promise<void> {
  const idempotencyKey = generateIdempotencyKey(drift.endpointName, drift.violationType, drift.timestamp);

  await withRetry(
    async () => {
      await dynamoClient.send(new PutItemCommand({
        TableName: registryTable,
        Item: {
          recordId: { S: `fallback-${drift.endpointName}-${Date.now()}` },
          recordType: { S: 'FALLBACK_ACTION' },
          endpointName: { S: drift.endpointName },
          modelName: { S: drift.modelName },
          violationType: { S: drift.violationType },
          severity: { S: classifyDriftSeverity(drift.metricName, drift.metricValue, drift.threshold) },
          status: { S: 'TRIGGERED' },
          triggeredAt: { S: new Date().toISOString() },
          idempotencyKey: { S: idempotencyKey },
          requestId: { S: requestId },
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey) OR idempotencyKey <> :idempotencyKey',
        ExpressionAttributeValues: {
          ':idempotencyKey': { S: idempotencyKey },
        },
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, endpointName: drift.endpointName },
  );
}

async function emitDriftAlert(drift: ModelDriftEvent, requestId: string): Promise<void> {
  const severity = classifyDriftSeverity(drift.metricName, drift.metricValue, drift.threshold);

  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.security',
            DetailType: 'ModelDriftAlert',
            Detail: JSON.stringify({
              endpointName: drift.endpointName,
              modelName: drift.modelName,
              violationType: drift.violationType,
              severity,
              metricValue: drift.metricValue,
              threshold: drift.threshold,
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, endpointName: drift.endpointName },
  );
}

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const driftDetail = messageBody.detail as ModelDriftEvent;

  logInfo('Processing model drift event', {
    requestId,
    endpointName: driftDetail.endpointName,
    violationType: driftDetail.violationType,
    metricValue: driftDetail.metricValue,
    threshold: driftDetail.threshold,
  });

  if (!driftDetail.endpointName || !driftDetail.violationType) {
    logWarn('Skipping invalid drift event', { requestId, recordBody: record.body.substring(0, 500) });
    return;
  }

  // Store evidence
  await storeDriftEvidence(driftDetail, requestId);

  // Update registry with fallback status
  await updateRegistryFallbackStatus(driftDetail, requestId);

  // Emit alert
  await emitDriftAlert(driftDetail, requestId);

  logInfo('Model drift event processed', {
    requestId,
    endpointName: driftDetail.endpointName,
    severity: classifyDriftSeverity(driftDetail.metricName, driftDetail.metricValue, driftDetail.threshold),
  });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const requestId = context.awsRequestId;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  logInfo('Model drift handler invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error) {
      logError('Failed to process drift record', error, { requestId, messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logInfo('Model drift handler completed', {
    requestId,
    processed: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
}
