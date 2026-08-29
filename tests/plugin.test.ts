/**
 * Tests run against the plugin object directly — no CMS, no network. The
 * context double covers kv, the `runs` storage, `github`, `site` and `http`.
 */

import { describe, expect, it } from "vitest";

import { canonicalCallback, canonicalCi, hmacHex } from "../src/agent.js";
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
	const builds = new Map<string, Record<string, unknown>>();
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

function pull(n: number, author: string, headRef: string, sha = "abc1234") {
	return { number: n, title: `PR ${n}`, user: { login: author }, head: { ref: headRef, sha }, base: { ref: "main" }, html_url: `https://github.com/acme/site/pull/${n}`, state: "open", draft: false };
}

function ciResult(pr: number, attempt: number, ok: boolean) {
	const step = (k: boolean) => ({ ok: k, log: k ? "fine" : "boom", seconds: 1 });
	return { pr, branch: "agent/issue-1-x", attempt, headSha: "abc1234", staticBranch: "static/agent/issue-1-x", staticSha: ok ? "def5678" : null, check: step(true), build: step(ok), push: ok ? step(true) : null, test: ok ? step(true) : null, preview: ok ? step(true) : null, previewUrl: ok ? `https://preview-acme-site-pr${pr}.example.workers.dev` : null, previewTest: ok ? step(true) : null, ok, ...(ok ? {} : { error: "build failed" }) };
}

const conn = { token: "gho_x", owner: "acme", repo: "site", branch: "main", previewSecret: "prev" };

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

async function signedCi(cb: Record<string, unknown>, key = "k") {
	const sig = await hmacHex(key, canonicalCi(cb as never));
	return { input: cb, request: { headers: { "x-agent-signature": `sha256=${sig}` } } };
}

describe("pull requests", () => {
	it("builds a PR from a whitelisted author and records the passing result from the callback", async () => {
		const { ctx, builds, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => {
				if (url.endsWith("/pulls/10")) return Response.json(pull(10, "alice", "agent/issue-1-x"));
				if (url.endsWith("/pulls/10/merge")) return Response.json({ merged: true, sha: "merged1", message: "Pull Request successfully merged" });
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				return Response.json({});
			},
		});
		const r = (await route("webhook")({ input: { action: "opened", pull_request: pull(10, "alice", "agent/issue-1-x") } }, ctx)) as { started: boolean; status: string };
		expect(r.started).toBe(true);
		expect(r.status).toBe("running");
		const ci = JSON.parse(String(calls.find((c) => c.url.endsWith("/ci"))?.init?.body));
		expect(ci).toMatchObject({ pr: 10, headRef: "agent/issue-1-x", staticBranch: "static/agent/issue-1-x", previewSecret: "prev", token: "gho_x", attempt: 1 });

		const cb = (await route("ci-callback")(await signedCi(ciResult(10, 1, true)), ctx)) as { success: boolean; status: string };
		expect(cb).toMatchObject({ success: true, status: "merged" });
		expect(builds.get("10")).toMatchObject({ attempt: 1, staticBranch: "static/agent/issue-1-x", staticSha: "def5678", issue: 1, status: "merged", previewUrl: "https://preview-acme-site-pr10.example.workers.dev" });
		const merge = calls.find((c) => c.url.endsWith("/pulls/10/merge"));
		expect(merge?.init?.method).toBe("PUT");
		expect(JSON.parse(String(merge?.init?.body))).toMatchObject({ merge_method: "squash" });
		const comment = JSON.parse(String(calls.find((c) => c.url.endsWith("/issues/10/comments"))?.init?.body)).body;
		expect(comment).toContain("https://preview-acme-site-pr10.example.workers.dev");
		const status = JSON.parse(String(calls.filter((c) => c.url.includes("/statuses/")).pop()?.init?.body));
		expect(status).toMatchObject({ state: "success", target_url: "https://preview-acme-site-pr10.example.workers.dev" });
	});

	it("removes the preview and marks the build closed when the PR closes", async () => {
		const { ctx, builds, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/pulls/10")) return Response.json(pull(10, "alice", "agent/issue-1-x"));
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.includes("/preview?") && init?.method === "DELETE") return Response.json({ deleted: true });
				return Response.json({});
			},
		});
		await route("webhook")({ input: { action: "opened", pull_request: pull(10, "alice", "agent/issue-1-x") } }, ctx);
		await route("ci-callback")(await signedCi(ciResult(10, 1, true)), ctx);
		await route("webhook")({ input: { action: "closed", pull_request: pull(10, "alice", "agent/issue-1-x") } }, ctx);
		expect(builds.get("10")).toMatchObject({ status: "closed" });
		expect(builds.get("10")?.previewUrl).toBeUndefined();
		expect(calls.some((c) => c.url.includes("/preview?") && c.init?.method === "DELETE")).toBe(true);
	});

	it("rejects a CI callback with a bad signature", async () => {
		const { ctx } = ctxWith({ github: conn, settings });
		const cb = (await route("ci-callback")(await signedCi(ciResult(10, 1, true), "wrong"), ctx)) as { success: boolean };
		expect(cb.success).toBe(false);
	});

	it("asks the agent to fix a failing build on its own PR, then stops at the cap", async () => {
		const runs: string[] = [];
		const { ctx, builds } = ctxWith({
			github: conn,
			settings: { ...settings, maxBuildAttempts: 2 },
			fetch: async (url, init) => {
				if (url.endsWith("/pulls/11")) return Response.json(pull(11, "alice", "agent/issue-1-x"));
				if (url.endsWith("/issues/1")) return Response.json(issue(1, "alice"));
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.endsWith("/run")) {
					runs.push(JSON.parse(String(init?.body)).note ?? "");
					return Response.json({ submissionId: `s${runs.length}`, accepted: true });
				}
				return Response.json({});
			},
		});
		const ev = { input: { action: "synchronize", pull_request: pull(11, "alice", "agent/issue-1-x") } };
		await route("webhook")(ev, ctx);
		await route("ci-callback")(await signedCi(ciResult(11, 1, false)), ctx);
		expect(builds.get("11")?.status).toBe("failed");
		expect(runs.length).toBe(1);
		expect(runs[0]).toMatch(/CI failed on your pull request #11/);
		await route("webhook")(ev, ctx);
		await route("ci-callback")(await signedCi(ciResult(11, 2, false)), ctx);
		expect(builds.get("11")?.status).toBe("capped");
		expect(runs.length).toBe(1);
		const third = (await route("webhook")(ev, ctx)) as { started: boolean; reason: string };
		expect(third.started).toBe(false);
		expect(third.reason).toMatch(/attempts/);
	});

	it("never builds a PR from a non-whitelisted author", async () => {
		const { ctx, calls } = ctxWith({
			github: conn,
			settings,
			fetch: async (url) => (url.endsWith("/pulls/12") ? Response.json(pull(12, "mallory", "feature")) : Response.json({})),
		});
		const r = (await route("webhook")({ input: { action: "opened", pull_request: pull(12, "mallory", "feature") } }, ctx)) as { started: boolean };
		expect(r.started).toBe(false);
		expect(calls.some((c) => c.url.endsWith("/ci"))).toBe(false);
	});
});

