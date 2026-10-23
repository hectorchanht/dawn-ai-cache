import { describe, it, expect } from "vitest";
import {
	aiCacheKey,
	prepareCachedStream,
	teeTextStream,
	DEFAULT_CACHE_PREFIX,
	type KvLike,
	type TextStream,
} from "../src/cache.js";

/** In-memory KV for tests. */
function memKv(seed: Record<string, string> = {}): KvLike & { store: Map<string, string> } {
	const store = new Map(Object.entries(seed));
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => {
			store.set(k, v);
		},
	};
}

/** A controllable TextStream (finalMessage is idempotent, like the real lazy-start streams). */
function fakeStream(chunks: string[], fail = false): TextStream & { listeners: number } {
	const textLs: Array<(d: string) => void> = [];
	const errLs: Array<(e: unknown) => void> = [];
	let listeners = 0;
	let done = false;
	return {
		listeners: 0,
		on(event: "text" | "error", listener: (a: never) => void): unknown {
			listeners++;
			(this as { listeners: number }).listeners = listeners;
			if (event === "text") textLs.push(listener as (d: string) => void);
			else errLs.push(listener as (e: unknown) => void);
			return this;
		},
		async finalMessage(): Promise<unknown> {
			if (done) return chunks.join("");
			done = true;
			if (fail) {
				for (const l of errLs) l(new Error("boom"));
				throw new Error("boom");
			}
			for (const c of chunks) for (const l of [...textLs]) l(c);
			return chunks.join("");
		},
		abort(): void {},
	} as TextStream & { listeners: number };
}

const PARTS = { provider: "workers-ai", model: "", promptHash: "p1", inputHash: "i1", extra: { locale: "zht" } };

describe("aiCacheKey", () => {
	it("is stable for the same parts", async () => {
		expect(await aiCacheKey(PARTS)).toBe(await aiCacheKey(PARTS));
	});

	it("changes when any part changes (prompt version, input, locale…)", async () => {
		const a = await aiCacheKey(PARTS);
		expect(await aiCacheKey({ ...PARTS, promptHash: "p2" })).not.toBe(a);
		expect(await aiCacheKey({ ...PARTS, inputHash: "i2" })).not.toBe(a);
		expect(await aiCacheKey({ ...PARTS, extra: { locale: "en" } })).not.toBe(a);
	});

	it("normalizes provider case/whitespace", async () => {
		expect(await aiCacheKey({ ...PARTS, provider: " Workers-AI " })).toBe(await aiCacheKey(PARTS));
	});

	it("uses the default prefix, overridable per call", async () => {
		const k = await aiCacheKey(PARTS);
		expect(k.startsWith(DEFAULT_CACHE_PREFIX)).toBe(true);
		const k2 = await aiCacheKey(PARTS, "other:");
		expect(k2.startsWith("other:")).toBe(true);
		expect(k2).not.toBe(k);
	});
});

describe("prepareCachedStream — HIT", () => {
	it("returns the cached Response with X-Cache: HIT without calling makeStream", async () => {
		const kv = memKv();
		const key = await aiCacheKey(PARTS);
		await kv.put(key, "cached text");
		let made = false;
		const r = await prepareCachedStream(kv, PARTS, () => {
			made = true;
			return fakeStream(["x"]);
		});
		expect(made).toBe(false);
		if (!("hit" in r)) throw new Error("expected hit");
		expect(r.hit.headers.get("X-Cache")).toBe("HIT");
		expect(await r.hit.text()).toBe("cached text");
	});

	it("a KV read failure degrades to miss (never throws)", async () => {
		const kv: KvLike = {
			get: async () => {
				throw new Error("kv down");
			},
			put: async () => {},
		};
		const r = await prepareCachedStream(kv, PARTS, () => fakeStream(["a"]));
		expect("miss" in r).toBe(true);
	});
});

describe("prepareCachedStream — forceRefresh", () => {
	it("skips the KV read and regenerates even when a cached value exists", async () => {
		const kv = memKv();
		const key = await aiCacheKey(PARTS);
		await kv.put(key, "old cached");
		let made = false;
		const r = await prepareCachedStream(
			kv,
			PARTS,
			() => {
				made = true;
				return fakeStream(["fresh"]);
			},
			{ forceRefresh: true },
		);
		expect(made).toBe(true);
		if (!("miss" in r)) throw new Error("expected miss");
		// the fresh result overwrites the old entry via the normal flow
		// (consume the stream first — the tee accumulates on listener attach)
		r.miss.stream.on("text", () => {});
		await r.miss.stream.finalMessage();
		const pending: Promise<unknown>[] = [];
		r.miss.armPersistence((p) => pending.push(p));
		await Promise.all(pending);
		expect(kv.store.get(key)).toBe("fresh");
	});

	it("without forceRefresh the cached value wins (no regeneration)", async () => {
		const kv = memKv();
		const key = await aiCacheKey(PARTS);
		await kv.put(key, "old cached");
		let made = false;
		const r = await prepareCachedStream(kv, PARTS, () => {
			made = true;
			return fakeStream(["fresh"]);
		});
		expect(made).toBe(false);
		if (!("hit" in r)) throw new Error("expected hit");
		expect(await r.hit.text()).toBe("old cached");
	});
});

