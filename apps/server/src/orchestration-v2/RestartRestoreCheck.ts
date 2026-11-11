import {
  latestProviderTurnForAttempt,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isAwaitedWork,
  neverStarted,
} from "./RestartBackgroundNote.ts";

/** Actual native-session outcome after a restart continuation starts a turn. */
export type RestartRestoreOutcome = "resumed" | "fresh" | "failed";

export type RestartRestoreNotReadyReason =
  | "continuation_disabled"
  | "no_candidate_run"
  | "thread_blocked"
  | "provider_mismatch"
  | "missing_native_state"
  | "session_not_live"
  | "no_live_turn"
  | "no_open_awaited_work";

export type RestartRestoreCheckEntry = {
  readonly threadId: ThreadId;
  readonly status: "ready" | "not_ready";
  readonly reason?: RestartRestoreNotReadyReason;
  readonly sourceRunId?: RunId;
  readonly title?: string | null;
};

export type RestartRestoreCheckSummary = {
  readonly total: number;
  readonly ready: number;
  readonly notReady: number;
  readonly threads: ReadonlyArray<RestartRestoreCheckEntry>;
};

type RecoveryProjection = Pick<
  ProjectionRuntimeRecoveryState,
  | "thread"
  | "runs"
  | "providerThreads"
  | "providerSessions"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
>;

export function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  if (
    !settled &&
    turn !== undefined &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
  )
    return true;
  const waitingRequest = projection.runtimeRequests.some(
    (request) =>
      request.kind !== "dynamic_tool_call" &&
      request.kind !== "auth_refresh" &&
      request.responseCapability.type !== "message" &&
      (request.status === "pending" ||
        ((request.status === "expired" || request.status === "cancelled") &&
          request.responseCapability.type === "not_resumable" &&
          turn !== undefined &&
          turn.id === request.providerTurnId)),
  );
  if (waitingRequest) return true;
  return projection.turnItems.some(
    (item) =>
      item.type === "secret_request" &&
      item.runId === source.id &&
      (item.secretStatus === "pending" ||
        (item.secretStatus === "cancelled" &&
          item.completedAt !== null &&
          source.completedAt !== null &&
          DateTime.Equivalence(item.completedAt, source.completedAt))),
  );
}

/** App-owned delegations continue in their own threads and report back. */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    return (
      work !== undefined &&
      isAwaitedWork(work) &&
      awaitingProviderThreadId(item, projection.runs) === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

export type RestartContinuationInspection =
  | { readonly status: "ready"; readonly run: OrchestrationV2Run }
  | {
      readonly status: "not_ready";
      readonly reason: Exclude<RestartRestoreNotReadyReason, "continuation_disabled">;
      readonly run?: OrchestrationV2Run;
    };

/**
 * Explains whether a thread would attempt a native resume after restart.
 * A ready result is only a forecast; the later turn start reports resumed/fresh/failed.
 */
export function inspectRestartContinuation(
  projection: RecoveryProjection,
  now: DateTime.Utc,
): RestartContinuationInspection {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      !neverStarted(candidate) &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return { status: "not_ready", reason: "no_candidate_run" };
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && !preparedContinuation && !settled)
    return { status: "not_ready", reason: "no_candidate_run", run };
  if (restartContinuationBlocked(projection, run, now, settled))
    return { status: "not_ready", reason: "thread_blocked", run };
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId)
    return { status: "not_ready", reason: "provider_mismatch", run };
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return { status: "not_ready", reason: "missing_native_state", run };
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && (session.status === "stopped" || session.status === "error"))
  )
    return { status: "not_ready", reason: "session_not_live", run };
  if (settled) {
    return hasOpenAwaitedWork(projection, providerThread)
      ? { status: "ready", run }
      : { status: "not_ready", reason: "no_open_awaited_work", run };
  }
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return { status: "not_ready", reason: "no_live_turn", run };
  return { status: "ready", run };
}

