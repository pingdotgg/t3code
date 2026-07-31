/**
 * CopilotAdapter — shape type for the GitHub Copilot provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/CopilotDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module CopilotAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class CopilotAdapterValidationError extends Schema.TaggedErrorClass<CopilotAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

export class CopilotAdapterSessionNotFoundError extends Schema.TaggedErrorClass<CopilotAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

export class CopilotAdapterSessionClosedError extends Schema.TaggedErrorClass<CopilotAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

export class CopilotAdapterRequestError extends Schema.TaggedErrorClass<CopilotAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

export class CopilotAdapterProcessError extends Schema.TaggedErrorClass<CopilotAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

export type CopilotAdapterError =
  | CopilotAdapterValidationError
  | CopilotAdapterSessionNotFoundError
  | CopilotAdapterSessionClosedError
  | CopilotAdapterRequestError
  | CopilotAdapterProcessError;

/**
 * CopilotAdapterShape — per-instance GitHub Copilot adapter contract.
 */
export interface CopilotAdapterShape {
  readonly provider: ProviderDriverKind;
  readonly capabilities: {
    readonly sessionModelSwitch: "in-session" | "unsupported";
  };
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, CopilotAdapterError>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CopilotAdapterError>;
  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<void, CopilotAdapterError>;
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CopilotAdapterError>;
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CopilotAdapterError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, CopilotAdapterError>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly turns: ReadonlyArray<{
        readonly id: TurnId;
        readonly items: ReadonlyArray<unknown>;
      }>;
    },
    CopilotAdapterError
  >;
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly turns: ReadonlyArray<{
        readonly id: TurnId;
        readonly items: ReadonlyArray<unknown>;
      }>;
    },
    CopilotAdapterError
  >;
  readonly stopAll: () => Effect.Effect<void, CopilotAdapterError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
