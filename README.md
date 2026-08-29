# GitHub Agent — PremiumCMS plugin

Issues on the site's connected GitHub repository, plus a coding agent that turns
labelled issues into **open** pull requests.

- **Credential:** the site's own GitHub connection (Settings → General). Nothing
  else to paste; the PR is opened as the site owner.
- **Runtime:** a Cloudflare Worker (`agent/`) running a
  [Think](https://github.com/cloudflare/agents/tree/main/docs/think) agent on
  Workers AI (`@cf/zai-org/glm-5.3-flash` by default) with GitHub's remote MCP
  server. No GitHub Actions, no scripts — one bundled skill and MCP tools only.
- **Dry coding:** the agent reads the repo, writes a branch, opens a PR and
  comments on the issue. It never runs code or tests and never merges.
- **Whitelist:** the agent only works on issues raised by the GitHub usernames
  listed in the plugin settings. Everyone else's labelled issues are recorded as
  skipped.

## How it works

1. GitHub delivers `issues` events to the platform's GitHub App webhook. The
   parent control plane (projects plugin, `githubWebhook` route) routes each
   event to the project whose site repo it belongs to and calls this plugin's
   `webhook` route. Nothing is polled.
2. The plugin re-reads the issue from GitHub with the site's own token: if it
   carries the trigger label (default `agent`) and its author is whitelisted,
   the agent worker is asked to run (`POST /run`, idempotent per issue+attempt).
3. When the run ends the worker calls `agent-callback` (HMAC-signed with the
   agent key) with the outcome; the PR link shows up on the admin page.
4. The admin page (**GitHub Agent**) lists issues, creates new ones (optionally
   labelled for the agent), runs the agent on a given issue ("run again" retries
   a finished one as a new attempt), reconciles by hand, and holds the settings.

## Pull requests: check → build → static branch → test

Every pull request from a whitelisted author (the agent's own PRs included) is
built in a Cloudflare container by the agent worker (`POST /ci`, Sandbox SDK):

1. `npm run check:cf` (the site's static checks),
2. `astro build` against the site's live content snapshot,
3. `dist/` is force-pushed to `static/<branch>` — one branch per PR that always
   holds the latest build, so it can be served straight away later,
4. `npm run test:cf`,
5. when everything passed, the build is hosted on Cloudflare as an assets-only
   Worker (`preview-<owner>-<repo>-pr<N>.<account>.workers.dev`) and the URL
   is posted on the PR (comment + commit-status link). The preview is deleted
   when the PR closes. The worker needs `CF_ACCOUNT_ID` / `CF_API_TOKEN`
   secrets (Workers Scripts edit) for this; without them the step is skipped,
6. `npm run test:preview:cf` runs against the live preview (`PREVIEW_URL`):
   the shipped test just fetches it; a project can put Playwright, Cloudflare
   Browser Rendering or anything else behind that script. A failure here goes
   back to the agent like any other step,
7. with every check green the PR is squash-merged into the default branch
   (**Auto-merge** setting, on by default), whose push rebuilds `static/<default>`;
   the preview is removed when the PR closes.

The result is posted as a PR comment and a `premium-cms/ci` commit status. When
the PR is the agent's own fix branch (`agent/issue-N-…`) and CI failed, the
agent is asked to push a fix to the same branch with the failing output; GitHub
reports the push (`synchronize`), CI runs again onto the same static branch —
until it passes or **Max build attempts per PR** (default 3) is used up. The
agent's own dry-run attempts are capped separately (each retry is a new
attempt on the same issue). Until the checks pass everything stays open: one
issue, one PR, one fix branch, one static branch; a green PR is merged.

Routes: `webhook` (platform-authenticated: `issues` + `pull_request` events),
`agent-callback` / `ci-callback` (public, HMAC-signed), and admin-authenticated
`issues`, `issues/create`, `issues/run`, `issues/comment`, `pulls`,
`pulls/build`, `poll`, `settings`, `settings/save`.

The platform's GitHub App needs **Issues: read & write**, **Pull requests: read
& write**, **Commit statuses: read & write**, and must subscribe to the
**Issues** and **Pull request** events; each installation has to accept the
permissions once.

## The agent worker

`agent/` is a standalone Worker: `bun install && bunx wrangler deploy`, then
`wrangler secret put AGENT_KEY` with the key you paste into the plugin settings.
It needs a Workers Paid plan (Workers AI). The platform runs one shared instance
at `https://premium-cms-issue-agent.premiumcms.workers.dev`; any deployment
works as long as its URL host is allowed by the plugin manifest
(`*.workers.dev`, `*.premium-cms.com`).
