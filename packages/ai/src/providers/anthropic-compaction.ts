import { isBedrockAnthropicRoute, isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import type { Model } from "../types";
import type { AnthropicMessagesClientLike } from "./anthropic-client";
import { normalizeAnthropicBaseUrl, resolveDirectAnthropicBaseUrl } from "./anthropic-state";

function isCompactionCapableModel(model: Model<"anthropic-messages">): boolean {
	return model.compat.supportsServerCompaction === true && model.remoteCompaction?.enabled !== false;
}

/** Supported Anthropic Messages deployments; gateways require an explicit opt-in. */
function isSupportedCompactionEndpoint(baseUrl: string | undefined): boolean {
	if (isOfficialAnthropicApiUrl(baseUrl)) return true;
	if (!baseUrl) return false;
	try {
		const { hostname, pathname } = new URL(baseUrl);
		return (
			/^(?:[a-z0-9-]+[-.])?aiplatform\.googleapis\.com$/.test(hostname) ||
			(hostname.endsWith(".services.ai.azure.com") &&
				(pathname === "/" || pathname === "/anthropic" || pathname.startsWith("/anthropic/"))) ||
			/^aws-external-anthropic\.[a-z0-9-]+\.api\.aws$/.test(hostname)
		);
	} catch {
		return false;
	}
}

/** Whether the model's effective first-party route is the official Anthropic API. */
export function resolvesToOfficialAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	const baseUrl =
		model.provider === "anthropic" ? resolveDirectAnthropicBaseUrl(model) : normalizeAnthropicBaseUrl(model.baseUrl);
	return isOfficialAnthropicApiUrl(baseUrl);
}

/**
 * Whether model policy and the effective deployment support on-demand compaction.
 * A route outside the known deployments, such as a custom gateway or proxy,
 * qualifies only when its model declares the capability and opts in with
 * `remoteCompaction.enabled`, and only on the model's own configured endpoint.
 */
export function supportsAnthropicCompaction(model: Model<"anthropic-messages">, effectiveBaseUrl?: string): boolean {
	if (!isCompactionCapableModel(model)) return false;
	const ownRoute = normalizeAnthropicBaseUrl(model.baseUrl);
	const effective = effectiveBaseUrl === undefined ? undefined : normalizeAnthropicBaseUrl(effectiveBaseUrl);
	const optedIn = model.remoteCompaction?.enabled === true;
	if (
		model.transport === "pi-native" &&
		(model.compat.firstPartyProvider === true || optedIn) &&
		(effective === undefined || effective === ownRoute)
	) {
		return true;
	}
	const route = effective ?? (model.provider === "anthropic" ? resolveDirectAnthropicBaseUrl(model) : ownRoute);
	// Bedrock's Anthropic Messages API implements on-demand compaction. The flag is detected
	// from a Bedrock `/anthropic` baseUrl, or set in models.yml for a proxy or a reroute; it
	// applies to the model's own endpoint or a Bedrock `/anthropic` route it reaches.
	if (model.compat.bedrockMessagesApi === true && (isBedrockAnthropicRoute(route) || route === ownRoute)) {
		return true;
	}
	if (optedIn && route === ownRoute) return true;
	return (
		isSupportedCompactionEndpoint(route) &&
		(model.compat.firstPartyProvider === true || model.provider === "google-vertex" || optedIn)
	);
}

/** Read a caller-owned client's endpoint for request and compaction routing. */
export function injectedClientBaseUrl(client: AnthropicMessagesClientLike): string | undefined {
	const candidate = "baseURL" in client ? client.baseURL : undefined;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Whether a caller-owned Anthropic client targets a compaction-capable endpoint. */
export function supportsAnthropicCompactionOnClient(
	model: Model<"anthropic-messages">,
	client: AnthropicMessagesClientLike,
): boolean {
	const baseUrl = injectedClientBaseUrl(client);
	if (baseUrl !== undefined) return supportsAnthropicCompaction(model, baseUrl);
	return isCompactionCapableModel(model) && model.remoteCompaction?.enabled === true;
}
