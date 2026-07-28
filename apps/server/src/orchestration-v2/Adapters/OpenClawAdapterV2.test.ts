import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import { OPENCLAW_DRIVER_KIND, OpenClawAdapterV2Driver } from "./OpenClawAdapterV2.ts";

describe("OpenClawAdapterV2", () => {
  it("registers the standard ACP adapter flavor", () => {
    expect(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(OPENCLAW_DRIVER_KIND)).toBe(true);
    expect(OpenClawAdapterV2Driver.driverKind).toBe("openclaw");
    expect(OpenClawAdapterV2Driver.defaultConfig()).toEqual({
      enabled: true,
      binaryPath: "openclaw",
      url: "",
      tokenFile: "",
      passwordFile: "",
      session: "",
      resetSession: false,
      customModels: [],
    });
  });
});
