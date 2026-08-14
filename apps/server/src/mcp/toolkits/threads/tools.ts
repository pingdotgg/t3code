import { MessageId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const THREAD_RELAY_MESSAGE_MAX_CHARS = 8_000;
export const THREAD_RELAY_LIST_LIMIT = 50;

export class ThreadRelayError extends Schema.TaggedErrorClass<ThreadRelayError>()(
  "ThreadRelayError",
  {
    code: Schema.Literals([
      "source_unavailable",
      "target_not_found",
      "self_send",
      "cross_project",
      "query_failed",
      "dispatch_failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const ThreadRelayStatus = Schema.Literals(["idle", "working", "monitoring", "waiting", "error"]);

const ThreadRelayPeer = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: ThreadRelayStatus,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  workspace: Schema.Literals(["shared", "worktree"]),
  updatedAt: Schema.String,
});

const ThreadListResult = Schema.Struct({
  threads: Schema.Array(ThreadRelayPeer),
  truncated: Schema.Boolean,
});

const ThreadSendInput = Schema.Struct({
  threadId: ThreadId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_RELAY_MESSAGE_MAX_CHARS)),
});

const ThreadSendResult = Schema.Struct({
  messageId: MessageId,
  targetThreadId: ThreadId,
  status: Schema.Literal("accepted"),
  sequence: Schema.Number,
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  Crypto.Crypto,
];

export const ThreadListTool = Tool.make("thread_list", {
  description:
    "List active sibling T3 threads in this thread's project. Returns stable T3 thread IDs plus runtime and workspace context. These are durable T3 threads, not provider process or conversation IDs.",
  parameters: Schema.Struct({}),
  success: ThreadListResult,
  failure: ThreadRelayError,
  dependencies,
})
  .annotate(Tool.Title, "List sibling threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSendTool = Tool.make("thread_send", {
  description:
    "Send a bounded, attributed message to an existing sibling T3 thread in the same project. T3 durably records the target turn before starting, resuming, or steering its provider session. This does not share provider context, read the target transcript, wait for a result, or merge worktrees; include all context the recipient needs.",
  parameters: ThreadSendInput,
  success: ThreadSendResult,
  failure: ThreadRelayError,
  dependencies,
})
  .annotate(Tool.Title, "Message sibling thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const ThreadRelayToolkit = Toolkit.make(ThreadListTool, ThreadSendTool);
