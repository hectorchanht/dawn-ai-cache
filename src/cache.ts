// @dawn-studio/ai-cache — server-side AI response cache (saves Workers AI budget).
//
// Design:
// - The caller provides the KV binding (any object with get/put) — this lib never
//   touches env directly, so it runs on Cloudflare Workers, in tests, anywhere.
// - Cache key = sha256 of the STABLE-serialized key parts. The standing rule:
//   cache by (prompt version + input hash), so repeated questions cost zero.
//   Bump `keyPrefix` to invalidate all old entries at once.
// - Only COMPLETE, successful responses are cached: the stream is tee'd, text is
//   accumulated, and the KV write happens via `waitUntil` after finalMessage()
//   resolves. Errors / truncations / empty text are never written.
// - Chat / infer-time (conversational, history-dependent) calls should NOT use this
//   — hit rate is near zero. Use it for deterministic generations (same input +
//   same config → same response).

import { sha256hex } from "./hash.js";

/** Cache key namespace. Bump to invalidate every old entry at once. */
export const DEFAULT_CACHE_PREFIX = "aicache:2:";
/** 90 days — cached AI responses are deterministic, so long TTL is safe. */
export const DEFAULT_CACHE_TTL_SECONDS = 90 * 24 * 3600;

/**
 * The parts that identify a deterministic generation. Keep it to what actually
 * changes the output: provider, model, prompt version, input hash, locale, etc.
 * Values are trimmed/lowercased where noted; missing optionals become "".
 */
export interface AiCacheKeyParts {
	/** Effective provider, lowercase (e.g. "workers-ai"). */
	provider: string;
	/** Effective model name; "" when the provider default is deterministic per deploy. */
	model?: string;
	/** Prompt version / persona hash — changing the prompt MUST change the key. */
	promptHash: string;
	/** Canonical input hash (the generation is a deterministic function of this). */
	inputHash: string;
	/** Any other dimensions that change the output (locale, section, lens…). */
	extra?: Record<string, string>;
}

/** Stable cache key from the parts. */
export async function aiCacheKey(
	p: AiCacheKeyParts,
	prefix: string = DEFAULT_CACHE_PREFIX,
): Promise<string> {
	const norm: Record<string, string> = {
		provider: p.provider.trim().toLowerCase(),
		model: (p.model ?? "").trim(),
		promptHash: p.promptHash,
		inputHash: p.inputHash,
	};
	for (const [k, v] of Object.entries(p.extra ?? {})) norm[`extra.${k}`] = v;
	return prefix + (await sha256hex(JSON.stringify(norm)));
}

/** Minimal KV interface (a Cloudflare KV binding satisfies this; tests inject memory). */
export interface KvLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>;
}

/**
 * Minimal text-stream interface (Anthropic-style events). The caller's provider
 * adapter must satisfy this — no dependency on any provider SDK.
 */
export interface TextStream {
	on(event: "text", listener: (delta: string) => void): unknown;
	on(event: "error", listener: (err: unknown) => void): unknown;
	finalMessage(): Promise<unknown>;
	abort(): void;
}

export interface CachedStream {
	stream: TextStream;
	cacheKey: string;
	/**
	 * Call after the final Response is built: registers the background cache write
	 * via `waitUntil`. Writes only when the stream COMPLETED successfully and the
	 * accumulated text is non-empty; failures/truncations/empty output are skipped.
	 */
	armPersistence: (waitUntil: ((p: Promise<unknown>) => void) | null) => void;
}

/** Info passed to cache lifecycle callbacks. */
export interface CacheEvent {
	key: string;
	/** Response bytes (hit / write events only). */
	bytes?: number;
}

const DEFAULT_HIT_HEADERS: Record<string, string> = {
	"Content-Type": "text/plain; charset=utf-8",
	"Cache-Control": "public, max-age=86400",
	"X-Cache": "HIT",
};

