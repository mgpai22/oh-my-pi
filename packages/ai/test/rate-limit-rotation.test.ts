import { describe, expect, it, spyOn } from "bun:test";
import {
	isRotatableRateLimit,
	isRotatableRateLimitOutcome,
	isUsageLimitOutcome,
	parseRateLimitReason,
	RateLimitRotationRequested,
} from "@oh-my-pi/pi-ai/error/rate-limit";
import type { RateLimitRotationOptions } from "@oh-my-pi/pi-ai/types";
import {
	formatRateLimitRotationMessage,
	makeRotationAwareOnBeforeSleep,
	makeRotationAwareRetryWait,
	parseRetryAfterMsHint,
} from "@oh-my-pi/pi-ai/utils/rate-limit-rotation";
import { logger } from "@oh-my-pi/pi-utils";

const rotation = (over: Partial<RateLimitRotationOptions> = {}): RateLimitRotationOptions => ({
	enabled: true,
	minSleepMs: 2_000,
	hasUsableSibling: () => true,
	...over,
});

describe("isRotatableRateLimitOutcome", () => {
	it("is true only for RATE_LIMIT_EXCEEDED messages", () => {
		expect(isRotatableRateLimitOutcome(429, "Too many requests, please slow down")).toBe(true);
		expect(isRotatableRateLimitOutcome(429, "Rate limit exceeded, try again per minute")).toBe(true);
	});

	it("is false for quota / capacity / server / unknown reasons", () => {
		// QUOTA_EXHAUSTED (account cap → usage-limit long block, not rotation)
		expect(isRotatableRateLimitOutcome(429, "You have hit your usage limit. quota will reset in 1h")).toBe(false);
		// MODEL_CAPACITY_EXHAUSTED (529 / overloaded — provider-wide, must not thrash siblings)
		expect(isRotatableRateLimitOutcome(529, "Service overloaded, capacity exhausted")).toBe(false);
		// SERVER_ERROR
		expect(isRotatableRateLimitOutcome(500, "internal server error")).toBe(false);
		// UNKNOWN
		expect(isRotatableRateLimitOutcome(429, "Please retry in 5s")).toBe(false);
		// no message → nothing to classify
		expect(isRotatableRateLimitOutcome(429, undefined)).toBe(false);
	});

	it("isRotatableRateLimit reads the message off an error object", () => {
		expect(isRotatableRateLimit(new Error("429 rate limit exceeded"))).toBe(true);
		expect(isRotatableRateLimit(new Error("usage limit reached, quota will reset"))).toBe(false);
		expect(isRotatableRateLimit(undefined)).toBe(false);
	});
});

describe("rotation message contract pin (plan N3)", () => {
	it("the shared formatter string is rotatable, NOT usage-limit, and round-trips retryAfterMs", () => {
		const message = formatRateLimitRotationMessage(37_000);
		// All four assertions the plan pins so wording drift cannot silently
		// reroute the rotation error into the usage-limit long-block path.
		expect(parseRateLimitReason(message)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isRotatableRateLimitOutcome(429, message)).toBe(true);
		expect(isUsageLimitOutcome(429, message)).toBe(false);
		expect(parseRetryAfterMsHint(message)).toBe(37_000);
	});

	it("parseRetryAfterMsHint returns undefined without a hint", () => {
		expect(parseRetryAfterMsHint("429 too many requests")).toBeUndefined();
		expect(parseRetryAfterMsHint(undefined)).toBeUndefined();
	});
});

