# Visible Preview Browser Automation via CDP + MCP

## Summary

Implement agent control of the user-visible T3 preview browser only. Do not add headless browser support. Do not add SSH/relay/private forwarding in v1; preview URLs must already be reachable from the desktop client, such as a Mac mini private IP URL opened on a MacBook.

Architecture:

`agent` -> `stdio MCP server in environment` -> `private T3 server bridge` -> `focused desktop client/window` -> `Electron preview webview via CDP`

The stdio MCP server is the agent-facing integration because all target agents can speak MCP. The MCP server is intentionally thin: it does not automate Chromium directly. It calls the T3 environment server, which routes commands to the focused desktop client that owns the visible preview.

## Explicit Non-Goals

- No headless browser runner.
- No Playwright-managed browser.
- No arbitrary SSH dev-port forwarding in v1.
- No Cloudflare/Tailscale/relay URL rewriting in v1.
- No automation of browser/web clients that do not have Electron preview support.
- No per-action user approval prompts in v1.

## Key Decisions

- **Transport to agents:** stdio MCP.
- **Browser being controlled:** the actual integrated Electron preview webview.
- **Remote URL handling:** manual reachable URLs only. Agents may open `http://mac-mini.local:5173` or `http://192.168.x.y:5173`; T3 will not tunnel `127.0.0.1:5173` from remote to local yet.
- **Client routing:** route tool requests to the most recently focused desktop window/client for the agent’s thread. Return a typed error if no focused desktop preview owner is available.
- **Scope:** full control of preview browser, including opening/showing the preview panel.
- **Primary automation engine:** Chrome DevTools Protocol through Electron `webContents.debugger`, with `webContents.capturePage()` where it is simpler and more reliable.

## New Contracts

Add `packages/contracts/src/previewAutomation.ts`.

### Branded IDs

- `PreviewAutomationRequestId`
- `PreviewAutomationClientId`
- `PreviewAutomationOwnerId`

### Tool Input/Output Schemas

Add Effect schemas for these operations:

- `PreviewAutomationOpenInput`
  - `url?: string`
  - `show?: boolean` default `true`
  - `reuseExistingTab?: boolean` default `true`
- `PreviewAutomationNavigateInput`
  - `url: string`
  - `waitUntil?: "load" | "domcontentloaded" | "network-idle" | "none"` default `"load"`
  - `timeoutMs?: number` default `15000`
- `PreviewAutomationSnapshotInput`
  - `includeScreenshot?: boolean` default `true`
  - `includeDomSummary?: boolean` default `true`
  - `includeAccessibilityTree?: boolean` default `true`
  - `screenshotMaxWidth?: number` default `1280`
- `PreviewAutomationClickInput`
  - one of:
    - `{ selector: string }`
    - `{ x: number; y: number }`
  - `button?: "left" | "middle" | "right"` default `"left"`
  - `clickCount?: number` default `1`
- `PreviewAutomationTypeInput`
  - `text: string`
  - `selector?: string`
  - `clearFirst?: boolean` default `false`
- `PreviewAutomationPressInput`
  - `key: string`
  - `modifiers?: readonly ("alt" | "control" | "meta" | "shift")[]`
- `PreviewAutomationScrollInput`
  - `deltaX?: number`
  - `deltaY?: number`
  - optional target `{ selector: string }`
- `PreviewAutomationEvaluateInput`
  - `expression: string`
  - `awaitPromise?: boolean` default `true`
  - `returnByValue?: boolean` default `true`
- `PreviewAutomationWaitForInput`
  - one of:
    - `{ selector: string }`
    - `{ text: string }`
    - `{ urlIncludes: string }`
  - `timeoutMs?: number` default `10000`
- `PreviewAutomationStatusResult`
  - `available: boolean`
  - `visible: boolean`
  - `threadId`
  - `tabId: string | null`
  - `url: string | null`
  - `title: string | null`
  - `loading: boolean`
  - `ownerClientId: string | null`

### Result Shape

Every mutating or stateful operation returns:

```ts
{
  ok: boolean;
  status: PreviewAutomationStatusResult;
  message?: string;
}
```

`snapshot` additionally returns:

```ts
{
  status: PreviewAutomationStatusResult;
  screenshot?: {
    mimeType: "image/png";
    dataBase64: string;
    width: number;
    height: number;
  };
  domSummary?: {
    url: string;
    title: string;
    activeElement: string | null;
    text: string;
    interactiveElements: readonly {
      index: number;
      tag: string;
      role: string | null;
      name: string;
      text: string;
      selector: string | null;
      rect: { x: number; y: number; width: number; height: number } | null;
    }[];
  };
  accessibilityTree?: unknown;
}
```

### Error Types

Add tagged errors:

- `PreviewAutomationUnavailableError`
- `PreviewAutomationNoFocusedOwnerError`
- `PreviewAutomationUnsupportedClientError`
- `PreviewAutomationTabNotFoundError`
- `PreviewAutomationTimeoutError`
- `PreviewAutomationExecutionError`
- `PreviewAutomationInvalidSelectorError`

## Server-Side Broker

Add `apps/server/src/previewAutomation/Services/PreviewAutomationBroker.ts`.

Responsibilities:

- Track connected desktop automation clients.
- Track focus ownership by `(environmentId, threadId)`.
- Accept tool calls from MCP/stdin proxy.
- Route each call to the focused owner for the thread.
- Enforce timeouts and cleanup pending requests on disconnect.
- Return typed failures when no client/window is available.

### Owner State

Store:

```ts
{
  clientId: PreviewAutomationClientId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  tabId: PreviewTabId | null;
  focusedAt: string;
  visible: boolean;
  supportsAutomation: boolean;
}
```

Ownership updates come from the web/desktop client when:

- route/thread changes,
- preview panel opens/closes,
- window focus changes,
- tab id changes,
- desktop bridge availability changes.

## WS Bridge: Server to Desktop Client

The current preview RPCs are client-to-server plus server event streams. Add a request/response bridge using stream-style RPCs to avoid introducing bidirectional RPC infrastructure.

### New WS Methods

Add to `packages/contracts/src/rpc.ts`:

- `previewAutomation.connect`
  - client calls this as a long-lived stream
  - input:
    - `clientId`
    - `capabilities`
  - stream output:
    - `PreviewAutomationClientRequest`
- `previewAutomation.respond`
  - client sends response for a request id
- `previewAutomation.reportOwner`
  - client reports focus/visibility/thread ownership
- `previewAutomation.clearOwner`
  - client clears stale ownership on unmount/disconnect

### Request Shape

```ts
{
  requestId: string;
  threadId: string;
  tabId?: string;
  operation:
    | "open"
    | "navigate"
    | "snapshot"
    | "click"
    | "type"
    | "press"
    | "scroll"
    | "evaluate"
    | "waitFor"
    | "status";
  input: unknown;
  timeoutMs: number;
}
```

### Response Shape

```ts
{
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    _tag: string;
    message: string;
    detail?: unknown;
  };
}
```

## Desktop Preview Automation

Extend `apps/desktop/src/preview-view-manager.ts`.

### Add Methods

- `getAutomationStatus(tabId)`
- `captureSnapshot(tabId, options)`
- `click(tabId, input)`
- `type(tabId, input)`
- `press(tabId, input)`
- `scroll(tabId, input)`
- `evaluate(tabId, input)`
- `waitFor(tabId, input)`

### CDP Session Handling

Add a small helper inside desktop preview code:

- Attach `webContents.debugger` lazily per operation.
- Do not keep debugger attached forever unless needed.
- If already attached by DevTools or another debugger, return `PreviewAutomationExecutionError`.
- Use CDP domains:
  - `Runtime.evaluate`
  - `DOM.getDocument`
  - `DOM.querySelector`
  - `DOM.getBoxModel`
  - `Accessibility.getFullAXTree`
  - `Input.dispatchMouseEvent`
  - `Input.dispatchKeyEvent`
  - optionally `Page.captureScreenshot` if `webContents.capturePage()` is insufficient

