import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const APPROVAL_REQUEST_TIMEOUT_REASON = "Approval request timed out and was declined.";
export const APPROVAL_REQUEST_TIMEOUT_BATCH_SIZE = 100;

const isApprovalRequestKind = (kind: OrchestrationV2RuntimeRequest["kind"]): boolean =>
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

export function isAlreadyResolvedRuntimeRequestFailure(cause: Cause.Cause<unknown>): boolean {
  const failure = Cause.findErrorOption(cause);
  if (Option.isNone(failure)) return false;
  const error = failure.value as {
    readonly _tag?: unknown;
    readonly cause?: unknown;
  };
  return (
    error._tag === "OrchestratorDispatchError" &&
    typeof error.cause === "string" &&
    /^Runtime request .+ is (?:resolved|expired|cancelled)\.$/.test(error.cause)
  );
}

export const logApprovalRequestTimeoutDispatchFailure = (input: {
  readonly cause: Cause.Cause<unknown>;
  readonly threadId: ThreadId;
  readonly requestId: OrchestrationV2RuntimeRequest["id"];
}) =>
  isAlreadyResolvedRuntimeRequestFailure(input.cause)
    ? Effect.logInfo("orchestration-v2.approval-request-timeout.already-resolved", {
        threadId: input.threadId,
        requestId: input.requestId,
      })
    : Effect.logWarning("orchestration-v2.approval-request-timeout.dispatch-failed", {
        threadId: input.threadId,
        requestId: input.requestId,
        cause: input.cause,
      });

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  yield* Effect.forkChild(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("ApprovalRequestTimeoutWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const timeoutSeconds = (yield* settings.getSettings).approvalRequestTimeout;
    if (timeoutSeconds === null) {
      yield* due.record(readVersion, Infinity, nowMs);
      return;
    }
    const candidates = yield* projections.getApprovalRequestTimeoutCandidates({
      before: DateTime.subtract(now, { seconds: timeoutSeconds }),
      limit: APPROVAL_REQUEST_TIMEOUT_BATCH_SIZE,
    });
    for (const candidate of candidates) {
      const command = approvalRequestTimeoutCommand({
        threadId: candidate.threadId,
        request: candidate.request,
        timeoutSeconds,
        nowMs,
      });
      if (command === null) continue;
      yield* Effect.logInfo("orchestration-v2.approval-request-timeout.decline", {
        threadId: candidate.threadId,
        requestId: candidate.request.id,
        reason: APPROVAL_REQUEST_TIMEOUT_REASON,
        timeoutSeconds,
      });
      yield* orchestrator.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          logApprovalRequestTimeoutDispatchFailure({
            cause,
            threadId: candidate.threadId,
            requestId: candidate.request.id,
          }),
        ),
      );
    }
    yield* due.record(readVersion, nowMs + 5_000, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("approval-request-timeout", sweep());
  }),
);