describe("makeRotationAwareRetryWait", () => {
	const rateLimitCause = new Error("429 too many requests");

	it("throws the marker when enabled, a sibling exists, the cause is rotatable, and delay ≥ minSleepMs", async () => {
		let slept = 0;
		const wait = makeRotationAwareRetryWait({
			provider: "anthropic",
			rotation: rotation(),
			wait: async () => {
				slept++;
			},
		});
		await expect(wait(5_000, undefined, rateLimitCause)).rejects.toBeInstanceOf(RateLimitRotationRequested);
		expect(slept).toBe(0);
	});

	it("carries the parsed retry-after-ms hint (else the delay) on the marker", async () => {
		const wait = makeRotationAwareRetryWait({ provider: "anthropic", rotation: rotation(), wait: async () => {} });
		const withHint = wait(5_000, undefined, new Error("429 too many requests; retry-after-ms: 8000")).catch(e => e);
		expect(((await withHint) as RateLimitRotationRequested).retryAfterMs).toBe(8_000);
		const noHint = wait(6_000, undefined, rateLimitCause).catch(e => e);
		expect(((await noHint) as RateLimitRotationRequested).retryAfterMs).toBe(6_000);
	});

	it("sleeps (never throws) when disabled, no sibling, non-429 cause, or delay below minSleepMs", async () => {
		const cases: RateLimitRotationOptions[] = [
			rotation({ enabled: false }),
			rotation({ hasUsableSibling: () => false }),
			rotation({ hasUsableSibling: undefined }),
		];
		for (const rot of cases) {
			let slept = 0;
			const wait = makeRotationAwareRetryWait({
				provider: "anthropic",
				rotation: rot,
				wait: async () => {
					slept++;
				},
			});
			await wait(5_000, undefined, rateLimitCause);
			expect(slept).toBe(1);
		}
		// non-429 cause (empty-completion retry passes cause=undefined, plan N4)
		let sleptUndef = 0;
		const undefWait = makeRotationAwareRetryWait({
			provider: "anthropic",
			rotation: rotation(),
			wait: async () => {
				sleptUndef++;
			},
		});
		await undefWait(5_000, undefined, undefined);
		expect(sleptUndef).toBe(1);
		// below minSleepMs
		let sleptShort = 0;
		const shortWait = makeRotationAwareRetryWait({
			provider: "anthropic",
			rotation: rotation({ minSleepMs: 2_000 }),
			wait: async () => {
				sleptShort++;
			},
		});
		await shortWait(500, undefined, rateLimitCause);
		expect(sleptShort).toBe(1);
	});

	it("emits a rate_limit_stall WARN on an un-rotated rate-limit sleep ≥10s", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const wait = makeRotationAwareRetryWait({
				provider: "anthropic",
				rotation: rotation({ hasUsableSibling: () => false }),
				wait: async () => {},
			});
			await wait(12_000, undefined, rateLimitCause);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toBe("rate_limit_stall");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("makeRotationAwareOnBeforeSleep", () => {
	it("surfaces a 429 when enabled with a sibling and delay ≥ minSleepMs", () => {
		const decide = makeRotationAwareOnBeforeSleep({ provider: "openai", rotation: rotation() });
		expect(decide({ attempt: 0, delayMs: 5_000, status: 429 })).toBe("surface");
	});

	it("sleeps for a non-429 status, no sibling, disabled, or short delay", () => {
		expect(
			makeRotationAwareOnBeforeSleep({ provider: "openai", rotation: rotation() })({
				attempt: 0,
				delayMs: 5_000,
				status: 503,
			}),
		).toBe("sleep");
		expect(
			makeRotationAwareOnBeforeSleep({ provider: "openai", rotation: rotation({ hasUsableSibling: () => false }) })({
				attempt: 0,
				delayMs: 5_000,
				status: 429,
			}),
		).toBe("sleep");
		expect(
			makeRotationAwareOnBeforeSleep({ provider: "openai", rotation: rotation({ enabled: false }) })({
				attempt: 0,
				delayMs: 5_000,
				status: 429,
			}),
		).toBe("sleep");
		expect(
			makeRotationAwareOnBeforeSleep({ provider: "openai", rotation: rotation() })({
				attempt: 0,
				delayMs: 500,
				status: 429,
			}),
		).toBe("sleep");
	});
});
