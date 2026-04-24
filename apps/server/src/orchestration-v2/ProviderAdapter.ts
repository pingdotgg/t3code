import {
  ChatAttachment,
  CheckpointId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderSession,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RawProviderEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  ProviderUserInputAnswers,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeMode,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect, Scope, Stream } from "effect";

export const ProviderAdapterV2RuntimePolicy = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cwd: Schema.NullOr(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type ProviderAdapterV2RuntimePolicy = typeof ProviderAdapterV2RuntimePolicy.Type;

export const ProviderAdapterV2TurnMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export type ProviderAdapterV2TurnMessage = typeof ProviderAdapterV2TurnMessage.Type;

export const ProviderAdapterV2SessionStatus = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type ProviderAdapterV2SessionStatus = typeof ProviderAdapterV2SessionStatus.Type;

export const ProviderAdapterV2Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider_session.updated"),
    provider: ProviderKind,
    providerSession: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_thread.updated"),
    provider: ProviderKind,
    providerThread: OrchestrationV2ProviderThread,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    provider: ProviderKind,
    providerTurn: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    type: Schema.Literal("node.updated"),
    provider: ProviderKind,
    node: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    provider: ProviderKind,
    message: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_item.updated"),
    provider: ProviderKind,
    turnItem: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_request.updated"),
    provider: ProviderKind,
    runtimeRequest: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("plan.updated"),
    provider: ProviderKind,
    plan: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    provider: ProviderKind,
    providerTurnId: ProviderTurnId,
    status: Schema.Literals(["completed", "interrupted", "failed", "cancelled"]),
  }),
]);
export type ProviderAdapterV2Event = typeof ProviderAdapterV2Event.Type;

export class ProviderAdapterCapabilitiesError extends Schema.TaggedErrorClass<ProviderAdapterCapabilitiesError>()(
  "ProviderAdapterCapabilitiesError",
  {
    provider: ProviderKind,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to read ${this.provider} provider capabilities.`;
  }
}

export class ProviderAdapterOpenSessionError extends Schema.TaggedErrorClass<ProviderAdapterOpenSessionError>()(
  "ProviderAdapterOpenSessionError",
  {
    provider: ProviderKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to open ${this.provider} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterCloseSessionError extends Schema.TaggedErrorClass<ProviderAdapterCloseSessionError>()(
  "ProviderAdapterCloseSessionError",
  {
    provider: ProviderKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to close ${this.provider} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterResumeThreadError extends Schema.TaggedErrorClass<ProviderAdapterResumeThreadError>()(
  "ProviderAdapterResumeThreadError",
  {
    provider: ProviderKind,
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to resume ${this.provider} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterEnsureThreadError extends Schema.TaggedErrorClass<ProviderAdapterEnsureThreadError>()(
  "ProviderAdapterEnsureThreadError",
  {
    provider: ProviderKind,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to ensure ${this.provider} provider thread for app thread ${this.threadId}.`;
  }
}

export class ProviderAdapterReadThreadSnapshotError extends Schema.TaggedErrorClass<ProviderAdapterReadThreadSnapshotError>()(
  "ProviderAdapterReadThreadSnapshotError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to read ${this.provider} provider thread snapshot ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterRollbackThreadError extends Schema.TaggedErrorClass<ProviderAdapterRollbackThreadError>()(
  "ProviderAdapterRollbackThreadError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    checkpointId: Schema.optional(CheckpointId),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to roll back ${this.provider} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterForkThreadError extends Schema.TaggedErrorClass<ProviderAdapterForkThreadError>()(
  "ProviderAdapterForkThreadError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to fork ${this.provider} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterTurnStartError extends Schema.TaggedErrorClass<ProviderAdapterTurnStartError>()(
  "ProviderAdapterTurnStartError",
  {
    provider: ProviderKind,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    runId: RunId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to start run ${this.runId} on ${this.provider} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterSteerRunUnsupportedError extends Schema.TaggedErrorClass<ProviderAdapterSteerRunUnsupportedError>()(
  "ProviderAdapterSteerRunUnsupportedError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
  },
) {
  override get message(): string {
    return `${this.provider} provider thread ${this.providerThreadId} does not support active-run steering.`;
  }
}

export class ProviderAdapterSteerRunError extends Schema.TaggedErrorClass<ProviderAdapterSteerRunError>()(
  "ProviderAdapterSteerRunError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to steer active run ${this.providerTurnId} on ${this.provider} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterInterruptError extends Schema.TaggedErrorClass<ProviderAdapterInterruptError>()(
  "ProviderAdapterInterruptError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to interrupt ${this.provider} provider turn ${this.providerTurnId}.`;
  }
}

