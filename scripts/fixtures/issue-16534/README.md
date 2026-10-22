These fixtures reconstruct synthetic sidebar projections and client reset inputs.
They never start a provider or read personal application data. Projection-only
fixtures prove rendering/navigation, not event-sourced backend behavior.

Generate with `python3 scripts/fixtures/issue-16534/seed.py --output /tmp/sidebar-seed
--variant all`. Stop the isolated server before applying reset-threads.sql,
archive-unrelated-threads.sql, hide-v1-threads.sql, hide-unrelated-projects.sql,
projects.sql, threads.sql, messages.sql, turn-items.sql, transcript-runs.sql,
transcript-messages.sql and transcript-turn-items.sql, in that order, with the documented
`t3-sqlite-state.ts exec` helper, once per file. Never target the live T3 home.

`all` includes two eight-thread projects, forty spacers, child/grandchild/fork
lineage and synthetic markdown navigation messages. Other variants isolate shelf,
archive and lineage states. `fixture.json` records deterministic clock/settings.
The replay option records stopped synthetic shell representations for working,
status and delayed arrival without spawning providers. `replay.js` transforms
only real shell frames before the real RPC decoder/reducer receives them; delayed
shell frames are released explicitly through `__sidebarReplay.release()`.

Install bootstrap.js and replay.js as identical pre-module scripts in the served
HTML only for capture. Remove both before committing or switching checkouts.
Use a fresh navigation, never document.write over an evaluated module graph.
Configure `sessionStorage['sidebar-capture-config']` with `{storage, replay}`.
Clear only projection caches (shell/thread/vcs-refs in t3code:connection-runtime)
from a same-origin inert document before navigating to the app. Preserve auth.
Timers and performance.now remain native; only Date is frozen. Record the exact
injection externally with the artifacts.

For grouping, initialize the three synthetic /tmp/triage-16534-{A,B,Spacer}
paths as git repositories with the same synthetic origin, then use repository
grouping and an explicit separate override for Spacer. No network fetch needed.
All navigation links are synthetic t3-thread links rendered by the real client.
