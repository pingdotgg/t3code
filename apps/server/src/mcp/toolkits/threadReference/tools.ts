import {
  ThreadReferenceReadError,
  ThreadReferenceReadInput,
  ThreadReferenceReadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const ThreadReadTool = Tool.make("thread_read", {
  description:
    "Read a T3 Code chat thread referenced by a t3-thread link in the user's message. For t3-thread:///ENVIRONMENT_ID/THREAD_ID, pass the final THREAD_ID as threadId. The full t3-thread link and ENVIRONMENT_ID/THREAD_ID are also accepted. The transcript is paginated; when nextCursor is non-null, call thread_read again with that cursor to continue. Do not call this for unrelated threads that the user did not reference.",
  parameters: ThreadReferenceReadInput,
  success: ThreadReferenceReadResult,
  failure: ThreadReferenceReadError,
  dependencies: [McpInvocationContext.McpInvocationContext, ProjectionSnapshotQuery],
})
  .annotate(Tool.Title, "Read referenced chat thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReferenceToolkit = Toolkit.make(ThreadReadTool);
