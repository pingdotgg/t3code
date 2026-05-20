# Orchestrator Operations Runbook

This runbook is for the current Vevin production topology:

- Convex production is the canonical live orchestrator deployment.
- Slack and GitHub webhooks point at the active Convex site URL.
- Local T3 runs on this Windows machine and is exposed through Cloudflare at `https://t3.olumbe.com`.
- `t3code-server` and `cloudflared-t3code` should both run as Windows services.

Use this with `apps/orchestrator/AGENTS.md` and `docs/orchestrator-deployment.md`.

Current production Convex site:

```text
https://basic-porcupine-321.convex.site
```

## Fast Triage

Run the local production health check first:

```powershell
cd C:\Users\Vivek\Affil\t3code
$env:T3CODE_HEALTH_CONVEX_SITE_URL = "https://basic-porcupine-321.convex.site"
bun run health:orchestrator
```

The command checks:

- `t3code-server` scheduled task
- `t3code-server` Windows service
- `cloudflared-t3code` Windows service
- local T3 at `http://127.0.0.1:3773`
- public T3/Cloudflare at `https://t3.olumbe.com`
- unauthenticated bridge status at `/api/execution/runs/status`
- Convex `/health`
- recent `severity: "error"` orchestrator events

Start with the durable Convex event log:

```powershell
cd C:\Users\Vivek\Affil\t3code\apps\orchestrator
bunx convex run observability:listRecent -- '{ "limit": 25 }'
```

Useful filters:

```powershell
bunx convex run observability:listRecent -- '{ "source": "slack", "limit": 25 }'
bunx convex run observability:listRecent -- '{ "source": "github", "limit": 25 }'
bunx convex run observability:listRecent -- '{ "source": "t3", "limit": 25 }'
bunx convex run observability:listRecent -- '{ "severity": "error", "limit": 50 }'
bunx convex run observability:listRecent -- '{ "externalId": "T123:C123:1770000000.000000", "limit": 50 }'
```

Task-scoped logs:

```powershell
bunx convex run observability:listRecent -- '{ "taskId": "<convex task id>", "limit": 100 }'
bunx convex run taskEvents:listTaskEvents -- '{ "taskId": "<convex task id>", "limit": 100 }'
```

`orchestratorEvents` is the cross-cutting audit log. It includes events that may not have a task yet, such as ignored Slack messages, unlinked GitHub deliveries, and webhook auth failures.

`taskEvents` is the task-scoped idempotency and lifecycle log. It records claims, delivered replies, PR ensure results, and work-session lifecycle events.

## Slack Message Received But No Reply

1. Confirm the webhook reached Convex:

   ```powershell
   bunx convex run observability:listRecent -- '{ "source": "slack", "limit": 50 }'
   ```

2. Look for these events:
   - `http.slack-webhook.received`
   - `slack.webhook.action-received`
   - `slack.message.received`
   - `slack.policy.accepted`
   - `task-intake.store.resolved`
   - `task-intake.runtime.materialize-started` or `task-intake.runtime.continue-started`

3. If you see `slack.policy.ignored`, inspect `payloadJson.reason`.

   Expected ignore reasons include:
   - `slack_thread_aside`
   - `slack_thread_muted`
   - `slack_thread_other_user_mention`
   - `slack_ambient_without_task_thread`

4. If `slack.policy.accepted` exists but no runtime event follows, inspect errors:

   ```powershell
   bunx convex run observability:listRecent -- '{ "severity": "error", "limit": 50 }'
   ```

5. Check active Convex logs:

   ```powershell
   cd C:\Users\Vivek\Affil\t3code\apps\orchestrator
   bunx convex logs
   ```

## Open T3 Card Missing

1. Find the accepted Slack event:

   ```powershell
   bunx convex run observability:listRecent -- '{ "source": "slack", "limit": 50 }'
   ```

2. Expected event sequence for a new task:
   - `slack.reply.acknowledged`
   - `task-intake.runtime.materialize-completed`
   - `slack.reply.task-started-card-delivered`

3. If materialization completed but the card did not post, look for:
   - `slack.reply.task-started-card-failed`
   - `task-started-status-reply.failed` in `taskEvents`

4. If the card posted without a useful URL, confirm Convex env:

   ```powershell
   bunx convex env list
   ```

   Required:

   ```text
   T3_WEB_APP_BASE_URL=https://t3.olumbe.com
   T3_EXECUTION_BRIDGE_BASE_URL=https://t3.olumbe.com
   ```

## Assistant Message Not Relayed

