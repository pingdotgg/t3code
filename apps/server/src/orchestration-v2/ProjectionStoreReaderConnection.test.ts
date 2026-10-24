import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const providerInstanceId = modelSelection.instanceId;
const projectId = ProjectId.make("project:reader");

/**
 * A tracer that records the connection each statement ran on.
 *
 * `nodeSqliteClient` stamps `db.connection` on the span of the transaction that
 * acquired the connection - "reader" for the reader worker, "writer" for the
 * main connection - but only when the span is a real one. So a read has to run
 * under a tracer for the attribute to exist at all.
 */
const makeConnectionRecorder = () => {
  const connections: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const connection = span.attributes.get("db.connection");
        // Only the spans that acquired a connection carry the attribute; the
        // statement spans inside a transaction do not.
        if (typeof connection === "string") connections.push(connection);
      };
      return span;
    },
  });
  return { connections, tracer };
};

/**
 * A file-backed database, because the reader worker is a second connection and
 * an in-memory database cannot be shared between two of them.
 */
const fileBackedLayer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "projection-reader-" });
  return SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
}).pipe(Layer.unwrap, Layer.provide(NodeServices.layer));

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(fileBackedLayer)),
  fileBackedLayer,
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projectionStore.apply({
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  });

it.effect("the thread-record read runs on the reader connection", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:reader:records");
    yield* createThread(threadId);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const { connections, tracer } = makeConnectionRecorder();
    connections.length = 0;

    yield* projectionStore
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      );

    // The point of the change: a pure read must not queue behind the writes
    // that the same load is producing.
    assert.deepEqual(connections, ["reader"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the thread-shell read runs on the reader connection", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:reader:shell");
    yield* createThread(threadId);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const { connections, tracer } = makeConnectionRecorder();
    connections.length = 0;

    yield* projectionStore
      .getThreadShell(threadId)
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      );

    assert.deepEqual(connections, ["reader"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the shell-snapshot read runs on the reader connection", () =>
  Effect.gen(function* () {
    yield* createThread(ThreadId.make("thread:reader:snapshot"));
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const { connections, tracer } = makeConnectionRecorder();
    connections.length = 0;

    yield* projectionStore
      .getShellSnapshot({ projectId, location: "active" })
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      );

    assert.deepEqual(connections, ["reader"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the startup-recovery read runs on the reader connection", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:reader:recovery");
    yield* createThread(threadId);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const { connections, tracer } = makeConnectionRecorder();
    connections.length = 0;

    yield* projectionStore
      .getRecoveryThreadIds("queued-runs")
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      );

    // Startup recovery must not take the write lock.
    assert.deepEqual(connections, ["reader"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the settlement-sweep read runs on the reader connection", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:reader:settlement");
    yield* createThread(threadId);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const { connections, tracer } = makeConnectionRecorder();
    connections.length = 0;

    yield* projectionStore
      .getSettlementCandidates(threadId)
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      );

    // The auto-settlement sweep must not take the write lock.
    assert.deepEqual(connections, ["reader"]);
  }).pipe(Effect.provide(layerTest)),
);
