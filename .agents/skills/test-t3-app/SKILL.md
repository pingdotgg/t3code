---
name: test-t3-app
description: Launch and test the T3 Code web app in isolated development environments, including reusable worktree-scoped dev authentication, real pairing-token recovery, worktree-safe state directories, dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run T3 locally, test UI behavior in a browser, exercise real pairing behavior, isolate dev state, or prepare test data in state.sqlite.
---

# Test T3 App

Use this skill for the web client. For iOS Simulator, Android Emulator, or physical-device testing against an isolated T3 backend, use the sibling [`test-t3-mobile`](../test-t3-mobile/SKILL.md) skill.

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.t3` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/t3code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `vp run dev --home-dir <base-dir>`.
4. Keep the terminal session alive and read the selected server port, web port, base directory, and explicitly labeled `reusable web pairing URL` from the dev-runner output.

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.t3` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The dev runner disables browser auto-open by default. Do not pass `--browser` during automated testing so the controlled browser remains the only client surface.

## Authenticate the browser

1. Wait for the dev runner's explicitly labeled `reusable web pairing URL`. The server also prints a real one-time pairing URL during startup; do not confuse the two.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open the complete reusable URL as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

The reusable development credential is deterministically derived from the canonical worktree path and is intentionally limited to loopback servers. It may be opened repeatedly by browsers testing the same running worktree. Do not mistake it for a production secret or configure it on a remotely reachable server.

## Exercise real pairing or recover a one-time token

When the behavior under test is pairing itself, create a real one-time token against the same database and web URL as the running dev server:

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

Real pairing URLs remain secret, short-lived, and single-use. Do not copy them into final responses, screenshots, committed files, or durable logs.

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

- If the reusable dev URL is rejected, confirm the runner and server use the same worktree and that the backend is loopback-only.
- If a real one-time URL was consumed, issue a new token instead of retrying it.
- If the pairing URL is no longer visible, create a replacement token with both `--dev-url` and `--base-url`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If the UI shows unexpected data, verify that every command uses the identical explicit base directory before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
