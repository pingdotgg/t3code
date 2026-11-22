# Parity with real Conn (within `docs/scope.md`)

conn-gpui matches the real Conn shell in look and behavior **for the locked feature set in [`docs/scope.md`](./scope.md)** — do not chase upstream T3 Code features marked `Drop` or moved to `Orbit`. This file lists every known gap inside that scope. Update it as gaps close; never mark a surface done without a side-by-side.

## Reference: real Conn side by side in nick-vm

GUI verification happens in nick-vm through VMPal (screenshots, real clicks, typing), never on
Nick's Mac and never by asking Nick to test. Take `/tmp/vm-gui.lock` around GUI steps.

- Private VM folder: `~/apps/conn-gpui-vm/{conn-gpui,conn-server,bin,sdk-host,ref}`.
  Sync from the Mac: `rsync -rlpz --checksum --exclude '/target*' --exclude '/.refs' --exclude '/.shots' --exclude '/.git' conn-gpui/ vm:apps/conn-gpui-vm/conn-gpui/`
  (checksum, no time preservation, so cargo sees edits).
- Shared data: the disposable `conn-server` in the VM on `127.0.0.1:3891`
  (state `/tmp/conn-gpui-dev/state`, same seeded threads as on the Mac).
- Real Conn: `~/apps/conn-gpui-vm/ref/Conn.app` (copy of Nick's installed build), launched with
  `open -n -a ... --env T3CODE_HOME=/tmp/conn-ref-home2` and paired to the server as a remote
  environment. Window at (20, 41), 1440x900 points.
- conn-gpui: `scripts/vm-run.sh [theme]` builds, bundles (`scripts/bundle-app.sh`) and opens it
  at the same frame (`CONN_GPUI_WINDOW=20,41,1440,900`). Cmd+H one app to capture the other.

## Gaps (updated 2026-11-21; verified side-by-side in `nick-vm` via VMPal)

### Look
- **Inline code:** body size (Conn `0.85em`; GPUI `TextRun` cannot change size per run); workspace file paths in inline code and `file://` links are clickable via `InteractiveText` and open directly in the File preview tab (verified in `nick-vm`).
- **Composer:** paperclip attachment picker + upload strip, Claude/OpenAI brand marks + full model alias resolution (`Claude Haiku 5.5`), reasoning/effort picker (`Medium` via `capabilities.option_descriptors` -> `modelSelection.options`), and `BranchToolbar` context strip (Local/Worktree, branch, Plan toggle, runtime permission selector) are wired and verified in `nick-vm`.
- **Settings modal:** live search, themes, Reduce Transparency, Connections, and Keyboard shortcuts are wired and verified in `nick-vm`; still needs full Conn nav groups and server-backed settings rows.
- **Vibrancy & glossy shell parity (verified 0–1 RGB vs `Conn.app` in `nick-vm`):** Measured over identical bounds and backdrop across all 3 reference themes: **Conn Dark (`t3-code-dark`)** gloss shell `(53,51,52)` vs `(53,51,52)`, sidebar `(25,25,25)` vs `(26,26,26)`, chat/right panel `(17,17,17)` vs `(17,17,17)`; **Ocean Dark** gloss shell `(61,68,78)` vs `(61,68,78)`, sidebar `(38,50,62)` vs `(38,50,62)`, chat/right panel `(29,45,60)` vs `(29,45,60)`; **Conn Light (`t3-code-light`)** gloss shell `(242,240,241)` vs `(242,240,241)`, sidebar `(249,249,249)` vs `(249,249,249)`, chat/right panel `(251,251,251)` vs `(251,251,251)`. Right-panel tab strip clips/scrolls cleanly with 7+ open tabs, Tasks 4-col KPI strip fits without clipping, Command Palette uses opaque `popover` fill with no text bleed, Split Diff and tooltip placement verified via real VMPal clicks/hover.

### Browser
- Fixed: native view shown a frame before its panel repainted (flash on tab switch); URL field stuck on `about:blank`; native view hidden when right panel closes or GPUI overlays (palette, Settings) open.

### Buttons that exist but do nothing yet
- Right panel: dock to bottom *(deferred per `docs/scope.md` #16 — hide or wire later)*.

### Features missing (within locked `docs/scope.md`)
- **Browser & Device Annotations (`#18`):** annotation overlay, queue panel, and Operator dictation wired to `annotations_*`.
- **Diff (`#15`):** working-tree / branch diff scopes (`All changes` and per-turn `Turn N` scopes via `getTurnDiff` are wired).
- **Device (`#24`):** optional WebRTC transport (MJPEG + VideoToolbox H.264 implemented).
- **Intentionally omitted (see `docs/scope.md`):** Usage limits/accounts (`#3`), Snooze/Archive/Working shelves (`#9`), Labs/Theme Editor/Keybindings editor (`#13`, `#30`), GitLab & AI PR Review Guides (`#23`), EAS/Simlock hosts (`#24`), SnapShot/Guest Share/Telemetry/Side Chats (`#26`–`#29`).

### Done so far (verified in `nick-vm` side-by-side captures)
- Composer Operator dictation & clipboard paste: `conn_desktop::operator::OperatorClient` (`/dictate/{start,stop,wait,cancel}` + 504 wait loop + legacy fallback), composer mic toggle (`Listening…` / `Transcribing…`, `Esc` cancel, external Operator shortcut auto-insert), `⌘V` clipboard image & file paste, and drag-and-drop file upload onto the composer.
- Orbit profile sync: `OrbitProfileClient` (`GET /me`, `/profiles`, `PUT /me/profile`, `GET/PUT/PATCH /profiles/{id}/settings` with 3-way conflict merges), synced workspace tiles in the 54px rail + sidebar project-group filtering, `"From Orbit profile"` custom themes in Appearance & Command Palette (`⌘K`), bi-directional appearance & desktop settings push, and `Settings › Connections › Orbit profile sync` controls (live-verified against `https://gateway.orbit`).
- Core shell: sidebar width (288px column), thread order (latest user message), Claude and OpenAI marks, SF Mono for code and inline code, Settled footer, app activation (bundled `.app`), native macOS menu bar (`Conn`, `File`, `Edit`, `View`, `Window`) + main-window close/quit, header and breadcrumb positions, header Linked items toggle & tooltips, header title truncation, workspace rail wired buttons & tooltips, macOS vibrancy `Root` fix + `NSAppearance` sync (exact RGB match to `Conn.app`), Reduce Transparency toggle.
- Sidebar: live thread search (title/project/branch) with clear button, project-scope filter popover, native folder picker Add project (`projects.mutate` / `project.create`), hover inline thread rename (`thread.metadata.update`), hover quick Settle / Un-settle row actions, new thread (`⌘N` / compose button via `orchestration.launchThread`).
- Chat: Markdown + syntect highlighting, clickable links & workspace file-path chips via `InteractiveText`, code-block colored language icon + wrap-lines toggle + copy button, collapsed `"Agent <preview> ▸"` row for agent/CLI-dispatched user messages, approval buttons wired to `runtime-request.respond`, model picker + alias resolution + Claude/OpenAI brand marks + reasoning/effort picker (`server.getConfig` + `thread.model-selection.set`), paperclip file/image attachment picker + `attachments.createUploadUrl` upload strip, `BranchToolbar` context strip (Local/Worktree, branch, Plan toggle, runtime permissions selector), `/model`/`/plan`/`/settle` slash commands, `@` file mentions (`projects.searchEntries`), `"Worked for Xs"` duration labels, clickable `"N changed files +A -D"` card opening Diff.
- Right-panel surfaces: clipped/scrollable multi-tab header (zero overlap with maximize/dock/close controls), Files (colored `@pierre/trees` file-type icons, tree + preview + open file tabs), Diff (syntect highlighting, `All changes` / per-turn `Turn N` scope switcher via `getTurnDiff`, Unified & side-by-side Split diff toggle, resizable split handle, colored file icons, tooltips), Terminal (`alacritty_terminal`, mouse drag/word/line selection + `⌘C`/`⌘V`/`⌘A`), Browser (CEF-on-demand + overlay visibility sync, verified rendering `https://example.com/`), API, Database, MCP, Tasks (4-column KPI strip + sparklines + lanes), Pull Request (reviewer/label pickers, base-branch update popover, submit review, reactions, PR diff highlighting, agent prompt actions, collapsible header), Linked Items (stacks, watch/unlink/link dialog, `pullRequests.changeBreakdown` popover, gradient hover fade), Device (hub ticket auth, MJPEG + VideoToolbox H.264 decode, touch/keys/hardware buttons, screenshots, foreground & event log SSE, visibility-gated lifecycle).
- Settings & Palette: `⌘K` fuzzy command palette (opaque `popover` surface), `⌘,` Settings modal with live search, live theme switching, and Reduce Transparency.
