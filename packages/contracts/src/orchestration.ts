import { Effect, Option, Schema, SchemaIssue, SchemaTransformation, Struct } from "effect";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  QueuedTurnId,
  ThreadId,
  ThreadUrl,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "./baseSchemas.ts";
import {
  PullRequestMonitorActionableEvent,
  PullRequestMonitorAcceptanceProvenance,
  PullRequestMonitorFeedbackRevisionId,
} from "./pullRequestMonitor.ts";
import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceExchangeId,
  CollaborativeAcceptanceRequestTransportContext,
} from "./collaborativeAcceptance.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ReviewResult, ReviewSnapshot } from "./review.ts";
import { GitPullRequestAssociation } from "./git.ts";
import {
  WorkflowArtifact,
  WorkflowDefinition,
  WorkflowNodeId,
  WorkflowRun,
  WorkflowRunId,
} from "./agentWorkflows.ts";
import {
  ValidationGate,
  ValidationGateId,
  ValidationGateStatus,
  ValidationLease,
  ValidationRequest,
  ValidationRequestFailure,
  ValidationRequester,
  ValidationRunLifecycleUpdate,
  ValidationRun,
  ValidationScenario,
  ValidationScope,
  ValidationStructuredResult,
  ValidationTarget,
} from "./validation.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getThreadActivities: "orchestration.getThreadActivities",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  getTurnDiffState: "orchestration.getTurnDiffState",
  getFullThreadDiffState: "orchestration.getFullThreadDiffState",
  replayEvents: "orchestration.replayEvents",
  getShellSnapshot: "orchestration.getShellSnapshot",
  getThreadSnapshot: "orchestration.getThreadSnapshot",
  readThread: "orchestration.readThread",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  searchThreads: "orchestration.searchThreads",
  searchTranscript: "orchestration.searchTranscript",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;
export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  previewUrl: Schema.optionalKey(Schema.String),
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProjectKind = Schema.Literals(["workspace", "chat-import"]);
export type OrchestrationProjectKind = typeof OrchestrationProjectKind.Type;

export const WorkspaceBinding = Schema.Struct({
  canonicalPath: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  generation: NonNegativeInt,
  // Present only when the thread explicitly opted into the project checkout
  // ("Current checkout"). Absent for isolated workspaces and for legacy
  // bindings, which must keep isolating.
  workspaceScope: Schema.optionalKey(Schema.Literals(["project-checkout"])),
});
export type WorkspaceBinding = typeof WorkspaceBinding.Type;

export const OrchestrationProject = Schema.Struct({
  kind: Schema.optionalKey(OrchestrationProjectKind),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

/**
 * Marks messages that T3 authored on behalf of a workspace handoff rather than
 * the user: the transition marker itself and the boilerplate continuation turn
 * that resumes the task in the newly bound worktree.
 */
export const WorkspaceHandoffOrigin = Schema.Struct({
  kind: Schema.Literal("workspace-handoff"),
  role: Schema.Literals(["marker", "continuation"]),
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  workspaceBinding: Schema.optional(WorkspaceBinding),
});
export type WorkspaceHandoffOrigin = typeof WorkspaceHandoffOrigin.Type;

export const CrossThreadOrigin = Schema.Struct({
  kind: Schema.Literal("cross-thread"),
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  sourceThreadTitle: TrimmedNonEmptyString,
});
export type CrossThreadOrigin = typeof CrossThreadOrigin.Type;

export const ChildReportKind = Schema.Literals(["progress", "decision-needed", "important-update"]);
export const ChildDecision = Schema.Struct({
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  options: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
      Schema.isMaxLength(8),
      Schema.makeFilter((options) => new Set(options).size === options.length),
    ),
  ),
  recommendation: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1000))),
});
export const ChildNudgeUpdate = Schema.Struct({
  id: TrimmedNonEmptyString,
  childThreadId: ThreadId,
  childTitle: TrimmedNonEmptyString,
  assignmentId: MessageId,
  kind: Schema.Literals([
    "progress",
    "decision-needed",
    "important-update",
    "result-available",
    "failed",
    "blocked",
  ]),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  sourceMessageId: Schema.optional(MessageId),
  decision: Schema.optional(ChildDecision),
  canContinue: Schema.optional(Schema.Boolean),
  supersedesReportId: Schema.optional(TrimmedNonEmptyString),
  /** Execution generation that produced this update. Absent on pre-fence history. */
  dispatchId: Schema.optional(TrimmedNonEmptyString),
  wakeReason: Schema.optional(
    Schema.Literals([
      "decision-required",
      "assignment-failed",
      "assignment-blocked",
      "result-ready",
      "important-update",
    ]),
  ),
});
export type ChildNudgeUpdate = typeof ChildNudgeUpdate.Type;

export const ChildNudgeOrigin = Schema.Struct({
  kind: Schema.Literal("child-nudge"),
  updates: Schema.Array(ChildNudgeUpdate).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  collectUntil: Schema.optional(IsoDateTime),
});

const CHILD_WAIT_DEADLINE_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export const ChildWaitDeadlineAt = Schema.String.check(
  Schema.makeFilter((value) => {
    const datePart = value.slice(0, 10);
    const date = new Date(`${datePart}T00:00:00.000Z`);
    return (
      (CHILD_WAIT_DEADLINE_PATTERN.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === datePart) ||
      "Expected a valid ISO 8601 date-time."
    );
  }),
);

export const ChildWaitAssignmentIdentity = Schema.Struct({
  childThreadId: ThreadId,
  assignmentId: MessageId,
});
export type ChildWaitAssignmentIdentity = typeof ChildWaitAssignmentIdentity.Type;

export const ChildWaitCondition = Schema.Struct({
  mode: Schema.Literals(["any", "all", "decisions-only"]),
  generationId: Schema.optional(CommandId),
  assignments: Schema.Array(
    Schema.Struct({
      ...ChildWaitAssignmentIdentity.fields,
      outcome: Schema.optional(Schema.Literals(["result-available", "failed", "blocked"])),
    }),
  ).check(Schema.isMaxLength(32)),
  satisfiedAt: Schema.optional(IsoDateTime),
  deadlineAt: Schema.optional(ChildWaitDeadlineAt),
});
export type ChildWaitCondition = typeof ChildWaitCondition.Type;

export const ThreadDelegation = Schema.Struct({
  assignmentId: MessageId,
  /**
   * Active execution generation for this assignment. The logical assignment
   * survives retries; the dispatch identifies one authorized execution.
   * Absent on pre-fence delegations, which follow legacy (unfenced) rules
   * until the first post-upgrade execution binds.
   */
  dispatchId: Schema.optional(TrimmedNonEmptyString),
  /** Monotonic generation counter, informational and audit-ordered. */
  dispatchSequence: Schema.optional(NonNegativeInt),
  /** Provider turn authorized for the active dispatch. Null until bound. */
  dispatchTurnId: Schema.optional(Schema.NullOr(TurnId)),
  /** Why the active execution generation was created. */
  dispatchReason: Schema.optional(Schema.Literals(["assigned", "continued", "replaced"])),
  /** Previous generation revoked by a continuation or replacement. */
  previousDispatchId: Schema.optional(TrimmedNonEmptyString),
  followUp: Schema.Literals(["automatic", "notify-only"]),
  completedAt: Schema.NullOr(IsoDateTime),
  assignedAt: Schema.optional(IsoDateTime),
  outcome: Schema.optional(Schema.Literals(["result-available", "failed", "blocked"])),
  decision: Schema.optional(Schema.NullOr(ChildNudgeUpdate)),
  pendingResponse: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        queuedTurnId: QueuedTurnId,
        report: ChildNudgeUpdate,
      }),
    ),
  ),
});
export type ThreadDelegation = typeof ThreadDelegation.Type;
export const ThreadNudging = Schema.Struct({
  paused: Schema.optional(Schema.Boolean),
  delegation: Schema.optional(ThreadDelegation),
  wait: Schema.optional(Schema.NullOr(ChildWaitCondition)),
});
export type ThreadNudging = typeof ThreadNudging.Type;

