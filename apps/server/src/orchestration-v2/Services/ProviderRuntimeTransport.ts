import type { ProviderReplayEntry } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export type ProviderRuntimeInbound =
  | { readonly type: "frame"; readonly frame: unknown }
  | Extract<ProviderReplayEntry, { readonly type: "runtime_exit" }>;

export class ProviderRuntimeTranscriptExhaustedError extends Schema.TaggedErrorClass<ProviderRuntimeTranscriptExhaustedError>()(
  "ProviderRuntimeTranscriptExhaustedError",
  {
    scenario: Schema.String,
    direction: Schema.Literals(["outbound", "inbound"]),
    frame: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Replay transcript '${this.scenario}' is exhausted before ${this.direction} frame.`;
  }
}

export class ProviderRuntimeUnexpectedOutboundError extends Schema.TaggedErrorClass<ProviderRuntimeUnexpectedOutboundError>()(
  "ProviderRuntimeUnexpectedOutboundError",
  {
    scenario: Schema.String,
    index: Schema.Number,
    expectedEntry: Schema.optional(Schema.Unknown),
    actualFrame: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Replay transcript '${this.scenario}' expected inbound data at index ${this.index}, but transport sent an outbound frame.`;
  }
}

export class ProviderRuntimeUnexpectedInboundPullError extends Schema.TaggedErrorClass<ProviderRuntimeUnexpectedInboundPullError>()(
  "ProviderRuntimeUnexpectedInboundPullError",
  {
    scenario: Schema.String,
    index: Schema.Number,
    expectedFrame: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Replay transcript '${this.scenario}' expected outbound frame at index ${this.index}, but transport was pulled for inbound data.`;
  }
}

export class ProviderRuntimeOutboundMismatchError extends Schema.TaggedErrorClass<ProviderRuntimeOutboundMismatchError>()(
  "ProviderRuntimeOutboundMismatchError",
  {
    scenario: Schema.String,
    index: Schema.Number,
    expectedFrame: Schema.Unknown,
    actualFrame: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Replay transcript '${this.scenario}' outbound frame mismatch at index ${this.index}.`;
  }
}

export class ProviderRuntimeIncompleteTranscriptError extends Schema.TaggedErrorClass<ProviderRuntimeIncompleteTranscriptError>()(
  "ProviderRuntimeIncompleteTranscriptError",
  {
    scenario: Schema.String,
    index: Schema.Number,
    total: Schema.Number,
    nextEntry: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Replay transcript '${this.scenario}' stopped at index ${this.index} of ${this.total}.`;
  }
}

export const ProviderRuntimeTransportError = Schema.Union([
  ProviderRuntimeTranscriptExhaustedError,
  ProviderRuntimeUnexpectedOutboundError,
  ProviderRuntimeUnexpectedInboundPullError,
  ProviderRuntimeOutboundMismatchError,
  ProviderRuntimeIncompleteTranscriptError,
]);
export type ProviderRuntimeTransportError = typeof ProviderRuntimeTransportError.Type;

export interface ProviderRuntimeTransportShape {
  readonly send: (frame: unknown) => Effect.Effect<void, ProviderRuntimeTransportError>;
  readonly receive: () => Effect.Effect<ProviderRuntimeInbound, ProviderRuntimeTransportError>;
  readonly assertComplete: () => Effect.Effect<void, ProviderRuntimeTransportError>;
}

export class ProviderRuntimeTransport extends Context.Service<
  ProviderRuntimeTransport,
  ProviderRuntimeTransportShape
>()("t3/orchestration-v2/Services/ProviderRuntimeTransport") {}
