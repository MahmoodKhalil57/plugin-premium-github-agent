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
	/** How many times the agent was asked about this issue. */
	attempt?: number;
	updatedAt: string;
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
	attempt: number,
	callbackUrl: string,
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
