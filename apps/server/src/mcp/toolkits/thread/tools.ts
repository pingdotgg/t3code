import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadArchiveFailedError extends Schema.TaggedError<ThreadArchiveFailedError>()(
  "ThreadArchiveFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not archive the thread.";
  }
}

export const ThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadNotFoundError,
  ThreadArchiveFailedError,
]);
export type ThreadToolError = typeof ThreadToolError.Type;

export const ArchiveThreadResult = Schema.Struct({
  threadId: Schema.String,
  alreadyArchived: Schema.Boolean.annotate({
    description: "True when the thread was archived before the call.",
  }),
  scheduled: Schema.Boolean.annotate({
    description:
      "True when the call came during a running turn and the archive waits for that turn to end.",
  }),
});
export type ArchiveThreadResult = typeof ArchiveThreadResult.Type;

const ArchiveThreadTool = Tool.make("archive_thread", {
  description:
    "Archive this thread in T3 Code. It leaves the active thread list but stays readable and can be unarchived. Call it only when the user asked for it, as your final action once all work in the thread is done. A call during your turn is deferred until the turn ends (scheduled=true), so finish your reply right after it; if a new user message starts another turn first, the archive is cancelled. Archiving an already-archived thread succeeds with alreadyArchived=true.",
  success: ArchiveThreadResult,
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Archive this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(ArchiveThreadTool);
