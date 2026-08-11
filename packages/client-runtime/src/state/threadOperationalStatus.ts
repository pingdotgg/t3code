import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type ThreadOperationalStatus =
  | "needs-approval"
  | "needs-input"
  | "connecting"
  | "working"
  | "failed"
  | "plan-ready"
  | "monitoring"
  | "ready";

export type ThreadOperationalStatusInput = Pick<
  OrchestrationThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
  | "interactionMode"
  | "hasActionableProposedPlan"
  | "backgroundLiveness"
>;

function hasReadyPlan(thread: ThreadOperationalStatusInput): boolean {
  const latestTurn = thread.latestTurn;
  return (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    latestTurn !== null &&
    latestTurn.startedAt !== null &&
    latestTurn.completedAt !== null
  );
}

/**
 * Provider-neutral operational state shared by clients and headless controls.
 * Presentation details such as labels, colors, and icons remain client-owned.
 */
export function resolveThreadOperationalStatus(
  thread: ThreadOperationalStatusInput,
): ThreadOperationalStatus {
  if (thread.hasPendingApprovals) {
    return "needs-approval";
  }
  if (thread.hasPendingUserInput) {
    return "needs-input";
  }
  if (thread.session?.status === "starting") {
    return "connecting";
  }
  if (thread.session?.status === "running") {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (hasReadyPlan(thread)) {
    return "plan-ready";
  }
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}
