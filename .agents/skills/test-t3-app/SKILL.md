---
name: test-t3-app
description: Launch, retain, and test the T3 Code web app in isolated development environments, including first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, cross-turn dev server lifecycle, and safe SQLite inspection. Use when an agent needs to run T3 locally, iteratively test UI behavior with a human, recover from an expired or consumed pairing token, isolate dev state, or inspect disposable test data.
---

# Test T3 App

## Required outcomes

Before implementation, identify the observable scenarios the change must satisfy. Before PR
delivery, record the tested revision, scenario results, console errors, failed requests, and
published evidence links. A completed assistant turn, passing unit tests, or a video file alone
does not establish verification. Recheck affected scenarios after further edits.

## Test and capture the changed feature

Use focused tests and one integrated real-client pass after integrating the change. Authenticate
first, then exercise the relevant actions with meaningful test data. Check observable state,
snapshots, console errors, and failed requests. A generic empty app or pairing form does not
demonstrate a feature. Native behavior requires native validation, not just the web client.

Browser automation failure does not block independent backend/CLI acceptance work. Complete
those scenarios separately and keep the browser limitation scoped to what it actually prevents;
backend results do not waive the required real-client pass.

Capture before/after screenshots for UI changes. Record the action and outcome when motion,
timing, or reconnect behavior matters. Review the captures for relevance and secrets. Describe
what you actually exercised, the tested revision, observations, and limitations in the PR's
testing notes. There is no required feature-report JSON or automated visual-content verdict.

Publish with `pnpm pr:media -- <PR URL> <capture files...>`. It accepts PNG/JPEG images and
WebM/MP4 recordings, verifies each declared format and decodes all captures before any upload,
updates only its managed PR media section, and verifies the downloaded bytes. It reuses the smoke
check's Chromium decoder; install that runtime if missing with
`pnpm --filter @t3tools/scripts exec playwright install chromium` (no smoke run is required).
It does not run tests or prove the captures depict correct behavior. Its PR-head label identifies
the upload target, not when the media was captured. Supply the actual tested revision in your notes.
Remove obsolete pairing-only PR evidence rather than retaining it beside feature captures.

The publisher retains upload URLs in ignored `.t3/pr-media/` receipts. Repeating the same command
for the same PR head and files reuses completed uploads. Inspect GitHub before retrying an
ambiguous timed-out upload. Check the published images and sample the recording before reporting
delivery; local paths and CI artifacts are not permanent inline PR media. Report blockers plainly.

## Separate pairing/reconnect smoke check

Run `pnpm test:self` when changing pairing/reconnect flows or when a separate baseline check is
needed. It runs production web assertions and retains diagnostic captures and a revision manifest.
`pnpm test:self -- status` checks that baseline revision and file integrity only; neither command
establishes feature readiness. The old `feature`, `publish`, and publication-status flags are retired.

Baseline media stays in `.t3/self-test/` and CI diagnostics, not PR feature evidence. Decoding and
file hashes detect broken captures, not functional failures. White/navigation frames or a static
video are not themselves test failures; assertions against actual app behavior determine success.
The runner serializes worktree-local runs. If interrupted, inspect `.t3/self-test/lock/owner.json`
and confirm its PID is no longer running before removing only that stale lock directory. The media
publisher uses the same ownership pattern at `.t3/pr-media/lock/owner.json`.

Failed runs retain unverified recordings in the run's `raw/` directory and counters in
`diagnostics.json`; CI uploads both. These are debugging artifacts, not passed evidence.
Unexpected console errors block verification, including during pairing. The intentional
consumed-token bootstrap 401 and native unauthenticated WebSocket rejection during pairing
are counted separately, not silently ignored; application `console.error` calls still fail.
Network checks cover pairing and recovery too. Exempt only the intentional bootstrap rejection,
requests aborted by a recorded navigation, and tracing fetch cancellation after an exact 204
acknowledgement. A blanket pairing-phase or aborted-request exclusion is not valid.