1. Confirm T3 called Convex:

   ```powershell
   bunx convex run observability:listRecent -- '{ "kind": "http.t3-assistant-message.received", "limit": 25 }'
   ```

2. Expected delivery sequence:
   - `http.t3-assistant-message.received`
   - `task-intake.assistant-message-reply.claimed`
   - `task-intake.assistant-message-reply.delivery-started`
   - `task-intake.assistant-message-reply.delivered`

3. If no HTTP event exists, inspect local T3 logs and bridge callback env:

   ```text
   ORCHESTRATOR_BASE_URL=https://basic-porcupine-321.convex.site
   T3_EXECUTION_BRIDGE_SHARED_SECRET=<same secret configured in Convex>
   ```

4. If the claim count is zero, inspect task links:

   ```powershell
   bunx convex run taskExternalLinks:listTaskExternalLinks -- '{ "taskId": "<convex task id>" }'
   ```

   The Slack thread link should be present and not muted.

## PR Card Missing

1. Confirm the terminal lifecycle callback:

   ```powershell
   bunx convex run observability:listRecent -- '{ "kind": "http.t3-runtime-event.received", "limit": 50 }'
   ```

2. Expected sequence:
   - `http.t3-runtime-event.received` with `type: completed`
   - `t3.pr.ensure-requested`
   - `t3.pr.ensure-completed`
   - `task-intake.pr-status-reply.claimed`
   - `task-intake.pr-status-reply.delivered`

3. If PR ensure reports `waiting_for_changes`, the agent finished without file changes.

4. If PR ensure failed, inspect:

   ```powershell
   bunx convex run observability:listRecent -- '{ "kind": "t3.pr.ensure-completed", "limit": 20 }'
   bunx convex run observability:listRecent -- '{ "severity": "error", "limit": 50 }'
   ```

5. Confirm local GitHub auth on the T3 host:

   ```powershell
   gh auth status
   ```

## Deployment URL Wrong Or Missing

1. Confirm GitHub sent deployment events:

   ```powershell
   bunx convex run observability:listRecent -- '{ "source": "github", "kind": "github.deployment-status.parsed", "limit": 50 }'
   ```

2. Expected sequence:
   - `http.github-webhook.received`
   - `github.deployment-status.parsed`
   - `github.deployment-status.delivery-claiming`
   - `github.deployment-status.delivery-claimed`
   - `github.deployment-status.slack-delivered`

3. If you see `github.deployment-status.unlinked`, GitHub delivered the event before Convex had a PR record for that head SHA, or the SHA does not match the linked PR.

4. If the URL is commit-specific, inspect the `delivery-claiming` payload:
   - `originalUrl`
   - `branchUrl`
   - `environment`
   - `headBranch`

   `branchUrl` is what Slack should receive.

5. Dashboard URLs such as `https://vercel.com/...` should be filtered before parsing.

## PR Merged Reaction Missing

1. Confirm GitHub `pull_request` webhooks are configured for the repo.

2. Query merged events:

   ```powershell
   bunx convex run observability:listRecent -- '{ "source": "github", "kind": "github.pull-request.merged-parsed", "limit": 25 }'
   ```

3. Expected sequence:
   - `github.pull-request.merged-parsed`
   - `github.pull-request.merge-delivery-claimed`
   - `github.pull-request.merge-slack-delivery-started`
   - `github.pull-request.merge-slack-delivered`

4. If you see `github.pull-request.unlinked`, Convex does not have a `githubPullRequests` row matching `owner/repo#number`.

5. If delivery failed, inspect the error payload. Reaction failures usually mean the original Slack message id could not be reconstructed from the Slack thread external id.

## Local T3 Or Cloudflare Down

Check the local server and Cloudflare Windows services:

```powershell
Get-Service t3code-server
Get-Service cloudflared-t3code
```

Check local and tunnel reachability:

```powershell
curl.exe -i http://127.0.0.1:3773/
curl.exe -i https://t3.olumbe.com/
curl.exe -i -X POST https://t3.olumbe.com/api/execution/runs/status
```

Expected unauthenticated bridge result:

- `401`: route exists and shared secret is configured
- `503`: route exists but local server is missing `T3_EXECUTION_BRIDGE_SHARED_SECRET`
- `404`: running server build does not include the bridge route, or Cloudflare is not reaching it
- Cloudflare `530`: Cloudflare is reachable but no tunnel connector is connected

The current production-like services are:

- `t3code-server`: NSSM-wrapped Windows service that runs
  `scripts\start-t3code-server.cmd`
