// @dawn-studio/ai-cache — monthly AI spend budget guard.
//
// Background: Workers AI has no native monthly spending cap — overage is simply
// billed ($0.011 / 1K neurons). This enforces one at the application layer: every
// call reads the month-to-date (UTC) neuron total from KV before running, and
// refuses with 429 once the cap is reached — never overspending.
//
// Conservative accounting: ALL neurons count toward the cap, including any free
// tier. Set the cap well under the free allowance and the bill stays $0.
// KV is eventually consistent, so concurrent requests can slightly overshoot —
// acceptable for a spend guard.
//
// The error message carries the fixed `AI_BUDGET_EXCEEDED:` marker — keep it stable,
// downstream error classifiers key on it (→ HTTP 429).

/** Monthly budget in USD (hard cap). Configurable per app; $2 is the house default. */
export const DEFAULT_BUDGET_USD_PER_MONTH = 2;
/** Workers AI pricing: $0.011 / 1,000 neurons (official pricing). */
export const DEFAULT_USD_PER_1K_NEURONS = 0.011;

export interface BudgetOptions {
	/** Monthly cap in USD. @default 2 */
	usdPerMonth?: number;
	/** Price per 1K neurons. @default 0.011 */
	usdPer1kNeurons?: number;
	/** KV key prefix for the monthly counter. @default "ai-budget:" */
	keyPrefix?: string;
}

/** Minimal KV interface subset (a Cloudflare KV binding satisfies this). */
export interface BudgetKV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<unknown>;
}

function neuronsFor(o: Required<BudgetOptions>): number {
	return Math.floor((o.usdPerMonth / o.usdPer1kNeurons) * 1000);
}

function opts(o: BudgetOptions = {}): Required<BudgetOptions> {
	return {
		usdPerMonth: o.usdPerMonth ?? DEFAULT_BUDGET_USD_PER_MONTH,
		usdPer1kNeurons: o.usdPer1kNeurons ?? DEFAULT_USD_PER_1K_NEURONS,
		keyPrefix: o.keyPrefix ?? "ai-budget:",
	};
}

/** This month's (UTC) counter key, e.g. "ai-budget:2026-10". Rolls on UTC month boundary. */
export function budgetMonthKey(o: BudgetOptions = {}, d: Date = new Date()): string {
	const c = opts(o);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	return `${c.keyPrefix}${y}-${m}`;
}

/** Thrown when the budget is exhausted. Do NOT change the message marker. */
export class BudgetExceededError extends Error {
	readonly usedNeurons: number;
	constructor(usedNeurons: number, o: BudgetOptions = {}) {
		const c = opts(o);
		super(
			`AI_BUDGET_EXCEEDED:本月 AI 用量已達上限($${c.usdPerMonth},` +
				`已用約 ${Math.round(usedNeurons).toLocaleString("en-US")} neurons),` +
				`請下個月再試,或切換其它 provider`,
		);
		this.name = "BudgetExceededError";
		this.usedNeurons = usedNeurons;
	}
}

async function readTotal(kv: BudgetKV, key: string): Promise<number> {
	const raw = await kv.get(key);
	const n = raw === null ? 0 : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Pre-call check: returns the current month-to-date total; throws
 * BudgetExceededError once the cap is reached. Run before every billable AI call
 * (for lazy-start streams, first line inside run()).
 */
export async function checkBudget(
	kv: BudgetKV,
	o: BudgetOptions = {},
	now: Date = new Date(),
): Promise<number> {
	const c = opts(o);
	const total = await readTotal(kv, budgetMonthKey(c, now));
	if (total >= neuronsFor(c)) throw new BudgetExceededError(total, c);
	return total;
}

/** Post-call accounting: add this call's neurons, return the new month-to-date total. */
export async function recordUsage(
	kv: BudgetKV,
	neurons: number,
	o: BudgetOptions = {},
	now: Date = new Date(),
): Promise<number> {
	const c = opts(o);
	const key = budgetMonthKey(c, now);
	const total = await readTotal(kv, key);
	const next = total + (Number.isFinite(neurons) && neurons > 0 ? neurons : 0);
	await kv.put(key, String(next));
	return next;
}
