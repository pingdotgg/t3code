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
