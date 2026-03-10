import type { ProjectId } from "@t3tools/contracts";

import { findLatestProposedPlan, isLatestTurnSettled } from "./session-logic";
import type { Thread } from "./types";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";

export const FOCUS_MODE_GRACE_MS = 2 * 60_000;

export type FocusVisibilityReason = "current-status" | "grace" | "hidden";

export interface FocusThreadVisibilityInput {
  thread: Thread;
  hasPendingApprovals: boolean;
  hasPendingUserInputs: boolean;
  now: number;
  graceMs: number;
}

export interface FocusThreadVisibility {
  hasCurrentStatus: boolean;
  isVisible: boolean;
  graceExpiresAt: number | null;
  lastFocusEligibleAt: number | null;
  reason: FocusVisibilityReason;
}

interface ResolveFocusContainerOpenInput {
  isFocusMode: boolean;
  containsVisibleThread: boolean;
  manuallyCollapsed: boolean;
  activeVisibleThreadInContainer: boolean;
}

function parseIso(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function maxTimestamp(current: number | null, next: string | null | undefined): number | null {
  const parsed = parseIso(next);
  if (parsed === null) {
    return current;
  }
  return current === null || parsed > current ? parsed : current;
}

function hasUnreadAt(timestamp: string | null | undefined, lastVisitedAt: string | undefined): boolean {
  const updatedAt = parseIso(timestamp);
  if (updatedAt === null) {
    return false;
  }

  const visitedAt = parseIso(lastVisitedAt);
  if (visitedAt === null) {
    return true;
  }

  return updatedAt > visitedAt;
}

function hasUnreadError(thread: Thread): boolean {
  if (
    thread.latestTurn?.state === "error" &&
    hasUnreadAt(thread.latestTurn.completedAt ?? undefined, thread.lastVisitedAt)
  ) {
    return true;
  }

  return thread.session?.status === "error" && hasUnreadAt(thread.session.updatedAt, thread.lastVisitedAt);
}

function deriveLastFocusEligibleAt(thread: Thread): number | null {
  let latestAt: number | null = null;

  for (const activity of thread.activities) {
    if (
      activity.kind === "approval.requested" ||
      activity.kind === "approval.resolved" ||
      activity.kind === "user-input.requested" ||
      activity.kind === "user-input.resolved"
    ) {
      latestAt = maxTimestamp(latestAt, activity.createdAt);
    }
  }

  if (thread.session?.status === "running" || thread.session?.status === "connecting") {
    latestAt = maxTimestamp(latestAt, thread.session.updatedAt);
  }

  const latestTurnSettled = isLatestTurnSettled(thread.latestTurn, thread.session);
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  const latestPlan = latestTurnSettled
    ? findLatestProposedPlan(thread.proposedPlans, latestTurnId)
    : null;

  if (latestTurnId && latestPlan?.turnId === latestTurnId) {
    latestAt = maxTimestamp(latestAt, latestPlan.updatedAt);
  }

  if (thread.latestTurn?.state === "completed" && latestTurnSettled) {
    latestAt = maxTimestamp(latestAt, thread.latestTurn.completedAt);
  }

  if (thread.latestTurn?.state === "error") {
    latestAt = maxTimestamp(latestAt, thread.latestTurn.completedAt);
  }

  if (thread.session?.status === "error") {
    latestAt = maxTimestamp(latestAt, thread.session.updatedAt);
  }

  if (
    latestAt !== null &&
    thread.session &&
    thread.session.status !== "running" &&
    thread.session.status !== "connecting" &&
    thread.session.status !== "error"
  ) {
    latestAt = maxTimestamp(latestAt, thread.session.updatedAt);
  }

  return latestAt;
}

export function deriveFocusThreadVisibility(
  input: FocusThreadVisibilityInput,
): FocusThreadVisibility {
  const hasCurrentStatus =
    resolveThreadStatusPill({
      thread: input.thread,
      hasPendingApprovals: input.hasPendingApprovals,
      hasPendingUserInput: input.hasPendingUserInputs,
    }) !== null || hasUnreadError(input.thread);

  if (hasCurrentStatus) {
    return {
      hasCurrentStatus: true,
      isVisible: true,
      graceExpiresAt: null,
      lastFocusEligibleAt: null,
      reason: "current-status",
    };
  }

  const lastFocusEligibleAt = deriveLastFocusEligibleAt(input.thread);
  if (lastFocusEligibleAt === null) {
    return {
      hasCurrentStatus: false,
      isVisible: false,
      graceExpiresAt: null,
      lastFocusEligibleAt: null,
      reason: "hidden",
    };
  }

  const graceExpiresAt = lastFocusEligibleAt + input.graceMs;
  if (input.now < graceExpiresAt) {
    return {
      hasCurrentStatus: false,
      isVisible: true,
      graceExpiresAt,
      lastFocusEligibleAt,
      reason: "grace",
    };
  }

  return {
    hasCurrentStatus: false,
    isVisible: false,
    graceExpiresAt,
    lastFocusEligibleAt,
    reason: "hidden",
  };
}

export function resolveFocusProjectExpanded(
  input: ResolveFocusContainerOpenInput & { baseExpanded: boolean },
): boolean {
  if (!input.isFocusMode) {
    return input.baseExpanded;
  }
  if (!input.containsVisibleThread) {
    return false;
  }
  if (input.manuallyCollapsed && !input.activeVisibleThreadInContainer) {
    return false;
  }
  return true;
}

export function toggleFocusProjectOverride(
  previous: ReadonlySet<ProjectId>,
  projectId: ProjectId,
  open: boolean,
): ReadonlySet<ProjectId> {
  const next = new Set(previous);
  if (open) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  return next;
}
