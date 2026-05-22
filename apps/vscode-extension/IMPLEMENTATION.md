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

Build a platform-targeted VSIX:

```sh
bun run --filter t3code-vscode package -- --target darwin-arm64 --out release-publish/t3code-vscode-darwin-arm64.vsix
```

Local packages use the temporary publisher id `t3tools` when `VSCE_PUBLISHER` is not set. For Marketplace publishing, the release workflow uses `@vscode/vsce` with a Visual Studio Marketplace Personal Access Token. Configure the GitHub repository variable `VSCE_PUBLISHER` with the Marketplace publisher id and the GitHub secret `VSCE_PAT` with a token that can publish for that publisher. Stable releases publish normal VSIX packages, and nightly/prerelease releases publish with `--pre-release`.

## Auth Transport

VS Code webviews use bearer auth for the extension-owned local backend, not browser cookies. The extension starts the backend with a one-time desktop bootstrap token, exchanges that token for a bearer session from the extension host, and injects the bearer token through `window.t3HostBridge`.

The web app then sends authenticated HTTP requests with an `Authorization: Bearer ...` header and requests short-lived WebSocket tokens before opening `/ws`. This avoids relying on cross-origin cookie behavior between the VS Code webview origin and the loopback backend.

## VS Code MCP Bridge

The VS Code extension exposes VS Code-backed tools through a local MCP server owned by the extension host. The bridge is enabled by the extension setting:

- `t3code.mcp.enabled`
- `t3code.mcp.toolTimeoutSec`
- `t3code.mcp.allowedRunCommands`
- `t3code.mcp.allowedActivateExtensions`

The bridge setting defaults to `true`, the tool timeout setting defaults to `120` seconds, the `vscodeRunCommand` allowlist defaults to `t3code.*`, `vscode.open`, `vscode.diff`, and `revealLine`, and extension activation is disabled by default. When enabled, each VS Code window starts a temporary local socket server with a unique `t3code-vscode-*` name and includes `{ name, socketPath, toolTimeoutSec }` in the desktop bootstrap envelope. The backend converts that metadata into each provider's MCP configuration shape. The per-window name avoids same-named MCP server collisions when multiple VS Code windows are running agents at the same time.

The extension MCP server is generic, so that provider integrations translate the same bootstrap MCP server list into their provider-native MCP/tool configuration.

Provider mappings:

- Codex receives `mcp_servers` thread config. `t3code.mcp.toolTimeoutSec` is passed as Codex `tool_timeout_sec`.
- Claude Code receives SDK `mcpServers` entries. The current SDK shape supports stdio MCP server config but does not expose an equivalent per-tool-call timeout field.
- OpenCode local sessions receive `OPENCODE_CONFIG_CONTENT` with `mcp.<name>` local server entries. `t3code.mcp.toolTimeoutSec` maps to OpenCode's `timeout` field in milliseconds, which controls MCP tool discovery/fetch timeout rather than Codex-style tool-call timeout. Externally managed OpenCode servers cannot be injected by this backend because they are already running outside the session bootstrap.
- Cursor receives ACP `mcpServers` on session create/load. ACP's stdio MCP server schema does not expose an equivalent per-tool-call timeout field.
- Claude Code, OpenCode, and Cursor mappings use the T3 server's `stdio-to-uds` relay command to connect provider-managed stdio MCP clients back to the VS Code extension-owned socket. The relay config includes `ELECTRON_RUN_AS_NODE=1` so packaged VS Code/Electron extension launches execute the backend entrypoint as Node. Codex keeps using the Codex CLI `stdio-to-uds` relay because that path is known to work with Codex app-server MCP startup.

The current supported MCP tools are:

- `vscodeDiagnostics`: returns diagnostics currently known to VS Code, including language-server and extension diagnostics.
- `vscodeReferences`: finds references for a file position through VS Code language providers.
- `vscodeWorkspaceSymbols`: searches workspace symbols through VS Code language providers.
- `vscodeRunCommand`: executes an allowed registered VS Code command through `vscode.commands.executeCommand(...)` and returns a JSON-safe result.

`vscodeRunCommand` accepts:

```json
{
  "command": "vscode.open",
  "args": [{ "$vscode": "Uri", "path": "/absolute/path/to/file.ts" }],
  "activateExtension": "publisher.extension-id"
}
```

`activateExtension` is optional and expects an installed extension id. When provided, `vscodeRunCommand` first rejects internal or command-disallowed requests, then verifies the extension id is listed in `t3code.mcp.allowedActivateExtensions` before calling `vscode.extensions.getExtension(...).activate()`. Registration is checked afterward with `vscode.commands.getCommands(true)`, which supports extensions that register commands during activation without letting MCP activate arbitrary installed extensions by default. `vscodeRunCommand` hydrates supported JSON encodings for VS Code `Uri`, `Position`, and `Range` arguments, and serializes command return values into bounded JSON-safe values. The command policy is configured by `t3code.mcp.allowedRunCommands`; entries ending in `*` are treated as non-empty command-prefix rules, and the default list is `t3code.*`, `vscode.open`, `vscode.diff`, and `revealLine`. Extension activation is disabled by default because `t3code.mcp.allowedActivateExtensions` defaults to an empty list. The language-service tools return bounded JSON-safe result sets with truncation metadata.

## VS Code Webview UI Defaults

The VS Code webview hides T3 Code controls that duplicate VS Code-native surfaces:

- Open/reveal picker: VS Code already owns editor and file-reveal actions.
- Checkout mode indicator: VS Code already shows the active workspace/checkouts.
- Branch/ref selector: VS Code already owns branch/ref selection through its source-control UI.
- T3 Code terminal drawer: VS Code already owns terminal surfaces.
- Project management chrome: VS Code already scopes the webview to the active workspace folders.

Each control can be restored individually with extension settings:

- `t3code.ui.showOpenInPicker`
- `t3code.ui.showCheckoutModeIndicator`
- `t3code.ui.showBranchSelector`
- `t3code.ui.enableTerminal`

The VS Code webview can also customize chat width with:

- `t3code.ui.threadConversationMaxWidth`

