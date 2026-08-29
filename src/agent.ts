/**
 * Talks to the agent worker (a Cloudflare Worker running a Think agent with
 * GitHub's MCP server). Every run is keyed by issue number and idempotent on
 * the worker, so re-dispatching is safe.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

import type { Connection } from "./github.js";
import type { Settings } from "./settings.js";

export type RunStatus = "waiting" | "queued" | "running" | "completed" | "error" | "skipped";

/** The layer below a stacked run: the agent branches from its pull request's branch. */
export interface LayerBelow {
	issue: number;
	pr: number;
	branch: string;
}

export interface Run {
	number: number;
	title: string;
	author: string;
	status: RunStatus;
	submissionId?: string;
	/** The agent's last line: a PR url, or `NO_PR: reason`. */
	answer?: string;
	prUrl?: string;
	reason?: string;
	/** How many times the agent was asked about this issue. */
	attempt?: number;
	/** The stack this run is a layer of (`waiting` until the layer below opens its PR). */
	stack?: string;
	layer?: number;
	/** Stacked layers above the bottom: the branch the agent starts from and targets. */
	base?: string;
	below?: LayerBelow;
	updatedAt: string;
}

/** Stack placement handed to the worker with a run. */
export interface StackedRun {
	layer: number;
	size: number;
	base?: string;
	below?: LayerBelow;
}

/** What the agent worker POSTs to `agent-callback` when a run ends. */
export interface Callback {
	issue: number;
	attempt: number;
	submissionId: string;
	status: string;
	answer: string | null;
	prUrl: string | null;
}

export function runId(number: number): string {
	return String(number);
}

