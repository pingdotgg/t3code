# Per-Project and General Terminal + Resize Debounce
## Problem
Three issues to address:
1. **Resize spam** — `ThreadTerminalDrawer`'s window-resize handler calls `setResizeEpoch` synchronously on every resize event, flooding the shell process with SIGWINCH and causing prompt-reprint spam.
2. **Per-project terminal** — The existing per-thread terminal (`SquareTerminalIcon` in `ChatHeader`) is scoped to a thread: it resets when switching threads. Users need a terminal that persists across thread switches within the same project (e.g. to keep `pnpm dev` running).
3. **General terminal** — A terminal not scoped to any thread or project, accessible from the sidebar, useful for arbitrary commands.
## Current State
* `ThreadTerminalDrawer` lives inside `ChatView` which has `key={threadId}`, so it remounts on every thread switch.
* `terminalStateStore` is keyed by `ThreadId` (branded string), but it can hold any string key — no server-side validation prevents synthetic IDs.
* `_chat.tsx` layout: left sidebar + `DiffWorkerPoolProvider` + `Outlet`. General terminal belongs here.
* `_chat.$threadId.tsx`: renders `<ChatView key={threadId} />` plus diff/browser panels outside it. Per-project terminal belongs here (outside `ChatView`).
* Server welcome payload (`WsWelcomePayload`) contains the server `cwd` — usable as the general terminal's starting directory. This is already available via `useStore` (server cwd is stored on `serverCwd` in the main store, or we can get it from `onServerWelcome`).
## Proposed Changes
### 1. Fix resize debounce (`ThreadTerminalDrawer.tsx`)
Wrap `setResizeEpoch` in `requestAnimationFrame` with cancel-on-cleanup inside the window `resize` listener. This coalesces rapid resize events into at most one state update per animation frame.
### 2. Per-project terminal (`_chat.$threadId.tsx` + `ChatView.tsx`)
* In `ChatThreadRouteView`, look up `activeProject` from the store using the thread's `projectId`. Derive a synthetic `projectTerminalId = ThreadId.makeUnsafe(\`project:${activeProject.id}`)` and subscribe to `terminalStateStore` with it.
* Render a second `ThreadTerminalDrawer` (lazy-loaded, `key={activeProject.id}`) **outside** `<ChatView key={threadId}>` so it persists across thread switches.
* Add `projectTerminalOpen` + `onToggleProjectTerminal` props to `ChatHeader`. Use `LayoutTerminalIcon` (or `MonitorIcon`) to distinguish it visually from the per-thread `SquareTerminalIcon`. Tooltip: "Project terminal (persists across threads)".
* CWD: `activeProject.cwd` (not `gitCwd` — project root, not worktree).
### 3. General terminal (`_chat.tsx` + `Sidebar.tsx`)
* In `ChatRouteLayout`, use a fixed synthetic ID `ThreadId.makeUnsafe("__global__")` and subscribe to `terminalStateStore` with it.
* Get starting CWD from the store's `serverCwd` field (the server bootstrap `cwd` from the welcome payload).
* Render `ThreadTerminalDrawer` at the bottom of the layout (inside `DiffWorkerPoolProvider`, below `Outlet`).
* Add a terminal icon button in `SidebarFooter` (above "+ Add project") to toggle it. Use `TerminalIcon` with tooltip "General terminal".
### Icon choices
* Per-thread terminal: `SquareTerminalIcon` (existing)
* Per-project terminal: `MonitorIcon` from lucide (represents project/environment scope)
* General terminal: `TerminalIcon` from lucide (represents free-form shell)
### Store access for serverCwd
Check whether `useStore` already exposes a `serverCwd`; if not, read it from `lastWelcome` in `wsNativeApi` via a small exported getter `getLastServerWelcomeCwd()`.