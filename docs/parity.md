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

## Gaps (updated 2026-11-21, after the parity pass; compare `.shots/parity/ours2-*.png` with `.shots/ref-lab/`)

### Look
- Provider icons: Conn shows provider logos (Claude starburst, OpenAI knot); superheroicons has
  none, so rows and the composer use generic concepts.
- Status dot on the project badge approximates Conn's radial cutout with a ring.
- "Worked for <duration>": durations need run/item timestamps in `conn-state`.
- Orbit task cards in the timeline; changed-files summary.

### Buttons that exist but do nothing yet
- Sidebar: Search field, Filter, Add project. Rail: `+` (workspace), Usage, Pull requests.
- Chat header: thread details (notes). Right panel: dock to bottom.
- Composer: `/` commands are listed but not executed; microphone has no dictation.

### Features missing
- Thread search, settle/archive, rename; add project; workspaces.
- Tasks, Pull requests, Usage surfaces; Database/MCP/Device panels.
- Diff scopes (uncommitted, latest turn, commits), split diff, resizable splits; terminal tabs/splits.

### Built, not yet verified live
- Approvals: Approve/Decline on approval rows dispatch `runtime-request.respond`. The dev server's
  Claude provider never asked for approval in `approval-required` mode, so no live approval yet.
- Model picker (`server.getConfig` providers; selection dispatches `thread.model-selection.set`)
  and `/`, `@` menus: not clicked through yet (automation has no click command).

### Done in this pass
- Sidebar rows, rail, chat header, timeline, composer and right panel header rebuilt against
  the lab's code and captures; Dark Mono default theme; browser flicker fixed; new thread
  (Cmd+N and the sidebar compose button) via `orchestration.launchThread`.
