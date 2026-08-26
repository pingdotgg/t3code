import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

/**
 * Shared identity stamper for built-in drivers.
 * Each driver was copy-pasting the same 8-line closure differing only by `driver`.
 * One factory replaces six copies.
 */
export const makeWithInstanceIdentity =
  (driver: ProviderDriverKind) =>
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
