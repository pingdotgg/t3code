/**
 * Subtle skill grouping for the team rail (PJ): when roles are known (fixtures
 * now, Tempo team roles later), docks cluster by role — largest group first,
 * unknown roles last. Without roles the rail is a single flat row. Extracted
 * from t3work-PlanningSpaceRail.tsx.
 */

import type { PlanningOwner } from "./t3work-planningSpaceData";

export function groupOwnersByRole(
  owners: ReadonlyArray<PlanningOwner>,
  ownerRoles: ReadonlyMap<string, string> | undefined,
): ReadonlyArray<{ role: string | null; owners: PlanningOwner[] }> {
  if (!ownerRoles || ownerRoles.size === 0) {
    return [{ role: null, owners: [...owners] }];
  }
  const byRole = new Map<string | null, PlanningOwner[]>();
  for (const owner of owners) {
    const role = ownerRoles.get(owner.id) ?? ownerRoles.get(owner.name) ?? null;
    const bucket = byRole.get(role) ?? [];
    bucket.push(owner);
    byRole.set(role, bucket);
  }
  return [...byRole.entries()]
    .sort((a, b) => {
      if (a[0] === null) return 1;
      if (b[0] === null) return -1;
      const sizeDelta = b[1].length - a[1].length;
      if (sizeDelta !== 0) return sizeDelta;
      return a[0].localeCompare(b[0]);
    })
    .map(([role, group]) => ({ role, owners: group }));
}
