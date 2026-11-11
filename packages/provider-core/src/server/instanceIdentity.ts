import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

export const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly driverKind: ProviderDriverKind;
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  ({ displayName: driverLabel, ...snapshot }: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: input.driverKind,
    ...instanceDisplayName({ ...input, driverLabel }),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

// Clients humanize the instance id of an unnamed extra instance, so the driver's
// label is only sent for the default one; any other displayName is the user's.
export function instanceDisplayName(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
  readonly driverLabel: string | undefined;
}): { readonly displayName?: string } {
  const displayName =
    input.displayName ||
    (input.instanceId === defaultInstanceIdForDriver(input.driverKind)
      ? input.driverLabel
      : undefined);
  return displayName ? { displayName } : {};
}
