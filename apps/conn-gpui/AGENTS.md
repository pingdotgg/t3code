# conn-gpui

Read `docs/status.md` and `docs/scope.md` first. `docs/status.md` says what is proven, what is in progress, and what is next; `docs/scope.md` is the locked feature cutlist defining what belongs in **Orbit**, **`conn-server`**, **`conn-gpui`**, and future **SwiftUI iOS** (and what upstream T3 Code features are intentionally dropped). Update `docs/status.md` with every landed milestone.

**conn-gpui** is a native Rust + GPUI macOS desktop client for Conn + Orbit: it matches the Conn desktop shell's look and feel (`apps/web` + `apps/desktop` in this monorepo) for everything in `docs/scope.md`, talks directly to `conn-server` (`apps/conn-server`) using its typed Rust contract crates (`conn-wire` and `conn-contract`), integrates tightly with Orbit (nodes, workspaces, profiles, themes, tasks, `ai-router`), and adopts proven GPUI patterns from Threadbear (`.refs/threadbear`).

Read `README.md`, `docs/scope.md`, `docs/architecture.md`, and `docs/design-spec.md` before changing code. Do **not** port features marked `Drop` or `Orbit` in `docs/scope.md` into `conn-gpui`. For tracking upstream changes from Conn, T3 Code, Threadbear, and Rune, see `docs/radar.md`. If you are running a long autonomous session, read `GOAL.md` for the phased milestone plan and sub-agent split.

## Inputs and references (read-only)

`conn-gpui` lives in the `nckrtl/conn` monorepo at `apps/conn-gpui`. Paths below are relative to the monorepo root unless they start with `crates/`, `docs/` or `scripts/`. Third-party references sit under `apps/conn-gpui/.refs/` (gitignored; synced by `scripts/sync-refs.sh` from `references.pin`); never edit anything inside `.refs/`:

1. **Conn itself (this monorepo)**: The **sole** visual, behavioral, and wire-contract specification.
   - Every pixel, color role, token formula, layout metric, icon choice, keyboard shortcut, and right-panel surface comes from `apps/web`, `apps/desktop`, and `FORK.md` at your checkout's commit.
   - `conn-gpui` imports `apps/conn-server/crates/conn-wire` and `apps/conn-server/crates/conn-contract` as Cargo path dependencies (`../conn-server/...` from `apps/conn-gpui`). Never duplicate or hand-roll Effect RPC frame types or contract schemas.
   - Branch from a fresh `origin/main` before auditing or porting UI, so a stale branch can never be the source. Never port from another checkout (such as `~/apps/conn`) that may sit on an old branch.
2. **`.refs/threadbear`** (`mikecann/threadbear`, gitignored; run `scripts/sync-refs.sh` if missing): Primary GPUI engineering reference. Prefer its proven patterns over inventing from scratch:
   - `desktop/gpui/src/` for GPUI + `gpui-kit = "=0.9.0"` app structure, window chrome, AppKit shims, `alacritty_terminal` rendering, markdown/diff rows, and scripted `automation.rs`.
   - `desktop/web/` for CEF-on-demand (`cef-rs` + `dlopen` loader + `offscreen.rs` + `devtools.rs`).
   - `desktop/vendor/` and `desktop/Cargo.toml` for known `gpui-kit`/`gpui-base`/`gpui-pre` macOS fixes (popup menus, soft-wrap selection, long paste scroll, file drags, scroll bounce).
3. **`.refs/rune`** (`anomalyco/rune`, gitignored; synced by `scripts/sync-refs.sh`): Secondary inspiration reference only (do not switch frameworks away from GPUI). Useful for its `research/` notes (GPUI perf/text/scroll/motion analyses), agent-verification patterns, frosted glass/token ideas, and `rune-kit` coding-agent UX patterns.

## Build and run safety

This repo is cleared to build, test, and run locally on this Mac (or in `nick-vm` when preferred):

1. **Own checkout / worktree.** Work in your own worktree of `nckrtl/conn` when multiple agents run concurrently. Run `apps/conn-gpui/scripts/sync-refs.sh` (or symlink `.refs` from another checkout) in any fresh worktree before you need Threadbear or Rune.
2. **Own build folder.** Keep Cargo target output in a git-ignored folder inside your checkout (default `target/` or `CARGO_TARGET_DIR`). Never clear shared caches or another checkout's build folder.
3. **Own processes.** Track PIDs of every `conn-server` or `conn-gpui` process you launch and stop only those PIDs. Never run `killall` or `pkill`.
4. **One GUI verification at a time.** Only the orchestrator launches `conn-app` windows or captures screenshots, so concurrent sub-agents do not fight over window focus.
5. **Never touch live `~/.t3/userdata`.** Always run `conn-server` (or the TS server) against a disposable temp `--state-dir` (or a read-only copied/migrated dev DB). Never connect tests to Nick's live server or credentials.

