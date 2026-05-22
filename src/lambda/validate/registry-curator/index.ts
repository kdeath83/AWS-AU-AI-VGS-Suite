/**
 * src/lambda/validate/registry-curator/index.ts
 * Manages approval workflow for agent registry records via DynamoDB stream processing.
 * Memory: 256MB | Timeout: 60s
 */

import { DynamoDBStreamEvent, DynamoDBStreamRecord, Context } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry, isNonEmptyString } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { RegistryRecord, RegistryCuratorEvent, AgentStatus } from '../../../shared/types';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const eventBusName = getEnvVar('EVENT_BUS_NAME');
const registryTable = getEnvVar('AGENT_REGISTRY_TABLE');

// Required fields for a valid registry record
const REQUIRED_FIELDS = ['name', 'description', 'version', 'ownerTeam', 'recordType'];

function validateRecord(record: Partial<RegistryRecord>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!record[field as keyof RegistryRecord]) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (record.recordType && !['AGENT', 'MCP_SERVER', 'TOOL'].includes(record.recordType)) {
    errors.push(`Invalid recordType: ${record.recordType}`);
  }
  return { valid: errors.length === 0, errors };
}

async function updateRecordStatus(
  recordId: string,
  recordType: string,
  status: AgentStatus,
  approvedBy?: string,
): Promise<void> {
  const updateExpression = approvedBy
    ? 'SET #status = :status, approvedBy = :approvedBy, approvedAt = :approvedAt'
    : 'SET #status = :status';

  const expressionAttributeValues: Record<string, { S: string }> = {
    ':status': { S: status },
  };

  if (approvedBy) {
    expressionAttributeValues[':approvedBy'] = { S: approvedBy };
    expressionAttributeValues[':approvedAt'] = { S: new Date().toISOString() };
  }

  await withRetry(
    async () => {
      await dynamoClient.send(new UpdateItemCommand({
        TableName: registryTable,
        Key: {
          recordId: { S: recordId },
          recordType: { S: recordType },
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: 'attribute_exists(recordId)',
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { recordId, status },
  );
}

async function emitRegistryEvent(record: RegistryRecord, eventType: string, requestId: string): Promise<void> {
  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.agent-registry',
            DetailType: eventType,
            Detail: JSON.stringify({
              recordId: record.recordId,
              recordType: record.recordType,
              name: record.name,
              status: record.status,
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, recordId: record.recordId, eventType },
  );
}

async function processInsert(record: DynamoDBStreamRecord, requestId: string): Promise<void> {
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) {
    logWarn('No NewImage in INSERT record', { requestId, record });
    return;
  }

  const registryRecord: Partial<RegistryRecord> = {
    recordId: newImage.recordId?.S,
    recordType: newImage.recordType?.S as any,
    name: newImage.name?.S,
    description: newImage.description?.S,
    version: newImage.version?.S,
    ownerTeam: newImage.ownerTeam?.S,
    status: newImage.status?.S as any,
  };

  logInfo('Processing registry record insertion', { requestId, recordId: registryRecord.recordId });

  // Validate the record
  const validation = validateRecord(registryRecord);
  if (!validation.valid) {
    logWarn('Invalid registry record submitted', { requestId, recordId: registryRecord.recordId, errors: validation.errors });
    await updateRecordStatus(registryRecord.recordId!, registryRecord.recordType!, 'ERROR');
    return;
  }

  // Auto-approve if status is PENDING_APPROVAL and all required fields present
  if (registryRecord.status === 'PENDING_APPROVAL') {
    logInfo('Auto-approving valid registry record', { requestId, recordId: registryRecord.recordId });
    await updateRecordStatus(registryRecord.recordId!, registryRecord.recordType!, 'ACTIVE', 'registry-curator-auto');
    await emitRegistryEvent(registryRecord as RegistryRecord, 'RegistryRecordApproved', requestId);
  } else {
    await emitRegistryEvent(registryRecord as RegistryRecord, 'RegistryRecordCreated', requestId);
  }
}

async function processModify(record: DynamoDBStreamRecord, requestId: string): Promise<void> {
  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;

  if (!newImage || !oldImage) {
    logWarn('Missing image in MODIFY record', { requestId });
    return;
  }

  const recordId = newImage.recordId?.S;
  const recordType = newImage.recordType?.S;
  const newStatus = newImage.status?.S;
  const oldStatus = oldImage.status?.S;

  if (newStatus !== oldStatus) {
    logInfo('Registry record status changed', { requestId, recordId, oldStatus, newStatus });

    if (newStatus === 'ACTIVE') {
      await emitRegistryEvent(
        {
          recordId: recordId!,
          recordType: recordType as any,
          name: newImage.name?.S || '',
          description: newImage.description?.S || '',
          version: newImage.version?.S || '',
          ownerTeam: newImage.ownerTeam?.S || '',
          status: 'ACTIVE',
          metadata: {},
          tags: {},
        },
        'RegistryRecordApproved',
        requestId,
      );
    } else if (newStatus === 'INACTIVE' || newStatus === 'ERROR') {
      await emitRegistryEvent(
        {
          recordId: recordId!,
          recordType: recordType as any,
          name: newImage.name?.S || '',
          description: newImage.description?.S || '',
          version: newImage.version?.S || '',
          ownerTeam: newImage.ownerTeam?.S || '',
          status: newStatus as any,
          metadata: {},
          tags: {},
        },
        'RegistryRecordRevoked',
        requestId,
      );
    }
  }
}

export async function handler(event: DynamoDBStreamEvent, context: Context): Promise<void> {
  const requestId = context.awsRequestId;

  logInfo('Registry curator invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      switch (record.eventName) {
        case 'INSERT':
          await processInsert(record, requestId);
          break;
        case 'MODIFY':
          await processModify(record, requestId);
          break;
        case 'REMOVE':
          logInfo('Registry record removed', { requestId, recordId: record.dynamodb?.Keys?.recordId?.S });
          break;
        default:
          logWarn('Unknown DynamoDB stream event name', { requestId, eventName: record.eventName });
      }
    } catch (error) {
      logError('Failed to process registry record', error, { requestId, recordId: record.dynamodb?.Keys?.recordId?.S });
      // Continue processing other records (graceful degradation)
    }
  }

  logInfo('Registry curator completed', { requestId });
}
