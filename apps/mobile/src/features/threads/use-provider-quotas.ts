import type { ServerProvider, UsageLimitSourceSnapshots } from "@t3tools/contracts";
import {
  nextProviderRefill,
  providerQuotaStatus,
  type ProviderQuotaStatus,
} from "@t3tools/shared/usageLimits";

import { useNowWithWakes } from "../../lib/clock";
import type { ProviderGroup } from "../../lib/modelOptions";

/**
 * Token status per provider group, re-read each minute for countdowns and the
 * moment any spent provider refills.
 */
export function useProviderQuotas(
  groups: ReadonlyArray<ProviderGroup>,
  config:
    | {
        readonly providers: readonly ServerProvider[];
        readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      }
    | undefined,
): { readonly checkedAt: number; readonly byProvider: ReadonlyMap<string, ProviderQuotaStatus> } {
  const quotaAt = (now: number) =>
    new Map(
      groups.flatMap((group) => {
        const instanceId = group.models[0]?.selection.instanceId;
        const quota =
          config && instanceId
            ? providerQuotaStatus(instanceId, config.providers, config.usageLimitSources ?? [], now)
            : null;
        return quota ? [[group.providerKey, quota] as const] : [];
      }),
    );
  const checkedAt = useNowWithWakes((afterMs) => nextProviderRefill(quotaAt(afterMs).values()));
  return { checkedAt, byProvider: quotaAt(checkedAt) };
}
