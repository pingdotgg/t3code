# Parity with real Conn

conn-gpui is done only when it matches the real Conn app in look and behavior. This file lists
every known gap. Update it as gaps close; never mark a surface done without a side-by-side.

## Reference

- **Spec source:** the Conn UI lab worktree `~/apps/conn-ui-lab` (branch `lab/conn-ui`, tracks
  Conn `main`; newer than the `../conn` pin). It mounts the real Conn `AppRoot` on fake data.
- **Build it privately** (never into the shared `/tmp/conn-lab-dist`):
  `cd ~/apps/conn-ui-lab/apps/web && LAB_OUT_DIR=/tmp/conn-gpui-dev/lab-dist vp build --config vite.lab.config.ts`,
  serve with `python3 -m http.server 5811 --bind 127.0.0.1` from that folder.
- **Capture it:** headless Chrome at 1440x900 @2x:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --user-data-dir=<tmp> --window-size=1440,900 --force-device-scale-factor=2 --virtual-time-budget=15000 --screenshot=out.png "http://127.0.0.1:5811/lab.html[?theme=light]"`.
  Captures so far: `.shots/ref-lab/lab-dark.png`, `lab-light.png`.
- **Theme:** Nick's dark theme is Dark Mono (built in, the default); light is T3 Code Light.
- **Ours:** `scripts/run-app.sh` + `scripts/automate.py` screenshot at the same window size.

## Gaps (2026-11-21, from lab vs `.shots/parity/ours-dark.png`)

### Shell and chrome
- Chat header: Conn has a document/notes button at the right of the chat header; ours has a
  ToolbarGroup of four panel toggles there instead.
- Right panel header: Conn shows open panel tabs (`Tasks`, ...) with a `+` add-panel menu and,
  at the far right, expand, dock-to-bottom and toggle buttons. Ours shows fixed Files, Diff,
  Terminal, Browser tabs.
- Rail: Conn has Usage, Pull requests and Settings at the bottom; ours lacks Pull requests.
  Rail tiles: Conn shows only the active-workspace tile and `+` when there are no saved workspaces.

### Sidebar
- Thread rows: Conn's row is two lines: project monogram + title, then provider icon · project ·
  branch · age (muted). Ours is a three-line card.
- Status glyphs (plan/idea bulb, working, approval) placed like Conn's.

### Timeline
- "Worked for X" collapsible work group with a divider; tool rows grouped inside it.
- Task cards (Orbit tasks) and their meta line.
- Chat lane width and spacing (Conn's lane is narrower; bubble and text sizes).

### Composer
- Footer: provider icon + model name, microphone, send on the right; Conn has no model chip on
  the left.
- Model/effort picker, attachments, `/` commands, `@` files, `$` skills menus.

### Features missing entirely
- New thread (sidebar compose button), thread search, settle/archive, rename.
- Approve/deny approval cards (`runtime-request.respond`).
- Add project; workspaces.
- Tasks, Pull requests, Usage surfaces.

### Fixed
- Browser flicker on every click (visibility was guessed from repaints; now explicit).
- Dark Mono theme added and made default.
