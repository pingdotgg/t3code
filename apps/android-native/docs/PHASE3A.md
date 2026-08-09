# Phase 3A — Projects and read-only workspace files

## Goal

Let a user register an existing folder or clone a Git repository into any connected environment, then inspect a thread's effective workspace without leaving the native Android app.

## Capability matrix

| Journey | Server contract | Android behavior |
| --- | --- | --- |
| Browse project folders | `filesystem.browse` | Environment-scoped folder browser starting at `~/` |
| Register a project | `project.create` | Creates the project and opens New task with it selected |
| Clone a repository | `sourceControl.cloneRepository` | Clones to the chosen destination, then registers the returned path |
| Browse thread files | `projects.listEntries` | Uses the thread worktree when present, otherwise the project root |
| Search paths | `projects.searchEntries` | Debounced, bounded server search |
| Search contents | `projects.searchContents` | Plain, case-insensitive server search |
| Read text | `projects.readFile` | Selectable monospace preview with truncation notice |
| Read Markdown | `projects.readFile` | Rendered Markdown preview |
| Read images | `assets.createUrl` | Signed workspace asset URL rendered through Coil |

Every RPC is routed through the connection belonging to the selected environment. File state is keyed by environment, thread, and effective workspace path so results cannot leak across environment switches.

## Entry points

- Home toolbar: Add project
- New task: Add project
- Settings → Projects: Add project
- Thread toolbar: Files

## Verification

Focused local gate:

```bash
./gradlew :protocol:test :app:testDebugUnitTest :app:assembleDebug
```

The opt-in Android protocol integration test accepts `pairingUrl` and `workspaceCwd` instrumentation arguments. Against a disposable fixture containing `README.md`, `src/`, and the marker `phase-three-alpha`, it proves browse, list, path search, content search, and read-file RPCs over Android's real network stack. Optional thread and clone arguments also prove signed asset decoding and repository cloning on-device.

Manual device acceptance covers registering a folder, opening its new-task draft, opening a thread's file tree, both search modes, and text/Markdown/image previews.

## Boundaries

Phase 3A is read-only after project creation. It does not add file writes, terminal sessions, review UI, general git operations, or attachment picker/upload. T3 Connect remains externally blocked by production administrator approval and is not a Phase 3A gate. Performance measurement remains deferred until all Phase 3 slices are complete.
