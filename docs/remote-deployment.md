# Local T3 Server Deployment

The active production-like setup runs T3 on this Windows PC and exposes it through Cloudflare Tunnel.

## Topology

```text
Convex -> https://t3.olumbe.com -> Cloudflare Tunnel t3code-local -> 127.0.0.1:3773
```

Slack does not call the local T3 server directly. It calls Convex:

```text
https://<your-convex-site>/slack/webhook
```

Convex then calls the local T3 execution bridge at `https://t3.olumbe.com`.

## Windows Services

`t3code-server`:

```text
NSSM Windows service wrapping scripts\start-t3code-server.cmd
```

`cloudflared-t3code`:

```text
Cloudflare Windows service running tunnel t3code-local
```

Start the whole local stack:

```cmd
scripts\start-t3code-prod.cmd
```

## Environment

Local T3 server:

```text
ORCHESTRATOR_BASE_URL=https://<your-convex-site>
T3_EXECUTION_BRIDGE_SHARED_SECRET=<shared-secret>
T3_DEFAULT_PROVIDER_INSTANCE_ID=codex
T3_DEFAULT_MODEL=gpt-5.5
```

Convex:

```text
T3_EXECUTION_BRIDGE_BASE_URL=https://t3.olumbe.com
T3_EXECUTION_BRIDGE_SHARED_SECRET=<shared-secret>
LINEAR_DEFAULT_WORKSPACE_ROOT=C:\Users\Vivek\Affil\t3code
```

## Checks

```powershell
Get-Service t3code-server
Get-Service cloudflared-t3code
curl.exe -i http://127.0.0.1:3773/
curl.exe -i https://t3.olumbe.com/
curl.exe -i -X POST https://t3.olumbe.com/api/execution/runs/status
```

Expected unauthenticated bridge response:

- `401`: bridge route is live and the shared secret is configured
- `503`: route is live but local T3 is missing `T3_EXECUTION_BRIDGE_SHARED_SECRET`
- `404`: running server build does not include the bridge route, or the tunnel is not reaching it

## Updating The Server

Use the scripted update path from an elevated PowerShell:

```powershell
cd C:\Users\Vivek\Affil\t3code
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\update-t3code-server.ps1
```

By default this fetches and merges `pingdotgg/main`, runs `bun install`, runs
`bun run build`, restarts the `t3code-server` service, and runs the orchestrator
health check. It refuses to merge over a dirty worktree unless `-AllowDirty` is
passed.

## Provider Auth

Authenticate Codex/Claude on this Windows user account because the service runs
under the configured local account. The local T3 server launches provider
sessions from the same machine and worktree paths.

## Notes

Remote access docs and Tailscale pairing notes can still exist elsewhere, but this file is the active deployment path for the local-PC worker.
