import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import type { ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function latestProjectionRun(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, candidate) =>
      latest === null || candidate.ordinal > latest.ordinal ? candidate : latest,
    null,
  );
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = latestProjectionRun(projection);
  if (run === null) return null;
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

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const latestRunProjection = latestProjectionRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  if (latestRun === null && projection.thread.activeProviderThreadId === null) return null;
  const activeRunId =
    projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status))?.id ?? null;
  const hasPendingBackgroundTasks =
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
    }).length > 0;
  return {
    status: hasPendingBackgroundTasks ? "idle" : (latestRun?.status ?? "idle"),
    activeRunId,
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    lastError: providerSession?.lastError ?? null,
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}
