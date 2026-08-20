import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadColdStorage from "./ThreadColdStorage.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const insertArchivedThread = Effect.fn("insertArchivedThreadTestFixture")(function* (
  threadId: ThreadId,
  title: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at, archived_at
    ) VALUES (
      ${threadId}, 'project-1', ${title},
      '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
      'full-access', 'default', '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'
    )
  `;
});

const layer = it.layer(
  ThreadColdStorage.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cold-storage-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ThreadColdStorage", (it) => {
  it.effect("waits for pending archive and delete work before legacy compaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const archiveThreadId = ThreadId.make("thread-compact-pending-archive");
      const deleteThreadId = ThreadId.make("thread-compact-pending-delete");

      yield* insertArchivedThread(archiveThreadId, "Pending archive before compaction");
      yield* insertArchivedThread(deleteThreadId, "Pending delete before compaction");
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-07-03T00:00:00.000Z'
        WHERE thread_id = ${deleteThreadId}
      `;

      yield* storage.compactLegacyStorage;
      const deferredMaintenance = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_storage_maintenance
        WHERE task = 'compact-legacy-thread-storage'
      `;
      assert.deepStrictEqual(deferredMaintenance, [{ status: "pending" }]);

      yield* storage.archiveThread(archiveThreadId);
      yield* storage.deleteThread(deleteThreadId);
      yield* storage.compactLegacyStorage;
      const completedMaintenance = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_storage_maintenance
        WHERE task = 'compact-legacy-thread-storage'
      `;
      assert.deepStrictEqual(completedMaintenance, [{ status: "complete" }]);
    }),
  );

  it.effect("normalizes typed quiesce failures at the archive boundary", () =>
    Effect.gen(function* () {
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-quiesce-failure");
      const quiesceFailure = { _tag: "QuiesceFailure" } as const;

      yield* insertArchivedThread(threadId, "Quiesce failure thread");

      const archiveFailure = yield* Effect.flip(
        storage.archiveThread(threadId, Effect.fail(quiesceFailure)),
      );

      assert.strictEqual(archiveFailure.operation, "archive");
      assert.strictEqual(archiveFailure.threadId, threadId);
      assert.strictEqual(archiveFailure.cause, quiesceFailure);

      const normalizedFailure = new ThreadColdStorage.ThreadColdStorageError({
        operation: "archive",
        threadId,
        cause: quiesceFailure,
      });
      const repeatedFailure = yield* Effect.flip(
        storage.archiveThread(threadId, Effect.fail(normalizedFailure)),
      );
      assert.strictEqual(repeatedFailure, normalizedFailure);

      const differentlyAttributedFailure = new ThreadColdStorage.ThreadColdStorageError({
        operation: "restore",
        threadId,
        cause: quiesceFailure,
      });
      const attributedFailure = yield* Effect.flip(
        storage.archiveThread(threadId, Effect.fail(differentlyAttributedFailure)),
      );
      assert.strictEqual(attributedFailure.operation, "archive");
      assert.strictEqual(attributedFailure.threadId, threadId);
      assert.strictEqual(attributedFailure.cause, differentlyAttributedFailure);
    }),
  );

  it.effect("archives post-quiescence state while a running thread awaits user input", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-running-pending-user-input");

      yield* insertArchivedThread(threadId, "Running thread awaiting user input");
      yield* sql`
        UPDATE projection_threads
        SET pending_user_input_count = 1
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id,
          provider_thread_id, active_turn_id, last_error, updated_at,
          runtime_mode, provider_instance_id
        ) VALUES (
          ${threadId}, 'running', 'codex', 'session-pending-user-input',
          'provider-thread-pending-user-input', 'turn-pending-user-input', NULL,
          '2026-07-02T00:00:00.000Z', 'full-access', 'codex'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, created_at, sequence
        ) VALUES (
          'activity-user-input-requested', ${threadId}, 'turn-pending-user-input',
          'info', 'user-input.requested', 'Waiting for user input',
          '{"requestId":"request-pending-user-input"}',
          '2026-07-02T00:00:00.000Z', 1
        )
      `;

      yield* storage.archiveThread(
        threadId,
        Effect.gen(function* () {
          yield* sql`
            UPDATE projection_thread_sessions
            SET status = 'stopped', active_turn_id = NULL,
                updated_at = '2026-07-02T00:01:00.000Z'
            WHERE thread_id = ${threadId}
          `;
          yield* sql`
            UPDATE projection_threads
            SET pending_user_input_count = 0
            WHERE thread_id = ${threadId}
          `;
          yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary,
              payload_json, created_at, sequence
            ) VALUES (
              'activity-user-input-resolved', ${threadId}, 'turn-pending-user-input',
              'info', 'user-input.resolved', 'User input request interrupted',
              '{"requestId":"request-pending-user-input"}',
              '2026-07-02T00:01:00.000Z', 2
            )
          `;
        }),
      );

      const coldActivities = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `;
      const coldSessions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      const postArchiveShells = yield* sql<{ readonly pendingUserInputCount: number }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(coldActivities, [{ count: 0 }]);
      assert.deepStrictEqual(coldSessions, [{ count: 0 }]);
      // The lightweight shell deliberately stays hot while child projections
      // move cold, so verify its post-quiescence value before any restore.
      assert.deepStrictEqual(postArchiveShells, [{ pendingUserInputCount: 0 }]);

      assert.isTrue(yield* storage.restoreTree(threadId));
      const restoredActivities = yield* sql<{
        readonly kind: string;
        readonly payloadJson: string;
        readonly createdAt: string;
        readonly sequence: number;
      }>`
        SELECT kind, payload_json AS "payloadJson", created_at AS "createdAt", sequence
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC
      `;
      const restoredSessions = yield* sql<{
        readonly status: string;
        readonly activeTurnId: string | null;
        readonly updatedAt: string;
      }>`
        SELECT status, active_turn_id AS "activeTurnId", updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(restoredActivities, [
        {
          kind: "user-input.requested",
          payloadJson: '{"requestId":"request-pending-user-input"}',
          createdAt: "2026-07-02T00:00:00.000Z",
          sequence: 1,
        },
        {
          kind: "user-input.resolved",
          payloadJson: '{"requestId":"request-pending-user-input"}',
          createdAt: "2026-07-02T00:01:00.000Z",
          sequence: 2,
        },
      ]);
      assert.deepStrictEqual(restoredSessions, [
        {
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-07-02T00:01:00.000Z",
        },
      ]);
    }),
  );

  it.effect("discovers archived shells before a lifecycle manifest exists", () =>
    Effect.gen(function* () {
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-archive-queue-fallback");

      yield* insertArchivedThread(threadId, "Archive queue fallback thread");

      assert.deepInclude(yield* storage.listPendingArchiveThreadIds, threadId);
    }),
  );

  it.effect("discovers deleted shells before a cleanup queue entry exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-delete-queue-fallback");

      yield* insertArchivedThread(threadId, "Delete queue fallback thread");
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-07-03T00:00:00.000Z'
        WHERE thread_id = ${threadId}
      `;

      assert.deepInclude(yield* storage.listPendingDeleteThreadIds, threadId);
    }),
  );

  it.effect("reserves hot archived rows while an unarchive command is pending", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-unarchive-hot-reservation");

      yield* insertArchivedThread(threadId, "Pending hot unarchive");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-unarchive-hot-reservation', ${threadId}, NULL, 'user',
          'keep hot until unarchive commits', '[]', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_archive_manifests (
          thread_id, root_thread_id, status, archive_version,
          archived_at, updated_at, error
        ) VALUES (
          ${threadId}, ${threadId}, 'pending', 0,
          '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP, NULL
        )
      `;

      assert.isTrue(yield* storage.restoreTree(threadId));
      assert.deepInclude(yield* storage.listPendingArchiveThreadIds, threadId);
      let quiesceCalls = 0;
      yield* storage.archiveThread(
        threadId,
        Effect.sync(() => {
          quiesceCalls += 1;
        }),
      );

      const messages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{
        readonly rootThreadId: string;
        readonly status: string;
        readonly archiveVersion: number;
        readonly archivedAt: string;
      }>`
        SELECT
          root_thread_id AS "rootThreadId",
          status,
          archive_version AS "archiveVersion",
          archived_at AS "archivedAt"
        FROM thread_archive_manifests
        WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(quiesceCalls, 0);
      assert.deepStrictEqual(messages, [{ text: "keep hot until unarchive commits" }]);
      assert.deepStrictEqual(manifest, [
        {
          rootThreadId: threadId,
          status: "restored",
          archiveVersion: 1,
          archivedAt: "2026-07-02T00:00:00.000Z",
        },
      ]);

      yield* storage.finishRestoreTree(threadId);
      const remainingManifest = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(remainingManifest, [{ count: 0 }]);
    }),
  );

  it.effect("reports unknown archive chunk kinds with structured validation detail", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-unknown-archive-chunk-kind");

      yield* insertArchivedThread(threadId, "Unknown archive chunk kind");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-unknown-archive-chunk-kind', ${threadId}, NULL, 'user',
          'corrupt this chunk kind', '[]', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;

      yield* storage.archiveThread(threadId);
      yield* sql`
        UPDATE cold_archive.archive_thread_chunks
        SET kind = 'future:unsupported'
        WHERE thread_id = ${threadId}
      `;

      const failure = yield* Effect.flip(storage.restoreTree(threadId));
      assert.deepInclude(failure.cause, {
        _tag: "ArchiveChunkKindValidationError",
        chunkKind: "future:unsupported",
      });
    }),
  );

  it.effect("re-archives an orphaned restore reservation discovered after restart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-orphaned-restore-reservation");

      yield* insertArchivedThread(threadId, "Orphaned restore reservation");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-orphaned-restore-reservation', ${threadId}, NULL, 'user',
          'move cold during startup recovery', '[]', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_archive_manifests (
          thread_id, root_thread_id, status, archive_version,
          archived_at, updated_at, error
        ) VALUES (
          ${threadId}, ${threadId}, 'restored', 1,
          '2026-07-02T00:00:00.000Z', CURRENT_TIMESTAMP, NULL
        )
      `;

      assert.deepInclude(yield* storage.listPendingArchiveThreadIds, threadId);
      yield* storage.archiveThread(threadId);

      const messages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM thread_archive_manifests
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(messages, [{ count: 0 }]);
      assert.deepStrictEqual(manifest, [{ status: "cold" }]);
    }),
  );

  it.effect("re-archives hot rows after restored-bundle finalization fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-rearchive-stale-restored");

      yield* insertArchivedThread(threadId, "Re-archive stale restore");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-rearchive-stale-restored', ${threadId}, NULL, 'user',
          'move cold after the next archive', '[]', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;

      assert.isTrue(yield* storage.restoreTree(threadId));
      yield* sql`
        UPDATE projection_threads
        SET archived_at = NULL, updated_at = '2026-07-03T00:00:00.000Z'
        WHERE thread_id = ${threadId}
      `;
      // Simulate finishRestoreTree failing after the unarchive transaction,
      // then the user archiving the same thread again.
      yield* sql`
        UPDATE projection_threads
        SET archived_at = '2026-07-04T00:00:00.000Z',
            updated_at = '2026-07-04T00:00:00.000Z'
        WHERE thread_id = ${threadId}
      `;

      yield* storage.archiveThread(threadId);

      const messages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{
        readonly status: string;
        readonly archivedAt: string;
      }>`
        SELECT status, archived_at AS "archivedAt"
        FROM thread_archive_manifests
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(messages, [{ count: 0 }]);
      assert.deepStrictEqual(manifest, [
        { status: "cold", archivedAt: "2026-07-04T00:00:00.000Z" },
      ]);
    }),
  );

  it.effect("does not replay a restored bundle over active thread data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-stale-restored-bundle");
      const attachmentName =
        "thread-stale-restored-bundle-00000000-0000-4000-8000-000000000001.txt";
      const attachmentPath = path.join(config.attachmentsDir, attachmentName);

      yield* insertArchivedThread(threadId, "Stale restored bundle");
      yield* sql.unsafe(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (?, ?, NULL, 'user', 'cold value', ?, 0, ?, ?)`,
        [
          "message-stale-restored-bundle",
          threadId,
          encodeUnknownJsonString([
            {
              type: "text",
              id: attachmentName.slice(0, -4),
              name: "content.txt",
              mimeType: "text/plain",
            },
          ]),
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      yield* fs.writeFileString(attachmentPath, "cold attachment");

      yield* storage.archiveThread(threadId);
      assert.isTrue(yield* storage.restoreTree(threadId));

      yield* sql`
        UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${threadId}
      `;
      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'active value'
        WHERE thread_id = ${threadId}
      `;
      yield* fs.writeFileString(attachmentPath, "active attachment");

      assert.isTrue(yield* storage.restoreTree(threadId));

      const messages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(messages, [{ text: "active value" }]);
      assert.strictEqual(yield* fs.readFileString(attachmentPath), "active attachment");
    }),
  );

  it.effect("keeps command receipts hot while conversation data is cold", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-hot-command-receipt");

      yield* insertArchivedThread(threadId, "Hot command receipt");
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error
        ) VALUES (
          'command-hot-receipt', 'thread', ${threadId},
          '2026-07-02T00:00:00.000Z', 42, 'accepted', NULL
        )
      `;

      yield* storage.archiveThread(threadId);

      const hotReceipts = yield* sql<{ readonly commandId: string }>`
        SELECT command_id AS "commandId"
        FROM orchestration_command_receipts
        WHERE aggregate_id = ${threadId}
      `;
      const receiptChunks = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM cold_archive.archive_thread_chunks
        WHERE thread_id = ${threadId}
          AND kind = 'table:orchestration_command_receipts'
      `;
      assert.deepStrictEqual(hotReceipts, [{ commandId: "command-hot-receipt" }]);
      assert.deepStrictEqual(receiptChunks, [{ count: 0 }]);

      yield* storage.deleteThread(threadId);
      const deletedReceipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_command_receipts
        WHERE aggregate_id = ${threadId}
      `;
      assert.deepStrictEqual(deletedReceipts, [{ count: 0 }]);
    }),
  );

  it.effect("compresses conversation data, destroys logs, restores content, and hard-deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-cold");
      const attachmentName = "thread-cold-00000000-0000-4000-8000-000000000001.webp";

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, pinned_at
        ) VALUES (
          ${threadId}, 'project-1', 'Cold thread',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-07-01T00:00:00.000Z',
          '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
          '2026-07-01T12:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', ${threadId}, NULL, 'user', 'keep this conversation',
          '[{"type":"image","id":"thread-cold-00000000-0000-4000-8000-000000000001","name":"image.webp","mimeType":"image/webp"}]',
          0, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-1', 'thread', ${threadId}, 1, 'thread.created',
          '2026-07-01T00:00:00.000Z', 'command-1', NULL, 'command-1',
          'system', '{}', '{}'
        )
      `;

      const attachmentPath = path.join(config.attachmentsDir, attachmentName);
      const providerLogPath = path.join(config.providerLogsDir, "events.thread-cold.log");
      const rotatedProviderLogPath = `${providerLogPath}.1`;
      const similarlyPrefixedProviderLogPath = path.join(
        config.providerLogsDir,
        "events.thread-cold-extra.log",
      );
      yield* fs.writeFileString(attachmentPath, "image bytes");
      yield* fs.writeFileString(providerLogPath, "diagnostic");
      yield* fs.writeFileString(rotatedProviderLogPath, "old diagnostic");
      yield* fs.writeFileString(similarlyPrefixedProviderLogPath, "other thread diagnostic");

      yield* storage.archiveThread(threadId);

      const archivedMessageCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const archivedEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId}
      `;
      const shell = yield* sql<{ readonly pinnedAt: string | null }>`
        SELECT pinned_at AS "pinnedAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{ readonly status: string; readonly compressedBytes: number }>`
        SELECT status, compressed_bytes AS "compressedBytes"
        FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(archivedMessageCount[0]?.count, 0);
      assert.strictEqual(archivedEventCount[0]?.count, 0);
      assert.deepStrictEqual(shell, [{ pinnedAt: "2026-07-01T12:00:00.000Z" }]);
      assert.strictEqual(manifest[0]?.status, "cold");
      assert.isAbove(manifest[0]?.compressedBytes ?? 0, 0);
      assert.isFalse(yield* fs.exists(attachmentPath));
      assert.isFalse(yield* fs.exists(providerLogPath));
      assert.isFalse(yield* fs.exists(rotatedProviderLogPath));
      assert.isTrue(yield* fs.exists(similarlyPrefixedProviderLogPath));

      assert.isTrue(yield* storage.restoreTree(threadId));
      const restoredMessages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const restoredShell = yield* sql<{ readonly pinnedAt: string | null }>`
        SELECT pinned_at AS "pinnedAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(restoredMessages, [{ text: "keep this conversation" }]);
      assert.deepStrictEqual(restoredShell, [{ pinnedAt: "2026-07-01T12:00:00.000Z" }]);
      assert.strictEqual(yield* fs.readFileString(attachmentPath), "image bytes");
      assert.isFalse(yield* fs.exists(providerLogPath));

      // A queued archive job can run after restore but before the unarchive
      // command commits. It must not undo a restore owned by that command.
      yield* storage.archiveThread(threadId);
      const stillRestoredMessages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const stillRestoredManifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(stillRestoredMessages, [{ text: "keep this conversation" }]);
      assert.deepStrictEqual(stillRestoredManifest, [{ status: "restored" }]);

      yield* storage.rollbackRestoreTree(threadId);
      const rolledBackMessages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const rolledBackManifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(rolledBackMessages, [{ count: 0 }]);
      assert.deepStrictEqual(rolledBackManifest, [{ status: "cold" }]);

      assert.isTrue(yield* storage.restoreTree(threadId));
      assert.strictEqual(yield* fs.readFileString(attachmentPath), "image bytes");

      yield* storage.finishRestoreTree(threadId);
      const remainingManifestCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(remainingManifestCount[0]?.count, 0);

      yield* storage.deleteThread(threadId);
      const remainingShellCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const remainingMessageCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(remainingShellCount[0]?.count, 0);
      assert.strictEqual(remainingMessageCount[0]?.count, 0);
      assert.isFalse(yield* fs.exists(attachmentPath));

      yield* storage.compactLegacyStorage;
      const maintenance = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_storage_maintenance
        WHERE task = 'compact-legacy-thread-storage'
      `;
      assert.deepStrictEqual(maintenance, [{ status: "complete" }]);
    }),
  );

  it.effect("ignores traversal attachment entries while restoring", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-traversal");
      const attachmentName = "thread-traversal-00000000-0000-4000-8000-000000000001.png";

      yield* insertArchivedThread(threadId, "Traversal thread");
      yield* sql.unsafe(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (?, ?, NULL, 'user', 'validate attachment name', ?, 0, ?, ?)`,
        [
          "message-traversal",
          threadId,
          encodeUnknownJsonString([
            {
              type: "image",
              id: attachmentName.slice(0, -4),
              name: "image.png",
              mimeType: "image/png",
            },
          ]),
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      yield* fs.writeFileString(path.join(config.attachmentsDir, attachmentName), "image bytes");
      yield* storage.archiveThread(threadId);
      const escapedPath = path.join(config.attachmentsDir, "..", "thread-traversal-escape");
      yield* sql`
        UPDATE cold_archive.archive_thread_chunks
        SET kind = 'attachment:../thread-traversal-escape'
        WHERE thread_id = ${threadId} AND kind LIKE 'attachment:%'
      `;

      assert.isTrue(yield* storage.restoreTree(threadId));
      const manifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(manifest, [{ status: "restored" }]);
      assert.isFalse(yield* fs.exists(escapedPath));
    }),
  );

  it.effect("keeps cold SQL data authoritative when attachment restore fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-attachment-restore-failure");
      const attachmentName =
        "thread-attachment-restore-failure-00000000-0000-4000-8000-000000000001.png";

      yield* insertArchivedThread(threadId, "Attachment restore failure");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-attachment-restore-failure', ${threadId}, NULL, 'user', 'keep me cold',
          '[{"type":"image","id":"thread-attachment-restore-failure-00000000-0000-4000-8000-000000000001","name":"image.png","mimeType":"image/png"}]',
          0, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* fs.writeFileString(path.join(config.attachmentsDir, attachmentName), "image bytes");
      yield* storage.archiveThread(threadId);

      const blockedTarget = path.join(config.attachmentsDir, "blocked-restore.bin");
      yield* fs.makeDirectory(blockedTarget);
      yield* fs.writeFileString(path.join(blockedTarget, "keep"), "prevent replacement");
      yield* sql`
        UPDATE cold_archive.archive_thread_chunks
        SET kind = 'attachment:blocked-restore.bin'
        WHERE thread_id = ${threadId} AND kind LIKE 'attachment:%'
      `;

      const failure = yield* Effect.flip(storage.restoreTree(threadId));
      assert.strictEqual(failure.operation, "restore");
      const messages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      const chunks = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM cold_archive.archive_thread_chunks WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(messages, [{ count: 0 }]);
      assert.deepStrictEqual(manifest, [{ status: "cold" }]);
      assert.isAbove(chunks[0]?.count ?? 0, 0);
    }),
  );

  it.effect("round-trips binary SQL values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-binary");
      const diffBytes = new Uint8Array([0, 1, 2, 127, 128, 255]);

      yield* insertArchivedThread(threadId, "Binary thread");
      yield* sql.unsafe(
        `INSERT INTO checkpoint_diff_blobs
          (thread_id, from_turn_count, to_turn_count, diff, created_at)
         VALUES (?, 0, 1, ?, '2026-07-01T00:00:00.000Z')`,
        [threadId, diffBytes],
      );

      yield* storage.archiveThread(threadId);
      assert.isTrue(yield* storage.restoreTree(threadId));
      const restored = (yield* sql.unsafe(
        `SELECT diff FROM checkpoint_diff_blobs WHERE thread_id = ?`,
        [threadId],
      )) as ReadonlyArray<{ readonly diff: Uint8Array }>;
      assert.deepStrictEqual(restored[0]?.diff, diffBytes);
    }),
  );

  it.effect("retries archive cleanup without rebuilding deleted hot data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-cleanup-retry");
      const providerLogPath = path.join(config.providerLogsDir, "events.thread-cleanup-retry.log");

      yield* insertArchivedThread(threadId, "Cleanup retry thread");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-cleanup-retry', ${threadId}, NULL, 'user', 'preserve across cleanup retry',
          '[]', 0, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* fs.makeDirectory(providerLogPath);
      yield* fs.writeFileString(path.join(providerLogPath, "keep"), "force cleanup failure");

      const archiveFailure = yield* Effect.flip(storage.archiveThread(threadId));
      assert.strictEqual(archiveFailure.operation, "archive");
      const pendingManifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(pendingManifest, [{ status: "cleanup_pending" }]);
      assert.deepInclude(yield* storage.listPendingArchiveThreadIds, threadId);

      yield* fs.remove(providerLogPath, { recursive: true });
      yield* storage.archiveThread(threadId);
      const coldManifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(coldManifest, [{ status: "cold" }]);

      assert.isTrue(yield* storage.restoreTree(threadId));
      const restoredMessages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(restoredMessages, [{ text: "preserve across cleanup retry" }]);
    }),
  );

  it.effect("finishes cleanup-pending archives after their shell is removed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-cleanup-missing-shell");
      const providerLogPath = path.join(
        config.providerLogsDir,
        "events.thread-cleanup-missing-shell.log",
      );

      yield* insertArchivedThread(threadId, "Cleanup missing shell thread");
      yield* fs.makeDirectory(providerLogPath);
      yield* fs.writeFileString(path.join(providerLogPath, "keep"), "force cleanup failure");

      const archiveFailure = yield* Effect.flip(storage.archiveThread(threadId));
      assert.strictEqual(archiveFailure.operation, "archive");
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      yield* fs.remove(providerLogPath, { recursive: true });

      yield* storage.archiveThread(threadId);
      const manifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(manifest, [{ status: "cold" }]);
      assert.notDeepInclude(yield* storage.listPendingArchiveThreadIds, threadId);
    }),
  );

  it.effect("archives only attachments owned by colliding thread segments", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const archivedThreadId = ThreadId.make("Thread.Foo");
      const liveThreadId = ThreadId.make("thread foo");
      const archivedAttachmentId = "thread-foo-00000000-0000-4000-8000-000000000001";
      const liveAttachmentId = "thread-foo-00000000-0000-4000-8000-000000000002";
      const archivedAttachmentName = `${archivedAttachmentId}.png`;
      const liveAttachmentName = `${liveAttachmentId}.png`;

      yield* insertArchivedThread(archivedThreadId, "Archived colliding thread");
      yield* insertArchivedThread(liveThreadId, "Live colliding thread");
      yield* sql`
        UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${liveThreadId}
      `;
      yield* sql.unsafe(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (?, ?, NULL, 'user', ?, ?, 0, ?, ?)`,
        [
          "message-archived-collision",
          archivedThreadId,
          "archive only my attachment",
          encodeUnknownJsonString([
            {
              type: "image",
              id: archivedAttachmentId,
              name: "archived.png",
              mimeType: "image/png",
            },
          ]),
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (?, ?, NULL, 'user', ?, ?, 0, ?, ?)`,
        [
          "message-live-collision",
          liveThreadId,
          "keep my attachment live",
          encodeUnknownJsonString([
            {
              type: "image",
              id: liveAttachmentId,
              name: "live.png",
              mimeType: "image/png",
            },
          ]),
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      const archivedAttachmentPath = path.join(config.attachmentsDir, archivedAttachmentName);
      const liveAttachmentPath = path.join(config.attachmentsDir, liveAttachmentName);
      yield* fs.writeFileString(archivedAttachmentPath, "archived image");
      yield* fs.writeFileString(liveAttachmentPath, "live image");

      yield* storage.archiveThread(archivedThreadId);

      assert.isFalse(yield* fs.exists(archivedAttachmentPath));
      assert.strictEqual(yield* fs.readFileString(liveAttachmentPath), "live image");
      const archivedChunks = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM cold_archive.archive_thread_chunks
        WHERE thread_id = ${archivedThreadId} AND kind LIKE 'attachment:%'
      `;
      assert.deepStrictEqual(archivedChunks, [{ kind: `attachment:${archivedAttachmentName}` }]);
    }),
  );

  it.effect("restores cleanup-pending bundles before unarchiving", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-cleanup-pending-restore");

      yield* insertArchivedThread(threadId, "Cleanup-pending restore thread");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-cleanup-pending-restore', ${threadId}, NULL, 'user',
          'restore while cleanup is pending', '[]', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;

      yield* storage.archiveThread(threadId);
      yield* sql`
        UPDATE thread_archive_manifests
        SET status = 'cleanup_pending'
        WHERE thread_id = ${threadId}
      `;

      assert.isTrue(yield* storage.restoreTree(threadId));
      const restoredMessages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(restoredMessages, [{ text: "restore while cleanup is pending" }]);
      assert.deepStrictEqual(manifest, [{ status: "restored" }]);
    }),
  );

  it.effect("abandons an incomplete archive after the shell is unarchived", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const threadId = ThreadId.make("thread-unarchived-before-archive");

      yield* insertArchivedThread(threadId, "Unarchived before archive thread");
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-unarchived-before-archive', ${threadId}, NULL, 'user',
          'keep active data hot', '[]', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_archive_manifests (
          thread_id, root_thread_id, status, archive_version, archived_at, updated_at
        ) VALUES (
          ${threadId}, ${threadId}, 'pending', 1,
          '2026-07-02T00:00:00.000Z', CURRENT_TIMESTAMP
        )
      `;
      yield* sql`
        UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${threadId}
      `;

      yield* storage.archiveThread(threadId);
      const messages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const manifests = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      const chunks = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM cold_archive.archive_thread_chunks
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(messages, [{ text: "keep active data hot" }]);
      assert.deepStrictEqual(manifests, [{ count: 0 }]);
      assert.deepStrictEqual(chunks, [{ count: 0 }]);
    }),
  );

  it.effect("retries attachment cleanup after directory I/O errors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const threadId = ThreadId.make("thread-attachment-directory-error");

      yield* insertArchivedThread(threadId, "Attachment directory error thread");
      yield* fs.remove(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(config.attachmentsDir, "not a directory");

      const archiveFailure = yield* Effect.flip(storage.archiveThread(threadId));
      assert.strictEqual(archiveFailure.operation, "archive");
      const shell = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const manifests = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(shell, [{ count: 1 }]);
      assert.deepStrictEqual(manifests, [{ status: "archiving" }]);

      yield* fs.remove(config.attachmentsDir);
      yield* fs.makeDirectory(config.attachmentsDir);
      yield* storage.archiveThread(threadId);
      const completedManifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(completedManifest, [{ status: "cold" }]);
    }),
  );

  it.effect("keeps the delete cleanup queue entry until external cleanup succeeds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage.ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-delete-retry");
      const attachmentName = "thread-delete-retry-00000000-0000-4000-8000-000000000001.png";
      const attachmentPath = path.join(config.attachmentsDir, attachmentName);

      yield* insertArchivedThread(threadId, "Delete retry thread");
      yield* sql.unsafe(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (?, ?, NULL, 'user', 'delete me', ?, 0, ?, ?)`,
        [
          "message-delete-retry",
          threadId,
          encodeUnknownJsonString([
            {
              type: "image",
              id: attachmentName.slice(0, -4),
              name: "delete.png",
              mimeType: "image/png",
            },
          ]),
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      yield* fs.makeDirectory(attachmentPath);
      yield* fs.writeFileString(path.join(attachmentPath, "keep"), "force cleanup failure");

      const deleteFailure = yield* Effect.flip(storage.deleteThread(threadId));
      assert.strictEqual(deleteFailure.operation, "delete");
      const pendingCleanup = yield* sql<{ readonly reason: string }>`
        SELECT reason FROM thread_cleanup_queue WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(pendingCleanup, [{ reason: "deleted" }]);

      yield* fs.remove(attachmentPath, { recursive: true });
      yield* storage.deleteThread(threadId);
      const completedCleanup = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_cleanup_queue WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(completedCleanup, [{ count: 0 }]);
    }),
  );
});
