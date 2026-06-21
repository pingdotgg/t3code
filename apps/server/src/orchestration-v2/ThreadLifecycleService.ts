import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadLifecycleError extends Schema.TaggedErrorClass<ThreadLifecycleError>()(
  "ThreadLifecycleError",
  {
    operation: Schema.Literals([
      "archive",
      "unarchive",
      "delete",
      "update-metadata",
      "set-runtime-mode",
      "set-interaction-mode",
      "set-model-selection",
    ]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle operation '${this.operation}' failed for ${this.threadId}.`;
  }
}

export class ThreadLifecycleService extends Context.Service<
  ThreadLifecycleService,
  {
    readonly archive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
    readonly unarchive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
    readonly delete: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
    readonly updateMetadata: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
    readonly setRuntimeMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
    readonly setInteractionMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly interactionMode: ProviderInteractionMode;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
    readonly setModelSelection: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadLifecycleError>;
  }
>()("t3/orchestration-v2/ThreadLifecycleService") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const dispatch = <Operation extends ThreadLifecycleError["operation"]>(
    operation: Operation,
    threadId: ThreadId,
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.andThen(threads.getThreadProjection(threadId)),
      Effect.mapError((cause) => new ThreadLifecycleError({ operation, threadId, cause })),
    );

  return ThreadLifecycleService.of({
    archive: (input) =>
      dispatch("archive", input.threadId, {
        type: "thread.archive",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    unarchive: (input) =>
      dispatch("unarchive", input.threadId, {
        type: "thread.unarchive",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    delete: (input) =>
      dispatch("delete", input.threadId, {
        type: "thread.delete",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    updateMetadata: (input) =>
      dispatch("update-metadata", input.threadId, {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      }),
    setRuntimeMode: (input) =>
      dispatch("set-runtime-mode", input.threadId, {
        type: "thread.runtime-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
      }),
    setInteractionMode: (input) =>
      dispatch("set-interaction-mode", input.threadId, {
        type: "thread.interaction-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        interactionMode: input.interactionMode,
      }),
    setModelSelection: (input) =>
      dispatch("set-model-selection", input.threadId, {
        type: "thread.model-selection.set",
        commandId: input.commandId,
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      }),
  });
});

export const layer = Layer.effect(ThreadLifecycleService, make);
