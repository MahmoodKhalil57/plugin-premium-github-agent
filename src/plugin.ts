/**
 * GitHub Agent — issues on the site's connected repo, and a coding agent
 * that turns labelled issues into open pull requests.
 *
 *   github    the site's GitHub connection (`ctx.github`) is the only
 *             credential; nothing is stored beyond the plugin's own settings.
 *   cron      every N minutes: open issues with the trigger label whose
 *             author is whitelisted are handed to the agent worker.
 *   agent     a Cloudflare Worker running a Think agent (Workers AI +
 *             GitHub MCP). It reads the repo, writes a branch, opens a PR and
 *             leaves it open. No code is ever executed — dry coding only.
 *   storage   `runs` — one row per issue the agent was asked about.
 *   admin     /github-agent page: issues, runs, "new issue", settings.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

import { dispatch, prUrlFrom, runId, status as agentStatus, type Run } from "./agent.js";
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
import { cronFor, DEFAULTS, normalizeLogin, readSettings, saveSettings, type Settings } from "./settings.js";

const CRON_TASK = "poll";

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

async function requireSetup(
	ctx: PluginContext,
): Promise<{ ok: true; conn: Connection; settings: Settings } | { ok: false; error: string }> {
	const conn = await getConnection(ctx);
	if (!conn) return { ok: false, error: "Connect GitHub in Settings → General first." };
	const settings = await readSettings(ctx);
	return { ok: true, conn, settings };
}

/**
 * Hand one issue to the agent. The whitelist is enforced here, for manual
 * runs and the cron alike — an unlisted author is recorded as skipped.
 */
async function runIssue(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	issue: Issue,
): Promise<Run> {
	const existing = await getRun(ctx, issue.number);
	if (existing && (existing.status === "queued" || existing.status === "running")) return existing;
	if (existing?.status === "completed") return existing;

	const base = { number: issue.number, title: issue.title, author: issue.author, updatedAt: now() };
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
		const d = await dispatch(ctx, settings, conn, issue.number);
		const run: Run = { ...base, status: "queued", submissionId: d.submissionId };
		await putRun(ctx, run);
		ctx.log.info(`issue #${issue.number} handed to the agent`, { submission: d.submissionId });
		return run;
	} catch (error) {
		const run: Run = { ...base, status: "error", reason: String(error) };
		await putRun(ctx, run);
		ctx.log.error(`issue #${issue.number}: dispatch failed`, error);
		return run;
	}
}

/** Refresh one queued/running run from the agent worker. */
async function refreshRun(ctx: PluginContext, settings: Settings, conn: Connection, run: Run): Promise<Run> {
	if (!run.submissionId || (run.status !== "queued" && run.status !== "running")) return run;
	try {
		const s = await agentStatus(ctx, settings, conn, run.number, run.submissionId);
		let next: Run = run;
		if (s.status === "running" || s.status === "pending") next = { ...run, status: "running" };
		else if (s.status === "completed") {
			next = { ...run, status: "completed", answer: s.answer ?? undefined, prUrl: prUrlFrom(s.answer) };
		} else if (s.status === "error" || s.status === "aborted" || s.status === "skipped") {
			next = { ...run, status: "error", reason: `agent ${s.status}` };
		}
		if (next !== run) await putRun(ctx, next);
		return next;
	} catch (error) {
		ctx.log.warn(`issue #${run.number}: status check failed`, error);
		return run;
	}
}

