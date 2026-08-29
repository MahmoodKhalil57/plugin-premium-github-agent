import type { PluginContext } from "@premium-cms/emdash/plugin";

export interface Settings {
	/** Master switch: webhook-triggered runs are ignored while off. */
	enabled: boolean;
	/** Issues carrying this label are picked up. */
	label: string;
	/** GitHub logins (lowercase) whose issues the agent may work on. */
	allowedUsers: string[];
	/** The Cloudflare Worker running the Think agent. */
	agentUrl: string;
	/** Shared secret for that worker (never shown back). */
	agentKey: string;
	/** Workers AI model id handed to the agent. */
	model: string;
	reasoning: "low" | "medium" | "high";
	/** How many CI runs a PR gets before the agent stops retrying (fix → build → test loops). */
	maxBuildAttempts: number;
	/** Squash-merge a PR into the default branch once every check passed. */
	autoMerge: boolean;
}

export const DEFAULTS: Settings = {
	enabled: true,
	label: "agent",
	allowedUsers: [],
	agentUrl: "https://premium-cms-issue-agent.premiumcms.workers.dev",
	agentKey: "",
	model: "@cf/zai-org/glm-5.3-flash",
	reasoning: "high",
	maxBuildAttempts: 3,
	autoMerge: true,
};

const PREFIX = "settings:";

function clampAttempts(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : DEFAULTS.maxBuildAttempts;
}

export function parseUsers(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map(String).map(normalizeLogin).filter(Boolean);
	if (typeof raw !== "string") return [];
	return raw.split(/[\s,]+/).map(normalizeLogin).filter(Boolean);
}

export function normalizeLogin(login: string): string {
	return login.trim().replace(/^@/, "").toLowerCase();
}

export async function readSettings(ctx: PluginContext): Promise<Settings> {
	const map: Record<string, unknown> = {};
	for (const e of await ctx.kv.list(PREFIX)) map[e.key.slice(PREFIX.length)] = e.value;
	const reasoning = String(map.reasoning ?? "");
	return {
		enabled: typeof map.enabled === "boolean" ? map.enabled : DEFAULTS.enabled,
		label: (typeof map.label === "string" && map.label.trim()) || DEFAULTS.label,
		allowedUsers: parseUsers(map.allowedUsers),
		agentUrl: ((typeof map.agentUrl === "string" && map.agentUrl.trim()) || DEFAULTS.agentUrl).replace(
			/\/+$/,
			"",
		),
		agentKey: typeof map.agentKey === "string" ? map.agentKey : "",
		model: (typeof map.model === "string" && map.model.trim()) || DEFAULTS.model,
		reasoning: reasoning === "low" || reasoning === "medium" ? reasoning : "high",
		maxBuildAttempts: clampAttempts(map.maxBuildAttempts),
		autoMerge: typeof map.autoMerge === "boolean" ? map.autoMerge : DEFAULTS.autoMerge,
	};
}

export async function saveSettings(ctx: PluginContext, values: Record<string, unknown>): Promise<void> {
	if (typeof values.enabled === "boolean") await ctx.kv.set(`${PREFIX}enabled`, values.enabled);
	if (typeof values.label === "string") await ctx.kv.set(`${PREFIX}label`, values.label.trim() || DEFAULTS.label);
	if (typeof values.allowedUsers === "string") {
		await ctx.kv.set(`${PREFIX}allowedUsers`, parseUsers(values.allowedUsers).join(", "));
	}
	if (typeof values.agentUrl === "string") {
		await ctx.kv.set(`${PREFIX}agentUrl`, values.agentUrl.trim().replace(/\/+$/, "") || DEFAULTS.agentUrl);
	}
	// An empty secret field means "keep what is stored".
	if (typeof values.agentKey === "string" && values.agentKey.trim()) {
		await ctx.kv.set(`${PREFIX}agentKey`, values.agentKey.trim());
	}
	if (typeof values.model === "string") await ctx.kv.set(`${PREFIX}model`, values.model.trim() || DEFAULTS.model);
	if (values.reasoning === "low" || values.reasoning === "medium" || values.reasoning === "high") {
		await ctx.kv.set(`${PREFIX}reasoning`, values.reasoning);
	}
	if (values.maxBuildAttempts !== undefined) {
		await ctx.kv.set(`${PREFIX}maxBuildAttempts`, clampAttempts(values.maxBuildAttempts));
	}
	if (typeof values.autoMerge === "boolean") await ctx.kv.set(`${PREFIX}autoMerge`, values.autoMerge);
}

/** Master switch: with `enabled` off, webhooks and manual runs are ignored. */
