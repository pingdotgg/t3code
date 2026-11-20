# conn-gpui

Read `docs/status.md` first. It says what is proven, what is in progress, and what is next. Update it with every landed milestone.

**conn-gpui** is a native Rust + GPUI desktop client for Conn: a pixel-for-pixel port of the Conn desktop shell (`../conn`, Nick's fork of T3 Code) that talks directly to `conn-server` (`../conn-server`) using its typed Rust contract crates (`conn-wire` and `conn-contract`), adopting proven GPUI patterns from Threadbear (`.refs/threadbear`).

Read `README.md`, `docs/architecture.md`, and `docs/design-spec.md` before changing code. If you are running a long autonomous session, read `GOAL.md` for the phased milestone plan and sub-agent split.

## Inputs and references (read-only)

This repo piggybacks on three upstream/sibling repos. Pin versions live in `references.pin`. Never edit any of them from `conn-gpui` work:

1. **`../conn`** (`nckrtl/conn`): The visual and behavioral specification. Every pixel, color role, token formula, layout metric, icon choice, keyboard shortcut, and right-panel surface comes from `../conn/apps/web`, `../conn/apps/desktop`, and `../conn/FORK.md`.
2. **`../conn-server`** (`hardimpactdev/conn-server`): The Rust server and wire contract. `conn-gpui` directly imports `../conn-server/crates/conn-wire` and `../conn-server/crates/conn-contract` as path dependencies. Never duplicate or hand-roll Effect RPC frame types or contract schemas.
3. **`.refs/threadbear`** (`mikecann/threadbear`, gitignored; run `scripts/sync-refs.sh` if missing): Primary GPUI engineering reference. Prefer its proven patterns over inventing from scratch:
   - `desktop/gpui/src/` for GPUI + `gpui-kit = "=0.9.0"` app structure, window chrome, AppKit shims, `alacritty_terminal` rendering, markdown/diff rows, and scripted `automation.rs`.
   - `desktop/web/` for CEF-on-demand (`cef-rs` + `dlopen` loader + `offscreen.rs` + `devtools.rs`).
   - `desktop/vendor/` and `desktop/Cargo.toml` for known `gpui-kit`/`gpui-base`/`gpui-pre` macOS fixes (popup menus, soft-wrap selection, long paste scroll, file drags, scroll bounce).
4. **`.refs/rune`** (`anomalyco/rune`, gitignored; synced by `scripts/sync-refs.sh`): Secondary inspiration reference only (do not switch frameworks away from GPUI). Useful for its `research/` notes (GPUI perf/text/scroll/motion analyses), agent-verification patterns, frosted glass/token ideas, and `rune-kit` coding-agent UX patterns.

## Build and run in `nick-vm` only

Follow `~/apps/AGENTS.md` without exception:

1. **Never build, run, or test this Mac app on Nick's Mac (`nick.local`).** All `cargo build`, `cargo check`, `cargo test`, `cargo clippy`, app launches, and GUI screenshots run inside the macOS VM `nick-vm` (`ssh vm` from `nick.local`).
2. **Own checkout / worktree.** Work in your own worktree (`git worktree add ~/apps/conn-gpui-<task>`) when multiple agents run concurrently. Relative path deps (`../conn-server/crates/...`) resolve cleanly from any sibling checkout in `~/apps/`.
3. **Own build folder.** Keep Cargo target output in a git-ignored folder inside your checkout (default `target/` or `CARGO_TARGET_DIR`). Never clear shared caches or another checkout's build folder.
4. **Own processes.** Track PIDs of every `conn-server` or `conn-gpui` process you launch and stop only those PIDs. Never run `killall` or `pkill`.
5. **GUI lock.** Before any GUI step in `nick-vm` (launching `conn-gpui`, taking window screenshots, changing macOS appearance), acquire `mkdir /tmp/vm-gui.lock` (retry every 20s if busy) and `rmdir /tmp/vm-gui.lock` immediately after, even on failure. Headless `cargo build` and `cargo test` need no lock.
6. **Never touch live `~/.t3/userdata`.** Always run `conn-server` (or the TS server) against a disposable temp `--state-dir` (or a read-only copied/migrated dev DB). Never connect tests to Nick's live server or credentials.

## Workspace boundaries (multi-agent safe)

Keep crate boundaries strict so parallel sub-agents do not collide:

| Crate | Owns | Must NOT depend on |
| --- | --- | --- |
| `crates/conn-client` | WebSocket `/ws` connection to `conn-server`, Effect RPC framing (`conn-wire`), typed calls (`conn-contract`), auth/pairing, reconnect, stream acks | `gpui` / `gpui-kit` / UI |
| `crates/conn-state` | Pure Rust client state, shell & thread reducers, workspace/tab/panel layout state, settings model, unit tests | `gpui` / `gpui-kit` / I/O |
| `crates/conn-theme` | Conn theme definitions (Dark Ocean, T3 Light/Dark, Grove, Ocean, Ember, Iris), `color-mix` shell token derivation, GPUI `Hsla` conversion | networking / app views |
| `crates/conn-web` | Embedded browser runtime (CEF-on-demand via `cef-rs`, DevTools/CDP, offscreen/host surfaces) | `conn-state` / app views |
| `crates/conn-app` | GPUI desktop binary: macOS window frame, workspace rail, thread sidebar, 44px header, chat timeline, composer, right panel (Files, Diff, Terminal, Browser, etc.), Settings modal, command palette, automation hook | direct raw WS protocol logic |

- `conn-client`, `conn-state`, and `conn-theme` stay `#![forbid(unsafe_code)]`.
- `unsafe` is permitted only in `conn-app` (macOS AppKit/Metal window shims) and `conn-web` (CEF FFI), and every `unsafe` block must carry a `// SAFETY:` comment (`undocumented_unsafe_blocks = "deny"`).
- Keep `conn-client` and `conn-state` 100% GPUI-free so `cargo test -p conn-client -p conn-state` runs in seconds with no window server.

## Visual parity rules (pixel-for-pixel Conn)

1. **Follow the `nckrtl-shell-design` skill** (`.claude/skills/nckrtl-shell-design/SKILL.md` and `references/tokens.md`) and `docs/design-spec.md`. Do not fall back to default `gpui-kit` colors, radii, or spacing.
2. **Exact shell geometry:** 18px window radius, 4px shell inset, 14px concentric card corner (`--shell-corner`), 44px transparent glass header (`--shell-header-height`), macOS traffic lights centered on 44px (not 52px), 0.5px inner edge borders, 1px two-tone dividers switching at 44px, no top highlight.
3. **Theme-driven tokens, never hardcoded hex in views:** Views read semantic tokens from `conn-theme` derived from the active theme's color roles (default dark verification theme: Dark Ocean; also verify Light).
4. **Icons:** UI chrome uses Lucide; thread timeline uses Phosphor (solid by default, bold for carets/line glyphs). Match `../conn/apps/web/src/icons/`.
5. **Typography:** `13px` (`text-ui`, `20px` line height) for panel chrome, settings, tree items, status lines, and controls. Sans everywhere except code and terminal output; `tabular-nums` for aligned numbers; no uppercase section labels.
6. **Prove visual parity with screenshots:** Every UI milestone must capture screenshots of `conn-gpui` (via its automation/capture hook in `nick-vm`, under `/tmp/vm-gui.lock`) and compare against the real Conn desktop/web layout (`../conn`). Fix visible spacing, alignment, border, or color drift before marking a milestone done.

## Rust & GPUI rules

- Follow the vendored BeautifulRust skills in `.claude/skills/` (`rust-best-practices`, `rust-review`, `rust-port`).
- Pin `gpui-kit = "=0.9.0"` (matching `.refs/threadbear`). Upgrade only intentionally in a dedicated commit.
- If a `gpui-kit`, `gpui-base`, or `gpui-pre` limitation blocks pixel-for-pixel macOS parity, check `.refs/threadbear/desktop/vendor/` first—Threadbear has already solved several of these. Document any vendored patch in `Cargo.toml`.
- No `unwrap()` in production code; handle errors or document invariants cleanly.
- No continuously repainting animations that peg the GPU on high-refresh displays.
- GPUI has no Tokio runtime on its main thread: run `conn-client` on a dedicated Tokio runtime and bridge events into GPUI entities over bounded channels (see `.refs/threadbear/desktop/gpui/src/main.rs`).

## Verification and git

- Run `scripts/check.sh` inside `nick-vm` before declaring a milestone complete (`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`).
- Commit locally in small, coherent steps with conventional commit titles (`feat(theme): ...`, `feat(client): ...`, `feat(app): ...`).
- Never push or open a PR unless Nick explicitly asks.
- Update `docs/status.md` whenever a milestone lands or a blocker is discovered.

## Multi-agent workflow (for `/goal` runs)

When orchestrating sub-agents:
1. Partition work strictly along crate or feature-module lines (`conn-client`, `conn-state`, `conn-theme`, `conn-app` shell, `conn-app` chat, `conn-app` right panels, `conn-web`).
2. Keep one orchestrator owning `Cargo.toml`, `crates/conn-app/src/main.rs`, integration wiring, and final visual verification in `nick-vm`.
3. Only one agent runs GUI builds/launches at a time (or uses its own worktree + `/tmp/vm-gui.lock`). Pure Rust sub-agents (`conn-client`, `conn-state`, `conn-theme`) can run unit tests in parallel in their own worktrees.
4. Keep every step green on `scripts/check.sh` before moving to the next phase in `GOAL.md`.
