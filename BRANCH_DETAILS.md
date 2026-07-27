# Preview Automation Reliability

Product-native preview automation is bounded and recoverable across the web host, MCP server, and Electron CDP controller. The branch-specific layer covers operation deadlines, control-session recovery, background capture presentation, and degraded semantic snapshots.

Expected behavior:

- Every Electron automation operation has a bounded control-session lifetime. The desktop manager reserves response grace inside the requested timeout, always finalizes controller and action-timeline state, and detaches a timed-out debugger session when initialization or an acquired permit may have left a CDP command pending. A request that times out while queued behind another action does not detach that action's shared debugger session.
- Click, type, and wait operations propagate their caller-supplied timeout into the desktop control-session boundary. Operations without a caller timeout retain the bounded desktop default.
- Snapshot collection keeps active-tab capture on CDP `Page.captureScreenshot` from the compositor surface. For an unselected tab, the renderer stages the still-mounted guest at effectively transparent opacity for two compositor frames, but only for the snapshot itself. The desktop manager captures that compositor surface without focusing the guest or calling `Page.bringToFront`; either activation call can make Electron promote the native guest over the host window and keep the T3 interface covered after staging ends. A separately bounded `webContents.capturePage` attempt provides a fallback, using `stayHidden: true` for background guests and normal visible-page capture for the foreground. Every returned PNG, including resized output, is validated and bounded. Final screenshot failure or timeout is logged, timed-out CDP capture resets the session after releasing its control permit, and the semantic page state, interactive elements, accessibility tree, diagnostics, and action timeline still return with `screenshot: null` instead of failing the complete snapshot.
- Desktop preview guests no longer create their CDP debugger session eagerly when a webview registers. Session initialization is lazy and included in the automation operation deadline. This prevents an offscreen Chromium guest from leaving `Runtime.enable` pending while holding the synchronized session lock, which previously made every later evaluation or snapshot against that tab time out even after it became presentable. Closing detached DevTools restores an explicit color-scheme override through the separately bounded recovery path; tabs following the system scheme stay detached until the next automation operation.
- Inactive preview webviews remain mounted, retain their declared viewport, and stay CSS-visible while positioned outside the human-visible panel. This preserves their runtime and semantic or input automation without selecting them. Background snapshot capture uses a reference-counted presentation lease and always restores the offscreen position afterward; navigation, color-scheme changes, evaluation, waits, recording, and input operations remain compatible with the selected inline preview or right-panel surface without acquiring that lease. Snapshot staging does not change the human-selected preview surface. The entire lease, including compositor-frame staging and desktop IPC, is bounded by the operation's remaining response budget and reports a typed timeout if it stalls. If the user foregrounds the target in either the inline mini-player or right panel while staging is pending, that visible presentation satisfies readiness. A never-presented tab does not depend on another browser surface having supplied a panel rectangle: capture staging falls back to a deterministic rectangle fitted inside the renderer viewport.
- A background snapshot that times out before desktop capture begins releases its presentation lease even when Chromium has paused compositor-frame callbacks. Once desktop capture starts, a timed-out snapshot retains its presentation lease until that capture settles, so response timeouts cannot tear down compositor staging beneath an in-flight capture. The desktop snapshot receives the operation's remaining timeout and bounds its control session accordingly.
- The shared preview contract treats snapshot screenshots as nullable. MCP snapshot responses omit image content when capture is unavailable while preserving structured semantic content and explicitly reporting `screenshot: null`; tool descriptions promise a PNG only when capture is available. The desktop snapshot IPC schema and preload adapter default an omitted `background` flag to `false`, preserving foreground-capture behavior for legacy callers.
- The renderer automation consumer reserves response grace before the broker deadline and converts a stalled host operation into a typed `PreviewAutomationTimeoutError` instead of leaving the broker to surface a generic execution failure. Short caller-supplied timeouts retain their full execution budget instead of being consumed by fixed grace deductions. Requests that ask to open the inline preview use the request's remaining bounded visibility budget rather than a fixed two-second ceiling, and their stable-presentation dwell contracts to fit short deadlines instead of requiring an impossible fixed 100 milliseconds. Reused empty or failed tabs acknowledge without waiting for a browser surface those states intentionally hide. Visibility timeouts report the active inline or right-panel surface, whether the requested browser surface was registered, and whether it had a presentation rectangle.
- A newly created preview tab applies its server snapshot and assigned tab id, initiates any requested selection, and acknowledges server-side creation immediately without making the first call depend on cold React panel rendering, Electron overlay registration, or page readiness. Its initial URL continues loading exactly once in that same tab; status can report progress, while later wait, snapshot, or interaction operations own any attachment or page-readiness wait. Reopening an existing shown tab selects both the preview-state tab and its matching inline mini-player surface, then waits for stable presentation; while the request remains pending it reasserts that explicit selection across route hydration or session reconciliation instead of accepting one transient visible frame. Reused tabs retain overlay, navigation, and requested-visibility readiness checks because their existing automation target should already be available. The deprecated `show` input remains an alias for upstream's `open` input.
- The standard dev runner keeps local navigation and direct backend URLs on `127.0.0.1`. Browser modes follow upstream's single-origin architecture: they leave client HTTP/WebSocket URLs and generic `HOST` unset so remote sharing and origin-derived HMR keep working, while Vite's default listener and its default backend proxy use explicit IPv4 loopback. Explicit IPv6 backend binds proxy through IPv6 loopback. Desktop mode continues to pin `HOST` and its renderer/backend URLs to `127.0.0.1`; server-only mode keeps direct HTTP/WebSocket URLs on the same IPv4 loopback.
- The primary pairing route watches for later URL-fragment changes while it remains mounted. Navigating an already-loaded `/pair` document to `/pair#token=...` claims each new token once, removes the secret fragment, and runs the normal pairing exchange without requiring a reload or a second desktop window.

