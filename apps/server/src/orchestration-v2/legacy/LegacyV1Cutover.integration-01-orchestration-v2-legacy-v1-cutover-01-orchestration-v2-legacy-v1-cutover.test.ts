import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import Migration0042 from "../../persistence/Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "../../persistence/Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "../../persistence/Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "../../persistence/Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "../../persistence/Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "../../persistence/Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "../../persistence/Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "../../persistence/Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionReplay from "../testkit/ProjectionReplay.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CapturedLog, CapturedTurn } from "./LegacyV1Cutover.integration-01-orchestration-v2-legacy-v1-cutover-01-orchestration-v2-legacy-v1-cutover-part2.testkit.ts";
import { ACTIVE_THREAD, ALL_THREADS, ARCHIVED_THREAD, CONTINUATION_PROMPT, DELETED_THREAD, EARLIEST_MARKER, INTERRUPTED_THREAD, LATEST_MARKER, LONG_THREAD, PINNED_THREAD, SNOOZED_THREAD, layerBoot, makeCapturingLogger, seedV1Database, waitForIdle } from "./LegacyV1Cutover.integration-01-orchestration-v2-legacy-v1-cutover-01-orchestration-v2-legacy-v1-cutover-part2.testkit.ts";

const messageOrdinals = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems
    .filter(
      (
        item,
      ): item is Extract<typeof item, { readonly type: "user_message" | "assistant_message" }> =>
        item.type === "user_message" || item.type === "assistant_message",
    )
    .map((item) => [String(item.messageId), item.ordinal, item.status] as const);






