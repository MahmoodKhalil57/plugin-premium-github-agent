/**
 * premium-cms-issue-agent — a Think agent that turns a labelled GitHub issue
 * into an open pull request, entirely through GitHub's remote MCP server.
 *
 * One Durable Object per (repo, issue). The PremiumCMS "GitHub agent" plugin
 * calls `POST /run` with the site's own GitHub token; the token lives only in
 * the MCP connection of that object and is never logged or stored elsewhere.
 * There is no bash, no fetch, no scripts: the model reads and writes the repo
 * with MCP tools only, guided by a single bundled skill (dry coding).
 */

import { Think } from "@cloudflare/think";
import { getAgentByName } from "agents";
import { skills } from "@cloudflare/think";

import { Sandbox } from "@cloudflare/sandbox";

import { previewWorkerName, runCi, type CiInput } from "./ci.js";
import { FIX_ISSUE_SKILL } from "./skill.js";

export { Sandbox };

interface Env {
	AI: Ai;
	IssueFixer: DurableObjectNamespace<IssueFixer>;
	Sandbox: DurableObjectNamespace<Sandbox>;
	/** Shared secret the plugin sends as `Authorization: Bearer …`. */
	AGENT_KEY: string;
	/** Default model; `run` may override per request. */
	MODEL?: string;
	/** Platform Cloudflare account that hosts PR previews (assets-only Workers). */
	CF_ACCOUNT_ID?: string;
	CF_API_TOKEN?: string;
}

const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";
const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";

/** Tools that would take the run past "open a PR" — refused even if the model asks. */
const FORBIDDEN = /merge|delete|close|update_issue|update_pull_request_branch|request_copilot|assign|lock|transfer/i;

export interface RunInput {
	owner: string;
	repo: string;
	branch: string;
	issue: number;
	token: string;
	model?: string;
	reasoning?: "low" | "medium" | "high";
	/** Retry counter: a new attempt is a new turn on the same object (default 1). */
	attempt?: number;
	/** Where to POST the outcome (signed with AGENT_KEY) when the run ends. */
	callbackUrl?: string;
	/** Extra context for this attempt, e.g. the failing CI log. */
	note?: string;
}

interface Watch {
	submissionId: string;
	issue: number;
	attempt: number;
	callbackUrl: string;
	polls: number;
}

export class IssueFixer extends Think<Env> {
	workspaceBash = false;
	fetchTools = false as const;
	includeMcpTools = true;
	waitForMcpConnections = { timeout: 30_000 };
	maxSteps = 80;
	sendReasoning = false;

	private model = DEFAULT_MODEL;
	private reasoning: "low" | "medium" | "high" = "high";

	getModel() {
		return this.model;
	}

	getSystemPrompt() {
		return "You fix GitHub issues by opening pull requests. Activate the fix-github-issue skill and follow it exactly. You cannot run code.";
	}

	getSkills() {
		return [
			skills.fromManifest({
				id: "premium-cms-issue-agent",
				fingerprint: "fix-github-issue@2",
				skills: [FIX_ISSUE_SKILL],
			}),
		];
	}

	getSkillScriptRunner() {
		return null;
	}

	beforeToolCall(ctx: { toolName: string }) {
		if (FORBIDDEN.test(ctx.toolName)) {
			return {
				action: "block" as const,
				reason: `"${ctx.toolName}" is not allowed: this agent only opens pull requests.`,
			};
		}
		return undefined;
	}

