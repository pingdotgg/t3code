import type { EnvironmentId, ManagedPolicySummary } from "@t3tools/contracts";

import { useServerConfigs } from "./entities";
import { usePrimaryEnvironmentId } from "./environments";

export {
  managedInstanceLocks,
  type ManagedInstanceLocks,
} from "@t3tools/client-runtime/settings/managed-policy";

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
