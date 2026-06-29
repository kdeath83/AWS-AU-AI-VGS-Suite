# Code Review: AWS-AU-AI-VGS-Suite

**Date**: June 2026
**Scope**: Security, Performance, Logic Bugs
**Standards**: APRA CPS 234, CPS 230, ASIC 26-092MR, AWS Well-Architected

---

## CRITICAL (6)

### C1. Harness Execution Role — Wildcard Bedrock Model Resources
- **File**: `cdk/lib/validate-stack.ts:240-248`
- **Category**: SECURITY
- **CPS 234**: CPS234-4 (Control Implementation)
- **Issue**: `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream` + `bedrock-agentcore:InvokeHarness` all granted on `resources: ['*']`. Any harness can invoke ANY model in the account.
- **Fix**: Scope to specific foundation model ARNs:
```typescript
resources: [
  `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-opus-4-8`,
  `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-fable-5`,
  // ... all authorized models
]
```

### C2. API Gateway Resource Policy — AnyPrincipal
- **File**: `cdk/lib/secure-stack.ts:281`
- **Category**: SECURITY
- **CPS 234**: CPS234-4
- **Issue**: `new iam.AnyPrincipal()` with only `aws:RequestedRegion` condition. Any IAM principal in the account can invoke AI governance endpoints.
- **Fix**: Restrict to specific roles or use principal tag conditions.

### C3. Hardcoded Identity API Key ARN in Lambda Env
- **File**: `cdk/lib/validate-stack.ts:501`
- **Category**: SECURITY
- **Issue**: `arn:aws:bedrock-agentcore:...:api-key-credential/opencode-go-key` hardcoded as env var. Credential rotation silently breaks the function.
- **Fix**: Use SSM Parameter Store or Secrets Manager for the ARN reference.

### C4. Base IAM Role — Wildcard CloudWatch Logs
- **File**: `cdk/lib/shared-stack.ts:121-136`
- **Category**: SECURITY
- **CPS 234**: CPS234-4
- **Issue**: All 12+ Lambda functions share one role with `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `resources: ['*']`.
- **Fix**: Scope to log group pattern: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${PROJECT_NAME}-*:*`

### C5. Prompt Injection Detector Logs Raw User PII
- **File**: `src/lambda/secure/prompt-injection-detector/index.ts:101-107`
- **Category**: SECURITY
- **CPS 234**: CPS234-2 (Information Asset Classification)
- **Issue**: `promptSnippet: prompt.substring(0, 200)` captures raw user prompts (potentially containing TFNs, bank account numbers, names) into structured CloudWatch logs.
- **Fix**: Sanitize prompt content before logging or log only detection metadata (attackType, confidence) without prompt content.