For screenshots, prefer `webContents.capturePage()` first because it is already used safely for annotations.

### DOM Summary Script

Use `Runtime.evaluate` with a bounded page script that returns:

- `document.URL`
- `document.title`
- active element summary
- visible text truncated to a fixed limit, e.g. 20k chars
- up to 200 interactive elements:
  - buttons
  - links
  - inputs
  - selects
  - textareas
  - elements with roles
  - elements with click handlers where detectable
- stable-ish CSS selectors generated in page context
- bounding rects

Do not return full HTML by default.

### Input Behavior

- `click(selector)`:
  - resolve selector in page
  - scroll into view
  - compute center of bounding box
  - dispatch mouse move/down/up through CDP
- `click(x, y)`:
  - dispatch at viewport coordinates
- `type(selector, text)`:
  - focus selector if provided
  - optionally clear existing value with platform shortcut
  - dispatch text via CDP keyboard events or `Input.insertText`
- `press(key)`:
  - map common key names: Enter, Escape, Tab, Backspace, Arrow keys
  - support modifiers
- `scroll`:
  - use CDP mouse wheel or page `scrollBy` fallback

## Web Client Changes

Update `apps/web/src/components/preview`.

### Ownership Reporting

Add a hook, likely `usePreviewAutomationOwner`, mounted near `PreviewView`.

It reports owner state when:

- the current route thread ref changes,
- preview panel visibility changes,
- browser window focus/blur changes,
- tab id changes,
- desktop preview bridge exists.

Policy:

- Only Electron desktop clients with `window.desktopBridge.preview` can report `supportsAutomation: true`.
- A visible preview panel gets ownership.
- The most recently focused window wins.
- On unmount or preview close, clear ownership.

### Handling Server Requests

Add a client-side subscriber using the new `previewAutomation.connect` stream.

When a request arrives:

- if operation is `open`, ensure preview panel is visible for the thread, call `api.preview.open` if needed, mount/create desktop tab, then navigate if URL is provided.
- for browser operations, call new `desktopBridge.preview.automation.*` methods.
- send `previewAutomation.respond`.

Opening behavior:

- If the right panel is closed, open it to preview.
- If the thread is not currently active in the UI, do not navigate the whole app in v1. Return `PreviewAutomationNoFocusedOwnerError`.
- If preview is supported but no tab exists and the agent calls `open`, create one.
- If no tab exists and the agent calls `snapshot/click/type/...`, return a clear “preview not open” error suggesting `preview_open`.

## Desktop IPC / Preload

Extend `packages/contracts/src/ipc.ts` `DesktopPreviewBridge`.

Add:

```ts
automation: {
  status(tabId: string): Promise<PreviewAutomationStatusResult>;
  snapshot(tabId: string, input: PreviewAutomationSnapshotInput): Promise<PreviewAutomationSnapshotResult>;
  click(tabId: string, input: PreviewAutomationClickInput): Promise<PreviewAutomationActionResult>;
  type(tabId: string, input: PreviewAutomationTypeInput): Promise<PreviewAutomationActionResult>;
  press(tabId: string, input: PreviewAutomationPressInput): Promise<PreviewAutomationActionResult>;
  scroll(tabId: string, input: PreviewAutomationScrollInput): Promise<PreviewAutomationActionResult>;
  evaluate(tabId: string, input: PreviewAutomationEvaluateInput): Promise<PreviewAutomationEvaluateResult>;
  waitFor(tabId: string, input: PreviewAutomationWaitForInput): Promise<PreviewAutomationActionResult>;
}
```

Add IPC channels in `apps/desktop/src/ipc/channels.ts` and handlers in `apps/desktop/src/ipc/methods/preview.ts`.

## Stdio MCP Server

Add package: `packages/preview-mcp`.

Purpose:

- Implements the MCP stdio protocol.
- Exposes T3 preview tools.
- Calls a private loopback endpoint or local JSON-RPC bridge on the environment server.
- Does not know Electron/CDP details.

