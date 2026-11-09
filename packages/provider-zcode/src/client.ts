import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ZcodeSettings } from "./settings.ts";

export const zcodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zcode"),
  label: "ZCode",
  settingsSchema: ZcodeSettings,
  icon: {
    viewBox: "0 0 1024 1024",
    fill: { light: "#18181B", dark: "#FAFAFA" },
    paths: [
      {
        // Simplified trace of the official ZCode italic "Z" glyph.
        d: "M304 288 H804 V340 L560 684 H804 V736 H280 V684 L524 340 H304 Z",
      },
    ],
  },
});
