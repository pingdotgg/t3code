import type { ServerSourceUpdateStatus } from "@t3tools/contracts";
import type { SourceUpdateRun } from "@t3tools/client-runtime/state/server";

export type SourceUpdatePhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "available";
      readonly behindOrigin: number;
      readonly upstreamAhead: number;
    }
  | { readonly kind: "running" }
  | { readonly kind: "succeeded"; readonly sha: string }
  | { readonly kind: "failed"; readonly message: string };

const IDLE: SourceUpdatePhase = { kind: "idle" };

/**
 * An update this client started stays on screen until its outcome is dismissed. The outcome
 * is the first result that differs from the one the server reported when the update began,
 * so it does not depend on either machine's clock.
 */
export function resolveSourceUpdatePhase(
  status: ServerSourceUpdateStatus | null,
  run: SourceUpdateRun | null,
): SourceUpdatePhase {
  if (run !== null) {
    const result = status?.lastResult ?? null;
    if (status === null || status.updateRunning) return { kind: "running" };
    // The unit truncates the log when it starts, so an empty log after it ends means it died.
    if (result === null) {
      return { kind: "failed", message: "The update stopped without reporting a result." };
    }
    if (result.finishedAt === run.previousResultFinishedAt) return { kind: "running" };
    return result.outcome === "succeeded"
      ? { kind: "succeeded", sha: status.head.sha }
      : { kind: "failed", message: result.message };
  }
  if (status === null) return IDLE;
  if (status.updateRunning) return { kind: "running" };
  const behindOrigin = status.behindOrigin ?? 0;
  const upstreamAhead = status.upstreamAhead ?? 0;
  return behindOrigin > 0 || upstreamAhead > 0
    ? { kind: "available", behindOrigin, upstreamAhead }
    : IDLE;
}

export function newCommitsLabel(count: number): string {
  return `${count} new commit${count === 1 ? "" : "s"}`;
}

export function sourceUpdatePillLabel(phase: SourceUpdatePhase): string | null {
  switch (phase.kind) {
    case "idle":
      return null;
    case "available":
      return phase.behindOrigin > 0
        ? `Update · ${newCommitsLabel(phase.behindOrigin)}`
        : `Upstream · ${newCommitsLabel(phase.upstreamAhead)}`;
    case "running":
      return "Updating…";
    case "succeeded":
      return `Updated · ${phase.sha}`;
    case "failed":
      return "Update failed";
  }
}

export function canRunSourceUpdate(phase: SourceUpdatePhase): boolean {
  return (phase.kind === "available" && phase.behindOrigin > 0) || phase.kind === "failed";
}

export function isSourceUpdateSettled(
  phase: SourceUpdatePhase,
): phase is Extract<SourceUpdatePhase, { kind: "succeeded" | "failed" }> {
  return phase.kind === "succeeded" || phase.kind === "failed";
}

export function canPullUpstream(
  status: ServerSourceUpdateStatus | null,
  phase: SourceUpdatePhase,
): boolean {
  return phase.kind !== "running" && (status?.upstreamAhead ?? 0) > 0;
}

export function pickSourceUpdateEnvironment<Id extends string>(input: {
  readonly primary: Id | null;
  readonly candidates: ReadonlyArray<Id>;
  readonly supportsSourceUpdate: (environmentId: Id) => boolean;
}): Id | null {
  if (input.primary !== null && input.supportsSourceUpdate(input.primary)) return input.primary;
  return input.candidates.find(input.supportsSourceUpdate) ?? null;
}
