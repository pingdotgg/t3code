---
name: test-t3-app
description: Launch and test the T3 Code web app in isolated development environments, including first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run T3 locally, test UI behavior in a browser, recover from an expired or consumed pairing token, isolate dev state, or prepare test data in state.sqlite.
---

# Test T3 App

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.t3` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/t3code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `vp run dev --home-dir <base-dir>`.
4. Keep the terminal session alive and read the selected server port, web port, base directory, and pairing URL from its output.

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.t3` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The dev runner disables browser auto-open by default. Do not pass `--browser` during automated testing: an automatically opened page can consume the one-time bootstrap token before the controlled browser uses it.

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Treat pairing URLs as secrets. Do not copy them into final responses, screenshots, committed files, or durable logs. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it.

## Recover a consumed or expired pairing token

Create another token against the same database and web URL as the running dev server:

```bash
T3CODE_PORT=<server-port> node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> \
  --dev-url <web-url> \
  --base-url <web-url> \
  --ttl 15m \
  --label agent-ui-test
```

Use the `Pair URL` from this command once. Derive `<server-port>` and `<web-url>` from the current dev-runner output, including any automatically selected port offset. Setting `T3CODE_PORT` keeps the administrative CLI from probing for an unrelated free port.

Always pass `--dev-url` for a dev-runner environment so the generated pairing URL uses the current web origin. An explicit base directory stores runtime state in `<base-dir>/userdata`; the `<base-dir>/dev` fallback is only used by an implicit dev home. Use `auth pairing list` to inspect active token metadata; it intentionally cannot reveal token secrets.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/t3-sqlite-state.ts query` for schema discovery and read-only checks.
- Stop the dev server before using `node apps/server/scripts/t3-sqlite-state.ts exec`, then restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when testing business behavior or projection correctness.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

The helper refuses to write to the shared `~/.t3` directory by default and creates a database backup before each mutation.

## Finish the test

Stop the dev process with its terminal interrupt. Preserve the isolated base directory when it contains useful reproduction evidence; otherwise remove only a path that was created for this test after resolving and verifying the exact target. A fresh isolated base directory is the safest reset when authentication, migrations, or fixture state becomes ambiguous.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- If the pairing URL is no longer visible, create a replacement token with both `--dev-url` and `--base-url`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If the UI shows unexpected data, verify that every command uses the identical explicit base directory before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