The first four settings default to `false`; `t3code.ui.threadConversationMaxWidth` defaults to an empty value, which keeps the React app's normal conversation and prompt input widths. Values are passed to the React app through `window.t3HostBridge.getDisplayPreferences()` at startup and through `window.t3HostBridge.onDisplayPreferencesChanged(...)` while the webview is open, so changes apply without reopening the T3 Code view. When `t3code.ui.enableTerminal` is `false`, the embedded T3 terminal drawer is disabled, terminal keybindings are ignored, terminal-backed project actions are hidden, and any open terminal drawer is closed.

Project management chrome is not configurable in the VS Code extension. The extension backend is started from the active workspace folder and receives the full VS Code workspace folder list, so the React app treats the VS Code surface as a workspace-scoped view: it filters the sidebar to the bootstrapped workspace projects, hides the add-project button, hides redundant project labels only when there is a single visible project, and renders only those projects' threads. This avoids showing unrelated desktop-app projects inside an editor-scoped surface while still supporting multi-root workspaces.

The thread-history sidebar still shows the "Sidebar options" button when VS Code hides project chrome. In that project-scoped mode, the menu keeps thread controls such as thread sort order and visible thread count, but hides project controls such as project sort order and project grouping. Multi-root VS Code workspaces that show project chrome retain the full sidebar options menu.

The sidebar toggle remains visible in VS Code webviews at all viewport widths. In desktop/browser surfaces the existing responsive behavior is preserved, but inside VS Code the user must always have a visible control for closing or reopening the thread-history sidebar.

When the thread-history sidebar is open in the inline desktop layout, the VS Code webview shows only the sidebar-local toggle before the T3 Code wordmark, using the close-sidebar icon. The main header toggle before the thread title is hidden until the sidebar is closed, so the view never presents two equivalent sidebar controls at once. In the narrow floating-sidebar layout, the main header toggle remains visible while the floating sidebar is open and switches to the close-sidebar icon, avoiding header text reflow while keeping a local close control available.

The thread-history sidebar open/closed state is stored in shared `ClientSettings`. In VS Code this goes through the host bridge to `<T3 home>/userdata/client-settings.json`, so reloading the VS Code window restores the previous sidebar state.

The webview startup route is reset each time the extension renders the view. Sidebar and new-thread views start at the T3 chat home, intentionally ignoring any stale hash route VS Code may have retained from an earlier webview instance, then let the authenticated backend welcome event choose the current workspace's startup thread. Custom editor resources shaped like `t3-code://route/<environmentId>/<threadId>` initialize directly to that thread's hash route. In VS Code, automatic startup selection is constrained to bootstrapped workspace projects: the app prefers the active workspace folder's project, chooses the most recently visited thread within that project, falls back to that project's newest active thread, and otherwise falls back within the visible workspace project set.

## VS Code Theme and Font Propagation

VS Code webviews match the active VS Code color theme and editor fonts by default. The extension injects the current host appearance through `window.t3HostBridge.getHostAppearance()`, broadcasts changes through `window.t3HostBridge.onHostAppearanceChanged(...)`, and the React app maps its theme tokens to VS Code webview variables such as `--vscode-editor-background`, `--vscode-editor-foreground`, `--vscode-focusBorder`, `--vscode-font-family`, and `--vscode-editor-font-family`.

The app still owns its normal default theme path outside VS Code. Inside VS Code, users can restore that default T3 Code theme with:

- `t3code.ui.restoreDefaultTheme`

This setting defaults to `false`. When it is `false`, VS Code theme/font propagation is enabled. When it is `true`, the webview removes the host theme mapping and the normal T3 Code theme preference applies again.

## Virtual Workspace Cache

VS Code virtual workspace folders, such as GitHub RemoteHub folders shaped like `vscode-vfs://github/<owner>/<repo>`, do not provide a real process `cwd`. T3 materializes supported GitHub virtual folders into local partial clones under `<T3 home>/virtual-workspaces/github/<owner>-<repo>-<hash>`, starts the backend from that checkout, and keeps the original VS Code URI-derived folder key in the bootstrap metadata.

Each T3-owned virtual checkout contains `.t3-virtual-workspace.json` with provider, clone URL, workspace folder key, creation time, last-used time, and last-backend-started time. After a backend starts successfully, the extension prunes cache-owned GitHub virtual workspace clones that have not been used for 15 days. Pruning is intentionally conservative: it keeps at least the 10 most recently used checkouts and never deletes a checkout that belongs to the currently running backend.

The explicit command for manual cleanup is:

```sh
t3code.cleanVirtualWorkspaceCache
```

Run it from the VS Code command palette as "T3 Code: Clean Virtual Workspace Cache". The command deletes inactive T3-owned virtual workspace checkouts immediately, ignores directories without T3 metadata, and keeps the active checkout if the backend is running.

## Implementation Status

Current status: locally installable experimental VSIX exists, uses stable VS Code APIs only, and is wired into the release workflow for platform-targeted VSIX builds and Marketplace publishing.

Implemented so far:

- Created the `apps/vscode-extension` workspace package with `package.json`, `src/extension.ts`, `src/backendManager.ts`, `src/webview.ts`, `tsdown.config.ts`, build scripts, package scripts, a desktop-logo package icon, and a VS Code Side Bar SVG icon.
- Added extension commands:
  - `t3code.open`
  - `t3code.newThread`
  - `t3code.restartBackend`
  - `t3code.cleanVirtualWorkspaceCache`
- Added a stable Secondary Side Bar view container and webview view:
  - `t3code.sidebarView`
- Added custom editor contribution and provider:
  - `t3code.conversationEditor`
  - virtual resources shaped like `t3-code://route/local/new`
  - thread resources shaped like `t3-code://route/<environmentId>/<threadId>` route directly to the matching T3 thread
- Added a backend process manager that:
  - chooses the active executable workspace folder or materialized virtual checkout as `cwd`
  - allocates a loopback port
  - generates a bootstrap token
  - writes a desktop-compatible bootstrap envelope through fd 3
  - exchanges the bootstrap token for a VS Code bearer session after backend readiness
  - starts the bundled `dist/server/bin.mjs` with `ELECTRON_RUN_AS_NODE=1`
  - falls back to a development checkout command when no bundled server exists
  - supports user-configurable server command, args, cwd, and T3 home
  - includes enabled VS Code MCP bridge servers in the desktop bootstrap envelope
  - records T3-owned virtual workspace clone metadata
  - prunes inactive virtual workspace clones not used for 15 days after successful backend startup
  - polls `/.well-known/t3/environment` with a per-request timeout
  - marks the backend bootstrap with `hostIntegration: "vscode"` so VS Code-only behavior can remain scoped server-side
  - terminates the backend on extension disposal
