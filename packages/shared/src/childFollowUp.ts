import type {
  ChildNudgeUpdate,
  ChildWaitCondition,
  OrchestrationQueuedTurn,
  ThreadId,
  ThreadNudging,
} from "@t3tools/contracts";

export const CHILD_RESULT_COLLECTION_MS = 2_000;

export interface ChildFollowUpThread {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly nudging?: ThreadNudging | undefined;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null | undefined;
}

export function childReportNeedsAttention(report: ChildNudgeUpdate): boolean {
  return report.kind === "decision-needed" || report.kind === "failed" || report.kind === "blocked";
}

function childWaitAssignmentIsSettled(
  assignment: ChildWaitCondition["assignments"][number],
): boolean {
  return (
    assignment.outcome === "result-available" ||
    assignment.outcome === "failed" ||
    assignment.outcome === "blocked"
  );
}

function childWaitAssignmentMatchesUpdate(
  assignment: ChildWaitCondition["assignments"][number],
  update: ChildNudgeUpdate,
): boolean {
  return (
    assignment.childThreadId === update.childThreadId &&
    assignment.assignmentId === update.assignmentId
  );
}

export function childWaitIsSatisfied(wait: ChildWaitCondition): boolean {
  if (wait.mode === "decisions-only" || wait.assignments.length === 0) return false;
  return wait.mode === "all"
    ? wait.assignments.every(childWaitAssignmentIsSettled)
    : wait.assignments.some(childWaitAssignmentIsSettled);
}

export function childWaitHasUnsettledUpdate(
  wait: ChildWaitCondition,
  updates: ReadonlyArray<ChildNudgeUpdate>,
): boolean {
  return (
    !childWaitIsSatisfied(wait) &&
    updates.some((update) =>
      wait.assignments.some((assignment) => childWaitAssignmentMatchesUpdate(assignment, update)),
    )
  );
}

export function childWaitIsSatisfiedByUpdates(
  wait: ChildWaitCondition,
  updates: ReadonlyArray<ChildNudgeUpdate>,
): boolean {
  return (
    childWaitIsSatisfied(wait) &&
    updates.some((update) =>
      wait.assignments.some(
        (assignment) =>
          childWaitAssignmentIsSettled(assignment) &&
          childWaitAssignmentMatchesUpdate(assignment, update),
      ),
    )
  );
}

export function childWaitBlockReason(
  wait: ChildWaitCondition | null | undefined,
  children: ReadonlyMap<ThreadId, ChildFollowUpThread>,
  parentId?: ThreadId,
): string | null {
  if (!wait || wait.satisfiedAt || childWaitIsSatisfied(wait)) return null;
  if (wait.mode === "decisions-only") return "Only decisions and blockers wake this thread.";
  for (const assignment of wait.assignments) {
    if (childWaitAssignmentIsSettled(assignment)) continue;
    const child = children.get(assignment.childThreadId);
    if (
      !child ||
      child.archivedAt !== null ||
      child.deletedAt != null ||
      (parentId !== undefined && child.parentThreadId !== parentId) ||
      child.nudging?.delegation?.assignmentId !== assignment.assignmentId
    ) {
      return "A required assignment is unavailable. Change the wait condition.";
    }
  }
  const remaining = wait.assignments.filter((entry) => !childWaitAssignmentIsSettled(entry)).length;
  return `Waiting for ${wait.mode === "any" ? "any of " : ""}${remaining} ${remaining === 1 ? "child" : "children"}.`;
}

export function evaluateChildFollowUp(
  parent: ChildFollowUpThread,
  turn: OrchestrationQueuedTurn,
  children: ReadonlyMap<ThreadId, ChildFollowUpThread>,
  now: string,
): { updates: ReadonlyArray<ChildNudgeUpdate>; reason: string | null; dueAt: string | null } {
  if (turn.origin?.kind !== "child-nudge") return { updates: [], reason: null, dueAt: null };
  const updates = turn.origin.updates.filter((report) => {
    const child = children.get(report.childThreadId);
    if (child && child.parentThreadId !== undefined && child.parentThreadId !== parent.id)
      return false;
    // Terminal results were already accepted when queued. Reassignment must
    // not erase a result that is waiting for this parent to dispatch.
    const isTerminalReport =
      report.kind === "result-available" || report.kind === "failed" || report.kind === "blocked";
    const delegation = child?.nudging?.delegation;
    if (
      !isTerminalReport &&
      delegation &&
      (delegation.assignmentId !== report.assignmentId ||
        (report.dispatchId !== undefined &&
          delegation.dispatchId !== undefined &&
          report.dispatchId !== delegation.dispatchId))
    ) {
      return false;
    }
    if (report.kind !== "decision-needed") return true;
    // Legacy reports did not persist decision state; do not silently discard them.
    const decision = delegation?.decision;
    return decision === undefined || decision?.id === report.id;
  });
  if (updates.length === 0) return { updates, reason: null, dueAt: null };
  if (parent.nudging?.paused)
    return { updates, reason: "Automatic follow-up is paused.", dueAt: null };
  if (parent.archivedAt !== null || parent.deletedAt != null) {
    return { updates, reason: "The parent is archived or deleted.", dueAt: null };
  }
  if (updates.some(childReportNeedsAttention)) return { updates, reason: null, dueAt: null };
  const wait = parent.nudging?.wait;
  const reason =
    wait && (wait.mode === "decisions-only" || childWaitHasUnsettledUpdate(wait, updates))
      ? childWaitBlockReason(wait, children, parent.id)
      : null;
  if (reason) return { updates, reason, dueAt: null };
  const dueAt = turn.origin.collectUntil ?? null;
  return {
    updates,
    reason: dueAt && dueAt > now ? "Collecting child results." : null,
    dueAt: dueAt && dueAt > now ? dueAt : null,
  };
}
