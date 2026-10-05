import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { callerIsHome, routeHome } from "../../homeRouting.ts";
import { OrchestratorToolkit } from "./tools.ts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const handlers = {
  orchestrator_capabilities: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const local = yield* service.capabilities(scope);
      if (input.environmentId === undefined || input.environmentId === scope.environmentId) {
        return local;
      }
      const remote = yield* routeHome(input.environmentId, "capabilities", input);
      return Option.match(remote, {
        onNone: () => local,
        onSome: ({ providers }) => ({ ...local, providers }),
      });
    }),
  delegate_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  task_status: ({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  task_cancel: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  schedule_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.scheduleTask(scope, input);
    }),
  list_scheduled_tasks: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  update_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  delete_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  create_threads: (input) =>
    Effect.gen(function* () {
      // These threads share the caller's folder, and Home's folder makes them act as Home.
      if (yield* callerIsHome())
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Home launches threads with t3_thread_launch and a projectId or scratch:true.",
        });
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  t3_thread_list: (input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "threads.list", input);
      if (Option.isSome(routed)) return routed.value;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listThreads(scope, input);
    }),
  t3_thread_read: (input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "threads.read", input);
      if (Option.isSome(routed)) return routed.value;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.readThread(scope, input);
    }),
  t3_thread_update: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = input.threadId ?? scope.thread?.threadId;
      if (input.action === "rename" && input.title !== undefined && threadId !== undefined) {
        const routed = yield* routeHome(input.environmentId, "threads.rename", {
          threadId,
          title: input.title,
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        });
        if (Option.isSome(routed)) return routed.value;
      } else if (input.environmentId !== undefined && input.environmentId !== scope.environmentId) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Only renaming a named thread works in another environment.",
        });
      }
      const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
      return yield* service.update(scope, input);
    }),
  t3_thread_send: (input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "threads.send", input);
      if (Option.isSome(routed)) return routed.value;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.sendToThread(scope, input);
    }),
  t3_thread_wait: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  t3_thread_interrupt: (input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "threads.interrupt", input);
      if (Option.isSome(routed)) return routed.value;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.interruptThread(scope, input);
    }),
} satisfies Parameters<typeof OrchestratorToolkit.toLayer>[0];

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(handlers);
