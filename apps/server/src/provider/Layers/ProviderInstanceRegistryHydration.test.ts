import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("materializes the default Pi instance from legacy provider settings", () => {
    const config = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

    expect(config[ProviderInstanceId.make("piAgent")]).toEqual({
      driver: ProviderDriverKind.make("piAgent"),
      config: {
        enabled: true,
        binaryPath: "pi",
        homePath: "",
        customModels: [],
      },
    });
  });

  it("preserves an explicit Pi instance config", () => {
    const instanceId = ProviderInstanceId.make("piAgent");
    const explicit = {
      driver: ProviderDriverKind.make("piAgent"),
      enabled: false,
      config: { binaryPath: "/opt/pi" },
    } as const;
    const config = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: explicit },
    });

    expect(config[instanceId]).toEqual(explicit);
  });
});
