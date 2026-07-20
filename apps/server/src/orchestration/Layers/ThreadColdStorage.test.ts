import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadColdStorage } from "../Services/ThreadColdStorage.ts";
import { ThreadColdStorageLive } from "./ThreadColdStorage.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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
  ThreadColdStorageLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cold-storage-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ThreadColdStorage", (it) => {
  it.effect("discovers archived shells before a lifecycle manifest exists", () =>
    Effect.gen(function* () {
      const storage = yield* ThreadColdStorage;
      const threadId = ThreadId.make("thread-archive-queue-fallback");

      yield* insertArchivedThread(threadId, "Archive queue fallback thread");

      assert.deepInclude(yield* storage.listPendingArchiveThreadIds, threadId);
    }),
  );

  it.effect("reserves hot archived rows while an unarchive command is pending", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage;
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

      assert.isTrue(yield* storage.restoreTree(threadId));
      yield* storage.archiveThread(threadId);

      const messages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{ readonly status: string }>`
        SELECT status FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(messages, [{ text: "keep hot until unarchive commits" }]);
      assert.deepStrictEqual(manifest, [{ status: "restored" }]);

      yield* storage.finishRestoreTree(threadId);
      const remainingManifest = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(remainingManifest, [{ count: 0 }]);
    }),
  );

  it.effect("compresses conversation data, destroys logs, restores content, and hard-deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-cold");
      const attachmentName = "thread-cold-00000000-0000-4000-8000-000000000001.png";

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at
        ) VALUES (
          ${threadId}, 'project-1', 'Cold thread',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access', 'default', '2026-07-01T00:00:00.000Z',
          '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', ${threadId}, NULL, 'user', 'keep this conversation',
          '[{"type":"image","id":"thread-cold-00000000-0000-4000-8000-000000000001","name":"image.png","mimeType":"image/png"}]',
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
      const providerLogPath = path.join(config.providerLogsDir, "thread-cold.log");
      const rotatedProviderLogPath = `${providerLogPath}.1`;
      yield* fs.writeFileString(attachmentPath, "image bytes");
      yield* fs.writeFileString(providerLogPath, "diagnostic");
      yield* fs.writeFileString(rotatedProviderLogPath, "old diagnostic");

      yield* storage.archiveThread(threadId);

      const archivedMessageCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      const archivedEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId}
      `;
      const shellCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const manifest = yield* sql<{ readonly status: string; readonly compressedBytes: number }>`
        SELECT status, compressed_bytes AS "compressedBytes"
        FROM thread_archive_manifests WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(archivedMessageCount[0]?.count, 0);
      assert.strictEqual(archivedEventCount[0]?.count, 0);
      assert.strictEqual(shellCount[0]?.count, 1);
      assert.strictEqual(manifest[0]?.status, "cold");
      assert.isAbove(manifest[0]?.compressedBytes ?? 0, 0);
      assert.isFalse(yield* fs.exists(attachmentPath));
      assert.isFalse(yield* fs.exists(providerLogPath));
      assert.isFalse(yield* fs.exists(rotatedProviderLogPath));

      assert.isTrue(yield* storage.restoreTree(threadId));
      const restoredMessages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(restoredMessages, [{ text: "keep this conversation" }]);
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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-cleanup-retry");
      const providerLogPath = path.join(config.providerLogsDir, "thread-cleanup-retry.log");

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
      const storage = yield* ThreadColdStorage;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-cleanup-missing-shell");
      const providerLogPath = path.join(config.providerLogsDir, "thread-cleanup-missing-shell.log");

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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
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
      const storage = yield* ThreadColdStorage;
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
