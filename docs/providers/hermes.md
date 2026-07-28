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

The T3 Code repository is also a Hermes plugin. Install the repository root with Hermes:

```bash
hermes plugins install totalolage/t3code --enable
```

Restart the Hermes dashboard after the first install so it mounts the plugin's backend routes, then
open the **T3 Code** tab. **Install and start** resolves one T3/Hermes product release, advances the
plugin checkout and checksum-verified native runtime to that release together, activates the s6
service, and verifies the live process and HTTP endpoint. The current release workflow publishes the
companion binary for Linux x64; ARM64 Hermes hosts are rejected until a Linux ARM64 standalone
artifact is available.

There is one compatibility case when the loaded Hermes host does not yet implement managed backend
reloads. If the clean checkout's unchanged `HEAD`, the newest compatible release tag, and the
retained runtime's reported version and SHA-256 digest already identify the exact same product,
**Install and start** may activate that retained pair and persist its coherent state. It does not move
source or install a runtime. An older release, missing or mismatched runtime, dirty or moving
checkout, or incomplete Update recovery still fails before activation. This is not an alternate
Update path.

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

There is one T3 Code **Update** operation. It selects the newest release whose Git tag contains the
`t3code-hermes` product contract and whose GitHub release contains the matching native binary and
adjacent checksum. The release tag binds the plugin source commit and native runtime version into one
identity. Update stages and validates both before cutover, refuses a dirty checkout without changing
anything, checks out the exact release-tag commit in detached-HEAD mode while preserving the prior
commit and branch for rollback, runs activation in a fresh Python process from the new commit, and
reports success only after the new runtime owns the configured listener and passes supervisor,
process identity, service-account, `HERMES_HOME`, and HTTP health checks.

If activation or Hermes backend reload fails, Update resets the clean checkout to its prior commit,
restores the verified prior binary, regenerates the prior native service definition with that binary,
restores the watchdog and durable desired-state file, and reports whether rollback succeeded. It
also requires Hermes to remount and attest the prior backend before reporting rollback success.
Failed rollback retains the staged target and prior snapshot for operator recovery. It never edits
T3's generated environment marker by hand. Internal source/runtime diagnostics remain available,
but the dashboard displays only the coherent installed product version.

#### Required Hermes managed-update contract

Hermes currently exposes `hermes plugins update <name>` and the Plugins-page update action as a
generic `git pull --ff-only`, followed by metadata rescan. That operation neither delegates to the
plugin nor reloads Python routers already mounted in the dashboard process, so it can create the
source-only state this integration forbids.

The plugin declares `update.mode: managed` and `contract: t3code-hermes-v1`. Hermes core must add a
managed-plugin update contract that:

1. hides/delegates its generic Git update action for a managed plugin, including the CLI and dashboard
   API, so both invoke the plugin's single coherent Update operation;
2. exposes `hermes_cli.managed_plugin_update.get_managed_update_contract(name)` with version `1`,
   a mutation-free `preflight(plugin_name, plugin_root)`, and
   `complete(plugin_name, plugin_root, source_commit, product_version)`, and
   `rollback(plugin_name, plugin_root, source_commit, product_version)`; and
3. makes those handoffs reload or restart the dashboard through a host-owned coordinator that
   outlives the requesting dashboard process. Each response must attest the source commit and product
   version actually mounted, and return only after the requested backend is active. A metadata rescan
   or page reload is not sufficient.

Until Hermes supplies that contract, T3's Update operation and any Install that would change source
or runtime fail before product mutation. Only the exact-current Install adoption described above can
activate without reloading the already-loaded backend, because its verified source and runtime
identity do not change. T3 does not emulate the missing host primitive with a page reload, metadata
rescan, or unsafe self-restart.

The companion watchdog checks for `plugin.yaml` every 15 minutes by default. Two consecutive misses
remove the T3 Code and watchdog s6 slots. This covers direct plugin-directory removal without making
uninstallation immediate. T3 Code data and the downloaded binary remain under
`$HERMES_HOME/t3code`; the dashboard's **Remove service** action likewise removes only supervision.

### Reboot recovery and desired state

The plugin records explicit service intent in
`$HERMES_HOME/t3code/service-state.json`. A successful **Install and start** or **Update** records
`installed` together with the coherent product version, plugin source commit, installed binary
version, and SHA-256 digest. **Remove service**
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

Boot recovery never checks GitHub or downloads a release. It validates the local source commit,
re-hashes the already installed binary against the digest recorded at install time, and restores that
same coherent version. It is never an implicit upgrade. A mismatched source commit or a missing,
non-executable, changed, or architecture-incompatible binary leaves the Hermes dashboard running;
the plugin status reports
`reconciliation_status=failed` and an actionable `reconciliation_error`. Use **Install and start**
to download and verify a replacement.

Plugin versions predating this state file retained only the binary and application data, so a legacy
install is indistinguishable from one the operator intentionally removed. The plugin therefore never
infers intent from an old binary during boot. Run **Install and start** explicitly once to establish
a coherent product version and durable intent. Without the managed host contract, this succeeds only
when release resolution proves the clean current source and retained binary already are the newest
compatible pair. From then on, boot recovery is automatic and **Remove service** remains
authoritative.

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
