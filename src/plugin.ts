/**
 * GitHub Agent — issues on the site's connected repo, and a coding agent
 * driven entirely by slash-commands in issue and pull-request comments.
 *
 *   commands  `/agent-issue` on an issue summons the agent. `/agent-stack
 *             #a #b …` runs issues as stacked layers (`/agent-issue on #N`
 *             adds one on top — see "Stacked pull requests"). `/awaiting-test`
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
 *             `builds` — one row per PR / built branch; `stacks` — one row
 *             per stack of layers.
 *   admin     /github-agent page: issues, runs, "new issue", settings.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";
import type { ZodType } from "zod";
// zod/mini keeps the marketplace bundle small (the classic API alone is ~75 KB
// minified); the CLI turns these into JSON schema at build time, and the
// plugin API is typed with the classic ZodType, hence the cast.
import * as z from "zod/mini";

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
	type LayerBelow,
	type PreviousDeployment,
	type Run,
	type StackedRun,
} from "./agent.js";
import {
	addToGitHubStack,
	asyncMergeResult,
	branchHead,
	closeIssue,
	comment,
	createGitHubStack,
	createIssue,
	getConnection,
	getIssue,
	getPull,
	listIssues,
	listSubIssues,
	mergePull,
	mergePullAsync,
	retargetPull,
	servePagesFromBranch,
	setStatus,
	type AsyncMerge,
	type Connection,
	type Issue,
	type PullRequest,
} from "./github.js";
import { DEFAULTS, normalizeLogin, readSettings, saveSettings, type Settings } from "./settings.js";
import { decideMerge, describeStack, issueRefs, prNumberFrom, stackId, stackOnArg, type LayerState, type Stack } from "./stacks.js";

const CALLBACK_PATH = "/_emdash/api/plugins/premium-github-agent/agent-callback";
const CI_CALLBACK_PATH = "/_emdash/api/plugins/premium-github-agent/ci-callback";

/** The comment vocabulary. Anything else in a comment is just text. */
const COMMANDS = [
	"agent-issue",
	"agent-stack",
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
/** `/command` at a word boundary, then the rest of its line (the arguments: `on #12`, `#12 #13 …`). */
const COMMAND_RE = new RegExp(`(?:^|\\s)/(${COMMANDS.join("|")})(?=\\s|$)([^\\S\\r\\n]*[^\\r\\n]*)?`, "g");

/** Every command mentioned in a comment body, in order, deduplicated. */
function commandsIn(body: string): Command[] {
	const out: Command[] = [];
	for (const m of body.matchAll(COMMAND_RE)) {
		const c = m[1] as Command;
		if (!out.includes(c)) out.push(c);
	}
	return out;
}

/** The text after each command on its line (first mention wins). */
function commandArgs(body: string): Partial<Record<Command, string>> {
	const out: Partial<Record<Command, string>> = {};
	for (const m of body.matchAll(COMMAND_RE)) {
		const c = m[1] as Command;
		if (out[c] === undefined) out[c] = (m[2] ?? "").trim();
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

/** A zod/mini schema where the plugin API expects a classic one (both share the v4 core the CLI reads). */
function schema(s: unknown): ZodType {
	return s as ZodType;
}

function described<T extends z.ZodMiniType>(s: T, description: string): T {
	z.globalRegistry.add(s, { description });
	return s;
}

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
	/** Stack placement; a retry without one keeps the placement of the run it retries. */
	placement?: { stack: { id: string; layer: number; size: number }; base?: string; below?: LayerBelow },
): Promise<Run> {
	const existing = await getRun(ctx, issue.number);
	if (existing && (existing.status === "queued" || existing.status === "running")) return existing;
	if (existing?.status === "completed" && !again) return existing;
	// A `waiting` row is a stack placeholder: its attempt counter carries on from the previous run of the issue.
	const attempt = !existing ? 1 : existing.status === "waiting" || again ? (existing.attempt ?? (existing.status === "waiting" ? 0 : 1)) + 1 : (existing.attempt ?? 1);
	let stacked: StackedRun | undefined;
	let stackFields: Pick<Run, "stack" | "layer" | "base" | "below"> = {};
	if (placement) {
		stacked = { layer: placement.stack.layer, size: placement.stack.size, base: placement.base, below: placement.below };
		stackFields = { stack: placement.stack.id, layer: placement.stack.layer, base: placement.base, below: placement.below };
	} else if (existing?.stack) {
		const stack = await getStack(ctx, existing.stack);
		stacked = { layer: existing.layer ?? 1, size: stack?.issues.length ?? existing.layer ?? 1, base: existing.base, below: existing.below };
		stackFields = { stack: existing.stack, layer: existing.layer, base: existing.base, below: existing.below };
	}

	const seed = { number: issue.number, title: issue.title, author: issue.author, attempt, ...stackFields, updatedAt: now() };
	if (!allowed(settings, issue.author)) {
		const run: Run = { ...seed, status: "skipped", reason: `@${issue.author} is not a whitelisted user` };
		await putRun(ctx, run);
		return run;
	}
	if (!settings.agentKey) {
		const run: Run = { ...seed, status: "error", reason: "Agent key is not set in the plugin settings" };
		await putRun(ctx, run);
		return run;
	}
	try {
		const d = await dispatch(ctx, settings, conn, issue.number, attempt, callbackUrl(ctx), note, stacked);
		const run: Run = { ...seed, status: "queued", submissionId: d.submissionId };
		await putRun(ctx, run);
		ctx.log.info(`issue #${issue.number} handed to the agent`, { submission: d.submissionId, attempt, ...(stacked ? { layer: stacked.layer, base: stacked.base } : {}) });
		return run;
	} catch (error) {
		const run: Run = { ...seed, status: "error", reason: String(error) };
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
		if (next !== run && next.stack && next.status !== "queued" && next.status !== "running") {
			await onRunFinished(ctx, settings, conn, next).catch((e) => ctx.log.error(`stack: run #${next.number} follow-up failed`, e));
		}
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
	/** The PR's base branch (a stacked layer targets the branch below it, not the default branch). */
	baseRef?: string;
	/** The stack this PR is a layer of. */
	stack?: string;
	/** The stack merge was announced on this PR (`/merged`, issue closed) — set only by the announcer, so a `closed` webhook racing it cannot suppress the comment. */
	announced?: boolean;
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
	const run = Number.isInteger(issue) ? await getRun(ctx, issue as number) : null;
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
		baseRef: pr.baseRef || existing?.baseRef,
		stack: run?.stack ?? existing?.stack,
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
		// A layer of a stack: the stack decides (bottom-up, atomic), not this PR alone.
		const stack = (next.stack ? await getStack(ctx, next.stack) : null) ?? (await stackWithPull(ctx, r.pr));
		if (stack && stack.status !== "merged") {
			await settleStack(ctx, settings, conn, stack);
			return (await getBuild(ctx, r.pr)) ?? next;
		}
		if (next.baseRef && next.baseRef !== conn.branch) {
			await comment(ctx, conn, r.pr, `Not merged automatically: this pull request targets \`${next.baseRef}\`, not \`${conn.branch}\`. Link it as a stack (\`gh stack link\`) or retarget it.`).catch(() => undefined);
			return next;
		}
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
): { number: number; isPull: boolean; author: string; body: string; commands: Command[]; args: Partial<Record<Command, string>> } | null {
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
		return { number, isPull, author: String(user.login ?? ""), body, commands, args: commandArgs(body) };
	}
	if (input.action !== "opened" || isPull) return null;
	const body = String(issue.body ?? "");
	const commands = commandsIn(body).filter((c) => c === "agent-issue" || c === "agent-stack");
	if (!commands.length) return null;
	const user = isRecord(issue.user) ? issue.user : {};
	return { number, isPull, author: String(user.login ?? ""), body, commands, args: commandArgs(body) };
}

function pushFromEvent(input: unknown): { branch: string; after: string; deleted: boolean } | null {
	if (!isRecord(input) || typeof input.ref !== "string" || !input.ref.startsWith("refs/heads/")) return null;
	return { branch: input.ref.slice("refs/heads/".length), after: String(input.after ?? ""), deleted: input.deleted === true };
}

function pullFromEvent(
	input: unknown,
): { action: string; number: number; headSha: string; author: string; baseRef: string; merged: boolean; stackNumber: number | null } | null {
	if (!isRecord(input) || !isRecord(input.pull_request)) return null;
	const pr = input.pull_request;
	const number = Number(pr.number);
	if (!Number.isInteger(number) || number <= 0) return null;
	const head = isRecord(pr.head) ? pr.head : {};
	const base = isRecord(pr.base) ? pr.base : {};
	const user = isRecord(pr.user) ? pr.user : {};
	const stack = isRecord(pr.stack) ? pr.stack : isRecord(input.stack) ? input.stack : null;
	return {
		action: String(input.action ?? ""),
		number,
		headSha: String(head.sha ?? ""),
		author: String(user.login ?? ""),
		baseRef: String(base.ref ?? ""),
		merged: pr.merged === true || typeof pr.merged_at === "string",
		stackNumber: stack && Number.isInteger(Number(stack.number)) ? Number(stack.number) : null,
	};
}


// ── Stacked pull requests ────────────────────────────────────────────────
//
// `/agent-stack #12 #13 #14` (or `/agent-stack` on an issue with sub-issues)
// runs the listed issues as layers: the first from the default branch, each
// next one from the branch of the pull request below it, as soon as that PR
// is open. `/agent-issue on #12` appends one layer to #12's stack. The PRs are
// linked as a GitHub stack; the platform builds every layer and merges the
// stack bottom-up through GitHub's atomic stack merge (the longest green run
// from the bottom, never under a layer still building), then rebuilds the
// layers GitHub rebases. Records live in the `stacks` storage; a cron tick
// keeps them moving when a webhook or callback is lost.

const STACK_TICK = "stacks";
const STACK_TICK_SCHEDULE = "*/2 * * * *";
/** A PR that changed this recently and has no build yet is about to be built (the agent comments /awaiting-test right after opening it). */
const FRESH_PR_MS = 10 * 60 * 1000;
/** A rebased layer whose branch has not moved after this long: a conflict, most likely. */
const REBASE_WAIT_MS = 15 * 60 * 1000;
/** How many 2-second polls a route gives GitHub's asynchronous merge before leaving it to the tick. */
const MERGE_POLLS = 5;

function isStack(v: unknown): v is Stack {
	return isRecord(v) && typeof v.id === "string" && Array.isArray(v.issues) && typeof v.status === "string";
}

async function getStack(ctx: PluginContext, id: string): Promise<Stack | null> {
	const row = await ctx.storage.stacks!.get(id);
	return isStack(row) ? row : null;
}

async function putStack(ctx: PluginContext, stack: Stack): Promise<Stack> {
	const next = { ...stack, updatedAt: now() };
	await ctx.storage.stacks!.put(stack.id, next);
	return next;
}

async function listStacks(ctx: PluginContext, limit = 30): Promise<Stack[]> {
	const r = await ctx.storage.stacks!.query({ orderBy: { updatedAt: "desc" }, limit });
	return r.items.map((i) => i.data).filter(isStack);
}

async function stackOf(ctx: PluginContext, run: Run | null): Promise<Stack | null> {
	return run?.stack ? getStack(ctx, run.stack) : null;
}

/** The unfinished stack one of whose layers is this pull request. */
async function stackWithPull(ctx: PluginContext, pr: number): Promise<Stack | null> {
	for (const s of await listStacks(ctx, 30)) {
		if (s.status !== "merged" && Object.values(s.prs).includes(pr)) return s;
	}
	return null;
}

function prOf(stack: Stack, issue: number): number | undefined {
	return stack.prs[String(issue)];
}

/** Layers without a pull request yet, bottom first. */
function planned(stack: Stack): number[] {
	return stack.issues.filter((n) => !prOf(stack, n));
}

function stackView(stack: Stack) {
	return {
		id: stack.id,
		status: stack.status,
		summary: stack.summary ?? null,
		github: stack.github ?? null,
		layers: stack.issues.map((n, i) => ({ layer: i + 1, issue: n, pr: prOf(stack, n) ?? null })),
	};
}

async function ensureTick(ctx: PluginContext): Promise<void> {
	try {
		await ctx.cron?.schedule(STACK_TICK, { schedule: STACK_TICK_SCHEDULE });
	} catch (error) {
		ctx.log.warn("stack tick not scheduled", error);
	}
}

function sleep(ms: number): Promise<void> {
	return typeof setTimeout === "function" ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function layerComment(stack: Stack, issue: number): string {
	const layer = stack.issues.indexOf(issue) + 1;
	const below = layer > 1 ? stack.issues[layer - 2] : null;
	return [
		`Stacked pull requests: layer ${layer} of ${stack.issues.length} (${describeStack(stack)}).`,
		below
			? `The agent starts on this issue as soon as #${below}'s pull request is open — from that branch, with a pull request against it.`
			: "The agent starts on this issue now, from the default branch; the layers above build on its branch.",
		"The platform links the pull requests as a GitHub stack, builds every layer, and merges the stack bottom-up once every layer is green.",
	].join(" ");
}

/** Plan a stack of issues (bottom first) and start its first layer. */
async function startStack(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	numbers: number[],
	createdBy: string,
): Promise<{ stack: Stack } | { error: string }> {
	const issues = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))];
	if (issues.length < 2) return { error: "a stack needs at least two issues, bottom first: `/agent-stack #12 #13`" };
	const found = new Map<number, Issue>();
	for (const n of issues) {
		const issue = await getIssue(ctx, conn, n);
		if (!issue) return { error: `#${n} was not found (or is a pull request)` };
		if (issue.state !== "open") return { error: `#${n} is closed` };
		const run = await getRun(ctx, n);
		if (run && (run.status === "queued" || run.status === "running")) return { error: `the agent is already working on #${n}` };
		const other = await stackOf(ctx, run);
		if (other && other.status === "running" && other.issues.includes(n)) {
			return { error: `#${n} is already layer ${other.issues.indexOf(n) + 1} of stack ${other.id} (${describeStack(other)})` };
		}
		found.set(n, issue);
	}
	let stack = await putStack(ctx, { id: stackId(issues[0]), issues, prs: {}, status: "running", createdBy, createdAt: now(), updatedAt: now() });
	for (const [i, n] of issues.entries()) {
		await placeholderRun(ctx, found.get(n)!, stack, i + 1);
		await comment(ctx, conn, n, layerComment(stack, n)).catch(() => undefined);
	}
	await ensureTick(ctx);
	stack = await advanceStack(ctx, settings, conn, stack);
	return { stack };
}

