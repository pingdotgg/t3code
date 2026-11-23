# Why these stacks

Conn has three parts of its own: the desktop client (`apps/conn-gpui`), the server
(`apps/conn-server`) and the iPhone app (`apps/ios`, in progress). This page says why each part
uses its stack, what we rejected, and which costs we accept. [`scope.md`](scope.md) says what
each part owns.

| Part | Stack | Chosen |
| --- | --- | --- |
| Desktop | Rust + GPUI (`gpui-kit`), CEF for the browser panel | 2026-11-20 |
| Server | Rust: tokio, axum, SQLite | 2026-11-13 |
| iPhone | SwiftUI on the shared Rust core (UniFFI) | 2026-11-22 |

All three share one Rust protocol layer: `conn-wire` and `conn-contract` from
`apps/conn-server`, and the GPUI-free client core in the repo-root `crates/` workspace
(`conn-client`, `conn-state`, `conn-theme`, `conn-orbit`, `conn-ffi`). The desktop and the
server stay separate Cargo workspaces that use these crates by path, so the server's Linux
builds never compile GPUI. They live in one repository, so one commit can change the contract,
the server and both clients.

## Desktop: Rust + GPUI

### Why

- **One language with the server.** The client uses the server's `conn-wire` and
  `conn-contract` crates directly. Client and server cannot drift on the wire format, and no
  copy of the contract in another language is needed.
- **Native, not Electron.** GPUI draws with Metal. The app starts fast, uses less memory, and
  scrolls long threads, diffs and terminals smoothly.
