/**
 * Talks to the instance's agent runtime (`ctx.agents`, `ctx.sandbox`): a Think
 * agent with GitHub's MCP server, and the build sandbox, both hosted by the
 * instance itself. Every run is keyed by issue number and idempotent, so
 * re-dispatching is safe.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

import type { Connection } from "./github.js";
import type { Settings } from "./settings.js";
import { FIX_ISSUE_SKILL } from "./skill.js";

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

/** The instance's agent runtime, reached through the plugin context (capabilities agents:run + sandbox:build). */
interface AgentsLike {
	run(spec: Record<string, unknown>): Promise<{ submissionId: string; accepted: boolean }>;
	status(id: string, submissionId: string): Promise<{ status: string; answer: string | null }>;
}
interface SandboxLike {
	build(spec: Record<string, unknown>): Promise<{ accepted: true }>;
	buildStatus(id: string): Promise<{ running: unknown; last: unknown }>;
}

function agentsOf(ctx: PluginContext): AgentsLike {
	const agents = (ctx as { agents?: AgentsLike }).agents;
	if (!agents) throw new Error("This instance does not host the agent runtime (plugin capability agents:run)");
	return agents;
}

function sandboxOf(ctx: PluginContext): SandboxLike {
	const sandbox = (ctx as { sandbox?: SandboxLike }).sandbox;
	if (!sandbox) throw new Error("This instance does not host a build sandbox (plugin capability sandbox:build)");
	return sandbox;
}

const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";
/** Tools that would take a run past "open a PR" — refused by the runtime even if the model asks. */
const FORBIDDEN_TOOLS = "merge|delete|close|update_issue|update_pull_request_branch|request_copilot|assign|lock|transfer";

/** The agent lane for an issue: every attempt lands on the same object. */
export function agentIdFor(issue: number): string {
	return `issue-${issue}`;
}

/** The build lane: one per pull request, one per built branch. */
export function buildIdFor(target: { pr: number; headRef?: string }): string {
	return target.pr > 0 ? `pr-${target.pr}` : `branch-${(target.headRef ?? "").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

export interface CiStep {
	ok: boolean;
	log: string;
	seconds: number;
}

/** An earlier deployment of the default branch, kept on `static/<branch>-b-N` and served from there by the platform. */
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

/** Start a build in the instance's sandbox; the runtime posts stage reports to `ci-stage` and the result to `ci-callback`, both signed. */
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
		/** PR builds: the platform's git-served URL of the static branch; the run waits for it, then tests against it. */
		previewUrl?: string | null;
		/** Branch builds: how many previous deployments to keep (`static/<branch>-b-N`). */
		previous?: number;
		/** Branch builds: the platform's URL for each kept deployment (`-b-1` first). */
		previousUrls?: Array<string | null>;
	},
): Promise<void> {
	const { callbackUrl: _url, ...build } = input;
	const r = await sandboxOf(ctx).build({
		id: buildIdFor(input),
		owner: conn.owner,
		repo: conn.repo,
		token: conn.token,
		previewSecret: conn.previewSecret,
		...build,
		callback: { route: "ci-callback", secret: settings.agentKey },
		stageRoute: "ci-stage",
	});
	if (r.accepted !== true) throw new Error("the build was not accepted");
}

/** What the run reports through `agent-callback`: `{issue, attempt}` come back as given, the rest from the runtime. */
export async function dispatch(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	issue: number,
	attempt: number,
	_callbackUrl: string,
	note?: string,
	stacked?: StackedRun,
): Promise<{ submissionId: string; accepted: boolean }> {
	const stackLine = stacked
		? stacked.base && stacked.below
			? `Stacked pull requests: this issue is layer ${stacked.layer} of ${stacked.size}. Create your branch from \`${stacked.base}\` — the branch of pull request #${stacked.below.pr}, which implements #${stacked.below.issue} and is not merged yet — instead of the default branch, and open your pull request against \`${stacked.base}\` (base), not against ${conn.branch}. Build on what is already there; do not rework what #${stacked.below.issue} changed unless this issue requires it. The platform links the pull request into the stack and merges the stack bottom-up — do not merge, retarget or rebase anything.`
			: `Stacked pull requests: this issue is layer ${stacked.layer} of ${stacked.size} and starts from the default branch as usual; the layers above will build on your branch, so keep the change self-contained and do not touch what they are meant to do.`
		: "";
	const input = [
		`Repository: ${conn.owner}/${conn.repo} (default branch: ${conn.branch})`,
		`Issue: #${issue}`,
		"",
		attempt > 1
			? `This is attempt ${attempt}. Re-read the issue and the repository state (branches and pull requests you opened earlier may exist — reuse or correct them rather than duplicating). Fix this issue and open or update a pull request. Do not merge it.`
			: "Fix this issue and open a pull request. Do not merge it.",
		...(stackLine ? ["", stackLine] : []),
		...(note ? ["", note.slice(0, 12_000)] : []),
	].join("\n");
	return agentsOf(ctx).run({
		id: agentIdFor(issue),
		model: settings.model,
		reasoning: settings.reasoning,
		systemPrompt: "You fix GitHub issues by opening pull requests. Activate the fix-github-issue skill and follow it exactly. You cannot run code.",
		skills: [FIX_ISSUE_SKILL],
		mcp: [
			{
				name: "github",
				url: GITHUB_MCP,
				headers: { Authorization: `Bearer ${conn.token}`, "X-MCP-Toolsets": "repos,issues,pull_requests" },
			},
		],
		repo: { owner: conn.owner, repo: conn.repo, branch: conn.branch, token: conn.token },
		input,
		idempotencyKey: `issue-${issue}-attempt-${attempt}`,
		forbidTools: FORBIDDEN_TOOLS,
		maxSteps: 80,
		callback: { route: "agent-callback", secret: settings.agentKey, data: { issue, attempt } },
	});
}

export async function status(
	ctx: PluginContext,
	_settings: Settings,
	_conn: Connection,
	issue: number,
	submissionId: string,
): Promise<{ status: string; answer: string | null }> {
	const r = await agentsOf(ctx).status(agentIdFor(issue), submissionId);
	return { status: String(r.status ?? "unknown"), answer: typeof r.answer === "string" ? r.answer : null };
}

/** Pull the PR link out of the agent's final answer, if it opened one. */
export function prUrlFrom(answer: string | null | undefined): string | undefined {
	if (!answer) return undefined;
	const m = answer.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
	return m?.[0];
}

/**
 * The runtime signs `JSON.stringify({ ...data, submissionId, status, answer })`
 * with `data = {issue, attempt}` as handed to it; the same shape is rebuilt here
 * (routes never see raw bytes). `prUrl` is derived from the answer, not signed.
 */
export function canonicalCallback(c: Pick<Callback, "issue" | "attempt" | "submissionId" | "status" | "answer">): string {
	return JSON.stringify({
		issue: c.issue,
		attempt: c.attempt,
		submissionId: c.submissionId,
		status: c.status,
		answer: c.answer,
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

/** The runtime's record of a build lane: what is running and the last finished result. */
export async function ciStatus(
	ctx: PluginContext,
	_settings: Settings,
	_conn: Connection,
	target: { pr: number; branch?: string },
): Promise<{ running: { attempt: number } | null; last: CiResult | null }> {
	const r = await sandboxOf(ctx).buildStatus(buildIdFor({ pr: target.pr, headRef: target.branch }));
	return {
		running: (r.running as { attempt: number } | null) ?? null,
		last: (r.last as CiResult | null) ?? null,
	};
}