export const CollaborationRequestId = TrimmedNonEmptyString;
export type CollaborationRequestId = typeof CollaborationRequestId.Type;
export const CollaborationResponseId = TrimmedNonEmptyString;
export type CollaborationResponseId = typeof CollaborationResponseId.Type;
export const CollaborationRequestKind = Schema.Literals([
  "clarification",
  "decision",
  "review",
  "remediation",
]);
export type CollaborationRequestKind = typeof CollaborationRequestKind.Type;
export const CollaborationRequestStatus = Schema.Literals([
  "waiting",
  "notification-delivered",
  "response-ready",
  "consumed",
  "superseded",
  "cancelled",
  "needs-human",
]);
export type CollaborationRequestStatus = typeof CollaborationRequestStatus.Type;
export const CollaborationRequestTerminalOutcome = Schema.Literals([
  "completed",
  "cancelled",
  "superseded",
  "needs-human",
  "stale",
]);
export type CollaborationRequestTerminalOutcome = typeof CollaborationRequestTerminalOutcome.Type;

export const CollaborationExecutionAuthority = Schema.Struct({
  executionId: TrimmedNonEmptyString,
  assignmentId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  generation: NonNegativeInt,
  dispatchId: Schema.NullOr(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TurnId),
});
export type CollaborationExecutionAuthority = typeof CollaborationExecutionAuthority.Type;

export const CollaborationPayloadReference = Schema.Struct({
  ref: TrimmedNonEmptyString,
  sha256: TrimmedNonEmptyString,
});
export type CollaborationPayloadReference = typeof CollaborationPayloadReference.Type;

export const CollaborationResponse = Schema.Struct({
  responseId: CollaborationResponseId,
  requestId: CollaborationRequestId,
  exchangeId: CollaborativeAcceptanceExchangeId,
  responderThreadId: ThreadId,
  responderAuthority: CollaborationExecutionAuthority,
  payloadRef: CollaborationPayloadReference,
  outcome: CollaborationRequestTerminalOutcome,
  createdAt: IsoDateTime,
});
export type CollaborationResponse = typeof CollaborationResponse.Type;

export const CollaborationRequest = Schema.Struct({
  requestId: CollaborationRequestId,
  kind: CollaborationRequestKind,
  exchangeId: CollaborativeAcceptanceExchangeId,
  senderThreadId: ThreadId,
  recipientThreadId: ThreadId,
  blocking: Schema.Boolean,
  caseId: Schema.optional(CollaborativeAcceptanceCaseId),
  transportContext: Schema.optional(Schema.NullOr(CollaborativeAcceptanceRequestTransportContext)),
  senderAuthority: CollaborationExecutionAuthority,
  recipientAuthority: CollaborationExecutionAuthority,
  producingExecution: CollaborationExecutionAuthority,
  payloadRef: CollaborationPayloadReference,
  candidateRefs: Schema.Array(CollaborativeAcceptanceCandidateId),
  findingRefs: Schema.Array(PullRequestMonitorFeedbackRevisionId),
  monitorProvenance: Schema.optional(Schema.NullOr(PullRequestMonitorAcceptanceProvenance)),
  supersedesRequestId: Schema.NullOr(CollaborationRequestId),
  deliveryQueuedTurnId: Schema.NullOr(QueuedTurnId),
  responseDeliveryQueuedTurnId: Schema.NullOr(QueuedTurnId),
  responseRef: Schema.NullOr(CollaborationResponseId),
  response: Schema.NullOr(CollaborationResponse),
  consumedExecution: Schema.NullOr(CollaborationExecutionAuthority),
  status: CollaborationRequestStatus,
  terminalOutcome: Schema.NullOr(CollaborationRequestTerminalOutcome),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).check(
  Schema.makeFilter((request) => {
    const hasResponse = request.responseRef !== null && request.response !== null;
    if ((request.status === "response-ready" || request.status === "consumed") && !hasResponse) {
      return "Collaboration request response state is inconsistent with its status";
    }
    if (request.status === "notification-delivered" && hasResponse) {
      return "Notifications cannot carry a correlated response";
    }
    return true;
  }),
);
export type CollaborationRequest = typeof CollaborationRequest.Type;

export const PullRequestMonitorOrigin = Schema.Struct({
  kind: Schema.Literal("pull-request-monitor"),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  /** Head this system-authored turn was prepared against. Older persisted turns omit it. */
  headSha: Schema.optional(TrimmedNonEmptyString),
  /** Exact provider revision used to prepare the turn. Older persisted turns omit it. */
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  /** Findings represented by the prompt, used only to suppress work resolved while queued. */
  events: Schema.optional(Schema.Array(PullRequestMonitorActionableEvent)),
  deliveryId: Schema.optional(TrimmedNonEmptyString),
  revisionSummaries: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(500)))),
  findingContext: Schema.optional(Schema.String),
  availableTools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  revalidationAttemptCount: Schema.optional(NonNegativeInt),
  nextRevalidationAt: Schema.optional(IsoDateTime),
});
export type PullRequestMonitorOrigin = typeof PullRequestMonitorOrigin.Type;

export const CollaborationRequestOrigin = Schema.Struct({
  kind: Schema.Literal("collaboration-request"),
  requestId: CollaborationRequestId,
  exchangeId: CollaborativeAcceptanceExchangeId,
});
export type CollaborationRequestOrigin = typeof CollaborationRequestOrigin.Type;

export const CollaborationResponseOrigin = Schema.Struct({
  kind: Schema.Literal("collaboration-response"),
  requestId: CollaborationRequestId,
  responseId: CollaborationResponseId,
  exchangeId: CollaborativeAcceptanceExchangeId,
});
export type CollaborationResponseOrigin = typeof CollaborationResponseOrigin.Type;

export const MessageOrigin = Schema.Union([
  WorkspaceHandoffOrigin,
  CrossThreadOrigin,
  PullRequestMonitorOrigin,
  ChildNudgeOrigin,
  CollaborationRequestOrigin,
  CollaborationResponseOrigin,
]);
export type MessageOrigin = typeof MessageOrigin.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  origin: Schema.optional(MessageOrigin),
  workspaceBinding: Schema.optional(WorkspaceBinding),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

const QueuedTurnMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literal("user"),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export type QueuedTurnMessage = typeof QueuedTurnMessage.Type;

const UploadQueuedTurnMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literal("user"),
  text: Schema.String,
  attachments: Schema.Array(UploadChatAttachment),
});

