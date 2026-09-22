/**
 * tests/helpers/mock-context.ts
 * A complete Lambda `Context` for unit tests.
 *
 * `Context` requires `callbackWaitsForEmptyEventLoop`, `logGroupName` and
 * `logStreamName` in addition to the fields tests usually stub, so a partial object
 * literal does not satisfy the type and the suite fails to compile. Build the context
 * here instead of hand-rolling it per test file.
 */

import type { Context } from 'aws-lambda';

export function createMockContext(overrides: Partial<Context> = {}): Context {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:ap-southeast-2:123456789012:function:test',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2026/09/22/[$LATEST]0123456789abcdef',
    getRemainingTimeInMillis: () => 30_000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
    ...overrides,
  };
}
