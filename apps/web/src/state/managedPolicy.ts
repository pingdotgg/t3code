import type { EnvironmentId, ManagedPolicySummary, ProviderDriverKind } from "@t3tools/contracts";

import { useServerConfigs } from "./entities";
import { usePrimaryEnvironmentId } from "./environments";

/** The policy an environment's administrator applies, or undefined when it is unmanaged. */
export function useManagedPolicy(
  environmentId: EnvironmentId | null | undefined,
): ManagedPolicySummary | undefined {
  const serverConfigs = useServerConfigs();
  return environmentId == null ? undefined : serverConfigs.get(environmentId)?.managedPolicy;
}

export function usePrimaryManagedPolicy(): ManagedPolicySummary | undefined {
  return useManagedPolicy(usePrimaryEnvironmentId());
}

/**
 * Why a control acting on several environments is unavailable: the first denial any target's
 * policy gives, since one refusing target refuses the whole action.
 */
export function firstManagedDenial(
  policies: Iterable<ManagedPolicySummary | undefined>,
  deny: (policy: ManagedPolicySummary | undefined) => string | undefined,
): string | undefined {
  for (const policy of policies) {
    const denial = deny(policy);
    if (denial !== undefined) return denial;
  }
  return undefined;
}

/** What usage-data notices say when the policy turns product analytics off. */
export function managedTelemetryOffMessage(
  policy: ManagedPolicySummary | undefined,
): string | undefined {
  return policy?.limits?.telemetry === false
    ? `${policy.organization} turned off anonymous usage data.`
    : undefined;
}

export interface ManagedInstanceLocks {
  /** Keys inside the instance's `config` users cannot change. */
  readonly configKeys: ReadonlySet<string>;
  /** Environment variables users cannot edit, rename, or remove. */
  readonly environmentNames: ReadonlySet<string>;
  /** Under a runtime-mode ceiling every variable is the administrator's, not only named ones. */
  readonly wholeEnvironment: boolean;
  readonly reason: string;
}

/** What the policy pins on instances of `driver`, or undefined when nothing is. */
export function managedInstanceLocks(
  policy: ManagedPolicySummary | undefined,
  driver: ProviderDriverKind,
): ManagedInstanceLocks | undefined {
  const paths = policy?.limits?.providers?.lockedInstanceFields?.[driver];
  if (policy === undefined || paths === undefined || paths.length === 0) return undefined;
  const fieldsUnder = (prefix: string) =>
    new Set(paths.flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : [])));
  return {
    configKeys: fieldsUnder("config."),
    environmentNames: fieldsUnder("environment."),
    wholeEnvironment: paths.includes("environment"),
    reason: `Managed by ${policy.organization}.`,
  };
}
