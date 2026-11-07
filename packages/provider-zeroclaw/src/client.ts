import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ZeroClawSettings } from "./settings.ts";

export const zeroClawClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zeroclaw"),
  label: "ZeroClaw",
  settingsSchema: ZeroClawSettings,
});
