# Thread feed parity

## User-visible behavior

The native feed follows the React Native presentation contract:

- Messages and work activity appear in chronological order.
- Started/progress noise and duplicate tool lifecycle rows are removed.
- Adjacent work is compact by default, with an explicit control to reveal the remaining rows.
- A settled turn collapses its commentary and tools into a `Worked for …` row while its final assistant response stays visible.
- Active turns remain expanded. Interrupted turns use `You stopped after …` and open automatically so the stopping point is visible.
- Work rows expose status, preview, expanded payload, and copy actions.
- Assistant text supports CommonMark plus tables, strikethrough, and task lists.

## Catch-up and cache

A cached thread remains visible while reconnecting. A fresh server snapshot is published immediately, replay events are reduced in memory, and the converged state is published and persisted once at the synchronization marker. Live events still render immediately, but an active turn is not repeatedly serialized to SQLite.

Thread snapshot schema 4 intentionally ignores older thread-detail snapshots once. Each thread rebuilds from its server source of truth when next opened, then resumes normal settled-snapshot caching. This does not clear environments, credentials, drafts, attachments, or queued messages.

The subscription still requests the latest 50 turns. Pagination is deliberately unchanged: the catch-up hot path is fixed without removing older history, and a smaller initial window should be added only if device measurements show a remaining material delay.

## Verification

Focused JVM coverage pins chronological ordering, settled and active turn presentation, work lifecycle filtering, replay batching, activity sequence parsing, and live turn lifecycle state. The APK build is the compile-time gate for the Compose and Markwon integration.

Manual S25 acceptance:

1. Open a long cached thread and confirm existing content appears immediately while synchronization finishes.
2. Start a turn with commentary and tools; confirm new entries appear live in order.
3. Let the turn finish; confirm commentary/tools collapse and the final response remains visible.
4. Expand and collapse the `Worked for …` row, expand compact work, and copy one work payload.
5. Interrupt a turn; confirm `You stopped after …` appears and its work stays expanded.
6. Reopen the thread; confirm it loads from the rebuilt cache without losing history.
7. Render headings, lists, fenced and inline code, a table, strikethrough, and task-list Markdown.
