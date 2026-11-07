import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

export const ProviderContextUsageInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderContextUsageInput = typeof ProviderContextUsageInput.Type;

/**
 * One slice of the live context window, as the provider itself accounts for
 * it. Deferred slices (tool schemas loaded on demand) are reported but do not
 * occupy the window yet, so clients show them without a percentage.
 */
export const ProviderContextUsageCategoryKind = Schema.Literals([
  "used",
  "free",
  "buffer",
  "deferred",
]);
export type ProviderContextUsageCategoryKind = typeof ProviderContextUsageCategoryKind.Type;

export const ProviderContextUsageCategory = Schema.Struct({
  name: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  deferred: Schema.Boolean,
  kind: Schema.optional(ProviderContextUsageCategoryKind),
});
export type ProviderContextUsageCategory = typeof ProviderContextUsageCategory.Type;

export const ProviderContextUsageDetailItem = Schema.Struct({
  name: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderContextUsageDetailItem = typeof ProviderContextUsageDetailItem.Type;

/** An expandable section under the category list, such as "MCP tools" listing every tool. */
export const ProviderContextUsageDetailGroup = Schema.Struct({
  label: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  items: Schema.Array(ProviderContextUsageDetailItem),
});
export type ProviderContextUsageDetailGroup = typeof ProviderContextUsageDetailGroup.Type;

/**
 * Point-in-time breakdown of what fills a thread's context window. Adapters
 * translate their provider's native report into this shape; providers without
 * a native breakdown do not implement the call.
 */
export const ProviderContextUsage = Schema.Struct({
  model: Schema.String,
  totalTokens: NonNegativeInt,
  maxTokens: PositiveInt,
  categories: Schema.Array(ProviderContextUsageCategory),
  groups: Schema.Array(ProviderContextUsageDetailGroup),
});
export type ProviderContextUsage = typeof ProviderContextUsage.Type;

export class ProviderContextUsageError extends Schema.TaggedError<ProviderContextUsageError>()(
  "ProviderContextUsageError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read context usage for thread ${this.threadId}.`;
  }
}
