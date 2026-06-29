/**
 * cdk/lib/shared-stack.ts
 * Shared foundational infrastructure: VPC, S3 Evidence Lake, KMS, IAM, CloudTrail, EventBridge.
 * All other stacks depend on this stack.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { PROJECT_NAME } from './constants';

export interface SharedStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly apraregion: string;
}

export class SharedStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly evidenceBucket: s3.Bucket;
  public readonly kmsKey: kms.Key;
  public readonly eventBus: events.EventBus;
  public readonly baseRole: iam.Role;
  public readonly cloudTrailLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: SharedStackProps) {
    super(scope, id, props);

    // ── KMS Key ─────────────────────────────────────────────────────────────
    // Primary encryption key for all suite resources. Rotates annually.
    this.kmsKey = new kms.Key(this, 'VgsMasterKey', {
      enableKeyRotation: true,
      alias: `alias/${PROJECT_NAME}-${props.environment}`,
      description: `Master encryption key for ${PROJECT_NAME} in ${props.environment}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── VPC ─────────────────────────────────────────────────────────────────
    // Private subnets across 2 AZs. No public subnets — all compute is private.
    this.vpc = new ec2.Vpc(this, 'VgsVpc', {
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
      flowLogs: {
        cloudWatch: {
          logFormat: ec2.FlowLogFileFormat.V2,
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    // VPC Endpoints for AWS services (no public internet egress for service calls)
    const vpcEndpointServices = [
      ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH,
      ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
      ec2.InterfaceVpcEndpointAwsService.KMS,
      ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      ec2.InterfaceVpcEndpointAwsService.SSM,
      ec2.InterfaceVpcEndpointAwsService.STS,
      ec2.InterfaceVpcEndpointAwsService.SNS,
      ec2.InterfaceVpcEndpointAwsService.SQS,
      ec2.InterfaceVpcEndpointAwsService.BEDROCK,
      ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME,
    ];

    vpcEndpointServices.forEach((service) => {
      this.vpc.addInterfaceEndpoint(`${service.shortName}Endpoint`, {
        service,
        privateDnsEnabled: true,
      });
    });

    // S3 Gateway endpoint
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // ── S3 Evidence Lake ────────────────────────────────────────────────────
    // Centralized audit evidence storage. Encrypted, versioned, access-logged.
    this.evidenceBucket = new s3.Bucket(this, 'EvidenceLake', {
      bucketName: `${PROJECT_NAME}-evidence-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsPrefix: 'access-logs/',
      lifecycleRules: [
        {
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
            { storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: cdk.Duration.days(365) },
          ],
          expiration: cdk.Duration.days(2555), // 7 years retention for APRA
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Base IAM Role ─────────────────────────────────────────────────────────
    // Base execution role used by Lambda functions and other compute.
    this.baseRole = new iam.Role(this, 'VgsBaseRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Base execution role for ${PROJECT_NAME}`,
    });

    // Least-privilege policy: allow VPC flow logs, CloudWatch Logs, and X-Ray
    this.baseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
        ],
        resources: [
          `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/lambda/${PROJECT_NAME}-*:*`,
          `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/${PROJECT_NAME}/*:*`,
        ],
      }),
    );

    // Allow base role to write to evidence bucket
    this.evidenceBucket.grantReadWrite(this.baseRole);

    // ── CloudTrail Organization Trail ─────────────────────────────────────────
    // Log ALL API calls across the organization for audit evidence.
    this.cloudTrailLogGroup = new logs.LogGroup(this, 'CloudTrailLogGroup', {
      logGroupName: `/${PROJECT_NAME}/cloudtrail/${props.environment}`,
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: this.kmsKey,
    });

    new cloudtrail.Trail(this, 'OrganizationTrail', {
      trailName: `${PROJECT_NAME}-org-trail-${props.environment}`,
      isMultiRegionTrail: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: this.cloudTrailLogGroup,
      cloudWatchLogsRetention: logs.RetentionDays.ONE_YEAR,
      bucket: new s3.Bucket(this, 'CloudTrailBucket', {
        bucketName: `${PROJECT_NAME}-cloudtrail-${props.environment}-${this.account}`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: this.kmsKey,
        lifecycleRules: [
          {
            transitions: [
              { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
            ],
            expiration: cdk.Duration.days(2555),
          },
        ],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
      encryptionKey: this.kmsKey,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      insightTypes: [
        cloudtrail.InsightType.API_CALL_RATE,
        cloudtrail.InsightType.API_ERROR_RATE,
      ],
    });

    // ── EventBridge Custom Event Bus ────────────────────────────────────────────
    // Central event bus for cross-stack event routing and escalation.
    this.eventBus = new events.EventBus(this, 'VgsEventBus', {
      eventBusName: `${PROJECT_NAME}-events-${props.environment}`,
      description: `Custom event bus for ${PROJECT_NAME} cross-stack communication`,
    });

    // Archive events for replay / audit
    this.eventBus.archive('EventArchive', {
      archiveName: `${PROJECT_NAME}-events-archive`,
      description: 'Archived events for compliance replay and investigation',
      retention: cdk.Duration.days(365),
      eventPattern: {
        source: events.Match.exists(),
      },
    });

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'EvidenceBucketArn', { value: this.evidenceBucket.bucketArn });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: this.kmsKey.keyArn });
    new cdk.CfnOutput(this, 'EventBusArn', { value: this.eventBus.eventBusArn });
    new cdk.CfnOutput(this, 'BaseRoleArn', { value: this.baseRole.roleArn });
  }
}
