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

Routes: `webhook` (platform-authenticated), `agent-callback` (public, signed),
and admin-authenticated `issues`, `issues/create`, `issues/run`,
`issues/comment`, `poll`, `settings`, `settings/save`.

## The agent worker

`agent/` is a standalone Worker: `bun install && bunx wrangler deploy`, then
`wrangler secret put AGENT_KEY` with the key you paste into the plugin settings.
It needs a Workers Paid plan (Workers AI). The platform runs one shared instance
at `https://premium-cms-issue-agent.premiumcms.workers.dev`; any deployment
works as long as its URL host is allowed by the plugin manifest
(`*.workers.dev`, `*.premium-cms.com`).
