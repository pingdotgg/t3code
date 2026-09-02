# Desktop (Qt) shell

`apps/desktop-qt` is a second desktop client next to the Electron app. It is a
compiled Qt 6 / QML binary (`t3code-qt`) that hosts the web app in a
`WebEngineView` and makes everything around the web view - window, chrome,
layout, colours - a set of QML "bricks" a user can rearrange and restyle from
`~/.t3/shell/`. It coexists with `apps/desktop`; nothing in `apps/web` or
`apps/server` may become Qt-specific.

## Process model

```
t3code-qt (C++/QML, the shell)
  └─ spawns ─► node apps/desktop-qt/host/main.ts  (the desktop host)
                 └─ spawns ─► node apps/server/src/bin.ts --no-browser  (the server)
WebEngineView ──── WebSocket ────────────────────────────────────────────► server
WebEngineView ◄─── WebChannel ───► QML bricks
```

- **The web view is the brain.** It keeps its normal WebSocket client to the
  server, exactly as in a browser tab. The shell never speaks the app protocol
  and holds no domain state.
- **The Node desktop host** owns everything TypeScript-owned: server lifecycle
  today; SSH, Tailscale, secrets, saved environments and updates as they are
  ported from `apps/desktop`. It reports to the shell over its stdout as
  newline-delimited JSON (`{"type":"ready","url":...}`); the shell closes the
  host's stdin when it exits, which is the host's cue to shut the server down.
- **QML gets everything from the web view over WebChannel**, nothing else.
  State flows web → QML (`t3Shell.publish(key, value)` → `Shell.state[key]`);
  actions flow QML → web (`Shell.dispatch(action, payload)` →
  `t3Shell.onAction(listener)`).
- The UI-owned parts of `desktopBridge` (open external, window commands,
  colour scheme, dialogs/context menus later) are served by the shell over the
  same channel; the TypeScript-owned parts stay on the Node side.

Attach mode (`--url <pairing url>`) skips the host entirely and loads a
running dev server; this is what `vp run dev:qt` uses.

### Web engine

- **One profile.** `src/WebProfile.cpp` configures Qt WebEngine's default
  profile and registers it as the `WebProfile` singleton: storage and a 64 MiB
  disk HTTP cache under `<T3 home>/userdata/shell-web` (`--home-dir`, then
  `T3CODE_HOME`, then `~/.t3`), cookies forced persistent, permissions stored.
  Every `WebSurface` shares it, so the embed panel reuses the primary's
  session and the bundle comes from cache on the next start. Chromium cannot
  share a profile directory between processes: a second shell on the same
  home finds the lock file taken and stays off-the-record for its run.
