# Managed policy

A managed policy lets an administrator configure T3 Code for every user on a machine. It sets
defaults and locks for settings, and limits such as the broadest permission mode or which
providers may run. The T3 Code server on the machine enforces it for every app that connects:
the desktop app, a browser, or the mobile app.

## Roll out a policy

1. Write the policy as JSON, starting from the [example](#write-a-policy). Do this even if you
   deploy through Group Policy, so you can check the values first.
2. Run `t3 policy check policy.json`. It prints what the policy will do, or what is wrong with it.
3. Deploy the policy to each machine with your device management tool, in
   [one of the supported places](#where-the-policy-goes).
4. Restart T3 Code on the machine. The server reads the policy only when it starts.
5. Run `t3 policy show` on the machine to see the policy T3 Code found there.

The desktop app includes the `t3` command; see [The `t3` command](./install.md#the-t3-command).

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

`schemaVersion` and `organization` are required. Users see the organization's name in Settings
and beside each control the policy locks, with a link to `supportUrl` if you set one. [`settings`](#settings)
sets defaults and locks, and [`limits`](#limits) restricts what T3 Code may do.

Every user on the machine can read the policy, so do not put credentials in it.

## Where the policy goes

Use one of these per machine:

| OS      | Native policy                                  | Policy file                                       |
| ------- | ---------------------------------------------- | ------------------------------------------------- |
| macOS   | Configuration profile for `com.t3tools.t3code` | `/Library/Application Support/T3Code/policy.json` |
| Windows | Group Policy, from the T3 Code template        | `C:\ProgramData\T3Code\policy.json`               |
| Linux   |                                                | `/etc/t3code/policy.json`                         |

T3 Code does not merge sources. If a machine has both a native policy and a policy file, T3 Code
refuses to start until you remove one.

`t3 policy templates <directory>` writes the Windows Group Policy template
(`windows/t3code.admx` and `windows/en-US/t3code.adml`) and a macOS configuration profile
(`macos/t3code.mobileconfig`). Add `--policy policy.json` to put your policy in the macOS profile;
without it, the profile holds a sample policy for "Example Corp". The Windows template is the same
either way, and you choose its values in Group Policy.

### Policy file

Copy the JSON to the path for the OS. Make it writable only by administrators.

### macOS configuration profile

Upload `macos/t3code.mobileconfig` to your device management tool, or build a custom settings
payload for the preference domain `com.t3tools.t3code`. The payload's keys are the policy's
top-level keys (`schemaVersion`, `organization`, `supportUrl`, `settings`, `limits`); JSON objects
become dictionaries and lists become arrays. Install it as a device profile, since T3 Code ignores
user profiles, and deploy only one profile for this domain. A profile cannot hold `null`, so `t3 policy templates` refuses a policy with a
`null` value; deploy that policy as a file instead.

### Windows Group Policy

Copy `t3code.admx` into a `PolicyDefinitions` folder and `t3code.adml` into its `en-US`
subfolder. That is `C:\Windows\PolicyDefinitions` for local policy, or the
[central store](https://learn.microsoft.com/en-us/troubleshoot/windows-client/group-policy/create-and-manage-central-store)
for a domain. For Intune,
[import the template](https://learn.microsoft.com/en-us/intune/device-configuration/settings-catalog/import-custom-admx-templates).
The policies appear under **Computer Configuration > Administrative Templates > T3 Code**.

Set **Organization** whenever you set any other T3 Code policy. Without it, T3 Code refuses to
start.

**Disabled** means different things for the two kinds of policy:

- **Allowed clients**, **Allowed providers**, **Broadest permission mode**, and **Updates** restrict
  only when Enabled. Disabled and Not configured both mean no restriction. To stop updates, enable
  **Updates** and choose **Off**.
- **Allow T3 Connect**, **Allow webhook tasks**, **Allow importing browser cookies**, and **Allow
  usage data** block the capability when Disabled. Enabled and Not configured leave it allowed.

**Managed settings (JSON)** takes the same object as a policy's [`settings`](#settings), and
**Provider settings (JSON)** takes the same object as
[`limits.providers.instances`](#providers). Enter each as one line of JSON. To validate them, put
them in a policy file and run `t3 policy check` on it.

T3 Code reads Group Policy through Windows PowerShell at
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` each time it starts, on every Windows
machine, whether or not a policy is set. Constrained Language mode, which AppLocker and WDAC
script rules turn on, is fine. If a rule blocks `powershell.exe` itself for the users who run
T3 Code, T3 Code refuses to start with "the registry cannot be read", so allow it for them.

## Change or remove a policy

After you deploy, change, or remove a policy, restart the T3 Code server on the machine: quit and
reopen the desktop app, or run `t3 service restart` for the
[background service](./background-service.md). Reconnecting a phone or browser does not reload the
policy. Run `t3 policy show` to confirm what applies.

To remove a policy, delete the file or remove the profile. For Group Policy, set every T3 Code
policy back to **Not configured** and refresh Group Policy, for example with `gpupdate /force`.
Deleting the template files does not remove a policy that already applies. Then restart the
server. T3 Code never writes policy values into the user's own settings, so users get back the
settings they had chosen.

## When T3 Code refuses to start

T3 Code refuses to start rather than run with a policy it cannot fully enforce. That includes a
policy it cannot read or parse, a setting it does not know, a value of the wrong type, a key this
version does not support, Group Policy without **Organization**, a Windows machine where T3 Code
cannot run [Windows PowerShell](#windows-group-policy), or a machine with both a native policy and
a file. The error names where the policy came from and what is wrong.

`t3 policy check` catches the same problems in a JSON file. For a profile or Group Policy, check
the same policy as a file first. A policy written for a newer version can use keys an older one
cannot enforce, so upgrade T3 Code before you deploy a policy that uses them.

## Settings

Each key under `settings` is a setting's path in the server's `settings.json`, such as
`storageCleanup.logsAfterDays`. To find a path, change the setting in T3 Code and look in
`settings.json` under `~/.t3/userdata`.

- `"locked": false` sets a default. It applies wherever the user has not chosen a value of their
  own, and users can change it.
- `"locked": true` sets the value. Users and agents cannot change it, in Settings or in a project's
  settings, and Settings shows the control as managed by your organization. Removing the policy
  brings back the user's own value.

A few settings need care:

- A default cannot add an entry, such as a provider instance, because users could never remove it.
  Lock the entry instead, or set provider fields with [`providers.instances`](#providers).
- A setting that can be empty, such as `defaultModelSelection`, is managed as a whole. You cannot
  manage one field inside it.
- `defaultRuntimeMode` cannot be broader than [`maxRuntimeMode`](#permission-modes).

## Limits

`limits` restricts what T3 Code may do. Leave a key out to keep T3 Code's normal behavior.

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

`maxRuntimeMode` is the broadest [permission mode](./permission-modes.md) any thread may use:
`approval-required` (Supervised), `auto-accept-edits`, `auto`, or `full-access`. It covers threads
that users start, agents start, and scheduled tasks start. A thread already above the limit cannot
run another turn until someone lowers its mode; its queued messages send once that happens. New
threads start at the limit when the user's default is above it.

With `maxRuntimeMode` set, you own each provider's launch settings: binary path, launch arguments,
config home, and every environment variable. They come from
[`providers.instances`](#providers) or T3 Code's defaults, and users cannot change them, because a
wrapper script, a launch flag, or a variable such as `NODE_OPTIONS` could otherwise turn off the
provider's approvals. Pin the variables your users need, such as a gateway URL, in
`providers.instances`.

The limit decides which modes T3 Code asks the provider for. It is not a sandbox. Providers still
read their own configuration from the user's home directory, such as `~/.claude` and `~/.codex`,
and users can run the provider's CLI outside T3 Code. See
[What a policy does not cover](#what-a-policy-does-not-cover).

### Clients and T3 Connect

`clients` lists what may connect to the server:

- `desktop`: the desktop app on this machine.
- `local-browser`: a browser on this machine.
- `remote`: phones, other computers, app.t3.codes, and anything else over the network.

Without `remote`, the server listens only on this machine, creates no pairing links, and signs out
devices that paired earlier. That also turns off T3 Connect. To keep other remote access but turn
off T3 Connect alone, set `"connect": false`.

### Other capabilities

- `webhookTasks: false`: scheduled tasks cannot use webhook triggers. Existing webhook tasks stay
  but do not run.
- `browserCookieImport: false`: users cannot import cookies from another browser into T3 Code's
  browser.
- `telemetry: false`: T3 Code sends no [product usage data](./telemetry.md) or relay connection
  traces, whatever the environment says. `true` cannot turn them on for a user who turned them off.

### Providers

`providers.allowedDrivers` lists the providers that may run, by ID: `codex` (Codex),
`claudeAgent` (Claude), `cursor` (Cursor), `grok` (Grok), `opencode` (OpenCode), `antigravity`
(Antigravity), `fx` (fx), `pi` (Pi), `muse` (Muse Code), and `acpRegistry` (ACP Registry).
`t3 policy check` rejects an ID this version does not know. Threads on other providers stay,
marked unavailable, and users can still turn those providers off.

`providers.instances` sets fields on every instance of a provider, such as an environment variable
that routes Claude through Amazon Bedrock or a base URL for a company gateway. `binaryPath` and
`launchArgs` work only for providers that have those settings. With `"locked": true`, users cannot
change the fields you set. With `"locked": false`, the fields fill in only what the user left
empty. A locked Codex instance, or any Codex instance under `maxRuntimeMode`, also rules out
[Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), since that runtime would skip
your fields.

### Updates

- `mode`: `auto` keeps the normal update flow. `off` stops T3 Code from checking for updates, for
  machines that get T3 Code through device management.
- `feedUrl`: the desktop app updates from your own mirror of the release feed instead of GitHub.
  Publish only the versions you have approved. The `t3` command-line server updates through npm,
  so pin it with your package tooling.
- `allowNightly: false`: the nightly channel is unavailable.

## What a policy does not cover

The policy controls what T3 Code does. Agents run through each provider's own CLI, which a user
can also run outside T3 Code. To restrict those CLIs, use their own managed configuration, such as
Claude Code's managed settings.

On Windows, a T3 Code server running inside WSL reads `/etc/t3code/policy.json` in that distro,
not the Windows policy. Deploy the policy file there too if your users run T3 Code in WSL.

A user with administrator rights on the machine can edit or remove the policy. T3 Code enforces
the policy in its own processes, which run as the user, so it stops users from changing managed
settings in T3 Code but does not stop a user who modifies or replaces T3 Code itself.
