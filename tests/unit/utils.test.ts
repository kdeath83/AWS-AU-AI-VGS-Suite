/**
 * tests/unit/utils.test.ts
 * Unit tests for shared utility functions.
 */

import {
  logInfo,
  logError,
  withRetry,
  CircuitBreaker,
  CircuitState,
  generateIdempotencyKey,
  isNonEmptyString,
  isValidARN,
  isValidUUID,
  chunkArray,
  sleep,
} from '../../src/shared/utils';

describe('Utils', () => {
  describe('logInfo', () => {
    it('should output structured JSON log', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      logInfo('Test message', { key: 'value' });
      expect(consoleSpy).toHaveBeenCalled();
      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.level).toBe('INFO');
      expect(logged.message).toBe('Test message');
      expect(logged.key).toBe('value');
      consoleSpy.mockRestore();
    });
  });

  describe('logError', () => {
    it('should output structured JSON error log', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const error = new Error('Test error');
      logError('Test error message', error, { context: 'test' });
      expect(consoleSpy).toHaveBeenCalled();
      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.level).toBe('ERROR');
      expect(logged.errorMessage).toBe('Test error');
      consoleSpy.mockRestore();
    });
  });

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await withRetry(operation);
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error and eventually succeed', async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce(new Error('ThrottlingException'))
        .mockResolvedValue('success');
      const result = await withRetry(operation, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw after max attempts', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('ThrottlingException'));
      await expect(withRetry(operation, { maxAttempts: 2, baseDelayMs: 10 })).rejects.toThrow();
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should not retry non-retryable errors', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Permanent failure'));
      await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: 10 })).rejects.toThrow('Permanent failure');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('CircuitBreaker', () => {
    it('should allow calls when closed', async () => {
      const breaker = new CircuitBreaker('test');
      const result = await breaker.execute(async () => 'success');
      expect(result).toBe('success');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should open after threshold failures', async () => {
      const breaker = new CircuitBreaker('test', { failureThreshold: 2, recoveryTimeoutMs: 1000 });
      const operation = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(breaker.execute(operation)).rejects.toThrow();
      await expect(breaker.execute(operation)).rejects.toThrow();

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      await expect(breaker.execute(operation)).rejects.toThrow('Circuit breaker test is OPEN');
    });

    it('should transition to half-open after recovery timeout', async () => {
      const breaker = new CircuitBreaker('test', { failureThreshold: 1, recoveryTimeoutMs: 50 });
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
      await sleep(60);
      await expect(breaker.execute(async () => 'success')).resolves.toBe('success');
    });
  });

  describe('generateIdempotencyKey', () => {
    it('should generate consistent keys for same inputs', () => {
      const key1 = generateIdempotencyKey('a', 'b', 'c');
      const key2 = generateIdempotencyKey('a', 'b', 'c');
      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // SHA-256 hex
    });

    it('should generate different keys for different inputs', () => {
      const key1 = generateIdempotencyKey('a', 'b');
      const key2 = generateIdempotencyKey('a', 'c');
      expect(key1).not.toBe(key2);
    });
  });

  describe('isNonEmptyString', () => {
    it('should return true for non-empty strings', () => {
      expect(isNonEmptyString('hello')).toBe(true);
    });
    it('should return false for empty strings', () => {
      expect(isNonEmptyString('')).toBe(false);
    });
    it('should return false for non-strings', () => {
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(123)).toBe(false);
    });
  });

  describe('isValidARN', () => {
    it('should validate correct ARNs', () => {
      expect(isValidARN('arn:aws:s3:::bucket')).toBe(true);
      expect(isValidARN('arn:aws:lambda:us-east-1:123456789012:function:my-function')).toBe(true);
    });
    it('should reject invalid ARNs', () => {
      expect(isValidARN('not-an-arn')).toBe(false);
      expect(isValidARN('')).toBe(false);
    });
  });

  describe('isValidUUID', () => {
    it('should validate UUIDs', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });
    it('should reject invalid UUIDs', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
    });
  });

  describe('chunkArray', () => {
    it('should chunk array correctly', () => {
      const chunks = chunkArray([1, 2, 3, 4, 5], 2);
      expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
    });
  });

  describe('sleep', () => {
    it('should resolve after specified time', async () => {
      const start = Date.now();
      await sleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
  });
});
