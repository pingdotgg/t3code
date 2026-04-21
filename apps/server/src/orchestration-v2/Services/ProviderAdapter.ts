import {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RawProviderEvent,
  ProviderKind,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

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
    providerSessionId: ProviderSessionId,
    nativeThreadRef: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to ensure ${this.provider} provider thread.`;
  }
}

export class ProviderAdapterSendRunError extends Schema.TaggedErrorClass<ProviderAdapterSendRunError>()(
  "ProviderAdapterSendRunError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to send run to ${this.provider} provider thread ${this.providerThreadId}.`;
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
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to steer active run on ${this.provider} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterInterruptError extends Schema.TaggedErrorClass<ProviderAdapterInterruptError>()(
  "ProviderAdapterInterruptError",
  {
    provider: ProviderKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to interrupt ${this.provider} provider thread ${this.providerThreadId}.`;
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

export class ProviderAdapterRawEventStreamError extends Schema.TaggedErrorClass<ProviderAdapterRawEventStreamError>()(
  "ProviderAdapterRawEventStreamError",
  {
    provider: ProviderKind,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed while streaming raw ${this.provider} provider events.`;
  }
}

export const ProviderAdapterV2Error = Schema.Union([
  ProviderAdapterCapabilitiesError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterSendRunError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterRawEventStreamError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

export interface ProviderAdapterV2SendRunInput {
  readonly providerThreadId: ProviderThreadId;
  readonly input: unknown;
}

export interface ProviderAdapterV2ResumeInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
}

export interface ProviderAdapterV2Shape {
  readonly provider: ProviderKind;
  readonly getCapabilities: () => Effect.Effect<
    OrchestrationV2ProviderCapabilities,
    ProviderAdapterV2Error
  >;
  readonly resumeThread: (
    input: ProviderAdapterV2ResumeInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly ensureThread: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly nativeThreadRef?: unknown;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly sendRun: (
    input: ProviderAdapterV2SendRunInput,
  ) => Effect.Effect<OrchestrationV2ProviderTurn, ProviderAdapterV2Error>;
  readonly steerRun: (
    input: ProviderAdapterV2SendRunInput,
  ) => Effect.Effect<OrchestrationV2ProviderTurn, ProviderAdapterV2Error>;
  readonly interrupt: (input: {
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId?: string;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRequest: (input: {
    readonly requestId: RuntimeRequestId;
    readonly response: unknown;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly streamRawEvents: Stream.Stream<OrchestrationV2RawProviderEvent, ProviderAdapterV2Error>;
}

export class ProviderAdapterV2 extends Context.Service<ProviderAdapterV2, ProviderAdapterV2Shape>()(
  "t3/orchestration-v2/Services/ProviderAdapter",
) {}
