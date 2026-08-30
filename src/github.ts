/**
 * The slice of the GitHub REST API the plugin uses directly (list / create /
 * comment on issues). Everything the agent does goes through GitHub's MCP
 * server inside the agent worker, not through here.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

export interface Connection {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	/** Signs content-snapshot requests for builds; empty when the site has none. */
	/** The frontend service account's API token — the build reads the content snapshot with it (EMDASH_API_TOKEN). */
	frontendToken: string;
}

export interface Issue {
	number: number;
	title: string;
	body: string;
	author: string;
	labels: string[];
	url: string;
	createdAt: string;
	updatedAt: string;
	state: "open" | "closed";
	isPullRequest: boolean;
}

const API = "https://api.github.com";

async function gh(
	ctx: PluginContext,
	conn: Connection,
	method: string,
	path: string,
	body?: unknown,
	version = "2022-11-28",
): Promise<{ ok: boolean; status: number; json: unknown }> {
	const res = await ctx.http!.fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${conn.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": version,
			"User-Agent": "premium-cms-github-agent/1.0",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	return { ok: res.ok, status: res.status, json };
}

function toIssue(raw: unknown): Issue | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const user = (r.user ?? {}) as Record<string, unknown>;
	const labels = Array.isArray(r.labels)
		? r.labels.map((l) => (typeof l === "string" ? l : String((l as Record<string, unknown>).name ?? "")))
		: [];
	return {
		number: Number(r.number),
		title: String(r.title ?? ""),
		body: typeof r.body === "string" ? r.body : "",
		author: String(user.login ?? ""),
		labels: labels.filter(Boolean),
		url: String(r.html_url ?? ""),
		createdAt: String(r.created_at ?? ""),
		updatedAt: String(r.updated_at ?? ""),
		state: r.state === "closed" ? "closed" : "open",
		isPullRequest: "pull_request" in r,
	};
}

export async function getConnection(ctx: PluginContext): Promise<Connection | null> {
	const c = await ctx.github?.get();
	if (!c) return null;
	return { ...c, frontendToken: (c as { frontendToken?: string }).frontendToken ?? "" };
}

/** Open issues (pull requests excluded), newest first. `label` narrows the list. */
export async function listIssues(
	ctx: PluginContext,
	conn: Connection,
	opts: { label?: string; limit?: number } = {},
): Promise<Issue[]> {
	const q = new URLSearchParams({
		state: "open",
		sort: "created",
		direction: "desc",
		per_page: String(Math.min(opts.limit ?? 50, 100)),
	});
	if (opts.label) q.set("labels", opts.label);
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/issues?${q}`);
	if (!r.ok || !Array.isArray(r.json)) {
		throw new Error(`GitHub ${r.status} listing issues`);
	}
	return r.json.map(toIssue).filter((i): i is Issue => !!i && !i.isPullRequest);
}

export async function getIssue(ctx: PluginContext, conn: Connection, number: number): Promise<Issue | null> {
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/issues/${number}`);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`GitHub ${r.status} reading issue #${number}`);
	const issue = toIssue(r.json);
	return issue && !issue.isPullRequest ? issue : null;
}

export async function createIssue(
	ctx: PluginContext,
	conn: Connection,
	input: { title: string; body: string; labels: string[] },
): Promise<Issue> {
	const r = await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/issues`, {
		title: input.title,
		body: input.body,
		labels: input.labels,
	});
	const issue = r.ok ? toIssue(r.json) : null;
	if (!issue) {
		const msg = (r.json as { message?: string } | null)?.message ?? "";
		throw new Error(`GitHub ${r.status} creating issue${msg ? `: ${msg}` : ""}`);
	}
	return issue;
}

export async function addLabels(
	ctx: PluginContext,
	conn: Connection,
	number: number,
	labels: string[],
): Promise<void> {
	const r = await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/issues/${number}/labels`, { labels });
	if (!r.ok) throw new Error(`GitHub ${r.status} labelling issue #${number}`);
}

