import { Effect, Schema } from "effect";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import {
  SandboxDescriptor,
  SandboxId,
  SandboxRuntimeSelection,
  SandboxServiceDescriptor,
  SandboxServiceRequest,
} from "./sandbox.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";

export const ExecutionRunId = TrimmedNonEmptyString;
export type ExecutionRunId = typeof ExecutionRunId.Type;

export const ControlThreadExternalId = TrimmedNonEmptyString;
export type ControlThreadExternalId = typeof ControlThreadExternalId.Type;

export const ExecutionRunLifecycleType = Schema.Literals([
  "started",
  "completed",
  "failed",
  "interrupted",
]);
export type ExecutionRunLifecycleType = typeof ExecutionRunLifecycleType.Type;

export const ExecutionRunCreateRequest = Schema.Struct({
  controlThreadId: ControlThreadExternalId,
  executionRunId: ExecutionRunId,
  initialPrompt: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
});
export type ExecutionRunCreateRequest = typeof ExecutionRunCreateRequest.Type;

export const ExecutionRunCreateResponse = Schema.Struct({
  controlThreadId: ControlThreadExternalId,
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
  acceptedAt: IsoDateTime,
});
export type ExecutionRunCreateResponse = typeof ExecutionRunCreateResponse.Type;

export const ExecutionRunLifecycleEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  controlThreadId: ControlThreadExternalId,
  executionRunId: ExecutionRunId,
  type: ExecutionRunLifecycleType,
  occurredAt: IsoDateTime,
  t3ThreadId: Schema.optional(ThreadId),
  t3TurnId: Schema.optional(TurnId),
  failureSummary: Schema.optional(TrimmedNonEmptyString),
});
export type ExecutionRunLifecycleEvent = typeof ExecutionRunLifecycleEvent.Type;

export const ExecutionRunStatusQuery = Schema.Struct({
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
});
export type ExecutionRunStatusQuery = typeof ExecutionRunStatusQuery.Type;

export const ExecutionRunStatusResponse = Schema.Struct({
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
  sessionStatus: TrimmedNonEmptyString,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  found: Schema.Boolean,
});
export type ExecutionRunStatusResponse = typeof ExecutionRunStatusResponse.Type;

export const ExecutionRunContinueRequest = Schema.Struct({
  controlThreadId: ControlThreadExternalId,
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
  prompt: Schema.String,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
});
export type ExecutionRunContinueRequest = typeof ExecutionRunContinueRequest.Type;

export const ExecutionRunContinueResponse = Schema.Struct({
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
  acceptedAt: IsoDateTime,
});
export type ExecutionRunContinueResponse = typeof ExecutionRunContinueResponse.Type;

export const ExecutionRunInterruptRequest = Schema.Struct({
  controlThreadId: ControlThreadExternalId,
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
});
export type ExecutionRunInterruptRequest = typeof ExecutionRunInterruptRequest.Type;

export const ExecutionRunInterruptResponse = Schema.Struct({
  executionRunId: ExecutionRunId,
  t3ThreadId: ThreadId,
  acceptedAt: IsoDateTime,
});
export type ExecutionRunInterruptResponse = typeof ExecutionRunInterruptResponse.Type;

export const ExecutionRunActivityType = Schema.Literals(["thought", "action", "error"]);
export type ExecutionRunActivityType = typeof ExecutionRunActivityType.Type;

export const ExecutionRunActivityEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  controlThreadId: ControlThreadExternalId,
  executionRunId: ExecutionRunId,
  activity: Schema.Struct({
    type: ExecutionRunActivityType,
    body: Schema.optional(Schema.String),
    action: Schema.optional(Schema.String),
    parameter: Schema.optional(Schema.String),
    ephemeral: Schema.optional(Schema.Boolean),
  }),
  occurredAt: IsoDateTime,
});
export type ExecutionRunActivityEvent = typeof ExecutionRunActivityEvent.Type;

export const TaskRuntimeMaterializationId = TrimmedNonEmptyString;
export type TaskRuntimeMaterializationId = typeof TaskRuntimeMaterializationId.Type;

export const TaskRuntimeMaterializeRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  initialPrompt: Schema.String,
  project: Schema.Struct({
    repoName: TrimmedNonEmptyString,
    workspaceRoot: TrimmedNonEmptyString,
    defaultBranch: TrimmedNonEmptyString,
    projectKey: Schema.optional(TrimmedNonEmptyString),
  }),
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  startCodingAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sandbox: Schema.optional(SandboxRuntimeSelection),
  services: Schema.optional(Schema.Array(SandboxServiceRequest)),
  idempotencyKey: Schema.optional(TrimmedNonEmptyString),
});
export type TaskRuntimeMaterializeRequest = typeof TaskRuntimeMaterializeRequest.Type;

export const TaskRuntimeMaterializeResponse = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  t3ProjectId: ProjectId,
  t3ThreadId: ThreadId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  acceptedAt: IsoDateTime,
  sandbox: Schema.optional(SandboxDescriptor),
  environment: Schema.optional(ExecutionEnvironmentDescriptor),
  services: Schema.optional(Schema.Array(SandboxServiceDescriptor)),
});
export type TaskRuntimeMaterializeResponse = typeof TaskRuntimeMaterializeResponse.Type;

export const TaskRuntimeReconnectRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  sandboxId: SandboxId,
});
export type TaskRuntimeReconnectRequest = typeof TaskRuntimeReconnectRequest.Type;

export const TaskRuntimeReconnectResponse = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  sandbox: SandboxDescriptor,
  environment: ExecutionEnvironmentDescriptor,
  services: Schema.Array(SandboxServiceDescriptor),
  acceptedAt: IsoDateTime,
});
export type TaskRuntimeReconnectResponse = typeof TaskRuntimeReconnectResponse.Type;

export const TaskRuntimeArchiveRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  sandboxId: SandboxId,
});
export type TaskRuntimeArchiveRequest = typeof TaskRuntimeArchiveRequest.Type;

export const TaskRuntimeArchiveResponse = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  sandbox: SandboxDescriptor,
  archivedAt: IsoDateTime,
});
export type TaskRuntimeArchiveResponse = typeof TaskRuntimeArchiveResponse.Type;

export const TaskRuntimeSandboxStatusQuery = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  sandboxId: SandboxId,
});
export type TaskRuntimeSandboxStatusQuery = typeof TaskRuntimeSandboxStatusQuery.Type;

export const TaskRuntimeSandboxStatusResponse = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  sandbox: SandboxDescriptor,
  services: Schema.Array(SandboxServiceDescriptor),
  refreshedAt: IsoDateTime,
});
export type TaskRuntimeSandboxStatusResponse = typeof TaskRuntimeSandboxStatusResponse.Type;

export const TaskRuntimeLifecycleEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  type: ExecutionRunLifecycleType,
  occurredAt: IsoDateTime,
  t3ThreadId: Schema.optional(ThreadId),
  t3TurnId: Schema.optional(TurnId),
  failureSummary: Schema.optional(TrimmedNonEmptyString),
});
export type TaskRuntimeLifecycleEvent = typeof TaskRuntimeLifecycleEvent.Type;
