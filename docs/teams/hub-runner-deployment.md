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
   curl -s http://127.0.0.1:3773/.well-known/t3/environment | jq '{environmentId, teamHubOnly: .capabilities.teamHubOnly}'
   ```

2. Enable linked environments on `t3runner` (so `t3runner` accepts `t3hub`'s peer-link OAuth registration) and mint a one-time pairing credential as `t3runner`:

   ```bash
   sudo -u t3runner mkdir -p /var/lib/t3runner/userdata
   sudo -u t3runner sh -c 'cat > /var/lib/t3runner/userdata/settings.json <<EOF
   {"linkedEnvironmentsEnabled": true}
   EOF'
   sudo systemctl restart t3runner
   sudo -u t3runner t3 pair --base-dir /var/lib/t3runner
   ```

3. Pair an owner client with `t3hub`, initialize the team in **Settings → Teams**, and link `http://127.0.0.1:3774` as a linked environment using `t3runner`'s pairing code (`--team-hub-only` automatically enables peer links on `t3hub` and permits attaching distinct loopback runners).

## 4. Verify Isolation

- **Hub refuses local execution:** Dispatching a turn, resuming a queue, delegating a task, or opening a terminal directly on `t3hub` is rejected synchronously with an explicit `--team-hub-only` error; `t3hub` never spawns agent or PTY child processes.
- **OS filesystem boundary:** Confirm `t3runner` cannot inspect `t3hub`'s database or secrets:

  ```bash
  sudo -u t3runner ls /var/lib/t3hub/userdata
  # Permission denied
  ```

- **No upward privilege from runner to hub:** `t3runner` holds no `t3hub` session token and cannot mint sessions or read RBAC/invite tables on `t3hub`.
- **Cross-environment forwarding & ACLs:** `t3hub` enforces per-environment `team_environments` ACLs (roles and member whitelists) before forwarding or issuing short-lived subject-scoped client pairings for linked runners, propagating `actingMemberId` from `t3hub` to `t3runner` on every turn and revoking member sessions across linked peers on role/status changes.

## 5. Optional Layer 2 Hardening (Concurrent Teammates)

The `t3hub` / `t3runner` OS-user split (Plane 2) completely protects the Team Control Plane (`statev2.sqlite`, `ServerSecretStore`, RBAC, invites, and admin-only View transcripts). To also isolate **concurrent teammate turns** running under the same `t3runner` OS user—preventing one agent or shell terminal from reading sibling worktrees, inspecting sibling processes, or touching `t3runner`'s own `userdata`—enable both Linux **`bwrap` (bubblewrap) worktree sandboxing** and **`/proc` `hidepid=2`**.

> **Fail-closed guarantee:** `--team-bwrap-sandbox` (`T3CODE_TEAM_BWRAP_SANDBOX=1`) is **off by default** and has zero effect on personal installs, macOS, Windows, or standard runners. When explicitly enabled, `t3runner` runs a preflight probe at startup verifying Linux, the `bwrap` binary, and unprivileged user-namespace support—and **refuses to start** rather than falling back to unsandboxed execution if any check fails.

### 5.1 Install `bubblewrap` and Configure Ubuntu 24.04 AppArmor (if applicable)

Install `bubblewrap` on Debian / Ubuntu hosts:

```bash
sudo apt-get update && sudo apt-get install -y bubblewrap
```

Verify unprivileged user namespaces are enabled in the kernel:

```bash
sysctl kernel.unprivileged_userns_clone 2>/dev/null || true
# Expected on Debian/Ubuntu (if present): kernel.unprivileged_userns_clone = 1
```

If `kernel.unprivileged_userns_clone` is `0`, enable it persistently:

```bash
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-t3runner-userns.conf
sudo sysctl --system
```

#### Ubuntu 24.04+ AppArmor unprivileged userns restriction

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1` by default, which causes `bwrap` to fail with `bwrap: setting up uid map: Permission denied` unless `bwrap` has an AppArmor profile granting `userns`. Check whether it is active and ensure `/etc/apparmor.d/bwrap` exists:

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true
```

If `kernel.apparmor_restrict_unprivileged_userns = 1` and `/etc/apparmor.d/bwrap` is absent, install the minimal `bwrap` AppArmor profile:

```bash
sudo tee /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Site-specific additions and overrides.
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Confirm `t3runner` can run `bwrap` with PID/IPC/UTS/mount namespaces:

```bash
sudo -u t3runner bwrap \
  --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session \
  --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  --dev /dev --proc /proc --tmpfs /tmp \
  -- true && echo "bwrap preflight OK"
