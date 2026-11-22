import { useId, useState } from "react";

interface WorkspaceVisit {
  readonly threadKey: string | null;
  readonly visit: number;
  /** The revision this visit's reads start under. */
  readonly revision: string;
  /** Whether this visit's reads cover the mutation id the history will load with. */
  readonly awaitsBaseline: boolean;
  /** The mutation id the history loaded with; `undefined` until it loads. */
  readonly baseline: string | null | undefined;
}

interface WorkspaceVisitInput {
  readonly threadKey: string | null;
  /** A settled server thread whose history is not synchronized yet. */
  readonly unloaded: boolean;
  readonly mutationId: string | null;
}

export interface WorkspaceRevision {
  /** What workspace queries are read under; changes only when the workspace may have. */
  readonly revision: string | null;
  /** The history is not synchronized: the mutation id is unknown, not absent. */
  readonly pending: boolean;
}

export function advanceWorkspaceVisit(
  visit: WorkspaceVisit | null,
  input: WorkspaceVisitInput,
  instanceId: string,
): WorkspaceVisit {
  if (visit === null || visit.threadKey !== input.threadKey) {
    const next = (visit?.visit ?? 0) + 1;
    return {
      threadKey: input.threadKey,
      visit: next,
      revision: `visit:${instanceId}:${next}:${input.threadKey ?? ""}`,
      awaitsBaseline: input.unloaded,
      baseline: undefined,
    };
  }
  return visit.awaitsBaseline && visit.baseline === undefined && !input.unloaded
    ? { ...visit, baseline: input.mutationId }
    : visit;
}

export function workspaceRevisionOf(
  visit: WorkspaceVisit,
  mutationId: string | null,
): WorkspaceRevision {
  if (!visit.awaitsBaseline) return { revision: mutationId, pending: false };
  if (visit.baseline === undefined) return { revision: visit.revision, pending: true };
  return { revision: mutationId === visit.baseline ? visit.revision : mutationId, pending: false };
}

/**
 * The revision a thread's workspace queries are read under. The mutation id a thread's history
 * loads with was made before the visit began, so the reads the visit already started cover it:
 * the visit keeps one revision of its own until an id replaces that one.
 */
export function useWorkspaceRevision(input: WorkspaceVisitInput): WorkspaceRevision {
  const instanceId = useId();
  const [visit, setVisit] = useState(() => advanceWorkspaceVisit(null, input, instanceId));
  const current = advanceWorkspaceVisit(visit, input, instanceId);
  if (current !== visit) setVisit(current);
  return workspaceRevisionOf(current, input.mutationId);
}
