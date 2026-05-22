/**
 * src/lambda/secure/ai-resource-tagger/index.ts
 * AWS Config custom rule: validates that AI resources have required tags.
 * Required tags: Owner, DataClassification, ModelVersion
 */

import { ConfigServiceClient, PutEvaluationsCommand } from '@aws-sdk/client-config-service';

const REQUIRED_TAGS = (process.env.REQUIRED_TAGS || 'Owner,DataClassification,ModelVersion').split(',');
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

interface ConfigurationItem {
  resourceType: string;
  resourceId: string;
  tags?: Record<string, string>;
}

interface ConfigEvent {
  invokingEvent: string;
  ruleParameters?: string;
  resultToken: string;
  eventLeftScope: boolean;
}

function log(level: string, message: string, data?: Record<string, unknown>): void {
  if (LOG_LEVEL === 'DEBUG' || level !== 'DEBUG') {
    console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data }));
  }
}

export const handler = async (event: ConfigEvent): Promise<void> => {
  log('INFO', 'Starting AI resource tagging evaluation', { resultToken: event.resultToken });

  try {
    const invokingEvent = JSON.parse(event.invokingEvent);
    const configurationItem: ConfigurationItem = invokingEvent.configurationItem;

    if (!configurationItem) {
      log('ERROR', 'No configurationItem in invokingEvent');
      throw new Error('Missing configurationItem');
    }

    const tags = configurationItem.tags || {};
    const missingTags = REQUIRED_TAGS.filter((tag) => !tags[tag]);

    const complianceType = missingTags.length === 0 ? 'COMPLIANT' : 'NON_COMPLIANT';
    const annotation = missingTags.length === 0
      ? 'All required AI resource tags present'
      : `Missing required tags: ${missingTags.join(', ')}`;

    log('INFO', 'Evaluation complete', {
      resourceId: configurationItem.resourceId,
      resourceType: configurationItem.resourceType,
      complianceType,
      annotation,
    });

    const configClient = new ConfigServiceClient({});
    await configClient.send(new PutEvaluationsCommand({
      Evaluations: [
        {
          ComplianceResourceType: configurationItem.resourceType,
          ComplianceResourceId: configurationItem.resourceId,
          ComplianceType: complianceType,
          Annotation: annotation,
          OrderingTimestamp: new Date(),
        },
      ],
      ResultToken: event.resultToken,
    }));

    log('INFO', 'Evaluation submitted to Config');
  } catch (error) {
    log('ERROR', 'Evaluation failed', { error: (error as Error).message });
    throw error;
  }
};
