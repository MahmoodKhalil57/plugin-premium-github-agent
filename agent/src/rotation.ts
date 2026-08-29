/**
 * Previous deployments of a static branch: `<branch>-b-1` holds the deployment
 * before the live one, `<branch>-b-2` the one before that. Rotation is planned
 * over ref shas only, so it needs no checkout and can be tested without GitHub.
 */

export interface RefUpdate {
	branch: string;
	sha: string;
}

/** `[static/main, static/main-b-1, …, static/main-b-<keep>]`. */
export function historyBranches(staticBranch: string, keep: number): string[] {
	const names = [staticBranch];
	for (let i = 1; i <= keep; i++) names.push(`${staticBranch}-b-${i}`);
	return names;
}

/**
 * Ref updates that shift every deployment one slot back before a new live
 * build is pushed: b-2 ← b-1, b-1 ← live. Nothing moves when there is no live
 * build yet, or when live already equals b-1 — a rotation whose push never
 * landed — so a retried build cannot push the older snapshots out.
 */
export function rotationPlan(names: readonly string[], shas: ReadonlyArray<string | null>): RefUpdate[] {
	const live = shas[0];
	if (!live || live === shas[1]) return [];
	const plan: RefUpdate[] = [];
	for (let i = names.length - 1; i >= 1; i--) {
		const sha = shas[i - 1];
		const branch = names[i];
		if (sha && branch) plan.push({ branch, sha });
	}
	return plan;
}

/** Shas of every slot once `plan` is applied. */
export function applyPlan(
	names: readonly string[],
	shas: ReadonlyArray<string | null>,
	plan: readonly RefUpdate[],
): Array<string | null> {
	const out = [...shas];
	for (const u of plan) {
		const i = names.indexOf(u.branch);
		if (i >= 0) out[i] = u.sha;
	}
	return out;
}

/** Worker name for the preview of a previous deployment: stable per (repo, branch, slot), valid for workers.dev. */
export function previousPreviewName(owner: string, repo: string, branch: string, slot: number): string {
	const clean = (s: string, max: number) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max)
			.replace(/-+$/, "");
	return `preview-${clean(`${owner}-${repo}`, 36)}-${clean(branch, 12)}-b-${slot}`;
}
