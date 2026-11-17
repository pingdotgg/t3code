import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Toggles one connected environment in the Settings scope. `null` means every environment.
 * Selected environments that are offline right now stay selected, so they come back in scope
 * when they reconnect.
 */
export function toggleSettingsEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  available: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = available.map((entry) => entry.environmentId);
  if (!ids.includes(toggledId)) return selected;
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