/** A `waiting` run row for a layer that has not started; the attempt counter carries on from the issue's previous run. */
async function placeholderRun(ctx: PluginContext, issue: Issue, stack: Stack, layer: number): Promise<void> {
	const run = await getRun(ctx, issue.number);
	await putRun(ctx, {
		number: issue.number,
		title: issue.title,
		author: issue.author,
		attempt: run?.attempt ?? 0,
		status: "waiting",
		stack: stack.id,
		layer,
		updatedAt: now(),
	});
}

/** Start the next layer whose pull request is missing, once the layer below has one. */
async function advanceStack(ctx: PluginContext, settings: Settings, conn: Connection, stack: Stack): Promise<Stack> {
	if (stack.status !== "running") return stack;
	const idx = stack.issues.findIndex((n) => !prOf(stack, n));
	if (idx < 0) return stack;
	const number = stack.issues[idx];
	const run = await getRun(ctx, number);
	// In flight, or finished without a PR (onRunFinished decides what that means).
	if (run && run.stack === stack.id && run.status !== "waiting") return stack;
	let base: string | undefined;
	let below: LayerBelow | undefined;
	if (idx > 0) {
		const belowIssue = stack.issues[idx - 1];
		const belowPr = prOf(stack, belowIssue)!;
		const pull = await getPull(ctx, conn, belowPr);
		if (!pull) return stopStack(ctx, conn, stack, `pull request #${belowPr} (layer ${idx}) was not found`);
		if (pull.state === "open") {
			base = pull.headRef;
			below = { issue: belowIssue, pr: belowPr, branch: pull.headRef };
		} else if (pull.merged) {
			// Everything below has landed: this layer starts afresh from the default branch.
			if (stack.github) stack = await putStack(ctx, { ...stack, github: undefined });
		} else {
			return stopStack(ctx, conn, stack, `pull request #${belowPr} (layer ${idx}) was closed without merging`);
		}
	}
	const issue = await getIssue(ctx, conn, number);
	if (!issue) return stopStack(ctx, conn, stack, `issue #${number} (layer ${idx + 1}) was not found`);
	const next = await runIssue(ctx, settings, conn, issue, !!run && run.status !== "waiting", undefined, {
		stack: { id: stack.id, layer: idx + 1, size: stack.issues.length },
		base,
		below,
	});
	if (next.status !== "queued") return stopStack(ctx, conn, stack, `#${number}: ${next.reason ?? next.status}`);
	return stack;
}

