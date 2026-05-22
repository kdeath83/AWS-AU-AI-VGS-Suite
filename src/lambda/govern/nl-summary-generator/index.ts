/**
 * src/lambda/govern/nl-summary-generator/index.ts
 * Uses Bedrock Claude to generate board-ready natural language summaries.
 * Memory: 512MB | Timeout: 120s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { NlSummaryGeneratorEvent, RiskPostureSummary } from '../../../shared/types';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const bedrockModelId = getEnvVar('BEDROCK_MODEL_ID');
const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');
const eventBusName = getEnvVar('EVENT_BUS_NAME');

interface SummaryPrompt {
  systemPrompt: string;
  userPrompt: string;
}

function buildSummaryPrompt(event: NlSummaryGeneratorEvent, data: string): SummaryPrompt {
  const systemPrompts: Record<string, string> = {
    BOARD: 'You are an expert risk advisor generating board-level summaries for an Australian Financial Services Institution. Use formal language, focus on strategic implications, regulatory obligations, and recommended board actions.',
    EXECUTIVE: 'You are a risk operations advisor generating executive summaries. Focus on operational metrics, key trends, and immediate actions required.',
    OPERATIONS: 'You are a security operations analyst generating detailed operational summaries. Include specific findings, technical details, and remediation steps.',
    REGULATOR: 'You are a compliance officer generating regulator-facing summaries. Focus on control effectiveness, evidence of compliance, and any regulatory gaps.',
  };

  const formatInstructions: Record<string, string> = {
    MARKDOWN: 'Format the output as Markdown with clear headings and bullet points.',
    JSON: 'Format the output as structured JSON with a summary, key_points, risks, and recommendations fields.',
    HTML: 'Format the output as HTML suitable for embedding in a web dashboard.',
  };

  const systemPrompt = `${systemPrompts[event.audience] || systemPrompts.BOARD} ${formatInstructions[event.outputFormat] || formatInstructions.MARKDOWN}`;

  const userPrompt = `Generate a ${event.summaryType} summary for the period ${event.timeRange.start} to ${event.timeRange.end}.

Data:
${data}

Maximum length: ${event.maxLengthWords || 500} words.

Summary:`;

  return { systemPrompt, userPrompt };
}

async function generateSummaryWithBedrock(prompt: SummaryPrompt, requestId: string): Promise<string> {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2000,
    temperature: 0.3,
    messages: [
      { role: 'user', content: prompt.userPrompt },
    ],
    system: prompt.systemPrompt,
  };

  const command = new InvokeModelCommand({
    modelId: bedrockModelId,
    body: JSON.stringify(payload),
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await withRetry(
    async () => bedrockClient.send(command),
    { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000 },
    { requestId },
  );

  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8'));
  return responseBody.content?.[0]?.text || responseBody.completion || '';
}

async function fetchSourceData(event: NlSummaryGeneratorEvent, requestId: string): Promise<string> {
  // For POC: return mock data. In production, fetch from evidence lake, QuickSight, Neptune.
  const mockRiskPosture: RiskPostureSummary = {
    overallScore: 87,
    categoryScores: {
      security: 92,
      compliance: 85,
      modelGovernance: 88,
      infrastructure: 90,
    },
    topRisks: [
      { riskId: 'SEC-001', riskName: 'Elevated GuardDuty findings on Lambda endpoints', severity: 'HIGH', remediationStatus: 'IN_PROGRESS' },
      { riskId: 'CMP-001', riskName: '2 Config rules non-compliant', severity: 'MEDIUM', remediationStatus: 'OPEN' },
    ],
    aiInventorySummary: {
      totalModels: 12,
      compliantModels: 10,
      modelsUnderReview: 2,
    },
    assuranceStatus: {
      totalControls: 24,
      compliantControls: 22,
      nonCompliantControls: 2,
      pendingControls: 0,
    },
    generatedAt: new Date().toISOString(),
  };

  return JSON.stringify(mockRiskPosture, null, 2);
}

async function storeGeneratedSummary(
  event: NlSummaryGeneratorEvent,
  summary: string,
  requestId: string,
): Promise<void> {
  const key = `nl-summaries/${event.summaryType}/${event.audience}/${Date.now()}.${event.outputFormat.toLowerCase()}`;

  await withRetry(
    async () => {
      await s3Client.send(new PutObjectCommand({
        Bucket: evidenceBucket,
        Key: key,
        Body: summary,
        ContentType: event.outputFormat === 'JSON' ? 'application/json' : 'text/plain',
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, summaryType: event.summaryType },
  );

  logInfo('NL summary stored', { requestId, key, summaryType: event.summaryType, audience: event.audience });
}

async function emitSummaryGeneratedEvent(
  event: NlSummaryGeneratorEvent,
  requestId: string,
): Promise<void> {
  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.governance',
            DetailType: 'NlSummaryGenerated',
            Detail: JSON.stringify({
              summaryType: event.summaryType,
              audience: event.audience,
              outputFormat: event.outputFormat,
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, summaryType: event.summaryType },
  );
}

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const event = messageBody as NlSummaryGeneratorEvent;

  logInfo('Processing NL summary generation', {
    requestId,
    summaryType: event.summaryType,
    audience: event.audience,
    outputFormat: event.outputFormat,
  });

  if (!event.summaryType || !event.timeRange || !event.audience) {
    logWarn('Skipping invalid summary request', { requestId, recordBody: record.body.substring(0, 500) });
    return;
  }

  // Fetch source data
  const sourceData = await fetchSourceData(event, requestId);

  // Build prompt
  const prompt = buildSummaryPrompt(event, sourceData);

  // Generate summary
  const summary = await generateSummaryWithBedrock(prompt, requestId);

  // Store summary
  await storeGeneratedSummary(event, summary, requestId);

  // Emit event
  await emitSummaryGeneratedEvent(event, requestId);

  logInfo('NL summary generation completed', {
    requestId,
    summaryType: event.summaryType,
    audience: event.audience,
    summaryLength: summary.length,
  });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const requestId = context.awsRequestId;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  logInfo('NL summary generator invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error) {
      logError('Failed to process NL summary record', error, { requestId, messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logInfo('NL summary generator completed', {
    requestId,
    processed: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
}
