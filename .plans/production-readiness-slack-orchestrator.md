# Slack Orchestrator Production Readiness Plan

> [!IMPORTANT]
> **Current operating mode**
>
> The orchestrator is still running on the Convex dev deployment. Treat
> `apps/orchestrator/.env.local` and `apps/orchestrator/AGENTS.md` as the source
> of truth until this plan explicitly cuts over to production.
>
> Required completion checks for implementation work: `bun fmt`, `bun lint`, and
> `bun typecheck`. Use `bun run test`, never `bun test`.

## Summary

Prepare the current Vevin Slack-only orchestrator for production without losing
the ergonomics that now work locally:

- Slack is the only chat entry point.
- Convex owns task orchestration state, idempotency, Chat SDK state, GitHub event
  handling, and delivery state.
- Local T3 owns execution, worktrees, provider sessions, git commits, pushes, PR
  creation, and the web UI.
- Cloudflare exposes the local T3 bridge and web app at `https://t3.olumbe.com`.
- GitHub webhooks report PR/deployment lifecycle events back to Convex.

Production readiness means replacing the current dev-deployment assumptions with
durable secrets, explicit runbooks, observability, recovery paths, and a safe
cutover checklist.

## Production Topology

### Runtime Components

1. Slack app receives user messages and sends events to Convex through the Chat
   SDK Slack webhook.
2. Convex receives `/slack/webhook`, `/github/webhook`, and T3 runtime callbacks.
3. Convex calls the local T3 execution bridge at `T3_EXECUTION_BRIDGE_BASE_URL`.
4. The Windows local machine runs:
   - `t3code-server`: NSSM-wrapped Windows service for T3 on
     `127.0.0.1:3773`
   - `cloudflared-t3code`: Windows service running Cloudflare tunnel
     `t3code-local`
   - optional local dev command for hot reloading when iterating
5. T3 creates worktrees, runs Codex GPT-5.5 fast mode by default,
   commits/pushes changes, and
   creates or finds the PR.
6. GitHub sends PR and deployment events to Convex so Slack can receive PR,
   deployment-ready, and merged-status cards.

### Ownership Boundaries

Convex owns:

- Slack Chat SDK intake and persisted Chat SDK state
- source thread/task linking
- mute/unmute/aside/mention gating
- task/work session/external link records
- one-time reply/card idempotency
- GitHub webhook verification and delivery fan-out
- bridge auth when calling local T3

T3 owns:

- local project resolution
- branch/worktree creation
- AI-generated thread title and branch rename behavior
- provider session lifecycle
- filesystem changes
- deterministic post-turn commit/push/PR ensure behavior
- current branch detection for PR ensure

Slack owns:

- user-facing chat surface
- initial mention events
- thread follow-ups after Chat SDK subscription
- reactions/cards rendered through Chat SDK primitives

## Required Production Decisions

Before cutover, decide these explicitly:

1. Convex deployment: create a real production Convex deployment, or continue
   using dev with a named "pilot" status. The preferred production path is a
   separate Convex production deployment.
2. Host model: keep the local Windows machine as the execution host, but treat it
   like production infrastructure with startup, health checks, backups, and a
   stable Cloudflare tunnel.
3. Slack workspace scope: confirm whether Vevin should be installed only in
   Affil.ai workspace or support multiple workspaces.
4. Repository allowlist: define the allowed repos/projects, currently `nextcard`
   by default with explicit `nextcard`/`t3code` routing.
5. Merge policy: decide whether Vevin ever merges PRs automatically, or only
   reacts to merged PR events.

## Phase 1: Production Environment And Secrets

Goal: create a production Convex environment with stable, audited configuration.

Tasks:

1. Create or select the production Convex deployment.
2. Move all required env vars from dev into production with fresh values where
   appropriate:
   - `T3_EXECUTION_BRIDGE_BASE_URL=https://t3.olumbe.com`
   - `T3_EXECUTION_BRIDGE_SHARED_SECRET`
   - `T3_WEB_APP_BASE_URL=https://t3.olumbe.com`
   - `LINEAR_DEFAULT_WORKSPACE_ROOT` only if legacy compatibility still needs it
   - Slack bot/signing/app credentials used by the Chat SDK adapter
   - GitHub webhook secret
   - GitHub token for deployment/PR lookup
3. Rotate bridge, Slack, and GitHub secrets before production cutover.
4. Document where each secret is stored and how to rotate it.
5. Update Slack and GitHub webhook URLs to point at the chosen production Convex
   site URL only after the staging validation passes.

Acceptance criteria:

- Production Convex env is complete and independently deployable.
- Dev and production site URLs are clearly named in docs.
- No active webhook points at a stale Convex deployment.
- Secret rotation steps are written and tested at least once for the bridge
  shared secret.

## Phase 2: Local Machine Hardening

Goal: make the local Windows machine reliable enough to behave like a production
execution host.

Tasks:

1. Ensure `t3code-server` Windows service starts automatically and wraps:
   `scripts\start-t3code-server.cmd`.
2. Ensure `cloudflared-t3code` Windows service starts automatically and runs:
   `C:\Program Files (x86)\cloudflared\cloudflared.exe --config C:\Users\Vivek\.cloudflared\config.yml tunnel run t3code-local`.
   The old `t3code-tunnel` scheduled task should remain disabled.
3. Add an operator runbook for:
   - start
   - stop
   - restart
   - view logs
   - validate Cloudflare tunnel
   - validate local bridge auth
4. Persist the pairing token through an env var or local config that survives
   server restarts.
5. Configure Windows startup behavior so both scheduled tasks come back after
   reboot.
6. Decide where logs live and how long to retain them.

Acceptance criteria:

- `Get-Service t3code-server` shows `Running`.
- `Get-Service cloudflared-t3code` shows `Running`.
- `curl.exe -i http://127.0.0.1:3773/` reaches local T3.
- `curl.exe -i https://t3.olumbe.com/` reaches Cloudflare/T3.
- An unauthenticated bridge call returns `401`, not `404`.

Current hardening status:

- On 2026-05-15, the old `t3code-tunnel` scheduled task was replaced by the
  `cloudflared-t3code` Windows service.
- `scripts\install-t3code-server-service.ps1` was added to install/repair the
  `t3code-server` NSSM service.
- `scripts\update-t3code-server.ps1` was added as the documented upstream update
  path: fetch/merge `pingdotgg/main`, install, build, restart service, run
  health checks.
- `scripts\install-cloudflared-t3code-service.ps1` installs/repairs the
  Cloudflare service.
- Services start automatically and are configured to restart on failure.
- The old scheduled tunnel/server tasks should be disabled after services are
  healthy.
- Both old scheduled tasks had a 72-hour execution time limit; that was the root
  cause of the tunnel stopping and `https://t3.olumbe.com` returning Cloudflare
  `530`.

## Phase 3: Slack Production Behavior

Goal: preserve the current expected Vevin UX under production deployment.

Expected behavior:

- Initial handled message gets an eyes reaction.
- Initial handled message receives a card: `Talk to Vevin in this thread` with an
  `Open T3` button.
- Mention-free follow-ups work inside subscribed Slack threads.
- Messages starting with `aside - ` are ignored.
- `@Vevin mute` mutes non-mention replies and receives an acknowledgement
  reaction.
- `@Vevin unmute` resumes non-mention replies and receives an acknowledgement
  reaction.
- Messages mentioning another human are ignored unless they directly invoke Vevin
  in a way that should be handled.
- Slack client attribution such as `Sent using ChatGPT` is stripped before the
  prompt reaches T3.
- Assistant replies are relayed as assistant messages regardless of provider.
- PR cards include `View PR` and deployment buttons only; no `Open T3` button in
  PR cards.
- Deployment-ready messages use branch preview URLs, not commit-only URLs.
- Merged PR events react to the original Slack message with a checkmark and post
  one merged-status message.

