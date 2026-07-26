import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";

const BoundedResultLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

export const ReadThreadInput = Schema.Struct({
  threadId: Schema.String.annotate({
    description:
      "A T3 Code thread ID or a provider-native thread ID copied from a T3 Code thread menu.",
  }),
  messageLimit: Schema.optionalKey(
    BoundedResultLimit.annotate({
      description:
        "Maximum number of newest conversation messages to return. Defaults to 50 and must be between 1 and 200.",
    }),
  ),
  activityLimit: Schema.optionalKey(
    BoundedResultLimit.annotate({
      description:
        "Maximum number of newest activity summaries to return. Defaults to 50 and must be between 1 and 200.",
    }),
  ),
});
export type ReadThreadInput = typeof ReadThreadInput.Type;

const ThreadReadMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  streaming: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ThreadReadActivity = Schema.Struct({
  id: Schema.String,
  tone: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  createdAt: Schema.String,
});

const ThreadReadLatestTurn = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});

export const ReadThreadResult = Schema.Struct({
  threadId: Schema.String,
  providerThreadId: Schema.optionalKey(Schema.String),
  title: Schema.String,
  project: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    workspaceRoot: Schema.String,
  }),
  provider: Schema.NullOr(Schema.String),
  status: Schema.String,
  latestTurn: Schema.NullOr(ThreadReadLatestTurn),
  messages: Schema.Array(ThreadReadMessage),
  activities: Schema.Array(ThreadReadActivity),
  totals: Schema.Struct({
    messages: Schema.Int,
    activities: Schema.Int,
  }),
  truncated: Schema.Struct({
    messages: Schema.Boolean,
    activities: Schema.Boolean,
  }),
});
export type ReadThreadResult = typeof ReadThreadResult.Type;

export class ThreadReadUnavailableError extends Schema.TaggedErrorClass<ThreadReadUnavailableError>()(
  "ThreadReadUnavailableError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return "This MCP credential does not grant cross-thread read access.";
  }
}

export class ThreadReadNotFoundError extends Schema.TaggedErrorClass<ThreadReadNotFoundError>()(
  "ThreadReadNotFoundError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `No readable T3 Code thread was found for '${this.threadId}'.`;
  }
}

export class ThreadReadAmbiguousError extends Schema.TaggedErrorClass<ThreadReadAmbiguousError>()(
  "ThreadReadAmbiguousError",
  {
    threadId: Schema.String,
    matchCount: Schema.Int,
  },
) {
  override get message(): string {
    return `Provider thread ID '${this.threadId}' matches multiple T3 Code threads; use a T3 thread ID instead.`;
  }
}

export class ThreadReadFailedError extends Schema.TaggedErrorClass<ThreadReadFailedError>()(
  "ThreadReadFailedError",
  {
    operation: Schema.String,
  },
) {
  override get message(): string {
    return `T3 Code could not read the requested thread during ${this.operation}.`;
  }
}

export const ThreadReadError = Schema.Union([
  ThreadReadUnavailableError,
  ThreadReadNotFoundError,
  ThreadReadAmbiguousError,
  ThreadReadFailedError,
]);
export type ThreadReadError = typeof ThreadReadError.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  ProviderSessionDirectory,
];

export const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read another T3 Code conversation by its T3 thread ID or copied provider-native thread ID. Returns current status plus bounded recent messages and activity summaries without resuming, steering, or modifying the target thread.",
  parameters: ReadThreadInput,
  success: ReadThreadResult,
  failure: ThreadReadError,
  dependencies,
})
  .annotate(Tool.Title, "Read T3 Code thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadControlToolkit = Toolkit.make(ReadThreadTool);