/** No more layers start; the pull requests that exist keep their own life (and still merge when green). */
async function stopStack(ctx: PluginContext, conn: Connection, stack: Stack, reason: string): Promise<Stack> {
	const rest = planned(stack);
	const next = await putStack(ctx, { ...stack, status: "stopped", summary: reason });
	for (const n of rest) {
		const run = await getRun(ctx, n);
		if (run?.status === "waiting") await putRun(ctx, { ...run, status: "skipped", reason: `stack stopped: ${reason}` });
		await comment(
			ctx,
			conn,
			n,
			`Stack ${describeStack(stack)} stopped: ${reason}. ${
				rest.length > 1
					? `Layers without a pull request were not started — fix the cause and comment \`/agent-stack ${rest.map((i) => `#${i}`).join(" ")}\` to run them.`
					: "Fix the cause and comment `/agent-issue` (or `/agent-issue on #…`) to run it."
			}`,
		).catch(() => undefined);
	}
	ctx.log.warn(`stack ${stack.id} stopped: ${reason}`);
	return next;
}

/** A run ended (callback or reconcile): record the layer's PR, link it, start the next layer, and see whether the stack can merge. */
async function onRunFinished(ctx: PluginContext, settings: Settings, conn: Connection, run: Run): Promise<void> {
	let stack = await stackOf(ctx, run);
	if (!stack || stack.status !== "running") return;
	const pr = run.status === "completed" ? prNumberFrom(run.prUrl) : null;
	if (pr) {
		if (prOf(stack, run.number) !== pr) {
			stack = await putStack(ctx, { ...stack, prs: { ...stack.prs, [String(run.number)]: pr } });
			stack = await linkLayer(ctx, conn, stack, run.number, pr);
		}
		stack = await advanceStack(ctx, settings, conn, stack);
		await settleStack(ctx, settings, conn, stack);
		return;
	}
	if (run.status !== "completed" && run.status !== "error" && run.status !== "skipped") return;
	const why = run.reason ?? run.answer ?? run.status;
	if (prOf(stack, run.number)) {
		// A fix attempt that gave up: the PR exists, the layers below can still merge.
		stack = await putStack(ctx, { ...stack, summary: `#${run.number}: ${why}` });
		await settleStack(ctx, settings, conn, stack);
		return;
	}
	await stopStack(ctx, conn, stack, `#${run.number} produced no pull request (${why})`);
}

