import { describe, it, expect } from "vitest";
import {
	BudgetExceededError,
	budgetMonthKey,
	checkBudget,
	recordUsage,
	DEFAULT_BUDGET_USD_PER_MONTH,
	DEFAULT_USD_PER_1K_NEURONS,
	type BudgetKV,
} from "../src/budget.js";
import { sha256hex } from "../src/hash.js";

function memKv(seed: Record<string, string> = {}): BudgetKV & { store: Map<string, string> } {
	const store = new Map(Object.entries(seed));
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => {
			store.set(k, v);
		},
	};
}

describe("budgetMonthKey", () => {
	it("formats as prefix:YYYY-MM on UTC boundaries", () => {
		expect(budgetMonthKey({}, new Date("2026-10-23T00:30:00Z"))).toBe("ai-budget:2026-10");
		expect(budgetMonthKey({}, new Date("2026-01-01T00:00:00Z"))).toBe("ai-budget:2026-01");
		// custom prefix
		expect(budgetMonthKey({ keyPrefix: "x:" }, new Date("2026-10-23T00:30:00Z"))).toBe("x:2026-10");
	});
});

describe("checkBudget / recordUsage", () => {
	const OPTS = { usdPerMonth: 2, usdPer1kNeurons: 0.011 }; // ≈181,818 neurons
	const CAP = Math.floor((2 / 0.011) * 1000);

	it("allows usage under the cap and returns the running total", async () => {
		const kv = memKv();
		expect(await checkBudget(kv, OPTS)).toBe(0);
		expect(await recordUsage(kv, 1000, OPTS)).toBe(1000);
		expect(await checkBudget(kv, OPTS)).toBe(1000);
	});

	it("throws BudgetExceededError at the cap (with the stable marker)", async () => {
		const kv = memKv({ [budgetMonthKey(OPTS)]: String(CAP) });
		const err = await checkBudget(kv, OPTS).catch((e) => e);
		expect(err).toBeInstanceOf(BudgetExceededError);
		expect(err.message).toContain("AI_BUDGET_EXCEEDED:");
		expect(err.usedNeurons).toBe(CAP);
	});

	it("throws once cumulative usage crosses the cap", async () => {
		const kv = memKv({ [budgetMonthKey(OPTS)]: String(CAP - 10) });
		await checkBudget(kv, OPTS); // still under
		await recordUsage(kv, 20, OPTS); // now over
		await expect(checkBudget(kv, OPTS)).rejects.toThrow("AI_BUDGET_EXCEEDED:");
	});

	it("ignores non-positive / non-finite neuron counts", async () => {
		const kv = memKv();
		expect(await recordUsage(kv, -5, OPTS)).toBe(0);
		expect(await recordUsage(kv, NaN, OPTS)).toBe(0);
		expect(await recordUsage(kv, 0, OPTS)).toBe(0);
	});

	it("treats corrupt KV values as zero", async () => {
		const kv = memKv({ [budgetMonthKey(OPTS)]: "not-a-number" });
		expect(await checkBudget(kv, OPTS)).toBe(0);
	});

	it("isolates months (UTC boundary rolls the key)", async () => {
		const kv = memKv();
		const oct = new Date("2026-10-31T23:59:59Z");
		const nov = new Date("2026-11-01T00:00:01Z");
		await recordUsage(kv, 500, OPTS, oct);
		expect(await checkBudget(kv, OPTS, oct)).toBe(500);
		expect(await checkBudget(kv, OPTS, nov)).toBe(0);
	});

	it("defaults match the house $2/mo policy", () => {
		expect(DEFAULT_BUDGET_USD_PER_MONTH).toBe(2);
		expect(DEFAULT_USD_PER_1K_NEURONS).toBe(0.011);
	});
});

describe("sha256hex", () => {
	it("matches the known SHA-256 vector", async () => {
		expect(await sha256hex("hello")).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
	});

	it("is stable and input-sensitive", async () => {
		expect(await sha256hex("a")).toBe(await sha256hex("a"));
		expect(await sha256hex("a")).not.toBe(await sha256hex("b"));
	});
});

import {
	budgetPeriodKey,
	rateForModel,
	usdForNeurons,
	DEFAULT_BUDGET_PERIOD,
} from "../src/budget.js";

