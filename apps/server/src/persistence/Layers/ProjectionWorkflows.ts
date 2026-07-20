import {
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
  WorkflowArtifactId,
  WorkflowArtifactPayload,
  WorkflowDefinition,
  WorkflowNodeId,
  WorkflowNodeStatus,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowWorkerConfig,
} from "@t3tools/contracts";
import type { WorkflowNodeRun } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionWorkflowArtifactInput,
  GetProjectionWorkflowRunInput,
  ProjectionWorkflowRepository,
  type ProjectionWorkflowRepositoryShape,
  toWorkflowRun,
} from "../Services/ProjectionWorkflows.ts";

const ProjectionWorkflowRunDbRow = Schema.Struct({
  runId: WorkflowRunId,
  workflowId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  status: WorkflowRunStatus,
  definition: Schema.fromJsonString(WorkflowDefinition),
  workerConfig: Schema.fromJsonString(WorkflowWorkerConfig),
  finalArtifactId: Schema.NullOr(WorkflowArtifactId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});

const ProjectionWorkflowShellRunDbRow = Schema.Struct({
  runId: WorkflowRunId,
  workflowId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  status: WorkflowRunStatus,
  definition: Schema.fromJsonString(WorkflowDefinition),
  finalArtifactId: Schema.NullOr(WorkflowArtifactId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});

const ProjectionWorkflowNodeDbRow = Schema.Struct({
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  status: WorkflowNodeStatus,
  workerThreadId: Schema.NullOr(ThreadId),
  inputArtifactId: Schema.NullOr(WorkflowArtifactId),
  resultArtifactId: Schema.NullOr(WorkflowArtifactId),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});

const ProjectionWorkflowArtifactDbRow = Schema.Struct({
  id: WorkflowArtifactId,
  runId: WorkflowRunId,
  nodeId: Schema.NullOr(WorkflowNodeId),
  producerThreadId: Schema.NullOr(ThreadId),
  payload: Schema.fromJsonString(WorkflowArtifactPayload),
  createdAt: IsoDateTime,
});
type ProjectionWorkflowArtifactDbRow = typeof ProjectionWorkflowArtifactDbRow.Type;

type ProjectionWorkflowRunDbRow = typeof ProjectionWorkflowRunDbRow.Type;
type ProjectionWorkflowShellRunDbRow = typeof ProjectionWorkflowShellRunDbRow.Type;
type ProjectionWorkflowNodeDbRow = typeof ProjectionWorkflowNodeDbRow.Type;

const runInput = Schema.Struct({ runId: WorkflowRunId });
const runIdsInput = Schema.Struct({ runIds: Schema.Array(WorkflowRunId) });
const SHELL_WORKFLOW_HISTORY_PER_PARENT = 20;

function mapNode(row: ProjectionWorkflowNodeDbRow): WorkflowNodeRun {
  return {
    nodeId: row.nodeId,
    status: row.status,
    ...(row.workerThreadId === null ? {} : { workerThreadId: row.workerThreadId }),
    ...(row.inputArtifactId === null ? {} : { inputArtifactId: row.inputArtifactId }),
    ...(row.resultArtifactId === null ? {} : { resultArtifactId: row.resultArtifactId }),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  };
}

function mapRun(
  row: ProjectionWorkflowRunDbRow,
  nodes: ReadonlyArray<ProjectionWorkflowNodeDbRow>,
) {
  return toWorkflowRun({
    run: {
      id: row.runId,
      workflowId: row.workflowId,
      parentThreadId: row.parentThreadId,
      status: row.status,
      ...(row.finalArtifactId === null ? {} : { finalArtifactId: row.finalArtifactId }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
      definition: row.definition,
      workerConfig: row.workerConfig,
    },
    nodes: nodes.map(mapNode),
  });
}

function mapShellRun(
  row: ProjectionWorkflowShellRunDbRow,
  nodes: ReadonlyArray<ProjectionWorkflowNodeDbRow>,
) {
  return {
    run: {
      id: row.runId,
      workflowId: row.workflowId,
      parentThreadId: row.parentThreadId,
      status: row.status,
      nodes: nodes.map(mapNode),
      ...(row.finalArtifactId === null ? {} : { finalArtifactId: row.finalArtifactId }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    },
    definition: row.definition,
  };
}

function mapArtifact(row: ProjectionWorkflowArtifactDbRow) {
  return {
    id: row.id,
    runId: row.runId,
    ...(row.nodeId === null ? {} : { nodeId: row.nodeId }),
    ...(row.producerThreadId === null ? {} : { producerThreadId: row.producerThreadId }),
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

const makeProjectionWorkflowRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRunRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkflowRunInput,
    Result: ProjectionWorkflowRunDbRow,
    execute: ({ runId }) =>
      sql`
        SELECT
          run_id AS "runId",
          workflow_id AS "workflowId",
          parent_thread_id AS "parentThreadId",
          status,
          definition_json AS definition,
          worker_config_json AS "workerConfig",
          final_artifact_id AS "finalArtifactId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_workflow_runs
        WHERE run_id = ${runId}
      `,
  });

  const listIncompleteRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkflowRunDbRow,
    execute: () =>
      sql`
        SELECT
          run_id AS "runId",
          workflow_id AS "workflowId",
          parent_thread_id AS "parentThreadId",
          status,
          definition_json AS definition,
          worker_config_json AS "workerConfig",
          final_artifact_id AS "finalArtifactId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_workflow_runs
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const listAllRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkflowRunDbRow,
    execute: () =>
      sql`
        SELECT
          run_id AS "runId",
          workflow_id AS "workflowId",
          parent_thread_id AS "parentThreadId",
          status,
          definition_json AS definition,
          worker_config_json AS "workerConfig",
          final_artifact_id AS "finalArtifactId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_workflow_runs
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const listShellRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkflowShellRunDbRow,
    execute: () =>
      sql`
        WITH ranked_runs AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                parent_thread_id,
                CASE
                  WHEN status IN ('pending', 'running') THEN 'active'
                  ELSE 'terminal'
                END
              ORDER BY created_at DESC, run_id DESC
            ) AS status_rank
          FROM projection_workflow_runs
        )
        SELECT
          run_id AS "runId",
          workflow_id AS "workflowId",
          parent_thread_id AS "parentThreadId",
          status,
          definition_json AS definition,
          final_artifact_id AS "finalArtifactId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM ranked_runs
        WHERE
          status IN ('pending', 'running')
          OR status_rank <= ${SHELL_WORKFLOW_HISTORY_PER_PARENT}
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const listNodeRows = SqlSchema.findAll({
    Request: runInput,
    Result: ProjectionWorkflowNodeDbRow,
    execute: ({ runId }) =>
      sql`
        SELECT
          run_id AS "runId",
          node_id AS "nodeId",
          status,
          worker_thread_id AS "workerThreadId",
          input_artifact_id AS "inputArtifactId",
          result_artifact_id AS "resultArtifactId",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_workflow_nodes
        WHERE run_id = ${runId}
        ORDER BY node_id ASC
      `,
  });

  const listNodeRowsForRuns = SqlSchema.findAll({
    Request: runIdsInput,
    Result: ProjectionWorkflowNodeDbRow,
    execute: ({ runIds }) =>
      sql`
        SELECT
          run_id AS "runId",
          node_id AS "nodeId",
          status,
          worker_thread_id AS "workerThreadId",
          input_artifact_id AS "inputArtifactId",
          result_artifact_id AS "resultArtifactId",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_workflow_nodes
        WHERE ${sql.in("run_id", runIds)}
        ORDER BY node_id ASC
      `,
  });

  const listShellArtifactRows = SqlSchema.findAll({
    Request: runIdsInput,
    Result: ProjectionWorkflowArtifactDbRow,
    execute: ({ runIds }) =>
      sql`
        SELECT
          artifact_id AS id,
          run_id AS "runId",
          node_id AS "nodeId",
          producer_thread_id AS "producerThreadId",
          payload_json AS payload,
          created_at AS "createdAt"
        FROM projection_workflow_artifacts
        WHERE
          ${sql.in("run_id", runIds)}
          AND (
            artifact_id IN (
              SELECT result_artifact_id
              FROM projection_workflow_nodes
              WHERE ${sql.in("run_id", runIds)}
                AND result_artifact_id IS NOT NULL
            )
            OR artifact_id IN (
              SELECT final_artifact_id
              FROM projection_workflow_runs
              WHERE ${sql.in("run_id", runIds)}
                AND final_artifact_id IS NOT NULL
            )
          )
        ORDER BY created_at ASC, artifact_id ASC
      `,
  });

  const mapRunsWithNodes = (rows: ReadonlyArray<ProjectionWorkflowRunDbRow>) =>
    rows.length === 0
      ? Effect.succeed([])
      : listNodeRowsForRuns({ runIds: rows.map((row) => row.runId) }).pipe(
          Effect.map((nodeRows) => {
            const nodesByRun = new Map<WorkflowRunId, ProjectionWorkflowNodeDbRow[]>();
            for (const node of nodeRows) {
              const existing = nodesByRun.get(node.runId);
              if (existing) {
                existing.push(node);
              } else {
                nodesByRun.set(node.runId, [node]);
              }
            }
            return rows.map((row) => mapRun(row, nodesByRun.get(row.runId) ?? []));
          }),
        );

  const getArtifactRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkflowArtifactInput,
    Result: ProjectionWorkflowArtifactDbRow,
    execute: ({ artifactId }) =>
      sql`
        SELECT
          artifact_id AS id,
          run_id AS "runId",
          node_id AS "nodeId",
          producer_thread_id AS "producerThreadId",
          payload_json AS payload,
          created_at AS "createdAt"
        FROM projection_workflow_artifacts
        WHERE artifact_id = ${artifactId}
      `,
  });

  const listAllArtifactRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkflowArtifactDbRow,
    execute: () =>
      sql`
        SELECT
          artifact_id AS id,
          run_id AS "runId",
          node_id AS "nodeId",
          producer_thread_id AS "producerThreadId",
          payload_json AS payload,
          created_at AS "createdAt"
        FROM projection_workflow_artifacts
        ORDER BY created_at ASC, artifact_id ASC
      `,
  });

  const getByRunId: ProjectionWorkflowRepositoryShape["getByRunId"] = (input) =>
    getRunRow(input).pipe(
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) =>
            listNodeRows({ runId: value.runId }).pipe(
              Effect.map((nodes) => Option.some(mapRun(value, nodes))),
            ),
        }),
      ),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.getByRunId:query")),
    );

  const listIncomplete: ProjectionWorkflowRepositoryShape["listIncomplete"] = () =>
    listIncompleteRunRows(undefined).pipe(
      Effect.flatMap(mapRunsWithNodes),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.listIncomplete:query")),
    );

  const listAll: ProjectionWorkflowRepositoryShape["listAll"] = () =>
    listAllRunRows(undefined).pipe(
      Effect.flatMap(mapRunsWithNodes),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.listAll:query")),
    );

  const listShellSnapshot: ProjectionWorkflowRepositoryShape["listShellSnapshot"] = () =>
    listShellRunRows(undefined).pipe(
      Effect.flatMap((runRows) => {
        if (runRows.length === 0) {
          return Effect.succeed({ runs: [], artifacts: [] });
        }
        const runIds = runRows.map((row) => row.runId);
        return Effect.all([listNodeRowsForRuns({ runIds }), listShellArtifactRows({ runIds })], {
          concurrency: "unbounded",
        }).pipe(
          Effect.map(([nodeRows, artifactRows]) => {
            const nodesByRun = new Map<WorkflowRunId, ProjectionWorkflowNodeDbRow[]>();
            for (const node of nodeRows) {
              const existing = nodesByRun.get(node.runId);
              if (existing) {
                existing.push(node);
              } else {
                nodesByRun.set(node.runId, [node]);
              }
            }
            return {
              runs: runRows.map((row) => mapShellRun(row, nodesByRun.get(row.runId) ?? [])),
              artifacts: artifactRows.map(mapArtifact),
            };
          }),
        );
      }),
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkflowRepository.listShellSnapshot:query"),
      ),
    );

  const upsertRun: ProjectionWorkflowRepositoryShape["upsertRun"] = (run) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO projection_workflow_runs (
          run_id,
          workflow_id,
          parent_thread_id,
          status,
          definition_json,
          worker_config_json,
          final_artifact_id,
          created_at,
          updated_at,
          completed_at
        )
        VALUES (
          ${run.id},
          ${run.workflowId},
          ${run.parentThreadId},
          ${run.status},
          ${JSON.stringify(run.definition)},
          ${JSON.stringify(run.workerConfig)},
          ${run.finalArtifactId ?? null},
          ${run.createdAt},
          ${run.updatedAt},
          ${run.completedAt ?? null}
        )
        ON CONFLICT (run_id)
        DO UPDATE SET
          workflow_id = excluded.workflow_id,
          parent_thread_id = excluded.parent_thread_id,
          definition_json = excluded.definition_json,
          worker_config_json = excluded.worker_config_json
      `;
      yield* Effect.forEach(
        run.nodes,
        (node) =>
          sql`
            INSERT INTO projection_workflow_nodes (
              run_id,
              node_id,
              status,
              worker_thread_id,
              input_artifact_id,
              result_artifact_id,
              started_at,
              completed_at
            )
            VALUES (
              ${run.id},
              ${node.nodeId},
              ${node.status},
              ${node.workerThreadId ?? null},
              ${node.inputArtifactId ?? null},
              ${node.resultArtifactId ?? null},
              ${node.startedAt ?? null},
              ${node.completedAt ?? null}
            )
            ON CONFLICT (run_id, node_id) DO NOTHING
          `,
        { concurrency: 1 },
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.upsertRun:query")));

  const upsertArtifact: ProjectionWorkflowRepositoryShape["upsertArtifact"] = (artifact) =>
    sql`
      INSERT INTO projection_workflow_artifacts (
        artifact_id,
        run_id,
        node_id,
        producer_thread_id,
        payload_json,
        created_at
      )
      VALUES (
        ${artifact.id},
        ${artifact.runId},
        ${artifact.nodeId ?? null},
        ${artifact.producerThreadId ?? null},
        ${JSON.stringify(artifact.payload)},
        ${artifact.createdAt}
      )
      ON CONFLICT (artifact_id)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        producer_thread_id = excluded.producer_thread_id
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.upsertArtifact:query")),
    );

  const getArtifactById: ProjectionWorkflowRepositoryShape["getArtifactById"] = (input) =>
    getArtifactRow(input).pipe(
      Effect.map((row) => Option.map(row, mapArtifact)),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.getArtifactById:query")),
    );

  const listAllArtifacts: ProjectionWorkflowRepositoryShape["listAllArtifacts"] = () =>
    listAllArtifactRows(undefined).pipe(
      Effect.map((rows) => rows.map(mapArtifact)),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.listAllArtifacts:query")),
    );

  const setNodeInputArtifact: ProjectionWorkflowRepositoryShape["setNodeInputArtifact"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE projection_workflow_nodes
        SET input_artifact_id = ${input.artifactId}
        WHERE run_id = ${input.runId}
          AND node_id = ${input.nodeId}
      `;
      yield* sql`
        UPDATE projection_workflow_runs
        SET updated_at = ${input.updatedAt}
        WHERE run_id = ${input.runId}
      `;
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkflowRepository.setNodeInputArtifact:query"),
      ),
    );

  const startNode: ProjectionWorkflowRepositoryShape["startNode"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE projection_workflow_nodes
        SET
          status = 'running',
          worker_thread_id = ${input.workerThreadId},
          started_at = ${input.startedAt}
        WHERE run_id = ${input.runId}
          AND node_id = ${input.nodeId}
      `;
      yield* sql`
        UPDATE projection_workflow_runs
        SET
          status = 'running',
          updated_at = ${input.startedAt}
        WHERE run_id = ${input.runId}
      `;
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.startNode:query")));

  const recordNodeResult: ProjectionWorkflowRepositoryShape["recordNodeResult"] = (input) =>
    Effect.gen(function* () {
      if (input.artifact.nodeId === undefined || input.artifact.payload.kind !== "worker-result") {
        return;
      }
      yield* sql`
        UPDATE projection_workflow_nodes
        SET
          status = ${input.artifact.payload.status},
          result_artifact_id = ${input.artifact.id},
          completed_at = ${input.completedAt}
        WHERE run_id = ${input.runId}
          AND node_id = ${input.artifact.nodeId}
      `;
      yield* sql`
        UPDATE projection_workflow_runs
        SET updated_at = ${input.completedAt}
        WHERE run_id = ${input.runId}
      `;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.recordNodeResult:query")),
    );

  const finalizeRun: ProjectionWorkflowRepositoryShape["finalizeRun"] = (input) =>
    Effect.gen(function* () {
      if (input.status === "failed") {
        yield* sql`
          UPDATE projection_workflow_nodes
          SET status = 'failed', completed_at = ${input.completedAt}
          WHERE run_id = ${input.runId}
            AND status = 'pending'
        `;
      }
      yield* sql`
        UPDATE projection_workflow_runs
        SET
          status = ${input.status},
          final_artifact_id = ${input.artifact.id},
          updated_at = ${input.completedAt},
          completed_at = ${input.completedAt}
        WHERE run_id = ${input.runId}
      `;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.finalizeRun:query")),
    );

  return {
    upsertRun,
    getByRunId,
    listIncomplete,
    listAll,
    listShellSnapshot,
    upsertArtifact,
    getArtifactById,
    listAllArtifacts,
    setNodeInputArtifact,
    startNode,
    recordNodeResult,
    finalizeRun,
  } satisfies ProjectionWorkflowRepositoryShape;
});

export const ProjectionWorkflowRepositoryLive = Layer.effect(
  ProjectionWorkflowRepository,
  makeProjectionWorkflowRepository,
);