Current limitations:

- Electron screenshot capture can still be unavailable when both the bounded CDP compositor capture and hidden `capturePage` fallback fail. The intended degraded result remains a usable semantic snapshot with `screenshot: null`, not raster evidence.

Primary files:

- `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/ipc/methods/preview.ts`
- `apps/desktop/src/preload.ts`
- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/mcp/toolkits/preview/tools.ts`
- `apps/web/src/browser/HostedBrowserWebview.tsx`
- `apps/web/src/browser/browserSurfaceStore.ts`
- `apps/web/src/browser/hostedBrowserWebviewStyle.ts`
- `apps/web/src/components/auth/PairingRouteSurface.logic.ts`
- `apps/web/src/components/auth/PairingRouteSurface.tsx`
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx`
- `apps/web/src/components/preview/previewAutomationPresentation.ts`
- `apps/web/src/components/preview/previewAutomationOpenReadiness.ts`
- `apps/web/src/components/preview/previewAutomationErrors.ts`
- `apps/web/src/components/preview/previewAutomationRequestConsumer.ts`
- `apps/web/vite.config.ts`
- `packages/contracts/src/previewAutomation.ts`
- `packages/contracts/src/ipc.ts`
- `scripts/dev-runner.ts`

Focused regression coverage lives in `scripts/dev-runner.test.ts`, `apps/desktop/src/preview/Manager.test.ts`, `apps/server/src/mcp/McpHttpServer.test.ts`, `apps/web/src/browser/browserSurfaceStore.test.ts`, `apps/web/src/browser/hostedBrowserWebviewStyle.test.ts`, `apps/web/src/components/auth/PairingRouteSurface.logic.test.ts`, `apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts`, `apps/web/src/components/preview/previewAutomationPresentation.test.ts`, `apps/web/src/components/preview/previewAutomationRequestConsumer.test.ts`, `packages/contracts/src/ipc.test.ts`, and `packages/contracts/src/preview.test.ts`.

```sh
vp test run scripts/dev-runner.test.ts apps/desktop/src/preview/Manager.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/web/src/browser/browserSurfaceStore.test.ts apps/web/src/browser/hostedBrowserWebviewStyle.test.ts apps/web/src/components/auth/PairingRouteSurface.logic.test.ts apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts apps/web/src/components/preview/previewAutomationPresentation.test.ts apps/web/src/components/preview/previewAutomationRequestConsumer.test.ts packages/contracts/src/ipc.test.ts packages/contracts/src/preview.test.ts
```

## Development Ports

Preferred ports when explicitly selecting offset 11:

- Web: `5744`
- Server/WebSocket: `13784`
- This explicit offset is optional. Use `T3CODE_PORT_OFFSET=11 vp run dev` only when you need to prefer this documented pair instead of the worktree-path-derived starting offset.
- If either preferred port is unavailable, the runner can advance. Use the `serverPort` and `webPort` values from the printed `[dev-runner]` line for testing; if a test requires the documented pair exactly, free the conflicting ports and restart.