describe("prepareCachedStream — MISS + armPersistence", () => {
	it("writes the full text on successful completion via waitUntil", async () => {
		const kv = memKv();
		const r = await prepareCachedStream(kv, PARTS, () => fakeStream(["he", "llo"]));
		if (!("miss" in r)) throw new Error("expected miss");
		expect(r.miss.cacheKey.startsWith(DEFAULT_CACHE_PREFIX)).toBe(true);
		// consumer streams it…
		const seen: string[] = [];
		r.miss.stream.on("text", (d) => seen.push(d));
		await r.miss.stream.finalMessage();
		expect(seen.join("")).toBe("hello");
		// …then arms persistence
		const pending: Promise<unknown>[] = [];
		r.miss.armPersistence((p) => pending.push(p));
		await Promise.all(pending);
		expect(kv.store.get(r.miss.cacheKey)).toBe("hello");
	});

	it("never writes on generation failure", async () => {
		const kv = memKv();
		const r = await prepareCachedStream(kv, PARTS, () => fakeStream(["x"], true));
		if (!("miss" in r)) throw new Error("expected miss");
		await expect(r.miss.stream.finalMessage()).rejects.toThrow();
		const pending: Promise<unknown>[] = [];
		r.miss.armPersistence((p) => pending.push(p));
		await Promise.allSettled(pending);
		expect(kv.store.has(r.miss.cacheKey)).toBe(false);
	});

	it("never writes empty output", async () => {
		const kv = memKv();
		const r = await prepareCachedStream(kv, PARTS, () => fakeStream(["   "]));
		if (!("miss" in r)) throw new Error("expected miss");
		await r.miss.stream.finalMessage();
		const pending: Promise<unknown>[] = [];
		r.miss.armPersistence((p) => pending.push(p));
		await Promise.all(pending);
		expect(kv.store.has(r.miss.cacheKey)).toBe(false);
	});

	it("a KV write failure is swallowed (response already went out)", async () => {
		const kv: KvLike = {
			get: async () => null,
			put: async () => {
				throw new Error("kv down");
			},
		};
		const r = await prepareCachedStream(kv, PARTS, () => fakeStream(["ok"]));
		if (!("miss" in r)) throw new Error("expected miss");
		await r.miss.stream.finalMessage();
		const pending: Promise<unknown>[] = [];
		r.miss.armPersistence((p) => pending.push(p));
		await expect(Promise.all(pending)).resolves.toBeDefined();
	});

	it("works with kv=null (no cache at all)", async () => {
		const r = await prepareCachedStream(null, PARTS, () => fakeStream(["z"]));
		if (!("miss" in r)) throw new Error("expected miss");
		const seen: string[] = [];
		r.miss.stream.on("text", (d) => seen.push(d));
		await r.miss.stream.finalMessage();
		expect(seen.join("")).toBe("z");
		r.miss.armPersistence(null); // no-op, no throw
	});
});

describe("teeTextStream", () => {
	it("attaches exactly ONE listener to the inner stream no matter how many wrap", async () => {
		const inner = fakeStream(["a", "b"]);
		const { stream, acc } = teeTextStream(inner);
		const seen1: string[] = [];
		const seen2: string[] = [];
		stream.on("text", (d) => seen1.push(d));
		stream.on("text", (d) => seen2.push(d));
		await stream.finalMessage();
		expect(inner.listeners).toBe(1);
		expect(acc.text).toBe("ab"); // accumulated exactly once — the old double-count bug
		expect(seen1.join("")).toBe("ab");
		expect(seen2.join("")).toBe("ab");
	});

	it("forwards errors and delegates finalMessage/abort", async () => {
		const inner = fakeStream([], true);
		const { stream } = teeTextStream(inner);
		const errs: unknown[] = [];
		stream.on("error", (e) => errs.push(e));
		await expect(stream.finalMessage()).rejects.toThrow("boom");
		expect(errs.length).toBe(1);
		expect(() => stream.abort()).not.toThrow();
	});
});
