import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { PrimeAgentSettings } from "./settings.ts";

const TILE =
  "M260 0H940A260 260 0 0 1 1200 260V940A260 260 0 0 1 940 1200H260A260 260 0 0 1 0 940V260A260 260 0 0 1 260 0Z";
const GLYPH_P =
  "M340 240H650C810 240 910 330 910 475C910 620 810 710 650 710H480V960H340V240ZM480 365V585H640C725 585 770 542 770 475C770 408 725 365 640 365H480Z";
const NODE_DOT = "M795 815A85 85 0 1 0 795 985A85 85 0 1 0 795 815Z";
const white = { light: "#FFFFFF", dark: "#FFFFFF" };

export const primeAgentClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("primeAgent"),
  label: "Prime Agent",
  featured: true,
  settingsSchema: PrimeAgentSettings,
  environmentFields: [
    {
      name: "PRIME_API_KEY",
      label: "Prime API key",
      description: "Optional. Authenticates Prime Inference without interactive /login.",
      placeholder: "Paste API key",
      sensitive: true,
    },
    {
      name: "RLM_MAX_DEPTH",
      label: "RLM max depth override",
      description: "Overrides RLM recursion depth (default 2, set 0 to disable rlm.spawn).",
      placeholder: "2",
      sensitive: false,
    },
  ],
  icon: {
    viewBox: "0 0 1200 1200",
    fill: { light: "#5B5CE6", dark: "#5B5CE6" },
    paths: [
      { d: `${TILE}${GLYPH_P}${NODE_DOT}`, fillRule: "evenodd" },
      { d: GLYPH_P, fill: white },
      { d: NODE_DOT, fill: white },
    ],
  },
});
