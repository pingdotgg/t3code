# Thread feed parity

## User-visible behavior

The native feed follows the React Native presentation contract:

- Messages and work activity appear in chronological order.
- Started/progress noise and duplicate tool lifecycle rows are removed.
- Adjacent work is compact by default, with an explicit control to reveal the remaining rows.
- A settled turn collapses its commentary and tools into a `Worked for …` row while its final assistant response stays visible.
- Active turns remain expanded. Interrupted turns use `You stopped after …` and open automatically so the stopping point is visible.
- Work rows expose semantic icons, status, previews, structured command output, changed-file lists, focused MCP details, and copy actions without dumping transport-envelope JSON.
- `update_plan` progress renders as one compact inline plan per turn instead of a generic JSON work row. The latest snapshot replaces earlier updates while the row stays anchored where planning began. The newest plan remains visible beside its final response; older plans stay available inside their turns' expanded work folds.
- Plan segments and expanded steps are status-coded: completed is green, in-progress uses the primary accent, and pending is muted. The running step also appears beside the working indicator.
- Assistant text uses native Compose Markdown with tables, strikethrough, task lists, selectable text, links, and copyable code blocks.

## Catch-up and cache

A cached thread remains visible while reconnecting. A fresh server snapshot is published immediately, replay events are reduced in memory, and the converged state is published and persisted once at the synchronization marker. Live events still render immediately, but an active turn is not repeatedly serialized to SQLite.

Thread snapshot schema 4 intentionally ignores older thread-detail snapshots once. Each thread rebuilds from its server source of truth when next opened, then resumes normal settled-snapshot caching. This does not clear environments, credentials, drafts, attachments, or queued messages.

The subscription still requests the latest 50 turns. Pagination is deliberately unchanged: the catch-up hot path is fixed without removing older history, and a smaller initial window should be added only if device measurements show a remaining material delay.

## Deferred performance investigation

An S25 trace of the newly installed debug APK found 310–331 ms UI frames while live updates rebuilt the thread feed. CPU sampling attributed most of that work to deriving historical activities, sorting the combined feed, repeatedly parsing timestamps, and compiling per-activity regular expressions. The same sample also contained substantial interpreter and JIT activity, so it is not evidence that the release build has a user-visible performance problem.

Before changing feed behavior, measure the same long thread with a release build. If a material stall remains, keep the presentation contract unchanged and consider only these internal optimizations:

1. Memoize message and activity-derived feed sections separately so a message update does not reprocess unchanged tool history.
2. Parse each feed timestamp once per sort instead of once per comparator call.
3. Reuse compiled regular expressions used by activity presentation.
4. Reuse unchanged row objects, following the web timeline's structural-sharing approach.

Do not change live-update cadence, ordering, folding, scrolling, Markdown presentation, or the working animation as part of this investigation without a separate product decision.

## Verification

Focused JVM coverage pins chronological ordering, settled and active turn presentation, work lifecycle filtering, replay batching, activity sequence parsing, live turn lifecycle state, and Markdown streaming fallback. The APK build is the compile-time gate for the Compose Markdown integration.

Manual S25 acceptance:

1. Open a long cached thread and confirm existing content appears immediately while synchronization finishes.
2. Start a turn with commentary and tools; confirm new entries appear live in order.
3. Let the turn finish; confirm commentary/tools collapse and the final response remains visible.
4. Expand and collapse the `Worked for …` row, expand compact work, and copy one work payload.
5. Interrupt a turn; confirm `You stopped after …` appears and its work stays expanded.
6. Reopen the thread; confirm it loads from the rebuilt cache without losing history.
7. Render headings, lists, fenced and inline code, a table, strikethrough, and task-list Markdown.
8. Run or open a turn with `update_plan`; confirm the compact progress row expands to a colored checklist and never exposes raw JSON.
