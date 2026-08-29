/**
 * GitHub Agent — issues on the site's connected repo, and a coding agent
 * that turns labelled issues into open pull requests.
 *
 *   github    the site's GitHub connection (`ctx.github`) is the only
 *             credential; nothing is stored beyond the plugin's own settings.
 *   webhook   GitHub → the platform's GitHub App webhook → the parent control
 *             plane routes the event by repository → this plugin's `webhook`
 *             route. The issue is re-read from GitHub before anything happens,
 *             so the event is only ever a hint.
 *   agent     a Cloudflare Worker running a Think agent (Workers AI +
 *             GitHub MCP). It reads the repo, writes a branch, opens a PR and
 *             leaves it open, then calls back (`agent-callback`, HMAC-signed).
 *             No code is ever executed — dry coding only.
 *   storage   `runs` — one row per issue the agent was asked about.
 *   admin     /github-agent page: issues, runs, "new issue", settings.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

import {
	canonicalCallback,
	canonicalCi,
	deletePreview,
	dispatch,
	dispatchCi,
	hmacHex,
	prUrlFrom,
	runId,
	status as agentStatus,
	timingSafeEqual,
	type Callback,
	type CiResult,
	type Run,
} from "./agent.js";
import {
	addLabels,
	branchHead,
	comment,
	createIssue,
	getConnection,
	getIssue,
	getPull,
	listIssues,
	mergePull,
	servePagesFromBranch,
	setStatus,
	type Connection,
	type Issue,
	type PullRequest,
} from "./github.js";
import { DEFAULTS, normalizeLogin, readSettings, saveSettings, type Settings } from "./settings.js";

const CALLBACK_PATH = "/_emdash/api/plugins/premium-github-agent/agent-callback";
const CI_CALLBACK_PATH = "/_emdash/api/plugins/premium-github-agent/ci-callback";
const STATUS_CONTEXT = "premium-cms/ci";
const AGENT_BRANCH = /^agent\/issue-(\d+)-/;

// ── Helpers ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function now(): string {
	return new Date().toISOString();
}

function isRun(v: unknown): v is Run {
	return isRecord(v) && typeof v.number === "number" && typeof v.status === "string";
}

async function getRun(ctx: PluginContext, number: number): Promise<Run | null> {
	const row = await ctx.storage.runs!.get(runId(number));
	return isRun(row) ? row : null;
}

async function putRun(ctx: PluginContext, run: Run): Promise<void> {
	await ctx.storage.runs!.put(runId(run.number), { ...run, updatedAt: now() });
}

async function listRuns(ctx: PluginContext, limit = 50): Promise<Run[]> {
	const r = await ctx.storage.runs!.query({ orderBy: { updatedAt: "desc" }, limit });
	return r.items.map((i) => i.data).filter(isRun);
}

function allowed(settings: Settings, author: string): boolean {
	return settings.allowedUsers.includes(normalizeLogin(author));
}

/** Sandboxed routes get a serialized request (`headers` is a plain object). */
function headerOf(request: unknown, name: string): string {
	const h = isRecord(request) ? request.headers : null;
	if (h && typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? "";
	if (isRecord(h)) {
		const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase());
		return hit ? String(hit[1]) : "";
	}
	return "";
}

function callbackUrl(ctx: PluginContext): string {
	return `${ctx.site.url.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

async function requireSetup(
	ctx: PluginContext,
): Promise<{ ok: true; conn: Connection; settings: Settings } | { ok: false; error: string }> {
	const conn = await getConnection(ctx);
	if (!conn) return { ok: false, error: "Connect GitHub in Settings → General first." };
	const settings = await readSettings(ctx);
	return { ok: true, conn, settings };
}

/**
 * Hand one issue to the agent. The whitelist is enforced here, for webhook
 * and manual runs alike — an unlisted author is recorded as skipped.
 * `again` retries an issue whose previous run already finished.
 */
async function runIssue(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	issue: Issue,
	again = false,
	note?: string,
): Promise<Run> {
	const existing = await getRun(ctx, issue.number);
	if (existing && (existing.status === "queued" || existing.status === "running")) return existing;
	if (existing?.status === "completed" && !again) return existing;
	const attempt = again ? (existing?.attempt ?? 1) + 1 : (existing?.attempt ?? 1);

	const base = { number: issue.number, title: issue.title, author: issue.author, attempt, updatedAt: now() };
	if (!allowed(settings, issue.author)) {
		const run: Run = { ...base, status: "skipped", reason: `@${issue.author} is not a whitelisted user` };
		await putRun(ctx, run);
		return run;
	}
	if (!settings.agentKey) {
		const run: Run = { ...base, status: "error", reason: "Agent key is not set in the plugin settings" };
		await putRun(ctx, run);
		return run;
	}
	try {
		const d = await dispatch(ctx, settings, conn, issue.number, attempt, callbackUrl(ctx), note);
		const run: Run = { ...base, status: "queued", submissionId: d.submissionId };
		await putRun(ctx, run);
		ctx.log.info(`issue #${issue.number} handed to the agent`, { submission: d.submissionId, attempt });
		return run;
	} catch (error) {
		const run: Run = { ...base, status: "error", reason: String(error) };
		await putRun(ctx, run);
		ctx.log.error(`issue #${issue.number}: dispatch failed`, error);
		return run;
	}
}

/** Refresh one queued/running run from the agent worker (manual reconcile). */
async function refreshRun(ctx: PluginContext, settings: Settings, conn: Connection, run: Run): Promise<Run> {
	if (!run.submissionId || (run.status !== "queued" && run.status !== "running")) return run;
	try {
		const s = await agentStatus(ctx, settings, conn, run.number, run.submissionId);
		const next = applyOutcome(run, s.status, s.answer);
		if (next !== run) await putRun(ctx, next);
		return next;
	} catch (error) {
		ctx.log.warn(`issue #${run.number}: status check failed`, error);
		return run;
	}
}

