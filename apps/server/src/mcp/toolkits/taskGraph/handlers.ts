import { OrchestratorMcpFailure, type TaskGraphId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TaskGraphService from "../../../taskGraph/TaskGraphService.ts";
import { TaskGraphToolkit } from "./tools.ts";

const failure = (code: "invalid_request" | "orchestration_error", message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** The calling thread; the access gate already refused callers without one. */
const callerThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* failure(
      "invalid_request",
      "Task graphs need an agent running inside a T3 thread.",
    );
  }
  return scope.thread.threadId;
});

const orchestrationError = (error: { readonly message: string }) =>
  failure("orchestration_error", error.message);

/** A graph the calling thread created; agents only steer their own graphs. */
const ownGraph = (graphId: TaskGraphId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const service = yield* TaskGraphService.TaskGraphService;
    const graph = yield* service.get(graphId).pipe(Effect.mapError(orchestrationError));
    if (graph.threadId !== threadId) {
      return yield* failure("invalid_request", "That task graph belongs to another thread.");
    }
    return service;
  });

const handlers = {
  task_graph_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      const service = yield* TaskGraphService.TaskGraphService;
      const graph = yield* service
        .create({ ...input, threadId })
        .pipe(Effect.mapError(orchestrationError));
      return { graph };
    }),
  ),
  task_graph_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      const service = yield* TaskGraphService.TaskGraphService;
      const graphs = yield* service
        .listForThread(threadId)
        .pipe(Effect.mapError(orchestrationError));
      return { graphs };
    }),
  ),
  task_graph_edit: McpToolAccess.actsAsCaller(({ graphId, edits }) =>
    Effect.gen(function* () {
      const service = yield* ownGraph(graphId, yield* callerThread);
      return {
        graph: yield* service.edit(graphId, edits).pipe(Effect.mapError(orchestrationError)),
      };
    }),
  ),
  task_graph_run: McpToolAccess.actsAsCaller(({ graphId }) =>
    Effect.gen(function* () {
      const service = yield* ownGraph(graphId, yield* callerThread);
      return { graph: yield* service.run(graphId).pipe(Effect.mapError(orchestrationError)) };
    }),
  ),
  task_graph_cancel: McpToolAccess.actsAsCaller(({ graphId }) =>
    Effect.gen(function* () {
      const service = yield* ownGraph(graphId, yield* callerThread);
      return { graph: yield* service.cancel(graphId).pipe(Effect.mapError(orchestrationError)) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof TaskGraphToolkit.tools>;

export const layer = McpToolAccess.toLayer(TaskGraphToolkit, handlers);
