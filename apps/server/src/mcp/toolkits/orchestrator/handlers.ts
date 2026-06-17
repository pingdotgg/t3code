import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";

const handlers = {
  orchestrator_capabilities: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.capabilities(scope);
    }),
  delegate_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  task_status: ({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  task_cancel: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  create_threads: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
} satisfies Parameters<typeof OrchestratorToolkit.toLayer>[0];

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(handlers);