export interface CacheOptions {
	/** Cache key namespace; bump to invalidate. @default DEFAULT_CACHE_PREFIX */
	prefix?: string;
	/** KV TTL seconds. @default DEFAULT_CACHE_TTL_SECONDS */
	ttlSeconds?: number;
	/**
	 * Deliberate re-run: skip the KV read and force a fresh generation.
	 * The new result overwrites the cached entry via the normal armPersistence flow.
	 * Use when the user explicitly hits regenerate / retry.
	 * @default false
	 */
	forceRefresh?: boolean;
	/**
	 * Full header set for the HIT Response (merged over the defaults:
	 * Content-Type text/plain, Cache-Control public max-age=86400, X-Cache: HIT).
	 * Use to add e.g. CORS headers or change the max-age per route.
	 */
	hitHeaders?: Record<string, string>;
	/** Called on a cache hit (never throws into the caller). */
	onCacheHit?: (e: CacheEvent) => void;
	/** Called on a cache miss, before makeStream runs (never throws into the caller). */
	onCacheMiss?: (e: CacheEvent) => void;
	/** Called after a successful KV write (never throws into the caller). */
	onCacheWrite?: (e: CacheEvent) => void;
}

/** Fire a user callback without ever letting it break the response path. */
function safeNotify(fn: ((e: CacheEvent) => void) | undefined, e: CacheEvent): void {
	if (!fn) return;
	try {
		fn(e);
	} catch {
		/* user callback failure must not affect the response */
	}
}

/**
 * Cache orchestration: check KV first — on hit, return a Response directly
 * (`X-Cache: HIT`); on miss, return a tee-wrapped stream — the caller streams it
 * to the client, then calls `armPersistence()` (`X-Cache: MISS`).
 *
 * Never throws on KV faults: a failed read degrades to miss, a failed write is
 * swallowed — the response already went out.
 *
 * Pass `forceRefresh: true` when the user deliberately re-runs (regenerate /
 * retry button): the KV read is skipped and the fresh result overwrites the
 * cached entry.
 */
export async function prepareCachedStream(
	kv: KvLike | null,
	parts: AiCacheKeyParts,
	makeStream: () => TextStream,
	opts: CacheOptions = {},
): Promise<{ hit: Response } | { miss: CachedStream }> {
	const prefix = opts.prefix ?? DEFAULT_CACHE_PREFIX;
	const ttlSeconds = opts.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
	const key = await aiCacheKey(parts, prefix);
	if (kv && !opts.forceRefresh) {
		try {
			const hit = await kv.get(key);
			if (hit) {
				safeNotify(opts.onCacheHit, { key, bytes: hit.length });
				return {
					hit: new Response(hit, {
						headers: { ...DEFAULT_HIT_HEADERS, ...opts.hitHeaders },
					}),
				};
			}
		} catch {
			/* read failure → treat as miss */
		}
	}
	safeNotify(opts.onCacheMiss, { key });
	const { stream, acc } = teeTextStream(makeStream());
	return {
		miss: {
			stream,
			cacheKey: key,
			armPersistence: (waitUntil) => {
				if (!kv || !waitUntil) return;
				waitUntil(
					stream.finalMessage().then(
						async () => {
							if (acc.text.trim()) {
								try {
									await kv.put(key, acc.text, { expirationTtl: ttlSeconds });
									safeNotify(opts.onCacheWrite, { key, bytes: acc.text.length });
								} catch {
									/* write failure must not affect the response already sent */
								}
							}
						},
						() => {
							/* generation failed: never cache */
						},
					),
				);
			},
		},
	};
}

/**
 * Wrap a TextStream: forward every event untouched, while accumulating text chunks
 * into `acc.text`.
 *
 * Key invariant: however many text listeners attach to the WRAPPER, the inner
 * stream gets exactly ONE listener that fans out — every chunk is accumulated
 * exactly once. (A naive per-listener attach double-counts when e.g. a warmer
 * and the real consumer both listen.)
 */
export function teeTextStream(inner: TextStream): { stream: TextStream; acc: { text: string } } {
	const acc = { text: "" };
	const textListeners: Array<(d: string) => void> = [];
	let attached = false;
	const stream: TextStream = {
		on(event: "text" | "error", listener: (arg: never) => void): unknown {
			if (event === "text") {
				if (!attached) {
					attached = true;
					inner.on("text", (d: string) => {
						acc.text += d;
						for (const l of [...textListeners]) l(d);
					});
				}
				textListeners.push(listener as (d: string) => void);
			} else {
				inner.on("error", listener as (e: unknown) => void);
			}
			return stream;
		},
		finalMessage(): Promise<unknown> {
			return inner.finalMessage();
		},
		abort(): void {
			inner.abort();
		},
	};
	return { stream, acc };
}
