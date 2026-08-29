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
	previewSecret: string;
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
	isPullRequest: boolean;
}

const API = "https://api.github.com";

async function gh(
	ctx: PluginContext,
	conn: Connection,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
	const res = await ctx.http!.fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${conn.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
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
		isPullRequest: "pull_request" in r,
	};
}

export async function getConnection(ctx: PluginContext): Promise<Connection | null> {
	const c = await ctx.github?.get();
	if (!c) return null;
	return { ...c, previewSecret: (c as { previewSecret?: string }).previewSecret ?? "" };
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
	};
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
