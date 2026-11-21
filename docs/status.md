# Status

**State:** Scaffolded — ready for Phase 1. No Rust build has been run yet.

Keep this file accurate. Update it whenever a milestone lands, a proof passes, or a blocker is found.

## Milestones (from `GOAL.md`)

| Phase | Area | State | Proof |
| --- | --- | --- | --- |
| 0 | Project scaffold, `AGENTS.md`, `GOAL.md`, docs, skills, `.refs/threadbear` | Done | Files in place, initial commit created |
| 1 | `conn-client` WebSocket + `conn-wire`/`conn-contract` handshake (`subscribeShell`) | Not started | Pending |
| 1 | `conn-theme` palettes + `color-mix` shell token math | Not started | Pending |
| 1 | `conn-app` native macOS window + 44px traffic lights + frosted shell | Not started | Pending |
| 2 | Workspace rail, thread sidebar, 44px header, Lucide/Phosphor icons | Not started | Pending |
| 3 | Chat timeline (Markdown, code blocks, tool rows, user bubbles) + composer | Not started | Pending |
| 4 | Right panel: Files tree/preview, Diff viewer, Terminal (`alacritty_terminal`) | Not started | Pending |
| 5 | `Cmd+K` palette, Settings route modal, live theme switching | Not started | Pending |
| 5 | `conn-web` CEF-on-demand browser spike | Not started | Pending |
| 5 | Side-by-side visual parity audit against Conn Electron (Dark Ocean + Light) | Not started | Pending |

## Known decisions & open notes

- **Build host:** Approved to build, test, and run locally on this Mac for overnight/dedicated runs (keep all worktrees, build output, and disposable `--state-dir` isolated).
- **Contract sharing:** `conn-wire` and `conn-contract` are path dependencies on `../conn-server/crates/`.
- **GPUI version:** Pinned to `gpui-kit = "=0.9.0"` (matching `.refs/threadbear`). If macOS polish requires vendoring `gpui-component`, `gpui-base`, or `gpui-pre`, follow `.refs/threadbear/desktop/Cargo.toml`'s `[patch.crates-io]` pattern and record each patch here.
