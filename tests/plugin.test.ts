/**
 * Tests run against the plugin object directly — no CMS, no network. The
 * context double covers kv, the `runs` storage, `github` and `http`.
 */

import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";
import { cronFor, parseUsers } from "../src/settings.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function ctxWith(opts: {
	settings?: Record<string, unknown>;
	github?: { token: string; owner: string; repo: string; branch: string } | null;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
	const kv = new Map<string, unknown>(
		Object.entries(opts.settings ?? {}).map(([k, v]) => [`settings:${k}`, v]),
	);
	const store = new Map<string, Record<string, unknown>>();
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const ctx = {
		kv: {
			get: async (k: string) => kv.get(k) ?? null,
			set: async (k: string, v: unknown) => void kv.set(k, v),
			list: async (prefix: string) =>
				[...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
		},
		storage: {
			runs: {
				get: async (id: string) => store.get(id) ?? null,
				put: async (id: string, data: Record<string, unknown>) => void store.set(id, data),
				query: async () => ({ items: [...store.entries()].map(([id, data]) => ({ id, data })), hasMore: false }),
			},
		},
		github: opts.github === undefined ? undefined : { get: async () => opts.github },
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return opts.fetch ? opts.fetch(url, init) : new Response("{}", { status: 200 });
			},
		},
		cron: { schedule: async () => undefined, cancel: async () => undefined, list: async () => [] },
		log: { debug() {}, info() {}, warn() {}, error() {} },
	};
	return { ctx, store, calls };
}

const conn = { token: "gho_x", owner: "acme", repo: "site", branch: "main" };

function issue(n: number, author: string, labels: string[] = ["agent"]) {
	return { number: n, title: `Issue ${n}`, body: "", user: { login: author }, labels, html_url: `https://github.com/acme/site/issues/${n}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}

describe("settings", () => {
	it("parses whitelists loosely", () => {
		expect(parseUsers("@Octocat, other-user\n third")).toEqual(["octocat", "other-user", "third"]);
	});
	it("maps poll minutes to cron", () => {
		expect(cronFor(5)).toBe("*/5 * * * *");
		expect(cronFor(60)).toBe("0 * * * *");
	});
});

describe("poll", () => {
	const route = (plugin.routes!.poll as { handler: Handler }).handler;

	it("refuses to run without a GitHub connection", async () => {
		const { ctx } = ctxWith({ github: null });
		const r = (await route({ input: {} }, ctx)) as { success: boolean; error?: string };
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/Connect GitHub/);
	});

	it("dispatches labelled issues from whitelisted users only", async () => {
		const { ctx, store, calls } = ctxWith({
			github: conn,
			settings: { allowedUsers: "alice", agentKey: "k", label: "agent" },
			fetch: async (url) => {
				if (url.includes("/issues?")) return Response.json([issue(1, "alice"), issue(2, "mallory")]);
				if (url.endsWith("/run")) return Response.json({ submissionId: "sub-1", accepted: true });
				return Response.json({});
			},
		});
		const r = (await route({ input: {} }, ctx)) as { dispatched: number };
		expect(r.dispatched).toBe(1);
		expect(store.get("1")?.status).toBe("queued");
		expect(store.get("2")?.status).toBe("skipped");
		const run = calls.find((c) => c.url.endsWith("/run"));
		const body = JSON.parse(String(run?.init?.body));
		expect(body).toMatchObject({ owner: "acme", repo: "site", issue: 1, token: "gho_x" });
	});

	it("never re-dispatches an issue it already handled", async () => {
		let runs = 0;
		const { ctx } = ctxWith({
			github: conn,
			settings: { allowedUsers: "alice", agentKey: "k" },
			fetch: async (url) => {
				if (url.includes("/issues?")) return Response.json([issue(7, "alice")]);
				if (url.endsWith("/run")) {
					runs++;
					return Response.json({ submissionId: "s", accepted: true });
				}
				if (url.includes("/status?")) return Response.json({ status: "running", answer: null });
				return Response.json({});
			},
		});
		await route({ input: {} }, ctx);
		await route({ input: {} }, ctx);
		expect(runs).toBe(1);
	});

	it("records the PR when the agent finishes", async () => {
		const { ctx, store } = ctxWith({
			github: conn,
			settings: { allowedUsers: "alice", agentKey: "k" },
			fetch: async (url) => {
				if (url.includes("/issues?")) return Response.json([issue(3, "alice")]);
				if (url.endsWith("/run")) return Response.json({ submissionId: "s3", accepted: true });
				if (url.includes("/status?"))
					return Response.json({ status: "completed", answer: "Opened https://github.com/acme/site/pull/12" });
				return Response.json({});
			},
		});
		await route({ input: {} }, ctx);
		await route({ input: {} }, ctx);
		expect(store.get("3")).toMatchObject({ status: "completed", prUrl: "https://github.com/acme/site/pull/12" });
	});
});

describe("issues/run", () => {
	const route = (plugin.routes!["issues/run"] as { handler: Handler }).handler;

	it("skips a manual run for a non-whitelisted author", async () => {
		const { ctx, calls } = ctxWith({
			github: conn,
			settings: { allowedUsers: "alice", agentKey: "k" },
			fetch: async (url) => {
				if (url.endsWith("/issues/9")) return Response.json(issue(9, "bob", []));
				return Response.json({});
			},
		});
		const r = (await route({ input: { number: 9 } }, ctx)) as { success: boolean; run: { status: string } };
		expect(r.success).toBe(false);
		expect(r.run.status).toBe("skipped");
		expect(calls.some((c) => c.url.endsWith("/run"))).toBe(false);
	});
});