	/**
	 * Connect the GitHub MCP server with the site's token and queue the turn.
	 * Idempotent per issue: re-running returns the existing submission.
	 */
	async run(input: RunInput): Promise<{ submissionId: string; accepted: boolean }> {
		this.model = input.model || this.env.MODEL || DEFAULT_MODEL;
		this.reasoning = input.reasoning ?? "high";

		const existing = this.getMcpServers();
		const connected = Object.values(existing.servers ?? {}).some(
			(s: { name?: string }) => s.name === "github",
		);
		if (!connected) {
			await this.addMcpServer("github", GITHUB_MCP, {
				transport: {
					type: "streamable-http",
					headers: {
						Authorization: `Bearer ${input.token}`,
						"X-MCP-Toolsets": "repos,issues,pull_requests",
					},
				},
			});
		}

		const attempt = Math.max(1, Math.floor(input.attempt ?? 1));
		const text = [
			`Repository: ${input.owner}/${input.repo} (default branch: ${input.branch})`,
			`Issue: #${input.issue}`,
			"",
			attempt > 1
				? `This is attempt ${attempt}. Re-read the issue and the repository state (branches and pull requests you opened earlier may exist — reuse or correct them rather than duplicating). Fix this issue and open or update a pull request. Do not merge it.`
				: "Fix this issue and open a pull request. Do not merge it.",
			...(input.note ? ["", input.note] : []),
		].join("\n");

		const res = await this.submitMessages(
			[{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }],
			{ idempotencyKey: `issue-${input.issue}-attempt-${attempt}` },
		);
		if (input.callbackUrl) {
			const watch: Watch = {
				submissionId: res.submissionId,
				issue: input.issue,
				attempt,
				callbackUrl: input.callbackUrl,
				polls: 0,
			};
			await this.schedule(20, "watch", watch);
		}
		return { submissionId: res.submissionId, accepted: res.accepted };
	}

