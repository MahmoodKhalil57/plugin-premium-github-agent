/**
 * Tests run against the plugin object directly — no CMS, no network. The
 * context double covers kv, the `runs`/`builds` storage, `github`, `site`
 * and `http`. The protocol under test: /agent-issue, /awaiting-test, the
 * runner's /…-succeeded, /…-failed, /preview-ready, /merged comments.
 */

import { describe, expect, it } from "vitest";

import { canonicalCallback, canonicalCi, canonicalStage, hmacHex } from "../src/agent.js";
import plugin from "../src/plugin.js";
import { parseUsers } from "../src/settings.js";
import { decideMerge, issueRefs, prNumberFrom, stackOnArg } from "../src/stacks.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const route = (name: string) => (plugin.routes![name] as { handler: Handler }).handler;

function ctxWith(opts: {
	settings?: Record<string, unknown>;
	github?: { token: string; owner: string; repo: string; branch: string; previewSecret: string } | null;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
	const kv = new Map<string, unknown>(Object.entries(opts.settings ?? {}).map(([k, v]) => [`settings:${k}`, v]));
	const store = new Map<string, Record<string, unknown>>();
	const builds = new Map<string, Record<string, unknown>>();
	const stacks = new Map<string, Record<string, unknown>>();
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const crons: string[] = [];
	const ctx = {
		kv: {
			get: async (k: string) => kv.get(k) ?? null,
			set: async (k: string, v: unknown) => void kv.set(k, v),
			list: async (prefix: string) => [...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
		},
		storage: {
			runs: {
				get: async (id: string) => store.get(id) ?? null,
				put: async (id: string, data: Record<string, unknown>) => void store.set(id, data),
				query: async () => ({ items: [...store.entries()].map(([id, data]) => ({ id, data })), hasMore: false }),
			},
			builds: {
				get: async (id: string) => builds.get(id) ?? null,
				put: async (id: string, data: Record<string, unknown>) => void builds.set(id, data),
				query: async () => ({ items: [...builds.entries()].map(([id, data]) => ({ id, data })), hasMore: false }),
			},
			stacks: {
				get: async (id: string) => stacks.get(id) ?? null,
				put: async (id: string, data: Record<string, unknown>) => void stacks.set(id, data),
				query: async () => ({ items: [...stacks.entries()].map(([id, data]) => ({ id, data })), hasMore: false }),
			},
		},
		cron: { schedule: async (name: string) => void crons.push(name) },
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
	return { ctx, store, builds, stacks, calls, crons };
}

const conn = { token: "gho_x", owner: "acme", repo: "site", branch: "main", previewSecret: "prev" };
const settings = { allowedUsers: "alice", agentKey: "k", enabled: true };

function issue(n: number, author: string, body = "") {
	return { number: n, title: `Issue ${n}`, body, user: { login: author }, labels: [], html_url: `https://github.com/acme/site/issues/${n}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}
function pull(n: number, author: string, headRef: string, sha = "abc1234") {
	return { number: n, title: `PR ${n}`, user: { login: author }, head: { ref: headRef, sha }, base: { ref: "main" }, html_url: `https://github.com/acme/site/pull/${n}`, state: "open", draft: false };
}
/** An issue_comment webhook payload; `onPull` marks the issue as a pull request. */
function commentEvent(n: number, author: string, body: string, onPull = false) {
	return { input: { action: "created", issue: { number: n, ...(onPull ? { pull_request: { url: "x" } } : {}) }, comment: { body, user: { login: author } }, repository: { full_name: "acme/site" } } };
}
function ciResult(pr: number, attempt: number, ok: boolean) {
	const step = (k: boolean) => ({ ok: k, log: k ? "fine" : "boom", seconds: 1 });
	return { pr, branch: "agent/issue-1-x", attempt, headSha: "abc1234", staticBranch: "static/agent/issue-1-x", staticSha: ok ? "def5678" : null, check: step(true), build: step(ok), push: ok ? step(true) : null, test: ok ? step(true) : null, preview: ok ? step(true) : null, previewUrl: ok ? `https://preview-acme-site-pr${pr}.example.workers.dev` : null, previewTest: ok ? step(true) : null, previous: [], ok, ...(ok ? {} : { error: "build failed" }) };
}
async function signed(cb: Record<string, unknown>, canonical: (x: never) => string, key = "k") {
	const sig = await hmacHex(key, canonical(cb as never));
	return { input: cb, request: { headers: { "x-agent-signature": `sha256=${sig}` } } };
}
const commentsPosted = (calls: Array<{ url: string; init?: RequestInit }>, n: number) =>
	calls.filter((c) => c.url.endsWith(`/issues/${n}/comments`) && c.init?.method === "POST").map((c) => JSON.parse(String(c.init?.body)).body as string);

describe("settings", () => {
	it("parses whitelists loosely", () => {
		expect(parseUsers("@Octocat, other-user\n third")).toEqual(["octocat", "other-user", "third"]);
	});
});

describe("/agent-issue", () => {
	it("summons the agent from a whitelisted comment, re-reading the issue", async () => {
		const { ctx, store, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => {
				if (url.endsWith("/issues/1")) return Response.json(issue(1, "alice"));
				if (url.endsWith("/run")) return Response.json({ submissionId: "sub-1", accepted: true });
				return Response.json({});
			},
		});
		const r = (await route("webhook")(commentEvent(1, "alice", "please look at this\n/agent-issue"), ctx)) as { handled: Record<string, { status: string }> };
		expect(r.handled["agent-issue"].status).toBe("queued");
		expect(store.get("1")?.submissionId).toBe("sub-1");
		const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/run"))?.init?.body));
		expect(body).toMatchObject({ owner: "acme", repo: "site", issue: 1, token: "gho_x", attempt: 1, callbackUrl: "https://site.example/_emdash/api/plugins/premium-github-agent/agent-callback" });
	});

	it("also works from the body of a newly opened issue", async () => {
		const { ctx, store } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => {
				if (url.endsWith("/issues/2")) return Response.json(issue(2, "alice", "fix it\n/agent-issue"));
				if (url.endsWith("/run")) return Response.json({ submissionId: "s2", accepted: true });
				return Response.json({});
			},
		});
		await route("webhook")({ input: { action: "opened", issue: { ...issue(2, "alice", "fix it\n/agent-issue") }, repository: { full_name: "acme/site" } } }, ctx);
		expect(store.get("2")?.status).toBe("queued");
	});

	it("ignores commands from non-whitelisted users, plain comments, and edits", async () => {
		const { ctx, calls } = ctxWith({ github: conn, settings });
		const a = (await route("webhook")(commentEvent(3, "mallory", "/agent-issue"), ctx)) as { ignored: string };
		expect(a.ignored).toMatch(/whitelisted/);
		const b = (await route("webhook")(commentEvent(3, "alice", "thanks!"), ctx)) as { ignored: string };
		expect(b.ignored).toBe("no command");
		const c = (await route("webhook")({ input: { action: "edited", issue: { number: 3 }, comment: { body: "/agent-issue", user: { login: "alice" } } } }, ctx)) as { ignored: string };
		expect(c.ignored).toBe("no command");
		expect(calls.some((c) => c.url.endsWith("/run"))).toBe(false);
	});

	it("a second /agent-issue on a finished issue is a new attempt", async () => {
		const attempts: number[] = [];
		const { ctx } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/issues/4")) return Response.json(issue(4, "alice"));
				if (url.endsWith("/run")) {
					attempts.push(JSON.parse(String(init?.body)).attempt);
					return Response.json({ submissionId: `s${attempts.length}`, accepted: true });
				}
				return Response.json({});
			},
		});
		await route("webhook")(commentEvent(4, "alice", "/agent-issue"), ctx);
		await route("webhook")(commentEvent(4, "alice", "/agent-issue"), ctx); // still queued → ignored
		const cb = { issue: 4, attempt: 1, submissionId: "s1", status: "completed", answer: null, prUrl: null };
		await route("agent-callback")(await signed(cb, canonicalCallback), ctx);
		await route("webhook")(commentEvent(4, "alice", "/agent-issue"), ctx);
		expect(attempts).toEqual([1, 2]);
	});
});

