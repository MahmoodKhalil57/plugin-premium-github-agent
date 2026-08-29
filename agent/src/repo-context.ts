/**
 * Per-repository agent context, read from the repo itself on every run:
 *
 *   .agents/skills/<name>/SKILL.md   Agent Skills (frontmatter + body), plus
 *                                    text files next to them as resources
 *   .mcp.json                        { "mcpServers": { name: { url, headers } } }
 *
 * Everything is fetched with the site's token at the branch being worked on,
 * so project users extend the agent by committing files — no platform change.
 * Only remote HTTP MCP servers are usable from a Worker; `command` entries
 * are reported and skipped.
 */

import { skills } from "@cloudflare/think";
import type { SkillManifest, SkillManifestEntry, SkillManifestResource } from "agents/skills";

const API = "https://api.github.com";
const SKILLS_DIR = ".agents/skills/";
const MAX_RESOURCE_BYTES = 64 * 1024;
const MAX_SKILLS = 20;

export interface RepoMcpServer {
	name: string;
	url: string;
	headers: Record<string, string>;
}

export interface RepoContext {
	/** Tree sha of the branch — the manifest fingerprint. */
	sha: string;
	manifest: SkillManifest | null;
	mcp: RepoMcpServer[];
	/** Human-readable notes (skipped entries, parse errors) for the transcript. */
	notes: string[];
}

interface TreeEntry {
	path: string;
	type: string;
	sha: string;
	size?: number;
}

async function gh(token: string, path: string, accept = "application/vnd.github+json"): Promise<Response> {
	return fetch(`${API}${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: accept,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "premium-cms-issue-agent/1.0",
		},
	});
}

async function blobText(token: string, owner: string, repo: string, sha: string): Promise<string | null> {
	const r = await gh(token, `/repos/${owner}/${repo}/git/blobs/${sha}`, "application/vnd.github.raw+json");
	if (!r.ok) return null;
	return r.text();
}

function resourceKind(path: string): SkillManifestResource["kind"] {
	if (/\.(mjs|cjs|js|ts|py|sh)$/i.test(path)) return "script";
	if (/\.(md|txt|json|yaml|yml|csv)$/i.test(path)) return "reference";
	return "file";
}

export async function loadRepoContext(
	owner: string,
	repo: string,
	ref: string,
	token: string,
): Promise<RepoContext> {
	const notes: string[] = [];
	const treeRes = await gh(token, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
	if (!treeRes.ok) return { sha: "", manifest: null, mcp: [], notes: [`repo tree unreadable (${treeRes.status})`] };
	const tree = (await treeRes.json()) as { sha: string; tree: TreeEntry[]; truncated?: boolean };
	const blobs = tree.tree.filter((e) => e.type === "blob");

	// Skills: one directory per skill, SKILL.md required.
	const skillDirs = new Map<string, TreeEntry[]>();
	for (const e of blobs) {
		if (!e.path.startsWith(SKILLS_DIR)) continue;
		const rest = e.path.slice(SKILLS_DIR.length);
		const dir = rest.split("/")[0];
		if (!dir || !rest.includes("/")) continue;
		skillDirs.set(dir, [...(skillDirs.get(dir) ?? []), e]);
	}
	const entries: SkillManifestEntry[] = [];
	for (const [dir, files] of [...skillDirs].slice(0, MAX_SKILLS)) {
		const skillFile = files.find((f) => f.path === `${SKILLS_DIR}${dir}/SKILL.md`);
		if (!skillFile) {
			notes.push(`.agents/skills/${dir}: no SKILL.md, skipped`);
			continue;
		}
		const raw = await blobText(token, owner, repo, skillFile.sha);
		const parsed = raw ? skills.parseSkillMarkdown(raw) : null;
		if (!parsed) {
			notes.push(`.agents/skills/${dir}/SKILL.md: missing name/description frontmatter, skipped`);
			continue;
		}
		const resources: SkillManifestResource[] = [];
		for (const f of files) {
			if (f === skillFile) continue;
			const rel = f.path.slice(`${SKILLS_DIR}${dir}/`.length);
			if ((f.size ?? 0) > MAX_RESOURCE_BYTES) {
				notes.push(`${f.path}: larger than 64 KiB, not loaded`);
				continue;
			}
			const content = await blobText(token, owner, repo, f.sha);
			if (content === null) continue;
			resources.push({ path: rel, kind: resourceKind(rel), size: content.length, encoding: "text", content });
		}
		entries.push({ ...parsed, name: parsed.name || dir, rawContent: raw ?? undefined, resources });
	}
	if (skillDirs.size > MAX_SKILLS) notes.push(`only the first ${MAX_SKILLS} skills were loaded`);

	// MCP servers.
	const mcp: RepoMcpServer[] = [];
	const mcpFile = blobs.find((e) => e.path === ".mcp.json");
	if (mcpFile) {
		const raw = await blobText(token, owner, repo, mcpFile.sha);
		try {
			const cfg = JSON.parse(raw ?? "{}") as { mcpServers?: Record<string, Record<string, unknown>> };
			for (const [name, def] of Object.entries(cfg.mcpServers ?? {})) {
				if (typeof def.url === "string" && /^https:\/\//.test(def.url)) {
					const headers: Record<string, string> = {};
					for (const [k, v] of Object.entries((def.headers as Record<string, unknown>) ?? {})) {
						if (typeof v === "string") headers[k] = v;
					}
					mcp.push({ name, url: def.url, headers });
				} else {
					notes.push(`.mcp.json: "${name}" is not a remote https server, skipped`);
				}
			}
		} catch {
			notes.push(".mcp.json: invalid JSON, skipped");
		}
	}

	const manifest: SkillManifest | null = entries.length
		? { id: `repo:${owner}/${repo}`.toLowerCase(), fingerprint: `${tree.sha}:${entries.length}`, skills: entries }
		: null;
	return { sha: tree.sha, manifest, mcp, notes };
}