```

### 5.2 Enable `/proc` `hidepid=2` (Host-Wide + systemd Unit)

Mounting `/proc` with `hidepid=2` prevents unprivileged users from viewing `/proc/<pid>` entries belonging to other OS users (such as `t3hub` or root services). Combine host-wide `/etc/fstab` hardening with systemd's per-unit `ProtectProc=invisible` + `ProcSubset=pid` on `t3runner.service`:

#### Option A — Host-wide `/etc/fstab` `hidepid=2`

Create a dedicated group for monitoring daemons that legitimately need full `/proc` visibility (never add `t3runner` to this group), then remount `/proc`:

```bash
sudo groupadd --system proc 2>/dev/null || true
# Optional: add monitoring agents (e.g. node_exporter) to the `proc` group, NEVER `t3runner`.
# sudo usermod -aG proc node_exporter

# Add (or update) the /proc entry in /etc/fstab:
echo 'proc /proc proc defaults,nosuid,nodev,noexec,hidepid=2,gid=proc 0 0' | sudo tee -a /etc/fstab

# Apply immediately without rebooting:
sudo mount -o remount,hidepid=2,gid=proc /proc
```

#### Option B — systemd per-unit `/proc` isolation + `--team-bwrap-sandbox`

Update `/etc/systemd/system/t3runner.service` to enable `--team-bwrap-sandbox` (or `T3CODE_TEAM_BWRAP_SANDBOX=1`), `ProtectProc=invisible`, and `ProcSubset=pid`:

```ini
[Unit]
Description=T3 Code Default Team Runner (t3runner)
After=network-online.target t3hub.service

[Service]
Type=simple
User=t3runner
Group=t3runner
Environment=T3CODE_HOME=/var/lib/t3runner
Environment=T3CODE_TEAM_BWRAP_SANDBOX=1
ExecStart=/usr/local/bin/t3 serve --team-bwrap-sandbox --host 127.0.0.1 --port 3774 --base-dir /var/lib/t3runner
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectProc=invisible
ProcSubset=pid
InaccessiblePaths=/var/lib/t3hub

[Install]
WantedBy=multi-user.target
```

Reload and restart `t3runner`:

```bash
sudo systemctl daemon-reload
sudo systemctl restart t3runner
sudo systemctl status t3runner --no-pager
```

> **Note on shared-daemon providers:** Providers that run a single shared background server across workspaces (`cursor`, `opencode`) fail closed when `--team-bwrap-sandbox` is enabled. Per-worktree providers (`claudeAgent`, `codex`, `antigravity`/ACP, `pi`, `muse`) and runner shell terminals all run inside per-thread `bwrap` sandboxes. For trust-tier isolation across different team roles, you can also run separate runner OS users (for example `t3runner-default` and `t3runner-admin`) gated by `team_environments` ACLs.

### 5.3 Verify Layer 2 Hardening

1. **Verify runner advertises `capabilities.teamBwrapSandbox === true`:**

   ```bash
   curl -s http://127.0.0.1:3774/.well-known/t3/environment \
     | jq '{environmentId, teamHubOnly: .capabilities.teamHubOnly, teamBwrapSandbox: .capabilities.teamBwrapSandbox}'
   # Expected: { ..., "teamBwrapSandbox": true }
   ```

2. **Verify `/proc` `hidepid=2` hides `t3hub` and other users' processes from `t3runner`:**

   ```bash
   sudo -u t3runner sh -c 'ps -eo user,pid,comm | grep -E "t3hub|sshd|root"' || echo "Foreign processes hidden (OK)"
   ```

3. **Verify sibling worktrees, sibling processes, `/var/lib/t3hub`, and `/var/lib/t3runner/userdata` are inaccessible from inside a sandboxed turn:**

   Run the following checks inside a sandboxed runner terminal or agent turn in worktree `wt-alice` (while another worktree `wt-bob` exists in `/srv/t3-workspaces/wt-bob` or `/var/lib/t3runner/worktrees/...`):

   ```bash
   # 1. Sibling worktree is invisible (No such file or directory):
   ls -la /srv/t3-workspaces/wt-bob
   # Expected: ls: cannot access '/srv/t3-workspaces/wt-bob': No such file or directory

   # 2. PID namespace isolation (only this sandbox's own processes appear, starting at PID 1/2):
   ps -ef
   # Expected: only the sandboxed shell/agent and `ps`, no sibling turns or host daemons

   # 3. Control plane (/var/lib/t3hub) is inaccessible:
   ls -la /var/lib/t3hub
   # Expected: No such file or directory (or Permission denied)

   # 4. Runner userdata (statev2.sqlite, ServerSecretStore) is inaccessible:
   ls -la /var/lib/t3runner/userdata/statev2.sqlite /var/lib/t3runner/userdata/secrets
   # Expected: No such file or directory
   ```

4. **Verify fail-closed startup when `bwrap` is unavailable:**

   ```bash
   sudo -u t3runner env PATH=/nonexistent T3CODE_TEAM_BWRAP_SANDBOX=1 \
     /usr/local/bin/t3 serve --host 127.0.0.1 --port 0 --base-dir /tmp/t3-bwrap-check
   # Expected: exits non-zero with "Linux bwrap sandbox unavailable [binary_not_found]"
   ```
