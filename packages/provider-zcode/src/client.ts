/**
 * ZCode's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-zcode/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ZCodeSettings } from "./settings.ts";

export const zcodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zcode"),
  label: "ZCode",
  settingsSchema: ZCodeSettings,
  // Runs through the community zcode-acp-server bridge.
  badgeLabel: "Beta",
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M5 0H19A5 5 0 0 1 24 5V19A5 5 0 0 1 19 24H5A5 5 0 0 1 0 19V5A5 5 0 0 1 5 0ZM4.5 5V7.6H12.8L4.5 19.3H19.5V16.7H11.2L19.5 5Z",
        fillRule: "evenodd",
      },
    ],
  },
  environmentFields: [
    {
      name: "ZCODE_HOME",
      label: "ZCode data directory",
      description: "Optional. Replaces ~/.zcode, including the plan credentials ZCode uses.",
      placeholder: "~/.zcode",
    },
  ],
});