export const OrchestrationQueuedTurn = Schema.Struct({
  id: QueuedTurnId,
  threadId: ThreadId,
  message: QueuedTurnMessage,
  origin: Schema.optional(MessageOrigin),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  workspaceBinding: Schema.optional(WorkspaceBinding),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  failedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  failureMessage: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type OrchestrationQueuedTurn = typeof OrchestrationQueuedTurn.Type;

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  activeMessageId: Schema.optional(MessageId),
  resumeCursor: Schema.optional(Schema.Unknown),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  previousPath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;
const OrchestrationCheckpointFiles = Schema.Array(OrchestrationCheckpointFile);
const OrchestrationAgentTouchedPaths = Schema.Array(TrimmedNonEmptyString);

export const OrchestrationCheckpointStatus = Schema.Literals([
  "ready",
  "missing",
  "speculative",
  "error",
]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: OrchestrationCheckpointFiles,
  agentTouchedPaths: OrchestrationAgentTouchedPaths.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  turnFiles: OrchestrationCheckpointFiles.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

export const ChildThreadLifecycle = Schema.Literals([
  "started",
  "blocked",
  "approval-required",
  "input-required",
  "failed",
  "completed",
  "pr-created",
  "reported",
]);
export type ChildThreadLifecycle = typeof ChildThreadLifecycle.Type;

const ChildThreadLifecycleNotificationFields = {
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  childTitle: TrimmedNonEmptyString,
  dedupeKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  report: Schema.optional(ChildNudgeUpdate),
} as const;

export const ChildThreadLifecycleNotification = Schema.Union([
  Schema.Struct({
    ...ChildThreadLifecycleNotificationFields,
    lifecycle: Schema.Literals([
      "started",
      "blocked",
      "approval-required",
      "input-required",
      "failed",
      "completed",
      "reported",
    ]),
  }),
  Schema.Struct({
    ...ChildThreadLifecycleNotificationFields,
    lifecycle: Schema.Literal("pr-created"),
    externalAction: Schema.Struct({
      url: TrimmedNonEmptyString,
    }),
  }),
]);
export type ChildThreadLifecycleNotification = typeof ChildThreadLifecycleNotification.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "recovered",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

export const ThreadPullRequestLink = Schema.Struct({
  pullRequest: GitPullRequestAssociation,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;

export const PendingPullRequestAssociation = Schema.Union([
  Schema.Struct({
    requestId: CommandId,
    reference: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    requestedAt: IsoDateTime,
    nextAttemptAt: IsoDateTime,
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    requestId: CommandId,
    reference: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    requestedAt: IsoDateTime,
    status: Schema.Literal("blocked"),
    reason: Schema.Literals([
      "repository-mismatch",
      "head-mismatch",
      "workspace-changed",
      "thread-changed",
      "resolve-failed",
    ]),
  }),
]);
export type PendingPullRequestAssociation = typeof PendingPullRequestAssociation.Type;

export const OrchestrationThread = Schema.Struct({
  nudging: Schema.optional(ThreadNudging),
  collaborationRequests: Schema.optionalKey(Schema.Array(CollaborationRequest)),
  linkedPullRequest: Schema.optionalKey(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pendingPullRequestAssociation: Schema.optionalKey(Schema.NullOr(PendingPullRequestAssociation)),
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  id: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  pendingRuntimeMode: Schema.optionalKey(Schema.NullOr(RuntimeMode)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceBinding: Schema.optionalKey(WorkspaceBinding),
  /**
   * Durable PR association for this thread. Never inferred from checkout/branch
   * equality — only set by explicit PR checkout/create/open flows.
   */
  pullRequest: Schema.optionalKey(Schema.NullOr(GitPullRequestAssociation)),
  pullRequests: Schema.optionalKey(Schema.Array(ThreadPullRequestLink)),
  reviewSnapshot: Schema.optionalKey(ReviewSnapshot),
  reviewResult: Schema.optionalKey(Schema.NullOr(ReviewResult)),
  validationRequest: Schema.optionalKey(Schema.NullOr(ValidationRequest)),
  validationRun: Schema.optionalKey(Schema.NullOr(ValidationRun)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * "settled" hides the thread from the inbox. "active" is a user pin that
   * suppresses automatic settlement; it is inert until auto-settle exists, so
   * do not remove it as dead code.
   */
  settledOverride: Schema.optionalKey(Schema.NullOr(Schema.Literals(["settled", "active"]))),
  settledAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  queuedTurns: Schema.optionalKey(Schema.Array(OrchestrationQueuedTurn)),
  activities: Schema.Array(OrchestrationThreadActivity),
  activityContext: Schema.optionalKey(Schema.Array(OrchestrationThreadActivity)),
  hasMoreActivities: Schema.optionalKey(Schema.Boolean),
  hasMoreCurrentTurnActivities: Schema.optionalKey(Schema.Boolean),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  workflowRuns: Schema.optionalKey(Schema.Array(WorkflowRun)),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  kind: Schema.optionalKey(OrchestrationProjectKind),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationBackgroundAgentRunShell = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "completed", "failed", "stopped"]),
  startedAt: IsoDateTime,
  completedAt: Schema.optionalKey(IsoDateTime),
});
export type OrchestrationBackgroundAgentRunShell = typeof OrchestrationBackgroundAgentRunShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  nudging: Schema.optional(ThreadNudging),
  linkedPullRequest: Schema.optionalKey(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pendingPullRequestAssociation: Schema.optionalKey(Schema.NullOr(PendingPullRequestAssociation)),
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  id: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  pendingRuntimeMode: Schema.optionalKey(Schema.NullOr(RuntimeMode)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceBinding: Schema.optionalKey(WorkspaceBinding),
  pullRequest: Schema.optionalKey(Schema.NullOr(GitPullRequestAssociation)),
  pullRequests: Schema.optionalKey(Schema.Array(ThreadPullRequestLink)),
  validationRequest: Schema.optionalKey(Schema.NullOr(ValidationRequest)),
  validationRun: Schema.optionalKey(Schema.NullOr(ValidationRun)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.optionalKey(Schema.NullOr(Schema.Literals(["settled", "active"]))),
  settledAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  latestChildNotificationAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  // True while a non-failed queued turn remains (handoff continuation or user
  // follow-up). Defaults false so older snapshots/clients decode cleanly.
  hasPendingQueuedTurn: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  backgroundAgentRuns: Schema.optionalKey(Schema.Array(OrchestrationBackgroundAgentRunShell)),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  workflowRuns: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        run: WorkflowRun,
        definition: WorkflowDefinition,
      }),
    ),
  ),
  workflowArtifacts: Schema.optionalKey(Schema.Array(WorkflowArtifact)),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  page: Schema.optionalKey(
    Schema.Struct({
      beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
      hasMore: Schema.Boolean,
      snapshotSequence: NonNegativeInt,
      threadSequence: Schema.optionalKey(NonNegativeInt),
    }),
  ),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const OrchestrationReadThreadInput = Schema.Struct({
  thread: TrimmedNonEmptyString,
  view: Schema.Literals(["summary", "messages", "activities"]),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  before: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export type OrchestrationReadThreadInput = typeof OrchestrationReadThreadInput.Type;

export const OrchestrationReadThreadResult = Schema.Struct({
  thread: OrchestrationThreadShell,
  messages: Schema.optionalKey(Schema.Array(OrchestrationMessage)),
  activities: Schema.optionalKey(Schema.Array(OrchestrationThreadActivity)),
  page: Schema.Struct({
    hasMore: Schema.Boolean,
    before: Schema.NullOr(Schema.String),
  }),
});
export type OrchestrationReadThreadResult = typeof OrchestrationReadThreadResult.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  autoPull: Schema.optional(Schema.Boolean),
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  delegation: Schema.optional(ThreadDelegation),
  parentWait: Schema.optional(Schema.NullOr(ChildWaitCondition)),
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sourceBranch: Schema.optional(TrimmedNonEmptyString),
  sourceWorktreePath: Schema.optional(TrimmedNonEmptyString),
  workspaceBinding: Schema.optionalKey(WorkspaceBinding),
  pullRequest: Schema.optionalKey(Schema.NullOr(GitPullRequestAssociation)),
  reviewSnapshot: Schema.optionalKey(ReviewSnapshot),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  cleanupWorktree: Schema.optional(Schema.Boolean),
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
});

const ThreadDecoupleCommand = Schema.Struct({
  type: Schema.Literal("thread.decouple"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  childWait: Schema.optional(Schema.NullOr(ChildWaitCondition)),
  childFollowUpPaused: Schema.optional(Schema.Boolean),
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedUpdatedAt: Schema.optional(IsoDateTime),
  expectedWorkspaceCwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceBinding: Schema.optional(Schema.NullOr(WorkspaceBinding)),
  pullRequest: Schema.optional(Schema.NullOr(GitPullRequestAssociation)),
  pullRequestSource: Schema.optional(ThreadPullRequestLinkSource),
  pullRequestOwnership: Schema.optional(Schema.Literal("transfer")),
  pendingPullRequestAssociation: Schema.optional(Schema.NullOr(PendingPullRequestAssociation)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadChildWaitDeadlineExpireCommand = Schema.Struct({
  type: Schema.Literal("thread.child-wait.deadline-expire"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedDeadlineAt: ChildWaitDeadlineAt,
  expectedGenerationId: Schema.optional(CommandId),
  expiredAt: ChildWaitDeadlineAt,
});

const ThreadChildWaitPruneCommand = Schema.Struct({
  type: Schema.Literal("thread.child.wait.prune"),
  commandId: CommandId,
  threadId: ThreadId,
  assignments: Schema.Array(ChildWaitAssignmentIdentity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
});

export const CollaborationDelivery = Schema.Struct({
  queuedTurnId: QueuedTurnId,
  message: QueuedTurnMessage,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type CollaborationDelivery = typeof CollaborationDelivery.Type;

const CollaborationRequestCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-request.create"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  recipientThreadId: ThreadId,
  kind: CollaborationRequestKind,
  exchangeId: CollaborativeAcceptanceExchangeId,
  blocking: Schema.Boolean,
  caseId: Schema.optional(CollaborativeAcceptanceCaseId),
  transportContext: Schema.optional(Schema.NullOr(CollaborativeAcceptanceRequestTransportContext)),
  senderAuthority: CollaborationExecutionAuthority,
  recipientAuthority: CollaborationExecutionAuthority,
  producingExecution: CollaborationExecutionAuthority,
  payloadRef: CollaborationPayloadReference,
  candidateRefs: Schema.Array(CollaborativeAcceptanceCandidateId),
  findingRefs: Schema.Array(PullRequestMonitorFeedbackRevisionId),
  monitorProvenance: Schema.optional(Schema.NullOr(PullRequestMonitorAcceptanceProvenance)),
  supersedesRequestId: Schema.optional(CollaborationRequestId),
  delivery: CollaborationDelivery,
  createdAt: IsoDateTime,
});

const CollaborationRequestRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-request.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  responseId: CollaborationResponseId,
  exchangeId: CollaborativeAcceptanceExchangeId,
  responderAuthority: CollaborationExecutionAuthority,
  payloadRef: CollaborationPayloadReference,
  outcome: CollaborationRequestTerminalOutcome,
  delivery: CollaborationDelivery,
  createdAt: IsoDateTime,
});

const CollaborationRequestConsumeCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-request.consume"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  responseId: CollaborationResponseId,
  consumedExecution: CollaborationExecutionAuthority,
  createdAt: IsoDateTime,
});

const CollaborationRequestSupersedeCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-request.supersede"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  supersededByRequestId: CollaborationRequestId,
  actorAuthority: CollaborationExecutionAuthority,
  createdAt: IsoDateTime,
});

const CollaborationRequestCancelCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-request.cancel"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  actorAuthority: CollaborationExecutionAuthority,
  createdAt: IsoDateTime,
});

const CollaborationResponseDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-response.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  responseId: CollaborationResponseId,
  actorAuthority: CollaborationExecutionAuthority,
  createdAt: IsoDateTime,
});

const CollaborationRequestOverrideCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-request.override"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CollaborationRequestId,
  outcome: Schema.Literals(["cancelled", "needs-human"]),
  authorizedBy: Schema.Literal("user"),
  createdAt: IsoDateTime,
});

