# 6-Hour Spike Goal: Conn Desktop on Rust + GPUI

**Objective:** Build a working, visually faithful GPUI desktop client for Conn that connects to a real `conn-server` instance (against a disposable `--state-dir`) and reproduces the Conn desktop UI pixel-for-pixel across its core workflow: macOS frosted shell, workspace rail, thread sidebar, 44px header, live streaming chat timeline, composer, and docked right panel (Files, Diff, Terminal, and CEF Browser spike).

**Non-goals for this 6-hour spike:**
- Do NOT implement mobile (iOS/Android stays separate).
- Do NOT re-implement `conn-server` or provider adapters—connect to `apps/conn-server` over `/ws` using `conn-wire` and `conn-contract`.
- Do NOT implement Clerk cloud auth, auto-updater, Vaultwarden autofill, or Orbit fleet sync yet (keep local/dev-token connection rock solid first).
- Do NOT touch live `~/.t3/userdata` (always run `conn-server` against a disposable `--state-dir`). Building, testing, and running directly on this Mac is explicitly approved for this run.

---

## Sub-Agent Workstream Split

Spawn specialized sub-agents along crate boundaries so work stays parallel and merge conflicts stay tiny:

1. **Stream 1 — Protocol & State (`conn-client`, `conn-state`)**
   - WebSocket client to `conn-server` (`/ws?orchestrationProtocol=2`, auth token header/query, `FromClient`/`FromServer` via `conn-wire`, `Ping`/`Pong`, `Ack` on stream chunks, automatic reconnect).
   - Typed RPC wrappers using `conn-contract::rpc::*`: `orchestration.subscribeShell`, `orchestration.subscribeThread`, `orchestration.dispatchCommand`, `server.getConfig`, `projects.*`, `git.*`, `files.*`, `terminal.*`.
   - Pure Rust shell + thread reducers in `conn-state` (projects, workspaces, thread list, unread/working states, streaming turn items, tool calls, diffs, pending approvals/asks).
   - Unit + integration tests against a local `conn-server` with a temp `--state-dir` (or fake provider).

2. **Stream 2 — Design System & Themes (`conn-theme`)**
   - Port all built-in Conn themes from `packages/shared/src/themePalettes.ts` (`t3-code` light/dark, `t3-chat`, `grove`, `ocean`, `ember`, `iris`) plus JSON loader for custom themes (especially Dark Ocean).
   - Implement exact `color-mix` sRGB derivation for every token in `docs/design-spec.md` and `.claude/skills/nckrtl-shell-design/references/tokens.md` (`--shell-fill`, `--shell-panel`, `--shell-card`, `--shell-raised`, `--shell-overlay`, `--shell-highlight`, `--shell-tile`, `--shell-field`, `--shell-control`, `--shell-divider`, `--shell-divider-header`, `--shell-divider-raised`, `--glass-divider`, `--switch-on`, etc.).
   - Map Conn tokens cleanly into `gpui-kit` theme overrides so every kit primitive inherits Conn's exact look.
   - Unit tests asserting computed dark & light token contrast/values against Conn's CSS formulas.

3. **Stream 3 — Window Shell, Workspace Rail & Sidebar (`conn-app`: `shell/`, `sidebar/`, `header/`)**
   - macOS window setup matching `apps/desktop/src/window/DesktopWindow.ts` and `.refs/threadbear/desktop/gpui/src/`: frameless titlebar, 18px window radius, macOS vibrancy/material backdrop, traffic lights vertically centered on the **44px** header (`--shell-header-height`).
   - Outer frosted frame (`--shell-fill`) with 4px inset (`--shell-inset`), 14px concentric card corners (`--shell-corner`), 0.5px inner border, and 1px two-tone panel dividers.
   - Workspace rail (leftmost rail with rounded workspace tiles, active ring `2px` inset with gap) + collapsible thread sidebar (projects, threads, status dots/spinners, hover/active/selected lighting overlays, search/filter, new-thread button).
   - 44px transparent header bar with thread title/breadcrumb, branch/worktree indicator, right-panel toggles aligned at 11px right inset, and 28px circular header icon buttons.
   - Shared Conn primitives: `ToolbarGroup`, soft search/address input (`h-8`), pill `Switch`, raised `Kbd`, `dropdown-glass` menu/popover surfaces, inset scrollbars.

4. **Stream 4 — Chat View, Timeline & Composer (`conn-app`: `chat/`)**
   - Virtualized/smooth-scrolling message timeline (`13px` UI chrome, Phosphor solid/bold icons inside timeline vs Lucide elsewhere).
   - User bubbles (`rounded-bubble` 16px), assistant Markdown rendering (headings, lists, inline code, fenced syntax-highlighted code blocks with copy button, tables, links), tool call / work-log collapsible rows, thinking blocks, working/status rows (`border-(--shell-divider-header)`), pending approval / question cards.
   - Bottom composer: multiline input, model/provider/effort picker, permission/interaction mode controls, send/stop/queue/steer actions, branch/worktree toolbar (`BranchToolbar` equivalent), drag-and-drop / paste image attachment chip bar.

