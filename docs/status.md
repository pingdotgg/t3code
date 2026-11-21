# Status

**State:** Phases 1, 3, 4 and most of 5 integrated and verified live against a disposable `conn-server`. Open: the CEF browser inside the Browser panel. `scripts/check.sh` green (41 tests).

Keep this file accurate. Update it whenever a milestone lands, a proof passes, or a blocker is found.

## Milestones (from `GOAL.md`)

| Phase | Area | State | Proof |
| --- | --- | --- | --- |
| 0 | Project scaffold, `AGENTS.md`, `GOAL.md`, docs, skills, `.refs/threadbear` | Done | Files in place, initial commit created |
| 1 | `conn-client` WebSocket + `conn-wire`/`conn-contract` handshake (`subscribeShell`) | Done | `CONN_SERVER_BIN=target-conn-server/release/conn-server cargo test -p conn-client` (live test); app dump shows `status: Connected` |
| 1 | `conn-theme` palettes + `color-mix` shell token math | Done | 13 built-in themes incl. Dark Ocean; golden tests in `cargo test -p conn-theme` |
| 1 | `conn-app` native macOS window + 44px traffic lights + frosted shell | Done | Traffic lights at (16, 15) → centered on 44px; blurred window; `.shots/p1-dark.png`, `.shots/p1-light.png` |
| 2 | Workspace rail, thread sidebar, 44px header, Lucide/Phosphor icons | Done | Flat card rows (badge, age, title, branch, provider), Search row, Settled footer, muted rail monograms, toggle right of traffic lights; `.shots/p2b-dark.png`, `p2b-light.png` |
| 3 | Chat timeline (Markdown, code blocks, tool rows, user bubbles) + composer | Done | Live `subscribeThread`; `message.dispatch` sends a prompt and the Haiku reply streams in (automation `send`); `.shots/p3-dark.png`, `p3-light.png` |
| 4 | Right panel: Files tree/preview, Diff viewer, Terminal (`alacritty_terminal`) | Done | `projects.listEntries`/`readFile`, `getFullThreadDiff`, local zsh PTY; `.shots/p4-*.png` |
| 5 | `Cmd+K` palette, Settings route modal, live theme switching | Done | `.shots/p5-palette-*.png`, `p5-settings-*.png`; theme switch updates the open modal |
| 5 | `conn-web` CEF-on-demand browser spike | In progress | Crate scaffold on main behind feature `cef` (default off); finishing + panel hosting delegated |
| 5 | Side-by-side visual parity audit against Conn Electron (Dark Ocean + Light) | In progress | Per-phase captures in `.shots/`; final audit after sidebar polish lands |

## Known decisions & open notes

- **Build host:** Approved to build, test, and run locally on this Mac for overnight/dedicated runs (keep all worktrees, build output, and disposable `--state-dir` isolated).
- **Contract sharing:** `conn-wire` and `conn-contract` are path dependencies on `../conn-server/crates/`.
- **GPUI version:** Pinned to `gpui-kit = "=0.9.0"` (matching `.refs/threadbear`). If macOS polish requires vendoring `gpui-component`, `gpui-base`, or `gpui-pre`, follow `.refs/threadbear/desktop/Cargo.toml`'s `[patch.crates-io]` pattern and record each patch here.

## How to run (reproduction)

```sh
scripts/dev-server.sh start        # disposable conn-server on :3891, state in /tmp/conn-gpui-dev
scripts/run-app.sh                 # builds conn-app --features automation, runs it live
scripts/automate.py '{"cmd":"dump"}'
scripts/automate.py '{"cmd":"theme","id":"t3-code-light"}' '{"cmd":"screenshot","path":"/abs/.shots/x.png"}'
scripts/run-app.sh stop; scripts/dev-server.sh stop
```

- Auth: `conn-server auth session issue --token-only` writes a bearer to `/tmp/conn-gpui-dev/bearer`; the app reads `CONN_GPUI_SERVER` + `CONN_GPUI_TOKEN_FILE` (or `CONN_GPUI_PAIRING_URL`). Without them it shows a demo fixture.
- Claude turns: the dev server uses a private copy of `../conn-server/helpers/sdk-host` with npm deps in `/tmp/conn-gpui-dev/sdk-host`; seed threads with `conn-server thread start <project> "<msg>" --provider claudeAgent --model haiku --wait --state-dir /tmp/conn-gpui-dev/state`.
- Screenshots: this shell has no macOS screen-recording permission, so `screencapture` fails. Screenshots come from GPUI's `render_to_image` via the automation hook, flattened onto the theme background (no desktop blur, no native traffic lights in the capture).
- Visual reference: the Conn lab build is no longer served, so the reference is a saved Conn screenshot (light mock window + dark chat) in `.shots/ref/` plus `docs/design-spec.md` metrics.

## Visual fixes made from screenshots

- Inline code chips: foreground 10% fill (Conn `.chat-markdown :not(pre) > code`), was invisible in dark.
- Tool row paths shown relative to the workspace root (also strips the `/private` symlink prefix).
- Diff lines no longer wrap; narrower line-number gutter and file list.
- Settings frame flattened onto the sidebar color: GPUI cannot blur in-window content, so the translucent frame let the chat show through.
- Open overlays (Settings, palette) now receive token updates on every theme switch.

## Known limitations

- Captures have no desktop blur and no native traffic lights (render_to_image draws only the GPUI scene).
- Inline code uses the body font; GPUI `HighlightStyle` cannot switch font family inside a run.
- The thread diff for the seeded "Add greet function" thread includes `target/` files: its checkpoint predates the demo `.gitignore`.

## Phase 2 drift (fixed)

All three items from the first audit are fixed (flat thread list, toggle placement, muted rail tiles); see `.shots/p2b-*.png` against `.shots/ref/`.