- `cloudflared-t3code`: Cloudflare Tunnel Windows service

The Cloudflare tunnel config should forward to `http://127.0.0.1:3773`, not
`http://localhost:3773`. On Windows, `localhost` can resolve to IPv6 and hit a
parallel hot-reload server instead of the production-like service.

The old `t3code-server` and `t3code-tunnel` scheduled tasks should remain
disabled after both services are healthy.

Useful service commands:

```powershell
Get-Service t3code-server
Restart-Service t3code-server
sc.exe qc t3code-server
Get-Service cloudflared-t3code
Restart-Service cloudflared-t3code
sc.exe qc cloudflared-t3code
sc.exe qfailure cloudflared-t3code
```

If either service needs to be installed or repaired, run an elevated PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
C:\Users\Vivek\Affil\t3code\scripts\install-t3code-server-service.ps1
C:\Users\Vivek\Affil\t3code\scripts\install-cloudflared-t3code-service.ps1
```

On 2026-05-15 the old scheduled tunnel task was found stopped because Task
Scheduler had `Stop Task If Runs X Hours and X Mins` set to 72 hours. The fix was
to disable that execution limit and replace the tunnel scheduled task with the
`cloudflared-t3code` service.

For active local development:

```cmd
bun run dev:local-cloudflare
```

Stop `t3code-server` first so the hot-reload server can bind `3773`. Set
`T3CODE_SKIP_CLOUDFLARE=1` when the `cloudflared-t3code` service is already
running. Use `bun run dev:local-cloudflare`, not `bun run dev:server`, when the
public Cloudflare URL should point at the hot-reload server; the local Cloudflare
dev wrapper keeps the stable pairing token armed in the dev auth database.

## Updating T3 Code Server From Upstream

The services run this local checkout. Use the scripted path from an elevated
PowerShell:

```powershell
cd C:\Users\Vivek\Affil\t3code
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\update-t3code-server.ps1
```

The script refuses to merge over a dirty worktree unless `-AllowDirty` is
passed. It fetches/merges `pingdotgg/main`, installs dependencies, builds,
restarts `t3code-server`, and runs `bun run health:orchestrator`.

Manual equivalent:

```powershell
cd C:\Users\Vivek\Affil\t3code
git fetch pingdotgg main
git merge pingdotgg/main
bun install
bun run build
Restart-Service t3code-server
curl.exe -i http://127.0.0.1:3773/
curl.exe -i https://t3.olumbe.com/
curl.exe -i -X POST https://t3.olumbe.com/api/execution/runs/status
```

Expected bridge result is `401` without auth. If it returns `404`, the running
server build does not include the bridge route or the tunnel is not reaching the
server. If it returns `503`, the server is missing the bridge shared secret.

The Cloudflare service usually does not need a restart when T3 code changes,
because it only forwards traffic to the local port.

## Health Monitor Slack Alerts

`bun run health:orchestrator` can post failure alerts through Convex to Slack.
The local monitor does not use Slack credentials directly. It sends a signed
request to Convex, and Convex posts to Slack through the Chat SDK.

Current alert destination:

```text
#infrastructure
T3_OPS_SLACK_ALERT_CHANNEL_ID=slack:C08JGQQMJCQ
```

Required env:

```text
T3_OPS_ALERT_SECRET=<shared local monitor to Convex secret>
T3_OPS_SLACK_ALERT_CHANNEL_ID=slack:C08JGQQMJCQ
```

Convex dev must have the same values:

```powershell
cd C:\Users\Vivek\Affil\t3code\apps\orchestrator
bunx convex env set T3_OPS_ALERT_SECRET "<secret>"
bunx convex env set T3_OPS_SLACK_ALERT_CHANNEL_ID "slack:C08JGQQMJCQ"
```

Run the notifying monitor once:

```powershell
cd C:\Users\Vivek\Affil\t3code
.\scripts\run-orchestrator-health-monitor.cmd
```

Install the recurring Windows scheduled task from an elevated PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
C:\Users\Vivek\Affil\t3code\scripts\install-orchestrator-health-monitor-task.ps1
```

The scheduled task runs every five minutes by default and posts only when a
health check changes state:

- first failing run posts one failure alert
- repeated failing runs stay quiet
- first passing run after a failure posts one recovery alert

The local state file defaults to:

```text
logs/orchestrator-health-monitor-state.json
```

Override with `T3CODE_HEALTH_ALERT_STATE_PATH` if the task needs to write state
somewhere else.

## Replay Notes

