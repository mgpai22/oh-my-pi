import { describe, expect, it } from "bun:test";
import { fetchWithRetry } from "@oh-my-pi/pi-utils/fetch-retry";

describe("fetchWithRetry", () => {
	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});

	it("surfaces the !ok response before sleeping when onBeforeSleep returns 'surface'", async () => {
		let attempt = 0;
		const seen: Array<{ attempt: number; delayMs: number; status: number; retryAfterMs?: number }> = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "retry-after-ms": "5000" } });
		};

		const response = await fetchWithRetry("https://example.invalid/surface", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 5,
			onBeforeSleep: info => {
				seen.push(info);
				return "surface";
			},
		});

		// One attempt, then surfaced instead of slept — the caller gets the 429 back.
		expect(response.status).toBe(429);
		expect(attempt).toBe(1);
		expect(seen).toEqual([{ attempt: 0, delayMs: 5000, status: 429, retryAfterMs: 5000 }]);
	});

	it("preserves normal retry/backoff when onBeforeSleep returns 'sleep'", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return attempt < 2 ? new Response("", { status: 429 }) : new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/sleep", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			onBeforeSleep: () => "sleep",
		});

		expect(response.status).toBe(200);
		expect(attempt).toBe(2);
	});

	it("is byte-identical to baseline when onBeforeSleep is absent", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return attempt < 3 ? new Response("", { status: 429 }) : new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/absent", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 5,
		});

		expect(response.status).toBe(200);
		expect(attempt).toBe(3);
	});
});