/** One poll: dispatch new labelled issues, refresh in-flight runs. */
async function poll(ctx: PluginContext): Promise<{ dispatched: number; refreshed: number; error?: string }> {
	const setup = await requireSetup(ctx);
	if (!setup.ok) return { dispatched: 0, refreshed: 0, error: setup.error };
	const { conn, settings } = setup;

	let dispatched = 0;
	const issues = await listIssues(ctx, conn, { label: settings.label, limit: 30 });
	for (const issue of issues) {
		const before = await getRun(ctx, issue.number);
		if (before) continue;
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

async function reschedule(ctx: PluginContext, settings: Settings): Promise<void> {
	if (!ctx.cron) return;
	await ctx.cron.cancel(CRON_TASK).catch(() => undefined);
	if (settings.enabled) await ctx.cron.schedule(CRON_TASK, { schedule: cronFor(settings.pollMinutes) });
}

// ── Plugin ───────────────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			for (const [k, v] of Object.entries(DEFAULTS)) {
				if (k === "agentKey" || k === "allowedUsers") continue;
				if ((await ctx.kv.get(`settings:${k}`)) === null) await ctx.kv.set(`settings:${k}`, v);
			}
			await reschedule(ctx, await readSettings(ctx));
			ctx.log.info("GitHub agent installed");
		},

		"plugin:uninstall": async (_event, ctx) => {
			await ctx.cron?.cancel(CRON_TASK).catch(() => undefined);
		},

		cron: async (event, ctx) => {
			if (event.name !== CRON_TASK) return;
			const settings = await readSettings(ctx);
			if (!settings.enabled) return;
			const r = await poll(ctx);
			if (r.error) ctx.log.warn(`poll skipped: ${r.error}`);
			else if (r.dispatched || r.refreshed) ctx.log.info("poll", r);
		},
	},

	routes: {
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
						agent: run ? { status: run.status, prUrl: run.prUrl, reason: run.reason } : null,
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

		/** Hand one issue to the agent now (whitelist still applies). */
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
				const run = await runIssue(ctx, setup.settings, setup.conn, issue);
				return { success: run.status !== "error" && run.status !== "skipped", run };
			},
		},

		/** Poll now: dispatch new labelled issues and refresh in-flight runs. */
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
				await reschedule(ctx, settings);
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
					await reschedule(ctx, await readSettings(ctx));
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
						return buildPage(ctx, `Issue #${issue.number} created${labels.length ? " and handed to the agent on the next poll" : ""}.`);
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
					const run = await runIssue(ctx, setup.settings, setup.conn, issue);
					return buildPage(
						ctx,
						run.status === "queued"
							? `Issue #${number} handed to the agent.`
							: `Issue #${number}: ${run.status}${run.reason ? ` — ${run.reason}` : ""}`,
					);
				}
				if (i.type === "block_action" && i.action_id === "poll_now") {
					const r = await poll(ctx);
					return buildPage(ctx, r.error ?? `Polled: ${r.dispatched} dispatched, ${r.refreshed} updated.`);
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
			description: "Connect the site's GitHub repository in Settings → General. The agent uses that connection to read issues and open pull requests.",
		});
	} else {
		blocks.push({
			type: "context",
			text: `Repository ${conn.owner}/${conn.repo} (${conn.branch}). Open issues labelled "${settings.label}" by whitelisted users are handed to the agent every ${settings.pollMinutes} min${settings.enabled ? "" : " — polling is off"}.`,
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
			elements: [{ type: "button", action_id: "poll_now", label: "Poll now", style: "secondary" }],
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
				{ type: "toggle", action_id: "agent", label: "Hand to the agent", description: `Adds the "${settings.label}" label.`, initial_value: true },
			],
			submit: { label: "Create issue", action_id: "create_issue" },
		});
		blocks.push({
			type: "form",
			block_id: "run-issue",
			fields: [{ type: "number_input", action_id: "number", label: "Run the agent on issue #", min: 1 }],
			submit: { label: "Run now", action_id: "run_issue" },
		});
	}

	blocks.push({ type: "divider" });
	blocks.push({
		type: "form",
		block_id: "settings",
		fields: [
			{ type: "toggle", action_id: "enabled", label: "Poll for labelled issues", initial_value: settings.enabled },
			{ type: "text_input", action_id: "label", label: "Trigger label", initial_value: settings.label },
			{
				type: "text_input",
				action_id: "allowedUsers",
				label: "Whitelisted GitHub users",
				placeholder: "octocat, another-user",
				initial_value: settings.allowedUsers.join(", "),
			},
			{ type: "number_input", action_id: "pollMinutes", label: "Poll every (minutes)", initial_value: settings.pollMinutes, min: 1, max: 60 },
			{ type: "text_input", action_id: "agentUrl", label: "Agent worker URL", initial_value: settings.agentUrl },
			{ type: "secret_input", action_id: "agentKey", label: settings.agentKey ? "Agent key (set — leave blank to keep)" : "Agent key" },
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
