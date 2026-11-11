import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeRunOutcomeRecorder } from "./RunMetrics.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const threadId = ThreadId.make("thread:metrics");

// Each test labels its runs with its own provider, since the metric registry is shared.
const runUpdated = (
  sequence: number,
  provider: string,
  run: Pick<OrchestrationV2Run, "id" | "status" | "startedAt" | "completedAt"> &
    Partial<OrchestrationV2Run>,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    type: "run.updated",
    id: EventId.make(`event:${provider}:${sequence}`),
    threadId,
    occurredAt: at("2026-10-19T12:00:00.000Z"),
    payload: {
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make(provider),
      modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "claude-opus-5-5" },
      requestedAt: at("2026-10-19T12:00:00.000Z"),
      ...run,
    } as OrchestrationV2Run,
  },
});

// Prepare inside the transaction, record after its commit, as the EventSink does.
const commitWith =
  (recorder: ReturnType<typeof makeRunOutcomeRecorder<unknown>>) =>
  (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
    recorder.prepare(events).pipe(Effect.flatMap(recorder.record));

const runSnapshots = (provider: string) =>
  Metric.snapshot.pipe(
    Effect.map((snapshots) =>
      snapshots.filter(
        (snapshot) =>
          snapshot.id.startsWith("t3_run") && snapshot.attributes?.["provider"] === provider,
      ),
    ),
  );

describe("makeRunOutcomeRecorder", () => {
  it.effect("records a finished run once, labelled, with its queue wait and duration", () =>
    Effect.gen(function* () {
      // A subagent thread's first run carries no delegatedTaskId; only its lineage says delegated.
      const recorder = makeRunOutcomeRecorder(() => Effect.succeed(true));
      const record = commitWith(recorder);
      const finished = {
        id: RunId.make("run:metrics:once"),
        status: "completed" as const,
        startedAt: at("2026-10-19T12:00:30.000Z"),
        completedAt: at("2026-10-19T12:10:30.000Z"),
      };

      yield* record([runUpdated(1, "p1", { ...finished, status: "running", completedAt: null })]);
      // A transaction that rolls back prepares and never records; it must not reserve the run.
      yield* recorder.prepare([runUpdated(2, "p1", finished)]);
      yield* record([runUpdated(2, "p1", finished)]);
      // Later updates to a finished run, such as its checkpoint, are not another run.
      yield* record([runUpdated(3, "p1", finished)]);

      const snapshots = yield* runSnapshots("p1");
      const byId = (id: string) => snapshots.find((snapshot) => snapshot.id === id);
      const counter = byId("t3_runs_total");
      assert.strictEqual(counter?.type === "Counter" ? counter.state.count : undefined, 1);
      assert.deepStrictEqual(counter?.attributes, {
        provider: "p1",
        modelFamily: "claude",
        outcome: "completed",
        delegated: "true",
      });
      const histogramSum = (id: string) => {
        const snapshot = byId(id);
        return snapshot?.type === "Histogram" ? snapshot.state.sum : undefined;
      };
      assert.strictEqual(histogramSum("t3_run_queue_wait"), 30_000);
      assert.strictEqual(histogramSum("t3_run_duration"), 600_000);
    }),
  );

  it.effect("does not count a rollback of a run that already finished", () =>
    Effect.gen(function* () {
      // A fresh recorder stands in for a restart, which forgets the runs already counted.
      const record = commitWith(makeRunOutcomeRecorder(() => Effect.succeed(false)));
      yield* record([
        runUpdated(1, "p2", {
          id: RunId.make("run:metrics:rolled-back"),
          status: "rolled_back",
          startedAt: at("2026-10-19T12:00:30.000Z"),
          completedAt: at("2026-10-20T09:00:00.000Z"),
        }),
      ]);

      assert.deepStrictEqual(yield* runSnapshots("p2"), []);
    }),
  );
});

describe("EventSink run outcomes", () => {
  const parentId = ThreadId.make("thread:metrics:sink:parent");
  const childId = ThreadId.make("thread:metrics:sink:child");
  const provider = ProviderInstanceId.make("p-sink");
  const now = at("2026-10-19T12:00:00.000Z");
  const thread = (id: ThreadId, lineage: OrchestrationV2AppThread["lineage"]) =>
    ({
      type: "thread.created",
      id: EventId.make(`event:${id}:created`),
      threadId: id,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id,
        projectId: ProjectId.make("project:metrics"),
        title: id,
        providerInstanceId: provider,
        modelSelection: { instanceId: provider, model: "gpt-6.1" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage,
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    }) satisfies OrchestrationV2DomainEvent;
  const runId = RunId.make("run:metrics:sink:child");
  const run = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
    id: runId,
    threadId: childId,
    ordinal: 1,
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "gpt-6.1" },
    providerThreadId: null,
    userMessageId: MessageId.make("message:metrics:sink"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: now,
    startedAt: at("2026-10-19T12:00:10.000Z"),
    completedAt: status === "running" ? null : at("2026-10-19T12:01:10.000Z"),
    checkpointId: null,
    contextHandoffId: null,
  });
  const runEvent = (type: "run.created" | "run.updated", status: OrchestrationV2Run["status"]) =>
    ({
      type,
      id: EventId.make(`event:${runId}:${status}`),
      threadId: childId,
      runId,
      occurredAt: now,
      payload: run(status),
    }) satisfies OrchestrationV2DomainEvent;

  it.effect("reads lineage inside the transaction, so a concurrent writer cannot deadlock it", () =>
    Effect.gen(function* () {
      const lookupEntered = yield* Deferred.make<boolean>();
      const releaseLookup = yield* Deferred.make<void>();
      const writerStarted = yield* Deferred.make<void>();
      const pausedLookup = Layer.effect(
        ProjectionStore.ProjectionStoreV2,
        Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sql = yield* SqlClient.SqlClient;
          let paused = false;
          return {
            ...store,
            getThread: (id) =>
              Effect.gen(function* () {
                if (id === childId && !paused) {
                  paused = true;
                  const inTransaction = Option.isSome(
                    yield* Effect.serviceOption(sql.transactionService),
                  );
                  yield* Deferred.succeed(lookupEntered, inTransaction);
                  // Outside the transaction this read would wait on the writer it is racing.
                  if (inTransaction) yield* Deferred.await(releaseLookup);
                }
                return yield* store.getThread(id);
              }),
          };
        }),
      );
      const layer = EventSink.layer.pipe(
        Layer.provideMerge(pausedLookup),
        Layer.provideMerge(
          Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
            Layer.provideMerge(SqlitePersistence.layerMemory),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            thread(parentId, {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: parentId,
            }),
            thread(childId, {
              parentThreadId: parentId,
              relationshipToParent: "subagent",
              rootThreadId: parentId,
            }),
            runEvent("run.created", "running"),
          ],
        });
        const terminal = yield* sink
          .write({ events: [runEvent("run.updated", "completed")] })
          .pipe(Effect.forkScoped);
        assert.isTrue(yield* Deferred.await(lookupEntered), "lineage read outside the transaction");
        const unrelated = yield* Deferred.succeed(writerStarted, undefined).pipe(
          Effect.andThen(
            sink.write({
              events: [
                thread(ThreadId.make("thread:metrics:sink:other"), {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: ThreadId.make("thread:metrics:sink:other"),
                }),
              ],
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(writerStarted);
        yield* Deferred.succeed(releaseLookup, undefined);

        const [terminalEvents, unrelatedEvents] = [
          yield* Fiber.join(terminal),
          yield* Fiber.join(unrelated),
        ];
        assert.strictEqual(terminalEvents.length, 1);
        assert.strictEqual(unrelatedEvents.length, 1);
        const counter = (yield* runSnapshots("p-sink")).find(
          (snapshot) => snapshot.id === "t3_runs_total",
        );
        assert.strictEqual(counter?.type === "Counter" ? counter.state.count : undefined, 1);
        assert.strictEqual(counter?.attributes?.["delegated"], "true");
      }).pipe(Effect.provide(layer));
    }),
  );
});
