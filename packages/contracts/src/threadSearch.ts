import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnItemId,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;

const SearchQuery = TrimmedString.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  Schema.isPattern(/^[^\u0000]*$/u),
);

export const ThreadSearchCursor = Schema.Struct({
  source: Schema.optionalKey(Schema.Literals(["messages", "tools"])),
  query: SearchQuery,
  projectId: Schema.NullOr(ProjectId),
  includeArchived: Schema.Boolean,
  rank: Schema.Literals([0, 1, 2, 3]),
  updatedAt: IsoDateTime,
  threadId: ThreadId,
});

export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: SearchQuery,
  cursor: Schema.optionalKey(ThreadSearchCursor),
  projectId: Schema.optionalKey(ProjectId),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.optionalKey(Schema.String),
  source: OrchestrationThreadSearchSource,
  messageId: Schema.optionalKey(MessageId),
  itemId: Schema.optionalKey(TurnItemId),
  digest: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  /**
   * How well the message matches: 1 for whole words, 0.8 when a word only
   * starts one, 0.3 when one only appears inside words, 0.25 more when the
   * words are written together as typed, else 0.1 more when they are near.
   * Older servers omit it.
   */
  quality: Schema.optionalKey(Schema.Finite),
  /** How many of the thread's newest messages match. Older servers omit it. */
  hits: Schema.optionalKey(Schema.Int),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
  nextCursor: Schema.optionalKey(Schema.NullOr(ThreadSearchCursor)),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
