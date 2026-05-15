import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  ProviderInteractionMode,
  UploadChatAttachment,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { UserInputQuestion } from "./providerRuntime.ts";

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
  attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
  workspaceRoot: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  taskRuntime: Schema.optional(Schema.Boolean),
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
  attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
  taskRuntime: Schema.optional(Schema.Boolean),
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
  attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
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
  environment: Schema.optional(ExecutionEnvironmentDescriptor),
});
export type TaskRuntimeMaterializeResponse = typeof TaskRuntimeMaterializeResponse.Type;

export const TaskRuntimeLifecycleEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  type: ExecutionRunLifecycleType,
  occurredAt: IsoDateTime,
  t3ThreadId: Schema.optional(ThreadId),
  t3TurnId: Schema.optional(TurnId),
  failureSummary: Schema.optional(TrimmedNonEmptyString),
  assistantResponse: Schema.optional(TrimmedNonEmptyString),
});
export type TaskRuntimeLifecycleEvent = typeof TaskRuntimeLifecycleEvent.Type;

export const TaskRuntimeAssistantMessageEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  occurredAt: IsoDateTime,
  t3ThreadId: ThreadId,
  t3MessageId: MessageId,
  t3TurnId: Schema.optional(TurnId),
  assistantMessage: TrimmedNonEmptyString,
});
export type TaskRuntimeAssistantMessageEvent = typeof TaskRuntimeAssistantMessageEvent.Type;

export const TaskRuntimeUserInputRequestEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  occurredAt: IsoDateTime,
  t3ThreadId: ThreadId,
  t3TurnId: Schema.optional(TurnId),
  requestId: ApprovalRequestId,
  questions: Schema.Array(UserInputQuestion),
});
export type TaskRuntimeUserInputRequestEvent = typeof TaskRuntimeUserInputRequestEvent.Type;

export const TaskRuntimeUserInputRespondRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  t3ThreadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type TaskRuntimeUserInputRespondRequest = typeof TaskRuntimeUserInputRespondRequest.Type;

export const TaskRuntimeUserInputRespondResponse = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  t3ThreadId: ThreadId,
  requestId: ApprovalRequestId,
  acceptedAt: IsoDateTime,
});
export type TaskRuntimeUserInputRespondResponse = typeof TaskRuntimeUserInputRespondResponse.Type;

export const TaskPullRequestEnsureRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  environmentId: Schema.optional(TrimmedNonEmptyString),
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  project: Schema.Struct({
    githubOwner: TrimmedNonEmptyString,
    githubRepo: TrimmedNonEmptyString,
    defaultBranch: TrimmedNonEmptyString,
  }),
  title: TrimmedNonEmptyString,
  body: Schema.optional(Schema.String),
  idempotencyKey: TrimmedNonEmptyString,
});
export type TaskPullRequestEnsureRequest = typeof TaskPullRequestEnsureRequest.Type;

export const TaskPullRequestDeploymentPreview = Schema.Struct({
  provider: TrimmedNonEmptyString,
  environment: Schema.optional(TrimmedNonEmptyString),
  url: Schema.String,
});
export type TaskPullRequestDeploymentPreview = typeof TaskPullRequestDeploymentPreview.Type;

export const TaskPullRequestMetadata = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  number: Schema.Number,
  url: Schema.String,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  draft: Schema.Boolean,
  headSha: Schema.optional(TrimmedNonEmptyString),
  previewUrl: Schema.optional(Schema.String),
  deploymentPreviews: Schema.optional(Schema.Array(TaskPullRequestDeploymentPreview)),
});
export type TaskPullRequestMetadata = typeof TaskPullRequestMetadata.Type;

export const TaskPullRequestEnsureResponse = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  workSessionId: TaskRuntimeMaterializationId,
  status: Schema.Literals(["waiting_for_changes", "created", "existing", "failed"]),
  checkedAt: IsoDateTime,
  pullRequest: Schema.optional(TaskPullRequestMetadata),
  summary: Schema.optional(TrimmedNonEmptyString),
});
export type TaskPullRequestEnsureResponse = typeof TaskPullRequestEnsureResponse.Type;
