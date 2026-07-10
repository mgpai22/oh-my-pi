import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const SESSION = "sess-rotate";

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function rateLimitError(retryAfterMs?: number): Error & { status: number } {
	const hint = retryAfterMs === undefined ? "" : `; retry-after-ms: ${retryAfterMs}`;
	return Object.assign(new Error(`429 too many requests, per minute${hint}`), { status: 429 });
}

describe("AuthStorage rotate-on-rate-limit branch (A4)", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-rotate-rl-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function storageWith(count: number): Promise<{ storage: AuthStorage; ids: number[] }> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		for (let i = 0; i < count; i++) store.saveOAuth(PROVIDER, oauthCredential(String(i)));
		const storage = new AuthStorage(store);
		await storage.reload();
		const ids = store.listAuthCredentials(PROVIDER).map(row => row.id);
		return { storage, ids };
	}

	it("short-blocks the hot credential (unscoped, sized to retry-after-ms) and re-ranks onto a sibling", async () => {
		const { storage, ids } = await storageWith(2);
		try {
			const before = await storage.getApiKey(PROVIDER, SESSION);
			const now = Date.now();
			const switched = await storage.rotateSessionCredential(PROVIDER, SESSION, { error: rateLimitError(37_000) });
			expect(switched).toBe(true);

			// Exactly one credential is now blocked, unscoped, ~37s out.
			const blocks = storage.listCredentialBlocks(ids).filter(b => b.blockedUntilMs > now);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.blockScope).toBe("");
			expect(blocks[0]!.blockedUntilMs - now).toBeGreaterThanOrEqual(36_000);
			expect(blocks[0]!.blockedUntilMs - now).toBeLessThanOrEqual(38_000);

			// Serial-agent equivalence: the next resolve re-ranks onto the sibling.
			const after = await storage.getApiKey(PROVIDER, SESSION);
			expect(after).not.toBe(before);
		} finally {
			storage.close();
		}
	});

	it("does not block or rotate when there is no usable sibling (G3)", async () => {
		const { storage, ids } = await storageWith(1);
		try {
			await storage.getApiKey(PROVIDER, SESSION);
			const switched = await storage.rotateSessionCredential(PROVIDER, SESSION, { error: rateLimitError(37_000) });
			expect(switched).toBe(false);
			expect(storage.listCredentialBlocks(ids).filter(b => b.blockedUntilMs > Date.now())).toEqual([]);
		} finally {
			storage.close();
		}
	});

	it("clamps the block to [5s, 120s]", async () => {
		for (const [retryAfterMs, expectedMs] of [
			[4_000, 5_000],
			[600_000, 120_000],
		] as const) {
			const { storage, ids } = await storageWith(2);
			try {
				await storage.getApiKey(PROVIDER, SESSION);
				const now = Date.now();
				await storage.rotateSessionCredential(PROVIDER, SESSION, { error: rateLimitError(retryAfterMs) });
				const block = storage.listCredentialBlocks(ids).find(b => b.blockedUntilMs > now);
				expect(block).toBeDefined();
				expect(block!.blockedUntilMs - now).toBeGreaterThanOrEqual(expectedMs - 1_000);
				expect(block!.blockedUntilMs - now).toBeLessThanOrEqual(expectedMs + 1_000);
			} finally {
				storage.close();
			}
			// Fresh db for the next clamp case.
			await removeWithRetries(dbPath).catch(() => {});
		}
	});

	it("hasUsableSibling reflects sibling availability for the session", async () => {
		const two = await storageWith(2);
		try {
			await two.storage.getApiKey(PROVIDER, SESSION);
			expect(two.storage.hasUsableSibling(PROVIDER, SESSION)).toBe(true);
		} finally {
			two.storage.close();
		}
		await removeWithRetries(dbPath).catch(() => {});

		const one = await storageWith(1);
		try {
			await one.storage.getApiKey(PROVIDER, SESSION);
			expect(one.storage.hasUsableSibling(PROVIDER, SESSION)).toBe(false);
		} finally {
			one.storage.close();
		}
	});
});
