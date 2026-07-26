# SurgeCode for Windows — Architecture

Native Windows 11 client for the SergeCode server. Tauri 2 shell (Rust) around
a WebView2 renderer (React + TypeScript), with the Node server (`apps/server`,
npm package `t3`) running as a supervised child process — the same sidecar
shape as `apps/mac`.

```
┌─────────────────────────────────────────────────────────┐
│ SurgeCode.exe (Tauri 2, Windows 11)                     │
│                                                         │
│  src-tauri (Rust shell — the "native half")             │
│   • sidecar/  spawns node.exe dist/bin.mjs --mode desktop│
│   • sidecar/job.rs  Job Object owns the whole tree       │
│   • window.rs  DWM system backdrop (Mica) + dark caption │
│   • secrets.rs  Windows Credential Manager               │
│  src (WebView2 renderer — the UI + all protocol logic)  │
│   • @t3tools/client-runtime  effect-RPC-over-WebSocket   │
│   • theme/  Alpine design system ported from SwiftUI     │
│   • ui/  sidebar, chat, diffs, composer                  │
└──────────────┬──────────────────────────────────────────┘
               │ ws://127.0.0.1:<port>/ws + local HTTP
┌──────────────▼──────────────────────────────────────────┐
│ t3 server (Node, unchanged)                             │
│ providers: codex / claude code / grok / kimi            │
└─────────────────────────────────────────────────────────┘
```

## Why this shape

The server is the product's brain (orchestration engine, provider drivers,
SQLite persistence), so the Windows client supervises it as a child exactly as
macOS does. The split that differs is _where the protocol lives_.

`apps/mac` hand-ported the wire protocol into Swift (`T3Kit`, ~8k lines of
Codable mirrors of `@t3tools/contracts`, kept honest by fixture tests copied
from the TS side). Doing that a second time in Rust or C# would mean three
parallel implementations of one contract, each drifting on its own schedule —
directly against the repository's maintainability priority.

Instead the renderer imports `@t3tools/client-runtime`, the same package
`apps/mobile` uses: connection supervision, reconnect/backoff, auth, the thread
reducers, and the state projections all come from the monorepo and update with
`packages/contracts` automatically. The Rust shell owns only what a webview
genuinely cannot do: process supervision, Win32 window chrome, and OS secret
storage.

The cost is that the UI is HTML/CSS rather than native controls. That is a
smaller loss here than it looks: `apps/mac` is not built from stock AppKit
widgets either — it is ~45k lines of bespoke SwiftUI implementing the Alpine
design system, so the port is "reproduce a custom design system", not "map
NSButton to a Fluent Button". `src/theme/` is a direct, unit-tested port of the
Swift tokens for exactly that reason.

## Sidecar contract

Identical to macOS unless stated. Implemented in `src-tauri/src/sidecar/`.

- **Spawn**: `node.exe <server>/dist/bin.mjs --mode desktop --bootstrap-fd 0
--port <p> --host <h> --base-dir <dir>`, with `CREATE_NO_WINDOW` so no
  console flashes. Write ONE line of JSON (schema
  `packages/contracts/src/desktopBootstrap.ts` `DesktopBackendBootstrap`,
  including a random `desktopBootstrapToken`) to stdin, then close it.
- **Readiness**: poll `GET /.well-known/t3/environment` (100 ms interval, 60 s
  cap). A timeout terminates the still-running child before restarting, so the
  next launch can bind the port.
- **Restart**: exponential backoff 500 ms → 1s → 2s → 4s → 8s, capped at 10 s
  from attempt 5. `restart_attempt` resets to 0 once a run reaches ready.
- **Auth**: mode=desktop + loopback bind ⇒ server policy `desktop-managed-local`.
  Exchange the bootstrap token for a bearer token at `POST /oauth/token`
  (RFC 8693 token-exchange, `application/x-www-form-urlencoded`), then mint a
  short-lived per-connection ticket at `POST /api/auth/websocket-ticket` for
  every socket attempt. No Clerk, no DPoP.
- **Data dir**: `%APPDATA%\SergeCode\` (macOS uses
  `~/Library/Application Support/SergeCode/`). Logs rotate one generation into
  `<baseDir>\logs\sidecar\stdout.log{,.1}`.
- **Mobile (Settings ▸ iPhone)**: enabling local-network access binds `0.0.0.0`
  instead of loopback (policy flips to `remote-reachable`). Bind host is fixed
  per process, so toggling requires a relaunch — `preferences.rs` is read
  before the spawn for exactly this reason. The pairing QR encodes
  `http://<lan-ip>:<port>/pair#token=<code>`, the shape `apps/mobile`'s scanner
  parses.

### Shutdown: the one place Windows genuinely differs

macOS sends SIGTERM, waits 2 s, then SIGKILL, and `AppDelegate`
`applicationShouldTerminate` blocks the quit until that finishes — otherwise
the node child is orphaned, because `Process` does not kill children when its
owner exits.

Windows has no SIGTERM, and no way at all to run cleanup after a hard crash or
a Task Manager "End task". So ownership is structural instead of procedural:
the child is assigned to a **Job Object** created with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`sidecar/job.rs`). When this process
exits for _any_ reason the kernel closes the job handle and kills every process
still in it. A sidecar can never be left holding the port and the SQLite base
dir.