describe("default branch", () => {
	function branchResult(attempt: number, ok: boolean) {
		const step = (k: boolean) => ({ ok: k, log: k ? "fine" : "boom", seconds: 1 });
		return { pr: 0, branch: "main", attempt, headSha: "mainsha", staticBranch: "static/main", staticSha: ok ? "stat123" : null, check: step(true), build: step(ok), push: ok ? step(true) : null, test: ok ? step(true) : null, preview: null, previewUrl: null, previewTest: null, ok, ...(ok ? {} : { error: "build failed" }) };
	}

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
		expect(ci).toMatchObject({ pr: 0, headRef: "main", staticBranch: "static/main", preview: false });
		await route("ci-callback")(await signedCi(branchResult(1, true)), ctx);
		expect(builds.get("branch:main")).toMatchObject({ status: "passed", staticSha: "stat123" });
		expect(pagesCalls).toEqual([{ method: "PUT", body: { build_type: "legacy", source: { branch: "static/main", path: "/" } } }]);
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
		await route("ci-callback")(await signedCi(branchResult(1, true)), ctx);
		expect(ciCalls).toBe(2);
	});
});

describe("preview tests", () => {
	it("a failing test:preview:cf sends the agent the preview-test output", async () => {
		const runs: string[] = [];
		const { ctx, builds } = ctxWith({
			github: conn,
			settings,
			fetch: async (url, init) => {
				if (url.endsWith("/pulls/13")) return Response.json(pull(13, "alice", "agent/issue-1-x"));
				if (url.endsWith("/issues/1")) return Response.json(issue(1, "alice"));
				if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
				if (url.endsWith("/run")) {
					runs.push(JSON.parse(String(init?.body)).note ?? "");
					return Response.json({ submissionId: "s", accepted: true });
				}
				return Response.json({});
			},
		});
		await route("webhook")({ input: { action: "opened", pull_request: pull(13, "alice", "agent/issue-1-x") } }, ctx);
		const r = { ...ciResult(13, 1, true), previewTest: { ok: false, log: "expected 200, got 500", seconds: 3 }, ok: false, error: "test:preview:cf failed" };
		await route("ci-callback")(await signedCi(r), ctx);
		expect(builds.get("13")).toMatchObject({ status: "failed", summary: "test:preview:cf", previewUrl: "https://preview-acme-site-pr13.example.workers.dev" });
		expect(runs[0]).toMatch(/test:preview:cf/);
		expect(runs[0]).toMatch(/expected 200, got 500/);
	});
});

describe("auto-merge", () => {
	it("leaves the PR open when auto-merge is off, and when GitHub refuses the merge", async () => {
		const mk = (autoMerge: boolean, mergeOk: boolean) =>
			ctxWith({
				github: conn,
				settings: { ...settings, autoMerge },
				fetch: async (url) => {
					if (url.endsWith("/pulls/14")) return Response.json(pull(14, "alice", "feature"));
					if (url.endsWith("/pulls/14/merge")) return mergeOk ? Response.json({ merged: true, sha: "m" }) : Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
					if (url.endsWith("/ci")) return Response.json({ accepted: true }, { status: 202 });
					return Response.json({});
				},
			});
		for (const [autoMerge, mergeOk, expected] of [[false, true, "passed"], [true, false, "passed"], [true, true, "merged"]] as const) {
			const { ctx, builds, calls } = mk(autoMerge, mergeOk);
			await route("webhook")({ input: { action: "opened", pull_request: pull(14, "alice", "feature") } }, ctx);
			await route("ci-callback")(await signedCi(ciResult(14, 1, true)), ctx);
			expect(builds.get("14")?.status).toBe(expected);
			expect(calls.some((c) => c.url.endsWith("/pulls/14/merge"))).toBe(autoMerge);
		}
	});
});
