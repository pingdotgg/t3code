import {
  IsoDateTime,
  ThreadId,
  WorkflowArtifact,
  WorkflowArtifactId,
  WorkflowDefinition,
  WorkflowNodeId,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowWorkerConfig,
} from "@t3tools/contracts";
import { Context, Effect, Option, Schema } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkflowRun = Schema.Struct({
  ...WorkflowRun.fields,
  definition: WorkflowDefinition,
  workerConfig: WorkflowWorkerConfig,
});
export type ProjectionWorkflowRun = typeof ProjectionWorkflowRun.Type;

export const GetProjectionWorkflowRunInput = Schema.Struct({
  runId: WorkflowRunId,
});
export type GetProjectionWorkflowRunInput = typeof GetProjectionWorkflowRunInput.Type;

export const ProjectionWorkflowNodeStart = Schema.Struct({
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  workerThreadId: ThreadId,
  startedAt: IsoDateTime,
});
export type ProjectionWorkflowNodeStart = typeof ProjectionWorkflowNodeStart.Type;

export const ProjectionWorkflowNodeResult = Schema.Struct({
  runId: WorkflowRunId,
  artifact: WorkflowArtifact,
  completedAt: IsoDateTime,
});
export type ProjectionWorkflowNodeResult = typeof ProjectionWorkflowNodeResult.Type;

export const ProjectionWorkflowRunFinalization = Schema.Struct({
  runId: WorkflowRunId,
  artifact: WorkflowArtifact,
  status: Schema.Literals(["completed", "failed"]),
  completedAt: IsoDateTime,
});
export type ProjectionWorkflowRunFinalization = typeof ProjectionWorkflowRunFinalization.Type;

export const ProjectionWorkflowNodeInputArtifact = Schema.Struct({
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  artifactId: WorkflowArtifactId,
  updatedAt: IsoDateTime,
});
export type ProjectionWorkflowNodeInputArtifact = typeof ProjectionWorkflowNodeInputArtifact.Type;

export const GetProjectionWorkflowArtifactInput = Schema.Struct({
  artifactId: WorkflowArtifactId,
});
export type GetProjectionWorkflowArtifactInput = typeof GetProjectionWorkflowArtifactInput.Type;

export interface ProjectionWorkflowShellSnapshot {
  readonly runs: ReadonlyArray<{
    readonly run: WorkflowRun;
    readonly definition: WorkflowDefinition;
  }>;
  readonly artifacts: ReadonlyArray<WorkflowArtifact>;
}

export interface ProjectionWorkflowRepositoryShape {
  readonly upsertRun: (
    run: ProjectionWorkflowRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByRunId: (
    input: GetProjectionWorkflowRunInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkflowRun>, ProjectionRepositoryError>;
  readonly listIncomplete: () => Effect.Effect<
    ReadonlyArray<ProjectionWorkflowRun>,
    ProjectionRepositoryError
  >;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionWorkflowRun>,
    ProjectionRepositoryError
  >;
  readonly listShellSnapshot: () => Effect.Effect<
    ProjectionWorkflowShellSnapshot,
    ProjectionRepositoryError
  >;
  readonly upsertArtifact: (
    artifact: WorkflowArtifact,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getArtifactById: (
    input: GetProjectionWorkflowArtifactInput,
  ) => Effect.Effect<Option.Option<WorkflowArtifact>, ProjectionRepositoryError>;
  readonly listAllArtifacts: () => Effect.Effect<
    ReadonlyArray<WorkflowArtifact>,
    ProjectionRepositoryError
  >;
  readonly setNodeInputArtifact: (
    input: ProjectionWorkflowNodeInputArtifact,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly startNode: (
    input: ProjectionWorkflowNodeStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly recordNodeResult: (
    input: ProjectionWorkflowNodeResult,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly finalizeRun: (
    input: ProjectionWorkflowRunFinalization,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionWorkflowRepository extends Context.Service<
  ProjectionWorkflowRepository,
  ProjectionWorkflowRepositoryShape
>()("t3/persistence/Services/ProjectionWorkflows/ProjectionWorkflowRepository") {}

export const isIncompleteWorkflowRun = (status: WorkflowRunStatus): boolean =>
  status === "pending" || status === "running";

export const toWorkflowRun = (input: {
  readonly run: Omit<ProjectionWorkflowRun, "nodes">;
  readonly nodes: ReadonlyArray<WorkflowNodeRun>;
}): ProjectionWorkflowRun => ({
  ...input.run,
  nodes: [...input.nodes],
});