export class ProviderAdapterRuntimeRequestResponseError extends Schema.TaggedErrorClass<ProviderAdapterRuntimeRequestResponseError>()(
  "ProviderAdapterRuntimeRequestResponseError",
  {
    provider: ProviderKind,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to respond to ${this.provider} runtime request ${this.requestId}.`;
  }
}

export class ProviderAdapterEventStreamError extends Schema.TaggedErrorClass<ProviderAdapterEventStreamError>()(
  "ProviderAdapterEventStreamError",
  {
    provider: ProviderKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed while streaming ${this.provider} provider session ${this.providerSessionId} events.`;
  }
}

export class ProviderAdapterProtocolError extends Schema.TaggedErrorClass<ProviderAdapterProtocolError>()(
  "ProviderAdapterProtocolError",
  {
    provider: ProviderKind,
    detail: Schema.String,
    payload: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${this.provider} provider protocol error: ${this.detail}.`;
  }
}

export const ProviderAdapterV2Error = Schema.Union([
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterCloseSessionError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterTurnStartError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterEventStreamError,
  ProviderAdapterProtocolError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

export interface ProviderAdapterV2OpenSessionInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly resumeFromSession?: OrchestrationV2ProviderSession;
}

export interface ProviderAdapterV2EnsureThreadInput {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly providerSessionId?: ProviderSessionId;
  readonly existingProviderThread?: OrchestrationV2ProviderThread;
}

export interface ProviderAdapterV2TurnInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOrdinal: number;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2SteerInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly message: ProviderAdapterV2TurnMessage;
}

export interface ProviderAdapterV2InterruptInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
}

export interface ProviderAdapterV2RuntimeRequestResponseInput {
  readonly requestId: RuntimeRequestId;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
  readonly response?: unknown;
}

export interface ProviderAdapterV2ThreadSnapshot {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly providerPayload?: unknown;
}

export interface ProviderAdapterV2ReadThreadSnapshotInput {
  readonly providerThread: OrchestrationV2ProviderThread;
}

export interface ProviderAdapterV2RollbackThreadInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId?: ProviderTurnId;
  readonly providerPayload?: unknown;
}

export interface ProviderAdapterV2ForkThreadInput {
  readonly sourceProviderThread: OrchestrationV2ProviderThread;
  readonly providerTurnId?: ProviderTurnId;
  readonly targetThreadId: ThreadId;
  readonly ownerNodeId?: NodeId;
}

export interface ProviderAdapterV2SessionRuntime {
  readonly provider: ProviderKind;
  readonly providerSessionId: ProviderSessionId;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly rawEvents: Stream.Stream<OrchestrationV2RawProviderEvent, ProviderAdapterV2Error>;
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly ensureThread: (
    input: ProviderAdapterV2EnsureThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly resumeThread: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly startTurn: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly steerTurn: (
    input: ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly interruptTurn: (
    input: ProviderAdapterV2InterruptInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRuntimeRequest: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly readThreadSnapshot: (
    input: ProviderAdapterV2ReadThreadSnapshotInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly rollbackThread: (
    input: ProviderAdapterV2RollbackThreadInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly forkThread: (
    input: ProviderAdapterV2ForkThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
}

export interface ProviderAdapterV2Shape {
  readonly provider: ProviderKind;
  readonly getCapabilities: () => Effect.Effect<
    OrchestrationV2ProviderCapabilities,
    ProviderAdapterV2Error
  >;
  readonly openSession: (
    input: ProviderAdapterV2OpenSessionInput,
  ) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderAdapterV2Error, Scope.Scope>;
}

export class ProviderAdapterV2 extends Context.Service<ProviderAdapterV2, ProviderAdapterV2Shape>()(
  "t3/orchestration-v2/ProviderAdapter",
) {}