The graceful path is still attempted first — `taskkill /T` without `/F`, then a
2 s grace period — so a server build that handles the console control event
gets to flush SQLite. `TerminateJobObject` is the force path, and it is
strictly better than the macOS one: it also kills the provider CLIs (codex,
claude, …) the server spawned, which a SIGKILL of node alone leaves behind.

### Node runtime resolution

`sidecar/node.rs`, priority order: `$SERGECODE_NODE` → cached path → every
`PATH` entry → well-known install locations (`%ProgramFiles%\nodejs`,
`%LOCALAPPDATA%\Programs\nodejs`, Volta, Chocolatey, Scoop, `%NVM_SYMLINK%`).
Each candidate must satisfy `apps/server`'s engines range
(`^22.16 || ^23.11 || >=24.10`).

There is deliberately **no login-shell probe**. macOS needs one because a
Finder-launched GUI process inherits a minimal `PATH` with no Homebrew and no
version manager; on Windows the user `PATH` comes from the registry and GUI
processes inherit it intact, so scanning it directly finds what a terminal
would.

Release builds skip all of it: the installer embeds a version-pinned
`node.exe` and the server payload, staged by `scripts/stage-sidecar.mjs` and
declared as bundle resources in `tauri.conf.json`.

## Connection: why the local sidecar is a _bearer_ connection

`packages/client-runtime`'s `PrimaryConnectionTarget` assumes same-origin
cookie auth — how the browser client talks to the server that served it. A
Tauri webview is served from `tauri://localhost`, a different origin from
`http://127.0.0.1:<port>`, so cookies never apply.

client-runtime already models this case: _"secondary local backends live on a
separate loopback origin and authenticate with a bearer token minted from their
bootstrap credential"_ (`connection/catalog.ts`). The Windows app's own sidecar
is exactly that shape, so it registers as a `BearerConnectionRegistration`
emitted from `PlatformConnectionSource`. `src/connection/desktopBootstrap.ts`
performs the handshake; `src/app/useSidecar.ts` re-runs it whenever the
supervisor hands out a new endpoint, because the token is minted per sidecar
process.

## Window chrome and the layer stack

`src-tauri/src/window.rs` maps the macOS translucency model onto DWM:

| macOS                               | Windows 11                         |
| ----------------------------------- | ---------------------------------- |
| behind-window blur (desktop)        | `DWMSBT_MAINWINDOW` (Mica)         |
| translucent chrome over content     | `DWMSBT_TRANSIENTWINDOW` (Acrylic) |
| fully solid window (translucency 1) | `DWMSBT_NONE`                      |

Everything above the backdrop is identical maths on both platforms.
`src/theme/glass.ts` is a direct port of `Theme/GlassLayering.swift`, including
the invariant that makes the slider honest: **photo + wash composite to exactly
the requested translucency**, so `1 - t` of the desktop reaches the user, and
the window plate stays at zero until the ramp band. Both traps the macOS file
documents apply verbatim in CSS:

- The plate is a window-wide layer under the scenery, so any alpha it spends is
  alpha the desktop can never reach.
- Fading a stack of two opaque layers separately composites both. SwiftUI needs
  `.compositingGroup()`; CSS needs `isolation: isolate` on the scenery group
  with a single `opacity` on the group, never one per child.

The title bar keeps Windows' native caption (`decorations: true`). Snap
Layouts, the maximize hover menu, and the system menu are worth more than a
pixel-identical unified toolbar; the app's toolbar band sits directly under the
caption and is itself a drag region.

## Scope

**v1 (this PR's foundation + the handover work):** project/thread sidebar, chat
timeline (turns, streaming tokens, tool events), composer with @-mentions,
slash commands and image attachments, approvals, plan mode and proposed-plan
cards, model/runtime pickers, context-window meter, diff panel with
checkpoints, git/VCS toolbar, editable settings, provider status, scenery and
the Alpine theme, auto-update, and LAN iPhone pairing.

**Out for now:** dictation (macOS uses FluidAudio/Parakeet CoreML, which is
Apple-only — a Windows substitute needs whisper.cpp or ONNX Runtime and was
deferred), embedded terminal, browser preview, Clerk/T3 Connect cloud auth and
relay (permanently out for the fork), SSH/Tailscale remotes, keybindings
editor.

## Build

```powershell
vp run --filter t3 build:bundle          # build the server bundle first
node apps/windows/scripts/stage-sidecar.mjs   # release builds only
vp run --filter @sergecode/windows typecheck
vp run --filter @sergecode/windows test
cd apps/windows; pnpm exec tauri dev     # or `tauri build` for the installer
```

The Rust crate also compiles and tests on macOS/Linux, with every
`cfg(windows)` path replaced by an explicit no-op, so the shared supervisor
logic stays testable on a development machine. The Windows-only code is
verified by `.github/workflows/ci-windows.yml`, which runs `cargo clippy -D
warnings` and `cargo test` on `windows-latest` for every PR. Cross-compiling
those paths from macOS is not possible here: `tauri-winres` needs `llvm-rc`
and `tauri-plugin-updater` pulls `ring`, which needs the Windows SDK headers.
