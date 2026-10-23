# @dawn-studio/ai-cache

KV-cached AI streaming + period spend budget guard for Dawn Studio apps. Zero dependencies, edge-safe (WebCrypto only). Extracted from Numerology's battle-tested AI layer.

**Design principle:** zero-config defaults that just work, and *every* setting exposed — nothing is hardcoded that a reasonable app would want to change.

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

### Deliberate re-run

When the user explicitly hits regenerate / retry, they want a *different* result — not the cached one. Pass `forceRefresh: true` to skip the KV read; the fresh generation flows through the normal miss path and **overwrites** the cached entry:

```ts
const result = await prepareCachedStream(
  env.AI_BUDGET_KV,
  { provider: "workers-ai", promptHash, inputHash },
  () => myProvider.textStream({ ... }),
  { forceRefresh: true }, // user asked for a fresh take
);
```

### 2. Budget guard (`budget.ts`)

Workers AI has no native spending cap — this enforces one at the application layer. Every call checks the period-to-date (UTC) neuron total in KV before running, and refuses with `BudgetExceededError` at the cap. The error message carries the stable `AI_BUDGET_EXCEEDED:` marker (downstream classifiers map it → HTTP 429).

```ts
import { checkBudget, recordUsage } from "@dawn-studio/ai-cache";

await checkBudget(env.AI_BUDGET_KV); // throws BudgetExceededError at the cap
const out = await runWorkersAi(...); // your call
await recordUsage(env.AI_BUDGET_KV, out.usage.neurons);
```

Defaults: **$2/month** cap, $0.011/1K neurons, `ai-budget:` key prefix — everything configurable via `BudgetOptions`:

| option | default | notes |
|---|---|---|
| `usdPerMonth` | `2` | hard cap in USD for the period |
| `usdPer1kNeurons` | `0.011` | base price; fallback when a model has no `rates` entry |
| `rates` | `{}` | per-model price table: `{ "m2m100-1.2b": 0.022 }` (case-insensitive) |
| `period` | `"month"` | `"month"` (UTC calendar), `"week"` (Monday UTC start), or `"day"` (UTC date) |
| `keyPrefix` | `"ai-budget:"` | KV key namespace |

Mixed-model apps: pass `recordUsage(kv, { neurons, model }, opts)` — each call is normalized to reference neurons at the base rate, so **one cap covers all models** (a 2×-priced model burns the cap 2× faster). Plain `recordUsage(kv, neurons)` still works. `rateForModel(opts, model)` and `usdForNeurons(neurons, opts, model)` are exported for your own cost math; `budgetPeriodKey(opts, date)` gives the current period's KV key (month keys are unchanged from v0.4.x, so existing counters keep working).

Conservative accounting: every neuron counts (including any free tier), so set the cap under the free allowance and the bill stays $0. KV is eventually consistent, so concurrent requests can slightly overshoot — acceptable for a spend guard.

### 3. `sha256hex` (`hash.ts`)

WebCrypto SHA-256 hex — the primitive behind cache keys and input hashes.

## API

| Export | Description |
|---|---|
| `prepareCachedStream(kv, parts, makeStream, opts?)` | HIT → `Response`; MISS → tee'd stream + `armPersistence`. Never throws on KV faults. `opts`: `prefix`, `ttlSeconds`, `forceRefresh`, `hitHeaders` (merge over the defaults: `Content-Type`, `Cache-Control`, `X-Cache: HIT`), `onCacheHit` / `onCacheMiss` / `onCacheWrite` (never throw into the caller). |
| `streamToPrimedResponse(stream, timeoutMs?, opts?)` | Waits for the first chunk (or failure) before returning the `Response`; replays the primed chunk so the body is complete. Provider failures surface as rejections — the caller returns a proper JSON error instead of a truncated stream. `opts`: `headers`, `status`. |
| `streamToResponse(stream, opts?)` | Immediate streaming `Response` (no priming). `opts`: `headers`, `status`. |
| `streamPost(url, body, onText, opts?)` | **Client-side.** POST JSON and stream the text back; `onText` gets the *cumulative* full text, throttled (default 80ms) so long responses don't O(n²) your markdown re-parse. Final call always delivers the complete text. Throws the server's `{ error }` on non-OK. `opts`: `throttleMs`, `signal`, `method`, `headers`, `fetchInit` (`fetchInit.headers` wins over `headers`). |
| `aiCacheKey(parts, prefix?)` | Stable cache key. |
| `teeTextStream(inner)` | Fan-out wrapper; inner gets exactly one text listener. |
| `checkBudget(kv, opts?, now?)` | Pre-call guard; throws `BudgetExceededError` at cap. |
| `recordUsage(kv, neurons \| { neurons, model }, opts?, now?)` | Post-call accounting; returns new total. With `model` + `opts.rates`, usage is normalized to reference neurons. |
| `budgetPeriodKey(opts?, now?)` | `"<prefix>YYYY-MM"` (month) / `"<prefix>week:YYYY-MM-DD"` (Monday UTC) / `"<prefix>day:YYYY-MM-DD"` on UTC boundaries. |
| `budgetMonthKey(opts?, now?)` | Kept for back-compat; identical to `budgetPeriodKey` with `period: "month"`. |
| `rateForModel(opts?, model?)` | USD per 1K neurons for a model (rates table → base fallback). |
| `usdForNeurons(neurons, opts?, model?)` | USD cost of a neuron count. |
| `BudgetExceededError` | Carries `usedNeurons` + `period`; message keeps the `AI_BUDGET_EXCEEDED:` marker. |
| `sha256hex(text)` | SHA-256 hex via WebCrypto. |

## License

Apache-2.0
