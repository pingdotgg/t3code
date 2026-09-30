import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { compactLegacyActivityPayloadBatch } from "../ActivityPayloadCompactor.ts";

const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  Layer.merge(OrchestrationEventStoreLive, ProjectionThreadActivityRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("redacts MCP tool credentials before the orchestration event is persisted", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const threadId = ThreadId.make("thread-mcp-redaction");
      const appended = yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-mcp-redaction"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("activity-mcp-redaction"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Delegation completed",
            payload: {
              itemType: "mcp_tool_call",
              data: {
                rawInput: {
                  toolName: "delegate_work",
                  authorization: "Bearer never-persist-this",
                  prompt: "Retain prompt evidence",
                },
                rawOutput: { content: "Retain result evidence" },
              },
            },
            turnId: null,
            createdAt: now,
          },
        },
      });

      const rows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(rows.length, 1);
      assert.notInclude(rows[0]?.payloadJson ?? "", "never-persist-this");
      assert.include(rows[0]?.payloadJson ?? "", "Retain prompt evidence");
      assert.include(rows[0]?.payloadJson ?? "", "Retain result evidence");
      assert.include(rows[0]?.payloadJson ?? "", "[REDACTED]");
    }),
  );

  it.effect("stores large tool data once while event and projection reads stay lossless", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const activities = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-15T00:00:00.000Z";
      const threadId = ThreadId.make("thread-tool-payload-blob");
      const activityId = EventId.make("activity-tool-payload-blob");
      const largeOutput = {
        rawOutput: {
          content: "unique-large-tool-output-".repeat(10_000),
        },
      };

      const appended = yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-tool-payload-blob"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: activityId,
            tone: "tool",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: {
              itemType: "command_execution",
              data: largeOutput,
            },
            turnId: null,
            createdAt: now,
          },
        },
      });
      yield* activities.upsert({
        activityId,
        threadId,
        turnId: null,
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool completed",
        payload: {
          itemType: "command_execution",
          data: largeOutput,
        },
        createdAt: now,
      });

      const stored = yield* sql<{
        readonly blobs: number;
        readonly eventCopies: number;
        readonly projectionCopies: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM activity_payload_blobs) AS blobs,
          (
            SELECT COUNT(*) FROM orchestration_events
            WHERE instr(payload_json, 'unique-large-tool-output-') > 0
          ) AS eventCopies,
          (
            SELECT COUNT(*) FROM projection_thread_activities
            WHERE instr(payload_json, 'unique-large-tool-output-') > 0
          ) AS projectionCopies
      `;
      assert.deepStrictEqual(stored, [{ blobs: 1, eventCopies: 0, projectionCopies: 0 }]);

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(appended.sequence - 1, 1),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const replayedActivity = replayed[0]!.payload;
      assert.deepStrictEqual(
        replayedActivity && "activity" in replayedActivity
          ? (replayedActivity.activity.payload as { readonly data?: unknown }).data
          : undefined,
        largeOutput,
      );

      const projected = yield* activities.listByThreadId({ threadId });
      assert.deepStrictEqual(
        (projected[0]!.payload as { readonly data?: unknown }).data,
        largeOutput,
      );
    }),
  );

  it.effect("incrementally compacts legacy tool payloads without changing reads", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const activities = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-16T00:00:00.000Z";
      const threadId = ThreadId.make("thread-legacy-tool-payload");
      const activityId = EventId.make("activity-legacy-tool-payload");
      const data = { content: "legacy-large-tool-output-".repeat(10_000) };
      const activity = {
        id: activityId,
        tone: "tool",
        kind: "tool.completed",
        summary: "Legacy tool completed",
        payload: { itemType: "command_execution", data },
        turnId: null,
        createdAt: now,
      } as const;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-legacy-tool-payload")},
          ${"thread"},
          ${threadId},
          ${0},
          ${"thread.activity-appended"},
          ${now},
          ${null},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({ threadId, activity })},
          ${"{}"}
        )
      `;
      const [persistedEvent] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = ${EventId.make("evt-legacy-tool-payload")}
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          ${activityId},
          ${threadId},
          ${null},
          ${activity.tone},
          ${activity.kind},
          ${activity.summary},
          ${JSON.stringify(activity.payload)},
          ${1},
          ${now}
        )
      `;

      assert.equal(yield* compactLegacyActivityPayloadBatch(), 1);

      const rawCopies = yield* sql<{
        readonly eventCopies: number;
        readonly projectionCopies: number;
      }>`
        SELECT
          (
            SELECT COUNT(*) FROM orchestration_events
            WHERE instr(payload_json, 'legacy-large-tool-output-') > 0
          ) AS eventCopies,
          (
            SELECT COUNT(*) FROM projection_thread_activities
            WHERE instr(payload_json, 'legacy-large-tool-output-') > 0
          ) AS projectionCopies
      `;
      assert.deepStrictEqual(rawCopies, [{ eventCopies: 0, projectionCopies: 0 }]);

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence((persistedEvent?.sequence ?? 1) - 1, 1),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const replayedPayload = replayed[0]!.payload;
      assert.deepStrictEqual(
        replayedPayload && "activity" in replayedPayload
          ? (replayedPayload.activity.payload as { readonly data?: unknown }).data
          : undefined,
        data,
      );
      const projected = yield* activities.listByThreadId({ threadId });
      assert.deepStrictEqual((projected[0]!.payload as { readonly data?: unknown }).data, data);
    }),
  );
});
