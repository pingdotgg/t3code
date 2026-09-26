# Validate and roll back extension integration

This runbook covers the trusted resource-view developer preview described in the [contributor guide](../internals/extensions/developer-preview.md). Use it for a frozen SDK or application candidate. Unit tests, a successful build and six registered native adapters do not establish real-client parity.

## Freeze the thing being tested

Record the exact baseline and candidate commits, package-source hashes, packed SDK hash, tool versions, fixture seed, commands, real exit statuses and retained logs. If validation starts against an uncommitted package snapshot, retain hashes for its source/configuration and label the result as a snapshot result. Pin it to a committed candidate with matching content before calling it a frozen release gate; rerun affected checks if content changed.

Keep seed material, raw traces, failed attempts and receipts outside the repository; runtime fixture copies must also satisfy the server-root requirements below. Keep baseline and candidate source/build/state separate. Never point a test server at live T3 userdata. Use supported consistent database snapshots when real test data is needed, copy it into disposable state, and keep data flow one-way.

On a shared machine, serialize dependency installation, builds and heavyweight tests with the team's agreed lock, set `CI=true`, and bound Node heap usage. Do not run builds during performance measurement. Keep captured process IDs and stop only processes owned by the run. The [development runbook](development.md) covers normal dev environment setup.

## Put review fixtures inside the configured roots

`ReviewService` accepts a diff request's canonical `cwd` only when it is the configured `config.cwd` or `config.worktreesDir`, or a descendant of either. Copy each baseline/candidate fixture into its isolated server's worktrees directory or workspace root. Do not use symlinks: validation resolves real paths, so a link does not bring an outside fixture within the boundary.

Point the disposable project's workspace at that copy through the authorized fixture API's `project.meta.update` command. Confirm the resulting project metadata, then inspect the observed review RPC `cwd` and returned preview `cwd`: both must identify the intended canonical fixture before accepting behavior or timing evidence.

An outside-root fixture produces a workspace-boundary error. `DiffPanel` can then retry at `serverConfig.cwd`, yielding an empty or unrelated diff instead of the seeded comparison. Treat that as a fixture failure even if the panel renders successfully; correct the copy and project mapping, and rerun with the intended RPC path.

## SDK and fresh-install gate

The SDK's `prepare` script builds its emitted exports during normal workspace installation. The web package's `dev`, `build`, `test` and `typecheck` scripts build the SDK first. The runtime's `build` and `test` scripts also build the SDK; the server's `dev`, `build:bundle`, `test` and `typecheck` scripts use `build:extensions` to build that runtime dependency.

Raw commands such as `vp test run` and `pnpm exec tsc` bypass package-script prerequisites. Before using them in a clean checkout, run `CI=true corepack pnpm --filter t3 run build:extensions`. Do not remove an active environment's `dist` to test this: use an isolated package/workspace copy.

Run the focused SDK checks from the repository root:

```sh
CI=true corepack pnpm --filter @t3tools/extension-sdk build
CI=true corepack pnpm --filter @t3tools/extension-sdk test
node packages/extension-sdk/test/external-consumer.mjs
```

The packed example check is necessary but is authored with the SDK. Add a fresh external consumer package that uses only public exports and real TypeScript resolution against the emitted tarball. It must not use workspace aliases, private source imports or SDK test helpers. Preserve the tarball, compile command and consumer fixture. Verify private imports fail at the package resolver.

At minimum, independently exercise:

- Registration, duplicate/malformed manifests, unsupported state/client/capability fallback and unavailable-plugin restoration.
- Two environments with colliding local resource IDs; context/workspace changes during delayed requests; rejection of old publications and cancellation races.
- Interactive renderer state across hide/show, late/failed factories, cleanup/disable/reopen and shared-resource survival after closing one viewer.
- A burst of saves without any publication: notifications coalesce, the latest restoration value reaches persistence, and reopening reads that value.
- Optional retained exit presentation: state stays mounted, hidden activity remains blocked, and the shell eventually conceals it.
- A lifecycle soak of at least 100 cycles with resource/listener/pending-call counts returning to baseline after drain.

Test two clean installation paths separately. A fresh workspace copy without emitted output must run `prepare` successfully; the web scripts' build prefix must also rebuild missing SDK exports. A fresh downstream package must install the packed tarball with lifecycle scripts enabled and import its runtime exports without requiring SDK source files or a compiler.

## Application integration gate

Run this focused store, bridge, service, placement and text-contribution selection from `apps/web` after building the SDK. These are component/unit checks, not a complete native-adapter or real-client gate:

```sh
../../node_modules/.bin/vp test run --project unit \
  src/rightPanelStore.test.ts \
  src/rightPanelStore.extensions.test.ts \
  src/rightPanelStore.placements.test.ts \
  src/extensions/nativeBridge.test.tsx \
  src/extensions/workspaceRegistry.test.tsx \
  src/extensions/workspaceServices.test.tsx \
  src/extensions/services/workspaceRead.test.ts \
  src/extensions/GenericExtensionDock.test.tsx \
  src/extensions/context.test.tsx \
  src/extensions/MessageDecorations.compiler.test.tsx
```

