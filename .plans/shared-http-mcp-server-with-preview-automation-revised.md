# Shared HTTP MCP Server with Preview Automation

## Summary

Embed one reusable HTTP MCP server in each T3 environment server. Every agent session connects to that shared MCP endpoint using a session-scoped bearer token.

Preview browser automation is the first MCP toolkit, not the purpose or boundary of the MCP server. Future T3 toolkits register with the same server.

Architecture:

`agent session` -> `shared T3 HTTP MCP server` -> `tool dispatcher` -> `preview broker` -> `focused desktop client` -> `Electron webview via CDP`

No per-thread MCP process, stdio transport, headless browser, or automatic remote port forwarding.

## Process Model

Each `apps/server` process owns exactly one MCP server instance.

- MCP transport: HTTP.
- MCP endpoint: `/mcp`.
- MCP lifetime: environment server lifetime.
- Agent sessions create MCP protocol sessions/connections, not OS processes.
- Toolkit registration happens once during server startup.
- Provider session termination revokes only its scoped credential.

Implement the endpoint with:

```ts
McpServer.layerHttp({
  name: "T3 Code",
  version,
  path: "/mcp",
});
```

Use the API from:

`effect/unstable/ai/McpServer`

Reference source:

`.repos/effect-smol/packages/effect/src/unstable/ai/McpServer.ts`

Do not implement MCP framing, initialization, session management, or JSON-RPC manually.

## Invocation Identity

MCP `tools/call` does not include T3 thread identity. Bind identity to the MCP connection through authentication.

When starting or resuming a provider session, issue an opaque bearer token associated internally with:

```ts
interface McpInvocationScope {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  providerSessionId: string;
  providerInstanceId: ProviderInstanceId;
  allowedCapabilities: ReadonlySet<string>;
  issuedAt: string;
  expiresAt: string;
}
```

Provider MCP configuration:

```ts
{
  type: "http",
  name: "t3",
  url: `${environmentHttpBaseUrl}/mcp`,
  headers: [
    {
      name: "Authorization",
      value: `Bearer ${token}`,
    },
  ],
}
```

Requirements:

- Agents never receive or pass `threadId` as a tool argument.
- Tool handlers obtain `McpInvocationScope` from request authentication middleware.
- Tokens are cryptographically random opaque values.
- Store only a hash of each token server-side.
- Revoke tokens when the provider session stops.
- Expire tokens after inactivity and at a fixed maximum lifetime.
- Server restart invalidates all tokens.
- Resuming a provider session issues a fresh token.

## General MCP Architecture

Add server modules such as:

```text
apps/server/src/mcp/
  Services/
    McpSessionRegistry.ts
    McpInvocationContext.ts
  Layers/
    McpSessionRegistry.ts
    McpHttpServer.ts
  toolkits/
    preview/
      tools.ts
      handlers.ts
      layer.ts
```

### Toolkit Registration

Define capabilities with Effect AI:

```ts
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
```

Each capability family owns:

- `Tool.make` definitions
- a `Toolkit.make` collection
- handler services/layers
- an MCP registration layer

Server startup merges all registration layers:

```ts
const T3McpToolkits = Layer.mergeAll(
  PreviewToolkitRegistration,
  // Future toolkit registrations
);
```

Future filesystem, terminal, source-control, or environment tools must not require changes to MCP transport or authentication.

### Naming

Use stable capability-prefixed names:

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

## MCP Authentication

Integrate bearer authentication into the HTTP MCP route before MCP request handling.

Authentication flow:

1. Read `Authorization: Bearer <token>`.
2. Hash token and resolve it through `McpSessionRegistry`.
3. Verify expiration and provider-session liveness.
4. Provide `McpInvocationContext` to MCP toolkit handlers.
5. Reject invalid credentials without invoking MCP tools.
6. Update token activity timestamp after authenticated requests.

Capability authorization occurs inside handlers or common middleware:

```ts
yield* McpInvocationContext.requireCapability("preview");
```

## Preview Automation Contracts

Add `packages/contracts/src/previewAutomation.ts`.

Define schemas for:

