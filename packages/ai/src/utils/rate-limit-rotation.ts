/**
 * Rotate-on-rate-limit: the transport-side surfacing hooks (plan Prong B).
 *
 * Providers back off transient 429s inside their own retry loops. When
 * sibling-credential rotation is enabled and a usable sibling exists, we want a
 * per-minute (RPM) 429 to escape that loop early — before a long in-loop sleep —
 * so the streaming a/b/c seam can rotate to another credential instead of the
 * request stalling for the whole window (the field pathology in plan §1).
 *
 * Two shapes, one policy:
 * - {@link makeRotationAwareRetryWait} wraps the Anthropic transport's
 *   `providerRetryWait` seam: it THROWS {@link RateLimitRotationRequested},
 *   which the Anthropic outer catch converts into a terminal 429 error event.
 * - {@link makeRotationAwareOnBeforeSleep} wraps the OpenAI-family
 *   `fetchWithRetry` `onBeforeSleep` seam: it returns `"surface"`, which returns
 *   the `!ok` 429 response so the caller raises a classifiable error.
 *
 * The rotation error/response both carry `retry-after-ms: <N>` (via
 * {@link formatRateLimitRotationMessage} / the surfaced `Retry-After`) so the
 * auth-storage rotation branch can size a short unscoped block. The marker class
 * lives in the dependency-light `error/rate-limit` leaf (plan N2) to keep this
 * factory free of any `stream`/`auth-storage` import that would cycle back into
 * `providers`.
 */
import { scheduler } from "node:timers/promises";
import { logger } from "@oh-my-pi/pi-utils";
import { isRotatableRateLimit, RateLimitRotationRequested } from "../error/rate-limit";
import type { RateLimitRotationOptions } from "../types";

/** Default floor for `rateLimitRotation.minSleepMs` when the host omits it. */
export const RATE_LIMIT_ROTATION_DEFAULT_MIN_SLEEP_MS = 2_000;

/** Any rate-limit sleep at or above this without rotation is worth a WARN (plan §7). */
const STALL_WARN_THRESHOLD_MS = 10_000;

const RETRY_AFTER_MS_HINT = /retry-after-ms:\s*(\d+)/i;

/**
 * The single formatter for the rotation error message. Producers (transport
 * hooks) and consumers (auth-storage block sizing, §9 contract-pin test) go
 * through this so the stringly-typed `retry-after-ms:` contract cannot drift.
 * The wording is deliberately `RATE_LIMIT_EXCEEDED`-classifiable and NOT
 * usage-limit-classifiable (asserted by the N3 contract pin).
 */
export function formatRateLimitRotationMessage(retryAfterMs: number): string {
	return `rate limit exceeded (rotation requested); retry-after-ms: ${retryAfterMs}`;
}

/** Extract the `retry-after-ms: <N>` hint embedded by {@link formatRateLimitRotationMessage}. */
export function parseRetryAfterMsHint(message: string | undefined): number | undefined {
	if (!message) return undefined;
	const match = RETRY_AFTER_MS_HINT.exec(message);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

export interface RotationAwareRetryWaitContext {
	provider: string;
	rotation: RateLimitRotationOptions;
	/** Sleep primitive; injectable for tests. Defaults to `scheduler.wait`. */
	wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Build a `providerRetryWait`-shaped hook that throws
 * {@link RateLimitRotationRequested} instead of sleeping when ALL of: rotation
 * enabled; a usable sibling exists; `cause` classifies as a rotatable RPM 429;
 * and the pending wait meets `minSleepMs`. Otherwise it sleeps normally and
 * emits a `rate_limit_stall` WARN for any un-rotated rate-limit sleep ≥10s.
 *
 * A benign empty-completion re-request passes `cause: undefined`, which never
 * classifies as rotatable, so those always sleep (plan N4).
 */
export function makeRotationAwareRetryWait(
	ctx: RotationAwareRetryWaitContext,
): (delayMs: number, signal?: AbortSignal, cause?: unknown) => Promise<void> {
	const wait = ctx.wait ?? ((delayMs: number, signal?: AbortSignal) => scheduler.wait(delayMs, { signal }));
	const minSleepMs = ctx.rotation.minSleepMs ?? RATE_LIMIT_ROTATION_DEFAULT_MIN_SLEEP_MS;
	let attempt = 0;
	return async (delayMs, signal, cause) => {
		const step = attempt++;
		const rotatable = isRotatableRateLimit(cause);
		const canRotate = ctx.rotation.enabled === true && ctx.rotation.hasUsableSibling?.() === true && rotatable;
		if (canRotate && delayMs >= minSleepMs) {
			const retryAfterMs = parseRetryAfterMsHint(cause instanceof Error ? cause.message : undefined) ?? delayMs;
			throw new RateLimitRotationRequested({ retryAfterMs, cause });
		}
		if (rotatable && delayMs >= STALL_WARN_THRESHOLD_MS) {
			logger.warn("rate_limit_stall", {
				provider: ctx.provider,
				delayMs,
				attempt: step,
				rotationAvailable: canRotate,
			});
		}
		await wait(delayMs, signal);
	};
}

export interface RotationOnBeforeSleepContext {
	provider: string;
	rotation: RateLimitRotationOptions;
}

/** Decision handed to {@link makeRotationAwareOnBeforeSleep}. Mirrors the fetch-retry hook payload. */
export interface RotationOnBeforeSleepInfo {
	attempt: number;
	delayMs: number;
	status: number;
	retryAfterMs?: number;
}

/**
 * Build a `fetchWithRetry` `onBeforeSleep`-shaped hook for the OpenAI family:
 * returns `"surface"` for a 429 when rotation is enabled, a usable sibling
 * exists, and the pending sleep meets `minSleepMs`; otherwise `"sleep"` (with a
 * `rate_limit_stall` WARN for un-rotated 429 sleeps ≥10s). The surfaced `!ok`
 * response's `Retry-After` is embedded into the raised error's message by the
 * caller, so the real `RATE_LIMIT_EXCEEDED`-vs-usage-limit classification stays
 * at the a/b/c seam (which sees the message this hook cannot).
 */
export function makeRotationAwareOnBeforeSleep(
	ctx: RotationOnBeforeSleepContext,
): (info: RotationOnBeforeSleepInfo) => "sleep" | "surface" {
	const minSleepMs = ctx.rotation.minSleepMs ?? RATE_LIMIT_ROTATION_DEFAULT_MIN_SLEEP_MS;
	return info => {
		const canRotate =
			ctx.rotation.enabled === true && ctx.rotation.hasUsableSibling?.() === true && info.status === 429;
		if (canRotate && info.delayMs >= minSleepMs) return "surface";
		if (info.status === 429 && info.delayMs >= STALL_WARN_THRESHOLD_MS) {
			logger.warn("rate_limit_stall", {
				provider: ctx.provider,
				delayMs: info.delayMs,
				attempt: info.attempt,
				rotationAvailable: canRotate,
			});
		}
		return "sleep";
	};
}