describe("/awaiting-test and the runner's reports", () => {
	const passing = (n: number) => async (url: string, init?: RequestInit) => {
		if (url.endsWith(`/pulls/${n}`)) return Response.json(pull(n, "alice", "agent/issue-1-x"));
		if (url.endsWith(`/pulls/${n}/merge`)) return Response.json({ merged: true, sha: "merged1" });
		if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
		return Response.json({});
	};

	it("runs CI on /awaiting-test, comments each stage, then /merged", async () => {
		const { ctx, builds, calls } = ctxWith({ github: conn, settings, fetch: passing(10) });
		const r = (await route("webhook")(commentEvent(10, "alice", "Changed the footer.\n/awaiting-test", true), ctx)) as { handled: Record<string, { started: boolean }> };
		expect(r.handled["awaiting-test"].started).toBe(true);
		const ci = JSON.parse(String(calls.find((c) => c.url.endsWith("/ci"))?.init?.body));
		expect(ci).toMatchObject({ pr: 10, headRef: "agent/issue-1-x", staticBranch: "static/agent/issue-1-x", attempt: 1 });

		const stage = (stage: string, ok: boolean, previewUrl: string | null = null) =>
			signed({ pr: 10, branch: "agent/issue-1-x", attempt: 1, headSha: "abc1234", stage, ok, log: ok ? "" : "boom", seconds: 2, previewUrl }, canonicalStage);
		await route("ci-stage")(await stage("check", true), ctx);
		await route("ci-stage")(await stage("test", true), ctx);
		await route("ci-stage")(await stage("preview", true, "https://preview-acme-site-pr10.example.workers.dev"), ctx);
		await route("ci-stage")(await stage("previewTest", true, "https://preview-acme-site-pr10.example.workers.dev"), ctx);
		await route("ci-callback")(await signed(ciResult(10, 1, true), canonicalCi), ctx);

		const posted = commentsPosted(calls, 10);
		expect(posted.map((b) => b.split("\n")[0])).toEqual([
			"/check-succeeded",
			"/test-succeeded",
			"/preview-ready https://preview-acme-site-pr10.example.workers.dev",
			"/preview-test-succeeded",
			"/merged",
		]);
		expect(builds.get("10")).toMatchObject({ status: "merged", previewUrl: "https://preview-acme-site-pr10.example.workers.dev" });
	});

	it("does not run CI on plain pull_request events any more", async () => {
		const { ctx, calls } = ctxWith({ github: conn, settings, fetch: passing(11) });
		const r = (await route("webhook")({ input: { action: "opened", pull_request: pull(11, "alice", "feature"), repository: { full_name: "acme/site" } } }, ctx)) as { ignored: string };
		expect(r.ignored).toBe("pull_request opened");
		expect(calls.some((c) => c.url.endsWith("/ci"))).toBe(false);
	});

	it("a /…-failed report on an agent PR sends the agent back with the output, until the cap", async () => {
		const runs: string[] = [];
		const { ctx, builds } = ctxWith({
			github: conn,
			settings: { ...settings, maxBuildAttempts: 2 },
			fetch: async (url, init) => {
				if (url.endsWith("/pulls/12")) return Response.json(pull(12, "alice", "agent/issue-1-x"));
				if (url.endsWith("/issues/1")) return Response.json(issue(1, "alice"));
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.endsWith("/run")) {
					runs.push(JSON.parse(String(init?.body)).note ?? "");
					return Response.json({ submissionId: `s${runs.length}`, accepted: true });
				}
				return Response.json({});
			},
		});
		await route("webhook")(commentEvent(12, "alice", "/awaiting-test", true), ctx);
		await route("ci-callback")(await signed(ciResult(12, 1, false), canonicalCi), ctx);
		expect(builds.get("12")?.status).toBe("failed");
		// The runner's failure comment comes back through the webhook and summons the agent.
		const r = (await route("webhook")(commentEvent(12, "alice", "/test-failed\ntest:cf failed\n```\nexpected 1 got 2\n```", true), ctx)) as { handled: Record<string, { started: boolean }> };
		expect(r.handled["test-failed"].started).toBe(true);
		expect(runs[0]).toMatch(/\/test-failed/);
		expect(runs[0]).toMatch(/expected 1 got 2/);
		expect(runs[0]).toMatch(/\/awaiting-test/);
		// Second attempt fails too and hits the cap: no third agent run.
		await route("webhook")(commentEvent(12, "alice", "/awaiting-test", true), ctx);
		await route("ci-callback")(await signed(ciResult(12, 2, false), canonicalCi), ctx);
		expect(builds.get("12")?.status).toBe("capped");
		const again = (await route("webhook")(commentEvent(12, "alice", "/test-failed", true), ctx)) as { handled: Record<string, { started: boolean; reason: string }> };
		expect(again.handled["test-failed"].started).toBe(false);
		expect(again.handled["test-failed"].reason).toMatch(/attempts/);
		expect(runs.length).toBe(1);
	});

	it("a failure report on a human PR does nothing, and success reports are inert", async () => {
		const { ctx, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => (url.endsWith("/pulls/13") ? Response.json(pull(13, "alice", "feature")) : Response.json({})),
		});
		const r = (await route("webhook")(commentEvent(13, "alice", "/check-failed", true), ctx)) as { handled: Record<string, { started: boolean; reason: string }> };
		expect(r.handled["check-failed"].started).toBe(false);
		const ok = (await route("webhook")(commentEvent(13, "alice", "/check-succeeded", true), ctx)) as { handled: Record<string, unknown> };
		expect(Object.keys(ok.handled)).toEqual([]);
		expect(calls.some((c) => c.url.endsWith("/run") || c.url.endsWith("/ci"))).toBe(false);
	});

	it("reports a platform error that stopped the run before any stage, without summoning the agent", async () => {
		const { ctx, builds, calls } = ctxWith({ github: conn, settings, fetch: passing(15) });
		await route("webhook")(commentEvent(15, "alice", "/awaiting-test", true), ctx);
		const dead = { ...ciResult(15, 1, false), check: null, build: null, error: "ContainerUnavailableError: Maximum number of running container instances exceeded" };
		await route("ci-callback")(await signed(dead, canonicalCi), ctx);
		expect(builds.get("15")?.status).toBe("error");
		const posted = commentsPosted(calls, 15);
		expect(posted.length).toBe(1);
		expect(posted[0]).toMatch(/Platform error/);
		expect(posted[0]).not.toMatch(/(^|\s)\/awaiting-test/);
	});

	it("rejects stage and result callbacks with a bad signature", async () => {
		const { ctx, calls } = ctxWith({ github: conn, settings });
		const a = (await route("ci-stage")(await signed({ pr: 1, branch: "b", attempt: 1, headSha: "s", stage: "check", ok: true, log: "", seconds: 1, previewUrl: null }, canonicalStage, "wrong"), ctx)) as { success: boolean };
		const b = (await route("ci-callback")(await signed(ciResult(1, 1, true), canonicalCi, "wrong"), ctx)) as { success: boolean };
		expect(a.success).toBe(false);
		expect(b.success).toBe(false);
		expect(commentsPosted(calls, 1)).toEqual([]);
	});

	it("removes the preview when the PR closes", async () => {
		const { ctx, builds, calls } = ctxWith({
			github: conn,
			settings: { ...settings, autoMerge: false },
			fetch: async (url, init) => {
				if (url.endsWith("/pulls/14")) return Response.json(pull(14, "alice", "feature"));
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.includes("/preview?") && init?.method === "DELETE") return Response.json({ deleted: true });
				return Response.json({});
			},
		});
		await route("webhook")(commentEvent(14, "alice", "/awaiting-test", true), ctx);
		await route("ci-callback")(await signed(ciResult(14, 1, true), canonicalCi), ctx);
		expect(builds.get("14")?.status).toBe("passed");
		await route("webhook")({ input: { action: "closed", pull_request: pull(14, "alice", "feature"), repository: { full_name: "acme/site" } } }, ctx);
		expect(builds.get("14")).toMatchObject({ status: "closed" });
		expect(calls.some((c) => c.url.includes("/preview?") && c.init?.method === "DELETE")).toBe(true);
	});
});

