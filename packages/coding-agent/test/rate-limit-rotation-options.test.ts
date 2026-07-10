import { describe, expect, it } from "bun:test";
import type { RateLimitRotationInfo } from "@oh-my-pi/pi-ai";
import { createRateLimitRotationOptions, rotationBlockedForMs } from "../src/config/rate-limit-rotation";

const authStorage = (siblings: boolean) => ({ hasUsableSibling: () => siblings });

describe("createRateLimitRotationOptions", () => {
	it("returns undefined when the flag is off (G3)", () => {
		expect(
			createRateLimitRotationOptions({
				enabled: false,
				minSleepMs: 2_000,
				authStorage: authStorage(true),
				provider: "anthropic",
				sessionId: "s",
			}),
		).toBeUndefined();
	});

	it("wires the sibling capability and fires the extra onRotate sink", () => {
		const seen: RateLimitRotationInfo[] = [];
		const options = createRateLimitRotationOptions({
			enabled: true,
			minSleepMs: 2_500,
			authStorage: authStorage(true),
			provider: "anthropic",
			sessionId: "s",
			onRotate: info => seen.push(info),
		});
		expect(options?.enabled).toBe(true);
		expect(options?.minSleepMs).toBe(2_500);
		expect(options?.hasUsableSibling?.()).toBe(true);

		const info: RateLimitRotationInfo = {
			provider: "anthropic",
			reason: "rate_limit",
			retryAfterMs: 8_000,
			attempt: 0,
		};
		options?.onRotate?.(info);
		expect(seen).toEqual([info]);
	});
});

describe("rotationBlockedForMs", () => {
	it("clamps rate-limit blocks to [5s,120s] and leaves usage-limit blocks unknown", () => {
		expect(rotationBlockedForMs({ provider: "p", reason: "rate_limit", retryAfterMs: 37_000, attempt: 0 })).toBe(
			37_000,
		);
		expect(rotationBlockedForMs({ provider: "p", reason: "rate_limit", retryAfterMs: 1_000, attempt: 0 })).toBe(
			5_000,
		);
		expect(rotationBlockedForMs({ provider: "p", reason: "rate_limit", retryAfterMs: 600_000, attempt: 0 })).toBe(
			120_000,
		);
		expect(rotationBlockedForMs({ provider: "p", reason: "usage_limit", attempt: 0 })).toBeUndefined();
	});
});
