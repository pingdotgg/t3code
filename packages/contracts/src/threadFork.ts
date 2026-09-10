import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const ThreadForkInput = Schema.Struct({
  sourceThreadId: ThreadId,
  newThreadId: ThreadId,
  modelSelection: ModelSelection,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  threadId: ThreadId,
  sequence: NonNegativeInt,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export const ThreadForkFailureReason = Schema.Literals([
  "source_not_found",
  "source_busy",
  "target_conflict",
  "target_provider_unavailable",
  "transcript_too_large",
  "internal",
]);
export type ThreadForkFailureReason = typeof ThreadForkFailureReason.Type;

export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  sourceThreadId: ThreadId,
  newThreadId: ThreadId,
  reason: ThreadForkFailureReason,
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "source_not_found":
        return "The conversation to fork was not found.";
      case "source_busy":
        return "Wait for the current response to finish, or stop it, before forking this conversation.";
      case "target_conflict":
        return "A different conversation already uses the requested fork identifier.";
      case "target_provider_unavailable":
        return "The selected provider is not available in this environment.";
      case "transcript_too_large":
        return "This conversation is too large to hand off as a single transcript.";
      case "internal":
        return this.detail ?? "Failed to fork the conversation.";
    }
  }
}
