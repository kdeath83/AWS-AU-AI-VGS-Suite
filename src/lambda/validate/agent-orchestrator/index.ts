/**
 * src/lambda/validate/agent-orchestrator/index.ts
 * Coordinates agent tasks via AgentCore Harness with model load balancing.
 * Routes tasks to models based on priority and task type.
 *
 * Memory: 512MB | Timeout: 300s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry, CircuitBreaker } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { AgentOrchestratorEvent, RiskClassification } from '../../../shared/types';
import {
  selectModel,
  buildHarnessModelPayload,
  ModelConfig,
} from '../../../shared/model-router';

const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const eventBusName = getEnvVar('EVENT_BUS_NAME');
const securityHarnessArn = getEnvVar('SECURITY_HARNESS_ARN');
const governanceHarnessArn = getEnvVar('GOVERNANCE_HARNESS_ARN');
// Optional: AgentCore Identity API key credential ARN for 3rd-party providers
const identityApiKeyArn = process.env.IDENTITY_API_KEY_ARN || undefined;

// Circuit breaker for AgentCore Harness calls
const harnessCircuitBreaker = new CircuitBreaker('agentcore-harness', {
  failureThreshold: 5,
  recoveryTimeoutMs: 30000,
  halfOpenMaxCalls: 3,
});

// ── Types ──────────────────────────────────────────────────────────────────

interface HarnessResult {
  harnessArn: string;
  success: boolean;
  response?: string;
  modelUsed: string;
  error?: string;
  attempts: number;
  routingMode: 'weighted' | 'failover';
}

interface HarnessInvocationTracking {
  harnessArn: string;
  modelConfig: ModelConfig;
  attempt: number;
  error?: string;
}

// ── Harness Resolution ─────────────────────────────────────────────────────

/** Maps logical agent names to harness ARNs */
function resolveHarnessArn(agentName: string): string {
  switch (agentName) {
    case 'security-sentinel':
      return securityHarnessArn;
    case 'governance-auditor':
      return governanceHarnessArn;
    default:
      throw new Error(`Unknown harness target: ${agentName}`);
  }
}

/** Picks the right system prompt based on harness type */
function getSystemPrompt(agentName: string): string {
  switch (agentName) {
    case 'security-sentinel':
      return `You are the Security Sentinel, an AI security monitoring agent for an Australian Financial Services Institution.
Your responsibilities:
1. Monitor AI endpoints for anomalous behavior, prompt injection attempts, and data exfiltration
2. Read and analyze GuardDuty findings related to AI workloads
3. Read and analyze Inspector vulnerability scan results
4. Generate security incident reports with severity classification
5. Escalate critical findings via EventBridge

Always comply with APRA CPS 234 security requirements. Be concise and direct.`;
    case 'governance-auditor':
      return `You are the Governance Auditor, a compliance validation agent for an Australian Financial Services Institution.
Your responsibilities:
1. Validate compliance controls against APRA CPS 234 and CPS 230 frameworks
2. Read Audit Manager assessment results and evidence
3. Read AWS Config compliance rules and evaluations
4. Identify compliance gaps and recommend remediation
5. Generate board-ready compliance summaries

Always provide evidence-based conclusions. Be concise and direct.`;
    default:
      return '';
  }
}

// ── Harness Invocation with Fallback ────────────────────────────────────────

async function invokeHarnessWithFallback(
  harnessArn: string,
  agentName: string,
  inputText: string,
  correlationId: string,
  priority: RiskClassification,
  taskType: string,
): Promise<HarnessResult> {
  const sessionId = `session-${correlationId}-${Date.now()}`;
  const route = selectModel(taskType, priority);
  const { primary, fallbacks } = route;
  const modelChain = [primary, ...fallbacks];

  const tracking: HarnessInvocationTracking[] = [];

  for (let i = 0; i < modelChain.length; i++) {
    const modelConfig = modelChain[i];
    const attempt = i + 1;

    try {
      const result = await harnessCircuitBreaker.execute(
        async () => {
          const modelPayload = buildHarnessModelPayload(
            identityApiKeyArn
              ? { ...modelConfig, apiKeyArn: identityApiKeyArn }
              : modelConfig,
          );

          const command = new InvokeHarnessCommand({
            harnessArn,
            runtimeSessionId: sessionId,
            model: modelPayload,
            systemPrompt: [{ text: getSystemPrompt(agentName) }],
            messages: [
              { role: 'user', content: [{ text: inputText }] },
            ],
          });

          return withRetry(
            async () => agentCoreClient.send(command),
            { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 3000 },
            { harnessArn, modelId: modelConfig.modelId, correlationId, attempt },
          );
        },
        { harnessArn, modelId: modelConfig.modelId, correlationId, attempt },
      );

      // Extract response from streaming completion
      let responseText = '';
      if (result.completion) {
        for await (const chunk of result.completion) {
          if (chunk.chunk?.bytes) {
            responseText += Buffer.from(chunk.chunk.bytes).toString('utf-8');
          }
        }
      }

      logInfo('Harness invocation succeeded', {
        correlationId,
        harnessArn: harnessArn.substring(harnessArn.lastIndexOf(':') + 1),
        model: modelConfig.modelId,
        attempt,
        provider: modelConfig.provider,
        routingMode: route.mode,
        ...(route.weightedPool ? { weightedPool: route.weightedPool } : {}),
      });

      return {
        harnessArn,
        success: true,
        response: responseText,
        modelUsed: modelConfig.modelId,
        attempts: attempt,
        routingMode: route.mode,
      };
    } catch (error) {
      const errMsg = (error as Error).message;
      tracking.push({ harnessArn, modelConfig, attempt, error: errMsg });

      logWarn('Harness invocation failed, trying fallback', {
        correlationId,
        model: modelConfig.modelId,
        attempt,
        error: errMsg,
        fallbacksRemaining: modelChain.length - i - 1,
      });

      // Continue to next model in the fallback chain
    }
  }

  // All models exhausted
  logError('All harness models exhausted', new Error('No fallbacks remaining'), {
    correlationId,
    harnessArn: harnessArn.substring(harnessArn.lastIndexOf(':') + 1),
    attempts: tracking,
  });

  return {
    harnessArn,
    success: false,
    error: `All ${modelChain.length} models failed. Last: ${tracking[tracking.length - 1]?.error}`,
    modelUsed: modelChain[modelChain.length - 1].modelId,
    attempts: modelChain.length,
    routingMode: route.mode,
  };
}

