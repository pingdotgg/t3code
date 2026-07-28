import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";

const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

function latestMatchingRun(
  projection: OrchestrationV2ThreadProjection,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function summarizeThreadRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = latestMatchingRun(projection, () => true);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Returns the run that owns live provider work, falling back to the newest run
 * once the thread is idle. A newer queued run must not make an older executing
 * run look settled in clients that render per-run activity.
 */
export function deriveThreadActivityRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) =>
      INTERRUPTIBLE_RUN_STATUSES.has(candidate.status),
    ) ?? latestMatchingRun(projection, () => true);
  return run === null ? null : summarizeThreadRun(projection, run);
}

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  if (latestRun === null && projection.thread.activeProviderThreadId === null) return null;
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  return {
    status: latestRun?.status ?? "idle",
    activeRunId,
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    lastError: providerSession?.lastError ?? null,
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadRuntimeSummary | null | undefined,
): boolean {
  return runtime?.activeRunId !== null && runtime?.activeRunId !== undefined;
}
