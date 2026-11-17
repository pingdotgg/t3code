import type { ServerConfig, ServerSourceUpdateStatus, ThreadId } from "@t3tools/contracts";
import type { SourceUpdateRun } from "@t3tools/client-runtime/state/server";

export type SourceUpdatePhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "available";
      readonly behindOrigin: number;
      readonly upstreamAhead: number;
      /** Checkout commits the running server was not built from. */
      readonly unbuilt: number;
    }
  /** Upstream conflicted, so Update started an agent thread to merge it instead. */
  | { readonly kind: "resolving"; readonly threadId: ThreadId }
  /** `cancellable` once the server confirms the update is running. */
  | { readonly kind: "running"; readonly cancellable: boolean }
  | {
      readonly kind: "succeeded";
      readonly runId: string;
      readonly sha: string;
      readonly message: string;
    }
  | { readonly kind: "failed"; readonly runId: string; readonly message: string };

type SettledPhase = Extract<SourceUpdatePhase, { kind: "succeeded" | "failed" }>;

const IDLE: SourceUpdatePhase = { kind: "idle" };

/**
 * The server stops a run after 30 minutes (RuntimeMaxSec), restart wait included. A run that has
 * not reported back by then will not: the server it would report to did not come back.
 */
export const SOURCE_UPDATE_GIVE_UP_MS = 32 * 60_000;

/** How the run the server last logged ended, or null while none has. */
function settledRun(status: ServerSourceUpdateStatus | null): SettledPhase | null {
  if (status === null || status.updateRunning || status.lastRunId === null) return null;
  const result = status.lastResult;
  // The script logs an outcome on every exit it survives; none means it was killed outright.
  if (result === null) {
    return {
      kind: "failed",
      runId: status.lastRunId,
      message: "The update stopped without reporting a result.",
    };
  }
  return result.outcome === "succeeded"
    ? { kind: "succeeded", runId: result.runId, sha: status.head.sha, message: result.message }
    : { kind: "failed", runId: result.runId, message: result.message };
}

/**
 * The server's last run shows until this client dismisses it. A run this client started reads
 * as running until the server reports that run id, so a status fetched before the start never
 * passes for its outcome.
 */
export function resolveSourceUpdatePhase(input: {
  readonly status: ServerSourceUpdateStatus | null;
  readonly run: SourceUpdateRun | null;
  /** The agent thread an Update from this client started for upstream conflicts. */
  readonly conflictThreadId?: ThreadId | null;
  readonly dismissedRunId: string | null;
  readonly nowMs: number;
}): SourceUpdatePhase {
  const { status, run } = input;
  const settled = settledRun(status);
  // Past the server's own limit even a status that still says running is stale.
  if (
    run !== null &&
    settled?.runId !== run.runId &&
    input.nowMs - run.startedAtMs >= SOURCE_UPDATE_GIVE_UP_MS
  ) {
    return {
      kind: "failed",
      runId: run.runId,
      message: "The update never reported back; the server may not have restarted. Check its log.",
    };
  }
  if (status?.updateRunning) return { kind: "running", cancellable: true };
  if (run !== null && settled?.runId !== run.runId) return { kind: "running", cancellable: false };
  // Once the agent merges upstream into the checkout, Update builds it like any other commit.
  const conflictThreadId = input.conflictThreadId ?? null;
  if (conflictThreadId !== null && (status?.upstreamAhead ?? 0) > 0) {
    return { kind: "resolving", threadId: conflictThreadId };
  }
  if (settled !== null && settled.runId !== input.dismissedRunId) return settled;
  if (status === null || status.updateUnavailableReason !== null) return IDLE;
  const behindOrigin = status.behindOrigin ?? 0;
  const unbuilt = status.unbuiltCommits ?? 0;
  const upstreamAhead = status.upstreamAhead ?? 0;
  return behindOrigin > 0 || unbuilt > 0 || upstreamAhead > 0
    ? { kind: "available", behindOrigin, upstreamAhead, unbuilt }
    : IDLE;
}

/** Whether T3's server Update action runs a source update on this environment. */
export function supportsSourceUpdate(config: Pick<ServerConfig, "environment"> | undefined) {
  return config?.environment.capabilities.sourceUpdate === true;
}

function commitsLabel(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

/** What the source checkout needs, or how the last update went; null while there is nothing. */
export function sourceUpdateSummary(phase: SourceUpdatePhase): string | null {
  switch (phase.kind) {
    case "idle":
    case "resolving":
      return null;
    case "available":
      return [
        phase.behindOrigin > 0 ? `origin/main is ${commitsLabel(phase.behindOrigin)} ahead` : null,
        phase.upstreamAhead > 0
          ? `upstream/main is ${commitsLabel(phase.upstreamAhead)} ahead`
          : null,
        phase.unbuilt > 0 ? `${commitsLabel(phase.unbuilt)} not built` : null,
      ]
        .filter((part) => part !== null)
        .join(" · ");
    case "running":
      return "Updating from source…";
    case "succeeded":
      return phase.message || `Updated to ${phase.sha}`;
    case "failed":
      return `Update failed: ${phase.message}`;
  }
}

export function canRunSourceUpdate(
  status: ServerSourceUpdateStatus | null,
  phase: SourceUpdatePhase,
): boolean {
  if (status === null || status.updateUnavailableReason !== null) return false;
  return phase.kind === "available" || phase.kind === "resolving" || phase.kind === "failed";
}

export function canCancelSourceUpdate(phase: SourceUpdatePhase): boolean {
  return phase.kind === "running" && phase.cancellable;
}

export function isSourceUpdateSettled(phase: SourceUpdatePhase): phase is SettledPhase {
  return phase.kind === "succeeded" || phase.kind === "failed";
}
