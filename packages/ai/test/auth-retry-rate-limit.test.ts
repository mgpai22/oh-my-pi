import { describe, expect, it } from "bun:test";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai";
import { resolveRetryKey } from "@oh-my-pi/pi-ai/auth-retry";

/**
 * A3 contract: on a rotatable RPM 429, `resolveRetryKey` must ask the resolver
 * to rotate to a sibling (`lastChance: true`) even on the refresh-same step —
 * a token re-mint cannot clear a per-minute window. Other error classes keep the
 * step's own `lastChance` value.
 */
function captureLastChance(): { resolver: (ctx: ApiKeyResolveContext) => string; seen: boolean[] } {
	const seen: boolean[] = [];
	return {
		seen,
		resolver: ctx => {
			seen.push(ctx.lastChance);
			return "key";
		},
	};
}

describe("resolveRetryKey rotation predicate", () => {
	it("forces a sibling rotation on a rotatable rate-limit error at the refresh-same step", async () => {
		const { resolver, seen } = captureLastChance();
		await resolveRetryKey(resolver, /* lastChance */ false, new Error("429 too many requests, per minute"));
		expect(seen).toEqual([true]);
	});

	it("forces a sibling rotation on a usage-limit error at the refresh-same step", async () => {
		const { resolver, seen } = captureLastChance();
		await resolveRetryKey(resolver, false, new Error("You have hit your usage limit. quota will reset"));
		expect(seen).toEqual([true]);
	});

	it("keeps refresh-same for a plain 401 and for capacity/overload errors", async () => {
		const auth = captureLastChance();
		await resolveRetryKey(auth.resolver, false, new Error("401 authentication_error"));
		expect(auth.seen).toEqual([false]);

		const overloaded = captureLastChance();
		await resolveRetryKey(overloaded.resolver, false, new Error("529 service overloaded, capacity exhausted"));
		expect(overloaded.seen).toEqual([false]);
	});
});
