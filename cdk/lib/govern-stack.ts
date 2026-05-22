/**
 * cdk/lib/govern-stack.ts
 * GOVERN Stack: QuickSight dashboards, Bedrock prompt optimization, escalation routing.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import { Construct } from 'constructs';
import { PROJECT_NAME } from './constants';

export interface GovernStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly vpc: ec2.Vpc;
  readonly evidenceBucket: s3.Bucket;
  readonly kmsKey: kms.Key;
  readonly eventBus: events.EventBus;
  readonly baseRole: iam.Role;
}

export class GovernStack extends cdk.Stack {
  public readonly quickSightDashboardArn: string;
  public readonly escalationTopic: sns.Topic;
  public readonly promptOptimizationBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: GovernStackProps) {
    super(scope, id, props);

    // ── QuickSight Dashboard Resources ──────────────────────────────────────
    // Data sources from S3, Neptune, CloudWatch.
    const quickSightRole = new iam.Role(this, 'QuickSightServiceRole', {
      assumedBy: new iam.ServicePrincipal('quicksight.amazonaws.com'),
      description: 'Service role for QuickSight data access',
    });
    props.evidenceBucket.grantRead(quickSightRole);

    // S3 data source for QuickSight
    const s3DataSource = new quicksight.CfnDataSource(this, 'QuickSightS3DataSource', {
      awsAccountId: cdk.Stack.of(this).account,
      dataSourceId: `${PROJECT_NAME}-s3-datasource`,
      name: `${PROJECT_NAME} Evidence Lake`,
      type: 'S3',
      dataSourceParameters: {
        s3Parameters: {
          manifestFileLocation: {
            bucket: props.evidenceBucket.bucketName,
            key: 'quicksight-manifest.json',
          },
        },
      },
      sslProperties: {
        disableSsl: false,
      },
    });

    // CloudWatch data source for metrics
    const cloudWatchDataSource = new quicksight.CfnDataSource(this, 'QuickSightCloudWatchDataSource', {
      awsAccountId: cdk.Stack.of(this).account,
      dataSourceId: `${PROJECT_NAME}-cloudwatch-datasource`,
      name: `${PROJECT_NAME} CloudWatch Metrics`,
      type: 'CLOUDWATCH',
      dataSourceParameters: {
        cloudWatchParameters: {},
      },
    });

    // Neptune data source (via Athena connector)
    const neptuneDataSource = new quicksight.CfnDataSource(this, 'QuickSightNeptuneDataSource', {
      awsAccountId: cdk.Stack.of(this).account,
      dataSourceId: `${PROJECT_NAME}-neptune-datasource`,
      name: `${PROJECT_NAME} Neptune Graph`,
      type: 'ATHENA',
      dataSourceParameters: {
        athenaParameters: {
          workGroup: `${PROJECT_NAME}-quicksight`,
        },
      },
    });

    // SPICE datasets for dashboard performance
    const riskPostureDataset = new quicksight.CfnDataSet(this, 'RiskPostureDataset', {
      awsAccountId: cdk.Stack.of(this).account,
      dataSetId: `${PROJECT_NAME}-risk-posture-dataset`,
      name: 'Risk Posture Metrics',
      importMode: 'SPICE',
      physicalTableMap: {
        s3Table: {
          s3Source: {
            dataSourceArn: s3DataSource.attrArn,
            inputColumns: [
              { name: 'timestamp', type: 'DATETIME' },
              { name: 'risk_score', type: 'INTEGER' },
              { name: 'category', type: 'STRING' },
              { name: 'severity', type: 'STRING' },
              { name: 'control_id', type: 'STRING' },
              { name: 'compliance_status', type: 'STRING' },
            ],
          },
        },
      },
      logicalTableMap: {
        riskTable: {
          alias: 'RiskPosture',
          source: { physicalTableId: 's3Table' },
        },
      },
      refreshConfiguration: {
        incrementalRefresh: {
          lookbackWindow: {
            columnName: 'timestamp',
            size: 1,
            sizeUnit: 'DAY',
          },
        },
      },
      permissions: [
        {
          principal: quickSightRole.roleArn,
          actions: ['quicksight:DescribeDataSet', 'quicksight:DescribeDataSetPermissions', 'quicksight:PassDataSet', 'quicksight:DescribeIngestion', 'quicksight:ListIngestions', 'quicksight:UpdateDataSet'],
        },
      ],
    });

    const aiInventoryDataset = new quicksight.CfnDataSet(this, 'AiInventoryDataset', {
      awsAccountId: cdk.Stack.of(this).account,
      dataSetId: `${PROJECT_NAME}-ai-inventory-dataset`,
      name: 'AI Inventory',
      importMode: 'SPICE',
      physicalTableMap: {
        s3Table: {
          s3Source: {
            dataSourceArn: s3DataSource.attrArn,
            inputColumns: [
              { name: 'model_id', type: 'STRING' },
              { name: 'model_name', type: 'STRING' },
              { name: 'version', type: 'STRING' },
              { name: 'status', type: 'STRING' },
              { name: 'endpoint', type: 'STRING' },
              { name: 'last_evaluated', type: 'DATETIME' },
              { name: 'drift_status', type: 'STRING' },
              { name: 'bias_status', type: 'STRING' },
            ],
          },
        },
      },
      logicalTableMap: {
        inventoryTable: {
          alias: 'AIInventory',
          source: { physicalTableId: 's3Table' },
        },
      },
      refreshConfiguration: {
        incrementalRefresh: {
          lookbackWindow: {
            columnName: 'last_evaluated',
            size: 1,
            sizeUnit: 'DAY',
          },
        },
      },
    });

    // Dashboard definition with 5 core views
    const dashboard = new quicksight.CfnDashboard(this, 'VgsDashboard', {
      awsAccountId: cdk.Stack.of(this).account,
      dashboardId: `${PROJECT_NAME}-executive-dashboard`,
      name: `${PROJECT_NAME} Executive Dashboard`,
      versionDescription: 'Initial version with 5 core views',
      dashboardPublishOptions: {
        adHocFilteringOption: { availabilityStatus: 'ENABLED' },
        exportToPDFOption: { availabilityStatus: 'ENABLED' },
        sheetControlsOption: { visibilityState: 'EXPANDED' },
      },
      permissions: [
        {
          principal: quickSightRole.roleArn,
          actions: ['quicksight:DescribeDashboard', 'quicksight:ListDashboardVersions', 'quicksight:QueryDashboard'],
        },
      ],
    });
    this.quickSightDashboardArn = dashboard.attrArn;

    // ── Bedrock Prompt Optimization Configs ──────────────────────────────────
    // S3 bucket for prompt optimization templates
    this.promptOptimizationBucket = new s3.Bucket(this, 'PromptOptimizationBucket', {
      bucketName: `${PROJECT_NAME}-prompts-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Lambda evaluation function for structured output scoring
    const promptEvaluationLambda = new lambda.Function(this, 'PromptEvaluationFunction', {
      functionName: `${PROJECT_NAME}-prompt-evaluator-${props.environment}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/govern/prompt-evaluation'),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        PROMPT_BUCKET: this.promptOptimizationBucket.bucketName,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    this.promptOptimizationBucket.grantReadWrite(promptEvaluationLambda);

    // ── Lambda: Dashboard Data Prep ─────────────────────────────────────────
    const dashboardDataPrep = new lambda.Function(this, 'DashboardDataPrep', {
      functionName: `${PROJECT_NAME}-dashboard-data-prep-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/govern/dashboard-data-prep'),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        DASHBOARD_DATASET_PREFIX: 'quicksight/datasets/',
        NEPTUNE_ENDPOINT: 'placeholder-neptune-endpoint',
        KMS_KEY_ARN: props.kmsKey.keyArn,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    // Schedule every 5 minutes for standard metrics
    new events.Rule(this, 'DashboardDataPrepSchedule', {
      ruleName: `${PROJECT_NAME}-dashboard-prep-schedule`,
      description: 'Refresh QuickSight dashboard datasets',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(dashboardDataPrep)],
    });

    // ── Lambda: NL Summary Generator ─────────────────────────────────────────
    const nlSummaryQueue = new sqs.Queue(this, 'NlSummaryQueue', {
      queueName: `${PROJECT_NAME}-nl-summary-${props.environment}`,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new sqs.Queue(this, 'NlSummaryDLQ', {
          queueName: `${PROJECT_NAME}-nl-summary-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.kmsKey,
        }),
      },
    });

    const nlSummaryGenerator = new lambda.Function(this, 'NlSummaryGenerator', {
      functionName: `${PROJECT_NAME}-nl-summary-generator-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/govern/nl-summary-generator'),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0',
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        KMS_KEY_ARN: props.kmsKey.keyArn,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    nlSummaryGenerator.addEventSource(new lambda.EventSourceMapping(this, 'NlSummaryQueueMapping', {
      target: nlSummaryGenerator,
      eventSourceArn: nlSummaryQueue.queueArn,
      batchSize: 1,
    }));

    // ── Escalation Topic ─────────────────────────────────────────────────────
    this.escalationTopic = new sns.Topic(this, 'EscalationTopic', {
      topicName: `${PROJECT_NAME}-escalation-${props.environment}`,
      displayName: `${PROJECT_NAME} Alert Escalation`,
      masterKey: props.kmsKey,
    });

    // ── Lambda: Escalation Router ───────────────────────────────────────────
    const escalationRouter = new lambda.Function(this, 'EscalationRouter', {
      functionName: `${PROJECT_NAME}-escalation-router-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda/govern/escalation-router'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ESCALATION_TOPIC_ARN: this.escalationTopic.topicArn,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        LOG_LEVEL: 'INFO',
      },
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      role: props.baseRole,
    });

    this.escalationTopic.grantPublish(escalationRouter);

    // ── EventBridge Rules for Automated Escalation ─────────────────────────
    // Critical risk events → immediate escalation
    new events.Rule(this, 'CriticalRiskEscalationRule', {
      ruleName: `${PROJECT_NAME}-critical-risk-escalation`,
      description: 'Escalate critical risk events immediately',
      eventBus: props.eventBus,
      eventPattern: {
        source: [`${PROJECT_NAME}.security`, `${PROJECT_NAME}.compliance`],
        detailType: ['RiskEvent', 'ComplianceViolation', 'ModelDriftAlert'],
        detail: {
          riskClassification: ['CRITICAL', 'HIGH'],
        },
      },
      targets: [
        new targets.LambdaFunction(escalationRouter),
        new targets.SnsTopic(this.escalationTopic),
      ],
    });

    // Medium risk events → delayed escalation (15 min SLA)
    new events.Rule(this, 'MediumRiskEscalationRule', {
      ruleName: `${PROJECT_NAME}-medium-risk-escalation`,
      description: 'Escalate medium risk events within SLA',
      eventBus: props.eventBus,
      eventPattern: {
        source: [`${PROJECT_NAME}.security`, `${PROJECT_NAME}.compliance`],
        detailType: ['RiskEvent', 'ComplianceViolation'],
        detail: {
          riskClassification: ['MEDIUM'],
        },
      },
      targets: [new targets.SqsQueue(new sqs.Queue(this, 'MediumRiskQueue', {
        queueName: `${PROJECT_NAME}-medium-risk-queue`,
        visibilityTimeout: cdk.Duration.seconds(900),
        retentionPeriod: cdk.Duration.days(14),
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: props.kmsKey,
      }))],
    });

    // CloudWatch alarms for dashboard health
    const dashboardErrorAlarm = new cloudwatch.Alarm(this, 'DashboardErrorAlarm', {
      alarmName: `${PROJECT_NAME}-dashboard-errors`,
      alarmDescription: 'Alarm for dashboard data preparation failures',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: { FunctionName: dashboardDataPrep.functionName },
        statistic: cloudwatch.Statistic.SUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    dashboardErrorAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.escalationTopic));

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'QuickSightDashboardArn', { value: this.quickSightDashboardArn });
    new cdk.CfnOutput(this, 'EscalationTopicArn', { value: this.escalationTopic.topicArn });
    new cdk.CfnOutput(this, 'PromptOptimizationBucketArn', { value: this.promptOptimizationBucket.bucketArn });
  }
}