## Workspace boundaries (multi-agent safe)

Keep crate boundaries strict so parallel sub-agents do not collide:

| Crate | Owns | Must NOT depend on |
| --- | --- | --- |
| `crates/conn-client` | WebSocket `/ws` connection to `conn-server`, Effect RPC framing (`conn-wire`), typed calls (`conn-contract`), auth/pairing, reconnect, stream acks | `gpui` / `gpui-kit` / UI |
| `crates/conn-orbit` | GPUI-free, UniFFI-ready Orbit Gateway client (HTTPS + Reverb WSS via `rustls-platform-verifier` for macOS & iOS), Fleet/Nodes/Instances, primary `agent`-role node selection, Projects, Profile/Workspace/Theme 3-way sync, Tasks models/board/detail/insights/formatting, fixtures | `gpui` / `gpui-kit` / `sqlx` / process spawning / desktop UI |
| `crates/conn-state` | Pure Rust client state, shell & thread reducers, workspace/tab/panel layout state, settings model, unit tests | `gpui` / `gpui-kit` / I/O |
| `crates/conn-theme` | Conn theme definitions (Dark Ocean, T3 Light/Dark, Grove, Ocean, Ember, Iris), `color-mix` shell token derivation, GPUI `Hsla` conversion | networking / app views |
| `crates/conn-web` | Embedded browser runtime (CEF-on-demand via `cef-rs`, DevTools/CDP, offscreen/host surfaces) | `conn-state` / app views |
| `crates/conn-ffi` | UniFFI Swift/iOS bridge wrapping `conn-client` + `conn-state` + `conn-orbit` (Tokio runtime, event pump, snapshot coalescing, generated FFI bindings) | `gpui` / `gpui-kit` / `conn-app` / `conn-web` |
| `crates/conn-desktop` | Desktop-only native right-panel backends (API, Database/`sqlx`, MCP stdio/HTTP, Operator, Vault, desktop Orbit panel state & local Application Support storage re-exporting `conn-orbit`) | `gpui` / `gpui-kit` / `conn-app` |
| `crates/conn-app` | GPUI desktop binary: macOS window frame, workspace rail, thread sidebar, 44px header, chat timeline, composer, right panel (Files, Diff, Terminal, Browser, etc.), Settings modal, command palette, automation hook | direct raw WS protocol logic |

- `conn-client`, `conn-orbit`, `conn-state`, and `conn-theme` stay `#![forbid(unsafe_code)]`.
- `unsafe` is permitted only in `conn-app` (macOS AppKit/Metal window shims), `conn-web` (CEF FFI), and generated UniFFI scaffolding inside `conn-ffi` (hand-written code in `conn-ffi` must remain free of `unsafe`); every hand-written `unsafe` block must carry a `// SAFETY:` comment (`undocumented_unsafe_blocks = "deny"`).
- Keep `conn-client`, `conn-orbit`, `conn-state`, and `conn-theme` 100% GPUI-free so `cargo test -p conn-client -p conn-orbit -p conn-state -p conn-theme` runs in seconds with no window server and so the same Rust core can be exposed to the pure SwiftUI iOS client via UniFFI.

## Visual parity rules (pixel-for-pixel Conn)