Service cases cover explicit grants, revocation, scope and bounded/stale results using controlled dependencies; they do not prove backend or provider behavior. Placement cases cover container ownership, saved generations and hidden activation; real-client retention and geometry still require observation. Text-contribution cases cover explicit capture and visible read-only cards. When changing composer integration, also run the existing editor serialization, mention, paste, logic and prompt-history tests.

The message-decoration compiler test transforms the actual component with the application's React compiler preset. It covers a message mounted before registration, subsequent installation, unregister and reinstall, including obsolete visibility callbacks. Keep this case alongside the ordinary component tests: uncompiled tests can miss a mutable registry lookup that the compiler memoizes as a constant. Registration availability must remain an explicit reactive dependency. The compiler test uses a controlled observer; a real-client reinstall journey remains separate evidence.

Run the changed native adapter's focused tests as well. Keep the existing store cases in the selection so generic records cannot silently regress native order, close/reopen behavior or automatic-open priority.

A real application journey must then establish that a newly registered contribution opens without a new core kind, uses the normal tab/menu/keyboard close and focus paths, saves without publishing or stealing focus, survives a reload, and becomes readable fallback when unregistered. Confirm factory restoration semantics on mounting retained records, including `null` saved state. A mock React composition test cannot establish that persistence path.

For native surfaces, preserve resource ownership and presentation identity. In particular, verify same-workspace file navigation does not reset the outer preview merely because a thread or selected path changed; attachments still reset by attachment identity. Retained terminal docks must not acquire the foreground project's context.

Matched baseline/candidate journeys, baseline-noise measurement, fault injection, 100-cycle soaks and raw latency/CPU/memory/wire samples are the acceptance bar for parity claims. Supply actual web/Electron drivers and service receipts; synthetic analyzer fixtures are not substitute journey evidence. Record unsupported macOS, React Native, provider and connection-mode paths explicitly.

## Interpret readiness and resource diagnostics

Require actual content readiness before measuring a surface. For Files, a refresh button or mounted shell does not establish that the tree has loaded: wait for the expected fixture tree item and selected file content, and retain failure evidence if they never appear. Apply the same rule to the seeded diff and actual terminal output.

Distinguish CDP instance counters from connected DOM counts. `Memory.getDOMCounters` reports renderer-wide objects and listeners; a document query counts a different population and can omit retained or shadow-tree nodes. Do not subtract connected elements from CDP node counts and label the difference an exact detached-node count.

For resource investigation, compare matched visible states and, separately, matched drained states after owned subscriptions, requests and viewer cleanup have settled. A controlled garbage-collection phase may help distinguish retained resources from objects awaiting collection, but record it as a diagnostic phase applied equally to baseline and candidate. Forced GC is not a latency benchmark and must not be mixed into ordinary interaction timing. Keep phase labels, raw counters and ownership observations together; a single unmatched count cannot establish a leak or its cause.

## Classify failures before changing the candidate

An invalid record rejected before opening is different from a valid record whose plugin is unavailable. Preserve a valid record's fallback and restoration data; do not erase it simply to remove an error panel.

A stale-context result is a lifecycle defect, not a reason to relax scope validation. Confirm the resource environment and optional thread match the layout ref, then inspect host cancellation/generation and domain-adapter ownership. Shared PTYs or browser sessions disappearing after viewer closure indicate a resource-ownership violation.

Saved state disappearing without a presentation update usually points to notification or bridge persistence wiring. Check `session.save` notification, the bridge's record callback, and `updateExtensionRecord`. Calling `openExtension` for every save can reopen a hidden panel or defeat focus expectations.

A blank full-height renderer can be a layout-boundary failure. Inspect the SDK wrapper dimensions and visibility before replacing the native engine. Retained exit paint must be inert and aria-hidden, and it must end.

Do not change provider credentials, restart unrelated services or mutate live state to make a validation fixture pass. Retain the failed receipt and fix the candidate or fixture within its disposable environment.

## Rollback

For one bootstrap contribution, invoke its unregister function or remove its trusted bootstrap registration in the candidate. Existing generic layout records remain readable via fallback; registration can be restored later. Explicitly close a layout record to remove it from the panel. Neither action is a domain terminate command.

For a native adapter regression, return the candidate build to the previously validated baseline or revert the relevant integration change through the normal review workflow. The integration does not promise a permanent runtime switch between built-in and extension renderers. Do not mount both implementations at once: duplicate listeners, queries or viewers can invalidate both behavior and measurements.

Preserve a copy of candidate layout state before running an older client. An older layout schema may discard unknown extension records; downgrade behavior is not a guarantee of data preservation. Reverting a viewer does not undo completed filesystem writes, repository operations, browser navigation or terminal activity. Their existing recovery paths remain authoritative.

A runtime/fleet rollback is a deployment action with its own authorization and compatibility checks. Completing this validation runbook does not authorize a live update, state migration or public release.

## Completion receipt

Report the frozen source and package identities, exact focused checks and exit statuses, independent consumer result, real-client journey evidence, comparison decision, unresolved gaps and rollback target. State whether cross-provider review actually ran; if credentials or quota made it unavailable, preserve the failed availability evidence and do not imply a review occurred.

Keep SDK usability, app persistence correctness, six-surface parity, performance and platform coverage as separate conclusions. A passing result in one category does not fill a missing result in another.