- **One renderer per surface.** Chromium gives each top-level view its own
  renderer process (roughly the app bundle's footprint each), which is the
  price of the panel being a separate document. The panel surface sets
  `sleepsWhenHidden`, so its page is frozen (no timers, no painting) while the
  panel is closed and resumes where it was; discarding it would also drop the
  terminals it holds. The primary surface never sleeps.
- **The channel carries no properties.** QWebChannel re-sends a changed
  property to every connected page, so `Shell.state` is not on it: pages talk
  to `ShellChannel` (`publish`, `dispatch`, `snapshot`, `actionRequested`,
  `stateEntryChanged`), and `shell-connect.js` pulls the map lazily. A page
  that never reads it (the primary) is never sent its own publishes back.
- **Per-key bindings.** `Shell.state` is a `QQmlPropertyMap`, so a publish
  only re-evaluates bindings on that key. Keys are declared up front in
  `ShellBridge.cpp`; a rice can read any of them, but a new key must be added
  there before a binding will follow it.
- **Permissions and downloads.** Pages get the async clipboard; every other
  permission is denied (there is no notification presenter yet). Downloads
  are accepted into the user's download folder.
- **No width animation on the surfaces' neighbours.** Animating the sidebar
  or panel width resizes the web view every frame, which is a Chromium
  relayout and a new GPU surface each time; both snap instead.

## Source layout

| Path                    | Role                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `src/main.cpp`          | CLI flags, config dir resolution, wiring                             |
| `src/ShellRuntime.*`    | QML engine generations, `shell.qml` resolution, hot reload, fallback |
| `src/ShellBridge.*`     | The `shell` WebChannel object / `Shell` QML singleton                |
| `src/ThemeStore.*`      | `theme.json` loader + watcher, `Theme` QML singleton, CSS injection  |
| `src/BackendProcess.*`  | Spawns the Node desktop host, waits for `ready`                      |
| `qml/T3/Bricks/`        | Pure-QML bricks (see below) and the injected `js/shell-connect.js`   |
| `scripts/gen-icons.mjs` | Regenerates `js/lucide.js`, the icon paths `ShellIcon` draws         |
| `host/main.ts`          | Node desktop host                                                    |
| `scripts/dev-qt.mjs`    | Build, pair with the dev server, launch                              |
| `examples/`             | Starter `theme.json` and `shell.qml`                                 |

QML modules: `T3.Shell` is C++-only (`Shell`, `Theme`, `Runtime` singletons,
registered once and shared by every engine generation). `T3.Bricks` is
QML-only with a hand-written `qmldir` (no `prefer` line) so the same directory
works compiled into the binary and as an on-disk import path.

The bricks come in two layers. Chrome bricks each own one piece of the page's
chrome and read one key of `Shell.state`: `Sidebar`, `Workspace` (the header
strip), `Composer`, `RightPanel`, `SettingsNav`, `GitActions`,
`Notifications`, `ContextMenuHost`, plus `WebSurface`, `DefaultShell` and
`ShellErrorOverlay`. Under them sit the primitives a rice composes its own
chrome from, all styled from `Theme`: `ShellWindow` (the root every rice
starts from: theme-driven colour, opacity and frame, `sidebarCollapsed` /
`settingsActive` read from the page, the shell's context menus, the error
overlay and the page's window commands), `ShellCard` (a rounded, hairlined
panel), `ShellButton` (outline, `subtle` ghost, `primary`), `ShellComboBox`
(ghost, `outline: true` for a field), `ShellSplitButton` (the header's action

- chevron pill), `ShellMenu` / `ShellMenuItem`, `ShellTextField`, `ShellIcon`,
  `WindowControls` (glyph buttons, or macOS traffic lights with
  `trafficLights: true`) and `TitleBar`. `ShellIcon` draws the page's lucide
  icons as a `Shape` from the path table in `js/lucide.js`, so bricks pass an
  icon name (`iconName: "git-branch"`) and get the same glyph the HTML shows, at
  any size or color.

`DefaultShell` is laid out like the page: the sidebar's brand band ("T3 Code"
plus the collapse toggle), a 52 px header strip with the breadcrumb and the
run / open / git pills, the timeline, and the composer card with the checkout
strip welded under it. Frameless windows get their drag handle and buttons
from the brand band and the header strip (`Sidebar.window`,
`Workspace.window`), not from a `TitleBar`; the examples that want a title
bar row still use that brick.

## Setup

Requirements: CMake ≥ 3.21, Ninja, a C++20 compiler, Qt ≥ 6.9 with
`WebEngineQuick` and `WebChannel`, Node (the host runs from TypeScript source).

- macOS: `brew install qt` (6.11 at time of writing, WebEngine included).
- Linux: distro Qt often lacks WebEngine; prefer the official binaries via
  `uvx aqtinstall install-qt linux desktop 6.11.1 -m qtwebengine qtwebchannel qtpositioning`
  and set `QT_PREFIX=~/Qt/6.11.1/gcc_64`.
- CI/release builds use `aqtinstall` on every platform for reproducibility.

```sh
vp run dev        # terminal 1: server + web (single origin)
vp run dev:qt     # terminal 2: cmake configure/build, `t3 pair`, launch with --url
```