/** Settled runs require a live session so stale crash records cannot wake them. */
export function restartContinuationRun(
  projection: RecoveryProjection,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const inspection = inspectRestartContinuation(projection, now);
  return inspection.status === "ready" ? inspection.run : undefined;
}

export function restartRestoreCheckEntry(input: {
  readonly projection: RecoveryProjection;
  readonly now: DateTime.Utc;
  readonly continueAfterRestart: boolean;
}): RestartRestoreCheckEntry | undefined {
  const inspection = inspectRestartContinuation(input.projection, input.now);
  // Idle threads with nothing to continue stay out of the restore-check roster.
  if (inspection.status === "not_ready" && inspection.reason === "no_candidate_run") return;
  if (!input.continueAfterRestart) {
    return {
      threadId: input.projection.thread.id,
      status: "not_ready",
      reason: "continuation_disabled",
      ...(inspection.run === undefined ? {} : { sourceRunId: inspection.run.id }),
      title: input.projection.thread.title,
    };
  }
  if (inspection.status === "ready") {
    return {
      threadId: input.projection.thread.id,
      status: "ready",
      sourceRunId: inspection.run.id,
      title: input.projection.thread.title,
    };
  }
  return {
    threadId: input.projection.thread.id,
    status: "not_ready",
    reason: inspection.reason,
    ...(inspection.run === undefined ? {} : { sourceRunId: inspection.run.id }),
    title: input.projection.thread.title,
  };
}

export function summarizeRestartRestoreCheck(
  threads: ReadonlyArray<RestartRestoreCheckEntry>,
): RestartRestoreCheckSummary {
  let ready = 0;
  let notReady = 0;
  for (const thread of threads) {
    if (thread.status === "ready") ready += 1;
    else notReady += 1;
  }
  return { total: threads.length, ready, notReady, threads };
}

export function formatRestartRestoreCheckSummary(summary: RestartRestoreCheckSummary): string {
  if (summary.total === 0) return "Restart restore-check: no interrupted threads to resume.";
  const lines = [
    `Restart restore-check: ${summary.ready} would come back, ${summary.notReady} would not (${summary.total} total).`,
  ];
  for (const thread of summary.threads) {
    const label = thread.title?.trim() || thread.threadId;
    if (thread.status === "ready") {
      lines.push(
        `  ready ${label}${thread.sourceRunId === undefined ? "" : ` (${thread.sourceRunId})`}`,
      );
      continue;
    }
    lines.push(
      `  not_ready ${label}${thread.sourceRunId === undefined ? "" : ` (${thread.sourceRunId})`}: ${thread.reason ?? "unknown"}`,
    );
  }
  return lines.join("\n");
}

/** Thread-visible copy for the cut-run recovery notice after a restart. */
export function restartRestoreForecastMessage(
  baseDetail: string,
  check: RestartRestoreCheckEntry | undefined,
): string {
  if (check === undefined) return baseDetail;
  if (check.status === "ready") {
    return `${baseDetail} T3 Code will attempt to resume this turn.`;
  }
  switch (check.reason) {
    case "continuation_disabled":
      return `${baseDetail} Continue after restart is off, so this turn will not resume.`;
    case "missing_native_state":
    case "session_not_live":
      return `${baseDetail} The provider session could not be resumed.`;
    default:
      return `${baseDetail} This turn will not automatically resume.`;
  }
}

export function restartRestoreOutcomeNotice(outcome: Exclude<RestartRestoreOutcome, "failed">): {
  readonly title: string;
  readonly message: string;
} {
  if (outcome === "resumed") {
    return {
      title: "Resumed after restart",
      message: "The provider session came back and this turn continued from where it left off.",
    };
  }
  return {
    title: "Started a fresh provider session",
    message:
      "The earlier provider session could not be resumed, so this turn continued in a new session with recovered context.",
  };
}

export const logRestartRestoreOutcome = Effect.fn("RestartRestoreCheck.logOutcome")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly sourceRunId: RunId;
    readonly outcome: RestartRestoreOutcome;
    readonly reason?: string;
  }) {
    yield* Effect.logInfo("orchestration-v2.restart-restore.outcome", input);
  },
);
