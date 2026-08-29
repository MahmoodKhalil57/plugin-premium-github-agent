/**
 * Stacked pull requests. A stack is an ordered list of issues the agent
 * implements as a chain of pull requests: layer 1 from the default branch,
 * every next layer from the branch of the layer below, linked on GitHub as a
 * stack and merged bottom-up. This module is the pure part — the record
 * shape, the command arguments and the merge decision — so it can be tested
 * without a context; the orchestration (dispatching layers, linking, merging,
 * rebuilding after GitHub's rebase) lives in plugin.ts.
 */

export type StackStatus = "running" | "merged" | "stopped";

export interface Stack {
	id: string;
	/** Layers, bottom first. */
	issues: number[];
	/** Issue → pull request, once that layer's PR is open. Layers open in order, so this is always a prefix of `issues`. */
	prs: Record<string, number>;
	/** GitHub's stack number once two or more PRs are linked. */
	github?: number;
	status: StackStatus;
	/** What the stack is doing or why it stopped. */
	summary?: string;
	createdBy: string;
	/** PRs GitHub rebases after a merge below them, with their head before that merge: rebuilt once the head moves. */
	pendingRebuild?: Record<string, { sha: string; since: string }>;
	/** An asynchronous stack merge still running on GitHub. */
	merging?: { pr: number; uuid: string; prs: number[]; startedAt: string };
	/** The last refusal, so the same head is not retried on every tick. */
	mergeRefused?: { pr: number; sha: string; message: string };
	createdAt: string;
	updatedAt: string;
}

export function stackId(bottomIssue: number, at = Date.now()): string {
	return `s${bottomIssue}-${at.toString(36)}`;
}

export function describeStack(stack: Pick<Stack, "issues">): string {
	return stack.issues.map((n) => `#${n}`).join(" → ");
}

/** `/agent-issue on #12` → 12. Anything else (no argument, other words) → null. */
export function stackOnArg(args: string): number | null {
	const m = args.trim().match(/^on\s+#?(\d+)(?!\d)/i);
	return m ? Number(m[1]) : null;
}

/** Issue numbers in `#12 #13, 14`, in order, deduplicated. */
export function issueRefs(args: string): number[] {
	const out: number[] = [];
	for (const m of args.matchAll(/(?<![\w#/.-])#?(\d+)(?![\w-])/g)) {
		const n = Number(m[1]);
		if (n > 0 && !out.includes(n)) out.push(n);
	}
	return out;
}

/** What the merge decision sees of one layer with an open or finished pull request. */
export interface LayerState {
	issue: number;
	pr: number;
	state: "open" | "merged" | "closed";
	headSha: string;
	headRef: string;
	/** When the PR last changed (opened, pushed, rebased). */
	updatedAt?: string;
	/** The platform's latest build of that PR, if any. */
	build: { status: string; headSha: string; updatedAt: string } | null;
}

export type MergeDecision =
	| { kind: "nothing"; reason: string }
	| { kind: "hold"; reason: string }
	| { kind: "merge"; prs: number[]; top: LayerState };

/**
 * Bottom-up: the longest run of green layers from the lowest open one merges
 * in one atomic stack merge — unless the layer right above it is about to be
 * built (its build is running, or it just changed and has no build yet), or a
 * planned layer has not opened its pull request yet. Merging under a layer in
 * flight would only make GitHub rebase it and throw that build away.
 */
export function decideMerge(
	layers: LayerState[],
	opts: { plannedPending: boolean; now: number; staleMs: number; freshMs: number },
): MergeDecision {
	const closedAt = layers.findIndex((l) => l.state === "closed");
	const open = layers.filter((l, i) => l.state === "open" && (closedAt < 0 || i < closedAt));
	if (open.length === 0) {
		if (closedAt >= 0 && layers.some((l, i) => i > closedAt && l.state === "open")) {
			return { kind: "hold", reason: `#${layers[closedAt].pr} was closed without merging; the layers above it cannot merge` };
		}
		return { kind: "nothing", reason: "no open layer" };
	}
	const green = (l: LayerState) => l.build?.status === "passed" && l.build.headSha === l.headSha;
	const prefix: LayerState[] = [];
	for (const l of open) {
		if (!green(l)) break;
		prefix.push(l);
	}
	if (prefix.length === 0) return { kind: "nothing", reason: `#${open[0].pr} is not green` };
	const above = open[prefix.length];
	if (above) {
		const b = above.build;
		if (b?.status === "running" && opts.now - Date.parse(b.updatedAt) < opts.staleMs) {
			return { kind: "hold", reason: `waiting for the build of #${above.pr}` };
		}
		const unbuilt = !b || b.headSha !== above.headSha;
		const fresh = above.updatedAt ? opts.now - Date.parse(above.updatedAt) < opts.freshMs : false;
		if (unbuilt && fresh) return { kind: "hold", reason: `waiting for #${above.pr} to start building` };
	} else if (opts.plannedPending) {
		return { kind: "hold", reason: "waiting for the next layer to open its pull request" };
	}
	return { kind: "merge", prs: prefix.map((l) => l.pr), top: prefix[prefix.length - 1] };
}

/** The PR number in a GitHub pull-request URL. */
export function prNumberFrom(url: string | null | undefined): number | null {
	const m = url?.match(/\/pull\/(\d+)(?:[/?#]|$)/);
	return m ? Number(m[1]) : null;
}
