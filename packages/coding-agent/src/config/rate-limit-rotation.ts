import type { AuthStorage, RateLimitRotationInfo, RateLimitRotationOptions } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

/** Recompute the display block window from the rotating error's retry-after hint (N1). */
export function rotationBlockedForMs(info: RateLimitRotationInfo): number | undefined {
	// The real block is sized privately inside rotateSessionCredential and never
	// returns here; recompute the same clamp for display. Usage-limit blocks use
	// a server-derived window we do not know, so leave undefined for them.
	return info.reason === "rate_limit" ? Math.min(Math.max(info.retryAfterMs ?? 60_000, 5_000), 120_000) : undefined;
}

export interface RateLimitRotationOptionParams {
	/** `retry.rotateOnRateLimit` — master switch. When false the helper returns undefined. */
	enabled: boolean;
	/** `retry.rotateMinSleepMs`. */
	minSleepMs: number;
	/** Credential store providing the sibling-availability capability. */
	authStorage: Pick<AuthStorage, "hasUsableSibling">;
	/** Request provider (sibling check + rotation event are provider-scoped). */
	provider: string;
	/** Session id for the sibling check. */
	sessionId: string | undefined;
	/** Optional extra sink (e.g. a session UI event) fired after the structured log. */
	onRotate?: (info: RateLimitRotationInfo) => void;
}

/**
 * Build the {@link RateLimitRotationOptions} threaded onto a stream call, or
 * `undefined` when the feature is disabled. Shared by the sdk main/subagent
 * Agent construction and the coding-agent auxiliary-stream sites so the
 * hasUsableSibling capability, the structured rotation log, and the display
 * block-window computation stay in one place. pi-ai stays headless: the
 * capability and callback are supplied here, not reached for by pi-ai.
 */
export function createRateLimitRotationOptions(
	params: RateLimitRotationOptionParams,
): RateLimitRotationOptions | undefined {
	if (!params.enabled) return undefined;
	const { authStorage, provider, sessionId, minSleepMs, onRotate } = params;
	return {
		enabled: true,
		minSleepMs,
		hasUsableSibling: () => authStorage.hasUsableSibling(provider, sessionId),
		onRotate: info => {
			logger.info("credential rotated on rate limit", {
				provider: info.provider,
				reason: info.reason,
				retryAfterMs: info.retryAfterMs,
				attempt: info.attempt,
				blockedForMs: rotationBlockedForMs(info),
			});
			onRotate?.(info);
		},
	};
}
