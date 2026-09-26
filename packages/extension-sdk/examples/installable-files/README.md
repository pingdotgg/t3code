# Installable Files API provider

This format-2 package replaces the ordinary Files panel entry with its own read-only tree and text renderer. Its bundled client uses only the injected React identity and public `invokeApi` methods. It imports no private application component, transport, filesystem path or store. `server.mjs` provides the shared `t3.file/presentation@1` contract and its own `example.files/info@1` API.

Install this directory using Settings → Integrations on the target environment. Select allowed projects, explicitly grant `t3.workspace/read-text`, `t3.workspace/list-entries` and `t3.file/open`, and accept trusted code execution. Choose **Use for t3.file/presentation** on the installed package. Provider selection does not add grants. The equivalent authenticated `extensions.selectApi` request is:

```json
{ "id": "t3.file/presentation", "providerId": "example.files", "fallbackProviderIds": [] }
```

Open the usual Files panel, navigate directories and choose a text file. The renderer calls `t3.workspace/files.listEntries` and `.readText`; host authorization binds its installed content hash to its project grant. Refresh rereads data, Load more entries advances the bounded directory cursor, hidden or disposed views cancel requests, and truncated reads are clearly marked. This package never writes files. Presentation state stores the selected relative path; the native route persists that opaque state with the resource and selected provider identity, with a 32-record bound.

Install the neighboring `installable-files-consumer` directory to exercise a separately packaged client consuming `example.files/info`. It declares an explicit dependency on this package at `^1.0.0` and on that API at `^1.0.0`.

The legacy full editor remains available when no Files presentation API is installed. Conflicting, disabled or unavailable selected providers show an unavailable state; they do not silently take over through the legacy panel. File attachments continue through the legacy renderer because this package does not implement attachment resource leases.

This is a real read-only replacement slice, not full Files parity. Editing and save receipts, Markdown tasks, media and attachment rendering, line comments, composer insertion, external editor/open, reveal-line handling, diff and full tree UX remain to migrate. Browser, terminal, source-control and orchestration panel replacement are not established by this example. Reload/remount testing covers local presentation state, not multi-device state synchronization or full relay/tunnel parity.

The web regression loads these actual package files through the installed controller and renders them via `NativeRightPanel`; its transport is a test double. Real installation/server and remote-mode evidence must be reported separately.
