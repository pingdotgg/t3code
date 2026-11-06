import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { VibeSettings } from "./settings.ts";

export const vibeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("vibe"),
  label: "Vibe",
  featured: false,
  modelFamilies: ["Mistral ", "Devstral"],
  acpRegistryAgentIds: ["mistral-vibe"],
  settingsSchema: VibeSettings,
  badgeLabel: "Early Access",
  environmentFields: [
    {
      name: "MISTRAL_API_KEY",
      label: "Mistral API key",
      description:
        "Optional. La Plateforme API key used by vibe-app-server instead of an interactive login.",
      placeholder: "Paste API key",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#FF7000", dark: "#FF7000" },
    paths: [
      {
        d: "M3 3h4v4H3V3Zm14 0h4v4h-4V3ZM3 7h8v4H3V7Zm10 0h8v4h-8V7ZM3 11h18v10h-4v-6h-3v4h-4v-4H7v6H3V11Z",
      },
    ],
  },
});