export async function comment(ctx: PluginContext, conn: Connection, number: number, body: string): Promise<void> {
	const r = await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/issues/${number}/comments`, { body });
	if (!r.ok) throw new Error(`GitHub ${r.status} commenting on issue #${number}`);
}

export interface PullRequest {
	number: number;
	title: string;
	author: string;
	headRef: string;
	headSha: string;
	baseRef: string;
	url: string;
	state: string;
	draft: boolean;
	merged: boolean;
	updatedAt: string;
	/** The description — where `Fixes #N` names the issue when the branch does not. */
	body: string;
	/** GitHub's stack membership, when the PR is part of one. */
	stack: { number: number; size: number; position: number; base: string } | null;
}

function toPull(raw: unknown): PullRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const head = (r.head ?? {}) as Record<string, unknown>;
	const base = (r.base ?? {}) as Record<string, unknown>;
	const user = (r.user ?? {}) as Record<string, unknown>;
	return {
		number: Number(r.number),
		title: String(r.title ?? ""),
		author: String(user.login ?? ""),
		headRef: String(head.ref ?? ""),
		headSha: String(head.sha ?? ""),
		baseRef: String(base.ref ?? ""),
		url: String(r.html_url ?? ""),
		state: String(r.state ?? ""),
		draft: r.draft === true,
		merged: r.merged === true || typeof r.merged_at === "string",
		updatedAt: String(r.updated_at ?? ""),
		body: typeof r.body === "string" ? r.body : "",
		stack: toStackRef(r.stack),
	};
}

function toStackRef(raw: unknown): PullRequest["stack"] {
	if (!raw || typeof raw !== "object") return null;
	const s = raw as Record<string, unknown>;
	const base = (s.base ?? {}) as Record<string, unknown>;
	return { number: Number(s.number), size: Number(s.size), position: Number(s.position), base: String(base.ref ?? "") };
}

export async function getPull(ctx: PluginContext, conn: Connection, number: number): Promise<PullRequest | null> {
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/pulls/${number}`);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`GitHub ${r.status} reading PR #${number}`);
	return toPull(r.json);
}

/** A commit status on the PR head (`context` groups the checks). Best-effort: needs the statuses permission. */
export async function setStatus(
	ctx: PluginContext,
	conn: Connection,
	sha: string,
	status: { state: "pending" | "success" | "failure" | "error"; context: string; description: string; targetUrl?: string },
): Promise<boolean> {
	const r = await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/statuses/${sha}`, {
		state: status.state,
		context: status.context,
		description: status.description.slice(0, 140),
		target_url: status.targetUrl,
	});
	return r.ok;
}

/**
 * Point GitHub Pages at a branch (legacy "deploy from a branch" build) so the
 * platform-built static branch is what the site serves. Returns the Pages URL.
 */
export async function servePagesFromBranch(
	ctx: PluginContext,
	conn: Connection,
	branch: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
	const current = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/pages`);
	const cfg = (current.ok ? current.json : null) as { html_url?: string; build_type?: string; source?: { branch?: string; path?: string } } | null;
	if (cfg?.build_type === "legacy" && cfg.source?.branch === branch && (cfg.source.path ?? "/") === "/") {
		return { ok: true, url: cfg.html_url };
	}
	const body = { build_type: "legacy", source: { branch, path: "/" } };
	const r = current.status === 404
		? await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/pages`, body)
		: await gh(ctx, conn, "PUT", `/repos/${conn.owner}/${conn.repo}/pages`, body);
	if (!r.ok && r.status !== 204) {
		const msg = (r.json as { message?: string } | null)?.message ?? "";
		return { ok: false, error: `GitHub ${r.status} configuring Pages${msg ? `: ${msg}` : ""}` };
	}
	const after = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/pages`);
	return { ok: true, url: (after.json as { html_url?: string } | null)?.html_url };
}

