# SurgeCode for macOS — Architecture

Native macOS client for the t3 server. SwiftUI with Liquid Glass (macOS 26+),
no Electron, no web view. The existing Node server (`apps/server`, npm package
`t3`) is kept unchanged and runs as a supervised child process.

```
┌───────────────────────────────────────────────┐
│ SurgeCode.app (SwiftUI, macOS 26+)            │
│                                               │
│  SergeCodeMac (app target)                    │
│   • Liquid Glass UI: sidebar, chat, diffs     │
│   • AppModel: observable session state        │
│  T3Kit (library)                              │
│   • Effect-RPC-over-WebSocket client          │
│   • Codable models mirroring @t3tools/contracts│
│   • Reconnect supervisor (backoff, resubscribe)│
│  SidecarKit (library)                         │
│   • Spawns `node dist/bin.mjs --mode desktop` │
│   • Bootstrap JSON over stdin (--bootstrap-fd 0)│
│   • Readiness poll, crash restart, shutdown   │
└──────────────┬────────────────────────────────┘
               │ ws://127.0.0.1:<port>/ws + local HTTP
┌──────────────▼────────────────────────────────┐
│ t3 server (Node, unchanged)                   │
│ providers: codex / claude / cursor / opencode │
└───────────────────────────────────────────────┘
```

## Why this shape

- The server is the product's brain (orchestration engine, provider drivers,
  SQLite persistence). The Electron app already runs it as a supervised child
  (`apps/desktop/src/backend/DesktopBackendManager.ts`); we reuse that exact
  contract from Swift instead of porting Effect-TS to Swift.
- `apps/mobile` proves a non-browser client works: it speaks the same
  `WS_METHODS` effect-rpc contract via `packages/client-runtime`. T3Kit is the
  Swift equivalent of `client-runtime`'s Primary connection path.

## Sidecar contract (from apps/desktop + apps/server)

- Spawn: `node <server>/dist/bin.mjs --mode desktop --bootstrap-fd 0`,
  loopback host. Write ONE line of JSON (schema
  `packages/contracts/src/desktopBootstrap.ts` `DesktopBackendBootstrap`,
  includes a random `desktopBootstrapToken`) to stdin before anything else.
- Readiness: poll `GET /.well-known/t3/environment` (100ms interval, 60s cap).
- Auth: with mode=desktop + loopback bind, server policy is
  `desktop-managed-local` — exchange the bootstrap token for a session/bearer
  token via the local HTTP auth API. No Clerk, no pairing, no DPoP in v1.
- Shutdown: SIGTERM, 2s grace, then SIGKILL. Restart on crash with
  exponential backoff (500ms → 10s).
- Data dir: pass explicit `--base-dir` under
  `~/Library/Application Support/SergeCode/` so we never collide with an
  Electron install's state.
- PATH repair is the server's job (`os-jank.ts fixPath()`); the app just
  spawns node. Dev builds locate node via `/usr/bin/env node` (engines:
  ^22.16 || ^23.11 || >=24.10); bundling a Node runtime into the .app is a
  post-v1 packaging task.

## Wire protocol

See `docs/wire-protocol.md` (generated from packages/contracts +
packages/client-runtime). Effect-RPC over a WebSocket at `/ws`: JSON request
envelopes with tag/id/payload, streamed responses for subscriptions.
T3Kit hand-ports the message shapes as Codable structs; contract drift is
caught by `Tests/T3KitTests` fixtures copied from the TS side.

## Scope

v1 (core parity): project/thread sidebar, chat timeline (turns, streaming
tokens, tool events), composer, approvals, diff panel, checkpoints,
provider status, light/dark.

v2 (feature parity — landed): user-input prompt cards, plan mode +
proposed-plan cards with implement action, runtime-mode picker, model
picker, context-window meter, live plan-progress (todo) strip above the
composer, composer @-file-mentions (projects.searchEntries), image
attachments (inline base64 dataUrl), slash-command menu, editable settings
(server.getSettings/updateSettings), provider refresh + CLI update,
archived-thread management, git/VCS (subscribeVcsStatus, branch
switch/create, pull, stacked commit/push/PR actions with outcome banner,
PR links). The trailing inspector is a single diff panel with a
collapsible checkpoints section; the workspace file browser was removed
(backend workspace RPCs remain for @-mentions).

Out (excluded or later): embedded terminal (needs a SwiftTerm dependency —
Package.swift change to coordinate), browser preview/automation, PR review
dialogs, Clerk/T3 Connect cloud auth + relay + pairing (t3-service
exclusive, permanently out for the fork), SSH/tailscale remotes,
keybindings editor, auto-update (Sparkle later), Windows/Linux (Electron
app remains for those).

## Liquid Glass usage

macOS 26+ only, no fallbacks: `glassEffect(_:in:)` on floating surfaces
(composer, approval sheets, toolbars), `GlassEffectContainer` for morphing
groups, `.buttonStyle(.glass)`, scroll-edge effects on sidebar/timeline.
Content layers (chat text, diffs) stay opaque for readability; glass is for
chrome, never for long-form reading surfaces.

## Build without Xcode

Only Command Line Tools are required. `scripts/make-app.sh` runs
`swift build` and assembles `dist/SurgeCode.app` (hand-written Info.plist,
ad-hoc codesign). CRITICAL: the macOS 27 beta SDK defines SwiftUI `@State`,
`@Entry`, `@Animatable` as compiler macros in a `SwiftUIMacros` plugin that
ships only with Xcode. Rules for all Swift code in this package:

- Use `@UIState` (Sources/SergeCodeMac/Support/StateShim.swift) — never `@State`.
- Custom environment values: manual `EnvironmentKey` conformance — never `@Entry`.
- Manual `Animatable` conformance — never the `@Animatable` macro.
- `@Observable` (ObservationMacros) works and is the preferred store pattern.

### Code signing + TCC (why Finder launches need a stable identity)

The node sidecar (and the repo checkout it loads from) usually lives under
`~/Documents`, which is TCC-protected. macOS keys the Documents-folder grant
to the app's code identity; an ad-hoc signature produces a new identity on
every rebuild, so the grant never sticks — and while consent is unresolved
the sidecar's very first `open()` of `bin.mjs` blocks in the kernel, which
presents as "app launches but stays on Launching Server… forever" (terminal
launches are unaffected because they inherit the terminal app's grant).

One-time setup for a stable local identity (`make-app.sh` picks it up
automatically and falls back to ad-hoc with a warning):

1. Generate + import a self-signed codesigning cert named
   `SergeCode Dev Signing` (openssl req/pkcs12 + `security import`).
2. Trust it for code signing:
   `security add-trusted-cert -p codeSign <cert.pem>` (approve the prompt).
3. Rebuild with `scripts/make-app.sh`; on first Finder launch approve the
   "SurgeCode would like to access files in your Documents folder" dialog.
