/**
 * src/lambda/govern/dashboard-data-prep/index.ts
 * Aggregates data from all stacks into QuickSight datasets.
 * Memory: 1024MB | Timeout: 300s
 */

import { EventBridgeEvent, Context } from 'aws-lambda';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { logInfo, logError, logWarn, withRetry, chunkArray } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { DashboardDataPrepEvent, DashboardMetric, RiskPostureSummary } from '../../../shared/types';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const cloudWatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });

const evidenceBucket = getEnvVar('EVIDENCE_BUCKET');
const datasetPrefix = getEnvVar('DASHBOARD_DATASET_PREFIX', 'quicksight/datasets/');

interface AggregatedMetrics {
  securityFindings: number;
  complianceViolations: number;
  modelDrifts: number;
  patchCompliant: number;
  patchNonCompliant: number;
  totalAgents: number;
  activeAgents: number;
  totalControls: number;
  compliantControls: number;
  nonCompliantControls: number;
}

async function aggregateSecurityMetrics(requestId: string): Promise<AggregatedMetrics> {
  const metrics: AggregatedMetrics = {
    securityFindings: 0,
    complianceViolations: 0,
    modelDrifts: 0,
    patchCompliant: 0,
    patchNonCompliant: 0,
    totalAgents: 0,
    activeAgents: 0,
    totalControls: 0,
    compliantControls: 0,
    nonCompliantControls: 0,
  };

  // Count evidence files by type
  const prefixes = [
    'guardduty/',
    'patch-compliance/',
    'model-drift/',
    'bias-reports/',
    'audit-evidence/',
  ];

  for (const prefix of prefixes) {
    try {
      const response = await s3Client.send(new ListObjectsV2Command({
        Bucket: evidenceBucket,
        Prefix: prefix,
        MaxKeys: 1000,
      }));

      const count = response.Contents?.length || 0;
      switch (prefix) {
        case 'guardduty/':
          metrics.securityFindings = count;
          break;
        case 'patch-compliance/':
          // Count compliant vs non-compliant
          break;
        case 'model-drift/':
          metrics.modelDrifts = count;
          break;
        case 'audit-evidence/':
          // Count by compliance status
          break;
      }

      logInfo(`Aggregated ${count} items from ${prefix}`, { requestId, prefix });
    } catch (error) {
      logWarn(`Failed to list objects in ${prefix}`, { requestId, prefix, error: (error as Error).message });
      // Continue with other prefixes (graceful degradation)
    }
  }

  return metrics;
}

async function fetchCloudWatchMetrics(requestId: string): Promise<DashboardMetric[]> {
  const metrics: DashboardMetric[] = [];
  const namespace = 'AWS/Lambda';

  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 5 * 60 * 1000); // Last 5 minutes

    const command = new GetMetricDataCommand({
      MetricDataQueries: [
        {
          Id: 'lambda_errors',
          MetricStat: {
            Metric: {
              Namespace: namespace,
              MetricName: 'Errors',
              // Dimension removed — wildcards not supported. Aggregate across all functions.
            },
            Period: 300,
            Stat: 'Sum',
          },
        },
        {
          Id: 'lambda_invocations',
          MetricStat: {
            Metric: {
              Namespace: namespace,
              MetricName: 'Invocations',
              // Dimension removed — wildcards not supported. Aggregate across all functions.
            },
            Period: 300,
            Stat: 'Sum',
          },
        },
      ],
      StartTime: startTime,
      EndTime: endTime,
    });

    const response = await withRetry(
      async () => cloudWatchClient.send(command),
      { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
      { requestId },
    );

    for (const result of response.MetricDataResults || []) {
      const latestValue = result.Values?.[result.Values.length - 1];
      if (latestValue !== undefined) {
        metrics.push({
          metricId: result.Id!,
          metricName: result.Label || result.Id!,
          value: latestValue,
          trend: 'FLAT',
          timestamp: new Date().toISOString(),
          dimension: 'Lambda',
        });
      }
    }
  } catch (error) {
    logWarn('Failed to fetch CloudWatch metrics', { requestId, error: (error as Error).message });
  }

  return metrics;
}

