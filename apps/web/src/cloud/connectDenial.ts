import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import type { ManagedPolicySummary } from "@t3tools/contracts";

import { desktopConnectDeniedBy } from "./publicConfig";

type Resolve = NonNullable<Parameters<typeof managedCapabilityDenial>[2]>;

/**
 * Why T3 Connect is off for an environment: its own policy's reason, else the reason from this
 * desktop's Managed Policy, which turns Clerk off wherever the environment is.
 */
export function connectDenialFor(
  policy: ManagedPolicySummary | undefined,
  resolve?: Resolve,
): string | undefined {
  const own = managedCapabilityDenial(policy, "connect", resolve);
  if (own !== undefined) return own;
  const organization = desktopConnectDeniedBy();
  return organization === null
    ? undefined
    : managedCapabilityDenial(
        { organization, lockedSettings: [], limits: { connect: false } },
        "connect",
        resolve,
      );
}
