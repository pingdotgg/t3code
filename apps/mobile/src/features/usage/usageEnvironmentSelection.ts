import type { EnvironmentId } from "@t3tools/contracts";

/** Null follows all environments, including ones connected after the menu opened. */
export function toggleUsageEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  environments: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = environments.map(({ environmentId }) => environmentId);
  const next = new Set(ids.filter((id) => selected === null || selected.has(id)));
  if (ids.includes(toggledId)) {
    if (next.has(toggledId)) next.delete(toggledId);
    else next.add(toggledId);
  }
  return ids.every((id) => next.has(id)) ? null : next;
}
