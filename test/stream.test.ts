import { describe, it, expect } from "vitest";
import { streamToResponse, streamToPrimedResponse } from "../src/stream.js";
import type { TextStream } from "../src/cache.js";

/** Manually-driven TextStream for priming tests. */
function deferredStream() {
	const textLs: Array<(d: string) => void> = [];
	const errLs: Array<(e: unknown) => void> = [];
	let resolveFinal!: (v: unknown) => void;
	let rejectFinal!: (e: unknown) => void;
	const finalPromise = new Promise<unknown>((res, rej) => {
		resolveFinal = res;
		rejectFinal = rej;
	});
	const stream: TextStream = {
		on(event: "text" | "error", listener: (a: never) => void): unknown {
			(event === "text" ? textLs : errLs).push(listener as (d: string) => void);
			return stream;
		},
		finalMessage: () => finalPromise,
		abort: () => {},
	};
	return {
		stream,
		emit: (chunk: string) => {
			for (const l of [...textLs]) l(chunk);
		},
		fail: (err: unknown) => {
			for (const l of [...errLs]) l(err);
			rejectFinal(err);
		},
		done: () => resolveFinal(""),
	};
}

describe("streamToResponse", () => {
	it("streams every chunk through the Response body", async () => {
		const d = deferredStream();
		const res = streamToResponse(d.stream);
		d.emit("he");
		d.emit("llo");
		d.done();
		expect(await res.text()).toBe("hello");
	});

	it("surfaces a mid-stream provider error to the reader", async () => {
		const d = deferredStream();
		const res = streamToResponse(d.stream);
		d.emit("partial");
		d.fail(new Error("provider down"));
		await expect(res.text()).rejects.toThrow("provider down");
	});
});

describe("streamToPrimedResponse", () => {
	it("replays the primed first chunk so the body is complete", async () => {
		const d = deferredStream();
		const p = streamToPrimedResponse(d.stream);
		d.emit("first"); // prime resolves here
		const res = await p;
		d.emit("-second");
		d.done();
		expect(await res.text()).toBe("first-second");
	});

	it("rejects with the provider error when it fails before the first chunk", async () => {
		const d = deferredStream();
		const p = streamToPrimedResponse(d.stream);
		d.fail(new Error("AI_BUDGET_EXCEEDED:cap"));
		await expect(p).rejects.toThrow("AI_BUDGET_EXCEEDED");
	});

	it("rejects on timeout when no chunk arrives", async () => {
		const d = deferredStream();
		await expect(streamToPrimedResponse(d.stream, 50)).rejects.toThrow(/timed out/);
	});

	it("resolves with an empty prime when the stream ends chunkless", async () => {
		const d = deferredStream();
		const p = streamToPrimedResponse(d.stream);
		d.done(); // finalMessage resolves with zero chunks → prime is ""
		const res = await p;
		expect(await res.text()).toBe("");
	});
});
