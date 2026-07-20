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
  schedule_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.scheduleTask(scope, input);
    }),
  list_scheduled_tasks: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope);
    }),
  update_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  delete_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  create_threads: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  t3_thread_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      const result = yield* service.createThreads(scope, {
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        threads: [
          {
            prompt: input.prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
          },
        ],
      });
      return result.threads[0]!;
    }),
  t3_thread_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.listThreads(scope, input);
    }),
  t3_thread_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.readThread(scope, input);
    }),
  t3_thread_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.sendToThread(scope, input);
    }),
  t3_thread_wait: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  t3_thread_interrupt: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.interruptThread(scope, input);
    }),
} satisfies Parameters<typeof OrchestratorToolkit.toLayer>[0];

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(handlers);
