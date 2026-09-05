import type { EnvironmentId } from "@t3tools/contracts";

interface UsageRefreshStatus {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly summary: unknown | null;
}

/** Tracks only environments that had a value when pull-to-refresh began. */
export function usagePullRefreshTargets(
  environments: readonly UsageRefreshStatus[],
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments.flatMap((environment) =>
      environment.summary === null ? [] : [environment.environmentId],
    ),
  );
}

/** Reports whether one of the environments selected at refresh start is still answering. */
export function isUsagePullRefreshPending(
  environments: readonly UsageRefreshStatus[],
  targets: ReadonlySet<EnvironmentId>,
): boolean {
  return environments.some(
    (environment) => environment.isPending && targets.has(environment.environmentId),
  );
}
