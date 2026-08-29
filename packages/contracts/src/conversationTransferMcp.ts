import * as Schema from "effect/Schema";

import { CommandId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2ContextTransferType,
  OrchestrationV2ThreadForkSourcePoint,
} from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const WellFormedRequestKey = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      (value.length > 0 && value === value.trim()) ||
      "The request key must be non-empty and must not have surrounding whitespace.",
  ),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value: string) =>
      hasWellFormedUnicode(value) ||
      "The request key must not contain unpaired Unicode surrogates.",
  ),
).annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

const TransferPageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const ConversationTransferListInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread in the calling project; defaults to this thread.",
    }),
  ),
  type: Schema.optional(OrchestrationV2ContextTransferType),
  limit: Schema.optional(TransferPageLimit),
});
export type ConversationTransferListInput = typeof ConversationTransferListInput.Type;

export const ConversationTransferListResult = Schema.Struct({
  threadId: ThreadId,
  scope: Schema.Literal("current_project"),
  transfers: Schema.Array(OrchestrationV2ContextTransfer),
  hasMore: Schema.Boolean,
});
export type ConversationTransferListResult = typeof ConversationTransferListResult.Type;

export const ConversationForkInput = Schema.Struct({
  sourceThreadId: Schema.optional(
    ThreadId.annotate({
      description: "Source thread in the calling project; defaults to this thread.",
    }),
  ),
  sourcePoint: OrchestrationV2ThreadForkSourcePoint.annotate({
    description:
      "Explicit stable source: the latest completed run, one completed run id, or a checkpoint on a completed run.",
  }),
  title: Schema.optional(TrimmedNonEmptyString),
  clientRequestId: WellFormedRequestKey,
});
export type ConversationForkInput = typeof ConversationForkInput.Type;

export const ConversationForkNativeEligibility = Schema.Literals([
  "eligible",
  "provider_does_not_support_fork",
  "provider_does_not_support_turn_fork",
  "strong_native_source_unavailable",
  "source_provider_session_unavailable",
]);
export type ConversationForkNativeEligibility = typeof ConversationForkNativeEligibility.Type;

export const ConversationForkProviderSupport = Schema.Struct({
  sourceProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  nativeForkEligibility: ConversationForkNativeEligibility,
  resolutionTiming: Schema.Literal("first_target_turn"),
  fallback: Schema.Literal("provider_context_capabilities_checked_on_first_target_turn"),
});
export type ConversationForkProviderSupport = typeof ConversationForkProviderSupport.Type;

export const ConversationTransferReceipt = Schema.Struct({
  commandId: CommandId,
  commandType: Schema.Literals(["thread.fork", "thread.merge_back"]),
  sequence: NonNegativeInt,
  eventIds: Schema.Array(Schema.String),
});
export type ConversationTransferReceipt = typeof ConversationTransferReceipt.Type;

export const ConversationForkResult = Schema.Struct({
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  scope: Schema.Literal("conversation_through_source_point"),
  requestedSourcePoint: OrchestrationV2ThreadForkSourcePoint,
  canonicalSourcePoint: OrchestrationV2ContextSourcePoint,
  transfer: OrchestrationV2ContextTransfer,
  providerSupport: ConversationForkProviderSupport,
  receipt: ConversationTransferReceipt,
});
export type ConversationForkResult = typeof ConversationForkResult.Type;
