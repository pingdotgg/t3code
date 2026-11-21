# Status

**State:** Phases 1–5 + right-panel parity surfaces (Files, Diff, Terminal, Browser/CEF, API, Database, MCP, Tasks, Pull Request, Linked Items, Device live streaming) integrated, passing `scripts/check.sh` + `--features automation` + `--features cef` clippy + live `conn-server` tests, and **side-by-side visually verified in `nick-vm` via VMPal against `Conn.app`** in both T3 Code Light and Dark Ocean.

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
| 5 | `conn-web` CEF-on-demand browser spike | Done | CEF 156 downloads on demand to `~/Library/Application Support/conn-gpui/cef/`; `cef_smoke` prints a local page's title; in the app the Browser panel hosts a native CEF view over its bounds and `browser-state` reports `title: "conn-gpui CEF spike"` for `http://127.0.0.1:8765/` |
| 5 | Side-by-side visual parity audit against Conn Electron (Dark Ocean + Light) | Done (with limits below) | `.shots/final/{dark-ocean,t3-code-light}-{chat,files,diff,terminal,browser,settings,palette}.png` vs `.shots/ref/` and design-spec metrics |

## Known decisions & open notes

- **Icons:** superheroicons 16/solid everywhere (Nick, 2026-11-21), copied with provenance in `crates/conn-app/assets/icons/superhero/`; Lucide/Phosphor removed. A test checks every icon the app uses resolves to a drawing. Captures: `.shots/icons/`.

- **Build host:** Approved to build, test, and run locally on this Mac for overnight/dedicated runs (keep all worktrees, build output, and disposable `--state-dir` isolated).
- **Contract sharing:** `conn-wire` and `conn-contract` are path dependencies on `../conn-server/crates/`.
- **GPUI version:** Pinned to `gpui-kit = "=0.9.0"` (matching `.refs/threadbear`). If macOS polish requires vendoring `gpui-component`, `gpui-base`, or `gpui-pre`, follow `.refs/threadbear/desktop/Cargo.toml`'s `[patch.crates-io]` pattern and record each patch here.
- **Vendored `gpui-pre-macos` (2026-11-21):** Threadbear's copy (plain keys go to an embedded web view that holds the keyboard), plus frames paced by CVDisplayLink instead of `CAMetalDisplayLink`. Under the Metal link, a frame drawn during key dispatch stayed off screen until the next mouse event (Cmd+K from the composer, typing in the palette); reproduced and verified fixed in nick-vm. `CONN_GPUI_METAL_DISPLAY_LINK=1` opts back in.
- **Overlay focus:** closing the palette or Settings returns the keyboard to what had it before (else the shell root), so shortcuts keep working after Escape.
- **macOS vibrancy root fix (2026-11-21 — verified in `nick-vm`):** `gpui-component`'s `RootPlugin` painted an opaque `cx.theme().tokens.background` over the `NSVisualEffectView`, making T3 Code Light render RGB 251 instead of Conn's translucent glass. `vibrancy::install` now clears `root.style().background = Some(transparent_black())` (proven by `vibrancy_install_clears_root_opaque_background`), `vibrancy::sync_appearance` syncs `[NSApp setAppearance:]` (`NSAppearanceNameAqua` / `NSAppearanceNameDarkAqua`) on startup and theme switches, and right-panel surfaces drop opaque root `.bg(...)` overrides so they share `inset_card`'s frosted tint. Measured side-by-side in `nick-vm` via VMPal: rail median RGB `(242,240,241)` matches `Conn.app` `(242,240,241)` pixel-for-pixel; sidebar `(249,249,249)` matches `Conn.app` `(249,249,249)`.
- **Side-by-side VM audit fixes (2026-11-21 — verified in `nick-vm`):** Fixed 5 issues caught in VMPal captures across T3 Code Light and Dark Ocean: (1) right-panel tab strip overflowing over maximize/dock/close buttons when 6+ tabs are open (`panels/header.rs` clipped horizontal tab strip), (2) composer model alias resolution (`haiku` -> `Claude Haiku 5.5` with orange Claude brand mark and `Medium` effort picker in `chat/composer.rs` + `model_picker.rs`), (3) Tasks 4-column KPI strip clipping the 4th card at default panel width (`CARD_MIN_WIDTH_PX = 130.0`), (4) Command Palette unblurred text bleed-through (`tokens.popover` surface), and (5) Settings scroll body bottom padding (`pb(32px)`). Also verified Split Diff toggle, tooltip placement (`Split diff`), sidebar hover Rename/Settle actions, CEF Browser rendering (`https://example.com/`), native macOS menu bar, and Dark Ocean appearance switching.
- **Device screen streaming (2026-11-21):** Authenticated device hub ticket minting (`device_hub` in `conn-client`), MJPEG + AVCC/SEMU H.264 demuxing, macOS VideoToolbox BGRA hardware decode (tested end-to-end with a real H.264 IDR frame), iOS/Android touch + keyboard + hardware buttons, screenshot save to `~/Downloads`, foreground app & event log SSE, and visibility-gated stream lifecycle (`RightPanel::sync_surface_visibility` -> `DevicePanel::set_visible`).
- **Pull Request & Linked Items surfaces (2026-11-21):** Reviewer/label pickers, base-branch freshness/update popover, submit review (`Comment`/`Approve`/`RequestChanges`), emoji reactions, PR Code tab diff syntax highlighting, agent prompt actions (`SendPrompt`), collapsible header on scroll, and gradient hover fade in Linked Items.
- **Diagnostics:** GPUI warnings/errors go to stderr; `CONN_GPUI_FRAME_LOG=1` also logs keys, the palette action and renders per second.

## How to run (reproduction)

```sh
scripts/dev-server.sh start        # disposable conn-server on :3891, state in /tmp/conn-gpui-dev
scripts/run-app.sh                 # builds conn-app --features automation, runs it live
scripts/automate.py '{"cmd":"dump"}'
scripts/automate.py '{"cmd":"theme","id":"t3-code-light"}' '{"cmd":"screenshot","path":"/abs/.shots/x.png"}'
scripts/run-app.sh stop; scripts/dev-server.sh stop
```

With the CEF browser:

```sh
CARGO_FLAGS="--features cef" scripts/run-app.sh
scripts/automate.py '{"cmd":"browse","url":"http://127.0.0.1:8765/"}' '{"cmd":"browser-state"}'
CARGO_TARGET_DIR=target-cef cargo run -p conn-web --example cef_smoke --features cef -- http://127.0.0.1:8765/
```

CEF lint check: `CARGO_TARGET_DIR=target-cef cargo clippy -p conn-web -p conn-app --all-targets --features conn-web/cef,conn-app/cef,conn-app/automation -- -D warnings`.

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

- Captures have no desktop blur, no native traffic lights, and no CEF page (render_to_image draws only the GPUI scene; the browser is a native child NSView). The CEF page is proven by its title and URL read back from the hosted view.
- The CEF view is created at paint time; a window covered by other windows gets no frames until focused (automation `browse` forces one).
- Inline code uses the body font; GPUI `HighlightStyle` cannot switch font family inside a run.
- The thread diff for the seeded "Add greet function" thread includes `target/` files: its checkpoint predates the demo `.gitignore`.

## Next

- **Composer:** clipboard image paste.
- **Diff & Terminal:** working-tree/branch diff scopes; terminal tabs/splits.
- **Settings:** additional server-backed Conn settings pages and multi-workspace saved presets.

## Phase 2 drift (fixed)

All three items from the first audit are fixed (flat thread list, toggle placement, muted rail tiles); see `.shots/p2b-*.png` against `.shots/ref/`.
