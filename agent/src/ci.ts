/**
 * Pull-request CI in a Cloudflare container (Sandbox SDK): check → build →
 * push the static build to its own branch → test. One container per PR,
 * reused across attempts so the static branch is updated, never duplicated.
 *
 * The site's GitHub token and preview secret live only in this job's env;
 * they are never written to disk in the container (the clone uses a
 * credential helper fed from the environment).
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export interface CiInput {
	owner: string;
	repo: string;
	/** PR head branch (the fix branch). */
	headRef: string;
	headSha: string;
	pr: number;
	attempt: number;
	/** Branch that receives dist/ (force-pushed each run). */
	staticBranch: string;
	token: string;
	backendUrl: string;
	previewSecret: string;
	siteUrl: string;
	callbackUrl: string;
}

export interface StepResult {
	ok: boolean;
	/** Tail of the combined output, trimmed for a PR comment. */
	log: string;
	seconds: number;
}

export interface CiResult {
	pr: number;
	attempt: number;
	headSha: string;
	staticBranch: string;
	staticSha: string | null;
	check: StepResult | null;
	build: StepResult | null;
	push: StepResult | null;
	test: StepResult | null;
	/** Hosting the passing build on Cloudflare (assets-only Worker). */
	preview: StepResult | null;
	previewUrl: string | null;
	ok: boolean;
	error?: string;
}

/** Cloudflare account that hosts PR previews (the platform's). */
export interface PreviewHost {
	accountId: string;
	apiToken: string;
}

/** Worker name for a PR preview: stable per (repo, PR), valid for workers.dev. */
export function previewWorkerName(owner: string, repo: string, pr: number): string {
	const slug = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return `preview-${slug.slice(0, 40).replace(/-+$/, "")}-pr${pr}`;
}

const LOG_TAIL = 6000;
const WORK = "/workspace/site";
const OUT = "/workspace/static";

function tail(s: string): string {
	return s.length > LOG_TAIL ? `…${s.slice(-LOG_TAIL)}` : s;
}

async function step(
	sb: Sandbox,
	cmd: string,
	opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number },
): Promise<StepResult> {
	const t0 = Date.now();
	try {
		const r = await sb.exec(cmd, { cwd: opts.cwd, env: opts.env, timeout: opts.timeout ?? 15 * 60_000 });
		const log = tail([r.stdout, r.stderr].filter(Boolean).join("\n"));
		return { ok: r.success, log, seconds: Math.round((Date.now() - t0) / 1000) };
	} catch (e) {
		return { ok: false, log: tail(String(e)), seconds: Math.round((Date.now() - t0) / 1000) };
	}
}

