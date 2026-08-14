import {
  ThreadReferenceReadError,
  ThreadReferenceReadInput,
  ThreadReferenceReadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read a T3 Code task referenced by a t3-thread link in the user's message. Pass the final THREAD_ID path segment, the complete link, or ENVIRONMENT_ID/THREAD_ID. Read only the context needed for the current request. When nextCursor is non-null, pass it back to continue. Never use this tool for an unrelated task the user did not reference.",
  parameters: ThreadReferenceReadInput,
  success: ThreadReferenceReadResult,
  failure: ThreadReferenceReadError,
  dependencies: [McpInvocationContext.McpInvocationContext, ProjectionSnapshotQuery],
})
  .annotate(Tool.Title, "Read referenced T3 Code task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReferenceToolkit = Toolkit.make(ThreadReadTool);
