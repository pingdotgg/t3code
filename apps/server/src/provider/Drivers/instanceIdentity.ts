import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";

import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import type { ProviderAdapterCapabilities } from "../Services/ProviderAdapter.ts";

/**
 * Stamp instance identity and adapter-owned capabilities onto a provider draft
 * before the driver publishes it.
 */
export const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly driverKind: ProviderDriverKind;
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly adapterCapabilities: ProviderAdapterCapabilities;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: input.driverKind,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    sessionFork: input.adapterCapabilities.sessionFork ?? "unsupported",
    continuation: { groupKey: input.continuationGroupKey },
  });