const CollaborationStateClearCommand = Schema.Struct({
  type: Schema.Literal("thread.collaboration-state.clear"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadWorkspaceHandoffCommand = Schema.Struct({
  type: Schema.Literal("thread.workspace.handoff"),
  commandId: CommandId,
  threadId: ThreadId,
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  workspaceBinding: Schema.optional(WorkspaceBinding),
  markerMessageId: MessageId,
  continuation: OrchestrationQueuedTurn,
});

const ThreadPullRequestLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.link"),
  commandId: CommandId,
  threadId: ThreadId,
  pullRequest: GitPullRequestAssociation,
  source: ThreadPullRequestLinkSource,
});

const ThreadPullRequestUnlinkCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  pullRequest: GitPullRequestAssociation,
});

const ThreadPullRequestRekeyCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.rekey"),
  commandId: CommandId,
  threadId: ThreadId,
  previousPullRequest: GitPullRequestAssociation,
  pullRequest: GitPullRequestAssociation,
});

const ThreadForkCommand = Schema.Struct({
  type: Schema.Literal("thread.fork"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  targetMessageId: MessageId,
  createdAt: IsoDateTime,
});

const ChatArchiveImportMessage = Schema.Struct({
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const ChatArchiveImportThread = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messages: Schema.Array(ChatArchiveImportMessage),
});

const ChatArchiveImportCommand = Schema.Struct({
  type: Schema.Literal("chat-archive.import"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  threads: Schema.Array(ChatArchiveImportThread),
  createdAt: IsoDateTime,
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadPendingRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pending-runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sourceBranch: Schema.optional(TrimmedNonEmptyString),
  sourceWorktreePath: Schema.optional(TrimmedNonEmptyString),
  workspaceBinding: Schema.optionalKey(WorkspaceBinding),
  pullRequest: Schema.optionalKey(Schema.NullOr(GitPullRequestAssociation)),
  reviewSnapshot: Schema.optionalKey(ReviewSnapshot),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  workspaceBinding: Schema.optional(WorkspaceBinding),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  origin: Schema.optional(MessageOrigin),
  crossThreadSourceThreadId: Schema.optional(ThreadId),
  crossThreadDispatchCapability: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  workspaceBinding: Schema.optional(WorkspaceBinding),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  crossThreadSourceThreadId: Schema.optional(ThreadId),
  crossThreadDispatchCapability: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const ThreadQueuedTurnCreateCommand = Schema.Struct({
  assignment: Schema.optional(
    Schema.Struct({
      followUp: Schema.Literals(["automatic", "notify-only"]),
    }),
  ),
  respondToReportId: Schema.optional(TrimmedNonEmptyString),
  assignmentId: Schema.optional(MessageId),
  type: Schema.Literal("thread.queued-turn.create"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  message: QueuedTurnMessage,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  origin: Schema.optional(MessageOrigin),
  crossThreadSourceThreadId: Schema.optional(ThreadId),
  createdAt: IsoDateTime,
});

const ClientThreadQueuedTurnCreateCommand = Schema.Struct({
  assignment: Schema.optional(
    Schema.Struct({
      followUp: Schema.Literals(["automatic", "notify-only"]),
    }),
  ),
  respondToReportId: Schema.optional(TrimmedNonEmptyString),
  assignmentId: Schema.optional(MessageId),
  type: Schema.Literal("thread.queued-turn.create"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  message: UploadQueuedTurnMessage,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  crossThreadSourceThreadId: Schema.optional(ThreadId),
  crossThreadDispatchCapability: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const ThreadQueuedTurnUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-turn.update"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  text: Schema.String,
  origin: Schema.optional(MessageOrigin),
  updatedAt: IsoDateTime,
});

const ClientThreadQueuedTurnUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-turn.update"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  text: Schema.String,
  updatedAt: IsoDateTime,
});

const ThreadQueuedTurnDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-turn.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  deletedAt: IsoDateTime,
});

const ThreadQueuedTurnDispatchCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-turn.dispatch"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  workspaceBinding: Schema.optional(WorkspaceBinding),
  dispatchedAt: IsoDateTime,
});

const ThreadQueuedTurnFailCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-turn.fail"),
  commandId: CommandId,
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  failureMessage: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadValidationRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.request"),
  commandId: CommandId,
  threadId: ThreadId,
  scenarios: Schema.Array(ValidationScenario),
  scope: ValidationScope,
  requester: ValidationRequester,
  requestedAt: IsoDateTime,
});

const ThreadValidationRequestFailedCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.request-failed"),
  commandId: CommandId,
  threadId: ThreadId,
  failure: ValidationRequestFailure,
});

const ThreadValidationRunPlanCommand = Schema.Struct({
  type: Schema.Literal("thread.validation-run.plan"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  target: ValidationTarget,
  createdAt: IsoDateTime,
});

const ThreadValidationRunPlanCoordinatorCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.coordinator-plan"),
  commandId: CommandId,
  threadId: ThreadId,
  run: ValidationRun,
  createdAt: IsoDateTime,
});

const ThreadValidationLifecycleUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.lifecycle"),
  commandId: CommandId,
  threadId: ThreadId,
  update: ValidationRunLifecycleUpdate,
});

const ThreadValidationLeaseClaimCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.lease.claim"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  lease: ValidationLease,
  executorId: TrimmedNonEmptyString,
  target: ValidationTarget,
  claimedAt: IsoDateTime,
});

const ThreadValidationLeaseReleaseCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.lease.release"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  leaseId: TrimmedNonEmptyString,
  releasedAt: IsoDateTime,
});

const ThreadValidationResultRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.validation.result.record"),
  commandId: CommandId,
  threadId: ThreadId,
  result: ValidationStructuredResult,
});

const ThreadValidationGateUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.validation-gate.update"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  leaseId: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  target: ValidationTarget,
  gateId: ValidationGateId,
  status: ValidationGateStatus,
  command: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  outputRef: Schema.NullOr(TrimmedNonEmptyString),
  blockerReason: Schema.NullOr(TrimmedNonEmptyString),
  diagnostics: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

/** Durable execution settings for a workflow worker. These are captured when
 * the run is requested so restart recovery never falls back to changed parent
 * settings or a different worktree. */
export const WorkflowWorkerConfig = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceBinding: Schema.optionalKey(WorkspaceBinding),
  pullRequest: Schema.optionalKey(Schema.NullOr(GitPullRequestAssociation)),
  reviewSnapshot: Schema.optionalKey(ReviewSnapshot),
});
export type WorkflowWorkerConfig = typeof WorkflowWorkerConfig.Type;

export const WorkflowRunRequestCommand = Schema.Struct({
  type: Schema.Literal("workflow.run.request"),
  commandId: CommandId,
  runId: WorkflowRunId,
  parentThreadId: ThreadId,
  definition: WorkflowDefinition,
  workerConfig: WorkflowWorkerConfig,
  inputArtifact: WorkflowArtifact,
  createdAt: IsoDateTime,
});

const WorkflowNodeWorkerStartCommand = Schema.Struct({
  type: Schema.Literal("workflow.node.worker.start"),
  commandId: CommandId,
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  workerThreadId: ThreadId,
  startedAt: IsoDateTime,
});

const WorkflowWorkerResultRecordCommand = Schema.Struct({
  type: Schema.Literal("workflow.worker-result.record"),
  commandId: CommandId,
  runId: WorkflowRunId,
  artifact: WorkflowArtifact,
  completedAt: IsoDateTime,
});

const WorkflowRunFinalizeCommand = Schema.Struct({
  type: Schema.Literal("workflow.run.finalize"),
  commandId: CommandId,
  runId: WorkflowRunId,
  parentThreadId: ThreadId,
  artifact: WorkflowArtifact,
  status: Schema.Literals(["completed", "failed"]),
  completedAt: IsoDateTime,
});