Use this skill for the web client. For native mobile testing (simulator builds, Maestro flows, on-device captures), load the `test-t3-mobile` skill instead; it covers the Expo app with an isolated backend. If neither skill's requirements can be met, state clearly that the validation is unavailable rather than following a missing workflow.

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.t3` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/t3code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `t3-code.terminal_start`, passing the foreground command `pnpm dev --home-dir <absolute-base-dir> --no-browser`. Search for the tool if it is deferred. Prefer an explicit isolated directory for tests; when `--home-dir` is omitted the runner defaults to the current worktree's own gitignored `.t3` (then isolated `~/.t3-dev`), never the shared `~/.t3` home. The root script runs `scripts/dev-runner.ts`, which supports `--share` to publish the web port on the tailnet via `tailscale serve` (removed on exit; no-op for `dev:server`, unsupported for `dev:desktop`).
4. Keep the returned `terminalId`. Use `terminal_read` to read the selected server port, web port, base directory, and pairing information, and verify readiness with a health request. `terminal_start` returning successfully means the terminal accepted the command, not that the app is ready. `terminal_list` recovers existing terminal IDs after a lost response; inspect these before retrying a launch.

Retained servers belong in T3-managed terminals, not provider-attached background shells.
Copilot ACP can keep `session/prompt` pending until attached shell work exits, even after the
model has written its final answer. A retained `pnpm dev` in `bash(mode: "async")` can therefore
leave the chat showing Working indefinitely. Do not work around this with `nohup`, `&`, or
unowned detached processes. If managed terminal tools are unavailable, use a task-scoped server
and explicitly stop its exact shell session before your final answer; report that the preview
cannot be retained. Finite builds and tests may still use provider shell tools.

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.t3` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The explicit `--home-dir` must belong to this test, not the shared home from an ambient `T3CODE_HOME`.

Ports are derived from the worktree path but can shift when occupied. Always read the actual values from the `[dev-runner]` line.

Let the dev runner configure `VITE_HTTP_URL` and `VITE_WS_URL` for its selected backend port; do not override them with another environment's addresses.

Pass `--no-browser` explicitly during automated testing: an automatically opened page can consume the one-time bootstrap token before the controlled browser uses it.

### Verify a shared environment before human handoff

When another person will use the printed pairing URL, first open the shared origin without the pairing path or fragment in the controlled browser and confirm the T3 Code app loads. This browser navigation is required even when curl succeeds because browsers block some otherwise reachable ports before making a network request.

Do not open the other person's complete pairing URL during this reachability check; doing so consumes its one-time token. If the agent also needs an authenticated browser, create and consume a separate pairing token, then leave a fresh token for the other person.

## Preserve the environment while iterating

Treat the overall testing or implementation loop—not an assistant turn or one verification pass—as the environment lifecycle boundary.

- Keep the dev process, base directory, selected ports, authenticated browser tab, registered projects, and seeded fixtures alive while the user may inspect the result or request follow-up changes.
- Use `terminal_list` and `terminal_read` to reuse this chat's T3-managed server across turns. Its lifetime is independent of Copilot completion and interruption; chat archive/deletion or T3 shutdown closes it. This is not a promise of survival across T3 restarts.
- Do not stop the server merely because one verification pass completed or because you are yielding a response to the user.
- Before starting another environment, check whether the existing process and browser tab still serve the task. Reuse them when healthy instead of discarding useful state.
- On a later turn, verify that the existing process is alive and reuse its printed ports and base directory. If it exited, restart with the same base directory; create a new pairing token only when the browser session is no longer valid.
- Tell the user when a test environment remains available, including its non-secret web URL when useful. Include a pairing token only when the user still needs to pair (see below).

## Keep test loops fast

- Batch open+navigate+snapshot with `preview_open_and_snapshot` instead of three separate calls.
- Navigate straight to the complete pairing URL as the first navigation; do not type the token into the masked pairing input.
- Reuse the warm env and tabs across turns instead of fresh `mktemp` envs; restart with the same base directory when the process exited.
- Freeze the checkout during a loop; branch switches and reinstalls invalidate Vite's optimizer cache and force a cold recompile.
- Snapshot at checkpoints only and trust void-tool `ok` results; shrink `maxScreenshotEdge` when detail is not needed.

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Keep pairing URLs out of screenshots, committed files, and durable logs. When the user asked for a shared environment, the deliverable IS the full pairing URL — paste it in your reply, token and all; a bare origin is useless to them. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it, so never open a URL you handed to the user.

