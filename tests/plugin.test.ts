/**
 * Tests run against the plugin object directly — no CMS, no network. The
 * context double covers kv, the `runs` storage, `github`, `site` and `http`.
 */

import { describe, expect, it } from "vitest";

import { canonicalCallback, hmacHex } from "../src/agent.js";
import plugin from "../src/plugin.js";
import { parseUsers } from "../src/settings.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const route = (name: string) => (plugin.routes![name] as { handler: Handler }).handler;

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
		site: { name: "Site", url: "https://site.example", locale: "en" },
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return opts.fetch ? opts.fetch(url, init) : new Response("{}", { status: 200 });
			},
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	};
	return { ctx, store, calls };
}

const conn = { token: "gho_x", owner: "acme", repo: "site", branch: "main" };

function issue(n: number, author: string, labels: string[] = ["agent"]) {
	return {
		number: n,
		title: `Issue ${n}`,
		body: "",
		user: { login: author },
		labels,
		html_url: `https://github.com/acme/site/issues/${n}`,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
	};
}

const settings = { allowedUsers: "alice", agentKey: "k", label: "agent", enabled: true };

describe("settings", () => {
	it("parses whitelists loosely", () => {
		expect(parseUsers("@Octocat, other-user\n third")).toEqual(["octocat", "other-user", "third"]);
	});
});

describe("webhook", () => {
	it("re-reads the issue and dispatches it for a whitelisted author", async () => {
		const { ctx, store, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => {
				if (url.endsWith("/issues/1")) return Response.json(issue(1, "alice"));
				if (url.endsWith("/run")) return Response.json({ submissionId: "sub-1", accepted: true });
				return Response.json({});
			},
		});
		const r = (await route("webhook")(
			{ input: { action: "labeled", label: { name: "agent" }, issue: { number: 1 } } },
			ctx,
		)) as { run: { status: string } };
		expect(r.run.status).toBe("queued");
		expect(store.get("1")?.submissionId).toBe("sub-1");
		const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/run"))?.init?.body));
		expect(body).toMatchObject({
			owner: "acme",
			repo: "site",
			issue: 1,
			token: "gho_x",
			attempt: 1,
			callbackUrl: "https://site.example/_emdash/api/plugins/premium-github-agent/agent-callback",
		});
	});

	it("skips authors outside the whitelist and never calls the agent", async () => {
		const { ctx, store, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => (url.endsWith("/issues/2") ? Response.json(issue(2, "mallory")) : Response.json({})),
		});
		await route("webhook")({ input: { action: "opened", issue: { number: 2 } } }, ctx);
		expect(store.get("2")?.status).toBe("skipped");
		expect(calls.some((c) => c.url.endsWith("/run"))).toBe(false);
	});

	it("ignores events without the trigger label, and other actions", async () => {
		const { ctx, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => (url.endsWith("/issues/3") ? Response.json(issue(3, "alice", ["bug"])) : Response.json({})),
		});
		const a = (await route("webhook")({ input: { action: "opened", issue: { number: 3 } } }, ctx)) as { ignored: string };
		expect(a.ignored).toMatch(/label/);
		const b = (await route("webhook")({ input: { action: "closed", issue: { number: 3 } } }, ctx)) as { ignored: string };
		expect(b.ignored).toMatch(/closed/);
		expect(calls.some((c) => c.url.endsWith("/run"))).toBe(false);
	});

	it("never re-dispatches an issue that is already running", async () => {
		let runs = 0;
		const { ctx } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => {
				if (url.endsWith("/issues/7")) return Response.json(issue(7, "alice"));
				if (url.endsWith("/run")) {
					runs++;
					return Response.json({ submissionId: "s", accepted: true });
				}
				return Response.json({});
			},
		});
		const ev = { input: { action: "labeled", label: { name: "agent" }, issue: { number: 7 } } };
		await route("webhook")(ev, ctx);
		await route("webhook")(ev, ctx);
		expect(runs).toBe(1);
	});
});

describe("agent-callback", () => {
	async function signed(cb: Record<string, unknown>, key = "k") {
		const sig = await hmacHex(key, canonicalCallback(cb as never));
		return { input: cb, request: { headers: { "x-agent-signature": `sha256=${sig}` } } };
	}

	it("records the PR from a correctly signed callback", async () => {
		const { ctx, store } = ctxWith({ github: conn, settings });
		store.set("3", { number: 3, title: "t", author: "alice", status: "queued", submissionId: "s3", updatedAt: "" });
		const cb = { issue: 3, attempt: 1, submissionId: "s3", status: "completed", answer: "Opened https://github.com/acme/site/pull/12", prUrl: "https://github.com/acme/site/pull/12" };
		const r = (await route("agent-callback")(await signed(cb), ctx)) as { success: boolean };
		expect(r.success).toBe(true);
		expect(store.get("3")).toMatchObject({ status: "completed", prUrl: "https://github.com/acme/site/pull/12" });
	});

	it("rejects a callback signed with the wrong key", async () => {
		const { ctx, store } = ctxWith({ github: conn, settings });
		store.set("4", { number: 4, title: "t", author: "alice", status: "queued", submissionId: "s4", updatedAt: "" });
		const cb = { issue: 4, attempt: 1, submissionId: "s4", status: "completed", answer: null, prUrl: null };
		const r = (await route("agent-callback")(await signed(cb, "wrong"), ctx)) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(store.get("4")?.status).toBe("queued");
	});
});

describe("issues/run", () => {
	it("retries a finished run as a new attempt only with again=true", async () => {
		const attempts: number[] = [];
		const { ctx } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/issues/9")) return Response.json(issue(9, "alice"));
				if (url.endsWith("/run")) {
					attempts.push(JSON.parse(String(init?.body)).attempt);
					return Response.json({ submissionId: `s${attempts.length}`, accepted: true });
				}
				return Response.json({});
			},
		});
		await route("issues/run")({ input: { number: 9 } }, ctx);
		const cb = { issue: 9, attempt: 1, submissionId: "s1", status: "completed", answer: null, prUrl: null };
		const sig = await hmacHex("k", canonicalCallback(cb as never));
		await route("agent-callback")({ input: cb, request: { headers: { "x-agent-signature": `sha256=${sig}` } } }, ctx);
		await route("issues/run")({ input: { number: 9 } }, ctx);
		expect(attempts).toEqual([1]);
		await route("issues/run")({ input: { number: 9, again: true } }, ctx);
		expect(attempts).toEqual([1, 2]);
	});
});
