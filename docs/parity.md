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

## Gaps (2026-11-21 09:15, measured side by side in nick-vm)

### Look
- Chat: no "61 changed files" card after the turn; "Worked" lacks "for 7.5s"; code blocks show a
  `rust` label where Conn shows the language icon plus wrap and copy buttons; inline code is
  body size (Conn 0.85em; GPUI text runs cannot change size); file paths in inline code are not
  links with file icons (Conn: `main.rs` with the Rust icon).
- Messages a thread was started with by an agent/CLI render as a normal bubble; Conn shows an
  "Agent <text> v" collapsed row.
- Sidebar rows sit 2-3px lower than Conn's; composer is ~14px taller and lacks the paperclip.
- Header title overflows instead of truncating; macOS menu bar has no File/Edit/View/Window/Help.
- Settings modal differs a lot from Conn's (nav groups, search, rows); Dark Mono comparison not
  done yet (the VM reference runs T3 Code Light).

### Browser
- Fixed: native view shown a frame before its panel repainted (flash on tab switch); URL field
  stuck on `about:blank`. Not reproduced on ordinary clicks with tracing (`CONN_WEB_TRACE=1`):
  no hide/show/resize/reload happens. VMPal captures are too slow to see a single-frame flash.

### Buttons that exist but do nothing yet
- Sidebar: Search field, Filter, Add project. Rail: `+` (workspace), Usage, Pull requests.
- Chat header: thread details. Right panel: dock to bottom.
- Composer: `/` commands are listed but not executed; microphone has no dictation.

### Features missing
- Thread search, settle/archive, rename; add project; workspaces.
- Tasks, Pull requests, Usage surfaces; Database/MCP/Device panels.
- Diff scopes, split diff, resizable splits; terminal tabs/splits.

### Done so far
- Sidebar rows, rail, chat header, timeline, composer and right panel header rebuilt against
  the lab's code and captures; Dark Mono default theme; browser flicker fixed; new thread
  (Cmd+N and the sidebar compose button) via `orchestration.launchThread`.
- Side-by-side fixes: sidebar width (288px column), thread order (latest user message), Claude
  and OpenAI marks, SF Mono for code and inline code, Settled footer, app activation (bundled
  `.app`), header and breadcrumb positions match.
