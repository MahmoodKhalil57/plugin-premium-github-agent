/**
 * GitHub Agent — issues on the site's connected repo, and a coding agent
 * driven entirely by slash-commands in issue and pull-request comments.
 *
 *   commands  `/agent-issue` on an issue summons the agent. `/awaiting-test`
 *             on a PR runs the platform checks. The runner answers per stage
 *             with `/check-succeeded` | `/check-failed`, `/test-succeeded` |
 *             `/test-failed`, `/preview-ready <url>` | `/preview-build-failed`,
 *             `/preview-test-succeeded` | `/preview-test-failed`, `/merged`.
 *             A `/…-failed` on the agent's own PR sends it back to fix.
 *             Only whitelisted GitHub users' commands count.
 *   github    the site's GitHub connection (`ctx.github`) is the only
 *             credential; nothing is stored beyond the plugin's own settings.
 *   webhook   GitHub → the platform's GitHub App webhook → the parent control
 *             plane routes the event by repository → this plugin's `webhook`
 *             route. Issues and PRs are re-read from GitHub before anything
 *             happens, so the event is only ever a hint.
 *   agent     a Cloudflare Worker running a Think agent (Workers AI +
 *             GitHub MCP). It reads the repo, writes a branch, opens a PR and
 *             leaves it open, then calls back (`agent-callback`, HMAC-signed).
 *             No code is ever executed — dry coding only.
 *   site      pushes to the default branch and content publishes rebuild
 *             `static/<branch>` (what GitHub Pages serves). The two previous
 *             deployments stay on `static/<branch>-b-1` / `-b-2`, each hosted
 *             as its own preview Worker, so "live", one back and two back are
 *             always there.
 *   storage   `runs` — one row per issue the agent was asked about;
 *             `builds` — one row per PR / built branch.
 *   admin     /github-agent page: issues, runs, "new issue", settings.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

import {
	canonicalCallback,
	canonicalCi,
	canonicalStage,
	ciStatus,
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
	type CiStageReport,
	type PreviousDeployment,
	type Run,
} from "./agent.js";
import {
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

/** The comment vocabulary. Anything else in a comment is just text. */
const COMMANDS = [
	"agent-issue",
	"awaiting-test",
	"check-succeeded",
	"check-failed",
	"test-succeeded",
	"test-failed",
	"preview-ready",
	"preview-build-failed",
	"preview-test-succeeded",
	"preview-test-failed",
	"merged",
] as const;
type Command = (typeof COMMANDS)[number];
const FAILURE_COMMANDS: Command[] = ["check-failed", "test-failed", "preview-build-failed", "preview-test-failed"];
const COMMAND_RE = new RegExp(`(?:^|\\s)/(${COMMANDS.join("|")})(?=\\s|$)`, "g");

/** Every command mentioned in a comment body, in order, deduplicated. */
function commandsIn(body: string): Command[] {
	const out: Command[] = [];
	for (const m of body.matchAll(COMMAND_RE)) {
		const c = m[1] as Command;
		if (!out.includes(c)) out.push(c);
	}
	return out;
}
const STATUS_CONTEXT = "premium-cms/ci";
/** Deployments of the default branch kept behind the live one (`static/<branch>-b-1` … `-b-N`). */
const PREVIOUS_DEPLOYMENTS = 2;
/** A build still "running" after this long lost its callback; a new one may start. */
const STALE_BUILD_MS = 30 * 60 * 1000;

function isStale(b: { status: string; updatedAt: string }): boolean {
	return b.status === "running" && Date.now() - Date.parse(b.updatedAt) > STALE_BUILD_MS;
}
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
	const attempt = existing ? (again ? (existing.attempt ?? 1) + 1 : (existing.attempt ?? 1)) : 1;

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