// ── Task Builder ───────────────────────────────────────────────────────────

function buildTaskInput(task: AgentOrchestratorEvent): string {
  switch (task.taskType) {
    case 'SECURITY_SCAN':
      return `Perform a security scan. Input data: ${JSON.stringify(task.inputData)}`;
    case 'COMPLIANCE_CHECK':
      return `Run a compliance check against APRA CPS 234/230. Input data: ${JSON.stringify(task.inputData)}`;
    case 'INCIDENT_RESPONSE':
      return `Respond to a security incident. Analyze and recommend actions. Input data: ${JSON.stringify(task.inputData)}`;
    case 'AUDIT_EVIDENCE':
      return `Collect and analyze audit evidence. Input data: ${JSON.stringify(task.inputData)}`;
    default:
      return `Execute task. Input data: ${JSON.stringify(task.inputData)}`;
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────

interface OrchestrationResult {
  agentName: string;
  harnessResult: HarnessResult;
}

async function executeTask(
  task: AgentOrchestratorEvent,
  requestId: string,
): Promise<OrchestrationResult[]> {
  const correlationId = task.correlationId;
  const results: OrchestrationResult[] = [];
  const inputText = buildTaskInput(task);

  logInfo('Executing agent orchestration task', {
    requestId,
    correlationId,
    taskType: task.taskType,
    targetAgents: task.targetAgentIds,
    priority: task.priority,
  });

  for (const targetAgentId of task.targetAgentIds) {
    const harnessArn = resolveHarnessArn(targetAgentId);
    const harnessResult = await invokeHarnessWithFallback(
      harnessArn,
      targetAgentId,
      inputText,
      correlationId,
      task.priority,
      task.taskType,
    );

    results.push({ agentName: targetAgentId, harnessResult });

    logInfo('Agent invocation result', {
      requestId,
      agentName: targetAgentId,
      success: harnessResult.success,
      modelUsed: harnessResult.modelUsed,
      attempts: harnessResult.attempts,
      hasResponse: !!harnessResult.response,
    });
  }

  return results;
}

// ── Event Emission ─────────────────────────────────────────────────────────

async function emitOrchestrationSummary(
  task: AgentOrchestratorEvent,
  results: OrchestrationResult[],
  requestId: string,
): Promise<void> {
  const allSuccessful = results.every((r) => r.harnessResult.success);
  const summary = {
    correlationId: task.correlationId,
    taskType: task.taskType,
    priority: task.priority,
    totalAgents: task.targetAgentIds.length,
    successfulAgents: results.filter((r) => r.harnessResult.success).length,
    failedAgents: results.filter((r) => !r.harnessResult.success).length,
    allSuccessful,
    modelsUsed: results.map((r) => ({
      agentName: r.agentName,
      model: r.harnessResult.modelUsed,
      attempts: r.harnessResult.attempts,
      success: r.harnessResult.success,
      routingMode: r.harnessResult.routingMode,
    })),
    requestId,
    timestamp: new Date().toISOString(),
  };

  await withRetry(
    async () => {
      await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: eventBusName,
              Source: 'aws-au-ai-vgs-suite.agent-orchestrator',
              DetailType: 'AgentOrchestrationComplete',
              Detail: JSON.stringify(summary),
            },
          ],
        }),
      );
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, correlationId: task.correlationId },
  );
}

// ── SQS Handler ────────────────────────────────────────────────────────────

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const task = messageBody as AgentOrchestratorEvent;

  if (!task.taskType || !task.targetAgentIds || task.targetAgentIds.length === 0) {
    logWarn('Skipping invalid orchestration task', {
      requestId,
      recordBody: record.body.substring(0, 500),
    });
    return;
  }

  const results = await executeTask(task, requestId);
  await emitOrchestrationSummary(task, results, requestId);

  logInfo('Agent orchestration task completed', {
    requestId,
    correlationId: task.correlationId,
    taskType: task.taskType,
    priority: task.priority,
    successful: results.filter((r) => r.harnessResult.success).length,
    failed: results.filter((r) => !r.harnessResult.success).length,
  });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const requestId = context.awsRequestId;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  logInfo('Agent orchestrator invoked', { requestId, recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error) {
      logError('Failed to process orchestration record', error, {
        requestId,
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logInfo('Agent orchestrator completed', {
    requestId,
    processed: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
}
