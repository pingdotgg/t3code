import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const APPROVAL_REQUEST_TIMEOUT_REASON = "Approval request timed out and was declined.";

export const isApprovalRequestKind = (kind: OrchestrationV2RuntimeRequest["kind"]): boolean =>
  kind !== "user_input" && kind !== "auth_refresh" && kind !== "dynamic_tool_call";

export function approvalRequestTimeoutCommand(input: {
  readonly threadId: ThreadId;
  readonly request: Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "status" | "createdAt">;
  readonly timeoutSeconds: number | null;
  readonly nowMs: number;
}): OrchestrationV2Command | null {
  if (
    input.timeoutSeconds === null ||
    input.request.status !== "pending" ||
    !isApprovalRequestKind(input.request.kind) ||
    input.nowMs - DateTime.toEpochMillis(input.request.createdAt) < input.timeoutSeconds * 1000
  )
    return null;
  return {
    type: "runtime-request.respond",
    commandId: CommandId.make(`approval-timeout:${input.threadId}:${input.request.id}`),
    threadId: input.threadId,
    requestId: input.request.id,
    decision: "decline",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("ApprovalRequestTimeoutWorker.sweep")(function* () {
    const timeoutSeconds = (yield* settings.getSettings).approvalRequestTimeout;
    if (timeoutSeconds === null) return;
    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const shells = yield* projections.listActiveShellIndex();
    for (const shell of shells) {
      const records = yield* projections.getThreadRecords(shell.id, ["runtimeRequests"], {
        runtimeRequestStatuses: ["pending"],
      });
      for (const request of records.runtimeRequests) {
        const command = approvalRequestTimeoutCommand({
          threadId: shell.id,
          request,
          timeoutSeconds,
          nowMs,
        });
        if (command === null) continue;
        yield* Effect.logInfo("orchestration-v2.approval-request-timeout.decline", {
          threadId: shell.id,
          requestId: request.id,
          reason: APPROVAL_REQUEST_TIMEOUT_REASON,
          timeoutSeconds,
        });
        yield* orchestrator.dispatch(command).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.approval-request-timeout.dispatch-failed", {
              threadId: shell.id,
              requestId: request.id,
              cause,
            }),
          ),
        );
      }
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("approval-request-timeout", sweep());
  }),
);