describe("MCP tools for assistants", () => {
	it("declares create/list/status tools over author-level routes", () => {
		const tools = (plugin as { mcp?: { tools: Record<string, { route: string }> } }).mcp?.tools ?? {};
		expect(Object.keys(tools).sort()).toEqual(["create_issue", "create_stack", "issue_status", "list_issues"]);
		for (const t of Object.values(tools)) {
			expect((plugin.routes![t.route] as { permission?: string }).permission).toBe("content:edit_own");
		}
	});

	it("issues/status reports the agent run, the PR build and the site build", async () => {
		const { ctx, store, builds } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => (url.endsWith("/issues/5") ? Response.json(issue(5, "alice", "Fix footer")) : Response.json({})),
		});
		store.set("5", { number: 5, title: "Fix footer", author: "alice", status: "completed", prUrl: "https://github.com/acme/site/pull/9", attempt: 1, updatedAt: "2026-01-01T00:00:00Z" });
		builds.set("9", { pr: 9, title: "Fix footer", author: "alice", headRef: "agent/issue-5-x", headSha: "h", staticBranch: "static/agent/issue-5-x", attempt: 1, status: "merged", issue: 5, previewUrl: "https://preview-acme-site-pr9.example.workers.dev", summary: "merged into main", updatedAt: "2026-01-01T00:00:00Z" });
		builds.set("branch:main", { pr: 0, title: "main", author: "acme", headRef: "main", headSha: "m", staticBranch: "static/main", staticSha: "s", attempt: 3, status: "passed", summary: "published to static/main", updatedAt: "2026-01-01T00:00:00Z" });
		const r = (await route("issues/status")({ input: { number: 5 }, user: { id: "u", role: 30 } }, ctx)) as Record<string, unknown>;
		expect(r).toMatchObject({
			success: true,
			issue: { number: 5, title: "Issue 5" },
			agent: { status: "completed", prUrl: "https://github.com/acme/site/pull/9" },
			pullRequest: { number: 9, status: "merged", previewUrl: "https://preview-acme-site-pr9.example.workers.dev" },
			site: { status: "passed", staticBranch: "static/main" },
		});
	});
});