const ThreadChildReportCommand = Schema.Struct({
  type: Schema.Literal("thread.child.report"),
  commandId: CommandId,
  threadId: ThreadId,
  reportId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  assignmentId: Schema.optional(MessageId),
  kind: ChildReportKind,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  decision: Schema.optional(ChildDecision),
  canContinue: Schema.optional(Schema.Boolean),
  supersedesReportId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Execution dispatch presenting this report. Must arrive with the report
   * from the reporting execution's context; the server never substitutes
   * live thread state for provenance.
   */
  dispatchId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Provider turn that produced this report, sourced from the reporting
   * execution's session context. Validated against the dispatch's authorized
   * turn; absent only on pre-fence callers.
   */
  originTurnId: Schema.optional(TurnId),
  crossThreadDispatchCapability: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

/**
 * Outcome of fencing an attempt-scoped child report against the delegation's
 * active execution generation. Returned to the reporter through
 * DispatchResult.reportVerdict and recorded on the receipt activity.
 */
export const DispatchReportVerdict = Schema.Literals(["accepted", "already-recorded", "stale"]);
export type DispatchReportVerdict = typeof DispatchReportVerdict.Type;

const ThreadDispatchReplaceCommand = Schema.Struct({
  type: Schema.Literal("thread.dispatch.replace"),
  commandId: CommandId,
  threadId: ThreadId,
  /**
   * Compare-and-swap guard: the replacement applies only when the active
   * dispatch equals this value. Absent expects a legacy (undispatched)
   * delegation. Mismatches are rejected, never silently applied.
   */
  expectedDispatchId: Schema.optional(TrimmedNonEmptyString),
  queuedTurnId: QueuedTurnId,
  message: QueuedTurnMessage,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ThreadChildReportCommand,
  CollaborationRequestCreateCommand,
  CollaborationRequestRespondCommand,
  CollaborationRequestSupersedeCommand,
  CollaborationRequestCancelCommand,
  CollaborationResponseDeleteCommand,
  CollaborationRequestOverrideCommand,
  CollaborationStateClearCommand,
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadDecoupleCommand,
  ThreadMetaUpdateCommand,
  ThreadChildWaitPruneCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadPullRequestRekeyCommand,
  ThreadWorkspaceHandoffCommand,
  ThreadForkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadPendingRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadQueuedTurnCreateCommand,
  ThreadQueuedTurnUpdateCommand,
  ThreadQueuedTurnDeleteCommand,
  ThreadQueuedTurnDispatchCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  ThreadValidationRequestCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ThreadChildReportCommand,
  CollaborationRequestCreateCommand,
  CollaborationRequestRespondCommand,
  CollaborationRequestSupersedeCommand,
  CollaborationRequestCancelCommand,
  CollaborationResponseDeleteCommand,
  CollaborationRequestOverrideCommand,
  CollaborationStateClearCommand,
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadDecoupleCommand,
  ThreadMetaUpdateCommand,
  ThreadChildWaitPruneCommand,
  ThreadPullRequestLinkCommand,
  ThreadPullRequestUnlinkCommand,
  ThreadPullRequestRekeyCommand,
  ThreadWorkspaceHandoffCommand,
  ThreadForkCommand,
  ThreadRuntimeModeSetCommand,
  ThreadPendingRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ClientThreadQueuedTurnCreateCommand,
  ClientThreadQueuedTurnUpdateCommand,
  ThreadQueuedTurnDeleteCommand,
  ThreadQueuedTurnDispatchCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  ThreadValidationRequestCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

// Client-only additions are sent only after checking the server's advertised capabilities.
export const CapabilityClientOrchestrationCommand = Schema.Union([
  ClientOrchestrationCommand,
  Schema.Struct({
    ...ClientThreadTurnStartCommand.fields,
    message: Schema.Struct({
      ...ClientThreadTurnStartCommand.fields.message.fields,
      attachments: Schema.Array(Schema.Union([UploadChatImageAttachment, ChatAttachment])),
    }),
  }),
]);
export type CapabilityClientOrchestrationCommand = typeof CapabilityClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  expectedActiveTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  replaceExisting: Schema.optional(Schema.Boolean),
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadReviewResultSetCommand = Schema.Struct({
  type: Schema.Literal("thread.review-result.set"),
  commandId: CommandId,
  threadId: ThreadId,
  result: ReviewResult,
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: OrchestrationCheckpointFiles,
  agentTouchedPaths: OrchestrationAgentTouchedPaths.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  turnFiles: OrchestrationCheckpointFiles.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadDelegationSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.delegation.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadChildAssignmentUnavailableCommand = Schema.Struct({
  type: Schema.Literal("thread.child.assignment.unavailable"),
  commandId: CommandId,
  threadId: ThreadId,
  childThreadId: ThreadId,
  assignmentId: MessageId,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

export const InternalOrchestrationCommand = Schema.Union([
  ChatArchiveImportCommand,
  CollaborationRequestConsumeCommand,
  ThreadSessionSetCommand,
  ThreadDispatchReplaceCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadReviewResultSetCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadDelegationSettleCommand,
  ThreadChildAssignmentUnavailableCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
  ThreadQueuedTurnDispatchCommand,
  ThreadQueuedTurnFailCommand,
  ThreadChildWaitDeadlineExpireCommand,
  WorkflowRunRequestCommand,
  WorkflowNodeWorkerStartCommand,
  WorkflowWorkerResultRecordCommand,
  WorkflowRunFinalizeCommand,
  ThreadValidationRequestFailedCommand,
  ThreadValidationRunPlanCommand,
  ThreadValidationRunPlanCoordinatorCommand,
  ThreadValidationLifecycleUpdateCommand,
  ThreadValidationLeaseClaimCommand,
  ThreadValidationLeaseReleaseCommand,
  ThreadValidationResultRecordCommand,
  ThreadValidationGateUpdateCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.decoupled",
  "thread.meta-updated",
  "thread.collaboration-request-updated",
  "thread.collaboration-state-cleared",
  "thread.pull-request-linked",
  "thread.pull-request-unlinked",
  "thread.pull-request-rekeyed",
  "thread.runtime-mode-set",
  "thread.pending-runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.review-result-set",
  "thread.turn-start-requested",
  "thread.queued-turn-created",
  "thread.queued-turn-updated",
  "thread.queued-turn-deleted",
  "thread.queued-turn-dispatched",
  "thread.queued-turn-failed",
  "thread.provider-fork-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.validation-requested",
  "thread.validation-request-failed",
  "thread.validation-run-planned",
  "thread.validation-lifecycle-updated",
  "thread.validation-lease-claimed",
  "thread.validation-lease-released",
  "thread.validation-result-recorded",
  "thread.validation-gate-updated",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.child-lifecycle-notified",
  "workflow.run-requested",
  "workflow.artifact-created",
  "workflow.node-worker-started",
  "workflow.worker-result-recorded",
  "workflow.run-finalized",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread", "workflow"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optionalKey(OrchestrationProjectKind),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  autoPull: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  nudging: Schema.optional(ThreadNudging),
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  pendingRuntimeMode: Schema.optionalKey(Schema.NullOr(RuntimeMode)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceBinding: Schema.optionalKey(WorkspaceBinding),
  pullRequest: Schema.optionalKey(Schema.NullOr(GitPullRequestAssociation)),
  reviewSnapshot: Schema.optionalKey(ReviewSnapshot),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadWorktreeCleanup = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ThreadWorktreeCleanup = typeof ThreadWorktreeCleanup.Type;

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
  worktreeCleanup: Schema.optional(ThreadWorktreeCleanup),
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /**
   * When set, the durable cleanup worker should remove this thread's worktree
   * after archive (used for merged-PR chats). Same safety rules as delete cleanup.
   */
  worktreeCleanup: Schema.optional(ThreadWorktreeCleanup),
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadDecoupledPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  nudging: Schema.optional(ThreadNudging),
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceBinding: Schema.optionalKey(Schema.NullOr(WorkspaceBinding)),
  pullRequest: Schema.optional(Schema.NullOr(GitPullRequestAssociation)),
  pullRequestSource: Schema.optional(ThreadPullRequestLinkSource),
  pullRequestOwnership: Schema.optional(Schema.Literal("transfer")),
  pendingPullRequestAssociation: Schema.optional(Schema.NullOr(PendingPullRequestAssociation)),
  updatedAt: IsoDateTime,
});

export const ThreadCollaborationRequestUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals([
    "created",
    "responded",
    "consumed",
    "superseded",
    "cancelled",
    "reopened",
    "override",
    "response-rejected",
  ]),
  request: CollaborationRequest,
  response: Schema.optional(CollaborationResponse),
  updatedAt: IsoDateTime,
});

export const ThreadCollaborationStateClearedPayload = Schema.Struct({
  threadId: ThreadId,
  clearedAt: IsoDateTime,
});

export const ThreadPullRequestLinkedPayload = Schema.Struct({
  threadId: ThreadId,
  link: ThreadPullRequestLink,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestLinkedPayload = typeof ThreadPullRequestLinkedPayload.Type;

export const ThreadPullRequestUnlinkedPayload = Schema.Struct({
  threadId: ThreadId,
  pullRequest: GitPullRequestAssociation,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestUnlinkedPayload = typeof ThreadPullRequestUnlinkedPayload.Type;

export const ThreadPullRequestRekeyedPayload = Schema.Struct({
  threadId: ThreadId,
  previousPullRequest: GitPullRequestAssociation,
  link: ThreadPullRequestLink,
  updatedAt: IsoDateTime,
});
export type ThreadPullRequestRekeyedPayload = typeof ThreadPullRequestRekeyedPayload.Type;

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadPendingRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  origin: Schema.optional(MessageOrigin),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  replaceExisting: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadReviewResultSetPayload = Schema.Struct({
  threadId: ThreadId,
  result: ReviewResult,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  delegationAssignmentId: Schema.optional(MessageId),
  delegationDispatchId: Schema.optional(TrimmedNonEmptyString),
  delegationTransition: Schema.optional(Schema.Literals(["assigned", "continued", "replaced"])),
  executionAuthority: Schema.optional(CollaborationExecutionAuthority),
  workspaceBinding: Schema.optional(WorkspaceBinding),
  createdAt: IsoDateTime,
});

export const ThreadQueuedTurnCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedTurn: OrchestrationQueuedTurn,
});

export const ThreadQueuedTurnUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  text: Schema.String,
  origin: Schema.optional(MessageOrigin),
  updatedAt: IsoDateTime,
});

export const ThreadQueuedTurnDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  deletedAt: IsoDateTime,
});

export const ThreadQueuedTurnDispatchedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  messageId: MessageId,
  dispatchedAt: IsoDateTime,
});

export const ThreadQueuedTurnFailedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedTurnId: QueuedTurnId,
  failureMessage: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});

export const ThreadProviderForkRequestedPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  targetMessageId: MessageId,
  targetTurnId: Schema.NullOr(TurnId),
  targetTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadValidationRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  request: ValidationRequest,
});