function applyOutcome(run: Run, status: string, answer: string | null): Run {
	if (status === "running" || status === "pending") return run.status === "running" ? run : { ...run, status: "running" };
	if (status === "completed") return { ...run, status: "completed", answer: answer ?? undefined, prUrl: prUrlFrom(answer) };
	if (status === "error" || status === "aborted" || status === "skipped" || status === "unknown") {
		return { ...run, status: "error", reason: `agent ${status}` };
	}
	return run;
}

/** Manual reconcile: dispatch labelled issues not seen yet, refresh in-flight runs. */
async function poll(ctx: PluginContext): Promise<{ dispatched: number; refreshed: number; error?: string }> {
	const setup = await requireSetup(ctx);
	if (!setup.ok) return { dispatched: 0, refreshed: 0, error: setup.error };
	const { conn, settings } = setup;

	let dispatched = 0;
	for (const issue of await listIssues(ctx, conn, { label: settings.label, limit: 30 })) {
		if (await getRun(ctx, issue.number)) continue;
		const run = await runIssue(ctx, settings, conn, issue);
		if (run.status === "queued") dispatched++;
	}

	let refreshed = 0;
	for (const run of await listRuns(ctx, 50)) {
		if (run.status !== "queued" && run.status !== "running") continue;
		const after = await refreshRun(ctx, settings, conn, run);
		if (after.status !== run.status) refreshed++;
	}
	return { dispatched, refreshed };
}

/** A GitHub `issues` event, as forwarded by the parent control plane. */
function issueNumberFromEvent(input: unknown): { action: string; number: number; label: string } | null {
	if (!isRecord(input)) return null;
	const issue = isRecord(input.issue) ? input.issue : null;
	const number = Number(issue?.number);
	if (!Number.isInteger(number) || number <= 0) return null;
	const label = isRecord(input.label) ? String(input.label.name ?? "") : "";
	return { action: String(input.action ?? ""), number, label };
}

// ── Pull-request builds ──────────────────────────────────────────────────

type BuildStatus = "running" | "passed" | "merged" | "failed" | "error" | "capped" | "closed";

/** Storage id of the default-branch build row. */
function branchBuildId(branch: string): string {
	return `branch:${branch}`;
}

/** One row per PR (or per built branch, `pr: 0`) in the `builds` storage: the latest CI attempt and its outcome. */
interface Build {
	pr: number;
	title: string;
	author: string;
	headRef: string;
	headSha: string;
	staticBranch: string;
	staticSha?: string;
	/** Cloudflare-hosted preview of the latest passing build. */
	previewUrl?: string;
	/** CI attempts on this PR (across agent fixes). */
	attempt: number;
	status: BuildStatus;
	summary?: string;
	/** Issue the PR fixes when the branch is the agent's (`agent/issue-N-…`). */
	issue?: number;
	/** Branch builds: another build was requested while this one ran. */
	rebuild?: boolean;
	updatedAt: string;
}

function isBuild(v: unknown): v is Build {
	return isRecord(v) && typeof v.pr === "number" && typeof v.status === "string";
}

function buildId(b: { pr: number; headRef: string }): string {
	return b.pr > 0 ? String(b.pr) : branchBuildId(b.headRef);
}

async function getBuild(ctx: PluginContext, pr: number): Promise<Build | null> {
	const row = await ctx.storage.builds!.get(String(pr));
	return isBuild(row) ? row : null;
}

async function getBranchBuild(ctx: PluginContext, branch: string): Promise<Build | null> {
	const row = await ctx.storage.builds!.get(branchBuildId(branch));
	return isBuild(row) ? row : null;
}

async function putBuild(ctx: PluginContext, b: Build): Promise<void> {
	await ctx.storage.builds!.put(buildId(b), { ...b, updatedAt: now() });
}

async function listBuilds(ctx: PluginContext, limit = 50): Promise<Build[]> {
	const r = await ctx.storage.builds!.query({ orderBy: { updatedAt: "desc" }, limit });
	return r.items.map((i) => i.data).filter(isBuild);
}

function staticBranchFor(headRef: string): string {
	return `static/${headRef}`;
}

function ciCallbackUrl(ctx: PluginContext): string {
	return `${ctx.site.url.replace(/\/+$/, "")}${CI_CALLBACK_PATH}`;
}

function stepLine(name: string, s: { ok: boolean; seconds: number } | null): string {
	if (!s) return `- ${name}: skipped`;
	return `- ${name}: ${s.ok ? "✅ passed" : "❌ failed"} (${s.seconds}s)`;
}

function firstFailure(r: CiResult): { name: string; log: string } | null {
	for (const [name, s] of [
		["check:cf", r.check],
		["build", r.build],
		["static push", r.push],
		["test:cf", r.test],
		["preview", r.preview],
		["test:preview:cf", r.previewTest],
	] as const) {
		if (s && !s.ok) return { name, log: s.log };
	}
	return null;
}

