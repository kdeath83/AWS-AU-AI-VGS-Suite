/**
 * src/shared/utils.ts
 * Shared utility functions for Lambda handlers in the AWS AU AI VGS Suite.
 * Includes structured logging, retry logic, circuit breaker, and validation helpers.
 */

import * as crypto from 'crypto';

// ── Structured Logging ────────────────────────────────────────────────────────

export interface LogContext {
  [key: string]: unknown;
}

export function logInfo(message: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), message, ...context }));
}

export function logWarn(message: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ level: 'WARN', timestamp: new Date().toISOString(), message, ...context }));
}

export function logError(message: string, error: unknown, context: LogContext = {}): void {
  const errorDetail = error instanceof Error
    ? { errorName: error.name, errorMessage: error.message, errorStack: error.stack }
    : { errorString: String(error) };
  console.log(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), message, ...errorDetail, ...context }));
}

// ── Retry Logic (Exponential Backoff) ─────────────────────────────────────────

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrorPredicate?: (error: unknown) => boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableErrorPredicate: (error: unknown): boolean => {
    if (error instanceof Error) {
      const retryableMessages = [
        'ThrottlingException',
        'TooManyRequestsException',
        'ServiceUnavailable',
        'InternalServerError',
        'RateExceeded',
        'TimeoutError',
        'ECONNRESET',
        'ETIMEDOUT',
      ];
      return retryableMessages.some((msg) => error.message.includes(msg));
    }
    return false;
  },
};

/**
 * Run an operation with exponential backoff.
 *
 * `options` is partial: anything omitted falls back to DEFAULT_RETRY_OPTIONS.
 * When `getRemainingTimeMs` is supplied (Lambdas: `context.getRemainingTimeInMillis`),
 * retrying stops rather than sleeping past the invocation deadline — a retry that
 * cannot finish is worse than a failure that reports itself.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
  logContext: LogContext = {},
  getRemainingTimeMs?: () => number,
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        logInfo(`Operation succeeded after ${attempt} attempts`, { ...logContext, attempts: attempt });
      }
      return result;
    } catch (error) {
      lastError = error;
      const isRetryable = opts.retryableErrorPredicate ? opts.retryableErrorPredicate(error) : true;

      if (!isRetryable || attempt === opts.maxAttempts) {
        logError(
          `Operation failed after ${attempt} attempts (non-retryable or max reached)`,
          error,
          { ...logContext, attempt },
        );
        throw error;
      }

      const delay = Math.min(opts.baseDelayMs * Math.pow(2, attempt - 1), opts.maxDelayMs);
      const remaining = getRemainingTimeMs ? getRemainingTimeMs() : undefined;
      if (remaining !== undefined && remaining < delay + MIN_REMAINING_MS) {
        logError(
          `Abandoning retry: ${Math.round(remaining)}ms left in the invocation, next backoff is ${delay}ms`,
          lastError,
          { ...logContext, attempt, remainingMs: Math.round(remaining) },
        );
        throw lastError;
      }

      logWarn(`Retry attempt ${attempt}/${opts.maxAttempts} after ${delay}ms`, {
        ...logContext,
        attempt,
        delayMs: delay,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Minimum remaining invocation time worth starting another backoff for. */
export const MIN_REMAINING_MS = 250;

// ── Circuit Breaker ─────────────────────────────────────────────────────────

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenMaxCalls: number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30000,
  halfOpenMaxCalls: 3,
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private halfOpenCalls = 0;
  private readonly options: CircuitBreakerOptions;

  /** Options are partial: anything omitted falls back to the defaults. */
  constructor(
    private readonly name: string,
    options: Partial<CircuitBreakerOptions> = {},
  ) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...options };
  }

  async execute<T>(operation: () => Promise<T>, context: LogContext = {}): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - (this.lastFailureTime || 0) > this.options.recoveryTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenCalls = 0;
        logInfo(`Circuit breaker ${this.name} moved to HALF_OPEN`, context);
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    if (this.state === CircuitState.HALF_OPEN && this.halfOpenCalls >= this.options.halfOpenMaxCalls) {
      throw new Error(`Circuit breaker ${this.name} HALF_OPEN call limit reached`);
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenCalls++;
    }

    try {
      const result = await operation();
      this.onSuccess(context);
      return result;
    } catch (error) {
      this.onFailure(context);
      throw error;
    }
  }

  private onSuccess(context: LogContext): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.options.halfOpenMaxCalls) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        logInfo(`Circuit breaker ${this.name} CLOSED`, context);
      }
    } else {
      this.failureCount = 0; // Reset on success in CLOSED state
    }
  }

  private onFailure(context: LogContext): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      logWarn(`Circuit breaker ${this.name} moved to OPEN (half-open failure)`, context);
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
      logWarn(`Circuit breaker ${this.name} moved to OPEN (threshold reached)`, { ...context, failureCount: this.failureCount });
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ── Idempotency ──────────────────────────────────────────────────────────────

export function generateIdempotencyKey(...inputs: string[]): string {
  const hash = crypto.createHash('sha256');
  inputs.forEach((input) => hash.update(input));
  return hash.digest('hex');
}

// ── Validation Helpers ────────────────────────────────────────────────────────

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidARN(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  // Region and account may both be empty (S3 bucket and IAM ARNs, e.g.
  // `arn:aws:s3:::bucket`), the account is exactly 12 digits when present, and the
  // resource segment may itself contain colons (`function:my-function`) plus the
  // wildcard and dot characters used in policy ARNs.
  return /^arn:aws[a-zA-Z0-9-]*:[a-zA-Z0-9-]+:[a-zA-Z0-9-]*:(\d{12})?:[a-zA-Z0-9\-_/:.*]+$/.test(value);
}

export function isValidUUID(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isValidRegion(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  return /^[a-z]{2}-[a-z]+-\d$/.test(value);
}

export function assertDefined<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Required parameter '${name}' is missing`);
  }
  return value;
}

// ── General Utilities ─────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) {
      result[key] = obj[key] as T[keyof T];
    }
  }
  return result;
}
