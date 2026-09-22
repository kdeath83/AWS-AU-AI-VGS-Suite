/**
 * src/jev/jev-client.ts
 * Minimal TypeSafe / Jev System One client.
 *
 * Uses node:https rather than fetch so the call works on any Node 18+ runtime
 * without depending on a global fetch implementation, and so the `server-timing`
 * response header can be read directly. The API key is read from the environment
 * and is never logged, echoed, or included in an error message.
 */

import * as https from 'https';
import { URL } from 'url';
import { Question, SystemOneResponse } from './types';

export const JEV_ENDPOINT =
  process.env.TYPESAFE_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone';

export const JEV_MODEL = process.env.TYPESAFE_MODEL ?? 'jev-latest';

/** Published rate: $0.042 per 1M input tokens. Output tokens are not billed. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Measured practical ceiling is ~450 structured assertions per request. */
export const MAX_ASSERTIONS_PER_REQUEST = 450;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export class JevError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(message: string, statusCode: number, body: string) {
    super(message);
    this.name = 'JevError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export interface EvaluateOptions {
  /** Model id. Defaults to jev-latest. */
  model?: string;
  /** Total attempts including the first. Defaults to 4. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, in ms. Defaults to 400. */
  baseDelayMs?: number;
  /** Per-attempt socket timeout, in ms. Defaults to 60000. */
  timeoutMs?: number;
  /** Injectable transport, for tests. */
  transport?: Transport;
}

export interface TransportRequest {
  endpoint: string;
  apiKey: string;
  body: string;
  timeoutMs: number;
}

export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface EvaluateResult {
  response: SystemOneResponse;
  serverMs: number;
  wallMs: number;
  statusCode: number;
  attempts: number;
  requestId: string;
}

function readApiKey(): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    throw new JevError(
      'TYPESAFE_API_KEY is not set. Export it before running the control test ' +
        '(the value is never logged).',
      0,
      '',
    );
  }
  return key;
}

/** Read the upstream service time. TypeSafe fronts the API with Envoy. */
export function parseServerMs(headers: Record<string, string | string[] | undefined>): number {
  const envoy = headers['x-envoy-upstream-service-time'];
  if (typeof envoy === 'string' && envoy.trim() !== '') return Number(envoy);

  const timing = headers['server-timing'];
  const raw = Array.isArray(timing) ? timing.join(',') : timing;
  if (!raw) return 0;
  const match = /dur=(\d+(?:\.\d+)?)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

function readRequestId(headers: Record<string, string | string[] | undefined>): string {
  const id = headers['x-typesafe-request-id'];
  if (Array.isArray(id)) return id[0] ?? '';
  return id ?? '';
}

const defaultTransport: Transport = ({ endpoint, apiKey, body, timeoutMs }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const url = new URL(endpoint);
    const payload = Buffer.from(body, 'utf8');

    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Evaluate a state against a map of typed questions.
 *
 * All questions in one call see the same state, are evaluated independently and
 * in parallel, and cannot see each other's answers. Anything that depends on a
 * sibling answer must be composed in caller code.
 */
export async function evaluate(
  state: unknown,
  questions: Record<string, Question>,
  options: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const apiKey = readApiKey();
  const transport = options.transport ?? defaultTransport;
  const model = options.model ?? JEV_MODEL;
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const timeoutMs = options.timeoutMs ?? 60000;

  const assertionCount = Object.keys(questions).length;
  if (assertionCount === 0) {
    throw new JevError('Refusing to send a request with no questions.', 0, '');
  }
  if (assertionCount > MAX_ASSERTIONS_PER_REQUEST) {
    throw new JevError(
      `Assertion count ${assertionCount} exceeds the measured per-request ceiling ` +
        `of ${MAX_ASSERTIONS_PER_REQUEST}. Split the assertion set across requests.`,
      0,
      '',
    );
  }

  const body = JSON.stringify({ state, model, questions });
  const startedAt = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await transport({ endpoint: JEV_ENDPOINT, apiKey, body, timeoutMs });

      if (res.statusCode === 200) {
        const parsed = JSON.parse(res.body) as SystemOneResponse;
        return {
          response: parsed,
          serverMs: parseServerMs(res.headers),
          wallMs: Date.now() - startedAt,
          statusCode: res.statusCode,
          attempts: attempt,
          requestId: readRequestId(res.headers),
        };
      }

      if (!RETRYABLE_STATUS.has(res.statusCode)) {
        throw new JevError(
          `Jev request failed with status ${res.statusCode}: ${res.body.slice(0, 300)}`,
          res.statusCode,
          res.body,
        );
      }

      lastError = new JevError(
        `Jev request returned retryable status ${res.statusCode}`,
        res.statusCode,
        res.body,
      );
    } catch (err) {
      if (err instanceof JevError && !RETRYABLE_STATUS.has(err.statusCode)) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }

  throw lastError ?? new JevError('Jev request failed with no recorded error', 0, '');
}

/** Cost of a request at the published input-token rate. */
export function costOf(inputTokens: number): number {
  return inputTokens * USD_PER_INPUT_TOKEN;
}