`dev:qt` resolves the data directory the way `vp run dev` does (`--home-dir`,
else the worktree's own `.t3`, else `T3CODE_HOME`, else `~/.t3`), pairs with
the server running there, and launches the shell with that directory as its
`T3CODE_HOME` so it rices from the matching `shell/`. Pass the same
`--home-dir` to both commands if you set one. Its other flags are `--url` (skip
pairing), `--release` (no disk QML loading) and `--configure-only` (build, do
not launch); everything else is forwarded to the binary, so
`vp run dev:qt --screenshot out.png --action rightPanel.toggle` works.
`pnpm --filter @t3tools/desktop-qt build:qt` builds without launching. Build
output lands in `apps/desktop-qt/build/<debug|release>` (gitignored).

Standalone (no dev server): run the binary with no `--url`; it spawns the host,
which starts the server against a built `apps/web` (`vp run build`).

CLI: `--url`, `--config-dir`, `--qml-dir`, `--host-entry`, `--node`, `--screenshot <png>`
(grab the window after the page loads, then quit — PR evidence without a
screen-recording permission), `--action name[=json]` (repeatable; dispatch shell
actions after the page loads, e.g. `--action rightPanel.toggle`); env
`T3CODE_HOME`, `T3CODE_QML_DIR`, `T3CODE_NODE`, `T3CODE_SERVER_ENTRY`.

## Ricing contract

Config dir: `$T3CODE_HOME/shell/`, so `~/.t3/shell/` by default on every
platform and `<worktree>/.t3/shell/` for a sandboxed dev run; `--config-dir`
overrides it.

### `theme.json`

The file _is_ the interface for colour propagation: theme managers (omarchy
themes, pywal templates, a hand-written file) write it and the app follows.
The shell itself does not import terminal configs; the generator that comes
closest, `examples/terminal/theme-from-terminal.mjs`, asks the running
terminal for its palette over OSC 10 / 11 / 12 / 17 / 4 and writes a
`theme.json` from the answer, keeping the shell on the file contract.

Its shape is the web app's own `ThemeFile` (`apps/web/src/themePalette.ts`;
the Settings → Theme editor exports it) plus a shell-only `window` section:

```json
{
  "version": 1,
  "id": "tokyo-night-shell",
  "name": "Tokyo Night (shell)",
  "appearance": "dark",
  "colors": { "canvas": "#1a1b26", "chrome": "#16161e", "text": "#c0caf5", "sidebar": "#16161e" },
  "variants": { "light": { "canvas": "#e1e2e7" } },
  "window": { "opacity": 0.96, "transparent": false, "blur": false, "frameless": true }
}
```

- `colors.*` keys are the web's theme roles (`canvas`, `chrome`, `surface`,
  `text`, `textMuted`, `accent`, `sidebar`, `terminalBackground`, … — the
  `ThemeColorRole` list in `packages/shared/src/themePalettes.ts`).
  `variants.<appearance>` overrides `colors` for that appearance.
- The shell applies them to the page exactly as the web app applies its own
  themes: `data-theme-id` on `<html>` plus inline `--app-theme-<role>`
  variables, re-asserted if the web app's stored preference overwrites them.
  Until the SPA applies shell themes itself, supply the full role set
  (the files under `examples/*/` do) — a missing role has no fallback on this path.
- QML reads the same roles: `Theme.colors`, `Theme.color("chrome", fallback)`,
  `Theme.appearance`, `Theme.id`.
- `window.*` is shell-only: `opacity` (whole-window), `transparent` (window and
  web view background cleared; compositor rules do the blur on Wayland),
  `blur` (advisory for platform hooks), `frameless` (default `true`).
- The file is watched; edits apply live to QML and to the page. A malformed
  file keeps the previous good theme and sets `Theme.lastError`. Deleting it
  removes the shell's variables; the web app's own theme returns on its next
  apply.

### `shell.qml`

If `~/.t3/shell/shell.qml` exists it is loaded as the root instead of the
built-in `DefaultShell.qml`. It composes bricks from `T3.Bricks` and reads the
`T3.Shell` singletons:

- `Shell.pageUrl`, `Shell.state` (whatever the web app published),
  `Shell.dispatch(action, payload)`, `Shell.windowCommandRequested(command)`.
- `Theme.*` as above.
- `Runtime.configDir`, `Runtime.userShellPath`, `Runtime.usingUserShell`,
  `Runtime.lastError`, `Runtime.reload()`.

Extra QML modules can live under `~/.t3/shell/qml/` (it is on the import
path). If `shell.qml` fails to load, the default shell takes over with
`ShellErrorOverlay` showing the error; a broken rice never locks the app.

### Hot reload

`ShellRuntime` watches the config dir and, in non-release builds, the in-repo
`qml/` directory. A change to any `.qml`/`.js`/`qmldir` file rebuilds the whole
engine generation (new window first, then the old one is dropped, so the app
never hits "last window closed"). The web view is recreated with the window
and reloads the page; keeping it alive across generations is a follow-up.
QmlLive was evaluated and rejected: unmaintained since 2019, Qt 5 only.

## Page-side API

`WebSurface` injects `qwebchannel.js` (bundled from Qt's data dir at build
time) and `js/shell-connect.js` at document creation, which exposes:

```ts
window.t3Shell: {
  protocolVersion: number;                           // 1
  surfaceId: string;                                 // "primary" | "rightPanel"
  ready: Promise<ShellObject>;                       // raw WebChannel proxy
  publish(key: string, value: unknown): Promise<void>;
  dispatch(action: string, payload?: unknown): Promise<void>;
  onAction(listener: (action: string, payload: unknown) => void): Promise<() => void>;
  getState(): Promise<Record<string, unknown>>;      // everything published, any document
  onState(listener: (state: Record<string, unknown>) => void): Promise<() => void>;
}
```

`window.t3Shell` is undefined in a browser tab; the web app must keep working
without it. `apps/web/src/env.ts` exports `isT3Shell` (module-load-time, like
`isElectron`). The contract — what gets published under which key and which
actions exist — lives in `packages/contracts/src/shell.ts` and is imported as
`@t3tools/contracts/shell`, not from the package barrel, so browsers never
bundle it. The bridges follow the same rule: `apps/web/src/shell/lazy.tsx`
wraps each one in `React.lazy`, and only a shell-hosted document ever imports
`shell/bridges.ts`. Every bridge decodes actions through `useShellActions`
(one subscription per bridge, handlers read live props) and publishes through
`useShellPublish` (skips unchanged JSON, clears the key on unmount).

### `sidebar`

`apps/web/src/shell/T3ShellBridge.tsx` (mounted from the root route when
`isT3Shell`) publishes `ShellSidebarState`: project groups, the current scope,
and the thread list already bucketed (`pinned`/`active`/`snoozed`/`settled`),
sorted, and annotated with status, status label, unread, branch. It is derived
with the same code as the HTML sidebar — `partitionSidebarThreads` and
`useSidebarProjectGroups` are shared — so the two never disagree. `settled` is
capped at 50 rows with `settledTotal` carrying the real count. When hosted,
`AppSidebarLayout` renders no thread sidebar (the settings nav stays HTML).

Actions (`Shell.dispatch(name, payload)` in QML → `ShellAction` on the page):
`thread.open {key}`, `draft.open {draftId}`, `thread.new {projectKey?}`,
`sidebar.scope {projectKey|null}`, `project.add`, `settings.open`,
`pullRequests.open`, `usage.open`, `palette.open`. Unknown or malformed
actions are dropped by the schema guard.

### `composer`

`apps/web/src/shell/ShellComposerBridge.tsx` is mounted _inside_
`ChatComposer` when hosted, so approvals, user-input questions, plan
follow-ups, attachments and mentions keep their one implementation. It
publishes `ShellComposerState` — draft text, placeholder, whether sending is
possible and why not, running/connecting flags, enabled provider instances
with their models (and per-model disabled reasons), the selected model, the
provider option descriptors (reasoning effort etc.), runtime modes and the
plan/build toggle. `ChatComposer` hides its editor and footer when hosted;
the editor comes back for approval and user-input flows, which type answers
through it.

