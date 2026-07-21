import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export class ThreadToolError extends Schema.TaggedErrorClass<ThreadToolError>()("ThreadToolError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

const OptionalPrompt = Schema.optional(
  TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
);

const ThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  forkedFromThreadId: Schema.optional(ThreadId),
  forkedFromTurnId: Schema.optional(TurnId),
});

const ThreadMutationResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  turnStarted: Schema.Boolean,
});

const dependencies = [
  Crypto.Crypto,
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
];

const readonlyThreadTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const mutatingThreadTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, false) as T;

export const ThreadListTool = readonlyThreadTool(
  Tool.make("thread_list", {
    description:
      "List T3 Code threads in the current project, including fork lineage and runtime status. Archived threads are omitted unless requested.",
    parameters: Schema.Struct({
      includeArchived: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Array(ThreadSummary),
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "List project threads"),
);

export const ThreadCreateTool = mutatingThreadTool(
  Tool.make("thread_create", {
    description:
      "Create a sibling T3 Code thread in the current project. Supply prompt to immediately start its first turn.",
    parameters: Schema.Struct({
      title: Schema.optional(TrimmedNonEmptyString),
      prompt: OptionalPrompt,
    }),
    success: ThreadMutationResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Create project thread"),
);

export const ThreadForkTool = mutatingThreadTool(
  Tool.make("thread_fork", {
    description:
      "Fork a T3 Code conversation into a side thread with native provider history. Defaults to the current thread and its latest completed turn. Supply prompt to immediately start work in the fork.",
    parameters: Schema.Struct({
      sourceThreadId: Schema.optional(ThreadId),
      sourceTurnId: Schema.optional(TurnId),
      title: Schema.optional(TrimmedNonEmptyString),
      prompt: OptionalPrompt,
    }),
    success: ThreadMutationResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Fork conversation to side thread"),
);

export const ThreadSendTool = mutatingThreadTool(
  Tool.make("thread_send", {
    description:
      "Send a new prompt to another active T3 Code thread in the current project and start its turn.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    }),
    success: ThreadMutationResult,
    failure: ThreadToolError,
    dependencies,
  }).annotate(Tool.Title, "Send prompt to project thread"),
);

export const ThreadArchiveTool = mutatingThreadTool(
  Tool.make("thread_archive", {
    description:
      "Archive another inactive T3 Code thread in the current project. The current agent thread cannot archive itself.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Null,
    failure: ThreadToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Archive project thread")
    .annotate(Tool.Destructive, true),
);

export const ThreadToolkit = Toolkit.make(
  ThreadListTool,
  ThreadCreateTool,
  ThreadForkTool,
  ThreadSendTool,
  ThreadArchiveTool,
);