function ciComment(conn: Connection, b: Build, r: CiResult, next: string): string {
	const failure = firstFailure(r);
	const staticUrl = `https://github.com/${conn.owner}/${conn.repo}/tree/${r.staticBranch}`;
	return [
		`### ${r.ok ? "✅" : "❌"} PremiumCMS CI — attempt ${r.attempt} on \`${b.headRef}\` @ ${r.headSha.slice(0, 7)}`,
		"",
		stepLine("check:cf", r.check),
		stepLine("build (astro)", r.build),
		stepLine(`static build → [\`${r.staticBranch}\`](${staticUrl})`, r.push),
		stepLine("test:cf", r.test),
		...(r.preview ? [stepLine("preview on Cloudflare", r.preview)] : []),
		...(r.previewTest ? [stepLine("test:preview:cf (against the preview)", r.previewTest)] : []),
		...(r.previewUrl ? ["", `**Preview:** ${r.previewUrl}`] : []),
		...(r.staticSha ? ["", `Static build commit: ${r.staticSha.slice(0, 7)} (force-pushed; the branch always holds the latest build of this PR).`] : []),
		...(failure
			? ["", `<details><summary>${failure.name} output</summary>`, "", "```", failure.log.trim().slice(-5000), "```", "", "</details>"]
			: []),
		...(r.error && !failure ? ["", `Error: ${r.error}`] : []),
		"",
		next,
	].join("\n");
}

/**
 * Build one PR (opened / new commits). The PR author must be whitelisted; a
 * PR that already used up `maxBuildAttempts` is left alone.
 */
async function buildPull(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	pr: PullRequest,
	opts: { force?: boolean } = {},
): Promise<{ started: boolean; reason?: string; build?: Build }> {
	if (!allowed(settings, pr.author)) return { started: false, reason: `@${pr.author} is not a whitelisted user` };
	if (!settings.agentKey) return { started: false, reason: "Agent key is not set in the plugin settings" };
	if (pr.state !== "open") return { started: false, reason: `PR is ${pr.state}` };

	const existing = await getBuild(ctx, pr.number);
	if (existing?.status === "running" && existing.headSha === pr.headSha && !opts.force) {
		return { started: false, reason: "already building this commit", build: existing };
	}
	const attempt = (existing?.attempt ?? 0) + 1;
	if (attempt > settings.maxBuildAttempts && !opts.force) {
		const capped: Build = { ...(existing as Build), status: "capped", updatedAt: now() };
		await putBuild(ctx, capped);
		return { started: false, reason: `reached ${settings.maxBuildAttempts} build attempts`, build: capped };
	}
	const issue = Number(pr.headRef.match(AGENT_BRANCH)?.[1]) || existing?.issue;
	const build: Build = {
		pr: pr.number,
		title: pr.title,
		author: pr.author,
		headRef: pr.headRef,
		headSha: pr.headSha,
		staticBranch: existing?.staticBranch ?? staticBranchFor(pr.headRef),
		staticSha: existing?.staticSha,
		attempt,
		status: "running",
		issue: Number.isInteger(issue) ? issue : undefined,
		updatedAt: now(),
	};
	await putBuild(ctx, build);
	await setStatus(ctx, conn, pr.headSha, {
		state: "pending",
		context: STATUS_CONTEXT,
		description: `attempt ${attempt}: check → build → static → test`,
	}).catch(() => undefined);

	try {
		// The worker runs the job in its own durable object and POSTs the
		// signed result to ci-callback, where recordCi finishes the story.
		await dispatchCi(ctx, settings, conn, {
			pr: pr.number,
			headRef: pr.headRef,
			headSha: pr.headSha,
			attempt,
			staticBranch: build.staticBranch,
			backendUrl: ctx.site.url,
			siteUrl: ctx.site.url,
			callbackUrl: ciCallbackUrl(ctx),
		});
		return { started: true, build };
	} catch (error) {
		const failed: Build = { ...build, status: "error", summary: String(error) };
		await putBuild(ctx, failed);
		ctx.log.error(`PR #${pr.number}: ci dispatch failed`, error);
		return { started: false, reason: String(error), build: failed };
	}
}

/**
 * Apply a CI result: store it, comment on the PR, set the commit status and —
 * when the PR is the agent's own fix branch and the run failed — ask the
 * agent to push a fix (which GitHub reports as `synchronize`, re-running CI
 * onto the same static branch) until `maxBuildAttempts` is used up.
 * Idempotent per (pr, attempt).
 */
async function recordCi(ctx: PluginContext, settings: Settings, conn: Connection, r: CiResult): Promise<Build | null> {
	const build = await getBuild(ctx, r.pr);
	if (!build) return null;
	if (build.attempt !== r.attempt || build.status !== "running") return build;

	const exhausted = r.attempt >= settings.maxBuildAttempts;
	const agentPr = build.issue !== undefined;
	let next: Build = {
		...build,
		status: r.ok ? "passed" : "failed",
		staticSha: r.staticSha ?? build.staticSha,
		previewUrl: r.previewUrl ?? build.previewUrl,
		summary: r.ok ? `passed on attempt ${r.attempt}` : (firstFailure(r)?.name ?? r.error ?? "failed"),
	};
	let closing: string;
	if (r.ok) {
		closing = [
			r.previewUrl ? `Preview: ${r.previewUrl}. The static build lives on \`${r.staticBranch}\`.` : `The static build lives on \`${r.staticBranch}\`.`,
			settings.autoMerge ? `All checks passed — merging into \`${conn.branch}\`, which rebuilds \`${staticBranchFor(conn.branch)}\`.` : "Ready for review.",
		].join(" ");
	} else if (agentPr && !exhausted) {
		closing = `The agent will push a fix to \`${build.headRef}\` (build attempt ${r.attempt + 1} of ${settings.maxBuildAttempts}).`;
	} else if (agentPr) {
		closing = `Build attempts exhausted (${settings.maxBuildAttempts}); a human needs to take it from here.`;
		next = { ...next, status: "capped" };
	} else {
		closing = "Push a fix to re-run the checks.";
	}
	await putBuild(ctx, next);

	await comment(ctx, conn, r.pr, ciComment(conn, next, r, closing)).catch((e) => ctx.log.warn("PR comment failed", e));
	await setStatus(ctx, conn, r.headSha, {
		state: r.ok ? "success" : "failure",
		context: STATUS_CONTEXT,
		description: r.ok ? `passed (attempt ${r.attempt}); static: ${r.staticBranch}` : `${next.summary} (attempt ${r.attempt})`,
		targetUrl: r.previewUrl ?? `https://github.com/${conn.owner}/${conn.repo}/pull/${r.pr}`,
	}).catch(() => undefined);

	if (r.ok && settings.autoMerge) {
		const m = await mergePull(ctx, conn, r.pr, build.title).catch((e) => ({ merged: false, message: String(e) }));
		if (m.merged) {
			next = { ...next, status: "merged", summary: `merged into ${conn.branch}${m.sha ? ` @ ${m.sha.slice(0, 7)}` : ""}` };
			await putBuild(ctx, next);
			ctx.log.info(`PR #${r.pr} merged into ${conn.branch}`, { sha: m.sha });
		} else {
			await comment(ctx, conn, r.pr, `Could not merge automatically: ${m.message}. The PR stays open for a human.`).catch(() => undefined);
			ctx.log.warn(`PR #${r.pr}: auto-merge refused: ${m.message}`);
		}
	}

	if (!r.ok && agentPr && !exhausted && build.issue !== undefined) {
		const failure = firstFailure(r);
		const note = [
			`CI failed on your pull request #${r.pr} (branch \`${build.headRef}\`, commit ${r.headSha.slice(0, 7)}) at step "${failure?.name ?? r.error ?? "unknown"}".`,
			"Fix the cause and push the corrected files to that same branch (do not open another PR or branch). Then comment on the PR with what you changed.",
			"",
			"Output:",
			"```",
			(failure?.log ?? r.error ?? "").trim().slice(-6000),
			"```",
		].join("\n");
		const issue = await getIssue(ctx, conn, build.issue);
		if (issue) {
			const run = await runIssue(ctx, settings, conn, issue, true, note);
			ctx.log.info(`PR #${r.pr}: agent asked to fix (attempt ${run.attempt})`);
		}
	}
	return next;
}

