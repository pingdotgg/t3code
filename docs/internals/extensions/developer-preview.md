# Extension developer preview

The implementation is a trusted, in-process resource-view SDK with captured composer context, read-only message cards and a web/desktop application bridge. An independently authored package can register a new surface and open it through a generic layout record without adding another feature kind to the shell. Trusted environment packages add persistent installation, authenticated client delivery and supervised server tools. See [installed environment extensions](./environment-packages.md) for that boundary and its permissions. Explicit application bootstrap remains available for bundled integrations.

Six bundled adapters use the same SDK renderer contract: Files, Diff, Version Control, Browser, Terminal and Agents. Their presence is implementation evidence, not a declaration of real-client parity or release readiness. Use the [validation and rollback guide](../../operations/extensions-validation.md) and retained run receipts to assess a candidate.

Portable text snapshot validation and codecs are exported from `@t3tools/extension-sdk/context`; see the [SDK author guide](../../../packages/extension-sdk/README.md) for context and message contribution examples.

## Package API and application integration are different boundaries

The public package exports are documented in the [SDK author guide](../../../packages/extension-sdk/README.md). Start from its [packed counter example](../../../packages/extension-sdk/examples/counter/counter.ts).

| Boundary                           | Contract                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@t3tools/extension-sdk/contracts` | Serializable manifests, descriptors, resource/context references and `ViewRecord`; identity and bounded JSON helpers.                                                                                                                                                 |
| `@t3tools/extension-sdk/host`      | `Extension<Renderer>`, view factories/sessions, host lifecycle, registration, subscriptions and explicitly supplied services.                                                                                                                                         |
| `@t3tools/extension-sdk/react`     | `SurfaceRenderer`, renderer props and `ExtensionSurface`; optional React dependency.                                                                                                                                                                                  |
| `@t3tools/extension-sdk/context`   | Composer/message contribution types, attributed text snapshots, bounded validation and readable append/read/remove codecs.                                                                                                                                            |
| Environment packages               | Public package metadata and client/server definitions use `@t3tools/extension-sdk/environment`; workspace read contracts use `@t3tools/extension-sdk/workspace`. The environment runtime owns installation, grants and tool execution.                                |
| Application bootstrap              | [`registerWorkspaceExtension`](../../../apps/web/src/extensions/workspaceRegistry.tsx) imports a trusted React extension into the running client and returns an idempotent unregister function. This is application integration code, not another SDK package export. |
| Application layout                 | [`rightPanelStore`](../../../apps/web/src/rightPanelStore.ts) opens and persists a generic `kind: "extension"` surface containing the SDK record. Tabs resolve registered titles and fall back to the record's text.                                                  |

A bundled package exports an `Extension<SurfaceRenderer>` with a namespaced manifest, descriptors and corresponding factories. An installed client entry instead exports a factory receiving the host React identity and authenticated tool invoker. Bootstrap calls `registerWorkspaceExtension(extension)`; a user command then calls `openExtension(threadRef, record)` on the layout store. Registration alone does not open or focus a view. Removing registration leaves saved layout records readable through their fallback, and registration can later make those records renderable again.

The generic application registry defaults to no services and authorization denied. Trusted bootstrap may pass fixed SDK `HostOptions` as the second argument to `registerWorkspaceExtension`; native adapters keep the deny-by-default behavior. The host repeats authorization on every service invocation, and a host-owned callback can revoke grants. These bootstrap services are host configuration, not a renderer-controlled registry. Installed packages use a separate tool path: the client receives its own tool invoker, and its server tools request granted environment services. The installed loader supplies no direct client SDK services.

The bootstrap-only [workspace reader example](../../../packages/extension-sdk/examples/workspace-reader/README.md) uses only public SDK exports and React. Its explicit app adapter supplies `t3.workspace/read-text` through the existing authenticated project read API, bound to one installed environment/project grant. It derives cwd from live host state, rejects absolute/traversal inputs, retains backend canonical relative-path containment, rejects stale/revoked results and bounds the complete response JSON. This is a trusted in-process API, not server-side per-extension authentication or a sandbox. No other example capability names are implied endpoints.

Bundled native adapters are a separate trusted integration case. Their typed React binding hooks carry existing component props and callbacks; factories do not read hooks outside React. They can import existing first-party domain components. An external package using only SDK exports must not assume those native imports or binding hooks are a public, portable capability API.

Generic community views have real side-panel and bottom-dock destinations. See the [placement and viewer ownership guide](./placements.md) for migration, show/hide/close, captured save generations and unsupported destinations. Use `session.save` for restoration state; the app bridge supplies the matching layout owner when persisting it.

## Identity and saved layout

A descriptor identifies its contribution and required scope. A resource reference identifies the domain object. A viewer is one mounted presentation of that object. Use the public `resourceKey` when comparing domain references; a bare path, thread ID or resource ID is insufficient across environments.

The layout store accepts environment- and project-scoped resources in a thread's panel, as well as thread-scoped resources. The record's environment must match the layout ref. If a resource has a thread ID, it must match that ref; SDK context validation also requires its project ID. These shape checks do not authenticate project membership or authorize a domain operation.

Generic surface IDs derive from contribution ID and full resource identity. Opening the same identity updates its record in place instead of adding another tab. `moveSurface` changes tab order; existing activate/close/show actions retain ownership of focus and panel visibility. The store validates and copies records, limits their JSON size/depth and admits at most 64 generic extension records per thread. It normalizes both older migrations and current-version hydration, recomputes IDs and drops malformed, duplicate or mismatched records. Valid records for unknown contributions or incompatible plugin state remain available for fallback rendering.

`openExtension(ref, record, expectedUserActionRevision)` is an automatic open: a later user panel choice rejects it. Omitting the revision is a manual choice and advances the revision. A background save uses `updateExtensionRecord`, which only updates an existing identity and does not reopen a hidden panel, take focus or advance that revision. Do not persist a save by calling the manual open action.

The inherited layout key format cannot safely distinguish environment IDs containing colons. Generic opening rejects those ambiguous refs instead of restoring their records into a different environment. Changing this format requires a separate scoped-key migration.

## Creation, restoration and lifetime

An application bridge mount binds an existing resource/layout record. Resource creation belongs in an explicit host command before that record opens. The bridge uses SDK restoration semantics even when `restoreState` is `null`; `null` does not mean the domain resource should be created again. In a standalone SDK host, `host.open` remains available for a deliberately fresh viewer, while `host.restore` sets `session.restoring`.

`session.publish(sequence, state)` updates the current presentation. `session.save(state)` updates bounded, validated restoration data and emits a coalesced notification even without a publication. The app bridge forwards changed saved records to `updateExtensionRecord`. Changes to saved data alone do not replace the renderer. State versions match exactly; this preview has no automatic plugin-state migration.

Hide and disposal are different:

- Hide retains the session, renderer and local React state while canceling service activity. Hidden sessions refuse new service calls and publications. Use visibility callbacks to suspend extension-owned streams and expensive work.
- Show resumes the retained viewer. The shell must keep its adapter mounted if local React state should survive.
- Closing, unregistering, disabling, replacing context or shutting down disposes the viewer and aborts its lifetime. Cleanup must be registered before asynchronous activation; the SDK disposes late factory results after cancellation.
- Viewer cleanup does not terminate a shared terminal, browser or other domain resource. Termination remains an explicit domain action. Cancellation is cooperative and cannot undo an already completed external effect.

The React adapter defaults to concealing hidden content. The shell may temporarily use `retainHiddenPresentation` for exit paint; the hidden wrapper remains inert and aria-hidden while SDK activity stays canceled. The shell must finish that transition and conceal or unmount the view. This option is not a work-resumption signal or a substitute for stream backpressure.

A context or workspace revision change invalidates old work. The SDK host supports generation-based context replacement; application bridge replacement also disposes the previous host. Neither permits an old response to retarget itself to the newly selected environment.

## Native adapters and domain ownership

The [native registry](../../../apps/web/src/extensions/nativePanels.tsx) resolves existing compatibility records to registered presentations. Generic contributed records take a separate registry path; adding another contributed ID does not require another native-kind case.

| Adapter         | Resource boundary that must survive integration                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files           | Workspace explorer/content uses project scope and preserves presentation across same-workspace thread navigation. Stored attachments use thread scope and attachment identity. Existing query, editing and asset engines remain owners. |
| Diff            | Thread comparison presentation retains working-tree/checkpoint engines. Checkpoint creation, settlement and rollback remain core.                                                                                                       |
| Version Control | Project/repository detail is shared by thread panels and the repository page. Existing repository and review write authorization remains authoritative.                                                                                 |
| Browser         | Thread views observe existing browser sessions. Hiding or closing a viewer must not be confused with destroying a shared browser resource.                                                                                              |
| Terminal        | Thread panels and bottom docks bind existing terminal state. Retained docks resolve their own thread context, not the foreground project's context.                                                                                     |
| Agents          | Thread-scoped tree/status presentation retains existing observation and navigation. It gains no orchestration control authority.                                                                                                        |

Native restore state remains owned by existing stores; those adapters accept `null` SDK restoration state. Web and desktop use these React adapters. React Native mobile requires a separate native renderer and integration, and is not implemented by this bridge.

## Deliberately later phases

This preview does not implement an untrusted-code sandbox, marketplace, automatic upgrades, asynchronous composer resolution or a structured attachment/timeline-item contribution protocol. Installed packages have a server loader, authenticated HTTP endpoints and MCP catalog/call tools; this does not expose arbitrary orchestration commands. The six native adapters' existing features do not create those general-purpose extension APIs. Core authentication, durable orchestration, approvals, provider lifecycle, turn settlement and checkpoint coordination remain outside replaceable views.

Current integration targets the repository's V1 application. Research about V2 execution identities, migration, tools and future contribution slots is design work, not a compatibility guarantee. A common SDK type does not make a V1 client compatible with a V2 server. Those phases need their own contracts, migrations and platform/provider verification.

The text contribution slice adds synchronous explicit composer selections and read-only message cards to the same trusted registration path. Captured context is readable prompt text with host attribution and scope, preserved by existing draft/send/history paths. Selection captures a snapshot; the normal send path freezes that string before awaits and the server admits it through the existing command. It does not resolve live external data inside admission. Message cards are pure projections of visible immutable user messages; original text always remains. The static issue-context example is labeled as a fixture. The installed-package MCP bridge is a separate tool path. No new attachment union member, native client renderer or V2 protocol compatibility follows from text selection.