async function call(
	ctx: PluginContext,
	settings: Settings,
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
	const res = await ctx.http!.fetch(`${settings.agentUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${settings.agentKey}`,
			"Content-Type": "application/json",
			"User-Agent": "premium-cms-github-agent/1.0",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	let json: Record<string, unknown> = {};
	try {
		json = (await res.json()) as Record<string, unknown>;
	} catch {
		json = {};
	}
	return { ok: res.ok, status: res.status, json };
}

export interface CiStep {
	ok: boolean;
	log: string;
	seconds: number;
}

/** An earlier deployment of the default branch, kept on `static/<branch>-b-N` and hosted as a preview Worker. */
export interface PreviousDeployment {
	branch: string;
	sha: string;
	previewUrl: string | null;
}

/** What the agent worker POSTs to `ci-callback` (and returns from `/ci`). */
export interface CiResult {
	pr: number;
	/** The branch that was built. */
	branch: string;
	attempt: number;
	headSha: string;
	staticBranch: string;
	staticSha: string | null;
	check: CiStep | null;
	build: CiStep | null;
	push: CiStep | null;
	test: CiStep | null;
	preview: CiStep | null;
	previewUrl: string | null;
	previewTest: CiStep | null;
	/** Branch builds: the deployments before this one, nearest first. */
	previous?: PreviousDeployment[];
	ok: boolean;
	error?: string;
}

/** Fixed field order: what the worker signs (JSON of the whole result). */
export function canonicalCi(r: CiResult): string {
	return JSON.stringify({
		pr: r.pr,
		branch: r.branch,
		attempt: r.attempt,
		headSha: r.headSha,
		staticBranch: r.staticBranch,
		staticSha: r.staticSha,
		check: r.check,
		build: r.build,
		push: r.push,
		test: r.test,
		preview: r.preview ?? null,
		previewUrl: r.previewUrl ?? null,
		previewTest: r.previewTest ?? null,
		...(r.previous !== undefined ? { previous: r.previous } : {}),
		ok: r.ok,
		...(r.error !== undefined ? { error: r.error } : {}),
	});
}

/** A stage report the worker POSTs to `ci-stage` while a run progresses. */
export interface CiStageReport {
	pr: number;
	branch: string;
	attempt: number;
	headSha: string;
	stage: "check" | "test" | "preview" | "previewTest";
	ok: boolean;
	log: string;
	seconds: number;
	previewUrl: string | null;
}

/** Fixed field order — what the worker signs for a stage report. */
export function canonicalStage(r: CiStageReport): string {
	return JSON.stringify({
		pr: r.pr,
		branch: r.branch,
		attempt: r.attempt,
		headSha: r.headSha,
		stage: r.stage,
		ok: r.ok,
		log: r.log,
		seconds: r.seconds,
		previewUrl: r.previewUrl,
	});
}

/** Remove a PR's preview Worker (best-effort, when the PR closes). */
export async function deletePreview(ctx: PluginContext, settings: Settings, conn: Connection, pr: number): Promise<boolean> {
	const q = new URLSearchParams({ owner: conn.owner, repo: conn.repo, pr: String(pr) });
	const r = await call(ctx, settings, "DELETE", `/preview?${q}`);
	return r.ok && r.json.deleted === true;
}

/** Start a PR build; the worker accepts it and POSTs the result to `ci-callback` when done. */
export async function dispatchCi(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	input: {
		pr: number;
		headRef: string;
		headSha: string;
		attempt: number;
		staticBranch: string;
		backendUrl: string;
		siteUrl: string;
		callbackUrl: string;
		preview?: boolean;
		/** Branch builds: how many previous deployments to keep (`static/<branch>-b-N`). */
		previous?: number;
	},
): Promise<void> {
	const r = await call(ctx, settings, "POST", "/ci", {
		owner: conn.owner,
		repo: conn.repo,
		token: conn.token,
		previewSecret: conn.previewSecret,
		...input,
	});
	if (!r.ok || r.json.accepted !== true) {
		throw new Error(`agent ${r.status}: ${String(r.json.error ?? "ci was not accepted")}`);
	}
}

export async function dispatch(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	issue: number,
	attempt: number,
	callbackUrl: string,
	note?: string,
	stacked?: StackedRun,
): Promise<{ submissionId: string; accepted: boolean }> {
	const r = await call(ctx, settings, "POST", "/run", {
		owner: conn.owner,
		repo: conn.repo,
		branch: conn.branch,
		issue,
		token: conn.token,
		model: settings.model,
		reasoning: settings.reasoning,
		attempt,
		callbackUrl,
		...(note ? { note } : {}),
		...(stacked ? { base: stacked.base, stack: { layer: stacked.layer, size: stacked.size, below: stacked.below } } : {}),
	});
	if (!r.ok || typeof r.json.submissionId !== "string") {
		throw new Error(`agent ${r.status}: ${String(r.json.error ?? "no submission id")}`);
	}
	return { submissionId: r.json.submissionId, accepted: r.json.accepted !== false };
}

export async function status(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	issue: number,
	submissionId: string,
): Promise<{ status: string; answer: string | null }> {
	const q = new URLSearchParams({
		owner: conn.owner,
		repo: conn.repo,
		issue: String(issue),
		submission: submissionId,
	});
	const r = await call(ctx, settings, "GET", `/status?${q}`);
	if (!r.ok) throw new Error(`agent ${r.status}: ${String(r.json.error ?? "status failed")}`);
	return {
		status: String(r.json.status ?? "unknown"),
		answer: typeof r.json.answer === "string" ? r.json.answer : null,
	};
}

/** Pull the PR link out of the agent's final answer, if it opened one. */
export function prUrlFrom(answer: string | null | undefined): string | undefined {
	if (!answer) return undefined;
	const m = answer.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
	return m?.[0];
}

/**
 * The callback is signed over the canonical JSON of its six fields, in this
 * order, so it can be checked from the parsed body (routes never see raw bytes).
 */
export function canonicalCallback(c: Callback): string {
	return JSON.stringify({
		issue: c.issue,
		attempt: c.attempt,
		submissionId: c.submissionId,
		status: c.status,
		answer: c.answer,
		prUrl: c.prUrl,
	});
}

export async function hmacHex(secret: string, text: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The worker's record of a build: what is running and the last finished result. */
export async function ciStatus(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	target: { pr: number; branch?: string },
): Promise<{ running: { attempt: number } | null; last: CiResult | null }> {
	const q = new URLSearchParams({ owner: conn.owner, repo: conn.repo, pr: String(target.pr) });
	if (target.branch) q.set("branch", target.branch);
	const r = await call(ctx, settings, "GET", `/ci/status?${q}`);
	if (!r.ok) throw new Error(`agent ${r.status}: ${String(r.json.error ?? "status failed")}`);
	return {
		running: (r.json.running as { attempt: number } | null) ?? null,
		last: (r.json.last as CiResult | null) ?? null,
	};
}