- preview status
- opening/showing preview
- navigation
- page snapshot
- selector or coordinate click
- text entry
- key press
- scrolling
- JavaScript evaluation
- waiting for selector, text, or URL

Define tagged errors:

- `PreviewAutomationUnavailableError`
- `PreviewAutomationNoFocusedOwnerError`
- `PreviewAutomationUnsupportedClientError`
- `PreviewAutomationTabNotFoundError`
- `PreviewAutomationTimeoutError`
- `PreviewAutomationExecutionError`
- `PreviewAutomationInvalidSelectorError`
- `PreviewAutomationResultTooLargeError`

## Preview Toolkit

Implement preview tools as an independent Effect AI toolkit.

Apply annotations:

- `preview_status` and `preview_snapshot`: read-only
- `preview_status`: idempotent
- navigation and page interaction tools: open-world
- browser operations: non-destructive
- all tools: human-readable title and precise description

### `preview_open`

Input:

```ts
{
  url?: string;
  show?: boolean;
  reuseExistingTab?: boolean;
}
```

Defaults:

- `show: true`
- `reuseExistingTab: true`

Behavior:

- Show the preview panel for the scoped thread.
- Reuse its active preview tab when available.
- Create and mount a tab otherwise.
- Navigate when `url` is supplied.
- Wait until the webview has registered before returning.

### `preview_snapshot`

Return:

- current URL, title, loading state
- bounded visible text
- up to 200 interactive elements
- accessibility tree
- PNG screenshot scaled to a maximum width of 1280 pixels

Expose the screenshot as MCP image content and metadata as structured content.

### Browser Controls

- `preview_click`: selector or viewport coordinates
- `preview_type`: optionally focus selector and clear existing value
- `preview_press`: common keys and modifiers
- `preview_scroll`: viewport or selector target
- `preview_evaluate`: execute bounded JavaScript
- `preview_wait_for`: selector, visible text, or URL substring
- `preview_navigate`: navigate and wait for selected readiness condition

Default operation timeout: 15 seconds.

Maximum serialized evaluation result: 64 KB.

Maximum visible text: 20 KB.

## Preview Broker

Add `PreviewAutomationBroker` to `apps/server`.

Responsibilities:

- Track automation-capable desktop clients.
- Track preview ownership by environment and thread.
- Route operations to the correct desktop client.
- Correlate requests and responses.
- Enforce timeouts.
- Fail pending calls when clients disconnect.

Owner state:

```ts
interface PreviewAutomationOwner {
  clientId: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  tabId: PreviewTabId | null;
  visible: boolean;
  supportsAutomation: boolean;
  focusedAt: string;
}
```

Routing policy:

- Use the most recently focused Electron window displaying the scoped thread.
- Never accept environment or thread overrides from tool arguments.
- Return `PreviewAutomationNoFocusedOwnerError` when no valid owner exists.
- Do not switch the UI to a different thread automatically.

## Server-to-Desktop Protocol

Add WS RPCs:

- `previewAutomation.connect`
- `previewAutomation.respond`
- `previewAutomation.reportOwner`
- `previewAutomation.clearOwner`

`connect` is a long-lived stream from the environment server to the desktop client.

Request:

```ts
{
  requestId: string;
  threadId: ThreadId;
  tabId?: PreviewTabId;
  operation: PreviewAutomationOperation;
  input: unknown;
  timeoutMs: number;
}
```

Response:

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

## Desktop Automation

Extend `PreviewViewManager` using Electron `webContents.debugger`.

Use CDP domains:

- `Runtime`
- `DOM`
- `Page`
- `Accessibility`
- `Input`

Use `webContents.capturePage()` for screenshots.

Create a scoped CDP helper that:

1. Resolves the tab’s webContents.
2. Attaches lazily.
3. Enables required domains.
4. Executes one bounded operation.
5. Detaches in finalization.
6. Maps protocol failures to typed errors.

If DevTools or another debugger owns the target, return a typed automation error rather than disrupting it.

Place pure logic in separate modules:

- DOM summary extraction
- selector generation
- result clamping
- key mapping
- CDP response parsing

## Desktop IPC

