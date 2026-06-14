# Browser Phase 0 Findings

## Executive Result

Phase 0 resolves the major architectural unknowns:

1. Keep a real Electron `<webview>` as the collaborative browser surface for the next iteration.
2. Move that webview into a durable app-level host independent of panel and route mounting.
3. Build a browser-client-style semantic automation adapter over persistent CDP, not direct Playwright attachment.
4. Use CDP screencast for capture and Chromium MediaRecorder for seekable H.264 MP4 encoding.
5. Use a desktop loopback listener plus a dedicated authenticated raw-TCP-over-WebSocket tunnel for remote environment ports.
6. Keep the renderer as the desktop/server transport relay initially; remove its browser lifecycle authority, not the relay itself.

## Automation Attachment

### Existing `<webview>`

Electron remote debugging exposed two targets:

- host renderer: target type `page`
- guest browser: target type `webview`

Playwright `chromium.connectOverCDP()` returned only the host renderer as a `Page`. Connecting directly to the guest target's debugger WebSocket succeeded at the transport level but produced zero Playwright pages.

Conclusion: direct Playwright locators cannot drive the current guest webview through the supported `connectOverCDP` API.

### Semantic CDP adapter

The spike used:

- `Accessibility.getFullAXTree`
- role and accessible-name matching
- `DOM.getBoxModel`
- `Input.dispatchMouseEvent`
- `DOM.resolveNode`
- `Runtime.callFunctionOn`

It located and clicked a button by role/name and filled a textbox by role/name against the exact guest page. The resulting page state was correct.

Conclusion: a browser-client-style adapter can provide semantic locators without Playwright owning or directly attaching to the guest page.

### `WebContentsView` comparison

A main-process-owned `WebContentsView` appears as a normal Playwright `Page`; Playwright role and textbox locators succeeded.

However:

- hidden or detached view capture was inconsistent or unavailable
- detached `capturePage()` reported no current display surface
- detached CDP screenshot could hang without an explicit timeout
- hidden/detached CDP screencast emitted zero frames
- native child views add clipping, stacking, and renderer-overlay integration costs

Conclusion: do not migrate the collaborative browser to `WebContentsView` in this iteration merely to obtain direct Playwright attachment.

## Hidden Lifecycle

For the existing `<webview>`:

- the window was hidden for 1.5 seconds
- the page timer advanced 15 ticks
- semantic automation incremented page state
- `capturePage()` returned a 1600×1200 Retina capture
- the page remained alive and controllable

Observed process snapshot for the minimal two-renderer harness:

- main-process private memory: approximately 43 MiB
- Electron Browser working set: approximately 172 MiB
- GPU process working set: approximately 100 MiB
- host renderer working set: approximately 88 MiB
- guest renderer working set: approximately 93 MiB
- measured main-process CPU during the 1.5-second hidden interval: approximately 0.04%

These are development-machine snapshots, not production budgets. They prove lifecycle behavior and establish that each retained page has meaningful renderer memory cost.

## Recording

### CDP screencast behavior

`Page.startScreencast` against the guest webview produced frames while:

- the whole BrowserWindow was hidden
- the webview remained full-size and was covered by an opaque renderer element

Moving the webview offscreen reduced the stream to one frame. Therefore hidden idle parking and hidden recording require different presentation policies.

### External ffmpeg proof

The initial proof sampled CDP frames at 12 fps and encoded H.264 MP4 with ffmpeg:

- 28 frames
- 800×600
- 12 fps
- 2.33-second duration
- valid seekable MP4

This proved the capture pipeline but is not the selected production encoder because shipping an external ffmpeg executable is unnecessary.

### Selected Chromium-native encoder

The final proof sent sampled CDP frames into an isolated canvas and used Chromium MediaRecorder:

- MIME: `video/mp4;codecs=avc1.42E01E`
- codec: H.264
- 800×600
- approximately 11 fps from a requested 12 fps
- 2.4617-second duration
- 12,823-byte seekable MP4 artifact
- no external ffmpeg process used for encoding

Conclusion: select CDP screencast plus Chromium MediaRecorder H.264 MP4 for the initial recording backend.

## Remote Preview Tunnel

Two proxy shapes were tested:

1. HTTP-aware reverse proxy with WebSocket upgrade handling.
2. Desktop loopback TCP listener forwarding raw streams over a dedicated WebSocket to an environment-side TCP dialer.

Both loaded the HTTP page and passed 100 WebSocket echo round trips. The raw TCP tunnel is selected because it preserves origin paths, root-relative assets, arbitrary HTTP semantics, HMR upgrades, and application WebSockets without rewriting response bodies.

Five local runs of the raw TCP tunnel produced:

- added HTTP median latency: 0.036–0.112 ms; median run 0.049 ms
- WebSocket median round-trip: 0.075–0.138 ms; median run 0.102 ms
- WebSocket p95 round-trip: 0.133–0.287 ms; median run 0.151 ms

Network latency will dominate in real remote environments. The local result shows the framing/proxy architecture itself is not a meaningful latency source.

## Desktop Routing Latency

The spike compared 100 no-op CDP evaluations:

- direct main-process CDP call
- renderer `ipcRenderer.invoke` relay to the same main-process CDP call

Across five runs:

- direct median: 0.058–0.066 ms; median run 0.060 ms
- renderer-relay median: 0.100 ms
- direct p95: 0.101–0.115 ms; median run 0.105 ms
- renderer-relay p95: approximately 0.300 ms

Conclusion: renderer IPC overhead is negligible compared with browser work and remote networking. The renderer should lose lifecycle and ownership authority, but replacing the existing server-to-renderer transport relay is not a Phase 1 performance requirement.

## Explicit Unsupported or Rejected Paths

- Direct Playwright `connectOverCDP` to an Electron `<webview>` guest.
- Enabling an unauthenticated process-wide Chromium remote-debugging port in production.
- Switching to `WebContentsView` solely for Playwright compatibility.
- Recording from an offscreen or detached surface without temporarily restoring a composited parking surface.
- Using screenshots, JPEG frames, or video as the interactive browser presentation.
- HTTP path-prefix rewriting as the general remote preview solution.
- Sending preview tunnel data over the normal control/event WebSocket.

