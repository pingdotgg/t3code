# conn-gpui

A native Rust + GPUI desktop client for **Conn** (Nick's fork of T3 Code), built to match Conn desktop's visual design pixel-for-pixel while talking directly to `conn-server` (`../conn-server`) over its typed Rust contract crates.

> **Status:** Scaffolded, not yet built. See [`docs/status.md`](docs/status.md) and [`GOAL.md`](GOAL.md).

## Architecture at a glance

```text
conn-gpui (Rust + GPUI desktop app)
  ├── crates/conn-client  ──► WebSocket /ws (Effect RPC via ../conn-server/crates/conn-wire & conn-contract)
  ├── crates/conn-state   ──► Pure Rust reducers, workspace/thread/panel state (zero GPUI deps)
  ├── crates/conn-theme   ──► Conn theme palettes + color-mix shell tokens -> GPUI Hsla
  ├── crates/conn-web     ──► Embedded Chromium browser via CEF-on-demand (modeled on Threadbear)
  └── crates/conn-app     ──► GPUI binary: frosted shell, workspace rail, sidebar, chat, composer, right panels
```

## Reference repositories

Pinned in [`references.pin`](references.pin):

- **`../conn`** — Source of truth for Conn's UI, shell tokens, themes, icons, and fork features (`FORK.md`).
- **`../conn-server`** — Rust backend; provides `conn-wire` and `conn-contract` as direct Cargo path dependencies.
- **`.refs/threadbear`** — Read-only shallow clone of [`mikecann/threadbear`](https://github.com/mikecann/threadbear) (gitignored). Reference for GPUI + `gpui-kit = "=0.9.0"`, macOS AppKit hooks, `alacritty_terminal`, and `cef-rs` on-demand embedding. Run `scripts/sync-refs.sh` to populate or sync.

## Prerequisites & commands (run in `nick-vm`)

Per `~/apps/AGENTS.md`, build, test, and run Mac apps in `nick-vm`, never on Nick's Mac:

```sh
# 1. Ensure read-only Threadbear reference is present
scripts/sync-refs.sh

# 2. Run formatting, clippy (-D warnings), and workspace tests (inside nick-vm)
scripts/check.sh

# 3. Run the desktop app against a disposable conn-server (inside nick-vm, under /tmp/vm-gui.lock)
cargo run -p conn-app
```

## Docs

- [`AGENTS.md`](AGENTS.md) — Agent rules, VM workflow, crate boundaries, visual parity checklist.
- [`GOAL.md`](GOAL.md) — Phased 6-hour multi-agent spike plan.
- [`docs/architecture.md`](docs/architecture.md) — Detailed technical mapping from Conn + Threadbear into `conn-gpui`.
- [`docs/design-spec.md`](docs/design-spec.md) — Pixel-for-pixel Conn visual specification (shell, tokens, icons, typography, panels).
- [`docs/status.md`](docs/status.md) — Live progress ledger.