Acceptance criteria:

- The behavior above is documented in an E2E checklist.
- A staging Slack app/workspace channel can validate the full path before moving
  production webhooks.
- Chat SDK state persists across Convex action restarts.
- There is no active direct Slack Web API implementation in app code; outbound
  Slack interactions go through Chat SDK primitives.

## Phase 4: GitHub And Preview Event Reliability

Goal: make PR/deployment notifications correct and idempotent.

Tasks:

1. Confirm GitHub webhook covers:
   - `pull_request`
   - `deployment_status`
2. Verify signatures for every GitHub webhook request.
3. Resolve preview URLs from GitHub deployment statuses and prefer public branch
   preview URLs over commit-specific or dashboard URLs.
4. Store delivery events in Convex so duplicate GitHub deliveries do not repost
   the same Slack card.
5. Keep PR-created, deployment-ready, and PR-merged delivery keys separate so
   each event type can post once.
6. Add a replay/debug runbook for manually reprocessing a GitHub delivery from
   payload data without making duplicate Slack posts.

Acceptance criteria:

- PR created posts exactly one PR card.
- Every public Vercel preview URL for the branch is either a button or a text link
  when Slack button limits are reached.
- Deployment-ready posts exactly once per unique deployment URL.
- PR merged reacts to the original Slack message and posts exactly one status
  message.
- Vercel dashboard URLs are filtered out.

Implementation notes:

- Added durable cross-cutting observability through `orchestratorEvents` so
  webhook, Slack intake, T3 bridge, GitHub delivery, and ignored-event paths are
  visible even when no task-scoped event exists yet.
- GitHub webhook handling now logs received, parsed, ignored, unlinked, claimed,
  delivered, and failed states for `deployment_status` and `pull_request` events.
- Deployment-ready delivery still keys idempotency by task, deployment identity,
  resolved branch preview URL, and source link, so duplicate GitHub deliveries
  should not repost the same Slack message.
- PR-created, deployment-ready, and PR-merged notifications remain separate event
  families so each can be delivered once without suppressing the others.
- T3 bridge and Slack delivery paths now log start/completion/failure around
  materialization, continuation, assistant-message relay, PR status cards, and
  lifecycle replies.

Implementation footprint:

- `apps/orchestrator/convex/schema.ts`
- `apps/orchestrator/convex/observability.ts`
- `apps/orchestrator/convex/http.ts`
- `apps/orchestrator/convex/github.ts`
- `apps/orchestrator/convex/taskIntake.ts`
- `apps/orchestrator/convex/t3Runtime.ts`
- `apps/orchestrator/convex/_generated/*`

## Phase 5: Project And Worktree Safety

Goal: ensure production tasks modify the intended repo and branch base.

Tasks:

1. Keep default project fallback to `nextcard`.
2. Route by explicit project mention:
   - `nextcard` -> Nextcard project
   - `t3code` -> T3 Code project
3. Maintain a production allowlist of workspace roots.
4. Refresh the remote base branch before new worktree creation without moving the
   local base branch.
5. Ensure existing-worktree follow-ups do not fetch/recreate the worktree.
6. Validate that AI-generated title/branch rename is reflected in the sidebar and
   PR metadata.

Acceptance criteria:

- A Slack task without a project mention uses Nextcard.
- A Slack task mentioning `t3code` uses the T3 Code workspace.
- New worktree branches start from the latest `origin/<baseBranch>`.
- The local base branch is not checked out, pulled, merged, or fast-forwarded by
  worktree creation.
- PR title/branch/card metadata matches the final actual branch, not stale Convex
  metadata.

## Phase 6: Observability And Operations

Goal: make failures diagnosable without guessing from Slack behavior.

Tasks:

1. Add structured logs around:
   - Slack webhook received
   - Chat SDK subscription lookup
   - gating decision
   - task materialization request/response
   - T3 callback received
   - assistant message relayed
   - PR ensure requested/result
   - GitHub webhook received/result
   - Slack reply/card/reaction delivered or failed