Extend `DesktopPreviewBridge` with:

```ts
automation: {
  status(...): Promise<...>;
  snapshot(...): Promise<...>;
  click(...): Promise<...>;
  type(...): Promise<...>;
  press(...): Promise<...>;
  scroll(...): Promise<...>;
  evaluate(...): Promise<...>;
  waitFor(...): Promise<...>;
}
```

Add schema-validated IPC channels and handlers.

## Web Client

Add a preview ownership hook mounted with `PreviewView`.

Report changes to:

- active environment/thread
- tab id
- panel visibility
- window focus
- Electron automation availability

Handle broker requests:

- `preview_open` opens the right panel for the active scoped thread.
- Create a preview session and tab if needed.
- Wait for webview registration.
- Other operations invoke desktop automation IPC.
- Always send a correlated success or failure response.

Clear ownership on unmount, thread change, panel close, or desktop disconnect.

## Provider Integration

Add `McpSessionRegistry` integration to provider lifecycle.

For each provider session:

1. Issue a scoped MCP bearer token.
2. Add the shared HTTP MCP configuration to session startup.
3. Start or resume the agent session.
4. Revoke the token during provider-session finalization.

ACP providers use their existing HTTP MCP configuration fields.

Codex uses its supported MCP/config override mechanism to register the same shared HTTP endpoint.

Assume every supported provider can use HTTP MCP. Do not implement stdio fallback.

## Remote Environment Behavior

For a Mac mini environment viewed from a MacBook:

1. Mac mini runs the T3 environment server and shared MCP endpoint.
2. Agent session connects to that endpoint locally/remotely using its scoped token.
3. Preview tool calls enter the Mac mini preview broker.
4. Broker routes them over the existing T3 connection to the focused MacBook desktop.
5. MacBook controls its visible Electron webview.

URLs must already be reachable from the MacBook, such as:

- `http://mac-mini.local:5173`
- `http://192.168.1.42:5173`

Warn when a remote environment opens `localhost`, `127.0.0.1`, or `::1`, because loopback resolves on the preview client.

Preserve URL-resolution metadata:

```ts
{
  requestedUrl: string;
  resolvedUrl: string;
  resolutionKind: "direct";
  environmentId: EnvironmentId;
}
```

This leaves room for future SSH, relay, or Tailscale resolution.

## Tests

### MCP Server

- one MCP server layer starts per environment server
- multiple authenticated MCP clients share the same server instance
- each client receives its own invocation scope
- toolkit registration is independent of transport
- a mock future toolkit can register without changing server runtime
- malformed parameters are rejected by Effect schemas
- tool annotations appear in `tools/list`

### Authentication

- valid token resolves correct thread and provider session
- concurrent tokens remain isolated
- revoked and expired tokens fail
- token cannot call unauthorized capability family
- thread identity cannot be overridden in arguments
- server restart invalidates tokens

### Preview Broker

- focused owner receives operation
- most recently focused client wins
- wrong-thread client is never selected
- no owner returns typed error
- disconnect fails pending calls
- stale responses are ignored

### Desktop and Web

- agent can show and open preview
- webview registration is awaited
- CDP click, typing, key press, scroll, evaluation, and wait work
- snapshot bounds screenshot, text, and interactive elements
- ownership updates on focus and visibility changes
- background threads are not automatically activated

### End-to-End Integration

Run two mocked agent sessions against one HTTP MCP server:

1. Bind each bearer token to a different thread.
2. Call `preview_status` concurrently.
3. Verify each request routes to its own focused preview owner.
4. Verify no MCP child process is spawned.
5. Revoke one provider session and confirm only its MCP access fails.

## Validation

- `vp check`
- `vp run typecheck`
- `vp test`

## Assumptions

- HTTP MCP is supported by every target provider.
- One MCP server is embedded in each T3 environment server.
- MCP connection authentication supplies invocation identity.
- Agents never know or pass T3 thread IDs.
- Preview automation is the first of multiple future MCP toolkits.
- Only Electron desktop preview clients support browser automation in v1.
- No headless browser, stdio fallback, or automatic tunnel management is included.