describe("budgetPeriodKey", () => {
	it("defaults to month (back-compat with budgetMonthKey)", () => {
		const d = new Date("2026-10-23T00:30:00Z");
		expect(budgetPeriodKey({}, d)).toBe(budgetMonthKey({}, d));
		expect(budgetPeriodKey({}, d)).toBe("ai-budget:2026-10");
		expect(DEFAULT_BUDGET_PERIOD).toBe("month");
	});

	it("week: Monday-start UTC keys", () => {
		const fri = new Date("2026-10-23T12:00:00Z"); // Friday
		const sun = new Date("2026-10-25T23:59:59Z"); // Sunday — same week
		const mon = new Date("2026-10-19T00:00:00Z"); // Monday — same week
		const nextMon = new Date("2026-10-26T00:00:01Z"); // next week
		expect(budgetPeriodKey({ period: "week" }, fri)).toBe("ai-budget:week:2026-10-19");
		expect(budgetPeriodKey({ period: "week" }, sun)).toBe("ai-budget:week:2026-10-19");
		expect(budgetPeriodKey({ period: "week" }, mon)).toBe("ai-budget:week:2026-10-19");
		expect(budgetPeriodKey({ period: "week" }, nextMon)).toBe("ai-budget:week:2026-10-26");
	});

	it("day: UTC date keys, rolls at midnight", () => {
		const a = new Date("2026-10-23T23:59:59Z");
		const b = new Date("2026-10-24T00:00:01Z");
		expect(budgetPeriodKey({ period: "day" }, a)).toBe("ai-budget:day:2026-10-23");
		expect(budgetPeriodKey({ period: "day" }, b)).toBe("ai-budget:day:2026-10-24");
	});

	it("periods isolate from each other and from month keys", () => {
		const d = new Date("2026-10-23T12:00:00Z");
		const keys = [
			budgetPeriodKey({ period: "month" }, d),
			budgetPeriodKey({ period: "week" }, d),
			budgetPeriodKey({ period: "day" }, d),
		];
		expect(new Set(keys).size).toBe(3);
	});

	it("isolates weeks in checkBudget/recordUsage", async () => {
		const kv = memKv();
		const fri = new Date("2026-10-23T12:00:00Z");
		const nextMon = new Date("2026-10-26T00:00:01Z");
		const o = { usdPerMonth: 2, usdPer1kNeurons: 0.011, period: "week" as const };
		await recordUsage(kv, 500, o, fri);
		expect(await checkBudget(kv, o, fri)).toBe(500);
		expect(await checkBudget(kv, o, nextMon)).toBe(0);
	});
});

describe("per-model rates", () => {
	const RATES = { usdPerMonth: 2, usdPer1kNeurons: 0.011, rates: { "m2m100-1.2b": 0.022 } };

	it("rateForModel: table hit (case-insensitive) → base rate fallback", () => {
		expect(rateForModel(RATES, "m2m100-1.2b")).toBe(0.022);
		expect(rateForModel(RATES, " M2M100-1.2B ")).toBe(0.022);
		expect(rateForModel(RATES, "other-model")).toBe(0.011);
		expect(rateForModel(RATES)).toBe(0.011);
	});

	it("usdForNeurons converts at the model rate", () => {
		expect(usdForNeurons(1000, RATES, "m2m100-1.2b")).toBeCloseTo(0.022, 9);
		expect(usdForNeurons(1000, RATES, "other")).toBeCloseTo(0.011, 9);
	});

	it("recordUsage normalizes to reference neurons: expensive model burns cap 2x faster", async () => {
		const kv = memKv();
		await recordUsage(kv, { neurons: 1000, model: "m2m100-1.2b" }, RATES);
		expect(await checkBudget(kv, RATES)).toBe(2000); // 2x at base rate
	});

	it("recordUsage still accepts a plain number (back-compat)", async () => {
		const kv = memKv();
		expect(await recordUsage(kv, 1000, RATES)).toBe(1000);
	});
});

describe("period-aware errors", () => {
	it("carries the period and a matching label in the message", async () => {
		const o = { usdPerMonth: 0.00001 }; // tiny cap → always exceeded
		for (const period of ["month", "week", "day"] as const) {
			const kv = memKv({ [budgetPeriodKey({ period })]: "999999999" });
			const err = await checkBudget(kv, { ...o, period }).catch((e) => e);
			expect(err).toBeInstanceOf(BudgetExceededError);
			expect(err.message).toContain("AI_BUDGET_EXCEEDED:");
			expect(err.period).toBe(period);
		}
		const dayErr = await checkBudget(
			memKv({ [budgetPeriodKey({ period: "day" })]: "999999999" }),
			{ ...o, period: "day" },
		).catch((e) => e);
		expect(dayErr.message).toContain("今日");
	});
});
