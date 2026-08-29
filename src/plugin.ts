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
	dispatch,
	hmacHex,
	prUrlFrom,
	runId,
	status as agentStatus,
	timingSafeEqual,
	type Callback,
	type Run,
} from "./agent.js";
import {
	addLabels,
	comment,
	createIssue,
	getConnection,
	getIssue,
	listIssues,
	type Connection,
	type Issue,
} from "./github.js";
import { DEFAULTS, normalizeLogin, readSettings, saveSettings, type Settings } from "./settings.js";

const CALLBACK_PATH = "/_emdash/api/plugins/premium-github-agent/agent-callback";

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
		const d = await dispatch(ctx, settings, conn, issue.number, attempt, callbackUrl(ctx));
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
	},

	routes: {
		/**
		 * GitHub `issues` events, forwarded by the parent control plane (it
		 * authenticates as the platform). Only `opened`/`labeled`/`reopened`
		 * matter, and the issue is re-read from GitHub before anything runs.
		 */
		webhook: {
			handler: async (routeCtx, ctx) => {
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
		blocks.push({
			type: "actions",
			elements: [{ type: "button", action_id: "poll_now", label: "Reconcile now", style: "secondary" }],
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
