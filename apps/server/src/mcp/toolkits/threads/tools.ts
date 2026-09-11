import {
  CommandId,
  McpCapabilityUnavailableError,
  ModelSelection,
  OrchestrationMessage,
  OrchestrationThreadDetailPage,
  OrchestrationThreadShell,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class ThreadToolError extends Schema.TaggedError<ThreadToolError>()("ThreadToolError", {
  message: Schema.String,
}) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];
const failure = Schema.Union([McpCapabilityUnavailableError, ThreadToolError]);
const target = { threadId: ThreadId };
const mutation = {
  commandId: Schema.optionalKey(
    CommandId.annotate({
      description:
        "Stable retry ID. Reuse only for the identical operation and arguments; scoped to your source thread.",
    }),
  ),
};
const receipt = Schema.Struct({ ...target, sequence: Schema.Finite });
const limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const ThreadSummary = Schema.Struct({
  ...Struct.pick(OrchestrationThreadShell.fields, [
    "id",
    "projectId",
    "title",
    "modelSelection",
    "runtimeMode",
    "interactionMode",
    "createdAt",
    "updatedAt",
    "settledAt",
    "settledOverride",
    "session",
    "latestTurn",
    "latestUserMessageAt",
    "hasPendingApprovals",
    "hasPendingUserInput",
    "backgroundLiveness",
  ]),
  cursor: Schema.String,
});

const makeTool = <const N extends string, P extends Schema.Top, S extends Schema.Top>(
  name: N,
  description: string,
  parameters: P,
  success: S,
  readonly: boolean,
) =>
  Tool.make(name, { description, parameters, success, failure, dependencies })
    .annotate(Tool.Readonly, readonly)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, readonly)
    .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(
  makeTool(
    "create_thread",
    "Create an empty persistent peer thread in this project, at its workspace root. Inherits this thread's model and permission mode unless modelSelection is supplied. Returns its ID; use send_message_to_thread to start work. Does not copy history or create a worktree.",
    Schema.Struct({
      ...mutation,
      title: TrimmedNonEmptyString,
      modelSelection: Schema.optionalKey(ModelSelection),
    }),
    receipt,
    false,
  ),
  makeTool(
    "list_threads",
    "List persistent peer threads in this project, including settled threads. Archived threads are excluded. Results sort by ID; pass nextBeforeThreadId to fetch the next page.",
    Schema.Struct({
      limit: Schema.optionalKey(limit),
      beforeThreadId: Schema.optionalKey(ThreadId),
    }),
    Schema.Struct({
      threads: Schema.Array(ThreadSummary),
      nextBeforeThreadId: Schema.NullOr(ThreadId),
    }),
    true,
  ),
  makeTool(
    "read_thread",
    "Read a peer thread's state and a page of conversation messages in this project. Tool output and attachments are omitted; message text is capped at 8000 characters. Use the returned page.beforeCursor for older turns.",
    Schema.Struct({
      ...target,
      turnLimit: Schema.optionalKey(limit),
      beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      thread: ThreadSummary,
      messages: Schema.Array(
        Schema.Struct({
          ...Struct.pick(OrchestrationMessage.fields, ["id", "role", "text", "createdAt"]),
          truncated: Schema.Boolean,
        }),
      ),
      page: Schema.optionalKey(OrchestrationThreadDetailPage),
      snapshotSequence: Schema.Finite,
    }),
    true,
  ),
  makeTool(
    "send_message_to_thread",
    "Send a visible follow-up to a peer thread in this project, starting or queuing work and reviving settled threads. Includes your thread ID so the recipient can reply. Optional modelSelection changes the model. T3 can reject changing the provider of an already-bound thread.",
    Schema.Struct({
      ...mutation,
      ...target,
      message: TrimmedNonEmptyString,
      replyToSource: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Include instructions to reply to your source thread. Defaults true. Set false when an external controller watches completion instead.",
        }),
      ),
      modelSelection: Schema.optionalKey(ModelSelection),
    }),
    receipt,
    false,
  ),
  makeTool(
    "wait_threads",
    "Wait for any peer thread to finish or need attention. Pass each last returned cursor to avoid repeated notifications. Returns current state on timeout; commentary does not wake this tool. Maximum wait is 60 seconds.",
    Schema.Struct({
      targets: Schema.Array(
        Schema.Struct({ ...target, cursor: Schema.optionalKey(Schema.String) }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
      timeoutSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 })),
      ),
    }),
    Schema.Struct({ threads: Schema.Array(ThreadSummary), timedOut: Schema.Boolean }),
    true,
  ),
  makeTool(
    "set_thread_settled",
    "Settle or reactivate a peer thread in this project. Settling is rejected while work is running or queued, or blocking approvals are pending. Use interrupt_thread to stop a turn first.",
    Schema.Struct({ ...mutation, ...target, settled: Schema.Boolean }),
    receipt,
    false,
  ),
  makeTool(
    "interrupt_thread",
    "Request interruption of a peer thread's current turn in this project. History remains available for a follow-up.",
    Schema.Struct({ ...mutation, ...target }),
    receipt,
    false,
  ),
);
