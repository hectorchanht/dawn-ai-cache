// @dawn-studio/ai-cache — client-side streaming POST.
//
// The consumer counterpart to the server helpers in stream.ts: POST a JSON body
// to your own streaming endpoint (one served by `streamToPrimedResponse`) and
// receive the text progressively.
//
// `onText` receives the CUMULATIVE full text (not deltas), throttled — so a long
// response doesn't re-trigger a markdown re-parse on every token (O(n²) jank).
// The final call always delivers the complete text.

export interface StreamPostOptions {
	/** Minimum ms between onText calls. @default 80 */
	throttleMs?: number;
	/** AbortSignal to cancel the request. */
	signal?: AbortSignal;
	/** HTTP method. @default "POST" */
	method?: string;
	/**
	 * Extra request headers, merged over `Content-Type: application/json`.
	 * `fetchInit.headers` (if also given) wins over these.
	 */
	headers?: Record<string, string>;
	/** Extra fetch init (e.g. credentials). */
	fetchInit?: RequestInit;
}

/**
 * POST JSON and stream the plain-text response body.
 *
 * @throws Error with the server's `{ error }` message (or `Request failed (<status>)`)
 *         when the response is not OK.
 */
export async function streamPost(
	url: string,
	body: unknown,
	onText: (fullText: string) => void,
	opts: StreamPostOptions = {},
): Promise<void> {
	const throttleMs = opts.throttleMs ?? 80;
	const mergedHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		...opts.headers,
		...(opts.fetchInit?.headers as Record<string, string> | undefined),
	};
	const { headers: _ignored, ...restInit } = opts.fetchInit ?? {};
	const res = await fetch(url, {
		...restInit,
		method: opts.method ?? restInit.method ?? "POST",
		headers: mergedHeaders,
		body: JSON.stringify(body),
		signal: opts.signal ?? restInit.signal,
	});
	if (!res.ok || !res.body) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Request failed (${res.status})`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let full = "";
	let last = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		full += decoder.decode(value, { stream: true });
		const now = Date.now();
		if (now - last >= throttleMs) {
			last = now;
			onText(full);
		}
	}
	onText(full); // final full text — never drop the tail
}
