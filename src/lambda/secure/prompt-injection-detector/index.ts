/**
 * src/lambda/secure/prompt-injection-detector/index.ts
 * Detects and logs prompt injection attempts. Integrates with Bedrock Guardrails.
 * Memory: 256MB | Timeout: 10s
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { logInfo, logError, logWarn, withRetry, generateIdempotencyKey } from '../../../shared/utils';
import { getEnvVar } from '../../../shared/config';
import { PromptInjectionAttempt } from '../../../shared/types';

interface DetectionResult {
  blocked: boolean;
  actionTaken: 'BLOCKED' | 'FLAGGED' | 'ALLOWED';
  attackType: PromptInjectionAttempt['attackType'];
  confidence: number;
}

// Regex-based detection patterns (complement to WAF layer)
const DETECTION_PATTERNS: Array<{ pattern: RegExp; type: PromptInjectionAttempt['attackType']; weight: number }> = [
  { pattern: /ignore\s+(all|previous|your)\s+(instructions?|rules?|constraints?)/i, type: 'DIRECT_INJECTION', weight: 0.9 },
  { pattern: /(new\s+instruction|system\s+prompt|developer\s+mode)/i, type: 'DIRECT_INJECTION', weight: 0.85 },
  { pattern: /(DAN|do\s+anything\s+now|jailbreak|root\s+access)/i, type: 'JAILBREAK', weight: 0.95 },
  { pattern: /(disregard|override|bypass)\s+(your|the|all)\s+(instructions?|training|programming)/i, type: 'DIRECT_INJECTION', weight: 0.88 },
  { pattern: /(output\s+initialization|above\s+instructions|previous\s+constraints)/i, type: 'DIRECT_INJECTION', weight: 0.82 },
  { pattern: /(translate\s+to|convert\s+to)\s+(bash|python|exec)/i, type: 'INDIRECT_INJECTION', weight: 0.75 },
  { pattern: /(send\s+.*to\s+email|exfiltrate|extract\s+data|dump\s+database)/i, type: 'DATA_EXFILTRATION', weight: 0.9 },
  { pattern: /(bearer\s+[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/i, type: 'DATA_EXFILTRATION', weight: 0.85 },
];

function detectPromptInjection(prompt: string): DetectionResult {
  let maxScore = 0;
  let detectedType: PromptInjectionAttempt['attackType'] = 'DIRECT_INJECTION';

  for (const { pattern, type, weight } of DETECTION_PATTERNS) {
    if (pattern.test(prompt)) {
      const score = weight;
      if (score > maxScore) {
        maxScore = score;
        detectedType = type;
      }
    }
  }

  if (maxScore >= 0.9) {
    return { blocked: true, actionTaken: 'BLOCKED', attackType: detectedType, confidence: maxScore };
  }
  if (maxScore >= 0.7) {
    return { blocked: false, actionTaken: 'FLAGGED', attackType: detectedType, confidence: maxScore };
  }
  return { blocked: false, actionTaken: 'ALLOWED', attackType: 'DIRECT_INJECTION', confidence: 0 };
}

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  const requestId = context.awsRequestId;
  const idempotencyKey = generateIdempotencyKey(requestId, JSON.stringify(event.body || ''));

  logInfo('Prompt injection detector invoked', { requestId, idempotencyKey });

  try {
    // Input validation
    if (!event.body) {
      logWarn('Empty request body', { requestId });
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Request body is required' }),
      };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.body);
    } catch (parseError) {
      logError('Invalid JSON in request body', parseError, { requestId });
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON in request body' }),
      };
    }

    const prompt = payload.prompt as string;
    if (!prompt || typeof prompt !== 'string') {
      logWarn('Missing or invalid prompt field', { requestId, payload });
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing or invalid "prompt" field' }),
      };
    }

    // Detection
    const detection = detectPromptInjection(prompt);

    // Log attempt
    const attempt: PromptInjectionAttempt = {
      requestId,
      timestamp: new Date().toISOString(),
      sourceIp: event.requestContext?.identity?.sourceIp || 'unknown',
      userAgent: event.requestContext?.identity?.userAgent || 'unknown',
      promptSnippet: prompt.substring(0, 200),
      attackType: detection.attackType,
      blocked: detection.blocked,
      actionTaken: detection.actionTaken,
      guardrailId: getEnvVar('GUARDRAIL_ID', ''),
    };

    logInfo('Prompt injection detection result', {
      requestId,
      actionTaken: detection.actionTaken,
      attackType: detection.attackType,
      confidence: detection.confidence,
    });

    // Block if detected
    if (detection.blocked) {
      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-Detection-Result': 'BLOCKED',
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({
          error: 'Request blocked: potential prompt injection detected',
          requestId,
          detection: {
            attackType: detection.attackType,
            confidence: detection.confidence,
          },
        }),
      };
    }

    // Flagged (log but allow)
    if (detection.actionTaken === 'FLAGGED') {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Detection-Result': 'FLAGGED',
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({
          result: 'FLAGGED',
          requestId,
          warning: 'Prompt flagged for review',
          detection: {
            attackType: detection.attackType,
            confidence: detection.confidence,
          },
        }),
      };
    }

    // Allowed
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Detection-Result': 'ALLOWED',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({
        result: 'ALLOWED',
        requestId,
      }),
    };
  } catch (error) {
    logError('Unhandled error in prompt injection detector', error, { requestId });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', requestId }),
    };
  }
}
