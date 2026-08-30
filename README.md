# GitHub Agent — PremiumCMS plugin

Issues on the site's connected GitHub repository, plus a coding agent that turns
labelled issues into **open** pull requests.

- **Credential:** the site's own GitHub connection (Settings → General). Nothing
  else to paste; the PR is opened as the site owner.
- **Runtime:** the instance itself. The plugin asks the platform for a
  [Think](https://github.com/cloudflare/agents/tree/main/docs/think) agent
  (`ctx.agents`, capability `agents:run`) on the instance's Workers AI
  (`@cf/zai-org/glm-5.3-flash` by default) with GitHub's remote MCP server, and
  for builds in the instance's sandbox container (`ctx.sandbox`, capability
  `sandbox:build`). Nothing runs outside the site's own Worker, and every bill
  lands on the account that hosts the instance. No GitHub Actions, no scripts —
  one bundled skill and MCP tools only.
- **Dry coding:** the agent reads the repo, writes a branch, opens a PR and
  comments on the issue. It never runs code or tests and never merges.
- **Whitelist:** the agent only works on issues raised by the GitHub usernames
  listed in the plugin settings. Everyone else's labelled issues are recorded as
  skipped.

## How it works — a comment protocol

Everything is driven by `/commands` in issue and pull-request comments, from
**whitelisted GitHub users** only (the plugin setting). There is no label.

| Who      | Command                                    | Effect |
| -------- | ------------------------------------------ | ------ |
| you      | `/agent-issue` (issue body or comment)     | the agent studies the repo, opens a fix PR, and comments `/awaiting-test` on it |
| you      | `/agent-stack #12 #13 …` (any issue), or bare `/agent-stack` on an issue with sub-issues | the issues run as stacked layers, bottom first — see below |
| you      | `/agent-issue on #12`                      | this issue becomes one more layer on top of #12's stack (or its PR) |
| you/agent| `/awaiting-test` (PR comment)              | the platform runs the checks on the PR head |
| runner   | `/check-succeeded` · `/check-failed`       | `check:cf` + `astro build` + push to `static/<branch>` |
| runner   | `/test-succeeded` · `/test-failed`         | `test:cf` |
| runner   | `/preview-ready <url>` · `/preview-build-failed` | the build hosted on Cloudflare |
| runner   | `/preview-test-succeeded` · `/preview-test-failed` | `test:preview:cf` against the preview |
| runner   | `/merged`                                  | squash-merged into the default branch (Auto-merge setting) |

A `/…-failed` report on the agent's own PR (`agent/issue-N-…`) sends the output
back to the agent, which pushes a fix to the same branch and comments
`/awaiting-test` again — bounded by **Max build attempts per PR**. Reports on a
human's PR are informational; `/…-succeeded` never triggers anything. Pushes
to the default branch and content publishes rebuild `static/<default>` without
any comment.

## Stacked pull requests: several issues, one branching strategy

Several related changes — dependent on each other, or touching the same
files — should not be a queue of independent PRs (slow, or a merge-conflict
lottery when run in parallel) or one huge issue. Run them as a **stack**,
GitHub's native stacked pull requests (public preview):

```
/agent-stack #12 #13 #14      ← on any issue: the listed issues, bottom first
/agent-stack                  ← on an issue with sub-issues: those, in their order
/agent-issue on #12           ← one more layer on top of #12's stack (or its PR)
```

(The MCP tools `create_stack` and `create_issue` with `on` do the same for
assistants; the admin page has a "Start stack" form.)

What happens, bottom-up:

1. **Layer 1** runs as usual: a branch from the default branch, a pull request,
   `/awaiting-test`.
2. **Each next layer starts the moment the layer below opens its pull
   request** — not after its checks or merge — from that PR's branch, and opens
   its PR *against that branch*. Dependent code always sees the code it depends
   on; nothing conflicts, nothing waits for a merge.
3. The plugin links the PRs as a GitHub stack (`POST /repos/…/stacks`, then
   `/stacks/{n}/add`); every PR shows the stack map on GitHub and is built,
   previewed and tested by the platform like any other.
4. **Merging is bottom-up and atomic**: whenever the lowest open layer is green,
   the longest run of green layers above it merges in one GitHub stack merge
   (`PUT …/pulls/{n}/merge-async`, squash). The merge is held while the layer
   right above is building (or just opened and about to build) and while a
   planned layer has no PR yet, so GitHub never rebases a layer mid-build.
5. After a partial merge GitHub rebases and retargets the remaining layers; the
   plugin rebuilds each one as soon as its branch moves (`pull_request
   synchronize`, with a two-minute cron tick as the safety net). A layer whose
   build had failed is left to the agent's fix — its `/awaiting-test` builds it.
6. Each merged layer gets `/merged`, its issue is closed, and the default
   branch rebuilds.

