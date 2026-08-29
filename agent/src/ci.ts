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

import { applyPlan, historyBranches, rotationPlan, type RefUpdate } from "./rotation.js";

export interface CiInput {
	owner: string;
	repo: string;
	/** Branch to build: a PR head, or the default branch for a `branch` build. */
	headRef: string;
	headSha: string;
	/** Pull request number; 0 for a plain branch build (e.g. the default branch). */
	pr: number;
	attempt: number;
	/** Branch that receives dist/ (force-pushed each run). */
	staticBranch: string;
	token: string;
	backendUrl: string;
	previewSecret: string;
	siteUrl: string;
	callbackUrl: string;
	/**
	 * PR builds: where the platform serves `staticBranch` straight from the
	 * repository (`https://<rn>--pr-N.premium-cms.com`). The run waits until
	 * that URL serves the commit it pushed, then runs `test:preview:cf` there.
	 */
	previewUrl?: string | null;
	/** Branch builds: keep this many previous deployments as `<staticBranch>-b-N` branches. */
	previous?: number;
	/** Branch builds: where the platform serves each kept deployment (`-b-1` first). */
	previousUrls?: Array<string | null>;
}

/** An earlier deployment of a branch, kept on its own static branch. */
export interface PreviousDeployment {
	branch: string;
	sha: string;
	previewUrl: string | null;
}

export interface StepResult {
	ok: boolean;
	/** Tail of the combined output, trimmed for a PR comment. */
	log: string;
	seconds: number;
}