async function buildRiskPostureSummary(
  metrics: AggregatedMetrics,
  cwMetrics: DashboardMetric[],
  requestId: string,
): Promise<RiskPostureSummary> {
  const overallScore = Math.max(0, 100 - (metrics.securityFindings * 2 + metrics.complianceViolations * 5 + metrics.modelDrifts * 10));

  const summary: RiskPostureSummary = {
    overallScore,
    categoryScores: {
      security: Math.max(0, 100 - metrics.securityFindings * 2),
      compliance: Math.max(0, 100 - metrics.complianceViolations * 5),
      modelGovernance: Math.max(0, 100 - metrics.modelDrifts * 10),
      infrastructure: Math.max(0, 100 - (metrics.patchNonCompliant * 3)),
    },
    topRisks: [],
    aiInventorySummary: {
      totalModels: metrics.totalAgents,
      compliantModels: metrics.activeAgents,
      modelsUnderReview: 0,
    },
    assuranceStatus: {
      totalControls: metrics.totalControls,
      compliantControls: metrics.compliantControls,
      nonCompliantControls: metrics.nonCompliantControls,
      pendingControls: metrics.totalControls - metrics.compliantControls - metrics.nonCompliantControls,
    },
    generatedAt: new Date().toISOString(),
  };

  // Add top risks if thresholds exceeded
  if (metrics.securityFindings > 5) {
    summary.topRisks.push({
      riskId: 'SEC-001',
      riskName: 'Elevated Security Findings',
      severity: 'HIGH',
      remediationStatus: 'IN_PROGRESS',
    });
  }
  if (metrics.modelDrifts > 0) {
    summary.topRisks.push({
      riskId: 'MDL-001',
      riskName: 'Model Drift Detected',
      severity: 'HIGH',
      remediationStatus: 'OPEN',
    });
  }
  if (metrics.complianceViolations > 0) {
    summary.topRisks.push({
      riskId: 'CMP-001',
      riskName: 'Compliance Violations',
      severity: 'MEDIUM',
      remediationStatus: 'IN_PROGRESS',
    });
  }

  return summary;
}

async function storeDashboardDatasets(
  summary: RiskPostureSummary,
  metrics: DashboardMetric[],
  requestId: string,
): Promise<void> {
  const datasets = {
    'risk-posture-summary': summary,
    'cloudwatch-metrics': metrics,
  };

  for (const [name, data] of Object.entries(datasets)) {
    const key = `${datasetPrefix}${name}/${Date.now()}.json`;
    await withRetry(
      async () => {
        await s3Client.send(new PutObjectCommand({
          Bucket: evidenceBucket,
          Key: key,
          Body: JSON.stringify(data),
          ContentType: 'application/json',
        }));
      },
      { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
      { requestId, datasetName: name },
    );

    logInfo('Dashboard dataset stored', { requestId, datasetName: name, key });
  }
}

export async function handler(_event: EventBridgeEvent<string, unknown>, context: Context): Promise<void> {
  const requestId = context.awsRequestId;

  logInfo('Dashboard data prep invoked', { requestId });

  try {
    // Aggregate metrics from all evidence sources
    const aggregatedMetrics = await aggregateSecurityMetrics(requestId);

    // Fetch CloudWatch metrics
    const cloudWatchMetrics = await fetchCloudWatchMetrics(requestId);

    // Build risk posture summary
    const riskPosture = await buildRiskPostureSummary(aggregatedMetrics, cloudWatchMetrics, requestId);

    // Store datasets for QuickSight
    await storeDashboardDatasets(riskPosture, cloudWatchMetrics, requestId);

    logInfo('Dashboard data prep completed', {
      requestId,
      overallScore: riskPosture.overallScore,
      topRisksCount: riskPosture.topRisks.length,
    });
  } catch (error) {
    logError('Dashboard data prep failed', error, { requestId });
    throw error;
  }
}
