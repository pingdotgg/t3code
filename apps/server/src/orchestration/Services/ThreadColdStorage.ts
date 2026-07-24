import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ThreadColdStorageError extends Schema.TaggedErrorClass<ThreadColdStorageError>()(
  "ThreadColdStorageError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cold thread storage failed during ${this.operation} for '${this.threadId}'.`;
  }
}

export class ThreadColdStorage extends Context.Service<
  ThreadColdStorage,
  {
    readonly archiveThread: (threadId: ThreadId) => Effect.Effect<void, ThreadColdStorageError>;
    readonly restoreTree: (threadId: ThreadId) => Effect.Effect<boolean, ThreadColdStorageError>;
    readonly rollbackRestoreTree: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadColdStorageError>;
    readonly finishRestoreTree: (threadId: ThreadId) => Effect.Effect<void, ThreadColdStorageError>;
    readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, ThreadColdStorageError>;
    readonly removeProviderLogs: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadColdStorageError>;
    readonly compactLegacyStorage: Effect.Effect<void, ThreadColdStorageError>;
    readonly listPendingArchiveThreadIds: Effect.Effect<
      ReadonlyArray<ThreadId>,
      ThreadColdStorageError
    >;
    readonly listPendingDeleteThreadIds: Effect.Effect<
      ReadonlyArray<ThreadId>,
      ThreadColdStorageError
    >;
  }
>()("t3/orchestration/Services/ThreadColdStorage") {}
