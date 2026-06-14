/**
 * Planning space data adapter (spec §10): maps backlog `ProjectTicket`s into
 * the scene's domain model. Encodes the real-data findings (§10.3):
 *  - subtasks are the planning unit; stories aggregate them
 *  - subtask parents outside the sprint become context-parent placeholders
 *  - planning state counts the subtask aggregate, not just story estimates
 *  - per-person load is subtask-hour based
 * Pure module, unit-tested; no fetching.
 */

import type { ProjectTicket } from "~/t3work/t3work-types";

import { orderEpicsByAffinity } from "./t3work-planningSpaceScene";

export const NO_EPIC_ID = "__no_epic__";

export interface PlanningSubtask {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly parentId: string;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly hoursSeconds: number;
  /** Jira remaining estimate (`timeestimate`); falls back to the original. */
  readonly remainingSeconds: number;
  readonly inSprint: boolean;
  readonly resolved: boolean;
  readonly description: string | null;
}

export type PlanningState = "ready" | "needs-owner" | "needs-estimate" | "needs-owner-and-estimate";

export interface PlanningStory {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly epicId: string;
  readonly issueType: string;
  readonly issueTypeIconUrl: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly inSprint: boolean;
  /** Outside the sprint but shown because its subtasks are in it (§10.3 F1). */
  readonly isContextParent: boolean;
  /** Synthesized from a subtask's parentId — full ticket not loaded yet. */
  readonly isPlaceholder: boolean;
  readonly resolved: boolean;
  readonly ownHoursSeconds: number;
  /** Story's own Jira remaining estimate; falls back to the original. */
  readonly ownRemainingSeconds: number;
  readonly subtasks: ReadonlyArray<PlanningSubtask>;
  readonly aggregateHoursSeconds: number;
  readonly planningState: PlanningState;
  readonly description: string | null;
}

export interface PlanningEpic {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly storyIds: ReadonlyArray<string>;
  readonly totalHoursSeconds: number;
  readonly readyCount: number;
}

export interface PlanningOwner {
  readonly id: string;
  readonly name: string;
  /** Σ original estimates of in-sprint items (assigned time). */
  readonly loadSeconds: number;
  /** Σ remaining estimates of in-sprint items. */
  readonly remainingSeconds: number;
}

export interface PlanningSceneData {
  readonly stories: ReadonlyArray<PlanningStory>;
  readonly epics: ReadonlyArray<PlanningEpic>;
  readonly epicOrder: ReadonlyArray<string>;
  readonly owners: ReadonlyArray<PlanningOwner>;
  readonly unparentedSubtaskIds: ReadonlyArray<string>;
}

export const DEFAULT_RESOLVED_STATUSES = new Set([
  "done",
  "closed",
  "resolved",
  "abgeschlossen",
  "erledigt",
  "fertig",
]);

export interface PlanningCurrentUserIdentity {
  readonly accountId?: string;
  readonly displayName?: string;
}

export interface BuildPlanningSceneOptions {
  /** Sprint to plan; when omitted, tickets with an active sprint count as in-sprint. */
  readonly sprintId?: string;
  readonly resolvedStatuses?: ReadonlySet<string>;
  /** Epic↔epic affinity from issue links; optional until links land in the payload. */
  readonly epicAffinity?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Rail sort (§6.6): current user leftmost, then descending load. */
  readonly currentUser?: PlanningCurrentUserIdentity;
}


function normalizeIdentityValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function isCurrentPlanningOwner(
  owner: PlanningOwner,
  identity: PlanningCurrentUserIdentity | undefined,
): boolean {
  if (!identity) return false;
  const accountId = identity.accountId?.trim();
  if (accountId && owner.id === accountId) return true;
  const displayName = normalizeIdentityValue(identity.displayName);
  const ownerName = normalizeIdentityValue(owner.name);
  return displayName !== undefined && ownerName === displayName;
}

export function sortPlanningOwners(
  owners: ReadonlyArray<PlanningOwner>,
  identity: PlanningCurrentUserIdentity | undefined,
): PlanningOwner[] {
  return [...owners].sort((left, right) => {
    const leftIsCurrent = isCurrentPlanningOwner(left, identity);
    const rightIsCurrent = isCurrentPlanningOwner(right, identity);
    if (leftIsCurrent !== rightIsCurrent) {
      return leftIsCurrent ? -1 : 1;
    }
    return (
      right.loadSeconds - left.loadSeconds || left.name.localeCompare(right.name)
    );
  });
}


export { buildPlanningSceneData } from "./t3work-planningSpaceSceneBuild";