Actions: `composer.text.set {text, cursor?}` (debounced from the QML
editor), `composer.submit {text?, intent?}` (text rides along so the send is
atomic with the last edit), `composer.interrupt`, `composer.model.select
{instanceId, model}`, `composer.option.set {id, value}`,
`composer.runtimeMode.set {mode}`, `composer.interactionMode.set {mode}`,
`composer.suggest.select {id}`, `composer.suggest.dismiss`.

`@file`, `$skill` and `/command` suggestions reuse `ChatComposer`'s own
trigger detection and menu: the QML editor edits the raw prompt (mentions
written out as `[label](path)`), so it sends an _expanded_ caret with each
edit; `ChatComposer` collapses it, re-detects the trigger and publishes
`triggerKind`, `suggestions` and `suggestionsEmptyText`. Selecting sends the
item id back and the page applies the same replacement the HTML menu would,
then publishes the new `text` and `cursor` for the editor to adopt.

### `rightPanel`

The right panel is the first brick whose _content_ stays HTML but whose
_placement_ is the shell's: `RightPanel` renders the tab strip natively and
loads the app's embed route (`/embed/$environmentId/$threadId`) in a second
`WebSurface`. Both surfaces share the shell's profile (see Web engine), so
the embed document has the primary's session cookie and authenticates without
a pairing token; it opens its own WebSocket, and sleeps while the panel is
closed.

The embed route renders `ChatView` with `presentation="rightPanel"`, which
returns only the panel's content — every hook, handler and per-surface
component stays in one place. The two documents converge on the tab model
through localStorage: `shell/shellDocumentSync.ts` rehydrates the right
panel, terminal and diff stores whenever another document wrote them.
Composer drafts are deliberately not synced (both documents write them).

`ShellRightPanelBridge` (mounted by `ChatView` when hosted) publishes
`ShellRightPanelState`: open flag, surfaces with titles, the active surface,
what can be added, and `embedPath`. `ChatView` hides its inline panel, sheet
and layout toggles when hosted. Actions: `rightPanel.toggle`,
`rightPanel.activate {id}`, `rightPanel.close {id}`, `rightPanel.add {kind}`
(`diff | files | terminal | pull-request | agents`). The embed document
follows the primary one through `ShellEmbedRouteBridge`, which navigates in
place when `rightPanel.threadKey` changes.

Known gaps: the browser/preview surface needs the Electron preview host and
is unavailable under the shell; "add to composer" from a terminal selection in
the embed document has no composer to reach yet.

### `workspace`

`ShellWorkspaceBridge` (mounted by `ChatView` when hosted) publishes
`ShellWorkspaceState`: project and thread titles, checkout mode (and whether
it can still change), branch and worktree, a git summary (dirty, ahead/behind,
linked PR), the environments the logical project spans, available editors
with the preferred one, and project scripts. `ChatHeader` keeps only the git
control (`shellHosted`), since commit/push/PR flows carry dialogs and progress
UI that live with that control; the branch toolbar under the composer is not
rendered. The `Workspace` brick renders the breadcrumb and the run / open
pills; the branch toolbar's contents (environment, checkout mode, branch
picker, PR badge) are the context strip under the `Composer` brick, where the
page puts them. Actions: `workspace.newThread`, `workspace.openInEditor
{editorId?}` (same command and preference as the HTML picker),
`workspace.runScript {scriptId}`, `workspace.envMode.set {mode}`,
`workspace.startFromOrigin.set {enabled}`, `workspace.openPullRequest`,
`workspace.environment.set {environmentId}`.

