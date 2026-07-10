import { describe, expect, it } from "bun:test";
import { isRotatableRateLimitOutcome, isUsageLimitOutcome } from "@oh-my-pi/pi-ai/error/rate-limit";
import { captureOpenAIHttpError } from "@oh-my-pi/pi-ai/utils/openai-http";
import { parseRetryAfterMsHint } from "@oh-my-pi/pi-ai/utils/rate-limit-rotation";
import { extractRetryHint } from "@oh-my-pi/pi-utils";

/**
 * The EMBED half of the plan §9 "retry-after-ms message parsing round-trip":
 * {@link captureOpenAIHttpError} (postOpenAIStream's surfaced-429 path) appends
 * `; retry-after-ms: <N>` to the error message so auth-storage's rotation branch
 * (via {@link parseRetryAfterMsHint}) can size the short block. The suffix is
 * gated on a truthy `detail` — an opaque/empty body must NOT be suffixed (plan
 * R5: it stays classifiable as a usage-limit outcome).
 */
describe("captureOpenAIHttpError retry-after-ms embedding", () => {
	it("round-trips the server Retry-After through the message on an informative 429 body", async () => {
		const response = new Response(
			JSON.stringify({ error: { message: "Rate limit reached for requests", type: "rate_limit_exceeded" } }),
			{ status: 429, headers: { "content-type": "application/json", "retry-after-ms": "8000" } },
		);
		// postOpenAIStream computes the hint exactly this way before handing it over.
		const hint = extractRetryHint(response);
		expect(hint).toBe(8_000);

		const error = await captureOpenAIHttpError(response, hint);
		// The embedded hint parses back to the exact N that A4 will read.
		expect(parseRetryAfterMsHint(error.message)).toBe(8_000);
		// And the message stays a rotatable rate limit, never usage-limit.
		expect(isRotatableRateLimitOutcome(429, error.message)).toBe(true);
		expect(isUsageLimitOutcome(429, error.message)).toBe(false);
	});

	it("does NOT suffix an opaque/empty 429 body even when a hint is supplied", async () => {
		const response = new Response("", { status: 429, headers: { "retry-after-ms": "8000" } });
		const error = await captureOpenAIHttpError(response, extractRetryHint(response));
		// Opaque body → "<status> status code (no body)", left untouched (plan R5).
		expect(error.message).toBe("429 status code (no body)");
		expect(error.message).not.toContain("retry-after-ms");
		expect(parseRetryAfterMsHint(error.message)).toBeUndefined();
	});

	it("leaves the message unsuffixed when there is no Retry-After to embed", async () => {
		const response = new Response(JSON.stringify({ error: { message: "Rate limit reached for requests" } }), {
			status: 429,
			headers: { "content-type": "application/json" },
		});
		const error = await captureOpenAIHttpError(response, extractRetryHint(response));
		expect(error.message).not.toContain("retry-after-ms");
	});
});