/**
 * Build the default branch and publish it to `static/<branch>`, which GitHub
 * Pages serves. Triggered by pushes to the branch and by content publishes.
 * Builds coalesce: a request during a running build re-runs it once after.
 */
async function buildDefaultBranch(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	why: string,
): Promise<{ started: boolean; reason?: string }> {
	if (!settings.agentKey) return { started: false, reason: "Agent key is not set in the plugin settings" };
	const branch = conn.branch;
	const existing = await getBranchBuild(ctx, branch);
	if (existing?.status === "running") {
		await putBuild(ctx, { ...existing, rebuild: true });
		return { started: false, reason: "build in progress — queued a rebuild" };
	}
	const sha = (await branchHead(ctx, conn, branch)) ?? "";
	const build: Build = {
		pr: 0,
		title: `${branch} (${why})`,
		author: conn.owner,
		headRef: branch,
		headSha: sha,
		staticBranch: staticBranchFor(branch),
		staticSha: existing?.staticSha,
		attempt: (existing?.attempt ?? 0) + 1,
		status: "running",
		updatedAt: now(),
	};
	await putBuild(ctx, build);
	try {
		await dispatchCi(ctx, settings, conn, {
			pr: 0,
			headRef: branch,
			headSha: sha,
			attempt: build.attempt,
			staticBranch: build.staticBranch,
			backendUrl: ctx.site.url,
			siteUrl: ctx.site.url,
			callbackUrl: ciCallbackUrl(ctx),
			preview: false,
		});
		return { started: true };
	} catch (error) {
		await putBuild(ctx, { ...build, status: "error", summary: String(error) });
		ctx.log.error(`branch ${branch}: ci dispatch failed`, error);
		return { started: false, reason: String(error) };
	}
}

/** A branch build finished: record it, switch Pages to the static branch once, honour queued rebuilds. */
async function recordBranchCi(ctx: PluginContext, settings: Settings, conn: Connection, r: CiResult): Promise<Build | null> {
	const build = await getBranchBuild(ctx, r.branch);
	if (!build || build.attempt !== r.attempt || build.status !== "running") return build;
	const next: Build = {
		...build,
		status: r.ok ? "passed" : "failed",
		staticSha: r.staticSha ?? build.staticSha,
		summary: r.ok ? `published to ${r.staticBranch}` : (firstFailure(r)?.name ?? r.error ?? "failed"),
		rebuild: false,
	};
	await putBuild(ctx, next);
	if (r.headSha) {
		await setStatus(ctx, conn, r.headSha, {
			state: r.ok ? "success" : "failure",
			context: STATUS_CONTEXT,
			description: r.ok ? `built → ${r.staticBranch}` : `${next.summary} (attempt ${r.attempt})`,
			targetUrl: `https://github.com/${conn.owner}/${conn.repo}/tree/${r.staticBranch}`,
		}).catch(() => undefined);
	}
	if (r.ok && r.staticSha) {
		const pages: { ok: boolean; url?: string; error?: string } = await servePagesFromBranch(ctx, conn, r.staticBranch).catch(
			(e) => ({ ok: false, error: String(e) }),
		);
		if (!pages.ok) ctx.log.warn(`Pages source not switched to ${r.staticBranch}: ${pages.error}`);
		else if (pages.url) await ctx.kv.set("pages:url", pages.url);
	}
	if (build.rebuild) await buildDefaultBranch(ctx, settings, conn, "queued rebuild");
	return next;
}

function pushFromEvent(input: unknown): { branch: string; after: string; deleted: boolean } | null {
	if (!isRecord(input) || typeof input.ref !== "string" || !input.ref.startsWith("refs/heads/")) return null;
	return { branch: input.ref.slice("refs/heads/".length), after: String(input.after ?? ""), deleted: input.deleted === true };
}