export const ThreadValidationRequestFailedPayload = Schema.Struct({
  threadId: ThreadId,
  failure: ValidationRequestFailure,
});

export const ThreadValidationRunPlannedPayload = Schema.Struct({
  threadId: ThreadId,
  run: ValidationRun,
});

export const ThreadValidationLifecycleUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  update: ValidationRunLifecycleUpdate,
});

export const ThreadValidationLeaseClaimedPayload = Schema.Struct({
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  lease: ValidationLease,
});

export const ThreadValidationLeaseReleasedPayload = Schema.Struct({
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  leaseId: TrimmedNonEmptyString,
  releasedAt: IsoDateTime,
});

export const ThreadValidationResultRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  result: ValidationStructuredResult,
});

export const ThreadValidationGateUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  gate: ValidationGate,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: OrchestrationCheckpointFiles,
  agentTouchedPaths: OrchestrationAgentTouchedPaths.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  turnFiles: OrchestrationCheckpointFiles.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadChildLifecycleNotifiedPayload = ChildThreadLifecycleNotification;

export const WorkflowRunRequestedPayload = Schema.Struct({
  run: WorkflowRun,
  definition: WorkflowDefinition,
  workerConfig: WorkflowWorkerConfig,
});

export const WorkflowArtifactCreatedPayload = Schema.Struct({
  artifact: WorkflowArtifact,
});

export const WorkflowNodeWorkerStartedPayload = Schema.Struct({
  runId: WorkflowRunId,
  nodeId: WorkflowNodeId,
  workerThreadId: ThreadId,
  startedAt: IsoDateTime,
});

export const WorkflowWorkerResultRecordedPayload = Schema.Struct({
  runId: WorkflowRunId,
  artifact: WorkflowArtifact,
  completedAt: IsoDateTime,
});

export const WorkflowRunFinalizedPayload = Schema.Struct({
  runId: WorkflowRunId,
  parentThreadId: ThreadId,
  artifact: WorkflowArtifact,
  status: Schema.Literals(["completed", "failed"]),
  completedAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, WorkflowRunId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.decoupled"),
    payload: ThreadDecoupledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.collaboration-request-updated"),
    payload: ThreadCollaborationRequestUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.collaboration-state-cleared"),
    payload: ThreadCollaborationStateClearedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-linked"),
    payload: ThreadPullRequestLinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-unlinked"),
    payload: ThreadPullRequestUnlinkedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pull-request-rekeyed"),
    payload: ThreadPullRequestRekeyedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pending-runtime-mode-set"),
    payload: ThreadPendingRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.review-result-set"),
    payload: ThreadReviewResultSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-turn-created"),
    payload: ThreadQueuedTurnCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-turn-updated"),
    payload: ThreadQueuedTurnUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-turn-deleted"),
    payload: ThreadQueuedTurnDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-turn-dispatched"),
    payload: ThreadQueuedTurnDispatchedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-turn-failed"),
    payload: ThreadQueuedTurnFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.provider-fork-requested"),
    payload: ThreadProviderForkRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-requested"),
    payload: ThreadValidationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-request-failed"),
    payload: ThreadValidationRequestFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-run-planned"),
    payload: ThreadValidationRunPlannedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-lifecycle-updated"),
    payload: ThreadValidationLifecycleUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-lease-claimed"),
    payload: ThreadValidationLeaseClaimedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-lease-released"),
    payload: ThreadValidationLeaseReleasedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-result-recorded"),
    payload: ThreadValidationResultRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.validation-gate-updated"),
    payload: ThreadValidationGateUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.child-lifecycle-notified"),
    payload: ThreadChildLifecycleNotifiedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workflow.run-requested"),
    payload: WorkflowRunRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workflow.artifact-created"),
    payload: WorkflowArtifactCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workflow.node-worker-started"),
    payload: WorkflowNodeWorkerStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workflow.worker-result-recorded"),
    payload: WorkflowWorkerResultRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workflow.run-finalized"),
    payload: WorkflowRunFinalizedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("workflow-event"),
    sequence: NonNegativeInt,
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
    sequence: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
    sequence: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const TurnDiffScope = Schema.Literals(["turn", "snapshot"]);
export type TurnDiffScope = typeof TurnDiffScope.Type;

export const DiffLineType = Schema.Literals(["context", "add", "delete", "hunk"]);
export type DiffLineType = typeof DiffLineType.Type;

export const DiffLine = Schema.Struct({
  type: DiffLineType,
  oldLineNumber: Schema.NullOr(NonNegativeInt),
  newLineNumber: Schema.NullOr(NonNegativeInt),
  text: Schema.String,
});
export type DiffLine = typeof DiffLine.Type;

export const DiffHunk = Schema.Struct({
  oldStartLine: NonNegativeInt,
  oldLineCount: NonNegativeInt,
  newStartLine: NonNegativeInt,
  newLineCount: NonNegativeInt,
  lines: Schema.Array(DiffLine),
});
export type DiffHunk = typeof DiffHunk.Type;

export const DiffFileStatus = Schema.Literals([
  "new",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "unknown",
]);
export type DiffFileStatus = typeof DiffFileStatus.Type;

export const DiffSize = Schema.Literals(["normal", "large", "unrenderable"]);
export type DiffSize = typeof DiffSize.Type;

export const DiffFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  previousPath: Schema.NullOr(TrimmedNonEmptyString),
  status: DiffFileStatus,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  hunks: Schema.Array(DiffHunk),
  isBinary: Schema.Boolean,
  size: DiffSize,
  hasHiddenBidiChars: Schema.Boolean,
});
export type DiffFile = typeof DiffFile.Type;

export const DiffMetadata = Schema.Struct({
  filesChanged: NonNegativeInt,
  totalAdditions: NonNegativeInt,
  totalDeletions: NonNegativeInt,
  largeFiles: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  unrenderableFiles: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type DiffMetadata = typeof DiffMetadata.Type;

export const DiffMetadataRefreshed = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    scope: TurnDiffScope,
    metadata: DiffMetadata,
    files: Schema.Array(DiffFile),
  }),
  { unsafePreserveChecks: true },
);
export type DiffMetadataRefreshed = typeof DiffMetadataRefreshed.Type;

