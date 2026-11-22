# conn-gpui

A native Rust + GPUI desktop client for **Conn** (Nick's fork of T3 Code), built to match Conn desktop's visual design pixel-for-pixel while talking directly to `conn-server` (`apps/conn-server` in this monorepo) over its typed Rust contract crates.

> **Status:** See [`docs/status.md`](docs/status.md) and [`docs/scope.md`](docs/scope.md).

## Architecture at a glance

```text
conn-gpui (Rust + GPUI desktop app)
  ├── crates/conn-client  ──► WebSocket /ws (Effect RPC via apps/conn-server/crates/{conn-wire,conn-contract})
  ├── crates/conn-state   ──► Pure Rust reducers, workspace/thread/panel state (zero GPUI deps)
  ├── crates/conn-theme   ──► Conn theme palettes + color-mix shell tokens -> GPUI Hsla
  ├── crates/conn-web     ──► Embedded Chromium browser via CEF-on-demand (modeled on Threadbear)
  └── crates/conn-app     ──► GPUI binary: frosted shell, workspace rail, sidebar, chat, composer, right panels
```

## Reference repositories

Conn itself (web, desktop, mobile, `conn-server`) is this monorepo. Third-party references are pinned in [`references.pin`](references.pin) and synced into gitignored `.refs/` via `scripts/sync-refs.sh`:

- **`.refs/threadbear`** — Read-only shallow clone of [`mikecann/threadbear`](https://github.com/mikecann/threadbear). Primary reference for GPUI + `gpui-kit = "=0.9.0"`, macOS AppKit hooks, `alacritty_terminal`, and `cef-rs` on-demand embedding.
- **`.refs/rune`** — Read-only shallow clone of [`anomalyco/rune`](https://github.com/anomalyco/rune). Secondary inspiration reference (rendering/text/perf research notes, frosted-glass & motion ideas, agent visual-verification patterns).

## Prerequisites & commands

```sh
# 1. Populate read-only references (.refs/threadbear, .refs/rune)
scripts/sync-refs.sh

# 2. Run formatting, clippy (-D warnings), and workspace tests
scripts/check.sh

# 3. Run the desktop app against a disposable conn-server
cargo run -p conn-app
```

## Docs

- [`AGENTS.md`](AGENTS.md) — Agent rules, VM workflow, crate boundaries, visual parity checklist.
- [`GOAL.md`](GOAL.md) — Phased 6-hour multi-agent spike plan.
- [`docs/architecture.md`](docs/architecture.md) — Detailed technical mapping from Conn + Threadbear into `conn-gpui`.
- [`docs/design-spec.md`](docs/design-spec.md) — Pixel-for-pixel Conn visual specification (shell, tokens, icons, typography, panels).
- [`docs/status.md`](docs/status.md) — Live progress ledger.
