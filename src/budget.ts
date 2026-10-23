// @dawn-studio/ai-cache — AI spend budget guard (period-aware).
//
// Background: Workers AI has no native spending cap — overage is simply
// billed ($0.011 / 1K neurons). This enforces one at the application layer: every
// call reads the period-to-date (UTC) neuron total from KV before running, and
// refuses with 429 once the cap is reached — never overspending.
//
// Conservative accounting: ALL neurons count toward the cap, including any free
// tier. Set the cap well under the free allowance and the bill stays $0.
// KV is eventually consistent, so concurrent requests can slightly overshoot —
// acceptable for a spend guard.
//
// Per-model pricing: pass `rates` (model → USD per 1K neurons) and per-call
// `{ neurons, model }` to recordUsage — usage is normalized to reference
// neurons at the base rate, so one cap covers a mixed-model app.
//
// The error message carries the fixed `AI_BUDGET_EXCEEDED:` marker — keep it stable,
// downstream error classifiers key on it (→ HTTP 429).

/** Budget in USD (hard cap). Configurable per app; $2 is the house default. */
export const DEFAULT_BUDGET_USD_PER_MONTH = 2;
/** Workers AI pricing: $0.011 / 1,000 neurons (official pricing). */
export const DEFAULT_USD_PER_1K_NEURONS = 0.011;

/** Budget accounting period. Week starts Monday (UTC); day is the UTC date. */
export type BudgetPeriod = "month" | "week" | "day";
export const DEFAULT_BUDGET_PERIOD: BudgetPeriod = "month";

export interface BudgetOptions {
	/** Cap in USD for the period. @default 2 */
	usdPerMonth?: number;
	/** Base price per 1K neurons (fallback when a model has no entry in `rates`). @default 0.011 */
	usdPer1kNeurons?: number;
	/**
	 * Per-model price table: model name (trimmed, case-insensitive) → USD per 1K
	 * neurons. Mixed-model apps: recordUsage converts each call to reference
	 * neurons at the base rate, so one cap covers all models.
	 * @default {} (every model uses usdPer1kNeurons)
	 */
	rates?: Record<string, number>;
	/** Accounting period. @default "month" */
	period?: BudgetPeriod;
	/** KV key prefix for the period counter. @default "ai-budget:" */
	keyPrefix?: string;
}

/** Minimal KV interface subset (a Cloudflare KV binding satisfies this). */
export interface BudgetKV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<unknown>;
}

/** Per-call usage input: plain neuron count, or neurons + model for rate conversion. */
export type UsageInput = number | { neurons: number; model?: string };

function opts(o: BudgetOptions = {}): Required<BudgetOptions> {
	return {
		usdPerMonth: o.usdPerMonth ?? DEFAULT_BUDGET_USD_PER_MONTH,
		usdPer1kNeurons: o.usdPer1kNeurons ?? DEFAULT_USD_PER_1K_NEURONS,
		rates: o.rates ?? {},
		period: o.period ?? DEFAULT_BUDGET_PERIOD,
		keyPrefix: o.keyPrefix ?? "ai-budget:",
	};
}

/** Price per 1K neurons for a model: rates table hit (case-insensitive) → base rate. */
export function rateForModel(o: BudgetOptions = {}, model?: string): number {
	const c = opts(o);
	if (model) {
		const hit = c.rates[model.trim().toLowerCase()];
		if (typeof hit === "number" && Number.isFinite(hit) && hit > 0) return hit;
	}
	return c.usdPer1kNeurons;
}

/** Cap expressed in neurons at a given rate. */
function neuronsFor(o: Required<BudgetOptions>, model?: string): number {
	return Math.floor((o.usdPerMonth / rateForModel(o, model)) * 1000);
}

/** USD cost of a neuron count at a model's rate. */
export function usdForNeurons(
	neurons: number,
	o: BudgetOptions = {},
	model?: string,
): number {
	return (neurons / 1000) * rateForModel(o, model);
}

