// @dawn-studio/ai-cache — TextStream → streaming HTTP Response helpers.
//
// The consumer side of `prepareCachedStream` (see cache.ts):
//   const r = await prepareCachedStream(kv, parts, makeStream);
//   if ("hit" in r) return r.hit;
//   const response = await streamToPrimedResponse(r.miss.stream);
//   r.miss.armPersistence((p) => ctx.waitUntil(p));
//   return response;
//
// `streamToPrimedResponse` waits for the first text chunk (or failure) BEFORE
// returning the Response. Background: returning headers immediately means a
// provider failure before the first token (rate limit / bad key / DNS) surfaces
// to the client as a silently truncated stream with no usable status code.
// Primed: the failure happens before the Response exists, so the caller can
// return a proper JSON error instead.

import type { TextStream } from "./cache.js";

const STREAM_HEADERS: Record<string, string> = {
	"Content-Type": "text/plain; charset=utf-8",
	"Cache-Control": "no-store",
	"X-Accel-Buffering": "no",
};

export interface StreamResponseOptions {
	/**
	 * Extra/override headers, merged over the defaults
	 * (Content-Type text/plain, Cache-Control no-store, X-Accel-Buffering no).
	 */
	headers?: Record<string, string>;
	/** HTTP status for the streaming response. @default 200 */
	status?: number;
}

function streamInit(opts: StreamResponseOptions = {}): ResponseInit {
	return {
		status: opts.status ?? 200,
		headers: { ...STREAM_HEADERS, ...opts.headers },
	};
}

/** Turn a TextStream into a plain-text streaming HTTP Response for progressive rendering. */
export function streamToResponse(stream: TextStream, opts: StreamResponseOptions = {}): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			stream.on("text", (delta) => controller.enqueue(encoder.encode(delta)));
			stream.on("error", (err) => controller.error(err));
			stream
				.finalMessage()
				.then(() => controller.close())
				.catch((err) => controller.error(err));
		},
		cancel() {
			stream.abort();
		},
	});
	return new Response(body, streamInit(opts));
}

/**
 * Primed streaming Response: waits for the first text chunk (or failure) before
 * returning. The primed chunk is replayed first, so the body is complete.
 *
 * @param timeoutMs max wait for the first chunk. @default 20000
 * @throws the provider's original error when it fails before the first token
 *         (the caller maps it to a status code), or a timeout error.
 */
export async function streamToPrimedResponse(
	stream: TextStream,
	timeoutMs = 20_000,
	opts: StreamResponseOptions = {},
): Promise<Response> {
	const first = await waitForFirstChunk(stream, timeoutMs);
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			// The prime already consumed the first chunk — replay it so the body is whole.
			if (first) controller.enqueue(encoder.encode(first));
			stream.on("text", (delta) => controller.enqueue(encoder.encode(delta)));
			stream.on("error", (err) => controller.error(err));
			stream
				.finalMessage()
				.then(() => controller.close())
				.catch((err) => controller.error(err));
		},
		cancel() {
			stream.abort();
		},
	});
	return new Response(body, streamInit(opts));
}

/** Wait for the stream's first text chunk; failures (incl. timeout) reject to the caller. */
function waitForFirstChunk(stream: TextStream, timeoutMs: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			done(() =>
				reject(new Error(`AI request timed out: no first text chunk within ${Math.round(timeoutMs / 1000)}s`)),
			);
		}, timeoutMs);
		stream.on("text", (delta) => done(() => resolve(delta)));
		stream.on("error", (err) => done(() => reject(err)));
		stream
			.finalMessage()
			.then(() => done(() => resolve("")))
			.catch((err) => done(() => reject(err)));
	});
}
