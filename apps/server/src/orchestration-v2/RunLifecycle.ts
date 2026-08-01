/**
 * The single source of truth for which persisted status transitions are legal
 * for orchestration V2 lifecycle entities. EventSink consults this before
 * committing any status-bearing event, and the projection tables carry
 * matching triggers (045_OrchestrationV2RunLifecycleGuarantees) as a storage
 * backstop, so a terminal run can never be resurrected — not by a buggy
 * command handler, not by a stale effect settling late, not by direct SQL.
 *
 * The policy is deliberately the smallest one that makes stuck/corrupted
 * states unrepresentable rather than a full transition matrix:
 *
 * - Same-status rewrites are always legal (payload refreshes: queue position,
 *   checkpoint scope backfill, subagent wake policy on settled rows).
 * - A missing row accepts any initial status (imports create already-settled
 *   history; node.updated and subagent.updated are their own creation events).
 * - Any non-terminal status may move to any status. Which non-terminal step
 *   happens next is the deciders' business logic, not an integrity rule.
 * - Runs: terminal is absorbing, except checkpoint rollback retiring a
 *   completed run to rolled_back.
 * - Run attempts: terminal is absorbing, no exceptions.
 * - Nodes: terminal is absorbing except retirement to rolled_back — but
 *   subagent and root_turn nodes are provider-owned and deliberately
 *   reopenable (Claude resumes settled tasks with task_started, Codex
 *   restarts collab turns), so they are not constrained.
 * - Subagent rows are not gated at all for the same reason; their cleanup
 *   guarantee comes from the run cascade and the janitor, not from
 *   absorption.
 */

export type LifecycleEntityKind = "run" | "run-attempt" | "node";

export const TERMINAL_LIFECYCLE_STATUSES: Readonly<
  Record<LifecycleEntityKind, ReadonlySet<string>>
> = {
  run: new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]),
  "run-attempt": new Set(["completed", "interrupted", "failed", "cancelled", "superseded"]),
  node: new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]),
};

export const REOPENABLE_NODE_KINDS: ReadonlySet<string> = new Set(["subagent", "root_turn"]);

export function isTerminalLifecycleStatus(kind: LifecycleEntityKind, status: string): boolean {
  return TERMINAL_LIFECYCLE_STATUSES[kind].has(status);
}

export interface LifecycleTransitionInput {
  readonly kind: LifecycleEntityKind;
  readonly from: string | null;
  readonly to: string;
  /** The node's kind when kind === "node"; reopenable kinds are exempt. */
  readonly nodeKind?: string;
}

/**
 * Returns a human-readable reason when the transition is illegal, or null
 * when it is allowed.
 */
export function illegalLifecycleTransition(input: LifecycleTransitionInput): string | null {
  const { kind, from, to } = input;
  if (from === null || from === to) {
    return null;
  }
  if (!isTerminalLifecycleStatus(kind, from)) {
    return null;
  }
  if (kind === "run" && from === "completed" && to === "rolled_back") {
    return null;
  }
  if (kind === "node") {
    if (to === "rolled_back") {
      return null;
    }
    if (input.nodeKind !== undefined && REOPENABLE_NODE_KINDS.has(input.nodeKind)) {
      return null;
    }
  }
  return `a ${kind} in terminal status "${from}" cannot move to "${to}"`;
}
