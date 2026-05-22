/**
 * src/lambda/validate/agent-orchestrator/index.ts
 * Coordinates agent tasks via Bedrock AgentCore Runtime.
 * Memory: 512MB | Timeout: 300s
 */

import { SQSEvent, SQSRecord, Context, SQSBatchResponse } from 'aws-lambda';
import { BedrockAgentRuntimeClient, InvokeAgentCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry, CircuitBreaker } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { AgentOrchestratorEvent, RiskClassification } from '../../../shared/types';

const bedrockClient = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const eventBusName = getEnvVar('EVENT_BUS_NAME');
const securitySentinelAgentId = getEnvVar('SECURITY_SENTINEL_AGENT_ID');
const governanceAuditorAgentId = getEnvVar('GOVERNANCE_AUDITOR_AGENT_ID');

// Circuit breaker for Bedrock AgentCore calls
const bedrockCircuitBreaker = new CircuitBreaker('bedrock-agentcore', {
  failureThreshold: 5,
  recoveryTimeoutMs: 30000,
  halfOpenMaxCalls: 3,
});

interface AgentTaskResult {
  agentId: string;
  success: boolean;
  response?: string;
  error?: string;
}

async function invokeAgent(
  agentId: string,
  inputText: string,
  correlationId: string,
): Promise<AgentTaskResult> {
  const sessionId = `session-${correlationId}-${Date.now()}`;

  try {
    const response = await bedrockCircuitBreaker.execute(
      async () => {
        const command = new InvokeAgentCommand({
          agentId,
          agentAliasId: 'TSTALIASID', // Use test alias for POC
          sessionId,
          inputText,
          enableTrace: true,
        });
        return withRetry(
          async () => bedrockClient.send(command),
          { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
          { agentId, correlationId },
        );
      },
      { agentId, correlationId },
    );

    // Extract response text
    let responseText = '';
    if (response.completion) {
      for await (const chunk of response.completion) {
        if (chunk.chunk?.bytes) {
          responseText += Buffer.from(chunk.chunk.bytes).toString('utf-8');
        }
      }
    }

    return {
      agentId,
      success: true,
      response: responseText,
    };
  } catch (error) {
    return {
      agentId,
      success: false,
      error: (error as Error).message,
    };
  }
}

function resolveAgentId(targetId: string): string {
  switch (targetId) {
    case 'security-sentinel':
      return securitySentinelAgentId;
    case 'governance-auditor':
      return governanceAuditorAgentId;
    default:
      return targetId;
  }
}

async function executeTask(task: AgentOrchestratorEvent, requestId: string): Promise<AgentTaskResult[]> {
  const correlationId = task.correlationId;
  const results: AgentTaskResult[] = [];

  logInfo('Executing agent orchestration task', {
    requestId,
    correlationId,
    taskType: task.taskType,
    targetAgents: task.targetAgentIds,
    priority: task.priority,
  });

  // Build task-specific input text
  let inputText = '';
  switch (task.taskType) {
    case 'SECURITY_SCAN':
      inputText = `Perform a security scan. Input data: ${JSON.stringify(task.inputData)}`;
      break;
    case 'COMPLIANCE_CHECK':
      inputText = `Run a compliance check. Input data: ${JSON.stringify(task.inputData)}`;
      break;
    case 'INCIDENT_RESPONSE':
      inputText = `Respond to a security incident. Input data: ${JSON.stringify(task.inputData)}`;
      break;
    case 'AUDIT_EVIDENCE':
      inputText = `Collect and analyze audit evidence. Input data: ${JSON.stringify(task.inputData)}`;
      break;
    default:
      inputText = `Execute task. Input data: ${JSON.stringify(task.inputData)}`;
  }

  // Invoke each target agent
  for (const targetAgentId of task.targetAgentIds) {
    const resolvedAgentId = resolveAgentId(targetAgentId);
    const result = await invokeAgent(resolvedAgentId, inputText, correlationId);
    results.push(result);

    logInfo('Agent invocation result', {
      requestId,
      agentId: resolvedAgentId,
      success: result.success,
      hasResponse: !!result.response,
    });
  }

  return results;
}

async function emitOrchestrationSummary(
  task: AgentOrchestratorEvent,
  results: AgentTaskResult[],
  requestId: string,
): Promise<void> {
  const allSuccessful = results.every((r) => r.success);
  const summary = {
    correlationId: task.correlationId,
    taskType: task.taskType,
    totalAgents: task.targetAgentIds.length,
    successfulAgents: results.filter((r) => r.success).length,
    failedAgents: results.filter((r) => !r.success).length,
    allSuccessful,
    priority: task.priority,
    requestId,
    timestamp: new Date().toISOString(),
  };

  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.agent-orchestrator',
            DetailType: 'AgentOrchestrationComplete',
            Detail: JSON.stringify(summary),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, correlationId: task.correlationId },
  );
}

async function processRecord(record: SQSRecord, requestId: string): Promise<void> {
  const messageBody = JSON.parse(record.body);
  const task = messageBody as AgentOrchestratorEvent;

  if (!task.taskType || !task.targetAgentIds || task.targetAgentIds.length === 0) {
    logWarn('Skipping invalid orchestration task', { requestId, recordBody: record.body.substring(0, 500) });
    return;
  }

  const results = await executeTask(task, requestId);
  await emitOrchestrationSummary(task, results, requestId);

  logInfo('Agent orchestration task completed', {
    requestId,
    correlationId: task.correlationId,
    taskType: task.taskType,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
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
      logError('Failed to process orchestration record', error, { requestId, messageId: record.messageId });
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