- Added VS Code MCP support:
  - extension-owned temporary socket MCP server
  - unique MCP server identity per VS Code window
  - desktop bootstrap `mcpServers` metadata
  - provider MCP config injection through provider-appropriate `stdio-to-uds <socketPath>` relays
  - configurable Codex `tool_timeout_sec` propagation from `t3code.mcp.toolTimeoutSec`
  - VS Code diagnostics, references, and workspace-symbol tools backed by VS Code language APIs
  - generic `vscodeRunCommand` tool execution through `vscode.commands.executeCommand(...)`
  - registered-command validation and internal-command rejection
  - configurable command allowlist for `vscodeRunCommand` through `t3code.mcp.allowedRunCommands`
  - configurable extension activation allowlist for `vscodeRunCommand` through `t3code.mcp.allowedActivateExtensions`
  - JSON-safe command argument/result handling, including supported `Uri`, `Position`, and `Range` arguments
  - `t3code.mcp.enabled` setting for enabling or disabling the whole bridge
- Added a neutral host bridge contract:
  - `T3HostBridge`
  - `window.t3HostBridge`
  - `getDisplayPreferences()` for host-level UI and capability preferences
  - `getHostAppearance()` for host-level theme/font propagation
- Added VS Code multi-root bootstrap metadata:
  - the extension sends every VS Code workspace folder through the desktop bootstrap envelope
  - each folder has a stable key derived from URI scheme, authority, and filesystem path
  - the active editor's workspace folder is marked as the active bootstrap folder
  - GitHub RemoteHub virtual folders are materialized into a local T3-managed clone before bootstrapping
  - T3-owned virtual workspace clones are kept under `<T3 home>/virtual-workspaces/github`
  - the extension keeps at least the 10 most recently used virtual workspace clones and never prunes the active checkout
- Updated the web app to:
  - prefer `window.t3HostBridge.getLocalEnvironmentBootstrap()`
  - fall back to `window.desktopBridge.getLocalEnvironmentBootstrap()`
  - use hash history in VS Code webviews
  - identify VS Code webviews only through the explicit `window.__T3_IS_VSCODE_WEBVIEW` marker
  - read bootstrap credentials from either bridge
  - use host-injected bearer auth for VS Code webview HTTP and WebSocket startup
  - hide VS Code-duplicated controls by default based on host display preferences
  - match VS Code theme colors and font variables by default
  - restore the normal T3 Code theme when `t3code.ui.restoreDefaultTheme` is enabled
  - keep the sidebar toggle visible at all VS Code webview widths
  - scope the sidebar to the bootstrapped VS Code workspace projects
  - hide project-management chrome in VS Code single-project mode
  - keep the sidebar options button visible in VS Code single-project mode while limiting its menu to thread options
  - remove the thread group rail in VS Code single-project mode
  - show only one thread-sidebar toggle at a time
  - persist the thread-sidebar open state in shared `ClientSettings`
  - reset VS Code webview startup routing before React initializes
  - suppress resolved terminal and project-script shortcuts when VS Code host preferences disable the embedded terminal
  - choose only a visible VS Code workspace thread during first-load navigation, preferring the active workspace project
  - read and write `ClientSettings` through `window.t3HostBridge` when no desktop bridge is present
  - support `VITE_BASE_URL` so extension-local web assets can be built with relative paths
- Added webview rendering that:
  - reads extension-local `dist/webview/index.html`
  - injects a `<base>` tag using `webview.asWebviewUri(...)`
  - injects `window.t3HostBridge`
  - injects VS Code display preferences from extension configuration
  - broadcasts display preference changes to open T3 Code webviews
  - injects VS Code host appearance and broadcasts theme/default-theme toggle changes to open T3 Code webviews
  - handles neutral host bridge requests for shared client settings persistence
  - initializes the hash route
  - overwrites stale retained hash routes with the requested initial route
  - applies a restrictive CSP with local backend HTTP and WebSocket connect sources
- Added VS Code-only MCP orchestration that:
  - starts the extension MCP bridge only from VS Code extension usage
  - passes bridge metadata through the desktop bootstrap envelope
  - injects provider-native MCP config for sessions launched by the VS Code-backed backend
  - leaves browser and desktop app prompt text, services, and runtime waiting paths untouched
- Added extension settings for restoring VS Code-hidden T3 Code controls:
  - `t3code.ui.showOpenInPicker`
  - `t3code.ui.showCheckoutModeIndicator`
  - `t3code.ui.showBranchSelector`
  - `t3code.ui.enableTerminal`
- Added extension setting for customizing the thread conversation timeline and prompt input width:
  - `t3code.ui.threadConversationMaxWidth`
- Added extension setting for restoring the default T3 Code theme instead of matching VS Code:
  - `t3code.ui.restoreDefaultTheme`
- Added extension setting for the VS Code MCP bridge:
  - `t3code.mcp.enabled`
  - `t3code.mcp.toolTimeoutSec`
  - `t3code.mcp.allowedRunCommands`
  - `t3code.mcp.allowedActivateExtensions`
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
  - supports `--target`, `--out`, and `--pre-release` package options
  - includes extension-local Marketplace metadata for repository and license
  - creates a versioned `apps/vscode-extension/t3code-vscode-<version>.vsix`
