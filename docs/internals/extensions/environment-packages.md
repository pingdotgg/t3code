# Installed environment extensions

An installed package joins three existing boundaries: the public resource-view SDK, authenticated environment HTTP, and the provider session's MCP server. The first supported package format is deliberately small: a `t3-extension.json` manifest and at most one bundled ESM client entry and one bundled ESM server entry. The complete package is limited to 1 MiB; metadata and individual tool inputs/results have separate 64 KiB JSON limits.

The [installed workspace reader](../../../packages/extension-sdk/examples/installable-workspace-reader/README.md) is a complete public-package example. Its panel calls its own server tool, which requests `t3.workspace/read-text` from the host. Its explicit composer selection captures the last successful read for the exact environment, project, thread and workspace revision. Reading a file does not automatically put it in a prompt.

## Installation and identity

Installation requires an authenticated environment session with `access:write`, an explicit trusted-code acknowledgement, a directory on that environment, explicit project and capability grants. Empty grant lists do not confer project or service access. Ordinary read-scoped sessions can discover installed metadata and invoke granted tools, but cannot install or change packages.

The server copies only declared entries and the manifest into an immutable directory identified by a digest over their paths and bytes. It validates public metadata, strict draft-7 tool schemas without external references, size limits, and entry syntax before committing an installation record. The installer does not execute the module; a connected client executes an enabled client entry when loading its refreshed catalog. The supervised worker validates the executable server export when its first tool is invoked.

Updates preserve the installation identity and existing grants. A new capability therefore remains denied until it is explicitly granted by a new installation. The Settings permission form applies to new installations; changing existing grants currently requires removal and reinstallation. Invalid metadata/schema/syntax does not replace the active record. A changed digest invalidates calls from older loaded clients. Disabling and removing an installation revoke its host-mediated operations; they do not rewrite previously captured prompt text.

Records live under the environment's `userdata/extensions` directory. A single running environment server owns that runtime. Corrupt installation records make extensions unavailable with a diagnostic; they must not stop the core app or silently reset installation data.

The runtime creates its own `packages/package.json` containing `{"type":"module"}` outside the immutable package directory. Both declared `.js` and `.mjs` server entries therefore execute as ESM even when the surrounding server installation uses CommonJS. This host metadata does not change the package digest or add a fourth copied package file; conflicting metadata or a symlink is rejected.

## Public client and server boundary

An installed client entry exports a synchronous default factory receiving the host React object and `invokeTool` binding and returning the existing SDK `Extension<SurfaceRenderer>`. Bundle client dependencies without another React runtime or private app imports. The server entry exports a default definition with exactly the declared tools; each tool receives its input and a session containing captured context, cancellation and named capability invocation. See the public `/environment` and `/workspace` exports in the [SDK guide](../../../packages/extension-sdk/README.md).

Installed clients call their own declared tools through `host.invokeTool`. Server tools call granted host services through `ToolSession.invoke`. A surface's `capabilities` describe direct client SDK services, which the installed loader currently does not supply; declaring one gives an unavailable view. The reader sample therefore has empty surface capabilities and declares workspace read on its server tool.

## Execution and trust

**This is trusted native code, not an untrusted-code sandbox.** Server entries execute as the environment's OS user in supervised Node children. Client entries execute in the app renderer and use the host's React identity. The permission checks constrain host-provided services; they cannot stop trusted code from importing Node modules or using browser APIs directly. The tool's read-only flag is a declaration and MCP hint, not an OS restriction.

Each enabled installation starts its server worker lazily. The parent bounds calls, service concurrency, payloads and deadlines; a crashing or hung worker is replaceable. Ordinary cancellation belongs to one invocation. A hard deadline can terminate that installation's shared worker and fail its other pending calls. Disabling, updating or removing a package invalidates its old generation.

The client loads code through authenticated environment HTTP, checks the catalog digest, and registers it only for the matching environment. It revokes temporary Blob URLs after importing them. Desktop's script policy permits those Blob modules; arbitrary network script origins remain restricted. A client package must not bundle a second React runtime. Async module evaluation has a 10-second deadline; timeout or connection disposal discards a late factory, and one failed package does not block later packages. This cannot preempt synchronous trusted JavaScript.

Catalogs refresh on connection changes and with **Refresh extensions** in Settings. There is no periodic polling or installation-event subscription. A package changed from another client may remain visible until refresh, while server generation and grant checks reject obsolete tool calls immediately. See the [client lifecycle](./environment-client.md) and [user guide](../../user/extensions.md).

## Scope and model tools

Caller-provided paths are never workspace authority. Before and after a call, the server resolves the actual environment, project and optional thread from its projection repositories. It rejects deleted or mismatched records and stale workspace revisions. The workspace service accepts only validated relative paths and retains the existing backend's canonical file confinement, including symlink checks.

`extensions_list` advertises enabled, granted read-only tools to a provider session. `extensions_call` requires the selected tool's current package digest. The MCP credential supplies environment and thread identity; the model cannot override them with another project or working directory. Installation grants are checked independently of the MCP credential.

The generic catalog/call tools avoid changing a provider's cached MCP tool list every time a package is installed. The catalog returns each package's input schema and tool description; tool input is validated again in the runtime. Tool results are bounded JSON, so they remain readable through the provider's existing history path.

## Bundled adapters and compatibility

Files, Diff, Version Control, Browser, Terminal and Agents use the same view lifecycle, but remain bundled first-party integrations with their existing engines and backend commands. Their private React bindings are not public SDK services. An external extension cannot assume that a terminal, browser, forge or orchestration control API exists merely because its corresponding native panel uses the SDK.

Web and desktop support React extension views. Installed React views are not supported by React Native mobile; it needs a separate native renderer and host integration. Generic side panels and bottom docks are implemented; full-page and compact-detail descriptors do not imply those destinations are available in every client. Composer context and message cards remain bounded text contributions.

This integration targets Orchestra V1. Environment/resource identity and package metadata are reusable for V2; execution, admission and orchestration adapters require separate implementation and verification. Device simulator, live issue tracker and non-Git source-control providers remain separate extension implementations.

See the [developer preview](./developer-preview.md), [placements](./placements.md), and [validation guide](../../operations/extensions-validation.md). Source and unit-test coverage do not establish production performance or native-client compatibility; retain real-client receipts for the exact candidate.
