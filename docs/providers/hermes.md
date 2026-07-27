# Hermes

T3 Code runs Hermes as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent.
Hermes remains a provider in **Settings → Providers** because it is the agent runtime that owns
sessions, tools, and model-provider credentials. The model picker is populated from the models Hermes
advertises over ACP, and T3 Code forwards model, runtime-mode, and supported option changes to the
active Hermes session.

T3 Code does not connect to the Hermes gateway HTTP API. A gateway URL and API-server secret are
therefore not Hermes provider settings. They authenticate the OpenAI-compatible HTTP surface, not the
stdio ACP process that T3 Code hosts.

## Installation

Install and configure Hermes using its normal setup flow:

```bash
hermes setup
hermes acp --check
```

Then enable Hermes in T3 Code. Leave **Binary path** as `hermes`, or enter the absolute path to the
Hermes executable.

### Hermes plugin installation

The T3 Code repository is also a Hermes plugin. Installing the repository root keeps Hermes' native
Git-based plugin updater working:

```bash
hermes plugins install totalolage/t3code --enable
```

Restart the Hermes dashboard after the first install so it mounts the plugin's backend routes, then
open the **T3 Code** tab. **Install and start** downloads the newest compatible standalone release,
verifies its adjacent SHA-256 asset, and asks T3 Code to install its own s6 service at
`/run/service/t3code`. The current release workflow publishes this companion binary for Linux x64;
ARM64 Hermes hosts are rejected until a Linux ARM64 standalone artifact is available.

The service listens on port `3773` by default. The plugin exposes that address from its Hermes
dashboard tab and does not proxy T3 Code traffic through the Hermes dashboard API. Hermes plugin
manifests do not control the container runtime's host-port mappings, so publish the port once in the
container configuration:

```yaml
ports:
  - "3773:3773"
```

Configuration overrides are environment variables:

- `T3CODE_HERMES_PORT` and `T3CODE_HERMES_HOST`
- `T3CODE_HERMES_SERVICE_USER` and `T3CODE_HERMES_SERVICE_GROUP` for custom root-run containers
- `T3CODE_HERMES_PUBLIC_URL` when the browser-facing URL cannot be derived from the dashboard host
- `T3CODE_HERMES_REPOSITORY` for a release fork, in `owner/repository` form
- `T3CODE_HERMES_WATCH_INTERVAL_SECONDS` and `T3CODE_HERMES_WATCH_MISSES`

T3 Code uses its normal pairing flow on first launch. The initial pairing URL is written to
`$HERMES_HOME/t3code/data/userdata/logs/boot-service.log`.

Hermes and T3 Code update independently. `hermes plugins update t3code` updates the plugin source;
restart the dashboard when that update changes `plugin_api.py`. The dashboard tab's **Update**
button downloads and checksum-verifies the latest compatible T3 Code binary, then asks T3 Code to
rewrite and restart its own s6 service while preserving the configured host and port.

The companion watchdog checks for `plugin.yaml` every 15 minutes by default. Two consecutive misses
remove the T3 Code and watchdog s6 slots. This covers direct plugin-directory removal without making
uninstallation immediate. T3 Code data and the downloaded binary remain under
`$HERMES_HOME/t3code`; the dashboard's **Remove service** action likewise removes only supervision.

### Reboot recovery and desired state

The plugin records explicit service intent in
`$HERMES_HOME/t3code/service-state.json`. A successful **Install and start** or **Update** records
`installed` together with the installed binary's version and SHA-256 digest. **Remove service**
records `uninstalled` before it starts tearing down supervision; if that state cannot be persisted,
the removal is rejected without touching the s6 slots. The orphan-cleanup watchdog also records
`uninstalled` when it removes services after the plugin directory disappears.

Hermes imports enabled dashboard backends when the dashboard starts. At that point the T3 Code
backend starts a failure-isolated background reconciliation. If intent is `installed` but the
ephemeral `/run/service/t3code` or `/run/service/t3code-plugin-watchdog` slot is missing, it recreates
only the missing slot using the configured host, port, service user/group, `HERMES_HOME`, data
directory, and the existing service hardening. Reconciliation shares the lifecycle lock used by the
dashboard actions and the watchdog, leaves current running slots alone, starts complete stopped slots
without replacing their supervise tree, and will not rewrite a partial supervise tree. A running or
stopped T3 definition whose native environment marker does not contain the configured `HERMES_HOME`
is repaired once through the retained checksum-verified binary's local **Update** path. That refreshes
stale launchers without a release lookup; the repaired marker makes later reconciliation a no-op.
Native install, update, and start commands are not treated as proof that the service is running:
the plugin waits for the current slot to report the same positive service PID on consecutive checks.
If an obsolete deleted slot still owns the configured port, recovery terminates it only when `/proc`
proves one unambiguous match for the configured service UID, exact T3 command and executable, deleted
service working directory, listen socket, and root `s6-supervise` parent. Otherwise recovery fails
safely with an actionable status instead of touching an arbitrary port owner or reporting a false
repair. Watchdog updates reuse their existing scan slot, and removal hides the old scan name before
asking s6 to reap its supervisor, preventing two supervisors from acquiring the same service name.

Hermes pre-seeds each dynamic service's supervision skeleton with the ownership required by its
no-new-privileges container. After the native T3 service command writes an s6 run script, the plugin
atomically removes only its redundant top-level `s6-svperms ...` line while preserving the script's
mode and all other contents. Install, update, and boot recovery apply the same adaptation before the
service is expected to run. Non-root dashboard processes pass their passwd account name to T3 and
leave the service group implicit unless explicitly configured, matching `s6-setuidgid` semantics.

Boot recovery never checks GitHub or downloads a release. It re-hashes the already installed binary
against the digest recorded at install time before executing it. A missing, non-executable, changed, or
architecture-incompatible binary leaves the Hermes dashboard running; the plugin status reports
`reconciliation_status=failed` and an actionable `reconciliation_error`. Use **Install and start**
to download and verify a replacement.

Plugin versions predating this state file retained only the binary and application data, so a legacy
install is indistinguishable from one the operator intentionally removed. The plugin therefore never
infers intent from an old binary or executes it during migration. After upgrading an existing plugin,
click **Install and start** once to verify the retained or replacement release and establish explicit
durable intent. From then on, boot recovery is automatic and **Remove service** remains authoritative.

## Projects and execution

Hermes is not a T3 remote environment. T3 Code launches one ACP subprocess for the selected project,
and that subprocess performs tool work in the project directory.

For Hermes on another machine, expose an executable on the T3 server that transports stdio to
`hermes acp` on that machine, for example an SSH wrapper. The remote path must represent the same
project checkout that Hermes should edit; a Hermes gateway URL alone cannot provide that filesystem
and stdio contract.

## Conversations and model selection

New T3 Code threads create Hermes ACP sessions. T3 Code stores the opaque Hermes session ID and asks
Hermes to load it when a thread is reopened. T3 sends selected model changes through
`session/set_model`, maps T3 interaction modes to Hermes session modes, and forwards ACP tool and
approval events into the normal conversation timeline.

The models shown in T3 depend on the providers configured in Hermes. Add or authenticate another
underlying model provider with Hermes first; it can then advertise those models to T3 Code.

## Current limits

- A gateway HTTP URL and secret cannot be reused as ACP credentials.
- File attachments and thread rollback are not currently exposed by this integration.