2. Add a production debugging guide for:
   - "Slack message received but no response"
   - "Open T3 card missing"
   - "Assistant message not relayed"
   - "PR card missing"
   - "Deployment URL wrong"
   - "T3 server/tunnel down"
3. Add a daily or manual health check command that verifies Convex env, T3 local
   server, Cloudflare, Slack webhook, and GitHub webhook reachability.
4. Define paging/notification expectations for failures. For the first production
   phase, a visible Slack error reply is acceptable for user-triggered failures.

Acceptance criteria:

- A single task can be traced across Slack, Convex, T3, GitHub, and back to Slack
  by IDs in logs.
- User-visible errors are relayed to Slack when a webhook was handled but later
  orchestration failed.
- Operators can distinguish ignored messages from failed messages.

## Phase 7: Staging And Cutover

Goal: move from Convex dev to production without breaking the working pilot.

Cutover sequence:

1. Freeze changes except production-readiness fixes.
2. Deploy to staging or production Convex with production env vars.
3. Point a staging Slack app/channel and GitHub test webhook at the new Convex
   deployment.
4. Run the full E2E checklist:
   - initial mention
   - existing Slack thread context on first invocation
   - mention-free follow-up
   - aside
   - mute
   - unmute
   - ignored message mentioning another human
   - harmless file change
   - assistant replies
   - commit/push
   - PR card
   - branch preview deployment message
   - PR merged message and checkmark reaction
5. Switch production Slack/GitHub webhooks to the production Convex URL.
6. Run the same smoke test in `#testing`.
7. Keep dev deployment intact as rollback for one release window.

Rollback:

- Repoint Slack and GitHub webhooks to the previous Convex dev site URL.
- Keep the local T3 bridge secret compatible during the rollback window, or rotate
  it immediately after rollback if production traffic reached the new deployment.
- Pause production Convex scheduled/queued work if duplicate delivery risk exists.

Acceptance criteria:

- Production Slack and GitHub webhooks point to the intended Convex deployment.
- The production smoke test completes with one PR and one preview URL message.
- Rollback URL and commands are documented before cutover starts.

## Phase 8: Post-Cutover Cleanup

Goal: remove temporary assumptions once production is stable.

Tasks:

1. Update `apps/orchestrator/AGENTS.md` so it no longer says Convex dev is the
   canonical live deployment.
2. Remove stale Linear chat documentation and any inactive Linear webhook config
   that could confuse operators.
3. Archive old EC2/Caddy/systemd T3 hosting runbooks from active docs.
4. Document the production Slack/GitHub webhook URLs.
5. Add periodic dependency/update checks for upstream `pingdotgg/t3code`.
6. Decide whether to keep the local machine architecture long-term or migrate the
   execution host later.

Acceptance criteria:

- New agents can determine the correct production deployment from docs alone.
- There is no stale active-path doc pointing to an old Convex URL, EC2 host, or
  Linear chat flow.
- The production E2E checklist has a date-stamped passing run.

## Open Risks

- Local Windows machine uptime is now production uptime for execution.
- Convex dev/prod confusion can cause webhooks to hit the wrong deployment.
- Cloudflare tunnel or local scheduled task failure can make Slack intake succeed
  while T3 execution fails.
- GitHub deployment events may arrive before task/PR correlation is fully stored.
- Slack button limits can hide preview URLs unless overflow rendering is kept.
- Provider changes may alter assistant message event shapes; relay logic must stay
  provider-neutral.

## Near-Term Next Steps

1. Create the production Convex deployment and copy env vars from dev using fresh
   secrets.
2. Write the production runbook for the Windows scheduled tasks and Cloudflare
   tunnel.
3. Add/verify the E2E checklist in a dedicated doc or test tracker.
4. Run staging Slack/GitHub E2E against the production Convex deployment before
   changing the real Slack app webhook URL.
5. After cutover, update `apps/orchestrator/AGENTS.md` to remove the dev-only
   instruction.