### C6. SageMaker Roles — Wildcard S3 Resources
- **File**: `cdk/lib/validate-stack.ts:106-119, 155-166`
- **Category**: SECURITY
- **CPS 234**: CPS234-4
- **Issue**: SageMaker execution and Clarify roles have `s3:GetObject/PutObject/ListBucket` on `resources: ['*']`.
- **Fix**: Scope to specific evidence bucket:
```typescript
resources: [props.evidenceBucket.bucketArn, `${props.evidenceBucket.bucketArn}/*`]
```

---

## HIGH (9)

### H1. API Gateway Health Check — No Authentication
- **File**: `cdk/lib/secure-stack.ts:301-306`
- **Category**: SECURITY
- **Issue**: Health check endpoint uses `MockIntegration` without `authorizationType`. Combined with AnyPrincipal (C2), this exposes an unauthenticated endpoint.
- **Fix**: Add `authorizationType: apigw.AuthorizationType.IAM`.

### H2. Circuit Breaker Never Resets Properly
- **File**: `src/shared/utils.ts:164-166`
- **Category**: BUG
- **Issue**: On success in CLOSED state, `failureCount = Math.max(0, failureCount - 1)` — decrements by 1 instead of resetting to 0. Intermittent failures accumulate indefinitely. 3 failures + 1 success + 1 failure = 3, not 1.
- **Fix**: `this.failureCount = 0; // Reset on success in CLOSED state`

### H3. CloudTrail Config Rule — Empty Required Parameters
- **File**: `cdk/lib/secure-stack.ts:543-544`
- **Category**: BUG
- **Issue**: `CLOUD_TRAIL_ENABLED` rule has `s3BucketName: ''` and `snsTopicArn: ''` — empty strings that will cause persistent evaluation failure.
- **Fix**: Either omit parameters or provide valid values from stack resources.

### H4. Test File Imports Non-Existent `ShieldStack`
- **File**: `cdk/test/cdk.test.ts:10,24`
- **Category**: BUG
- **Issue**: Imports `ShieldStack` from `../lib/secure-stack` but the exported class is `SecureStack`. Tests won't compile.
- **Fix**: Rename all `ShieldStack` references to `SecureStack`.

### H5. Lambda Test Import Path Mismatch
- **File**: `tests/unit/prompt-injection-detector.test.ts:6`
- **Category**: BUG
- **Issue**: Imports from `../../src/lambda/shield/prompt-injection-detector` — directory is `secure/`, not `shield/`.
- **Fix**: Change path to `../../src/lambda/secure/prompt-injection-detector`.

### H6. Deploy Script References "ShieldStack"
- **File**: `scripts/deploy.sh:89`
- **Category**: BUG
- **Issue**: Echo statement says `SharedStack → ShieldStack → ValidateStack → GovernStack`. Stack name is `SecureStack`.
- **Fix**: Change `ShieldStack` to `SecureStack`.

### H7. SQS Visibility Timeout Equals Lambda Timeout
- **File**: `cdk/lib/validate-stack.ts:473-496`
- **Category**: PERFORMANCE
- **Issue**: Queue `visibilityTimeout: 300s` = Lambda `timeout: 300s`. If Lambda takes full 300s, message becomes visible before Lambda finishes → duplicate processing.
- **Fix**: Set visibility timeout to 360s minimum (AWS recommends 6× Lambda timeout).

### H8. VPC Lambda Cold Starts — No Provisioned Concurrency
- **File**: All Lambda definitions across stacks
- **Category**: PERFORMANCE
- **Issue**: All functions in VPC private subnets with no provisioned concurrency. Cold starts of 2-10s due to ENI provisioning. `prompt-injection-detector` (10s timeout) could exhaust entire budget on cold start.
- **Fix**: Add provisioned concurrency for latency-sensitive functions.

### H9. No SQS DLQ Monitoring or Alarms
- **File**: All stacks (shared, secure, validate, govern)
- **Category**: BUG
- **CPS 234**: CPS234-5 (Incident Management)
- **Issue**: All DLQs configured but no CloudWatch alarms on DLQ depth. Messages failing 3 times are abandoned without notification.
- **Fix**: Add CloudWatch alarms for all DLQs:
```typescript
new cloudwatch.Alarm(this, 'DLQAlarm', {
  metric: dlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
});
```

---

## MEDIUM (11)

### M1. Patch Compliance Checker — Hardcoded Placeholder Instance ID
- **File**: `src/lambda/secure/patch-compliance-checker/index.ts:128`
- **Category**: BUG
- **Issue**: `instanceIds = ['i-placeholder-001']` — will never find a real instance.
- **Fix**: Use `DescribeInstanceInformation` with tag-based filtering.

### M2. NL Summary Generator — Always Returns Mock Data
- **File**: `src/lambda/govern/nl-summary-generator/index.ts:84-113`
- **Category**: BUG
- **Issue**: `fetchSourceData()` unconditionally returns hardcoded mock `RiskPostureSummary`. Board/regulator summaries report fabricated data.
- **Fix**: Fetch from S3, QuickSight, or Neptune. Implement real data pipeline.

### M3. Dashboard Data Prep — Incomplete Metric Aggregation
- **File**: `src/lambda/govern/dashboard-data-prep/index.ts:69-78`
- **Category**: BUG
- **Issue**: Counts files by prefix but never parses their contents. `patchCompliant` and `patchNonCompliant` always remain 0.
- **Fix**: Download and parse representative objects to extract severity/compliance fields.

### M4. CloudTrail S3 Bucket — SSE-S3 Instead of SSE-KMS
- **File**: `cdk/lib/shared-stack.ts:160`
- **Category**: SECURITY
- **CPS 234**: CPS234-7 (Internal Audit)
- **Issue**: Bucket encryption is `S3_MANAGED` (SSE-S3) while the trail itself uses KMS. Audit log data deserves KMS encryption.
- **Fix**: Change to `encryption: s3.BucketEncryption.KMS` with the same KMS key.

### M5. Neptune Cluster — No Backup Retention Configured
- **File**: `cdk/lib/validate-stack.ts:70-89`
- **Category**: SECURITY
- **CPS 234**: CPS234-6 (Testing), CPS234-7
- **Issue**: `CfnDBCluster` has `deletionProtection: true` but no `backupRetentionPeriod`. Data loss would impair compliance evidence.
- **Fix**: Add `backupRetentionPeriod: 35` and `preferredBackupWindow`.

### M6. Audit Evidence Collector — No Pagination
- **File**: `src/lambda/validate/audit-evidence-collector/index.ts:30-63,66-99,101-134`
- **Category**: BUG
- **Issue**: All three collection functions use `MaxResults: 50` with no `NextToken` pagination. Excess evidence silently dropped. 24-hour window could miss 99%+ of findings in active accounts.
- **Fix**: Implement pagination loops using `NextToken`.

### M7. Prompt Injection Detector — No Input Size Validation
- **File**: `src/lambda/secure/prompt-injection-detector/index.ts:83`
- **Category**: SECURITY
- **Issue**: Accepts `payload.prompt` with no size limit. Multi-megabyte prompt could exhaust 256MB Lambda memory (DoS).
- **Fix**: Add `if (prompt.length > 10000) return { statusCode: 413 }`.

### M8. `withRetry` — Doesn't Check Lambda Remaining Time
- **File**: `src/shared/utils.ts:61-92`
- **Category**: PERFORMANCE
- **Issue**: Retry logic doesn't check `context.getRemainingTimeInMillis()`. Near-timeout retries may be forcibly terminated mid-operation.
- **Fix**: Accept `getRemainingTimeMs` param and skip retries when < 5s remain.

### M9. Bias Report Generator — Hardcoded us-east-1 ECR Image
- **File**: `src/lambda/validate/bias-report-generator/index.ts:68`
- **Category**: BUG
- **Issue**: `ImageUri: '382416733822.dkr.ecr.us-east-1.amazonaws.com/clarify-processing:1.0'` — hardcoded to us-east-1. Cross-region pull in ap-southeast-2 adds latency.
- **Fix**: Use region-specific container URI or SSM parameter lookup.

### M10. Registry Curator — Unsafe Non-Null Assertions
- **File**: `src/lambda/validate/registry-curator/index.ts:125,132-133,159-161`
- **Category**: BUG
- **Issue**: Multiple `!` assertions on DynamoDB image fields (`recordId!`, `recordType!`). Malformed stream records cause uncaught runtime errors.
- **Fix**: Add explicit null checks or call `validateRecord()` before field access.

### M11. CloudWatch Metric — Wildcard Dimension Won't Match
- **File**: `src/lambda/govern/dashboard-data-prep/index.ts:106,118`
- **Category**: BUG
- **Issue**: `Dimensions: [{ Name: 'FunctionName', Value: 'aws-au-ai-vgs-suite-*' }]` — CloudWatch dimensions don't support wildcards. Returns empty results.
- **Fix**: Remove dimension filter and aggregate in query, or list functions first and query individually.

---

## LOW (8)

### L1. Bash Script — `==` in `[` Test
- **File**: `scripts/destroy.sh:55,67`
- **Category**: BUG
- **Fix**: Use `=` with `[` or switch to `[[` consistently.

### L2. Python Lambda — Invalid API Gateway Response Format
- **File**: `src/lambda/govern/prompt-evaluation/index.py:149-155`
- **Category**: BUG
- **Fix**: Return `{ statusCode: 200, headers: {...}, body: json.dumps(data) }` for Lambda proxy integration.

### L3. Missing `.gitignore`
- **File**: DESIGN.md references `.gitignore` but file not present
- **Category**: SECURITY
- **Fix**: Add `.gitignore` with `node_modules/`, `cdk.out/`, `.env`, `*.log`.

### L4. Python Handler — `hasattr(context, "aws_request_id")` Degraded Traceability
- **File**: `src/lambda/govern/prompt-evaluation/index.py:154,164`
- **Category**: BUG
- **Fix**: Accept context changes — this silently falls back to `"unknown"`.

### L5. Integration Test — Flawed GuardDuty Assertion
- **File**: `tests/integration/integration.test.ts:114`
- **Category**: BUG
- **Fix**: `startsWith('')` always returns true — likely intended `detectorId.length > 0`.

### L6. Bias Report — Leading Space in Metric Key
- **File**: `src/lambda/validate/bias-report-generator/index.ts:96`
- **Category**: BUG
- **Fix**: Remove leading space from `' demographic_parity': 0.0`.

### L7. Shared IAM Role — All Lambdas Have Evidence Bucket ReadWrite
- **File**: `cdk/lib/shared-stack.ts:139`
- **Category**: SECURITY
- **Fix**: Create per-function roles with minimum S3 permissions.

### L8. CDK Nag — Will Flag Wildcard Resource Policies
- **File**: `cdk/bin/app.ts:88-96`
- **Category**: SECURITY
- **Fix**: Address wildcard policies (C1, C4, C6) or suppress with documented justifications.

---

## Summary

| Severity | Security | Performance | Bug | **Total** |
|----------|----------|-------------|-----|-----------|
| CRITICAL | 6 | — | — | **6** |
| HIGH | 2 | 2 | 5 | **9** |
| MEDIUM | 2 | 2 | 7 | **11** |
| LOW | 2 | — | 6 | **8** |
| **TOTAL** | **12** | **4** | **18** | **34** |

## APRA CPS 234 Compliance Gaps

| Control | Gap |
|---------|-----|
| CPS234-4 (Control Implementation) | 6 IAM least-privilege violations (C1, C4, C6, C2, L7) |
| CPS234-5 (Incident Management) | DLQ monitoring missing (H9), no alert on message failures |
| CPS234-6 (Testing) | CI/CD pipeline broken — test imports error (H4, H5) |
| CPS234-7 (Internal Audit) | CloudTrail not KMS-encrypted (M4), evidence collector drops paginated data (M6) |
| CPS234-2 (Asset Classification) | PII in CloudWatch logs (C5) |

## Remediation Priority

1. **Fix C1, C4, C6** — IAM scope reduction (fail any APRA audit today)
2. **Fix H4, H5** — test import paths (CI/CD blocked)
3. **Fix H2** — circuit breaker reset logic (resilience degradation)
4. **Fix C2** — API Gateway authorization (exposed endpoints)
5. **Fix H7** — SQS visibility timeout (duplicate processing)
6. **Fix H9** — DLQ CloudWatch alarms (silent failures)
