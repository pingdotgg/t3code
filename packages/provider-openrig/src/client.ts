/**
 * OpenRig's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-openrig/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OpenRigSettings } from "./settings.ts";

export const openRigClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("openrig"),
  label: "OpenRig",
  featured: false,
  badgeLabel: "Early Access",
  // Hide the registry duplicate once `@openrig/acp` publishes under this id.
  acpRegistryAgentIds: ["openrig", "openrig-acp"],
  settingsSchema: OpenRigSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#111111", dark: "#F4F4F5" },
    paths: [
      {
        d: "M12 2.5L20.5 7.5V16.5L12 21.5L3.5 16.5V7.5L12 2.5ZM12 5.2L6.2 8.5V15.5L12 18.8L17.8 15.5V8.5L12 5.2ZM9.2 10.2H14.8V12H11.2V14.8H9.2V10.2Z",
        fillRule: "evenodd",
      },
    ],
  },
});
