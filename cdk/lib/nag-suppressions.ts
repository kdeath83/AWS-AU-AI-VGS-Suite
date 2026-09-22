/**
 * cdk-nag suppressions for the AWS AU AI VGS Suite.
 *
 * Three packs run against every stack — AwsSolutions, NIST 800-53 R5 and HIPAA Security — so
 * one missing control is reported two or three times under different IDs. The entries below
 * are the findings this reference deployment deliberately does not action.
 *
 * This file is a decision log, not a mute button. Everything that could be fixed was fixed in
 * the stacks instead and is deliberately absent here: TLS enforcement on all 15 queues and 4
 * buckets, bucket versioning, a KMS-encrypted VPC flow log group, encrypted notification
 * topics, a dead-letter queue on the medium-risk queue, alarm actions wired to a real topic,
 * current Lambda runtimes, Neptune auto minor version upgrade, a customer managed key on the
 * SageMaker endpoint config, and public-IP auto-assignment off the NAT-only subnets.
 *
 * Anything added below needs a reason specific enough that a reviewer can challenge it.
 * "Not applicable to a demo" is not a reason.
 *
 * Scope is stack-level throughout. That is a readability trade-off and it does mean a *future*
 * wildcard IAM action in the same stack would also pass — the reasons therefore name exactly
 * what is being accepted, so a reviewer can tell deliberate acceptance from oversight.
 */
import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';

interface Suppression {
  id: string;
  reason: string;
}

/** Findings that are inherent to how CDK generates IAM, not to how this suite is written. */
const IAM_SUPPRESSIONS: Suppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Wildcard actions come from CDK grant methods that cannot enumerate every action they ' +
      'cover — s3:GetObject*, s3:List*, kms:GenerateDataKey* against the ARNs of buckets and ' +
      'keys created by this suite, never against "*". Hand-authoring these policies would ' +
      'mean replacing CDK grant behaviour and drifting from it on library upgrades.',
  },
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'The only AWS managed policies attached anywhere in the suite are ' +
      'AWSLambdaBasicExecutionRole and AmazonAPIGatewayPushToCloudWatchLogs, both attached by ' +
      'CDK constructs rather than by hand. Removing them means replacing those constructs\u2019 ' +
      'default roles to scope down permissions that are already limited to log delivery.',
  },
  {
    id: 'NIST.800.53.R5-IAMNoInlinePolicy',
    reason:
      'CDK attaches inline policies to the roles it creates — the base role\u2019s grant policy ' +
      'and the per-function roles. Inline policies are how CDK ties a grant to one role\u2019s ' +
      'lifecycle; converting them to managed policies means pre-creating and naming policies ' +
      'CDK otherwise owns and cleans up.',
  },
  {
    id: 'HIPAA.Security-IAMNoInlinePolicy',
    reason:
      'Same reasoning as the NIST variant: CDK creates inline policies on the roles it ' +
      'generates, and the grants they carry are scoped to suite resources.',
  },
];

/** Lambda-level controls that the suite intentionally handles at the queue or account layer. */
const LAMBDA_SUPPRESSIONS: Suppression[] = [
  {
    id: 'NIST.800.53.R5-LambdaDLQ',
    reason:
      'The functions invoked by SQS event sources use the queue\u2019s own dead-letter queue — ' +
      'each queue has one with a bounded receive count, which is the correct destination for ' +
      'that invocation type. For the functions invoked asynchronously (Config rule ' +
      'evaluations), failures surface through CloudWatch alarms on their metrics. No function ' +
      'has a per-function Lambda dead-letter destination.',
  },
  {
    id: 'HIPAA.Security-LambdaDLQ',
    reason:
      'Same reasoning as the NIST variant: SQS-invoked functions fail into the source ' +
      'queue\u2019s dead-letter queue, and asynchronous failures are alarmed on rather than ' +
      'routed to a per-function destination.',
  },
  {
    id: 'NIST.800.53.R5-LambdaConcurrency',
    reason:
      'No function reserves concurrency. Back-pressure in this design comes from the queues ' +
      '(visibility timeouts, batch sizes, bounded receive counts); pinning a fixed reservation ' +
      'per function would throttle the pollers and can starve them of capacity. Account-level ' +
      'concurrency is a deployment-time setting, not a stack property.',
  },
  {
    id: 'HIPAA.Security-LambdaConcurrency',
    reason:
      'Same reasoning as the NIST variant: concurrency is bounded at the queue layer and at ' +
      'the account level rather than reserved per function.',
  },
];

