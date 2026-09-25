import { RuntimeMode, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export class ThreadsToolError extends Schema.TaggedError<ThreadsToolError>()("ThreadsToolError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const SubagentStatus = Schema.Literals(["starting", "running", "idle", "failed", "stopped"]);
export type SubagentStatus = typeof SubagentStatus.Type;

export const ThreadScope = Schema.Literals(["children", "project"]);
export type ThreadScope = typeof ThreadScope.Type;

const threadScope = ThreadScope.pipe(
  Schema.withDecodingDefault(Effect.succeed("children" as const)),
);
const includeSettled = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));

export const SpawnThreadInput = Schema.Struct({
  task: TrimmedNonEmptyString.annotate({
    description: "The first message the child thread receives: its whole task.",
  }),
  instanceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Provider instance to run the child on, for example claudeAgent, codex, opencode or grok. Defaults to this thread's provider instance.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id on that instance. Defaults to this thread's model.",
    }),
  ),
  effort: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Reasoning effort (Claude effort, Codex/Grok reasoningEffort, OpenCode variant).",
    }),
  ),
  title: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
  reportBack: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "When true (default), each time the child finishes a turn its final reply is sent to this thread as a message.",
    }),
  ),
});

export const SpawnThreadResult = Schema.Struct({
  threadId: Schema.String,
  parentThreadId: Schema.String,
  instanceId: Schema.String,
  model: Schema.String,
});

export const MessageThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyString.annotate({ description: "A thread in the selected scope." }),
  text: TrimmedNonEmptyString,
  scope: threadScope,
});

export const MessageThreadResult = Schema.Struct({
  threadId: Schema.String,
  statusBefore: SubagentStatus,
  delivery: Schema.Literals(["new-turn", "steer"]).annotate({
    description:
      "new-turn: the child was idle and starts a turn. steer: the message joins the child's running turn.",
  }),
});

export const ThreadSummary = Schema.Struct({
  threadId: Schema.String,
  id: Schema.String,
  title: Schema.String,
  status: SubagentStatus,
  instanceId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  lastAssistantMessage: Schema.NullOr(Schema.String),
  userMessageCount: Schema.Int,
});

const SpawnThreadTool = Tool.make("spawn_thread", {
  description:
    "Start a child thread in this project on a chosen provider instance, model and effort, and send it a task. Returns immediately with the child's thread id; the child shows in this thread's Agents panel. Use read_thread to see its reply, message_thread to talk to it.",
  parameters: SpawnThreadInput,
  success: SpawnThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn child thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const MessageThreadTool = Tool.make("message_thread", {
  description:
    "Send a message to a child thread by default, or any thread in this project with scope: project, once it has started working or gone idle. A thread that is still starting refuses with a retryable error; retry in a few seconds.",
  parameters: MessageThreadInput,
  success: MessageThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message child thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read a thread's status and its latest assistant reply. The default scope is this thread's children; use scope: project for any thread in this project, including settled threads.",
  parameters: Schema.Struct({ threadId: TrimmedNonEmptyString, scope: threadScope }),
  success: ThreadSummary,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read child thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListChildThreadsTool = Tool.make("list_child_threads", {
  description: "List this thread's child threads and their status.",
  success: Schema.Struct({ threads: Schema.Array(ThreadSummary) }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List child threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadsTool = Tool.make("list_threads", {
  description:
    "List active threads in this thread's children by default, or all non-archived threads in this project with scope: project. Set includeSettled: true to include settled threads.",
  parameters: Schema.Struct({ scope: threadScope, includeSettled }),
  success: Schema.Struct({ threads: Schema.Array(ThreadSummary) }),
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(
  SpawnThreadTool,
  MessageThreadTool,
  ReadThreadTool,
  ListChildThreadsTool,
  ListThreadsTool,
);
