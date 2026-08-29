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

import { FIX_ISSUE_SKILL } from "./skill.js";

interface Env {
	AI: Ai;
	IssueFixer: DurableObjectNamespace<IssueFixer>;
	/** Shared secret the plugin sends as `Authorization: Bearer …`. */
	AGENT_KEY: string;
	/** Default model; `run` may override per request. */
	MODEL?: string;
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
				fingerprint: "fix-github-issue@1",
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

		const text = [
			`Repository: ${input.owner}/${input.repo} (default branch: ${input.branch})`,
			`Issue: #${input.issue}`,
			"",
			"Fix this issue and open a pull request. Do not merge it.",
		].join("\n");

		const res = await this.submitMessages(
			[{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }],
			{ idempotencyKey: `issue-${input.issue}` },
		);
		return { submissionId: res.submissionId, accepted: res.accepted };
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
			});
			return json(out);
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

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