Branch switching is native too: the selector's brain moved into
`hooks/useThreadBranchSelection.ts` (thread/draft resolution, paginated ref
list for a query, optimistic active branch, `selectBranch`/`createRef` which
stop a live session and rewrite the thread's checkout), and both the HTML
`BranchToolbarBranchSelector` and the bridge consume it. The state carries
`branches` for the current `branchQuery` plus `branchesTotal`,
`branchesLoading`, `branchSwitchPending`; actions `workspace.branch.search
{query}`, `workspace.branch.select {name}`, `workspace.branch.create {name}`.

Renaming is native too (`workspace.rename {title}`, with `renameRequestId`
bumping when the page asks the brick to start editing) and the title's
context menu comes from `workspace.titleMenu {x, y}`.

### `settings`

Settings are whole HTML pages, so only their navigation moves: the root
route mounts `ShellSettingsBridge` when hosted, which publishes
`ShellSettingsState` on every route change — `active` (on `/settings*`),
the sections in sidebar order, the active one, and search results for the
query the shell last sent (the same `searchSettings` catalog the HTML nav
uses). `DefaultShell` swaps the `Sidebar` brick for `SettingsNav` while
`active`. Actions: `settings.navigate {to}`, `settings.openResult {to,
targetId}` (scrolls when already on the page), `settings.search {query}`,
`settings.back` (history back, else `/`). When hosted, `AppSidebarLayout`
renders no sidebar on any route.

Bridges tied to a thread route (`workspace`, `composer`, `rightPanel`)
publish `null` for their key on unmount, so leaving a thread clears the
native chrome instead of freezing it on the last thread.

### `theme` (page → shell)

`ShellThemeBridge` (root route, when hosted) resolves every theme role from
the page's semantic CSS variables — painting each through a canvas so
`oklch()`/`color-mix()` become sRGB hex — plus `--radius` and the font lists,
and republishes on theme, appearance or custom-theme changes. `Theme.color()`
resolves theme.json first, then this page theme, then the brick's fallback;
`Theme.radius`, `Theme.fontUi`, `Theme.fontMono` follow the same order (the
shell-only `radius` / `fonts` keys in theme.json override the page). The
themed controls (`ShellButton` etc.) take radius, surfaces, borders and fonts
from `Theme`, so native chrome matches the page by default and follows
whatever the user picks in Settings.

### `layout`

The page keeps owning the main sidebar's open state (its `sidebar.toggle`
keybinding, Mod+B by default, still works when hosted) and publishes it as
`layout {sidebarCollapsed}` from `ShellLayoutBridge`, mounted inside the
sidebar provider. `sidebar.toggle` flips it from native chrome — the
`Workspace` brick shows a toggle when its `sidebarToggle` property is bound
(it takes the sidebar's place at the strip's left edge, as on the page), and
`Sidebar` shows the matching collapse toggle in its brand band when
`showBrand` is on. The right panel's toggle follows the same pattern:
`Workspace.panelToggle` puts it in the header strip and `RightPanel
{ ownToggle: false }` then takes no width while closed; a rice that leaves
`ownToggle` on gets the 36 px rail with the toggle instead.
The shell only animates the result: `DefaultShell` and the examples ease the
sidebar's `Layout.preferredWidth` to 0 and hide it once it is gone
(`visible: !sidebarCollapsed || width > 0` — guard on the collapsed flag, not
on width alone, or a layout-managed item never regains a size).

`Sidebar` carries the search and new-thread row, the project scope picker
and "add project" under its brand band, and the app's places (Settings, PRs,
Usage) in its footer. A rice that puts those somewhere else — the dashboard
example's icon rail — sets `showScope: false` and `showFooter: false` so the
same action is not reachable from two places; `showBrand` is off by default
because most rices bring their own title bar.

### `notifications`

`ToastProvider` accepts a `shellMirror` rendered inside it; the mirrored
toasts still get a hidden `Toast.Root` in the HTML viewport, because Base UI
only drops a closed toast once its root has finished leaving. `ShellToastBridge`
mirrors the page's stacked toasts (title, description, buttons, update key)
as `notifications` and runs a toast's button or dismissal on
`notification.action {id, actionId}` / `notification.dismiss {id}` — the
same `onClick`/`onClose` the HTML buttons call. Toasts with React-element
bodies or anchored positioning stay in the page. The `Notifications` brick
renders the rest.