### Binary

Expose bin:

```json
{
  "bin": {
    "t3-preview-mcp": "./dist/index.js"
  }
}
```

During local dev, provider config can call the source runner via workspace package script; production package uses built JS.

### MCP Environment Variables

Provider sessions launch the MCP server with:

- `T3_PREVIEW_MCP_SERVER_URL`
  - environment server loopback URL
- `T3_PREVIEW_MCP_TOKEN`
  - short-lived token scoped to the provider session/thread
- `T3_PREVIEW_ENVIRONMENT_ID`
- `T3_PREVIEW_THREAD_ID`

The token must be generated by the environment server and expire when the provider session ends.

### MCP Tools

Expose these tools:

- `preview_status`
- `preview_open`
- `preview_navigate`
- `preview_snapshot`
- `preview_click`
- `preview_type`
- `preview_press`
- `preview_scroll`
- `preview_evaluate`
- `preview_wait_for`

Tool descriptions must explicitly say they operate the visible T3 preview browser for the current thread.

### MCP Output

- Text results include concise status and URL/title.
- `preview_snapshot` returns:
  - text summary
  - MCP image content for screenshot when available
- Errors are MCP tool errors with the tagged T3 error message included.

## Private MCP Bridge Endpoint

Add an internal server route under `apps/server`, not public app UI:

- `POST /internal/preview-automation/tool`
- Auth: bearer `T3_PREVIEW_MCP_TOKEN`
- Body:
  - `{ tool: string, input: unknown }`
- Response:
  - `{ ok: true, result } | { ok: false, error }`

This endpoint is only for the stdio MCP proxy. It calls `PreviewAutomationBroker`.

Bind it to the same host/port as the environment server, but require the short-lived token. The endpoint must reject requests without a token or with an expired/stale thread/session.

## Provider Integration

### Codex

When starting a Codex provider session, add the T3 preview MCP server to Codex configuration if the app-server config path supports per-thread MCP injection.

Implementation path:

1. Add `PreviewMcpSessionService` in `apps/server`.
2. On provider session start:
   - create scoped MCP token for `(environmentId, threadId, providerSessionId)`.
   - build MCP server config:
     - name: `t3-preview`
     - command: `t3-preview-mcp`
     - env vars listed above
3. Thread/session start passes the MCP server config through the provider’s supported config field.
4. If Codex app-server cannot accept injected MCP servers through typed params, use its `config` override field with Codex-compatible MCP config.

### ACP Providers

ACP session creation already passes `mcpServers: []`. Replace that with the same `t3-preview` MCP server config for providers that support MCP.

### Provider Fallback

If a provider does not support MCP injection yet, do not add provider-specific native tools in v1. The shared MCP server remains available for later provider wiring.

## Remote Environment Behavior

### Mac mini dev server viewed from MacBook

Expected v1 workflow:

1. Agent runs dev server on Mac mini.
2. Agent or user opens a reachable URL, e.g.:
   - `http://mac-mini.local:5173`
   - `http://192.168.1.42:5173`
3. T3 desktop on MacBook opens that URL in the local Electron preview.
4. Agent uses MCP tools.
5. T3 routes tool calls from Mac mini environment server to the focused MacBook preview client.

### `localhost` Caveat

In v1, if an agent opens `http://localhost:5173` from a remote environment, the MacBook preview will interpret that as MacBook localhost. The tool result should include a warning when:

- environment is not the primary/local environment, and
- URL hostname is `localhost`, `127.0.0.1`, or `::1`.

Warning text:

`This URL is loopback on the preview client, not necessarily the remote environment. Use a client-reachable host/IP for remote dev servers.`

### Future-Proofing

Do not bake manual URL assumptions into the automation layer. Represent opened URLs as:

```ts
{
  displayUrl: string;
  requestedUrl: string;
  resolutionKind: "direct";
  environmentId: string;
}
```

Later `resolutionKind` can add:

- `ssh-forward`
- `relay`
- `tailscale`
- `cloudflare-tunnel`

## Security and Safety

- MCP tokens are scoped to one provider session/thread.
- MCP tokens expire on provider session stop and server restart.
- Browser automation only routes to focused desktop owner for that same thread.
- Do not allow MCP input to specify arbitrary `environmentId` or `threadId`; infer both from token/session.
- `preview_evaluate` is powerful. Keep it enabled in v1 because the user requested full control, but:
  - limit result serialization size, e.g. 64 KB
  - timeout evaluation
  - return by value by default
  - document that it executes in the preview page context
- Screenshot output should be bounded:
  - max dimensions
  - max base64 size
  - return error if too large after scaling attempts
- Clear pending broker requests when desktop disconnects.
- CDP operations must timeout and detach debugger in `finally`.

## Failure Modes

Return typed errors for:

- no desktop client connected
- desktop client connected but preview unsupported
- no focused owner for thread
- preview panel not open and operation is not `preview_open`
- webview not initialized yet
- navigation timeout
- selector not found
- CDP debugger unavailable
- page execution error
- screenshot too large
- stale request id or response after timeout

## Tests

### Contracts

Add tests for:

- schema decoding for every preview automation input/result
- error schema decoding
- invalid selector/click union inputs rejected
- snapshot options defaulting

### Desktop Unit Tests

Add tests around `PreviewViewManager` helpers:

- owner-independent status when tab exists/does not exist
- selector summary script clamps output
- selector generation handles ids/classes/nth-child fallback
- error mapping for missing webContents
- screenshot result shape

Where Electron/CDP is hard to unit test, isolate pure helpers and cover IPC handler validation.

### Server Broker Tests

Add tests for:

- registering clients
- ownership updates
- focused owner wins
- request routed to focused owner
- request timeout
- client disconnect fails pending requests
- response with unknown request id ignored/rejected
- token scoped to thread/session
- remote loopback URL warning generated

### Web Client Tests

Add tests for:

- ownership report sent only in Electron preview-supported runtime
- opening preview panel on `preview_open`
- no route switch for background thread
- clear ownership on unmount
- response sent for successful and failed desktop bridge calls

### MCP Tests

Add tests for:

- tool list includes all expected preview tools
- each tool maps to internal bridge request
- token missing/invalid returns MCP error
- snapshot maps screenshot to MCP image content
- tool errors preserve tagged T3 error message

### Integration Tests

Add a focused integration test using mocked desktop client:

1. Start server broker.
2. Register fake desktop automation client.
3. Mark it focused for thread.
4. Invoke MCP `preview_open`.
5. Assert fake client received open request.
6. Respond success.
7. Assert MCP response is successful.

Add a second integration test:

1. No focused owner.
2. Invoke `preview_snapshot`.
3. Assert `PreviewAutomationNoFocusedOwnerError`.

## Validation Commands

Before completion:

- `vp check`
- `vp run typecheck`
- `vp test`

No `vp run lint:mobile` required unless mobile code is changed.

## Implementation Order

1. Add contracts for preview automation schemas and WS methods.
2. Add `PreviewAutomationBroker` server service.
3. Add WS stream bridge for desktop clients.
4. Add desktop IPC and `PreviewViewManager` CDP automation methods.
5. Add web ownership reporting and request handling.
6. Add private `/internal/preview-automation/tool` endpoint with scoped token auth.
7. Add `packages/preview-mcp` stdio MCP server.
8. Wire provider sessions to launch/register `t3-preview` MCP server where provider protocols support MCP config.
9. Add remote loopback URL warning.
10. Add tests.
11. Run validation commands.

## Assumptions

- v1 only supports Electron desktop preview clients.
- The active/focused thread preview is the right target for agent control.
- Manual client-reachable URLs are acceptable for remote dev servers.
- Full browser control includes `evaluate`.
- Stdio MCP is the agent-facing transport.
- A private server bridge behind the stdio MCP server is acceptable and necessary because the browser lives on the desktop client, not beside the remote agent.
