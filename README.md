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

1. Every _N_ minutes (plugin cron) open issues with the trigger label
   (default `agent`) are fetched.
2. Issues by whitelisted users are handed to the agent worker (`POST /run`,
   idempotent per issue). Progress is polled (`GET /status`) and stored in the
   plugin's `runs` table; the PR link shows up on the admin page.
3. The admin page (**GitHub Agent**) lists issues, creates new ones (optionally
   labelled for the agent), runs the agent on a given issue and holds the
   settings.

Routes (admin-authenticated): `issues`, `issues/create`, `issues/run`,
`issues/comment`, `poll`, `settings`, `settings/save`.

## The agent worker

`agent/` is a standalone Worker: `bun install && bunx wrangler deploy`, then
`wrangler secret put AGENT_KEY` with the key you paste into the plugin settings.
It needs a Workers Paid plan (Workers AI). The platform runs one shared instance
at `https://premium-cms-issue-agent.premiumcms.workers.dev`; any deployment
works as long as its URL host is allowed by the plugin manifest
(`*.workers.dev`, `*.premium-cms.com`).