function pullFromEvent(input: unknown): { action: string; number: number; headSha: string; author: string } | null {
	if (!isRecord(input) || !isRecord(input.pull_request)) return null;
	const pr = input.pull_request;
	const number = Number(pr.number);
	if (!Number.isInteger(number) || number <= 0) return null;
	const head = isRecord(pr.head) ? pr.head : {};
	const user = isRecord(pr.user) ? pr.user : {};
	return { action: String(input.action ?? ""), number, headSha: String(head.sha ?? ""), author: String(user.login ?? "") };
}

// ── Plugin ───────────────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			for (const [k, v] of Object.entries(DEFAULTS)) {
				if (k === "agentKey" || k === "allowedUsers") continue;
				if ((await ctx.kv.get(`settings:${k}`)) === null) await ctx.kv.set(`settings:${k}`, v);
			}
			ctx.log.info("GitHub agent installed");
		},

		// Publishing content changes the static site: rebuild the default
		// branch (coalesced) so `static/<branch>` — what Pages serves — follows.
		"content:afterPublish": async (_event, ctx) => {
			const setup = await requireSetup(ctx);
			if (!setup.ok || !setup.settings.enabled) return;
			const r = await buildDefaultBranch(ctx, setup.settings, setup.conn, "content published");
			if (!r.started && r.reason) ctx.log.info(`rebuild not started: ${r.reason}`);
		},
	},

	routes: {
		/**
		 * GitHub `issues` events, forwarded by the parent control plane (it
		 * authenticates as the platform). Only `opened`/`labeled`/`reopened`
		 * matter, and the issue is re-read from GitHub before anything runs.
		 */
		webhook: {
			handler: async (routeCtx, ctx) => {
				const push = pushFromEvent(routeCtx.input);
				if (push) {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return { success: false, error: setup.error };
					if (!setup.settings.enabled) return { success: true, ignored: "disabled" };
					if (push.deleted || push.branch !== setup.conn.branch) {
						return { success: true, ignored: `push to ${push.branch}` };
					}
					const r = await buildDefaultBranch(ctx, setup.settings, setup.conn, `push ${push.after.slice(0, 7)}`);
					return { success: true, branch: push.branch, started: r.started, reason: r.reason };
				}
				const pull = pullFromEvent(routeCtx.input);
				if (pull) {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return { success: false, error: setup.error };
					if (pull.action === "closed") {
						const build = await getBuild(ctx, pull.number);
						if (build) {
							const deleted = build.previewUrl
								? await deletePreview(ctx, setup.settings, setup.conn, pull.number).catch(() => false)
								: false;
							await putBuild(ctx, {
								...build,
								status: build.status === "merged" ? "merged" : "closed",
								previewUrl: undefined,
								summary: `${build.status === "merged" ? build.summary : "closed"}; preview ${deleted ? "removed" : "not removed"}`,
							});
						}
						return { success: true, pr: pull.number, closed: true };
					}
					if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(pull.action)) {
						return { success: true, ignored: `action ${pull.action}` };
					}
					if (!setup.settings.enabled) return { success: true, ignored: "disabled" };
					const pr = await getPull(ctx, setup.conn, pull.number);
					if (!pr) return { success: true, ignored: "pull request not found" };
					if (pr.draft) return { success: true, ignored: "draft" };
					const r = await buildPull(ctx, setup.settings, setup.conn, pr);
					return { success: true, pr: pr.number, started: r.started, reason: r.reason, status: r.build?.status };
				}
				const ev = issueNumberFromEvent(routeCtx.input);
				if (!ev) return { success: true, ignored: "not an issue event" };
				if (!["opened", "labeled", "reopened"].includes(ev.action)) {
					return { success: true, ignored: `action ${ev.action}` };
				}
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				if (!setup.settings.enabled) return { success: true, ignored: "disabled" };
				if (ev.action === "labeled" && ev.label && ev.label !== setup.settings.label) {
					return { success: true, ignored: `label ${ev.label}` };
				}
				const issue = await getIssue(ctx, setup.conn, ev.number);
				if (!issue) return { success: true, ignored: "issue not found" };
				if (!issue.labels.includes(setup.settings.label)) {
					return { success: true, ignored: "trigger label not present" };
				}
				const run = await runIssue(ctx, setup.settings, setup.conn, issue);
				return { success: true, run: { number: run.number, status: run.status, reason: run.reason } };
			},
		},

		/** The agent worker's signed outcome for a run. */
		"agent-callback": {
			public: true,
			handler: async (routeCtx, ctx) => {
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const cb: Callback = {
					issue: Number(input.issue),
					attempt: Number(input.attempt),
					submissionId: String(input.submissionId ?? ""),
					status: String(input.status ?? ""),
					answer: typeof input.answer === "string" ? input.answer : null,
					prUrl: typeof input.prUrl === "string" ? input.prUrl : null,
				};
				const settings = await readSettings(ctx);
				const given = headerOf(routeCtx.request, "X-Agent-Signature").replace(/^sha256=/, "");
				if (!settings.agentKey || !given) return { success: false, error: "unsigned" };
				const expected = await hmacHex(settings.agentKey, canonicalCallback(cb));
				if (!timingSafeEqual(given, expected)) return { success: false, error: "bad signature" };

				const run = await getRun(ctx, cb.issue);
				if (!run || run.submissionId !== cb.submissionId) return { success: true, ignored: "unknown run" };
				const next = applyOutcome(run, cb.status, cb.answer);
				if (cb.prUrl && !next.prUrl) next.prUrl = cb.prUrl;
				await putRun(ctx, next);
				return { success: true, status: next.status };
			},
		},

		/** The agent worker's signed CI result for a pull request (same payload as its direct response). */
		"ci-callback": {
			public: true,
			handler: async (routeCtx, ctx) => {
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const settings = await readSettings(ctx);
				const given = headerOf(routeCtx.request, "X-Agent-Signature").replace(/^sha256=/, "");
				if (!settings.agentKey || !given) return { success: false, error: "unsigned" };
				const r = input as unknown as CiResult;
				const expected = await hmacHex(settings.agentKey, canonicalCi(r));
				if (!timingSafeEqual(given, expected)) return { success: false, error: "bad signature" };
				const conn = await getConnection(ctx);
				if (!conn) return { success: false, error: "GitHub not connected" };
				const build = r.pr > 0 ? await recordCi(ctx, settings, conn, r) : await recordBranchCi(ctx, settings, conn, r);
				return { success: true, status: build?.status ?? "unknown" };
			},
		},

		/** Build the default branch now and publish it to static/<branch>. */
		"site/build": {
			handler: async (_routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const r = await buildDefaultBranch(ctx, setup.settings, setup.conn, "manual");
				return { success: r.started, reason: r.reason, build: await getBranchBuild(ctx, setup.conn.branch) };
			},
		},

		/** Pull requests the plugin has built, newest first. */
		pulls: {
			handler: async (_routeCtx, ctx) => ({ success: true, items: await listBuilds(ctx, 50) }),
		},

		/** Build one PR now (whitelist applies; `force: true` ignores the attempt cap). */
		"pulls/build": {
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const number = Number(input.number);
				if (!Number.isInteger(number) || number <= 0) return { success: false, error: "PR number required." };
				const pr = await getPull(ctx, setup.conn, number);
				if (!pr) return { success: false, error: `PR #${number} not found.` };
				const r = await buildPull(ctx, setup.settings, setup.conn, pr, { force: input.force === true });
				return { success: r.started, reason: r.reason, build: r.build };
			},
		},

		/** Open issues on the connected repo, with the agent's state per issue. */
		issues: {
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error, items: [] };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const issues = await listIssues(ctx, setup.conn, {
					label: typeof input.label === "string" ? input.label : undefined,
					limit: 50,
				});
				const items = [];
				for (const issue of issues) {
					const run = await getRun(ctx, issue.number);
					items.push({
						...issue,
						whitelisted: allowed(setup.settings, issue.author),
						agent: run ? { status: run.status, prUrl: run.prUrl, reason: run.reason, attempt: run.attempt } : null,
					});
				}
				return { success: true, repo: `${setup.conn.owner}/${setup.conn.repo}`, items };
			},
		},

		/** Create an issue; `agent: true` also applies the trigger label. */
		"issues/create": {
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const title = typeof input.title === "string" ? input.title.trim() : "";
				if (!title) return { success: false, error: "A title is required." };
				const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
				if (input.agent === true && !labels.includes(setup.settings.label)) labels.push(setup.settings.label);
				const issue = await createIssue(ctx, setup.conn, {
					title,
					body: typeof input.body === "string" ? input.body : "",
					labels,
				});
				return { success: true, issue };
			},
		},

		/** Hand one issue to the agent now (whitelist still applies); `again: true` retries a finished run. */
		"issues/run": {
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const number = Number(input.number);
				if (!Number.isInteger(number) || number <= 0) return { success: false, error: "Issue number required." };
				const issue = await getIssue(ctx, setup.conn, number);
				if (!issue) return { success: false, error: `Issue #${number} not found.` };
				if (!issue.labels.includes(setup.settings.label)) {
					await addLabels(ctx, setup.conn, number, [setup.settings.label]);
				}
				const run = await runIssue(ctx, setup.settings, setup.conn, issue, input.again === true);
				return { success: run.status !== "error" && run.status !== "skipped", run };
			},
		},

		/** Manual reconcile: dispatch labelled issues not seen yet, refresh in-flight runs. */
		poll: {
			handler: async (_routeCtx, ctx) => {
				const r = await poll(ctx);
				return { success: !r.error, ...r };
			},
		},

		/** Post a comment on an issue with the site's connection. */
		"issues/comment": {
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const number = Number(input.number);
				const body = typeof input.body === "string" ? input.body.trim() : "";
				if (!Number.isInteger(number) || !body) return { success: false, error: "number and body required." };
				await comment(ctx, setup.conn, number, body);
				return { success: true };
			},
		},

		settings: {
			handler: async (_routeCtx, ctx) => {
				const s = await readSettings(ctx);
				return { ...s, agentKey: s.agentKey ? "set" : "" };
			},
		},

		"settings/save": {
			handler: async (routeCtx, ctx) => {
				await saveSettings(ctx, isRecord(routeCtx.input) ? routeCtx.input : {});
				const settings = await readSettings(ctx);
				return { success: true, settings: { ...settings, agentKey: settings.agentKey ? "set" : "" } };
			},
		},

		admin: {
			handler: async (routeCtx, ctx) => {
				const i = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: unknown;
					values?: Record<string, unknown>;
				};
				if (i.type === "page_load" && i.page === "widget:agent-runs") return buildWidget(ctx);
				if (i.type === "form_submit" && i.action_id === "save_settings") {
					await saveSettings(ctx, i.values ?? {});
					return buildPage(ctx, "Settings saved.");
				}
				if (i.type === "form_submit" && i.action_id === "create_issue") {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return buildPage(ctx, setup.error);
					const v = i.values ?? {};
					const title = typeof v.title === "string" ? v.title.trim() : "";
					if (!title) return buildPage(ctx, "A title is required.");
					const labels = v.agent === true ? [setup.settings.label] : [];
					try {
						const issue = await createIssue(ctx, setup.conn, {
							title,
							body: typeof v.body === "string" ? v.body : "",
							labels,
						});
						return buildPage(
							ctx,
							`Issue #${issue.number} created${labels.length ? " — the agent starts as soon as GitHub delivers the event" : ""}.`,
						);
					} catch (error) {
						return buildPage(ctx, String(error));
					}
				}
				if (i.type === "form_submit" && i.action_id === "run_issue") {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return buildPage(ctx, setup.error);
					const number = Number(i.values?.number);
					const issue = Number.isInteger(number) && number > 0 ? await getIssue(ctx, setup.conn, number) : null;
					if (!issue) return buildPage(ctx, `Issue #${number} not found.`);
					if (!issue.labels.includes(setup.settings.label)) {
						await addLabels(ctx, setup.conn, number, [setup.settings.label]).catch(() => undefined);
					}
					const run = await runIssue(ctx, setup.settings, setup.conn, issue, i.values?.again === true);
					return buildPage(
						ctx,
						run.status === "queued"
							? `Issue #${number} handed to the agent (attempt ${run.attempt ?? 1}).`
							: `Issue #${number}: ${run.status}${run.reason ? ` — ${run.reason}` : ""}`,
					);
				}
				if (i.type === "form_submit" && i.action_id === "build_pr") {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return buildPage(ctx, setup.error);
					const number = Number(i.values?.number);
					const pr = Number.isInteger(number) && number > 0 ? await getPull(ctx, setup.conn, number) : null;
					if (!pr) return buildPage(ctx, `PR #${number} not found.`);
					const r = await buildPull(ctx, setup.settings, setup.conn, pr, { force: i.values?.force === true });
					return buildPage(ctx, r.started ? `PR #${number}: ${r.build?.status ?? "built"} (attempt ${r.build?.attempt}).` : `PR #${number}: ${r.reason}`);
				}
				if (i.type === "block_action" && i.action_id === "build_site") {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return buildPage(ctx, setup.error);
					const r = await buildDefaultBranch(ctx, setup.settings, setup.conn, "manual");
					return buildPage(ctx, r.started ? `Building ${setup.conn.branch}…` : `Not started: ${r.reason}`);
				}
				if (i.type === "block_action" && i.action_id === "poll_now") {
					const r = await poll(ctx);
					return buildPage(ctx, r.error ?? `Reconciled: ${r.dispatched} dispatched, ${r.refreshed} updated.`);
				}
				return buildPage(ctx);
			},
		},
	},
};