/** Network and data controls accepted for a single-region reference deployment. */
const INFRA_SUPPRESSIONS: Suppression[] = [
  {
    id: 'NIST.800.53.R5-VPCNoUnrestrictedRouteToIGW',
    reason:
      'The public subnets carry a 0.0.0.0/0 route to the internet gateway because NAT ' +
      'gateways must live in a subnet that has one. No application compute is placed there — ' +
      'every function runs in PRIVATE_WITH_EGRESS subnets, and the public subnets do not ' +
      'auto-assign public IPs.',
  },
  {
    id: 'HIPAA.Security-VPCNoUnrestrictedRouteToIGW',
    reason:
      'Same reasoning as the NIST variant: the internet route exists to serve the NAT ' +
      'gateways, and no workload runs in the public tier.',
  },
  {
    id: 'NIST.800.53.R5-VPCDefaultSecurityGroupClosed',
    reason:
      'AWS creates a default security group in every VPC and CDK\u2019s Vpc construct does not ' +
      'remove it. Nothing in the suite attaches it to a resource or references it in a rule, ' +
      'so it carries no traffic. Deleting it needs a custom resource.',
  },
  {
    id: 'HIPAA.Security-VPCDefaultSecurityGroupClosed',
    reason:
      'Same reasoning as the NIST variant: the default security group is unused and ' +
      'unreferenced, and removing it requires a custom resource.',
  },
  {
    id: 'NIST.800.53.R5-S3BucketReplicationEnabled',
    reason:
      'Cross-region replication is out of scope for a single-region reference deployment: it ' +
      'needs a destination bucket, a replication role and versioning in both regions. The ' +
      'evidence lake is versioned with a 7-year lifecycle and CloudTrail validates its own ' +
      'log-file digests, so integrity is covered; regional durability is a decision for a ' +
      'real deployment.',
  },
  {
    id: 'HIPAA.Security-S3BucketReplicationEnabled',
    reason:
      'Same reasoning as the NIST variant: this is a single-region reference deployment, and ' +
      'the evidence lake relies on versioning plus CloudTrail log-file validation.',
  },
  {
    id: 'AwsSolutions-S1',
    reason:
      'Known gap, accepted deliberately: these buckets have no server access logging. The ' +
      'suite\u2019s audit trail is the CloudTrail organisation trail, which records management ' +
      'events but NOT individual object reads, so bucket-level access logging would add ' +
      'coverage this does not have. It needs a dedicated log-target bucket, which is not part ' +
      'of this reference implementation.',
  },
  {
    id: 'NIST.800.53.R5-S3BucketLoggingEnabled',
    reason:
      'Same accepted gap as AwsSolutions-S1: server access logging is not enabled, and the ' +
      'CloudTrail trail does not cover object-level reads.',
  },
  {
    id: 'HIPAA.Security-S3BucketLoggingEnabled',
    reason:
      'Same accepted gap: server access logging is not enabled on these buckets, and the ' +
      'CloudTrail trail records management events rather than individual object accesses.',
  },
  {
    id: 'NIST.800.53.R5-DynamoDBInBackupPlan',
    reason:
      'The agent registry table has point-in-time recovery enabled, which covers restore to ' +
      'any second in the last 35 days. It is not additionally registered with AWS Backup, ' +
      'which would mean creating a vault and plan for a table whose data is reproducible from ' +
      'the registry\u2019s own source events.',
  },
  {
    id: 'HIPAA.Security-DynamoDBInBackupPlan',
    reason:
      'Same reasoning as the NIST variant: point-in-time recovery is enabled on the table, ' +
      'and no AWS Backup plan or vault is created.',
  },
];

