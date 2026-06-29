# Multi-Model Consistency for Critical Banking Operations

> How to use Opus 4.8 and GPT-5.5 together in regulated financial workflows without fine-tuning.

---

## Core Principle

**Don't fine-tune. Layer consistency on top.**

Fine-tuning Opus 4.8 and GPT-5.5 to produce identical outcomes is architecturally infeasible — they're different model families with different reasoning patterns, tokenizers, and training distributions. Even if you could (Bedrock only supports fine-tuning on smaller models like Claude Haiku and Llama), you'd still get divergent outputs.

The right approach: **the model proposes, the system validates.**

---

## Architecture

```
Customer deposit request
        │
        ▼
┌──────────────────────────────────────┐
│ Model layer (Opus 4.8 or GPT-5.5)    │
│ → Produces structured JSON output    │
│ → JSON schema enforced at API level  │
└──────────────┬───────────────────────┘
               │ { "action": "process",
               │   "amount": 5000,
               │   "account": "123-456",
               │   "risk_flag": "LOW",
               │   "reasoning": "..." }
               ▼
┌──────────────────────────────────────┐
│ Deterministic validation layer       │  ← Consistency lives HERE
│ → Amount matches transaction record  │
│ → Account exists + is active         │
│ → Within daily limits                │
│ → AML/CTF screening pass             │
│ → Regulatory hold check              │
│ → Balance sufficient                 │
└──────────────┬───────────────────────┘
               │ ✅ Validated
               ▼
┌──────────────────────────────────────┐
│ Core banking system                  │
│ → Executes the transaction           │
└──────────────────────────────────────┘
```

The model only decides *classification* and *routing*, never execution.

---

## The Four-Layer Approach

### Layer 1: Structured Output Enforcement

Both models support JSON schema. Force identical output shapes:

```json
{
  "type": "object",
  "required": ["action", "classification", "confidence", "reasoning", "flags"],
  "properties": {
    "action": { "enum": ["PROCESS", "HOLD", "ESCALATE", "REJECT"] },
    "classification": {
      "enum": ["STANDARD_DEPOSIT", "LARGE_DEPOSIT", "SUSPICIOUS", "INTERNATIONAL"]
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "reasoning": { "type": "string", "maxLength": 500 },
    "flags": {
      "type": "array",
      "items": {
        "enum": ["AML_REVIEW", "LIMIT_EXCEEDED", "SOURCE_VERIFICATION", "COMPLIANCE_HOLD"]
      }
    }
  }
}
```

Both models emit the same shape — downstream systems don't care which model produced it.

---

### Layer 2: Golden Dataset + Cross-Model Evaluation

Build a labeled dataset of 500–1,000 deposit scenarios with correct classifications. Run both models against it. Track:

| Metric | Opus 4.8 | GPT-5.5 | Threshold |
|--------|----------|---------|-----------|
| Classification agreement | 94% | 92% | ≥ 90% |
| False positive rate (flagged normal) | 1.2% | 1.8% | < 2% |
| False negative rate (missed suspicious) | 0.3% | 0.5% | < 0.5% |
| Confidence distribution (mean) | 0.91 | 0.88 | μ > 0.85 |

If one model diverges on specific scenarios, adjust the system prompt with those examples. This is **prompt engineering**, not fine-tuning — and it works across providers.

---

### Layer 3: Bedrock Guardrails + Policy Injection

Apply identical guardrails regardless of which model is invoked:

```typescript
const guardrailConfig = {
  topicPolicy: {
    topics: [
      { name: "TransactionExecution", type: "DENY" },     // Model never executes
      { name: "CustomerDataModification", type: "DENY" },  // Model never mutates data
      { name: "FinancialAdvice", type: "DENY" },           // Compliance boundary
    ],
  },
  contentPolicy: {
    filters: [
      { type: "PROMPT_INJECTION", strength: "HIGH" },
      { type: "MISINFORMATION", strength: "HIGH" },
    ],
  },
  wordPolicy: {
    managedWordLists: [{ name: "Profanity", type: "BLOCK" }],
  },
};
```

Inject bank policy as context via RAG — same policy document chunked and embedded, retrieved identically regardless of model.

---

### Layer 4: Dual-Model Consensus for High-Value Transactions

For CRITICAL deposits above a threshold (e.g., $50K), run BOTH models and require agreement:

```typescript
if (amount > CONSENSUS_THRESHOLD) {
  const opusResult = await invokeHarness(OPUS_MODEL, ...);
  const gptResult = await invokeHarness(GPT_MODEL, ...);

  if (
    opusResult.action === gptResult.action &&
    opusResult.confidence > 0.9
  ) {
    // Both agree → proceed
    executeTransaction(opusResult);
  } else {
    // Disagreement → escalate to human
    emitEscalation({ opus: opusResult, gpt: gptResult });
  }
}
```

This turns the multi-model setup from a *risk* (inconsistency) into an *asset* (consensus validation).

---

## Customer Advisory

> Don't try to make Opus 4.8 and GPT-5.5 behave identically — they won't. Instead, give both models the same structured output schema, the same policy context via RAG, the same guardrails, and validate their outputs through a deterministic rules engine. For high-value transactions, run both models and require agreement. The consistency you need lives in the validation layer and the schema, not in the model weights.

---

## Key Takeaways

| Principle | Implementation |
|-----------|---------------|
| Models propose, systems validate | Deterministic rules engine post-inference |
| Identical output schemas | JSON schema enforced on both models |
| Shared policy context | RAG with single source of truth |
| Consistent guardrails | Bedrock Guardrails applied uniformly |
| High-value consensus | Dual-model invocation with agreement gate |
| Continuous evaluation | Golden dataset with per-model metric tracking |

Fine-tuning frontier models is the wrong tool for banking consistency. Schema enforcement + guardrails + golden dataset evaluation + dual-model consensus is the right one.

---

*Document generated June 2026. Models referenced: Claude Opus 4.8 (Anthropic on Bedrock), GPT-5.5 (OpenAI on Bedrock).*
