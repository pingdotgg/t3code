# Architecture

`conn-gpui` replaces Conn's Electron + React desktop surface (`apps/desktop` + `apps/web`) with a native Rust + GPUI desktop app that talks directly to `conn-server` (`apps/conn-server`).

## System overview

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ conn-gpui (native macOS GPUI binary)                                      │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ conn-app (GPUI UI thread — Metal 120fps, no Tokio on main thread)   │  │
│  │  • Window chrome + AppKit 44px traffic lights + native vibrancy     │  │
│  │  • Workspace rail + Thread sidebar + 44px transparent header        │  │
│  │  • Chat timeline (Markdown, superheroicons, work log, approvals)    │  │
│  │  • Composer + BranchToolbar + Cmd+K palette + Settings modal        │  │
│  │  • Right panel: Files, Diff, Terminal (alacritty_terminal), Browser │  │
│  └───────────────▲────────────────────────────────────┬────────────────┘  │
│                  │ bounded channel (events/snapshots) │ commands          │
│  ┌───────────────┴────────────────────────────────────▼────────────────┐  │
│  │ conn-state (pure Rust reducers)     conn-theme (tokens -> Hsla)     │  │
│  └───────────────▲─────────────────────────────────────────────────────┘  │
│                  │                                                        │
│  ┌───────────────┴─────────────────────────────────────────────────────┐  │
│  │ conn-client (dedicated Tokio runtime)   conn-orbit (Gateway + WSS)  │  │
│  │  • tokio-tungstenite /ws?orchestrationProtocol=2                    │  │
│  │  • conn-wire (FromClient, FromServer, Ack, Ping/Pong, frame_parts)  │  │
│  │  • conn-contract (rpc::*, OrchestrationV2Command, ids)              │  │
│  │  • Orbit Gateway HTTPS + Reverb WSS via rustls-platform-verifier    │  │
│  └───────────────▲─────────────────────────────────────────────────────┘  │
│                  │ WebSocket / HTTP                                       │
│  ┌───────────────┴─────────────────────────────────────────────────────┐  │
│  │ conn-web (on-demand CEF via cef-rs + dlopen loader)        │  │
│  │  • Embedded Chromium browser panel + DevTools/CDP + sealed HTML     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────┼────────────────────────────────────────────────────────┘
                   │
                   ▼
         conn-server (apps/conn-server)  —or—  T3 server (apps/server)