/** Manual reconcile: refresh in-flight runs and builds from the worker. */
async function poll(ctx: PluginContext): Promise<{ dispatched: number; refreshed: number; error?: string }> {
	const setup = await requireSetup(ctx);
	if (!setup.ok) return { dispatched: 0, refreshed: 0, error: setup.error };
	const { conn, settings } = setup;
	const dispatched = 0;

	let refreshed = 0;
	for (const run of await listRuns(ctx, 50)) {
		if (run.status !== "queued" && run.status !== "running") continue;
		const after = await refreshRun(ctx, settings, conn, run);
		if (after.status !== run.status) refreshed++;
	}
	// Builds whose callback never arrived: take the worker's stored result.
	for (const b of await listBuilds(ctx, 50)) {
		if (b.status !== "running") continue;
		try {
			const s = await ciStatus(ctx, settings, conn, { pr: b.pr, branch: b.pr > 0 ? undefined : b.headRef });
			if (s.last && s.last.attempt === b.attempt && (!s.running || s.running.attempt !== b.attempt)) {
				const after = b.pr > 0 ? await recordCi(ctx, settings, conn, s.last) : await recordBranchCi(ctx, settings, conn, s.last);
				if (after && after.status !== "running") refreshed++;
			}
		} catch (error) {
			ctx.log.warn(`build ${b.pr > 0 ? `#${b.pr}` : b.headRef}: status check failed`, error);
		}
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
	/** Branch builds: the deployments before the live one (`-b-1`, `-b-2`) and their preview Workers. */
	previous?: PreviousDeployment[];
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

function stageComment(r: CiStageReport): string {
	const head = `\`${r.branch}\` @ ${r.headSha.slice(0, 7)}, attempt ${r.attempt}`;
	const detail = r.log.trim() ? ["", "<details><summary>output</summary>", "", "```", r.log.trim().slice(-5000), "```", "", "</details>"] : [];
	switch (r.stage) {
		case "check":
			return r.ok
				? [`/check-succeeded`, `check:cf and build passed — ${head} (${r.seconds}s). ${r.log.trim()}`].join("\n")
				: [`/check-failed`, `check or build failed — ${head} (${r.seconds}s).`, ...detail].join("\n");
		case "test":
			return r.ok
				? [`/test-succeeded`, `test:cf passed — ${head} (${r.seconds}s).`].join("\n")
				: [`/test-failed`, `test:cf failed — ${head} (${r.seconds}s).`, ...detail].join("\n");
		case "preview":
			return r.ok && r.previewUrl
				? [`/preview-ready ${r.previewUrl}`, `Preview of ${head} is live at ${r.previewUrl} (${r.seconds}s).`].join("\n")
				: [`/preview-build-failed`, `Hosting the preview failed — ${head} (${r.seconds}s).`, ...detail].join("\n");
		case "previewTest":
			return r.ok
				? [`/preview-test-succeeded`, `test:preview:cf passed against ${r.previewUrl ?? "the preview"} — ${head} (${r.seconds}s).`].join("\n")
				: [`/preview-test-failed`, `test:preview:cf failed against ${r.previewUrl ?? "the preview"} — ${head} (${r.seconds}s).`, ...detail].join("\n");
	}
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
	if (existing?.status === "running" && existing.headSha === pr.headSha && !opts.force && !isStale(existing)) {
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
 * Apply a finished run: store it, set the commit status, merge when green
 * (`/merged`). Per-stage `/…-succeeded` / `/…-failed` comments were already
 * posted by `ci-stage`; a failure comment on an agent PR is what sends the
 * agent back (see the `issue_comment` handling), bounded by `maxBuildAttempts`.
 * Idempotent per (pr, attempt).
 */
async function recordCi(ctx: PluginContext, settings: Settings, conn: Connection, r: CiResult): Promise<Build | null> {
	const build = await getBuild(ctx, r.pr);
	if (!build) return null;
	if (build.attempt !== r.attempt || build.status !== "running") return build;

	let next: Build = {
		...build,
		status: r.ok ? "passed" : "failed",
		staticSha: r.staticSha ?? build.staticSha,
		previewUrl: r.previewUrl ?? build.previewUrl,
		summary: r.ok ? `passed on attempt ${r.attempt}` : (firstFailure(r)?.name ?? r.error ?? "failed"),
	};
	if (!r.ok && build.issue !== undefined && r.attempt >= settings.maxBuildAttempts) next = { ...next, status: "capped" };
	await putBuild(ctx, next);

	await setStatus(ctx, conn, r.headSha, {
		state: r.ok ? "success" : "failure",
		context: STATUS_CONTEXT,
		description: r.ok ? `passed (attempt ${r.attempt}); static: ${r.staticBranch}` : `${next.summary} (attempt ${r.attempt})`,
		targetUrl: r.previewUrl ?? `https://github.com/${conn.owner}/${conn.repo}/pull/${r.pr}`,
	}).catch(() => undefined);

	// A run that died before any stage ran (platform trouble, not the code):
	// say so on the PR; the stage reports never had a chance to.
	if (!r.ok && !firstFailure(r)) {
		next = { ...next, status: "error" };
		await putBuild(ctx, next);
		await comment(
			ctx,
			conn,
			r.pr,
			`Platform error while building attempt ${r.attempt}: ${r.error ?? "unknown"}. Nothing was tested. Comment \`/awaiting-test\` to try again.`,
		).catch(() => undefined);
		return next;
	}

	if (next.status === "capped") {
		await comment(ctx, conn, r.pr, `Build attempts exhausted (${settings.maxBuildAttempts}); a human needs to take it from here.`).catch(() => undefined);
	}

	if (r.ok && settings.autoMerge) {
		const m: { merged: boolean; sha?: string; message: string } = await mergePull(ctx, conn, r.pr, build.title).catch(
			(e) => ({ merged: false, message: String(e) }),
		);
		if (m.merged) {
			next = { ...next, status: "merged", summary: `merged into ${conn.branch}${m.sha ? ` @ ${m.sha.slice(0, 7)}` : ""}` };
			await putBuild(ctx, next);
			await comment(ctx, conn, r.pr, [`/merged`, `Every check passed — squash-merged into \`${conn.branch}\`${m.sha ? ` (${m.sha.slice(0, 7)})` : ""}; \`${staticBranchFor(conn.branch)}\` rebuilds from it.`].join("\n")).catch(() => undefined);
			ctx.log.info(`PR #${r.pr} merged into ${conn.branch}`, { sha: m.sha });
		} else {
			await comment(ctx, conn, r.pr, `Could not merge automatically: ${m.message}. The PR stays open for a human.`).catch(() => undefined);
			ctx.log.warn(`PR #${r.pr}: auto-merge refused: ${m.message}`);
		}
	}
	return next;
}

/** A `/…-failed` report on the agent's own PR: hand the output back to the agent, if attempts remain. */
async function agentFix(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	pr: PullRequest,
	command: Command,
	body: string,
): Promise<{ started: boolean; reason?: string }> {
	const issueNo = Number(pr.headRef.match(AGENT_BRANCH)?.[1]);
	if (!Number.isInteger(issueNo)) return { started: false, reason: "not an agent branch" };
	const build = await getBuild(ctx, pr.number);
	if (build && build.attempt >= settings.maxBuildAttempts) {
		return { started: false, reason: `reached ${settings.maxBuildAttempts} build attempts` };
	}
	const issue = await getIssue(ctx, conn, issueNo);
	if (!issue) return { started: false, reason: `issue #${issueNo} not found` };
	const note = [
		`The platform reported \`/${command}\` on your pull request #${pr.number} (branch \`${pr.headRef}\`, commit ${pr.headSha.slice(0, 7)}):`,
		"",
		body.trim().slice(-8000),
		"",
		"Fix the cause and push the corrected files to that same branch (no new branch or PR). Then comment on the PR with what you changed and `/awaiting-test` on its own line.",
	].join("\n");
	const run = await runIssue(ctx, settings, conn, issue, true, note);
	return { started: run.status === "queued", reason: run.reason };
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
	if (existing?.status === "running" && !isStale(existing)) {
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
		previous: existing?.previous,
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
			previous: PREVIOUS_DEPLOYMENTS,
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
		previous: r.previous?.length ? r.previous : build.previous,
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

/** A command-bearing event: a freshly opened issue whose body has one, or a new comment. */
function commandEvent(
	input: Record<string, unknown>,
): { number: number; isPull: boolean; author: string; body: string; commands: Command[] } | null {
	const issue = isRecord(input.issue) ? input.issue : null;
	if (!issue) return null;
	const number = Number(issue.number);
	if (!Number.isInteger(number) || number <= 0) return null;
	const isPull = isRecord(issue.pull_request);
	const commentObj = isRecord(input.comment) ? input.comment : null;
	if (commentObj) {
		if (input.action !== "created") return null;
		const body = String(commentObj.body ?? "");
		const commands = commandsIn(body);
		if (!commands.length) return null;
		const user = isRecord(commentObj.user) ? commentObj.user : {};
		return { number, isPull, author: String(user.login ?? ""), body, commands };
	}
	if (input.action !== "opened" || isPull) return null;
	const body = String(issue.body ?? "");
	const commands = commandsIn(body).filter((c) => c === "agent-issue");
	if (!commands.length) return null;
	const user = isRecord(issue.user) ? issue.user : {};
	return { number, isPull, author: String(user.login ?? ""), body, commands };
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
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};

				// Pushes to the default branch rebuild the site.
				const push = pushFromEvent(input);
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

				// Closed PRs: drop the preview. Nothing else about PRs is implicit.
				const pull = pullFromEvent(input);
				if (pull) {
					if (pull.action !== "closed") return { success: true, ignored: `pull_request ${pull.action}` };
					const setup = await requireSetup(ctx);
					if (!setup.ok) return { success: false, error: setup.error };
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

				// Commands: a new issue whose body carries one, or a new comment.
				const cmd = commandEvent(input);
				if (!cmd) return { success: true, ignored: "no command" };
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				if (!setup.settings.enabled) return { success: true, ignored: "disabled" };
				if (!allowed(setup.settings, cmd.author)) return { success: true, ignored: `@${cmd.author} is not whitelisted` };
				const handled: Record<string, unknown> = {};

				for (const command of cmd.commands) {
					if (command === "agent-issue" && !cmd.isPull) {
						const issue = await getIssue(ctx, setup.conn, cmd.number);
						if (!issue) return { success: true, ignored: "issue not found" };
						const run = await runIssue(ctx, setup.settings, setup.conn, issue, true);
						handled[command] = { status: run.status, attempt: run.attempt, reason: run.reason };
					} else if (command === "awaiting-test" && cmd.isPull) {
						const pr = await getPull(ctx, setup.conn, cmd.number);
						if (!pr) return { success: true, ignored: "pull request not found" };
						const r = await buildPull(ctx, setup.settings, setup.conn, pr);
						handled[command] = { started: r.started, reason: r.reason, attempt: r.build?.attempt };
					} else if (FAILURE_COMMANDS.includes(command) && cmd.isPull) {
						const pr = await getPull(ctx, setup.conn, cmd.number);
						if (!pr || pr.state !== "open") return { success: true, ignored: "pull request not open" };
						handled[command] = await agentFix(ctx, setup.settings, setup.conn, pr, command, cmd.body);
					}
				}
				return { success: true, number: cmd.number, handled };
			},
		},

		/** A per-stage report from the worker while a PR build runs: one `/…` comment each. */
		"ci-stage": {
			public: true,
			handler: async (routeCtx, ctx) => {
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const settings = await readSettings(ctx);
				const given = headerOf(routeCtx.request, "X-Agent-Signature").replace(/^sha256=/, "");
				if (!settings.agentKey || !given) return { success: false, error: "unsigned" };
				const r: CiStageReport = {
					pr: Number(input.pr),
					branch: String(input.branch ?? ""),
					attempt: Number(input.attempt),
					headSha: String(input.headSha ?? ""),
					stage: input.stage as CiStageReport["stage"],
					ok: input.ok === true,
					log: typeof input.log === "string" ? input.log : "",
					seconds: Number(input.seconds) || 0,
					previewUrl: typeof input.previewUrl === "string" ? input.previewUrl : null,
				};
				const expected = await hmacHex(settings.agentKey, canonicalStage(r));
				if (!timingSafeEqual(given, expected)) return { success: false, error: "bad signature" };
				if (!["check", "test", "preview", "previewTest"].includes(r.stage) || !(r.pr > 0)) {
					return { success: true, ignored: "not a PR stage" };
				}
				const conn = await getConnection(ctx);
				if (!conn) return { success: false, error: "GitHub not connected" };
				const build = await getBuild(ctx, r.pr);
				if (!build || build.attempt !== r.attempt) return { success: true, ignored: "stale stage" };
				if (r.stage === "preview" && r.ok && r.previewUrl) await putBuild(ctx, { ...build, previewUrl: r.previewUrl });
				await comment(ctx, conn, r.pr, stageComment(r));
				return { success: true, stage: r.stage, ok: r.ok };
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
				const text = typeof input.body === "string" ? input.body : "";
				const issue = await createIssue(ctx, setup.conn, {
					title,
					body: input.agent === true && !commandsIn(text).includes("agent-issue") ? `${text.trimEnd()}\n\n/agent-issue` : text,
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
				if (i.type === "page_load" && i.page === "widget:deployments") return buildDeploymentsWidget(ctx);
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
					const text = typeof v.body === "string" ? v.body : "";
					try {
						const issue = await createIssue(ctx, setup.conn, {
							title,
							body: v.agent === true ? `${text.trimEnd()}\n\n/agent-issue` : text,
							labels: [],
						});
						return buildPage(
							ctx,
							`Issue #${issue.number} created${v.agent === true ? " — the agent starts as soon as GitHub delivers the event" : ""}.`,
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
			text: `Repository ${conn.owner}/${conn.repo} (${conn.branch}). Whitelisted users drive the agent with comments: /agent-issue on an issue, /awaiting-test on a pull request; the runner answers with /check-…, /test-…, /preview-ready, /preview-test-… and /merged${settings.enabled ? "" : " — currently OFF"}.`,
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
			type: "table",
			block_id: "deployments",
			page_action_id: "deployments_page",
			empty_text: `No previous deployments kept yet — each build keeps the last ${PREVIOUS_DEPLOYMENTS} on ${staticBranchFor(conn.branch)}-b-1 … -b-${PREVIOUS_DEPLOYMENTS}, each with its own preview URL.`,
			columns: [
				{ key: "slot", label: "Deployment", format: "text" },
				{ key: "branch", label: "Branch", format: "code" },
				{ key: "url", label: "URL", format: "link" },
			],
			rows: deploymentRows(ctx.site.url, site, pagesUrl),
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
					agent: run ? STATUS_LABEL[run.status] : "-",
					result: run?.prUrl ?? run?.reason ?? run?.answer ?? "",
					created: i.createdAt,
				};
			}),
		});
		const builds = await listBuilds(ctx, 30);
		blocks.push({ type: "divider" });
		blocks.push({ type: "section", text: "Pull requests built by the platform after /awaiting-test (check:cf → build → static branch → test:cf → Cloudflare preview → test:preview:cf → /merged)." });
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
				{ key: "preview", label: "Preview", format: "link" },
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
					description: "Ends the issue body with /agent-issue.",
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
			{ type: "toggle", action_id: "enabled", label: "React to /commands", initial_value: settings.enabled },
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
					value: r.prUrl ? withoutScheme(r.prUrl) : `${STATUS_LABEL[r.status]}${r.reason ? ` · ${r.reason}` : ""}`,
					...(r.prUrl ? { url: r.prUrl } : {}),
				})),
			},
		],
	};
}

