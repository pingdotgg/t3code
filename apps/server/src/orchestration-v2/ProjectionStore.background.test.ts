import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const projectId = ProjectId.make("project:background-shell");

const createThread = Effect.fn("createThread")(function* (threadId: ThreadId) {
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
      title: "Scheduled run",
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

it.effect("flags the shells of threads a background run launched", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const background = ThreadId.make("thread:background-run");
    const regular = ThreadId.make("thread:regular");
    // The scheduler flags a run's thread before the thread exists.
    yield* sql`
      INSERT INTO scheduled_task_run_threads (thread_id, task_id, created_at)
      VALUES (${background}, 'scheduled-task:inbox', '2026-10-10T09:00:00.000Z')
    `;
    yield* createThread(background);
    yield* createThread(regular);

    const snapshot = yield* projectionStore.getShellSnapshot({ projectId });
    const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    assert.equal(byId.get(background)?.background, true);
    assert.equal(byId.get(regular)?.background, undefined);

    // The live shell stream reads one thread at a time through the same query.
    assert.equal((yield* projectionStore.getThreadShell(background))?.background, true);
    assert.equal((yield* projectionStore.getThreadShell(regular))?.background, undefined);
  }).pipe(Effect.provide(layerTest)),
);
