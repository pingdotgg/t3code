# Orchestrator Deployment

This runbook covers the local production topology:

- the T3 server runs on this Windows PC at `127.0.0.1:3773`
- Cloudflare Tunnel `t3code-local` exposes it publicly at `https://t3.olumbe.com`
- Convex calls the local server bridge through that public URL
- Slack calls the Convex public HTTP endpoint

## Local Services

The local T3 server and Cloudflare connector are separate local services:

```text
t3code-server
  Windows service wrapping:
  scripts\start-t3code-server.cmd

cloudflared-t3code
  Windows service:
  C:\Program Files (x86)\cloudflared\cloudflared.exe --config C:\Users\Vivek\.cloudflared\config.yml tunnel run t3code-local
```

`t3code-server` should run as a Windows service via NSSM. Install or repair it
from an elevated PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
C:\Users\Vivek\Affil\t3code\scripts\install-t3code-server-service.ps1
```

If another dev/server process already owns port `3773`, stop it first or rerun
with `-StopExistingPortOwner`.

The old `t3code-server` scheduled task should remain disabled after the service
is healthy. On 2026-05-15 the old scheduled tunnel/server tasks were found with
a 72-hour execution limit, which caused the Cloudflare tunnel to stop after
three days and made `https://t3.olumbe.com` return Cloudflare `530`.

`cloudflared-t3code` replaced the old `t3code-tunnel` scheduled task. It is a
Windows service configured for automatic startup and restart-on-failure. The old
`t3code-tunnel` scheduled task should remain disabled so two connectors do not
run at the same time.

The tunnel ingress should point at the IPv4 loopback address, not `localhost`,
so Cloudflare cannot accidentally land on a parallel hot-reload server bound to
IPv6:

```yaml
ingress:
  - hostname: t3.olumbe.com
    service: http://127.0.0.1:3773
  - service: http_status:404
```

