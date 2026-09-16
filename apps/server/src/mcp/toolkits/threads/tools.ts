import {
  McpCapabilityUnavailableError,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
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

export const StartThreadInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(200_000)).annotate({
    description:
      "The first user message of the new thread. It must stand on its own: the new agent cannot see this conversation.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Thread title. Omit to let T3 Code generate one from the prompt.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model id on this thread's provider. Defaults to this thread's model. The provider is never changed.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({ description: "Permission mode. Defaults to this thread's mode." }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description: "default or plan. Defaults to this thread's mode.",
    }),
  ),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description:
        "Stable id you choose for this call. A retry with the same id lands on the same thread with the same first turn instead of starting a second one.",
    }),
  ),
});
export type StartThreadInput = typeof StartThreadInput.Type;

export const StartThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
});
export type StartThreadResult = typeof StartThreadResult.Type;

export class StartThreadCallerNotFoundError extends Schema.TaggedError<StartThreadCallerNotFoundError>()(
  "StartThreadCallerNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class StartThreadFailedError extends Schema.TaggedError<StartThreadFailedError>()(
  "StartThreadFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not start the thread.";
  }
}

export const StartThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  StartThreadCallerNotFoundError,
  StartThreadFailedError,
]);
export type StartThreadToolError = typeof StartThreadToolError.Type;

const StartThreadTool = Tool.make("start_thread", {
  description:
    "Start a new top-level T3 Code thread in this thread's project and send it a first message. The new thread runs on its own, in parallel, with the same provider, checkout, and worktree as this thread. It is not a subagent: it does not report back, and you cannot read it. Use it when the user asks for separate threads or wants work to continue after this turn ends. Two threads editing one checkout can collide, so split the work by files.",
  parameters: StartThreadInput,
  success: StartThreadResult,
  failure: StartThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a T3 Code thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(StartThreadTool);