describe("orchestration v2 legacy v1 cutover", () => {
  it.live(
    "migrates an untouched v1 database copy through shell import, lazy transcripts, continuation and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspace = yield* checkpointWorkspace("legacy-v1-cutover");
          const stateDir = yield* fs.makeTempDirectory({ prefix: "t3-v1-cutover-state-" });
          const fixturePath = path.join(stateDir, "v1-source.sqlite");
          const copyPath = path.join(stateDir, "userdata", "state.sqlite");
          yield* fs.makeDirectory(path.join(stateDir, "userdata"), { recursive: true });

          yield* seedV1Database(fixturePath, workspace);
          yield* fs.copyFile(fixturePath, copyPath);

          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const longThreadId = ThreadId.make(LONG_THREAD);

          const boot1Logs: CapturedLog[] = [];
          const firstBoot = yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
              const maintenance = yield* ProjectionReplay.ProjectionReplay;
              const projections = yield* ProjectionStore.ProjectionStoreV2;
              const orchestrator = yield* Orchestrator.OrchestratorV2;

              assert.equal(yield* importer.pendingThreadCount, ALL_THREADS.length);
              const shellImport = yield* importer.reconcileShells;
              assert.deepStrictEqual(shellImport, {
                importedThreadCount: ALL_THREADS.length,
                importedMessageCount: 14,
              });

              assert.deepStrictEqual(yield* importer.reconcileShells, {
                importedThreadCount: 0,
                importedMessageCount: 0,
              });
              assert.isTrue((yield* maintenance.rebuild).valid);

              const shellSnapshot = yield* projections.getShellSnapshot();
              const visibleShellIds = [
                ...shellSnapshot.threads.map((thread) => thread.id),
                ...shellSnapshot.archivedThreads.map((thread) => thread.id),
              ];
              assert.notInclude(visibleShellIds, ThreadId.make(DELETED_THREAD));
              assert.include(
                shellSnapshot.archivedThreads.map((thread) => thread.id),
                ThreadId.make(ARCHIVED_THREAD),
              );
              const pinnedShell = shellSnapshot.threads.find(
                (thread) => thread.id === PINNED_THREAD,
              );
              assert.equal(pinnedShell?.pinOrderKey, "a0");

              const activeShell = yield* projections.getThreadProjection(
                ThreadId.make(ACTIVE_THREAD),
              );
              assert.equal(activeShell.thread.historyOrigin, "v1_import");
              assert.isNull(activeShell.thread.activeProviderThreadId);
              assert.deepStrictEqual(
                activeShell.messages.map((message) => message.id),
                ["message:cutover:active:3", "message:cutover:active:4"],
              );
              assert.isEmpty(activeShell.providerThreads);

              assert.isEmpty(
                activeShell.turnItems.filter(
                  (item) => item.type !== "user_message" && item.type !== "assistant_message",
                ),
              );

              const deletedShell = yield* projections.getThreadProjection(
                ThreadId.make(DELETED_THREAD),
              );
              assert.isNotNull(deletedShell.thread.deletedAt);
              assert.equal(
                deletedShell.thread.deletedAt?.toString(),
                DateTime.makeUnsafe("2026-01-09T00:00:00.000Z").toString(),
              );

              for (const threadId of [
                ACTIVE_THREAD,
                ARCHIVED_THREAD,
                PINNED_THREAD,
                DELETED_THREAD,
                INTERRUPTED_THREAD,
                LONG_THREAD,
              ]) {
                yield* importer.ensureTranscript(ThreadId.make(threadId));
              }
              assert.deepStrictEqual(
                yield* importer.ensureTranscript(ThreadId.make(ACTIVE_THREAD)),
                { importedThreadCount: 0, importedMessageCount: 0 },
              );

              const active = yield* projections.getThreadProjection(ThreadId.make(ACTIVE_THREAD));
              assert.deepStrictEqual(
                active.messages.map((message) => message.id),
                [
                  "message:cutover:active:1",
                  "message:cutover:active:2",
                  "message:cutover:active:3",
                  "message:cutover:active:4",
                ],
              );
              assert.deepStrictEqual(messageOrdinals(active), [
                ["message:cutover:active:1", 1, "completed"],
                ["message:cutover:active:2", 2, "completed"],
                ["message:cutover:active:3", 3, "completed"],
                ["message:cutover:active:4", 4, "completed"],
              ]);
              assert.deepStrictEqual(
                active.messages.find((message) => message.id === "message:cutover:active:2")
                  ?.attachments,
                [
                  {
                    type: "image",
                    id: "att-1",
                    name: "shot.png",
                    mimeType: "image/png",
                    sizeBytes: 1234,
                  },
                ],
              );
              assert.equal(active.thread.linkedPullRequest?.number, 9100);
              assert.deepStrictEqual(
                active.thread.pullRequests?.map((pullRequest) => pullRequest.number),
                [9100],
              );

              const archived = yield* projections.getThreadProjection(
                ThreadId.make(ARCHIVED_THREAD),
              );
              assert.isNotNull(archived.thread.archivedAt);
              const pinned = yield* projections.getThreadProjection(ThreadId.make(PINNED_THREAD));
              assert.isNotNull(pinned.thread.pinnedAt);
              assert.equal(pinned.thread.pinOrderKey, "a0");
              const snoozed = yield* projections.getThreadProjection(ThreadId.make(SNOOZED_THREAD));
              assert.equal(
                snoozed.thread.snoozedUntil?.toString(),
                DateTime.makeUnsafe("2026-02-01T00:00:00.000Z").toString(),
              );

              assert.deepStrictEqual(
                snoozed.messages.map((message) => message.id),
                ["message:cutover:snoozed:1", "message:cutover:snoozed:3"],
              );
              const snoozedImportRow = yield* sql<{
                readonly transcript_imported_at: string | null;
              }>`
              SELECT transcript_imported_at
              FROM orchestration_v2_legacy_imports
              WHERE thread_id = ${SNOOZED_THREAD}
            `;
              assert.isNull(snoozedImportRow[0]?.transcript_imported_at);

              const interrupted = yield* projections.getThreadProjection(
                ThreadId.make(INTERRUPTED_THREAD),
              );
              assert.deepStrictEqual(messageOrdinals(interrupted), [
                ["message:cutover:interrupted:1", 1, "completed"],
                ["message:cutover:interrupted:2", 2, "interrupted"],
              ]);

              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cutover:continue"),
                threadId: longThreadId,
                messageId: MessageId.make("message:cutover:long:continuation"),
                text: CONTINUATION_PROMPT,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
              });
              const continued = yield* waitForIdle(longThreadId);

              const runs = continued.runs.filter((run) => run.ordinal >= 1);
              assert.equal(runs.at(-1)?.status, "completed");
              assert.equal(continued.providerThreads.length, 1);
              assert.isNotNull(continued.providerThreads[0]?.nativeThreadRef);
              assert.equal(continued.contextHandoffs.length, 1);
              const handoff = continued.contextHandoffs[0]!;
              assert.equal(handoff.strategy, "manual_context");
              assert.isAtMost(handoff.summaryText.length, 32_000);
              assert.include(handoff.summaryText, LATEST_MARKER);
              assert.notInclude(handoff.summaryText, EARLIEST_MARKER);
              const turns = yield* Ref.get(capturedTurns);
              assert.equal(turns.length, 1);
              assert.include(turns[0]!.text, "Context handoff (manual_context):");
              assert.include(turns[0]!.text, `User message:\n${CONTINUATION_PROMPT}`);

              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cutover:continue:again"),
                threadId: longThreadId,
                messageId: MessageId.make("message:cutover:long:continuation:2"),
                text: "One more.",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
              });
              const continuedAgain = yield* waitForIdle(longThreadId);
              assert.equal(continuedAgain.contextHandoffs.length, 1);
              assert.equal((yield* Ref.get(capturedTurns)).length, 2);

              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              yield* worker.drain();

              const migrationEventCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM orchestration_events
              WHERE application_event_version = 2
                AND event_id LIKE 'migration:v1:%'
            `;
              const importRows = yield* sql<{
                readonly thread_id: string;
                readonly transcript_imported_at: string | null;
              }>`
              SELECT thread_id, transcript_imported_at
              FROM orchestration_v2_legacy_imports
              ORDER BY thread_id
            `;
              const legacyMessageCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_thread_messages
            `;
              const legacyThreadCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_threads
            `;
              const recordedMigration41 = yield* sql<{ readonly name: string }>`
              SELECT name FROM effect_sql_migrations WHERE migration_id = 41
            `;
              const authSessionColumns = yield* sql<{ readonly name: string }>`
              PRAGMA table_info(auth_sessions)
            `;
              return {
                migrationEventCount: migrationEventCount[0]?.count ?? 0,
                importRows,
                legacyMessageCount: legacyMessageCount[0]?.count ?? 0,
                legacyThreadCount: legacyThreadCount[0]?.count ?? 0,
                longProjection: continuedAgain,
                migration41Name: recordedMigration41[0]?.name ?? null,
                authSessionColumnNames: authSessionColumns.map((column) => column.name),
              };
            }).pipe(
              Effect.provide(
                layerBoot({
                  name: "legacy-v1-cutover-first",
                  dbPath: copyPath,
                  workspace,
                  capturedTurns,
                }),
              ),
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([makeCapturingLogger(boot1Logs)]),
              ),
            ),
          );

          const divergenceLog = boot1Logs.find((log) =>
            String(log.message).includes("migration history diverges"),
          );
          assert.deepStrictEqual(divergenceLog?.annotations.divergent, [
            "41:ThreadSummaryTimeline (this build: AuthSessionClientConnection)",
          ]);
          assert.equal(firstBoot.migration41Name, "ThreadSummaryTimeline");

          assert.notInclude(firstBoot.authSessionColumnNames, "client_surface");
          assert.notInclude(firstBoot.authSessionColumnNames, "client_app_version");

          assert.equal(firstBoot.importRows.length, ALL_THREADS.length);
          const unhydratedRows = firstBoot.importRows.filter(
            (row) => row.transcript_imported_at === null,
          );
          assert.deepStrictEqual(
            unhydratedRows.map((row) => row.thread_id),
            [SNOOZED_THREAD],
          );

          const boot2Logs: CapturedLog[] = [];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
              const projections = yield* ProjectionStore.ProjectionStoreV2;

              assert.equal(yield* importer.pendingThreadCount, 1);
              assert.deepStrictEqual(yield* importer.reconcileShells, {
                importedThreadCount: 0,
                importedMessageCount: 0,
              });
              assert.deepStrictEqual(
                yield* importer.ensureTranscript(ThreadId.make(SNOOZED_THREAD)),
                { importedThreadCount: 1, importedMessageCount: 1 },
              );
              const snoozed = yield* projections.getThreadProjection(ThreadId.make(SNOOZED_THREAD));
              assert.deepStrictEqual(
                snoozed.messages.map((message) => message.id),
                [
                  "message:cutover:snoozed:1",
                  "message:cutover:snoozed:2",
                  "message:cutover:snoozed:3",
                ],
              );
              assert.equal(yield* importer.pendingThreadCount, 0);
              for (const threadId of ALL_THREADS) {
                assert.deepStrictEqual(yield* importer.ensureTranscript(ThreadId.make(threadId)), {
                  importedThreadCount: 0,
                  importedMessageCount: 0,
                });
              }
              const migrationEventCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM orchestration_events
              WHERE application_event_version = 2
                AND event_id LIKE 'migration:v1:%'
            `;

              assert.equal(migrationEventCount[0]?.count, firstBoot.migrationEventCount + 2);

              const restarted = yield* projections.getThreadProjection(longThreadId);
              assert.equal(restarted.thread.historyOrigin, "v1_import");
              assert.equal(restarted.contextHandoffs.length, 1);
              assert.isNotNull(restarted.thread.activeProviderThreadId);
              assert.deepStrictEqual(
                restarted.runs.map((run) => run.status),
                firstBoot.longProjection.runs.map((run) => run.status),
              );

              const legacyMessageCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_thread_messages
            `;
              const legacyThreadCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_threads
            `;
              assert.equal(legacyMessageCount[0]?.count, firstBoot.legacyMessageCount);
              assert.equal(legacyThreadCount[0]?.count, firstBoot.legacyThreadCount);
              const quickCheck = yield* sql<{ readonly quick_check: string }>`
              PRAGMA quick_check
            `;
              assert.deepStrictEqual(
                quickCheck.map((row) => row.quick_check),
                ["ok"],
              );
            }).pipe(
              Effect.provide(
                layerBoot({
                  name: "legacy-v1-cutover-restart",
                  dbPath: copyPath,
                  workspace,
                  capturedTurns,
                }),
              ),
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([makeCapturingLogger(boot2Logs)]),
              ),
            ),
          );

          assert.isTrue(
            boot2Logs.some((log) => String(log.message).includes("migration history diverges")),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});


