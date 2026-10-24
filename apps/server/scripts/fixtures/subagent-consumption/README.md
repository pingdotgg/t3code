# Subagent consumption visual fixtures

These synthetic projection rows exercise the timeline, notification and lineage
callers of the subagent tooltip. They do not exercise terminal attribution or
create a coherent event history. They never start a provider or scheduled task.

Start a development server once against an isolated T3 home to initialize its
schema, then stop that server before seeding:

```sh
python3 apps/server/scripts/fixtures/subagent-consumption/seed.py \
  --home-dir /absolute/path/to/isolated/.t3 --server-stopped \
  --with-synthetic-catalog
```

The command backs up the database and replaces only its named synthetic project,
threads, runs, messages, subagents and turn items. It leaves the event log and
authentication tables unchanged. Never run it against the installed T3 home.
The fixture requires Python 3 with its standard SQLite module.

Restart the isolated server and open `/<environmentId>/visual-15429-V01` through
`visual-15429-V16`. Expand `Worked for 10s` for timeline cases. For V02, V08,
V12 and V15, use Thread details → Lineage → Previous agents. V03 is a completion
notification. V13 is an ephemeral active projection with no provider behind it;
V16 intentionally has a turn item without a matching subagent projection.

Capture in en-US with a fixed browser clock of 2026-10-21T09:01:00Z, fonts ready,
100% zoom, at 1440×900 and 390×844, in both light and dark appearances. The same
fixture script can be run externally against the pinned baseline checkout.
The optional `--with-synthetic-catalog` flag adds two disabled synthetic Codex
instances to the isolated settings file, with a custom long model and explicit
effort/speed descriptors for V08. It backs up that settings file first. These
instances cannot start a provider; the fixture changes no credentials, auth,
permissions, approvals, runtime modes or sandbox settings. Restore the isolated
settings backup after capture if those catalog entries are no longer wanted.
V02 includes eight synthetic neighboring child shells to exercise pagination
and scroll in the Previous agents list.

Projection-only SQL does not advance the event cursor. When reusing a Browser
profile across revisions, leave the fixture route, discard only cached `thread`
entries whose key contains `visual-15429-` from the `t3code:connection-runtime`
IndexedDB database, then reload the fixture route. Otherwise a warm client can
retain a baseline snapshot at the same cursor. Do not clear the catalog, auth,
server configuration or unrelated thread caches.