describe("default branch", () => {
	type Previous = Array<{ branch: string; sha: string; previewUrl: string | null }>;
	function branchResult(attempt: number, ok: boolean, previous: Previous = []) {
		const step = (k: boolean) => ({ ok: k, log: k ? "fine" : "boom", seconds: 1 });
		return { pr: 0, branch: "main", attempt, headSha: "mainsha", staticBranch: "static/main", staticSha: ok ? "stat123" : null, check: step(true), build: step(ok), push: ok ? step(true) : null, test: ok ? step(true) : null, preview: null, previewUrl: null, previewTest: null, previous, ok, ...(ok ? {} : { error: "build failed" }) };
	}
	const previous: Previous = [
		{ branch: "static/main-b-1", sha: "prev1sha", previewUrl: "https://preview-acme-site-main-b-1.example.workers.dev" },
		{ branch: "static/main-b-2", sha: "prev2sha", previewUrl: "https://preview-acme-site-main-b-2.example.workers.dev" },
	];

	it("builds main on push, then switches Pages to static/main when it passes", async () => {
		const pagesCalls: Array<{ method?: string; body: unknown }> = [];
		const { ctx, builds, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "mainsha" } });
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.endsWith("/pages")) {
					if ((init?.method ?? "GET") === "GET") return Response.json({ build_type: "workflow", source: { branch: "main", path: "/" }, html_url: "https://acme.github.io/site/" });
					pagesCalls.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
					return new Response(null, { status: 204 });
				}
				return Response.json({});
			},
		});
		const r = (await route("webhook")({ input: { ref: "refs/heads/main", after: "mainsha", repository: { full_name: "acme/site" } } }, ctx)) as { started: boolean };
		expect(r.started).toBe(true);
		const ci = JSON.parse(String(calls.find((c) => c.url.endsWith("/ci"))?.init?.body));
		expect(ci).toMatchObject({ pr: 0, headRef: "main", staticBranch: "static/main", preview: false, previous: 2 });
		await route("ci-callback")(await signed(branchResult(1, true), canonicalCi), ctx);
		expect(builds.get("branch:main")).toMatchObject({ status: "passed", staticSha: "stat123" });
		expect(pagesCalls).toEqual([{ method: "PUT", body: { build_type: "legacy", source: { branch: "static/main", path: "/" } } }]);
	});

	it("keeps the two previous deployments and their preview URLs on the site row, and shows them in the admin", async () => {
		const { ctx, builds } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "mainsha" } });
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.endsWith("/pages") && (init?.method ?? "GET") === "GET") return Response.json({ build_type: "legacy", source: { branch: "static/main", path: "/" }, html_url: "https://acme.github.io/site/" });
				return Response.json({});
			},
		});
		await route("site/build")({ input: {} }, ctx);
		await route("ci-callback")(await signed(branchResult(1, true, previous), canonicalCi), ctx);
		expect(builds.get("branch:main")).toMatchObject({ status: "passed", previous });

		// A later build that reports no slots keeps what it had.
		await route("site/build")({ input: {} }, ctx);
		await route("ci-callback")(await signed(branchResult(2, false), canonicalCi), ctx);
		expect(builds.get("branch:main")).toMatchObject({ status: "failed", previous });

		const page = (await route("admin")({ input: { type: "page_load", page: "/github-agent" } }, ctx)) as { blocks: Array<{ type: string; block_id?: string; columns?: Array<{ key: string; format?: string }>; rows?: Array<Record<string, string>> }> };
		const table = page.blocks.find((b) => b.type === "table" && b.block_id === "deployments");
		expect(table?.columns?.find((c) => c.key === "url")?.format).toBe("link");
		expect(table?.rows).toEqual([
			{ slot: "Live", branch: "static/main @ stat123", url: "https://site.example" },
			{ slot: "Live (GitHub Pages origin)", branch: "static/main", url: "https://acme.github.io/site/" },
			{ slot: "1 back", branch: "static/main-b-1 @ prev1sh", url: "https://preview-acme-site-main-b-1.example.workers.dev" },
			{ slot: "2 back", branch: "static/main-b-2 @ prev2sh", url: "https://preview-acme-site-main-b-2.example.workers.dev" },
		]);
	});

	it("the Deployments dashboard widget links live, the kept deployments and open PR previews", async () => {
		const { ctx, builds } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "mainsha" } });
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.endsWith("/pages") && (init?.method ?? "GET") === "GET") return Response.json({ build_type: "legacy", source: { branch: "static/main", path: "/" }, html_url: "https://acme.github.io/site/" });
				return Response.json({});
			},
		});
		await route("site/build")({ input: {} }, ctx);
		await route("ci-callback")(await signed(branchResult(1, true, previous), canonicalCi), ctx);
		builds.set("7", { pr: 7, title: "Bigger footer", author: "alice", headRef: "feat", headSha: "f", staticBranch: "static/feat", attempt: 1, status: "passed", previewUrl: "https://preview-acme-site-pr7.example.workers.dev", updatedAt: "2026-01-01T00:00:00Z" });
		builds.set("8", { pr: 8, title: "Closed one", author: "alice", headRef: "old", headSha: "o", staticBranch: "static/old", attempt: 1, status: "closed", updatedAt: "2026-01-01T00:00:00Z" });

		const widget = (await route("admin")({ input: { type: "page_load", page: "widget:deployments" } }, ctx)) as { blocks: Array<{ type: string; fields?: Array<{ label: string; value: string; url?: string }> }> };
		const fields = widget.blocks.find((b) => b.type === "fields")?.fields ?? [];
		expect(fields.map((f) => [f.label, f.url])).toEqual([
			["Live — static/main @ stat123", "https://site.example"],
			["1 back — static/main-b-1 @ prev1sh", "https://preview-acme-site-main-b-1.example.workers.dev"],
			["2 back — static/main-b-2 @ prev2sh", "https://preview-acme-site-main-b-2.example.workers.dev"],
			["PR #7 — Bigger footer", "https://preview-acme-site-pr7.example.workers.dev"],
			["GitHub Pages origin", "https://acme.github.io/site/"],
		]);
		expect(fields[0]?.value).toBe("site.example");
	});

	it("ignores pushes to other branches and to static/*", async () => {
		const { ctx, calls } = ctxWith({ github: conn, settings });
		for (const ref of ["refs/heads/static/main", "refs/heads/feature", "refs/tags/v1"]) {
			await route("webhook")({ input: { ref, after: "x", repository: { full_name: "acme/site" } } }, ctx);
		}
		expect(calls.some((c) => c.url.endsWith("/ci"))).toBe(false);
	});

	it("coalesces a publish during a running build into one rebuild", async () => {
		let ciCalls = 0;
		const { ctx } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "mainsha" } });
				if (url.endsWith("/ci")) {
					ciCalls++;
					return Response.json({ accepted: true }, { status: 202 });
				}
				if (url.endsWith("/pages") && (init?.method ?? "GET") === "GET") return Response.json({ build_type: "legacy", source: { branch: "static/main", path: "/" }, html_url: "https://acme.github.io/site/" });
				return Response.json({});
			},
		});
		const hook = plugin.hooks!["content:afterPublish"] as (event: unknown, ctx: unknown) => Promise<void>;
		await hook({}, ctx);
		await hook({}, ctx);
		await hook({}, ctx);
		expect(ciCalls).toBe(1);
		await route("ci-callback")(await signed(branchResult(1, true), canonicalCi), ctx);
		expect(ciCalls).toBe(2);
	});
});

