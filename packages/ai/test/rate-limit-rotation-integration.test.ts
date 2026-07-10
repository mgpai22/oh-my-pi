import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	RateLimitRotationInfo,
	RateLimitRotationOptions,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const SOURCE_ID = "rate-limit-rotation-test";
const API = "rate-limit-rotation-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function rateLimitErrorMessage(): AssistantMessage {
	return {
		...assistant(),
		stopReason: "error",
		errorMessage: "429 too many requests; retry-after-ms: 5000",
		errorStatus: 429,
	};
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: API,
		provider: "test-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function ok(stream: AssistantMessageEventStream): void {
	const message = assistant(["ok"]);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

function rotation(over: Partial<RateLimitRotationOptions> = {}): RateLimitRotationOptions {
	return { enabled: true, minSleepMs: 2_000, hasUsableSibling: () => true, ...over };
}

describe("streamSimple rotate-on-rate-limit", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("rotates to a sibling on a transient 429 error event when enabled", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({ type: "error", reason: "error", error: rateLimitErrorMessage() });
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const rotations: RateLimitRotationInfo[] = [];
		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "credA" : "credB"),
			rateLimitRotation: rotation({ onRotate: info => rotations.push(info) }),
		});
		for await (const _event of stream) {
			// drain
		}

		// Rotated to credB and completed there — no user-visible retry noise.
		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["credA", "credB"]);
		expect(rotations).toEqual([{ provider: "test-provider", reason: "rate_limit", retryAfterMs: 5000, attempt: 0 }]);
	});

	it("does NOT rotate when the flag is off (baseline: surfaces the terminal 429)", async () => {
		const keys: unknown[] = [];
		const eventTypes: string[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "error", reason: "error", error: rateLimitErrorMessage() });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const rotations: RateLimitRotationInfo[] = [];
		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "credA" : "credB"),
			rateLimitRotation: rotation({ enabled: false, onRotate: info => rotations.push(info) }),
		});
		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		// One attempt, terminal error surfaced, no rotation.
		expect(keys).toEqual(["credA"]);
		expect(rotations).toEqual([]);
		expect(eventTypes).toContain("error");
	});

	it("does NOT rotate once a replay-unsafe event has shipped (pre-first-token invariant)", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: assistant(["partial"]) });
					stream.push({ type: "error", reason: "error", error: rateLimitErrorMessage() });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const rotations: RateLimitRotationInfo[] = [];
		const eventTypes: string[] = [];
		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "credA" : "credB"),
			rateLimitRotation: rotation({ onRotate: info => rotations.push(info) }),
		});
		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		// The streamed text committed the attempt: no rotation (single attempt), no
		// duplicated output — the delta shipped exactly once before the terminal error.
		expect(keys).toEqual(["credA"]);
		expect(rotations).toEqual([]);
		expect(eventTypes.filter(type => type === "text_delta")).toHaveLength(1);
		expect(eventTypes.at(-1)).toBe("error");
	});
});