- Added release workflow distribution that:
  - aligns `apps/vscode-extension/package.json` to the release version before packaging
  - stamps the package publisher from `VSCE_PUBLISHER` during packaging without committing it to source
  - builds platform-targeted VSIX artifacts for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`
  - marks nightly/prerelease VSIX builds with `vsce package --pre-release`
  - uploads VSIX artifacts to the GitHub release alongside desktop artifacts
  - publishes all built VSIX artifacts to the VS Code Marketplace with `vsce publish --packagePath ...`
  - uses `VSCE_PUBLISHER` as the required GitHub repository variable for the Marketplace publisher id
  - uses `VSCE_PAT` as the required GitHub secret for Marketplace auth
- Verified:
  - `bun fmt`
  - `bun lint` (passes with existing unrelated warnings)
  - `bun typecheck`
  - `bun run --filter t3code-vscode package`
  - manual bundled-backend readiness smoke test

Deferred until there is a concrete UX need:

- Chat Sessions integration, including the proposed `chatSessionsProvider`, `chatSessions/newSession` menu contribution, and listing recent T3 threads as VS Code chat session items.
- Webview-to-extension host actions beyond client settings persistence and host appearance propagation, including adding the current file/selection to T3 Code and reveal/open file host actions.
- External OpenCode server MCP injection. Backend-owned OpenCode servers receive the VS Code MCP config through `OPENCODE_CONFIG_CONTENT`; externally managed OpenCode servers are already running and cannot be reconfigured by this backend session bootstrap.

Not implemented yet:

- Containing keybinding collisions between T3 webview shortcuts and VS Code native keybindings. See the decision log entry below.
- Package size optimization.
- Linux arm64 and Windows arm64 VSIX publishing. The current release matrix matches the platform set already validated for desktop release runners.

Known packaging notes:

- The generated VSIX is intentionally gitignored.
- Extension build output under `apps/vscode-extension/dist` is intentionally gitignored.
- The current local VSIX includes staged runtime dependencies and is still larger than a normal webview-only extension. The initial working artifact was around 119 MB on macOS arm64; pruning runtime-dead staged dependency files reduced the local artifact to around 22 MB.
- VS Code packaging removes the backend's duplicated `dist/server/client` static web app after copying `apps/server/dist`. The extension webview loads `dist/webview` directly, so the packaged backend does not need its standalone static-client copy.
- `bun install --production` reports a blocked `node-pty` postinstall in the staged extension runtime, but the installed package includes `node-pty` prebuilds for macOS and Windows. Linux packaging still needs explicit validation.
- Release packaging is platform-targeted with `vsce --target` because the staged backend runtime includes native dependencies such as `node-pty`.
- The release workflow currently builds Marketplace VSIX artifacts for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`. Add `linux-arm64` and `win32-arm64` only after native runtime staging has been validated on matching runners.
- Marketplace publishing uses the `VSCE_PUBLISHER` GitHub repository variable and `VSCE_PAT` GitHub secret. Per the VS Code publishing docs, `vsce` publishes with a Visual Studio Marketplace Personal Access Token; the token should be scoped so it can publish for the configured publisher.

## Decision Log

### 2026-05-20: Add VS Code MCP Bridge

Decision: expose VS Code-backed tools through an extension-owned MCP server. Keep the MCP server generic and provider-neutral, and translate it into each provider's native MCP config where the provider exposes one.

Reasoning:

- MCP is the provider-native shape for tool discovery, invocation, and result routing in the current Codex, Claude Code, OpenCode, and Cursor integrations.
- The VS Code extension host is still the correct place to execute VS Code commands because it has access to the public `vscode.commands.executeCommand(...)` API.
- The backend only needs generic MCP server bootstrap metadata. That keeps the extension bridge usable by future providers that can consume MCP without baking Codex semantics into the bridge itself.
- Browser and desktop app usage should not receive VS Code MCP configuration or extension-host services. MCP startup and integration remain scoped to the VS Code extension bootstrap.
- Subagents can use the MCP tools if the underlying harness inherits MCP configuration and permits MCP tools for child agents. Provider-specific subagent behavior should be validated and enhanced in a separate branch, because this branch is focused on the VS Code extension bridge and Codex integration.

Implemented:

- `VsCodeMcpBridge` starts a local socket MCP server from the VS Code extension host.
- Each bridge instance uses a unique MCP server name so multiple VS Code windows do not advertise the same server key.
- `BackendManager` includes enabled MCP server metadata in the desktop bootstrap envelope.
- The server stores bootstrap MCP metadata in `ServerConfig.hostMcpServers`.
- The backend exposes a generic `stdio-to-uds` relay so provider MCP clients can reach the VS Code extension-owned socket without depending on the Codex binary.
- The Codex adapter converts host MCP metadata into Codex `mcp_servers` config using the Codex CLI relay.
- The Claude adapter converts host MCP metadata into SDK `mcpServers` config.
- The OpenCode adapter injects local server `mcp` config through `OPENCODE_CONFIG_CONTENT` for backend-owned OpenCode servers.
- The Cursor adapter passes host MCP metadata through ACP `mcpServers`.
- `vscodeDiagnostics`, `vscodeReferences`, and `vscodeWorkspaceSymbols` expose VS Code language-service data through MCP.
- `vscodeRunCommand` executes allowed registered VS Code commands and returns JSON-safe MCP content.

Boundaries:

- Internal VS Code commands prefixed with `_` and commands outside the explicit MCP allowlist are rejected.
- The command list is queried with `vscode.commands.getCommands(true)`, so stale or unregistered allowed commands are still rejected. Tool calls may provide `activateExtension` to activate an installed extension before this registration check only when the extension id is listed in `t3code.mcp.allowedActivateExtensions`.
- `vscodeRunCommand` is intentionally narrow by default. Users can expand `t3code.mcp.allowedRunCommands` only when the command side effects and argument shapes are understood.
- MCP bridge startup is gated by one setting, `t3code.mcp.enabled`, which defaults to `true`.
- Codex MCP tool calls use `t3code.mcp.toolTimeoutSec`, which defaults to `120` seconds, rejects values below `5` seconds, and is passed as `tool_timeout_sec`.
- OpenCode receives the same setting as its MCP `timeout` in milliseconds, but OpenCode documents that field as the timeout for fetching MCP tools.
- Claude Code and Cursor do not currently receive a provider-specific timeout because the configuration surfaces used here do not expose a matching field.

Deferred work:

- Validate provider-specific subagent MCP inheritance and add targeted fixes only if a harness requires explicit subagent MCP propagation.
- Consider expanding the VS Code MCP tool catalog further after the initial command and language-service tools have enough real usage.

### 2026-05-15: Default VS Code View Into Secondary Side Bar

Decision: require VS Code 1.106+ for the extension and contribute the T3 Code view container through `viewsContainers.secondarySidebar` instead of the Activity Bar.

Reasoning:

- VS Code 1.106 added stable support for extension-owned view containers in the Secondary Side Bar.
- T3 Code behaves like a coding-agent/chat companion surface, so the Secondary Side Bar is a better default than taking a primary Activity Bar slot.
- Requiring 1.106+ avoids runtime layout mutation and avoids maintaining duplicate Activity Bar and Secondary Side Bar fallback views.
- Existing users may keep VS Code's persisted layout if they have already moved the view manually.

Implemented:

- Updated the extension engine floor to VS Code `^1.106.0`.
- Moved the `t3code` view container contribution from `activitybar` to `secondarySidebar`.
- Kept `t3code.sidebarView` and `t3code.open` unchanged so provider registration and focusing behavior remain stable.

### 2026-05-15: Propagate VS Code Theme and Font Defaults

Decision: make VS Code theme and font propagation the default for VS Code webviews, while providing `t3code.ui.restoreDefaultTheme` as an explicit opt-out that restores the normal T3 Code app theme path.

Reasoning:

- VS Code users expect embedded editor surfaces to follow the active VS Code color theme, UI font, and editor monospace font.
- VS Code already exposes stable webview CSS variables for theme colors and fonts, so the web app can map its existing design tokens without hard-coding theme names or reading user settings directly.
- The React app still needs to know the host-resolved light/dark mode because markdown highlighting, diff rendering, and file icons are selected from app state, not CSS alone.
- A restore-default setting is less ambiguous than a partial theme toggle: when enabled, the VS Code host stops driving T3 Code theme tokens and the app's existing theme preference applies.

Implemented:

- Added `T3HostAppearance` to the neutral host bridge contract.
- The VS Code extension injects `getHostAppearance()` and `onHostAppearanceChanged(...)` into `window.t3HostBridge`.
- Host appearance changes are broadcast when the active VS Code color theme changes or when `t3code.ui.restoreDefaultTheme` changes.
- The webview bridge sets `data-t3-host-theme="vscode"` and the `.dark` class before React starts when VS Code propagation is active.
- The web app maps T3 theme tokens and body/code fonts to VS Code webview CSS variables when host propagation is active.
- `useTheme()` uses the host-resolved light/dark mode for app-level rendering decisions while preserving the existing stored app theme for the default-theme path.

Automated coverage:

- VS Code webview tests cover initial host appearance injection, bridge listener wiring, and the `t3code.ui.restoreDefaultTheme` contribution.
- Web tests cover resolving the VS Code host theme, applying base propagation to the document, and toggling back to the default theme path.

### 2026-05-14: Treat VS Code as a Single-Workspace Surface

Decision: when running inside the VS Code webview, the T3 web app presents only the project that the extension-owned backend bootstrapped from the current workspace folder.

Status: superseded for multi-root workspaces by the 2026-05-15 multi-root bootstrap decision. The single-project behavior remains the compatibility path when VS Code exposes only one workspace folder.

Reasoning:

- VS Code already defines the active workspace/repository context. Showing the desktop app's full project list inside that context makes it possible to accidentally navigate into unrelated repositories.
- The extension starts a backend for the selected workspace folder with `--auto-bootstrap-project-from-cwd`, so the web UI has a concrete current-project identity from the welcome payload and server config.
- A single-workspace sidebar keeps thread history useful without duplicating project-management UI that belongs in the desktop app or the command palette.

Implemented:

- The React sidebar filters projects to the VS Code welcome `bootstrapProjectId`, falling back to the backend `cwd` while the welcome payload is still settling.
- The sidebar hides the add-project button, "Projects" label, and current-project row label in VS Code webviews.
- The sidebar removes the thin thread group rail in VS Code webviews because there is no visible next project boundary to communicate.
- Thread rows remain visible and are limited to the current workspace project.
- The sidebar toggle is visible in VS Code webviews at all viewport widths.

### 2026-05-15: Support Multi-root VS Code Workspace Bootstrap

Decision: keep `thread.projectId` as the authoritative ownership key, but bootstrap one T3 project per VS Code workspace folder and expose the full project set in the lifecycle welcome payload.

Reasoning:

- A repository root is a useful grouping key, but it is not a safe ownership key. Worktrees, monorepo subprojects, devcontainers, SSH remotes, and local paths can share repository metadata while requiring separate working state and command execution context.
- The existing T3 thread index already uses `projectId -> threadIds`, so multi-root support should widen the bootstrapped project set rather than replace thread ownership with repository identity.
- VS Code workspace folder URIs carry scheme and authority. Including those fields in the bootstrap key distinguishes local, SSH, and devcontainer roots even when their filesystem paths are identical from the agent's point of view.
- Backward compatibility matters: older clients and non-VS Code surfaces still understand `bootstrapProjectId` and `bootstrapThreadId`.

Implemented:

- `DesktopBackendBootstrap` accepts `workspaceFolders[]` and `activeWorkspaceFolderKey`.
- Each workspace folder carries `key`, `name`, `cwd`, `uriScheme`, and `uriAuthority`.
- The VS Code extension builds folder keys as `<scheme>:<authority>:<fsPath>`, sends every workspace folder, and keeps launching the backend from the active folder.
- `file:` and `vscode-remote:` workspace folders are treated as directly executable filesystem roots.
- `vscode-vfs://github/<owner>/<repo>` workspace folders from GitHub RemoteHub are cloned with `git clone --filter=blob:none` into `<T3 home>/virtual-workspaces/github/<owner>-<repo>-<hash>` and bootstrapped from that local checkout.
- Unsupported virtual workspace folders are skipped instead of passing their `Uri.fsPath` to the backend as a bogus cwd.
- `ServerConfig` stores the bootstrapped folder list and active folder key from the desktop bootstrap envelope.
- Server startup resolves or creates one T3 project per bootstrapped folder, creates a startup thread when a project has no active thread, and publishes all results as `bootstrapProjects[]`.
- The legacy welcome fields `bootstrapProjectId` and `bootstrapThreadId` remain populated from the active folder's project for compatibility.
- The React app filters VS Code sidebars to the bootstrapped `projectId` set, falling back to bootstrapped `cwd`s while project ids are still settling.
- VS Code first-load navigation selects only visible workspace threads and prefers the active workspace project's candidates.
- Global new-thread shortcuts and command-palette actions in VS Code use the visible workspace project set for their default project instead of unrelated desktop projects.

