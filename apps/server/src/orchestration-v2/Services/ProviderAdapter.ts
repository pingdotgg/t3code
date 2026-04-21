import {
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeItem,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
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
import type { Effect, Stream } from "effect";

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
});
export type ProviderAdapterV2TurnMessage = typeof ProviderAdapterV2TurnMessage.Type;

export const ProviderAdapterV2Event = Schema.Union([
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
    type: Schema.Literal("runtime_item.updated"),
    provider: ProviderKind,
    runtimeItem: OrchestrationV2RuntimeItem,
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
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterTurnStartError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterProtocolError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

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
  readonly response?: unknown;
}

export interface ProviderAdapterV2Shape {
  readonly provider: ProviderKind;
  readonly getCapabilities: () => Effect.Effect<
    OrchestrationV2ProviderCapabilities,
    ProviderAdapterV2Error
  >;
  readonly ensureThread: (
    input: ProviderAdapterV2EnsureThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly resumeThread: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly startTurn: (
    input: ProviderAdapterV2TurnInput,
  ) => Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly steerTurn: (
    input: ProviderAdapterV2SteerInput,
  ) => Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly interruptTurn: (
    input: ProviderAdapterV2InterruptInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRuntimeRequest: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
}

export class ProviderAdapterV2 extends Context.Service<ProviderAdapterV2, ProviderAdapterV2Shape>()(
  "t3/orchestration-v2/Services/ProviderAdapter",
) {}