/** Normalize a call's neurons to reference neurons at the base rate. */
function toReferenceNeurons(
	neurons: number,
	o: Required<BudgetOptions>,
	model?: string,
): number {
	const n = Number.isFinite(neurons) && neurons > 0 ? neurons : 0;
	if (!model) return n;
	// round to 6dp: float math (0.022/0.011) can leave 2000.0000000000002
	return Math.round((n * rateForModel(o, model)) / o.usdPer1kNeurons * 1e6) / 1e6;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Monday (UTC) of the week containing d, as YYYY-MM-DD. */
function mondayOf(d: Date): string {
	const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const dow = new Date(t).getUTCDay(); // 0=Sun … 6=Sat
	const monday = new Date(t - ((dow + 6) % 7) * 86_400_000);
	return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

/**
 * This period's (UTC) counter key.
 * - month: "ai-budget:2026-10" (rolls on UTC month boundary)
 * - week:  "ai-budget:week:2026-10-19" (Monday UTC start, rolls weekly)
 * - day:   "ai-budget:day:2026-10-23" (rolls at UTC midnight)
 */
export function budgetPeriodKey(o: BudgetOptions = {}, d: Date = new Date()): string {
	const c = opts(o);
	const y = d.getUTCFullYear();
	const m = pad(d.getUTCMonth() + 1);
	if (c.period === "week") return `${c.keyPrefix}week:${mondayOf(d)}`;
	if (c.period === "day") return `${c.keyPrefix}day:${y}-${m}-${pad(d.getUTCDate())}`;
	return `${c.keyPrefix}${y}-${m}`;
}

/** This month's (UTC) counter key, e.g. "ai-budget:2026-10". Kept for back-compat. */
export function budgetMonthKey(o: BudgetOptions = {}, d: Date = new Date()): string {
	return budgetPeriodKey({ ...o, period: "month" }, d);
}

const PERIOD_WORD: Record<BudgetPeriod, string> = {
	month: "本月",
	week: "本週",
	day: "今日",
};

/** Thrown when the budget is exhausted. Do NOT change the message marker. */
export class BudgetExceededError extends Error {
	readonly usedNeurons: number;
	readonly period: BudgetPeriod;
	constructor(usedNeurons: number, o: BudgetOptions = {}) {
		const c = opts(o);
		const word = PERIOD_WORD[c.period];
		super(
			`AI_BUDGET_EXCEEDED:${word} AI 用量已達上限($${c.usdPerMonth},` +
				`已用約 ${Math.round(usedNeurons).toLocaleString("en-US")} neurons),` +
				`請稍後再試,或切換其它 provider`,
		);
		this.name = "BudgetExceededError";
		this.usedNeurons = usedNeurons;
		this.period = c.period;
	}
}

async function readTotal(kv: BudgetKV, key: string): Promise<number> {
	const raw = await kv.get(key);
	const n = raw === null ? 0 : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Pre-call check: returns the current period-to-date total; throws
 * BudgetExceededError once the cap is reached. Run before every billable AI call
 * (for lazy-start streams, first line inside run()).
 */
export async function checkBudget(
	kv: BudgetKV,
	o: BudgetOptions = {},
	now: Date = new Date(),
): Promise<number> {
	const c = opts(o);
	const total = await readTotal(kv, budgetPeriodKey(c, now));
	if (total >= neuronsFor(c)) throw new BudgetExceededError(total, c);
	return total;
}

/**
 * Post-call accounting: add this call's neurons (normalized to reference neurons
 * at the base rate when a model with a custom rate is given), return the new
 * period-to-date total.
 */
export async function recordUsage(
	kv: BudgetKV,
	usage: UsageInput,
	o: BudgetOptions = {},
	now: Date = new Date(),
): Promise<number> {
	const c = opts(o);
	const key = budgetPeriodKey(c, now);
	const total = await readTotal(kv, key);
	const { neurons, model } =
		typeof usage === "number" ? { neurons: usage, model: undefined } : usage;
	const next = total + toReferenceNeurons(neurons, c, model);
	await kv.put(key, String(next));
	return next;
}
