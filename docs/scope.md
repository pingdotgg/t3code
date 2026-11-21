# Scope & Architecture Cutlist (`Orbit` + `conn-server` + `conn-gpui` + future `conn-ios`)

> **Status:** **Locked v1** (confirmed 2026-11-21). This document is the product scope contract for `conn-gpui`, the future `conn-server` trim list, and the filter rubric for the Upstream Radar ([docs/radar.md](./radar.md)).

---

## 1. Component Ownership Model

Every feature belongs to **one** primary owner. Anything duplicated across layers gets cut from the lower layers.

| Layer | Owns | Must NOT own |
| --- | --- | --- |
| **Orbit** *(infrastructure & control plane)* | Nodes & environment discovery, pairing/relay, workspaces, user profiles, themes & appearance sync, desktop settings sync, Tasks/insights board, **scheduled tasks**, `ai-router` / model routing | Local PTYs, local git/file reads, agent turn loop, macOS AppKit/CEF UI |
| **`conn-server`** *(headless per-node work engine)* | Agent execution (`conn-engine`), provider drivers (`claude`, `codex`, `acp` via `ai-router`/CLI), thread persistence & streaming, workspace files/git/diff, **GitHub PRs**, attachments, Vaultwarden credentials/test logins, **annotations**, MCP/browser/device/panel brokers, **Operator voice bridge** — serving **`conn-gpui` and mobile** | Cloud accounts/Clerk, OAuth multi-account pools, load balancing, usage-limit scrapers, guest sharing, telemetry export, T3 Whisper voice, standalone theme publishing, GitLab, AI PR Review Guides |
| **`conn-gpui`** *(thin native macOS client)* | Native Rust + GPUI frosted shell, chat/composer, right-panel views (Files, Diff, Terminal, CEF Browser, Annotations, API, DB, MCP, Tasks, GitHub PR, Linked Items, Device), local macOS bridges (`Vault --conn-bridge`, Operator dictation, `conn://` links), Orbit Gateway client | Direct raw WS framing (stays in `conn-client`), duplicate server logic, upstream T3 bloat |
| **Mobile** *(current: Expo `../conn/apps/mobile`; future: **pure SwiftUI iOS**)* | **Now:** Expo remains the daily-driver mobile app during transition (keep its required RPCs intact on `conn-server`). **Next:** Pure SwiftUI iOS app sharing the GPUI-free Rust core (`conn-client` + `conn-state` + `conn-theme` via UniFFI) — focused on inbox, chat, Operator voice, approvals/questions, and quick PR/task views. | Embedded CEF browser, split IDE diffs, multi-panel desktop dock, React Native/Expo runtime long-term |

---

## 2. Locked T3 / Conn Feature Cutlist

**Dispositions:** `Keep` · `Subset` · `Orbit` · `Operator` · `Drop`

### A. Infrastructure, Identity, Providers & Sync

| # | Feature / Subsystem | Decision | Rationale / Driver | `conn-server` impact |
| --- | --- | --- | --- | --- |
| 1 | **Environments, Linking & Relay** | **`Orbit`** | All node/server discovery, auto-pairing, and environment switching come from Orbit Gateway. | Drop Clerk/T3 Connect, manual peer-link UI, standalone relay & authorized-clients UI; keep bearer/scope auth Orbit & mobile need. |
| 2 | **Themes, Appearance & Profile Sync** | **`Orbit`** | Presets + custom palettes + workspaces + per-device settings sync through Orbit profiles (`PATCH /profiles/{id}/settings`). | Drop server theme publishing (`t3_theme_set` / theme store). |
| 3 | **Provider Accounts, OAuth & Load Balancing** | **`Drop`** | Models run through **`ai-router` / proxy API / CLI**. Zero Codex multi-account, ChatGPT account picker, OAuth wizards, usage-limit sources, or load balancing. | Delete `limits/`, multi-account auth, ChatGPT OAuth, load-balancing config. |
| 4 | **Provider Drivers** | **`Subset`** | Keep `claude`, `codex`, and `acp` drivers configured against `ai-router` / local CLI — no per-provider account setup wizards. | Keep `conn-provider-{claude,codex,acp}`, strip account/OAuth branches. |
| 5 | **Vaultwarden & Vault Mac Bridge** | **`Keep`** | Full Vaultwarden support + `Vault --conn-bridge` (Database connections + personal browser autofill with CDP redaction/lock) + agent test logins (`save_test_login`). | Keep `credentials.*`, `secrets.*`, and browser credential redaction/lock. |
| 6 | **Voice / Dictation** | **`Operator`** | Replace all T3/Whisper transcription with **Operator** (`/dictate/start\|stop\|wait\|cancel`), including a `conn-server` Operator voice bridge so mobile uses Operator too. | Strip upstream T3 voice/Whisper engines; expose Operator transcription bridge. |
| 7 | **Scheduled Tasks** | **`Orbit`** | Orbit owns fleet/workspace schedules. Omit Conn-local scheduler from `conn-gpui`. | Trim `conn-features/scheduled` + `scheduledTasks.*` once Expo no longer needs it. |

