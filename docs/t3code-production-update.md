# T3 Code Production Update Runbook

This runbook assumes the production-like server runs from the WSL checkout and
is managed by the user-level systemd service `t3code-server.service`.

## Golden Rule

If an update is initiated from a T3/Slack-launched agent session, avoid
restarting the server inline. Restarting T3 kills the process relaying the
agent's response. Use an external WSL terminal, the Codex desktop app, or a
detached wrapper.

## Normal WSL Update

```bash
cd ~/code/t3code
git fetch origin
git pull --ff-only origin <branch>
vp i
vp run build
systemctl --user restart t3code-server.service
```

Verify:

```bash
systemctl --user status t3code-server.service --no-pager
curl -i http://127.0.0.1:3773/
curl -i https://<your-public-t3-url>/
curl -sS https://<your-public-t3-url>/api/external-intake/health
vp run health:orchestrator
```

## Restart Only

```bash
cd ~/code/t3code
systemctl --user restart t3code-server.service
systemctl --user status t3code-server.service --no-pager
```

## Logs

```bash
journalctl --user -u t3code-server.service -n 150 --no-pager
journalctl --user -u t3code-server.service -f
```

## Expected Health

The public app should return `200`:

```bash
curl -i https://<your-public-t3-url>/
```

The unauthenticated bridge check should return:

- `401`: bridge route is live and shared-secret auth is active.
- `503`: bridge route is live but the shared secret is missing.
- `404`: stale build or Cloudflare is not reaching the server.

The external-intake health endpoint should return `ok: true` and the current
webhook URLs:

```bash
curl -sS https://<your-public-t3-url>/api/external-intake/health
```
