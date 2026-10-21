/**
 * Habit tracker sync API — one JSON document per workspace, stored in D1.
 *
 *   GET  /health      -> { ok: true }                       (no auth)
 *   GET  /api/state   -> { ok, payload, updated_at }
 *   PUT  /api/state   <- { payload }  -> { ok, updated_at }
 *
 * Auth: `Authorization: Bearer <SYNC_KEY>` (a Worker secret). The key is a shared
 * passphrase typed once per device, not an account system.
 */
import { env } from "cloudflare:workers";

const WORKSPACE = "default";
const MAX_PAYLOAD_BYTES = 1_000_000;

const ALLOWED_ORIGINS = [
	"https://abhinavmanocha.github.io",
	"http://127.0.0.1:8014",
	"http://localhost:8014",
];

function corsHeaders(request: Request): Record<string, string> {
	const origin = request.headers.get("Origin") || "";
	const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
	return {
		"Access-Control-Allow-Origin": allow,
		"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...cors,
		},
	});
}

/** Length-independent comparison so the passphrase can't be probed by timing. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function authorized(request: Request): boolean {
	const expected = (env as unknown as { SYNC_KEY?: string }).SYNC_KEY;
	if (!expected) return false;
	const header = request.headers.get("Authorization") || "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	return token.length > 0 && safeEqual(token, expected);
}

async function ensureSchema(db: D1Database): Promise<void> {
	await db
		.prepare(
			"CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)",
		)
		.run();
}

export default {
	async fetch(request: Request): Promise<Response> {
		const cors = corsHeaders(request);
		const url = new URL(request.url);

		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
		if (url.pathname === "/health") return json({ ok: true }, 200, cors);
		if (url.pathname !== "/api/state") return json({ error: "not found" }, 404, cors);
		if (!authorized(request)) return json({ error: "unauthorized" }, 401, cors);

		const db = (env as unknown as { DB: D1Database }).DB;
		await ensureSchema(db);

		if (request.method === "GET") {
			const row = await db
				.prepare("SELECT payload, updated_at FROM state WHERE id = ?1")
				.bind(WORKSPACE)
				.first<{ payload: string; updated_at: number }>();
			if (!row) return json({ ok: true, payload: null, updated_at: 0 }, 200, cors);
			return json(
				{ ok: true, payload: JSON.parse(row.payload), updated_at: row.updated_at },
				200,
				cors,
			);
		}

		if (request.method === "PUT") {
			let body: { payload?: unknown };
			try {
				body = (await request.json()) as { payload?: unknown };
			} catch {
				return json({ error: "invalid json" }, 400, cors);
			}
			const payload = body?.payload;
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				return json({ error: "payload object required" }, 400, cors);
			}
			const text = JSON.stringify(payload);
			if (text.length > MAX_PAYLOAD_BYTES) return json({ error: "payload too large" }, 413, cors);

			const now = Date.now();
			await db
				.prepare(
					"INSERT INTO state (id, payload, updated_at) VALUES (?1, ?2, ?3) " +
						"ON CONFLICT(id) DO UPDATE SET payload = ?2, updated_at = ?3",
				)
				.bind(WORKSPACE, text, now)
				.run();
			return json({ ok: true, updated_at: now }, 200, cors);
		}

		return json({ error: "method not allowed" }, 405, cors);
	},
};
