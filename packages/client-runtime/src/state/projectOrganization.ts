import type { OrchestrationProjectShell } from "@t3tools/contracts";

import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import type { EnvironmentProject } from "./models.ts";
import { buildProjectGroups, type ProjectGroupingSettings } from "./projectGrouping.ts";
import { pinOrderKeyBetween, planPinnedReorder } from "./threadSort.ts";

type ProjectOrganizationFields = Pick<
  OrchestrationProjectShell,
  "pinnedAt" | "pinOrderKey" | "archivedAt"
>;

export interface ProjectGroupOrganization {
  readonly pinnedAt: string | null;
  readonly pinOrderKey: string | null;
  readonly archivedAt: string | null;
}

/**
 * Pin and archive state of a logical project, from the records its machines
 * keep. Clients write every record together, but records can still disagree
 * (an agent changed one, or a machine added the project later). Then the
 * project stays visible: pinned when any record is pinned, and archived only
 * when every record is archived.
 */
export function resolveProjectGroupOrganization(
  members: ReadonlyArray<ProjectOrganizationFields>,
): ProjectGroupOrganization {
  let pinnedAt: string | null = null;
  let pinOrderKey: string | null = null;
  let archivedAt: string | null = null;
  let everyMemberArchived = members.length > 0;
  for (const member of members) {
    if (member.pinnedAt != null) {
      if (pinnedAt === null || member.pinnedAt < pinnedAt) pinnedAt = member.pinnedAt;
      if (member.pinOrderKey != null && (pinOrderKey === null || member.pinOrderKey < pinOrderKey))
        pinOrderKey = member.pinOrderKey;
    }
    if (member.archivedAt == null) everyMemberArchived = false;
    else if (archivedAt === null || member.archivedAt > archivedAt) archivedAt = member.archivedAt;
  }
  return { pinnedAt, pinOrderKey, archivedAt: everyMemberArchived ? archivedAt : null };
}

interface PinnableProject {
  readonly pinnedAt?: string | null | undefined;
  readonly pinOrderKey?: string | null | undefined;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Pinned projects first, in slot order and then keyless pins (set by an
 * agent) in the order they were pinned. The rest keep the order given.
 */
export function sortPinnedProjectsFirst<T extends PinnableProject>(projects: readonly T[]): T[] {
  const pinned = projects.filter((project) => project.pinnedAt != null);
  if (pinned.length === 0) return [...projects];
  pinned.sort((left, right) => {
    const leftKey = left.pinOrderKey ?? null;
    const rightKey = right.pinOrderKey ?? null;
    if (leftKey !== null && rightKey !== null) return compareText(leftKey, rightKey);
    if (leftKey !== null || rightKey !== null) return leftKey !== null ? -1 : 1;
    return compareText(left.pinnedAt!, right.pinnedAt!);
  });
  return [...pinned, ...projects.filter((project) => project.pinnedAt == null)];
}

/** Slot for a newly pinned project, after every pinned project that has one. */
export function nextProjectPinOrderKey(projects: ReadonlyArray<PinnableProject>): string | null {
  let lastKey: string | null = null;
  for (const project of projects) {
    if (project.pinnedAt == null || project.pinOrderKey == null) continue;
    if (lastKey === null || project.pinOrderKey > lastKey) lastKey = project.pinOrderKey;
  }
  return pinOrderKeyBetween(lastKey, null);
}

/**
 * Order-key writes that move one pinned project. Usually one write; a block
 * with keyless pins (pinned by an agent) is rewritten once.
 */
export function planProjectPinReorder(input: {
  /** Pinned project keys in the new order. */
  readonly orderedKeys: readonly string[];
  readonly pinOrderKeyByKey: ReadonlyMap<string, string | null>;
  readonly movedKey: string;
}): ReadonlyArray<{ readonly key: string; readonly pinOrderKey: string }> {
  return planPinnedReorder({
    orderedIds: input.orderedKeys,
    keysById: input.pinOrderKeyByKey,
    movedId: input.movedKey,
  }).map(({ id, orderKey }) => ({ key: id, pinOrderKey: orderKey }));
}

/**
 * Project records for a picker that lists each machine's record on its own:
 * archived projects left out and pinned ones first, judged by the whole
 * logical project across machines. Filter to one machine afterwards.
 */
export function organizeProjectRecords<TProject extends EnvironmentProject>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly settings: ProjectGroupingSettings;
  /** Keeps a record whose project is archived, such as a saved choice. */
  readonly keep?: (project: TProject) => boolean;
}): TProject[] {
  const organizationByRef = new Map<string, ProjectGroupOrganization>();
  for (const group of buildProjectGroups({ projects: input.projects, settings: input.settings })) {
    const organization = resolveProjectGroupOrganization(
      group.members.map((member) => member.project),
    );
    for (const projectRef of group.memberProjectRefs) {
      organizationByRef.set(scopedProjectKey(projectRef), organization);
    }
  }
  const entries = input.projects.flatMap((project) => {
    const organization = organizationByRef.get(
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    );
    if (organization?.archivedAt != null && input.keep?.(project) !== true) return [];
    return [
      {
        project,
        pinnedAt: organization?.pinnedAt ?? null,
        pinOrderKey: organization?.pinOrderKey ?? null,
      },
    ];
  });
  return sortPinnedProjectsFirst(entries).map((entry) => entry.project);
}
