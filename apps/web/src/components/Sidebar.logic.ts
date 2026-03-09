import type { Thread } from "../types";
import { findLatestProposedPlan, isLatestTurnSettled } from "../session-logic";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Planning"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Submitted"
    | "Errored";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session"
>;

function hasUnreadAt(timestamp: string | undefined, lastVisitedAt: string | undefined): boolean {
  if (!timestamp) {
    return false;
  }

  const updatedAt = Date.parse(timestamp);
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  if (!lastVisitedAt) {
    return true;
  }

  const visitedAt = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedAt)) {
    return true;
  }

  return updatedAt > visitedAt;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running" && thread.interactionMode === "plan") {
    return {
      label: "Planning",
      colorClass: "text-cyan-600 dark:text-cyan-300/90",
      dotClass: "bg-cyan-500 dark:bg-cyan-300/90",
      pulse: true,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null) !== null;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Submitted",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      dotClass: "bg-teal-500 dark:bg-teal-300/90",
      pulse: false,
    };
  }

  if (
    thread.latestTurn?.state === "error" &&
    hasUnreadAt(thread.latestTurn.completedAt ?? undefined, thread.lastVisitedAt)
  ) {
    return {
      label: "Errored",
      colorClass: "text-rose-600 dark:text-rose-300/90",
      dotClass: "bg-rose-500 dark:bg-rose-300/90",
      pulse: false,
    };
  }

  if (
    thread.session?.status === "error" &&
    hasUnreadAt(thread.session.updatedAt, thread.lastVisitedAt)
  ) {
    return {
      label: "Errored",
      colorClass: "text-rose-600 dark:text-rose-300/90",
      dotClass: "bg-rose-500 dark:bg-rose-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}
