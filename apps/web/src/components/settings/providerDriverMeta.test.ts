import { KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getDriverOption } from "./providerDriverMeta";

describe("providerDriverMeta", () => {
  it("exposes Kimi as an Early Access provider with its settings schema", () => {
    expect(getDriverOption(ProviderDriverKind.make("kimi"))).toMatchObject({
      value: ProviderDriverKind.make("kimi"),
      label: "Kimi",
      badgeLabel: "Early Access",
      settingsSchema: KimiSettings,
    });
  });
});
