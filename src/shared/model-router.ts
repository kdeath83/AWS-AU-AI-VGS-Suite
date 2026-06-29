/**
 * src/shared/model-router.ts
 * Model selection and load balancing for AgentCore Harness invocations.
 *
 * Two routing modes:
 *   1. Weighted distribution — splits traffic across providers by configured
 *      weights (e.g., 80% Opus 4.8 + 20% GPT-5.5 for CRITICAL).
 *   2. Failover chain — deterministic primary with ordered fallbacks on failure.
 *
 * Model lineup (June 2026):
 *   Claude Fable 5   — Anthropic's top tier, frontier reasoning & agentic tasks
 *   Claude Opus 4.8  — Highest GA Opus, complex reasoning & long-horizon agents
 *   Claude Sonnet 4.6 — Production default, near-Opus performance at lower cost
 *   GPT-5.5          — OpenAI's most advanced frontier model on Bedrock
 *   DeepSeek V4 Pro  — Strong reasoning, cost-effective via OpenCode Go
 *   DeepSeek V4 Flash — Fastest, cheapest via OpenCode Go
 */

import { RiskClassification } from './types';

// ── Model Provider & Config Types ──────────────────────────────────────────

export type ModelProvider = 'bedrock' | 'liteLlm' | 'openAi' | 'gemini';

export interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
  apiBase?: string;
  apiKeyArn?: string;
  additionalParams?: Record<string, unknown>;
  apiFormat?: 'responses' | 'chat_completions' | 'converse_stream';
}

export interface WeightedModel {
  config: ModelConfig;
  weight: number; // relative weight (e.g., 80, 20 = 80%/20% split)
}

export interface RouteResult {
  /** The model selected for this invocation (weighted random or deterministic) */
  primary: ModelConfig;
  /** Ordered fallback chain — remaining models to try if primary fails */
  fallbacks: ModelConfig[];
  /** The routing mode used for observability */
  mode: 'weighted' | 'failover';
  /** The complete weighted pool if mode=weighted (for audit trail) */
  weightedPool?: Array<{ model: string; weight: number; selected: boolean }>;
}

// ── Model Pool (June 2026) ─────────────────────────────────────────────────

export const MODEL_POOL: Record<string, ModelConfig> = {
  'claude-fable-5': {
    provider: 'bedrock',
    modelId: 'anthropic.claude-fable-5',
    apiFormat: 'converse_stream',
  },
  'claude-opus-4.8': {
    provider: 'bedrock',
    modelId: 'anthropic.claude-opus-4-8',
    apiFormat: 'converse_stream',
  },
  'claude-sonnet-4.6': {
    provider: 'bedrock',
    modelId: 'claude-sonnet-4-6',
    apiFormat: 'converse_stream',
  },
  'gpt-5.5': {
    provider: 'openAi',
    modelId: 'gpt-5.5',
    apiFormat: 'responses',
  },
  'deepseek-v4-pro': {
    provider: 'liteLlm',
    modelId: 'deepseek-v4-pro',
    apiBase: 'https://opencode.ai/zen/go/v1',
  },
  'deepseek-v4-flash': {
    provider: 'liteLlm',
    modelId: 'deepseek-v4-flash',
    apiBase: 'https://opencode.ai/zen/go/v1',
  },
};

// ── Weighted Routing Pools ─────────────────────────────────────────────────

/** CRITICAL workflows: 80% Opus 4.8, 20% GPT-5.5 */
const CRITICAL_POOL: WeightedModel[] = [
  { config: MODEL_POOL['claude-opus-4.8'], weight: 80 },
  { config: MODEL_POOL['gpt-5.5'], weight: 20 },
];

/** HIGH-security tasks: 70% Opus 4.8, 30% GPT-5.5 */
const HIGH_SECURITY_POOL: WeightedModel[] = [
  { config: MODEL_POOL['claude-opus-4.8'], weight: 70 },
  { config: MODEL_POOL['gpt-5.5'], weight: 30 },
];

/** HIGH-compliance tasks: 60% GPT-5.5, 40% Opus 4.8 */
const HIGH_COMPLIANCE_POOL: WeightedModel[] = [
  { config: MODEL_POOL['gpt-5.5'], weight: 60 },
  { config: MODEL_POOL['claude-opus-4.8'], weight: 40 },
];

/** MEDIUM: purely failover — single primary with fallback chain */
/** LOW: purely failover — cheapest primary with fallback chain */

// ── Weighted Random Selection ──────────────────────────────────────────────

/**
 * Selects a model from a weighted pool using cumulative probability.
 * Stateless — each invocation independently rolls the dice.
 * Returns the selected config and the ordered fallback chain (remaining models).
 */