function withoutScheme(url: string): string {
	return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Live, one back, two back: one row per slot, plus the GitHub Pages origin behind the live site. */
function deploymentRows(siteUrl: string, site: Build | null, pagesUrl: string | null | undefined) {
	const rows: Array<{ slot: string; branch: string; url: string }> = [];
	if (site?.staticSha) rows.push({ slot: "Live", branch: `${site.staticBranch} @ ${site.staticSha.slice(0, 7)}`, url: siteUrl });
	if (site?.staticSha && pagesUrl) rows.push({ slot: "Live (GitHub Pages origin)", branch: site.staticBranch, url: pagesUrl });
	for (const [i, p] of (site?.previous ?? []).entries()) {
		rows.push({ slot: `${i + 1} back`, branch: `${p.branch} @ ${p.sha.slice(0, 7)}`, url: p.previewUrl ?? "no preview" });
	}
	return rows;
}

/** Dashboard card: every URL that currently serves this site — live, the kept deployments, and open PR previews. */
async function buildDeploymentsWidget(ctx: PluginContext) {
	const conn = await getConnection(ctx);
	if (!conn) return { blocks: [{ type: "context", text: "Connect GitHub in Settings → General to build the site on the platform." }] };
	const site = await getBranchBuild(ctx, conn.branch);
	const pagesUrl = await ctx.kv.get<string>("pages:url");
	const fields: Array<{ label: string; value: string; url?: string }> = [];
	fields.push({
		label: site?.staticSha ? `Live — ${site.staticBranch} @ ${site.staticSha.slice(0, 7)}` : "Live",
		value: withoutScheme(ctx.site.url),
		url: ctx.site.url,
	});
	for (const [i, p] of (site?.previous ?? []).entries()) {
		fields.push({
			label: `${i + 1} back — ${p.branch} @ ${p.sha.slice(0, 7)}`,
			value: p.previewUrl ? withoutScheme(p.previewUrl) : "no preview",
			...(p.previewUrl ? { url: p.previewUrl } : {}),
		});
	}
	for (const b of (await listBuilds(ctx, 50)).filter((b) => b.pr > 0 && b.previewUrl)) {
		fields.push({ label: `PR #${b.pr} — ${b.title}`, value: withoutScheme(b.previewUrl!), url: b.previewUrl });
	}
	if (pagesUrl && site?.staticSha) fields.push({ label: "GitHub Pages origin", value: withoutScheme(pagesUrl), url: pagesUrl });
	const blocks: unknown[] = [{ type: "fields", fields }];
	if (!site) {
		blocks.push({ type: "context", text: `Not built by the platform yet — pushes to ${conn.branch} and content publishes build it to ${staticBranchFor(conn.branch)}; the two previous deployments then stay on ${staticBranchFor(conn.branch)}-b-1 / -b-2 with their own preview URLs.` });
	} else if (site.status === "running") {
		blocks.push({ type: "context", text: `Building ${conn.branch} (attempt ${site.attempt})…` });
	}
	return { blocks };
}
