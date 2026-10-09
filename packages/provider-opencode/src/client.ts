/**
 * OpenCode's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-opencode/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OpenCodeSettings } from "./settings.ts";

export const openCodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("opencode"),
  label: "OpenCode",
  settingsSchema: OpenCodeSettings,
  icon: {
    viewBox: "0 0 32 40",
    fill: { light: "#211E1E", dark: "#F1ECEC" },
    paths: [
      { d: "M24 32H8V16H24V32Z", fill: { light: "#CFCECD", dark: "#4B4646" } },
      { d: "M24 8H8V32H24V8ZM32 40H0V0H32V40Z" },
    ],
  },
});
