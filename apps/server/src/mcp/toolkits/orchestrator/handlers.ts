import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const { tools } = OrchestratorToolkit;

/**
 * Runs `here` in this environment, or the same tool in the linked
 * environment `input.environmentId` names. The tool's declaration has already
 * checked the caller here either way.
 */
const routed = <T extends (typeof tools)[keyof typeof tools], A, E, R>(
  tool: T,
  input: Tool.Parameters<T> & { readonly environmentId?: EnvironmentId | undefined },
  here: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (PeerForwarding.remoteTarget(scope, input.environmentId) === undefined) return yield* here;
    const forwarding = yield* PeerForwarding.PeerForwarding;
    return yield* forwarding.route(scope, tool, input, here);
  });

const handlers = {
  orchestrator_capabilities: McpToolAccess.reads((input) =>
    routed(
      tools.orchestrator_capabilities,
      input,
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.capabilities(scope);
      }),
    ),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  schedule_task: McpToolAccess.startsThreads(
    // A scheduled task runs with the caller's own modes.
    () => ({}),
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.scheduleTask(scope, input);
      }),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  update_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  t3_thread_list: McpToolAccess.reads((input) =>
    routed(
      tools.t3_thread_list,
      input,
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.listThreads(scope, input);
      }),
    ),
  ),
  // Reading a child's finished result also acknowledges its delivery to the
  // reader's own thread. That is bookkeeping on the caller's own subagent, not
  // a change to anything it reads, so this stays a read.
  t3_thread_read: McpToolAccess.reads((input) =>
    routed(
      tools.t3_thread_read,
      input,
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.readThread(scope, input);
      }),
    ),
  ),
  t3_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  t3_thread_send: McpToolAccess.writesThreads(
    // A thread in a linked environment is checked there, where it lives.
    // This environment's own id names a thread here, which is checked here.
    (input, scope) =>
      PeerForwarding.remoteTarget(scope, input.environmentId) === undefined ? [input.threadId] : [],
    (input) =>
      routed(
        tools.t3_thread_send,
        input,
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.sendToThread(scope, input);
        }),
      ),
  ),
  t3_thread_wait: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const target = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (target !== undefined) {
        const forwarding = yield* PeerForwarding.PeerForwarding;
        return yield* forwarding.waitForThread(scope, target, input);
      }
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  ),
  t3_environment_links: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const forwarding = yield* PeerForwarding.PeerForwarding;
      return yield* forwarding.links(scope);
    }),
  ),
  t3_thread_interrupt: McpToolAccess.writesThreads(
    // A thread in a linked environment is checked there, where it lives.
    // This environment's own id names a thread here, which is checked here.
    (input, scope) =>
      PeerForwarding.remoteTarget(scope, input.environmentId) === undefined ? [input.threadId] : [],
    (input) =>
      routed(
        tools.t3_thread_interrupt,
        input,
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.interruptThread(scope, input);
        }),
      ),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
