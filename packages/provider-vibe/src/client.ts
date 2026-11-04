/**
 * Mistral Vibe's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-vibe/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { VibeSettings } from "./settings.ts";

export const vibeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("vibe"),
  label: "Mistral Vibe",
  acpRegistryAgentIds: ["mistral-vibe"],
  settingsSchema: VibeSettings,
  environmentFields: [
    {
      name: "MISTRAL_API_KEY",
      label: "Mistral API key",
      description: "Optional. Signs in without `vibe --setup`.",
      placeholder: "Paste API key",
      sensitive: true,
    },
  ],
  // mistralai/mistral-vibe distribution/zed/icons/mistral_vibe.svg (Apache-2.0).
  icon: {
    viewBox: "0 0 28 28",
    fill: { light: "#000000", dark: "#FFFFFF" },
    paths: [
      { d: "M8.8147 5.35803H5.35791V8.46914H8.8147V5.35803Z" },
      { d: "M22.6419 5.35803H19.1851V8.46914H22.6419V5.35803Z" },
      { d: "M15.7283 15.7284H12.2715V18.8395H15.7283V15.7284Z" },
      { d: "M8.8147 15.7284H5.35791V18.8395H8.8147V15.7284Z" },
      { d: "M22.6419 15.7284H19.1851V18.8395H22.6419V15.7284Z" },
      { d: "M12.2715 8.81482H5.35791V11.9259H12.2715V8.81482Z" },
      { d: "M12.2718 19.1852H1.90137V22.2963H12.2718V19.1852Z" },
      { d: "M26.0989 19.1852H15.7285V22.2963H26.0989V19.1852Z" },
      { d: "M22.6419 12.2716H5.35791V15.3827H22.6419V12.2716Z" },
      { d: "M22.6421 8.81482H15.7285V11.9259H22.6421V8.81482Z" },
    ],
  },
});