// ── Stacked pull requests ────────────────────────────────────────────────

/**
 * A GitHub double with state: issues, pull requests, stacks, asynchronous
 * merges (merging PR N in a stack lands every unmerged PR below it), plus
 * the agent worker's /run and /ci. Everything the stack code touches.
 */
function fakeGitHub(init: { issues?: Record<number, ReturnType<typeof issue>>; pulls?: Record<number, ReturnType<typeof spull>>; subIssues?: Record<number, number[]> } = {}) {
	const state = {
		issues: { ...(init.issues ?? {}) } as Record<number, ReturnType<typeof issue>>,
		pulls: { ...(init.pulls ?? {}) } as Record<number, ReturnType<typeof spull>>,
		subIssues: init.subIssues ?? {},
		stacks: [] as Array<{ number: number; open: boolean; base: { ref: string }; pull_requests: Array<{ number: number; state: string; draft: boolean; merged_at: string | null; head: { ref: string; sha: string } }> }>,
		merges: [] as Array<{ pr: number; body: Record<string, unknown> }>,
		asyncMerge: false,
		runs: [] as Array<Record<string, unknown>>,
		ci: [] as Array<Record<string, unknown>>,
		closed: [] as number[],
		retargeted: [] as Array<{ pr: number; base: string }>,
	};
	const layer = (n: number) => ({ number: n, state: "open", draft: false, merged_at: null, head: state.pulls[n].head });
	const markMerged = (pr: number) => {
		const st = state.stacks.find((x) => x.pull_requests.some((p) => p.number === pr));
		const prs = st ? st.pull_requests.slice(0, st.pull_requests.findIndex((p) => p.number === pr) + 1).map((p) => p.number) : [pr];
		for (const n of prs) {
			state.pulls[n] = { ...state.pulls[n], state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z" };
			const entry = st?.pull_requests.find((p) => p.number === n);
			if (entry) Object.assign(entry, { state: "closed", merged_at: "2026-01-02T00:00:00Z" });
		}
	};
	const fetch = async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		let m: RegExpMatchArray | null;
		if ((m = path.match(/\/issues\/(\d+)\/sub_issues$/))) return Response.json((state.subIssues[+m[1]] ?? []).map((n) => state.issues[n]));
		if ((m = path.match(/\/issues\/(\d+)$/)) && method === "GET") return state.issues[+m[1]] ? Response.json(state.issues[+m[1]]) : Response.json({}, { status: 404 });
		if ((m = path.match(/\/issues\/(\d+)$/)) && method === "PATCH") {
			state.closed.push(+m[1]);
			return Response.json({});
		}
		if (path.endsWith("/issues") && method === "POST") {
			const n = Math.max(0, ...Object.keys(state.issues).map(Number)) + 1;
			state.issues[n] = { ...issue(n, "alice", String(body.body ?? "")), title: String(body.title ?? "") };
			return Response.json(state.issues[n], { status: 201 });
		}
		if ((m = path.match(/\/pulls\/(\d+)$/)) && method === "GET") return state.pulls[+m[1]] ? Response.json(state.pulls[+m[1]]) : Response.json({}, { status: 404 });
		if ((m = path.match(/\/pulls\/(\d+)$/)) && method === "PATCH") {
			state.retargeted.push({ pr: +m[1], base: String(body.base) });
			state.pulls[+m[1]].base.ref = String(body.base);
			return Response.json(state.pulls[+m[1]]);
		}
		if (path.endsWith("/stacks") && method === "POST") {
			const st = { number: 50 + state.stacks.length, open: true, base: { ref: "main" }, pull_requests: (body.pull_requests as number[]).map(layer) };
			state.stacks.push(st);
			return Response.json(st, { status: 201 });
		}
		if ((m = path.match(/\/stacks\/(\d+)\/add$/))) {
			const st = state.stacks.find((x) => x.number === +m![1])!;
			st.pull_requests.push(...(body.pull_requests as number[]).map(layer));
			return Response.json(st);
		}
		if ((m = path.match(/\/pulls\/(\d+)\/merge-async$/)) && method === "PUT") {
			state.merges.push({ pr: +m[1], body });
			if (state.asyncMerge) return Response.json({ status: "pending", uuid: `u${m[1]}` }, { status: 202 });
			markMerged(+m[1]);
			return Response.json({ status: "merged", details: { sha: "mmmmmmm" } });
		}
		if ((m = path.match(/\/pulls\/(\d+)\/merge-async\/(.+)$/))) {
			markMerged(+m[1]);
			return Response.json({ status: "merged", details: { sha: "mmmmmmm" } });
		}
		if (path.endsWith("/run")) {
			state.runs.push(body);
			return Response.json({ submissionId: `s${state.runs.length}`, accepted: true });
		}
		if (path.endsWith("/ci")) {
			state.ci.push(body);
			return Response.json({ accepted: true }, { status: 202 });
		}
		return Response.json({});
	};
	return { state, fetch, markMerged };
}

