import type { StatusTone } from "../../components/StatusPill";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error"
  | "plan-ready";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

function isLatestRunSettled(thread: EnvironmentThreadShell): boolean {
  if (!thread.latestRun?.startedAt) return false;
  if (!thread.latestRun.completedAt) return false;
  return !threadRuntimeIsActive(thread.runtime);
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  if (thread.hasPendingApprovals) {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-warning",
      textClassName: "text-warning-foreground",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-adaptive-indigo-500-a12-a16",
      textClassName: "text-adaptive-indigo-600-300",
      pulse: false,
    };
  }

  const runtimeStatus = thread.runtime?.status;

  if (runtimeStatus === "running" || runtimeStatus === "waiting") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-600-400",
      pulse: true,
    };
  }

  if (runtimeStatus === "preparing" || runtimeStatus === "queued" || runtimeStatus === "starting") {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-600-400",
      pulse: true,
    };
  }

  if (runtimeStatus === "failed" || thread.latestRun?.status === "failed") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-danger",
      textClassName: "text-danger-foreground",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-600-400",
      pulse: false,
    };
  }

  return null;
}
