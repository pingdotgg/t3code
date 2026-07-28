import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BranchThreadInput = Schema.Struct({
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Optional title for the new thread. When omitted, the server derives one from the current thread.",
    }),
  ),
});
export type BranchThreadInput = typeof BranchThreadInput.Type;

export const BranchThreadResult = Schema.Struct({
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  copiedMessageCount: NonNegativeInt,
  omittedMessageCount: NonNegativeInt,
});
export type BranchThreadResult = typeof BranchThreadResult.Type;

export const BranchThreadErrorReason = Schema.Literals([
  "capability-unavailable",
  "caller-thread-not-found",
  "dispatch-failed",
]);
export type BranchThreadErrorReason = typeof BranchThreadErrorReason.Type;

export class BranchThreadError extends Schema.TaggedErrorClass<BranchThreadError>()(
  "BranchThreadError",
  {
    reason: BranchThreadErrorReason,
    description: Schema.String,
  },
) {
  override get message(): string {
    return this.description;
  }
}
