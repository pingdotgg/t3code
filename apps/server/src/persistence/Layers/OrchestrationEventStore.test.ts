import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

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
      const now = "2026-01-01T00:00:00.000Z";

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

  it.effect("orders project and V2 agent events in the retained application event source", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectId = ProjectId.make("project-shared-stream");
      const threadId = ThreadId.make("thread-shared-stream");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const occurredAt = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
      const now = DateTime.formatIso(occurredAt);
      const baselineSequence = yield* eventStore.latestApplicationSequence;

      const projectEvent = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("event-project-shared-stream"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("command-project-shared-stream"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-shared-stream"),
        metadata: {},
        payload: {
          projectId,
          title: "Shared stream",
          workspaceRoot: "/tmp/shared-stream",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const [threadEvent] = yield* eventStore.appendAgentEvents({
        commandId: CommandId.make("command-thread-shared-stream"),
        events: [
          {
            id: EventId.make("event-thread-shared-stream"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt,
            payload: {
              id: threadId,
              projectId,
              title: "Thread",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: {
                rootThreadId: threadId,
                parentThreadId: null,
                relationshipToParent: null,
              },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: occurredAt,
              updatedAt: occurredAt,
              archivedAt: null,
              deletedAt: null,
            },
          },
        ],
      });

      const applicationEvents = yield* eventStore
        .streamApplicationEvents({ afterSequence: baselineSequence })
        .pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      assert.deepEqual(
        applicationEvents.map((event) => event.sequence),
        [projectEvent.sequence, threadEvent!.sequence],
      );
      assert.isTrue("aggregateKind" in applicationEvents[0]!);
      assert.isTrue("event" in applicationEvents[1]!);

      const legacyReplay = yield* eventStore.readFromSequence(projectEvent.sequence - 1).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.deepEqual(
        legacyReplay.map((event) => event.type),
        ["project.created"],
      );
    }),
  );
});