## Recover a consumed or expired pairing token

Run `node apps/server/src/bin.ts pair --base-dir <absolute-base-dir>` from the repository root, using the identical directory passed to `--home-dir` (or the resolved `baseDir=` from the `[dev-runner]` line when `--home-dir` was omitted). It discovers the running server in that directory and prints a fresh pairing URL. If a remote user needs access, prefer `pnpm dev --share` (publishes the single-origin web port on the tailnet; backend needs no separate mapping because Vite proxies it) over an ad hoc reverse proxy; without `--share`, use an existing network or reverse-proxy setup.

Tokens from `pair` carry standard client scopes. The startup pairing URL carries admin scopes; if the user needs Settings → Connections management (`access:write`), restart the server and hand over the new startup URL instead.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before inspecting the database.

- Prefer the guarded helper `apps/server/scripts/t3-sqlite-state.ts` for read-only schema discovery on an isolated base directory (readonly connection; `exec` refuses the shared `~/.t3` / `~/.t3-dev` homes). Fall back to the documented `sqlite3 -readonly` commands only when the helper is unusable.
- Do not write SQLite fixtures directly from this skill. Use application commands and APIs for behavior tests; if a disposable projection fixture is essential, stop the server and use `t3-sqlite-state.ts exec` (takes a `VACUUM INTO` backup, 0600, automatically) after confirming the exact schema — isolated fixture databases only, never the shared homes.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

## Tear down only when the testing loop is finished

Tear down when the user explicitly asks, confirms the iteration is finished, or the overall task is genuinely complete with no pending human review. Do not infer completion from the end of an assistant turn.

When teardown is appropriate:

1. Stop the exact managed terminal with `terminal_stop({terminalId})`. For a legacy provider-attached server, use its original shell stop/interrupt tool instead. Do not stop another chat's server or unrelated processes.
2. If the server was started with an isolated `--home-dir`, also reap it with `pnpm dev:stop --home-dir <absolute-base-dir>` from the repository root (refuses pidfiles that do not belong to a dev server, and clears stale ones). Stale isolated servers otherwise linger and shift ports for later runs.
3. Preserve the isolated base directory when it contains useful reproduction evidence or state for a likely follow-up.
4. Otherwise remove only a path created for this test after resolving and verifying the exact target.

If completion is uncertain, keep the environment alive and mention that it is retained for further iteration. A fresh isolated base directory remains the safest reset when authentication, migrations, or fixture state becomes ambiguous.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- The pairing input accepts a raw token or a complete same-origin pairing URL. Use the "Pairing token" label, not a textbox role (the input is masked). Never paste a token for another environment. Clear failed credentials before capturing evidence.
- If the pairing URL is no longer visible, rerun `pair --base-dir <absolute-base-dir>`; do not pass `--dev-url` or `--base-url` to `pair`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If seeded data is missing or unexpected, verify the resolved database path and application flavor used by both the seed command and running server, not merely the supplied home directory or ports. Follow [database selection](references/sqlite-fixtures.md#select-the-correct-database), then confirm a known seeded entity through the target server's API before browser interaction. Do not mutate shared state or copy a live database to repair a mismatch.
- If the backend and Vite are started separately, run `dev:server` and `dev:web` with the same
  `T3CODE_DEV_INSTANCE` (or explicit port offset) and keep the browser on the Vite origin.
  The runner must provide `VITE_DEV_SERVER_URL` for that origin plus `VITE_HTTP_URL` and
  `VITE_WS_URL` for the backend. Credentialed `/api` requests then use Vite's same-origin
  proxy; if `/api/auth/session` targets the backend URL directly and fails CORS, inspect this
  environment wiring instead of loosening CORS or disabling credentials.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
