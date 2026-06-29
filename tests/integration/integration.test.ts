/**
 * tests/integration/integration.test.ts
 * Integration test script that validates deployed resources.
 * Run after deployment to verify all stacks are functional.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Integration test configuration
const TEST_CONFIG = {
  region: process.env.AWS_REGION || 'ap-southeast-2',
  environment: process.env.ENVIRONMENT || 'dev',
  projectName: 'aws-au-ai-vgs-suite',
  timeoutSeconds: 60,
};

interface TestResult {
  test: string;
  passed: boolean;
  message: string;
  duration: number;
}

async function runAwsCommand(command: string): Promise<string> {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      timeout: TEST_CONFIG.timeoutSeconds * 1000,
      env: { ...process.env, AWS_REGION: TEST_CONFIG.region },
    }).trim();
  } catch (error) {
    throw new Error(`AWS command failed: ${command} - ${(error as Error).message}`);
  }
}

async function testVpcExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const vpcs = await runAwsCommand(
      `aws ec2 describe-vpcs --filters "Name=tag:Project,Values=${TEST_CONFIG.projectName}" --query "Vpcs[0].VpcId" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'VPC exists',
      passed: vpcs !== 'None' && vpcs.startsWith('vpc-'),
      message: `VPC ID: ${vpcs}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'VPC exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testEvidenceBucketExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const bucket = await runAwsCommand(
      `aws s3api list-buckets --query "Buckets[?starts_with(Name, \`${TEST_CONFIG.projectName}-evidence-${TEST_CONFIG.environment}-\`)].Name | [0]" --output text`
    );
    return {
      test: 'Evidence bucket exists',
      passed: bucket !== 'None' && bucket.includes('evidence'),
      message: `Bucket: ${bucket}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'Evidence bucket exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testKmsKeyExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const keyId = await runAwsCommand(
      `aws kms list-aliases --query "Aliases[?AliasName==\`alias/${TEST_CONFIG.projectName}-${TEST_CONFIG.environment}\`].TargetKeyId | [0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'KMS key exists',
      passed: keyId !== 'None' && keyId.startsWith('arn:aws:kms'),
      message: `Key: ${keyId}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'KMS key exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testEventBusExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const busName = await runAwsCommand(
      `aws events list-event-buses --query "EventBuses[?Name==\`${TEST_CONFIG.projectName}-events-${TEST_CONFIG.environment}\`].Name | [0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'EventBridge bus exists',
      passed: busName !== 'None',
      message: `Bus: ${busName}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'EventBridge bus exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testGuardDutyEnabled(): Promise<TestResult> {
  const start = Date.now();
  try {
    const detectorId = await runAwsCommand(
      `aws guardduty list-detectors --query "DetectorIds[0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'GuardDuty enabled',
      passed: detectorId !== 'None' && detectorId.length > 0,
      message: `Detector: ${detectorId}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'GuardDuty enabled', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testWafWebAclExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const aclId = await runAwsCommand(
      `aws wafv2 list-web-acls --scope REGIONAL --query "WebACLs[?Name==\`${TEST_CONFIG.projectName}-ai-waf-${TEST_CONFIG.environment}\`].Id | [0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'WAF WebACL exists',
      passed: aclId !== 'None',
      message: `ACL ID: ${aclId}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'WAF WebACL exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testApiGatewayExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const apiId = await runAwsCommand(
      `aws apigateway get-rest-apis --query "items[?name==\`${TEST_CONFIG.projectName}-api-${TEST_CONFIG.environment}\`].id | [0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'API Gateway exists',
      passed: apiId !== 'None',
      message: `API ID: ${apiId}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'API Gateway exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testLambdaFunctionsExist(): Promise<TestResult> {
  const start = Date.now();
  try {
    const functions = await runAwsCommand(
      `aws lambda list-functions --query "Functions[?starts_with(FunctionName, \`${TEST_CONFIG.projectName}-\`)].FunctionName" --output text --region ${TEST_CONFIG.region}`
    );
    const functionCount = functions.split('\t').filter((f) => f.trim()).length;
    return {
      test: 'Lambda functions exist',
      passed: functionCount >= 9, // At least 9 lambdas expected
      message: `${functionCount} Lambda functions found`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'Lambda functions exist', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testNeptuneClusterExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const clusterId = await runAwsCommand(
      `aws neptune describe-db-clusters --query "DBClusters[?DBClusterIdentifier==\`${TEST_CONFIG.projectName}-neptune-${TEST_CONFIG.environment}\`].DBClusterIdentifier | [0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'Neptune cluster exists',
      passed: clusterId !== 'None',
      message: `Cluster: ${clusterId}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'Neptune cluster exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testDynamoDBTableExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const tableName = await runAwsCommand(
      `aws dynamodb list-tables --query "TableNames[?starts_with(@, \`${TEST_CONFIG.projectName}-agent-registry-\`) | [0]" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'DynamoDB registry table exists',
      passed: tableName !== 'None',
      message: `Table: ${tableName}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'DynamoDB registry table exists', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testSQSQueuesExist(): Promise<TestResult> {
  const start = Date.now();
  try {
    const queues = await runAwsCommand(
      `aws sqs list-queues --queue-name-prefix ${TEST_CONFIG.projectName} --query "QueueUrls" --output text --region ${TEST_CONFIG.region}`
    );
    const queueCount = queues.split('\t').filter((q) => q.trim()).length;
    return {
      test: 'SQS queues exist',
      passed: queueCount >= 5, // At least 5 queues expected
      message: `${queueCount} SQS queues found`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'SQS queues exist', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

async function testCloudTrailEnabled(): Promise<TestResult> {
  const start = Date.now();
  try {
    const trailStatus = await runAwsCommand(
      `aws cloudtrail get-trail-status --name ${TEST_CONFIG.projectName}-org-trail-${TEST_CONFIG.environment} --query "IsLogging" --output text --region ${TEST_CONFIG.region}`
    );
    return {
      test: 'CloudTrail logging',
      passed: trailStatus === 'true',
      message: `Logging: ${trailStatus}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return { test: 'CloudTrail logging', passed: false, message: (error as Error).message, duration: Date.now() - start };
  }
}

// ── Main Test Runner ─────────────────────────────────────────────────────────

async function runIntegrationTests(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     AWS AU AI VGS Suite - Integration Tests                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  console.log(`Region:      ${TEST_CONFIG.region}`);
  console.log(`Environment: ${TEST_CONFIG.environment}`);
  console.log('');

  const tests = [
    testVpcExists,
    testEvidenceBucketExists,
    testKmsKeyExists,
    testEventBusExists,
    testGuardDutyEnabled,
    testWafWebAclExists,
    testApiGatewayExists,
    testLambdaFunctionsExist,
    testNeptuneClusterExists,
    testDynamoDBTableExists,
    testSQSQueuesExist,
    testCloudTrailEnabled,
  ];

  const results: TestResult[] = [];
  for (const test of tests) {
    const result = await test();
    results.push(result);
    const symbol = result.passed ? '✅' : '❌';
    console.log(`${symbol} ${result.test.padEnd(35)} ${result.message} (${result.duration}ms)`);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ❌ ${r.test}: ${r.message}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All integration tests passed!');
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  runIntegrationTests().catch((error) => {
    console.error('Integration tests failed:', error);
    process.exit(1);
  });
}

export { runIntegrationTests };
