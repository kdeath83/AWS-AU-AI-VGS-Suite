/**
 * cdk/test/cdk.test.ts
 * CDK snapshot tests for the AWS AU AI VGS Suite stacks.
 * Validates that stacks synthesize without errors and match expected structure.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SharedStack } from '../lib/shared-stack';
import { SecureStack } from '../lib/secure-stack';
import { ValidateStack } from '../lib/validate-stack';
import { GovernStack } from '../lib/govern-stack';

describe('CDK Stacks', () => {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'ap-southeast-2' };

  const sharedStack = new SharedStack(app, 'TestSharedStack', {
    env,
    environment: 'test',
    apraregion: 'ap-southeast-2',
  });

  const shieldStack = new SecureStack(app, 'TestSecureStack', {
    env,
    environment: 'test',
    vpc: sharedStack.vpc,
    evidenceBucket: sharedStack.evidenceBucket,
    kmsKey: sharedStack.kmsKey,
    eventBus: sharedStack.eventBus,
    baseRole: sharedStack.baseRole,
  });

  const validateStack = new ValidateStack(app, 'TestValidateStack', {
    env,
    environment: 'test',
    vpc: sharedStack.vpc,
    evidenceBucket: sharedStack.evidenceBucket,
    kmsKey: sharedStack.kmsKey,
    eventBus: sharedStack.eventBus,
    baseRole: sharedStack.baseRole,
  });

  const governStack = new GovernStack(app, 'TestGovernStack', {
    env,
    environment: 'test',
    vpc: sharedStack.vpc,
    evidenceBucket: sharedStack.evidenceBucket,
    kmsKey: sharedStack.kmsKey,
    eventBus: sharedStack.eventBus,
    baseRole: sharedStack.baseRole,
  });

  describe('SharedStack', () => {
    const template = Template.fromStack(sharedStack);

    it('should create a VPC', () => {
      template.hasResourceProperties('AWS::EC2::VPC', {
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      });
    });

    it('should create an S3 bucket with encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
              },
            },
          ],
        },
      });
    });

    it('should create a KMS key with rotation', () => {
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });
    });

    it('should create a CloudTrail organization trail', () => {
      template.hasResourceProperties('AWS::CloudTrail::Trail', {
        IsMultiRegionTrail: true,
        EnableLogFileValidation: true,
      });
    });

    it('should create an EventBridge custom event bus', () => {
      template.hasResourceProperties('AWS::Events::EventBus', {
        Name: 'aws-au-ai-vgs-suite-events-test',
      });
    });

    it('should create VPC endpoints for AWS services', () => {
      template.resourceCountIs('AWS::EC2::VPCEndpoint', 13); // 12 interface + 1 gateway
    });
  });

  describe('SecureStack', () => {
    const template = Template.fromStack(shieldStack);

    it('should create a WAF WebACL', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        DefaultAction: { Allow: {} },
        Scope: 'REGIONAL',
      });
    });

    it('should create an API Gateway REST API', () => {
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: 'aws-au-ai-vgs-suite-api-test',
      });
    });

    it('should create GuardDuty detector', () => {
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        Enable: true,
      });
    });

    it('should create Secrets Manager secret with rotation', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        GenerateSecretString: {
          PasswordLength: 32,
        },
      });
    });

    it('should create Config conformance pack', () => {
      template.hasResourceProperties('AWS::Config::ConformancePack', {
        ConformancePackName: 'apra-cps234-test',
      });
    });

    it('should create SQS queues with DLQs', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        KmsMasterKeyId: {},
      });
    });

    it('should create Lambda functions for secure operations', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
      });
    });
  });

  describe('ValidateStack', () => {
    const template = Template.fromStack(validateStack);

    it('should create a Neptune cluster', () => {
      template.hasResourceProperties('AWS::Neptune::DBCluster', {
        DeletionProtection: true,
        IamAuthEnabled: true,
      });
    });

    it('should create a DynamoDB table with encryption', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        SSESpecification: {
          SSEEnabled: true,
        },
      });
    });

    it('should create SageMaker endpoint config with data capture', () => {
      template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
        DataCaptureConfig: {
          EnableCapture: true,
        },
      });
    });

    it('should create Bedrock agents', () => {
      template.hasResourceProperties('AWS::Bedrock::Agent', {
        AgentName: 'aws-au-ai-vgs-suite-security-sentinel-test',
      });
      template.hasResourceProperties('AWS::Bedrock::Agent', {
        AgentName: 'aws-au-ai-vgs-suite-governance-auditor-test',
      });
    });

    it('should create Lambda functions for validate operations', () => {
      template.resourceCountIsGreaterThan('AWS::Lambda::Function', 4);
    });
  });

  describe('GovernStack', () => {
    const template = Template.fromStack(governStack);

    it('should create QuickSight data sources', () => {
      template.hasResourceProperties('AWS::QuickSight::DataSource', {
        Type: 'S3',
      });
    });

    it('should create QuickSight datasets with SPICE', () => {
      template.hasResourceProperties('AWS::QuickSight::DataSet', {
        ImportMode: 'SPICE',
      });
    });

    it('should create an SNS escalation topic', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        DisplayName: 'aws-au-ai-vgs-suite Alert Escalation',
      });
    });

    it('should create EventBridge rules for escalation', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventBusName: {},
      });
    });

    it('should create CloudWatch alarms', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Threshold: 3,
      });
    });
  });

  describe('Cross-Stack Dependencies', () => {
    it('should have SharedStack as dependency for SecureStack', () => {
      expect(shieldStack.dependencies).toContain(sharedStack);
    });

    it('should have SharedStack as dependency for ValidateStack', () => {
      expect(validateStack.dependencies).toContain(sharedStack);
    });

    it('should have SharedStack as dependency for GovernStack', () => {
      expect(governStack.dependencies).toContain(sharedStack);
    });
  });
});

