// @dawn-studio/ai-cache — sha256 hex via WebCrypto.
//
// Works in browsers (https/localhost), edge runtimes, and node 18+ — everywhere
// `globalThis.crypto.subtle` exists.

/** sha256 hex (lowercase) of the input text. Throws if WebCrypto is unavailable. */
export async function sha256hex(text: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this environment");
	const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