function selectWeighted(pool: WeightedModel[]): {
  selected: WeightedModel;
  rest: WeightedModel[];
} {
  const totalWeight = pool.reduce((sum, m) => sum + m.weight, 0);
  let roll = Math.random() * totalWeight;

  for (let i = 0; i < pool.length; i++) {
    roll -= pool[i].weight;
    if (roll <= 0) {
      const rest = [...pool.slice(0, i), ...pool.slice(i + 1)];
      return { selected: pool[i], rest };
    }
  }

  // Fallback: return last model (shouldn't reach here)
  const last = pool[pool.length - 1];
  return { selected: last, rest: pool.slice(0, -1) };
}

// ── Routing Engine ─────────────────────────────────────────────────────────

export function selectModel(
  taskType: string,
  priority: RiskClassification,
): RouteResult {
  // ── CRITICAL: weighted 80/20 split Opus 4.8 ↔ GPT-5.5 ──
  if (priority === 'CRITICAL') {
    const { selected, rest } = selectWeighted(CRITICAL_POOL);
    return {
      primary: selected.config,
      fallbacks: rest.map((m) => m.config),
      mode: 'weighted',
      weightedPool: CRITICAL_POOL.map((m) => ({
        model: m.config.modelId,
        weight: m.weight,
        selected: m.config.modelId === selected.config.modelId,
      })),
    };
  }

  // ── HIGH: weighted per task type ──
  if (priority === 'HIGH') {
    switch (taskType) {
      case 'SECURITY_SCAN':
      case 'INCIDENT_RESPONSE': {
        const { selected, rest } = selectWeighted(HIGH_SECURITY_POOL);
        return {
          primary: selected.config,
          fallbacks: rest.map((m) => m.config),
          mode: 'weighted',
          weightedPool: HIGH_SECURITY_POOL.map((m) => ({
            model: m.config.modelId,
            weight: m.weight,
            selected: m.config.modelId === selected.config.modelId,
          })),
        };
      }
      case 'COMPLIANCE_CHECK':
      case 'AUDIT_EVIDENCE': {
        const { selected, rest } = selectWeighted(HIGH_COMPLIANCE_POOL);
        return {
          primary: selected.config,
          fallbacks: rest.map((m) => m.config),
          mode: 'weighted',
          weightedPool: HIGH_COMPLIANCE_POOL.map((m) => ({
            model: m.config.modelId,
            weight: m.weight,
            selected: m.config.modelId === selected.config.modelId,
          })),
        };
      }
      default:
        return {
          primary: MODEL_POOL['claude-opus-4.8'],
          fallbacks: [MODEL_POOL['gpt-5.5']],
          mode: 'failover',
        };
    }
  }

  // ── MEDIUM: failover — deterministic primary with fallback chain ──
  if (priority === 'MEDIUM') {
    switch (taskType) {
      case 'SECURITY_SCAN':
      case 'INCIDENT_RESPONSE':
        return {
          primary: MODEL_POOL['claude-sonnet-4.6'],
          fallbacks: [MODEL_POOL['deepseek-v4-pro'], MODEL_POOL['gpt-5.5']],
          mode: 'failover',
        };
      case 'COMPLIANCE_CHECK':
      case 'AUDIT_EVIDENCE':
        return {
          primary: MODEL_POOL['deepseek-v4-pro'],
          fallbacks: [MODEL_POOL['claude-sonnet-4.6'], MODEL_POOL['deepseek-v4-flash']],
          mode: 'failover',
        };
      default:
        return {
          primary: MODEL_POOL['deepseek-v4-pro'],
          fallbacks: [MODEL_POOL['claude-sonnet-4.6']],
          mode: 'failover',
        };
    }
  }

  // ── LOW: failover — cheapest viable model ──
  return {
    primary: MODEL_POOL['deepseek-v4-flash'],
    fallbacks: [MODEL_POOL['deepseek-v4-pro'], MODEL_POOL['claude-sonnet-4.6']],
    mode: 'failover',
  };
}

// ── Harness Model Payload Builder ──────────────────────────────────────────

export function buildHarnessModelPayload(config: ModelConfig): Record<string, unknown> {
  switch (config.provider) {
    case 'bedrock':
      return {
        bedrockModelConfig: {
          modelId: config.modelId,
          ...(config.apiFormat ? { apiFormat: config.apiFormat } : {}),
        },
      };

    case 'liteLlm':
      return {
        liteLlmConfig: {
          modelId: config.modelId,
          ...(config.apiBase ? { apiBase: config.apiBase } : {}),
          ...(config.apiKeyArn ? { apiKeyArn: config.apiKeyArn } : {}),
          ...(config.additionalParams ? { additionalParams: config.additionalParams } : {}),
        },
      };

    case 'openAi':
      return {
        openAiModelConfig: {
          modelId: config.modelId,
          apiFormat: config.apiFormat ?? 'responses',
        },
      };

    default:
      throw new Error(`Unsupported model provider: ${config.provider}`);
  }
}
