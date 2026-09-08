import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export function projectBooleanOverrideTargets(
  members: readonly { environmentId: EnvironmentId; id: ProjectId }[],
  enabled: boolean | undefined,
) {
  const overridesByEnvironment = new Map<EnvironmentId, Record<string, boolean | null>>();
  for (const member of members) {
    const overrides = overridesByEnvironment.get(member.environmentId) ?? {};
    overrides[member.id] = enabled ?? null;
    overridesByEnvironment.set(member.environmentId, overrides);
  }
  return Array.from(overridesByEnvironment, ([environmentId, overrides]) => ({
    environmentId,
    overrides,
  }));
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}
