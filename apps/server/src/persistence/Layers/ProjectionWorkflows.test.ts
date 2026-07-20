import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  ThreadId,
  WorkflowArtifactId,
  WorkflowDefinition,
  WorkflowNodeId,
  WorkflowRunId,
  WorkflowWorkerConfig,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import { ProjectionWorkflowRepository } from "../Services/ProjectionWorkflows.ts";
import type { ProjectionWorkflowRun } from "../Services/ProjectionWorkflows.ts";
import { ProjectionWorkflowRepositoryLive } from "./ProjectionWorkflows.ts";

const now = "2026-07-17T20:00:00.000Z";

const definition: WorkflowDefinition = {
  id: "generic-worker",
  name: "Generic worker",
  nodes: [
    {
      id: WorkflowNodeId.make("worker"),
      title: "Investigate",
      prompt: "Investigate the scoped task and return a concise result.",
      contextPolicy: "summary",
    },
  ],
};

const workerConfig: WorkflowWorkerConfig = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
};

const makeRun = (id: string, status: ProjectionWorkflowRun["status"]): ProjectionWorkflowRun => ({
  id: WorkflowRunId.make(id),
  workflowId: "generic-worker",
  parentThreadId: ThreadId.make(`parent-${id}`),
  status,
  nodes: [
    {
      nodeId: WorkflowNodeId.make("worker"),
      status: status === "completed" ? "completed" : "pending",
      inputArtifactId: WorkflowArtifactId.make(`input-${id}`),
    },
  ],
  createdAt: now,
  updatedAt: now,
  definition,
  workerConfig,
});

const createSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      worker_config_json TEXT NOT NULL,
      final_artifact_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE projection_workflow_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_thread_id TEXT,
      input_artifact_id TEXT,
      result_artifact_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, node_id)
    )
  `;
  yield* sql`
    CREATE TABLE projection_workflow_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT,
      producer_thread_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});

const freshRepository = ProjectionWorkflowRepositoryLive.pipe(
  Layer.provideMerge(SqliteClient.layerMemory()),
);

const withSchema = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* createSchema;
    return yield* effect;
  }).pipe(Effect.provide(freshRepository));

it.effect("groups batched node rows per run for listAll", () =>
  withSchema(
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;

      yield* repository.upsertRun(makeRun("run-a", "running"));
      yield* repository.upsertRun(makeRun("run-b", "completed"));
      yield* repository.upsertRun(makeRun("run-c", "pending"));

      const all = yield* repository.listAll();
      assert.deepEqual(all.map((run) => run.id).toSorted(), ["run-a", "run-b", "run-c"]);
      for (const run of all) {
        assert.equal(run.nodes.length, 1);
        assert.equal(run.nodes[0]?.nodeId, "worker");
      }
    }),
  ),
);

it.effect("returns only pending/running runs with their nodes for listIncomplete", () =>
  withSchema(
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;

      yield* repository.upsertRun(makeRun("run-a", "running"));
      yield* repository.upsertRun(makeRun("run-b", "completed"));
      yield* repository.upsertRun(makeRun("run-c", "pending"));

      const incomplete = yield* repository.listIncomplete();
      assert.deepEqual(incomplete.map((run) => run.id).toSorted(), ["run-a", "run-c"]);
      for (const run of incomplete) {
        assert.equal(run.nodes.length, 1);
      }
    }),
  ),
);

it.effect("bounds shell history per parent while retaining active runs", () =>
  withSchema(
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;
      const parentThreadId = ThreadId.make("shared-parent");

      for (let index = 0; index < 25; index += 1) {
        const timestamp = `2026-07-17T20:${String(index).padStart(2, "0")}:00.000Z`;
        yield* repository.upsertRun({
          ...makeRun(`terminal-${String(index).padStart(2, "0")}`, "completed"),
          parentThreadId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      yield* repository.upsertRun({
        ...makeRun("active-old", "running"),
        parentThreadId,
        createdAt: "2026-07-17T19:00:00.000Z",
        updatedAt: "2026-07-17T19:00:00.000Z",
      });

      const snapshot = yield* repository.listShellSnapshot();

      assert.equal(snapshot.runs.length, 21);
      assert(snapshot.runs.some(({ run }) => run.id === "active-old"));
      assert.deepEqual(
        snapshot.runs.filter(({ run }) => run.status === "completed").map(({ run }) => run.id),
        Array.from(
          { length: 20 },
          (_, offset) => `terminal-${String(offset + 5).padStart(2, "0")}`,
        ),
      );
      assert.deepEqual(snapshot.artifacts, []);
    }),
  ),
);

it.effect("returns no runs when the table is empty", () =>
  withSchema(
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkflowRepository;

      assert.deepEqual(yield* repository.listAll(), []);
      assert.deepEqual(yield* repository.listIncomplete(), []);
      assert.deepEqual(yield* repository.listShellSnapshot(), { runs: [], artifacts: [] });
    }),
  ),
);