/** Link a freshly opened layer on top of the one below as a GitHub stack (created with the first pair, extended after). */
async function linkLayer(ctx: PluginContext, conn: Connection, stack: Stack, issue: number, pr: number): Promise<Stack> {
	const idx = stack.issues.indexOf(issue);
	if (idx <= 0) return stack;
	const belowPr = prOf(stack, stack.issues[idx - 1]);
	if (!belowPr) return stack;
	try {
		const below = await getPull(ctx, conn, belowPr);
		if (below?.merged) {
			// The layer below landed while this one was being written: nothing to stack on any more.
			const mine = await getPull(ctx, conn, pr);
			if (mine && mine.baseRef !== conn.branch) {
				await retargetPull(ctx, conn, pr, conn.branch);
				await comment(ctx, conn, pr, `#${belowPr} was already merged, so this pull request now targets \`${conn.branch}\` on its own.`).catch(() => undefined);
			}
			return putStack(ctx, { ...stack, github: undefined });
		}
		const gh = stack.github ? await addToGitHubStack(ctx, conn, stack.github, [pr]) : await createGitHubStack(ctx, conn, [belowPr, pr]);
		const next = await putStack(ctx, { ...stack, github: gh.number });
		await comment(
			ctx,
			conn,
			pr,
			`Stacked on #${belowPr} as layer ${idx + 1} of ${stack.issues.length} (GitHub stack #${gh.number}). The platform merges the stack bottom-up once every layer is green.`,
		).catch(() => undefined);
		return next;
	} catch (error) {
		ctx.log.warn(`stack ${stack.id}: linking #${pr} on #${belowPr} failed`, error);
		await comment(
			ctx,
			conn,
			pr,
			`Could not link this pull request into the GitHub stack on top of #${belowPr}: ${String(error)}. It stays open on its branch and is not merged automatically until it is linked (\`gh stack link\`) or retargeted.`,
		).catch(() => undefined);
		return stack;
	}
}

/** The layers with a pull request, bottom first, as the merge decision sees them. */
async function stackLayers(ctx: PluginContext, conn: Connection, stack: Stack): Promise<LayerState[]> {
	const out: LayerState[] = [];
	for (const issue of stack.issues) {
		const pr = prOf(stack, issue);
		if (!pr) break;
		const pull = await getPull(ctx, conn, pr);
		if (!pull) continue;
		const b = await getBuild(ctx, pr);
		out.push({
			issue,
			pr,
			state: pull.merged ? "merged" : pull.state === "open" ? "open" : "closed",
			headSha: pull.headSha,
			headRef: pull.headRef,
			updatedAt: pull.updatedAt,
			build: b ? { status: b.status, headSha: b.headSha, updatedAt: b.updatedAt } : null,
		});
	}
	return out;
}

/** Is a planned layer still on its way to a pull request? */
async function plannedPending(ctx: PluginContext, stack: Stack): Promise<boolean> {
	if (stack.status !== "running") return false;
	const next = planned(stack)[0];
	if (!next) return false;
	const run = await getRun(ctx, next);
	return !!run && run.stack === stack.id && (run.status === "waiting" || run.status === "queued" || run.status === "running");
}

/** Merge what is green, bottom-up, when nothing above it is in flight. */
async function settleStack(ctx: PluginContext, settings: Settings, conn: Connection, stack: Stack): Promise<Stack> {
	if (stack.status === "merged" || !settings.autoMerge) return stack;
	if (stack.merging) {
		stack = await finishStackMerge(ctx, settings, conn, stack);
		if (stack.merging || stack.status === "merged") return stack;
	}
	const layers = await stackLayers(ctx, conn, stack);
	const d = decideMerge(layers, { plannedPending: await plannedPending(ctx, stack), now: Date.now(), staleMs: STALE_BUILD_MS, freshMs: FRESH_PR_MS });
	if (d.kind === "hold") return stack.summary === d.reason ? stack : putStack(ctx, { ...stack, summary: d.reason });
	if (d.kind === "nothing") return stack;
	if (stack.mergeRefused && stack.mergeRefused.pr === d.top.pr && stack.mergeRefused.sha === d.top.headSha) return stack;
	const m = await mergePullAsync(ctx, conn, d.top.pr, d.top.headSha).catch((e): AsyncMerge => ({ status: "failed", message: String(e) }));
	return applyStackMerge(ctx, settings, conn, stack, layers, d.prs, m);
}

/** Take GitHub's asynchronous merge to its end: poll a little, then leave the rest to the tick and the `closed` webhooks. */
async function applyStackMerge(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	stack: Stack,
	layers: LayerState[],
	prs: number[],
	m: AsyncMerge,
): Promise<Stack> {
	const top = prs[prs.length - 1];
	if (m.status === "merged") return completeStackMerge(ctx, settings, conn, stack, layers, prs, m.sha);
	if (m.status === "failed") return refuseStackMerge(ctx, conn, stack, layers, top, m.message);
	for (let i = 0; i < MERGE_POLLS && m.uuid && m.status === "pending"; i++) {
		await sleep(2000);
		const r = await asyncMergeResult(ctx, conn, top, m.uuid);
		if (r.status === "merged") return completeStackMerge(ctx, settings, conn, stack, layers, prs, r.sha);
		if (r.status === "failed") return refuseStackMerge(ctx, conn, stack, layers, top, r.message);
		if (r.status === "enqueued") break;
	}
	return putStack(ctx, {
		...stack,
		merging: { pr: top, uuid: m.uuid ?? "", prs, startedAt: now() },
		summary: `merging ${prs.map((p) => `#${p}`).join(", ")} — GitHub is working on it`,
	});
}

