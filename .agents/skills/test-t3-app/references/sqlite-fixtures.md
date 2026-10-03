# SQLite fixtures

Load this reference only when inspecting or seeding local T3 state directly.

## Select the correct database

When `--base-dir` or `--home-dir` is explicit, runtime state lives under `<base-dir>/userdata` and the database path is `<base-dir>/userdata/statev2.sqlite`. The `<base-dir>/dev` state directory is only the fallback for an implicit development home, preventing an ordinary `vp run dev` from touching production state.

The server copies the V1 `state.sqlite` into `statev2.sqlite` only when `statev2.sqlite` is missing. After the first start, edits to `state.sqlite` change nothing.

Start the target runtime once before seeding so all migrations have run. Use an isolated base directory. Stop the server before writes to avoid racing application state or an active projection.

## Use the helper

List tables:

```bash
node apps/server/scripts/t3-sqlite-state.ts query \
  --base-dir <base-dir> \
  --sql "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
```

Inspect current columns before writing a fixture:

```bash
node apps/server/scripts/t3-sqlite-state.ts query \
  --base-dir <base-dir> \
  --sql "PRAGMA table_info(orchestration_v2_projection_threads)"
```

Apply a SQL fixture from a file:

```bash
node apps/server/scripts/t3-sqlite-state.ts exec \
  --base-dir <base-dir> \
  --file /tmp/t3-seed.sql
```

Use one statement per invocation for both `query` and `exec`; the helper wraps writes in a transaction and prints the backup path after a successful mutation. Use a single insert with multiple value rows when a fixture needs several records.

## Seed projection data carefully

Clients read projects from `projection_projects` and everything else from the `orchestration_v2_projection_*` tables: threads, runs, messages, turn items, runtime requests, plans, and provider sessions. The older `projection_thread*` tables hold V1 history, which the server imports once per thread at startup; later edits there do not reach the UI.

Most V2 rows carry a `payload_json` that must decode against the schemas in `packages/contracts/src/orchestrationV2.ts`. The safest start is a row the app wrote itself: create a thread through the UI, copy its rows, and edit them. Keep identifiers unique, timestamps as ISO strings, and related project, thread, and run IDs consistent.

Direct projection writes are appropriate for ephemeral visual states, edge-case counts, long titles, long timelines, and similar UI fixtures. They do not create a coherent event history. Leave `orchestration_v2_events` unchanged, and do not use direct projection writes to claim backend business behavior works.

Use the app's commands or APIs for behavior tests. Use `node apps/server/src/bin.ts auth ...` for auth state rather than editing `auth_pairing_links` or `auth_sessions`.