	/**
	 * Durable follow-up: re-checks the submission until it is terminal, then
	 * POSTs `{issue, attempt, submissionId, status, answer, prUrl}` to the
	 * callback, signed as `X-Agent-Signature: sha256=<hmac(AGENT_KEY, body)>`.
	 */
	async watch(w: Watch): Promise<void> {
		const s = await this.status(w.submissionId);
		const terminal = ["completed", "error", "aborted", "skipped", "unknown"].includes(s.status);
		if (!terminal) {
			if (w.polls < 360) await this.schedule(20, "watch", { ...w, polls: w.polls + 1 });
			return;
		}
		const body = JSON.stringify({
			issue: w.issue,
			attempt: w.attempt,
			submissionId: w.submissionId,
			status: s.status,
			answer: s.answer,
			prUrl: s.answer?.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0] ?? null,
		});
		const sig = await hmac(this.env.AGENT_KEY, body);
		try {
			const r = await fetch(w.callbackUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Agent-Signature": `sha256=${sig}`,
					"User-Agent": "premium-cms-issue-agent/1.0",
				},
				body,
			});
			if (!r.ok && w.polls < 360) await this.schedule(60, "watch", { ...w, polls: w.polls + 30 });
		} catch {
			if (w.polls < 360) await this.schedule(60, "watch", { ...w, polls: w.polls + 30 });
		}
	}

	/**
	 * Pull-request CI. `startCi` schedules the job on this object (durable,
	 * runs to completion inside the container) and returns at once; `ciJob`
	 * signs and POSTs the result to the plugin when done.
	 */
	async startCi(input: CiInput): Promise<{ accepted: true }> {
		await this.schedule(1, "ciJob", input);
		return { accepted: true };
	}

	async ciJob(input: CiInput): Promise<void> {
		const host =
			this.env.CF_ACCOUNT_ID && this.env.CF_API_TOKEN
				? { accountId: this.env.CF_ACCOUNT_ID, apiToken: this.env.CF_API_TOKEN }
				: null;
		await this.ctx.storage.put("ci:running", { attempt: input.attempt, startedAt: new Date().toISOString() });
		const result = await runCi(this.env.Sandbox, input, host);
		await this.ctx.storage.put("ci:last", result);
		await this.ctx.storage.delete("ci:running");
		const payload = JSON.stringify(result);
		const sig = await hmac(this.env.AGENT_KEY, payload);
		for (let i = 0; i < 3; i++) {
			try {
				const r = await fetch(input.callbackUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Agent-Signature": `sha256=${sig}`,
						"User-Agent": "premium-cms-issue-agent/1.0",
					},
					body: payload,
				});
				if (r.ok) return;
			} catch {
				/* retry */
			}
			await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
		}
	}

	/** The last CI result on this PR (and whether one is in flight). */
	async ciStatus(): Promise<{ running: unknown; last: unknown }> {
		return {
			running: (await this.ctx.storage.get("ci:running")) ?? null,
			last: (await this.ctx.storage.get("ci:last")) ?? null,
		};
	}

	/** Compact transcript: every text + tool part, for operators and the admin page. */
	async transcript(limit = 60): Promise<Array<{ role: string; type: string; text: string }>> {
		const out: Array<{ role: string; type: string; text: string }> = [];
		for (const m of this.messages) {
			for (const p of m.parts as Array<Record<string, unknown>>) {
				const type = String(p.type ?? "");
				if (type === "text") out.push({ role: m.role, type, text: String(p.text ?? "").slice(0, 600) });
				else if (type.startsWith("tool-") || type === "dynamic-tool") {
					const name = String(p.toolName ?? type.replace(/^tool-/, ""));
					const state = String(p.state ?? "");
					const input = JSON.stringify(p.input ?? {}).slice(0, 300);
					const output = p.output !== undefined ? JSON.stringify(p.output).slice(0, 300) : "";
					const err = p.errorText ? ` error=${String(p.errorText).slice(0, 200)}` : "";
					out.push({ role: m.role, type: "tool", text: `${name} [${state}] ${input}${output ? ` → ${output}` : ""}${err}` });
				} else if (type === "reasoning") out.push({ role: m.role, type, text: String(p.text ?? "").slice(0, 200) });
			}
		}
		return out.slice(-limit);
	}

	/** Terminal status + the model's final answer (PR url or NO_PR: reason). */
	async status(submissionId: string): Promise<{
		status: string;
		answer: string | null;
	}> {
		const s = await this.inspectSubmission(submissionId);
		if (!s) return { status: "unknown", answer: null };
		let answer: string | null = null;
		if (s.status === "completed") {
			const last = [...this.messages].reverse().find((m) => m.role === "assistant");
			answer =
				last?.parts
					.filter((p): p is { type: "text"; text: string } => p.type === "text")
					.map((p) => p.text)
					.join("")
					.trim() || null;
		}
		return { status: s.status, answer };
	}
}

