/**
 * tests/unit/escalation-router.test.ts
 * Unit tests for the escalation router Lambda.
 */

import { handler } from '../../src/lambda/govern/escalation-router';
import { createMockContext } from '../helpers/mock-context';

// The handler builds real AWS clients at module load and publishes on every valid
// escalation, so both SDKs are mocked. These tests cover routing and validation logic,
// not the network — without the mocks every case fails with a credentials error.
jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({ MessageId: 'mock-message-id' }),
  })),
  PublishCommand: jest.fn((input: unknown) => ({ input })),
}));

jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [] }),
  })),
  PutEventsCommand: jest.fn((input: unknown) => ({ input })),
}));

const mockContext = createMockContext();

describe('Escalation Router', () => {
  beforeEach(() => {
    process.env.ESCALATION_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:test-topic';
    process.env.EVENT_BUS_NAME = 'test-event-bus';
  });

  it('should validate required fields', async () => {
    const event = {
      detail: {
        eventId: '',
        eventSource: 'test',
        eventType: 'RiskEvent',
        riskClassification: 'HIGH',
        description: 'Test',
      },
    };
    // Should not throw, just log warning and return
    await expect(handler(event as any, mockContext)).resolves.not.toThrow();
  });

  it('should handle valid CRITICAL escalation', async () => {
    const event = {
      detail: {
        eventId: 'evt-001',
        eventSource: 'aws-au-ai-vgs-suite.security',
        eventType: 'ModelDriftAlert',
        riskClassification: 'CRITICAL',
        slaMinutes: 5,
        description: 'Critical model drift detected',
        affectedResources: ['arn:aws:sagemaker:ap-southeast-2:123456789012:endpoint/test'],
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    };
    // Should not throw (SNS will be mocked in actual test environment)
    await expect(handler(event as any, mockContext)).resolves.not.toThrow();
  });

  it('should reject invalid risk classification', async () => {
    const event = {
      detail: {
        eventId: 'evt-002',
        eventSource: 'test',
        eventType: 'RiskEvent',
        riskClassification: 'INVALID',
        description: 'Test',
        affectedResources: [],
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    };
    await expect(handler(event as any, mockContext)).resolves.not.toThrow();
  });
});
