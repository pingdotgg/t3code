# T3 Code for VS Code

Experimental VS Code shell for T3 Code. It starts a local T3 backend, injects a host bridge into the existing T3 web UI, and renders that UI in a sidebar or custom editor webview.

Build a local VSIX from the repository root:

```sh
bun run --filter t3code-vscode package
```

Install the generated `.vsix` with VS Code's "Install from VSIX..." command, or from the repository root:

```sh
code --install-extension $(ls -t apps/vscode-extension/*.vsix | head -1)
```

## Auth Transport

VS Code webviews use bearer auth for the extension-owned local backend, not browser cookies. The extension starts the backend with a one-time desktop bootstrap token, exchanges that token for a bearer session from the extension host, and injects the bearer token through `window.t3HostBridge`.

The web app then sends authenticated HTTP requests with an `Authorization: Bearer ...` header and requests short-lived WebSocket tokens before opening `/ws`. This avoids relying on cross-origin cookie behavior between the VS Code webview origin and the loopback backend.

## Implementation Status

Current status: locally installable experimental VSIX exists and uses stable VS Code APIs only.

Implemented so far:

- Created the `apps/vscode-extension` workspace package with `package.json`, `src/extension.ts`, `src/backendManager.ts`, `src/webview.ts`, `tsdown.config.ts`, build scripts, package scripts, and a minimal SVG icon.
- Added extension commands:
  - `t3code.open`
  - `t3code.newThread`
  - `t3code.restartBackend`
- Added a stable Activity Bar view container and webview view:
  - `t3code.sidebarView`
- Added custom editor contribution and provider:
  - `t3code.conversationEditor`
  - virtual resources shaped like `t3-code://route/local/new`
- Added a backend process manager that:
  - chooses the active workspace folder or first workspace folder as `cwd`
  - allocates a loopback port
  - generates a bootstrap token
  - writes a desktop-compatible bootstrap envelope through fd 3
  - exchanges the bootstrap token for a VS Code bearer session after backend readiness
  - starts the bundled `dist/server/bin.mjs` with `ELECTRON_RUN_AS_NODE=1`
  - falls back to a development checkout command when no bundled server exists
  - supports user-configurable server command, args, cwd, and T3 home
  - polls `/.well-known/t3/environment` with a per-request timeout
  - terminates the backend on extension disposal
- Added a neutral host bridge contract:
  - `T3HostBridge`
  - `window.t3HostBridge`
- Updated the web app to:
  - prefer `window.t3HostBridge.getLocalEnvironmentBootstrap()`
  - fall back to `window.desktopBridge.getLocalEnvironmentBootstrap()`
  - use hash history in VS Code webviews
  - read bootstrap credentials from either bridge
  - use host-injected bearer auth for VS Code webview HTTP and WebSocket startup
  - read and write `ClientSettings` through `window.t3HostBridge` when no desktop bridge is present
  - support `VITE_BASE_URL` so extension-local web assets can be built with relative paths
- Added webview rendering that:
  - reads extension-local `dist/webview/index.html`
  - injects a `<base>` tag using `webview.asWebviewUri(...)`
  - injects `window.t3HostBridge`
  - handles neutral host bridge requests for shared client settings persistence
  - initializes the hash route
  - applies a restrictive CSP with local backend HTTP and WebSocket connect sources
- Added shared T3 Code app `ClientSettings` persistence for VS Code:
  - persists to `<T3 home>/userdata/client-settings.json`
  - uses the same raw client-settings file format as desktop
  - preserves browser/localStorage fallback when no host persistence API is available
- Added packaging that:
  - builds `apps/web`
  - builds `apps/server`
  - builds the extension host bundle
  - copies `apps/web/dist` to `apps/vscode-extension/dist/webview`
  - copies `apps/server/dist` to `apps/vscode-extension/dist/server`
  - stages extension runtime dependencies under `apps/vscode-extension/dist/node_modules`
  - creates `apps/vscode-extension/t3code-vscode-0.0.1.vsix`
- Verified:
  - `bun fmt`
  - `bun lint` (passes with existing unrelated warnings)
  - `bun typecheck`
  - `bun run --filter t3code-vscode package`
  - manual bundled-backend readiness smoke test

Not implemented yet:

- Proposed `chatSessionsProvider` integration.
- `chatSessions/newSession` menu contribution.
- Listing recent T3 threads as VS Code chat session items.
- Thread-specific route reconstruction in the custom editor. The custom editor currently opens the T3 chat index route.
- Webview-to-extension host actions beyond a basic `postMessage` bridge hook.
- Add current file/selection to T3 Code.
- Reveal/open file host actions.
- VS Code theme/font propagation into the web UI.
- Platform-specific VSIX build matrix.
- Package size optimization.
- Marketplace publishing hardening.

Known packaging notes:

- The generated VSIX is intentionally gitignored.
- Extension build output under `apps/vscode-extension/dist` is intentionally gitignored.
- The current local VSIX includes staged runtime dependencies and is large. The initial working artifact was around 119 MB on macOS arm64.
- `bun install --production` reports a blocked `node-pty` postinstall in the staged extension runtime, but the installed package includes `node-pty` prebuilds for macOS and Windows. Linux packaging still needs explicit validation.
- The current package is not yet platform-targeted with `vsce --target`.

## Decision Log

### 2026-05-14: Use Stable Webview Surfaces First

Decision: implement the stable sidebar/custom-editor extension shell before proposed chat-session APIs.

Reasoning:

- The plan identifies `chatSessionsProvider` as proposed and unstable.
- A stable webview shell lets us validate backend startup, bootstrap auth, webview CSP, asset loading, and the existing T3 UI in VS Code first.
- This keeps experimentation installable in normal VS Code without proposed API flags.

Deviation from original plan:

- Strategy 1 remains the product direction, but Phase 6 is deferred.
- The current artifact is closer to Strategy 2 plus the backend/webview pieces of Strategy 1.

### 2026-05-14: Introduce `window.t3HostBridge`

Decision: add a neutral `T3HostBridge` instead of making the VS Code webview impersonate Electron's `desktopBridge`.

Reasoning:

- VS Code is not Electron desktop from the app's perspective, even if VS Code itself runs on Electron.
- A neutral bridge matches the preferred design in the plan and leaves `desktopBridge` for desktop-specific APIs.
- The web app still falls back to `desktopBridge` for compatibility.

Implemented as planned:

- `packages/contracts/src/ipc.ts` defines `T3HostBridge`.
- `apps/web/src/environments/primary/target.ts` and `auth.ts` read `t3HostBridge` first.
- `apps/web/src/main.tsx` uses hash routing when `isVscodeWebview` is true.

### 2026-05-14: Reuse Desktop Bootstrap Transport

Decision: start the T3 backend with `--bootstrap-fd 3` and pass a desktop-compatible bootstrap envelope.

Reasoning:

- The server already supports this flow.
- It avoids a parallel auth/bootstrap design.
- The web app can exchange the injected bootstrap token through the existing `/api/auth/bootstrap` endpoint.

Implemented as planned:

- The extension generates a bootstrap token.
- The extension writes `mode`, `noBrowser`, `port`, `t3Home`, `host`, `desktopBootstrapToken`, and Tailscale fields to fd 3.
- The webview injects the token through `window.t3HostBridge.getLocalEnvironmentBootstrap()`.

Deviation from original plan:

- The extension currently defines the bootstrap payload shape locally instead of importing `DesktopBackendBootstrap` from `@t3tools/contracts`. This avoids pulling schema/runtime dependencies into the extension host bundle for the first prototype.

### 2026-05-14: Start One Backend for the Active Workspace

Decision: use one extension-owned backend process based on the active editor's workspace folder, falling back to the first workspace folder or the user home directory.

Reasoning:

- This satisfies the initial single-workspace experimentation path with minimal server churn.
- It keeps the process manager small while preserving room for a future multi-root backend registry.

Deviation from original plan:

- The backend manager is not yet a full one-process-per-workspace registry.
- Multi-root workspace behavior is basic.

### 2026-05-14: Package Staged Runtime Dependencies

Decision: stage runtime dependencies under `apps/vscode-extension/dist/node_modules` and package with `vsce --no-dependencies`.

Reasoning:

- The server bundle still has external imports such as `effect`, `@effect/platform-node`, `@opencode-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@pierre/diffs`, and `node-pty`.
- Letting `vsce` discover dependencies directly from the monorepo pulled unrelated files and failed while parsing unrelated markdown.
- Controlled staging produces an installable local VSIX.

Deviation from original plan:

- Packaging is not yet optimized.
- The current VSIX is not platform-specific, although platform-specific VSIXs are still the recommended direction if `node-pty` remains required.

### 2026-05-14: Keep Built Artifacts Out of Git

