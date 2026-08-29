/**
 * Rotation of the default branch's static deployments: live → -b-1 → -b-2,
 * planned over ref shas only.
 */

import { describe, expect, it } from "vitest";

import { applyPlan, historyBranches, previousPreviewName, rotationPlan } from "../agent/src/rotation.js";

const names = historyBranches("static/main", 2);

describe("static deployment rotation", () => {
	it("names the slots after the static branch", () => {
		expect(names).toEqual(["static/main", "static/main-b-1", "static/main-b-2"]);
		expect(historyBranches("static/main", 0)).toEqual(["static/main"]);
	});

	it("does nothing before the first deployment", () => {
		expect(rotationPlan(names, [null, null, null])).toEqual([]);
	});

	it("fills the slots one deployment at a time, oldest slot first", () => {
		expect(rotationPlan(names, ["X", null, null])).toEqual([{ branch: "static/main-b-1", sha: "X" }]);
		expect(rotationPlan(names, ["Y", "X", null])).toEqual([
			{ branch: "static/main-b-2", sha: "X" },
			{ branch: "static/main-b-1", sha: "Y" },
		]);
		expect(applyPlan(names, ["Y", "X", null], rotationPlan(names, ["Y", "X", null]))).toEqual(["Y", "Y", "X"]);
	});

	it("drops the oldest deployment once every slot is taken", () => {
		const plan = rotationPlan(names, ["Z", "Y", "X"]);
		expect(plan).toEqual([
			{ branch: "static/main-b-2", sha: "Y" },
			{ branch: "static/main-b-1", sha: "Z" },
		]);
		expect(applyPlan(names, ["Z", "Y", "X"], plan)).toEqual(["Z", "Z", "Y"]);
	});

	it("does not rotate again when the previous rotation's push never landed", () => {
		// live already equals -b-1: rotating would duplicate it and lose X.
		expect(rotationPlan(names, ["Y", "Y", "X"])).toEqual([]);
	});

	it("names preview Workers per slot within workers.dev limits", () => {
		expect(previousPreviewName("MahmoodKhalil57", "site-01m10e4fh0nsp0cwsbv3rnnq53", "main", 1)).toBe(
			"preview-mahmoodkhalil57-site-01m10e4fh0nsp0c-main-b-1",
		);
		const long = previousPreviewName("o".repeat(40), "r".repeat(40), "release/2026-candidate", 2);
		expect(long.length).toBeLessThanOrEqual(63);
		expect(long).toMatch(/^preview-[a-z0-9-]+-b-2$/);
	});
});
