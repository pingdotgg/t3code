import type { EnvironmentId } from "@t3tools/contracts";

export function toggleSettingsEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  available: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = available.map((entry) => entry.environmentId);
  const next = new Set(ids.filter((id) => selected === null || selected.has(id)));
  if (ids.includes(toggledId)) {
    if (next.has(toggledId)) next.delete(toggledId);
    else next.add(toggledId);
  }
  return ids.every((id) => next.has(id)) ? null : next;
}

/** Restrict the selected environments to the selected project group, if any. */
export function settingsTargetsForProject<T extends { readonly environmentId: EnvironmentId }>(
  targets: readonly T[],
  group:
    | {
        readonly members: readonly {
          readonly project: { readonly environmentId: EnvironmentId };
        }[];
      }
    | null
    | undefined,
): readonly T[] {
  if (group === null) return targets;
  return targets.filter((target) =>
    group?.members.some((member) => member.project.environmentId === target.environmentId),
  );
}