1. **Follow the `nckrtl-shell-design` skill** (`.claude/skills/nckrtl-shell-design/SKILL.md` and `references/tokens.md`) and `docs/design-spec.md`. Do not fall back to default `gpui-kit` colors, radii, or spacing.
2. **Exact shell geometry:** 18px window radius, 4px shell inset, 14px concentric card corner (`--shell-corner`), 44px transparent glass header (`--shell-header-height`), macOS traffic lights centered on 44px (not 52px), 0.5px inner edge borders, 1px two-tone dividers switching at 44px, no top highlight.
3. **Theme-driven tokens, never hardcoded hex in views:** Views read semantic tokens from `conn-theme` derived from the active theme's color roles (default dark verification theme: Dark Ocean; also verify Light).
4. **Icons:** Every icon (chrome and thread timeline) is superheroicons 16/solid, copied from `~/apps/superheroicons/consumers/conn/final/` into `crates/conn-app/assets/icons/superhero/` (Nick, 2026-11-21; Conn decision `conn-icon-set-solid-v4`). `crates/conn-app/src/superhero.rs` maps gpui-kit Lucide names to concepts through the library manifest. Never redraw or patch glyphs here; fixes go to the superheroicons library, then re-copy.
5. **Typography:** `13px` (`text-ui`, `20px` line height) for panel chrome, settings, tree items, status lines, and controls. Sans everywhere except code and terminal output; `tabular-nums` for aligned numbers; no uppercase section labels.
6. **Prove visual parity with live side-by-side screenshots in `nick-vm`:** Every UI milestone or visual bug fix must be verified with the 3-layer harness:
   - **Layer 1 (`scripts/check.sh`):** Headless `#[gpui_kit::test]` GPUI render + pointer/keyboard interaction tests run in `cargo test` with debug assertions on.
   - **Layer 2 (`scripts/e2e.py`):** Expanded live E2E suite against the seeded disposable `:3891` `conn-server` asserting zero panics/crash logs.
   - **Layer 3 (`scripts/vm-parity.sh` in `nick-vm` via VMPal):** Launch both current `Conn.app` and `Conn GPUI.app` against the same seeded `:3891` `conn-server` at identical `1440×900` bounds (Dark Ocean + Light), stitch side-by-side `Conn | Conn GPUI` comparisons, and inspect every image before marking UI work done.
7. **1:1 source-anchored porting (copy everything in scope first):** Never implement or polish a UI surface from memory or high-level summaries. Read every relevant `.tsx` and `.logic.ts` file in `apps/web/src/components/` at your checkout's commit and port *all* in-scope states, button transitions, hover actions, tooltips, label formats, badges, and edge cases directly (skipping only features explicitly marked `Drop` or `Orbit` in `docs/scope.md`). Track parity per surface under `docs/parity/{composer,timeline,shell-sidebar,panels}.md` (`[x]` exact, `[~]` drifted, `[ ]` missing, `[-]` out of scope). Default to including everything from Conn — Nick prefers removing unwanted details over discovering missing ones.

## Rust & GPUI rules

- Follow the vendored BeautifulRust skills in `.claude/skills/` (`rust-best-practices`, `rust-review`, `rust-port`).
- Pin `gpui-kit = "=0.9.0"` (matching `.refs/threadbear`). Upgrade only intentionally in a dedicated commit.
- If a `gpui-kit`, `gpui-base`, or `gpui-pre` limitation blocks pixel-for-pixel macOS parity, check `.refs/threadbear/desktop/vendor/` first—Threadbear has already solved several of these. Document any vendored patch in `Cargo.toml`.
- No `unwrap()` in production code; handle errors or document invariants cleanly.
- No continuously repainting animations that peg the GPU on high-refresh displays.
- Every new interactive element, card, row or section gets an AX element through `crates/conn-app/src/a11y.rs` (`.id(...)` + `a11y_button` / `a11y_group` / `a11y_tab` / …): a stable dotted id (`thread-details.pr.0`, `chat.approval.<id>`) and a human label. Nick's annotator selects UI only through the AX tree. Nest separately selectable controls inside their row's group.
- GPUI has no Tokio runtime on its main thread: run `conn-client` on a dedicated Tokio runtime and bridge events into GPUI entities over bounded channels (see `.refs/threadbear/desktop/gpui/src/main.rs`).

## Verification and git

- Run `scripts/check.sh` before declaring a milestone complete (`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`).
- Commit locally in small, coherent steps with conventional commit titles (`feat(theme): ...`, `feat(client): ...`, `feat(app): ...`).
- Never push or open a PR unless Nick explicitly asks. The monorepo's root `AGENTS.md` also applies; this file wins for `apps/conn-gpui`.
- Update `docs/status.md` whenever a milestone lands or a blocker is discovered.

## Multi-agent workflow (for `/goal` runs)

When orchestrating sub-agents:
1. Partition work strictly along crate or feature-module lines (`conn-client`, `conn-state`, `conn-theme`, `conn-app` shell, `conn-app` chat, `conn-app` right panels, `conn-web`).
2. Keep one orchestrator owning `Cargo.toml`, `crates/conn-app/src/main.rs`, integration wiring, and final visual verification.
3. Only the orchestrator launches GUI windows or captures screenshots. Pure Rust sub-agents (`conn-client`, `conn-state`, `conn-theme`) can run builds and unit tests in parallel in their own worktrees.
4. Keep every step green on `scripts/check.sh` before moving to the next phase in `GOAL.md`.
