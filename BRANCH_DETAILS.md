# Preview Automation Reliability

Product-native preview automation remains bounded and recoverable across the web host, MCP server, and Electron CDP controller. Preserve this behavior until upstream provides equivalent operation deadlines, control-session recovery, and degraded semantic snapshots.

Expected behavior:

- Every Electron automation operation has a bounded control-session lifetime. The desktop manager reserves response grace inside the requested timeout, always finalizes controller and action-timeline state, and detaches a timed-out debugger session when initialization or an acquired permit may have left a CDP command pending. A request that times out while queued behind another action does not detach that action's shared debugger session.
- Click, type, and wait operations propagate their caller-supplied timeout into the desktop control-session boundary. Operations without a caller timeout retain the bounded desktop default.
- Snapshot collection keeps active-tab capture on CDP `Page.captureScreenshot` from the compositor surface. For an unselected tab, the renderer stages the still-mounted guest at effectively transparent opacity for two compositor frames, but only for the snapshot itself. The desktop manager captures that compositor surface without focusing the guest or calling `Page.bringToFront`; either activation call can make Electron promote the native guest over the host window and keep the T3 interface covered after staging ends. A separately bounded `webContents.capturePage` attempt provides a fallback, using `stayHidden: true` for background guests and normal visible-page capture for the foreground. Every returned PNG, including resized output, is validated and bounded. Final screenshot failure or timeout is logged, timed-out CDP capture resets the session after releasing its control permit, and the semantic page state, interactive elements, accessibility tree, diagnostics, and action timeline still return with `screenshot: null` instead of failing the complete snapshot.
- Desktop preview guests no longer create their CDP debugger session eagerly when a webview registers. Session initialization is lazy and included in the automation operation deadline. This prevents an offscreen Chromium guest from leaving `Runtime.enable` pending while holding the synchronized session lock, which previously made every later evaluation or snapshot against that tab time out even after it became presentable. Closing detached DevTools restores an explicit color-scheme override through the separately bounded recovery path; tabs following the system scheme stay detached until the next automation operation.
- Inactive preview webviews remain mounted, retain their declared viewport, and stay CSS-visible while positioned outside the human-visible panel. This preserves their runtime and semantic or input automation without selecting them. Background snapshot capture uses a reference-counted presentation lease and always restores the offscreen position afterward; navigation, color-scheme changes, evaluation, waits, and input operations remain offscreen and do not acquire that native-surface lease. Snapshot staging does not change the right-panel tab selected by the user. The entire lease, including compositor-frame staging and desktop IPC, is bounded by the operation's remaining response budget and reports a typed timeout if it stalls. If the user foregrounds the target while staging is pending, that visible presentation satisfies readiness. A never-presented tab does not depend on another browser surface having supplied a panel rectangle: capture staging falls back to a deterministic rectangle fitted inside the renderer viewport.
- The shared preview contract treats snapshot screenshots as nullable. MCP snapshot responses omit image content when capture is unavailable while preserving structured semantic content and explicitly reporting `screenshot: null`; tool descriptions promise a PNG only when capture is available. The desktop snapshot IPC schema and preload adapter default an omitted `background` flag to `false`, preserving foreground-capture behavior for legacy callers.
- The renderer automation consumer reserves response grace before the broker deadline and converts a stalled host operation into a typed `PreviewAutomationTimeoutError` instead of leaving the broker to surface a generic execution failure. Short caller-supplied timeouts retain their full execution budget instead of being consumed by fixed grace deductions. Requests that ask to show the browser use the request's remaining bounded visibility budget rather than a fixed two-second ceiling, and their stable-presentation dwell contracts to fit short deadlines instead of requiring an impossible fixed 100 milliseconds. Reused empty or failed tabs acknowledge without waiting for a browser surface those states intentionally hide. Visibility timeouts report whether the right panel was open, which surface was active, whether the requested browser surface was registered, and whether it had a presentation rectangle.
- A newly created preview tab applies its server snapshot and assigned tab id, initiates any requested selection, and acknowledges server-side creation immediately without making the first call depend on cold React panel rendering, Electron overlay registration, or page readiness. Its initial URL continues loading exactly once in that same tab; status can report progress, while later wait, snapshot, or interaction operations own any attachment or page-readiness wait. Reopening an existing shown tab selects both the preview-state tab and its matching right-panel surface, then waits for stable panel presentation; while the request remains pending it reasserts that explicit selection across route hydration or session reconciliation instead of accepting one transient visible frame. Reused tabs retain overlay, navigation, and requested-visibility readiness checks because their existing automation target should already be available.
- The standard dev runner uses `127.0.0.1` consistently for its generated web, HTTP, and WebSocket loopback URLs and pins Vite to the same host. It sets the generic `HOST` override only for modes that launch the composite stack, web, or desktop, leaving server-only invocations untouched. Environment-port navigation therefore cannot resolve the backend as IPv4 while the related Vite listener is reachable only through IPv6 `localhost`.
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
- `apps/web/src/components/auth/PairingRouteSurface.tsx`
- `apps/web/src/components/preview/PreviewAutomationHosts.tsx`
- `apps/web/src/components/preview/previewAutomationPresentation.ts`
- `apps/web/src/components/preview/previewAutomationOpenReadiness.ts`
- `apps/web/src/components/preview/previewAutomationErrors.ts`
- `apps/web/src/components/preview/previewAutomationRequestConsumer.ts`
- `packages/contracts/src/previewAutomation.ts`
- `packages/contracts/src/ipc.ts`
- `scripts/dev-runner.ts`

Focused regression coverage lives in `scripts/dev-runner.test.ts`, `apps/desktop/src/preview/Manager.test.ts`, `apps/server/src/mcp/McpHttpServer.test.ts`, `apps/web/src/browser/browserSurfaceStore.test.ts`, `apps/web/src/browser/hostedBrowserWebviewStyle.test.ts`, `apps/web/src/components/auth/PairingRouteSurface.logic.test.ts`, `apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts`, `apps/web/src/components/preview/previewAutomationPresentation.test.ts`, `apps/web/src/components/preview/previewAutomationRequestConsumer.test.ts`, `packages/contracts/src/ipc.test.ts`, and `packages/contracts/src/preview.test.ts`.

```sh
vp test run scripts/dev-runner.test.ts apps/desktop/src/preview/Manager.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/web/src/browser/browserSurfaceStore.test.ts apps/web/src/browser/hostedBrowserWebviewStyle.test.ts apps/web/src/components/auth/PairingRouteSurface.logic.test.ts apps/web/src/components/preview/previewAutomationOpenReadiness.test.ts apps/web/src/components/preview/previewAutomationPresentation.test.ts apps/web/src/components/preview/previewAutomationRequestConsumer.test.ts packages/contracts/src/ipc.test.ts packages/contracts/src/preview.test.ts
```

## Development Ports

- Web: `5744`
- Server/WebSocket: `13784`