### B. Core Shell, Sidebar, Chat & Settings

| # | Feature / Subsystem | Decision | Rationale / Driver | `conn-server` impact |
| --- | --- | --- | --- | --- |
| 8 | **Shell, Workspace Rail & Multi-Window** | **`Keep` + `Orbit`** | Native GPUI frosted shell, workspace rail, multi-window; workspaces & icons synced via Orbit profile. | None (client + Orbit). |
| 9 | **Thread Sidebar** | **`Subset`** | Keep flat thread list, search, project filter, inline rename, quick Settle/Un-settle, Settled shelf, New thread. **Drop:** Snooze presets, Archived threads page, Working shelf, custom grouping/sort permutations. | Keep basic thread metadata/settle; prune unused snooze/archive endpoints after mobile migration. |
| 10 | **Chat Timeline & Composer** | **`Keep`** | Markdown + syntect, clickable file chips, code wrap/copy, worked duration, changed-files card, approvals, model + effort picker, attachments, clipboard image paste, `BranchToolbar` (Local/Worktree, branch, Plan, runtime mode), `/` + `@` menus, Operator mic. | Keep `orchestration.*`, `attachments.*`, `projects.searchEntries`. |
| 11 | **Command Palette (`⌘K`)** | **`Keep`** | Fuzzy threads, projects, Orbit workspaces, themes, shell actions. | None (client-side). |
| 12 | **Worktrees & Git Branching** | **`Subset`** | Keep core worktree handoff/creation/branch display. **Drop:** custom branch-naming template UI & complex worktree settings pages. | Keep `git.*` / worktree core. |
| 13 | **Settings Architecture** | **`Subset`** | Flat Orbit-synced profile + minimal per-project overrides (scripts, worktree default). **Drop:** Labs flags, Global/Env/Project multi-scope inheritance engine (`SettingsScopeContext`), custom keybindings editor, visual Theme Editor & Inspector spotlight. | Drop `keybindings.json` migration engine & scope-inheritance bloat; keep lean `settings` + `project` config. |
| 14 | **Desktop Control Socket & `conn://` Links** | **`Subset`** | Keep `conn://workspace/...` and `open-thread` activation for Orbit / Rooms tooling. Drop legacy `t3code://` migration/safeStorage copy code. | None (desktop-only). |

### C. Right-Panel Surfaces & Agent Bridges

| # | Surface / Feature | Decision | Rationale / Driver | `conn-server` impact |
| --- | --- | --- | --- | --- |
| 15 | **Files & Diff** | **`Keep`** | File tree, preview tabs, `@pierre/trees` icons, syntect diff, turn scopes, Unified + Split diff, working-tree/branch diff. | Keep `conn-files`, `conn-vcs`, diff RPCs. |
| 16 | **Terminal** | **`Subset`** | Keep `alacritty_terminal` panel + selection/clipboard. Defer multi-tab/split terminals & bottom-dock layout until actually missed. | Keep `conn-terminal`. |
| 17 | **Browser (CEF) + Agent Automation + Laravel Toolbar** | **`Subset`** | Keep CEF-on-demand, `preview_*` agent tab automation/CDP relay, Vault autofill + redaction, and Laravel Toolbar. **Drop:** multi-profile browser tabs & Chrome/Arc profile import wizard. | Keep preview automation broker + desktop tab relay; drop profile-import plumbing. |
| 18 | **Browser & Device Annotations** | **`Keep`** | Core Conn workflow: annotation queue + overlay + Operator dictation + `annotations_*` MCP tools. | Keep `conn-features/annotations` + `annotations_*` MCP tools. |
| 19 | **API Panel** | **`Keep`** | Local HTTP runner (`conn-desktop`) + Laravel Toolbar header inspection. | None (local desktop). |
| 20 | **Database Panel** | **`Keep`** | Read-only SQLite/Postgres/MySQL + SSH tunnel + `Vault --conn-bridge` + `database_query` agent tool. | None (local desktop + `panels.requests`). |
| 21 | **MCP Inspector Panel** | **`Keep`** | Local stdio/HTTP/SSE inspector + `mcp_connect` / `mcp_call` agent tools. | None (local desktop + `panels.requests`). |
| 22 | **Tasks (Orbit Board)** | **`Keep` (`Orbit`)** | Tight native Orbit integration: KPI insights, lanes, task detail, direct thread launch from tasks. | None (Orbit Gateway directly). |
| 23 | **Pull Request & Linked Items** | **`Subset`** | **GitHub only:** keep PR viewer, reviews, reactions, diff, linked stacks, watch/unwatch. **Drop:** GitLab support & AI PR Review Guides (`write_pull_request_guides` / `read_pull_request_guide`). | Keep GitHub path in `conn-source-control`; cut GitLab provider & PR review guide runner. |
| 24 | **Device Panel (iOS / Android)** | **`Subset`** | Keep local + SSH Device Hub streaming (MJPEG + VideoToolbox H.264, input, screenshots, `device_*` tools). **Drop:** EAS Cloud & Simlock remote host editors. | Keep core `device.*` (local + SSH); drop EAS Cloud & Simlock host config. |
| 25 | **Agent-Opened Panels (`panel_open`, `database_query`, `mcp_*`)** | **`Keep`** | Core Conn superpower (`panels.requests` / `panels.respond`) so agents drive live desktop surfaces in front of you. | Keep `panels.*` broker. |

