# Single-Host Hub / Runner Deployment (`t3hub` + `t3runner`)

When deploying T3 Code Teams on a shared company host, split the **Team Control Plane** (`t3hub`) from the **Execution Runner** (`t3runner`) across two dedicated Linux OS users. Coding agents execute arbitrary shell commands, so keeping them in an unprivileged OS user prevents any agent (or prompt injection) from reading `statev2.sqlite`, `ServerSecretStore`, admin-only View transcripts, or team invite hashes.

## Architecture

| Process                         | OS User    | Data Directory                                 | Bind Address                                | Responsibilities                                                                                                                              |
| ------------------------------- | ---------- | ---------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **`t3hub`** (`--team-hub-only`) | `t3hub`    | `/var/lib/t3hub` (`0700 t3hub:t3hub`)          | `0.0.0.0:3773` (or reverse proxy / Tailnet) | Owns `statev2.sqlite` (RBAC, Views, invites, transcripts) and `ServerSecretStore`. Refuses to spawn coding agents or shell terminals locally. |
| **`t3runner`**                  | `t3runner` | `/var/lib/t3runner` (`0700 t3runner:t3runner`) | `127.0.0.1:3774` (loopback only)            | Runs coding agents, terminals, and project workspaces. Has zero filesystem access to `/var/lib/t3hub` and cannot mint sessions on `t3hub`.    |

## 1. Create Dedicated OS Users and Directories

```bash
sudo useradd --system --home-dir /var/lib/t3hub --create-home --shell /usr/sbin/nologin t3hub
sudo useradd --system --home-dir /var/lib/t3runner --create-home --shell /bin/bash t3runner

sudo chmod 700 /var/lib/t3hub /var/lib/t3runner
sudo chown t3hub:t3hub /var/lib/t3hub
sudo chown t3runner:t3runner /var/lib/t3runner

# Project workspaces are owned by t3runner (never grant t3runner access to /var/lib/t3hub).
sudo mkdir -p /srv/t3-workspaces
sudo chown t3runner:t3runner /srv/t3-workspaces
```

## 2. Configure systemd Units

### `/etc/systemd/system/t3hub.service`

```ini
[Unit]
Description=T3 Code Team Control Plane (t3hub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=t3hub
Group=t3hub
Environment=T3CODE_HOME=/var/lib/t3hub
Environment=T3CODE_TEAM_HUB_ONLY=1
ExecStart=/usr/local/bin/t3 serve --team-hub-only --host 0.0.0.0 --port 3773 --base-dir /var/lib/t3hub
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/t3hub

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/t3runner.service`

```ini
[Unit]
Description=T3 Code Default Team Runner (t3runner)
After=network-online.target t3hub.service

[Service]
Type=simple
User=t3runner
Group=t3runner
Environment=T3CODE_HOME=/var/lib/t3runner
ExecStart=/usr/local/bin/t3 serve --host 127.0.0.1 --port 3774 --base-dir /var/lib/t3runner
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
InaccessiblePaths=/var/lib/t3hub

[Install]
WantedBy=multi-user.target
```

Enable and start both services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now t3hub t3runner
```

## 3. Attach `t3runner` to `t3hub` Over Loopback

1. Verify `t3hub` advertises control-plane-only mode (`capabilities.teamHubOnly === true`):

   ```bash
   curl -s http://127.0.0.1:3773/api/environment/descriptor | jq '{environmentId, teamHubOnly: .capabilities.teamHubOnly}'
   ```

2. Mint a one-time pairing credential on `t3runner` (run as `t3runner`):

   ```bash
   sudo -u t3runner t3 pair --base-dir /var/lib/t3runner
   ```

3. Pair an owner client with `t3hub`, initialize the team in **Settings → Teams**, and link `http://127.0.0.1:3774` as a linked environment using `t3runner`'s pairing code (`--team-hub-only` automatically enables peer links and permits attaching distinct loopback runners).

## 4. Verify Isolation

- **Hub refuses local execution:** Dispatching a turn or opening a terminal directly on `t3hub` is rejected with an explicit `--team-hub-only` error; `t3hub` never spawns agent or PTY child processes.
- **OS filesystem boundary:** Confirm `t3runner` cannot inspect `t3hub`'s database or secrets:

  ```bash
  sudo -u t3runner ls /var/lib/t3hub/userdata
  # Permission denied
  ```

- **No upward privilege from runner to hub:** `t3runner` holds no `t3hub` session token and cannot mint sessions or read RBAC/invite tables on `t3hub`. Every MCP call originating from a turn on `t3runner` is bound to `actingMemberId = turnAuthorMemberId`.

## 5. Optional Layer 2 Hardening (Concurrent Teammates)

To further isolate concurrent agent turns running under `t3runner`:

- Mount `/proc` with `hidepid=2` so sibling processes cannot inspect each other's `/proc/<pid>` entries.
- Wrap agent commands in Linux `bwrap` (bubblewrap) mounting only the thread's worktree, `/tmp`, and its turn-scoped socket, or run separate runner users per trust tier (for example `t3runner-default` and `t3runner-admin`).