Operational model:

- Multi-root workspace: one backend process, one T3 project per VS Code root, and one visible thread group per bootstrapped project.
- Git worktree: each worktree path remains a distinct T3 project; repository identity can group it visually, but thread ownership stays on the physical worktree project.
- Devcontainer or SSH: the workspace folder key includes `vscode-remote` scheme and authority, so the bootstrap identity distinguishes remote/container roots from local roots. The backend still executes inside the environment where the extension host starts it.
- GitHub RemoteHub: the VS Code folder URI is virtual and `Uri.fsPath` is not a usable process cwd. T3 clones the GitHub repository to a local cache, uses that checkout as the project cwd, and preserves the virtual folder key for bootstrap identity.
- Repository identity: still used for sidebar grouping and labels, not as the persistence key for threads.

Automated coverage:

- Server startup tests cover existing project/thread reuse, missing project/thread creation, and multi-root active-folder selection.
- CLI config tests cover desktop bootstrap propagation for devcontainer-style workspace folder metadata.
- VS Code extension tests cover single-root startup, multi-root SSH-style folder bootstrap, GitHub RemoteHub clone materialization, and unsupported virtual workspace fallback.
- Web sidebar logic tests cover multi-root filtering, cwd fallback before project ids settle, and active-project startup thread selection.

### 2026-05-15: Prune T3-owned Virtual Workspace Clones

Decision: keep GitHub RemoteHub materialized checkouts as a T3-owned cache with metadata, prune checkouts not used for 15 days, keep at least the 10 most recently used checkouts, and never delete the currently active backend checkout.

Reasoning:

- GitHub RemoteHub gives T3 a virtual URI, not a real executable `cwd`, so supported virtual folders need a local clone before agents can run shell commands.
- Cloning on every startup would make RemoteHub workspaces slow and waste network bandwidth; keeping a cache preserves normal repeated-use ergonomics.
- A cache without cleanup leaks disk over time. Fifteen days is eager enough to recover stale repositories while still covering most short-to-medium branch and review workflows.
- The active backend checkout must be protected because deleting it would break commands and file references for the running session.
- Keeping the 10 most recently used checkouts avoids surprising users who rotate through several repositories within a short period.

Implemented:

- GitHub virtual workspace checkouts write `.t3-virtual-workspace.json` with provider, clone URL, workspace folder key, creation time, last-used time, and last-backend-started time.
- Existing cache checkouts are reused and their usage metadata is refreshed when the backend starts from them.
- Successful backend startup schedules best-effort pruning for T3-owned GitHub virtual workspace checkouts under `<T3 home>/virtual-workspaces/github`.
- Pruning deletes only metadata-owned checkouts older than 15 days, preserves the active checkout paths, and keeps the 10 most recently used checkouts regardless of age.
- The VS Code command `t3code.cleanVirtualWorkspaceCache` ("T3 Code: Clean Virtual Workspace Cache") deletes inactive metadata-owned virtual checkouts immediately while preserving the active checkout and ignoring unowned directories.

Automated coverage:

- VS Code extension tests cover RemoteHub clone materialization before backend startup.
- Virtual workspace cache tests cover stable checkout path resolution, initial clone metadata, existing-checkout reuse and metadata refresh, 15-day pruning with active and most-recently-used protection, retention-window protection, unowned directory protection, and explicit clean-command behavior.

### 2026-05-15: Keep Thread Sidebar Options Available in VS Code

Decision: when VS Code hides project chrome in single-project mode, keep the "Sidebar options" button visible but hide project-related menu sections.

Reasoning:

- Thread sorting and visible-thread count are still useful controls inside the VS Code thread-history sidebar.
- Project sorting and project grouping do not apply when the VS Code surface has collapsed project chrome around a single visible workspace project.
- Removing the whole options trigger hid valid thread controls as an accidental side effect of hiding project chrome.
- Multi-root VS Code workspaces still show project chrome, so they keep the full menu with project and thread sections.

Implemented:

- The sidebar options trigger is rendered independently from the project label/add-project chrome.
- In VS Code single-project mode, the menu shows only "Sort threads" and "Visible threads".
- In normal desktop/browser sidebars and VS Code multi-root sidebars, the menu still includes project sort, thread sort, visible-thread count, and project grouping.
- Automated coverage verifies that the sidebar options button remains available while project options are removed when project chrome is hidden.

### 2026-05-15: Remove the VS Code Thread Group Rail

Decision: remove the thin left rail beside thread rows when the sidebar is running in VS Code single-project mode.

Reasoning:

- The rail exists in the desktop/browser sidebar to visually group threads beneath a project and show where one project's thread list ends before the next project begins.
- VS Code shows only the current workspace project, so the rail no longer communicates a useful project boundary and reads as stray chrome.
- Keeping the desktop/browser rail unchanged preserves the multi-project grouping affordance where it still has meaning.

Implemented:

- The React sidebar passes the same VS Code project-chrome hiding state into the thread list.
- The thread list adds `border-l-0` only for that single-project VS Code mode.
- Automated coverage verifies the thread list class keeps the rail in normal sidebars and removes it in VS Code single-project mode.

### 2026-05-15: Persist and De-duplicate the VS Code Sidebar Toggle

Decision: keep one visible thread-sidebar toggle at a time and persist the thread-history sidebar open state in client settings.

Reasoning:

- VS Code makes the sidebar toggle visible at all viewport widths, so showing one before the T3 Code wordmark and another before the thread title creates duplicate controls for the same action.
- The sidebar-local toggle is the right visible control while the sidebar is open because it is spatially attached to the panel being closed.
- The main header toggle is the right visible control while the sidebar is closed because it remains available in the main view.
- VS Code webview reloads should preserve whether the user prefers the thread history open or hidden, and shared `ClientSettings` already persists VS Code client preferences through the host bridge.

Implemented:

- The shared sidebar trigger now uses the close-sidebar icon when the desktop sidebar is open, not only when the mobile sheet is open.
- Main-view header triggers render only when the inline thread-history sidebar is closed. In the narrow floating-sidebar layout, the main header trigger remains visible while open and switches to the close-sidebar icon.
- `threadSidebarOpen` is part of `ClientSettings`, defaults to `true`, and is persisted through the existing browser, desktop, and VS Code host persistence paths.
- Automated coverage verifies main-header trigger visibility and the sidebar trigger open/close labels.