/** A pull request with a base branch and an update time (fresh = just opened). */
function spull(n: number, headRef: string, base = "main", opts: { sha?: string; fresh?: boolean } = {}) {
	return {
		...pull(n, "alice", headRef, opts.sha ?? "abc1234"),
		base: { ref: base },
		merged: false,
		merged_at: null as string | null,
		updated_at: opts.fresh ? new Date().toISOString() : "2026-01-01T00:00:00Z",
	};
}

async function callback(ctx: unknown, issueNo: number, submissionId: string, prUrl: string | null, answer = prUrl ?? "NO_PR: unclear") {
	return route("agent-callback")(await signed({ issue: issueNo, attempt: 1, submissionId, status: "completed", answer, prUrl }, canonicalCallback), ctx);
}

describe("stack helpers", () => {
	it("parses command arguments", () => {
		expect(stackOnArg("on #12")).toBe(12);
		expect(stackOnArg("on 7, please")).toBe(7);
		expect(stackOnArg("")).toBeNull();
		expect(stackOnArg("later")).toBeNull();
		expect(issueRefs("#12 #13, 14 and #12 again")).toEqual([12, 13, 14]);
		expect(issueRefs("see PR-12 or v1.2 but #5")).toEqual([5]);
		expect(prNumberFrom("https://github.com/acme/site/pull/42")).toBe(42);
		expect(prNumberFrom("https://github.com/acme/site/issues/42")).toBeNull();
	});

	it("merges the longest green run from the bottom, never under a layer in flight", () => {
		const now = Date.parse("2026-01-01T12:00:00Z");
		const L = (pr: number, build: string | null, opts: { sha?: string; state?: "open" | "merged" | "closed"; fresh?: boolean } = {}) => ({
			issue: pr, pr, state: opts.state ?? ("open" as const), headSha: "h", headRef: `b${pr}`,
			updatedAt: opts.fresh ? new Date(now - 1000).toISOString() : "2026-01-01T00:00:00Z",
			build: build ? { status: build, headSha: opts.sha ?? "h", updatedAt: new Date(now - 60_000).toISOString() } : null,
		});
		const o = { plannedPending: false, now, staleMs: 30 * 60_000, freshMs: 10 * 60_000 };
		expect(decideMerge([L(1, "passed"), L(2, "passed")], o)).toMatchObject({ kind: "merge", prs: [1, 2] });
		expect(decideMerge([L(1, "passed"), L(2, "running")], o)).toMatchObject({ kind: "hold" });
		expect(decideMerge([L(1, "passed"), L(2, null, { fresh: true })], o)).toMatchObject({ kind: "hold" });
		expect(decideMerge([L(1, "passed"), L(2, "failed")], o)).toMatchObject({ kind: "merge", prs: [1] });
		expect(decideMerge([L(1, "passed"), L(2, "failed"), L(3, "passed")], o)).toMatchObject({ kind: "merge", prs: [1] });
		expect(decideMerge([L(1, "passed", { sha: "old" })], o)).toMatchObject({ kind: "nothing" });
		expect(decideMerge([L(1, "passed")], { ...o, plannedPending: true })).toMatchObject({ kind: "hold" });
		expect(decideMerge([L(1, "merged", { state: "merged" }), L(2, "passed")], o)).toMatchObject({ kind: "merge", prs: [2] });
		expect(decideMerge([L(1, "passed", { state: "closed" }), L(2, "passed")], o)).toMatchObject({ kind: "hold" });
	});
});

