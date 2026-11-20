import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient, type ProviderIcon } from "@t3tools/provider-core/client";
import { SparrowSettings } from "./settings.ts";

// 4x4 modular pixel-grid "S" mark aligned to Pi's grid for razor-sharp edges at 12/16/20/24px.
const sparrowIcon: ProviderIcon = {
  viewBox: "0 0 400 400",
  fill: { light: "#0F0F0F", dark: "#F5F5F5" },
  paths: [
    {
      d: "M100 0H400V100H200V200H0V100H100Z",
    },
    {
      d: "M200 200H400V300H300V400H0V300H200Z",
    },
  ],
};

export const sparrowClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("sparrow"),
  label: "Sparrow",
  icon: sparrowIcon,
  settingsSchema: SparrowSettings,
});
