# Desktop (Qt) shell

`apps/desktop-qt` is a second desktop client next to the Electron app. It is a
compiled Qt 6 / QML binary (`t3code-qt`) that hosts the web app in a
`WebEngineView` and makes everything around the web view - window, chrome,
layout, colours - a set of QML "bricks" a user can rearrange and restyle from
`~/.config/t3code/`. It coexists with `apps/desktop`; nothing in `apps/web` or
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
running dev server; this is what `pnpm dev:qt` uses.

## Source layout

| Path                   | Role                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/main.cpp`         | CLI flags, config dir resolution, wiring                                                                               |
| `src/ShellRuntime.*`   | QML engine generations, `shell.qml` resolution, hot reload, fallback                                                   |
| `src/ShellBridge.*`    | The `shell` WebChannel object / `Shell` QML singleton                                                                  |
| `src/ThemeStore.*`     | `theme.json` loader + watcher, `Theme` QML singleton, CSS injection                                                    |
| `src/BackendProcess.*` | Spawns the Node desktop host, waits for `ready`                                                                        |
| `qml/T3/Bricks/`       | Pure-QML bricks (`DefaultShell`, `TitleBar`, `WebSurface`, `ShellErrorOverlay`) and the injected `js/shell-connect.js` |
| `host/main.ts`         | Node desktop host                                                                                                      |
| `scripts/dev-qt.mjs`   | Build, pair with the dev server, launch                                                                                |
| `examples/`            | Starter `theme.json` and `shell.qml`                                                                                   |

QML modules: `T3.Shell` is C++-only (`Shell`, `Theme`, `Runtime` singletons,
registered once and shared by every engine generation). `T3.Bricks` is
QML-only with a hand-written `qmldir` (no `prefer` line) so the same directory
works compiled into the binary and as an on-disk import path.

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
pnpm dev:qt       # terminal 2: cmake configure/build, `t3 pair`, launch with --url
```

`dev:qt` pairs with whatever server `t3 pair` discovers (worktree `.t3` first,
then `T3CODE_HOME`); run both commands with the same `T3CODE_HOME` if you set
one. `pnpm --filter @t3tools/desktop-qt build:qt` builds without launching;
`--release` builds without disk QML loading. Build output lands in
`apps/desktop-qt/build/<debug|release>` (gitignored).

Standalone (no dev server): run the binary with no `--url`; it spawns the host,
which starts the server against a built `apps/web` (`vp run build`).

CLI: `--url`, `--config-dir`, `--qml-dir`, `--host-entry`, `--node`, `--screenshot <png>`
(grab the window after the page loads, then quit — PR evidence without a
screen-recording permission); env
`T3CODE_CONFIG_DIR`, `T3CODE_QML_DIR`, `T3CODE_NODE`, `T3CODE_SERVER_ENTRY`.

## Ricing contract

Config dir: `~/.config/t3code/` on every platform (`$XDG_CONFIG_HOME/t3code`,
or `T3CODE_CONFIG_DIR`). Dotfiles should be portable, so no per-OS paths.

### `theme.json`

The file _is_ the interface for colour propagation: theme managers (omarchy
themes, pywal templates, a hand-written file) write it and the app follows.
The shell does not import terminal configs.

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
  (`examples/theme.json` does) — a missing role has no fallback on this path.
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

If `~/.config/t3code/shell.qml` exists it is loaded as the root instead of the
built-in `DefaultShell.qml`. It composes bricks from `T3.Bricks` and reads the
`T3.Shell` singletons:

- `Shell.pageUrl`, `Shell.state` (whatever the web app published),
  `Shell.dispatch(action, payload)`, `Shell.windowCommandRequested(command)`.
- `Theme.*` as above.
- `Runtime.configDir`, `Runtime.userShellPath`, `Runtime.usingUserShell`,
  `Runtime.lastError`, `Runtime.reload()`.

Extra QML modules can live under `~/.config/t3code/qml/` (it is on the import
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
time) and `js/shell-connect.js`, which exposes:

```ts
window.t3Shell: {
  ready: Promise<ShellObject>;                       // raw WebChannel proxy
  publish(key: string, value: unknown): Promise<void>;
  onAction(listener: (action: string, payload: unknown) => void): Promise<void>;
}
```

`window.t3Shell` is undefined in a browser tab; the web app must keep working
without it. The channel carries `protocolVersion` (currently `1`).

## Splitting chrome out

Order of work: sidebar first, then composer, right panel, workspace switcher,
settings. The timeline and terminal stay HTML. Each split-out piece becomes one
brick with a documented state/action surface; in the shell the SPA simply does
not render the parts that moved out. When an HTML brick needs to live somewhere
QML decides (for example the terminal), it becomes a second `WebEngineView`
loading an embed route with its own server connection; the primary view stays
the brain.

## Release targets

Linux AppImage and macOS `.app` first, Windows later. The runtime Node is not
bundled: the host requires a system Node matching `apps/server`'s engine range.