export interface CiResult {
	pr: number;
	/** The branch that was built. */
	branch: string;
	attempt: number;
	headSha: string;
	staticBranch: string;
	staticSha: string | null;
	check: StepResult | null;
	build: StepResult | null;
	push: StepResult | null;
	test: StepResult | null;
	/** The git-served preview answering with the pushed commit. */
	preview: StepResult | null;
	previewUrl: string | null;
	/** `test:preview:cf` run against the live preview (PREVIEW_URL). */
	previewTest: StepResult | null;
	/** Branch builds: the deployments before this one, nearest first (`-b-1`, `-b-2`). */
	previous: PreviousDeployment[];
	ok: boolean;
	error?: string;
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

/**
 * The platform serves the static branch from git and caches by commit: wait
 * until the preview answers with the commit this run pushed (`X-Preview-Commit`),
 * so the tests run against these bytes and not the previous build's.
 */
export async function waitForPreview(url: string, commit: string | null, attempts = 24): Promise<StepResult> {
	const t0 = Date.now();
	let last = "";
	for (let i = 0; i < attempts; i++) {
		try {
			const r = await fetch(`${url.replace(/\/+$/, "")}/`, { method: "GET", redirect: "manual", headers: { "cache-control": "no-cache" } });
			const served = r.headers.get("x-preview-commit") ?? "";
			last = `${r.status} ${served ? `@ ${served.slice(0, 7)}` : "(no preview headers)"}`;
			if (r.status < 500 && (!commit || served === commit)) {
				return { ok: true, log: `${url} serves ${served ? served.slice(0, 7) : "the branch"}`, seconds: Math.round((Date.now() - t0) / 1000) };
			}
		} catch (e) {
			last = String(e);
		}
		await new Promise((res) => setTimeout(res, 5000));
	}
	return { ok: false, log: `${url} did not serve ${commit?.slice(0, 7) ?? "the branch"} in time (last: ${last})`, seconds: Math.round((Date.now() - t0) / 1000) };
}

/** A transient platform condition (no container slot free right now). */
export function isCapacityError(message: string | undefined): boolean {
	return /ContainerUnavailableError|Maximum number of running container/i.test(message ?? "");
}

const GITHUB_API = "https://api.github.com";

interface RepoAuth {
	owner: string;
	repo: string;
	token: string;
}

async function github(
	auth: RepoAuth,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	const r = await fetch(`${GITHUB_API}/repos/${auth.owner}/${auth.repo}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${auth.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "premium-cms-issue-agent/1.0",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
	return { status: r.status, json };
}

async function refSha(auth: RepoAuth, branch: string): Promise<string | null> {
	const r = await github(auth, "GET", `/git/ref/heads/${branch}`);
	if (r.status === 404) return null;
	const sha = (r.json?.object as { sha?: string } | undefined)?.sha;
	if (r.status !== 200 || !sha) throw new Error(`GitHub ${r.status} reading ${branch}`);
	return sha;
}

/** Point a branch at a commit (created when missing); refs only, no checkout. */
async function setRef(auth: RepoAuth, u: RefUpdate): Promise<void> {
	const r = await github(auth, "PATCH", `/git/refs/heads/${u.branch}`, { sha: u.sha, force: true });
	if (r.status === 200) return;
	if (r.status === 404 || r.status === 422) {
		const c = await github(auth, "POST", "/git/refs", { ref: `refs/heads/${u.branch}`, sha: u.sha });
		if (c.status === 201) return;
		throw new Error(`GitHub ${c.status} creating ${u.branch}: ${String(c.json?.message ?? "")}`);
	}
	throw new Error(`GitHub ${r.status} updating ${u.branch}: ${String(r.json?.message ?? "")}`);
}

/** Stage names reported while a run progresses (each maps to a PR comment command). */
export type CiStage = "check" | "test" | "preview" | "previewTest";
export type StageReporter = (stage: CiStage, result: StepResult, extra?: { previewUrl?: string }) => Promise<void>;

export async function runCi(
	ns: DurableObjectNamespace<Sandbox>,
	input: CiInput,
	report: StageReporter = async () => undefined,
): Promise<CiResult> {
	const out: CiResult = {
		pr: input.pr,
		branch: input.headRef,
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
		previewTest: null,
		previous: [],
		ok: false,
	};
	const sb = getSandbox(ns, `${input.owner}/${input.repo}#${input.pr || input.headRef}`.toLowerCase(), { sleepAfter: "2m" });
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
			await report("check", out.check);
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
			await report("check", out.build);
			return out;
		}

		// Branch builds keep their previous deployments: shift `static/x` →
		// `static/x-b-1` → `static/x-b-2` (refs only) before the new build takes
		// the live slot. A retried build whose push never landed does not rotate again.
		const keep = input.pr === 0 ? Math.max(0, Math.min(5, Math.floor(input.previous ?? 0))) : 0;
		const names = historyBranches(input.staticBranch, keep);
		let history: Array<string | null> = [];
		if (keep > 0) {
			try {
				const shas = await Promise.all(names.map((b) => refSha(input, b)));
				const plan = rotationPlan(names, shas);
				for (const u of plan) await setRef(input, u);
				history = applyPlan(names, shas, plan);
			} catch (e) {
				out.push = { ok: false, log: `rotating previous deployments failed: ${String(e)}`, seconds: 0 };
				out.error = "static push failed";
				await report("check", out.push);
				return out;
			}
		}

		// dist/ → the static branch: a single-commit history, force-pushed, so the
		// branch always holds exactly the latest build of the PR head.
		out.push = await step(
			sb,
			[
				`rm -rf ${OUT} && mkdir -p ${OUT} && cp -r ${WORK}/dist/. ${OUT}/`,
				`cd ${OUT} && git init -q -b "${input.staticBranch}" && touch .nojekyll`,
				`git add -A && git commit -q -m "static build of ${input.headRef} @ ${input.headSha.slice(0, 7)} (${input.pr ? `PR #${input.pr}` : "branch"}, attempt ${input.attempt})"`,
				`git push -q --force "${repoUrl}" "HEAD:refs/heads/${input.staticBranch}" && git rev-parse HEAD`,
			].join(" && "),
			{ cwd: "/workspace", env: gitEnv, timeout: 5 * 60_000 },
		);
		if (!out.push.ok) {
			out.error = "static push failed";
			await report("check", out.push);
			return out;
		}
		out.staticSha = out.push.log.match(/^[0-9a-f]{40}$/m)?.[0] ?? null;
		out.previous = names.slice(1).flatMap((branch, i) => {
			const sha = history[i + 1];
			// Served straight from the branch by the platform: the URL is the plugin's to know.
			return sha ? [{ branch, sha, previewUrl: input.previousUrls?.[i] ?? null }] : [];
		});
		await report("check", {
			ok: true,
			log: `check:cf ${out.check.seconds}s · build ${out.build.seconds}s · ${input.staticBranch} @ ${out.staticSha?.slice(0, 7) ?? "?"}`,
			seconds: out.check.seconds + out.build.seconds + out.push.seconds,
		});

		out.test = await step(sb, "npm run --if-present test:cf", { cwd: WORK });
		await report("test", out.test);
		if (!out.test.ok) {
			out.error = "test:cf failed";
			return out;
		}

		// Tests passed. The platform serves the static branch straight from git;
		// wait until it answers with the commit just pushed, then the project's own
		// end-to-end suite runs against it (Playwright, Browser Rendering, plain
		// fetch — the script decides).
		if (input.pr > 0 && input.previewUrl) {
			const url = input.previewUrl;
			out.preview = await waitForPreview(url, out.staticSha);
			if (!out.preview.ok) {
				out.error = "preview not served";
				await report("preview", out.preview);
				return out;
			}
			out.previewUrl = url;
			await report("preview", out.preview, { previewUrl: url });

			out.previewTest = await step(sb, "npm run --if-present test:preview:cf", {
				cwd: WORK,
				env: { PREVIEW_URL: url },
				timeout: 15 * 60_000,
			});
			await report("previewTest", out.previewTest, { previewUrl: url });
			if (!out.previewTest.ok) {
				out.error = "test:preview:cf failed";
				return out;
			}
		}
		out.ok = true;
		return out;
	} catch (e) {
		out.error = String(e);
		return out;
	}
}
