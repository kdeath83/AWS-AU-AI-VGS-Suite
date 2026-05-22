/**
 * src/lambda/govern/escalation-router/index.ts
 * Routes alerts based on risk classification and SLA.
 * Memory: 256MB | Timeout: 60s
 */

import { EventBridgeEvent, Context } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { logInfo, logError, logWarn, withRetry } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { EscalationEvent, RiskClassification } from '../../../shared/types';

const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION });

const escalationTopicArn = getEnvVar('ESCALATION_TOPIC_ARN');
const eventBusName = getEnvVar('EVENT_BUS_NAME');

// SLA minutes per risk classification
const SLA_MINUTES: Record<RiskClassification, number> = {
  LOW: 240,
  MEDIUM: 60,
  HIGH: 15,
  CRITICAL: 5,
};

// Target channels per classification
const TARGET_CHANNELS: Record<RiskClassification, string[]> = {
  LOW: ['#ai-ops-alerts'],
  MEDIUM: ['#ai-ops-alerts', '#security-team'],
  HIGH: ['#ai-ops-alerts', '#security-team', '#incident-response'],
  CRITICAL: ['#ai-ops-alerts', '#security-team', '#incident-response', '#executive-alerts'],
};

function formatEscalationMessage(escalation: EscalationEvent): string {
  const severity = escalation.riskClassification;
  const sla = SLA_MINUTES[severity];
  const channels = TARGET_CHANNELS[severity];

  return `
🚨 **${severity} RISK ESCALATION** 🚨

**Event ID:** ${escalation.eventId}
**Source:** ${escalation.eventSource}
**Type:** ${escalation.eventType}
**SLA:** ${sla} minutes
**Channels:** ${channels.join(', ')}
**Description:** ${escalation.description}
**Affected Resources:** ${escalation.affectedResources.join(', ')}
**Timestamp:** ${escalation.timestamp}

Please acknowledge and begin remediation immediately.
`;
}

async function sendSNSNotification(escalation: EscalationEvent, requestId: string): Promise<void> {
  const message = formatEscalationMessage(escalation);

  await withRetry(
    async () => {
      await snsClient.send(new PublishCommand({
        TopicArn: escalationTopicArn,
        Subject: `[${escalation.riskClassification}] AI VGS Alert: ${escalation.eventType}`,
        Message: message,
        MessageAttributes: {
          riskClassification: { DataType: 'String', StringValue: escalation.riskClassification },
          eventType: { DataType: 'String', StringValue: escalation.eventType },
          eventId: { DataType: 'String', StringValue: escalation.eventId },
          slaMinutes: { DataType: 'Number', StringValue: String(SLA_MINUTES[escalation.riskClassification]) },
        },
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, eventId: escalation.eventId },
  );

  logInfo('SNS escalation notification sent', {
    requestId,
    eventId: escalation.eventId,
    riskClassification: escalation.riskClassification,
    slaMinutes: SLA_MINUTES[escalation.riskClassification],
  });
}

async function emitEscalationEvent(escalation: EscalationEvent, requestId: string): Promise<void> {
  await withRetry(
    async () => {
      await eventBridgeClient.send(new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: 'aws-au-ai-vgs-suite.governance',
            DetailType: 'EscalationRouted',
            Detail: JSON.stringify({
              eventId: escalation.eventId,
              riskClassification: escalation.riskClassification,
              slaMinutes: SLA_MINUTES[escalation.riskClassification],
              targetChannels: TARGET_CHANNELS[escalation.riskClassification],
              requestId,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }));
    },
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    { requestId, eventId: escalation.eventId },
  );
}

function validateEscalationEvent(event: EscalationEvent): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!event.eventId) errors.push('Missing eventId');
  if (!event.eventSource) errors.push('Missing eventSource');
  if (!event.eventType) errors.push('Missing eventType');
  if (!event.riskClassification) errors.push('Missing riskClassification');
  if (!event.description) errors.push('Missing description');
  if (!Object.values(RiskClassification).includes(event.riskClassification)) {
    errors.push(`Invalid riskClassification: ${event.riskClassification}`);
  }
  return { valid: errors.length === 0, errors };
}

export async function handler(event: EventBridgeEvent<string, unknown>, context: Context): Promise<void> {
  const requestId = context.awsRequestId;
  const escalationDetail = (event as any).detail as EscalationEvent;

  logInfo('Escalation router invoked', {
    requestId,
    eventId: escalationDetail?.eventId,
    riskClassification: escalationDetail?.riskClassification,
  });

  try {
    // Validate input
    const validation = validateEscalationEvent(escalationDetail);
    if (!validation.valid) {
      logWarn('Invalid escalation event', { requestId, errors: validation.errors });
      return;
    }

    // Send SNS notification
    await sendSNSNotification(escalationDetail, requestId);

    // Emit escalation routed event
    await emitEscalationEvent(escalationDetail, requestId);

    logInfo('Escalation routing completed', {
      requestId,
      eventId: escalationDetail.eventId,
      riskClassification: escalationDetail.riskClassification,
    });
  } catch (error) {
    logError('Escalation routing failed', error, { requestId, eventId: escalationDetail?.eventId });
    throw error;
  }
}
