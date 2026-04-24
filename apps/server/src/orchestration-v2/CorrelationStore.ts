import {
  MessageId,
  NodeId,
  OrchestrationV2ProviderRef,
  ProviderKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

export const CorrelationScopeV2 = Schema.Struct({
  provider: ProviderKind,
  providerSessionId: Schema.optional(ProviderSessionId),
  providerThreadId: Schema.optional(ProviderThreadId),
  providerTurnId: Schema.optional(ProviderTurnId),
});
export type CorrelationScopeV2 = typeof CorrelationScopeV2.Type;

export const CorrelationEntityV2 = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thread"), id: ThreadId }),
  Schema.Struct({ type: Schema.Literal("run"), id: RunId }),
  Schema.Struct({ type: Schema.Literal("run_attempt"), id: RunAttemptId }),
  Schema.Struct({ type: Schema.Literal("node"), id: NodeId }),
  Schema.Struct({ type: Schema.Literal("message"), id: MessageId }),
  Schema.Struct({ type: Schema.Literal("provider_session"), id: ProviderSessionId }),
  Schema.Struct({ type: Schema.Literal("provider_thread"), id: ProviderThreadId }),
  Schema.Struct({ type: Schema.Literal("provider_turn"), id: ProviderTurnId }),
  Schema.Struct({ type: Schema.Literal("runtime_request"), id: RuntimeRequestId }),
  Schema.Struct({ type: Schema.Literal("turn_item"), id: TurnItemId }),
  Schema.Struct({ type: Schema.Literal("raw_event"), id: RawEventId }),
]);
export type CorrelationEntityV2 = typeof CorrelationEntityV2.Type;

export const CorrelationBindingV2 = Schema.Struct({
  scope: CorrelationScopeV2,
  providerRef: OrchestrationV2ProviderRef,
  entity: CorrelationEntityV2,
  createdByRawEventId: Schema.optional(RawEventId),
});
export type CorrelationBindingV2 = typeof CorrelationBindingV2.Type;

export class CorrelationBindError extends Schema.TaggedErrorClass<CorrelationBindError>()(
  "CorrelationBindError",
  {
    scope: CorrelationScopeV2,
    providerRef: OrchestrationV2ProviderRef,
    entity: CorrelationEntityV2,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to bind ${this.scope.provider} provider ref to ${this.entity.type}.`;
  }
}

export class CorrelationLookupError extends Schema.TaggedErrorClass<CorrelationLookupError>()(
  "CorrelationLookupError",
  {
    scope: CorrelationScopeV2,
    providerRef: Schema.optional(OrchestrationV2ProviderRef),
    entity: Schema.optional(CorrelationEntityV2),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to look up ${this.scope.provider} provider correlation.`;
  }
}

export class CorrelationOrdinalError extends Schema.TaggedErrorClass<CorrelationOrdinalError>()(
  "CorrelationOrdinalError",
  {
    scope: CorrelationScopeV2,
    key: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to allocate correlation ordinal for ${this.scope.provider}:${this.key}.`;
  }
}

export const CorrelationStoreV2Error = Schema.Union([
  CorrelationBindError,
  CorrelationLookupError,
  CorrelationOrdinalError,
]);
export type CorrelationStoreV2Error = typeof CorrelationStoreV2Error.Type;

export interface CorrelationStoreV2Shape {
  readonly bind: (binding: CorrelationBindingV2) => Effect.Effect<void, CorrelationStoreV2Error>;
  readonly lookupByProviderRef: (input: {
    readonly scope: CorrelationScopeV2;
    readonly providerRef: OrchestrationV2ProviderRef;
  }) => Effect.Effect<Option.Option<CorrelationBindingV2>, CorrelationStoreV2Error>;
  readonly lookupByEntity: (input: {
    readonly scope: CorrelationScopeV2;
    readonly entity: CorrelationEntityV2;
  }) => Effect.Effect<Option.Option<CorrelationBindingV2>, CorrelationStoreV2Error>;
  readonly nextOrdinal: (input: {
    readonly scope: CorrelationScopeV2;
    readonly key: string;
  }) => Effect.Effect<number, CorrelationStoreV2Error>;
}

export class CorrelationStoreV2 extends Context.Service<
  CorrelationStoreV2,
  CorrelationStoreV2Shape
>()("t3/orchestration-v2/CorrelationStore") {}