Install or repair the Cloudflare service from an elevated PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
C:\Users\Vivek\Affil\t3code\scripts\install-cloudflared-t3code-service.ps1
```

Use the operator command from the repo root to start the server, tunnel, and desktop app:

```cmd
scripts\start-t3code-prod.cmd
```

For active development, use the hot-reloading local server command instead:

```cmd
bun run dev:local-cloudflare
```

This runs the server from source on `127.0.0.1:3773` and runs
`cloudflared tunnel run t3code-local` in the same terminal. Stop or pause the
`t3code-server` scheduled task first so the dev server can bind port `3773`.
Set `T3CODE_SKIP_CLOUDFLARE=1` because the `cloudflared-t3code` Windows service
normally owns the tunnel.

## Stable Pairing Token

Set `T3CODE_OWNER_PAIRING_TOKEN` in `.env.local` to reuse the same owner pairing
URL across local server restarts:

```text
T3CODE_OWNER_PAIRING_TOKEN=<long random local-only token>
```

Then use:

```text
https://t3.olumbe.com/pair#token=<long random local-only token>
```

`bun run dev:local-cloudflare` keeps the matching local auth row armed while it
runs, so hot-reload server restarts do not force you to chase the transient
startup token in the logs. Running `bun run dev:server` directly can serve the
public URL from the dev auth database without the pairing-token refresh loop.
The production service also seeds the same token before startup. To seed
manually, run:

```cmd
bun run auth:seed-owner-pairing
```

## Convex Env

Run Convex commands from `apps/orchestrator` with the intended `CONVEX_DEPLOYMENT` selected.

```bash
bunx convex env set --prod T3_EXECUTION_BRIDGE_BASE_URL 'https://t3.olumbe.com'
bunx convex env set --prod T3_EXECUTION_BRIDGE_SHARED_SECRET '<same secret used by local T3 server>'
bunx convex env set --prod LINEAR_DEFAULT_WORKSPACE_ROOT 'C:\Users\Vivek\Affil\t3code'
bunx convex env set --prod GITHUB_WEBHOOK_SECRET '<shared GitHub webhook secret>'
```

Slack and GitHub webhook URLs stay on Convex:

```text
https://<your-convex-site>/slack/webhook
https://<your-convex-site>/github/webhook
```

Configure the GitHub webhook for `deployment_status` and `pull_request` events.
The orchestrator verifies `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`,
posts public preview URLs when deployments become ready, and reacts to the
original Slack task with a checkmark when the linked PR is merged.

Operational debugging lives in `docs/orchestrator-operations.md`. Start there
when Slack receives a message but Vevin does not reply, when PR/deployment cards
are missing, or when a GitHub redelivery needs to be traced.

Lifecycle callbacks from T3 use:

```text
POST https://<your-convex-site>/t3/task-runtime-events
```

So the local T3 server must have:

```text
ORCHESTRATOR_BASE_URL=https://<your-convex-site>
T3_EXECUTION_BRIDGE_SHARED_SECRET=<same secret configured in Convex>
T3_DEFAULT_PROVIDER_INSTANCE_ID=codex
T3_DEFAULT_MODEL=gpt-5.5
```

## Bridge Health Checks

Run the combined local/Cloudflare/Convex check:

```powershell
cd C:\Users\Vivek\Affil\t3code
$env:T3CODE_HEALTH_CONVEX_SITE_URL = "https://scrupulous-fly-947.convex.site"
bun run health:orchestrator
```

Manual checks:

```powershell
Get-Service t3code-server
Get-Service cloudflared-t3code
curl.exe -i http://127.0.0.1:3773/
curl.exe -i https://t3.olumbe.com/
curl.exe -i -X POST https://t3.olumbe.com/api/execution/runs/status
```

Expected bridge result without auth:

- `401` means the route exists and the shared secret is configured
- `503` means the route exists but the local server is missing `T3_EXECUTION_BRIDGE_SHARED_SECRET`
- `404` means the route is not in the running server build or the tunnel is not reaching it

## Ops Alerts

The health monitor posts Slack alerts through Convex, not directly from the
Windows machine to Slack. Configure both the local `.env.local` and Convex dev
with:

```text
T3_OPS_ALERT_SECRET=<shared local monitor to Convex secret>
T3_OPS_SLACK_ALERT_CHANNEL_ID=slack:C08JGQQMJCQ
```

`C08JGQQMJCQ` is `#infrastructure`. The Convex endpoint is
`POST /ops/health-alert`; it requires `Authorization: Bearer <T3_OPS_ALERT_SECRET>`
and posts a Chat SDK card into the configured Slack channel.

Run a notifying health check:

```cmd
scripts\run-orchestrator-health-monitor.cmd
```

Install the recurring monitor from elevated PowerShell:

```powershell
C:\Users\Vivek\Affil\t3code\scripts\install-orchestrator-health-monitor-task.ps1
```

## Deploy Convex

From `apps/orchestrator`:

```bash
bun run deploy
```

If Convex reports schema incompatibilities during local bring-up, clear the affected deployment data only after confirming it is the intended development/test deployment.

## Updating T3 Code Server From Upstream

The Windows services run the files in this checkout. The scripted update path is
the preferred runbook:

```powershell
cd C:\Users\Vivek\Affil\t3code
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\update-t3code-server.ps1
```

Run PowerShell as Administrator when the script will restart `t3code-server`.
Without elevation, use `-SkipRestart`, then restart the service manually from an
elevated shell.

The script:

- refuses to merge over a dirty worktree unless `-AllowDirty` is passed
- fetches and merges `pingdotgg/main` by default
- runs `bun install`
- runs `bun run build`
- restarts the `t3code-server` Windows service
- runs `bun run health:orchestrator`

Equivalent manual flow:

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

The Cloudflare service usually does not need a restart for upstream T3 changes;
it only forwards traffic to `127.0.0.1:3773`. Restart `cloudflared-t3code` only
when the tunnel config or service itself changes.