export async function branchHead(ctx: PluginContext, conn: Connection, branch: string): Promise<string | null> {
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/branches/${encodeURIComponent(branch)}`);
	if (!r.ok) return null;
	return String((r.json as { commit?: { sha?: string } })?.commit?.sha ?? "") || null;
}

/** Squash-merge a pull request. `merged: false` with a message when GitHub refuses (conflicts, checks). */
export async function mergePull(
	ctx: PluginContext,
	conn: Connection,
	number: number,
	title: string,
): Promise<{ merged: boolean; sha?: string; message: string }> {
	const r = await gh(ctx, conn, "PUT", `/repos/${conn.owner}/${conn.repo}/pulls/${number}/merge`, {
		merge_method: "squash",
		commit_title: `${title} (#${number})`,
	});
	const j = (r.json ?? {}) as { merged?: boolean; sha?: string; message?: string };
	return { merged: r.ok && j.merged === true, sha: j.sha, message: j.message ?? (r.ok ? "merged" : `GitHub ${r.status}`) };
}

// ── Stacked pull requests ────────────────────────────────────────────────

/** The API version that documents stacks, the asynchronous merge and sub-issues. */
const STACKS_API_VERSION = "2026-03-10";

export interface GitHubStack {
	number: number;
	open: boolean;
	base: string;
	/** Bottom first. */
	pullRequests: Array<{ number: number; state: string; draft: boolean; mergedAt: string | null; headRef: string; headSha: string }>;
}

function toGitHubStack(raw: unknown): GitHubStack | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const base = (r.base ?? {}) as Record<string, unknown>;
	const prs = Array.isArray(r.pull_requests) ? r.pull_requests : [];
	return {
		number: Number(r.number),
		open: r.open !== false,
		base: String(base.ref ?? ""),
		pullRequests: prs.map((p) => {
			const x = (p ?? {}) as Record<string, unknown>;
			const head = (x.head ?? {}) as Record<string, unknown>;
			return {
				number: Number(x.number),
				state: String(x.state ?? ""),
				draft: x.draft === true,
				mergedAt: typeof x.merged_at === "string" ? x.merged_at : null,
				headRef: String(head.ref ?? ""),
				headSha: String(head.sha ?? ""),
			};
		}),
	};
}

function ghMessage(json: unknown): string {
	return (json as { message?: string } | null)?.message ?? "";
}

export async function getGitHubStack(ctx: PluginContext, conn: Connection, number: number): Promise<GitHubStack | null> {
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/stacks/${number}`, undefined, STACKS_API_VERSION);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`GitHub ${r.status} reading stack #${number}`);
	return toGitHubStack(r.json);
}

/** Link open pull requests (bottom first; each must target the branch of the one below) as a stack. */
export async function createGitHubStack(ctx: PluginContext, conn: Connection, pullRequests: number[]): Promise<GitHubStack> {
	const r = await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/stacks`, { pull_requests: pullRequests }, STACKS_API_VERSION);
	const stack = r.ok ? toGitHubStack(r.json) : null;
	if (!stack) throw new Error(`GitHub ${r.status} creating a stack of ${pullRequests.map((n) => `#${n}`).join(", ")}${ghMessage(r.json) ? `: ${ghMessage(r.json)}` : ""}`);
	return stack;
}

/** Append pull requests on top of a stack. */
export async function addToGitHubStack(ctx: PluginContext, conn: Connection, number: number, pullRequests: number[]): Promise<GitHubStack> {
	const r = await gh(ctx, conn, "POST", `/repos/${conn.owner}/${conn.repo}/stacks/${number}/add`, { pull_requests: pullRequests }, STACKS_API_VERSION);
	const stack = r.ok ? toGitHubStack(r.json) : null;
	if (!stack) throw new Error(`GitHub ${r.status} adding ${pullRequests.map((n) => `#${n}`).join(", ")} to stack #${number}${ghMessage(r.json) ? `: ${ghMessage(r.json)}` : ""}`);
	return stack;
}

export interface AsyncMerge {
	status: "merged" | "pending" | "enqueued" | "failed";
	uuid?: string;
	sha?: string;
	message: string;
}