A layer that produces no pull request **stops the stack**: the layers below
keep their life (they still merge when green), the layers above are not
started, and every unstarted issue gets a comment with the `/agent-stack …`
command to resume. A closed-unmerged layer blocks the layers above it, as on
GitHub. Stacks show on the admin page (layers, PRs, what the stack is waiting
for); `issue_status` reports the stack of an issue.

Layer discipline is the same as GitHub's advice for AI-generated code: order
by dependency (foundation first), keep each layer small and reviewable, and
put independent changes in separate stacks or plain issues.

## Previews come straight from git

Every static branch the CI pushes is a preview, with no hosting of its own.
The platform zone has a wildcard record and the router forwards
`https://<rn>--<label>.premium-cms.com` to the instance `<rn>` with
`X-Premium-Preview: <label>`; the instance serves `static/<label>` from the
repository through the site's own GitHub connection (cached at the edge by
commit; every response carries `X-Preview-Commit`, is `noindex`, and `/_emdash/*`
answers 404 — a preview is the static site only). So:

| Branch | Preview |
| --- | --- |
| `static/pr-12` (a PR build; deleted when the PR closes) | `https://<rn>--pr-12.premium-cms.com` |
| `static/main-b-1`, `-b-2` (kept deployments) | `https://<rn>--main-b-1.premium-cms.com` |
| `static/main` (what GitHub Pages serves live) | `https://<rn>--main.premium-cms.com` |

`<rn>` is the site's platform name (`ctx.site.platformUrl`, `https://p<ulid>.premium-cms.com`),
so previews stay on the platform zone even when the site uses a custom domain.
The CI waits until the preview serves the commit it pushed before running
`test:preview:cf` against it. Nothing runs or is stored outside the instance
and the repository: no preview Workers, no bucket, no Cloudflare credentials
in the CI.

## Default branch: live, one back, two back

Every successful build of the default branch is a deployment. Before the new
`dist/` is pushed to `static/<default>` (what GitHub Pages serves), the build
shifts the earlier deployments one slot back — `static/<default>-b-1` ← the
build that was live, `static/<default>-b-2` ← the one before it — by moving
refs through the GitHub API (no checkout, nothing rebuilt). Each kept slot is
served straight from its branch as `https://<rn>--<default>-b-1.premium-cms.com`
/ `-b-2` (see "Previews come straight from git"), so there are always three
things to look at: the live site, the previous deployment and the one before
that. The slot branches and their
preview URLs are on the site row in the admin page (and in the `site/build`
route's `build.previous`). A build whose push never landed does not rotate
again, so a retry cannot push the older snapshots out.

GitHub → App webhook → parent control plane (`githubWebhook`, routed by
repository) → this plugin's `webhook` route; issues and PRs are re-read from
GitHub before anything happens. The App must subscribe to **Issues**,
**Issue comment**, **Pull request** and **Push** events.

## Pull requests: check → build → static branch → test

Every pull request from a whitelisted author (the agent's own PRs included) is
built in the instance's sandbox container (`ctx.sandbox.build`, Sandbox SDK):

1. `npm run check:cf` (the site's static checks),
2. `astro build` against the site's live content snapshot,
3. `dist/` is force-pushed to `static/<branch>` — one branch per PR that always
   holds the latest build, so it can be served straight away later,
4. `npm run test:cf`,
5. when everything passed, the build waits until the git-served preview
   (`https://<rn>--pr-<N>.premium-cms.com`) answers with the commit it pushed,
   and the URL is posted on the PR (comment + commit-status link). The static
   branch — and with it the preview — is deleted when the PR closes,
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

## The runtime

There is nothing to deploy. The platform's instance bundle ships the agent
runtime (`@premium-cms/cloudflare/agents`): a `PluginAgent` Durable Object per
issue (`<plugin>:issue-<N>`, so every attempt lands on the same object and
re-dispatching is idempotent), a `Sandbox` container per build lane
(`pr-<N>` / `branch-<name>`), and Workers AI. The plugin reaches them through
`ctx.agents.run / status` and `ctx.sandbox.build / buildStatus`; the runtime
reports back by POSTing to the plugin's `agent-callback`, `ci-stage` and
`ci-callback` routes through the instance's own service binding, signed with
the plugin's agent key (generated on install, shown in the settings). The
instance needs a Workers Paid plan (Workers AI, Durable Objects, Containers);
the platform declares the bindings when it provisions or rolls a site.

## Repository context: `.agents/skills/` and `.mcp.json`

On every run the worker reads the site repository (at its default branch):

- `.agents/skills/<name>/SKILL.md` — [Agent Skills](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/)
  (`name` / `description` frontmatter + instructions; text files next to it
  become skill resources). They are offered to the model alongside the built-in
  `fix-github-issue` skill and named in the run prompt.
- `.mcp.json` — `{"mcpServers": {"<name>": {"url": "https://…", "headers": {…}}}}`;
  remote HTTP servers are connected for the run. `command` (stdio) servers
  cannot run in a Worker and are skipped; never commit secrets.

New site repos start with a `site-conventions` skill and an empty `.mcp.json`
(from the frontend template); projects edit them like any other file.