async function hmac(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function nameFor(owner: string, repo: string, issue: number): string {
	return `${owner}/${repo}#${issue}`.toLowerCase();
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true });

		const auth = request.headers.get("Authorization") ?? "";
		if (!env.AGENT_KEY || auth !== `Bearer ${env.AGENT_KEY}`) {
			return json({ error: "unauthorized" }, 401);
		}

		if (request.method === "POST" && url.pathname === "/run") {
			const body = (await request.json().catch(() => null)) as Partial<RunInput> | null;
			if (
				!body ||
				typeof body.owner !== "string" ||
				typeof body.repo !== "string" ||
				typeof body.token !== "string" ||
				typeof body.issue !== "number"
			) {
				return json({ error: "owner, repo, issue (number) and token are required" }, 400);
			}
			const agent = await getAgentByName(env.IssueFixer, nameFor(body.owner, body.repo, body.issue));
			const out = await agent.run({
				owner: body.owner,
				repo: body.repo,
				branch: body.branch || "main",
				issue: body.issue,
				token: body.token,
				model: body.model,
				reasoning: body.reasoning,
				attempt: typeof body.attempt === "number" ? body.attempt : 1,
				callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
				note: typeof body.note === "string" ? body.note.slice(0, 12_000) : undefined,
			});
			return json(out);
		}

		// Pull-request CI: accepted immediately, run inside a durable object
		// (the container does the work), result POSTed to the callback.
		if (request.method === "POST" && url.pathname === "/ci") {
			const body = (await request.json().catch(() => null)) as Partial<CiInput> | null;
			const need = ["owner", "repo", "headRef", "headSha", "staticBranch", "token", "backendUrl", "siteUrl", "callbackUrl"] as const;
			if (!body || typeof body.pr !== "number" || need.some((k) => typeof body[k] !== "string")) {
				return json({ error: `pr (number, 0 for a branch build) and ${need.join(", ")} are required` }, 400);
			}
			const input: CiInput = {
				owner: body.owner!,
				repo: body.repo!,
				headRef: body.headRef!,
				headSha: body.headSha!,
				pr: body.pr,
				attempt: typeof body.attempt === "number" ? body.attempt : 1,
				staticBranch: body.staticBranch!,
				token: body.token!,
				backendUrl: body.backendUrl!,
				previewSecret: typeof body.previewSecret === "string" ? body.previewSecret : "",
				siteUrl: body.siteUrl!,
				callbackUrl: body.callbackUrl!,
				preview: body.preview !== false,
			};
			const key = input.pr > 0 ? nameFor(input.owner, input.repo, input.pr) : `${input.owner}/${input.repo}@${input.headRef}`.toLowerCase();
			const agent = await getAgentByName(env.IssueFixer, `ci:${key}`);
			return json(await agent.startCi(input), 202);
		}

		if (request.method === "GET" && url.pathname === "/status") {
			const owner = url.searchParams.get("owner") ?? "";
			const repo = url.searchParams.get("repo") ?? "";
			const issue = Number(url.searchParams.get("issue"));
			const id = url.searchParams.get("submission") ?? "";
			if (!owner || !repo || !Number.isFinite(issue) || !id) {
				return json({ error: "owner, repo, issue and submission are required" }, 400);
			}
			const agent = await getAgentByName(env.IssueFixer, nameFor(owner, repo, issue));
			return json(await agent.status(id));
		}

		if (request.method === "GET" && url.pathname === "/ci/status") {
			const owner = url.searchParams.get("owner") ?? "";
			const repo = url.searchParams.get("repo") ?? "";
			const pr = Number(url.searchParams.get("pr") ?? "0");
			const branch = url.searchParams.get("branch") ?? "";
			if (!owner || !repo || (!(pr > 0) && !branch)) return json({ error: "owner, repo and pr or branch required" }, 400);
			const key = pr > 0 ? nameFor(owner, repo, pr) : `${owner}/${repo}@${branch}`.toLowerCase();
			const agent = await getAgentByName(env.IssueFixer, `ci:${key}`);
			return json(await agent.ciStatus());
		}

		// Remove a PR's preview Worker (the PR was closed or merged).
		if (request.method === "DELETE" && url.pathname === "/preview") {
			const owner = url.searchParams.get("owner") ?? "";
			const repo = url.searchParams.get("repo") ?? "";
			const pr = Number(url.searchParams.get("pr"));
			if (!owner || !repo || !Number.isInteger(pr)) return json({ error: "owner, repo, pr required" }, 400);
			if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return json({ error: "previews are not configured" }, 501);
			const name = previewWorkerName(owner, repo, pr);
			const r = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${name}`,
				{ method: "DELETE", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
			);
			return json({ name, deleted: r.ok || r.status === 404 });
		}

		if (request.method === "GET" && url.pathname === "/transcript") {
			const owner = url.searchParams.get("owner") ?? "";
			const repo = url.searchParams.get("repo") ?? "";
			const issue = Number(url.searchParams.get("issue"));
			if (!owner || !repo || !Number.isFinite(issue)) return json({ error: "owner, repo, issue required" }, 400);
			const agent = await getAgentByName(env.IssueFixer, nameFor(owner, repo, issue));
			return json({ items: await agent.transcript(Number(url.searchParams.get("limit")) || 60) });
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
