import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as FileHistory from "./FileHistory.ts";

const layerTest = FileHistory.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const checkpoint = (
  threadId: ThreadId,
  ordinal: number,
  files: ReadonlyArray<{ path: string; additions?: number; deletions?: number; kind?: string }>,
): OrchestrationV2DomainEvent => {
  const nodeId = NodeId.make(`node:${threadId}`);
  return {
    id: EventId.make(`checkpoint:${threadId}:${ordinal}`),
    type: "checkpoint.captured",
    threadId,
    nodeId,
    driver,
    providerInstanceId,
    occurredAt: at(ordinal),
    payload: {
      id: CheckpointId.make(`checkpoint:${threadId}:${ordinal}`),
      threadId,
      scopeId: CheckpointScopeId.make(`scope:${threadId}`),
      runId: null,
      nodeId,
      parentCheckpointId: null,
      ordinalWithinScope: ordinal,
      appRunOrdinal: null,
      ref: CheckpointRef.make(`ref:${threadId}:${ordinal}`),
      status: "ready",
      files: files.map((file) => ({
        path: file.path,
        kind: file.kind ?? "modified",
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      })),
      capturedAt: at(ordinal),
    },
  };
};

it.layer(layerTest)("FileHistory", (it) => {
  it.effect(
    "lists threads whose checkpoints included the file, scoped to its project and labelled present at checkpoint",
    () =>
      Effect.gen(function* () {
        const history = yield* FileHistory.FileHistory;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const app = ProjectId.make("app");
        const other = ProjectId.make("other");
        yield* createProject(app);
        yield* createProject(other);
        const working = ThreadId.make("working");
        const archived = ThreadId.make("archived");
        const deleted = ThreadId.make("deleted");
        const elsewhere = ThreadId.make("elsewhere");
        const unrelated = ThreadId.make("unrelated");
        yield* projections.apply(thread(working, app));
        yield* projections.apply(thread(archived, app, { archivedAt: at(30) }));
        yield* projections.apply(thread(deleted, app, { deletedAt: at(30) }));
        yield* projections.apply(thread(elsewhere, other));
        yield* projections.apply(thread(unrelated, app));
        yield* projections.apply(
          checkpoint(working, 1, [
            { path: "src/a.ts", additions: 3, deletions: 1 },
            { path: "src/b.ts" },
          ]),
        );
        yield* projections.apply(checkpoint(working, 2, [{ path: "src/a.ts", additions: 1 }]));
        yield* projections.apply(checkpoint(archived, 3, [{ path: "src/a.ts" }]));
        yield* projections.apply(checkpoint(deleted, 4, [{ path: "src/a.ts" }]));
        yield* projections.apply(checkpoint(elsewhere, 5, [{ path: "src/a.ts" }]));
        yield* projections.apply(checkpoint(unrelated, 6, [{ path: "src/b.ts" }]));

        const first = yield* history.read({ projectId: app, path: "./src/a.ts" });
        assert.equal(first.relation, "present-at-checkpoint");
        assert.deepEqual(first.index, { state: "complete", pendingCheckpoints: 0 });
        assert.deepEqual(
          first.entries.map((entry) => [entry.threadId, entry.checkpoints, entry.archived]),
          [
            [archived, 1, true],
            [working, 2, false],
          ],
        );
        assert.deepInclude(first.entries[1], { additions: 4, deletions: 1 });

        // A later checkpoint is picked up on the next read without re-reading the others.
        yield* projections.apply(
          checkpoint(working, 7, [{ path: "src/a.ts", kind: "deleted", deletions: 9 }]),
        );
        const second = yield* history.read({ projectId: app, path: "src/a.ts", limit: 1 });
        assert.equal(second.limitReached, true);
        assert.deepInclude(second.entries[0], {
          threadId: working,
          checkpoints: 3,
          lastKind: "deleted",
        });

        // The index is a cache: dropping it rebuilds the same answer.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM project_code_checkpoint_files`;
        yield* sql`DELETE FROM project_code_checkpoint_marks`;
        const rebuilt = yield* history.read({ projectId: app, path: "src/a.ts" });
        assert.deepEqual(
          rebuilt.entries.map((entry) => entry.threadId),
          [working, archived],
        );

        const missing = yield* history
          .read({ projectId: ProjectId.make("missing"), path: "src/a.ts" })
          .pipe(Effect.flip);
        assert.equal(missing._tag, "FileHistoryProjectNotFound");
      }),
  );

  it.effect("indexes every file of a checkpoint larger than one indexing page", () =>
    Effect.gen(function* () {
      const history = yield* FileHistory.FileHistory;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("large");
      const large = ThreadId.make("large-thread");
      yield* createProject(project);
      yield* projections.apply(thread(large, project));
      yield* projections.apply(
        checkpoint(
          large,
          1,
          Array.from({ length: 4_500 }, (_, index) => ({ path: `vendor/f${index}.ts` })),
        ),
      );
      const tail = yield* history.read({ projectId: project, path: "vendor/f4499.ts" });
      assert.deepEqual(
        tail.entries.map((entry) => entry.threadId),
        [large],
      );
      assert.deepEqual(tail.index, { state: "complete", pendingCheckpoints: 0 });
    }),
  );

  it.effect(
    "shares each indexing batch's file budget across checkpoints and resumes later reads",
    () =>
      Effect.gen(function* () {
        const history = yield* FileHistory.FileHistory;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const project = ProjectId.make("backlog");
        const working = ThreadId.make("backlog-thread");
        yield* createProject(project);
        yield* projections.apply(thread(working, project));
        const files = Array.from({ length: 20_001 }, (_, index) => ({
          path: `vendor/f${index}.ts`,
        }));
        yield* projections.apply(checkpoint(working, 1, files));
        yield* projections.apply(checkpoint(working, 2, files));

        const first = yield* history.read({ projectId: project, path: "vendor/f20000.ts" });
        assert.deepEqual(first.index, { state: "catching-up", pendingCheckpoints: 1 });
        assert.equal(first.entries[0]?.checkpoints, 1);

        const resumed = yield* history.read({ projectId: project, path: "vendor/f20000.ts" });
        assert.deepEqual(resumed.index, { state: "complete", pendingCheckpoints: 0 });
        assert.equal(resumed.entries[0]?.checkpoints, 2);
        assert.equal(resumed.entries[0]?.threadId, working);
      }),
  );
});
