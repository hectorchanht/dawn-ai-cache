// @dawn-studio/ai-cache — KV-cached AI streaming + monthly budget guard.
export {
	aiCacheKey,
	prepareCachedStream,
	teeTextStream,
	DEFAULT_CACHE_PREFIX,
	DEFAULT_CACHE_TTL_SECONDS,
} from "./cache.js";
export type { AiCacheKeyParts, CacheOptions, CachedStream, KvLike, TextStream } from "./cache.js";
export {
	BudgetExceededError,
	budgetMonthKey,
	checkBudget,
	recordUsage,
	DEFAULT_BUDGET_USD_PER_MONTH,
	DEFAULT_USD_PER_1K_NEURONS,
} from "./budget.js";
export type { BudgetKV, BudgetOptions } from "./budget.js";
export { sha256hex } from "./hash.js";
export { streamToResponse, streamToPrimedResponse } from "./stream.js";
export { streamPost } from "./client.js";
export type { StreamPostOptions } from "./client.js";