GitHub redelivery is safe for supported events because Slack delivery is guarded by `taskEvents` claim keys:

- deployment-ready keys include task, deployment identity, resolved URL, and source link
- PR-merged keys include task, PR identity, and source link
- PR status cards are keyed by work session, PR identity, and source link

Use GitHub's webhook redelivery UI for a real replay. The orchestrator should record the redelivery in `orchestratorEvents` while suppressing duplicate Slack posts if the claim was already delivered.

## Production Configuration Checklist

Use this checklist when verifying Slack, GitHub, and local T3 are all pointed at
the production Convex deployment.

### Verify Production

1. Confirm the production Convex deployment URL:

   ```text
   Production: https://basic-porcupine-321.convex.site
   ```

2. Set production Convex env vars:

   ```powershell
   cd C:\Users\Vivek\Affil\t3code\apps\orchestrator
   bunx convex env set --prod T3_EXECUTION_BRIDGE_BASE_URL "https://t3.olumbe.com"
   bunx convex env set --prod T3_WEB_APP_BASE_URL "https://t3.olumbe.com"
   bunx convex env set --prod T3_EXECUTION_BRIDGE_SHARED_SECRET "<rotated bridge secret>"
   bunx convex env set --prod GITHUB_WEBHOOK_SECRET "<rotated github webhook secret>"
   ```

3. Confirm Slack Chat SDK credentials and GitHub token are set on the target deployment.

4. Deploy the target Convex deployment.

5. Configure local T3 to call the production Convex URL:

   ```text
   ORCHESTRATOR_BASE_URL=https://basic-porcupine-321.convex.site
   T3_EXECUTION_BRIDGE_SHARED_SECRET=<same rotated bridge secret>
   ```

6. Run health checks against production:

   ```powershell
   cd C:\Users\Vivek\Affil\t3code
   $env:T3CODE_HEALTH_CONVEX_SITE_URL = "https://basic-porcupine-321.convex.site"
   bun run health:orchestrator
   ```

7. Confirm Slack event/webhook URL:

   ```text
   https://basic-porcupine-321.convex.site/slack/webhook
   ```

8. Confirm the GitHub webhook URL on every coding target repo that Vevin creates
   PRs against. The current required repo is:

   ```text
   https://github.com/affil-ai/nextcard/settings/hooks
   ```

   The webhook URL should be:

   ```text
   https://basic-porcupine-321.convex.site/github/webhook
   ```

   Do not expect this webhook to exist on `affil-ai/t3code` unless Vevin is also
   creating PRs against the orchestrator repo itself.

9. Confirm each target-repo GitHub webhook uses content type `application/json`,
   uses the same secret as Convex `GITHUB_WEBHOOK_SECRET`, and includes:

   ```text
   pull_request
   deployment_status
   ```

10. Restart or reload local T3 if `ORCHESTRATOR_BASE_URL` or bridge secret changed.

11. Run the full smoke:

- initial Slack mention gets eyes reaction
- `Talk to Vevin in this thread` card appears with `Open T3`
- assistant replies relay
- mention-free follow-up works
- `aside - ...` is ignored
- `@Vevin mute` and `@Vevin unmute` get acknowledgement reactions
- harmless file change creates commit, push, and PR
- PR card has `View PR` and deployment buttons only
- deployment-ready message posts a branch preview URL
- merging the PR reacts to the original Slack message and posts merged status

12. Inspect the trace:

```powershell
cd C:\Users\Vivek\Affil\t3code\apps\orchestrator
bunx convex run observability:listRecent -- '{ "limit": 100 }'
bunx convex run observability:listRecent -- '{ "severity": "error", "limit": 50 }'
```

### Emergency Dev Rollback

Use only if production is intentionally being rolled back to the old dev pilot
deployment.

1. Repoint Slack to:

   ```text
   https://scrupulous-fly-947.convex.site/slack/webhook
   ```

2. Repoint GitHub to:

   ```text
   https://scrupulous-fly-947.convex.site/github/webhook
   ```

3. Restore local T3:

   ```text
   ORCHESTRATOR_BASE_URL=https://scrupulous-fly-947.convex.site
   T3_EXECUTION_BRIDGE_SHARED_SECRET=<dev bridge secret>
   ```

4. Restart local T3 and run:

   ```powershell
   cd C:\Users\Vivek\Affil\t3code
   $env:T3CODE_HEALTH_CONVEX_SITE_URL = "https://scrupulous-fly-947.convex.site"
   bun run health:orchestrator
   ```