Decision: ignore extension VSIX files and extension build outputs.

Reasoning:

- The VSIX and `dist` content are generated artifacts.
- The package can be rebuilt from source with `bun run --filter t3code-vscode package`.
- Keeping generated assets out of git keeps the extension source package reviewable.

### 2026-05-14: Share T3 Code Client Settings Through T3 Home

Decision: keep favorite models and other UI-only preferences in `ClientSettings`, and have the VS Code extension persist them to the same shared T3 home source as desktop.

Reasoning:

- The existing app settings model deliberately separates server-authoritative settings from client-only settings.
- `ServerSettings` owns backend-affecting behavior such as provider settings, provider instances, binary paths, custom models, default environment mode, and observability settings.
- `ClientSettings` owns UI preferences such as favorite models, model ordering/visibility preferences, timestamp format, sidebar preferences, diff preferences, and confirmation toggles.
- Moving favorites into `ServerSettings` would blur that documented boundary.
- The extension should not introduce a separate VS Code-only preference environment for T3 Code app settings when it is attached to the same T3 home as desktop.

Implementation direction:

- Add a neutral host/backend persistence path for `ClientSettings` that VS Code can use without changing the existing desktop behavior. Implemented through `window.t3HostBridge.getClientSettings()` and `window.t3HostBridge.setClientSettings(...)`.
- Persist VS Code `ClientSettings` under the same T3 home state directory as desktop. Implemented at `<T3 home>/userdata/client-settings.json`.
- Use the same behavior on all extension platform targets. The only platform-specific difference should be path syntax and the OS user-home location.
- Preserve the server/client settings boundary: shared client settings should not be folded into `settings.json` or the `ServerSettings` schema.
- Keep the existing web app fallback behavior for non-hosted/browser contexts: when no host persistence API is available, browser storage remains the fallback.
- Desktop should continue using its existing `window.desktopBridge` persistence path and file format.

## Plan

## Goal

Create a VS Code extension for T3 Code that adds a "T3 Code" experience to VS Code's chat/session surface and renders the existing T3 Code UI there instead of building a separate native chat interface.

The intended reference implementation is the installed Codex extension at:

```text
~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64
```

The chosen plan is to follow the first strategy from the research: build a Codex-like VS Code extension shell that contributes a T3 Code chat session type, starts/manages the existing T3 backend, and hosts the existing React web UI in VS Code webviews/custom editors.

## Key Findings

### Codex Extension Architecture

The installed Codex extension does not appear to replace VS Code's native Chat UI by injecting arbitrary React content directly into `workbench.panel.chat`. Instead, it combines proposed chat-session APIs with webview-backed UI surfaces.

Relevant Codex package references:

- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:25`
  - Activation events include `onStartupFinished` and `onUri`.
- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:30`
  - Enables proposed APIs:
    - `chatSessionsProvider`
    - `languageModelProxy`
- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:173`
  - Contributes VS Code view containers in the activity bar and secondary sidebar.
- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:191`
  - Contributes webview views:
    - `chatgpt.sidebarView`
    - `chatgpt.sidebarSecondaryView`
- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:209`
  - Contributes a custom editor:
    - `viewType: chatgpt.conversationEditor`
    - `filenamePattern: openai-codex:/**/*`
- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:255`
  - Contributes a `chatSessions/newSession` menu entry.
- `~/.vscode/extensions/openai.chatgpt-26.506.31421-darwin-arm64/package.json:262`
  - Contributes a chat session type:
    - `type: openai-codex`
    - `name: Codex`
    - `displayName: OpenAI Codex`

Relevant Codex extension bundle findings:

- `out/extension.js` registers webview providers with `vscode.window.registerWebviewViewProvider(...)`.
- `out/extension.js` registers the custom editor with `vscode.window.registerCustomEditorProvider(...)`.
- `out/extension.js` registers chat session items with `vscode.chat.registerChatSessionItemProvider(...)`.
- Codex creates `openai-codex:` URIs for conversations and uses those resources with the custom editor.
- Codex's webview content is loaded from an extension-local `webview/index.html`, then patched with:
  - a `<base href="...">` using `webview.asWebviewUri(...)`
  - a Content Security Policy
  - extension/session/build metadata tags

Important conclusion: the closest practical target is not "replace the built-in Chat panel DOM." It is "integrate with VS Code's chat session surface while opening/rendering T3 Code's real UI through webview/custom-editor surfaces," as Codex does.

