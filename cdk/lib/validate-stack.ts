/**
 * cdk/lib/validate-stack.ts
 * VALIDATE Stack: Model monitoring, audit, supply chain graph, AgentCore, Agent Registry, Lambda functions.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { Construct } from 'constructs';
import { PROJECT_NAME } from './constants';

export interface ValidateStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly vpc: ec2.Vpc;
  readonly evidenceBucket: s3.Bucket;
  readonly kmsKey: kms.Key;
  readonly eventBus: events.EventBus;
  readonly baseRole: iam.Role;
}

export class ValidateStack extends cdk.Stack {
  public readonly neptuneCluster: neptune.CfnDBCluster;
  public readonly agentRegistryTable: dynamodb.Table;
  public readonly modelMonitorEndpointConfigName: string;
  public readonly auditAssessmentArn: string;

  constructor(scope: Construct, id: string, props: ValidateStackProps) {
    super(scope, id, props);

    // The shared execution role is created in SharedStack. Import it by ARN with
    // addGrantsToResources so grants in this stack become resource policies on the local
    // resource, rather than statements written into the role's policy — a resource that
    // lives in SharedStack. Writing this stack's resource ARNs into a SharedStack policy
    // would make SharedStack depend on this stack, and since this stack already depends on
    // SharedStack, CDK reports a dependency cycle and refuses to synthesize.
    const baseRole = iam.Role.fromRoleArn(this, 'BaseRoleRef', props.baseRole.roleArn, {
      mutable: false,
      addGrantsToResources: true,
    });

    // ── DynamoDB: Agent Registry ──────────────────────────────────────────────
    this.agentRegistryTable = new dynamodb.Table(this, 'AgentRegistryTable', {
      tableName: `${PROJECT_NAME}-agent-registry-${props.environment}`,
      partitionKey: { name: 'recordId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.kmsKey,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI for querying by status
    this.agentRegistryTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'recordType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for querying by owner team
    this.agentRegistryTable.addGlobalSecondaryIndex({
      indexName: 'OwnerTeamIndex',
      partitionKey: { name: 'ownerTeam', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Neptune Cluster ────────────────────────────────────────────────────────
    // AI supply chain graph database.
    this.neptuneCluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbClusterIdentifier: `${PROJECT_NAME}-neptune-${props.environment}`,
      engineVersion: '1.3.0.0',
      deletionProtection: true,
      iamAuthEnabled: true,
      storageEncrypted: true,
      kmsKeyId: props.kmsKey.keyArn,
      backupRetentionPeriod: 35,
      preferredBackupWindow: '03:00-04:00',
      vpcSecurityGroupIds: [
        new ec2.SecurityGroup(this, 'NeptuneSecurityGroup', {
          vpc: props.vpc,
          description: 'Security group for Neptune cluster — restricted egress to VPC endpoints only',
          allowAllOutbound: false,
        }).securityGroupId,
      ],
      dbSubnetGroupName: new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnetGroup', {
        dbSubnetGroupName: `${PROJECT_NAME}-neptune-subnets`,
        dbSubnetGroupDescription: 'Subnets for Neptune cluster',
        subnetIds: props.vpc.privateSubnets.map((subnet) => subnet.subnetId),
      }).dbSubnetGroupName,
    });

    new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbClusterIdentifier: this.neptuneCluster.dbClusterIdentifier,
      dbInstanceIdentifier: `${PROJECT_NAME}-neptune-instance-1`,
      dbInstanceClass: 'db.t4g.medium',
      // NIST/HIPAA-adjacent AwsSolutions-N2: let the service apply minor engine patches.
      autoMinorVersionUpgrade: true,
    });

    // ── SageMaker Model Monitor Endpoint ────────────────────────────────────
    // Data capture for drift detection.
    this.modelMonitorEndpointConfigName = `${PROJECT_NAME}-model-monitor-endpoint-${props.environment}`;

    // SageMaker execution role
    const sagemakerRole = new iam.Role(this, 'SageMakerExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'Execution role for SageMaker Model Monitor and Clarify',
    });
    sagemakerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
        'kms:Decrypt',
        'kms:GenerateDataKey',
      ],
      resources: [
        props.evidenceBucket.bucketArn,
        `${props.evidenceBucket.bucketArn}/*`,
      ],
    }));
    props.evidenceBucket.grantReadWrite(sagemakerRole);

    // Model Monitor endpoint configuration (placeholder model — POC uses mock endpoint)
    new sagemaker.CfnEndpointConfig(this, 'ModelMonitorEndpointConfig', {
      endpointConfigName: this.modelMonitorEndpointConfigName,
      // NIST/HIPAA SageMakerEndpointConfigurationKMSKeyConfigured: endpoint storage is
      // otherwise encrypted with an AWS-owned key the account cannot audit or revoke.
      kmsKeyId: props.kmsKey.keyArn,
      productionVariants: [
        {
          variantName: 'AllTraffic',
          modelName: `${PROJECT_NAME}-placeholder-model`,
          initialVariantWeight: 1,
          instanceType: 'ml.m5.large',
          initialInstanceCount: 1,
        },
      ],
      dataCaptureConfig: {
        enableCapture: true,
        initialSamplingPercentage: 100,
        destinationS3Uri: `s3://${props.evidenceBucket.bucketName}/model-monitor/capture/`,
        captureOptions: [
          { captureMode: 'Input' },
          { captureMode: 'Output' },
        ],
        captureContentTypeHeader: {
          csvContentTypes: ['text/csv'],
          jsonContentTypes: ['application/json'],
        },
        kmsKeyId: props.kmsKey.keyArn,
      },
    });

    // ── SageMaker Clarify Processing Job (Bias/Explainability) ─────────────────
    const clarifyProcessingRole = new iam.Role(this, 'ClarifyProcessingRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'Execution role for SageMaker Clarify processing jobs',
    });
    clarifyProcessingRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
        'kms:Decrypt',
        'kms:GenerateDataKey',
      ],
      resources: [
        props.evidenceBucket.bucketArn,
        `${props.evidenceBucket.bucketArn}/*`,
      ],
    }));
    props.evidenceBucket.grantReadWrite(clarifyProcessingRole);

    // ── Audit Manager Assessment ────────────────────────────────────────────
    // APRA CPS 234 control framework with 20+ controls.
    this.auditAssessmentArn = `arn:aws:auditmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:assessment/${PROJECT_NAME}-apra-cps234-${props.environment}`;

    // Create custom control framework for APRA CPS 234
    const apraControlFramework = new cdk.CfnResource(this, 'ApraCps234Framework', {
      type: 'AWS::AuditManager::Assessment',
      properties: {
        name: `APRA CPS 234 Assessment - ${props.environment}`,
        description: 'Automated APRA CPS 234 compliance assessment for AI systems',
        assessmentReportsDestination: {
          destination: props.evidenceBucket.bucketName,
          destinationType: 'S3',
        },
        scope: {
          awsAccounts: [
            { id: cdk.Stack.of(this).account },
          ],
          awsServices: [
            { serviceName: 'BEDROCK' },
            { serviceName: 'SAGEMAKER' },
            { serviceName: 'IAM' },
            { serviceName: 'S3' },
            { serviceName: 'KMS' },
            { serviceName: 'EC2' },
            { serviceName: 'VPC' },
            { serviceName: 'GUARDDUTY' },
            { serviceName: 'INSPECTOR' },
            { serviceName: 'CONFIG' },
            { serviceName: 'CLOUDTRAIL' },
            { serviceName: 'EVENTBRIDGE' },
            { serviceName: 'LAMBDA' },
            { serviceName: 'SECRETSMANAGER' },
          ],
        },
        roles: [
          {
            roleType: 'PROCESS_OWNER',
            roleArn: props.baseRole.roleArn,
          },
        ],
        tags: [
          { key: 'Project', value: PROJECT_NAME },
          { key: 'Environment', value: props.environment },
          { key: 'Framework', value: 'APRA-CPS-234' },
        ],
      },
    });

    // ── AgentCore Harness Configuration ──────────────────────────────────────
    // Harnesses are created via scripts/create-harnesses.sh (config-based, not infra).
    // The CDK passes harness ARNs as environment variables to the orchestrator.
    // 
    // Model routing happens at invocation time — the orchestrator selects a model
    // based on task priority and type, and passes it to InvokeHarness.
    //
    // Supported models (see src/shared/model-router.ts):
    //   CRITICAL → Claude Opus 4.5 (highest accuracy)
    //   HIGH security → Claude Sonnet 4.5
    //   HIGH compliance → DeepSeek V4 Pro (via OpenCode Go / LiteLLM)
    //   MEDIUM/LOW → DeepSeek V4 Flash (cost-optimized)
    //   All tiers support automatic fallback if primary model fails.

    const securityHarnessArn = `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:harness/${PROJECT_NAME}-security-sentinel-${props.environment}`;
    const governanceHarnessArn = `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:harness/${PROJECT_NAME}-governance-auditor-${props.environment}`;

    // ── AgentCore Identity ───────────────────────────────────────────────────
    // Role for harness execution — grants access to Bedrock models and AgentCore services.
    const harnessExecutionRole = new iam.Role(this, 'HarnessExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for AgentCore Harness — model invocation and credential access',
    });
    harnessExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock-agentcore:InvokeHarness',
      ],
      resources: [
        `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/anthropic.claude-fable-5`,
        `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/anthropic.claude-opus-4-8`,
        `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/claude-sonnet-4-6`,
      ],
    }));
    harnessExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore-identity:GetApiKeyCredential',
        'bedrock-agentcore-identity:DecryptApiKey',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:api-key-credential/*`,
      ],
    }));

    // ── AgentCore Gateway (MCP Registration) ──────────────────────────────────
    // Model-agnostic gateway for MCP server registration and tool discovery.
    // Uses AgentCore Gateway — separate from the harness, handles all tool routing.
    // Created via CLI or console (configuration, not infrastructure).
    // Reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html

    // ── AWS Agent Registry ──────────────────────────────────────────────────
    // Registry resource + records + EventBridge notifications
    const agentRegistry = new cdk.CfnResource(this, 'AgentRegistry', {
      type: 'AWS::Bedrock::Agent',
      properties: {
        AgentName: `${PROJECT_NAME}-agent-registry-${props.environment}`,
        Description: 'Central registry for all AI agents, MCP servers, and tools',
        FoundationModel: 'anthropic.claude-3-sonnet-20240229-v1:0',
        IdleSessionTTLInSeconds: 1800,
        Instruction: `You are the Agent Registry, the central catalog for all AI agents, MCP servers, and tools.
Your responsibilities:
1. Maintain a comprehensive catalog of all registered agents and tools
2. Enforce approval workflows for new registrations
3. Provide semantic search for discovering the right tool/agent
4. Track version history and ownership of all registry entries
5. Notify stakeholders of registry changes via EventBridge`,
      },
    });

    // A raw CfnResource cannot stand in for an SNS topic here: targets.SnsTopic.bind()
    // calls topic.grantPublish(), which only a real sns.Topic implements. The previous
    // `as any` cast hid that until synth time, so the stack could never be deployed.
    const registryNotificationsTopic = new sns.Topic(this, 'RegistryNotifications', {
      topicName: `${PROJECT_NAME}-registry-notifications`,
      // Matches the EscalationTopic pattern in the governance stack: CMK at rest, TLS in
      // transit. AwsSolutions-SNS3 and *-SNSEncryptedKMS both flag the topic without these.
      masterKey: props.kmsKey,
      enforceSSL: true,
    });

    // EventBridge rule for registry record changes
    new events.Rule(this, 'RegistryChangeRule', {
      ruleName: `${PROJECT_NAME}-registry-change-rule`,
      description: 'Notify on agent registry record changes',
      eventBus: props.eventBus,
      eventPattern: {
        source: [`${PROJECT_NAME}.agent-registry`],
        detailType: ['RegistryRecordCreated', 'RegistryRecordUpdated', 'RegistryRecordApproved', 'RegistryRecordRevoked'],
      },
      targets: [new targets.SnsTopic(registryNotificationsTopic)],
    });

    // ── Lambda: Model Drift Handler ──────────────────────────────────────────
    const driftHandlerQueue = new sqs.Queue(this, 'DriftHandlerQueue', {
      queueName: `${PROJECT_NAME}-drift-handler-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      enforceSSL: true,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'DriftHandlerDLQ', {
          queueName: `${PROJECT_NAME}-drift-handler-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
          enforceSSL: true,
        }),
      },
    });

    const modelDriftHandler = new lambda.Function(this, 'ModelDriftHandler', {
      functionName: `${PROJECT_NAME}-model-drift-handler-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/validate/model-drift-handler'),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        AGENT_REGISTRY_TABLE: this.agentRegistryTable.tableName,
        KMS_KEY_ARN: props.kmsKey.keyArn,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: baseRole,
    });

    this.agentRegistryTable.grantReadWriteData(modelDriftHandler);
    // SqsEventSource rather than a hand-built EventSourceMapping: the event source class
    // grants the function permission to consume the queue (the raw construct did not), and
    // reportBatchItemFailures makes the handler's `batchItemFailures` response
    // authoritative — without it one bad record replays the entire batch.
    modelDriftHandler.addEventSource(new lambdaEventSources.SqsEventSource(driftHandlerQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // ── Lambda: Bias Report Generator ────────────────────────────────────────
    const biasReportQueue = new sqs.Queue(this, 'BiasReportQueue', {
      queueName: `${PROJECT_NAME}-bias-report-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(600),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      enforceSSL: true,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'BiasReportDLQ', {
          queueName: `${PROJECT_NAME}-bias-report-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
          enforceSSL: true,
        }),
      },
    });

    const biasReportGenerator = new lambda.Function(this, 'BiasReportGenerator', {
      functionName: `${PROJECT_NAME}-bias-report-generator-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/validate/bias-report-generator'),
      timeout: cdk.Duration.seconds(600),
      memorySize: 1024,
      environment: {
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        KMS_KEY_ARN: props.kmsKey.keyArn,
        SAGEMAKER_ROLE_ARN: clarifyProcessingRole.roleArn,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: baseRole,
    });

    biasReportGenerator.addEventSource(new lambdaEventSources.SqsEventSource(biasReportQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // ── Lambda: Audit Evidence Collector ────────────────────────────────────
    const auditEvidenceQueue = new sqs.Queue(this, 'AuditEvidenceQueue', {
      queueName: `${PROJECT_NAME}-audit-evidence-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      enforceSSL: true,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'AuditEvidenceDLQ', {
          queueName: `${PROJECT_NAME}-audit-evidence-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
          enforceSSL: true,
        }),
      },
    });

    const auditEvidenceCollector = new lambda.Function(this, 'AuditEvidenceCollector', {
      functionName: `${PROJECT_NAME}-audit-evidence-collector-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/validate/audit-evidence-collector'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        AUDIT_ASSESSMENT_ARN: this.auditAssessmentArn,
        KMS_KEY_ARN: props.kmsKey.keyArn,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: baseRole,
    });

    auditEvidenceCollector.addEventSource(new lambdaEventSources.SqsEventSource(auditEvidenceQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    // Scheduled evidence collection every 6 hours
    new events.Rule(this, 'AuditEvidenceSchedule', {
      ruleName: `${PROJECT_NAME}-audit-evidence-schedule`,
      description: 'Scheduled audit evidence collection',
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [new targets.SqsQueue(auditEvidenceQueue)],
    });

    // ── Lambda: Registry Curator ────────────────────────────────────────────
    const registryCurator = new lambda.Function(this, 'RegistryCurator', {
      functionName: `${PROJECT_NAME}-registry-curator-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/validate/registry-curator'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        AGENT_REGISTRY_TABLE: this.agentRegistryTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: baseRole,
    });

    this.agentRegistryTable.grantReadWriteData(registryCurator);

    // Trigger on DynamoDB stream changes. DynamoEventSource derives the stream ARN from
    // the table (which is created with NEW_AND_OLD_IMAGES) and grants the function
    // stream-read permissions, which the raw construct did not.
    registryCurator.addEventSource(new lambdaEventSources.DynamoEventSource(this.agentRegistryTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      filters: [
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('MODIFY') }),
      ],
    }));

    // ── Lambda: Agent Orchestrator ───────────────────────────────────────────
    const orchestratorQueue = new sqs.Queue(this, 'OrchestratorQueue', {
      queueName: `${PROJECT_NAME}-agent-orchestrator-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      enforceSSL: true,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'OrchestratorDLQ', {
          queueName: `${PROJECT_NAME}-agent-orchestrator-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
          enforceSSL: true,
        }),
      },
    });

    const agentOrchestrator = new lambda.Function(this, 'AgentOrchestrator', {
      functionName: `${PROJECT_NAME}-agent-orchestrator-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/validate/agent-orchestrator'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        SECURITY_HARNESS_ARN: securityHarnessArn,
        GOVERNANCE_HARNESS_ARN: governanceHarnessArn,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: baseRole,
    });

    agentOrchestrator.addEventSource(new lambdaEventSources.SqsEventSource(orchestratorQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // ── DLQ Monitoring Alarms ─────────────────────────────────────────────
    // Alert when messages land in any dead-letter queue (CPS 234-5 compliance).
    // This was previously a hard-coded ARN string that was never attached to any alarm, so
    // the alarms had no action and could never notify anyone (NIST/HIPAA
    // CloudWatchAlarmAction).
    const dlqAlarmTopic = new sns.Topic(this, 'DlqAlarmTopic', {
      topicName: `${PROJECT_NAME}-dlq-alarms-${props.environment}`,
      masterKey: props.kmsKey,
      enforceSSL: true,
    });

    // Orchestrator DLQ alarm
    new cloudwatch.Alarm(this, 'OrchestratorDLQAlarm', {
      alarmName: `${PROJECT_NAME}-orchestrator-dlq-alarm`,
      alarmDescription: 'Messages in orchestrator DLQ — agent tasks are failing',
      metric: (orchestratorQueue.deadLetterQueue!.queue as sqs.Queue).metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(dlqAlarmTopic));

    // Audit evidence DLQ alarm
    new cloudwatch.Alarm(this, 'AuditEvidenceDLQAlarm', {
      alarmName: `${PROJECT_NAME}-audit-evidence-dlq-alarm`,
      alarmDescription: 'Messages in audit evidence DLQ — evidence collection is failing',
      metric: (auditEvidenceQueue.deadLetterQueue!.queue as sqs.Queue).metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(dlqAlarmTopic));

    // Drift handler DLQ alarm
    new cloudwatch.Alarm(this, 'DriftHandlerDLQAlarm', {
      alarmName: `${PROJECT_NAME}-drift-handler-dlq-alarm`,
      alarmDescription: 'Messages in drift handler DLQ — model drift detection is failing',
      metric: (driftHandlerQueue.deadLetterQueue!.queue as sqs.Queue).metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(dlqAlarmTopic));

    // Bias report DLQ alarm
    new cloudwatch.Alarm(this, 'BiasReportDLQAlarm', {
      alarmName: `${PROJECT_NAME}-bias-report-dlq-alarm`,
      alarmDescription: 'Messages in bias report DLQ — bias detection is failing',
      metric: (biasReportQueue.deadLetterQueue!.queue as sqs.Queue).metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(dlqAlarmTopic));

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'NeptuneEndpoint', { value: this.neptuneCluster.attrEndpoint });
    new cdk.CfnOutput(this, 'AgentRegistryTableArn', { value: this.agentRegistryTable.tableArn });
    // Logical id must differ from the CfnEndpointConfig above (same scope): construct ids
    // have to be unique, and the clash meant the stack could not synthesize at all.
    new cdk.CfnOutput(this, 'ModelMonitorEndpointConfigName', { value: this.modelMonitorEndpointConfigName });
    new cdk.CfnOutput(this, 'AuditAssessmentArn', { value: this.auditAssessmentArn });
    new cdk.CfnOutput(this, 'SecurityHarnessArn', { value: securityHarnessArn });
    new cdk.CfnOutput(this, 'GovernanceHarnessArn', { value: governanceHarnessArn });
    new cdk.CfnOutput(this, 'HarnessExecutionRoleArn', { value: harnessExecutionRole.roleArn });
  }
}
