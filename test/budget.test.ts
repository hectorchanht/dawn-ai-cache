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
