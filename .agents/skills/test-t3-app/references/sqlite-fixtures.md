# SQLite fixtures

Load this reference only when inspecting local T3 state directly.

## Select the correct database

The server derives its state directory from the base directory and whether a dev URL is set. The normal `pnpm dev` path uses `<base-dir>/dev/state.sqlite`; a server started without a dev URL uses `<base-dir>/userdata/state.sqlite`. Read the `[dev-runner]` line and server startup output instead of guessing. Always use an isolated base directory.

Start the target runtime once before inspection so all migrations have run. Use an isolated base directory. Do not write a live database.

## Read-only inspection

Prefer the guarded helper `apps/server/scripts/t3-sqlite-state.ts`, which runs
queries on a readonly connection and refuses `exec` against the shared homes
(`~/.t3`, `~/.t3-dev`):

```bash
node apps/server/scripts/t3-sqlite-state.ts query --base-dir <isolated-base-dir> \
  --sql "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;"
```

If the helper is unavailable and `sqlite3` is installed, use it only for read-only inspection:

```bash
sqlite3 -readonly <base-dir>/dev/state.sqlite \
  "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;"
```

Inspect current columns before considering a disposable fixture:

```bash
sqlite3 -readonly <base-dir>/dev/state.sqlite \
  "PRAGMA table_info(projection_threads);"
```

Do not assume `dev` is the right directory. Replace it with `userdata` when the server was started without a dev URL. If `sqlite3` is unavailable, use the app's CLI and APIs instead of adding an ad hoc database dependency.

## Seed projection data carefully

The web UI primarily reads these projection tables:

- `projection_projects`
- `projection_threads`
- `projection_thread_messages`
- `projection_thread_activities`
- `projection_thread_sessions`
- `projection_turns`
- `projection_pending_approvals`
- `projection_thread_proposed_plans`

Inspect `PRAGMA table_info(<table>)` and the current migrations under `apps/server/src/persistence/Migrations/` before constructing inserts. Keep identifiers unique, timestamps as ISO strings, JSON columns valid, and related project/thread/turn IDs consistent.

No mobile showcase fixture script is installed in this checkout. Derive any separately reviewed fixture from the target database schema and current migrations, not an unavailable example. Stop the server before mutation; `t3-sqlite-state.ts exec` takes a `VACUUM INTO` backup (0600) automatically, but prefer it only for isolated fixture databases, never the shared homes.

Direct projection writes may be appropriate for ephemeral visual states, edge-case counts, long titles, activity lists, and similar UI fixtures via the guarded `t3-sqlite-state.ts exec` helper on an isolated database. They do not create a coherent orchestration event history. Do not modify `orchestration_events` unless the test specifically exercises projector internals, and do not use direct projection writes to claim backend business behavior works.

Use the app's commands or APIs for behavior tests. Use `node apps/server/src/bin.ts auth ...` for auth state rather than editing `auth_pairing_links` or `auth_sessions`.
