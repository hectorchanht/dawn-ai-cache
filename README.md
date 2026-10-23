# @dawn-studio/ai-cache

KV-cached AI streaming + monthly spend budget guard for Dawn Studio apps. Zero dependencies, edge-safe (WebCrypto only). Extracted from Numerology's battle-tested AI layer.

## Install

```bash
npm i @dawn-studio/ai-cache
```

## What's inside

### 1. Response cache (`cache.ts`)

Deterministic AI generations (same input + same config → same response) are cached in KV, so repeated questions cost **zero**. Only complete, successful responses are ever written.

```ts
import { prepareCachedStream, streamToPrimedResponse } from "@dawn-studio/ai-cache";

// In your route handler (Cloudflare Workers example):
const result = await prepareCachedStream(
  env.AI_BUDGET_KV,                       // any { get, put } — injected, never env-coupled
  {
    provider: "workers-ai",
    promptHash: await sha256hex(systemPrompt), // prompt version — change prompt → new key
    inputHash,                                // canonical input hash
    extra: { locale, section },               // any other output-changing dimensions
  },
  () => myProvider.textStream({ ... }),  // lazy — only called on cache MISS
);

if ("hit" in result) return result.hit; // Response with `X-Cache: HIT`

// Miss: wait for the first chunk (or failure) BEFORE returning headers, then stream:
const response = await streamToPrimedResponse(result.miss.stream);
result.miss.armPersistence((p) => ctx.waitUntil(p));   // writes on success only
return response; // `X-Cache: MISS`
```

Rules baked in:
- Cache key = `sha256` of the stable-serialized parts — bump the key prefix to invalidate everything at once.
- The stream is tee'd: however many listeners attach, the inner stream gets exactly one (every chunk accumulated exactly once).
- KV read failure → miss; write failure → swallowed; empty/failed generations → never cached. The cache never breaks a response.
- Don't use this for chat / conversational calls (hit rate ≈ 0).

### 2. Budget guard (`budget.ts`)

Workers AI has no native monthly spending cap — this enforces one at the application layer. Every call checks the month-to-date (UTC) neuron total in KV before running, and refuses with `BudgetExceededError` at the cap. The error message carries the stable `AI_BUDGET_EXCEEDED:` marker (downstream classifiers map it → HTTP 429).

```ts
import { checkBudget, recordUsage } from "@dawn-studio/ai-cache";

await checkBudget(env.AI_BUDGET_KV); // throws BudgetExceededError at the cap
const out = await runWorkersAi(...); // your call
await recordUsage(env.AI_BUDGET_KV, out.usage.neurons);
```

Defaults: **$2/month** cap, $0.011/1K neurons, `ai-budget:` key prefix — all configurable via `BudgetOptions`. Conservative accounting: every neuron counts (including any free tier), so set the cap under the free allowance and the bill stays $0. KV is eventually consistent, so concurrent requests can slightly overshoot — acceptable for a spend guard.

### 3. `sha256hex` (`hash.ts`)

WebCrypto SHA-256 hex — the primitive behind cache keys and input hashes.

## API

| Export | Description |
|---|---|
| `prepareCachedStream(kv, parts, makeStream, opts?)` | HIT → `Response`; MISS → tee'd stream + `armPersistence`. Never throws on KV faults. |
| `streamToPrimedResponse(stream, timeoutMs?)` | Waits for the first chunk (or failure) before returning the `Response`; replays the primed chunk so the body is complete. Provider failures surface as rejections — the caller returns a proper JSON error instead of a truncated stream. |
| `streamToResponse(stream)` | Immediate streaming `Response` (no priming). |
| `streamPost(url, body, onText, opts?)` | **Client-side.** POST JSON and stream the text back; `onText` gets the *cumulative* full text, throttled (default 80ms) so long responses don't O(n²) your markdown re-parse. Final call always delivers the complete text. Throws the server's `{ error }` on non-OK. |
| `aiCacheKey(parts, prefix?)` | Stable cache key. |
| `teeTextStream(inner)` | Fan-out wrapper; inner gets exactly one text listener. |
| `checkBudget(kv, opts?, now?)` | Pre-call guard; throws `BudgetExceededError` at cap. |
| `recordUsage(kv, neurons, opts?, now?)` | Post-call accounting; returns new total. |
| `budgetMonthKey(opts?, now?)` | `"<prefix>YYYY-MM"` on UTC boundaries. |
| `BudgetExceededError` | Carries `usedNeurons`; message keeps the `AI_BUDGET_EXCEEDED:` marker. |
| `sha256hex(text)` | SHA-256 hex via WebCrypto. |

## License

Apache-2.0