function toAsyncMerge(status: number, json: unknown): AsyncMerge {
	const j = (json ?? {}) as { status?: string; uuid?: string; sha?: string; message?: string; error?: string; details?: { sha?: string; message?: string; error?: string } };
	const raw = String(j.status ?? "");
	const s: AsyncMerge["status"] = raw === "merged" || raw === "pending" || raw === "enqueued" ? raw : "failed";
	return {
		status: s,
		uuid: typeof j.uuid === "string" ? j.uuid : undefined,
		sha: j.sha ?? j.details?.sha,
		message: j.message ?? j.details?.message ?? j.details?.error ?? j.error ?? (s === "failed" ? `GitHub ${status}` : s),
	};
}

/**
 * Squash-merge a pull request through GitHub's asynchronous merge — the only
 * way to merge a stacked PR: every unmerged layer below it lands with it, in
 * one atomic operation. `pending` comes with a uuid to poll with `asyncMergeResult`.
 */
export async function mergePullAsync(ctx: PluginContext, conn: Connection, number: number, sha: string): Promise<AsyncMerge> {
	const r = await gh(
		ctx,
		conn,
		"PUT",
		`/repos/${conn.owner}/${conn.repo}/pulls/${number}/merge-async`,
		{ merge_method: "squash", merge_action: "default", sha },
		STACKS_API_VERSION,
	);
	// 202 pending (uuid), 200 merged, 409 an earlier request is still running (uuid), 400/404/422 refused.
	if (r.status === 202 || r.status === 200 || r.status === 409) return toAsyncMerge(r.status, r.json);
	return { status: "failed", message: ghMessage(r.json) || `GitHub ${r.status}` };
}

export async function asyncMergeResult(ctx: PluginContext, conn: Connection, number: number, uuid: string): Promise<AsyncMerge> {
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/pulls/${number}/merge-async/${encodeURIComponent(uuid)}`, undefined, STACKS_API_VERSION);
	if (!r.ok) return { status: "failed", message: ghMessage(r.json) || `GitHub ${r.status} reading the merge result` };
	return toAsyncMerge(r.status, r.json);
}

/** Point an open pull request at another base branch. */
export async function retargetPull(ctx: PluginContext, conn: Connection, number: number, base: string): Promise<void> {
	const r = await gh(ctx, conn, "PATCH", `/repos/${conn.owner}/${conn.repo}/pulls/${number}`, { base });
	if (!r.ok) throw new Error(`GitHub ${r.status} retargeting PR #${number} to ${base}${ghMessage(r.json) ? `: ${ghMessage(r.json)}` : ""}`);
}

/** The issue's sub-issues in their list order (pull requests excluded). */
export async function listSubIssues(ctx: PluginContext, conn: Connection, number: number): Promise<Issue[]> {
	const r = await gh(ctx, conn, "GET", `/repos/${conn.owner}/${conn.repo}/issues/${number}/sub_issues?per_page=100`, undefined, STACKS_API_VERSION);
	if (!r.ok || !Array.isArray(r.json)) throw new Error(`GitHub ${r.status} listing the sub-issues of #${number}`);
	return r.json.map(toIssue).filter((i): i is Issue => !!i && !i.isPullRequest);
}

export async function closeIssue(ctx: PluginContext, conn: Connection, number: number): Promise<void> {
	const r = await gh(ctx, conn, "PATCH", `/repos/${conn.owner}/${conn.repo}/issues/${number}`, { state: "closed", state_reason: "completed" });
	if (!r.ok) throw new Error(`GitHub ${r.status} closing issue #${number}`);
}

/** Delete a branch (its static preview disappears with it). Missing branches are fine. */
export async function deleteBranch(ctx: PluginContext, conn: Connection, branch: string): Promise<boolean> {
	const r = await gh(ctx, conn, "DELETE", `/repos/${conn.owner}/${conn.repo}/git/refs/heads/${branch}`);
	if (r.ok || r.status === 404 || r.status === 422) return r.ok;
	throw new Error(`GitHub ${r.status} deleting branch ${branch}`);
}
