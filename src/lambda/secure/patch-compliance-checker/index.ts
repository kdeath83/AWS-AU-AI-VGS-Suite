/**
 * src/lambda/secure/patch-compliance-checker/index.ts
 * Checks Systems Manager Patch Manager compliance and reports findings.
 * Memory: 256MB | Timeout: 60s
 */

import { EventBridgeEvent, Context } from 'aws-lambda';
import { SSMClient, DescribeInstancePatchesCommand, DescribePatchBaselinesCommand } from '@aws-sdk/client-ssm';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, withRetry } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { ComplianceStatus, EvidenceRecord } from '../../../shared/types';

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');
const eventBusName = getEnvVar('EVENT_BUS_NAME');

interface PatchComplianceResult {
  instanceId: string;
  compliant: boolean;
  missingPatchCount: number;
  installedPatchCount: number;
  failedPatchCount: number;
  lastScanTime?: string;
}

async function getInstancePatchCompliance(instanceId: string): Promise<PatchComplianceResult> {
  const command = new DescribeInstancePatchesCommand({
    InstanceId: instanceId,
    Filters: [{ Key: 'State', Values: ['Missing', 'Failed', 'InstalledRejected'] }],
  });

  const response = await ssmClient.send(command);

  const missingCount = response.Patches?.filter((p) => p.State === 'Missing').length || 0;
  const failedCount = response.Patches?.filter((p) => p.State === 'Failed').length || 0;
  const installedCount = response.Patches?.filter((p) => p.State === 'Installed').length || 0;

  return {
    instanceId,
    compliant: missingCount === 0 && failedCount === 0,
    missingPatchCount: missingCount,
    installedPatchCount: installedCount,
    failedPatchCount: failedCount,
    lastScanTime: response.Patches?.[0]?.InstalledTime?.toISOString(),
  };
}

async function storeComplianceEvidence(result: PatchComplianceResult, requestId: string): Promise<void> {
  const evidenceRecord: EvidenceRecord = {
    evidenceId: `patch-${result.instanceId}-${Date.now()}`,
    sourceService: 'SystemsManager',
    controlId: 'CPS234-4', // Control Implementation
    timestamp: new Date().toISOString(),
    accountId: process.env.ACCOUNT_ID || 'unknown',
    region: process.env.AWS_REGION || 'unknown',
    resourceArn: `arn:aws:ec2:${process.env.AWS_REGION}:${process.env.ACCOUNT_ID}:instance/${result.instanceId}`,
    severity: result.compliant ? 'LOW' : 'HIGH',
    description: `Patch compliance for ${result.instanceId}: ${result.missingPatchCount} missing, ${result.failedPatchCount} failed`,
    rawPayload: result as unknown as Record<string, unknown>,
    metadata: {
      collectedBy: 'patch-compliance-checker',
      collectionVersion: '1.0.0',
    },
  };

  const evidenceKey = `patch-compliance/${result.instanceId}/${Date.now()}.json`;

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
    { requestId, instanceId: result.instanceId },
  );
}

async function emitComplianceEvent(result: PatchComplianceResult, requestId: string): Promise<void> {
  if (result.compliant) return;

  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.compliance',
            DetailType: 'PatchComplianceViolation',
            Detail: JSON.stringify({
              instanceId: result.instanceId,
              missingPatchCount: result.missingPatchCount,
              failedPatchCount: result.failedPatchCount,
              riskClassification: result.missingPatchCount > 10 ? 'HIGH' : 'MEDIUM',
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, instanceId: result.instanceId },
  );
}

export async function handler(_event: EventBridgeEvent<string, unknown>, context: Context): Promise<void> {
  const requestId = context.awsRequestId;

  logInfo('Patch compliance checker invoked', { requestId });

  try {
    // Get managed instances
    const baselineResponse = await ssmClient.send(new DescribePatchBaselinesCommand({
      Filters: [{ Key: 'NAME_PREFIX', Values: ['aws-au-ai-vgs-suite'] }],
    }));

    // For POC: check a placeholder instance ID
    // In production, iterate over all managed instances
    const instanceIds = ['i-placeholder-001'];

    for (const instanceId of instanceIds) {
      try {
        const compliance = await getInstancePatchCompliance(instanceId);

        logInfo('Patch compliance result', {
          requestId,
          instanceId: compliance.instanceId,
          compliant: compliance.compliant,
          missing: compliance.missingPatchCount,
        });

        await storeComplianceEvidence(compliance, requestId);
        await emitComplianceEvent(compliance, requestId);
      } catch (instanceError) {
        logError('Failed to check instance patch compliance', instanceError, { requestId, instanceId });
        // Continue to next instance (graceful degradation)
      }
    }

    logInfo('Patch compliance checker completed', { requestId });
  } catch (error) {
    logError('Patch compliance checker failed', error, { requestId });
    throw error;
  }
}
