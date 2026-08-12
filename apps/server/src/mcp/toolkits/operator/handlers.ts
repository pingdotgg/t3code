import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OperatorService } from "../../../operator/OperatorService.ts";
import { OperatorToolkit } from "./tools.ts";

const handlers = {
  operator_models: () =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const operator = yield* OperatorService;
      return { providers: yield* operator.listModels(invocation.threadId) };
    }),
  operator_spawn: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const operator = yield* OperatorService;
      return yield* operator.spawn({
        coordinatorThreadId: invocation.threadId,
        tasks: input.tasks,
        workspaceMode: input.workspaceMode ?? "current",
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
      });
    }),
  operator_status: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const operator = yield* OperatorService;
      const tasks = yield* operator.status(
        invocation.threadId,
        input.taskIds?.map((taskId) => ThreadId.make(taskId)),
      );
      return { tasks };
    }),
  operator_wait: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const operator = yield* OperatorService;
      const tasks = yield* operator.wait(
        invocation.threadId,
        input.taskIds?.map((taskId) => ThreadId.make(taskId)),
      );
      return { tasks };
    }),
} satisfies Parameters<typeof OperatorToolkit.toLayer>[0];

export const OperatorToolkitHandlersLive = OperatorToolkit.toLayer(handlers);
