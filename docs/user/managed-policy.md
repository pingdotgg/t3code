# Managed policy

A managed policy lets an administrator set defaults, lock settings, and restrict capabilities (such as maximum permission mode, allowed providers, or remote access) for every user on a machine. The Hyakki server enforces the policy for all connected clients (desktop, web, and mobile).

## Roll out a policy

1. Author a JSON policy (see [Write a policy](#write-a-policy)). Do **not** include secrets—all local users can read the policy.
2. Validate it: `hyakki policy check policy.json`.
3. Deploy via MDM/GPO or a file to [one supported location](#where-the-policy-goes).
4. Restart Hyakki on the machine (policies load at startup only).
5. Verify with `hyakki policy show`.

## Write a policy

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://it.example.com/t3",
  "settings": {
    "defaultRuntimeMode": { "value": "approval-required", "locked": false },
    "enableAgentBrowserAccess": { "value": false, "locked": true }
  },
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["desktop", "local-browser"],
    "telemetry": false
  }
}
```

`schemaVersion` and `organization` are required. Locked controls display your organization name and optional `supportUrl` in Settings.

## Where the policy goes

Use **one** source per machine (having both a native policy and a policy file prevents Hyakki from starting):

| OS          | Native policy                                                                     | Policy file (admin-writable only)                 |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| **macOS**   | Device configuration profile for `dev.ryoku.hyakki`                               | `/Library/Application Support/T3Code/policy.json` |
| **Windows** | GPO template or `Policy` (`REG_SZ`) under `HKLM\SOFTWARE\Policies\T3Tools\T3Code` | `C:\Program Files\T3Code\policy.json`             |
| **Linux**   | —                                                                                 | `/etc/t3code/policy.json`                         |

- **macOS profile**: Generate `macos/t3code.mobileconfig` with `hyakki policy templates <dir> --policy policy.json` (or `plutil -convert xml1 -o dev.ryoku.hyakki.plist policy.json`). Deploy as a single device profile (profiles cannot represent `null`; use a policy file if needed).
- **Windows GPO**: Generate `windows/t3code.admx` and `windows/en-US/t3code.adml` with `hyakki policy templates <dir>`, import into `PolicyDefinitions`/Intune under **Computer Configuration → Administrative Templates → Hyakki**, set **Organization**, run `gpupdate /target:computer /force`, and restart Hyakki.
- **Windows registry**: Set `Policy` (`REG_SZ`) to single-line JSON (do not mix with GPO template values).

## Check what the server loaded

Run `hyakki policy show` as the user running Hyakki to inspect the installed policy, fingerprint, and whether the running server has loaded it. After any policy change or removal, restart the desktop app or run `hyakki service restart`. Removing a policy restores the user's own saved settings.

> Note: Hyakki **refuses to start** if a policy is unreadable, invalid, uses unknown keys from a newer version, or conflicts with another policy source. Always validate with `hyakki policy check` and upgrade Hyakki before deploying newer keys.

## Settings

Run `hyakki policy settings` to list every manageable path from `settings.json` and its default.

- `"locked": false` sets a default (users can override).
- `"locked": true` enforces the value across Settings and project overrides.

Key constraints:

- Lock `worktreeCleanup` together with `storageCleanup` worktree rules.
- `observability` (OTLP endpoints) cannot be managed by policy.
- Manage `idleCompaction` (not legacy `compactIdleThreads`).
- Lock `providerInstances.<id>` as a whole, or pin per-driver fields under [`limits.providers.instances`](#providers).

## Limits

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["desktop"],
    "connect": false,
    "webhookTasks": false,
    "browserCookieImport": false,
    "previewTunnel": false,
    "worktreeLayoutCommands": false,
    "telemetry": false,
    "providers": {
      "allowedDrivers": ["claudeAgent", "codex"],
      "instances": {
        "claudeAgent": {
          "locked": true,
          "environment": [{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" }]
        }
      }
    },
    "updates": { "mode": "auto", "feedUrl": "https://updates.example.com/t3code/" }
  }
}
```

### Permission modes

`maxRuntimeMode` caps all threads (`approval-required`, `auto-accept-edits`, `auto`, or `full-access`). Threads above the cap cannot run until lowered.

When `maxRuntimeMode` is set, users cannot modify provider launch settings (`binaryPath`, `launchArgs`, config home, or env vars)—pin required values (including absolute `binaryPath`s so user `PATH` entries can't shadow them) in `providers.instances`. Leave `acpRegistry` out of `allowedDrivers` if you don't want users adding arbitrary ACP Registry agents.

### Clients and Hyakki Connect

`clients` allows any subset of `desktop`, `local-browser`, and `remote` (keep `desktop` on desktop machines).

- Omitting `remote` restricts the server to loopback, revokes paired devices, disables LAN/Tailscale Serve/Hyakki Connect, and refuses startup if a Tailscale Serve route still forwards to Hyakki (or if a legacy service has LAN enabled—run `hyakki up --no-lan`).
- Set `"connect": false` to disable Hyakki Connect while allowing LAN/Tailscale remote access.

### Other capabilities

- `webhookTasks: false`: Disables scheduled-task and workflow webhooks.
- `browserCookieImport: false`: Disables importing cookies from other browsers.
- `previewTunnel: false`: Disables remote `localhost` tunneling and port forwarding (streams tabs instead).
- `worktreeLayoutCommands: false`: Disables `t3.json` `worktreeLayout` `create`/`remove` commands.
- `telemetry: false`: Disables product usage data and relay tracing for the server, desktop app, and server-opened browsers (does not control `hyakki.ryoku.dev` or mobile).

### Providers

- `providers.allowedDrivers`: Whitelist of driver IDs (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`, `fx`, `kiro`, `pi`, `muse`, `acpRegistry`).
- `providers.instances`: Sets or locks (`"locked": true`) fields across all instances of a driver (e.g., Bedrock/gateway env vars, `binaryPath`, `launchArgs`). Locking `codex` (or using `maxRuntimeMode`) disables ChatGPT-managed Codex; locking `opencode` disables external `serverUrl`.

### Updates

- `mode`: `"auto"` or `"off"` (when updates are managed externally).
- `feedUrl`: Custom update mirror matching GitHub Release layout (`latest*.yml` and installers at root; `t3-*` archives and `SHA256SUMS` under `v<version>/`).
- `allowNightly: false`: Disables the nightly channel.

## What a policy does not cover

- **Provider CLIs**: Restrict underlying CLIs with their own managed settings (e.g., Claude Code managed settings).
- **WSL**: Managed Windows desktop disables its WSL environment; a server started manually inside WSL reads `/etc/t3code/policy.json` in that distro.
- **Local admins / port forwarding**: Administrators can modify policies or Hyakki binaries, and users can still port-forward loopback sockets with external tools. Use OS/MDM controls for binary integrity and network isolation.
