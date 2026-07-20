# Conversation Data Savings

Archived conversations use cold storage instead of retaining full hot projections and diagnostics in `state.sqlite`.

- `state.sqlite` keeps only the lightweight archived thread shell needed by the Archive page. Conversation events, messages, activities, turns, checkpoints, plans, session/runtime rows, and content attachments are written as bounded gzip-compressed chunks in the separate `archive.sqlite` database, then removed from hot storage.
- `apps/server/scripts/t3-sqlite-state.ts` is the supported isolated-database inspection path. It targets hot `state.sqlite` by default and accepts `--database archive` for cold manifest and chunk queries, with both paths derived from the shared server configuration. Archive and restore behavior should use application commands rather than direct archive-bundle writes.
- Content attachments are part of the archive bundle and return on unarchive. Attachment collection follows exact ids persisted in thread messages, while retry cleanup may reuse exact attachment chunk filenames already recorded in the cold bundle; normalized thread-name collisions cannot claim another thread's files. Provider diagnostic logs and terminal history logs are deliberately destructive on archive: they are deleted, never copied into the bundle, and never restored. Provider-log cleanup matches only the exact thread log and its numeric rotations so similarly prefixed thread ids are not affected.
- Cold restore preserves binary SQL values, validates attachment entry names, and atomically replaces attachment files before marking SQL rows restored. It keeps compressed chunks authoritative on failure, pages chunk reads to bound memory, rejects unknown tables/chunk kinds, and intersects archived row columns with the current schema so older bundles remain recoverable after compatible migrations.
- Permanent thread deletion removes the shell, event stream, command receipts, every thread-owned projection/runtime/checkpoint row, attachments, terminal history, provider logs and rotations, and any cold-archive manifest/chunks. Exact attachment ownership metadata remains available until external attachment and provider-log cleanup succeeds, after which the SQL and cold-chunk rows are removed; cross-thread plan references are cleared rather than leaving dangling ids, and the durable cleanup-queue entry is retained until filesystem cleanup and free-page reclamation succeed so interrupted deletes retry safely.
- Forced project removal emits the same per-thread deletion events for archived shells, so already-cold threads pass through the durable lifecycle worker and lose their hot shell, archive manifest, and compressed chunks before cleanup completes. `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts` covers the forced-project decider, lifecycle reactor, and cold-storage boundary together.
- Archive/delete filesystem work runs through a durable background lifecycle queue so command acknowledgement and the UI are not blocked by compression or large cleanup operations. Archive and restore lifecycle work is serialized per project tree, with reference-counted idle-lock eviction after the final user or waiter. Archive creation uses a retry-safe two-phase boundary: compressed chunks and hot-row deletion commit before the manifest enters `cleanup_pending`, and destructive attachment/log cleanup must finish before it becomes `cold`. Destructive archive transitions recheck the archived shell inside the transaction, require provider/terminal/log-writer shutdown to succeed, and keep retry state for filesystem failures other than a genuinely missing directory. Incomplete cleanup, including a `cleanup_pending` manifest whose archived shell has already been removed, and archived shells missing a manifest resume after restart without rebuilding an already durable bundle.
- Unarchive restores `cold`, `restored`, or `cleanup_pending` bundles before dispatching the domain command. A rejected or failed command re-archives the restored rows and files, while a successful command finalizes the cold bundle only when that request actually performed a restore; this prevents unrelated or already-hot unarchive commands from deleting archive data. Once SQL restoration commits, later publication or metrics failures cannot re-archive the restored data.
- Unarchive reserves still-hot archived rows with a `restored` manifest before releasing the archive-tree lock. This prevents queued lifecycle work from moving those rows cold between the restore check and the unarchive command commit; command failure archives the reserved rows, while success removes the reservation. If storage cannot restore or reserve the archived conversation, the command is rejected before an active-shell event can commit.
- Migration `035_ThreadColdArchive` registers existing archived conversations for background conversion on the next update. Migration `036_DeletedThreadCleanupQueue` registers legacy soft-deleted conversations for the same permanent cleanup used by new deletes.
- After the legacy queues drain, a retryable one-time `VACUUM` physically compacts `state.sqlite` and enables incremental auto-vacuum. Later lifecycle operations reclaim bounded free-page batches from both `state.sqlite` and `archive.sqlite`, avoiding a full compaction on every archive.
- Normal provider, server, trace, and terminal logging behavior is unchanged. Space is reclaimed at the conversation lifecycle boundary instead of by weakening diagnostics for active work.

Primary files:

- `apps/server/src/orchestration/Layers/ThreadColdStorage.ts`
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts`
- `apps/server/src/persistence/Migrations/035_ThreadColdArchive.ts`
- `apps/server/src/persistence/Migrations/036_DeletedThreadCleanupQueue.ts`
- `apps/server/scripts/t3-sqlite-state.ts`

## Sidebar And Shell Consistency

Sidebar archive visibility is centralized across persisted and optimistic archive states. Project rows, project status, sorting, keyboard navigation, and prewarming exclude an optimistically archived conversation immediately, so durable cold-storage work cannot leave a stale row or keyboard target visible while the server shell catches up.

Authoritative shell synchronization is shared runtime behavior in `packages/client-runtime/src/state/shell.ts`, `packages/client-runtime/src/rpc/client.ts`, and `apps/server/src/ws.ts`, rather than a branch-specific subscription implementation. HTTP snapshots provide an early shell, while completion-capable WebSocket sessions revalidate it with a socket-owned snapshot after live buffering begins; the same refresh runs when the app returns to the foreground. Cold archive storage relies on this contract because compacted per-thread history cannot prove that cached projects and threads still exist.

`apps/server/src/server.test.ts` verifies that HTTP-seeded shell subscriptions preserve archive removals published while WebSocket catch-up reads persisted events, then emit the synchronization completion marker. Initial-snapshot event replay in `apps/server/src/ws.ts` and deferred active-thread cache writes in `packages/client-runtime/src/state/threads.ts` remain complementary to authoritative shell refresh.

Mobile Archive rows omit invalid lifecycle timestamps instead of presenting corrupt or legacy values as newly archived. General mobile time rendering is unchanged.

## Development Ports

- Web: `5736`
- Server/WebSocket: `13776`