For source-code development with hot reload, stop `t3code-server`, run
`bun run dev:local-cloudflare` with `T3CODE_SKIP_CLOUDFLARE=1`, then rebuild and
restart the service when the change is ready to become the production-like
server.

## End-To-End Smoke

1. Start local infra:

   ```cmd
   scripts\start-t3code-prod.cmd
   ```

2. Confirm the bridge returns `401`, not `404`:

   ```powershell
   curl.exe -i -X POST https://t3.olumbe.com/api/execution/runs/status
   ```

3. Post a tiny dated Slack smoke task in `#testing` that mentions `Vevin`.

4. Confirm Convex accepts the webhook, local T3 receives a bridge request, and the originating thread receives a reply.

## Slack E2E Matrix

Use Convex dev until the orchestrator is production-ready:

```bash
cd apps/orchestrator
bun run dev
```

Watch the dev logs while testing:

```powershell
Get-Content $env:TEMP\t3-orchestrator-convex-dev.err.log -Wait
```

Test these Slack behaviors in `#testing`:

- Initial task mention: Vevin reacts to the original message with `eyes`.
- Initial task card: Vevin posts `Talk to Vevin in this thread` with an `Open T3` button.
- Message relay: the message sent to T3 is only the user message and attachment links. Slack client attribution such as `Sent using ChatGPT` must be stripped.
- Aside: a message starting with `aside - ` is ignored and not relayed to T3.
- Mute: `@Vevin mute` stops non-mention follow-ups in that Slack thread; `@Vevin unmute` resumes them.
- PR created: Vevin posts a PR status card with `View PR` and Vercel preview buttons. The PR card must not include an `Open T3` button.
- Deployment ready: Vevin posts a deployment-ready card with the public Vercel preview URL.
- PR merged: Vevin reacts to the original Slack task message with `white_check_mark` and posts the same style PR status card.

### Current E2E Tracker

Update this checklist during each manual/live validation pass:

- [x] Initial mention received by `/slack/webhook` in Convex dev logs.
- [x] Original Slack message gets one `eyes` reaction.
- [x] Initial card posts `Talk to Vevin in this thread` with an `Open T3` button.
- [x] T3 prompt does not include Slack client attribution such as `Sent using ChatGPT`.
- [x] Assistant replies relay back into the Slack thread.
- [x] `aside - ...` follow-up is ignored and does not call T3.
- [x] `@Vevin mute` mutes non-mention follow-ups in that Slack thread.
- [x] `@Vevin unmute` resumes non-mention follow-ups.
- [x] PR-created card posts once with `View PR` and deployment buttons, and no `Open T3` button.
- [x] Deployment-ready event posts the public preview URL.
- [x] PR-merged event adds `white_check_mark` to the original message and posts a PR status card.

Latest live run:

- Slack thread: `C0AJ5HR70PR` / `1778700070.090889`
- Task: `kn76eye74y6t36wczn835ysrs186mgma`
- Work session: `ks7dfw28hb6wb479waxygcfr0x86nzsh`
- PR: `https://github.com/affil-ai/nextcard/pull/1388`
- Verified preview buttons: `nextcard-web`, `nextcard-mcp`, `nextcard-pdp`
- Merge validation: PR #1388 was merged on 2026-05-13 at 13:03 PDT. Convex dev handled the GitHub `pull_request.closed` webhook, Slack parent message `1778700070.090889` received `white_check_mark`, and Vevin posted a merge PR card in the thread at `1778702583.999829`.

PR merge validation steps:

1. Use a disposable Slack-created PR, or a PR that is safe to merge.
2. Merge it on GitHub.
3. Watch Convex dev logs for a `pull_request` webhook handled by `convex/github.ts`.
4. Confirm Vevin reacts to the original Slack task message with `white_check_mark`.
5. Confirm Vevin posts a PR status card in the same Slack thread.
6. Confirm duplicate GitHub deliveries do not post another merge card.
