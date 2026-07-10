import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { RateLimitRotationOptions, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

const rotation = (): RateLimitRotationOptions => ({ enabled: true, minSleepMs: 2_000, hasUsableSibling: () => true });

describe("Agent rateLimitRotation passthrough", () => {
	it("forwards AgentOptions.rateLimitRotation into the per-turn streamFn options", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		let captured: SimpleStreamOptions | undefined;
		const rot = rotation();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			rateLimitRotation: rot,
			streamFn: (model, context, options) => {
				captured = options;
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("hi");

		expect(captured?.rateLimitRotation).toBe(rot);
	});

	it("leaves streamFn options.rateLimitRotation undefined when not configured (G3 baseline)", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		let captured: SimpleStreamOptions | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				captured = options;
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("hi");

		expect(captured).toBeDefined();
		expect(captured?.rateLimitRotation).toBeUndefined();
	});
});
