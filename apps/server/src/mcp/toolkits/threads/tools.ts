import {
  McpCapabilityUnavailableError,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../../../orchestration/Services/ThreadBootstrap.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ThreadBootstrap.ThreadBootstrap,
];

export const ThreadStartWorktreeInput = Schema.Struct({
  baseBranch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Branch to start the worktree from. Defaults to this thread's branch.",
    }),
  ),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Name for the new worktree branch. Defaults to a generated t3code/<hex> name.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description: "Fetch origin and start from the remote baseBranch when it exists.",
    }),
  ),
});
export type ThreadStartWorktreeInput = typeof ThreadStartWorktreeInput.Type;

export const ThreadStartInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)).annotate({
    description:
      "First user message of the new thread. Write it for a person and an agent who have none of this thread's context: goal, decisions already made, file paths, and what is left.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Sidebar title for the new thread. Defaults to the first line of the prompt.",
    }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description: "default or plan. Defaults to this thread's interaction mode.",
    }),
  ),
  modelSelection: Schema.optional(
    ModelSelection.annotate({
      description:
        "Provider instance and model for the new thread, as { instanceId, model, options? }. Defaults to this thread's selection; the result echoes the resolved selection so you can copy its shape.",
    }),
  ),
  worktree: Schema.optional(
    ThreadStartWorktreeInput.annotate({
      description:
        "Give the new thread its own git worktree instead of sharing this checkout. Pass {} for the defaults. The project's setup script runs in the new worktree.",
    }),
  ),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description:
        "Your own id for this request. Repeating a call with the same id returns the thread created the first time instead of creating a second one.",
    }),
  ),
});
export type ThreadStartInput = typeof ThreadStartInput.Type;

export const ThreadStartResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  alreadyStarted: Schema.Boolean.annotate({
    description: "True when clientRequestId matched a thread this tool created before.",
  }),
});
export type ThreadStartResult = typeof ThreadStartResult.Type;

export class ThreadStartCallerNotFoundError extends Schema.TaggedError<ThreadStartCallerNotFoundError>()(
  "ThreadStartCallerNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadStartCallerArchivedError extends Schema.TaggedError<ThreadStartCallerArchivedError>()(
  "ThreadStartCallerArchivedError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot start new threads.`;
  }
}

export class ThreadStartProjectNotFoundError extends Schema.TaggedError<ThreadStartProjectNotFoundError>()(
  "ThreadStartProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ThreadStartWorktreeBaseRequiredError extends Schema.TaggedError<ThreadStartWorktreeBaseRequiredError>()(
  "ThreadStartWorktreeBaseRequiredError",
  {},
) {
  override get message(): string {
    return "This thread has no branch. Pass worktree.baseBranch.";
  }
}

export class ThreadStartFailedError extends Schema.TaggedError<ThreadStartFailedError>()(
  "ThreadStartFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not start the new thread.";
  }
}

export const ThreadStartToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadStartCallerNotFoundError,
  ThreadStartCallerArchivedError,
  ThreadStartProjectNotFoundError,
  ThreadStartWorktreeBaseRequiredError,
  ThreadStartFailedError,
]);
export type ThreadStartToolError = typeof ThreadStartToolError.Type;

const ThreadStartTool = Tool.make("t3_thread_start", {
  description:
    "Hand work off to a NEW top-level T3 Code thread that the user drives from the sidebar. Creates the thread in this thread's project and immediately starts its first turn with your prompt. The new thread inherits this thread's checkout, provider, model, permission mode, and interaction mode unless overridden; pass worktree to give it a fresh git worktree instead of sharing this checkout. This is not a subagent: it does not report back, and you do not wait for it. Use it when the user asks to continue, split off, or delegate work into a separate session.",
  parameters: ThreadStartInput,
  success: ThreadStartResult,
  failure: ThreadStartToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(ThreadStartTool);