- **We build on Threadbear, as Conn builds on T3 Code.** [Threadbear](https://github.com/mikecann/threadbear)
  is an agent app rewritten in GPUI. It has already solved the hard desktop parts: an embedded
  Chromium browser (CEF through `cef-rs`, loaded on demand), a terminal (`alacritty_terminal`),
  docking, and macOS fixes in vendored GPUI crates. We follow two upstreams instead of solving
  these parts alone. [`architecture.md`](architecture.md) maps each part.
- **A safe framework.** GPUI runs Zed in production and ships versioned crates.
- **A direct port.** The current desktop app maps onto GPUI view for view, with the same
  tokens ([`design-spec.md`](design-spec.md)).

### Rejected

| Option | Why not |
| --- | --- |
| Keep Electron + React | Electron's memory and start-up cost stays, and the client stays in another language than the server. |
| Tauri v2 | Still a web interface, in the system web view instead of Chromium, so the browser panel loses Chromium and its DevTools protocol. |
| SwiftUI / AppKit | The best macOS integration, and one Swift core with the iPhone app. But the views Conn needs most are hard in SwiftUI on macOS: streaming markdown, large diffs, text selection across blocks, the terminal and the embedded browser. They force a drop to AppKit and C or Rust code. `WKWebView` has no DevTools protocol, so the agent browser tools need CEF anyway. Swift would also need its own copy of the wire and contract types. |
| [Rune](https://github.com/anomalyco/rune) | Pre-release: a git pin on a moving branch, and every app must copy its patches for seven crates. Text input (IME) is its own largest open risk, and dictation matters for Conn. It has no ready browser, terminal or dock parts. We keep it as a reference for glass, motion and headless checks (`.refs/rune`). |

### Costs we accept

- GPUI draws its own controls. macOS text input, dictation and accessibility need our own work
  (`crates/conn-app/src/a11y.rs`).
- We pin `gpui-kit` exactly and keep a patched `vendor/gpui-pre-macos`. Each patch is written
  in `Cargo.toml` and [`status.md`](status.md).
- CEF must follow Chromium security releases.
- GPUI menus cannot draw over the CEF view. Menus that overlap the browser use their own
  windows or hide the browser, and page overlays go into the page through CDP.
- Mac and iPhone share the Rust core and the theme tokens, not views.

## Server: Rust

### Why

- **Memory per container.** Every Orbit container runs its own server. The T3 server (Node,
  Effect) holds about 300 MiB of private memory in each container. The Conn Server holds about
  4 MiB after 20 replayed turns ([`apps/conn-server/README.md`](../../conn-server/README.md),
  "Status").
- **The same client contract.** The Conn Server serves the T3 server's contract, so Conn
  clients work with either server, and an Orbit Project can choose its server.
- **We copy behaviour, not code.** The server reproduces behaviour at three boundaries: the
  client contract, `/mcp`, and the provider protocols. The upstream Effect code changes too
  fast to translate line by line.

### Rejected

| Option | Why not |
| --- | --- |
| Translate the TypeScript server | Upstream changes about 74,000 lines a month in its orchestration engine (November 2026). A translation could not keep up. |
| One shared server per host | Rejected on 2026-11-09. Each container keeps its own server. |

### Costs we accept

- Every in-scope upstream server change must be ported. The nightly upstream sync does this
  ([`apps/conn-server/docs/upkeep.md`](../../conn-server/docs/upkeep.md)).
- Claude still runs through Anthropic's Agent SDK in a small Node program, the SDK host. The
  server starts it with the first Claude session and stops it after the last one (about 44 MB).

The choices inside the server, such as the single-thread runtime, axum and SQLite, are in the
server's README ("Dependencies and runtime") and in
[`apps/conn-server/CRATES.md`](../../conn-server/CRATES.md).

## iPhone: SwiftUI on the Rust core

### Why

- **iPhone only.** Conn's mobile client is used on iOS only, so a cross-platform stack adds
  cost and gives nothing back.
- **Easier to build than Expo.** There is no Metro, CocoaPods, prebuild or React Native
  upgrade to follow. The Expo app's native modules are already Swift (about 11,500 lines: the
  review diff, native controls, the composer editor, the terminal), so they move into SwiftUI.
- **Native feel.** SwiftUI gives the iOS keyboard, scrolling, haptics and audio sessions (for
  voice input) directly.
- **The phone needs no IDE views.** It shows the inbox, chat, voice input, approvals, and quick
  pull request and task views, which is what SwiftUI does well. The views that are hard in
  SwiftUI, such as the embedded browser, split diffs and the panel dock, stay on the desktop.
- **One Rust core.** `crates/conn-ffi` exposes `conn-client`, `conn-state` and `conn-orbit` to
  Swift through UniFFI. Rust `async` functions become Swift `async` functions. The wire and
  contract types stay in Rust, so the compiler catches protocol changes. The protocol,
  reducers and Orbit client are written once for desktop and iPhone.
- **Shared Swift parts.** The app uses DesignKit, a SwiftUI package shared with other apps.

Threadbear uses the same split: GPUI on the desktop, SwiftUI on the iPhone. The project is an
XcodeGen spec (`project.yml`) and targets the latest iOS only.

### Rejected

| Option | Why not |
| --- | --- |
| Keep Expo / React Native | Metro, CocoaPods, prebuild and React Native upgrades to follow, and a TypeScript client core next to the Rust one. The Expo app stays the daily app until the SwiftUI app replaces it ([`scope.md`](scope.md), "Mobile Guardrail"). |
| Flutter + `flutter_rust_bridge` | Useful only when Android is needed. Its iOS feel is not native, and it adds Dart as a third language. |
| A Rust interface toolkit (GPUI, Dioxus, Makepad) | GPUI has no mobile target. Rust mobile toolkits still struggle with iOS text selection, keyboard insets and scroll inertia. |
| One Swift app for Mac and iPhone | SwiftUI on macOS is weak for the views the desktop needs (see the desktop section). |

### Costs we accept

- A second interface stack next to GPUI.
- iOS suspends the WebSocket while the app is in the background, so the app reconnects when it
  comes back. Push notifications would need APNs from the server or Orbit; there are none yet.
- `apps/ios` builds DesignKit from outside this repository.
