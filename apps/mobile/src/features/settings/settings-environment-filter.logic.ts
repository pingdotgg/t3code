import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Toggles one connected environment in the Settings scope. `null` means every environment.
 * Known offline environments keep their selection when they reconnect.
 */
export function toggleSettingsEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  available: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
  known: readonly { readonly environmentId: EnvironmentId }[] = available,
): ReadonlySet<EnvironmentId> | null {
  if (!available.some((entry) => entry.environmentId === toggledId)) return selected;
  const ids = known.map((entry) => entry.environmentId);
  const next = new Set(selected ?? ids);
  if (next.has(toggledId)) next.delete(toggledId);
  else next.add(toggledId);
  return ids.every((id) => next.has(id)) ? null : next;
}

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
