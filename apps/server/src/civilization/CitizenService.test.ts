import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ConfigService from "./ConfigService.ts";
import { enrollCivilizationThread } from "./PersistenceParticipant.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const hostOnlySink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(stores, database)),
  Layer.provide(Layer.succeed(EventSink.EventSinkPersistenceParticipants, [])),
);
const layer = Layer.mergeAll(
  database,
  stores,
  hostOnlySink,
  ConfigService.layer.pipe(Layer.provide(database)),
  CitizenService.layer.pipe(Layer.provide(Layer.mergeAll(database, stores))),
);

const providerInstanceId = ProviderInstanceId.make("codex");

function makeThread(
  id: ThreadId,
  projectId: ProjectId,
  at: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "Existing thread title",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "civilization-phase1" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const enableAllExisting = Effect.fn("CitizenService.test.enableAllExisting")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true, adoption: "all_existing" },
    },
  });
});

it.effect(
  "explicitly adopts current projections, remains idempotent, and excludes deleted threads",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const citizens = yield* CitizenService.CivilizationCitizenService;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:adoption");
      const activeId = ThreadId.make("thread:civilization:adoption:active");
      const deletedId = ThreadId.make("thread:civilization:adoption:deleted");
      const active = makeThread(activeId, projectId, now);
      const deleted = makeThread(deletedId, projectId, now);

      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:adoption:active:create"),
            type: "thread.created",
            threadId: activeId,
            occurredAt: now,
            payload: active,
          },
          {
            id: EventId.make("event:civilization:adoption:deleted:create"),
            type: "thread.created",
            threadId: deletedId,
            occurredAt: now,
            payload: deleted,
          },
        ],
      });
      const deletedProjection = { ...deleted, deletedAt: now, updatedAt: now };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:adoption:deleted:delete"),
            type: "thread.deleted",
            threadId: deletedId,
            occurredAt: now,
            payload: deletedProjection,
          },
        ],
      });
      assert.isNull(yield* citizens.getCitizen(activeId));
      yield* enableAllExisting();

      const first = yield* citizens.adoptExisting();
      assert.deepEqual(first, { candidates: 1, adopted: 1, skipped: 0 });
      assert.isNotNull(yield* citizens.getCitizen(activeId));
      assert.isNull(yield* citizens.getCitizen(deletedId));

      const second = yield* citizens.adoptExisting();
      assert.deepEqual(second, { candidates: 0, adopted: 0, skipped: 0 });
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("adopts all existing projections across bounded 100-row batches", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const citizens = yield* CitizenService.CivilizationCitizenService;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:civilization:adoption-batches");
    const threads = Array.from({ length: 105 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      const threadId = ThreadId.make(`thread:civilization:adoption-batches:${suffix}`);
      return makeThread(threadId, projectId, now);
    });
    yield* sink.write({
      events: threads.map((thread, index) => ({
        id: EventId.make(`event:civilization:adoption-batches:${index}`),
        type: "thread.created" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      })),
    });
    yield* enableAllExisting();

    const first = yield* citizens.adoptExisting({ projectId });
    assert.deepEqual(first, { candidates: 105, adopted: 105, skipped: 0 });
    const second = yield* citizens.adoptExisting({ projectId });
    assert.deepEqual(second, { candidates: 0, adopted: 0, skipped: 0 });
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "catch-up advances only enrolled citizens and never turns historical thread.created into adoption",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const citizens = yield* CitizenService.CivilizationCitizenService;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:catch-up");
      const enrolledId = ThreadId.make("thread:civilization:catch-up:enrolled");
      const historicalId = ThreadId.make("thread:civilization:catch-up:historical");
      const enrolled = makeThread(enrolledId, projectId, now);
      const historical = makeThread(historicalId, projectId, now);
      yield* enableAllExisting();

      const created = yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:catch-up:enrolled:create"),
            type: "thread.created",
            threadId: enrolledId,
            occurredAt: now,
            payload: enrolled,
          },
          {
            id: EventId.make("event:civilization:catch-up:historical:create"),
            type: "thread.created",
            threadId: historicalId,
            occurredAt: now,
            payload: historical,
          },
        ],
      });
      const enrolledCreate = created.find((stored) => stored.event.threadId === enrolledId)!;
      yield* enrollCivilizationThread({
        sequence: enrolledCreate.sequence,
        thread: enrolled,
        adoption: false,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      const settled = {
        ...enrolled,
        settledOverride: "settled" as const,
        settledAt: now,
        updatedAt: now,
      };
      const settledStored = yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:catch-up:enrolled:settle"),
            type: "thread.settled",
            threadId: enrolledId,
            occurredAt: now,
            payload: settled,
          },
        ],
      });

      const summary = yield* citizens.reconcileExisting();
      assert.deepEqual(summary, { citizenCount: 1, caughtUpCitizenCount: 1, appliedEventCount: 1 });
      const caughtUp = yield* citizens.getCitizen(enrolledId);
      assert.equal(caughtUp?.epoch, 1);
      assert.isTrue(caughtUp?.closed ?? false);
      assert.isNull(yield* citizens.getCitizen(historicalId));
      const watermark = (yield* sql<{ readonly last_applied_sequence: number }>`
        SELECT last_applied_sequence
        FROM civilization_citizens WHERE thread_id = ${enrolledId}
      `)[0]!.last_applied_sequence;
      assert.equal(watermark, settledStored[0]!.sequence);

      const idempotent = yield* citizens.reconcileExisting();
      assert.deepEqual(idempotent, {
        citizenCount: 1,
        caughtUpCitizenCount: 0,
        appliedEventCount: 0,
      });
    }).pipe(Effect.provide(Layer.fresh(layer))),
);
