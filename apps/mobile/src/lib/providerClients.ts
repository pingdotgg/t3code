import { isProviderDriverKind } from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([museClient, openCodeClient, piClient]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
