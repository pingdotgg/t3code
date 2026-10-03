# Sandboxes

A sandbox is one long-running Docker container per worktree. See
[`SandboxService`](../../apps/server/src/sandbox/SandboxService.ts) and the
[user guide](../user/sandboxes.md).

## The provider CLI runs inside

The point of a sandbox is separate ports and services, which only works if the commands an agent
runs share the container's network. Providers have no reliable hook to redirect their shell
commands, so the whole CLI runs in the container: Claude through the SDK's
`spawnClaudeCodeProcess`, Codex by wrapping the app-server command, and terminals by opening
`bash` with `docker exec -it`. The setup script runs in a terminal, so it follows. Other adapters
fail in `ProviderSessionManager` rather than run on the host unnoticed.

A process runs where it was opened, so a shared provider session (Codex serves every thread of an
instance from one app-server) is scoped per sandbox. The Orchestrator picks the session id from the
thread's current worktree each time a run starts, because a launch records one before the
worktree and sandbox exist. When a sandbox stops or is removed, `ProviderSessionManager` releases
the sessions that ran in it, so the next turn opens a fresh one and restarts the container.

The image installs Claude Code and Codex at the host's versions. Host binaries can be macOS
builds, so they are never mounted.

## Same paths inside and out

The worktree, the repository's git dir, `~/.claude`, `~/.codex`, `~/.gitconfig`, the attachments
folder, and the project checkout (read-only, for setup scripts) mount at their host paths, and the image user has the host's uid, gid, and home
path. T3 keeps reading worktree files, Claude session files, and git state on the host without any
path translation. `~/.claude.json` is copied in, not mounted, because Claude replaces it by rename,
which fails on a bind-mounted file.

## One relay, no published ports

Container IPs are not routable on Docker Desktop, and a server bound to `127.0.0.1` is not
reachable from a Linux bridge network. [`SandboxTunnel`](../../apps/server/src/sandbox/SandboxTunnel.ts)
avoids both: a Node relay runs under `docker exec -i` and multiplexes TCP over its stdio. It
forwards every port that starts listening in the container to a host loopback port, and listens
on T3's own port inside the container so the unchanged `127.0.0.1` MCP URL reaches the host.

## Killing `docker exec` kills nothing

Killing a `docker exec` client leaves its process running in the container. Every sandboxed
command starts through a launcher that records its PID, and each spawn site calls `release` when
its process exits or is killed. Each exec leads its own session, so `release` kills the whole
session, including children whose parent already exited. The first use after a server restart
kills everything an earlier server process left behind.

## Codex's own sandbox is off

Codex's bubblewrap sandbox cannot create namespaces in an unprivileged container. Sandboxed turns
send `dangerFullAccess` and keep the runtime mode's approval policy.

## Fail closed

A worktree is registered and saved as sandboxed before the image build, and stays registered when
provisioning fails, so a terminal or turn waits or fails instead of running on the host. A
sandboxed worktree whose container is missing gets a new one. Containers carry labels with their
worktree, CLI versions, and an owner hash of the server's state directory, so a lost or unreadable
list is rebuilt from the containers this server owns. Each sandboxed worktree also keeps its record
in `t3code-sandbox.json` in its git admin folder, so a lookup can rebuild the sandbox from the
worktree itself even when both the list and its container are gone. Entries for deleted worktrees
are dropped at startup.