### T3 Code Architecture Fit

The current T3 Code repo is already close to this shape because it has a clean web/server split:

- `apps/server`
  - Node server and CLI package named `t3`.
  - Hosts HTTP, WebSocket RPC, auth, persistence, provider runtimes, and static web serving.
- `apps/web`
  - React/Vite UI.
  - Owns the session/thread UX.
  - Connects to the backend through HTTP and WebSocket.
- `apps/desktop`
  - Existing Electron shell that already solves several host-shell problems relevant to VS Code.

Relevant T3 references:

- `apps/web/src/main.tsx:14`
  - Electron uses hash history because file-backed shells cannot rely on normal browser routing.
  - VS Code webviews likely need the same behavior.
- `apps/web/src/environments/primary/target.ts:65`
  - The web app can use configured `VITE_HTTP_URL` / `VITE_WS_URL`.
- `apps/web/src/environments/primary/target.ts:112`
  - The web app can use `window.desktopBridge.getLocalEnvironmentBootstrap()` to get local backend URLs.
- `apps/web/src/environments/primary/auth.ts:87`
  - The web app reads `bootstrapToken` from `window.desktopBridge.getLocalEnvironmentBootstrap()`.
- `apps/web/src/environments/primary/auth.ts:148`
  - The web app exchanges a bootstrap credential through `/api/auth/bootstrap`.
- `packages/contracts/src/desktopBootstrap.ts:5`
  - Existing bootstrap envelope schema includes:
    - `mode`
    - `noBrowser`
    - `port`
    - `t3Home`
    - `host`
    - `desktopBootstrapToken`
    - Tailscale/observability settings
- `apps/server/src/cli/config.ts:234`
  - Server can read the bootstrap envelope from `--bootstrap-fd`.
- `apps/server/src/auth/http.ts:68`
  - `/api/auth/bootstrap` exchanges the bootstrap credential and sets the session cookie.
- `apps/server/src/http.ts:246`
  - Server serves the built web app and falls back to `index.html` for SPA routes.
- `apps/web/vite.config.ts:81`
  - Web build currently injects selected runtime config through Vite `define`.

### T3 Code App Settings Persistence Strategy

The T3 Code app has two settings domains that the VS Code extension should preserve:

- Server-authoritative settings live in backend state as `settings.json`.
  - Implemented by `apps/server/src/serverSettings.ts`.
  - The path is derived from the T3 home state directory, usually `~/.t3/userdata/settings.json` in production.
  - These settings affect backend/runtime behavior: provider settings, provider instances, binary paths, custom models, default environment mode, observability settings, and related server behavior.
- Client-only app settings use `ClientSettings`.
  - Defined in `packages/contracts/src/settings.ts`.
  - Includes favorite models, provider model ordering/visibility preferences, timestamp format, sidebar preferences, diff preferences, and confirmation toggles.
  - The web app's `useSettings` hook intentionally merges server settings with client settings while routing writes to the correct backing store.

Desktop currently persists `ClientSettings` through `window.desktopBridge` to the desktop state directory, usually:

```text
~/.t3/userdata/client-settings.json
```

Default production paths by platform:

| Platform | Default T3 home       | Server settings                              | Client settings                                     |
| -------- | --------------------- | -------------------------------------------- | --------------------------------------------------- |
| macOS    | `/Users/<user>/.t3`   | `/Users/<user>/.t3/userdata/settings.json`   | `/Users/<user>/.t3/userdata/client-settings.json`   |
| Linux    | `/home/<user>/.t3`    | `/home/<user>/.t3/userdata/settings.json`    | `/home/<user>/.t3/userdata/client-settings.json`    |
| Windows  | `C:\Users\<user>\.t3` | `C:\Users\<user>\.t3\userdata\settings.json` | `C:\Users\<user>\.t3\userdata\client-settings.json` |

If `T3CODE_HOME`, `--base-dir`, or the extension's `t3code.home` setting points at a custom T3 home, the same rule applies under that custom home:

```text
<T3 home>/userdata/settings.json
<T3 home>/userdata/client-settings.json
```

The VS Code extension should provide an equivalent `ClientSettings` persistence capability through the neutral host/backend integration rather than creating a VS Code-only source of truth. When the VS Code extension uses the same T3 home as desktop, favorite models and other `ClientSettings` should come from the same shared T3 home state source.

Expected implementation impact:

- Desktop behavior should not change. It should keep using the existing `window.desktopBridge` persistence path and `client-settings.json` format.
- The extension behavior should be the same across macOS, Linux, and Windows; platform-specific code should only resolve the default user home and normalize paths.
- Browser/web app fallback behavior should not change. When no host persistence API is available, browser storage remains the fallback:

```text
t3code:client-settings:v1
```

- The VS Code extension should add the missing hosted persistence path so it does not fall into the browser-storage fallback for normal extension usage.
- `ClientSettings` remains the owner of favorite models and other UI-only preferences. These preferences should not move into `ServerSettings` or `settings.json`.

### Why a Host Bridge Is Needed

Today the web app only knows how to receive host-provided local backend info from `window.desktopBridge`.

In Electron, the preload script injects that bridge. In a VS Code webview, there is no Electron preload and no `window.desktopBridge` unless the extension provides one.

The VS Code extension needs to provide equivalent information:

- The local T3 backend HTTP URL.
- The local T3 backend WebSocket URL.
- The bootstrap token used for silent auth.
- Host actions such as open file, reveal path, execute VS Code command, or report focus/theme state.

There are two viable bridge designs:

1. Minimal compatibility shim:
   - Have the VS Code webview inject a compatible `window.desktopBridge.getLocalEnvironmentBootstrap()` implementation.
   - Fastest path, but semantically odd because the host is not Electron desktop.

2. Preferred maintainable design:
   - Introduce a neutral bridge such as `window.t3HostBridge`.
   - Both Electron and VS Code implement shared host capabilities.
   - Keep `window.desktopBridge` only for Electron-specific APIs.

The preferred design is to generalize host bootstrap behind a neutral bridge while retaining backward compatibility with `desktopBridge` during migration.

## Viable Strategies Considered

### Strategy 1: Codex-Like Extension Shell

This is the chosen plan.

Create a new workspace package, likely:

```text
apps/vscode-extension
```

The extension would package:

- Extension host code.
- Built `apps/web/dist` assets.
- A way to run the T3 backend:
  - either bundled built `apps/server/dist`
  - or a resolved `t3` executable
  - or a development-mode command for local extension development

The extension would contribute:

- `chatSessions` type, e.g. `t3-code`
- `chatSessions/newSession` menu command
- Custom editor for resources like `t3-code:/**/*`
- Optional webview view in secondary sidebar/activity bar as a stable fallback
- Commands:
  - Open T3 Code
  - New T3 Code thread
  - Add current file/selection to T3 Code
  - Open selected thread/session

The extension runtime would:

- Start a T3 backend process for the current workspace.
- Pass a bootstrap envelope through fd 3, reusing the existing desktop bootstrap flow.
- Wait for backend readiness.
- Create a VS Code webview/custom editor.
- Inject host/bootstrap metadata into the webview.
- Serve local web assets via `webview.asWebviewUri(...)`.
- Apply a strict Content Security Policy.
- Route webview messages to VS Code commands and server lifecycle operations.

Recommended URI shape:

```text
t3-code://route/local/<threadId>
t3-code://route/local/new
t3-code://route/project/<projectId>
```

Pros:

- Closest to Codex.
- Reuses the real T3 Code UI rather than building a second UI.
- Allows VS Code chat-session integration.
- Keeps T3's server/web architecture intact.
- Can support rich T3 features that native VS Code Chat primitives cannot represent well.

Cons:

- `chatSessionsProvider` is a proposed VS Code API and may be unstable.
- Publishing to the Marketplace may be constrained if proposed APIs are required.
- Requires a robust extension-side process manager.
- Requires webview-specific auth/bootstrap and routing hardening.

### Strategy 2: Stable Webview View Only

Use only stable VS Code APIs:

- `viewsContainers`
- `views`
- `WebviewViewProvider`
- commands

The extension would still launch the backend and host the T3 UI, but it would not integrate deeply with VS Code's Chat Sessions surface.

Pros:

- Much lower risk.
- Easier to publish.
- Useful fallback even if Strategy 1's proposed APIs are unavailable.

Cons:

- Does not create a native Chat panel/session entry.
- Less similar to the Codex user experience.

Recommended use: implement as a fallback inside Strategy 1.

### Strategy 3: Localhost UI Wrapper

Start `t3`, then point a VS Code webview at `http://127.0.0.1:<port>` or iframe that app.

Pros:

- Fastest prototype.
- Minimal changes to the web app.

Cons:

- Weak production posture.
- More brittle around cookies, iframe rules, CSP, webview origins, localhost permissions, and asset loading.
- Worse security story than extension-local assets with `webview.asWebviewUri(...)`.

Recommended use: prototype only.

### Strategy 4: Native VS Code Chat Participant

Use VS Code's native chat participant model and re-render T3 conversations as VS Code chat messages.

Pros:

- Most native VS Code feel.

Cons:

- Does not satisfy the requirement to show the existing T3 Code UI.
- Requires duplicating the T3 UI model.
- Cannot naturally represent T3's richer interaction surfaces such as terminal drawers, approval flows, provider controls, source-control views, settings, and diagnostics.

Recommended use: not recommended for this goal.

## Chosen Plan

Proceed with Strategy 1: Codex-like extension shell.

The implementation should still include the stable webview view from Strategy 2 as a fallback, because the chat session integration relies on proposed VS Code APIs.

Confirmed product direction:

- The target UX is Codex-like. It does not need to literally replace VS Code's built-in Chat panel DOM.
- A T3 Code chat-session entry plus webview/custom-editor backed T3 UI is acceptable and is the plan.
- Prefer one backend process per VS Code workspace if that can be achieved with minimal churn to the existing T3 codebase.
- Use the same T3 home as desktop for now. Reassess after experimenting.
- Remote workspaces, SSH, and devcontainers are desirable for v1 only if they can be supported with minimal churn.
- Use best judgement on auth transport. The implementation should fit the existing auth/bootstrap model rather than introduce a large parallel auth design.

## Proposed Implementation Phases

### Phase 1: Extension Package Skeleton

Create a new package:

```text
apps/vscode-extension
```

Initial contents:

- `package.json`
- `src/extension.ts`
- build config, likely `tsdown`
- VS Code extension development tasks
- extension assets/icons

Contribution points:

- command: `t3code.open`
- command: `t3code.newThread`
- webview view: `t3code.sidebarView`
- optional custom editor: `t3code.conversationEditor`

Do this first with stable APIs only.

### Phase 2: Backend Process Manager

Add an extension-side service that:

- Resolves workspace folder and cwd.
- Allocates a local port.
- Generates a desktop-style bootstrap token.
- Starts the T3 backend with `--bootstrap-fd 3`.
- Writes a `DesktopBackendBootstrap` payload to fd 3.
- Polls health/auth readiness.
- Restarts on failure where appropriate.
- Cleans up on extension deactivation.

Reuse the existing server bootstrap shape from `packages/contracts/src/desktopBootstrap.ts`.

Process ownership decision:

- Target model: one T3 backend process per VS Code workspace.
- Constraint: only do this if it does not require large changes to the existing server/runtime model.
- Fallback model: one extension-owned backend process that can host multiple T3 projects, using current server capabilities.
- Initial implementation should map one VS Code workspace folder to one backend process.
- For multi-root workspaces, start with the active workspace folder or first folder, then improve once the basic extension works.
- Keep the backend manager abstraction capable of either model so this can change after experimentation.

Likely T3 server command shape:

```text
node <extension-server-dist>/bin.mjs --bootstrap-fd 3 <workspace-cwd>
```

Development mode may use:

```text
bun --cwd apps/server dev --bootstrap-fd 3 <workspace-cwd>
```

Production mode should prefer a packaged JS artifact, not depend on Bun being installed by the user.

### Phase 3: Webview Host Bridge

Introduce a host-neutral bridge.

Suggested type:

```ts
interface T3HostBridge {
  getLocalEnvironmentBootstrap(): {
    label: string;
    httpBaseUrl: string | null;
    wsBaseUrl: string | null;
    bootstrapToken?: string;
  } | null;
}
```

Web app changes:

- Read `window.t3HostBridge` first.
- Fall back to `window.desktopBridge`.
- Use hash history when running inside VS Code webview.
- Add a small host-environment detector, e.g. `isVscodeWebview`.

Extension webview changes:

- Inject a script before the main web bundle that defines `window.t3HostBridge`.
- Wire VS Code `postMessage` for future host actions.

Auth/bootstrap decision:

- Reuse the existing bootstrap flow where practical.
- The VS Code extension should provide local backend URLs and a bootstrap token to the web app.
- The web app should exchange the bootstrap token through the existing `/api/auth/bootstrap` route unless VS Code webview cookie behavior proves unreliable.
- If cookie auth is unreliable in VS Code webviews, prefer the existing bearer-session path over inventing a new auth layer.
- Avoid a host-mediated RPC auth proxy unless needed; it would add more extension-specific logic than the current codebase appears to require.