```

## Mapping Conn & Threadbear into `conn-gpui`

| Capability | Conn specification (the Conn monorepo) | Threadbear GPUI reference (`.refs/threadbear`) | `conn-gpui` home |
| --- | --- | --- | --- |
| Wire protocol & RPC | `packages/contracts`, `packages/client-runtime` | `desktop/client/src/runner.rs` | `crates/conn-client` + `apps/conn-server/crates/{conn-wire,conn-contract}` |
| Orbit Gateway client (Nodes, Projects, Profile, Tasks, Reverb) | `packages/client-runtime/src/orbitGateway/`, `apps/mobile/src/features/orbit/` | — | `crates/conn-orbit` (shared by `conn-desktop` and SwiftUI iOS via UniFFI; desktop-only panel state & file storage stay in `crates/conn-desktop/src/orbit/`) |
| Client state & reducers | `packages/client-runtime/src/state/` (`shellReducer.ts`, `threadHistoryController.ts`) | `desktop/core/src/reducer/` | `crates/conn-state` |
| Theme palettes & shell tokens | `packages/shared/src/themePalettes.ts`, `apps/web/src/index.css` (tail), `apps/web/src/themePalette.ts` | `desktop/gpui/src/style.rs` | `crates/conn-theme` |
| macOS window & traffic lights | `apps/desktop/src/window/DesktopWindow.ts` (`MACOS_SHELL_HEADER_HEIGHT = 44`) | `desktop/gpui/src/main.rs`, `window_menu.rs`, `colour_space.rs` | `crates/conn-app/src/shell/` |
| Workspace rail & sidebar | `apps/web/src/components/Sidebar.tsx`, `sidebar/workspaceVisuals.tsx`, `AppSidebarLayout.tsx` | `desktop/gpui/src/sidebar.rs`, `side_sections.rs` | `crates/conn-app/src/sidebar/` |
| Chat timeline & markdown | `apps/web/src/components/ChatView.tsx`, `ChatMarkdown.tsx` | `desktop/gpui/src/thread.rs`, `rows/`, `rows/markdown.rs` | `crates/conn-app/src/chat/` |
| Composer & branch toolbar | `apps/web/src/components/ComposerPromptEditorTiptap.tsx`, `BranchToolbar.tsx` | `desktop/gpui/src/composer.rs`, `slash_palette.rs` | `crates/conn-app/src/chat/composer.rs` |
| Right panel tabs & splits | `apps/web/src/components/RightPanelTabs.tsx`, `RightPanelSheet.tsx` | `desktop/dock/`, `desktop/gpui/src/shell.rs` | `crates/conn-app/src/panels/` |
| Files & Diff viewers | `apps/web/src/components/DiffPanel.tsx`, `pierre-tree-theme.ts` | `desktop/gpui/src/viewer.rs`, `review_pane.rs` | `crates/conn-app/src/panels/{files,diff}.rs` |
| Embedded terminal | `apps/web/src/components/PersistentThreadTerminals.tsx` | `desktop/gpui/src/terminal.rs`, `terminal_element.rs` (`alacritty_terminal`) | `crates/conn-app/src/panels/terminal.rs` |
| Embedded browser & `html_render` | `apps/desktop/src/preview/`, `apps/web/src/browser/` | `desktop/web/` (`cef-rs` + `dlopen` loader + `offscreen.rs` + `devtools.rs`) | `crates/conn-web` + `crates/conn-app/src/panels/browser.rs` |
| Settings & Command Palette | `apps/web/src/components/AppRouteModal.tsx`, `CommandPalette.tsx` | `desktop/gpui/src/settings_window/`, `slash_palette.rs` | `crates/conn-app/src/{settings,palette}/` |
| Scripted visual verification | `apps/desktop/src/snapShot/` | `desktop/gpui/src/automation.rs`, `scripted.rs` | `crates/conn-app/src/automation.rs` |

## Key architectural constraints

1. **GPUI main thread stays non-blocking:** GPUI runs on macOS's main thread without Tokio. Spawn a dedicated Tokio runtime in `conn-client` and communicate via bounded async/sync channels, notifying GPUI entities on incoming updates.
2. **Effect RPC protocol fidelity:** `conn-server` speaks Effect 4 RPC over `/ws?orchestrationProtocol=2`:
   - Send `FromClient::Request` with monotonic numeric `RequestId::Number`.
   - Reply with `FromClient::Ack { request_id }` after receiving each `FromServer::Chunk` so streams do not stall.
   - Send `FromClient::Ping` periodically and expect `FromServer::Pong`.
   - Reassemble split frames using `conn_wire::frame_parts` when present.
   - Check `apps/conn-server/crates/conn-wire/src/lib.rs` and `apps/conn-server/crates/conn-server/tools/effect-client.mjs` for exact handshake & auth details.
3. **CEF overlay limitation:** Native CEF views cannot be painted under GPUI popovers/menus (`docs/gpui-port.md` in `.refs/threadbear`). Keep menus/popovers in separate popup windows or hide/freeze the browser panel while floating UI overlaps it. Inject annotation overlays inside the page DOM via CDP rather than trying to paint GPUI on top of CEF.
4. **Vendored GPUI patches:** Start with published `gpui-kit = "=0.9.0"`. If macOS text selection, popup menu spacing, long dictated paste scroll, or file drag hits a known bug, inspect `.refs/threadbear/desktop/vendor/` before inventing a workaround.
