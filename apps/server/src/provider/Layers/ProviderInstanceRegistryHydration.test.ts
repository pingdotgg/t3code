import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  HERMES_DRIVER_KIND,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

it("does not synthesize a legacy default Hermes instance", () => {
  const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

  assert.isUndefined(instances[ProviderInstanceId.make("hermes")]);
  assert.equal(instances[ProviderInstanceId.make("codex")]?.driver, "codex");
});

it("preserves an explicit Hermes instance whose id matches the driver default", () => {
  const instanceId = ProviderInstanceId.make("hermes");
  const instances = deriveProviderInstanceConfigMap({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: {
        driver: HERMES_DRIVER_KIND,
        displayName: "Research Hermes",
        enabled: true,
        config: {},
      },
    },
  });

  assert.deepEqual(instances[instanceId], {
    driver: HERMES_DRIVER_KIND,
    displayName: "Research Hermes",
    enabled: true,
    config: {},
  });
});
