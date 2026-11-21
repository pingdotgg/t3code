import { useId, useState } from "react";

interface WorkspaceVisit {
  readonly threadKey: string | null;
  readonly visit: number;
  readonly placeholder: string;
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
  /** The history is not synchronized: the mutation id is unknown, not absent. */
  readonly pending: boolean;
  /**
   * The revision this visit's reads started under, set while the mutation id is unknown
   * or still the one the history loaded with. See `revisionedQuery`.
   */
  readonly placeholder: string | undefined;
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
      placeholder: `unloaded:${instanceId}:${next}:${input.threadKey ?? ""}`,
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
  if (!visit.awaitsBaseline) return { pending: false, placeholder: undefined };
  if (visit.baseline === undefined) return { pending: true, placeholder: visit.placeholder };
  return {
    pending: false,
    placeholder: mutationId === visit.baseline ? visit.placeholder : undefined,
  };
}

/**
 * Tells the mutation id a thread's history loads with from a workspace change. That id was
 * made before the visit began, so the workspace reads the visit already started cover it;
 * only an id that replaces it is a change those reads have not seen.
 */
export function useWorkspaceRevision(input: WorkspaceVisitInput): WorkspaceRevision {
  const instanceId = useId();
  const [visit, setVisit] = useState(() => advanceWorkspaceVisit(null, input, instanceId));
  const current = advanceWorkspaceVisit(visit, input, instanceId);
  if (current !== visit) setVisit(current);
  return workspaceRevisionOf(current, input.mutationId);
}
