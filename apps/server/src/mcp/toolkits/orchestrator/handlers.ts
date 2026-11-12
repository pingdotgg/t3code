import * as RemoteThreads from "../../agents/remoteThreads.ts";
import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";

import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as TailnetDevices from "../../../peer/TailnetDevices.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import { readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

/**
 * Revoking cuts a machine off everywhere, so it comes from the user or a chat on this machine:
 * never through a link or an outside client, which may be acting from the machine it would cut.
 */
const assertMayRevoke = Effect.fn("mcp.assertMayRevoke")(function* (environmentId: EnvironmentId) {
  const caller = yield* readCaller();
  if (environmentId === caller.scope.environmentId) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "This machine cannot revoke itself.",
    });
  }
  if (caller.scope.client !== undefined || callerLinkOrigin(caller) !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Only the user, or a chat on this machine, can revoke a machine. Ask them to revoke it in Settings, Connections.",
    });
  }
});

export const layer = McpToolAccess.toLayer(
  OrchestratorToolkit,
  Effect.gen(function* () {
    const gateway = yield* RemoteThreads.gatewayToolContext;
    const remoteTarget = (environmentId: Parameters<typeof RemoteThreads.resolveEnvironment>[2]) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => RemoteThreads.resolveEnvironment(gateway, scope, environmentId)),
      );
    return {
      orchestrator_capabilities: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.capabilities(scope, input);
        }),
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
      t3_workflow_stop: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const { threads } = yield* readCaller();
            return yield* threads.stopWorkflow(input).pipe(
              Effect.as({}),
              Effect.mapError(
                (cause) =>
                  new OrchestratorMcpFailure({
                    code:
                      cause.reason === "unavailable" || cause.reason === "stop-failed"
                        ? "orchestration_error"
                        : "invalid_request",
                    message: cause.message,
                  }),
              ),
            );
          }),
      ),
      t3_background_wait: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { scope, threads } = yield* readCaller();
          const caller = yield* McpInvocationContext.requireThreadScope(
            scope,
            "t3_background_wait",
          );
          return yield* threads
            .awaitBackgroundTasks({
              threadId: caller.thread.threadId,
              taskIds: input.taskIds,
              awaited: input.waiting ?? true,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorMcpFailure({
                    code:
                      cause.reason === "unsupported" ? "invalid_request" : "orchestration_error",
                    message: cause.message,
                  }),
              ),
            );
        }),
      ),
      schedule_task: McpToolAccess.either(
        (input) => input.scheduledTaskId === undefined,
        McpToolAccess.startsThreads(
          () => ({}),
          ({ prompt, schedule, ...input }) =>
            Effect.gen(function* () {
              if (prompt === undefined || schedule === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "A new scheduled task needs `prompt` and `schedule`.",
                });
              }
              const scope = yield* McpInvocationContext.McpInvocationContext;
              const service = yield* OrchestratorMcpService.OrchestratorMcpService;
              return yield* service.scheduleTask(scope, { ...input, prompt, schedule });
            }),
          // A scheduled run starts long after its caller, with nothing to carry the link.
          { refused: "schedule tasks in this environment" },
        ),
        McpToolAccess.writes(
          ({ scheduledTaskId, prompt, title, schedule, enabled, bindToCurrentThread, profileId }) =>
            Effect.gen(function* () {
              if (scheduledTaskId === undefined) return yield* Effect.die("unreachable");
              const scope = yield* McpInvocationContext.McpInvocationContext;
              const service = yield* OrchestratorMcpService.OrchestratorMcpService;
              return yield* service.updateScheduledTask(scope, {
                scheduledTaskId,
                prompt,
                title,
                schedule,
                enabled,
                bindToCurrentThread,
                profileId,
              });
            }),
        ),
      ),
      list_scheduled_tasks: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.listScheduledTasks(scope, input);
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
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.listThreads(scope, input);
        }),
      ),
      t3_thread_read: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const remote = yield* remoteTarget(input.environmentId);
          if (remote !== undefined) return yield* RemoteThreads.readThread(remote, input);
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.readThread(scope, input);
        }),
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
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const remote = yield* remoteTarget(input.environmentId);
            if (remote !== undefined)
              return yield* RemoteThreads.sendToThread(remote, scope, input);
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            return yield* service.sendToThread(scope, input);
          }),
      ),
      t3_thread_wait: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const remote = yield* remoteTarget(input.environmentId);
          if (remote !== undefined) return yield* RemoteThreads.waitForThread(remote, input);
          const scope = yield* McpInvocationContext.McpInvocationContext;
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
      // A link lets every agent here reach the other environment, so it is an
      // environment setting: full access, and never for linked work.
      t3_environment_link: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const requests = yield* PeerLinkRequests.PeerLinkRequests;
          return yield* requests.request(scope, input);
        }),
      ),
      t3_environment_unlink: McpToolAccess.writesEnvironment(({ environmentId }) =>
        Effect.gen(function* () {
          const links = yield* PeerLinks.PeerLinks;
          const removed = yield* links.unlink(environmentId).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
          return { environmentId, removed };
        }),
      ),
      // A device's access holds on every one of the user's machines, so it is
      // an environment setting too.
      t3_environment_device_access: McpToolAccess.writesEnvironment(({ environmentId, access }) =>
        Effect.gen(function* () {
          if (access === "revoked") yield* assertMayRevoke(environmentId);
          const caller = yield* McpInvocationContext.McpInvocationContext;
          const devices = yield* TailnetDevices.TailnetDevices;
          const entry = yield* devices
            .setAccess(environmentId, access, "agent", caller.client?.peerEnvironmentId)
            .pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code:
                      error.reason === "unknown_device" || error.reason === "self"
                        ? "invalid_request"
                        : error.reason === "forbidden"
                          ? "capability_denied"
                          : "orchestration_error",
                    message: error.message,
                  }),
              ),
            );
          return { environmentId: entry.environmentId, access: entry.access };
        }),
      ),
      t3_thread_interrupt: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            return yield* service.interruptThread(scope, input);
          }),
      ),
    } satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;
  }),
);