/** The demo API and its single health endpoint. */
const API_SUPPRESSIONS: Suppression[] = [
  {
    id: 'AwsSolutions-APIG2',
    reason:
      'The API\u2019s only method is a health check that takes no body and no parameters, so a ' +
      'request validator has nothing to validate. Any method accepting input would need one.',
  },
  {
    id: 'AwsSolutions-APIG1',
    reason:
      'The API stage serves a single health endpoint and has no access logging or execution ' +
      'role configured. Enabling it means provisioning a log group and a stage-level role for ' +
      'one method.',
  },
  {
    id: 'AwsSolutions-COG4',
    reason:
      'Deliberately omitted from the reference implementation: the method is an unauthenticated ' +
      'health check. A real deployment would front it with a Cognito user pool or IAM ' +
      'authorizer, and this is called out in the README rather than silently accepted.',
  },
  {
    id: 'NIST.800.53.R5-APIGWCacheEnabledAndEncrypted',
    reason:
      'Stage caching is switched off on purpose: it bills per hour per cache size, and the ' +
      'stage serves one health check where a cache would add cost and staleness for no gain.',
  },
  {
    id: 'HIPAA.Security-APIGWCacheEnabledAndEncrypted',
    reason:
      'Same reasoning as the NIST variant: caching is disabled deliberately for a single ' +
      'health endpoint.',
  },
  {
    id: 'NIST.800.53.R5-APIGWSSLEnabled',
    reason:
      'This rule looks for an ACM certificate on the stage\u2019s custom domain. No custom ' +
      'domain is created, so the API is only reachable via the default execute-api endpoint, ' +
      'which is HTTPS-only.',
  },
  {
    id: 'HIPAA.Security-APIGWSSLEnabled',
    reason:
      'Same reasoning as the NIST variant: the API is served from the HTTPS-only default ' +
      'execute-api endpoint and no custom domain or certificate exists.',
  },
];

/** Remaining singleton findings. */
const MISCELLANEOUS_SUPPRESSIONS: Suppression[] = [
  {
    id: 'NIST.800.53.R5-WAFv2LoggingEnabled',
    reason:
      'The web ACL has no logging destination. WAF logging needs a log group whose name ' +
      'begins with aws-waf-logs- plus the required resource policy; the ACL\u2019s activity is ' +
      'visible through CloudWatch metrics, and full request logging would establish a second ' +
      'log pipeline alongside CloudTrail.',
  },
  {
    id: 'HIPAA.Security-WAFv2LoggingEnabled',
    reason:
      'Same reasoning as the NIST variant: the web ACL emits CloudWatch metrics but no ' +
      'aws-waf-logs- destination is configured.',
  },
  {
    id: 'AwsSolutions-SMG4',
    reason:
      'The secret holds a third-party model credential. Automatic rotation requires a Lambda ' +
      'that implements that provider\u2019s own rotation API, which the suite cannot supply. ' +
      'The secret is encrypted with the suite CMK and readable only by the base execution role.',
  },
  {
    id: 'NIST.800.53.R5-SecretsManagerRotationEnabled',
    reason:
      'Same constraint: the credential belongs to an external provider with no rotation ' +
      'endpoint this suite can call, so no automatic rotation schedule is set.',
  },
  {
    id: 'HIPAA.Security-SecretsManagerRotationEnabled',
    reason:
      'Same constraint: automatic rotation is not scheduled because the secret holds a ' +
      'third-party model credential with no provider rotation API available to this suite.',
  },
  {
    id: 'CdkNagValidationFailure',
    reason:
      'Validation failures, not findings. The VPC interface endpoint security groups scope ' +
      'their ingress to the VPC CIDR, which resolves to an intrinsic function at synth time, ' +
      'so cdk-nag cannot evaluate the ingress rules and reports them as unvalidated. The ' +
      'synthesised template confirms every one of those rules permits port 443 from the VPC ' +
      'range only — no 0.0.0.0/0 ingress and no SSH.',
  },
];

export const DOCUMENTED_SUPPRESSIONS: Suppression[] = [
  ...IAM_SUPPRESSIONS,
  ...LAMBDA_SUPPRESSIONS,
  ...INFRA_SUPPRESSIONS,
  ...API_SUPPRESSIONS,
  ...MISCELLANEOUS_SUPPRESSIONS,
];

/**
 * Apply every documented suppression to each stack. Call after the nag packs are attached.
 */
export function applyDocumentedSuppressions(stacks: cdk.Stack[]): void {
  for (const stack of stacks) {
    NagSuppressions.addStackSuppressions(stack, DOCUMENTED_SUPPRESSIONS);
  }
}
