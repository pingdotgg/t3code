/**
 * Pure helpers for the planning scene builder: ticket→owner/state mapping and
 * per-person sprint load aggregation. Split out of t3work-planningSpaceData.ts.
 */

import type { ProjectTicket } from "~/t3work/t3work-types";

import {
  type PlanningCurrentUserIdentity,
  type PlanningOwner,
  type PlanningState,
  type PlanningStory,
  sortPlanningOwners,
} from "./t3work-planningSpaceData";

export function isResolved(
  ticket: Pick<ProjectTicket, "status">,
  resolvedStatuses: ReadonlySet<string>,
): boolean {
  return resolvedStatuses.has(ticket.status.trim().toLowerCase());
}

export function ownerOf(ticket: ProjectTicket): { ownerId: string | null; ownerName: string | null } {
  const name = ticket.assignee?.trim() || null;
  return { ownerId: ticket.assigneeAccountId ?? name, ownerName: name };
}

export function planningStateOf(ownerId: string | null, estimated: boolean): PlanningState {
  if (ownerId && estimated) return "ready";
  if (ownerId) return "needs-estimate";
  if (estimated) return "needs-owner";
  return "needs-owner-and-estimate";
}

export function placeholderTitle(id: string, kind: "epic" | "story"): string {
  return kind === "epic" ? `Epic ${id}` : id;
}

/**
 * Rail membership mirrors the backlog assignee filter: everyone assigned on any
 * loaded ticket gets a dock, with sprint subtask/story hours summed as load
 * (Tempo team roster lands in §10.2).
 */
export function computePlanningOwners(
  tickets: ReadonlyArray<ProjectTicket>,
  stories: ReadonlyArray<PlanningStory>,
  currentUser: PlanningCurrentUserIdentity | undefined,
): PlanningOwner[] {
  const loadByOwner = new Map<string, PlanningOwner>();
  const registerOwner = (ownerId: string | null, ownerName: string | null) => {
    if (!ownerId) return;
    const existing = loadByOwner.get(ownerId);
    if (!existing) {
      loadByOwner.set(ownerId, {
        id: ownerId,
        name: ownerName ?? ownerId,
        loadSeconds: 0,
        remainingSeconds: 0,
      });
      return;
    }
    if (ownerName && existing.name === ownerId) {
      loadByOwner.set(ownerId, { ...existing, name: ownerName });
    }
  };
  const addLoad = (
    ownerId: string | null,
    ownerName: string | null,
    seconds: number,
    remainingSeconds: number,
  ) => {
    if (!ownerId) return;
    registerOwner(ownerId, ownerName);
    const existing = loadByOwner.get(ownerId);
    if (!existing) return;
    loadByOwner.set(ownerId, {
      ...existing,
      loadSeconds: existing.loadSeconds + seconds,
      remainingSeconds: existing.remainingSeconds + remainingSeconds,
    });
  };
  for (const ticket of tickets) {
    const owner = ownerOf(ticket);
    registerOwner(owner.ownerId, owner.ownerName);
  }
  for (const story of stories) {
    for (const subtask of story.subtasks) {
      if (subtask.inSprint) {
        addLoad(subtask.ownerId, subtask.ownerName, subtask.hoursSeconds, subtask.remainingSeconds);
      }
    }
    if (story.subtasks.length === 0 && story.inSprint) {
      addLoad(
        story.ownerId,
        story.ownerName,
        story.ownHoursSeconds,
        story.resolved ? 0 : story.ownRemainingSeconds,
      );
    }
  }
  return sortPlanningOwners([...loadByOwner.values()], currentUser);
}
