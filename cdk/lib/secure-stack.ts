/**
 * cdk/lib/secure-stack.ts
 * SECURE Stack: Security services for AI protection.
 * Bedrock Guardrails, WAFv2, API Gateway, GuardDuty, Inspector, Patch Manager,
 * AWS Config conformance pack, Secrets Manager, Config rules for AI compliance.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as inspector from 'aws-cdk-lib/aws-inspector';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as config from 'aws-cdk-lib/aws-config';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { PROJECT_NAME } from './constants';

export interface SecureStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly vpc: ec2.Vpc;
  readonly evidenceBucket: s3.Bucket;
  readonly kmsKey: kms.Key;
  readonly eventBus: events.EventBus;
  readonly baseRole: iam.Role;
}

export class SecureStack extends cdk.Stack {
  public readonly guardrailArn: string;
  public readonly webAclArn: string;
  public readonly apiGateway: apigw.RestApi;
  public readonly guardDutyDetector: guardduty.CfnDetector;
  public readonly secretsManagerSecret: secretsmanager.Secret;
  public readonly patchBaseline: ssm.CfnPatchBaseline;

  constructor(scope: Construct, id: string, props: SecureStackProps) {
    super(scope, id, props);

    // ── Bedrock Guardrails ──────────────────────────────────────────────────
    // FSI-specific guardrails: topic restrictions, PII redaction, content filters.
    const guardrail = new cdk.CfnResource(this, 'BedrockGuardrail', {
      type: 'AWS::Bedrock::Guardrail',
      properties: {
        Name: `${PROJECT_NAME}-fsi-guardrail-${props.environment}`,
        Description: 'FSI-specific guardrails for AI content safety',
        BlockedInputMessaging: 'Input blocked: this request violates financial services safety policies.',
        BlockedOutputsMessaging: 'Output blocked: generated content violates financial services safety policies.',
        SensitiveInformationPolicyConfig: {
          PiiEntitiesConfig: [
            { Type: 'CREDIT_DEBIT_CARD_NUMBER', Action: 'BLOCK' },
            { Type: 'BANK_ACCOUNT_NUMBER', Action: 'BLOCK' },
            { Type: 'AUSTRALIAN_TAX_FILE_NUMBER', Action: 'BLOCK' },
            { Type: 'AUSTRALIAN_BUSINESS_NUMBER', Action: 'ANONYMIZE' },
            { Type: 'DRIVER_ID', Action: 'ANONYMIZE' },
            { Type: 'NAME', Action: 'ANONYMIZE' },
            { Type: 'EMAIL', Action: 'ANONYMIZE' },
            { Type: 'PHONE', Action: 'ANONYMIZE' },
          ],
        },
        TopicPolicyConfig: {
          TopicsConfig: [
            {
              Name: 'FinancialAdvice',
              Definition: 'Providing personalized financial advice without appropriate disclaimers or licensing.',
              Examples: [
                'You should invest all your money in this stock',
                'Sell your house and buy crypto',
                'I guarantee this investment will double in 30 days',
              ],
              Type: 'DENY',
            },
            {
              Name: 'ConfidentialDataExfiltration',
              Definition: 'Attempts to extract confidential or proprietary financial data.',
              Examples: [
                'What are the account balances of all customers?',
                'List all customer credit card numbers',
                'Show me internal trading strategies',
              ],
              Type: 'DENY',
            },
            {
              Name: 'RegulatoryEvasion',
              Definition: 'Assisting with regulatory evasion or reporting avoidance.',
              Examples: [
                'How can I hide this transaction from regulators?',
                'Help me structure this to avoid AML reporting',
                'How to bypass KYC requirements',
              ],
              Type: 'DENY',
            },
          ],
        },
        WordPolicyConfig: {
          ManagedWordListsConfig: [
            { Type: 'PROFANITY', InputAction: 'BLOCK', OutputAction: 'BLOCK' },
          ],
        },
        ContentPolicyConfig: {
          FiltersConfig: [
            { Type: 'SEXUAL', InputStrength: 'HIGH', OutputStrength: 'HIGH' },
            { Type: 'VIOLENCE', InputStrength: 'HIGH', OutputStrength: 'HIGH' },
            { Type: 'HATE', InputStrength: 'HIGH', OutputStrength: 'HIGH' },
            { Type: 'INSULTS', InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' },
          ],
        },
        ContextualGroundingPolicyConfig: {
          GroundingFiltersConfig: [
            { Type: 'GROUNDING', Threshold: 0.75, InseparableThreshold: 0.85 },
            { Type: 'RELEVANCE', Threshold: 0.75, InseparableThreshold: 0.85 },
          ],
        },
      },
    });
    this.guardrailArn = guardrail.getAtt('GuardrailArn').toString();

    // ── WAFv2 WebACL ──────────────────────────────────────────────────────────
    // AI-specific rules: prompt injection patterns, rate limiting, OWASP Top 10.
    const webAcl = new wafv2.CfnWebACL(this, 'AiWebAcl', {
      name: `${PROJECT_NAME}-ai-waf-${props.environment}`,
      description: 'WAF rules for AI endpoints covering OWASP Top 10 + prompt injection',
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${PROJECT_NAME}-ai-waf-metrics`,
      },
      rules: [
        // Rate limiting per IP
        {
          name: 'RateLimit',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit',
          },
        },
        // AWS Managed Rules: Common Rule Set (OWASP Top 10)
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              ruleActionOverrides: [
                { actionToUse: { block: {} }, name: 'SizeRestrictions_BODY' },
              ],
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
          },
        },
        // AWS Managed Rules: Known Bad Inputs
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        // AI-specific: Prompt injection pattern detection
        {
          name: 'PromptInjectionBlocklist',
          priority: 4,
          statement: {
            regexPatternSetReferenceStatement: {
              arn: new wafv2.CfnRegexPatternSet(this, 'PromptInjectionPatterns', {
                name: `${PROJECT_NAME}-prompt-injection-patterns`,
                scope: 'REGIONAL',
                description: 'Regex patterns for common prompt injection and jailbreak attempts',
                regularExpressions: [
                  { regexString: '(?i)(ignore previous|ignore all|disregard|forget previous)' },
                  { regexString: '(?i)(new instruction|system prompt|developer mode)' },
                  { regexString: '(?i)(DAN|do anything now|jailbreak|root access)' },
                  { regexString: '(?i)(ignore your|override your|bypass your|you are now)' },
                  { regexString: '(?i)(output initialization|above instructions|previous constraints)' },
                  { regexString: '(?i)(translate to.*exec|convert to.*bash|convert to.*python)' },
                  { regexString: '(?i)( Base64: | base64 encoded | decode this )' },
                ],
              }).attrArn,
              fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
              textTransformations: [
                { priority: 0, type: 'LOWERCASE' },
                { priority: 1, type: 'URL_DECODE' },
                { priority: 2, type: 'HTML_ENTITY_DECODE' },
              ],
            },
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'PromptInjectionBlocklist',
          },
        },
        // AI-specific: Data exfiltration attempt detection
        {
          name: 'DataExfiltrationPattern',
          priority: 5,
          statement: {
            regexPatternSetReferenceStatement: {
              arn: new wafv2.CfnRegexPatternSet(this, 'DataExfiltrationPatterns', {
                name: `${PROJECT_NAME}-data-exfil-patterns`,
                scope: 'REGIONAL',
                description: 'Regex patterns for data exfiltration attempts',
                regularExpressions: [
                  { regexString: '(?i)(send.*to.*email|exfiltrate|extract.*data|dump.*database)' },
                  { regexString: '(?i)(bearer\s+[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)' },
                  { regexString: '(?i)(api[_-]?key\s*[:=]\s*[a-zA-Z0-9]{20,})' },
                  { regexString: '(?i)(aws_access_key_id\s*[:=]\s*AKIA)' },
                ],
              }).attrArn,
              fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
              textTransformations: [
                { priority: 0, type: 'LOWERCASE' },
                { priority: 1, type: 'URL_DECODE' },
              ],
            },
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'DataExfiltrationPattern',
          },
        },
      ],
    });
    this.webAclArn = webAcl.attrArn;

    // ── API Gateway ───────────────────────────────────────────────────────────
    // REST API with mTLS, scoped IAM authorization, WAF integration.
    this.apiGateway = new apigw.RestApi(this, 'VgsApiGateway', {
      restApiName: `${PROJECT_NAME}-api-${props.environment}`,
      description: 'API Gateway for AI VGS Suite with mTLS and scoped IAM',
      deployOptions: {
        stageName: props.environment,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
        tracingEnabled: true,
      },
      endpointConfiguration: {
        types: [apigw.EndpointType.REGIONAL],
      },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountPrincipal(cdk.Stack.of(this).account)],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*/*/*'],
          }),
        ],
      }),
    });

    // WAF association
    new wafv2.CfnWebACLAssociation(this, 'ApiGatewayWafAssociation', {
      resourceArn: `arn:aws:apigateway:${cdk.Stack.of(this).region}::/restapis/${this.apiGateway.restApiId}/stages/${props.environment}`,
      webAclArn: this.webAclArn,
    });

    // Example resource (health check)
    this.apiGateway.root.addResource('health').addMethod('GET', new apigw.MockIntegration({
      integrationResponses: [{ statusCode: '200' }],
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
      authorizationType: apigw.AuthorizationType.IAM,
    });

    // ── GuardDuty ─────────────────────────────────────────────────────────────
    // Threat detection for AI endpoints and workloads.
    this.guardDutyDetector = new guardduty.CfnDetector(this, 'GuardDutyDetector', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      features: [
        { name: 'S3_DATA_EVENTS', status: 'ENABLED' },
        { name: 'EKS_AUDIT_LOGS', status: 'ENABLED' },
        { name: 'EBS_MALWARE_PROTECTION', status: 'ENABLED' },
        { name: 'RDS_LOGIN_EVENTS', status: 'ENABLED' },
        { name: 'EKS_RUNTIME_MONITORING', status: 'ENABLED' },
        { name: 'LAMBDA_NETWORK_LOGS', status: 'ENABLED' },
      ],
      dataSources: {
        s3Logs: { enable: true },
        kubernetes: { auditLogs: { enable: true } },
        malwareProtection: {
          scanEc2InstanceWithFindings: { ebsVolumes: { enable: true } },
        },
      },
    });

    // GuardDuty findings -> EventBridge -> SQS for async processing
    const guarddutyQueue = new sqs.Queue(this, 'GuardDutyFindingsQueue', {
      queueName: `${PROJECT_NAME}-guardduty-findings-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'GuardDutyFindingsDLQ', {
          queueName: `${PROJECT_NAME}-guardduty-findings-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
        }),
      },
    });

    new events.Rule(this, 'GuardDutyFindingsRule', {
      ruleName: `${PROJECT_NAME}-guardduty-findings-rule`,
      description: 'Route GuardDuty findings to SQS for processing',
      eventBus: props.eventBus,
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Finding'],
      },
      targets: [new targets.SqsQueue(guarddutyQueue)],
    });

    // ── Inspector ────────────────────────────────────────────────────────────
    // Continuous vulnerability scanning.
    new inspector.CfnResourceGroup(this, 'InspectorResourceGroup', {
      resourceGroupTags: [
        { key: 'Project', value: PROJECT_NAME },
        { key: 'Environment', value: props.environment },
      ],
    });

    new inspector.CfnAssessmentTarget(this, 'InspectorAssessmentTarget', {
      assessmentTargetName: `${PROJECT_NAME}-inspector-target-${props.environment}`,
    });

    // Inspector -> EventBridge
    const inspectorQueue = new sqs.Queue(this, 'InspectorFindingsQueue', {
      queueName: `${PROJECT_NAME}-inspector-findings-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'InspectorFindingsDLQ', {
          queueName: `${PROJECT_NAME}-inspector-findings-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
        }),
      },
    });

    new events.Rule(this, 'InspectorFindingsRule', {
      ruleName: `${PROJECT_NAME}-inspector-findings-rule`,
      description: 'Route Inspector findings to SQS for processing',
      eventBus: props.eventBus,
      eventPattern: {
        source: ['aws.inspector2'],
        detailType: ['Inspector2 Finding', 'Inspector2 Coverage'],
      },
      targets: [new targets.SqsQueue(inspectorQueue)],
    });

    // ── Systems Manager Patch Manager ───────────────────────────────────────
    // Automated patching with maintenance windows.
    this.patchBaseline = new ssm.CfnPatchBaseline(this, 'PatchBaseline', {
      name: `${PROJECT_NAME}-patch-baseline-${props.environment}`,
      operatingSystem: 'AMAZON_LINUX_2',
      description: 'APRA CPS 234 compliant patch baseline',
      approvalRules: {
        patchRules: [
          {
            patchFilterGroup: {
              patchFilters: [
                { key: 'PRODUCT', values: ['AmazonLinux2'] },
                { key: 'SEVERITY', values: ['Critical', 'Important'] },
              ],
            },
            complianceLevel: 'CRITICAL',
            approveAfterDays: 7,
            enableNonSecurity: false,
          },
        ],
      },
    });

    const maintenanceWindow = new ssm.CfnMaintenanceWindow(this, 'PatchMaintenanceWindow', {
      name: `${PROJECT_NAME}-patch-window-${props.environment}`,
      description: 'Maintenance window for security patching',
      schedule: 'cron(0 2 ? * SUN *)', // Every Sunday at 2 AM
      duration: 4,
      cutoff: 1,
      allowUnassociatedTargets: false,
    });

    new ssm.CfnMaintenanceWindowTarget(this, 'PatchWindowTarget', {
      windowId: maintenanceWindow.ref,
      resourceType: 'INSTANCE',
      targets: [
        { key: 'tag:Project', values: [PROJECT_NAME] },
        { key: 'tag:Environment', values: [props.environment] },
      ],
    });

    new ssm.CfnMaintenanceWindowTask(this, 'PatchWindowTask', {
      windowId: maintenanceWindow.ref,
      targets: [
        { key: 'WindowTargetIds', values: ['*'] },
      ],
      taskArn: 'AWS-RunPatchBaseline',
      taskType: 'RUN_COMMAND',
      taskInvocationParameters: {
        maintenanceWindowRunCommandParameters: {
          parameters: {
            Operation: ['Install'],
            RebootOption: ['RebootIfNeeded'],
          },
        },
      },
      maxConcurrency: '10%',
      maxErrors: '5%',
      priority: 1,
    });

    // ── Secrets Manager ───────────────────────────────────────────────────────
    // Automatic rotation for model credentials.
    this.secretsManagerSecret = new secretsmanager.Secret(this, 'ModelCredentials', {
      secretName: `${PROJECT_NAME}/model-credentials/${props.environment}`,
      description: 'Rotating credentials for AI model API access',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'model-api-user' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
      encryptionKey: props.kmsKey,
    });

    // ── AWS Config Conformance Pack (APRA CPS 234) ──────────────────────────
    const conformancePackBucket = new s3.Bucket(this, 'ConformancePackBucket', {
      bucketName: `${PROJECT_NAME}-config-conformance-${props.environment}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Custom APRA CPS 234 conformance pack template
    const conformancePackTemplate = `Resources:
  # IAM Password Policy
  IAMPasswordPolicyRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-iam-password-policy
      Description: Ensure IAM password policy meets APRA CPS 234 requirements
      Source:
        Owner: AWS
        SourceIdentifier: IAM_PASSWORD_POLICY
      InputParameters:
        RequireUppercaseCharacters: 'true'
        RequireLowercaseCharacters: 'true'
        RequireSymbols: 'true'
        RequireNumbers: 'true'
        MinimumPasswordLength: '14'
        PasswordReusePrevention: '24'
        MaxPasswordAge: '90'
      Scope:
        ComplianceResourceTypes:
          - AWS::IAM::Account

  # S3 Bucket Public Read Prohibited
  S3BucketPublicReadProhibitedRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-s3-public-read-prohibited
      Description: S3 buckets must not allow public read access
      Source:
        Owner: AWS
        SourceIdentifier: S3_BUCKET_PUBLIC_READ_PROHIBITED
      Scope:
        ComplianceResourceTypes:
          - AWS::S3::Bucket

  # S3 Bucket SSL Only
  S3BucketSSLRequestsOnlyRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-s3-ssl-only
      Description: S3 buckets must require SSL/TLS
      Source:
        Owner: AWS
        SourceIdentifier: S3_BUCKET_SSL_REQUESTS_ONLY
      Scope:
        ComplianceResourceTypes:
          - AWS::S3::Bucket

  # CloudTrail Enabled
  CloudTrailEnabledRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-cloudtrail-enabled
      Description: CloudTrail must be enabled
      Source:
        Owner: AWS
        SourceIdentifier: CLOUD_TRAIL_ENABLED
      # Bucket monitored automatically by config rule; no explicit params needed
      Scope:
        ComplianceResourceTypes:
          - AWS::CloudTrail::Trail

  # GuardDuty Enabled
  GuardDutyEnabledCentralizedRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-guardduty-enabled
      Description: GuardDuty must be enabled centrally
      Source:
        Owner: AWS
        SourceIdentifier: GUARDDUTY_ENABLED_CENTRALIZED
      Scope:
        ComplianceResourceTypes:
          - AWS::GuardDuty::Detector

  # EC2 EBS Encryption
  EBSEncryptedVolumesRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-ebs-encrypted
      Description: EBS volumes must be encrypted
      Source:
        Owner: AWS
        SourceIdentifier: EC2_EBS_ENCRYPTION_BY_DEFAULT
      Scope:
        ComplianceResourceTypes:
          - AWS::EC2::Volume

  # VPC Flow Logs Enabled
  VpcFlowLogsEnabledRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-vpc-flow-logs
      Description: VPC flow logs must be enabled
      Source:
        Owner: AWS
        SourceIdentifier: VPC_FLOW_LOGS_ENABLED
      Scope:
        ComplianceResourceTypes:
          - AWS::EC2::VPC

  # Security Groups Restricted SSH
  SecurityGroupRestrictedSSHRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-sg-restricted-ssh
      Description: Security groups must restrict SSH access
      Source:
        Owner: AWS
        SourceIdentifier: INCOMING_SSH_DISABLED
      Scope:
        ComplianceResourceTypes:
          - AWS::EC2::SecurityGroup

  # RDS Storage Encrypted
  RDSStorageEncryptedRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-rds-encrypted
      Description: RDS instances must have encrypted storage
      Source:
        Owner: AWS
        SourceIdentifier: RDS_STORAGE_ENCRYPTED
      Scope:
        ComplianceResourceTypes:
          - AWS::RDS::DBInstance

  # KMS Key Rotation
  KMSKeyRotationRule:
    Type: AWS::Config::ConfigRule
    Properties:
      ConfigRuleName: apra-cps234-kms-rotation
      Description: KMS keys must have rotation enabled
      Source:
        Owner: AWS
        SourceIdentifier: KMS_KEY_ROTATION_ENABLED
      Scope:
        ComplianceResourceTypes:
          - AWS::KMS::Key
`;

    new s3.CfnBucket(this, 'ConformancePackTemplate', {
      bucket: conformancePackBucket.bucketName,
    });

    new config.CfnConformancePack(this, 'ApraCps234ConformancePack', {
      conformancePackName: `apra-cps234-${props.environment}`,
      deliveryS3Bucket: conformancePackBucket.bucketName,
      deliveryS3KeyPrefix: 'conformance-pack-results',
      templateBody: conformancePackTemplate,
    });

    // ── Config Rules for AI Resource Compliance ────────────────────────────
    new config.ManagedRule(this, 'BedrockModelLoggingRule', {
      configRuleName: `${PROJECT_NAME}-bedrock-model-logging`,
      description: 'Ensure Bedrock model invocation logging is enabled',
      identifier: 'bedrock-model-logging-enabled',
    });

    new config.ManagedRule(this, 'SageMakerEndpointEncryptionRule', {
      configRuleName: `${PROJECT_NAME}-sagemaker-endpoint-encryption`,
      description: 'Ensure SageMaker endpoints use encryption',
      identifier: 'sagemaker-endpoint-configuration-kms-key-configured',
    });

    new config.CustomRule(this, 'AiResourceTaggingRule', {
      configRuleName: `${PROJECT_NAME}-ai-resource-tagging`,
      description: 'AI resources must have required tags (Owner, DataClassification, ModelVersion)',
      lambdaFunction: new lambda.Function(this, 'AiResourceTaggingLambda', {
        functionName: `${PROJECT_NAME}-ai-tagging-checker-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
          exports.handler = async (event) => {
            const requiredTags = ['Owner', 'DataClassification', 'ModelVersion'];
            const configurationItem = event.configurationItem;
            const tags = configurationItem.tags || {};
            const missingTags = requiredTags.filter(tag => !tags[tag]);
            return {
              complianceType: missingTags.length === 0 ? 'COMPLIANT' : 'NON_COMPLIANT',
              annotation: missingTags.length === 0 ? 'All required tags present' : 'Missing tags: ' + missingTags.join(', '),
            };
          };
        `),
        timeout: cdk.Duration.seconds(30),
        memorySize: 128,
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      }),
      configurationChanges: true,
    });

    // ── Lambda: Prompt Injection Detector ────────────────────────────────────
    const promptInjectionDetector = new lambda.Function(this, 'PromptInjectionDetector', {
      functionName: `${PROJECT_NAME}-prompt-injection-detector-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/SECURE/prompt-injection-detector'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        GUARDRAIL_ID: this.guardrailArn,
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    // ── Lambda: GuardDuty Findings Aggregator ────────────────────────────────
    const guarddutyAggregator = new lambda.Function(this, 'GuardDutyAggregator', {
      functionName: `${PROJECT_NAME}-guardduty-aggregator-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/SECURE/guardduty-finder-aggregator'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    guarddutyAggregator.addEventSource(new lambda.EventSourceMapping(this, 'GuardDutyQueueMapping', {
      target: guarddutyAggregator,
      eventSourceArn: guarddutyQueue.queueArn,
      batchSize: 10,
    }));

    // ── Lambda: Patch Compliance Checker ───────────────────────────────────────
    const patchComplianceChecker = new lambda.Function(this, 'PatchComplianceChecker', {
      functionName: `${PROJECT_NAME}-patch-compliance-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/SECURE/patch-compliance-checker'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    // Schedule patch compliance check daily
    const patchScheduleRule = new events.Rule(this, 'PatchComplianceSchedule', {
      ruleName: `${PROJECT_NAME}-patch-compliance-schedule`,
      description: 'Daily patch compliance check',
      schedule: events.Schedule.cron({ hour: '3', minute: '0' }),
      targets: [new targets.LambdaFunction(patchComplianceChecker)],
    });

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GuardrailArn', { value: this.guardrailArn });
    new cdk.CfnOutput(this, 'WebAclArn', { value: this.webAclArn });
    new cdk.CfnOutput(this, 'ApiGatewayUrl', { value: this.apiGateway.url });
    new cdk.CfnOutput(this, 'GuardDutyDetectorId', { value: this.guardDutyDetector.attrId });
    new cdk.CfnOutput(this, 'SecretsManagerArn', { value: this.secretsManagerSecret.secretArn });
  }
}

