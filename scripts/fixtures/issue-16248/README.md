# Minimap rendering fixture

Start an empty isolated home once to migrate it, with project bootstrap disabled:

```sh
vp run dev --home-dir /tmp/minimap-proof --auto-bootstrap-project-from-cwd=false
```

Stop that server, then seed:

```sh
python3 scripts/fixtures/issue-16248/seed.py /tmp/minimap-proof --workspace /tmp/minimap-workspace
python3 scripts/fixtures/issue-16248/seed.py /tmp/minimap-proof --workspace /tmp/minimap-workspace --counts 1 --assistant-only
python3 scripts/fixtures/issue-16248/seed.py /tmp/minimap-proof --workspace /tmp/minimap-workspace --counts 600 --history
```

Restart normally and use its startup pairing URL. Read `userdata/environment-id`;
open `/<environment-id>/minimap-proof-600`. Other count routes use the same prefix.
The assistant-only route ends in `-1-assistant`; the paged route ends in
`-600-history`. Fixture records contain literal synthetic prose, deterministic
IDs and UTC timestamps, no provider sessions, and no executable pending work.
The workspace is an explicit local destination, never copied from a template.

`data.json` holds the literal synthetic text, timestamps, and matrix counts.

Default counts are 0, 1, 2, 75, 129, 130, 600: seven threads, six completed runs,
six completed nodes, 1560 messages and 2497 turn items. The assistant-only command
adds one thread/run/node and one command item (zero user rows). The history command
adds one thread, 600 completed runs/nodes, 1000 messages and 1600 turn items.
The main dense thread puts all items in one completed run to avoid initial history
paging. The history variant deliberately pages. At a measured 512px rail, HEAD
renders 0/0/2/75/129/129/129 marks; base renders one mark per user item above 1.

With the server stopped, `--counts 600 --generation b` replaces IDs at the same
count; `--append 1` adds an item; returning to defaults restores the initial data.
Only the named fixture threads are reset. Repeated invocations are idempotent.
These are projection-only rendering records, not a coherent event history: do
not use them to claim orchestration mutations work. The script refuses live home,
a running server, or a nonempty first-use database. Never copy its database into
live state.

The snapshot transport also bounds items inside a run. After opening the dense
route, click **Load earlier turns** until absent (30 clicks for this dataset at
the current page size). Confirm 129 marks and a 512px measured rail at 800px
viewport height. Repeat this on both revisions; do not equate fixture database
count with the number already loaded by the client.
