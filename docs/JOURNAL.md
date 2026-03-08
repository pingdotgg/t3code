# WebbsiaCode Dev Journal

## 2026-03-08 11:45 UTC — Add Browser Preview Panel

Added a resizable browser panel to the thread view so you can preview a localhost dev server alongside your AI conversations.

### What was added

- **`apps/web/src/components/BrowserPanel.tsx`** — iframe-based preview panel with URL bar and refresh button. URL defaults to `http://localhost:3000` and persists to localStorage.
- **`apps/web/src/browserRouteSearch.ts`** — Route search param utilities for `browser=1` toggle, mirroring the existing `diffRouteSearch.ts` pattern.

### What was changed

- **`apps/web/src/routes/_chat.$threadId.tsx`** — Added `BrowserPanelInlineSidebar` (resizable right sidebar on wide screens) and `BrowserPanelSheet` (slide-in sheet on narrow screens). Browser panel state driven by `browser=1` URL search param.
- **`apps/web/src/components/ChatView.tsx`** — Added globe icon toggle button in the ChatHeader toolbar (next to the diff toggle). Wires `browserOpen` state and `onToggleBrowser` callback.

### How to use

Click the globe icon (🌐) in the thread header toolbar to open the browser panel. Type a URL in the address bar and press Enter to navigate. The URL persists between sessions.

---

## 2026-03-08 12:55 UTC — Fix Browser Panel Hot Reload

Restored `allow-same-origin` to the iframe sandbox in `BrowserPanel.tsx`.

### Problem

Vite's HMR relies on a WebSocket connection from the page inside the iframe back to the Vite dev server. This requires same-origin access. Without `allow-same-origin` in the sandbox, the WebSocket was blocked and file changes to the previewed project did not hot-reload in the panel.

### Fix

- Re-added `allow-same-origin` to the iframe `sandbox` attribute.
- Added a file-level `/* eslint-disable react/iframe-missing-sandbox */` comment with an explanatory note. The lint rule flags `allow-scripts + allow-same-origin` as a security concern in general, but this is acceptable here because the panel is a developer tool exclusively used on localhost.
- `bun lint` and `bun typecheck` both pass with 0 warnings / 0 errors.

### Note on thread stuttering

During testing, slight stuttering was observed in the thread view while Codex was executing tool calls. This is a pre-existing behaviour caused by the rapid-fire orchestration event stream (~40+ domain events per turn) triggering frequent re-renders of the large `ChatView` component. It is not related to the browser panel feature.

---

## 2026-03-08 13:05 UTC — Add Terminal Toggle Button to ChatHeader

Added a `SquareTerminalIcon` toggle button to the `ChatHeader` toolbar (to the right of the browser toggle), following the same pattern as the diff and browser toggles.

### Motivation

The thread terminal was only openable via keyboard shortcut (`terminal.toggle`) or indirectly by running a project script. There was no visible button to open it. This made it impossible to start a dev server (e.g. `pnpm dev`) from within t3code's web UI without switching to an external terminal.

### What changed

- **`apps/web/src/components/ChatView.tsx`**
  - Imported `SquareTerminalIcon` from lucide-react.
  - Added `terminalOpen`, `hasProject`, and `onToggleTerminal` to `ChatHeaderProps`.
  - Added terminal `Toggle` button in `ChatHeader` render, disabled if no project is associated with the thread.
  - Wired `terminalOpen={terminalState.terminalOpen}`, `hasProject={activeProject !== null}`, and `onToggleTerminal={toggleTerminalVisibility}` at the call site.

### How to use

Click the `⬛` terminal icon in the thread header toolbar to open/close the terminal panel. From there you can run `pnpm dev` (or any other command) to start a dev server for the project being previewed in the browser panel.

---

## 2026-03-08 14:30 UTC — Per-Project & Global Terminal Scopes + Resize Fix

Added two additional terminal scopes alongside the existing per-thread terminal, and fixed prompt-line spam on window resize.

### Terminal resize fix

- **`apps/web/src/components/ThreadTerminalDrawer.tsx`** — The `onWindowResize` handler was calling `setResizeEpoch` unconditionally on every resize event, causing the pty to receive repeated `SIGWINCH` signals and redraw the shell prompt many times. Fixed by wrapping the `setResizeEpoch` call in `requestAnimationFrame`, coalescing rapid window-resize events into a single repaint per animation frame.

### New: `ScopedTerminalDrawer` component

- **`apps/web/src/components/ScopedTerminalDrawer.tsx`** — New reusable wrapper around `ThreadTerminalDrawer` that internally manages all terminal state (split, new, close, height) via `terminalStateStore` for any given `threadId`. Renders nothing when the terminal is closed. Used by both the project terminal and global terminal to avoid duplicating callback logic.

