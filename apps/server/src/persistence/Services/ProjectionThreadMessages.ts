/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  MessageId,
  MessageOrigin,
  NonNegativeInt,
  OrchestrationMessageContext,
  OrchestrationMessageRole,
  ThreadId,
  TurnId,
  IsoDateTime,
} from "@t3tools/contracts";
import { Schema, Context } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  sequence: Schema.optional(Schema.NullOr(NonNegativeInt)),
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  origin: Schema.optional(MessageOrigin),
  context: Schema.optional(OrchestrationMessageContext),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

/**
 * Bounded forward page over a thread's messages in stable
 * `(created_at, message_id)` order. The cursor binds to the last row of the
 * previous page; `afterMessageId` without `afterCreatedAt` is rejected by
 * callers. `limit` is the maximum row count the database may return.
 */
export const ListProjectionThreadMessagePagesInput = Schema.Struct({
  threadId: ThreadId,
  afterCreatedAt: Schema.optional(IsoDateTime),
  afterMessageId: Schema.optional(MessageId),
  limit: NonNegativeInt,
});
export type ListProjectionThreadMessagePagesInput =
  typeof ListProjectionThreadMessagePagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

export const DeleteProjectionThreadMessagesByIdsInput = Schema.Struct({
  threadId: ThreadId,
  messageIds: Schema.Array(MessageId),
});
export type DeleteProjectionThreadMessagesByIdsInput =
  typeof DeleteProjectionThreadMessagesByIdsInput.Type;

export const GetLatestUserMessageAtInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetLatestUserMessageAtInput = typeof GetLatestUserMessageAtInput.Type;

/**
 * Narrow message key for revert trimming: everything the retain logic needs
 * without message text, attachments, or origins.
 *
 * Returned in ascending creation order.
 */
export const ProjectionThreadMessageRevertKey = Schema.Struct({
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  createdAt: IsoDateTime,
});
export type ProjectionThreadMessageRevertKey = typeof ProjectionThreadMessageRevertKey.Type;

/**
 * Narrow message row for attachment reconciliation: only the attachment
 * references, without message text or origins.
 *
 * Returned in ascending creation order.
 */
export const ProjectionThreadMessageAttachmentRef = Schema.Struct({
  messageId: MessageId,
  attachments: Schema.NullOr(Schema.Array(ChatAttachment)),
});
export type ProjectionThreadMessageAttachmentRef = typeof ProjectionThreadMessageAttachmentRef.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `messageId`.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List one bounded page of projected thread messages for a thread.
   *
   * Filtering and the row cap happen in SQL before any payload is decoded,
   * so large threads never hydrate fully. Returned in ascending creation
   * order.
   */
  readonly listMessagesPage: (
    input: ListProjectionThreadMessagePagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List revert keys for a thread without fetching text, attachments, or origins.
   *
   * Cheaper than `listByThreadId` for revert trimming: only the columns the
   * retain logic inspects are read or decoded.
   */
  readonly listRevertKeysByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessageRevertKey>, ProjectionRepositoryError>;

  /**
   * List attachment references for a thread without fetching text or origins.
   *
   * Cheaper than `listByThreadId` for attachment reconciliation.
   */
  readonly listAttachmentRefsByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionThreadMessageAttachmentRef>,
    ProjectionRepositoryError
  >;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Delete only the listed messages of a thread, leaving the rest untouched.
   *
   * Unlike `deleteByThreadId` + re-upserting kept rows, this never rewrites
   * retained rows. An empty `messageIds` list deletes nothing.
   */
  readonly deleteByMessageIds: (
    input: DeleteProjectionThreadMessagesByIdsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read the newest user-authored message timestamp for a thread.
   *
   * Aggregate-only: never fetches message text, attachments, or origins.
   * Returns `null` when the thread has no user messages.
   */
  readonly getLatestUserMessageAt: (
    input: GetLatestUserMessageAtInput,
  ) => Effect.Effect<typeof IsoDateTime.Type | null, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends Context.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