### Phase 4: Bundle and Load Existing UI

Build `apps/web` into extension-local assets.

The webview provider should:

- Read `webview/index.html`.
- Replace or inject `<base href="${webview.asWebviewUri(webRoot)}/">`.
- Add a CSP similar to Codex:
  - `default-src 'none'`
  - `img-src ${webview.cspSource} https: data: blob:`
  - `script-src ${webview.cspSource}`
  - `style-src ${webview.cspSource} 'unsafe-inline'`
  - `font-src ${webview.cspSource}`
  - `connect-src ${webview.cspSource} http://127.0.0.1:<port> ws://127.0.0.1:<port>`
- Inject metadata:
  - backend HTTP URL
  - backend WS URL
  - bootstrap token
  - workspace id/cwd
  - initial route/thread id

### Phase 5: Custom Editor and Session Routing

Add custom editor support:

```json
{
  "viewType": "t3code.conversationEditor",
  "displayName": "T3 Code Thread",
  "priority": "default",
  "selector": [
    {
      "filenamePattern": "t3-code:/**/*"
    }
  ]
}
```

Open thread/session resources as virtual URIs:

```text
t3-code://route/local/<threadId>
```

When the custom editor opens, initialize the React app route to:

```text
/_chat/<environmentId>/<threadId>
```

or the equivalent hash route.

### Phase 6: Chat Sessions Integration

Add Codex-like chat sessions contribution:

```json
"enabledApiProposals": ["chatSessionsProvider"],
"contributes": {
  "chatSessions": [
    {
      "type": "t3-code",
      "name": "T3 Code",
      "displayName": "T3 Code",
      "description": "T3 Code integration for VS Code"
    }
  ],
  "menus": {
    "chatSessions/newSession": [
      {
        "command": "t3code.newThread",
        "when": "chatSessionType == t3-code"
      }
    ]
  }
}
```

Register a `ChatSessionItemProvider` from extension activation.

Provider responsibilities:

- List recent T3 threads from the backend.
- Convert T3 thread summaries to VS Code chat session items.
- Use `t3-code:` URIs as item resources.
- Track running/completed/error status where possible.
- Fire change events when the backend emits thread lifecycle changes.

Risk:

- This relies on proposed VS Code APIs. Keep the stable sidebar/custom-editor path independently functional.

### Phase 7: VS Code Host Actions

Add webview-to-extension messages for:

- Open file at line/column in VS Code.
- Reveal file in explorer.
- Add active editor/selection as context.
- Get active workspace folders.
- Execute extension commands.
- Reflect VS Code theme/font settings.
- Clipboard support if needed.

Avoid coupling these to Electron APIs. Route through the neutral `t3HostBridge` / webview message layer.

### Phase 8: Packaging

Decide how to package the backend.

Preferred:

- Build `apps/server` into JS artifacts.
- Include them in the VSIX.
- Run with VS Code's extension host Node or a child Node executable.

Concerns:

- Native dependency `node-pty` may require platform-specific VSIX builds.
- The current Codex extension is platform-specific (`darwin-arm64`), which is a useful precedent.
- If T3 Code needs native PTY support, the VS Code extension likely needs platform-specific packaging too.

Marketplace/platform-specific finding:

- Published VS Code extensions can have multiple platform-specific VSIX packages.
- Official VS Code docs state that platform-specific extensions are supported and are useful for native node modules.
- VS Code chooses the package matching the current platform.
- Current supported targets include `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `linux-armhf`, `alpine-x64`, `alpine-arm64`, `darwin-x64`, `darwin-arm64`, and `web`.
- `vsce` supports `--target`.

Example commands:

```text
vsce package --target darwin-arm64
vsce publish --packagePath PATH_TO_DARWIN_ARM64_VSIX
```

```text
vsce publish --target win32-x64 win32-arm64
```

Packaging recommendation:

- Assume platform-specific VSIX builds are viable.
- Start with the local development platform first.
- Add CI targets for macOS arm64/x64, Linux x64/arm64, and Windows x64/arm64 once the extension works.
- Use a universal fallback only if the backend can avoid native dependencies or ship optional native binaries cleanly.
- If `node-pty` remains required at runtime, platform-specific VSIXs are the cleaner distribution model.
