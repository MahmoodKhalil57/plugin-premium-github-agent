/**
 * Talks to the agent worker (a Cloudflare Worker running a Think agent with
 * GitHub's MCP server). Every run is keyed by issue number and idempotent on
 * the worker, so re-dispatching is safe.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

import type { Connection } from "./github.js";
import type { Settings } from "./settings.js";

export type RunStatus = "queued" | "running" | "completed" | "error" | "skipped";

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
	updatedAt: string;
}

export function runId(number: number): string {
	return String(number);
}

async function call(
	ctx: PluginContext,
	settings: Settings,
	method: "GET" | "POST",
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

export async function dispatch(
	ctx: PluginContext,
	settings: Settings,
	conn: Connection,
	issue: number,
): Promise<{ submissionId: string; accepted: boolean }> {
	const r = await call(ctx, settings, "POST", "/run", {
		owner: conn.owner,
		repo: conn.repo,
		branch: conn.branch,
		issue,
		token: conn.token,
		model: settings.model,
		reasoning: settings.reasoning,
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
