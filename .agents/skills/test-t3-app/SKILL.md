---
name: test-t3-app
description: Test T3 Code's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Use T3's built-in Browser panel for verification. If its tools are absent or
the panel reports unavailable, explain the blocker and stop verification.
Do not install or switch to another automation system. For native mobile
testing, use [test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Drive agent turns for free

Do not spend a paid model to see a turn render. `vp run dev` registers the
`Replay (dev)` provider, which replays recorded turns with simulated streaming
through the real adapter and orchestration. Its models are scenarios:
`showcase` covers thinking, a plan, tool calls, an approval, and markdown.
Press `Ctrl+Alt+Shift+R` for a picker (GNOME takes that key for screen
recording), call `window.t3dev.replay("showcase")`
with `preview_evaluate`, or run
`node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go"`.
When the test needs real provider behavior, use that provider's cheapest
model, such as Haiku for Claude or Luna for Codex.

## Use the Browser panel

Call `preview_status`, then `preview_open` if the Browser panel is
closed. Navigate to the complete startup pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one. Keep using the same tab.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