export default plugin;

// ── Admin page ───────────────────────────────────────────────────────────

const STATUS_LABEL: Record<Run["status"], string> = {
	queued: "queued",
	running: "working",
	completed: "done",
	error: "failed",
	skipped: "skipped",
};

async function buildPage(ctx: PluginContext, notice?: string) {
	const settings = await readSettings(ctx);
	const conn = await getConnection(ctx);
	const blocks: unknown[] = [{ type: "header", text: "GitHub Agent" }];
	if (notice) blocks.push({ type: "banner", description: notice });

	if (!conn) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "GitHub is not connected",
			description:
				"Connect the site's GitHub repository in Settings → General. The agent uses that connection to read issues and open pull requests.",
		});
	} else {
		blocks.push({
			type: "context",
			text: `Repository ${conn.owner}/${conn.repo} (${conn.branch}). Issues labelled "${settings.label}" by whitelisted users are handed to the agent the moment GitHub reports them${settings.enabled ? "" : " — currently OFF"}.`,
		});
		if (settings.allowedUsers.length === 0) {
			blocks.push({
				type: "banner",
				variant: "alert",
				title: "No whitelisted users",
				description: "Add GitHub usernames below. The agent only works on issues raised by them.",
			});
		}
		if (!settings.agentKey) {
			blocks.push({
				type: "banner",
				variant: "alert",
				title: "Agent key missing",
				description: "Paste the agent worker's key below. Runs stay disabled until it is set.",
			});
		}

		let issues: Issue[] = [];
		let listError = "";
		try {
			issues = await listIssues(ctx, conn, { limit: 30 });
		} catch (error) {
			listError = String(error);
		}
		const runs = new Map<number, Run>();
		for (const r of await listRuns(ctx, 100)) runs.set(r.number, r);

		const inFlight = [...runs.values()].filter((r) => r.status === "queued" || r.status === "running").length;
		const done = [...runs.values()].filter((r) => r.status === "completed").length;
		blocks.push({
			type: "stats",
			items: [
				{ label: "Open issues", value: issues.length },
				{ label: "Agent working", value: inFlight },
				{ label: "PRs opened", value: [...runs.values()].filter((r) => r.prUrl).length, description: `${done} runs finished` },
			],
		});
		const site = await getBranchBuild(ctx, conn.branch);
		const pagesUrl = await ctx.kv.get<string>("pages:url");
		blocks.push({
			type: "context",
			text: site
				? `Site (${conn.branch}): ${site.status}${site.summary ? ` — ${site.summary}` : ""}${site.staticSha ? ` @ ${site.staticSha.slice(0, 7)}` : ""}${pagesUrl ? ` · served by GitHub Pages from ${site.staticBranch} (${pagesUrl})` : ""}`
				: `Site (${conn.branch}): not built by the platform yet — pushes to ${conn.branch} and content publishes build it to ${staticBranchFor(conn.branch)}.`,
		});
		blocks.push({
			type: "actions",
			elements: [
				{ type: "button", action_id: "build_site", label: `Build ${conn.branch} now`, style: "primary" },
				{ type: "button", action_id: "poll_now", label: "Reconcile now", style: "secondary" },
			],
		});
		blocks.push({ type: "divider" });
		blocks.push({
			type: "table",
			block_id: "issues",
			page_action_id: "issues_page",
			empty_text: listError || "No open issues.",
			columns: [
				{ key: "number", label: "#", format: "code" },
				{ key: "title", label: "Title", format: "text" },
				{ key: "author", label: "Author", format: "text" },
				{ key: "labels", label: "Labels", format: "text" },
				{ key: "agent", label: "Agent", format: "badge" },
				{ key: "result", label: "Result", format: "text" },
				{ key: "created", label: "Opened", format: "relative_time" },
			],
			rows: issues.map((i) => {
				const run = runs.get(i.number);
				return {
					number: String(i.number),
					title: i.title,
					author: `${i.author}${allowed(settings, i.author) ? "" : " (not whitelisted)"}`,
					labels: i.labels.join(", ") || "-",
					agent: run ? STATUS_LABEL[run.status] : i.labels.includes(settings.label) ? "pending" : "-",
					result: run?.prUrl ?? run?.reason ?? run?.answer ?? "",
					created: i.createdAt,
				};
			}),
		});
		const builds = await listBuilds(ctx, 30);
		blocks.push({ type: "divider" });
		blocks.push({ type: "section", text: "Pull requests built by the platform (check:cf → build → static branch → test:cf → Cloudflare preview → test:preview:cf)." });
		blocks.push({
			type: "table",
			block_id: "pulls",
			page_action_id: "pulls_page",
			empty_text: "No pull requests built yet — PRs from whitelisted users are built as GitHub reports them.",
			columns: [
				{ key: "pr", label: "PR", format: "code" },
				{ key: "title", label: "Title", format: "text" },
				{ key: "branch", label: "Branch", format: "code" },
				{ key: "status", label: "CI", format: "badge" },
				{ key: "attempt", label: "Attempt", format: "text" },
				{ key: "static", label: "Static branch", format: "code" },
				{ key: "preview", label: "Preview", format: "text" },
				{ key: "summary", label: "Result", format: "text" },
				{ key: "updated", label: "Updated", format: "relative_time" },
			],
			rows: builds.map((b) => ({
				pr: b.pr > 0 ? `#${b.pr}` : b.headRef,
				title: b.title,
				branch: b.headRef,
				status: b.status,
				attempt: `${b.attempt} / ${settings.maxBuildAttempts}`,
				static: b.staticSha ? `${b.staticBranch} @ ${b.staticSha.slice(0, 7)}` : b.staticBranch,
				preview: b.previewUrl ?? "-",
				summary: b.summary ?? "",
				updated: b.updatedAt,
			})),
		});
		blocks.push({
			type: "form",
			block_id: "build-pr",
			fields: [
				{ type: "number_input", action_id: "number", label: "Build pull request #", min: 1 },
				{ type: "toggle", action_id: "force", label: "Ignore the attempt cap", initial_value: false },
			],
			submit: { label: "Build now", action_id: "build_pr" },
		});
		blocks.push({ type: "divider" });
		blocks.push({
			type: "form",
			block_id: "new-issue",
			fields: [
				{ type: "text_input", action_id: "title", label: "Title" },
				{ type: "text_input", action_id: "body", label: "Description", multiline: true },
				{
					type: "toggle",
					action_id: "agent",
					label: "Hand to the agent",
					description: `Adds the "${settings.label}" label.`,
					initial_value: true,
				},
			],
			submit: { label: "Create issue", action_id: "create_issue" },
		});
		blocks.push({
			type: "form",
			block_id: "run-issue",
			fields: [
				{ type: "number_input", action_id: "number", label: "Run the agent on issue #", min: 1 },
				{ type: "toggle", action_id: "again", label: "Run again even if it already finished", initial_value: false },
			],
			submit: { label: "Run now", action_id: "run_issue" },
		});
	}

	blocks.push({ type: "divider" });
	blocks.push({
		type: "form",
		block_id: "settings",
		fields: [
			{ type: "toggle", action_id: "enabled", label: "React to labelled issues", initial_value: settings.enabled },
			{ type: "text_input", action_id: "label", label: "Trigger label", initial_value: settings.label },
			{
				type: "text_input",
				action_id: "allowedUsers",
				label: "Whitelisted GitHub users",
				placeholder: "octocat, another-user",
				initial_value: settings.allowedUsers.join(", "),
			},
			{
				type: "number_input",
				action_id: "maxBuildAttempts",
				label: "Max build attempts per PR",
				initial_value: settings.maxBuildAttempts,
				min: 1,
				max: 10,
			},
			{
				type: "toggle",
				action_id: "autoMerge",
				label: "Auto-merge pull requests that pass every check",
				description: "Squash-merges into the default branch, which rebuilds the site.",
				initial_value: settings.autoMerge,
			},
			{ type: "text_input", action_id: "agentUrl", label: "Agent worker URL", initial_value: settings.agentUrl },
			{
				type: "secret_input",
				action_id: "agentKey",
				label: settings.agentKey ? "Agent key (set — leave blank to keep)" : "Agent key",
			},
			{ type: "text_input", action_id: "model", label: "Model", initial_value: settings.model },
			{
				type: "select",
				action_id: "reasoning",
				label: "Reasoning effort",
				options: [
					{ label: "High (slow, thorough)", value: "high" },
					{ label: "Medium", value: "medium" },
					{ label: "Low", value: "low" },
				],
				initial_value: settings.reasoning,
			},
		],
		submit: { label: "Save settings", action_id: "save_settings" },
	});
	return { blocks };
}

async function buildWidget(ctx: PluginContext) {
	const runs = (await listRuns(ctx, 5)).filter((r) => r.status !== "skipped");
	if (runs.length === 0) return { blocks: [{ type: "context", text: "No agent runs yet." }] };
	return {
		blocks: [
			{
				type: "fields",
				fields: runs.map((r) => ({
					label: `#${r.number} ${r.title}`,
					value: r.prUrl ?? `${STATUS_LABEL[r.status]}${r.reason ? ` · ${r.reason}` : ""}`,
				})),
			},
		],
	};
}
