/**
 * The one skill the agent has. It is the whole playbook — there is no system
 * prompt beyond a one-liner, and no scripts: the model works the GitHub MCP
 * tools by hand, which keeps the run inspectable (every step is a tool call).
 */
export const FIX_ISSUE_SKILL = {
	name: "fix-github-issue",
	description:
		"Turn an open GitHub issue into a pull request: read the issue, study the repository, write the fix on a new branch and open a PR that references the issue. Use for any request that names a repository and an issue number.",
	body: `# Fix a GitHub issue with a pull request

You are given a repository (\`owner/repo\`), its default branch and an issue number.
Everything happens through the GitHub tools. You never run code, tests or builds —
this is dry coding: read carefully, change little, explain clearly.

## 1. Understand the issue
- \`get_issue\` for the title and body; \`get_issue_comments\` for clarifications.
- Restate the problem to yourself in one sentence before touching code.

## 2. Study the repository before writing anything
- \`get_file_contents\` on the repo root, then follow the structure (\`package.json\`,
  \`README\`, the directories the issue points at).
- \`search_code\` for the identifiers, error messages or routes the issue mentions.
- Read every file you intend to change IN FULL, plus the files that import it.
  Match the existing style (indentation, quotes, naming, module system).
- If the issue is unclear, unreproducible from the code, or would need a design
  decision, do NOT guess: skip to step 5 and open no PR.

## 3. Write the fix on a branch
- Branch name: \`agent/issue-<number>-<short-kebab-summary>\` from the default branch
  (\`create_branch\`).
- Apply the smallest change that fixes the root cause. No drive-by refactors, no
  unrelated formatting, no new dependencies unless the issue requires one.
- Commit with \`create_or_update_file\` (one file) or \`push_files\` (several files) on
  that branch. Always send the COMPLETE new file content — never a diff or a
  fragment. Re-read the file's \`sha\` first when updating a single file.
- Commit message: \`fix: <what> (#<issue number>)\`.

## 4. Open the pull request
- \`create_pull_request\` from the branch into the default branch. Leave it open —
  never merge, never close, never request reviewers.
- Title: \`Fix #<number>: <issue title>\`.
- Body, in this order: **Problem** (one paragraph), **Fix** (what changed and why),
  **Not verified** (state plainly that no code was executed and what a reviewer
  should test), and the line \`Closes #<number>\`.

## 5. Report back on the issue
- \`add_issue_comment\` with either the PR link and a two-line summary, or — when you
  opened no PR — what you found and what information is missing.
- Finish with a one-line final answer: the PR URL, or \`NO_PR: <reason>\`.

## Hard rules
- Only ever touch the repository you were given.
- Never write to the default branch directly.
- Never merge, close, delete branches, edit labels, or change repository settings.
- One issue, one branch, one PR.`,
} as const;
