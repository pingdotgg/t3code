import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as OpenShellFleetService from "../../../environment/OpenShellFleetService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import { assertFullAccess, loadCaller, readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const fleetFailure = (error: OpenShellFleetService.OpenShellFleetError): OrchestratorMcpFailure =>
  error._tag === "OpenShellFleetDisabled"
    ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })
    : error._tag === "OpenShellFleetSpawnRefused"
      ? new OrchestratorMcpFailure({
          code:
            error.reason === "runtime_mode_above_ceiling"
              ? "runtime_mode_escalation_denied"
              : "invalid_request",
          message: error.message,
        })
      : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const handlers = {
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
      if (input.isolation !== "openshell-auto") {
        return yield* service.delegateTask(scope, input);
      }
      // Provision the worker here, then hand the task to it like any other
      // linked environment. Its retirement is the fleet's own: the deadline
      // reaps it drain-first, so nothing is deleted under a running child.
      const caller = yield* loadCaller();
      // Provisioning infrastructure is an environment setting, not thread work:
      // the same full-access/linked checks as t3_environment_spawn apply here,
      // and they run before anything is created.
      yield* assertFullAccess(caller, "provision a fleet worker");
      yield* assertNotLinked(caller, "provision a fleet worker");
      const fleet = yield* OpenShellFleetService.OpenShellFleetService;
      const spawned = yield* fleet
        .spawnWorker({
          workerClass: "ephemeral",
          runtimeModeCeiling: caller.limits.runtimeMode,
          ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
          ...(input.title === undefined ? {} : { label: input.title }),
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        })
        .pipe(Effect.mapError(fleetFailure));
      return yield* service.delegateTask(scope, {
        ...input,
        // The child runs in that environment's checkout; the sandbox is the isolation.
        isolation: "shared",
        target: { ...input.target, environmentId: spawned.environmentId },
      });
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
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_background_wait");
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
                code: cause.reason === "unsupported" ? "invalid_request" : "orchestration_error",
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
      ({ scheduledTaskId, prompt, title, schedule, enabled, bindToCurrentThread }) =>
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
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.sendToThread(scope, input);
      }),
  ),
  t3_thread_wait: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
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
      const removed = yield* links
        .unlink(environmentId)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      return { environmentId, removed };
    }),
  ),
  // Spawning a worker mints infrastructure under this environment's gateway
  // credential, so it is an environment setting: full access, never linked work.
  t3_environment_spawn: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const fleet = yield* OpenShellFleetService.OpenShellFleetService;
      const caller = yield* check;
      return yield* fleet
        .spawnWorker({
          workerClass: input.workerClass,
          runtimeModeCeiling: caller.limits.runtimeMode,
          ...(input.template === undefined ? {} : { template: input.template }),
          ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.ttlMs === undefined ? {} : { ttlMs: Duration.toMillis(input.ttlMs) }),
          ...(input.seedFrom === undefined ? {} : { seedFrom: input.seedFrom }),
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        })
        .pipe(Effect.mapError(fleetFailure));
    }),
  ),
  // Removal drains worker data back here before any delete, so a refusal is
  // the safe outcome; it stays a full-access environment operation.
  t3_environment_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const fleet = yield* OpenShellFleetService.OpenShellFleetService;
      const removed = yield* fleet
        .removeWorker({
          targetEnvironmentId: input.targetEnvironmentId,
          ...(input.drainTimeoutMs === undefined
            ? {}
            : { drainTimeoutMs: Duration.toMillis(input.drainTimeoutMs) }),
          ...(input.force === undefined ? {} : { force: input.force }),
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        })
        .pipe(Effect.mapError(fleetFailure));
      return {
        targetEnvironmentId: removed.environmentId,
        outcome: removed.outcome,
        ...(removed.drain === undefined ? {} : { drain: removed.drain }),
        ...(removed.sandboxOutcome === undefined ? {} : { sandboxOutcome: removed.sandboxOutcome }),
        ...(removed.reason === undefined ? {} : { reason: removed.reason }),
      };
    }),
  ),
  t3_environment_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const fleet = yield* OpenShellFleetService.OpenShellFleetService;
      const workers = yield* fleet
        .listWorkers(input.workerClass === undefined ? {} : { workerClass: input.workerClass })
        .pipe(Effect.mapError(fleetFailure));
      return { workers };
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

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
