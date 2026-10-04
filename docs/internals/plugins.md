# Plugins

A plugin is a directory with a [`t3-plugin.json`](../../packages/contracts/src/plugin.ts) manifest and a JavaScript entry. Each environment's server runs its own plugins, one supervised child process per plugin, from [apps/server/src/plugins](../../apps/server/src/plugins/). The catalogue contract is [pluginCatalog.ts](../../packages/contracts/src/pluginCatalog.ts). Views have their own constraints: see [plugin views](./plugin-views.md). Working examples live in [examples/plugins](../../examples/plugins/).

## Trust model

- Plugins are trusted code running as the server's OS user. The child process is an availability boundary, not a sandbox: heap limits, call deadlines, IPC bounds and backoff protect the server's event loop and memory, not the user's files, network or credentials. Never describe plugins as sandboxed.
- Capabilities gate which host APIs and contributions the server offers a plugin. They do not limit what plugin code can do on the machine, so a capability is a statement of intent the user consents to, not a permission check on the code.
- Consent binds the exact bytes: a digest of every regular file in the directory, hidden files included, with symbolic links refused. `version` is display text and is never compared. The catalogue re-checks the bytes on add, refresh, consent, enable, server start and before any cold start. A mismatch disables the plugin until the user approves the new bytes; nothing re-enables automatically.
- The digest is an inspected-tree policy, not executed-artifact identity. The directory stays writable by its owner, and code loaded from outside the directory is not covered. Present it as "what you approved", never as integrity against the directory's owner. A plugin that writes into its own directory disables itself, so plugin state belongs in `storage` or outside the directory.
- Contributions are declared statically in the manifest (tools, actions, settings, views, transforms), never registered at `activate`. That keeps them under consent, lets every client show them without a running plugin, and keeps the rule that zero enabled or zero used plugins means zero processes. Listing, rendering and configuring never start a plugin; only a call does. A new contribution kind follows the same shape: a manifest field validated by [PluginManifestLoader.ts](../../apps/server/src/plugins/PluginManifestLoader.ts) and a forward-compatible field on the catalogue summary.
- A server refuses a plugin that declares a capability it does not implement, so an older server never runs a plugin without a feature it needs. A new plugin requirement is a new capability name, not a `PLUGIN_API_VERSION` bump. Consumers also check that `consent.capabilities` includes their capability.

## Gating

- Every plugin request a client sends is gated on the capability flag of the session it is sent on (`plugins`, `pluginSettings`, `pluginActions`, `pluginViews`, `pluginNotifications`, `pluginNpm`). Check it on that session's own config at send time, as [`requestIfSupported`](../../packages/client-runtime/src/rpc/client.ts) does. A cached config or a capability seen before a reconnect to an older server is not enough, and a missing flag means send nothing.
- A missing `hostState` or `eventDelivery` decodes as unknown. Never render it as idle, healthy or permission to act.
- Management needs `access:write`, which standard pairings cannot hold. Reads need `orchestration:read`; running actions and view calls needs `orchestration:operate`.
- Agents reach plugin tools through two fixed MCP tools. A provider session holds the grants taken when its MCP credential was prepared, and every list and call intersects them with the live catalogue.

## Reserved names

- Plugin handler names starting with `t3.` belong to the host. The [child runtime](../../apps/server/src/plugins/pluginHostChild.ts) refuses an author registration under `t3.` except the `t3.tool.` prefix and the exact names `t3.transform.enrich` and `t3.approval.decide`, which the `transforms` and `approvals` capabilities ask plugins to register. Every other `t3.` name is refused; `t3.events` is registered by `onEvent`, not by authors. The prefixes `action:` and `view:` belong to the actions and views capabilities.
- Calls cross IPC in two directions. Host-to-plugin handlers (the names above) run through [`PluginCatalog.invoke`](../../apps/server/src/plugins/PluginCatalog.ts), which calls the supervisor's `invoke`. Plugin-to-host `HostCall` methods use prefixes owned by one capability each (`settings.`, `storage.`, `status.`, `notifications.`) and are answered by handlers registered with [`PluginSupervisor.serveHostMethod`](../../apps/server/src/plugins/PluginSupervisor.ts). A new host-called handler takes an exact reserved `t3.` name allowed in the child's guard; a new host method takes a new reserved prefix. Neither needs a new IPC message.

## Revocation

- A plugin is referenced by `(environment, installationId)` plus a generation. The generation is the revocation epoch: disable, remove, a byte change and a re-enable each end it. Anything issued under a generation (tool grants, action ids, view mounts, host calls, statuses, notifications) is refused or torn down when it ends, and is never redirected to a replacement with the same plugin id. Calls go through `PluginCatalog.invoke` with the generation they were issued for.
- Disable saves `enabled: false` first, then revokes in one synchronous step, then waits for the process to exit, so an interrupted disable never comes back enabled. Statuses and notifications belong to the process and disappear with it. Settings and storage belong to the installation: they survive disable and are deleted by remove.
- Quarantine, `incompatible`, and quarantined event delivery never lift by themselves. `plugins.resume` is the way out. It needs `access:write`, so every client that shows those states must offer it to an administrative session and point other sessions to one.
