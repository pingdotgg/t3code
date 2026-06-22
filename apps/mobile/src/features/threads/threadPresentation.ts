import type { StatusTone } from "../../components/StatusPill";
import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function threadSortValue(thread: EnvironmentThreadShell): number {
  const candidate = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(candidate) ? 0 : candidate;
}

export function threadStatusTone(thread: EnvironmentThreadShell): StatusTone {
  const status = thread.runtime?.status;
  if (status === "running" || status === "waiting") {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-warning",
      textClassName: "text-warning-foreground",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }
  if (status === "completed") {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-primary/10",
      textClassName: "text-foreground-secondary",
      iconColor: "#5e5ce6",
      iconBackground: "rgba(94,92,230,0.22)",
      pulse: false,
    };
  }
  if (status === "queued" || status === "starting") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-primary/10",
      textClassName: "text-adaptive-sky-600-400",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }
  if (status === "failed") {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-primary/10",
      textClassName: "text-foreground-secondary",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-danger",
      textClassName: "text-danger-foreground",
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-primary/10",
      textClassName: "text-foreground-secondary",
      iconColor: "#bf5af2",
      iconBackground: "rgba(191,90,242,0.22)",
      pulse: false,
    };
  }

  return null;
}
