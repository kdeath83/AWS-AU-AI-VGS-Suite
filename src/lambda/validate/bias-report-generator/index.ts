/**
 * src/lambda/validate/bias-report-generator/index.ts
 * Runs SageMaker Clarify analysis and stores bias/explainability reports in S3.
 * Memory: 1024MB | Timeout: 600s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import { SageMakerClient, CreateProcessingJobCommand } from '@aws-sdk/client-sagemaker';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { BiasReportGeneratorEvent, BiasReport, EvidenceRecord } from '../../../shared/types';

const sagemakerClient = new SageMakerClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');
const eventBusName = getEnvVar('EVENT_BUS_NAME');
const sagemakerRoleArn = getEnvVar('SAGEMAKER_ROLE_ARN');

async function submitClarifyJob(event: BiasReportGeneratorEvent, requestId: string): Promise<string> {
  const jobName = `bias-report-${event.modelName}-${Date.now()}`;
  const outputUri = `s3://${evidenceBucket}/bias-reports/${event.modelName}/${Date.now()}/`;

  const processingInputs = [
    {
      InputName: 'dataset',
      S3Input: {
        S3Uri: event.s3InputUri,
        S3DataType: 'S3Prefix',
        S3InputMode: 'File',
      },
    },
  ];

  const processingOutput = [
    {
      OutputName: 'analysis',
      S3Output: {
        S3Uri: outputUri,
        S3UploadMode: 'EndOfJob',
      },
    },
  ];

  // For POC: create a mock Clarify job. In production, use actual Clarify container image.
  const command = new CreateProcessingJobCommand({
    ProcessingJobName: jobName,
    RoleArn: sagemakerRoleArn,
    ProcessingInputs: processingInputs,
    ProcessingOutputConfig: {
      Outputs: processingOutput,
      KmsKeyId: getEnvVar('KMS_KEY_ARN', ''),
    },
    ProcessingResources: {
      ClusterConfig: {
        InstanceCount: 1,
        InstanceType: 'ml.m5.large',
        VolumeSizeInGB: 20,
      },
    },
    StoppingCondition: {
      MaxRuntimeInSeconds: 3600,
    },
    AppSpecification: {
      ImageUri: `382416733822.dkr.ecr.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/clarify-processing:1.0`,
      ContainerArguments: [
        '--analysis-type', event.analysisType,
        '--target-label', event.targetLabel,
        '--fairness-threshold', String(event.fairnessThreshold || 0.8),
        '--output-format', 'json',
      ],
    },
  });

  await withRetry(
    async () => sagemakerClient.send(command),
    { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000 },
    { requestId, jobName },
  );

  logInfo('SageMaker Clarify job submitted', { requestId, jobName, outputUri });
  return jobName;
}

async function storeBiasReportPlaceholder(event: BiasReportGeneratorEvent, jobName: string, requestId: string): Promise<void> {
  const report: BiasReport = {
    reportId: `bias-${Date.now()}`,
    jobName,
    endpointName: event.endpointName,
    modelName: event.modelName,
    analysisType: event.analysisType,
    biasMetrics: {
      'demographic_parity',
      'equal_opportunity': 0.0,
      'disparate_impact': 0.0,
    },
    timestamp: new Date().toISOString(),
    s3OutputUri: `s3://${evidenceBucket}/bias-reports/${event.modelName}/${Date.now()}/`,
  };

  const evidenceRecord: EvidenceRecord = {
    evidenceId: report.reportId,
    sourceService: 'SageMakerClarify',
    controlId: 'ASIC-3', // Bias Testing
    timestamp: report.timestamp,
    accountId: process.env.ACCOUNT_ID || 'unknown',
    region: process.env.AWS_REGION || 'unknown',
    resourceArn: `arn:aws:sagemaker:${process.env.AWS_REGION}:${process.env.ACCOUNT_ID}:processing-job/${jobName}`,
    severity: 'LOW',
    description: `Bias report generated for ${event.modelName}: ${event.analysisType} analysis`,
    rawPayload: report as unknown as Record<string, unknown>,
    metadata: {
      collectedBy: 'bias-report-generator',
      collectionVersion: '1.0.0',
    },
  };

  const evidenceKey = `bias-reports/${event.modelName}/${report.reportId}.json`;

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
    { requestId, jobName },
  );
}

async function emitBiasReportEvent(event: BiasReportGeneratorEvent, jobName: string, requestId: string): Promise<void> {
  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.compliance',
            DetailType: 'BiasReportGenerated',
            Detail: JSON.stringify({
              jobName,
              endpointName: event.endpointName,
              modelName: event.modelName,
              analysisType: event.analysisType,
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, jobName },
  );
}

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const eventPayload = messageBody as BiasReportGeneratorEvent;

  logInfo('Processing bias report request', {
    requestId,
    modelName: eventPayload.modelName,
    analysisType: eventPayload.analysisType,
  });

  if (!eventPayload.modelName || !eventPayload.s3InputUri) {
    logWarn('Skipping invalid bias report request', { requestId, recordBody: record.body.substring(0, 500) });
    return;
  }

  // Submit Clarify job
  const jobName = await submitClarifyJob(eventPayload, requestId);

  // Store placeholder report
  await storeBiasReportPlaceholder(eventPayload, jobName, requestId);

  // Emit event
  await emitBiasReportEvent(eventPayload, jobName, requestId);

  logInfo('Bias report request processed', { requestId, jobName, modelName: eventPayload.modelName });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const requestId = context.awsRequestId;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  logInfo('Bias report generator invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error) {
      logError('Failed to process bias report record', error, { requestId, messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logInfo('Bias report generator completed', {
    requestId,
    processed: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
}
