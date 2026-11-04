---
title: "Managed policy for teams"
description: "Configure T3 Code managed policy for a team, validate and deploy machine rules, cap permissions, and confirm the running server loaded your changes."
updated: 2026-11-04
sources:
  - label: "Managed policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md"
  - label: "Background service"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
  - label: "Product usage data"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Service installation defaults"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/service.ts"
  - label: "Service network configuration"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/config.ts"
faq:
  - question: "Where does T3 Code managed policy go?"
    answer: "T3 Code supports machine policy through a macOS device profile, Windows Group Policy or registry, or an OS-specific policy file. Linux uses /etc/t3code/policy.json."
  - question: "Does T3 Code managed policy apply to mobile clients?"
    answer: "T3 Code enforces machine policy on the environment server. It applies to desktop, browser, and mobile clients that connect to that server."
  - question: "Does T3 Code reload policy without restarting?"
    answer: "T3 Code reads managed policy when the server starts. Run t3 policy show to compare the installed policy with what the running server loaded."
  - question: "Is T3 Code managed policy a sandbox?"
    answer: "T3 Code managed policy restricts T3 Code behavior and requested provider modes. It does not sandbox provider CLIs or stop an administrator from replacing the app or removing policy."
---

T3 Code managed policy lets administrators set defaults, lock settings, and restrict capabilities for every user on a machine. The environment server enforces the policy for desktop, browser, and mobile clients that connect to it. Validate a policy before deployment, restart the server, and confirm the loaded policy on the host.

## Decide which team rules need enforcement

Use an unlocked setting for an organizational default that users may change. Use a locked setting when users and agents must keep its value, including in project settings. Use `limits` to restrict capabilities such as providers, permission modes, remote access, or telemetry.

| Policy choice                     | Effect                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| `settings` with `locked: false`   | Supplies a default where the user has not chosen a value     |
| `settings` with `locked: true`    | Enforces a value and marks its control as managed            |
| `limits.maxRuntimeMode`           | Caps permissions for user, agent, and scheduled-task threads |
| `limits.providers.allowedDrivers` | Allows only the named provider drivers                       |
| `limits.telemetry: false`         | Disables server and desktop product events and relay traces  |

Use [project settings](/learn/customize/project-settings) for project choices that do not require machine enforcement. Policy values do not overwrite a user's saved choices. Removing policy restores those choices after a server restart.

## Validate a policy before deploying it

This example sets a Supervised default, caps modes at Auto-accept edits, and disables usage data. It leaves users free to change the default within the cap.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "settings": {
    "defaultRuntimeMode": {
      "value": "approval-required",
      "locked": false
    }
  },
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "telemetry": false
  }
}
```

1. Save the JSON as `policy.json`.
2. Run `t3 policy check policy.json` and inspect the interpreted rules or errors.
3. Deploy one supported machine policy source through your device management tool.
4. Restart the T3 Code server.
5. Run `t3 policy show` as the user who runs T3 Code.

The required fields are `schemaVersion` and `organization`. An optional `supportUrl` gives users a support link beside managed controls. Every user can read policy, so keep credentials out of it.

## Choose one policy source per machine

| OS      | Native option                                                                                | Policy file                                       |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| macOS   | Device configuration profile for `com.t3tools.t3code`                                        | `/Library/Application Support/T3Code/policy.json` |
| Windows | Group Policy or a `Policy` JSON registry value under `HKLM\SOFTWARE\Policies\T3Tools\T3Code` | `C:\Program Files\T3Code\policy.json`             |
| Linux   | Policy file                                                                                  | `/etc/t3code/policy.json`                         |

Make the file and its parent folder writable only by administrators. T3 Code does not merge native policy with a policy file. Deploying both prevents startup until one is removed.

Generate deployment artifacts with `t3 policy templates <directory>`. Add `--policy policy.json` to generate a complete macOS profile from validated JSON. macOS requires a device profile; user profiles are ignored. Windows templates belong under Computer Configuration. Set **Organization** whenever another T3 Code policy is configured.

For Windows, choose either the whole `Policy` registry value or template settings. Combining them also prevents startup. If users run a server inside WSL, deploy Linux policy inside that distribution separately.

## Cap permissions without leaving launch settings open

`maxRuntimeMode` accepts `approval-required`, `auto-accept-edits`, `auto`, or `full-access`. These map to the [four permission modes](/learn/safety/permission-modes). Existing threads above the limit cannot run another turn until their mode is lowered. Queued messages wait for that change.

Setting a cap also places provider launch settings under administrator control. Configure required environment variables through `providers.instances`. Pin an absolute `binaryPath` for each allowed provider that supports it. A name such as `claude` still resolves through the startup environment's `PATH`, which users can influence.

The cap controls which mode T3 Code requests from a provider. Provider configuration still matters. ACP Registry agents also warrant a separate decision: exclude `acpRegistry` from allowed drivers if users must not choose those agents.

## Restrict remote access and diagnostics

Without `remote` in `limits.clients`, the server uses loopback, creates no pairing links, and signs out previously paired devices. Keep `desktop` allowed on hosts that need the desktop app. To allow other remote routes while disabling T3 Connect alone, use `connect: false`.

For a background service, check its bind address and set `T3CODE_HOST=127.0.0.1` in `service.env` when enforcing local-only access. Then restart the [background service](/learn/safety/background-service). New service installations default to local-only access. Older services can retain LAN exposure.

`telemetry: false` disables product events and server or desktop relay traces. It cannot force collection on. A browser can still send its own relay traces, so review the [usage data guide](/learn/safety/product-usage-data) for surface-specific controls.

## Diagnose a policy that did not apply

`t3 policy show` prints the installed policy and its fingerprint. It also says whether the running server loaded that policy or an older one. Reconnecting a phone or browser does not reload policy.

T3 Code refuses startup for unreadable, malformed, conflicting, unsupported, or unenforceable policy. Validate against the version you plan to run. Upgrade older builds before deploying keys they do not recognize.

Policy governs T3 Code, not separately launched provider CLIs. Use provider-managed configuration and device application controls where required. Administrators can remove policy, and users can forward a loopback port with other tools. Read [security and privacy](/learn/safety/security-and-privacy) when defining that wider boundary.

## Next steps

Review [permissions and privacy](/learn/safety) with your host and provider requirements. Test the policy on a representative machine before rolling it out to the remaining hosts.