5. **Stream 5 — Right Panel Surfaces & CEF Browser Spike (`conn-app`: `panels/`, `crates/conn-web`)**
   - Tabbed right panel with `RightPanelTabs` styling (Files, Diff, Terminal, Browser, and stub slots for Database/MCP/Device).
   - **Files panel:** Project file tree + search field (`InputGroup soft`) + syntax-highlighted source preview with clean T-junction split divider.
   - **Diff panel:** Changed files list + unified/split diff view with +/- counts matching text size.
   - **Terminal panel:** Real PTY terminal rendered in GPUI using `alacritty_terminal` (mirroring `.refs/threadbear/desktop/gpui/src/terminal.rs` & `terminal_element.rs`) connected to `conn-server`'s terminal RPCs or local shell.
   - **Browser panel (`conn-web`):** CEF-on-demand runtime modeled directly on `.refs/threadbear/desktop/web/` (`cef-rs` + `dlopen` loader + URL bar using Conn's soft field + `ToolbarGroup` nav buttons + CDP readiness). Keep browser panel optional/feature-gated until CEF archive is fetched so the main app never blocks on it.

6. **Stream 6 — Visual Verification, Settings Modal & Command Palette (`conn-app`: `settings/`, `palette/`, `automation.rs`)**
   - `Cmd+K` Command Palette (`--command-shell-inset`, `--command-content-inset`, threads/projects/themes/actions).
   - Settings route modal (`AppRouteModal`: frosted frame, transparent 44px header, inset left nav, raised group cards with `--shell-divider-raised`, theme switcher live-updating the whole window).
   - Scripted automation & screenshot capture hook (`--automation` feature, modeled on `.refs/threadbear/desktop/gpui/src/automation.rs`) so the orchestrator can capture screenshots of every major view (Dark Ocean + Light) and visually diff them against Conn Electron screenshots.

---

## Phased Milestones (6-Hour Target)

| Phase | Time budget | Exit criteria (must pass `scripts/check.sh`) |
| --- | --- | --- |
| **Phase 1: Boots & Connects** | 0:00 – 1:00 | Workspace builds cleanly; `conn-client` connects to a temp `conn-server`, receives `subscribeShell` snapshot; `conn-theme` computes Dark Ocean + Light tokens; `conn-app` opens a native macOS window with 44px traffic-light alignment and frosted shell frame. |
| **Phase 2: Shell + Sidebar + Live Threads** | 1:00 – 2:30 | Workspace rail, thread sidebar with real projects/threads from `conn-server`, 44px header, theme switcher, and Lucide/Phosphor SVG icon assets loaded. First visual screenshot comparison against Conn desktop; fix geometry/color drift. |
| **Phase 3: Chat Timeline + Working Composer** | 2:30 – 4:00 | Selecting a thread streams real history via `subscribeThread`; Markdown + code blocks + tool call rows + user bubbles render cleanly; sending a prompt dispatches `dispatchCommand` and streams live response (tested with fake/replay provider or cheap Haiku turn). |
| **Phase 4: Right Panels (Files, Diff, Terminal)** | 4:00 – 5:00 | Right panel opens/resizes with T-junction dividers; Files tree + viewer, Diff viewer, and live `alacritty_terminal` panel work end-to-end. |
| **Phase 5: Polish, Settings, Palette & CEF Browser Spike** | 5:00 – 6:00 | `Cmd+K` palette, Settings modal with live theme switching, `conn-web` CEF-on-demand browser spike (at minimum downloading/loading CEF and rendering a localhost URL inside the Browser tab), final side-by-side screenshot audit, and updated `docs/status.md`. |

---

## Starting Prompt Checklist for Orchestrator

When launching the 6-hour run:
1. Confirm `.refs/threadbear` exists (run `scripts/sync-refs.sh` if needed) and the Conn monorepo + `apps/conn-server` are present.
2. Start a disposable `conn-server` (seeded or fresh `--state-dir /tmp/conn-gpui-dev`) on a free port—never `~/.t3`.
3. Capture 2–3 baseline reference screenshots of Conn's current UI (Dark Ocean + Light) or inspect `apps/web/src/index.css` & `nckrtl-shell-design` so every agent shares the exact target.
4. Kick off Streams 1, 2, and 3 in parallel first; integrate Phase 1 before fanning out Streams 4, 5, and 6.
5. Keep `docs/status.md` updated at every phase boundary with what is proven, screenshots taken, and remaining gaps.