/** A merge left running on GitHub: see whether it finished (by its result, or by the pull requests showing merged). */
async function finishStackMerge(ctx: PluginContext, settings: Settings, conn: Connection, stack: Stack): Promise<Stack> {
	const m = stack.merging!;
	const layers = await stackLayers(ctx, conn, stack);
	if (m.prs.every((pr) => layers.find((l) => l.pr === pr)?.state === "merged")) {
		return completeStackMerge(ctx, settings, conn, stack, layers, m.prs, undefined);
	}
	if (m.uuid) {
		const r = await asyncMergeResult(ctx, conn, m.pr, m.uuid);
		if (r.status === "merged") return completeStackMerge(ctx, settings, conn, stack, layers, m.prs, r.sha);
		if (r.status === "failed") return refuseStackMerge(ctx, conn, stack, layers, m.pr, r.message);
	}
	if (Date.now() - Date.parse(m.startedAt) > REBASE_WAIT_MS) {
		return refuseStackMerge(ctx, conn, stack, layers, m.pr, "the merge did not finish on GitHub");
	}
	return stack;
}

/**
 * Some layers landed: mark them merged (`/merged`), close their issues, and
 * remember the open layers above with their last built head — GitHub rebases
 * them now, and each is rebuilt once its branch moves.
 */