### `contextMenu`

`localApi.contextMenu.show` routes to the shell when hosted: the items are
published under `contextMenu` with the surface they belong to (every web
surface tags its document with `window.t3Shell.surfaceId`; `"shell"` means
window coordinates from native chrome) and the choice returns as
`contextMenu.select {requestId, id}`. `ContextMenuHost` lives in each
`WebSurface` and once at the window level. This makes every context menu in
the app native; the thread title menu (`workspace.titleMenu {x, y}`) and
sidebar rows (`thread.menu {key, x, y}`) open the thread action menu through
it, and `workspace.rename {title}` / `renameRequestId` drive an inline rename
in the strip via the shared `useRenameThread` hook.

### `git`

`useGitActions` (extracted from `GitActionsControl`) owns the status query,
the stacked-action runner with its progress/result toasts, the default-branch
gate and the thread↔branch sync. When hosted the control renders
`ShellGitBridge` — publishing the quick action, menu items with disabled
reasons, hints, working-tree files and the pending confirmation — plus the
publish-repository dialog (still HTML). Actions: `git.quick`, `git.menu
{id}`, `git.commit {message, filePaths|null, featureBranch}`,
`git.defaultBranch {choice}`, `git.init`, `git.publish`, `git.refresh`. The
`GitActions` brick renders the split button, the commit dialog (file
checklist + message) and the confirmation.

### Composer layout

The `Composer` brick is the page's composer card: a centered card (768 px
max) with the attachment chips, the editor and a footer of ghost pickers —
model, effort, permissions, the plan/build toggle — and the round send/stop
button. The context strip hangs under the card with the environment
selector, the checkout-mode picker, the PR badge and the branch button
(`workspace.*` actions); the branch picker pops upward from it.

### Composer extras

`composer.attach {files:[{name, mimeType, base64}]}` feeds shell-read image
files into the composer's drop pipeline (the brick reads dropped or picked
files through `Shell.readImageFiles`, 10 MB cap, images only).
`composer.terminalContext.add {…selection}` adds a terminal selection; the
embed document's terminal forwards its selections with `t3Shell.dispatch`, so
they land in the primary's draft. Attached images and terminal contexts are
published as removable chips (`composer.attachment.remove`,
`composer.terminalContext.remove`).

## Linux and packaging

`window.blur` is native on macOS (an `NSVisualEffectView` behind the Qt view,
`src/PlatformWindow.mm`, tinted by the theme's appearance). On Linux
`QGuiApplication::setDesktopFileName("t3code")` sets the Wayland app id /
X11 `WM_CLASS`, so compositor rules can target the window — on Hyprland:
`windowrulev2 = opacity 0.9, class:^(t3code)$` and `decorate:blur` — with
`window.transparent: true` in theme.json for the compositor to blur through.
`.github/workflows/desktop-qt.yml` builds Release binaries on Linux and
macOS with the official Qt 6.9 binaries (`jurplel/install-qt-action`) and
packages an AppImage (`scripts/package-linux.sh`, linuxdeploy + its Qt
plugin) and a macOS bundle (`macdeployqt`). The Node desktop host still
requires a system Node at runtime. The Linux path was written against the
documented tooling but has only been exercised in CI, not on this machine.

## Splitting chrome out

Every piece of chrome from the original list now has a brick: `Sidebar`,
`Composer`, `RightPanel` (+ embed route), `Workspace`, `SettingsNav`. The
timeline and the settings pages stay HTML by design. The timeline and terminal stay HTML. Each split-out piece becomes one
brick with a documented state/action surface; in the shell the SPA simply does
not render the parts that moved out. When an HTML brick needs to live somewhere QML decides, it becomes a second
`WebEngineView` loading an embed route with its own server connection (the
right panel is the precedent); the primary view stays the brain.

## Release targets

Linux AppImage and macOS `.app` first, Windows later. The runtime Node is not
bundled: the host requires a system Node matching `apps/server`'s engine range.
