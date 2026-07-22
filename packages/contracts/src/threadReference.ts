import * as Schema from "effect/Schema";

import { ChatAttachment, OrchestrationMessageRole } from "./orchestration.ts";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const THREAD_REFERENCE_DEFAULT_MAX_CHARS = 40_000;
export const THREAD_REFERENCE_MAX_CHARS = 80_000;

export const ThreadReferenceCursor = Schema.String.check(
  Schema.isPattern(/^\d+:\d+$/, {
    description: "Opaque transcript cursor returned by a previous thread_read call.",
  }),
);
export type ThreadReferenceCursor = typeof ThreadReferenceCursor.Type;

export const ThreadReferenceReadInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description:
      "Referenced thread id. Prefer the final THREAD_ID path segment; full t3-thread:///ENVIRONMENT_ID/THREAD_ID links and ENVIRONMENT_ID/THREAD_ID are also accepted.",
  }),
  cursor: Schema.optional(ThreadReferenceCursor).annotate({
    description: "nextCursor from the previous page. Omit for the first page.",
  }),
  maxChars: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000))
      .check(Schema.isLessThanOrEqualTo(THREAD_REFERENCE_MAX_CHARS))
      .annotate({
        description: `Maximum message-text characters to return. Defaults to ${THREAD_REFERENCE_DEFAULT_MAX_CHARS}; maximum ${THREAD_REFERENCE_MAX_CHARS}.`,
      }),
  ),
});
export type ThreadReferenceReadInput = typeof ThreadReferenceReadInput.Type;

export const ThreadReferenceTranscriptMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  textStart: NonNegativeInt,
  textEnd: NonNegativeInt,
  textComplete: Schema.Boolean,
  attachments: Schema.Array(ChatAttachment),
  createdAt: IsoDateTime,
});
export type ThreadReferenceTranscriptMessage = typeof ThreadReferenceTranscriptMessage.Type;

export const ThreadReferenceReadResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  messages: Schema.Array(ThreadReferenceTranscriptMessage),
  totalMessages: NonNegativeInt,
  nextCursor: Schema.NullOr(ThreadReferenceCursor),
});
export type ThreadReferenceReadResult = typeof ThreadReferenceReadResult.Type;

export class ThreadReferenceNotFoundError extends Schema.TaggedErrorClass<ThreadReferenceNotFoundError>()(
  "ThreadReferenceNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Referenced thread '${this.threadId}' was not found.`;
  }
}

export class ThreadReferenceInvalidCursorError extends Schema.TaggedErrorClass<ThreadReferenceInvalidCursorError>()(
  "ThreadReferenceInvalidCursorError",
  { threadId: ThreadId, cursor: Schema.String },
) {
  override get message(): string {
    return `Cursor '${this.cursor}' is invalid for referenced thread '${this.threadId}'.`;
  }
}

export class ThreadReferenceUnavailableError extends Schema.TaggedErrorClass<ThreadReferenceUnavailableError>()(
  "ThreadReferenceUnavailableError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Referenced thread '${this.threadId}' could not be read.`;
  }
}

export const ThreadReferenceReadError = Schema.Union([
  ThreadReferenceNotFoundError,
  ThreadReferenceInvalidCursorError,
  ThreadReferenceUnavailableError,
]);
export type ThreadReferenceReadError = typeof ThreadReferenceReadError.Type;