async function completeStackMerge(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	stack: Stack,
	layers: LayerState[],
	prs: number[],
	sha: string | undefined,
): Promise<Stack> {
	for (const pr of prs) {
		const b = await getBuild(ctx, pr);
		if (b?.announced) continue;
		if (b) await putBuild(ctx, { ...b, status: "merged", announced: true, summary: `merged into ${conn.branch} with the stack${sha ? ` @ ${sha.slice(0, 7)}` : ""}` });
		await comment(
			ctx,
			conn,
			pr,
			[`/merged`, `Every check passed — merged into \`${conn.branch}\` as part of the stack (${prs.map((p) => `#${p}`).join(", ")}); \`${staticBranchFor(conn.branch)}\` rebuilds from it.`].join("\n"),
		).catch(() => undefined);
		const issue = stack.issues.find((n) => prOf(stack, n) === pr);
		if (issue) await closeIssue(ctx, conn, issue).catch((e) => ctx.log.warn(`issue #${issue} not closed`, e));
	}
	ctx.log.info(`stack ${stack.id}: merged ${prs.map((p) => `#${p}`).join(", ")} into ${conn.branch}`, { sha });
	const above = layers.filter((l) => l.state === "open" && !prs.includes(l.pr));
	const pendingRebuild = { ...(stack.pendingRebuild ?? {}) };
	for (const l of above) pendingRebuild[String(l.pr)] = { sha: l.build?.headSha ?? l.headSha, since: now() };
	const done = above.length === 0 && planned(stack).length === 0;
	return putStack(ctx, {
		...stack,
		merging: undefined,
		mergeRefused: undefined,
		pendingRebuild: done || !above.length ? undefined : pendingRebuild,
		status: done ? "merged" : stack.status,
		summary: done
			? `all ${stack.issues.length} layers merged into ${conn.branch}`
			: `merged ${prs.map((p) => `#${p}`).join(", ")}${above.length ? `; GitHub rebases ${above.map((l) => `#${l.pr}`).join(", ")}, then they rebuild` : ""}`,
	});
}

async function refuseStackMerge(ctx: PluginContext, conn: Connection, stack: Stack, layers: LayerState[], pr: number, message: string): Promise<Stack> {
	const sha = layers.find((l) => l.pr === pr)?.headSha ?? "";
	await comment(ctx, conn, pr, `Could not merge the stack automatically: ${message}. It stays open for a human; a new commit on any layer re-arms auto-merge.`).catch(() => undefined);
	ctx.log.warn(`stack ${stack.id}: merge of #${pr} refused: ${message}`);
	return putStack(ctx, { ...stack, merging: undefined, mergeRefused: { pr, sha, message }, summary: `merge refused: ${message}` });
}

/** A layer GitHub rebased after the merge below it: build the new head — unless the agent is still fixing that layer. */
async function rebuildRebased(ctx: PluginContext, settings: Settings, conn: Connection, stack: Stack, pr: number, headSha: string): Promise<Stack> {
	const entry = stack.pendingRebuild?.[String(pr)];
	if (!entry || entry.sha === headSha) return stack;
	const b = await getBuild(ctx, pr);
	if (b?.status === "running" && !isStale(b)) return stack; // let it finish; the tick comes back
	const rest = { ...stack.pendingRebuild };
	delete rest[String(pr)];
	const next = await putStack(ctx, { ...stack, pendingRebuild: Object.keys(rest).length ? rest : undefined });
	if (b && b.status !== "passed" && b.status !== "merged") return next; // failed / capped: the agent's fix asks for the build
	const pull = await getPull(ctx, conn, pr);
	if (pull?.state === "open") {
		const r = await buildPull(ctx, settings, conn, pull, { force: true });
		if (!r.started) ctx.log.warn(`PR #${pr}: rebuild after rebase not started: ${r.reason}`);
	}
	return next;
}

/** The cron tick: reconcile runs and builds, then keep every unfinished stack moving. */
async function stackTick(ctx: PluginContext): Promise<void> {
	await poll(ctx);
	await sweepStacks(ctx);
}

/** Keep every unfinished stack moving: rebased layers rebuild, the next layer starts, what is green merges. */
async function sweepStacks(ctx: PluginContext): Promise<void> {
	const setup = await requireSetup(ctx);
	if (!setup.ok) return;
	const { conn, settings } = setup;
	for (let stack of await listStacks(ctx, 20)) {
		if (stack.status === "merged") continue;
		for (const [key, entry] of Object.entries(stack.pendingRebuild ?? {})) {
			const pr = Number(key);
			const pull = await getPull(ctx, conn, pr).catch(() => null);
			if (!pull) continue;
			if (pull.headSha !== entry.sha) {
				stack = await rebuildRebased(ctx, settings, conn, stack, pr, pull.headSha);
			} else if (Date.now() - Date.parse(entry.since) > REBASE_WAIT_MS) {
				const rest = { ...stack.pendingRebuild };
				delete rest[key];
				stack = await putStack(ctx, { ...stack, pendingRebuild: Object.keys(rest).length ? rest : undefined, summary: `#${pr} was not rebased after the merge below it (a conflict?)` });
				await comment(
					ctx,
					conn,
					pr,
					`The layer below merged, but GitHub has not rebased this branch in ${REBASE_WAIT_MS / 60000} minutes — most likely a conflict. Rebase the stack (\`gh stack sync\`, or "Rebase stack" on the pull request) and comment \`/awaiting-test\`.`,
				).catch(() => undefined);
			}
		}
		stack = await advanceStack(ctx, settings, conn, stack);
		await settleStack(ctx, settings, conn, stack);
	}
}

/** `/agent-stack #a #b …` — or, without numbers, the issue's open sub-issues in their order. */
async function handleAgentStack(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	number: number,
	args: string,
	author: string,
): Promise<Record<string, unknown>> {
	let issues = issueRefs(args);
	const listed = issues.length > 0;
	if (!listed) {
		try {
			issues = (await listSubIssues(ctx, conn, number)).filter((i) => i.state === "open").map((i) => i.number);
		} catch (error) {
			return { started: false, reason: String(error) };
		}
	}
	if (issues.length < 2) {
		await comment(
			ctx,
			conn,
			number,
			listed && issues.length === 1
				? `One issue is not a stack — comment \`/agent-issue\` on #${issues[0]} instead, or list the layers bottom first: \`/agent-stack #${issues[0]} #…\`.`
				: "List the layers bottom first — `/agent-stack #12 #13 #14` — or add at least two open sub-issues to this issue and comment `/agent-stack` again.",
		).catch(() => undefined);
		return { started: false, reason: "fewer than two issues" };
	}
	const r = await startStack(ctx, settings, conn, issues, author);
	if ("error" in r) {
		await comment(ctx, conn, number, `Stack not started: ${r.error}.`).catch(() => undefined);
		return { started: false, reason: r.error };
	}
	return { started: true, stack: r.stack.id, issues };
}

/** `/agent-issue on #N` — one more layer on top of #N's stack (or on #N's own pull request). */
async function handleAgentIssueOn(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	number: number,
	on: number,
	author: string,
): Promise<Record<string, unknown>> {
	if (on === number) {
		await comment(ctx, conn, number, "An issue cannot stack on itself — `/agent-issue on #N` names the issue whose pull request this one builds on.").catch(() => undefined);
		return { started: false, reason: "self" };
	}
	const issue = await getIssue(ctx, conn, number);
	if (!issue) return { started: false, reason: "issue not found" };
	const run = await getRun(ctx, number);
	if (run && (run.status === "queued" || run.status === "running")) return { started: false, reason: "already working on it" };
	const mine = await stackOf(ctx, run);
	if (mine?.status === "running" && mine.issues.includes(number)) {
		await comment(ctx, conn, number, `Already layer ${mine.issues.indexOf(number) + 1} of stack ${describeStack(mine)}.`).catch(() => undefined);
		return { started: false, reason: "already stacked" };
	}
	const belowRun = await getRun(ctx, on);
	let stack = await stackOf(ctx, belowRun);
	if (!stack || stack.status !== "running") {
		const belowPr = prNumberFrom(belowRun?.prUrl);
		const inFlight = belowRun?.status === "queued" || belowRun?.status === "running";
		if (!belowPr && !inFlight) {
			await comment(
				ctx,
				conn,
				number,
				belowRun
					? `#${on}'s run ended without a pull request (${belowRun.reason ?? belowRun.answer ?? belowRun.status}) — comment \`/agent-stack #${on} #${number}\` to run both as a stack.`
					: `#${on} has not been handed to the agent — comment \`/agent-stack #${on} #${number}\` to run both as a stack.`,
			).catch(() => undefined);
			return { started: false, reason: `#${on} has no pull request` };
		}
		// #on is an ordinary run: it becomes the bottom of a new stack.
		stack = await putStack(ctx, {
			id: stackId(on),
			issues: [on],
			prs: belowPr ? { [String(on)]: belowPr } : {},
			status: "running",
			createdBy: author,
			createdAt: now(),
			updatedAt: now(),
		});
		if (belowRun) await putRun(ctx, { ...belowRun, stack: stack.id, layer: 1 });
		await ensureTick(ctx);
	}
	stack = await putStack(ctx, { ...stack, issues: [...stack.issues, number] });
	await placeholderRun(ctx, issue, stack, stack.issues.length);
	await comment(ctx, conn, number, layerComment(stack, number)).catch(() => undefined);
	stack = await advanceStack(ctx, settings, conn, stack);
	return { started: stack.status === "running", stack: stack.id, layer: stack.issues.length };
}

// ── Plugin ───────────────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	/**
	 * Exposed on the site's own MCP endpoint (once an admin enables this
	 * plugin's MCP tools), so an assistant acting as an editor can hand
	 * frontend work to the coding agent and follow it.
	 */
	mcp: {
		tools: {
			create_issue: {
				description:
					"Open an issue on the site's connected GitHub repository. With agent=true (the default) the coding agent picks it up: it studies the repository, opens a pull request, the platform builds, tests and previews it, and merges it when every check passes; the site rebuilds afterwards. Describe the change precisely: what, where it shows on the page, the exact current text, what it should look like or do afterwards, acceptance criteria. `on` stacks the change on top of another issue's pull request (its branch) — for a change that depends on one still in flight; for a planned series use create_stack.",
				route: "issues/create",
				destructive: false,
				input: schema(
					z.object({
						title: described(z.string().check(z.minLength(1), z.maxLength(200)), "Short imperative title"),
						body: described(z.string().check(z.minLength(1)), "What to change and why, with acceptance criteria"),
						agent: described(z.optional(z.boolean()), "Hand the issue to the coding agent (default true)"),
						labels: z.optional(z.array(z.string())),
						on: described(z.optional(z.int().check(z.positive())), "Stack this change on top of that issue's pull request (its branch)"),
					}),
				),
			},
			list_issues: {
				description: "Open issues on the site's repository with the agent's state for each (queued, working, done with a PR, failed, skipped).",
				route: "issues",
				destructive: false,
				input: schema(z.object({ label: z.optional(z.string()) })),
			},
			create_stack: {
				description:
					"Open several issues as ONE stack of layers, bottom first, and hand them to the coding agent: each layer's pull request builds on the branch of the one below, so dependent or same-area changes never conflict and never wait for each other's merge. The platform links them as a GitHub stack, builds every layer, and merges the stack bottom-up once every layer is green; the site rebuilds after the merge. Use it instead of several create_issue calls whenever the changes depend on each other or touch the same files; keep each layer small and independently reviewable.",
				route: "stacks/create",
				destructive: false,
				input: schema(
					z.object({
						issues: described(
							z.array(z.object({ title: z.string().check(z.minLength(1)), body: z.string() })).check(z.minLength(2), z.maxLength(10)),
							"The layers, bottom first: the foundation, then each change that builds on the previous one (2–10)",
						),
						labels: z.optional(z.array(z.string())),
					}),
				),
			},
			issue_status: {
				description: "Where one issue stands: the agent run (attempt, PR link or reason), the pull request's build / preview / merge state, its stack (layers, their PRs, what the stack is waiting for) and the site's latest default-branch build.",
				route: "issues/status",
				destructive: false,
				input: schema(z.object({ number: z.int().check(z.positive()) })),
			},
		},
	},

	hooks: {
		"plugin:install": async (_event, ctx) => {
			for (const [k, v] of Object.entries(DEFAULTS)) {
				if (k === "agentKey" || k === "allowedUsers") continue;
				if ((await ctx.kv.get(`settings:${k}`)) === null) await ctx.kv.set(`settings:${k}`, v);
			}
			await ensureTick(ctx);
			ctx.log.info("GitHub agent installed");
		},

		/** Updates re-activate the plugin: make sure the stack tick exists. */
		"plugin:activate": async (_event, ctx) => {
			await ensureTick(ctx);
		},

		/** Every two minutes: reconcile runs and builds, keep stacks moving (lost webhooks, merges left running on GitHub, rebased layers). */
		cron: async (event, ctx) => {
			if (event.name !== STACK_TICK) return;
			await stackTick(ctx).catch((e) => ctx.log.error("stack tick failed", e));
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

				// Pull requests: a layer GitHub rebased after a merge below it is
				// rebuilt; a layer linked by hand records its stack; closed PRs drop
				// their preview. Nothing else about PRs is implicit.
				const pull = pullFromEvent(input);
				if (pull) {
					if (pull.action === "synchronize") {
						const stack = await stackWithPull(ctx, pull.number);
						if (!stack?.pendingRebuild?.[String(pull.number)]) return { success: true, ignored: "pull_request synchronize" };
						const setup = await requireSetup(ctx);
						if (!setup.ok) return { success: false, error: setup.error };
						await rebuildRebased(ctx, setup.settings, setup.conn, stack, pull.number, pull.headSha);
						return { success: true, pr: pull.number, rebased: true };
					}
					if (pull.action === "stacked") {
						const stack = pull.stackNumber ? await stackWithPull(ctx, pull.number) : null;
						if (stack && stack.github !== pull.stackNumber) await putStack(ctx, { ...stack, github: pull.stackNumber! });
						return { success: true, pr: pull.number, stack: pull.stackNumber };
					}
					if (pull.action !== "closed") return { success: true, ignored: `pull_request ${pull.action}` };
					const setup = await requireSetup(ctx);
					if (!setup.ok) return { success: false, error: setup.error };
					// A layer of a stack landed (our merge, or someone's): announce it
					// first — this event can arrive before our own merge bookkeeping.
					const stack = await stackWithPull(ctx, pull.number);
					if (stack && pull.merged) {
						const layers = await stackLayers(ctx, setup.conn, stack);
						await completeStackMerge(ctx, setup.settings, setup.conn, stack, layers, [pull.number], undefined);
					}
					const build = await getBuild(ctx, pull.number);
					const merged = build?.status === "merged" || pull.merged;
					if (build) {
						const deleted = build.previewUrl
							? await deletePreview(ctx, setup.settings, setup.conn, pull.number).catch(() => false)
							: false;
						await putBuild(ctx, {
							...build,
							status: merged ? "merged" : "closed",
							previewUrl: undefined,
							summary: `${build.status === "merged" ? build.summary : merged ? `merged into ${setup.conn.branch}` : "closed"}; preview ${deleted ? "removed" : "not removed"}`,
						});
					}
					// A layer closed without merging blocks the layers above: let the stack take note.
					if (stack && !pull.merged) await settleStack(ctx, setup.settings, setup.conn, stack);
					return { success: true, pr: pull.number, closed: true, merged };
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
						const on = stackOnArg(cmd.args["agent-issue"] ?? "");
						if (on) {
							handled[command] = await handleAgentIssueOn(ctx, setup.settings, setup.conn, cmd.number, on, cmd.author);
							continue;
						}
						const issue = await getIssue(ctx, setup.conn, cmd.number);
						if (!issue) return { success: true, ignored: "issue not found" };
						const run = await runIssue(ctx, setup.settings, setup.conn, issue, true);
						handled[command] = { status: run.status, attempt: run.attempt, reason: run.reason };
					} else if (command === "agent-stack" && !cmd.isPull) {
						handled[command] = await handleAgentStack(ctx, setup.settings, setup.conn, cmd.number, cmd.args["agent-stack"] ?? "", cmd.author);
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
				if (next.stack && next.status !== "queued" && next.status !== "running") {
					const conn = await getConnection(ctx);
					if (conn) await onRunFinished(ctx, settings, conn, next).catch((e) => ctx.log.error(`stack: run #${next.number} follow-up failed`, e));
				}
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
			permission: "content:edit_own",
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

		/** Create an issue; `agent: true` (the default for MCP callers) ends the body with `/agent-issue`. */
		"issues/create": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const title = typeof input.title === "string" ? input.title.trim() : "";
				if (!title) return { success: false, error: "A title is required." };
				const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
				const text = typeof input.body === "string" ? input.body : "";
				const agent = input.agent !== false;
				const on = Number.isInteger(Number(input.on)) && Number(input.on) > 0 ? Number(input.on) : null;
				const issue = await createIssue(ctx, setup.conn, {
					title,
					body: agent && !commandsIn(text).includes("agent-issue") ? `${text.trimEnd()}\n\n/agent-issue${on ? ` on #${on}` : ""}` : text,
					labels,
				});
				return {
					success: true,
					issue,
					agent,
					...(on ? { on } : {}),
					next: agent
						? on
							? `The coding agent starts on it as a layer on top of #${on}'s pull request (from that branch) as soon as GitHub delivers the event; the stack merges bottom-up once every layer is green. Use issue_status to follow it.`
							: "The coding agent starts when GitHub delivers the event: it opens a pull request, the platform builds and tests it, hosts a preview, and merges it when every check passes; the site rebuilds a minute or two later. Use issue_status to follow it."
						: "Created without handing it to the agent.",
				};
			},
		},

		/** Open several issues as one stack of layers (bottom first) and start it. */
		"stacks/create": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const specs = (Array.isArray(input.issues) ? input.issues : [])
					.map((i) => (isRecord(i) ? { title: String(i.title ?? "").trim(), body: typeof i.body === "string" ? i.body : "" } : null))
					.filter((i): i is { title: string; body: string } => !!i);
				if (specs.length < 2 || specs.length > 10 || specs.some((i) => !i.title)) {
					return { success: false, error: "Two to ten issues with titles are required, bottom first." };
				}
				const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
				const created: Issue[] = [];
				for (const spec of specs) created.push(await createIssue(ctx, setup.conn, { title: spec.title, body: spec.body, labels }));
				const user: Record<string, unknown> = isRecord(routeCtx.user) ? routeCtx.user : {};
				const r = await startStack(ctx, setup.settings, setup.conn, created.map((i) => i.number), String(user.email ?? user.name ?? setup.conn.owner));
				if ("error" in r) return { success: false, error: r.error, issues: created };
				return {
					success: true,
					stack: stackView(r.stack),
					issues: created,
					next: "Layer 1 is with the agent; each next layer starts when the one below opens its pull request. The platform builds every layer and merges the stack bottom-up once every layer is green; the site rebuilds a minute or two after the merge. Use issue_status on any layer to follow it.",
				};
			},
		},

		/** Where one issue stands: agent run, its PR build, its stack, and the site's latest build. */
		"issues/status": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const setup = await requireSetup(ctx);
				if (!setup.ok) return { success: false, error: setup.error };
				const input = isRecord(routeCtx.input) ? routeCtx.input : {};
				const number = Number(input.number);
				if (!Number.isInteger(number) || number <= 0) return { success: false, error: "Issue number required." };
				const issue = await getIssue(ctx, setup.conn, number);
				if (!issue) return { success: false, error: `Issue #${number} not found.` };
				const run = await getRun(ctx, number);
				const pull = (await listBuilds(ctx, 100)).find((b) => b.pr > 0 && b.issue === number) ?? null;
				const site = await getBranchBuild(ctx, setup.conn.branch);
				const stack = await stackOf(ctx, run);
				return {
					success: true,
					issue: { number: issue.number, title: issue.title, url: issue.url },
					agent: run
						? { status: run.status, attempt: run.attempt, prUrl: run.prUrl ?? null, reason: run.reason ?? null, answer: run.answer ?? null, ...(run.stack ? { stack: run.stack, layer: run.layer ?? null, base: run.base ?? null } : {}) }
						: { status: "not started" },
					pullRequest: pull
						? { number: pull.pr, status: pull.status, attempt: pull.attempt, previewUrl: pull.previewUrl ?? null, summary: pull.summary ?? null, staticBranch: pull.staticBranch, baseRef: pull.baseRef ?? null }
						: null,
					stack: stack ? stackView(stack) : null,
					site: site ? { status: site.status, summary: site.summary ?? null, staticBranch: site.staticBranch, staticSha: site.staticSha ?? null } : null,
				};
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

		/** Manual reconcile: refresh in-flight runs and builds, keep stacks moving; also (re)registers the stack tick. */
		poll: {
			handler: async (_routeCtx, ctx) => {
				await ensureTick(ctx);
				const r = await poll(ctx);
				if (r.error) return { success: false, ...r };
				await sweepStacks(ctx).catch((e) => ctx.log.error("stack sweep failed", e));
				return { success: true, ...r };
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
					const on = Number.isInteger(Number(v.on)) && Number(v.on) > 0 ? Number(v.on) : null;
					try {
						const issue = await createIssue(ctx, setup.conn, {
							title,
							body: v.agent === true ? `${text.trimEnd()}\n\n/agent-issue${on ? ` on #${on}` : ""}` : text,
							labels: [],
						});
						return buildPage(
							ctx,
							`Issue #${issue.number} created${v.agent === true ? ` — the agent starts${on ? ` on top of #${on}'s pull request` : ""} as soon as GitHub delivers the event` : ""}.`,
						);
					} catch (error) {
						return buildPage(ctx, String(error));
					}
				}
				if (i.type === "form_submit" && i.action_id === "run_stack") {
					const setup = await requireSetup(ctx);
					if (!setup.ok) return buildPage(ctx, setup.error);
					const issues = issueRefs(String(i.values?.issues ?? ""));
					const r = await startStack(ctx, setup.settings, setup.conn, issues, "admin");
					return buildPage(ctx, "error" in r ? `Stack not started: ${r.error}.` : `Stack ${describeStack(r.stack)} started (${r.stack.id}) — layer 1 is with the agent.`);
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
	waiting: "waiting (stack)",
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
			text: `Repository ${conn.owner}/${conn.repo} (${conn.branch}). Whitelisted users drive the agent with comments: /agent-issue on an issue, /agent-stack #a #b … to run issues as stacked layers (/agent-issue on #N adds a layer), /awaiting-test on a pull request; the runner answers with /check-…, /test-…, /preview-ready, /preview-test-… and /merged${settings.enabled ? "" : " — currently OFF"}.`,
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
		const stacks = await listStacks(ctx, 20);
		blocks.push({ type: "divider" });
		blocks.push({
			type: "section",
			text: "Stacks: issues run as layers — each pull request from the branch of the one below, linked as a GitHub stack, merged bottom-up once every layer is green (/agent-stack #a #b …, or /agent-issue on #N).",
		});
		blocks.push({
			type: "table",
			block_id: "stacks",
			page_action_id: "stacks_page",
			empty_text: "No stacks yet.",
			columns: [
				{ key: "id", label: "Stack", format: "code" },
				{ key: "layers", label: "Layers (bottom first)", format: "text" },
				{ key: "prs", label: "Pull requests", format: "text" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "summary", label: "Where it stands", format: "text" },
				{ key: "updated", label: "Updated", format: "relative_time" },
			],
			rows: stacks.map((s) => ({
				id: s.id,
				layers: describeStack(s),
				prs: s.issues.map((n) => (prOf(s, n) ? `#${prOf(s, n)}` : "…")).join(" → ") + (s.github ? ` (GitHub stack #${s.github})` : ""),
				status: s.status,
				summary: s.summary ?? "",
				updated: s.updatedAt,
			})),
		});
		blocks.push({
			type: "form",
			block_id: "run-stack",
			fields: [
				{
					type: "text_input",
					action_id: "issues",
					label: "Run issues as a stack — numbers, bottom first",
					placeholder: "12 13 14",
				},
			],
			submit: { label: "Start stack", action_id: "run_stack" },
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
				{
					type: "number_input",
					action_id: "on",
					label: "Stack on issue # (optional)",
					description: "Makes it a layer on top of that issue's pull request: /agent-issue on #N.",
					min: 1,
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
