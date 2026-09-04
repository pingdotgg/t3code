import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import {
  LIVE_STREAM_MAX_ITEMS,
  LiveStreamBufferError,
} from "../../orchestration/LiveStreamBudget.ts";
import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);
const isLiveStreamBufferError = Schema.is(LiveStreamBufferError);

const TestLayer = OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const layer = it.layer(TestLayer);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays CLI-origin events", () =>
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
          origin: {
            surface: "cli",
          },
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
      assert.deepEqual(replayed[0]?.metadata.origin, { surface: "cli" });
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
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
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

      const finiteReplay = yield* eventStore
        .readApplicationEvents({
          afterSequence: baselineSequence,
          throughSequence: threadEvent!.sequence,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      assert.deepEqual(
        finiteReplay.map((event) => event.sequence),
        [projectEvent.sequence, threadEvent!.sequence],
      );

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
  it.effect("measures only a bounded thread replay before decoding its payloads", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("measured-replay-thread");
      const baseline = yield* store.latestApplicationSequence;
      const unicodePayload = '{"text":"🦊"}';
      const oversizedPayload = "{" + "x".repeat(1_048_576);
      let streamVersion = 0;
      const insert = Effect.fn(function* (input: {
        readonly id: string;
        readonly payload: string;
        readonly type?: string;
        readonly threadId?: string;
        readonly version?: number;
      }) {
        const rows = yield* sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${input.id}, 'thread', ${input.threadId ?? threadId},
            ${streamVersion++}, ${input.type ?? "thread.metadata-updated"},
            '2026-09-04T00:00:00.000Z', 'server', ${input.payload}, '{}', ${input.version ?? 2}
          ) RETURNING sequence
        `;
        return rows[0]!.sequence;
      });
      const first = yield* insert({
        id: "measured-replay-1",
        payload: unicodePayload,
        type: "thread.created",
      });
      yield* insert({
        id: "measured-unrelated",
        threadId: "other-replay-thread",
        payload: oversizedPayload,
      });
      yield* insert({ id: "measured-legacy", payload: oversizedPayload, version: 1 });
      const head = yield* insert({ id: "measured-replay-02", payload: oversizedPayload });
      const later = yield* insert({ id: "measured-replay-003", payload: "{}" });
      const range = { threadId, afterSequence: baseline, throughSequence: head, maxEvents: 128 };
      assert.deepEqual(yield* store.getAgentReplayStats(range), {
        eventCount: 2,
        payloadBytes: Buffer.byteLength(unicodePayload) + Buffer.byteLength(oversizedPayload),
        hasCreateEvent: true,
      });
      assert.deepEqual(yield* store.getAgentReplayStats({ ...range, afterSequence: first }), {
        eventCount: 1,
        payloadBytes: Buffer.byteLength(oversizedPayload),
        hasCreateEvent: false,
      });
      assert.equal(
        (yield* store.getAgentReplayStats({ ...range, throughSequence: later, maxEvents: 1 }))
          .eventCount,
        2,
      );
      assert.deepEqual(yield* store.getAgentReplayStats({ ...range, afterSequence: later }), {
        eventCount: 0,
        payloadBytes: 0,
        hasCreateEvent: false,
      });
    }),
  );
});

for (const phase of ["high-water", "replay"] as const) {
  it.effect(`bounds application live events while the ${phase} query is blocked`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const now = "2026-01-03T00:00:00.000Z";
        const projectId = ProjectId.make(`project:blocked-${phase}`);
        const projectEvent = yield* store.append({
          type: "project.created",
          eventId: EventId.make(`event:blocked-${phase}:created`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.make(`command:blocked-${phase}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Blocked stream",
            workspaceRoot: "/tmp/blocked-stream",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        if (projectEvent.type !== "project.created")
          return yield* Effect.die("Expected project.created");
        const readStarted = yield* Deferred.make<void>();
        const readClosed = yield* Deferred.make<void>();
        const blockRead: Statement.Transformer = (statement) => {
          const [query] = statement.compile();
          if (
            query.includes("FROM orchestration_events") &&
            query.includes("MAX(sequence)") === (phase === "high-water")
          ) {
            return Deferred.succeed(readStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(readClosed, undefined)),
              Effect.as(statement),
            );
          }
          return Effect.succeed(statement);
        };
        const reader = yield* store
          .streamApplicationEvents({ afterSequence: projectEvent.sequence })
          .pipe(
            Stream.provideService(Statement.CurrentTransformer, blockRead),
            Stream.runDrain,
            Effect.result,
            Effect.forkScoped,
          );
        yield* Deferred.await(readStarted);
        yield* store.publishCommitted(
          Array.from({ length: LIVE_STREAM_MAX_ITEMS + 1 }, (_, index) => ({
            ...projectEvent,
            eventId: EventId.make(`event:blocked-${phase}:${index}`),
            sequence: projectEvent.sequence + index + 1,
          })),
        );
        yield* Deferred.await(readClosed);
        const result = yield* Fiber.join(reader);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "PersistenceSqlError");
          assert.isTrue(isLiveStreamBufferError(result.failure.cause));
        }
      }),
    ).pipe(Effect.provide(Layer.fresh(TestLayer))),
  );
}
