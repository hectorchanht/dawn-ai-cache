import { describe, it, expect, vi, afterEach } from "vitest";
import { streamPost } from "../src/client.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function okResponse(text: string): Response {
	return new Response(text, {
		status: 200,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

describe("streamPost", () => {
	it("delivers the cumulative full text and ends with the complete body", async () => {
		vi.stubGlobal("fetch", async () => okResponse("hello world"));
		const seen: string[] = [];
		await streamPost("https://x.test/api", { q: 1 }, (t) => seen.push(t), { throttleMs: 0 });
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[seen.length - 1]).toBe("hello world");
		// cumulative, not deltas: every entry is a prefix of the next
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
		}
	});

	it("throttles onText (first chunk immediate, then throttled, final always fires)", async () => {
		vi.stubGlobal("fetch", async () => okResponse("abcdefghij"));
		const seen: string[] = [];
		await streamPost("https://x.test/api", {}, (t) => seen.push(t), { throttleMs: 60_000 });
		// first chunk fires immediately, the rest is throttled away, final call always fires
		expect(seen.length).toBeLessThanOrEqual(2);
		expect(seen[seen.length - 1]).toBe("abcdefghij");
	});

	it("throws the server's error message on non-OK", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ error: "AI_BUDGET_EXCEEDED:cap" }), { status: 429 }),
		);
		await expect(streamPost("https://x.test/api", {}, () => {})).rejects.toThrow(
			"AI_BUDGET_EXCEEDED",
		);
	});

	it("falls back to a status message when the error body is not JSON", async () => {
		vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
		await expect(streamPost("https://x.test/api", {}, () => {})).rejects.toThrow(
			"Request failed (500)",
		);
	});

	it("posts JSON with the right method and headers", async () => {
		let gotUrl = "";
		let gotInit: RequestInit = {};
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			gotUrl = url;
			gotInit = init;
			return okResponse("ok");
		});
		await streamPost("https://x.test/api/chat", { a: 1 }, () => {});
		expect(gotUrl).toBe("https://x.test/api/chat");
		expect(gotInit.method).toBe("POST");
		expect((gotInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
		expect(gotInit.body).toBe(JSON.stringify({ a: 1 }));
	});
});
