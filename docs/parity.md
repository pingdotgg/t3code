# Parity with real Conn

conn-gpui is done only when it matches the real Conn app in look and behavior. This file lists
every known gap. Update it as gaps close; never mark a surface done without a side-by-side.

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

## Gaps (updated 2026-11-21; latest code batch pending `nick-vm` side-by-side capture)

### Look
- **Inline code:** body size (Conn `0.85em`; GPUI `TextRun` cannot change size per run); workspace file paths in inline code and `file://` links are now clickable via `InteractiveText` and open directly in the File preview tab.
- **Composer:** paperclip attachment picker + upload strip and `BranchToolbar` context strip (Local/Worktree, branch, Plan toggle, runtime permission selector) are wired; still missing effort/reasoning picker.
- **Settings modal:** live search, themes, Reduce Transparency, Connections, and Keyboard shortcuts are wired; still needs full Conn nav groups and server-backed settings rows.
- **Pending VM verification:** shell translucency/vibrancy fix (clearing `gpui-component` `Root` opaque background + `[NSApp setAppearance:]` sync + frosted right-panel roots), native macOS menu bar, header title truncation fix, tooltip placement, Tasks chart gradients, Dark Ocean side-by-side, and new PR/Device/Chat/Diff/Composer visuals.

### Browser
- Fixed: native view shown a frame before its panel repainted (flash on tab switch); URL field stuck on `about:blank`; native view hidden when right panel closes or GPUI overlays (palette, Settings) open.

### Buttons that exist but do nothing yet
- Right panel: dock to bottom.
- Composer: microphone has no dictation; `/` commands execute `/model`, `/plan`, `/settle` (other provider slash commands stay in the draft for Enter).

### Features missing
- Multi-workspace saved presets; dedicated rail Usage / global Pull Requests pages (rail buttons currently open Tasks & Linked Items).
- Working-tree / branch diff scopes (`All changes` and per-turn `Turn N` scopes via `getTurnDiff` are wired); terminal tabs/splits.
- Device WebRTC transport (MJPEG + VideoToolbox H.264 implemented).

### Done so far (code complete; items marked `*` awaiting VM screenshot verification)
- Core shell: sidebar width (288px column), thread order (latest user message), Claude and OpenAI marks, SF Mono for code and inline code, Settled footer, app activation (bundled `.app`), native macOS menu bar (`Conn`, `File`, `Edit`, `View`, `Window`) + main-window close/quit `*`, header and breadcrumb positions, header Linked items toggle & tooltips `*`, header title truncation `*`, workspace rail wired buttons & tooltips `*`, macOS vibrancy `Root` fix + `NSAppearance` sync `*`, Reduce Transparency toggle `*`.
- Sidebar: live thread search (title/project/branch) with clear button `*`, project-scope filter popover `*`, native folder picker Add project (`projects.mutate` / `project.create`) `*`, hover inline thread rename (`thread.metadata.update`) `*`, hover quick Settle / Un-settle row actions `*`, new thread (`⌘N` / compose button via `orchestration.launchThread`).
- Chat: Markdown + syntect highlighting, clickable links & workspace file-path chips via `InteractiveText` `*`, code-block colored language icon + wrap-lines toggle + copy button `*`, collapsed `"Agent <preview> ▸"` row for agent/CLI-dispatched user messages `*`, approval buttons wired to `runtime-request.respond`, model picker (`server.getConfig` + `thread.model-selection.set`), paperclip file/image attachment picker + `attachments.createUploadUrl` upload strip `*`, `BranchToolbar` context strip (Local/Worktree, branch, Plan toggle, runtime permissions selector) `*`, `/model`/`/plan`/`/settle` slash commands, `@` file mentions (`projects.searchEntries`), `"Worked for Xs"` duration labels `*`, clickable `"N changed files +A -D"` card opening Diff `*`.
- Right-panel surfaces: Files (colored `@pierre/trees` file-type icons `*`, tree + preview + open file tabs), Diff (syntect highlighting `*`, `All changes` / per-turn `Turn N` scope switcher via `getTurnDiff` `*`, Unified & side-by-side Split diff toggle `*`, resizable split handle `*`, colored file icons `*`), Terminal (`alacritty_terminal`, mouse drag/word/line selection + `⌘C`/`⌘V`/`⌘A` `*`), Browser (CEF-on-demand + overlay visibility sync), API, Database, MCP, Tasks, Pull Request (reviewer/label pickers, base-branch update popover, submit review, reactions, PR diff highlighting, agent prompt actions, collapsible header `*`), Linked Items (stacks, watch/unlink/link dialog, `pullRequests.changeBreakdown` popover `*`, gradient hover fade `*`), Device (hub ticket auth, MJPEG + VideoToolbox H.264 decode, touch/keys/hardware buttons, screenshots, foreground & event log SSE, visibility-gated lifecycle `*`).
- Settings & Palette: `⌘K` fuzzy command palette, `⌘,` Settings modal with live search `*`, live theme switching, and Reduce Transparency.
