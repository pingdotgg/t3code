import type { EnvironmentId } from "@t3tools/contracts";
import type { UsageSummaryInput } from "@t3tools/contracts";

interface UsageRefreshStatus {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly summary: unknown | null;
}

/** Selects environments for which pull-to-refresh should show its indicator. */
export function usagePullRefreshTargets(
  environments: readonly UsageRefreshStatus[],
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments.flatMap((environment) =>
      environment.summary === null && environment.isPending ? [] : [environment.environmentId],
    ),
  );
}

/** Starts the explicit rescan before committing a rebased window to the screen. */
export async function refreshRebasedUsageWindow(
  input: UsageSummaryInput,
  refresh: (input: UsageSummaryInput) => Promise<void>,
  commit: (input: UsageSummaryInput) => void,
  isCurrent: () => boolean,
): Promise<void> {
  await refresh(input);
  if (isCurrent()) commit(input);
}
