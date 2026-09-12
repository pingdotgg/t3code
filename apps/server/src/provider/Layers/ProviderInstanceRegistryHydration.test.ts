import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const museId = ProviderInstanceId.make("muse");

describe("Muse provider instance hydration", () => {
  it("makes Muse available on existing environments without enabling it", () => {
    const instances = deriveProviderInstanceConfigMap(decodeSettings({}));

    expect(instances[museId]).toEqual({
      driver: ProviderDriverKind.make("muse"),
      config: { enabled: false, binaryPath: "muse", customModels: [] },
    });
  });

  it("applies legacy Muse settings while preserving an explicitly configured instance", () => {
    const legacy = { enabled: true, binaryPath: "/opt/muse", customModels: [] };
    const settings = decodeSettings({ providers: { muse: legacy } });
    expect(deriveProviderInstanceConfigMap(settings)[museId]?.config).toEqual(legacy);

    const explicit = decodeSettings({
      providers: { muse: legacy },
      providerInstances: {
        muse: {
          driver: "muse",
          enabled: false,
          displayName: "Muse test account",
          config: { binaryPath: "/another/muse" },
        },
      },
    });
    expect(deriveProviderInstanceConfigMap(explicit)[museId]).toEqual(
      explicit.providerInstances[museId],
    );
  });
});