export const DiffFileDelta = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    scope: TurnDiffScope,
    path: TrimmedNonEmptyString,
    file: Schema.NullOr(DiffFile),
    metadata: DiffMetadata,
  }),
  { unsafePreserveChecks: true },
);
export type DiffFileDelta = typeof DiffFileDelta.Type;

export const DiffSnapshot = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    scope: TurnDiffScope,
    patch: Schema.String,
    metadata: DiffMetadata,
    files: Schema.Array(DiffFile),
  }),
  { unsafePreserveChecks: true },
);
export type DiffSnapshot = typeof DiffSnapshot.Type;

const DiffLoadingState = TurnCountRange.mapFields(
  Struct.assign({
    _tag: Schema.Literal("loading"),
    threadId: ThreadId,
    scope: TurnDiffScope,
  }),
  { unsafePreserveChecks: true },
);

const DiffUnavailableState = TurnCountRange.mapFields(
  Struct.assign({
    _tag: Schema.Literal("unavailable"),
    threadId: ThreadId,
    scope: TurnDiffScope,
    message: TrimmedNonEmptyString,
  }),
  { unsafePreserveChecks: true },
);

const DiffErrorState = TurnCountRange.mapFields(
  Struct.assign({
    _tag: Schema.Literal("error"),
    threadId: ThreadId,
    scope: TurnDiffScope,
    message: TrimmedNonEmptyString,
  }),
  { unsafePreserveChecks: true },
);

export const DiffState = Schema.Union([
  Schema.TaggedStruct("ready", {
    snapshot: DiffSnapshot,
  }),
  Schema.TaggedStruct("stale", {
    snapshot: DiffSnapshot,
    message: TrimmedNonEmptyString,
  }),
  DiffLoadingState,
  DiffUnavailableState,
  DiffErrorState,
]);
export type DiffState = typeof DiffState.Type;

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: OrchestrationCheckpointFiles,
  agentTouchedPaths: OrchestrationAgentTouchedPaths.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  turnFiles: OrchestrationCheckpointFiles.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
  threadUrl: Schema.optionalKey(ThreadUrl),
  /** Fencing outcome for thread.child.report commands; absent otherwise. */
  reportVerdict: Schema.optionalKey(DispatchReportVerdict),
  collaborationOutcome: Schema.optionalKey(CollaborationRequestTerminalOutcome),
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationSearchTranscriptInput = Schema.Struct({
  query: Schema.String,
});
export type OrchestrationSearchTranscriptInput = typeof OrchestrationSearchTranscriptInput.Type;

export const OrchestrationTranscriptSearchMatch = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  role: Schema.Literals(["user", "assistant"]),
  excerpt: Schema.String,
  updatedAt: IsoDateTime,
});
export type OrchestrationTranscriptSearchMatch = typeof OrchestrationTranscriptSearchMatch.Type;

export const OrchestrationSearchTranscriptResult = Schema.Struct({
  matches: Schema.Array(OrchestrationTranscriptSearchMatch),
});
export type OrchestrationSearchTranscriptResult = typeof OrchestrationSearchTranscriptResult.Type;

export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: Schema.Literals(["user", "assistant"]),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    scope: TurnDiffScope.pipe(Schema.withDecodingDefault(Effect.succeed("snapshot" as const))),
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optionalKey(TurnId),
  beforeCreatedAt: IsoDateTime,
  beforeActivityId: EventId,
  limit: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationGetThreadActivitiesInput =
  typeof OrchestrationGetThreadActivitiesInput.Type;

export const OrchestrationGetThreadActivitiesResult = Schema.Struct({
  activities: Schema.Array(OrchestrationThreadActivity),
  hasMore: Schema.Boolean,
});
export type OrchestrationGetThreadActivitiesResult =
  typeof OrchestrationGetThreadActivitiesResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationGetTurnDiffStateInput = OrchestrationGetTurnDiffInput;
export type OrchestrationGetTurnDiffStateInput = typeof OrchestrationGetTurnDiffStateInput.Type;

export const OrchestrationGetTurnDiffStateResult = DiffState;
export type OrchestrationGetTurnDiffStateResult = typeof OrchestrationGetTurnDiffStateResult.Type;

export const OrchestrationGetTurnDiffFileDeltaInput = OrchestrationGetTurnDiffInput.mapFields(
  Struct.assign({
    path: TrimmedNonEmptyString,
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffFileDeltaInput =
  typeof OrchestrationGetTurnDiffFileDeltaInput.Type;

export const OrchestrationGetTurnDiffFileDeltaResult = DiffFileDelta;
export type OrchestrationGetTurnDiffFileDeltaResult =
  typeof OrchestrationGetTurnDiffFileDeltaResult.Type;

export const OrchestrationGetFullThreadDiffStateInput = OrchestrationGetFullThreadDiffInput;
export type OrchestrationGetFullThreadDiffStateInput =
  typeof OrchestrationGetFullThreadDiffStateInput.Type;

export const OrchestrationGetFullThreadDiffStateResult = DiffState;
export type OrchestrationGetFullThreadDiffStateResult =
  typeof OrchestrationGetFullThreadDiffStateResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  readThread: {
    input: OrchestrationReadThreadInput,
    output: OrchestrationReadThreadResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getThreadActivities: {
    input: OrchestrationGetThreadActivitiesInput,
    output: OrchestrationGetThreadActivitiesResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getTurnDiffState: {
    input: OrchestrationGetTurnDiffStateInput,
    output: OrchestrationGetTurnDiffStateResult,
  },
  getFullThreadDiffState: {
    input: OrchestrationGetFullThreadDiffStateInput,
    output: OrchestrationGetFullThreadDiffStateResult,
  },
  searchTranscript: {
    input: OrchestrationSearchTranscriptInput,
    output: OrchestrationSearchTranscriptResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  getShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  getThreadSnapshot: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadDetailSnapshot,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationReadThreadInputError extends Schema.TaggedErrorClass<OrchestrationReadThreadInputError>()(
  "OrchestrationReadThreadInputError",
  {
    message: TrimmedNonEmptyString,
  },
) {}

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationGetThreadActivitiesError extends Schema.TaggedErrorClass<OrchestrationGetThreadActivitiesError>()(
  "OrchestrationGetThreadActivitiesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationGetTurnDiffStateError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffStateError>()(
  "OrchestrationGetTurnDiffStateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationGetFullThreadDiffStateError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffStateError>()(
  "OrchestrationGetFullThreadDiffStateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);

export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);

export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

export const ProjectIconOverride = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lucide"),
    name: ProjectLucideIconName,
    color: ProjectIconColor,
  }),
  Schema.Struct({
    kind: Schema.Literal("emoji"),
    emoji: ProjectEmoji,
  }),
]);

export type ProjectIconOverride = typeof ProjectIconOverride.Type;

export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const ProviderSendTurnSupportedImageMimeType = TrimmedNonEmptyString.check(
  Schema.isPattern(
    new RegExp(`^(?:${PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.join("|")})$`, "i"),
  ),
);

export const isProviderSendTurnSupportedImageMimeType = Schema.is(
  ProviderSendTurnSupportedImageMimeType,
);

export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});

export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(TrimmedNonEmptyString),
});

export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;