describe("/agent-stack", () => {
	it("runs the layers in order, each from the branch below, links them as a GitHub stack, and merges bottom-up once every layer is green", async () => {
		const gh = fakeGitHub({ issues: { 1: issue(1, "alice"), 2: issue(2, "alice") } });
		const { ctx, store, builds, stacks, calls, crons } = ctxWith({ github: conn, settings, fetch: gh.fetch });

		const r = (await route("webhook")(commentEvent(1, "alice", "/agent-stack #1 #2"), ctx)) as { handled: Record<string, { started: boolean; issues: number[] }> };
		expect(r.handled["agent-stack"]).toMatchObject({ started: true, issues: [1, 2] });
		expect(gh.state.runs).toHaveLength(1);
		expect(gh.state.runs[0]).toMatchObject({ issue: 1, stack: { layer: 1, size: 2 } });
		expect(gh.state.runs[0].base).toBeUndefined();
		expect(store.get("1")).toMatchObject({ status: "queued", layer: 1 });
		expect(store.get("2")).toMatchObject({ status: "waiting", layer: 2 });
		expect(commentsPosted(calls, 2)[0]).toMatch(/layer 2 of 2/);
		expect(crons).toContain("stacks");
		const stack = [...stacks.values()][0] as { id: string; issues: number[] };
		expect(stack.issues).toEqual([1, 2]);

		// Layer 1 opens PR 10: layer 2 starts from its branch, against it.
		gh.state.pulls[10] = spull(10, "agent/issue-1-x");
		await callback(ctx, 1, "s1", "https://github.com/acme/site/pull/10");
		expect(gh.state.runs).toHaveLength(2);
		expect(gh.state.runs[1]).toMatchObject({ issue: 2, base: "agent/issue-1-x", stack: { layer: 2, size: 2, below: { issue: 1, pr: 10, branch: "agent/issue-1-x" } } });
		expect(store.get("2")).toMatchObject({ status: "queued", base: "agent/issue-1-x" });

		// Layer 2 opens PR 11 on top: the pair becomes a GitHub stack.
		gh.state.pulls[11] = spull(11, "agent/issue-2-y", "agent/issue-1-x", { fresh: true });
		await callback(ctx, 2, "s2", "https://github.com/acme/site/pull/11");
		expect(gh.state.stacks).toHaveLength(1);
		expect(gh.state.stacks[0].pull_requests.map((p) => p.number)).toEqual([10, 11]);
		expect(stacks.get(stack.id)).toMatchObject({ github: 50, prs: { "1": 10, "2": 11 } });
		expect(commentsPosted(calls, 11)[0]).toMatch(/Stacked on #10/);

		// PR 10 goes green while PR 11 has just opened and not built yet: hold, no merge.
		await route("webhook")(commentEvent(10, "alice", "/awaiting-test", true), ctx);
		await route("ci-callback")(await signed({ ...ciResult(10, 1, true), branch: "agent/issue-1-x" }, canonicalCi), ctx);
		expect(builds.get("10")).toMatchObject({ status: "passed", stack: stack.id, baseRef: "main" });
		expect(gh.state.merges).toEqual([]);
		expect(stacks.get(stack.id)).toMatchObject({ summary: "waiting for #11 to start building" });

		// PR 11 goes green too: one atomic stack merge of both, /merged on each, issues closed.
		await route("webhook")(commentEvent(11, "alice", "/awaiting-test", true), ctx);
		await route("ci-callback")(await signed({ ...ciResult(11, 1, true), branch: "agent/issue-2-y" }, canonicalCi), ctx);
		expect(gh.state.merges).toEqual([{ pr: 11, body: { merge_method: "squash", merge_action: "default", sha: "abc1234" } }]);
		expect(builds.get("10")).toMatchObject({ status: "merged" });
		expect(builds.get("11")).toMatchObject({ status: "merged" });
		expect(commentsPosted(calls, 10).map((b) => b.split("\n")[0])).toContain("/merged");
		expect(commentsPosted(calls, 11).map((b) => b.split("\n")[0])).toContain("/merged");
		expect(gh.state.closed.sort()).toEqual([1, 2]);
		expect(stacks.get(stack.id)).toMatchObject({ status: "merged" });
	});

	it("without numbers, stacks the issue's open sub-issues in their order", async () => {
		const gh = fakeGitHub({ issues: { 7: issue(7, "alice"), 8: issue(8, "alice"), 9: issue(9, "alice") }, subIssues: { 7: [9, 8] } });
		const { ctx, store } = ctxWith({ github: conn, settings, fetch: gh.fetch });
		const r = (await route("webhook")(commentEvent(7, "alice", "/agent-stack"), ctx)) as { handled: Record<string, { started: boolean; issues: number[] }> };
		expect(r.handled["agent-stack"]).toMatchObject({ started: true, issues: [9, 8] });
		expect(gh.state.runs[0]).toMatchObject({ issue: 9 });
		expect(store.get("8")).toMatchObject({ status: "waiting", layer: 2 });
		expect(store.get("7")).toBeUndefined();
	});

	it("a partial merge lands the green bottom, then rebuilds the layers GitHub rebases — except one the agent is still fixing", async () => {
		const gh = fakeGitHub({
			issues: { 3: issue(3, "alice"), 4: issue(4, "alice"), 5: issue(5, "alice") },
			pulls: { 20: spull(20, "b3", "main", { sha: "s20" }), 21: spull(21, "b4", "b3", { sha: "s21" }), 22: spull(22, "b5", "b4", { sha: "s22" }) },
		});
		gh.state.stacks.push({ number: 60, open: true, base: { ref: "main" }, pull_requests: [20, 21, 22].map((n) => ({ number: n, state: "open", draft: false, merged_at: null, head: gh.state.pulls[n].head })) });
		const { ctx, store, builds, stacks } = ctxWith({ github: conn, settings, fetch: gh.fetch });
		stacks.set("s3-t", { id: "s3-t", issues: [3, 4, 5], prs: { "3": 20, "4": 21, "5": 22 }, github: 60, status: "running", createdBy: "alice", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
		for (const [n, pr] of [[3, 20], [4, 21], [5, 22]] as const) {
			store.set(String(n), { number: n, title: `Issue ${n}`, author: "alice", status: "completed", prUrl: `https://github.com/acme/site/pull/${pr}`, attempt: 1, stack: "s3-t", layer: n - 2, updatedAt: "2026-01-01T00:00:00Z" });
		}
		const build = (pr: number, status: string, sha: string) => ({ pr, title: `PR ${pr}`, author: "alice", headRef: gh.state.pulls[pr].head.ref, headSha: sha, staticBranch: `static/${gh.state.pulls[pr].head.ref}`, attempt: 1, status, issue: pr - 17, stack: "s3-t", updatedAt: "2026-01-01T00:00:00Z" });
		builds.set("20", build(20, "running", "s20"));
		builds.set("21", build(21, "failed", "s21"));
		builds.set("22", build(22, "passed", "s22"));

		// The bottom layer finishes green: it merges alone (the layer above failed and is being fixed).
		await route("ci-callback")(await signed({ ...ciResult(20, 1, true), branch: "b3", headSha: "s20" }, canonicalCi), ctx);
		expect(gh.state.merges).toEqual([{ pr: 20, body: { merge_method: "squash", merge_action: "default", sha: "s20" } }]);
		expect(builds.get("20")).toMatchObject({ status: "merged" });
		expect(gh.state.closed).toEqual([3]);
		expect(stacks.get("s3-t")).toMatchObject({ status: "running", pendingRebuild: { "21": { sha: "s21" }, "22": { sha: "s22" } } });

		// GitHub rebases both upper branches: the green one is rebuilt, the failed one waits for the agent.
		gh.state.pulls[22] = { ...gh.state.pulls[22], head: { ref: "b5", sha: "s22b" } };
		await route("webhook")({ input: { action: "synchronize", pull_request: gh.state.pulls[22], repository: { full_name: "acme/site" } } }, ctx);
		expect(gh.state.ci.map((c) => c.pr)).toEqual([22]);
		expect(gh.state.ci[0]).toMatchObject({ headSha: "s22b", attempt: 2 });
		gh.state.pulls[21] = { ...gh.state.pulls[21], head: { ref: "b4", sha: "s21b" } };
		await route("webhook")({ input: { action: "synchronize", pull_request: gh.state.pulls[21], repository: { full_name: "acme/site" } } }, ctx);
		expect(gh.state.ci.map((c) => c.pr)).toEqual([22]);
		expect((stacks.get("s3-t") as { pendingRebuild?: unknown }).pendingRebuild).toBeUndefined();
	});

	it("a merge left running on GitHub is finished on the next event", async () => {
		const gh = fakeGitHub({ issues: { 1: issue(1, "alice") }, pulls: { 10: spull(10, "b1") } });
		gh.state.asyncMerge = true;
		const { ctx, store, builds, stacks } = ctxWith({ github: conn, settings, fetch: gh.fetch });
		stacks.set("s1-t", { id: "s1-t", issues: [1], prs: { "1": 10 }, status: "stopped", createdBy: "alice", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
		store.set("1", { number: 1, title: "Issue 1", author: "alice", status: "completed", prUrl: "https://github.com/acme/site/pull/10", attempt: 1, stack: "s1-t", layer: 1, updatedAt: "2026-01-01T00:00:00Z" });
		builds.set("10", { pr: 10, title: "PR 10", author: "alice", headRef: "b1", headSha: "abc1234", staticBranch: "static/b1", attempt: 1, status: "running", issue: 1, stack: "s1-t", updatedAt: "2026-01-01T00:00:00Z" });
		await route("ci-callback")(await signed({ ...ciResult(10, 1, true), branch: "b1" }, canonicalCi), ctx);
		// pending → polled once → merged.
		expect(gh.state.merges).toHaveLength(1);
		expect(builds.get("10")).toMatchObject({ status: "merged" });
		expect(stacks.get("s1-t")).toMatchObject({ status: "merged" });
	}, 15_000);

	it("/agent-issue on #N adds a layer on top of an issue's open pull request", async () => {
		const gh = fakeGitHub({ issues: { 5: issue(5, "alice"), 6: issue(6, "alice") }, pulls: { 30: spull(30, "agent/issue-5-a") } });
		const { ctx, store, stacks } = ctxWith({ github: conn, settings, fetch: gh.fetch });
		store.set("5", { number: 5, title: "Issue 5", author: "alice", status: "completed", prUrl: "https://github.com/acme/site/pull/30", attempt: 1, updatedAt: "2026-01-01T00:00:00Z" });
		const r = (await route("webhook")(commentEvent(6, "alice", "/agent-issue on #5"), ctx)) as { handled: Record<string, { started: boolean; layer: number }> };
		expect(r.handled["agent-issue"]).toMatchObject({ started: true, layer: 2 });
		expect(gh.state.runs[0]).toMatchObject({ issue: 6, base: "agent/issue-5-a", stack: { layer: 2, size: 2, below: { issue: 5, pr: 30 } } });
		const stack = [...stacks.values()][0] as { issues: number[]; prs: Record<string, number> };
		expect(stack).toMatchObject({ issues: [5, 6], prs: { "5": 30 } });
		expect(store.get("5")).toMatchObject({ stack: expect.any(String), layer: 1 });
	});

	it("a layer that yields no pull request stops the stack", async () => {
		const gh = fakeGitHub({ issues: { 1: issue(1, "alice"), 2: issue(2, "alice"), 3: issue(3, "alice") } });
		const { ctx, store, stacks, calls } = ctxWith({ github: conn, settings, fetch: gh.fetch });
		await route("webhook")(commentEvent(1, "alice", "/agent-stack #1 #2 #3"), ctx);
		await callback(ctx, 1, "s1", null, "NO_PR: the issue is unclear");
		expect(gh.state.runs).toHaveLength(1);
		expect([...stacks.values()][0]).toMatchObject({ status: "stopped", summary: expect.stringContaining("#1 produced no pull request") });
		expect(store.get("2")).toMatchObject({ status: "skipped" });
		expect(store.get("3")).toMatchObject({ status: "skipped" });
		expect(commentsPosted(calls, 2).some((b) => /stopped/.test(b) && /\/agent-stack #1 #2 #3/.test(b))).toBe(true);
	});

	it("create_stack opens the issues and starts them as one stack", async () => {
		const gh = fakeGitHub();
		const { ctx, store } = ctxWith({ github: conn, settings, fetch: gh.fetch });
		const r = (await route("stacks/create")({ input: { issues: [{ title: "Data model", body: "…" }, { title: "Endpoints", body: "…" }] }, user: { id: "u", role: 30 } }, ctx)) as { success: boolean; stack: { layers: Array<{ issue: number }> }; issues: Array<{ number: number }> };
		expect(r.success).toBe(true);
		expect(r.issues.map((i) => i.number)).toEqual([1, 2]);
		expect(r.stack.layers.map((l) => l.issue)).toEqual([1, 2]);
		expect(gh.state.runs[0]).toMatchObject({ issue: 1 });
		expect(store.get("2")).toMatchObject({ status: "waiting" });
		expect((plugin.routes!["stacks/create"] as { permission?: string }).permission).toBe("content:edit_own");
	});
});