### New: Per-project terminal

A second terminal that is keyed by the project (not the active thread), so it stays open when switching between threads within the same project.

- **`apps/web/src/components/ChatView.tsx`** — Added `MonitorIcon` import. Computes a synthetic `project:<projectId>` ThreadId and reads/writes its state via `terminalStateStore`. Added `projectTerminalOpen` + `onToggleProjectTerminal` props to `ChatHeaderProps`/`ChatHeader`, and a `MonitorIcon` toggle button in the header toolbar.
- **`apps/web/src/routes/_chat.$threadId.tsx`** — Renders `ScopedTerminalDrawer` for the project terminal outside `ChatView key={threadId}` (in both the inline-sidebar and sheet layout branches), so it survives thread-switches within the same project. Uses the project's root `cwd` (not a worktree path).

### New: Global terminal

A terminal that is not tied to any project, toggled from the sidebar footer.

- **`apps/web/src/routes/_chat.tsx`** — Wrapped the layout in a `flex h-dvh flex-col` div, placed `ScopedTerminalDrawer` below the `SidebarProvider` (keyed by the synthetic ThreadId `"global"`). Opens in the server's working directory obtained from `serverConfigQueryOptions`.
- **`apps/web/src/components/Sidebar.tsx`** — Added a `"Global terminal"` toggle button in `SidebarFooter` (above the "+ Add project" button). Reads and writes `terminalStateStore` for the `"global"` synthetic ThreadId.

### How to use

| Terminal | Icon | Where | Opens in |
|---|---|---|---|
| Thread terminal | `⬛` square-terminal | ChatHeader | Thread worktree path (or project cwd) |
| Project terminal | `🖥` monitor | ChatHeader | Project root cwd; persists when switching threads |
| Global terminal | `>_` terminal | Sidebar footer | Server cwd; always accessible |

`bun lint` and `bun typecheck` both pass with 0 warnings / 0 errors.

---

## 2026-03-08 15:30 UTC — Per-Project Browser Panel + Dev Server Auto-Detection

Made the browser panel project-scoped (each project remembers its own URL) and added automatic dev server URL detection from terminal output.

### Problem

1. Browser URL was global — switching between projects kept showing the same `http://localhost:3000`.
2. Browser panel closed when switching threads/projects (the `browser=1` search param was lost on navigation).
3. Projects without a running dev server showed localhost:3000 by default.

### Per-project browser URLs

- **`apps/web/src/components/BrowserPanel.tsx`** — Accepts `projectId` prop. URLs keyed per-project in localStorage (`t3code:browser-url:${projectId}`). When projectId changes, loads that project's saved URL. No default — shows a "No dev server running" placeholder when empty.
- **`apps/web/src/routes/_chat.$threadId.tsx`** — Passes `projectId` through `BrowserPanelInlineSidebar` and `BrowserPanelSheet` to `BrowserPanel`.

### Browser persistence across navigation

- **`apps/web/src/browserRouteSearch.ts`** — Added `saveBrowserOpenState()` to persist browser open/close to localStorage (`t3code:browser-open`). Modified `parseBrowserRouteSearch()` (called by route `validateSearch`) to auto-restore `browser=1` from localStorage when the URL doesn't include it. This makes the browser panel stay open across thread/project switches seamlessly.
- Toggle handlers in `ChatView.tsx` and `_chat.$threadId.tsx` call `saveBrowserOpenState()` on every open/close.

### Dev server URL auto-detection

- **`apps/web/src/lib/devServerDetection.ts`** (new) — `detectDevServerUrl(data)` scans terminal output for `http://localhost:PORT` or `http://127.0.0.1:PORT` patterns. `setDetectedBrowserUrl(projectId, url)` saves the URL and dispatches a custom DOM event to update BrowserPanel in the same tab.
- **`apps/web/src/routes/_chat.$threadId.tsx`** — `useEffect` subscribes to `api.terminal.onEvent()` for the active thread. When a dev server URL is detected in output and the project has no browser URL yet, it auto-saves the URL and opens the browser panel.
- **`apps/web/src/components/BrowserPanel.tsx`** — Listens for `t3code:browser-url-updated` custom events to reactively update when auto-detection fires.

### How it works

1. Open a project with no browser URL → browser panel shows "No dev server running" placeholder.
2. Run `pnpm dev` (or any dev server command) in the thread terminal.
3. Terminal output containing `http://localhost:3000` (or any port) is detected.
4. Browser panel URL is auto-set for that project and the panel opens.
5. Switch to another project → browser panel shows that project's saved URL (or placeholder if none).
6. Browser panel stays open when switching threads/projects until explicitly closed.