export async function runCi(
	ns: DurableObjectNamespace<Sandbox>,
	input: CiInput,
	host: PreviewHost | null,
): Promise<CiResult> {
	const out: CiResult = {
		pr: input.pr,
		attempt: input.attempt,
		headSha: input.headSha,
		staticBranch: input.staticBranch,
		staticSha: null,
		check: null,
		build: null,
		push: null,
		test: null,
		preview: null,
		previewUrl: null,
		ok: false,
	};
	const sb = getSandbox(ns, `${input.owner}/${input.repo}#${input.pr}`.toLowerCase(), { sleepAfter: "5m" });
	const repoUrl = `https://github.com/${input.owner}/${input.repo}.git`;
	// Credentials only ever travel through the environment of each command.
	const gitEnv = {
		GIT_ASKPASS: "/workspace/askpass.sh",
		GIT_TERMINAL_PROMPT: "0",
		GH_TOKEN: input.token,
		GIT_AUTHOR_NAME: "premium-cms-agent",
		GIT_AUTHOR_EMAIL: "agent@premium-cms.com",
		GIT_COMMITTER_NAME: "premium-cms-agent",
		GIT_COMMITTER_EMAIL: "agent@premium-cms.com",
	};

	try {
		await sb.mkdir("/workspace", { recursive: true });
		await sb.writeFile("/workspace/askpass.sh", '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$GH_TOKEN";; esac\n');
		await sb.exec("chmod +x /workspace/askpass.sh", { cwd: "/workspace" });

		// Fresh checkout of the PR head each attempt (the container may be reused).
		const clone = await step(
			sb,
			`rm -rf ${WORK} && git clone --depth 1 --branch "${input.headRef}" "${repoUrl}" ${WORK} && cd ${WORK} && git rev-parse HEAD`,
			{ cwd: "/workspace", env: gitEnv, timeout: 5 * 60_000 },
		);
		if (!clone.ok) {
			out.check = clone;
			out.error = "clone failed";
			return out;
		}

		const install = await step(sb, "bun install --frozen-lockfile 2>/dev/null || bun install", {
			cwd: WORK,
			timeout: 10 * 60_000,
		});
		if (!install.ok) {
			out.check = install;
			out.error = "install failed";
			return out;
		}

		out.check = await step(sb, "npm run --if-present check:cf", { cwd: WORK });
		if (!out.check.ok) {
			out.error = "check:cf failed";
			return out;
		}

		// Build against the site's content snapshot — the same inputs its own
		// GitHub Actions deploy uses.
		out.build = await step(
			sb,
			`node bin/snapshot-to-sqlite.mjs "${input.backendUrl}" ./snapshot.db && npm run build`,
			{
				cwd: WORK,
				env: {
					EMDASH_PREVIEW_SECRET: input.previewSecret,
					EMDASH_SNAPSHOT_DB: "./snapshot.db",
					SITE_URL: input.siteUrl,
				},
			},
		);
		if (!out.build.ok) {
			out.error = "build failed";
			return out;
		}

		// dist/ → the static branch: a single-commit history, force-pushed, so the
		// branch always holds exactly the latest build of the PR head.
		out.push = await step(
			sb,
			[
				`rm -rf ${OUT} && mkdir -p ${OUT} && cp -r ${WORK}/dist/. ${OUT}/`,
				`cd ${OUT} && git init -q -b "${input.staticBranch}" && touch .nojekyll`,
				`git add -A && git commit -q -m "static build of ${input.headRef} @ ${input.headSha.slice(0, 7)} (PR #${input.pr}, attempt ${input.attempt})"`,
				`git push -q --force "${repoUrl}" "HEAD:refs/heads/${input.staticBranch}" && git rev-parse HEAD`,
			].join(" && "),
			{ cwd: "/workspace", env: gitEnv, timeout: 5 * 60_000 },
		);
		if (!out.push.ok) {
			out.error = "static push failed";
			return out;
		}
		out.staticSha = out.push.log.match(/^[0-9a-f]{40}$/m)?.[0] ?? null;

		out.test = await step(sb, "npm run --if-present test:cf", { cwd: WORK });
		if (!out.test.ok) {
			out.error = "test:cf failed";
			return out;
		}

		// Tests passed: host the exact bytes that went to the static branch as an
		// assets-only Worker on the platform account. The config never touches
		// the static branch (it is written after the push).
		if (host) {
			const name = previewWorkerName(input.owner, input.repo, input.pr);
			await sb.writeFile(
				`${OUT}/wrangler.preview.jsonc`,
				JSON.stringify({ name, compatibility_date: "2026-08-01", assets: { directory: "./" }, workers_dev: true }),
			);
			out.preview = await step(
				sb,
				"rm -rf .git && npx --yes wrangler@4 deploy --config wrangler.preview.jsonc 2>&1 | grep -viE 'api token|account id'",
				{
					cwd: OUT,
					env: { CLOUDFLARE_API_TOKEN: host.apiToken, CLOUDFLARE_ACCOUNT_ID: host.accountId, WRANGLER_SEND_METRICS: "false" },
					timeout: 10 * 60_000,
				},
			);
			const url = out.preview.log.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0] ?? null;
			if (!out.preview.ok || !url) {
				out.error = "preview deploy failed";
				return out;
			}
			out.previewUrl = url;
		}
		out.ok = true;
		return out;
	} catch (e) {
		out.error = String(e);
		return out;
	}
}