### D. Upstream T3 Features Explicitly Dropped

| # | Upstream T3 Feature | Decision | Why cut |
| --- | --- | --- | --- |
| 26 | **SnapShot (screen capture + shortcut recorder)** | **`Drop`** | macOS has native screenshots + Browser/Device panels capture directly. |
| 27 | **Guest Share Links (`guestShare.*`)** | **`Drop`** | Solo workflow — zero need for public guest thread sharing. |
| 28 | **Resource Monitor & Telemetry Export** | **`Drop`** | Drop `t3-resource-monitor`, `ResourceTelemetryDiagnostics`, `TelemetryExportSettings`. Keep simple connection status/logs only. |
| 29 | **Side Chats right-panel tab** | **`Drop`** | Multi-window / normal threads already cover parallel chats without extra panel complexity. |
| 30 | **Visual Theme Editor & Inspector Spotlight** | **`Drop`** | Orbit-synced themes + JSON theme files are plenty; skip maintaining a full visual color-role IDE. |
| 31 | **Browser Profile Import Wizard & Multi-Profile Tabs** | **`Drop`** | Single CEF profile + Vault autofill + test logins keeps browser state simple and reliable. |
| 32 | **Custom Thread Title & Commit Writing Prompt Settings** | **`Drop`** | Use clean repo-convention defaults instead of extra prompt-config UI. |
| 33 | **Notifications Granularity & Per-Event Rules** | **`Subset` / `Drop`** | Simple on/off native macOS notification when a thread finishes or needs approval. |

---

## 3. `conn-server` Trim Blueprint

> **Mobile Guardrail:** `../conn/apps/mobile` (Expo) is Nick's active daily-driver mobile app until a pure SwiftUI iOS client replaces it. Before deleting any RPC or crate in `../conn-server`, verify `../conn/apps/mobile` does not call it (or migrate the Expo app in the same change).

- **Keep:** `conn-wire`, `conn-contract` (pruned), `conn-engine`, `conn-provider` + `conn-provider-{claude,codex,acp}` (simplified for `ai-router`/CLI), `conn-files`, `conn-vcs`, `conn-terminal`, `conn-mcp`, `conn-source-control` (GitHub only), `panels.*`, `preview.*` (automation broker + desktop relay), `credentials.*` / `secrets.*`, `annotations.*`, `device.*` (local + SSH), and the new **Operator voice bridge**.
- **Cut / Prune:** `limits/` & usage-limit scrapers, Clerk / T3 Connect / cloud relay, manual `peerLinks.*` UI plumbing, `guestShare.*`, `t3-resource-monitor` & telemetry export, `keybindings.rs` migration machinery, upstream T3 Whisper/voice engines, `model_manifest` account/pricing bloat, GitLab source-control provider, AI PR review guide runner (`write_pull_request_guides`), EAS Cloud & Simlock host plumbing, and `scheduledTasks.*` (once Expo no longer calls it).

---

## 4. Shared Core Rule (Desktop + Future SwiftUI iOS)

Keep `crates/conn-client`, `crates/conn-state`, and `crates/conn-theme` **100% GPUI-free and `#![forbid(unsafe_code)]`**. That guarantees:
1. Instant headless unit tests (`cargo test -p conn-client -p conn-state -p conn-theme`).
2. Drop-in reuse via **UniFFI** (`.xcframework`) when building the pure SwiftUI iOS client later — zero protocol or reducer duplication across `conn-server`, `conn-gpui`, and iOS.