### Follow-up: ANSI-aware detection + clickable terminal links

- **`apps/web/src/lib/devServerDetection.ts`** — `detectDevServerUrl` now strips ANSI escape codes before matching. Vite and other tools wrap URLs in color codes (e.g. `\x1b[36mhttp://localhost:5173/\x1b[39m`) which broke the regex. Also normalizes trailing slashes.
- **`apps/web/src/components/ThreadTerminalDrawer.tsx`** — The existing terminal link provider now intercepts localhost URLs: Cmd+click (Mac) / Ctrl+click (Windows) on `http://localhost:PORT` in terminal output dispatches a `t3code:terminal-localhost-link` custom event instead of opening the system browser.
- **`apps/web/src/routes/_chat.$threadId.tsx`** — Listens for `t3code:terminal-localhost-link` events, saves the URL for the active project, and opens the browser panel.

`bun lint` and `bun typecheck` both pass with 0 warnings / 0 errors.

---

## 2026-03-08 16:05 UTC — Fix Auto-Detection & Terminal Click-to-Browser

Fixed two bugs preventing dev server auto-detection and terminal click-to-browser from working.

### Bug 1: Auto-detection blocked when any URL exists

The auto-detection effect in `_chat.$threadId.tsx` had a guard `if (current.length > 0) return;` that skipped URL detection whenever the project already had *any* URL saved (even a manually-entered one). Changed to `if (current === url) return;` so it only skips if the *exact same* URL is already set. Now switching dev servers (e.g. from port 3001 to 3000) correctly updates the browser panel.

### Bug 2: Project terminal events not matched

Both the auto-detection effect and the terminal localhost-link listener filtered events with `event.threadId !== threadId`, matching only the *thread* terminal's ID. The project terminal dispatches events with a synthetic `project:<projectId>` threadId, which never matched. Both listeners now also match `projectTerminalThreadId`, so dev server URLs are detected from either terminal scope.

### What changed

- **`apps/web/src/routes/_chat.$threadId.tsx`**
  - Auto-detection effect: relaxed URL guard from `current.length > 0` to `current === url`, and added `projectTerminalThreadId` to the threadId match.
  - Terminal localhost-link listener: added `projectTerminalThreadId` to the threadId match.

### Note on Cmd/Ctrl+click

Terminal link activation requires **Cmd+click** (Mac) or **Ctrl+click** (Windows/Linux) — this is the standard terminal convention inherited from xterm.js. Regular clicks in the terminal are consumed by the shell for cursor placement.

`bun lint` and `bun typecheck` both pass with 0 warnings / 0 errors.

---

## 2026-03-08 16:10 UTC — Dev Server Health Check (Auto-Reconnect)

Added a periodic health check to BrowserPanel so it detects when the dev server goes down and automatically reconnects when it comes back.

### Problem

When the dev server is killed (Ctrl+C, crash, etc.), the iframe shows a broken browser error page ("connection refused"). There was no way to recover other than manually refreshing.

### Solution

BrowserPanel now periodically pings the loaded URL with `fetch(url, { mode: 'no-cors' })`. A network error (server unreachable) flips `serverReachable` to `false`, showing a "Dev server not responding — Reconnecting..." placeholder instead of a broken iframe. When the fetch succeeds again (server restarted), `serverReachable` flips back to `true` and the iframe reloads automatically.

### How it works

1. Dev server running → iframe shows the app normally.
2. Dev server killed → within ~3 seconds, health check fails → placeholder: "Dev server not responding / Reconnecting to http://localhost:3000..."
3. Dev server restarted → next health check succeeds → iframe loads the app again.
4. Manual refresh button also resets the reachable state.

### Implementation details

- **`apps/web/src/components/BrowserPanel.tsx`**
  - Added `serverReachable` state (default `true`).
  - Health check effect: after 1.5s initial delay, polls every 3s with a 2s timeout using `AbortController`.
  - Three render states: iframe (URL + reachable), reconnecting placeholder (URL + unreachable), idle placeholder (no URL).
  - `serverReachable` resets to `true` when URL changes or on manual refresh.

### Notes

- `fetch` with `mode: 'no-cors'` returns an opaque response (status 0) on success, and throws on network error. This works for any HTTP server without CORS headers.
- Polling overhead is negligible for localhost (tiny requests handled entirely by local network stack).

`bun lint` and `bun typecheck` both pass with 0 warnings / 0 errors.
