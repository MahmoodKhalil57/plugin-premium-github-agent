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
	const calls: Array<{ url: string; init?: RequestInit }> = [];
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
	return { ctx, store, builds, calls };
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

		const page = (await route("admin")({ input: { type: "page_load", page: "/github-agent" } }, ctx)) as { blocks: Array<{ type: string; text?: string }> };
		const line = page.blocks.find((b) => b.type === "context" && b.text?.startsWith("Previous deployments:"))?.text ?? "";
		expect(line).toContain("1 back — static/main-b-1 @ prev1sh → https://preview-acme-site-main-b-1.example.workers.dev");
		expect(line).toContain("2 back — static/main-b-2 @ prev2sh → https://preview-acme-site-main-b-2.example.workers.dev");
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