### 2026-05-14: Reset VS Code Webview Startup Routing

Decision: each VS Code webview render overwrites any retained hash route with the extension-provided initial route, then first-load navigation is constrained to the current workspace project.

Reasoning:

- VS Code can retain a webview hash route across reloads. If that route points at a thread from another project, the embedded app can initially open the wrong repository context.
- Resetting to chat home before React initializes avoids browser-style route restoration inside a workspace-scoped editor surface.
- The backend welcome payload provides the bootstrapped project identity, so the client can choose a startup thread without crossing project boundaries.

Implemented:

- The injected webview bridge now calls `history.replaceState(..., "#/_chat/")` whenever an initial route is provided, even if a hash already exists.
- The React event router, when in VS Code, resolves the first thread route from current-project candidates only.
- Startup selection prefers the most recently visited current-project thread, then the newest active current-project thread, then the existing no-active-thread/new-thread state.

### 2026-05-14: Make the Sidebar Wordmark a Button in VS Code-Safe Navigation

Decision: replace the sidebar wordmark router link with a button that calls router navigation programmatically.

Reasoning:

- VS Code webviews can treat anchors with file-backed webview URLs as external links.
- The wordmark is an in-app command, not an external document link.
- Rendering a button avoids exposing an `href` that VS Code can attempt to open in the user's browser while preserving the intended "go to T3 home" behavior.

Implemented:

- The "T3 Code" wordmark renders as `type="button"` and navigates with TanStack Router's `navigate({ to: "/" })`.
- Automated coverage verifies the wordmark control does not render an anchor or `href`.

### 2026-05-14: Hide VS Code-Duplicated Web UI by Default

Decision: keep the existing React UI, but hide specific controls in VS Code webviews when VS Code already provides the corresponding native surface.

Hidden by default:

- Open/reveal picker.
- Checkout mode indicator.
- Branch/ref selector.
- T3 Code terminal drawer.

Reasoning:

- The extension runs inside VS Code, so controls for opening the current workspace in VS Code, revealing files through the platform file manager, showing checkout type, picking refs, and opening a terminal duplicate capabilities already present in the host.
- Removing duplicated chrome keeps the embedded T3 Code surface focused on conversation and agent workflow while preserving the underlying app behavior for users who explicitly want the original controls.
- `window.t3HostBridge` remains neutral. VS Code detection now relies only on the explicit `window.__T3_IS_VSCODE_WEBVIEW` marker, while host-specific UI and capability choices are passed through `window.t3HostBridge.getDisplayPreferences()`.

Implemented:

- Added disabled-by-default extension settings for each hidden control:
  - `t3code.ui.showOpenInPicker`
  - `t3code.ui.showCheckoutModeIndicator`
  - `t3code.ui.showBranchSelector`
  - `t3code.ui.enableTerminal`
- Added `T3HostDisplayPreferences` to the shared host bridge contract.
- Injected the current VS Code setting values into each rendered webview.
- Broadcast setting changes to open T3 Code webviews and subscribed to them from React.
- Applied the preferences in `ChatHeader` and `BranchToolbar`.

### 2026-05-15: Disable the Embedded Terminal in VS Code by Default

Decision: rename the VS Code terminal setting from a display toggle to `t3code.ui.enableTerminal`, and make `false` disable the embedded T3 terminal surface instead of only hiding its toolbar button.

Reasoning:

- VS Code already provides native terminal surfaces and terminal keybindings.
- Hiding only the T3 terminal button left other terminal entry points active, including keyboard shortcuts and project actions that launch into the embedded drawer.
- A setting named "enable terminal" better describes the real capability boundary than "show terminal toggle."

Implemented:

- Replaced `t3code.ui.showTerminalToggle` with disabled-by-default `t3code.ui.enableTerminal`.
- Renamed the host bridge preference from `showTerminalToggle` to `enableTerminal`.
- When disabled, terminal shortcuts are ignored without preventing the host from handling the key event.
- When disabled while a drawer is open, the React terminal drawer state is closed.
- Terminal-backed project actions are hidden and do not launch embedded terminals while disabled.
- Automated coverage verifies the renamed setting, injected preference, terminal command filtering, and disabled-terminal close target resolution.

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
- `isVscodeWebview` is keyed only from `window.__T3_IS_VSCODE_WEBVIEW`, not from the neutral bridge existing.

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

Status: retained. Multi-root support now uses one backend process bootstrapped from the active folder while passing all workspace folders to the backend for project resolution.

Reasoning:

- This keeps provider sessions in one backend while allowing the server and web app to resolve multiple workspace projects.
- It keeps the process manager small while preserving room for a future one-process-per-environment registry if remote/container execution requires it.

Deviation from original plan:

- The backend manager is not yet a full one-process-per-workspace registry.
- Multi-root workspace behavior is now project-aware inside one backend process.

### 2026-05-14: Package Staged Runtime Dependencies

Decision: stage runtime dependencies under `apps/vscode-extension/dist/node_modules` and package with `vsce --no-dependencies`.

Reasoning:

- The server bundle still has external imports such as `effect`, `@effect/platform-node`, `@opencode-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@pierre/diffs`, and `node-pty`.
- Letting `vsce` discover dependencies directly from the monorepo pulled unrelated files and failed while parsing unrelated markdown.
- Controlled staging produces an installable local VSIX.

Deviation from original plan:

- Packaging is not yet optimized.
- The VS Code package currently strips `dist/server/client` as a packaging-only shortcut. A cleaner longer-term fix would split the server build so extension packaging can build/copy the backend without producing the standalone web client at all.
- A local package without `--target` is still useful for development, but release distribution should use platform-specific VSIXs while `node-pty` remains required.

### 2026-05-15: Publish Platform-targeted VSIXs from Release CI

Decision: build platform-targeted VSIX artifacts in the main release workflow and publish those artifacts to the Visual Studio Marketplace with `@vscode/vsce`.

Reasoning:

- The extension packages the server runtime and staged production dependencies, including native dependencies such as `node-pty`. A single universal VSIX is higher risk because native binaries and postinstall behavior vary by platform.
- `vsce package --target` lets the VSIX metadata declare the platform it was built for, and Marketplace can serve matching platform packages to VS Code clients.
- Publishing the exact VSIX files produced by CI keeps GitHub release artifacts and Marketplace artifacts aligned.
- Marketplace auth should be a release secret, not an interactive login. `vsce publish` accepts a Personal Access Token through `--pat` or the `VSCE_PAT` environment variable.
- Stable and nightly channels already flow through the release workflow. Passing `--pre-release` for nightly/prerelease builds maps that existing channel split to VS Code Marketplace prereleases.

Implemented:

- `apps/vscode-extension/scripts/package.mjs` accepts `--target`, `--out`, and `--pre-release`, then forwards those options to `vsce package`.
- The package script writes `VSCE_PUBLISHER` into `package.json` only for the duration of packaging and restores the source manifest afterward. Local packages fall back to `t3tools` when `VSCE_PUBLISHER` is unset.
- `apps/vscode-extension/package.json` includes Marketplace repository metadata and the packaged extension includes an extension-local `LICENSE`.
- `scripts/update-release-package-versions.ts` now includes `apps/vscode-extension/package.json`, so Marketplace releases do not repeat `0.0.1`.
- `.github/workflows/release.yml` builds `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64` VSIX artifacts after preflight.
- GitHub releases include the generated `.vsix` files alongside desktop release assets.
- The `publish_vscode_extension` job downloads all VSIX artifacts and publishes them in one `vsce publish --packagePath ...` invocation.
- The build and publish jobs require `VSCE_PUBLISHER`; missing publisher configuration fails the release instead of producing a VSIX with a placeholder publisher.
- The publish job requires the GitHub secret `VSCE_PAT`; missing auth fails the release instead of silently skipping Marketplace deployment.
- Nightly/prerelease builds package and publish with `--pre-release`.

Deferred work:

- Add `linux-arm64` and `win32-arm64` once matching native dependency staging has been validated on real runners.
- Add Marketplace/Open VSX split publishing only if the product needs non-Microsoft VS Code-compatible distributions.
- Revisit VSIX signing if Marketplace or enterprise distribution policy requires signed VSIX artifacts beyond the normal Marketplace publishing path.

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

### 2026-05-15: Defer Native Chat Session, Thread Tab, and Host Action Expansion

Decision: keep the current stable webview integration as the baseline and defer Chat Sessions integration and additional webview-to-extension host actions until real usage exposes a concrete problem those features would solve.

Reasoning:

- The existing sidebar webview already presents T3 Code's native thread history and workspace-scoped thread behavior in a way that feels intuitive during current use.
- VS Code Chat Sessions integration would mainly add native VS Code discoverability and session navigation around the same T3 threads, not fix the core T3 thread model.
- Thread-specific custom editor routing is implemented for resources shaped like `t3-code://route/<environmentId>/<threadId>`, so restored custom editor resources can reopen the matching web route.
- Additional host actions such as add current file/selection, reveal/open file, and theme/font propagation should be driven by observed workflow friction rather than added speculatively.

Deferred work:

- Reassess Chat Sessions integration if users need T3 threads to appear in VS Code's native chat/session surfaces.
- Reassess deeper custom editor integration if editor tabs, deep links, or restored resources need lifecycle behavior beyond route initialization.
- Reassess host action expansion if file-context, reveal/open, command execution, or theme/font gaps become noticeable in daily use.

### 2026-05-14: Defer VS Code Native Keybinding Conflict Handling

Decision: do not ship a keyboard-spill fix in this phase. Keep the extension baseline unchanged and defer keybinding conflict handling until we can design a general VS Code-host integration instead of hard-coding individual shortcuts.

Findings:

- The T3 web app already handles shortcuts with browser `keydown` listeners and calls `preventDefault()` for commands such as creating a new thread.
- In VS Code webviews, shortcuts can still also reach VS Code's keybinding service. For example, `Cmd+N` can both create a T3 thread and run VS Code's default new untitled file command.
- A webview-local capture-phase `keydown` guard is not enough for host-level accelerators. Manual validation showed `Cmd+N` still opened a VS Code untitled file after the webview had handled the shortcut.
- Static empty-command/no-op VS Code keybinding attempts were also not a satisfactory general fix. They either failed to stop `Cmd+N` in this setup or required one static rule per shortcut/context.
- VS Code extension keybindings are contributed statically through `package.json`. There is no stable runtime API for an extension to dynamically register arbitrary keybindings from T3 Code's app settings.
- Editing the user's VS Code `keybindings.json` to mirror T3 settings would be too invasive and would blur ownership between T3 Code app preferences and VS Code user preferences.
- The installed Codex extension handles `Cmd+N` through VS Code's own keybinding service, not through a generic webview DOM guard. Its manifest contributes `cmd+n`/`ctrl+n` to `chatgpt.newChat` when `chatgpt.supportsNewChatKeyShortcut` is true. The webview sets that context key while an eligible Codex surface has focus, and the extension command posts a `new-chat` message back into the webview.

Implications:

- The Codex pattern is reliable for a specific command like "new chat" because VS Code sees the keybinding first and resolves it to an extension command instead of the default workbench command.
- Directly copying that pattern into T3 Code for every app shortcut would still require static manifest entries and extension/web handlers for each conflicted shortcut. That is not acceptable as the general solution for T3's user-configurable keybindings.
- A future phase should design a host-owned keybinding bridge with a clear policy for which app commands are worth promoting to VS Code-native commands, how focus/context is tracked, and how user-customized T3 keybindings interact with VS Code's static keybinding model.

Deferred work:

- Decide whether T3 Code should expose a small, curated set of VS Code-native commands, such as "new thread", while leaving fully dynamic app keybindings browser-local.
- Investigate whether a generated manifest or build-time command list can keep curated keybindings maintainable without one-off handlers scattered across the extension and web app.
- Avoid runtime edits to VS Code user keybindings unless the user explicitly opts in.

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
/<environmentId>/<threadId>
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

- Use platform-specific VSIX builds for release distribution.
- Build the currently validated Marketplace targets in CI: `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`.
- Add CI targets for Linux arm64 and Windows arm64 once matching native runtime staging has been validated.
- Keep the universal/local package path for development only.
- If `node-pty` remains required at runtime, platform-specific VSIXs are the cleaner distribution model.
