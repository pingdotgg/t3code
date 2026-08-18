import type { SidebarProjectGroupingMode } from "@t3tools/contracts";

import { deriveProjectGroupingOverrideKey } from "./logicalProject";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

export function hasMultipleProjectEnvironments(
  group: Pick<SidebarProjectSnapshot, "memberProjects">,
): boolean {
  return new Set(group.memberProjects.map((member) => member.environmentId)).size > 1;
}

export function resolveProjectGroupingEnvironmentLabels(
  group: Pick<SidebarProjectSnapshot, "memberProjects">,
): string[] {
  return Array.from(
    new Set(
      group.memberProjects.map((member) => member.environmentLabel ?? String(member.environmentId)),
    ),
  );
}

export function findProjectGroupingPromptCandidate(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  acknowledgedKeys: ReadonlySet<string>,
): SidebarProjectSnapshot | null {
  return (
    groups.find(
      (group) => hasMultipleProjectEnvironments(group) && !acknowledgedKeys.has(group.projectKey),
    ) ?? null
  );
}

export function separateProjectGroup(
  group: Pick<SidebarProjectSnapshot, "memberProjects">,
  existingOverrides: Readonly<Record<string, SidebarProjectGroupingMode>>,
): Record<string, SidebarProjectGroupingMode> {
  const nextOverrides = { ...existingOverrides };
  for (const member of group.memberProjects) {
    nextOverrides[deriveProjectGroupingOverrideKey(member)] = "separate";
  }
  return nextOverrides;
}

export function acknowledgeProjectGroupingPrompt(
  acknowledgedKeys: ReadonlyArray<string>,
  projectKey: string,
): string[] {
  return acknowledgedKeys.includes(projectKey)
    ? [...acknowledgedKeys]
    : [...acknowledgedKeys, projectKey];
}
