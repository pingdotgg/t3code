import {
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread in the calling project. Omit threadId for this thread. snooze requires snoozedUntil. Existing thread lifecycle rules apply; this does not schedule a future action.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext, ThreadManagementService, Crypto.Crypto],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

export const ThreadToolkit = Toolkit.make(ThreadOrganizeTool);
